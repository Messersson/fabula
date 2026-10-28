'use strict';

// 排版规格（Layout Spec）：字体、字号、行距、段距、缩进、编号规则、页边距。
//
// 蒸馏的需求不只是「文风」，而是「照着写出来的东西长什么样」：
// 标题几号字、正文几号字、行距多少、几级标题、编号是「一、」还是「1.1」。
// 这些东西必须落到 Word 导出的样式表上，否则「排版」只是提示词里的一句话，
// 导出来的稿子还是默认宋体小四。
//
// 所以这里做三件事：
// 1. 定义规格的数据形状与默认值（DEFAULT_LAYOUT）
// 2. normalizeLayout：把模型给的规格夹到合法范围（字号不能是 0，行距不能是负数）
// 3. 把规格翻译成 Word styles.xml 的参数 / 页面预览的 CSS / 写作提示词里的一段话

const DEFAULT_LAYOUT = {
  pageSize: 'A4',
  orientation: 'portrait',
  marginTop: 2.54,      // 厘米
  marginBottom: 2.54,
  marginLeft: 3.17,
  marginRight: 3.17,
  bodyFont: '宋体',
  bodyFontEn: 'Times New Roman',
  bodySize: 12,         // 磅
  lineSpacing: 1.5,     // 倍数
  paraSpacing: 0,       // 磅（段后距）
  firstLineIndent: 2,   // 字符
  align: 'both',        // 两端对齐
  titleSize: 18,
  titleFont: '黑体',
  headingFont: '黑体',
  headingSizes: { 1: 15, 2: 14, 3: 12 },
  headingBold: true,
  numbering: 'chinese', // chinese: 一、  arabic: 1.  none: 无
  captionSize: 10.5,
  captionAlign: 'center',
  footerText: '',
};

const SIZE_MIN = 6;
const SIZE_MAX = 42;
const SPACING_MIN = 0.6;
const SPACING_MAX = 3;

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function clampInt(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

const FONT_POOL = {
  body: ['宋体', '仿宋', '楷体', 'Times New Roman', '微软雅黑'],
  heading: ['黑体', '微软雅黑', '楷体', '方正小标宋简体', 'SimHei'],
};

function pickFont(value, pool, fallback) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return fallback;
  // 不做白名单硬限制：作者可能用「方正小标宋简体」这类未列出的字体，
  // 只做长度与非法字符检查。
  if (text.length > 40 || /[<>&"']/.test(text)) return fallback;
  return text;
}

// 章节目录里的小节层级：1=一级标题（章），2=二级，3=三级
function normalizeSections(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map((item, index) => {
    const level = clampInt(item && item.level, 1, 3, 1);
    const title = String(item && item.title || '').trim().slice(0, 120);
    const brief = String(item && item.brief || '').trim().slice(0, 1200);
    const minChars = clampInt(item && item.minChars, 120, 4000, 600);
    return { title, brief, minChars, level, order: index + 1 };
  }).filter((item) => item.title);
}

// 归一化整份排版规格。任何一项缺失/非法都退回默认值，绝不让模型输出把导出搞崩。
function normalizeLayout(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const headings = source.headingSizes && typeof source.headingSizes === 'object' ? source.headingSizes : {};
  const numbering = ['chinese', 'arabic', 'none'].includes(String(source.numbering))
    ? String(source.numbering) : DEFAULT_LAYOUT.numbering;
  return {
    pageSize: ['A4', 'Letter', 'B5'].includes(String(source.pageSize)) ? String(source.pageSize) : 'A4',
    orientation: String(source.orientation) === 'landscape' ? 'landscape' : 'portrait',
    marginTop: clampNumber(source.marginTop, 1, 6, DEFAULT_LAYOUT.marginTop),
    marginBottom: clampNumber(source.marginBottom, 1, 6, DEFAULT_LAYOUT.marginBottom),
    marginLeft: clampNumber(source.marginLeft, 1, 6, DEFAULT_LAYOUT.marginLeft),
    marginRight: clampNumber(source.marginRight, 1, 6, DEFAULT_LAYOUT.marginRight),
    bodyFont: pickFont(source.bodyFont, FONT_POOL.body, DEFAULT_LAYOUT.bodyFont),
    bodyFontEn: pickFont(source.bodyFontEn, FONT_POOL.body, DEFAULT_LAYOUT.bodyFontEn),
    bodySize: clampNumber(source.bodySize, SIZE_MIN, SIZE_MAX, DEFAULT_LAYOUT.bodySize),
    lineSpacing: clampNumber(source.lineSpacing, SPACING_MIN, SPACING_MAX, DEFAULT_LAYOUT.lineSpacing),
    paraSpacing: clampNumber(source.paraSpacing, 0, 60, DEFAULT_LAYOUT.paraSpacing),
    firstLineIndent: clampNumber(source.firstLineIndent, 0, 8, DEFAULT_LAYOUT.firstLineIndent),
    align: ['left', 'center', 'right', 'both'].includes(String(source.align))
      ? String(source.align) : DEFAULT_LAYOUT.align,
    titleSize: clampNumber(source.titleSize, SIZE_MIN, SIZE_MAX, DEFAULT_LAYOUT.titleSize),
    titleFont: pickFont(source.titleFont, FONT_POOL.heading, DEFAULT_LAYOUT.titleFont),
    headingFont: pickFont(source.headingFont, FONT_POOL.heading, DEFAULT_LAYOUT.headingFont),
    headingSizes: {
      1: clampNumber(headings['1'], SIZE_MIN, SIZE_MAX, DEFAULT_LAYOUT.headingSizes[1]),
      2: clampNumber(headings['2'], SIZE_MIN, SIZE_MAX, DEFAULT_LAYOUT.headingSizes[2]),
      3: clampNumber(headings['3'], SIZE_MIN, SIZE_MAX, DEFAULT_LAYOUT.headingSizes[3]),
    },
    headingBold: source.headingBold === undefined ? DEFAULT_LAYOUT.headingBold : !!source.headingBold,
    numbering,
    captionSize: clampNumber(source.captionSize, SIZE_MIN, SIZE_MAX, DEFAULT_LAYOUT.captionSize),
    captionAlign: ['left', 'center', 'right'].includes(String(source.captionAlign))
      ? String(source.captionAlign) : DEFAULT_LAYOUT.captionAlign,
    footerText: String(source.footerText || '').trim().slice(0, 200),
  };
}

// 编号规则 → 中文序号（一、二、三 / 1. 2. 3.）
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];

function sectionNumber(no, style = 'chinese') {
  const index = Math.max(1, Number(no) || 1);
  if (style === 'none') return '';
  if (style === 'arabic') return `${index}. `;
  const label = CN_NUM[index - 1] || String(index);
  return `${label}、`;
}

// 层级化编号：counters 是 [一级序号, 二级序号, 三级序号]。
// 中文体例「一、/（一）/1.」，阿拉伯体例「1. / 1.1 / 1.1.1」——
// 蒸馏出的目录有层级，编号就必须跟着层级走，否则二级标题也顶着「三、」，
// 导出来是一份「所有小节都是章」的假目录。
function numberPath(counters, style = 'chinese', level = 1) {
  const path = (Array.isArray(counters) ? counters : [1]).slice(0, Math.max(1, Math.min(3, level)));
  const depth = path.length;
  if (style === 'none') return '';
  const cn = (value) => CN_NUM[Math.max(1, Number(value) || 1) - 1] || String(value);
  if (style === 'arabic') return depth === 1 ? `${path[0]}. ` : `${path.join('.')} `;
  if (depth === 1) return `${cn(path[0])}、`;
  if (depth === 2) return `（${cn(path[1])}）`;
  return `${path[2]}. `;
}

const PRE_NUMBERED_RE = /^(第[一二三四五六七八九十百零\d]+[章节篇部分]|[（(]?[一二三四五六七八九十\d]+[、.．)）]|\d+(\.\d+)*[、.．\s])/;

// 章节标题加上编号前缀（「引言」→「一、引言」；二级「样本」→「（一）样本」）
function numberTitle(title, no, style = 'chinese', level = 1) {
  const prefix = level > 1 ? numberPath([no], style, level) : sectionNumber(no, style);
  if (!prefix) return String(title || '');
  const text = String(title || '').trim();
  // 已经自带编号的（作者手写了「第一章」「1.」）就不重复加
  if (PRE_NUMBERED_RE.test(text)) return text;
  return `${prefix}${text}`;
}

// 按层级路径给标题加编号（导出时用这一版：counters 由调用方逐节推进）。
function headingTitle(title, counters, style = 'chinese', level = 1) {
  const text = String(title || '').trim();
  const prefix = numberPath(counters, style, level);
  if (!prefix || PRE_NUMBERED_RE.test(text)) return text;
  return `${prefix}${text}`;
}

// 磅 → 半点（OOXML w:sz 的单位是半磅）
function toHalfPoints(points) {
  return clampInt(Number(points) * 2, SIZE_MIN * 2, SIZE_MAX * 2, 24);
}

// 厘米 → twips（1 厘米 = 566.93 twips）
function cmToTwips(cm) {
  return Math.round(clampNumber(cm, 0.5, 8, 2.54) * 566.93);
}

// 行距倍数 → OOXML w:line（240 = 单倍行距）
function lineToTwips(multiplier) {
  return clampInt(clampNumber(multiplier, SPACING_MIN, SPACING_MAX, 1.5) * 240, 120, 720, 360);
}

// 字符缩进 → firstLineChars（OOXML 单位是 1/100 字符）
function indentChars(chars) {
  return clampInt(Number(chars) * 100, 0, 800, 200);
}

// 排版规格 → 写作提示词里的一段说明。
// 光落到 Word 样式表不够：模型写「## 2.1 影响因素」还是「## 影响因素」，
// 得在生成时就按目标的编号与层级来写，否则导出来标题编号是后贴的，与正文自相矛盾。
//
// templateBound（按模板撰写）时必须换一套说法：模板的目录是既定的，
// 节标题由系统按模板统一加上。此时若还教模型「小标题用 Markdown 的 # 表达」，
// 等于同时下达「必须写标题」和「禁止写标题」两条相反指令——模型多半会挑一条执行，
// 结果就是正文里冒出一堆与模板目录重复的标题。
// 所以模板模式下只交代正文的字体字号行距缩进，标题部分明确交给系统。
function layoutPrompt(layout, { templateBound = false } = {}) {
  const spec = normalizeLayout(layout);
  const alignText = { left: '左对齐', center: '居中', right: '右对齐', both: '两端对齐' }[spec.align];
  const numberingText = {
    chinese: '一级标题用「一、二、三、」，二级用「（一）（二）」，三级用「1. 2. 3.」',
    arabic: '一级标题用「1. 2. 3.」，二级用「1.1 1.2」，三级用「1.1.1」',
    none: '标题不带编号',
  }[spec.numbering];
  const head = [
    `【排版要求】标题 ${spec.titleSize} 磅 ${spec.titleFont}；一级标题 ${spec.headingSizes[1]} 磅 ${spec.headingFont}，`
      + `二级 ${spec.headingSizes[2]} 磅，三级 ${spec.headingSizes[3]} 磅；`,
    `正文 ${spec.bodySize} 磅 ${spec.bodyFont}（西文 ${spec.bodyFontEn}），行距 ${spec.lineSpacing} 倍，`
      + `段后 ${spec.paraSpacing} 磅，首行缩进 ${spec.firstLineIndent} 字符，${alignText}；`,
  ];
  if (templateBound) {
    head.push('【标题由系统统一添加】本文档的章节目录已固定，标题、层级与编号都由系统按模板统一生成。'
      + '你只写正文：不要输出 Markdown 标题（# / ## / ###），也不要自己写「一、」「（一）」「1.1」这类小节编号，'
      + '更不要新增或改名小节。正文里需要分段时直接换段。');
    return head.join('\n');
  }
  head.push(`【标题编号】${numberingText}。`);
  head.push('小标题按上述层级用 Markdown 的 # / ## / ### 表达；不要在标题文字里自己重复写编号以外的序号。');
  head.push('本节若含下级小节，编号要与层级对应：一级节下的小节用二级编号，二级之下用三级编号，不要一律用一级编号。');
  return head.join('\n');
}

// 版式规格 → 页面上一句话能读懂的摘要（新建时选模板、工作台「版式」卡都用它）。
function layoutSummary(raw) {
  const spec = normalizeLayout(raw);
  const numberingText = {
    chinese: '编号 一、（一）1.',
    arabic: '编号 1 / 1.1 / 1.1.1',
    none: '标题不编号',
  }[spec.numbering];
  return {
    spec,
    numberingText,
    bodyLine: `正文 ${spec.bodyFont} ${spec.bodySize} 磅 · 行距 ${spec.lineSpacing} 倍 · 首行缩进 ${spec.firstLineIndent} 字符`,
    headingLine: `标题 ${spec.headingFont} ${spec.headingSizes[1]} / ${spec.headingSizes[2]} / ${spec.headingSizes[3]} 磅 · ${numberingText}`,
    titleLine: `题名 ${spec.titleFont} ${spec.titleSize} 磅`,
    pageLine: `${spec.pageSize}${spec.orientation === 'landscape' ? ' 横向' : ' 纵向'} · 页边距 上 ${spec.marginTop} / 下 ${spec.marginBottom} / 左 ${spec.marginLeft} / 右 ${spec.marginRight} cm`,
  };
}

// 排版规格 → 页面预览用的 CSS 变量
function layoutCssVars(layout) {
  const spec = normalizeLayout(layout);
  return {
    '--doc-body-font': `"${spec.bodyFont}", "${spec.bodyFontEn}", serif`,
    '--doc-body-size': `${spec.bodySize}pt`,
    '--doc-line-height': String(spec.lineSpacing),
    '--doc-para-spacing': `${spec.paraSpacing}pt`,
    '--doc-indent': `${spec.firstLineIndent}em`,
    '--doc-title-font': `"${spec.titleFont}", "${spec.bodyFontEn}", serif`,
    '--doc-title-size': `${spec.titleSize}pt`,
  };
}

module.exports = {
  DEFAULT_LAYOUT, normalizeLayout, normalizeSections, sectionNumber, numberTitle,
  numberPath, headingTitle, toHalfPoints, cmToTwips, lineToTwips, indentChars,
  layoutPrompt, layoutCssVars, layoutSummary, CN_NUM,
};
