'use strict';

// 数学符号与字体。
//
// 乱码的根因不在 XML，而在「谁负责画这个字」：
// - 正文里的希腊字母（α β Δ）、关系符（≤ ≥ ≠）、运算符（∑ ∫ ∈）如果用
//   Times New Roman / 宋体，Word 找不到字形，界面上显示成方框或替换符——
//   用户看到的「乱码」就是它。正确做法是把这些字符单独切成一段 run，
//   指定 Cambria Math（数学字体，字形覆盖完整）。
// - OMML 公式对象里的 run 同理：m:r 必须带 w:rPr 指定 Cambria Math，
//   否则 Word 用段落默认字体去画 ∑ ∫，重排时符号会掉字形。
//
// 所以这里只做一件事：把一段文本切成「普通段」和「符号段」。

// 需要数学字体的字符集（用显式码点，避免正则字符类里的字面字符被误解析）：
// 希腊字母 U+0370–03FF、字母类符号 U+2100–214F（ℝ ℕ ℤ ℂ）、
// 箭头 U+2190–21FF、数学运算符 U+2200–22FF（≤ ≥ ≠ ∑ ∫ ∈）、
// 杂项技术 U+2300–23FF、几何图形 U+25A0–25FF、补充数学 U+2A00–2AFF。
const SYMBOL_PATTERN = /[Ͱ-Ͽ℀-⅏←-⇿∀-⋿⌀-⏿■-◿⨀-⫿]/;

function isSymbolChar(ch) {
  return SYMBOL_PATTERN.test(ch);
}

// 把文本切成若干段：{ text, symbol }。symbol 为 true 的段需要用数学字体。
// 相邻同类段会合并，避免把 run 切得稀碎。
function splitSymbolSegments(text) {
  const source = String(text == null ? '' : text);
  if (!source) return [];
  const segments = [];
  let buffer = '';
  let bufferSymbol = null;
  for (const ch of source) {
    const symbol = isSymbolChar(ch);
    if (bufferSymbol === null) bufferSymbol = symbol;
    if (symbol !== bufferSymbol) {
      segments.push({ text: buffer, symbol: bufferSymbol });
      buffer = '';
      bufferSymbol = symbol;
    }
    buffer += ch;
  }
  if (buffer) segments.push({ text: buffer, symbol: bufferSymbol });
  return segments;
}

function hasSymbol(text) {
  return SYMBOL_PATTERN.test(String(text || ''));
}

module.exports = { SYMBOL_PATTERN, isSymbolChar, splitSymbolSegments, hasSymbol };
