/**
 * Minimal Telegram-style markdown to HTML.
 * Supports: **bold**, *italic*, `code`, ```code blocks```, ~~strike~~, [text](url),
 * headers (#, ##, ###), tables, bullet lists
 */
export function renderMarkdown(text: string): string {
  let html = escapeHtml(text);

  // Code blocks (```...```)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) =>
    `<div class="code-scroll"><pre>${code.trim()}</pre></div>`
  );

  // Tables (detect lines with | separators and --- dividers)
  html = html.replace(
    /(?:^|\n)((?:\|[^\n]+\|\n)+)/g,
    (_m, tableBlock: string) => {
      const rows = tableBlock.trim().split('\n').filter(r => r.trim());
      if (rows.length < 2) return _m;
      // Check if second row is a separator (|---|---|)
      const isSep = /^\|[\s\-:|]+\|$/.test(rows[1].trim());
      let tableHtml = '<table class="md-table">';
      rows.forEach((row, i) => {
        if (isSep && i === 1) return; // skip separator row
        const cells = row.split('|').slice(1, -1).map(c => c.trim());
        const tag = isSep && i === 0 ? 'th' : 'td';
        tableHtml += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
      });
      tableHtml += '</table>';
      return tableHtml;
    }
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

  // Headers (### h3, ## h2, # h1)
  html = html.replace(/(?:^|<br>)### (.+?)(?=<br>|$)/g, '<h4 class="md-h">$1</h4>');
  html = html.replace(/(?:^|<br>)## (.+?)(?=<br>|$)/g, '<h3 class="md-h">$1</h3>');
  html = html.replace(/(?:^|<br>)# (.+?)(?=<br>|$)/g, '<h2 class="md-h">$1</h2>');

  // Links [text](url) — internal #hash links don't open in new tab
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) => {
    if (url.startsWith('#')) {
      return `<a href="${url}" style="color:var(--purple)">${text}</a>`;
    }
    return `<a href="${url}" target="_blank" rel="noopener" style="color:var(--purple)">${text}</a>`;
  });

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
