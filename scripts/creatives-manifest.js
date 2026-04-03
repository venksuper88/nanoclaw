/**
 * Creatives manifest helper
 * Maintains public/creatives/manifest.json as the source of truth for batch jobs.
 * Auto-populated when images are uploaded; text filled manually or via sheet.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(__dirname, '..', 'public', 'creatives', 'manifest.json');

export function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return [];
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

export function saveManifest(rows) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(rows, null, 2));
}

/** Called when a zone_1 image is uploaded — adds a new pending row */
export function onZone1Upload(filename) {
  const rows = loadManifest();
  // Avoid duplicate rows for the same filename
  if (rows.find(r => r.zone_1_src === filename)) return rows;
  rows.push({
    output_name: '',
    zone_1_src: filename,
    zone_2_text: '',
    zone_3_text: '',
    zone_3_src: '',
    status: 'pending'
  });
  saveManifest(rows);
  return rows;
}

/** Called when a zone_3 image is uploaded — attaches to the most recent pending row */
export function onZone3Upload(filename) {
  const rows = loadManifest();
  // Find last row with no zone_3_src
  const row = [...rows].reverse().find(r => !r.zone_3_src);
  if (row) row.zone_3_src = filename;
  saveManifest(rows);
  return rows;
}

/** Called after a successful export — marks row done and records output filename */
export function onExportComplete(zone1Src, outputName) {
  const rows = loadManifest();
  const row = rows.find(r => r.zone_1_src === zone1Src);
  if (row) {
    row.output_name = outputName;
    row.status = 'done';
  }
  saveManifest(rows);
  return rows;
}

export function printManifest() {
  const rows = loadManifest();
  if (!rows.length) { console.log('Manifest is empty.'); return; }
  console.log('\n# Creatives Manifest\n');
  console.log('Row | output_name       | zone_1_src   | zone_2_text                        | zone_3_text       | zone_3_src   | status');
  console.log('----|-------------------|--------------|-------------------------------------|-------------------|--------------|--------');
  rows.forEach((r, i) => {
    console.log(`${String(i+1).padEnd(4)}| ${(r.output_name||'').padEnd(18)}| ${(r.zone_1_src||'').padEnd(13)}| ${(r.zone_2_text||'').substring(0,36).padEnd(36)}| ${(r.zone_3_text||'').padEnd(18)}| ${(r.zone_3_src||'').padEnd(13)}| ${r.status||''}`);
  });
  console.log();
}

// CLI usage: node creatives-manifest.js [show|add-zone1 <file>|add-zone3 <file>]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === 'show') printManifest();
  else if (cmd === 'add-zone1') { onZone1Upload(process.argv[3]); printManifest(); }
  else if (cmd === 'add-zone3') { onZone3Upload(process.argv[3]); printManifest(); }
  else printManifest();
}
