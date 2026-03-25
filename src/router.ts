import path from 'path';

import { GROUPS_DIR } from './config.js';
import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Expand attachment references to include absolute paths for Claude's Read tool.
 * [Document: file.png] → [Document: file.png — Read this file: /abs/path/to/attachments/file.png]
 * [Photo: file.jpg | path:...] → already has container path, replace with host path
 */
function expandAttachments(content: string, groupFolder?: string): string {
  if (!groupFolder) return content;
  const attachDir = path.resolve(GROUPS_DIR, groupFolder, 'attachments');

  // [Document: filename] or [Document: filename] caption
  content = content.replace(/\[Document: ([^\]]+)\]/g, (match, filename) => {
    const absPath = path.join(attachDir, filename.trim());
    return `${match}\nIMPORTANT: Use the Read tool to view this file at: ${absPath}`;
  });

  // [Photo: filename | path:/workspace/group/attachments/filename]
  content = content.replace(
    /\[Photo: ([^|]+)\| path:[^\]]+\]/g,
    (match, filename) => {
      const absPath = path.join(attachDir, filename.trim());
      return `[Photo: ${filename.trim()}]\nIMPORTANT: Use the Read tool to view this image at: ${absPath}`;
    },
  );

  return content;
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

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

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
