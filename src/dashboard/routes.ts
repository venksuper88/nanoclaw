import { Router, Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import multer from 'multer';
import Database from 'better-sqlite3';

import YAML from 'yaml';

import {
  canAccessGroup,
  createToken,
  deleteToken,
  listTokens,
  type TokenUser,
} from './auth.js';
import {
  getAllChats,
  getAllMessagesSince,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getTaskById,
  getTaskRunLogs,
  setRegisteredGroup,
  storeMessage,
  updateTask,
  deleteTask,
  updateDashboardToken,
  createTodo,
  getTodoById,
  getAllTodos,
  updateTodo,
  deleteTodo,
  getAllScopeDefs,
  createScopeDef,
  deleteScopeDef,
  getDraft,
  setDraft,
  getRouterState,
  setRouterState,
  getTokenUsageSummary,
  createEmailRule,
  getEmailRules,
  updateEmailRule,
  deleteEmailRule,
  getEmailLog,
  getAlerts,
  dismissAlert,
} from '../db.js';
import {
  getTenjinSnapshot,
  fetchAndStoreTenjinSnapshot,
  getAllTenjinSnapshots,
} from '../tenjin-snapshot.js';
import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import { listCommands } from '../commands.js';
import { dashboardEvents, contextCache } from './events.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../group-folder.js';
import { formatMessages, compressImageForAgent } from '../router.js';
import { logger } from '../logger.js';
import { randomUUID } from 'crypto';
import { savePushSubscription, deletePushSubscription, getDbClient } from '../db.js';
import { VAPID_PUBLIC_KEY } from '../config.js';
import { getTranscriptSize, getSessionTranscriptSize } from '../tmux-runner.js';

/**
 * Compute next due date for a recurring todo.
 * Presets: daily, weekday, weekly, monthly, yearly.
 * Monthly handles short months by clamping to last day of month.
 */
function computeNextDueDate(
  fromIso: string,
  recurrence: string,
): string | null {
  const from = new Date(fromIso);
  if (isNaN(from.getTime())) return null;

  switch (recurrence) {
    case 'daily': {
      from.setDate(from.getDate() + 1);
      return from.toISOString();
    }
    case 'weekday': {
      do {
        from.setDate(from.getDate() + 1);
      } while (from.getDay() === 0 || from.getDay() === 6);
      return from.toISOString();
    }
    case 'weekly': {
      from.setDate(from.getDate() + 7);
      return from.toISOString();
    }
    case 'monthly': {
      const origDay = from.getDate();
      from.setMonth(from.getMonth() + 1);
      // Clamp to last day if month is shorter (e.g. Jan 31 -> Feb 28)
      if (from.getDate() < origDay) {
        from.setDate(0); // go to last day of previous month
      }
      return from.toISOString();
    }
    case 'yearly': {
      const origDay = from.getDate();
      from.setFullYear(from.getFullYear() + 1);
      if (from.getDate() < origDay) {
        from.setDate(0);
      }
      return from.toISOString();
    }
    default:
      return null;
  }
}

// Multer storage: save uploads to the target group's attachments folder
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const groupFolder = (req as unknown as { params: { folder: string } })
        .params?.folder;
      if (!groupFolder) return cb(new Error('Missing group folder'), '');
      try {
        const dir = path.join(
          resolveGroupFolderPath(groupFolder),
          'attachments',
        );
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      } catch (err) {
        cb(err as Error, '');
      }
    },
    filename: (_req, file, cb) => {
      cb(null, file.originalname);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

const startTime = Date.now();

/**
 * Callback injected from index.ts — handles sending a message to a group
 * as if it came from a channel (stores in DB, triggers container processing).
 */
export type ChatSendFn = (
  chatJid: string,
  text: string,
  senderName: string,
  stateless?: boolean,
) => Promise<void>;

/**
 * Callback to close a group's active container.
 */
export type SessionKillFn = (chatJid: string) => void;

import type { MemoryService } from '../memory.js';

let chatSendFn: ChatSendFn | null = null;
let sessionKillFn: SessionKillFn | null = null;
let sessionInterruptFn: ((chatJid: string) => void) | null = null;
let memoryServiceRef: MemoryService | null = null;
let activeGroupsFn: (() => string[]) | null = null;

export function setChatSendFn(fn: ChatSendFn): void {
  chatSendFn = fn;
}

export function setSessionKillFn(fn: SessionKillFn): void {
  sessionKillFn = fn;
}

export function setSessionInterruptFn(fn: (chatJid: string) => void): void {
  sessionInterruptFn = fn;
}

export function setMemoryService(svc: MemoryService): void {
  memoryServiceRef = svc;
}

export function setActiveGroupsFn(fn: () => string[]): void {
  activeGroupsFn = fn;
}

function getUser(req: Request): TokenUser {
  return (req as any).tokenUser as TokenUser;
}

export async function createRouter(): Promise<Router> {
  const router = Router();

  // ── Current user info ──
  router.get('/api/me', (req: Request, res: Response) => {
    const user = getUser(req);
    res.json({
      ok: true,
      data: {
        name: user.name,
        role: user.role,
        isOwner: user.isOwner,
        canSend: user.canSend,
        allowedGroups: user.allowedGroups,
      },
    });
  });

  // ── Status ──
  router.get('/api/status', async (_req: Request, res: Response) => {
    const groups = await getAllRegisteredGroups();
    const tasks = await getAllTasks();
    const sessions = await getAllSessions();
    res.json({
      ok: true,
      data: {
        uptime: Date.now() - startTime,
        assistantName: ASSISTANT_NAME,
        groupCount: Object.keys(groups).length,
        taskCount: tasks.length,
        activeTasks: tasks.filter((t) => t.status === 'active').length,
        sessionCount: Object.keys(sessions).length,
      },
    });
  });

  // ── Processing state (active agent containers) ──
  router.get('/api/processing', (_req: Request, res: Response) => {
    const folders = activeGroupsFn?.() ?? [];
    res.json({ ok: true, data: { activeGroupFolders: folders } });
  });

  // ── Groups (filtered by token access) ──
  router.get('/api/groups', async (req: Request, res: Response) => {
    const user = getUser(req);
    const groups = await getAllRegisteredGroups();
    const chats = await getAllChats();
    const sessions = await getAllSessions();
    const chatMap = new Map(chats.map((c) => [c.jid, c]));

    const data = Object.entries(groups)
      .filter(([jid]) => canAccessGroup(user, jid))
      .map(([jid, group]) => {
        const chat = chatMap.get(jid);
        return {
          jid,
          name: group.name,
          folder: group.folder,
          channel: chat?.channel,
          lastActivity: chat?.last_message_time,
          isMain: group.isMain || false,
          isTransient: group.isTransient || false,
          requiresTrigger: group.requiresTrigger ?? true,
          hasSession: !!sessions[group.folder],
          showInSidebar: group.showInSidebar !== false,
          model: group.model || 'opus',
          contextWindow: group.contextWindow || '200k',
        };
      });

    res.json({ ok: true, data });
  });

  // ── Drafts ──
  router.get('/api/groups/:jid/draft', async (req: Request, res: Response) => {
    const user = getUser(req);
    const jid = decodeURIComponent(req.params.jid as string);
    if (!canAccessGroup(user, jid)) {
      res.status(403).json({ ok: false, error: 'Access denied' });
      return;
    }
    const content = await getDraft(jid);
    res.json({ ok: true, data: { content } });
  });

  router.put('/api/groups/:jid/draft', async (req: Request, res: Response) => {
    const user = getUser(req);
    const jid = decodeURIComponent(req.params.jid as string);
    if (!canAccessGroup(user, jid)) {
      res.status(403).json({ ok: false, error: 'Access denied' });
      return;
    }
    const { content = '' } = req.body;
    await setDraft(jid, String(content));
    dashboardEvents.emitEvent('draft:update', {
      chatJid: jid,
      content: String(content),
    });
    res.json({ ok: true });
  });

  // ── Messages (access-checked) ──
  router.get(
    '/api/groups/:jid/messages',
    async (req: Request, res: Response) => {
      const user = getUser(req);
      const jid = decodeURIComponent(req.params.jid as string);
      if (!canAccessGroup(user, jid)) {
        res.status(403).json({ ok: false, error: 'Access denied' });
        return;
      }
      const since = String(req.query.since || '');
      const limit = parseInt(String(req.query.limit || '50'), 10);

      // Use getAllMessagesSince which includes bot responses (getMessagesSince filters them out)
      const messages = await getAllMessagesSince(jid, since, limit);
      res.json({
        ok: true,
        data: messages.map((m) => ({
          id: m.id,
          sender: m.sender,
          senderName: m.sender_name,
          content: m.content,
          timestamp: m.timestamp,
          isFromMe: m.is_from_me || false,
          isBotMessage: m.is_bot_message || false,
        })),
      });
    },
  );

  // ── Chat: send message to a group ──
  router.post('/api/chat/send', async (req: Request, res: Response) => {
    const user = getUser(req);
    const { chatJid, text, stateless } = req.body;
    if (!chatJid || !text) {
      res.status(400).json({ ok: false, error: 'chatJid and text required' });
      return;
    }

    if (!canAccessGroup(user, chatJid)) {
      res.status(403).json({ ok: false, error: 'Access denied' });
      return;
    }

    if (!user.canSend) {
      res.status(403).json({ ok: false, error: 'Read-only access' });
      return;
    }

    const groups = await getAllRegisteredGroups();
    if (!groups[chatJid]) {
      res.status(404).json({ ok: false, error: 'Group not registered' });
      return;
    }

    if (!chatSendFn) {
      res.status(503).json({ ok: false, error: 'Chat not available' });
      return;
    }

    // Handle ! commands — execute directly without LLM
    if (typeof text === 'string' && text.startsWith('!')) {
      const parts = text.slice(1).trim().split(/\s+/);
      const commandName = parts[0];
      const group = groups[chatJid];
      if (commandName && group) {
        const { runCommand: execCommand, resolveCommand: resolveCmd } = await import('../commands.js');
        if (resolveCmd(commandName, group.folder)) {
          // Store the user's command message in DB for chat history
          storeMessage({
            id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            chat_jid: chatJid,
            sender: user.name,
            sender_name: user.name,
            content: text,
            timestamp: new Date().toISOString(),
            is_from_me: true,
          }).catch(() => {});

          const sendMsg = async (msg: string) => {
            const agentName = group.name || ASSISTANT_NAME;
            const msgId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const timestamp = new Date().toISOString();
            storeMessage({ id: msgId, chat_jid: chatJid, sender: agentName, sender_name: agentName, content: msg, timestamp, is_from_me: false, is_bot_message: true }).catch(() => {});
            dashboardEvents.emitEvent('message:new', { chatJid, sender: agentName, senderName: agentName, content: msg, timestamp, isFromMe: false });
          };

          // Run in background — don't block the response
          execCommand({
            commandName,
            groupFolder: group.folder,
            chatJid,
            input: { args: parts.slice(1).join(' '), sender: user.name },
            sendMessage: sendMsg,
          }).catch((err) => logger.warn({ err, commandName }, 'Dashboard command execution failed'));

          res.json({ ok: true });
          return;
        }
      }
    }

    // Use the token user's name as the sender
    await chatSendFn(chatJid, text, user.name, !!stateless);
    res.json({ ok: true });
  });

  // ── File upload ──
  router.post(
    '/api/groups/:folder/upload',
    (req: Request, res: Response, next) => {
      upload.single('file')(req, res, (err) => {
        if (err) {
          logger.error(
            { err, folder: req.params.folder },
            'File upload multer error',
          );
          res
            .status(400)
            .json({ ok: false, error: `Upload failed: ${err.message}` });
          return;
        }
        next();
      });
    },
    async (req: Request, res: Response) => {
      if (!req.file) {
        res.status(400).json({ ok: false, error: 'No file uploaded' });
        return;
      }

      // Verify file was written to disk
      if (!fs.existsSync(req.file.path)) {
        logger.error(
          { path: req.file.path },
          'Uploaded file not found on disk after multer',
        );
        res.status(500).json({ ok: false, error: 'File write failed' });
        return;
      }

      logger.info(
        {
          folder: req.params.folder as string,
          file: req.file.originalname,
          size: req.file.size,
          path: req.file.path,
        },
        'File uploaded via dashboard',
      );

      // Pre-generate agent thumbnail for images (non-blocking)
      compressImageForAgent(req.file.path).catch((err) =>
        logger.warn(
          { err, file: req.file!.originalname },
          'Thumbnail pre-generation failed',
        ),
      );

      res.json({
        ok: true,
        data: {
          filename: req.file.originalname,
          size: req.file.size,
          path: req.file.path,
        },
      });
    },
  );

  // ── Sessions ──
  router.get('/api/sessions', async (_req: Request, res: Response) => {
    const sessions = await getAllSessions();
    const groups = await getAllRegisteredGroups();

    const data = Object.entries(sessions).map(([folder, sessionId]) => {
      const group = Object.values(groups).find((g) => g.folder === folder);
      return {
        folder,
        sessionId,
        groupName: group?.name || folder,
        jid: group
          ? Object.entries(groups).find(([, g]) => g.folder === folder)?.[0]
          : undefined,
      };
    });

    res.json({ ok: true, data });
  });

  router.post('/api/sessions/:jid/kill', (req: Request, res: Response) => {
    const jid = decodeURIComponent(req.params.jid as string);
    if (!sessionKillFn) {
      res
        .status(503)
        .json({ ok: false, error: 'Session management not available' });
      return;
    }
    sessionKillFn(jid);
    res.json({ ok: true });
  });

  // Interrupt (Ctrl+C) the running agent — stops current turn, preserves session
  router.post('/api/sessions/:jid/interrupt', (req: Request, res: Response) => {
    const jid = decodeURIComponent(req.params.jid as string);
    if (!sessionInterruptFn) {
      res.status(503).json({ ok: false, error: 'Interrupt not available' });
      return;
    }
    sessionInterruptFn(jid);
    res.json({ ok: true });
  });

  // ── Tasks ──
  router.get('/api/tasks', async (req: Request, res: Response) => {
    const user = getUser(req);
    const tasks = await getAllTasks();
    const filtered = tasks.filter(
      (t) => user.isOwner || canAccessGroup(user, t.chat_jid),
    );
    res.json({ ok: true, data: filtered });
  });

  router.get('/api/tasks/:id', async (req: Request, res: Response) => {
    const task = await getTaskById(req.params.id as string);
    if (!task) {
      res.status(404).json({ ok: false, error: 'Task not found' });
      return;
    }
    res.json({ ok: true, data: task });
  });

  router.get('/api/tasks/:id/logs', async (req: Request, res: Response) => {
    const task = await getTaskById(req.params.id as string);
    if (!task) {
      res.status(404).json({ ok: false, error: 'Task not found' });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 20;
    const logs = await getTaskRunLogs(req.params.id as string, limit);
    res.json({ ok: true, data: logs });
  });

  router.post('/api/tasks/:id/pause', async (req: Request, res: Response) => {
    const task = await getTaskById(req.params.id as string);
    if (!task) {
      res.status(404).json({ ok: false, error: 'Task not found' });
      return;
    }
    await updateTask(req.params.id as string, { status: 'paused' });
    res.json({
      ok: true,
      data: { id: req.params.id as string, status: 'paused' },
    });
  });

  router.post('/api/tasks/:id/resume', async (req: Request, res: Response) => {
    const task = await getTaskById(req.params.id as string);
    if (!task) {
      res.status(404).json({ ok: false, error: 'Task not found' });
      return;
    }
    await updateTask(req.params.id as string, { status: 'active' });
    res.json({
      ok: true,
      data: { id: req.params.id as string, status: 'active' },
    });
  });

  router.delete('/api/tasks/:id', async (req: Request, res: Response) => {
    const task = await getTaskById(req.params.id as string);
    if (!task) {
      res.status(404).json({ ok: false, error: 'Task not found' });
      return;
    }
    await deleteTask(req.params.id as string);
    res.json({ ok: true });
  });

  // ── Todos ──
  router.get('/api/todos', async (req: Request, res: Response) => {
    const user = getUser(req);
    const todos = await getAllTodos();
    const userId = user.name.toLowerCase();
    const filtered = todos.filter((t) => t.user_id === userId);
    res.json({ ok: true, data: filtered });
  });

  router.post('/api/todos', async (req: Request, res: Response) => {
    const user = getUser(req);
    const { title, data, priority, due_date, remind_at, recurrence, user_id } =
      req.body;
    if (!title) {
      res.status(400).json({ ok: false, error: 'title required' });
      return;
    }
    const id = `todo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();
    await createTodo({
      id,
      user_id: user_id || user.name.toLowerCase(),
      title,
      data: data || null,
      status: 'pending',
      priority: priority || 'medium',
      due_date: due_date || null,
      remind_at: remind_at || null,
      recurrence: recurrence || null,
      reminder_fired_at: null,
      created_by: 'dashboard',
      created_at: now,
      updated_at: now,
    });
    const todo = await getTodoById(id);
    res.json({ ok: true, data: todo });
  });

  router.patch('/api/todos/:id', async (req: Request, res: Response) => {
    const todo = await getTodoById(req.params.id as string);
    if (!todo) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }

    // Handle recurring todo completion — reset with next due date instead of marking done
    if (req.body.status === 'done' && todo.recurrence) {
      const nextDue = computeNextDueDate(
        todo.due_date || new Date().toISOString(),
        todo.recurrence,
      );
      if (nextDue) {
        const nextRemind = todo.remind_at
          ? computeNextDueDate(todo.remind_at, todo.recurrence)
          : null;
        await updateTodo(
          req.params.id as string,
          {
            due_date: nextDue,
            remind_at: nextRemind,
            reminder_fired_at: null,
          } as any,
        );
        const updated = await getTodoById(req.params.id as string);
        res.json({ ok: true, data: updated });
        return;
      }
    }

    await updateTodo(req.params.id as string, req.body);
    const updated = await getTodoById(req.params.id as string);
    res.json({ ok: true, data: updated });
  });

  router.delete('/api/todos/:id', async (req: Request, res: Response) => {
    const todo = await getTodoById(req.params.id as string);
    if (!todo) {
      res.status(404).json({ ok: false, error: 'Not found' });
      return;
    }
    await deleteTodo(req.params.id as string);
    res.json({ ok: true });
  });

  // ── Token reminder group ──
  router.patch(
    '/api/tokens/:token/reminder-group',
    async (req: Request, res: Response) => {
      const user = getUser(req);
      if (!user.isOwner) {
        res.status(403).json({ ok: false, error: 'Owner access required' });
        return;
      }
      const { reminderGroupJid } = req.body;
      await updateDashboardToken(req.params.token as string, {
        reminder_group_jid: reminderGroupJid || null,
      });
      res.json({ ok: true });
    },
  );

  // ── Logs ──
  router.get('/api/logs/:folder', (req: Request, res: Response) => {
    try {
      const logsDir = path.join(
        resolveGroupFolderPath(req.params.folder as string),
        'logs',
      );
      if (!fs.existsSync(logsDir)) {
        res.json({ ok: true, data: [] });
        return;
      }
      const files = fs
        .readdirSync(logsDir)
        .filter((f) => f.endsWith('.log'))
        .sort()
        .reverse()
        .slice(0, 20);

      const logs = files.map((f) => ({
        name: f,
        content: fs.readFileSync(path.join(logsDir, f), 'utf-8').slice(0, 5000),
      }));

      res.json({ ok: true, data: logs });
    } catch {
      res.json({ ok: true, data: [] });
    }
  });

  // ── Analytics ──
  router.get('/api/analytics', async (_req: Request, res: Response) => {
    const groups = await getAllRegisteredGroups();
    const chats = await getAllChats();
    const tasks = await getAllTasks();
    const sessions = await getAllSessions();

    const groupAnalytics = await Promise.all(
      Object.entries(groups).map(async ([jid, group]) => {
        const chat = chats.find((c) => c.jid === jid);
        const messages = await getMessagesSince(jid, '', ASSISTANT_NAME, 1000);
        const userMessages = messages.filter((m) => !m.is_from_me);
        const botMessages = messages.filter((m) => m.is_from_me);

        const sessionId = sessions[group.folder];
        let contextPercent = 0;
        const cached = contextCache[group.folder];
        if (cached) {
          contextPercent = cached.percent;
        } else {
          try {
            const dbVal = await getRouterState(`context_pct:${group.folder}`);
            if (dbVal) contextPercent = JSON.parse(dbVal).percent ?? 0;
          } catch {
            /* ignore */
          }
        }

        // Calculate attachment folder size
        let attachmentSize = 0;
        try {
          const attachDir = path.join(
            resolveGroupFolderPath(group.folder),
            'attachments',
          );
          if (fs.existsSync(attachDir)) {
            for (const f of fs.readdirSync(attachDir)) {
              if (f.startsWith('.')) continue;
              try {
                attachmentSize += fs.statSync(path.join(attachDir, f)).size;
              } catch {
                /* skip */
              }
            }
          }
        } catch {
          /* dir doesn't exist */
        }

        return {
          jid,
          name: group.name,
          folder: group.folder,
          channel: chat?.channel,
          totalMessages: messages.length,
          userMessages: userMessages.length,
          botMessages: botMessages.length,
          hasSession: !!sessionId,
          lastActivity: chat?.last_message_time,
          transcriptSize: getTranscriptSize(group.folder, group.workDir),
          currentTranscriptSize: sessionId
            ? getSessionTranscriptSize(group.folder, sessionId, group.workDir)
            : 0,
          contextPercent,
          attachmentSize,
        };
      }),
    );

    res.json({
      ok: true,
      data: {
        groups: groupAnalytics,
        totalGroups: Object.keys(groups).length,
        totalTasks: tasks.length,
        activeTasks: tasks.filter((t) => t.status === 'active').length,
        totalSessions: Object.keys(sessions).length,
      },
    });
  });

  // ── Claude Plan Usage (from Chrome extension relay) ──
  router.post('/api/claude-usage', async (req: Request, res: Response) => {
    const { session, weeklyAll, weeklySonnet, scrapedAt } = req.body;
    const data = JSON.stringify({
      session,
      weeklyAll,
      weeklySonnet,
      scrapedAt,
    });
    await setRouterState('claude_usage', data);
    logger.info({ scrapedAt }, 'Claude usage data received from extension');
    res.json({ ok: true });
  });

  router.get('/api/claude-usage', async (_req: Request, res: Response) => {
    const raw = await getRouterState('claude_usage');
    if (!raw) {
      res.json({ ok: true, data: null });
      return;
    }
    res.json({ ok: true, data: JSON.parse(raw) });
  });

  // ── Token Usage Analytics ──
  router.get('/api/token-usage', async (req: Request, res: Response) => {
    const days = req.query.days ? Number(req.query.days) : undefined;
    const folder = req.query.folder as string | undefined;
    const since = req.query.since as string | undefined;
    const until = req.query.until as string | undefined;
    const summary = await getTokenUsageSummary(folder, days, since, until);
    res.json({ ok: true, data: summary });
  });

  // ── Token management (owner only) ──
  router.get('/api/tokens', async (req: Request, res: Response) => {
    const user = getUser(req);
    if (!user.isOwner) {
      res.status(403).json({ ok: false, error: 'Owner access required' });
      return;
    }
    const tokens = (await listTokens()).map((t) => ({
      ...t,
      token: t.isOwner ? t.token : t.token.slice(0, 8) + '...',
      tokenFull: t.token,
    }));
    res.json({ ok: true, data: tokens });
  });

  router.post('/api/tokens', async (req: Request, res: Response) => {
    const user = getUser(req);
    if (!user.isOwner) {
      res.status(403).json({ ok: false, error: 'Owner access required' });
      return;
    }
    const { name, role, allowedGroups, canSend } = req.body;
    if (!name) {
      res.status(400).json({ ok: false, error: 'name is required' });
      return;
    }
    const token = await createToken(
      name,
      role || '',
      allowedGroups || [],
      canSend !== false,
    );
    res.json({ ok: true, data: { token, name } });
  });

  router.delete('/api/tokens/:token', async (req: Request, res: Response) => {
    const user = getUser(req);
    if (!user.isOwner) {
      res.status(403).json({ ok: false, error: 'Owner access required' });
      return;
    }
    const deleted = await deleteToken(req.params.token as string);
    res.json({ ok: true, data: { deleted } });
  });

  // ── Context usage (reads from Claude Code's statusLine output) ──
  router.get(
    '/api/groups/:jid/context',
    async (req: Request, res: Response) => {
      const jid = decodeURIComponent(req.params.jid as string);
      const groups = await getAllRegisteredGroups();
      const group = groups[jid];
      const empty = { percent: 0, sizeKB: 0, tokens: 0 };
      if (!group) {
        res.json({ ok: true, data: empty });
        return;
      }

      try {
        const contextFile = path.join(
          resolveGroupIpcPath(group.folder),
          'context.json',
        );
        if (!fs.existsSync(contextFile)) {
          // Fall back to in-memory cache, then DB
          let cached = contextCache[group.folder];
          if (!cached) {
            try {
              const dbVal = await getRouterState(`context_pct:${group.folder}`);
              if (dbVal) {
                cached = JSON.parse(dbVal);
                contextCache[group.folder] = cached!;
              }
            } catch {
              /* ignore */
            }
          }
          res.json({ ok: true, data: cached || empty });
          return;
        }
        const ctx = JSON.parse(fs.readFileSync(contextFile, 'utf-8'));
        const cw = ctx.context_window || {};
        const percent = cw.used_percentage ?? 0;
        const tokens =
          (cw.current_usage?.input_tokens ?? 0) +
          (cw.current_usage?.cache_creation_input_tokens ?? 0) +
          (cw.current_usage?.cache_read_input_tokens ?? 0);
        const sizeKB = Math.round((tokens * 4) / 1024);

        res.json({
          ok: true,
          data: {
            percent,
            sizeKB,
            tokens,
            contextWindowSize: cw.context_window_size,
            rateLimits: ctx.rate_limits,
            sessionId: ctx.session_id,
          },
        });
      } catch {
        res.json({ ok: true, data: empty });
      }
    },
  );

  // ── Group settings (owner only) ──
  router.get(
    '/api/groups/:jid/settings',
    async (req: Request, res: Response) => {
      const user = getUser(req);
      if (!user.isOwner) {
        res.status(403).json({ ok: false, error: 'Owner access required' });
        return;
      }
      const jid = decodeURIComponent(req.params.jid as string);
      const groups = await getAllRegisteredGroups();
      const group = groups[jid];
      if (!group) {
        res.status(404).json({ ok: false, error: 'Group not found' });
        return;
      }

      // Find which tokens have access to this group
      const tokens = (await listTokens())
        .filter(
          (t) =>
            t.isOwner ||
            t.allowedGroups.length === 0 ||
            t.allowedGroups.includes(jid),
        )
        .map((t) => ({ name: t.name, role: t.role, isOwner: t.isOwner }));

      res.json({
        ok: true,
        data: {
          jid,
          name: group.name,
          folder: group.folder,
          channel: undefined,
          isMain: group.isMain || false,
          isTransient: group.isTransient || false,
          requiresTrigger: group.requiresTrigger ?? true,
          memoryMode: group.memoryMode || 'full',
          memoryScopes: group.memoryScopes || [],
          memoryUserId: group.memoryUserId || 'venky',
          showInSidebar: group.showInSidebar !== false,
          idleTimeoutMinutes: group.idleTimeoutMinutes ?? null,
          allowedSkills: group.allowedSkills || [],
          allowedMcpServers: group.allowedMcpServers || [],
          model: group.model || 'opus',
          contextWindow: group.contextWindow || '200k',
          tokens,
        },
      });
    },
  );

  router.put(
    '/api/groups/:jid/settings',
    async (req: Request, res: Response) => {
      const user = getUser(req);
      if (!user.isOwner) {
        res.status(403).json({ ok: false, error: 'Owner access required' });
        return;
      }
      const jid = decodeURIComponent(req.params.jid as string);
      const groups = await getAllRegisteredGroups();
      const group = groups[jid];
      if (!group) {
        res.status(404).json({ ok: false, error: 'Group not found' });
        return;
      }

      const {
        memoryMode,
        memoryScopes,
        isTransient,
        memoryUserId,
        showInSidebar,
        idleTimeoutMinutes,
        allowedSkills,
        mode,
        model,
        requiresTrigger,
      } = req.body;
      const updated = { ...group };
      if (memoryMode !== undefined) updated.memoryMode = memoryMode;
      if (memoryScopes !== undefined) updated.memoryScopes = memoryScopes;
      if (isTransient !== undefined) updated.isTransient = isTransient;
      if (memoryUserId !== undefined) updated.memoryUserId = memoryUserId;
      if (showInSidebar !== undefined) updated.showInSidebar = showInSidebar;
      if (idleTimeoutMinutes !== undefined)
        updated.idleTimeoutMinutes = idleTimeoutMinutes;
      if (allowedSkills !== undefined) updated.allowedSkills = allowedSkills;
      const allowedMcpServers = req.body.allowedMcpServers;
      if (allowedMcpServers !== undefined)
        updated.allowedMcpServers = allowedMcpServers;
      if (mode !== undefined && mode === 'tmux') updated.mode = mode;
      if (requiresTrigger !== undefined)
        updated.requiresTrigger = requiresTrigger;
      if (req.body.workDir !== undefined)
        updated.workDir = req.body.workDir || undefined;
      if (model !== undefined && (model === 'opus' || model === 'sonnet'))
        updated.model = model;
      const contextWindow = req.body.contextWindow;
      if (
        contextWindow !== undefined &&
        (contextWindow === '200k' || contextWindow === '1m')
      )
        updated.contextWindow = contextWindow;

      await setRegisteredGroup(jid, updated);
      res.json({
        ok: true,
        data: {
          jid,
          memoryMode: updated.memoryMode,
          memoryScopes: updated.memoryScopes,
          memoryUserId: updated.memoryUserId,
          isTransient: updated.isTransient,
        },
      });
    },
  );

  // ── mem0 memories (owner: list, scope, delete) ──
  router.get('/api/mem0/memories', async (req: Request, res: Response) => {
    const user = getUser(req);
    if (!user.isOwner) {
      res.status(403).json({ ok: false, error: 'Owner access required' });
      return;
    }
    if (!memoryServiceRef) {
      res.json({ ok: true, data: [] });
      return;
    }
    const memories = await memoryServiceRef.getAllMemories();
    res.json({ ok: true, data: memories });
  });

  router.post(
    '/api/mem0/memories/:id/scope',
    async (req: Request, res: Response) => {
      const user = getUser(req);
      if (!user.isOwner) {
        res.status(403).json({ ok: false, error: 'Owner access required' });
        return;
      }
      const { scope } = req.body;
      if (scope === undefined) {
        res.status(400).json({ ok: false, error: 'scope required' });
        return;
      }
      if (!memoryServiceRef?.isAvailable()) {
        res
          .status(503)
          .json({ ok: false, error: 'Memory service unavailable' });
        return;
      }
      try {
        const mem = await memoryServiceRef.updateMemoryScope(
          req.params.id as string,
          scope,
        );
        res.json({ ok: true, data: mem });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  router.delete(
    '/api/mem0/memories/:id',
    async (req: Request, res: Response) => {
      const user = getUser(req);
      if (!user.isOwner) {
        res.status(403).json({ ok: false, error: 'Owner access required' });
        return;
      }
      if (!memoryServiceRef?.isAvailable()) {
        res
          .status(503)
          .json({ ok: false, error: 'Memory service unavailable' });
        return;
      }
      try {
        await memoryServiceRef.deleteMemory(req.params.id as string);
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  // ── Move memory to shared ──
  router.post(
    '/api/mem0/memories/:id/move-to-shared',
    async (req: Request, res: Response) => {
      const user = getUser(req);
      if (!user.isOwner) {
        res.status(403).json({ ok: false, error: 'Owner access required' });
        return;
      }
      if (!memoryServiceRef?.isAvailable()) {
        res
          .status(503)
          .json({ ok: false, error: 'Memory service unavailable' });
        return;
      }
      const { scope, sourceUserId } = req.body;
      if (!scope) {
        res.status(400).json({ ok: false, error: 'scope required' });
        return;
      }
      try {
        await memoryServiceRef.moveToShared(
          req.params.id as string,
          scope,
          sourceUserId,
        );
        res.json({ ok: true });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  // ── Suggest scope for a memory ──
  router.post(
    '/api/mem0/suggest-scope',
    async (req: Request, res: Response) => {
      const user = getUser(req);
      if (!user.isOwner) {
        res.status(403).json({ ok: false, error: 'Owner access required' });
        return;
      }
      if (!memoryServiceRef?.isAvailable()) {
        res
          .status(503)
          .json({ ok: false, error: 'Memory service unavailable' });
        return;
      }
      const { text } = req.body;
      if (!text) {
        res.status(400).json({ ok: false, error: 'text required' });
        return;
      }
      try {
        const suggested = await memoryServiceRef.suggestScope(text);
        res.json({ ok: true, data: { scope: suggested } });
      } catch (err) {
        res.status(500).json({ ok: false, error: String(err) });
      }
    },
  );

  // ── Memory scope definitions (owner CRUD) ──
  router.get('/api/mem0/scopes', async (req: Request, res: Response) => {
    const user = getUser(req);
    if (!user.isOwner) {
      res.status(403).json({ ok: false, error: 'Owner access required' });
      return;
    }
    res.json({ ok: true, data: await getAllScopeDefs() });
  });

  router.post('/api/mem0/scopes', async (req: Request, res: Response) => {
    const user = getUser(req);
    if (!user.isOwner) {
      res.status(403).json({ ok: false, error: 'Owner access required' });
      return;
    }
    const { name, description } = req.body;
    if (!name || !description) {
      res
        .status(400)
        .json({ ok: false, error: 'name and description required' });
      return;
    }
    await createScopeDef(name, description);
    res.json({ ok: true, data: { name, description } });
  });

  router.delete(
    '/api/mem0/scopes/:name',
    async (req: Request, res: Response) => {
      const user = getUser(req);
      if (!user.isOwner) {
        res.status(403).json({ ok: false, error: 'Owner access required' });
        return;
      }
      await deleteScopeDef(req.params.name as string);
      res.json({ ok: true });
    },
  );

  // ── mem0 stats ──
  router.get('/api/mem0/stats', (_req: Request, res: Response) => {
    const dbPath = path.resolve(process.cwd(), 'memory.db');
    if (!fs.existsSync(dbPath)) {
      res.json({
        ok: true,
        data: { totalRecords: 0, dbSizeBytes: 0, dbSize: '0 KB', actions: {} },
      });
      return;
    }

    try {
      const stat = fs.statSync(dbPath);
      const db = new Database(dbPath, { readonly: true });
      const total = (
        db.prepare('SELECT COUNT(*) as c FROM memory_history').get() as {
          c: number;
        }
      ).c;
      const actions = db
        .prepare(
          'SELECT action, COUNT(*) as c FROM memory_history GROUP BY action',
        )
        .all() as Array<{ action: string; c: number }>;
      const recent = db
        .prepare(
          'SELECT memory_id, new_value, action, created_at FROM memory_history ORDER BY created_at DESC LIMIT 10',
        )
        .all() as Array<{
        memory_id: string;
        new_value: string;
        action: string;
        created_at: string;
      }>;
      db.close();

      const actionMap: Record<string, number> = {};
      for (const a of actions) actionMap[a.action] = a.c;

      res.json({
        ok: true,
        data: {
          totalRecords: total,
          dbSizeBytes: stat.size,
          dbSize:
            stat.size < 1024
              ? `${stat.size} B`
              : stat.size < 1048576
                ? `${(stat.size / 1024).toFixed(1)} KB`
                : `${(stat.size / 1048576).toFixed(1)} MB`,
          actions: actionMap,
          recent: recent.map((r) => ({
            id: r.memory_id,
            value: (r.new_value || '').slice(0, 100),
            action: r.action,
            createdAt: r.created_at,
          })),
        },
      });
    } catch (err) {
      res.json({
        ok: true,
        data: {
          totalRecords: 0,
          dbSizeBytes: 0,
          dbSize: '0 KB',
          actions: {},
          error: String(err),
        },
      });
    }
  });

  // ── File serving (attachments) ──
  router.get('/api/files/:folder/:filename', (req: Request, res: Response) => {
    const folder = req.params.folder as string;
    const filepath = req.params.filename as string;
    const thumb = req.query.thumb === '1';
    if (!folder || !filepath || filepath.includes('..')) {
      res.status(400).json({ ok: false, error: 'Invalid path' });
      return;
    }
    try {
      const fullPath = path.join(
        resolveGroupFolderPath(folder),
        'attachments',
        filepath,
      );
      if (!fs.existsSync(fullPath)) {
        logger.warn(
          { folder, filepath, fullPath },
          'File not found when serving',
        );
        res.status(404).json({ ok: false, error: 'File not found' });
        return;
      }
      const ext = path.extname(fullPath).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.txt': 'text/plain',
      };
      res.setHeader(
        'Content-Type',
        mimeTypes[ext] || 'application/octet-stream',
      );
      res.setHeader('Cache-Control', 'public, max-age=86400');

      // Serve thumbnail for images if requested (resize via sharp if available, else serve original)
      if (thumb && ['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
        const thumbDir = path.join(
          resolveGroupFolderPath(folder),
          'attachments',
          '.thumbs',
        );
        const thumbPath = path.join(thumbDir, filepath);
        if (fs.existsSync(thumbPath)) {
          fs.createReadStream(thumbPath).pipe(res);
          return;
        }
        // No pre-generated thumb — serve original with smaller size hint
        // Browser will handle resizing via CSS
      }

      fs.createReadStream(fullPath).pipe(res);
    } catch {
      res.status(500).json({ ok: false, error: 'Failed to serve file' });
    }
  });

  // ── Commands (for chat autocomplete) ──
  router.get('/api/commands', (req: Request, res: Response) => {
    const groupFolder = req.query.folder as string | undefined;
    const commands: Array<{ command: string; description: string; prefix?: string }> = [
      {
        command: 'new',
        description: 'Clear context and start a fresh session',
      },
      { command: 'compact', description: 'Force context compaction' },
      { command: 'context', description: 'Show context window usage' },
    ];
    const skillDirs = [
      path.resolve(process.cwd(), 'container', 'skills'),
      path.resolve(process.cwd(), '.claude', 'skills'),
    ];
    for (const dir of skillDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const skillFile = path.join(dir, name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        try {
          const parsed = parseSkillFrontmatter(
            fs.readFileSync(skillFile, 'utf-8'),
          );
          if (parsed.name) {
            commands.push({
              command: parsed.name,
              description: (parsed.description || '').slice(0, 100),
            });
          }
        } catch {
          /* skip */
        }
      }
    }
    // Add ! commands (scripts) scoped to the group
    if (groupFolder) {
      const groupCommands = listCommands(groupFolder);
      for (const cmd of groupCommands) {
        commands.push({
          command: cmd.name,
          description: cmd.description,
          prefix: '!',
        });
      }
    }

    res.json({ ok: true, data: commands });
  });

  // ── MCP Servers (from ~/.claude.json + .mcp.json in group workDirs) ──
  router.get('/api/mcp-servers', async (_req: Request, res: Response) => {
    const homeClaudeJson = path.join(os.homedir(), '.claude.json');
    const seen = new Set<string>();
    const servers: Array<{ name: string; type: string; source: string }> = [];
    const addServer = (name: string, config: any, source: string) => {
      if (name === 'nanoclaw' || seen.has(name)) return;
      seen.add(name);
      const type = config?.type === 'http' ? 'http' : 'stdio';
      servers.push({ name, type, source });
    };
    try {
      // Global MCP servers: mcp-servers.json (stable) + ~/.claude.json (volatile)
      const mcpConfigPath = path.join(process.cwd(), 'mcp-servers.json');
      if (fs.existsSync(mcpConfigPath)) {
        try {
          const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
          for (const [name, config] of Object.entries(mcpConfig.mcpServers || {})) {
            addServer(name, config, 'global');
          }
        } catch {}
      }
      if (fs.existsSync(homeClaudeJson)) {
        const parsed = JSON.parse(fs.readFileSync(homeClaudeJson, 'utf-8'));
        for (const [name, config] of Object.entries(parsed.mcpServers || {})) {
          addServer(name, config, 'global');
        }
      }
      // Project-scoped MCP servers from .mcp.json in group workDirs
      const groups = await getAllRegisteredGroups();
      const scannedDirs = new Set<string>();
      for (const group of Object.values(groups)) {
        if (!group.workDir) continue;
        const resolvedDir = path.resolve(group.workDir);
        if (scannedDirs.has(resolvedDir)) continue;
        scannedDirs.add(resolvedDir);
        const mcpJson = path.join(resolvedDir, '.mcp.json');
        if (fs.existsSync(mcpJson)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(mcpJson, 'utf-8'));
            for (const [name, config] of Object.entries(parsed.mcpServers || {})) {
              addServer(name, config, resolvedDir);
            }
          } catch {}
        }
      }
    } catch {}
    res.json({ ok: true, data: servers });
  });

  // ── Email Rules ──
  router.get('/api/email-rules', async (_req: Request, res: Response) => {
    try {
      const rules = await getEmailRules();
      res.json({ ok: true, data: rules });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Failed to load email rules' });
    }
  });

  router.post('/api/email-rules', async (req: Request, res: Response) => {
    try {
      const { name, priority, from_pattern, subject_pattern, body_pattern, action, target_group, command_name, extract_prompt, enabled } = req.body;
      if (!name) return res.status(400).json({ ok: false, error: 'Name is required' });
      const rule = await createEmailRule({
        name,
        priority: priority ?? 0,
        from_pattern: from_pattern || '',
        subject_pattern: subject_pattern || '',
        body_pattern: body_pattern || '',
        action: action || 'forward',
        target_group: target_group || '',
        command_name: command_name || '',
        extract_prompt: extract_prompt || '',
        enabled: enabled !== false,
      });
      res.json({ ok: true, data: rule });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Failed to create email rule' });
    }
  });

  router.put('/api/email-rules/:id', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const updates = req.body;
      delete updates.id;
      delete updates.created_at;
      delete updates.updated_at;
      await updateEmailRule(id, updates);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Failed to update email rule' });
    }
  });

  router.delete('/api/email-rules/:id', async (req: Request, res: Response) => {
    try {
      await deleteEmailRule(req.params.id as string);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Failed to delete email rule' });
    }
  });

  // ── Email Log ──
  router.get('/api/email-log', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;
      const log = await getEmailLog(limit, offset);
      res.json({ ok: true, data: log });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Failed to load email log' });
    }
  });

  // ── Extraction Stats (computed from email_log) ──
  router.get('/api/extraction-stats', async (_req: Request, res: Response) => {
    try {
      const log = await getEmailLog(10000, 0);
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const weekStart = new Date(now.getTime() - 7 * 86400000).toISOString();

      const stats = {
        today: { calls: 0, input_tokens: 0, output_tokens: 0 },
        week: { calls: 0, input_tokens: 0, output_tokens: 0 },
        total: { calls: log.length, input_tokens: 0, output_tokens: 0 },
        byType: { email: log.length } as Record<string, number>,
      };

      for (const entry of log) {
        stats.total.input_tokens += entry.input_tokens;
        stats.total.output_tokens += entry.output_tokens;
        if (entry.processed_at >= todayStart) {
          stats.today.calls++;
          stats.today.input_tokens += entry.input_tokens;
          stats.today.output_tokens += entry.output_tokens;
        }
        if (entry.processed_at >= weekStart) {
          stats.week.calls++;
          stats.week.input_tokens += entry.input_tokens;
          stats.week.output_tokens += entry.output_tokens;
        }
      }

      res.json({ ok: true, data: stats });
    } catch {
      res.json({ ok: true, data: { today: { calls: 0, input_tokens: 0, output_tokens: 0 }, week: { calls: 0, input_tokens: 0, output_tokens: 0 }, total: { calls: 0, input_tokens: 0, output_tokens: 0 }, byType: {} } });
    }
  });

  // ── Agent Alerts ──
  router.get('/api/alerts', async (_req: Request, res: Response) => {
    try {
      const alerts = await getAlerts();
      res.json({ ok: true, data: alerts });
    } catch {
      res.json({ ok: true, data: [] });
    }
  });

  router.post('/api/alerts/:id/dismiss', async (req: Request, res: Response) => {
    try {
      await dismissAlert(Number(req.params.id as string));
      res.json({ ok: true, data: null });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // ── Skills ──
  router.get('/api/skills', (_req: Request, res: Response) => {
    const skills: Array<{
      name: string;
      description: string;
      type: string;
      folder: string;
    }> = [];

    // Container skills
    const containerSkillsDir = path.resolve(
      process.cwd(),
      'container',
      'skills',
    );
    if (fs.existsSync(containerSkillsDir)) {
      for (const dir of fs.readdirSync(containerSkillsDir)) {
        const skillFile = path.join(containerSkillsDir, dir, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          const parsed = parseSkillFrontmatter(
            fs.readFileSync(skillFile, 'utf-8'),
          );
          skills.push({
            name: parsed.name || dir,
            description: parsed.description || '',
            type: 'container',
            folder: `container/skills/${dir}`,
          });
        }
      }
    }

    // Global user skills (~/.claude/skills/) — also synced by setupClaudeConfig
    const globalSkillsDir = path.join(os.homedir(), '.claude', 'skills');
    if (fs.existsSync(globalSkillsDir)) {
      for (const dir of fs.readdirSync(globalSkillsDir)) {
        const skillFile = path.join(globalSkillsDir, dir, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          const parsed = parseSkillFrontmatter(
            fs.readFileSync(skillFile, 'utf-8'),
          );
          const name = parsed.name || dir;
          // Skip if a container skill with the same name already exists
          if (skills.some((s) => s.name === name)) continue;
          skills.push({
            name,
            description: parsed.description || '',
            type: 'global',
            folder: `~/.claude/skills/${dir}`,
          });
        }
      }
    }

    res.json({ ok: true, data: skills });
  });

  // ── Push notification subscription ──
  router.get('/api/notifications/vapid-key', (_req: Request, res: Response) => {
    res.json({ ok: true, data: { publicKey: VAPID_PUBLIC_KEY } });
  });

  router.post(
    '/api/notifications/subscribe',
    async (req: Request, res: Response) => {
      const { endpoint, keys } = req.body;
      if (!endpoint || !keys?.p256dh || !keys?.auth) {
        res.status(400).json({ ok: false, error: 'Invalid subscription' });
        return;
      }
      const userAgent = (req.headers['user-agent'] || '').slice(0, 200);
      await savePushSubscription({
        id: randomUUID(),
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        user_agent: userAgent,
        created_at: new Date().toISOString(),
      });
      logger.info({ endpoint: endpoint.slice(-30) }, 'Push subscription saved');
      res.json({ ok: true });
    },
  );

  router.delete(
    '/api/notifications/subscribe',
    async (req: Request, res: Response) => {
      const { endpoint } = req.body;
      if (!endpoint) {
        res.status(400).json({ ok: false, error: 'endpoint required' });
        return;
      }
      await deletePushSubscription(endpoint);
      res.json({ ok: true });
    },
  );

  // ── Finance sub-app routes (loaded from ~/Projects/deven-finance/) ─────────
  try {
    const financePath = path.resolve(os.homedir(), 'Projects', 'deven-finance', 'dist', 'api', 'index.js');
    if (fs.existsSync(financePath)) {
      const { createFinanceRouter } = await import(financePath);
      const financeRouter = createFinanceRouter({
        Router,
        getDbClient,
        getAllTenjinSnapshots,
        getTenjinSnapshot,
        fetchAndStoreTenjinSnapshot,
      });
      router.use('/api/finance', financeRouter);
      logger.info('Finance sub-app routes loaded from deven-finance');
    } else {
      logger.warn({ financePath }, 'Finance sub-app not found, finance routes disabled');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to load finance sub-app routes');
  }

  return router;
}

function parseSkillFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  try {
    const parsed = YAML.parse(match[1]);
    return {
      name: parsed?.name,
      description: parsed?.description,
    };
  } catch {
    return {};
  }
}
