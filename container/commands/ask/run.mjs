/**
 * ask — Stateless LLM query with optional file attachments.
 *
 * Input (stdin): { model, prompt, _raw, sender }
 *   model:  "gemini-flash" | "gemini-pro" | "gemini-3.1-flash-image-preview" | etc.
 *   prompt: The question + any trailing filenames (greedy arg)
 *
 * Attachments: any word in the prompt that matches a file in the group's
 * attachments folder is treated as an attachment and sent as inline data.
 *
 * Output (stdout): { message }
 * Image-gen models: image saved to attachments + sent via IPC filePath message.
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';

// ── Config ───────────────────────────────────────────────────────────────────
function readDotEnv(key) {
  if (process.env[key]) return process.env[key];
  try {
    const content = readFileSync(new URL('../../../.env', import.meta.url), 'utf-8');
    const m = content.match(new RegExp(`^${key}=(.+)`, 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

const GEMINI_API_KEY = readDotEnv('GEMINI_API_KEY');
const GROUP_FOLDER = process.env.NANOCLAW_GROUP_FOLDER || '';
const CHAT_JID = process.env.NANOCLAW_CHAT_JID || '';
const PROJECT_ROOT = process.env.NANOCLAW_PROJECT_ROOT || path.resolve(new URL('../../../', import.meta.url).pathname);
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');
const ATTACHMENTS_DIR = path.join(GROUPS_DIR, GROUP_FOLDER, 'attachments');
const IPC_MESSAGES_DIR = path.join(GROUPS_DIR, GROUP_FOLDER, 'ipc', 'messages');

const MODELS = {
  // Gemini 3.x image-gen
  '3.1-flash-image-preview': 'gemini-3.1-flash-image-preview',
  '3-pro-image-preview': 'gemini-3-pro-image-preview',
  // Gemini 2.5 image-gen
  '2.5-flash-image': 'gemini-2.5-flash-image',
  // Gemini 3.x text
  '3.1-flash-lite': 'gemini-3.1-flash-lite',
  // Gemini 2.5 text
  '2.5-flash': 'gemini-2.5-flash',
  '2.5-pro': 'gemini-2.5-pro',
  '2.5-flash-lite': 'gemini-2.5-flash-lite',
  // Gemini 2.0 text
  '2.0-flash': 'gemini-2.0-flash',
  // Shortcuts
  'flash': 'gemini-2.5-flash',
  'pro': 'gemini-2.5-pro',
};

// Models that generate images in their response
const IMAGE_GEN_MODELS = new Set([
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview',
  'gemini-2.5-flash-image',
]);

// ── MIME type detection ──────────────────────────────────────────────────────
const MIME_MAP = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function mimeToExt(mimeType) {
  const map = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
  return map[mimeType] || '.png';
}

// ── Gemini API call ──────────────────────────────────────────────────────────
async function callGemini(modelId, prompt, attachments, imageGen) {
  const parts = [];

  for (const att of attachments) {
    const data = readFileSync(att.path);
    parts.push({ inline_data: { mime_type: att.mimeType, data: data.toString('base64') } });
  }
  parts.push({ text: prompt });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts }],
    generationConfig: imageGen
      ? { responseModalities: ['IMAGE', 'TEXT'] }
      : { maxOutputTokens: 8192 },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));

  const responseParts = json.candidates?.[0]?.content?.parts ?? [];
  const text = responseParts.filter(p => p.text).map(p => p.text).join('') || '';
  const imagePart = responseParts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

  const usage = json.usageMetadata || {};
  return {
    text,
    imagePart: imagePart ? { mimeType: imagePart.inlineData.mimeType, data: imagePart.inlineData.data } : null,
    inputTokens: usage.promptTokenCount || 0,
    outputTokens: usage.candidatesTokenCount || 0,
  };
}

// ── Send image via IPC ───────────────────────────────────────────────────────
function sendImageViaIpc(filePath, caption) {
  if (!CHAT_JID || !GROUP_FOLDER) return;
  try {
    mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
    const msgFile = path.join(IPC_MESSAGES_DIR, `ask_img_${Date.now()}_${randomBytes(4).toString('hex')}.json`);
    writeFileSync(msgFile, JSON.stringify({
      type: 'message',
      chatJid: CHAT_JID,
      text: caption || '',
      filePath,
      timestamp: new Date().toISOString(),
    }));
  } catch (e) {
    process.stderr.write(`IPC write error: ${e.message}\n`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
const input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'));

if (!GEMINI_API_KEY) {
  process.stdout.write(JSON.stringify({ message: '❌ GEMINI_API_KEY not configured.' }));
  process.exit(0);
}

const modelKey = (input.model || 'flash').toLowerCase().trim();
const modelId = MODELS[modelKey];
if (!modelId) {
  const available = Object.keys(MODELS).join(', ');
  process.stdout.write(JSON.stringify({
    message: `❌ Unknown model: "${modelKey}". Available: ${available}`,
  }));
  process.exit(0);
}

const isImageGen = IMAGE_GEN_MODELS.has(modelId);

let promptText = (input.prompt || '').trim();
if (!promptText) {
  process.stdout.write(JSON.stringify({ message: '❌ No prompt provided. Usage: !ask <model> <prompt> [files...]' }));
  process.exit(0);
}

// Scan for attachment filenames in the prompt
const attachments = [];
const availableFiles = new Set();
try {
  if (existsSync(ATTACHMENTS_DIR)) {
    for (const f of readdirSync(ATTACHMENTS_DIR)) {
      availableFiles.add(f);
    }
  }
} catch { /* no attachments dir */ }

// Walk from the end to find trailing filenames
const words = promptText.split(/\s+/);
const promptWords = [];
let hitFile = false;
for (let i = words.length - 1; i >= 0; i--) {
  const word = words[i];
  const fp = path.join(ATTACHMENTS_DIR, word);
  if (!hitFile && availableFiles.has(word) && existsSync(fp)) {
    attachments.unshift({ name: word, path: fp, mimeType: getMimeType(fp) });
  } else {
    hitFile = true;
    promptWords.unshift(word);
  }
}

const finalPrompt = promptWords.join(' ');
if (!finalPrompt) {
  process.stdout.write(JSON.stringify({ message: '❌ No prompt text — only filenames detected.' }));
  process.exit(0);
}

try {
  const attLabel = attachments.length > 0
    ? ` (+ ${attachments.length} file${attachments.length > 1 ? 's' : ''})`
    : '';

  const { text, imagePart, inputTokens, outputTokens } = await callGemini(modelId, finalPrompt, attachments, isImageGen);

  const tokenInfo = `_${modelKey}${attLabel} · ${inputTokens} in / ${outputTokens} out_`;

  if (isImageGen) {
    if (!imagePart) {
      const errText = text || 'No image returned by model.';
      process.stdout.write(JSON.stringify({ message: `⚠️ ${errText}\n\n${tokenInfo}` }));
      process.exit(0);
    }

    // Save image to attachments
    mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const ext = mimeToExt(imagePart.mimeType);
    const outName = `ask_output_${Date.now()}${ext}`;
    const outPath = path.join(ATTACHMENTS_DIR, outName);
    writeFileSync(outPath, Buffer.from(imagePart.data, 'base64'));

    // Send via IPC so it appears in chat as a file
    sendImageViaIpc(outPath, text || '');

    process.stdout.write(JSON.stringify({
      message: `✓ Image generated: ${outName}\n\n${tokenInfo}`,
      data: { model: modelId, outputFile: outName, inputTokens, outputTokens },
    }));
  } else {
    if (!text) {
      process.stdout.write(JSON.stringify({ message: '⚠️ Empty response from Gemini.' }));
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({
      message: text + '\n\n' + tokenInfo,
      data: { model: modelId, inputTokens, outputTokens },
    }));
  }
} catch (err) {
  process.stderr.write(`ask error: ${err.message}\n`);
  process.exit(1);
}
