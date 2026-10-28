'use strict';

// 文档导出为 Word（.docx）。
//
// 论文要交 Word、申报书要用单位模板、BP 要给投资人——只给 Markdown 等于没交付。
// 这里不引第三方库：OOXML 的最小合法包就是 document.xml + styles.xml + 两个 rels，
// 压缩复用 lib/zip.js 的 makeZip（与模板 zip 上传同一条路径）。
//
// 支持的 markdown 子集：标题、段落、无序/有序列表、引用、代码块、表格、**粗体**、`行内码`。
// 定位是「能直接交出去继续改的稿子」，不是像素级还原——表格有边框、标题有层级、正文首行缩进。

const { makeZip } = require('./zip');
const { splitFigureBlocks, chartPartXml } = require('./doc-figure');
const docTable = require('./doc-table');
const { splitInlineMath } = require('./doc-math');
const { toOmml } = require('./math-tex');
const { splitSymbolSegments } = require('./doc-symbols');
const layout = require('./doc-layout');

const FONT_BODY_EA = '宋体';
const FONT_HEAD_EA = '黑体';
const FONT_ASCII = 'Times New Roman';
const FONT_CODE = 'Consolas';
// 数学字体：希腊字母、∑ ∫ ≤ ≠ 这些符号在 Times New Roman / 宋体里没有字形，
// Word 会画成方框（用户说的「乱码」）。凡是数学符号一律单独切段并指定 Cambria Math。
const FONT_MATH = 'Cambria Math';

const MAX_TABLE_ROWS = 200;

// XML 1.0 不允许的控制字符（模型偶尔会吐 \u000b）会让 Word 直接报「文件已损坏」。
function xml(text) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 行内格式：**粗体** 与 `行内码`。rPr 里 rFonts 必须排在 b 之前（OOXML 子元素有序）。
// 文本还要按「是否数学符号」再切一次：β ≤ Δ 这类字符单独成 run 并指定 Cambria Math，
// 否则 Word 用正文宋体去画它们，会显示成方框——这是「公式和符号乱码」最常见的来源。
function textRuns(text, { bold = false, code = false } = {}) {
  const parts = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  let matched = null;
  while ((matched = re.exec(text))) {
    if (matched.index > last) parts.push({ text: text.slice(last, matched.index), bold, code });
    const token = matched[0];
    if (token.startsWith('**')) parts.push({ text: token.slice(2, -2), bold: true, code });
    else parts.push({ text: token.slice(1, -1), bold, code: true });
    last = matched.index + token.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), bold, code });
  return parts.flatMap((part) => splitSymbolSegments(part.text).map((segment) => ({ ...part, ...segment })))
    .map((part) => {
    const props = [];
    if (part.symbol) {
      // 数学符号段：Cambria Math 同时管 ASCII 与东亚字形，避免符号回退到宋体
      props.push(`<w:rFonts w:ascii="${FONT_MATH}" w:hAnsi="${FONT_MATH}" w:cs="${FONT_MATH}"/>`);
    } else if (part.code) {
      props.push(`<w:rFonts w:ascii="${FONT_CODE}" w:hAnsi="${FONT_CODE}" w:eastAsia="${FONT_BODY_EA}"/>`);
    }
    if (part.bold) props.push('<w:b/>');
    const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
    return `<w:r>${rPr}<w:t xml:space="preserve">${xml(part.text)}</w:t></w:r>`;
  }).join('');
}

// 公式与文字混排：$...$ 走 Word 原生公式（m:oMath），其余照旧走文本 run。
// 公式必须是真正的公式对象，不能是图片——作者要能双击改符号、能改字号跟随正文。
function inlineRuns(text, options = {}) {
  return splitInlineMath(text).map((part) => {
    if (part.type !== 'math') return textRuns(part.text, options);
    const math = toOmml(part.tex);
    // 解析不出内容就原样留着，让人看见这处没渲染，而不是悄悄消失
    if (!math) return textRuns(`$${part.tex}$$`, options);
    return `<m:oMath>${math}</m:oMath>`;
  }).join('');
}

function para(text, { style = '', align = '', bold = false } = {}) {
  const props = [];
  if (style) props.push(`<w:pStyle w:val="${style}"/>`);
  if (align) props.push(`<w:jc w:val="${align}"/>`);
  const pPr = props.length ? `<w:pPr>${props.join('')}</w:pPr>` : '';
  return `<w:p>${pPr}${inlineRuns(text, { bold })}</w:p>`;
}

function table(rows) {
  const list = rows.slice(0, MAX_TABLE_ROWS);
  const cols = Math.max(...list.map((row) => row.length), 1);
  const width = Math.floor(9000 / cols);
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`;
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="C8CDD4"/>`).join('');
  const body = list.map((cells, rowIndex) => `<w:tr>${Array.from({ length: cols }, (_, i) => {
    const cellText = cells[i] == null ? '' : String(cells[i]);
    const shade = rowIndex === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="F1F3F6"/>' : '';
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade}</w:tcPr>`
      + `<w:p><w:pPr><w:pStyle w:val="TableText"/></w:pPr>${inlineRuns(cellText, { bold: rowIndex === 0 })}</w:p></w:tc>`;
  }).join('')}</w:tr>`).join('');
  // 表格后必须跟一个空段落，否则紧接标题时 Word 会把表格和标题挤在一起。
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders>`
    + `<w:tblLayout w:type="autofit"/></w:tblPr>${grid}${body}</w:tbl><w:p/>`;
}

// markdown → 块序列（不直接出 XML：标题层级要按上下文重映射）
// 单独一行的 $$…$$ / \[…\] 识别成公式块，返回 null 表示这行不是公式块起点。
function readMathBlock(lines, start) {
  const first = lines[start].trim();
  let open = '';
  let close = '';
  if (first.startsWith('$$')) { open = '$$'; close = '$$'; }
  else if (first.startsWith('\\[')) { open = '\\['; close = '\\]'; }
  else return null;
  const rest = first.slice(open.length);
  if (rest.includes(close)) {
    const tex = rest.slice(0, rest.indexOf(close)).trim();
    return { tex: stripTag(tex).tex, tag: stripTag(tex).tag, next: start + 1 };
  }
  const buffer = [rest];
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index];
    if (line.includes(close)) {
      buffer.push(line.slice(0, line.indexOf(close)));
      index += 1;
      break;
    }
    buffer.push(line);
    index += 1;
  }
  const tex = buffer.join('\n').trim();
  const parsed = stripTag(tex);
  return { tex: parsed.tex, tag: parsed.tag, next: index };
}

function stripTag(tex) {
  const matched = /\\tag\*?\{([^}]*)\}/.exec(String(tex || ''));
  if (!matched) return { tex: String(tex || ''), tag: '' };
  return { tex: String(tex).replace(matched[0], '').trim(), tag: matched[1].trim() };
}

function markdownBlocks(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const blocks = [];
  let inCode = false;
  let codeLines = [];
  let index = 0;
  while (index < lines.length) {
    const raw = lines[index];
    const trimmed = raw.trim();
    if (/^```/.test(trimmed)) {
      if (inCode) {
        blocks.push({ type: 'code', text: codeLines.join('\n') });
        codeLines = [];
        inCode = false;
      } else {
        inCode = true;
      }
      index += 1;
      continue;
    }
    if (inCode) { codeLines.push(raw); index += 1; continue; }
    if (!trimmed) { index += 1; continue; }

    // 独立成段的公式：$$…$$（可跨行）或 \[…\]。要在段落累积之前拦下来，
    // 否则会被当成普通文字，导出后是一行美元符号。
    const mathBlock = readMathBlock(lines, index);
    if (mathBlock) {
      blocks.push({ type: 'math', tex: mathBlock.tex, tag: mathBlock.tag });
      index = mathBlock.next;
      continue;
    }

    if (/^\|/.test(trimmed)) {
      const rows = [];
      while (index < lines.length && /^\|/.test(lines[index].trim())) {
        const cells = lines[index].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
        // 分隔行（|---|---|）不进表格
        if (!cells.every((cell) => !cell || /^:?-{2,}:?$/.test(cell))) rows.push(cells);
        index += 1;
      }
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }
    if (/^[-*+]\s+/.test(trimmed)) {
      blocks.push({ type: 'bullet', text: trimmed.replace(/^[-*+]\s+/, '') });
      index += 1;
      continue;
    }
    if (/^\d+[.)、]\s*/.test(trimmed)) {
      const number = (trimmed.match(/^(\d+)/) || [])[1] || '';
      blocks.push({ type: 'bullet', text: `${number}. ${trimmed.replace(/^\d+[.)、]\s*/, '')}` });
      index += 1;
      continue;
    }
    if (/^>\s?/.test(trimmed)) {
      blocks.push({ type: 'quote', text: trimmed.replace(/^>\s?/, '') });
      index += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      index += 1;
      continue;
    }
    const buffer = [trimmed];
    index += 1;
    while (index < lines.length) {
      const next = lines[index].trim();
      if (!next) break;
      if (/^(#{1,4}\s|[-*+]\s|\d+[.)、]\s*|>\s?|\||```)/.test(next)) break;
      buffer.push(next);
      index += 1;
    }
    blocks.push({ type: 'para', text: buffer.join('') });
  }
  if (codeLines.length) blocks.push({ type: 'code', text: codeLines.join('\n') });
  return blocks;
}

function blockXml(block, { headingOffset = 1, eqNo = 0 } = {}) {
  switch (block.type) {
    case 'title':
      return para(block.text, { style: 'DocTitle', align: 'center' });
    case 'meta':
      return para(block.text, { style: 'DocMeta', align: 'center' });
    case 'toctitle':
      return para('目 录', { style: 'TocTitle', align: 'center' });
    // 目录域：Word 的 TOC 字段，目录内容由 Word 在打开时按 Heading 样式生成。
    // 用域而不是静态文本：静态目录一旦正文改动就过期，域会跟着更新，
    // 而且域里的条目直接来自 Heading1~3 的 outlineLvl——也就是模板的目录层级。
    case 'toc':
      return '<w:p><w:pPr><w:jc w:val="left"/></w:pPr>'
        + '<w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>'
        + '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>'
        + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        + '<w:r><w:t xml:space="preserve">（在 Word 中右键此处选择「更新域」生成目录）</w:t></w:r>'
        + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(block.level || 1) + headingOffset - 1));
      return para(block.text, { style: `Heading${level}` });
    }
    case 'quote':
      return para(block.text, { style: 'Quote' });
    // 正文小标题：加粗、不占 outlineLvl。模板绑定时刻意把模型自己写的 # 标题降到这里，
    // 这样它在版面上仍有层次感，但不会进 Word 的导航窗格与目录——模板的章节目录不会被改写。
    case 'subhead':
      return para(block.text, { style: 'SubHead' });
    case 'code':
      return String(block.text || '').split(/\r?\n/)
        .map((line) => para(line, { style: 'CodeBlock' })).join('') || para('', { style: 'CodeBlock' });
    case 'bullet':
      return para(`• ${block.text}`, { style: 'ListItem' });
    case 'table':
      return table(block.rows || []);
    case 'hr':
      return para('──────────', { style: 'DocMeta', align: 'center' });
    case 'figure':
      return figureXml(block.spec, block.chartIndex);
    case 'table3':
      return docTable.tableCaptionXml(block.spec);
    case 'math':
      return equationXml(block.tex, eqNo, block.tag);
    default:
      return para(block.text || '');
  }
}

// 独立公式：居中 + 右侧编号（用制表位实现，Word 里改字号不会把编号挤到下一行）。
// 版心宽度 = 页宽 11906 − 左右页边距 1418×2 = 9070 twips，居中位在 4535。
//
// 结构用「制表位 + 行内 m:oMath」而不是 m:oMathPara：
// m:oMathPara 是真正的块级公式对象，但它后面不能再挂编号 run（Word 会弹「文档需要修复」），
// 编号只能另起一行，版式就散了。Word 自己插入带编号公式时用的正是下面这种
// 「居中制表位 → 公式 → 右对齐制表位 → 编号」的结构，这里照抄。
function equationXml(tex, no, tag = '') {
  const math = toOmml(tex);
  if (!math) return para(`$$${tex}$$`);
  const label = tag || (no ? `式 ${no}` : '');
  const number = label ? `<w:r><w:tab/><w:t xml:space="preserve">（${xml(label)}）</w:t></w:r>` : '';
  return '<w:p><w:pPr>'
    + '<w:tabs><w:tab w:val="center" w:pos="4535"/><w:tab w:val="right" w:pos="9070"/></w:tabs>'
    + '<w:spacing w:before="120" w:after="120" w:line="300" w:lineRule="auto"/>'
    + '<w:ind w:firstLine="0" w:firstLineChars="0"/>'
    + '</w:pPr>'
    + `<w:r><w:tab/></w:r><m:oMath>${math}</m:oMath>${number}</w:p>`;
}

// 原生 Word 图表：矢量、可编辑、不用图片。没有图表的文档不会多出任何部件。
function figureXml(spec, chartIndex) {
  const width = 5486400;   // 15.24cm ≈ 版心宽度
  const height = 3200400;  // 8.89cm
  const drawing = `<w:p><w:pPr><w:jc w:val="center"/><w:ind w:firstLine="0" w:firstLineChars="0"/></w:pPr>`
    + '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
    + `<wp:extent cx="${width}" cy="${height}"/><wp:docPr id="${chartIndex + 1}" name="图表 ${spec.no}"/>`
    + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
    + `<c:chart r:id="rIdChart${chartIndex}"/></a:graphicData></a:graphic>`
    + '</wp:inline></w:drawing></w:r></w:p>';
  const caption = para(`图${spec.no}　${spec.title}${spec.unit ? `（单位：${spec.unit}）` : ''}`, { style: 'Caption', align: 'center' });
  const note = spec.note ? para(`资料来源：${spec.note}`, { style: 'DocMeta', align: 'center' }) : '';
  return drawing + caption + note;
}

// 样式表按排版规格生成。
// 以前这里是写死的（宋体小四、1.5 倍行距、黑体三号标题），
// 蒸馏出的版式根本没地方落——现在每一项都来自 layoutSpec。
function stylesXml(layoutSpec = null) {
  const spec = layout.normalizeLayout(layoutSpec || {});
  const bodySize = layout.toHalfPoints(spec.bodySize);
  const bodyLine = layout.lineToTwips(spec.lineSpacing);
  const bodyAfter = Math.round(spec.paraSpacing * 20);
  const indentChars = layout.indentChars(spec.firstLineIndent);
  const bodyFont = spec.bodyFont;
  const bodyFontEn = spec.bodyFontEn;
  const headFont = spec.headingFont;
  const titleSize = layout.toHalfPoints(spec.titleSize);
  const captionSize = layout.toHalfPoints(spec.captionSize);
  const bold = spec.headingBold ? '<w:b/>' : '';
  const heading = (id, name, size, before, after, outline) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>`
    + `<w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="${after}" w:line="${bodyLine}" w:lineRule="auto"/>`
    + `<w:ind w:firstLine="0" w:firstLineChars="0"/><w:outlineLvl w:val="${outline}"/></w:pPr>`
    + `<w:rPr><w:rFonts w:ascii="${bodyFontEn}" w:hAnsi="${bodyFontEn}" w:eastAsia="${headFont}"/>`
    + `${bold}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${bodyFontEn}" w:hAnsi="${bodyFontEn}" w:eastAsia="${bodyFont}" w:cs="${bodyFontEn}"/><w:sz w:val="${bodySize}"/><w:szCs w:val="${bodySize}"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="${bodyAfter}" w:line="${bodyLine}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:after="${bodyAfter}" w:line="${bodyLine}" w:lineRule="auto"/><w:jc w:val="${spec.align}"/><w:ind w:firstLineChars="${indentChars}"/></w:pPr>
<w:rPr><w:rFonts w:ascii="${bodyFontEn}" w:hAnsi="${bodyFontEn}" w:eastAsia="${bodyFont}"/><w:sz w:val="${bodySize}"/><w:szCs w:val="${bodySize}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="DocTitle"><w:name w:val="文档标题"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="240" w:after="160" w:line="${bodyLine}" w:lineRule="auto"/><w:ind w:firstLine="0" w:firstLineChars="0"/><w:jc w:val="center"/></w:pPr>
<w:rPr><w:rFonts w:ascii="${bodyFontEn}" w:hAnsi="${bodyFontEn}" w:eastAsia="${spec.titleFont}"/><w:b/><w:sz w:val="${titleSize}"/><w:szCs w:val="${titleSize}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="DocMeta"><w:name w:val="文档信息"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/><w:ind w:firstLine="0" w:firstLineChars="0"/><w:jc w:val="center"/></w:pPr>
<w:rPr><w:rFonts w:ascii="${bodyFontEn}" w:hAnsi="${bodyFontEn}" w:eastAsia="${bodyFont}"/><w:color w:val="70757D"/><w:sz w:val="${captionSize}"/><w:szCs w:val="${captionSize}"/></w:rPr></w:style>
${heading('Heading1', 'heading 1', layout.toHalfPoints(spec.headingSizes[1]), 240, 120, 0)}
${heading('Heading2', 'heading 2', layout.toHalfPoints(spec.headingSizes[2]), 200, 100, 1)}
${heading('Heading3', 'heading 3', layout.toHalfPoints(spec.headingSizes[3]), 160, 80, 2)}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="引用"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="100" w:line="${bodyLine}" w:lineRule="auto"/><w:ind w:left="480" w:firstLine="0" w:firstLineChars="0"/></w:pPr>
<w:rPr><w:rFonts w:ascii="${bodyFontEn}" w:hAnsi="${bodyFontEn}" w:eastAsia="${bodyFont}"/><w:color w:val="555B63"/><w:sz w:val="${captionSize}"/><w:szCs w:val="${captionSize}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListItem"><w:name w:val="列表"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="60" w:line="${bodyLine}" w:lineRule="auto"/><w:ind w:left="640" w:hanging="240" w:firstLine="0" w:firstLineChars="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="SubHead"><w:name w:val="正文小标题"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80" w:line="${bodyLine}" w:lineRule="auto"/><w:ind w:firstLine="0" w:firstLineChars="0"/></w:pPr>
<w:rPr><w:rFonts w:ascii="${bodyFontEn}" w:hAnsi="${bodyFontEn}" w:eastAsia="${headFont}"/><w:b/><w:sz w:val="${layout.toHalfPoints(spec.headingSizes[3])}"/><w:szCs w:val="${layout.toHalfPoints(spec.headingSizes[3])}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TocTitle"><w:name w:val="目录标题"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="160" w:line="${bodyLine}" w:lineRule="auto"/><w:ind w:firstLine="0" w:firstLineChars="0"/><w:jc w:val="center"/></w:pPr>
<w:rPr><w:rFonts w:ascii="${bodyFontEn}" w:hAnsi="${bodyFontEn}" w:eastAsia="${spec.titleFont}"/><w:b/><w:sz w:val="${titleSize}"/><w:szCs w:val="${titleSize}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="代码"/><w:basedOn w:val="Normal"/>
<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F7F9"/><w:spacing w:after="0" w:line="260" w:lineRule="auto"/><w:ind w:left="240" w:firstLine="0" w:firstLineChars="0"/></w:pPr>
<w:rPr><w:rFonts w:ascii="${FONT_CODE}" w:hAnsi="${FONT_CODE}" w:eastAsia="${bodyFont}"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="表格文字"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="0" w:line="280" w:lineRule="auto"/><w:ind w:firstLine="0" w:firstLineChars="0"/></w:pPr>
<w:rPr><w:sz w:val="${captionSize}"/><w:szCs w:val="${captionSize}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:spacing w:before="60" w:after="120" w:line="280" w:lineRule="auto"/><w:ind w:firstLine="0" w:firstLineChars="0"/><w:jc w:val="${spec.captionAlign}"/></w:pPr>
<w:rPr><w:rFonts w:ascii="${bodyFontEn}" w:hAnsi="${bodyFontEn}" w:eastAsia="${bodyFont}"/><w:sz w:val="${captionSize}"/><w:szCs w:val="${captionSize}"/></w:rPr></w:style>
</w:styles>`;
}

function documentXml(blocks, layoutSpec = null) {
  const spec = layout.normalizeLayout(layoutSpec || {});
  // 公式编号在整篇里连号：块按顺序走一遍，遇到公式块才递增。
  let eqNo = 0;
  const body = blocks.map((block) => {
    if (block.type !== 'math') return blockXml(block);
    eqNo += 1;
    return blockXml(block, { eqNo });
  }).join('');  // 页面尺寸：A4 = 11906×16838 twips，Letter = 12240×15840，B5 = 9979×14175
  const sizes = {
    A4: { w: 11906, h: 16838 },
    Letter: { w: 12240, h: 15840 },
    B5: { w: 9979, h: 14175 },
  };
  const page = sizes[spec.pageSize] || sizes.A4;
  const landscape = spec.orientation === 'landscape';
  const pgSz = landscape
    ? `<w:pgSz w:w="${page.h}" w:h="${page.w}" w:orient="landscape"/>`
    : `<w:pgSz w:w="${page.w}" w:h="${page.h}"/>`;
  const marginTop = layout.cmToTwips(spec.marginTop);
  const marginBottom = layout.cmToTwips(spec.marginBottom);
  const marginLeft = layout.cmToTwips(spec.marginLeft);
  const marginRight = layout.cmToTwips(spec.marginRight);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
<w:body>${body}<w:sectPr>${pgSz}
<w:pgMar w:top="${marginTop}" w:right="${marginRight}" w:bottom="${marginBottom}" w:left="${marginLeft}" w:header="851" w:footer="992" w:gutter="0"/>
</w:sectPr></w:body></w:document>`;
}

function contentTypesXml(chartCount = 0) {
  const chartOverrides = Array.from({ length: chartCount }, (_, index) =>
    `<Override PartName="/word/charts/chart${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
${chartOverrides}</Types>`;
}

// settings.xml：声明数学区属性（mathPr）。
// 不写这个部件时 Word 会用内置默认值，多数情况能显示；但显式声明后
// 公式区的字体（Cambria Math）与行距行为才是确定的——不同 Word 版本
// 对缺省 mathPr 的处理不一致，这正是「公式乱码/错位」在部分机器上才出现的原因。
function settingsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
<w:zoom w:percent="100"/>
<w:defaultTabStop w:val="420"/>
<w:updateFields w:val="true"/>
<w:drawingGridHorizontalSpacing w:val="105"/>
<w:drawingGridVerticalSpacing w:val="156"/>
<w:displayHorizontalDrawingGridEvery w:val="0"/>
<w:displayVerticalDrawingGridEvery w:val="2"/>
<m:mathPr>
<m:mathFont m:val="Cambria Math"/>
<m:brkBin m:val="before"/>
<m:brkBinSub m:val="--"/>
<m:smallFrac m:val="0"/>
<m:dispDef/>
<m:lMargin m:val="0"/>
<m:rMargin m:val="0"/>
<m:defJc m:val="centerGroup"/>
<m:wrapIndent m:val="1440"/>
<m:intLim m:val="subSup"/>
<m:naryLim m:val="undOvr"/>
</m:mathPr>
<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>
</w:settings>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}

function documentRelsXml(chartCount = 0) {
  const charts = Array.from({ length: chartCount }, (_, index) =>
    `<Relationship Id="rIdChart${index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="charts/chart${index + 1}.xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
${charts}</Relationships>`;
}

// 主入口：{ title, subtitle, brief, front, sections, footer, figures, tables, layout } → Buffer
// 正文里的「【图1：标题】」替换成真正的 Word 图表；「【表1：标题】」替换成三线表。
// front 是投稿首页的作者/单位/关键词等行，居中排在题名之后。
// layout 是排版规格（字体字号行距缩进编号页边距）：样式表、页面尺寸、标题编号都按它生成。
function buildDocx({ title = '未命名文档', subtitle = '', brief = '', front = [], sections = [], footer = '', figures = [], tables = [], layout: layoutSpec = null, flatHeadings = false, toc = false } = {}) {
  const spec = layout.normalizeLayout(layoutSpec || {});
  const blocks = [{ type: 'title', text: title }];
  if (subtitle) blocks.push({ type: 'meta', text: subtitle });
  for (const line of front) blocks.push({ type: 'meta', text: line });
  if (brief) blocks.push({ type: 'quote', text: brief });
  // 目录：放在正文之前。目录项来自 Heading1~3，也就是模板的目录层级——
  // Word 里打开就能看到与模板一致的导航结构。
  if (toc) {
    blocks.push({ type: 'toctitle' });
    blocks.push({ type: 'toc' });
    blocks.push({ type: 'hr' });
  }
  const used = [];
  // 章标题编号：按编号规则加前缀（「引言」→「一、引言」）。
  // 编号必须在这里加而不是让模型写——模型写的编号会与实际节序对不上。
  // 蒸馏出的目录带层级：一级「一、」、二级「（一）」、三级「1.」，Heading 也跟着层级走。
  const counters = [0, 0, 0];
  for (const section of sections) {
    const level = Math.min(3, Math.max(1, Number(section.level) || 1));
    counters[level - 1] += 1;
    for (let deeper = level; deeper < counters.length; deeper++) counters[deeper] = 0;
    const numbered = layout.headingTitle(section.title, counters, spec.numbering, level);
    blocks.push({ type: 'heading', level, text: numbered, section: true });
    const content = String(section.content || '').trim();
    if (!content) {
      blocks.push({ type: 'para', text: '（本节尚未撰写）' });
      continue;
    }
    // 表格行与图表行都要先切出来，否则 markdown 会把「【表1：…】」当成普通段落。
    // 先切表再切图：两者的占位符互不包含，但先切表能少扫一遍正文。
    for (const piece of docTable.splitTableBlocks(content, tables)) {
      if (piece.type === 'table') {
        blocks.push({ type: 'table3', spec: piece.spec });
        continue;
      }
      for (const sub of splitFigureBlocks(piece.text, figures)) {
        if (sub.type === 'figure') {
          used.push(sub.spec);
          blocks.push({ type: 'figure', spec: sub.spec, chartIndex: used.length - 1 });
          continue;
        }
        // 正文里的标题整体降一级：节标题已经是 Heading1，正文的 # 不能和它同级。
        // 层级节（二级标题）下再降一级，最深落到 Heading3（样式表只到三级）。
        // flatHeadings：模板绑定的文档，正文里的标题一律降为「正文小标题」（加粗、无 outlineLvl）——
        // 模型自作主张加的章节不能进目录，否则模板的章节目录就被改写了。
        blocks.push(...markdownBlocks(sub.text).map((block) => {
          if (block.type !== 'heading') return block;
          if (flatHeadings) return { type: 'subhead', text: block.text };
          return { ...block, level: Math.min(3, block.level + level) };
        }));
      }
    }
  }
  const footerText = footer || spec.footerText;
  if (footerText) blocks.push({ type: 'meta', text: footerText });

  const files = [
    { name: '[Content_Types].xml', data: contentTypesXml(used.length) },
    { name: '_rels/.rels', data: rootRelsXml() },
    { name: 'word/_rels/document.xml.rels', data: documentRelsXml(used.length) },
    { name: 'word/document.xml', data: documentXml(blocks, spec) },
    { name: 'word/styles.xml', data: stylesXml(spec) },
    { name: 'word/settings.xml', data: settingsXml() },
  ];
  used.forEach((specItem, index) => {
    files.push({ name: `word/charts/chart${index + 1}.xml`, data: chartPartXml(specItem) });
  });
  return makeZip(files);
}

module.exports = { buildDocx, markdownBlocks, _xml: xml };
