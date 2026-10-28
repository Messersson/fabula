'use strict';

// 论文成稿的最后一公里：引用著录、数字溯源、图表呼应、重复检测。
//
// 这些都是「稿子能不能交出去」层面的事，不是「写得好不好」：
// - 参考文献页写着 [M1] 行业年报 —— 这不是参考文献，是内部工单号，交稿会被退
// - 正文里的数字没有来源 —— 模型顺手编一个「73% 的企业」，系统一个都查不出来
// - 图表摆在那里，正文从不说「如图 1 所示」 —— 审稿意见里最常见的一条
// - 两节换个说法讲同一件事 —— 精确查重查不出来，但审稿人一眼看得出
//
// 全部是纯函数，不碰数据库、不发请求。

const CITATION_PATTERN = /\[(M\d{1,3})\]/g;

// ---------- 引用编号重映射 ----------

// 学术惯例：参考文献按**正文首次引用顺序**编号，不是按素材录入顺序。
// 内部编号 [M1] 必须换成正文序号 [1]——工单号出现在论文正文里是不能交的。
function citationMap(sections, index) {
  const order = [];
  const seen = new Set();
  for (const section of sections || []) {
    const text = String(section.content || '');
    const matched = text.match(CITATION_PATTERN) || [];
    for (const token of matched) {
      const key = token.slice(1, -1).toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      order.push(key);
    }
  }
  const map = new Map();
  order.forEach((key, index2) => map.set(key, index2 + 1));
  return { map, order };
}

// 把正文里的 [M1] 换成 [1]。没被引用过的素材不编号（也进不了参考文献页）。
function remapCitations(text, map) {
  if (!map || !map.size) return String(text || '');
  return String(text || '').replace(CITATION_PATTERN, (whole, key) => {
    const no = map.get(key.toUpperCase());
    return no ? `[${no}]` : whole;
  });
}

// ---------- 参考文献著录 ----------

const TYPE_MARK = {
  literature: 'J',   // 期刊文章
  data: 'R',         // 报告
  policy: 'A',       // 法规/政策
  material: 'Z',     // 其他
};

const TYPE_NAME = {
  literature: '期刊论文', data: '研究报告', policy: '政策法规', material: '资料',
};

function splitAuthors(raw) {
  return String(raw || '')
    .split(/[;；,，、]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function gbtReference(entry) {
  // GB/T 7714-2015：[序号] 主要责任者. 题名[文献类型标识]. 出处, 年, 卷(期): 页码.
  // 出处字段通常已经把「刊名 年(期): 页码」写全了，这时不再重复补年份。
  const authors = splitAuthors(entry.authors);
  const authorPart = authors.length
    ? (authors.length > 3 ? `${authors.slice(0, 3).join(', ')}, 等` : authors.join(', '))
    : (entry.title || '未署名');
  const mark = TYPE_MARK[entry.kind] || 'Z';
  const pieces = [`[${entry.no}]`, `${authorPart}.`, `${entry.title || '未命名文献'}[${mark}].`];
  const source = String(entry.source || '').trim();
  if (source) pieces.push(/[.。]$/.test(source) ? source : `${source}.`);
  else if (entry.year) pieces.push(`${entry.year}.`);
  return pieces.join(' ');
}

function apaReference(entry) {
  const authors = splitAuthors(entry.authors);
  const authorPart = authors.length ? authors.join(', ') : (entry.title || '未署名');
  const year = entry.year ? `(${entry.year})` : '(n.d.)';
  const source = entry.source ? ` ${entry.source}.` : '';
  return `${authorPart} ${year}. ${entry.title || '未命名文献'}.${source}`;
}

// 支持的著录体例。GB/T 7714 是中文期刊投稿的硬要求，APA 覆盖英文场合。
const REF_STYLES = {
  gbt7714: { name: 'GB/T 7714（中文期刊）', format: gbtReference },
  apa: { name: 'APA（英文稿）', format: apaReference },
};

function formatReference(entry, style = 'gbt7714') {
  const chosen = REF_STYLES[style] || REF_STYLES.gbt7714;
  return chosen.format(entry);
}

// ---------- 数字溯源 ----------

// 只认「像数据」的单位：序数、序号、泛指的「个/条/次」不算数据。
const DATA_UNITS = [
  '%', '‰', '万元/人', '万元', '亿元', '人次', '人', '家', '倍',
  '个月', '周', '月', '年', '天', '小时', '分钟', '吨', '元', '美元', '百分点',
];

const UNIT_RE = new RegExp(`(${DATA_UNITS.map((u) => u.replace('/', '\\/')).join('|')})`);

// 把数字统一成可比较的形态：去掉千分位逗号，百分号只留数字。
function normalizeNumber(value) {
  const text = String(value).replace(/,/g, '').trim();
  const num = Number(text);
  if (!Number.isFinite(num)) return '';
  return String(Math.round(num * 1000) / 1000);
}

// 抽取正文里「像数据」的数字。
// 年份（1900~2100）排除：那多半是时间而不是数据；序数没有单位也不进候选。
function extractNumbers(text) {
  const source = String(text || '');
  const out = [];
  const re = /(\d+(?:,\d{3})*(?:\.\d+)?)\s*(%|‰|万元\/人|万元|亿元|人次|人|家|倍|个月|周|月|年|天|小时|分钟|吨|元|美元|百分点)?/g;
  let matched = null;
  while ((matched = re.exec(source))) {
    const raw = matched[1];
    const unit = matched[2] || '';
    const value = Number(raw.replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    if (!unit) continue;                        // 无单位：可能是序号/编号
    if (value >= 1900 && value <= 2100 && (unit === '年' || unit === '月' || unit === '天')) continue;
    const norm = normalizeNumber(raw);
    if (!norm) continue;
    out.push({ raw, norm, unit, value, at: matched.index, end: matched.index + matched[0].length });
  }
  return out;
}

// 素材与图表里出现过的数字，构成「有出处的数字」全集。
// 素材里的**所有**数字都算有出处，不要求带单位：中文常写「128、186、242、298 万元」，
// 单位只在末尾出现一次；按「数字+单位」逐个抓会漏掉前面几个，把真数据误报成编造。
function sourceNumberSet(materials, figures, tables) {
  const set = new Set();
  const addBare = (text) => {
    const re = /\d+(?:,\d{3})*(?:\.\d+)?/g;
    let matched = null;
    while ((matched = re.exec(String(text || '')))) {
      const norm = normalizeNumber(matched[0]);
      if (norm) set.add(norm);
    }
  };
  const addScaled = (text) => {
    for (const item of extractNumbers(text)) {
      set.add(item.norm);
      // 「3.2 万」与「32000」视为同一个数，避免单位换算造成的误报
      if (item.unit === '万元' || item.unit === '元') set.add(normalizeNumber(item.value * 10000));
      if (item.unit === '亿元') set.add(normalizeNumber(item.value * 100000000));
    }
  };
  for (const material of materials || []) {
    const text = String(material.text || material.content || '');
    addBare(text);
    addScaled(text);
  }
  for (const list of figures || []) {
    for (const spec of list || []) {
      for (const series of spec.series || []) {
        for (const value of series.values || []) set.add(normalizeNumber(value));
      }
      for (const category of spec.categories || []) addBare(category);
    }
  }
  // 统计表里的每个单元格都是算出来的数，正文引用它们时不该被当成「无出处」
  for (const list of tables || []) {
    for (const spec of list || []) {
      for (const row of spec.rows || []) {
        for (const cell of row || []) addBare(cell);
      }
      addBare(spec.note);
    }
  }
  return set;
}

// 正文里的数字哪些找不到出处。
// 这是防「模型自己编数据」的最后一道闸：素材里没有的数字，要么是推算值，要么是编的。
function unbackedNumbers(content, sourceSet, { limit = 8 } = {}) {
  const found = new Map();
  const text = String(content || '');
  for (const item of extractNumbers(text)) {
    // 「在 1% 水平上显著」「在 0.1% 的显著性水平上」——这类百分比是显著性水平，不是数据。
    // 不能只匹配紧跟的「水平」：真实稿子里更常见的是「的显著性水平」，中间隔了几个字。
    if (text.slice(item.end, item.end + 10).includes('水平')) continue;
    if (sourceSet.has(item.norm)) continue;
    if (sourceSet.has(normalizeNumber(item.value))) continue;
    if (sourceSet.has(normalizeNumber(item.value * 10000))) continue;
    if (sourceSet.has(normalizeNumber(item.value * 100000000))) continue;
    const key = `${item.norm}${item.unit}`;
    if (!found.has(key)) found.set(key, item);
  }
  return [...found.values()].slice(0, limit);
}

// ---------- 图表与正文呼应 ----------

// 正文里提到的「图 N」「表 N」（排除图表占位符本身那一行）。
function figureMentions(content, kind = '图') {
  const text = String(content || '').split(/\r?\n/)
    .filter((line) => !new RegExp(`^\\s*【${kind}\\s*\\d+\\s*[：:】]`).test(line))
    .join('\n');
  const out = new Set();
  const re = new RegExp(`${kind}\\s*(\\d{1,2})`, 'g');
  let matched = null;
  while ((matched = re.exec(text))) out.add(Number(matched[1]));
  return out;
}

// ---------- 近似重复 ----------

function bigrams(text) {
  const clean = String(text || '').replace(/[\s\u3000]/g, '');
  const set = new Set();
  for (let i = 0; i + 2 <= clean.length; i++) set.add(clean.slice(i, i + 2));
  return set;
}

function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const gram of a) if (b.has(gram)) hit += 1;
  return hit / Math.min(a.size, b.size);
}

// 跨节「换个说法重复」。精确查重查不出来，但相似度高的段落审稿人一眼看得出。
function nearDuplicates(sections, { threshold = 0.72, sameSectionThreshold = 0.82, minChars = 40 } = {}) {
  const entries = [];
  for (const section of sections || []) {
    for (const raw of String(section.content || '').split(/\n{2,}/)) {
      const text = String(raw).trim();
      if (text.length < minChars) continue;
      entries.push({ idx: section.idx, text, grams: bigrams(text) });
    }
  }
  const hits = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const sameSection = entries[i].idx === entries[j].idx;
      // 同节内部的重复很常见（反复引用同一条文献的同一个数字），但阈值要高一些，
      // 否则正常承接的段落会被误判。
      const bar = sameSection ? sameSectionThreshold : threshold;
      const score = similarity(entries[i].grams, entries[j].grams);
      if (score >= bar) {
        hits.push({
          score: Math.round(score * 100) / 100,
          sameSection,
          a: entries[i], b: entries[j],
          snippet: entries[i].text.slice(0, 40),
        });
      }
    }
  }
  return hits.sort((x, y) => y.score - x.score);
}

// 模板绑定的文档：正文里的 # 标题一律降为加粗行。
//
// 模型偶尔会在节内写「## 数据来源」这类标题。照原样渲染，它就变成了模板目录之外的章节——
// 页面目录、Markdown、Word 导航窗格三处都会多出一级标题，模板的章节目录当场失效。
// 所以「严格沿用模板」不能只靠提示词，渲染层必须兜住。
//
// 代码块里的 # 是注释不是标题，必须跳过：``` 围栏内的内容原样保留。
function demoteHeadings(text) {
  const source = String(text == null ? '' : text);
  const lines = source.split(/\r?\n/);
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    const matched = /^([ \t]{0,3})(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (!matched) return line;
    const title = matched[3].replace(/\*\*/g, '').trim();
    return title ? `${matched[1]}**${title}**` : line;
  }).join('\n');
}

// 模板模式下，正文里模型自写的「一、」「（一）」「1.1」这类编号行也要处理。
//
// Markdown 标题能被 demoteHeadings 降级，但纯文本的编号行不是标题语法，
// 导出后仍是一行「一、现状分析」。而模板的节标题本来就带编号，
// 两处编号叠在一起，正文看起来像多出了一层目录，读者会以为文档结构被改过。
//
// 处理方式：把这类「短行 + 纯编号前缀」的编号去掉，文字保留为加粗行。
// 只处理明显是标题的形态（行短、无句末标点、整行以编号开头），
// 否则「一、这是我第一点看法……」这类正常句子会被误伤。
//
// 「1. 」这种单层阿拉伯数字不处理：它在正文里绝大多数是有序列表项，
// 剥掉编号会让列表塌成一段话。只有多层的「1.1」「2.3.4」才当作标题编号。
const PSEUDO_HEADING_RE = /^[ \t]{0,3}(?:第[一二三四五六七八九十百千\d]+[章节篇部]|[一二三四五六七八九十]+、|（[一二三四五六七八九十]+）|\d+(?:\.\d+)+[、.．]?|[（(][一二三四五六七八九十\d]+[)）])[ \t]*(.+)$/;

// 编号前缀（分组 1）与标题文字（分组 2）。
// 上面那个正则里内层括号也可能是捕获组，直接取 matched[2] 会拿到 undefined。
// 统一在这里拆：最后一个捕获组是标题文字。
function splitPseudoHeading(line) {
  const matched = PSEUDO_HEADING_RE.exec(line);
  if (!matched) return null;
  const title = String(matched[matched.length - 1] || '').trim();
  if (!title) return null;
  const prefix = String(matched[0] || '').slice(0, String(matched[0] || '').length - title.length).trim();
  return { prefix, title };
}

function stripPseudoHeadings(text, { asHeading = false } = {}) {
  const source = String(text == null ? '' : text);
  const lines = source.split(/\r?\n/);
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    const parsed = splitPseudoHeading(line);
    if (!parsed) return line;
    const title = parsed.title;
    // 太长就是正文句子，不是标题；带句末标点也是正文。
    if (!title || title.length > 40 || /[。！？；,，、]$/.test(title)) return line;
    // asHeading：Word 导出时把它变成 markdown 标题，导出层再降级为「正文小标题」，
    // 这样它在 Word 里有独立的段落样式（而不是一段普通加粗文字）。
    return asHeading ? `#### ${title}` : `**${title}**`;
  }).join('\n');
}

// 模板绑定文档的正文规范化：Markdown 标题降级 + 去掉模型自写的编号前缀。
function normalizeTemplateBody(text) {
  return stripPseudoHeadings(demoteHeadings(text));
}

module.exports = {
  CITATION_PATTERN, citationMap, remapCitations,
  REF_STYLES, formatReference, splitAuthors, TYPE_MARK, TYPE_NAME,
  extractNumbers, sourceNumberSet, unbackedNumbers, normalizeNumber,
  figureMentions, nearDuplicates, bigrams, similarity, demoteHeadings,
  stripPseudoHeadings, normalizeTemplateBody, PSEUDO_HEADING_RE,
};
