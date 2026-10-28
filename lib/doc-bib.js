'use strict';

// 文献导入：BibTeX / RIS / CSL-JSON → 素材条目。
//
// 为什么从这里入手：文献综述是「学术论文」区别于「调研报告」的地方，
// 而模型不可能凭记忆给出真实文献——那只会编。现实里每个研究者手上都有
// Zotero / EndNote / 知网导出的 .bib / .ris / .json，把它们接进来，
// 文献综述才有真实的地基。
//
// 解析器零依赖，容错优先：格式不规范时宁可少解析一条，也不要整份失败。

// ---------- LaTeX 转纯文本（BibTeX 的作者名与标题里常见） ----------

const ACCENTS = {
  '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', A: 'Ä', E: 'Ë', I: 'Ï', O: 'Ö', U: 'Ü', y: 'ÿ' },
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ć', n: 'ń', s: 'ś', z: 'ź', A: 'Á', E: 'É' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê' },
  '~': { a: 'ã', n: 'ñ', o: 'õ', A: 'Ã', N: 'Ñ', O: 'Õ' },
  c: { c: 'ç', C: 'Ç' },
};

function latexToText(input) {
  let text = String(input == null ? '' : input);
  // \"o  \"{o}  {\"o}  \'e  \c{c} 等
  text = text.replace(/\\(["'`^~])\s*\{?([a-zA-Z])\}?/g, (whole, mark, letter) => {
    const table = ACCENTS[mark];
    return (table && table[letter]) || letter;
  });
  text = text.replace(/\\c\s*\{?([cC])\}?/g, (whole, letter) => (letter === 'c' ? 'ç' : 'Ç'));
  // 常见符号与命令
  text = text
    .replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\_/g, '_').replace(/\\\$/g, '$')
    .replace(/---/g, '—').replace(/--/g, '–')
    .replace(/\\[a-zA-Z]+\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

// ---------- BibTeX ----------

function splitFields(body) {
  // 按「逗号 + 后面跟 name =」切分，避免把 {a, b} 里的逗号当分隔
  const fields = [];
  let depth = 0;
  let quoted = false;
  let buffer = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"' && depth === 0) { quoted = !quoted; buffer += ch; continue; }
    if (!quoted) {
      if (ch === '{' || ch === '(') depth += 1;
      if (ch === '}' || ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) { fields.push(buffer); buffer = ''; continue; }
    }
    buffer += ch;
  }
  if (buffer.trim()) fields.push(buffer);
  return fields.map((field) => {
    const matched = /^\s*([a-zA-Z]+)\s*=\s*([\s\S]*)$/.exec(field);
    if (!matched) return null;
    let value = matched[2].trim();
    if (value.startsWith('{') && value.endsWith('}')) value = value.slice(1, -1);
    else if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    // 多个字段用 # 连接（"a" # "b"）时取拼接结果
    if (value.includes('" # "') || value.includes('} # {')) {
      value = value.replace(/[{}"]\s*#\s*[{}"]/g, '');
    }
    return [matched[1].toLowerCase(), value];
  }).filter(Boolean);
}

function parseBibtex(text) {
  const source = String(text || '');
  const entries = [];
  let index = 0;
  while (index < source.length) {
    const at = source.indexOf('@', index);
    if (at < 0) break;
    const head = /^@([a-zA-Z]+)\s*[{(]\s*([^,\s]*)\s*,/.exec(source.slice(at));
    if (!head) { index = at + 1; continue; }
    const type = head[1].toLowerCase();
    if (type === 'comment' || type === 'preamble' || type === 'string') { index = at + head[0].length; continue; }
    const bodyStart = at + head[0].length;
    // 从 bodyStart 开始找配对的右括号
    let depth = 1;
    let cursor = bodyStart;
    while (cursor < source.length && depth > 0) {
      const ch = source[cursor];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      cursor += 1;
    }
    const body = source.slice(bodyStart, cursor - 1);
    const fields = Object.fromEntries(splitFields(body));
    entries.push({ type, key: head[2], ...fields });
    index = cursor;
  }
  return entries;
}

// ---------- RIS ----------

function parseRis(text) {
  const records = [];
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const matched = /^([A-Z][A-Z0-9])\s{2}-\s?(.*)$/.exec(raw.trim());
    if (!matched) continue;
    const [, tag, value] = matched;
    if (tag === 'TY') { current = { type: value.trim(), authors: [] }; continue; }
    if (!current) continue;
    if (tag === 'ER') { records.push(current); current = null; continue; }
    if (tag === 'AU' || tag === 'A1') { current.authors.push(value.trim()); continue; }
    if (tag === 'TI' || tag === 'T1') { current.title = value.trim(); continue; }
    if (tag === 'PY' || tag === 'Y1') { current.year = (value.match(/\d{4}/) || [])[0] || ''; continue; }
    if (tag === 'JO' || tag === 'JF' || tag === 'T2' || tag === 'JA') { current.source = value.trim(); continue; }
    if (tag === 'DO') { current.doi = value.trim(); continue; }
    if (tag === 'AB' || tag === 'N2') { current.abstract = value.trim(); continue; }
    if (tag === 'VL') { current.volume = value.trim(); continue; }
    if (tag === 'IS') { current.issue = value.trim(); continue; }
    if (tag === 'SP') { current.pages = value.trim(); continue; }
    if (tag === 'EP') { current.pages = `${current.pages || ''}-${value.trim()}`; continue; }
  }
  if (current) records.push(current);
  return records;
}

// ---------- CSL-JSON（Zotero 导出） ----------

function parseCsl(text) {
  let parsed = null;
  try { parsed = JSON.parse(String(text || '')); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed && parsed.items) ? parsed.items : []);
  return list.map((item) => {
    const authors = (Array.isArray(item.author) ? item.author : [])
      .map((author) => [author.family, author.given].filter(Boolean).join(' '))
      .filter(Boolean);
    const issued = item.issued && Array.isArray(item.issued['date-parts']) ? item.issued['date-parts'][0] : null;
    const container = Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title'];
    return {
      type: item.type || 'article-journal',
      title: item.title || '',
      authors,
      year: issued && issued[0] ? String(issued[0]) : '',
      source: container || item.publisher || '',
      doi: item.DOI || '',
      abstract: item.abstract || '',
      volume: item.volume || '',
      issue: item.issue || '',
      pages: item.page || '',
    };
  });
}

// ---------- 统一成素材 ----------

const TYPE_TO_KIND = {
  article: 'literature', inproceedings: 'literature', incollection: 'literature',
  book: 'literature', phdthesis: 'literature', mastersthesis: 'literature', thesis: 'literature',
  techreport: 'data', report: 'data', misc: 'material',
  'article-journal': 'literature', 'paper-conference': 'literature', book: 'literature',
  thesis: 'literature', report: 'data', webpage: 'material', legislation: 'policy',
  JOUR: 'literature', CONF: 'literature', BOOK: 'literature', THES: 'literature',
  RPRT: 'data', GEN: 'material', ELEC: 'material', STAT: 'policy',
};

function cleanAuthors(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/\s+and\s+/);
  return list
    .map((name) => latexToText(String(name || '').replace(/\s+/g, ' ').trim()))
    .map((name) => {
      // BibTeX 的「姓, 名」转成「名 姓」
      const matched = /^([^,]+),\s*(.+)$/.exec(name);
      return matched ? `${matched[2].trim()} ${matched[1].trim()}`.trim() : name;
    })
    .filter(Boolean)
    .join(', ');
}

function toMaterial(entry) {
  const title = latexToText(entry.title || '');
  if (!title) return null;
  const authors = cleanAuthors(entry.authors || entry.author || '');
  const year = String(entry.year || '').match(/\d{4}/) ? String(entry.year).match(/\d{4}/)[0] : '';
  const container = latexToText(entry.source || entry.journal || entry.booktitle || entry.publisher || '');
  const volume = entry.volume ? String(entry.volume).trim() : '';
  const issue = entry.issue || entry.number ? String(entry.issue || entry.number).trim() : '';
  const pages = entry.pages ? String(entry.pages).trim().replace(/--/g, '-') : '';
  // 拼成 GB/T 7714 里「出处」那一栏的样子：刊名, 年, 卷(期): 页码
  const sourceParts = [container];
  if (year && !container.includes(year)) sourceParts.push(year);
  if (volume) sourceParts.push(issue ? `${volume}(${issue})` : volume);
  if (pages) sourceParts[sourceParts.length - 1] += `: ${pages}`;
  const source = sourceParts.filter(Boolean).join(', ').replace(/,\s*(\d{4})/, ', $1');
  const abstract = latexToText(entry.abstract || '');
  const kind = TYPE_TO_KIND[entry.type] || TYPE_TO_KIND[String(entry.type || '').toUpperCase()] || 'literature';
  return {
    title,
    authors,
    year,
    source,
    kind,
    doi: String(entry.doi || '').trim(),
    // 摘要就是「可读的原文」，没有摘要时留一句提示，不要编
    content: abstract || `（该条目没有摘要；题名：${title}。写作时只能引用题名与出处，不要推测其结论。）`,
  };
}

// 自动识别格式：@开头是 BibTeX，TY  - 是 RIS，[ 或 { 开头多半是 CSL-JSON
function detectFormat(text, filename = '') {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.bib') || name.endsWith('.bibtex')) return 'bibtex';
  if (name.endsWith('.ris')) return 'ris';
  if (name.endsWith('.json')) return 'csl';
  const head = String(text || '').trim().slice(0, 400);
  if (/^@[a-zA-Z]+\s*[{(]/.test(head)) return 'bibtex';
  if (/^TY\s{2}-/m.test(head)) return 'ris';
  if (/^[[{]/.test(head)) return 'csl';
  return 'unknown';
}

// 主入口：文本 → { format, entries, skipped }
function parseBibliography(text, { filename = '' } = {}) {
  const format = detectFormat(text, filename);
  let raw = [];
  if (format === 'bibtex') raw = parseBibtex(text);
  else if (format === 'ris') raw = parseRis(text);
  else if (format === 'csl') raw = parseCsl(text);
  else {
    // 认不出来时三种都试一遍，能解析出条目的就算
    for (const parser of [parseBibtex, parseRis, parseCsl]) {
      const attempt = parser(text);
      if (attempt.length) { raw = attempt; break; }
    }
  }
  const entries = [];
  let skipped = 0;
  const seen = new Set();
  for (const item of raw) {
    const material = toMaterial(item);
    if (!material) { skipped += 1; continue; }
    const fingerprint = `${material.title}|${material.year}`.toLowerCase();
    if (seen.has(fingerprint)) { skipped += 1; continue; }
    seen.add(fingerprint);
    entries.push(material);
  }
  return { format, entries, skipped, total: raw.length };
}

module.exports = {
  parseBibliography, parseBibtex, parseRis, parseCsl, toMaterial,
  detectFormat, latexToText, cleanAuthors, TYPE_TO_KIND,
};
