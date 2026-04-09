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

const TEMPLATE_ID  = process.argv[2];
const SHEET_GID    = process.argv[3];
const ROWS_ARG     = process.argv[4] || 'all'; // e.g. "1", "1-10", "1,3,5", "all"
const LANG_SUFFIX  = process.argv[5] || '';    // e.g. "ru", "de", "fr" — appended to output filenames
const IMAGES_ARG   = process.env.IMAGES_FILTER || 'all'; // e.g. "1", "1-3", "2,4", "all"
const SHEET_ID    = '1Y27STGF8NllPUlQQrLAv17EotF_vd09IIVf3MUBKkLs';
const API_BASE    = process.env.API_BASE || 'http://localhost:3000';
const TOKEN       = process.env.DASHBOARD_TOKEN || '';

const INPUT_FOLDER  = process.env.INPUT_FOLDER || '';  // e.g. "Input_1:1", "Input_9:16"
const OUTPUT_FOLDER = INPUT_FOLDER ? INPUT_FOLDER.replace(/^Input_/, 'Output_') : '';
// Dimension suffix for filenames: "Input_9:16" → "9_16", "Input_1.91:1" → "1_91_1"
const DIM_SUFFIX    = INPUT_FOLDER
  ? INPUT_FOLDER.replace(/^Input_/, '').replace(/[:.]/g, '_').replace(/_+/g, '_').replace(/^_|_$/, '')
  : '';
const LOCAL_INPUT   = path.join(__dirname, '..', 'public', 'creatives', 'pipeline', 'input', ...(INPUT_FOLDER ? [INPUT_FOLDER] : []));
const LOCAL_ASSETS  = path.join(__dirname, '..', 'public', 'creatives', 'pipeline', 'assets');
// Dimension-specific output subdir prevents cross-contamination between concurrent/sequential runs
const LOCAL_OUTPUT  = path.join(__dirname, '..', 'public', 'creatives', 'pipeline', 'output', INPUT_FOLDER || '_flat');
const DRIVE_INPUT   = INPUT_FOLDER ? `gdrive:Devi/Ad Pipeline/${INPUT_FOLDER}` : 'gdrive:Devi/Ad Pipeline/Input';
const DRIVE_ASSETS  = 'gdrive:Devi/Ad Pipeline/Assets';
const DRIVE_OUTPUT  = OUTPUT_FOLDER ? `gdrive:Devi/Ad Pipeline/${OUTPUT_FOLDER}` : 'gdrive:Devi/Ad Pipeline/Output';

if (!TEMPLATE_ID || !SHEET_GID) {
  console.error('Usage: node scripts/pipeline-run.js <template_id> <sheet_gid> [rows] [lang]');
  process.exit(1);
}

/** Parse rows arg → Set of 1-indexed row numbers, or null for all rows */
function parseRowFilter(arg) {
  if (!arg || arg === 'all') return null;
  const indices = new Set();
  for (const part of arg.split(',')) {
    const t = part.trim();
    if (t.includes('-')) {
      const [start, end] = t.split('-').map(Number);
      for (let i = start; i <= end; i++) indices.add(i);
    } else {
      indices.add(Number(t));
    }
  }
  return indices;
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

/** Derive short template name from template JSON display name.
 *  e.g. TemplateA2_1:1 → A2,  TestTemplateC → C */
function getTemplateShortName(templateId) {
  const templatePath = path.join(__dirname, '..', 'public', 'creatives', 'templates', `${templateId}.json`);
  try {
    const json = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    const displayName = (json.name || templateId).replace(/_+$/, '');
    // Strip dimension suffix (e.g. _1:1, _9:16, _4:5, _1.91:1)
    const base = displayName.replace(/_(?:1:1|9:16|4:5|1\.91:1|16:9|2:1)$/, '');
    // Strip everything up to and including "Template" (e.g. TestTemplateC → C)
    const short = base.replace(/^.*template/i, '');
    return short || slug(templateId);
  } catch {
    return slug(templateId);
  }
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
  fs.mkdirSync(LOCAL_OUTPUT, { recursive: true });

  // Step 1: Sync Drive → local (mirror so stale files are cleaned up)
  const t1 = Date.now();
  rclone('sync', DRIVE_INPUT,  LOCAL_INPUT);
  rclone('sync', DRIVE_ASSETS, LOCAL_ASSETS);
  const syncTime = Date.now() - t1;

  // Step 2: Read sheet (skip if rows=none — template has no text zones)
  const t2 = Date.now();
  let buttonFile = '';
  let logoFile   = 'Logo.png';
  let textCombos;
  let sheetTime = 0;

  if (ROWS_ARG === 'none') {
    textCombos = [{ z2: '', z3: '', rowNum: 0 }];
  } else {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
    const csvResp = await fetchUrl(csvUrl);
    if (csvResp.status !== 200) throw new Error(`Sheet fetch failed: HTTP ${csvResp.status}`);
    let rows = parseCSV(csvResp.body.toString());

    // Apply row filter — also track original 1-based sheet row numbers
    const rowFilter = parseRowFilter(ROWS_ARG);
    let rowNumbers = rows.map((_, i) => i + 1); // default: all rows
    if (rowFilter) {
      const filtered = [], nums = [];
      rows.forEach((row, i) => { if (rowFilter.has(i + 1)) { filtered.push(row); nums.push(i + 1); } });
      if (!filtered.length) throw new Error(`No rows matched filter "${ROWS_ARG}"`);
      rows = filtered;
      rowNumbers = nums;
    }

    buttonFile = rows.map(r => r.zone_3_src).find(Boolean) || '';
    logoFile   = rows.map(r => r.zone_4_src).find(Boolean) || 'Logo.png';

    // Build text combos with row numbers.
    // ZONE2_TEXTS / ZONE3_TEXTS env vars inject translated text (translate mode).
    // Each entry: { z2, z3, rowNum } — deduped by text pair, keeping first row number.
    if (process.env.ZONE2_TEXTS || process.env.ZONE3_TEXTS) {
      const z2s = process.env.ZONE2_TEXTS ? JSON.parse(process.env.ZONE2_TEXTS) : [''];
      const z3s = process.env.ZONE3_TEXTS ? JSON.parse(process.env.ZONE3_TEXTS) : [''];
      // Match translated texts to original row numbers by unique-pair order
      const pairRowNums = new Map();
      rows.forEach((r, i) => {
        const key = `${r.zone_2_text}|||${r.zone_3_text}`;
        if (!pairRowNums.has(key)) pairRowNums.set(key, rowNumbers[i]);
      });
      const uniqueRowNums = [...pairRowNums.values()];
      textCombos = z2s.map((z2, i) => ({ z2, z3: z3s[i] || '', rowNum: uniqueRowNums[i] ?? i + 1 }));
    } else {
      const seen = new Map();
      rows.forEach((r, i) => {
        const z2 = (r.zone_2_text || '').replace(/\s*\|\s*/g, '\n');
        const z3 = (r.zone_3_text || '').replace(/\s*\|\s*/g, '\n');
        if (!z2 && !z3) return;
        const key = `${z2}|||${z3}`;
        if (!seen.has(key)) seen.set(key, { z2, z3, rowNum: rowNumbers[i] });
      });
      textCombos = [...seen.values()];
    }
    sheetTime = Date.now() - t2;
  }

  // BG images = everything in Input folder (sorted for consistent 1-based numbering)
  let bgImages = fs.readdirSync(LOCAL_INPUT).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).sort();
  if (!bgImages.length) throw new Error('No BG images in Drive Input — upload images first.');

  // Apply image filter if specified
  if (IMAGES_ARG && IMAGES_ARG !== 'all') {
    const imageFilter = parseRowFilter(IMAGES_ARG); // same parse logic: "1", "1-3", "2,4"
    const filtered = bgImages.filter((_, i) => imageFilter.has(i + 1));
    if (!filtered.length) throw new Error(`No images matched filter "${IMAGES_ARG}" (folder has ${bgImages.length} images)`);
    bgImages = filtered;
  }

  // Build permutations: textCombos × BG images
  const combos = [];
  for (const { z2, z3, rowNum } of textCombos)
    for (const bg of bgImages)
      combos.push({ bg, z2, z3, rowNum });

  // Step 3: Export
  const t3 = Date.now();
  let done = 0, failed = 0;
  const results = [];

  const templateShortName = getTemplateShortName(TEMPLATE_ID);
  for (const { bg, z2, z3, rowNum } of combos) {
    let bgBase = path.basename(bg, path.extname(bg));
    // Strip existing dim suffix from source filename to avoid doubling
    // e.g. "1_9_16" with DIM_SUFFIX "9_16" → strip → "1"
    if (DIM_SUFFIX && bgBase.endsWith('_' + DIM_SUFFIX)) {
      bgBase = bgBase.slice(0, -(DIM_SUFFIX.length + 1));
    }
    // Format: {image}_{templateShort}_{dimension}[_{lang}].png
    // e.g. 1_A2_1_1.png  or  1_A2_9_16_ru.png
    const outName = [bgBase, templateShortName, DIM_SUFFIX, LANG_SUFFIX].filter(Boolean).join('_') + '.png';
    const inputSrcPath = INPUT_FOLDER ? `/creatives/pipeline/input/${INPUT_FOLDER}/${bg}` : `/creatives/pipeline/input/${bg}`;
    const zones = { zone_1: { src: inputSrcPath }, zone_2: { text: z2 } };
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

  // Step 4: Upload to Drive Output (copy only — never delete existing files)
  const t4 = Date.now();
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
    `Files → ${DRIVE_OUTPUT}`,
  ];
  for (const r of results)
    lines.push(r.ok ? `  ✓ ${r.name} (${r.kb}KB, ${elapsed(r.ms)})` : `  ✗ ${r.name}: ${r.error}`);

  console.log(lines.join('\n'));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Pipeline error:', e.message); process.exit(1); });
