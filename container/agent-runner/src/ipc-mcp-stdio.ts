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
