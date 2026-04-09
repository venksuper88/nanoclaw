#!/usr/bin/env node
/**
 * Single-image multi-dimension pipeline
 *
 * Runs one image + one sheet row across all dimension variants of a named template,
 * uploading results to each dimension's own Drive Output folder.
 *
 * Usage:
 *   DASHBOARD_TOKEN=<token> API_BASE=https://mc.neved.in \
 *   node scripts/pipeline-single.js <template_base> <sheet_gid> <image_number> <sheet_row>
 *
 * Args:
 *   template_base  — template name prefix, e.g. "templatea" finds all templatea_* variants
 *   sheet_gid      — Google Sheet tab GID (e.g. "1778695435")
 *   image_number   — 1-based BG image index (e.g. "3" for the 3rd image alphabetically in Input folder)
 *   sheet_row      — 1-based sheet row number (e.g. "2" for row 2)
 *
 * What it does:
 *   For each matching template variant (e.g. templatea_11_copy_*, templatea_916_copy_*, etc.):
 *     1. Determines the canvas ratio → maps to Input_<ratio> Drive folder
 *     2. Syncs that dimension's Input folder from Drive
 *     3. Exports image_number with the text from sheet_row
 *     4. Uploads result to Output_<ratio> Drive folder
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMPLATE_BASE = process.argv[2];
const SHEET_GID     = process.argv[3];
const IMAGE_NUMBER  = process.argv[4];
const SHEET_ROW     = process.argv[5];

const TEMPLATES_DIR = path.join(__dirname, '..', 'public', 'creatives', 'templates');
const PIPELINE_JS   = path.join(__dirname, 'pipeline-run.js');

if (!TEMPLATE_BASE || !SHEET_GID || !IMAGE_NUMBER || !SHEET_ROW) {
  console.error('Usage: node scripts/pipeline-single.js <template_base> <sheet_gid> <image_number> <sheet_row>');
  console.error('');
  console.error('  template_base  — prefix, e.g. "templatea" matches all templatea_* files');
  console.error('  sheet_gid      — Google Sheet tab GID');
  console.error('  image_number   — 1-based BG image index');
  console.error('  sheet_row      — 1-based sheet row number');
  process.exit(1);
}

// ── Canvas size → Drive folder ratio ─────────────────────────────────────────

function computeInputFolder(width, height) {
  if (!width || !height) return '';
  const r = width / height;
  if (Math.abs(r - 1)        < 0.01) return 'Input_1:1';
  if (Math.abs(r - 9 / 16)   < 0.01) return 'Input_9:16';
  if (Math.abs(r - 4 / 5)    < 0.01) return 'Input_4:5';
  if (Math.abs(r - 1.91)     < 0.05) return 'Input_1.91:1';
  // Fallback: reduce to simplest integer ratio
  function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }
  const g = gcd(Math.round(width), Math.round(height));
  return `Input_${Math.round(width) / g}:${Math.round(height) / g}`;
}

// ── Discover dimension variants ───────────────────────────────────────────────

// Known dimension suffixes that appear at the end of a template's display name.
// Used to strip the suffix and get the base template name (e.g. "TemplateA_9:16" → "TemplateA").
const DIM_SUFFIXES = ['_1:1', '_9:16', '_4:5', '_1.91:1', '_16:9', '_2:1'];

function stripDimSuffix(name) {
  for (const sfx of DIM_SUFFIXES) {
    if (name.endsWith(sfx)) return name.slice(0, -sfx.length);
  }
  // Fallback: strip trailing underscore (e.g. "TestTemplateC_")
  return name.replace(/_+$/, '');
}

const allTemplateFiles = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));

// Load all templates and compute their base name from the display name field
const allTemplates = allTemplateFiles.map(filename => {
  const templateId = filename.replace('.json', '');
  const json = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, filename), 'utf8'));
  const displayName = json.name || templateId;
  const baseName = stripDimSuffix(displayName);
  const { width, height } = json.canvas || {};
  const inputFolder = computeInputFolder(width, height);
  return { templateId, filename, displayName, baseName, width, height, inputFolder };
});

// Always resolve to the full template family (all dimension variants).
// Strip any dimension suffix from the input so "TemplateA_1:1" → "TemplateA",
// then match all templates sharing that base name.
const resolvedBase = stripDimSuffix(TEMPLATE_BASE).toLowerCase();
const matchingTemplates = allTemplates.filter(t => t.baseName.toLowerCase() === resolvedBase);

if (!matchingTemplates.length) {
  const bases = [...new Set(allTemplates.map(t => t.baseName))].sort();
  console.error(`No templates found matching "${TEMPLATE_BASE}" (resolved base: "${resolvedBase}")`);
  console.error(`Available template families: ${bases.join(', ')}`);
  process.exit(1);
}

const variants = matchingTemplates.sort((a, b) => a.templateId.localeCompare(b.templateId));

// ── Summary ───────────────────────────────────────────────────────────────────

const resolvedLabel = resolvedBase === TEMPLATE_BASE.toLowerCase() ? TEMPLATE_BASE : `${TEMPLATE_BASE} → ${resolvedBase}`;
console.log(`Template      : "${resolvedLabel}" (${variants.length} dimension variants)`);
console.log(`Sheet GID     : ${SHEET_GID}  row ${SHEET_ROW}`);
console.log(`Image number  : ${IMAGE_NUMBER}`);
console.log('');
for (const v of variants) {
  const dim = v.width && v.height ? `${v.width}×${v.height}` : 'unknown';
  console.log(`  ${v.displayName}  [${dim}]  → ${v.inputFolder || '(flat Input)'}`);
}
console.log('');

// ── Run each dimension ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

for (const v of variants) {
  const dim = v.width && v.height ? `${v.width}×${v.height}` : 'unknown';
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Running: ${v.displayName}  (${dim})`);
  console.log(`  Input  : ${v.inputFolder || 'Input (flat)'}`);
  console.log(`  Output : ${v.inputFolder ? v.inputFolder.replace('Input_', 'Output_') : 'Output (flat)'}`);
  console.log(`${'─'.repeat(60)}`);

  const runEnv = {
    ...process.env,
    IMAGES_FILTER: IMAGE_NUMBER,
    ...(v.inputFolder ? { INPUT_FOLDER: v.inputFolder } : {}),
  };

  try {
    const output = execSync(
      `node "${PIPELINE_JS}" "${v.templateId}" "${SHEET_GID}" "${SHEET_ROW}"`,
      { env: runEnv, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    console.log(output);
    passed++;
  } catch (e) {
    // execSync throws on non-zero exit; stdout/stderr still available
    if (e.stdout) console.log(e.stdout);
    if (e.stderr) console.error(e.stderr);
    console.error(`✗ ${v.templateId} failed (exit ${e.status})`);
    failed++;
  }
}

// ── Final summary ─────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`Multi-dimension run complete`);
console.log(`  Variants : ${variants.length}`);
console.log(`  Passed   : ${passed}`);
console.log(`  Failed   : ${failed}`);
console.log(`${'═'.repeat(60)}`);

process.exit(failed > 0 ? 1 : 0);
