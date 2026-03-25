import http from 'http';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';

import { logger } from '../logger.js';
import {
  canAccessGroup,
  getRequestUser,
  isSocketAuthenticated,
  type TokenUser,
} from './auth.js';
import { dashboardEvents, type DashboardEventMap } from './events.js';
import { createRouter } from './routes.js';

const STATIC_DIR = path.resolve(process.cwd(), 'public', 'dashboard');

export async function startDashboard(port: number, opts?: { getActiveGroupFolders?: () => string[] }): Promise<http.Server> {
  const app = express();

  app.use(express.json());

  // Auth middleware — resolve user from token, attach to request
  app.use('/api', async (req, res, next) => {
    const user = await getRequestUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    // Attach user to request for route handlers
    (req as any).tokenUser = user;
    next();
  });

  app.use(createRouter());

  // Static files (SPA)
  // Serve hashed assets with long cache; index.html must never be cached so
  // iOS Safari always fetches the latest entry point after a new build.
  app.use(
    express.static(STATIC_DIR, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        } else if (filePath.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  app.get('/{*path}', (_req, res) => {
    const indexPath = path.join(STATIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.sendFile(indexPath);
    } else {
      res.status(404).send('Dashboard not built. Run: cd web && npm run build');
    }
  });

  const server = http.createServer(app);

  // Socket.io
  const io = new SocketIOServer(server, {
    cors: { origin: '*' },
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    const user = await isSocketAuthenticated(token);
    if (user) {
      (socket as any).tokenUser = user;
      next();
    } else {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user: TokenUser = (socket as any).tokenUser;
    logger.debug(
      { socketId: socket.id, name: user.name },
      'Dashboard client connected',
    );

    const listeners: Array<{
      event: string;
      handler: (...args: unknown[]) => void;
    }> = [];

    // Forward events, filtered by user's allowed groups
    const forward = (event: keyof DashboardEventMap) => {
      const handler = (...args: unknown[]) => {
        const data = args[0] as any;
        // Filter events by group access if the event has group info
        if (data?.chatJid && !canAccessGroup(user, data.chatJid)) return;
        if (data?.groupFolder) {
          // groupFolder-based events need JID lookup — allow for now
          // (non-owner filtering is best-effort on socket events)
        }
        socket.emit(event, data);
      };
      dashboardEvents.on(event, handler);
      listeners.push({ event, handler });
    };

    forward('message:new');
    forward('agent:spawn');
    forward('agent:output');
    forward('agent:idle');
    forward('agent:exit');
    forward('draft:update');
    forward('task:complete');
    forward('context:update');
    forward('container:log');

    // Re-emit agent:spawn for any groups currently being processed
    // so clients that reconnect (phone screen lock, background) catch up
    const activeFolders = opts?.getActiveGroupFolders?.() ?? [];
    for (const groupFolder of activeFolders) {
      socket.emit('agent:spawn', { groupFolder });
    }

    socket.on('disconnect', () => {
      for (const { event, handler } of listeners) {
        dashboardEvents.off(event, handler);
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      logger.info({ port }, 'Mission Control started');
      resolve(server);
    });
  });
}
