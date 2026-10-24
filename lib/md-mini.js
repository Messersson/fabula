'use strict';
// 极简安全 Markdown 渲染器（零依赖，服务端用）。
// 安全模型：先整体 HTML 转义，再在转义后的文本上做 Markdown 结构转换——
// 任何注入的 <script> 都会以转义文本形式呈现，不会成为标签。
// 支持：标题(#~####)、**粗体**、*斜体*、`行内码`、```围栏代码(带语言)、
//       GFM 表格、-/* 无序列表、1. 有序列表、> 引用、--- 分隔线、空行分段。

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderInline(t) {
  return t
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`\n]+)`/g, '<code class="mdc">$1</code>');
}

function render(src) {
  const lines = escapeHtml(String(src || '')).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (para.length) { out.push('<p>' + renderInline(para.join(' ')) + '</p>'); para = []; }
  };

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();

    if (!t) { flushPara(); i++; continue; }

    // 围栏代码块
    const fence = t.match(/^```(\w*)\s*$/);
    if (fence) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { buf.push(lines[i]); i++; }
      out.push('<pre class="mdpre' + (fence[1] ? ' lang-' + fence[1].toLowerCase() : '') + '"><code>' +
        buf.join('\n') + '</code></pre>');
      i++;
      continue;
    }

    // 标题
    const h = t.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      flushPara();
      const level = Math.min(h[1].length + 2, 6); // # → h3，避免与页面标题冲突
      out.push(`<h${level} class="mdh">` + renderInline(h[2]) + `</h${level}>`);
      i++;
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,})$/.test(t)) { flushPara(); out.push('<hr class="mdhr">'); i++; continue; }

    // GFM 表格：当前行含 |，下一行是 |---|---| 分隔
    if (t.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      flushPara();
      const parseRow = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = parseRow(t);
      i += 2; // 跳过表头与分隔行
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      const cell = (c) => '<td>' + renderInline(c) + '</td>';
      out.push('<table class="mdtable"><thead><tr>' +
        head.map((c) => '<th>' + renderInline(c) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + head.map((_, ci) => cell(r[ci] || '')).join('') + '</tr>').join('') +
        '</tbody></table>');
      continue;
    }

    // 无序列表
    if (/^[-*]\s+/.test(t)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push('<li>' + renderInline(lines[i].trim().replace(/^[-*]\s+/, '')) + '</li>');
        i++;
      }
      out.push('<ul class="mdlist">' + items.join('') + '</ul>');
      continue;
    }

    // 有序列表
    if (/^\d+[.、]\s*/.test(t)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\d+[.、]\s*/.test(lines[i].trim())) {
        items.push('<li>' + renderInline(lines[i].trim().replace(/^\d+[.、]\s*/, '')) + '</li>');
        i++;
      }
      out.push('<ol class="mdlist">' + items.join('') + '</ol>');
      continue;
    }

    // 引用
    if (/^>\s?/.test(t)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push('<blockquote class="mdquote">' + renderInline(buf.join(' ')) + '</blockquote>');
      continue;
    }

    para.push(t);
    i++;
  }
  flushPara();
  return out.join('\n');
}

module.exports = { render, escapeHtml };
