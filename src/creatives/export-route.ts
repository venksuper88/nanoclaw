import { Router, Request, Response } from 'express';
import puppeteer, { Browser } from 'puppeteer';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { DASHBOARD_PORT } from '../config.js';

const router = Router();
const TEMPLATES_DIR = path.join(
  process.cwd(),
  'public',
  'creatives',
  'templates',
);
const STYLES_PATH = path.join(
  process.cwd(),
  'public',
  'creatives',
  'styles.json',
);

// ── Persistent browser + serialized export queue ────────────────────────────
let _browser: Browser | null = null;
let _exportQueue = Promise.resolve(); // serialize requests — one Puppeteer page at a time

async function getBrowser(): Promise<Browser> {
  if (_browser) {
    try {
      // Quick health check — throws if browser has crashed
      await _browser.version();
      return _browser;
    } catch {
      _browser = null;
    }
  }
  _browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  return _browser;
}

// ── Template persistence ────────────────────────────────────────────────────

// GET /api/creatives/templates — list all saved templates
router.get('/templates', (_req: Request, res: Response) => {
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  const files = fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.json'));
  const templates = files.flatMap((f) => {
    try {
      return [JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8'))];
    } catch {
      return [];
    }
  });
  res.json(templates);
});

// POST /api/creatives/templates/:id — save/update a template
router.post('/templates/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))
    return res.status(400).json({ error: 'Invalid template id' });
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TEMPLATES_DIR, `${id}.json`),
    JSON.stringify(req.body, null, 2),
  );
  res.json({ ok: true });
});

// DELETE /api/creatives/templates/:id — delete a template
router.delete('/templates/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id))
    return res.status(400).json({ error: 'Invalid template id' });
  const filePath = path.join(TEMPLATES_DIR, `${id}.json`);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: 'Template not found' });
  fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ── Styles persistence ──────────────────────────────────────────────────────

// GET /api/creatives/styles — load persisted style overrides
router.get('/styles', (_req: Request, res: Response) => {
  if (!fs.existsSync(STYLES_PATH)) return res.json({});
  try {
    res.json(JSON.parse(fs.readFileSync(STYLES_PATH, 'utf8')));
  } catch {
    res.json({});
  }
});

// POST /api/creatives/styles — save style overrides
router.post('/styles', (req: Request, res: Response) => {
  fs.mkdirSync(path.dirname(STYLES_PATH), { recursive: true });
  fs.writeFileSync(STYLES_PATH, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// ── Export ──────────────────────────────────────────────────────────────────

/**
 * POST /api/creatives/export
 *
 * Body: { templateId, zones: { [zoneId]: { text?, src? } } }
 * Response: image/png
 */
router.post('/export', async (req: Request, res: Response) => {
  const { templateId, zones } = req.body as {
    templateId?: string;
    zones?: Record<string, { text?: string; src?: string }>;
  };

  if (!templateId)
    return res.status(400).json({ error: 'templateId is required' });

  const templatePath = path.join(TEMPLATES_DIR, `${templateId}.json`);
  if (!fs.existsSync(templatePath)) {
    return res
      .status(404)
      .json({ error: `Template "${templateId}" not found` });
  }

  let template: { canvas: { width: number; height: number } };
  try {
    template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  } catch {
    return res.status(500).json({ error: 'Failed to parse template JSON' });
  }

  // Include full template + styles in export_data so ExportCanvas doesn't need to fetch
  let styles: Record<string, unknown> = {};
  if (fs.existsSync(STYLES_PATH)) {
    try { styles = JSON.parse(fs.readFileSync(STYLES_PATH, 'utf8')); } catch {}
  }
  const exportData = Buffer.from(
    JSON.stringify({
      templateId,
      template,
      zones: zones ?? {},
      styles,
    }),
  ).toString('base64');

  const renderUrl = `http://localhost:${DASHBOARD_PORT}/creatives/?export_data=${exportData}`;

  // Serialize: queue this export after any in-flight one
  let pngBuffer: Buffer;
  const result = await new Promise<
    { ok: true; buf: Buffer } | { ok: false; msg: string }
  >((resolve) => {
    _exportQueue = _exportQueue.then(async () => {
      let page;
      try {
        const browser = await getBrowser();
        page = await browser.newPage();
        await page.setCacheEnabled(false);
        // Render at 2x for sharper text/edges, then downscale to target size
        await page.setViewport({
          width: template.canvas.width,
          height: template.canvas.height,
          deviceScaleFactor: 2,
        });

        await page.goto(renderUrl, {
          waitUntil: 'networkidle0',
          timeout: 20000,
        });
        // Wait for ExportCanvas to signal layout is complete (AutoFitText done)
        await page.waitForSelector('#export-canvas[data-ready]', {
          timeout: 5000,
        });

        const canvasEl = await page.$('#export-canvas');
        if (!canvasEl) {
          resolve({ ok: false, msg: 'Canvas element not found' });
          return;
        }

        const png = await canvasEl.screenshot({ type: 'png' });
        const raw = Buffer.isBuffer(png) ? png : Buffer.from(png as Uint8Array);
        // Downscale 2x screenshot back to target canvas size (Lanczos3 = high quality)
        const buf = await sharp(raw)
          .resize(template.canvas.width, template.canvas.height, { kernel: 'lanczos3' })
          .png()
          .toBuffer();
        resolve({ ok: true, buf });
      } catch (err) {
        resolve({
          ok: false,
          msg: err instanceof Error ? err.message : String(err),
        });
      } finally {
        if (page) await page.close();
      }
    });
  });

  if (!result.ok)
    return res.status(500).json({ error: `Render failed: ${result.msg}` });
  pngBuffer = result.buf;

  res.set('Content-Type', 'image/png');
  res.set('Content-Disposition', `attachment; filename="${templateId}.png"`);
  res.end(pngBuffer);
});

export default router;
