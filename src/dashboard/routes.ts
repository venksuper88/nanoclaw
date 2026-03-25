import { execSync } from 'child_process';
import { Router, Request, Response } from 'express';
import fs from 'fs';
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
  setRegisteredGroup,
  storeMessage,
  updateTask,
  getAllScopeDefs,
  createScopeDef,
  deleteScopeDef,
  getDraft,
  setDraft,
} from '../db.js';
import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import { dashboardEvents } from './events.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { formatMessages } from '../router.js';
import { logger } from '../logger.js';
import { randomUUID } from 'crypto';
import { savePushSubscription, deletePushSubscription } from '../db.js';
import { VAPID_PUBLIC_KEY } from '../config.js';

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
) => Promise<void>;

/**
 * Callback to close a group's active container.
 */
export type SessionKillFn = (chatJid: string) => void;

import type { MemoryService } from '../memory.js';

let chatSendFn: ChatSendFn | null = null;
let sessionKillFn: SessionKillFn | null = null;
let memoryServiceRef: MemoryService | null = null;
let activeGroupsFn: (() => string[]) | null = null;

export function setChatSendFn(fn: ChatSendFn): void {
  chatSendFn = fn;
}

export function setSessionKillFn(fn: SessionKillFn): void {
  sessionKillFn = fn;
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

export function createRouter(): Router {
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
        };
      });

    res.json({ ok: true, data });
  });

  // ── Drafts ──
  router.get('/api/groups/:jid/draft', async (req: Request, res: Response) => {
    const user = getUser(req);
    const jid = decodeURIComponent(req.params.jid as string);
    if (!canAccessGroup(user, jid)) { res.status(403).json({ ok: false, error: 'Access denied' }); return; }
    const content = await getDraft(jid);
    res.json({ ok: true, data: { content } });
  });

  router.put('/api/groups/:jid/draft', async (req: Request, res: Response) => {
    const user = getUser(req);
    const jid = decodeURIComponent(req.params.jid as string);
    if (!canAccessGroup(user, jid)) { res.status(403).json({ ok: false, error: 'Access denied' }); return; }
    const { content = '' } = req.body;
    await setDraft(jid, String(content));
    dashboardEvents.emitEvent('draft:update', { chatJid: jid, content: String(content) });
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
    const { chatJid, text } = req.body;
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

    // Use the token user's name as the sender
    await chatSendFn(chatJid, text, user.name);
    res.json({ ok: true });
  });

  // ── File upload ──
  router.post(
    '/api/groups/:folder/upload',
    upload.single('file'),
    (req: Request, res: Response) => {
      if (!req.file) {
        res.status(400).json({ ok: false, error: 'No file uploaded' });
        return;
      }

      const containerPath = `/workspace/group/attachments/${req.file.originalname}`;
      logger.info(
        { folder: req.params.folder as string, file: req.file.originalname },
        'File uploaded via dashboard',
      );

      res.json({
        ok: true,
        data: {
          filename: req.file.originalname,
          size: req.file.size,
          path: containerPath,
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

  // ── Tasks ──
  router.get('/api/tasks', async (_req: Request, res: Response) => {
    const tasks = await getAllTasks();
    res.json({ ok: true, data: tasks });
  });

  router.get('/api/tasks/:id', async (req: Request, res: Response) => {
    const task = await getTaskById(req.params.id as string);
    if (!task) {
      res.status(404).json({ ok: false, error: 'Task not found' });
      return;
    }
    res.json({ ok: true, data: task });
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

        return {
          jid,
          name: group.name,
          folder: group.folder,
          channel: chat?.channel,
          totalMessages: messages.length,
          userMessages: userMessages.length,
          botMessages: botMessages.length,
          hasSession: !!sessions[group.folder],
          lastActivity: chat?.last_message_time,
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

  // ── Container stats (CPU/memory) ──
  router.get('/api/containers/stats', (_req: Request, res: Response) => {
    try {
      const raw = execSync(
        'docker stats --no-stream --format "{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.PIDs}}" 2>/dev/null',
        { timeout: 5000 },
      )
        .toString()
        .trim();

      if (!raw) {
        res.json({ ok: true, data: [] });
        return;
      }

      const containers = raw
        .split('\n')
        .filter((l) => l.includes('nanoclaw'))
        .map((line) => {
          const [name, cpu, mem, pids] = line.split('\t');
          return { name, cpu, mem, pids: parseInt(pids || '0', 10) };
        });

      res.json({ ok: true, data: containers });
    } catch {
      res.json({ ok: true, data: [] });
    }
  });

  // ── Context usage ──
  router.get(
    '/api/groups/:jid/context',
    async (req: Request, res: Response) => {
      const jid = decodeURIComponent(req.params.jid as string);
      const groups = await getAllRegisteredGroups();
      const group = groups[jid];
      if (!group) {
        res.json({ ok: true, data: { percent: 0, sizeKB: 0 } });
        return;
      }

      const sessions = await getAllSessions();
      const sessionId = sessions[group.folder];
      if (!sessionId) {
        res.json({ ok: true, data: { percent: 0, sizeKB: 0 } });
        return;
      }

      const transcriptFile = path.join(
        path.resolve(
          process.cwd(),
          'data',
          'sessions',
          group.folder,
          '.claude',
          'projects',
          '-workspace-group',
        ),
        `${sessionId}.jsonl`,
      );

      if (!fs.existsSync(transcriptFile)) {
        res.json({ ok: true, data: { percent: 0, sizeKB: 0 } });
        return;
      }

      // Read real token counts from the transcript's usage data.
      // Each assistant message has "usage":{"input_tokens":N,"cache_creation_input_tokens":N,"cache_read_input_tokens":N}
      // The last usage entry gives the current context size.
      // Max context: 1M tokens for Max plan.
      try {
        const stat = fs.statSync(transcriptFile);
        // Only read the tail — usage is in the most recent messages
        const TAIL_READ = Math.min(stat.size, 512 * 1024); // last 512KB
        const buf = Buffer.alloc(TAIL_READ);
        const fd = fs.openSync(transcriptFile, 'r');
        fs.readSync(fd, buf, 0, TAIL_READ, stat.size - TAIL_READ);
        fs.closeSync(fd);
        const tail = buf.toString('utf-8');

        // Find the last "usage" block — scan from end
        let lastInputTokens = 0;
        let lastCacheCreate = 0;
        let lastCacheRead = 0;
        let msgCount = 0;

        const lines = tail.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          if (!line.includes('"usage"')) continue;

          // Extract token counts with regex (faster than JSON.parse for large lines)
          const inputMatch = line.match(/"input_tokens":(\d+)/);
          const cacheCreateMatch = line.match(
            /"cache_creation_input_tokens":(\d+)/,
          );
          const cacheReadMatch = line.match(/"cache_read_input_tokens":(\d+)/);

          if (inputMatch || cacheCreateMatch || cacheReadMatch) {
            lastInputTokens = inputMatch ? parseInt(inputMatch[1], 10) : 0;
            lastCacheCreate = cacheCreateMatch
              ? parseInt(cacheCreateMatch[1], 10)
              : 0;
            lastCacheRead = cacheReadMatch
              ? parseInt(cacheReadMatch[1], 10)
              : 0;
            break;
          }
        }

        // Count user messages in the tail for display
        for (const line of lines) {
          if (line.includes('"type":"user"')) msgCount++;
        }

        const totalTokens = lastInputTokens + lastCacheCreate + lastCacheRead;
        const MAX_CONTEXT_TOKENS = 1_000_000; // 1M for Max plan
        const percent =
          totalTokens > 0
            ? Math.min(99, Math.round((totalTokens / MAX_CONTEXT_TOKENS) * 100))
            : 0;
        const sizeKB = Math.round((totalTokens * 4) / 1024); // ~4 chars/token rough size

        res.json({
          ok: true,
          data: { percent, sizeKB, messages: msgCount, tokens: totalTokens },
        });
      } catch {
        res.json({
          ok: true,
          data: { percent: 0, sizeKB: 0, messages: 0, tokens: 0 },
        });
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
  router.get('/api/commands', (_req: Request, res: Response) => {
    const commands: Array<{ command: string; description: string }> = [
      {
        command: 'new',
        description: 'Clear context and start a fresh session',
      },
      { command: 'compact', description: 'Force context compaction' },
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
    res.json({ ok: true, data: commands });
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

    // Claude Code skills
    const codeSkillsDir = path.resolve(process.cwd(), '.claude', 'skills');
    if (fs.existsSync(codeSkillsDir)) {
      for (const dir of fs.readdirSync(codeSkillsDir)) {
        const skillFile = path.join(codeSkillsDir, dir, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          const parsed = parseSkillFrontmatter(
            fs.readFileSync(skillFile, 'utf-8'),
          );
          skills.push({
            name: parsed.name || dir,
            description: parsed.description || '',
            type: 'claude-code',
            folder: `.claude/skills/${dir}`,
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
