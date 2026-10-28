'use strict';

// 从 .docx 里直接读出「这份文档长什么样」。
//
// 为什么要这个：蒸馏以前只吃纯文本，字体字号行距全靠模型「看」——文本里根本没有
// 这些信息，模型只能猜，猜出来的是「学术论文的常见值」，不是样例的真实版式。
// 而 .docx 是一套 OOXML，字体（w:rFonts）、字号（w:sz）、行距（w:spacing w:line）、
// 首行缩进（w:ind）、页边距（w:pgMar）、标题层级（w:pStyle / w:outlineLvl）全都在里面。
//
// 所以这里做的是「测量」而不是「推断」：解析器量出来的值可以直接写进排版规格，
// 再由 docx-export 原样还原成 Word 样式表——蒸馏 → 写作 → 导出 三步是同一个数。
//
// 解析范围：word/document.xml + word/styles.xml + word/theme/theme1.xml。
// 不处理：页眉页脚、脚注、批注、图片、域代码（它们不影响正文字体与版式判断）。

const { parseZip } = require('./zip');

const MAX_DOCX_BYTES = 12 * 1024 * 1024;
const MAX_PROBE_TEXT = 24000;

// ---------- XML 小工具 ----------

function decodeXml(text) {
  return String(text || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

function attr(tag, name) {
  const matched = String(tag || '').match(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}="([^"]*)"`));
  return matched ? matched[1] : '';
}

// 从一段 XML 片段里读出排版相关的属性。
// 段落属性（pPr）与字符属性（rPr）混着读是安全的：两者用到的标签不重叠
// （spacing/ind/jc/outlineLvl 只在 pPr，rFonts/sz/b 只在 rPr）。
function readProps(fragment) {
  const xml = String(fragment || '');
  const props = {};

  const fonts = xml.match(/<w:rFonts\b[^>]*>/);
  if (fonts) {
    const eastAsia = attr(fonts[0], 'w:eastAsia');
    const eastAsiaTheme = attr(fonts[0], 'w:eastAsiaTheme');
    const ascii = attr(fonts[0], 'w:ascii');
    if (eastAsia) props.fontEast = eastAsia;
    else if (eastAsiaTheme) props.fontEastTheme = eastAsiaTheme;
    if (ascii) props.fontAscii = ascii;
  }

  const size = xml.match(/<w:sz\b[^>]*w:val="(\d+)"/);
  if (size) props.size = Number(size[1]) / 2;   // 半磅 → 磅

  const bold = xml.match(/<w:b\b[^>]*>/);
  if (bold) props.bold = !/w:val="(?:0|false|off)"/.test(bold[0]);

  const spacing = xml.match(/<w:spacing\b[^>]*>/);
  if (spacing) {
    const line = attr(spacing[0], 'w:line');
    const rule = attr(spacing[0], 'w:lineRule') || 'auto';
    const after = attr(spacing[0], 'w:after');
    const before = attr(spacing[0], 'w:before');
    if (line) { props.line = Number(line); props.lineRule = rule; }
    if (after) props.after = Number(after) / 20;    // twips → 磅
    if (before) props.before = Number(before) / 20;
  }

  const ind = xml.match(/<w:ind\b[^>]*>/);
  if (ind) {
    const chars = attr(ind[0], 'w:firstLineChars');
    const twips = attr(ind[0], 'w:firstLine');
    if (chars) props.firstLineChars = Number(chars) / 100;   // 1/100 字符 → 字符
    else if (twips) props.firstLineTwips = Number(twips);
  }

  const jc = xml.match(/<w:jc\b[^>]*w:val="([^"]*)"/);
  if (jc) props.align = jc[1];

  const outline = xml.match(/<w:outlineLvl\b[^>]*w:val="(\d+)"/);
  if (outline) props.outline = Number(outline[1]);

  return props;
}

function mergeProps(...sources) {
  const out = {};
  for (const source of sources) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === null || value === '') continue;
      out[key] = value;
    }
  }
  return out;
}

// ---------- 样式表 ----------

function parseStyles(xml) {
  const text = String(xml || '');
  let defaults = {};
  const docDefaults = text.match(/<w:docDefaults>([\s\S]*?)<\/w:docDefaults>/);
  if (docDefaults) defaults = readProps(docDefaults[1]);

  const map = new Map();
  let defaultParagraph = '';
  const re = /<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g;
  let matched;
  while ((matched = re.exec(text))) {
    const attrs = matched[1];
    const body = matched[2];
    const id = attr(attrs, 'w:styleId');
    if (!id) continue;
    // 默认段落样式（Normal）：正文段落大多不写 pStyle，靠它继承字号行距缩进。
    // 只看 docDefaults 会把这些全丢掉——导出的稿子明明有首行缩进，解析出来却是 0。
    if (attr(attrs, 'w:type') === 'paragraph' && /w:default="(?:1|true|on)"/.test(attrs)) defaultParagraph = id;
    const nameTag = body.match(/<w:name\b[^>]*w:val="([^"]*)"/);
    const basedTag = body.match(/<w:basedOn\b[^>]*w:val="([^"]*)"/);
    map.set(id, {
      id,
      name: nameTag ? nameTag[1] : '',
      basedOn: basedTag ? basedTag[1] : '',
      props: readProps(body),
    });
  }
  return { map, defaults, defaultParagraph };
}

// 样式继承：basedOn 链一路并上来。链断了就用文档默认值，不抛错——
// 一份手工拼出来的 docx 里 basedOn 指向不存在的样式很常见。
function resolveStyle(id, styles, defaults) {
  const cache = new Map();
  const walk = (styleId, depth) => {
    if (!styleId || depth > 8) return { ...defaults };
    if (cache.has(styleId)) return cache.get(styleId);
    const entry = styles.map.get(styleId);
    if (!entry) return { ...defaults };
    const base = entry.basedOn && entry.basedOn !== styleId
      ? walk(entry.basedOn, depth + 1) : { ...defaults };
    const resolved = mergeProps(base, entry.props);
    cache.set(styleId, resolved);
    return resolved;
  };
  return walk(id, 0);
}

// 主题字体：Word 里「正文用主题字体」是常态（rFonts 只写 eastAsiaTheme），
// 这时真实字体名在 theme1.xml 的 minorFont/majorFont 里。
function parseThemeFonts(xml) {
  const text = String(xml || '');
  const eastAsiaOf = (block) => {
    if (!block) return '';
    const matched = block[1].match(/<a:ea\b[^>]*typeface="([^"]*)"/);
    return matched ? matched[1] : '';
  };
  return {
    minor: eastAsiaOf(text.match(/<a:minorFont>([\s\S]*?)<\/a:minorFont>/)),
    major: eastAsiaOf(text.match(/<a:majorFont>([\s\S]*?)<\/a:majorFont>/)),
  };
}

function fontFromTheme(props, theme) {
  if (props.fontEast) return props.fontEast;
  const key = String(props.fontEastTheme || '');
  if (/major/i.test(key) && theme.major) return theme.major;
  if (/minor/i.test(key) && theme.minor) return theme.minor;
  return '';
}

// ---------- 正文段落 ----------

function parseParagraphs(documentXml) {
  // 表格里的段落不参与版式统计：表格文字通常是小字号，会把正文均值拉偏。
  const xml = String(documentXml || '').replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, '');
  const list = [];
  const re = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let matched;
  while ((matched = re.exec(xml))) {
    const body = matched[1];
    const texts = [];
    const textRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
    let textMatched;
    while ((textMatched = textRe.exec(body))) texts.push(decodeXml(textMatched[1]));
    const text = texts.join('').replace(/\s+/g, ' ').trim();
    const pPr = (body.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [])[1] || '';
    const styleId = (pPr.match(/<w:pStyle\b[^>]*w:val="([^"]*)"/) || [])[1] || '';
    const runProps = [];
    const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
    let runMatched;
    while ((runMatched = runRe.exec(body))) runProps.push(readProps(runMatched[1]));
    const firstRun = runProps.find((item) => item.size || item.fontEast || item.fontEastTheme || item.bold) || runProps[0] || {};
    list.push({ text, styleId, pPrProps: readProps(pPr), runProps: firstRun });
  }
  return list;
}

function headingLevelOf(paragraph, props, styleName) {
  if (Number.isFinite(props.outline) && props.outline >= 0 && props.outline <= 8) return props.outline + 1;
  const name = String(styleName || '');
  const byName = name.match(/heading\s*([1-6])/i) || name.match(/标题\s*([1-6])/);
  if (byName) return Number(byName[1]);
  const byId = String(paragraph.styleId || '').match(/^Heading(\d)$/i) || String(paragraph.styleId || '').match(/^([1-6])$/);
  if (byId) return Number(byId[1]);
  return 0;
}

function weightedMode(pairs) {
  const weights = new Map();
  for (const [value, weight] of pairs) {
    if (value === undefined || value === null || value === '') continue;
    weights.set(value, (weights.get(value) || 0) + Math.max(1, weight));
  }
  let best = null;
  let bestWeight = 0;
  for (const [value, weight] of weights) {
    if (weight > bestWeight) { best = value; bestWeight = weight; }
  }
  return best;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

// 行距：auto 的 w:line 是 1/240 行；exact/atLeast 是 twips（绝对值），
// 换成「倍数」才有意义（Word 里固定值 20 磅 ≈ 单倍行距）。
function lineSpacingOf(props, bodySize) {
  if (!props.line) return null;
  const rule = String(props.lineRule || 'auto');
  if (rule === 'auto') return round2(props.line / 240);
  const points = props.line / 20;
  const base = bodySize > 0 ? bodySize * 1.2 : 12 * 1.2;
  return round2(points / base);
}

const PAGE_SIZES = { A4: [11906, 16838], Letter: [12240, 15840], B5: [9979, 14175] };

function pageSizeOf(width, height) {
  let best = 'A4';
  let bestDiff = Infinity;
  for (const [key, size] of Object.entries(PAGE_SIZES)) {
    const diff = Math.abs(size[0] - width) + Math.abs(size[1] - height);
    if (diff < bestDiff) { bestDiff = diff; best = key; }
  }
  return bestDiff <= 400 ? best : 'A4';
}

function twipsToCm(twips) {
  return round2(Number(twips) / 566.93);
}

// 标题里自带的编号：蒸馏出来的目录应该去掉它（导出时会按编号规则重新加），
// 但编号风格要记住（「一、」还是「1.1」）。
const CN_NUM_RE = /^[（(]?[一二三四五六七八九十百零]+[、.．)）]\s*/;
const ARABIC_NUM_RE = /^\d+(?:\.\d+)*[.、．]?\s+/;
const ARABIC_STRICT_RE = /^\d+(?:\.\d+)*[.、．]\s*/;
const CHAPTER_RE = /^第[一二三四五六七八九十百零\d]+[章节篇部分]\s*/;

function stripNumbering(title) {
  let text = String(title || '').trim();
  text = text.replace(CN_NUM_RE, '').replace(ARABIC_STRICT_RE, '').replace(ARABIC_NUM_RE, '');
  text = text.replace(CHAPTER_RE, '');
  return text.trim() || String(title || '').trim();
}

function detectNumbering(titles) {
  const list = titles.map((title) => String(title || '').trim()).filter(Boolean);
  if (!list.length) return 'none';
  const chinese = list.filter((title) => CN_NUM_RE.test(title)).length;
  const arabic = list.filter((title) => ARABIC_STRICT_RE.test(title)).length;
  if (chinese && chinese >= arabic) return 'chinese';
  if (arabic) return 'arabic';
  return 'none';
}

// ---------- 主入口 ----------

function probeDocx(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('没有读到文件内容');
  if (buffer.length > (options.maxBytes || MAX_DOCX_BYTES)) {
    throw new Error(`文件太大（上限 ${Math.round(MAX_DOCX_BYTES / 1024 / 1024)}MB），请先在 Word 里删掉图片再上传`);
  }
  let entries;
  try {
    entries = parseZip(buffer);
  } catch (error) {
    throw new Error(`不是可解析的 .docx（${String(error.message || error).slice(0, 80)}）`);
  }
  const find = (name) => entries.find((entry) => entry.name === name);
  const docEntry = find('word/document.xml');
  if (!docEntry) throw new Error('这不是 .docx 文件（缺少 word/document.xml）');

  const documentXml = String(docEntry.data);
  const stylesEntry = find('word/styles.xml');
  const styles = parseStyles(stylesEntry ? String(stylesEntry.data) : '');
  const themeEntry = find('word/theme/theme1.xml');
  const theme = parseThemeFonts(themeEntry ? String(themeEntry.data) : '');

  const paragraphs = parseParagraphs(documentXml).map((paragraph) => {
    // 没有 pStyle 的段落走默认段落样式（Normal），不是 docDefaults——
    // 首行缩进、行距、对齐大多写在 Normal 里。
    const styleId = paragraph.styleId || styles.defaultParagraph;
    const style = styleId ? resolveStyle(styleId, styles, styles.defaults) : { ...styles.defaults };
    const props = mergeProps(style, paragraph.pPrProps, paragraph.runProps);
    const font = fontFromTheme(props, theme);
    const styleName = styleId && styles.map.has(styleId) ? styles.map.get(styleId).name : '';
    return {
      text: paragraph.text,
      styleId: paragraph.styleId,
      props: font ? { ...props, fontEast: font } : props,
      styleName,
      level: headingLevelOf(paragraph, props, styleName),
    };
  }).filter((paragraph) => paragraph.text);

  if (!paragraphs.length) throw new Error('这份文档里没有可读的文字（可能全是图片）');

  // 1. 正文：按字数加权取众数，避免一个短标题把字号带偏。
  // 居中且很短（题名、作者、单位、日期）不算正文，否则它们会把对齐与缩进统计带跑偏。
  const titleLike = (paragraph) => /center/.test(String(paragraph.props.align || ''))
    && paragraph.text.length <= 40;
  const bodyCandidates = paragraphs.filter((paragraph) => !paragraph.level && !titleLike(paragraph)
    && paragraph.text.length >= 12);
  const bodyPool = bodyCandidates.length
    ? bodyCandidates
    : paragraphs.filter((paragraph) => !paragraph.level && !titleLike(paragraph));
  const bodySize = weightedMode(bodyPool.map((paragraph) => [paragraph.props.size, paragraph.text.length])) || 12;
  const bodyFont = weightedMode(bodyPool.map((paragraph) => [paragraph.props.fontEast, paragraph.text.length])) || '宋体';
  const bodyFontEn = weightedMode(bodyPool.map((paragraph) => [paragraph.props.fontAscii, paragraph.text.length]))
    || (/^[\u4e00-\u9fa5]/.test(bodyFont) ? 'Times New Roman' : bodyFont);

  // 2. 没有标题样式时按「加粗 / 比正文大 / 短」推断层级。
  let usedFallback = false;
  if (!paragraphs.some((paragraph) => paragraph.level)) {
    const sizes = [...new Set(paragraphs
      .filter((paragraph) => paragraph.text.length <= 60
        && (paragraph.props.bold || (paragraph.props.size || 0) >= bodySize + 1)
        && !/[。；，、]$/.test(paragraph.text))
      .map((paragraph) => round2(paragraph.props.size || bodySize)))]
      .sort((a, b) => b - a)
      .slice(0, 3);
    if (sizes.length) {
      usedFallback = true;
      for (const paragraph of paragraphs) {
        if (paragraph.text.length > 60 || /[。；，、]$/.test(paragraph.text)) continue;
        const size = round2(paragraph.props.size || bodySize);
        const rank = sizes.indexOf(size);
        if (rank < 0) continue;
        if (!paragraph.props.bold && size < bodySize + 1) continue;
        paragraph.level = rank + 1;
      }
    }
  }

  const headings = paragraphs.filter((paragraph) => paragraph.level > 0 && paragraph.text);

  // 文档大标题：居中、比正文大、且不是标题样式的那一段（封面上的题名）。
  // 有些模板把题名也套成「标题 1」，所以补一条：若首个标题明显大于其余标题且居中，
  // 同样按题名处理，并从目录里摘掉——否则导出的稿子会多出一个「一、论文题目」。
  let titleSize = 0;
  let titleFont = '';
  const centered = paragraphs
    .filter((paragraph) => !paragraph.level && /center/.test(String(paragraph.props.align || ''))
      && paragraph.text.length <= 60 && (paragraph.props.size || 0) > bodySize)
    .sort((a, b) => (b.props.size || 0) - (a.props.size || 0));
  if (centered.length) {
    titleSize = centered[0].props.size;
    titleFont = centered[0].props.fontEast || '';
  } else if (headings.length > 1) {
    const top = headings[0];
    const maxOther = Math.max(...headings.slice(1).map((paragraph) => paragraph.props.size || 0));
    if ((top.props.size || 0) >= maxOther + 2 && /center/.test(String(top.props.align || ''))) {
      titleSize = top.props.size;
      titleFont = top.props.fontEast || '';
      headings.shift();
    }
  }
  const headingSet = new Set(headings);

  // 3. 标题字号：按层级取众数；缺的层级按正文字号递推，绝不留空。
  const headingSizes = {};
  for (let level = 1; level <= 3; level++) {
    const pool = headings.filter((paragraph) => Math.min(3, paragraph.level) === level);
    headingSizes[level] = weightedMode(pool.map((paragraph) => [round2(paragraph.props.size || 0), paragraph.text.length]))
      || [bodySize + 3, bodySize + 2, bodySize][level - 1];
  }
  const headingFont = weightedMode(headings.map((paragraph) => [paragraph.props.fontEast, paragraph.text.length])) || '黑体';
  const headingBold = weightedMode(headings.map((paragraph) => [paragraph.props.bold ? 'b' : 'n', paragraph.text.length])) !== 'n';

  // 4. 页面与页边距：取最后一个 sectPr（多节文档里正文节通常在最后）。
  const pageMargins = [...documentXml.matchAll(/<w:pgMar\b[^>]*>/g)].map((item) => item[0]);
  const pageSizes = [...documentXml.matchAll(/<w:pgSz\b[^>]*>/g)].map((item) => item[0]);
  const marginTag = pageMargins.length ? pageMargins[pageMargins.length - 1] : '';
  const sizeTag = pageSizes.length ? pageSizes[pageSizes.length - 1] : '';
  const rawWidth = Number(attr(sizeTag, 'w:w')) || 11906;
  const rawHeight = Number(attr(sizeTag, 'w:h')) || 16838;
  const landscape = rawWidth > rawHeight;
  const layout = {
    pageSize: pageSizeOf(Math.min(rawWidth, rawHeight), Math.max(rawWidth, rawHeight)),
    orientation: landscape ? 'landscape' : 'portrait',
    marginTop: marginTag ? twipsToCm(attr(marginTag, 'w:top')) : 2.54,
    marginBottom: marginTag ? twipsToCm(attr(marginTag, 'w:bottom')) : 2.54,
    marginLeft: marginTag ? twipsToCm(attr(marginTag, 'w:left')) : 3.17,
    marginRight: marginTag ? twipsToCm(attr(marginTag, 'w:right')) : 3.17,
    bodyFont,
    bodyFontEn,
    bodySize,
    lineSpacing: weightedMode(bodyPool.map((paragraph) => [lineSpacingOf(paragraph.props, bodySize), paragraph.text.length])) || 1.5,
    paraSpacing: weightedMode(bodyPool.map((paragraph) => [round2(paragraph.props.after || 0), paragraph.text.length])) || 0,
    firstLineIndent: weightedMode(bodyPool.map((paragraph) => [
      paragraph.props.firstLineChars !== undefined
        ? round2(paragraph.props.firstLineChars)
        : round2((paragraph.props.firstLineTwips || 0) / (bodySize * 20)),
      paragraph.text.length,
    ])) || 0,
    align: weightedMode(bodyPool.map((paragraph) => [paragraph.props.align, paragraph.text.length])) || 'both',
    titleSize: titleSize || headingSizes[1],
    titleFont: titleFont || headingFont,
    headingFont,
    headingSizes,
    headingBold,
    numbering: detectNumbering(headings.map((paragraph) => paragraph.text)),
  };

  // 5. 目录 + 每节篇幅：标题之间的正文字数就是这一节的篇幅。
  const outline = [];
  const headingIndexes = paragraphs
    .map((paragraph, index) => ({ paragraph, index }))
    .filter((item) => headingSet.has(item.paragraph));
  headingIndexes.forEach((item, position) => {
    const level = Math.min(3, Math.max(1, item.paragraph.level));
    const next = headingIndexes[position + 1];
    const end = next ? next.index : paragraphs.length;
    let chars = 0;
    for (let index = item.index + 1; index < end; index++) {
      if (paragraphs[index].level > 0) continue;
      chars += paragraphs[index].text.length;
    }
    outline.push({
      level,
      title: stripNumbering(item.paragraph.text).slice(0, 120),
      brief: '',
      minChars: Math.max(120, Math.min(4000, chars)),
    });
  });

  // 6. 交给模型的纯文本：标题用 # 还原层级，模型据此写 brief。
  const textParts = [];
  let textLength = 0;
  for (const paragraph of paragraphs) {
    const line = paragraph.level > 0
      ? `${'#'.repeat(Math.min(3, Math.max(1, paragraph.level)))} ${paragraph.text}`
      : paragraph.text;
    if (textLength + line.length > (options.maxText || MAX_PROBE_TEXT)) break;
    textParts.push(line);
    textLength += line.length + 1;
  }

  const warnings = [];
  if (usedFallback) warnings.push('这份文档没有用标题样式，层级是按字号/加粗推断的，建议核对目录');
  if (!stylesEntry) warnings.push('文档没有 styles.xml，字体字号取自段落直接格式，可能不全');
  if (!outline.length) warnings.push('没识别出章节标题，蒸馏结果需要手工补目录');

  return {
    layout,
    outline,
    text: textParts.join('\n\n'),
    warnings,
    stats: {
      paragraphs: paragraphs.length,
      chars: paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0),
      headings: outline.length,
      usedFallback,
      hasStyles: !!stylesEntry,
    },
  };
}

module.exports = { probeDocx, stripNumbering, detectNumbering, MAX_DOCX_BYTES };
