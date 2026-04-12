import http from 'http';
import fs from 'fs';
import os from 'os';
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
import { Router } from 'express';
import puppeteer from 'puppeteer';
import { DASHBOARD_PORT } from '../config.js';

const STATIC_DIR = path.resolve(process.cwd(), 'public', 'dashboard');

export async function startDashboard(
  port: number,
  opts?: { getActiveGroupFolders?: () => string[] },
): Promise<http.Server> {
  const app = express();

  app.use(express.json());

  // Auth middleware — resolve user from token, attach to request
  // Exempt non-sensitive relay endpoints from auth (Chrome extension can't easily carry tokens)
  app.use('/api', async (req, res, next) => {
    if (req.method === 'POST' && req.path === '/claude-usage') return next();
    const user = await getRequestUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }
    // Attach user to request for route handlers
    (req as any).tokenUser = user;
    next();
  });

  app.use(await createRouter());

  // Back-to-dashboard snippet injected into sub-app index.html
  const backButtonSnippet = `<div id="mc-back" style="position:fixed;top:env(safe-area-inset-top,0);left:0;right:0;height:52px;background:var(--surface,#fff);border-bottom:1px solid rgba(0,0,0,.08);display:flex;align-items:center;padding:0 16px;gap:12px;z-index:9999;font-family:Inter,-apple-system,system-ui,sans-serif">
<a href="/" style="display:flex;align-items:center;gap:8px;text-decoration:none;color:inherit;font-size:14px;font-weight:500">
<span class="material-symbols-outlined" style="font-size:22px">arrow_back</span>Mission Control</a></div>
<style>#mc-back~#root,#mc-back~div{padding-top:52px!important}</style>`;
  const serveSubAppIndex = (indexPath: string, res: express.Response) => {
    if (!fs.existsSync(indexPath)) {
      res.status(404).send('App not found');
      return;
    }
    let html = fs.readFileSync(indexPath, 'utf-8');
    html = html.replace('</body>', backButtonSnippet + '</body>');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  };

  // Finance sub-app static files
  const FINANCE_DIR = path.join(process.cwd(), 'public', 'finance');
  // Serve index.html with back button injected
  app.get('/finance/', (_req, res) =>
    serveSubAppIndex(path.join(FINANCE_DIR, 'index.html'), res),
  );
  app.get('/finance', (_req, res) => res.redirect('/finance/'));
  app.use(
    '/finance',
    express.static(FINANCE_DIR, {
      index: false, // Don't auto-serve index.html — we handle it above
      setHeaders: (res, filePath) => {
        if (filePath.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  // Finance SPA fallback — serve finance index.html for all /finance/* routes
  app.get('/finance/{*path}', (_req, res) => {
    serveSubAppIndex(path.join(FINANCE_DIR, 'index.html'), res);
  });

  // Creatives sub-app static files
  const CREATIVES_DIR = path.join(process.cwd(), 'public', 'creatives');
  app.get('/creatives/', (_req, res) =>
    serveSubAppIndex(path.join(CREATIVES_DIR, 'index.html'), res),
  );
  app.get('/creatives', (_req, res) => res.redirect('/creatives/'));
  app.use(
    '/creatives',
    express.static(CREATIVES_DIR, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  // Creatives export API (loaded from ~/Projects/DevenCreativesPortal/)
  try {
    const creativesApiPath = path.resolve(
      os.homedir(),
      'Projects',
      'DevenCreativesPortal',
      'dist',
      'api',
      'index.js',
    );
    if (fs.existsSync(creativesApiPath)) {
      const { createCreativesRouter } = await import(creativesApiPath);
      const creativesRouter = createCreativesRouter({
        Router,
        puppeteer,
        dashboardPort: DASHBOARD_PORT,
      });
      app.use(
        '/api/creatives',
        express.json({ limit: '20mb' }),
        creativesRouter,
      );
      logger.info('Creatives sub-app routes loaded from DevenCreativesPortal');
    } else {
      logger.warn(
        { creativesApiPath },
        'Creatives sub-app not found, creatives API disabled',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Failed to load creatives sub-app routes');
  }

  // Creatives SPA fallback — serve creatives index.html for all /creatives/* routes
  app.get('/creatives/{*path}', (_req, res) => {
    serveSubAppIndex(path.join(CREATIVES_DIR, 'index.html'), res);
  });

  // Analytics (Metabase) sub-app
  const ANALYTICS_DIR = path.join(process.cwd(), 'public', 'analytics');
  app.get('/analytics/', (_req, res) =>
    serveSubAppIndex(path.join(ANALYTICS_DIR, 'index.html'), res),
  );
  app.get('/analytics', (_req, res) => res.redirect('/analytics/'));
  app.use(
    '/analytics',
    express.static(ANALYTICS_DIR, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.includes('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  app.get('/analytics/{*path}', (_req, res) => {
    serveSubAppIndex(path.join(ANALYTICS_DIR, 'index.html'), res);
  });

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
    forward('agent:stuck');
    forward('agent:alert');

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
