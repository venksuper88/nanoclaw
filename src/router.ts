import fs from 'fs';
import path from 'path';

import sharp from 'sharp';

import { GROUPS_DIR } from './config.js';
import {
  extractImage,
  extractPdf,
  isExtractionAvailable,
} from './extraction.js';
import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';
import { logger } from './logger.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.heif',
]);
const COMPRESS_MAX_DIMENSION = 768;
const COMPRESS_JPEG_QUALITY = 60;
const COMPRESS_MARKER = '.compressed';

/**
 * Compress an image in-place to reduce agent context token usage.
 * Replaces the original file with a resized JPEG. Skips if already compressed.
 * Returns the path to the (now-compressed) file.
 */
export async function compressImageForAgent(absPath: string): Promise<string> {
  const ext = path.extname(absPath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return absPath;

  // Skip if already compressed (marker file exists)
  const markerPath = `${absPath}${COMPRESS_MARKER}`;
  if (fs.existsSync(markerPath)) return absPath;

  try {
    const tmpPath = `${absPath}.tmp.jpg`;
    await sharp(absPath)
      .resize(COMPRESS_MAX_DIMENSION, COMPRESS_MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: COMPRESS_JPEG_QUALITY })
      .toFile(tmpPath);
    // Replace original with compressed version
    fs.renameSync(tmpPath, absPath);
    // Write marker so we don't re-compress
    fs.writeFileSync(markerPath, '');
    logger.info({ path: absPath }, 'Compressed image in-place');
    return absPath;
  } catch (err) {
    logger.warn({ err, absPath }, 'Failed to compress image');
    return absPath;
  }
}

/**
 * Compress all images in a group's attachments directory.
 * Called on session start to ensure all images are pre-compressed.
 */
export async function compressAllAttachments(
  groupFolder: string,
): Promise<void> {
  const attachDir = path.resolve(GROUPS_DIR, groupFolder, 'attachments');
  if (!fs.existsSync(attachDir)) return;

  const files = fs.readdirSync(attachDir);
  const images = files.filter((f) =>
    IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()),
  );
  await Promise.all(
    images.map((f) =>
      compressImageForAgent(path.join(attachDir, f)).catch(() => {}),
    ),
  );
}

/**
 * Expand attachment references to include absolute paths for Claude's Read tool.
 * Images are pointed at compressed thumbnails to reduce context token usage.
 * [Document: file.png] → [Document: file.png — Read this file: /abs/path/to/attachments/file.png]
 * [Photo: file.jpg | path:...] → already has container path, replace with host path
 */
function expandAttachments(content: string, groupFolder?: string): string {
  if (!groupFolder) return content;
  const attachDir = path.resolve(GROUPS_DIR, groupFolder, 'attachments');

  // [Document: filename] or [Document: filename] caption
  content = content.replace(/\[Document: ([^\]]+)\]/g, (match, filename) => {
    const absPath = path.join(attachDir, filename.trim());
    const descPath = `${absPath}.extraction.txt`;
    if (fs.existsSync(descPath)) {
      const desc = fs.readFileSync(descPath, 'utf-8').trim();
      return `[Document: ${filename.trim()}]\n${desc}\n(Original file at: ${absPath} — use Read tool if you need more detail)`;
    }
    return `${match}\nIMPORTANT: Use the Read tool to view this file at: ${absPath}`;
  });

  // [Photo: filename | path:/workspace/group/attachments/filename]
  content = content.replace(
    /\[Photo: ([^|]+)\| path:[^\]]+\]/g,
    (match, filename) => {
      const absPath = path.join(attachDir, filename.trim());
      const descPath = `${absPath}.extraction.txt`;
      if (fs.existsSync(descPath)) {
        const desc = fs.readFileSync(descPath, 'utf-8').trim();
        return `[Image: ${filename.trim()}]\n${desc}\n(Original image at: ${absPath} — use Read tool if you need the full image)`;
      }
      return `[Photo: ${filename.trim()}]\nIMPORTANT: Use the Read tool to view this image at: ${absPath}`;
    },
  );

  return content;
}

/**
 * Pre-compress any image attachments referenced in messages.
 * Call before formatMessages() so thumbnails exist when expandAttachments runs.
 */
export async function preCompressAttachments(
  messages: NewMessage[],
  groupFolder?: string,
): Promise<void> {
  if (!groupFolder) return;
  const attachDir = path.resolve(GROUPS_DIR, groupFolder, 'attachments');
  const imageRefs: string[] = [];

  for (const m of messages) {
    // Extract photo filenames
    const photoMatches = m.content.matchAll(/\[Photo: ([^|\]]+)/g);
    for (const match of photoMatches) {
      const filename = match[1].trim();
      const ext = path.extname(filename).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        imageRefs.push(path.join(attachDir, filename));
      }
    }
  }

  // Compress all unique images in parallel
  const unique = [...new Set(imageRefs)];
  await Promise.all(
    unique.map((p) => compressImageForAgent(p).catch(() => {})),
  );
}

const PDF_EXTENSIONS = new Set(['.pdf']);

/**
 * Extract descriptions for image and PDF attachments referenced in messages.
 * Writes .extraction.txt files alongside originals for expandAttachments to pick up.
 * Call after preCompressAttachments and before formatMessages.
 */
export async function extractAttachments(
  messages: NewMessage[],
  groupFolder?: string,
): Promise<void> {
  if (!groupFolder || !isExtractionAvailable()) return;
  const attachDir = path.resolve(GROUPS_DIR, groupFolder, 'attachments');
  const filesToExtract: Array<{ absPath: string; type: 'image' | 'pdf' }> = [];

  for (const m of messages) {
    // Photos
    const photoMatches = m.content.matchAll(/\[Photo: ([^|\]]+)/g);
    for (const match of photoMatches) {
      const filename = match[1].trim();
      const ext = path.extname(filename).toLowerCase();
      const absPath = path.join(attachDir, filename);
      if (IMAGE_EXTENSIONS.has(ext)) {
        filesToExtract.push({ absPath, type: 'image' });
      }
    }
    // Documents (PDFs)
    const docMatches = m.content.matchAll(/\[Document: ([^\]]+)\]/g);
    for (const match of docMatches) {
      const filename = match[1].trim();
      const ext = path.extname(filename).toLowerCase();
      const absPath = path.join(attachDir, filename);
      if (PDF_EXTENSIONS.has(ext)) {
        filesToExtract.push({ absPath, type: 'pdf' });
      }
    }
  }

  // Deduplicate and skip already-extracted files
  const seen = new Set<string>();
  const toProcess = filesToExtract.filter((f) => {
    if (seen.has(f.absPath)) return false;
    seen.add(f.absPath);
    const descPath = `${f.absPath}.extraction.txt`;
    return !fs.existsSync(descPath) && fs.existsSync(f.absPath);
  });

  await Promise.all(
    toProcess.map(async ({ absPath, type }) => {
      try {
        const result =
          type === 'image'
            ? await extractImage(absPath)
            : await extractPdf(absPath);
        if (result) {
          fs.writeFileSync(`${absPath}.extraction.txt`, result.summary);
          logger.info(
            { absPath, type, tokens: result.inputTokens + result.outputTokens },
            'Attachment extracted via Gemini',
          );
        }
      } catch (err) {
        logger.warn({ err, absPath, type }, 'Attachment extraction failed');
      }
    }),
  );
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
  groupFolder?: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const content = expandAttachments(m.content, groupFolder);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(content)}</message>`;
  });

  let header = `<context timezone="${escapeXml(timezone)}"`;
  if (groupFolder) {
    const attachDir = path.resolve(GROUPS_DIR, groupFolder, 'attachments');
    header += ` attachments="${escapeXml(attachDir)}"`;
  }
  header += ` />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
