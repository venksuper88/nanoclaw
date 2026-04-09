/**
 * run-pipeline — internal command called by pipeline-1x1, pipeline-9x16, etc.
 *
 * Resolves template family name + input_folder → template file ID, then
 * delegates to pipeline-run.js.
 *
 * Input (JSON via stdin):
 *   template      — family name, e.g. "TemplateC", "TemplateB"
 *   rows          — row filter: "1", "1-10", "all", "none"
 *   input_folder  — e.g. "Input_1:1", "Input_9:16"
 *   images        — image filter (optional, default "all")
 *   gid           — sheet GID override (optional)
 *   lang          — language suffix, e.g. "ru" (optional)
 */

import { readFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));

const { template, rows, input_folder, images, gid, lang } = input;

if (!template || !rows || !input_folder) {
  process.stderr.write('run-pipeline: missing required fields: template, rows, input_folder\n');
  process.exit(1);
}

// ── GID resolution (same logic as pipeline/run.mjs) ──────────────────────────
const TEMPLATE_GIDS = {
  templateb: '1781382981',
  templatec: '1778695435',
};

function resolveGid(templateName, gidOverride) {
  if (gidOverride) return gidOverride;
  const base = templateName.toLowerCase().replace(/[_\s].*$/, '');
  return TEMPLATE_GIDS[base] || '1778695435';
}

// ── Template ID resolution ────────────────────────────────────────────────────
// input_folder "Input_9:16" → dimension "9:16"
const dimension = input_folder.replace(/^Input_/, '');

const projectRoot = path.resolve(__dirname, '../../../');
const templatesDir = path.join(projectRoot, 'public', 'creatives', 'templates');

function resolveTemplateId(familyName, dim) {
  // Normalize: "TemplateC" → "templatec", "TestTemplateC" → "templatec"
  const familyNorm = familyName.toLowerCase().replace(/^test/, '');

  let files;
  try {
    files = readdirSync(templatesDir).filter(f => f.endsWith('.json'));
  } catch (e) {
    throw new Error(`Cannot read templates dir: ${e.message}`);
  }

  for (const file of files) {
    try {
      const json = JSON.parse(readFileSync(path.join(templatesDir, file), 'utf-8'));
      const name = (json.name || '').toLowerCase().replace(/^test/, '');
      const nameNorm = name.replace(/^test/, '');
      // Match family and dimension
      if (nameNorm.includes(familyNorm) && name.endsWith(`_${dim.toLowerCase()}`)) {
        return file.replace(/\.json$/, '');
      }
    } catch {}
  }
  throw new Error(`No template found for family "${familyName}" + dimension "${dim}"`);
}

let templateId;
try {
  templateId = resolveTemplateId(template, dimension);
} catch (e) {
  process.stderr.write(`run-pipeline: ${e.message}\n`);
  process.exit(1);
}

const sheetGid = resolveGid(template, gid);
const script = path.join(projectRoot, 'scripts', 'pipeline-run.js');

// Load .env
let env = { ...process.env };
try {
  const envFile = readFileSync(path.join(projectRoot, '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch {}

env.API_BASE      = env.API_BASE || 'https://mc.neved.in';
env.INPUT_FOLDER  = input_folder;
if (images && images !== 'all') env.IMAGES_FILTER = images;

const rowsArg = rows || 'all';
const langArg = lang || '';

try {
  const output = execSync(
    `node "${script}" "${templateId}" "${sheetGid}" "${rowsArg}" "${langArg}"`,
    { env, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  process.stdout.write(JSON.stringify({ message: output.trim() }));
} catch (e) {
  const out = (e.stdout || '').trim();
  const err = (e.stderr || e.message || '').trim();
  process.stderr.write(out ? `${out}\n${err}` : err);
  process.exit(1);
}
