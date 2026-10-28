'use strict';

// 三线表：学术论文的表格规范（顶线、表头线、底线，无竖线）。
//
// 三条渲染路径同一份 spec，与图表同构：
// - 页面：HTML table + 边框 CSS
// - Word：OOXML 表格，只给上/下/表头下三条线
// - Markdown：管道表 + 题注 + 注（Markdown 没有边框概念，靠题注说明）
//
// spec 形状：
// { no, title, note, columns:['变量','N','均值'], rows:[['投入','12','128.0']], align:['left','right','right'] }

const MAX_ROWS = 120;
const MAX_COLS = 12;

function shortText(value, max = 60) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeTable(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const columns = (Array.isArray(raw.columns) ? raw.columns : []).map((item) => shortText(item, 24)).slice(0, MAX_COLS);
  if (!columns.length) return null;
  const rows = (Array.isArray(raw.rows) ? raw.rows : []).slice(0, MAX_ROWS).map((row) =>
    (Array.isArray(row) ? row : []).slice(0, columns.length).map((cell) => shortText(cell, 40)));
  if (!rows.length) return null;
  // 对齐：默认首列左对齐、其余右对齐（数字列靠右是学术表格惯例）
  const align = columns.map((_, i) => {
    const given = Array.isArray(raw.align) ? raw.align[i] : null;
    if (['left', 'center', 'right'].includes(given)) return given;
    return i === 0 ? 'left' : 'right';
  });
  // 列宽比例：文字多的列（说明/依据）需要更宽，否则三线表没有竖线，相邻列会视觉粘连
  const widths = Array.isArray(raw.widths) && raw.widths.length === columns.length
    ? raw.widths.map((item) => Math.max(0.05, Number(item) || 0))
    : null;
  return {
    // 已经定过号（插入分析时算好的全文序号）就沿用它，不能被 normalize 重置成 1
    no: Number(raw.no) > 0 ? Number(raw.no) : Number(index) + 1,
    widths,
    title: shortText(raw.title, 60) || `表 ${Number(index) + 1}`,
    note: shortText(raw.note, 200),
    columns, rows, align,
  };
}

function normalizeTables(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item, index) => normalizeTable(item, index)).filter(Boolean).slice(0, 20);
}

// ---------- 页面 ----------

function tableHtml(rawSpec) {
  const spec = normalizeTable(rawSpec, 0);
  if (!spec) return '';
  const head = spec.columns.map((name, i) =>
    `<th style="text-align:${spec.align[i]}">${esc(name)}</th>`).join('');
  const body = spec.rows.map((row) => `<tr>${spec.columns.map((_, i) =>
    `<td style="text-align:${spec.align[i]}">${esc(row[i] == null ? '' : row[i])}</td>`).join('')}</tr>`).join('');
  return `<table class="tbl3"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function tableCaptionHtml(rawSpec) {
  const spec = normalizeTable(rawSpec, 0);
  if (!spec) return '';
  return `<div class="tbl3__cap">表 ${spec.no}　${esc(spec.title)}</div>`
    + (spec.note ? `<div class="tbl3__note">注：${esc(spec.note)}</div>` : '');
}

// 完整表格块：题注在上（学术惯例）、表格居中、注在下。
function tableBlockHtml(rawSpec) {
  const spec = normalizeTable(rawSpec, 0);
  if (!spec) return '';
  return `<figure class="tbl3wrap">`
    + `<div class="tbl3__cap">表 ${spec.no}　${esc(spec.title)}</div>`
    + tableHtml(spec)
    + (spec.note ? `<div class="tbl3__note">注：${esc(spec.note)}</div>` : '')
    + '</figure>';
}

// ---------- Markdown ----------

function tableMarkdown(rawSpec) {
  const spec = normalizeTable(rawSpec, 0);
  if (!spec) return '';
  const head = `| ${spec.columns.join(' | ')} |`;
  const divider = `| ${spec.align.map((align) =>
    (align === 'left' ? ':---' : align === 'right' ? '---:' : ':---:')).join(' | ')} |`;
  const rows = spec.rows.map((row) =>
    `| ${spec.columns.map((_, i) => String(row[i] == null ? '' : row[i])).join(' | ')} |`);
  return [`**表${spec.no}　${spec.title}**`, '', head, divider, ...rows]
    .join('\n') + (spec.note ? `\n\n> 注：${spec.note}` : '');
}

// ---------- Word ----------

// 三线表：只有表格顶边、表头下边、表格底边三条线，粗细按学术惯例（顶/底 1.5 磅，表头 0.75 磅）。
// 单元格宽度按版心 9070 twips 均分，首列留宽一些放变量名。
function tableXml(rawSpec) {
  const spec = normalizeTable(rawSpec, 0);
  if (!spec) return '';
  const total = 9070;
  let widths;
  if (spec.widths) {
    const sum = spec.widths.reduce((acc, item) => acc + item, 0) || 1;
    widths = spec.widths.map((item) => Math.round((item / sum) * total));
  } else {
    const firstWidth = Math.round(total * (spec.columns.length > 4 ? 0.22 : 0.3));
    const restWidth = Math.round((total - firstWidth) / Math.max(1, spec.columns.length - 1));
    widths = spec.columns.map((_, i) => (i === 0 ? firstWidth : restWidth));
  }
  const cell = (text, index, { header = false } = {}) => {
    const align = spec.align[index] === 'left' ? 'left' : spec.align[index] === 'center' ? 'center' : 'right';
    const shade = header ? '' : '';
    return `<w:tc><w:tcPr><w:tcW w:w="${widths[index]}" w:type="dxa"/>${shade}`
      + '<w:tcBorders>'
      + (header ? '<w:bottom w:val="single" w:sz="8" w:space="0" w:color="000000"/>' : '')
      + '</w:tcBorders>'
      + `<w:vAlign w:val="center"/></w:tcPr>`
      + `<w:p><w:pPr><w:pStyle w:val="TableText"/><w:jc w:val="${align}"/></w:pPr>`
      + `<w:r><w:rPr>${header ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:tc>`;
  };
  const headerRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${spec.columns.map((name, i) => cell(name, i, { header: true })).join('')}</w:tr>`;
  const bodyRows = spec.rows.map((row) =>
    `<w:tr>${spec.columns.map((_, i) => cell(row[i] == null ? '' : row[i], i)).join('')}</w:tr>`).join('');
  const grid = `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`;
  const table = '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:jc w:val="center"/>'
    + '<w:tblBorders>'
    + '<w:top w:val="single" w:sz="12" w:space="0" w:color="000000"/>'
    + '<w:bottom w:val="single" w:sz="12" w:space="0" w:color="000000"/>'
    + '</w:tblBorders>'
    + '<w:tblLayout w:type="fixed"/></w:tblPr>'
    + `${grid}${headerRow}${bodyRows}</w:tbl>`;
  // 表格后必须跟空段落，否则紧接标题时 Word 会把表格和标题挤在一起
  return table + '<w:p/>';
}

// 题注与注：题注在表上方（学术惯例），注在表下方。
function tableCaptionXml(rawSpec) {
  const spec = normalizeTable(rawSpec, 0);
  if (!spec) return '';
  const caption = `<w:p><w:pPr><w:pStyle w:val="Caption"/><w:jc w:val="center"/></w:pPr>`
    + `<w:r><w:t xml:space="preserve">表 ${spec.no}　${esc(spec.title)}</w:t></w:r></w:p>`;
  const note = spec.note
    ? `<w:p><w:pPr><w:pStyle w:val="DocMeta"/><w:jc w:val="left"/></w:pPr>`
      + `<w:r><w:t xml:space="preserve">注：${esc(spec.note)}</w:t></w:r></w:p>`
    : '';
  return caption + tableXml(spec) + note;
}

// ---------- 正文占位符 ----------

const TABLE_LINE = /^【表\s*(\d{1,2})\s*[：:]\s*([^】]*)】$/;

function parseTableLine(line) {
  const matched = String(line || '').trim().match(TABLE_LINE);
  if (!matched) return null;
  return { no: Number(matched[1]), title: String(matched[2] || '').trim() };
}

function splitTableBlocks(content, tables) {
  const map = new Map((tables || []).map((item) => [Number(item.no), item]));
  const blocks = [];
  let buffer = [];
  const flush = () => {
    if (buffer.length) { blocks.push({ type: 'text', text: buffer.join('\n') }); buffer = []; }
  };
  for (const line of String(content || '').split(/\r?\n/)) {
    const parsed = parseTableLine(line);
    if (parsed) {
      const spec = map.get(parsed.no);
      if (spec) { flush(); blocks.push({ type: 'table', spec }); continue; }
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

// 全文表号连号（与图号同一套逻辑）
function globalizeTables(sections) {
  let counter = 0;
  return (sections || []).map((section) => {
    const tables = Array.isArray(section.tables) ? section.tables : [];
    const renumber = new Map();
    const mapped = tables.map((spec) => {
      counter += 1;
      renumber.set(Number(spec.no), counter);
      return { ...spec, no: counter };
    });
    const content = renumber.size
      ? String(section.content || '').replace(/【表\s*(\d{1,2})\s*([：:])/g, (whole, num, colon) => {
        const globalNo = renumber.get(Number(num));
        return globalNo ? `【表${globalNo}${colon}` : whole;
      })
      : String(section.content || '');
    return { content, tables: mapped };
  });
}

module.exports = {
  normalizeTable, normalizeTables, tableHtml, tableCaptionHtml, tableBlockHtml, tableMarkdown,
  tableXml, tableCaptionXml, splitTableBlocks, parseTableLine, globalizeTables, TABLE_LINE,
};
