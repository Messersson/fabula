'use strict';

// 正文里的公式：识别、保护、渲染、编号。
//
// 三条渲染路径共用同一份识别规则，避免「页面上是公式、导出 Word 变成一行美元符号」：
// - 页面：先把 $...$ / $$...$$ 换成占位符，交给 markdown 渲染（否则公式里的 _ 和 * 会被当成斜体），
//   渲染完再把占位符换回 MathML。块级公式自带（式 N）编号。
// - Word：导出层直接按同一套规则切分，行内公式进 m:oMath，块级公式单独成段并右对齐编号。
// - Markdown：原样保留 $...$ / $$...$$（这是通用写法，GitHub、Typora、Obsidian 都认）。
//
// 编号是全文连号（式 1、式 2…），跨小节连续——论文里不会出现两个「式 1」。

const { toMathML } = require('./math-tex');

const DISPLAY_PATTERNS = [
  /\$\$([\s\S]+?)\$\$/g,
  /\\\[([\s\S]+?)\\\]/g,
];
const INLINE_PATTERNS = [
  // 行内：$ 前不能是反斜杠/字母数字，$ 后不能紧跟空白；内容里不能有 $ 和换行
  // 这样「US$100」「价格 $ 100」不会被误当成公式开头。
  /(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g,
  /\\\(([\s\S]+?)\\\)/g,
];

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// \tag{2.1} 允许作者手工指定编号（不常用，但投稿模板常有固定编号）
function extractTag(tex) {
  const matched = /\\tag\*?\{([^}]*)\}/.exec(String(tex || ''));
  if (!matched) return { tex: String(tex || ''), tag: '' };
  return { tex: String(tex).replace(matched[0], '').trim(), tag: matched[1].trim() };
}

// 把正文切成「文字 / 行内公式 / 块级公式」，并给块级公式分配编号。
// 返回的 text 里公式已经变成占位符，可以安全地过 markdown 渲染。
function protectMath(content, startNo = 1) {
  const items = [];
  let no = Math.max(1, Number(startNo) || 1);
  let text = String(content == null ? '' : content);
  // \$ 是字面美元符号，先临时藏起来，免得被当成公式定界符
  text = text.replace(/\\\$/g, '\u0000DOLLAR\u0000');

  const put = (rawTex, display) => {
    const { tex, tag } = extractTag(rawTex);
    const token = `@@MATH${items.length}@@`;
    const item = { token, tex, tag, display, no: display ? no : null };
    if (display) no += 1;
    items.push(item);
    return display ? `\n\n${token}\n\n` : token;
  };

  for (const pattern of DISPLAY_PATTERNS) {
    text = text.replace(pattern, (whole, tex) => put(tex, true));
  }
  for (const pattern of INLINE_PATTERNS) {
    text = text.replace(pattern, (whole, tex) => put(tex, false));
  }
  text = text.split('\u0000DOLLAR\u0000').join('$');
  return { text, items, nextNo: no };
}

function equationHtml(item) {
  const math = toMathML(item.tex, true);
  if (!math) return '';
  const label = item.tag || (item.no ? `式 ${item.no}` : '');
  const id = item.no ? ` id="eq-${item.no}"` : '';
  return `<div class="eq"${id}><div class="eq__body">${math}</div>`
    + (label ? `<span class="eq__no">（${escapeHtml(label)}）</span>` : '')
    + '</div>';
}

// 占位符换回真公式。块级公式要先连外层 <p> 一起替换：
// <div> 套在 <p> 里是非法嵌套，浏览器会自己拆标签，拆完编号就跑到正文外面去了。
function restoreMathHtml(html, items) {
  let out = String(html || '');
  for (const item of items || []) {
    const rendered = item.display ? equationHtml(item) : toMathML(item.tex, false);
    if (!rendered) continue;
    const token = item.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`<p>\\s*${token}\\s*</p>`, 'g'), rendered);
    out = out.split(item.token).join(rendered);
  }
  return out;
}

function countDisplay(content) {
  let count = 0;
  for (const pattern of DISPLAY_PATTERNS) {
    const matched = String(content || '').match(pattern);
    if (matched) count += matched.length;
  }
  return count;
}

// 体检用：公式数量与定界符是否成对。
// 单个 $ 没配对是最常见的坏稿子——整段会被当成公式，渲染出来一片空白。
function inspectMath(content) {
  const source = String(content || '');
  let display = 0;
  let stripped = source;
  for (const pattern of DISPLAY_PATTERNS) {
    stripped = stripped.replace(pattern, () => { display += 1; return ' '; });
  }
  const dollars = (stripped.match(/\$/g) || []).length;
  const inline = (stripped.match(/(?<![\\$\w])\$(?!\s)[^$\n]+?(?<!\s)\$(?![\w$])/g) || []).length;
  const doubleUnclosed = (source.match(/\$\$/g) || []).length % 2 === 1;
  // 成对的行内公式先摘掉；剩下的 $ 里，紧跟在字母数字后或紧跟数字的是货币符号（US$100），不算定界符。
  // 这样「$x + y 忘了收尾」会被抓出来，「价格 US$100」不会误报。
  const loose = stripped.replace(/(?<![\\$\w])\$(?!\s)[^$\n]+?(?<!\s)\$(?![\w$])/g, ' ');
  const stray = (loose.match(/(?<![\w$])\$(?!\d)/g) || []).length;
  return {
    display,
    inline,
    total: display + inline,
    unbalanced: stray % 2 === 1 || doubleUnclosed,
  };
}

// Word 用：把一段文字切成「文字 / 行内公式 / 块级公式」。
// 块级公式一般单独成行（由导出层识别），但作者写成「其中 $$x$$ 成立」时也要能正确处理。
function splitInlineMath(text) {
  const source = String(text == null ? '' : text);
  const stash = [];
  let rest = source.replace(/\\\$/g, '\u0000DOLLAR\u0000');
  const mark = (rawTex, display) => {
    const { tex, tag } = extractTag(rawTex);
    const index = stash.push({ tex, tag, display }) - 1;
    return `\u0001${index}\u0001`;
  };
  for (const pattern of DISPLAY_PATTERNS) {
    rest = rest.replace(pattern, (whole, tex) => mark(tex, true));
  }
  // 这里必须新建正则：模块级的 /g 正则带 lastIndex，被 exec 循环用过一次后会残留状态。
  rest = rest.replace(/(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g, (whole, tex) => mark(tex, false));
  rest = rest.replace(/\\\(([\s\S]+?)\\\)/g, (whole, tex) => mark(tex, false));

  const parts = [];
  let last = 0;
  const re = /\u0001(\d+)\u0001/g;
  let matched = null;
  while ((matched = re.exec(rest))) {
    if (matched.index > last) parts.push({ type: 'text', text: rest.slice(last, matched.index) });
    const item = stash[Number(matched[1])];
    if (item) parts.push({ type: 'math', tex: item.tex, tag: item.tag, display: item.display });
    last = matched.index + matched[0].length;
  }
  if (last < rest.length) parts.push({ type: 'text', text: rest.slice(last) });
  return parts.map((part) => (part.type === 'text'
    ? { type: 'text', text: part.text.split('\u0000DOLLAR\u0000').join('$') }
    : part));
}

module.exports = {
  protectMath, restoreMathHtml, equationHtml, countDisplay, inspectMath,
  splitInlineMath, extractTag, escapeHtml,
};
