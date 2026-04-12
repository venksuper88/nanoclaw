import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import { writeTasksSnapshot } from './ipc-snapshots.js';
import {
  ensureSession as ensureTmuxSession,
  runTmuxAgent,
  TmuxStreamEvent,
} from './tmux-runner.js';
import {
  getAllDashboardTokens,
  getAllTasks,
  getDueTasks,
  getDueNoteItemReminders,
  getDueTodoReminders,
  getNoteById,
  getTaskById,
  getTodosByUser,
  getRouterState,
  setRouterState,
  logTaskRun,
  storeMessage,
  updateTask,
  updateTaskAfterRun,
  updateNoteItem,
  updateTodo,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { dashboardEvents } from './dashboard/events.js';
import {
  AgentOutput,
  RegisteredGroup,
  ScheduledTask,
  groupHasUser,
  getGroupUserIds,
} from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    await updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    await logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    await logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for agent to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = await getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the agent promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task agent after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    // Ensure tmux session exists
    ensureTmuxSession(group, task.chat_jid);

    // Emit agent:spawn so dashboard shows activity indicator
    dashboardEvents.emitEvent('agent:spawn', {
      groupName: group.name,
      groupFolder: group.folder,
      containerName: 'tmux',
    });

    // Forward real-time stream events to the dashboard
    const agentName = group.name || ASSISTANT_NAME;
    const handleStreamEvent = (evt: TmuxStreamEvent) => {
      const content = evt.content;
      if (!content) return;

      if (evt.type === 'activity') {
        dashboardEvents.emitEvent('container:log', {
          groupName: group.name,
          groupFolder: group.folder,
          line: content,
          stream: 'stdout',
        });
        return;
      }

      // Text + SendMessage events -> message:new (shows in chat) + store to DB
      const sender = evt.sender || agentName;
      const msgId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const timestamp = new Date().toISOString();
      dashboardEvents.emitEvent('message:new', {
        chatJid: task.chat_jid,
        sender,
        senderName: sender,
        content,
        timestamp,
        isFromMe: true,
        isBotMessage: true,
        isStreamed: true,
      });
      storeMessage({
        id: msgId,
        chat_jid: task.chat_jid,
        sender,
        sender_name: sender,
        content,
        timestamp,
        is_from_me: true,
        is_bot_message: true,
      }).catch((err) =>
        logger.warn({ err }, 'storeMessage (task stream) failed'),
      );
    };

    const output = await runTmuxAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      handleStreamEvent,
    );

    dashboardEvents.emitEvent('agent:exit', {
      groupName: group.name,
      groupFolder: group.folder,
      duration: Date.now() - startTime,
    });

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
      // Forward result to user
      await deps.sendMessage(task.chat_jid, output.result);
      scheduleClose();
    }

    // Notify idle
    deps.queue.notifyIdle(task.chat_jid);
    scheduleClose();

    logger.info(
      { taskId: task.id, durationMs: Date.now() - startTime },
      'Task completed',
    );
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  await logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  await updateTaskAfterRun(task.id, nextRun, resultSummary);
}

// Track last digest date per user to avoid duplicate sends (persisted to DB)
const lastDigestDate: Record<string, string> = {};
let digestStateLoaded = false;

const DIGEST_HOUR = 5; // 5:00 AM local time

function formatTodoDigest(
  todos: { title: string; due_date: string | null; priority: string }[],
): string {
  if (todos.length === 0) return '';

  const now = new Date();
  const overdue = todos.filter((t) => t.due_date && new Date(t.due_date) < now);
  const dated = todos
    .filter((t) => t.due_date && new Date(t.due_date) >= now)
    .sort(
      (a, b) =>
        new Date(a.due_date!).getTime() - new Date(b.due_date!).getTime(),
    );
  const undated = todos.filter((t) => !t.due_date);

  const lines: string[] = [
    `📋 **Daily Todos** — ${now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}`,
  ];

  if (overdue.length > 0) {
    lines.push('', '🔴 **Overdue:**');
    for (const t of overdue) {
      const flag = t.priority === 'high' ? ' ⚡' : '';
      lines.push(
        `• ${t.title}${flag} — due ${new Date(t.due_date!).toLocaleDateString([], { month: 'short', day: 'numeric' })}`,
      );
    }
  }
  if (dated.length > 0) {
    lines.push('', '📅 **Upcoming:**');
    for (const t of dated) {
      const flag = t.priority === 'high' ? ' ⚡' : '';
      lines.push(
        `• ${t.title}${flag} — ${new Date(t.due_date!).toLocaleDateString([], { month: 'short', day: 'numeric' })}`,
      );
    }
  }
  if (undated.length > 0) {
    lines.push('', '📌 **No due date:**');
    for (const t of undated) {
      const flag = t.priority === 'high' ? ' ⚡' : '';
      lines.push(`• ${t.title}${flag}`);
    }
  }

  lines.push('', `${todos.length} total todo${todos.length === 1 ? '' : 's'}`);
  return lines.join('\n');
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = await getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = await getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }

      // Check for due todo reminders
      const tokens = await getAllDashboardTokens();
      const dueTodoReminders = await getDueTodoReminders();
      for (const todo of dueTodoReminders) {
        const groups = deps.registeredGroups();

        // Check if any user has a preferred reminder group
        const userToken = tokens.find((t) => {
          if (!t.reminder_group_jid) return false;
          const grp = groups[t.reminder_group_jid];
          return grp && groupHasUser(grp.memoryUserId, todo.user_id);
        });

        let targetJid: string;
        if (userToken?.reminder_group_jid) {
          targetJid = userToken.reminder_group_jid;
        } else {
          const entries = Object.entries(groups).filter(([, g]) =>
            groupHasUser(g.memoryUserId, todo.user_id),
          );
          const targetEntry =
            entries.find(([, g]) => g.isMain) ||
            entries.find(([, g]) => g.mode === 'tmux') ||
            entries[0];
          if (!targetEntry) continue;
          targetJid = targetEntry[0];
        }

        const msg = todo.data
          ? `🔔 **Reminder:** ${todo.title}\n\n${todo.data}`
          : `🔔 **Reminder:** ${todo.title}`;
        await deps.sendMessage(targetJid, msg);

        // Mark as fired, handle recurrence
        const now = new Date().toISOString();
        if (todo.recurrence) {
          try {
            const cron = CronExpressionParser.parse(todo.recurrence, {
              tz: TIMEZONE,
            });
            const nextRemind = cron.next().toISOString();
            await updateTodo(todo.id, { remind_at: nextRemind } as any);
          } catch {
            await updateTodo(todo.id, { reminder_fired_at: now } as any);
          }
        } else {
          await updateTodo(todo.id, { reminder_fired_at: now } as any);
        }
        logger.info(
          { todoId: todo.id, userId: todo.user_id },
          'Todo reminder fired',
        );
      }

      // Fire note item reminders (checklist items with remind_at)
      const dueNoteItems = await getDueNoteItemReminders();
      for (const item of dueNoteItems) {
        const note = await getNoteById(item.note_id);
        if (!note) continue;
        const userId = note.user_id;
        const groups = deps.registeredGroups();

        const userToken = tokens.find((t) => {
          if (!t.reminder_group_jid) return false;
          const grp = groups[t.reminder_group_jid];
          return grp && groupHasUser(grp.memoryUserId, userId);
        });

        let targetJid: string;
        if (userToken?.reminder_group_jid) {
          targetJid = userToken.reminder_group_jid;
        } else {
          const entries = Object.entries(groups).filter(([, g]) =>
            groupHasUser(g.memoryUserId, userId),
          );
          const targetEntry =
            entries.find(([, g]) => g.isMain) ||
            entries.find(([, g]) => g.mode === 'tmux') ||
            entries[0];
          if (!targetEntry) continue;
          targetJid = targetEntry[0];
        }

        const msg = `🔔 **Note reminder:** ${item.title}\n📝 From: *${note.title}*`;
        await deps.sendMessage(targetJid, msg);
        await updateNoteItem(item.id, {
          reminder_fired_at: new Date().toISOString(),
        });
        logger.info(
          { noteItemId: item.id, noteId: item.note_id },
          'Note item reminder fired',
        );
      }

      // Daily todo digest — send at DIGEST_HOUR local time
      const nowLocal = new Date(
        new Date().toLocaleString('en-US', { timeZone: TIMEZONE }),
      );
      const todayKey = nowLocal.toISOString().slice(0, 10);
      if (nowLocal.getHours() >= DIGEST_HOUR) {
        // Load persisted digest state on first run (survives restarts)
        if (!digestStateLoaded) {
          try {
            const saved = await getRouterState('last_digest_dates');
            if (saved) Object.assign(lastDigestDate, JSON.parse(saved));
          } catch {}
          digestStateLoaded = true;
        }
        const groups = deps.registeredGroups();
        // Collect unique users and resolve target group per user.
        // Priority: token's reminder_group_jid > isMain group > first group
        const allUsers = new Set<string>();
        for (const group of Object.values(groups)) {
          for (const uid of getGroupUserIds(group.memoryUserId))
            allUsers.add(uid);
        }

        const userGroups = new Map<string, string>();
        for (const userId of allUsers) {
          // 1. Check token preference (same logic as individual reminders)
          const userToken = tokens.find((t) => {
            if (!t.reminder_group_jid) return false;
            const grp = groups[t.reminder_group_jid];
            return grp && groupHasUser(grp.memoryUserId, userId);
          });
          if (userToken?.reminder_group_jid) {
            userGroups.set(userId, userToken.reminder_group_jid);
            continue;
          }
          // 2. Fallback: isMain > tmux > first match
          const entries = Object.entries(groups).filter(([, g]) =>
            groupHasUser(g.memoryUserId, userId),
          );
          const target =
            entries.find(([, g]) => g.isMain) ||
            entries.find(([, g]) => g.mode === 'tmux') ||
            entries[0];
          if (target) userGroups.set(userId, target[0]);
        }

        for (const [userId, targetJid] of userGroups) {
          if (lastDigestDate[userId] === todayKey) continue;

          const todos = await getTodosByUser(userId, false);
          if (todos.length === 0) {
            lastDigestDate[userId] = todayKey;
            setRouterState(
              'last_digest_dates',
              JSON.stringify(lastDigestDate),
            ).catch(() => {});
            continue;
          }

          const msg = formatTodoDigest(todos);
          await deps.sendMessage(targetJid, msg);
          // Persist digest to DB so it survives page refresh
          const now = new Date().toISOString();
          storeMessage({
            id: `digest-${userId}-${todayKey}`,
            chat_jid: targetJid,
            sender: ASSISTANT_NAME,
            sender_name: ASSISTANT_NAME,
            content: msg,
            timestamp: now,
            is_from_me: false,
            is_bot_message: true,
          }).catch((err) =>
            logger.warn({ err }, 'storeMessage (digest) failed'),
          );
          lastDigestDate[userId] = todayKey;
          setRouterState(
            'last_digest_dates',
            JSON.stringify(lastDigestDate),
          ).catch(() => {});
          logger.info(
            { userId, targetJid, todoCount: todos.length },
            'Daily todo digest sent',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
