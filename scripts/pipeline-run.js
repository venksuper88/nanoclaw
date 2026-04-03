#!/usr/bin/env node
/**
 * Ad Creative Pipeline
 *
 * One-shot runner: syncs Drive → exports all permutations → uploads to Drive.
 *
 * Usage:
 *   DASHBOARD_TOKEN=<token> API_BASE=https://mc.neved.in \
 *   node scripts/pipeline-run.js <template_id> <sheet_gid>
 *
 * Drive layout:
 *   gdrive:Devi/Ad Pipeline/Input   — BG images only
 *   gdrive:Devi/Ad Pipeline/Assets  — shared assets (button, logo, etc.)
 *   gdrive:Devi/Ad Pipeline/Output  — exports land here
 *
 * Sheet columns (one tab per template):
 *   zone_1_src  | zone_2_text       | zone_3_text       | zone_3_src
 *   (ignored)   | Headline text...  | Button text...    | Button.png
 *
 *   zone_2_text  — all non-empty rows = headline permutation dimension
 *   zone_3_text  — all non-empty rows = button text permutation dimension
 *   zone_3_src   — first non-empty value = button asset filename from Assets folder
 *   zone_1_src   — ignored; BG images come from Drive Input folder
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMPLATE_ID = process.argv[2];
const SHEET_GID   = process.argv[3];
const SHEET_ID    = '1Y27STGF8NllPUlQQrLAv17EotF_vd09IIVf3MUBKkLs';
const API_BASE    = process.env.API_BASE || 'http://localhost:3000';
const TOKEN       = process.env.DASHBOARD_TOKEN || '';

const LOCAL_INPUT  = path.join(__dirname, '..', 'public', 'creatives', 'pipeline', 'input');
const LOCAL_ASSETS = path.join(__dirname, '..', 'public', 'creatives', 'pipeline', 'assets');
const LOCAL_OUTPUT = path.join(__dirname, '..', 'public', 'creatives', 'pipeline', 'output');
const DRIVE_INPUT  = 'gdrive:Devi/Ad Pipeline/Input';
const DRIVE_ASSETS = 'gdrive:Devi/Ad Pipeline/Assets';
const DRIVE_OUTPUT = 'gdrive:Devi/Ad Pipeline/Output';

if (!TEMPLATE_ID || !SHEET_GID) {
  console.error('Usage: node scripts/pipeline-run.js <template_id> <sheet_gid>');
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function elapsed(ms) { return `${(ms / 1000).toFixed(1)}s`; }

function rclone(cmd, src, dst) {
  try {
    execSync(`rclone ${cmd} "${src}" "${dst}"`, { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`rclone ${cmd} failed: ${e.stderr?.toString().trim() || e.message}`);
  }
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return resolve(fetchUrl(res.headers.location));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? '']));
  });
}

function slug(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 40);
}

function callExportAPI(templateId, zones) {
  const body = JSON.stringify({ templateId, zones });
  const url = new URL(`${API_BASE}/api/creatives/export`);
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${TOKEN}`,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, contentType: res.headers['content-type'] || '', body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  fs.mkdirSync(LOCAL_INPUT,  { recursive: true });
  fs.mkdirSync(LOCAL_ASSETS, { recursive: true });
  // Clear local output so stale files from previous runs aren't re-uploaded
  fs.rmSync(LOCAL_OUTPUT, { recursive: true, force: true });
  fs.mkdirSync(LOCAL_OUTPUT, { recursive: true });

  // Step 1: Sync Drive → local (mirror so stale files are cleaned up)
  const t1 = Date.now();
  rclone('sync', DRIVE_INPUT,  LOCAL_INPUT);
  rclone('sync', DRIVE_ASSETS, LOCAL_ASSETS);
  const syncTime = Date.now() - t1;

  // Step 2: Read sheet
  const t2 = Date.now();
  const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
  const csvResp = await fetchUrl(csvUrl);
  if (csvResp.status !== 200) throw new Error(`Sheet fetch failed: HTTP ${csvResp.status}`);
  const rows = parseCSV(csvResp.body.toString());
  const sheetTime = Date.now() - t2;

  // Extract permutation dimensions
  const zone2Texts = [...new Set(rows.map(r => r.zone_2_text).filter(Boolean))];
  const zone3Texts = [...new Set(rows.map(r => r.zone_3_text).filter(Boolean))];
  const buttonFile = rows.map(r => r.zone_3_src).find(Boolean) || '';
  const logoFile   = rows.map(r => r.zone_4_src).find(Boolean) || 'Logo.png';

  // BG images = everything in Input folder
  const bgImages = fs.readdirSync(LOCAL_INPUT).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
  if (!bgImages.length) throw new Error('No BG images in Drive Input — upload images first.');

  // Build permutations: BG × zone_2 × zone_3
  const combos = [];
  for (const bg of bgImages)
    for (const z2 of zone2Texts)
      for (const z3 of (zone3Texts.length ? zone3Texts : ['']))
        combos.push({ bg, z2, z3 });

  // Step 3: Export
  const t3 = Date.now();
  let done = 0, failed = 0;
  const results = [];

  for (const { bg, z2, z3 } of combos) {
    const outName = `${slug(TEMPLATE_ID)}_${slug(bg)}_${slug(z2)}${z3 ? '_' + slug(z3) : ''}.png`;
    const zones = { zone_1: { src: `/creatives/pipeline/input/${bg}` }, zone_2: { text: z2 } };
    if (z3)         zones.zone_3 = { text: z3 };
    if (buttonFile) zones.zone_3 = { ...zones.zone_3, src: `/creatives/pipeline/assets/${buttonFile}` };
    if (logoFile)   zones.zone_4 = { src: `/creatives/pipeline/assets/${logoFile}` };

    const te = Date.now();
    const result = await callExportAPI(TEMPLATE_ID, zones);
    const exportMs = Date.now() - te;

    if (result.status === 200 && result.contentType.includes('image')) {
      fs.writeFileSync(path.join(LOCAL_OUTPUT, outName), result.body);
      results.push({ ok: true, name: outName, kb: Math.round(result.body.length / 1024), ms: exportMs });
      done++;
    } else {
      results.push({ ok: false, name: outName, error: result.body.toString().slice(0, 120) });
      failed++;
    }
  }
  const exportTime = Date.now() - t3;

  // Step 4: Upload to Drive Output
  const t4 = Date.now();
  // Delete only root-level PNGs (our pipeline's files) before uploading,
  // to avoid accumulation without needing delete permission on shared subdirs.
  try {
    execSync(`rclone delete --include "*.png" --max-depth 1 "${DRIVE_OUTPUT}"`, { stdio: 'pipe' });
  } catch (_) { /* ignore — may be empty or have no owned files yet */ }
  rclone('copy', LOCAL_OUTPUT, DRIVE_OUTPUT);
  const uploadTime = Date.now() - t4;

  const totalTime = Date.now() - t0;

  // ── Summary ──
  const lines = [
    `Pipeline complete — ${done} exported, ${failed} failed`,
    ``,
    `Timing:`,
    `  Drive sync   ${elapsed(syncTime)}`,
    `  Sheet read   ${elapsed(sheetTime)}`,
    `  Exports ×${combos.length}  ${elapsed(exportTime)}`,
    `  Upload       ${elapsed(uploadTime)}`,
    `  Total        ${elapsed(totalTime)}`,
    ``,
    `Files → gdrive:Devi/Ad Pipeline/Output`,
  ];
  for (const r of results)
    lines.push(r.ok ? `  ✓ ${r.name} (${r.kb}KB, ${elapsed(r.ms)})` : `  ✗ ${r.name}: ${r.error}`);

  console.log(lines.join('\n'));
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('Pipeline error:', e.message); process.exit(1); });
