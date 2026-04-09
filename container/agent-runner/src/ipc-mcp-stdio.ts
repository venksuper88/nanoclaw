/**
 * Stdio MCP Server for DevenClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const disabledTools = new Set(
  (process.env.NANOCLAW_DISABLED_TOOLS || '').split(',').filter(Boolean),
);

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

// Wrapper that skips tool registration if the tool is disabled for this group
const tool: typeof server.tool = (name: string, ...args: any[]) => {
  if (disabledTools.has(name)) return;
  return (server.tool as any)(name, ...args);
};

tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
    filePath: z.string().optional().describe('Absolute path to a file to send as attachment (image, document, etc). The file must exist on disk.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      filePath: args.filePath || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general", "dashboard_agent-name"). Use lowercase with hyphens for the group name part.

For project-specific agents, use the workDir parameter to set the agent's working directory (e.g., "~/Projects/TrainIdle/.agents/build/"). The agent will inherit the project's root CLAUDE.md automatically.`,
  {
    jid: z.string().describe('The chat JID (e.g., "dash:build-agent", "tg:-1001234567890")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "dashboard_build-agent", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    workDir: z.string().optional().describe('Custom working directory (absolute path). For project agents, set to the agent directory (e.g., "/Users/deven/Projects/TrainIdle/.agents/build/")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    // Dashboard agents default to requiresTrigger=false (respond to any message)
    const requiresTrigger = args.folder.startsWith('dashboard_') ? false : true;
    const data: Record<string, string | boolean | undefined> = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger,
      workDir: args.workDir,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

tool(
  'save_memory',
  `Save an important fact or preference to long-term memory. Use this when you learn something worth remembering for future conversations — user preferences, project decisions, key facts, or important context.

Do NOT save:
- Trivial or temporary information
- Things already in CLAUDE.md or code
- Raw code snippets or file contents

Good examples:
- "User prefers mobile-first design with Manrope/Inter fonts"
- "Turso DB migration completed, using libsql client"
- "BuildPo should never restart the service without asking"`,
  {
    text: z.string().describe('The fact or preference to remember. Be concise and specific.'),
  },
  async (args) => {
    const data = {
      type: 'save_memory',
      groupFolder,
      text: args.text,
      timestamp: new Date().toISOString(),
    };

    const memoryDir = path.join(IPC_DIR, 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    writeIpcFile(memoryDir, data);

    return {
      content: [{ type: 'text' as const, text: 'Memory saved.' }],
    };
  },
);

// ── Todos ──

tool(
  'add_todo',
  'Add a todo item for the user. Supports priority, due dates, reminders, and recurrence. The todo will appear in the Todos tab of Mission Control. Use this for BOTH todos and reminders — a reminder is just a todo with remind_at set.',
  {
    title: z.string().describe('Short description of the todo'),
    data: z.string().optional().describe('Additional notes or context (supports markdown)'),
    priority: z.enum(['low', 'medium', 'high']).optional().describe('Priority level (default: medium)'),
    due_date: z.string().optional().describe('Due date as ISO timestamp (e.g., "2026-03-27T09:00:00Z")'),
    remind_at: z.string().optional().describe('When to send a reminder notification — ISO timestamp (e.g., "2026-03-27T09:00:00+05:30")'),
    recurrence: z.enum(['daily', 'weekday', 'weekly', 'monthly', 'yearly']).optional().describe('Repeat schedule — todo auto-advances when completed'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'add_todo',
      title: args.title,
      data: args.data,
      priority: args.priority || 'medium',
      due_date: args.due_date || (args.recurrence ? new Date().toISOString() : undefined),
      remind_at: args.remind_at,
      recurrence: args.recurrence,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Todo added: "${args.title}" [View Todos](#todos)` }] };
  },
);

tool(
  'update_todo',
  'Update an existing todo item — change title, notes, status, priority, due date, reminder, or recurrence.',
  {
    todo_id: z.string().describe('The todo ID to update'),
    title: z.string().optional().describe('New title'),
    data: z.string().optional().describe('New notes/context'),
    status: z.enum(['pending', 'in_progress', 'done']).optional().describe('New status'),
    priority: z.enum(['low', 'medium', 'high']).optional().describe('New priority'),
    due_date: z.string().optional().describe('New due date (ISO timestamp)'),
    remind_at: z.string().optional().describe('New reminder time (ISO timestamp)'),
    recurrence: z.enum(['daily', 'weekday', 'weekly', 'monthly', 'yearly']).optional().describe('Repeat schedule'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'update_todo',
      todoId: args.todo_id,
      title: args.title,
      data: args.data,
      status: args.status,
      priority: args.priority,
      due_date: args.due_date,
      remind_at: args.remind_at,
      recurrence: args.recurrence,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Todo ${args.todo_id} updated.` }] };
  },
);

tool(
  'complete_todo',
  'Mark a todo as done.',
  {
    todo_id: z.string().describe('The todo ID to complete'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'update_todo',
      todoId: args.todo_id,
      status: 'done',
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Todo ${args.todo_id} marked as done.` }] };
  },
);

tool(
  'delete_todo',
  'Permanently delete a todo item.',
  {
    todo_id: z.string().describe('The todo ID to delete'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'delete_todo',
      todoId: args.todo_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: `Todo ${args.todo_id} deleted.` }] };
  },
);

tool(
  'list_todos',
  "List the user's todos. Returns all non-completed todos by default.",
  {
    include_completed: z.boolean().optional().describe('Include completed todos (default: false)'),
  },
  async (args) => {
    // Read from snapshot file written by host
    const snapshotFile = path.join(IPC_DIR, 'current_todos.json');
    if (!fs.existsSync(snapshotFile)) {
      return { content: [{ type: 'text' as const, text: 'No todos found.' }] };
    }
    const todos = JSON.parse(fs.readFileSync(snapshotFile, 'utf-8'));
    const filtered = args.include_completed ? todos : todos.filter((t: any) => t.status !== 'done');
    if (filtered.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No todos found.' }] };
    }
    const lines = filtered.map((t: any) => {
      const check = t.status === 'done' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
      const pri = t.priority === 'high' ? '🔴' : t.priority === 'medium' ? '🟡' : '🟢';
      const due = t.due_date ? ` (due: ${t.due_date})` : '';
      const remind = t.remind_at ? ` 🔔 ${t.remind_at}` : '';
      const recur = t.recurrence ? ` 🔁 ${t.recurrence}` : '';
      return `${check} ${pri} **${t.title}**${due}${remind}${recur}\n   ID: \`${t.id}\``;
    });
    return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
  },
);

tool(
  'run_command',
  `Run a command (script) available to this group. Commands are like skills but don't need an LLM — they're scripts with a standard interface.

Resolution: group-local commands take precedence over global ones (like skills).
Execution: the command runs as a child process with JSON input/output. Lifecycle messages (start, complete, error) are sent to the group chat automatically.

Use list_commands first to see what's available.`,
  {
    command_name: z.string().describe('Name of the command to run (e.g., "process-txn")'),
    input: z.record(z.string(), z.unknown()).optional().describe('JSON input to pass to the command via stdin'),
  },
  async (args) => {
    const data = {
      type: 'run_command',
      commandName: args.command_name,
      input: args.input || {},
      groupFolder,
      chatJid,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Command "${args.command_name}" execution requested. Lifecycle messages will be sent to the group chat.` }],
    };
  },
);

tool(
  'list_commands',
  'List all commands (scripts) available to this group. Shows both group-local and global commands.',
  {},
  async () => {
    const commandsFile = path.join(IPC_DIR, 'current_commands.json');
    if (!fs.existsSync(commandsFile)) {
      return { content: [{ type: 'text' as const, text: 'No commands available.' }] };
    }
    try {
      const commands = JSON.parse(fs.readFileSync(commandsFile, 'utf-8'));
      if (commands.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No commands available.' }] };
      }
      const formatted = commands
        .map((c: { name: string; description: string }) => `- **${c.name}**: ${c.description}`)
        .join('\n');
      return { content: [{ type: 'text' as const, text: `Available commands:\n${formatted}` }] };
    } catch {
      return { content: [{ type: 'text' as const, text: 'Error reading commands list.' }] };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
