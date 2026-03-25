/**
 * Minimal Telegram-style markdown to HTML.
 * Supports: **bold**, *italic*, `code`, ```code blocks```, ~~strike~~, [text](url)
 */
export function renderMarkdown(text: string): string {
  let html = escapeHtml(text);

  // Code blocks (```...```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) =>
    `<div class="code-scroll"><pre>${code.trim()}</pre></div>`
  );

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold **text** or __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic *text* or _text_ (not inside words)
  html = html.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, '<em>$1</em>');
  html = html.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, '<em>$1</em>');

  // Strikethrough ~~text~~
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener" style="color:var(--accent)">$1</a>'
  );

  // Newlines
  html = html.replace(/\n/g, '<br>');

  return html;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
