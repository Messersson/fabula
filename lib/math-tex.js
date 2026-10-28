'use strict';

// LaTeX 公式 → MathML（页面）/ OMML（Word）。
//
// 论文里没有公式不成立，但公式不能靠第三方库：本项目零依赖，页面的 HTML 是服务端直渲染的。
// 所以这里自己写一个够用的 LaTeX 子集解析器，产出两棵渲染树：
// - MathML：现代浏览器（Chrome 109+ / Edge / Safari / Firefox）原生渲染，不需要 JS、不需要字体文件
// - OMML：Word 原生公式对象，能选中、能编辑、能转 PDF，不是图片
//
// 支持的子集（覆盖论文里绝大多数写法）：
//   上下标 ^{} _{}、分式 \frac、根式 \sqrt[n]{}、求和求积积分 \sum \prod \int（带上下限）、
//   希腊字母、常用运算符与关系符、\text \mathrm \mathbf \mathbb、\left(...\right)、
//   矩阵与对齐环境 \begin{matrix|pmatrix|bmatrix|cases|aligned}、重音 \bar \hat \vec \dot、
//   \lim_{x\to0} 这类带下限的函数、间距 \, \; \quad、换行 \\ 与对齐 &。
//
// 不支持的写法（\newcommand、\cite、\ref 等）不会让整条公式炸掉：未知命令按正体文字呈现，
// 作者能一眼看到哪里没渲染对，而不是整段变成空白。

const SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς',
  tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
  Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', bullet: '•',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡',
  propto: '∝', sim: '∼', simeq: '≃', cong: '≅', ll: '≪', gg: '≫', perp: '⊥', parallel: '∥',
  infty: '∞', partial: '∂', nabla: '∇', emptyset: '∅', varnothing: '∅',
  rightarrow: '→', to: '→', leftarrow: '←', gets: '←', Rightarrow: '⇒', Leftarrow: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦', uparrow: '↑', downarrow: '↓',
  cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖', forall: '∀', exists: '∃', nexists: '∄',
  angle: '∠', circ: '∘', degree: '°', prime: '′', therefore: '∴', because: '∵',
  oplus: '⊕', otimes: '⊗', odot: '⊙', neg: '¬', land: '∧', lor: '∨',
  langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋',
  // 论文里高频、但之前缺失的一批：缺了就会退化成「top」「mid」「lesssim」这种正体字母，
  // 在 Word 里就是用户说的「数学符号乱码」。
  top: '⊤', bot: '⊥', mid: '∣', vert: '|', Vert: '‖', nmid: '∤', nparallel: '∦',
  lvert: '|', rvert: '|', lVert: '‖', rVert: '‖',
  ni: '∋', owns: '∋', backslash: '∖', smallsetminus: '∖',
  lesssim: '≲', gtrsim: '≳', lessgtr: '≶', gtrless: '≷', leqslant: '⩽', geqslant: '⩾',
  lneq: '⪇', gneq: '⪈', nleq: '≰', ngeq: '≱', nless: '≮', ngtr: '≯',
  prec: '≺', succ: '≻', preceq: '⪯', succeq: '⪰', precsim: '≾', succsim: '≿',
  sqsubset: '⊏', sqsupset: '⊐', sqsubseteq: '⊑', sqsupseteq: '⊒',
  sqcup: '⊔', sqcap: '⊓', uplus: '⊎', amalg: '⨿', wr: '≀',
  vdash: '⊢', dashv: '⊣', models: '⊨', vDash: '⊨', Vdash: '⊩',
  ll: '≪', gg: '≫', lll: '⋘', ggg: '⋙', asymp: '≍', doteq: '≐', fallingdotseq: '≒',
  triangle: '△', triangleleft: '◁', triangleright: '▷', blacktriangle: '▲',
  blacktriangledown: '▼', bigtriangleup: '△', bigtriangledown: '▽',
  square: '□', Box: '□', blacksquare: '■', lozenge: '◊', blacklozenge: '◆',
  diamond: '⋄', bigstar: '★', star2: '☆', clubsuit: '♣', diamondsuit: '♢',
  heartsuit: '♡', spadesuit: '♠', checkmark: '✓', maltese: '✠',
  dagger: '†', ddagger: '‡', S: '§', P: '¶', copyright: '©', pounds: '£', euro: '€',
  hbar: 'ℏ', hslash: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', beth: 'ℶ',
  gimel: 'ℷ', daleth: 'ℸ', wp: '℘', imath: 'ı', jmath: 'ȷ', mho: '℧', eth: 'ð',
  ldotp: '⋅', cdotp: '⋅', colon: ':', ratio: '∶', mathcolon: ':',
  bigcirc: '◯', circ2: '∘', ominus: '⊖', oslash: '⊘', boxplus: '⊞', boxminus: '⊟',
  boxdot: '⊡', boxtimes: '⊠', divideontimes: '⋇', ltimes: '⋉', rtimes: '⋊',
  curlyvee: '⋎', curlywedge: '⋏', veebar: '⊻', barwedge: '⊼', Cap: '⋒', Cup: '⋓',
  intercal: '⊺', smallint: '∫', iota2: 'ι', dotplus: '∔', centerdot: '·',
  circledR: '®', circledS: 'Ⓢ', angle2: '∠', measuredangle: '∡', sphericalangle: '∢',
  leftleftarrows: '⇇', rightrightarrows: '⇉', upuparrows: '⇈', downdownarrows: '⇊',
  hookrightarrow: '↪', hookleftarrow: '↩', longrightarrow: '⟶', longleftarrow: '⟵',
  Longrightarrow: '⟹', Longleftarrow: '⟸', longleftrightarrow: '⟷', Longleftrightarrow: '⟺',
  nearrow: '↗', searrow: '↘', swarrow: '↙', nwarrow: '↖', rightsquigarrow: '⇝',
  leadsto: '⇝', rightleftharpoons: '⇌', leftrightharpoons: '⇋',
};

// 大型运算符：带上下限时渲染成上下结构（∑ 的上下限在符号正上下方）
const NARY = {
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂', bigvee: '⋁', bigwedge: '⋀',
};

// 带标注的箭头：\xrightarrow[below]{above}
const XARROW = {
  xrightarrow: '→', xleftarrow: '←', xRightarrow: '⇒', xLeftarrow: '⇐',
  xleftrightarrow: '↔', xLeftrightarrow: '⇔', xhookrightarrow: '↪', xhookleftarrow: '↩',
  xmapsto: '↦', xlongrightarrow: '⟶', xlongleftarrow: '⟵',
  xrightharpoonup: '⇀', xleftharpoonup: '↼', xrightleftharpoons: '⇌',
};

// 希腊字母是变量，不是运算符：按 <mo> 渲染会被 MathML 当成运算符加上前后间距，
// 「ΔV」就会变成「Δ V」。这里单独标出来，渲染成 <mi>。
const GREEK = new Set([
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta',
  'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'varpi', 'rho', 'varrho',
  'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
]);

// 正体函数名。前几个的上下标写在正下方（lim_{x→0}），其余按普通上下标处理。
const FUNCS = new Set([
  'lim', 'max', 'min', 'sup', 'inf', 'arg', 'det', 'dim', 'gcd', 'hom', 'ker', 'deg', 'Pr',
  'log', 'ln', 'lg', 'exp', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'mod', 'bmod',
]);
const LIMIT_FUNCS = new Set(['lim', 'max', 'min', 'sup', 'inf', 'arg', 'det', 'gcd', 'Pr']);

// 重音符。MathML 用组合字符（浏览器渲染正常）；
// Word 的 OMML 对组合字符渲染不稳（显示为空白或豆腐块），
// 所以 OMML 侧把 \bar 转成 m:bar、\vec 转成箭头字符，见 ommlOf。
const ACCENTS = {
  bar: '\u0304', hat: '\u0302', tilde: '\u0303', vec: '\u20D7',
  dot: '\u0307', ddot: '\u0308', check: '\u030C', acute: '\u0301', grave: '\u0300', breve: '\u0306',
  widehat: '\u0302', widecheck: '\u030C', widetilde: '\u0303',
  overrightarrow: '\u20D7', overleftarrow: '\u20D6', overleftrightarrow: '\u20E1',
  underrightarrow: '\u20D7', underleftarrow: '\u20D6',
};

const SPACES = { ',': '0.17em', ':': '0.22em', ';': '0.28em', '!': '-0.17em', ' ': '0.25em', quad: '1em', qquad: '2em', enspace: '0.5em' };

const BLACKBOARD = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', E: '𝔼', P: 'ℙ', F: '𝔽' };

// \not 后面跟的符号：逐个给出「否定形式」，而不是靠组合斜线 U+0338。
// Word 的 Cambria Math 对组合斜线的支持不稳（经常画不出来），所以能查表就查表。
const NOT_MAP = {
  '=': '≠', '<': '≮', '>': '≯', '≡': '≢', '≈': '≉', '∼': '≁', '≤': '≰', '≥': '≱',
  '∈': '∉', '∋': '∌', '⊂': '⊄', '⊃': '⊅', '⊆': '⊈', '⊇': '⊉',
  '∣': '∤', '∥': '∦', '∃': '∄', '⊢': '⊬', '⊨': '⊭', '≺': '⊀', '≻': '⊁',
  '≼': '⋠', '≽': '⋡', '⊑': '⋢', '⊒': '⋣',
};

// \mathcal \mathfrak \mathsf \mathtt \mathbb：不换字符，只换字体变体。
// 直接映射到 Unicode 数学字母数字区会有空洞（\mathcal{B} 是 ℬ 而不是 U+1D49D），
// 而且 Word 对补充平面字符的字形支持不齐，所以交给渲染层用 variant 表达。
const TEXT_VARIANTS = {
  mathcal: 'script', mathscr: 'script', mathfrak: 'fraktur',
  mathsf: 'sans', mathtt: 'mono', mathbb: 'double', mathit2: 'italic',
};

// OMML 的 m:scr 取值
const OMML_SCR = { script: 'script', fraktur: 'fraktur', sans: 'sans-serif', mono: 'monospace', double: 'double-struck' };

// 只影响排版、不产生符号的命令
const IGNORED = new Set([
  'displaystyle', 'textstyle', 'scriptstyle', 'limits', 'nolimits', 'nonumber', 'notag',
  'label', 'tag*', 'mathstrut', 'strut', 'relax', 'big', 'Big', 'bigg', 'Bigg',
  'bigl', 'bigr', 'Bigl', 'Bigr', 'left.', 'right.',
  'vspace', 'smallskip', 'medskip', 'bigskip', 'noindent', 'hfill', 'allowbreak',
  'hline', 'noalign', 'phantom', 'hphantom', 'vphantom', 'smash', 'centering',
  'protect', 'ensuremath', 'mathop', 'mathbin', 'mathrel', 'mathord', 'mathopen',
  'mathclose', 'mathpunct', 'mathinner', 'pmod', 'bmod2', 'substack2',
]);

const DELIMS = {
  '(': '(', ')': ')', '[': '[', ']': ']', '{': '{', '}': '}', '|': '|',
  '\\{': '{', '\\}': '}', '\\|': '‖', '\\langle': '⟨', '\\rangle': '⟩',
  '\\lceil': '⌈', '\\rceil': '⌉', '\\lfloor': '⌊', '\\rfloor': '⌋', '.': '',
};

const MATRIX_ENVS = {
  matrix: ['', ''], smallmatrix: ['', ''],
  pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'],
  vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'],
  cases: ['{', ''], dcases: ['{', ''],
  aligned: ['', ''], align: ['', ''], split: ['', ''], gathered: ['', ''], array: ['', ''],
  equation: ['', ''], 'equation*': ['', ''], displaymath: ['', ''],
};

// ---------- 词法 ----------

function tokenize(src) {
  const s = String(src == null ? '' : src);
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j++;
      tokens.push({ t: 'ws', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '\\') {
      const word = /^[a-zA-Z]+/.exec(s.slice(i + 1));
      if (word) {
        tokens.push({ t: 'cmd', v: word[0] });
        i += 1 + word[0].length;
        continue;
      }
      tokens.push({ t: 'cmd', v: s[i + 1] == null ? '' : s[i + 1] });
      i += 2;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === '^' || ch === '_' || ch === '&') {
      tokens.push({ t: ch, v: ch });
      i += 1;
      continue;
    }
    const num = /^\d+(?:\.\d+)?/.exec(s.slice(i));
    if (num) {
      tokens.push({ t: 'num', v: num[0] });
      i += num[0].length;
      continue;
    }
    if (/[a-zA-Z]/.test(ch)) {
      tokens.push({ t: 'id', v: ch });
      i += 1;
      continue;
    }
    tokens.push({ t: 'op', v: ch });
    i += 1;
  }
  return tokens;
}

function tokenKey(tk) {
  if (!tk) return '';
  return tk.t === 'cmd' ? `cmd:${tk.v}` : tk.v;
}

// 换行命令 \\ 在词法里是一条反斜杠（s[i+1]），键名必须与之一致：
// 写成 'cmd:\\\\'（两条反斜杠）会让矩阵与 cases 永远匹配不到行分隔，整块被并成一行。
const CMD_ROW_BREAK = 'cmd:\\';

// ---------- 语法 ----------

function parse(src) {
  const tokens = tokenize(src);
  let pos = 0;
  const emptyRow = () => ({ type: 'row', items: [] });

  const skipWs = () => { while (pos < tokens.length && tokens[pos].t === 'ws') pos += 1; };

  function readRawGroup() {
    skipWs();
    const tk = tokens[pos];
    if (!tk) return '';
    if (tk.t !== '{') { pos += 1; return tk.t === 'cmd' ? tk.v : (tk.v || ''); }
    pos += 1;
    let depth = 1;
    let out = '';
    while (pos < tokens.length) {
      const cur = tokens[pos];
      if (cur.t === '{') depth += 1;
      if (cur.t === '}') {
        depth -= 1;
        if (!depth) { pos += 1; break; }
      }
      out += cur.t === 'cmd' ? rawOfCommand(cur.v) : (cur.v || '');
      pos += 1;
    }
    return out;
  }

  function rawOfCommand(name) {
    if (SYMBOLS[name]) return SYMBOLS[name];
    if (SPACES[name]) return ' ';
    if (name === '{' || name === '}' || name === '%' || name === '&' || name === '#' || name === '_' || name === '$') return name;
    return name;
  }

  // 读一个长度（\hspace{1em}、\kern2pt）：只接受「数字+单位」，别的当没写。
  // 直接信任输入会把 \hspace{\linewidth} 这类东西变成 CSS 注入面。
  const LENGTH_RE = /^-?\d*\.?\d+\s*(em|ex|pt|pc|mm|cm|in|px|mu|%)?$/;
  function readLength() {
    skipWs();
    const tk = tokens[pos];
    if (!tk) return '';
    if (tk.t === '{') {
      pos += 1;
      let raw = '';
      while (pos < tokens.length && tokens[pos].t !== '}') {
        raw += tokens[pos].t === 'cmd' ? ' ' : (tokens[pos].v || '');
        pos += 1;
      }
      if (tokens[pos] && tokens[pos].t === '}') pos += 1;
      return LENGTH_RE.test(raw.trim()) ? raw.trim() : '';
    }
    if (tk.t === 'num') {
      pos += 1;
      let unit = '';
      while (pos < tokens.length && tokens[pos].t === 'id') { unit += tokens[pos].v; pos += 1; }
      const text = tk.v + unit;
      return LENGTH_RE.test(text) ? text : '';
    }
    return '';
  }

  function readDelim() {
    skipWs();
    const tk = tokens[pos];
    if (!tk) return '';
    pos += 1;
    if (tk.t === 'cmd') return DELIMS[tk.v] != null ? DELIMS[tk.v] : (SYMBOLS[tk.v] || '');
    if (tk.t === 'op' || tk.t === '{' || tk.t === '}') return DELIMS[tk.v] != null ? DELIMS[tk.v] : tk.v;
    return tk.v || '';
  }

  // 中缀分式：a \over b、a \atop b、{n \choose k}。
  // 这三个不是前缀命令，语义是「把本层 row 从中间切开」，所以必须在 row 层处理。
  const INFIX_FRAC = { over: '', atop: 'atop', choose: 'choose' };

  function parseRow(stops) {
    const items = [];
    let overAt = -1;
    let overKind = '';
    for (;;) {
      skipWs();
      const tk = tokens[pos];
      if (!tk) break;
      if (stops && stops.has(tokenKey(tk))) break;
      if (tk.t === '&') { pos += 1; items.push({ type: 'space', w: '1.5em' }); continue; }
      if (tk.t === 'cmd' && tk.v === '\\') { pos += 1; items.push({ type: 'linebreak' }); continue; }
      if (tk.t === 'cmd' && (tk.v === 'right' || tk.v === 'end')) break;
      if (tk.t === 'cmd' && INFIX_FRAC[tk.v] != null) {
        // 只认第一个中缀命令，后面的按普通文字处理，避免 a\over b\over c 无限嵌套
        if (overAt < 0) { overAt = items.length; overKind = tk.v; pos += 1; continue; }
        pos += 1;
        continue;
      }
      const before = pos;
      const atom = parseScripts(stops);
      if (atom) items.push(atom);
      if (pos === before) pos += 1; // 兜底：任何分支都必须前进，否则会死循环
    }
    if (overAt >= 0) {
      const num = { type: 'row', items: items.slice(0, overAt) };
      const den = { type: 'row', items: items.slice(overAt) };
      const frac = { type: 'frac', num, den, noLine: overKind !== 'over' };
      if (overKind === 'choose') return { type: 'fenced', open: '(', close: ')', body: frac };
      return frac;
    }
    return { type: 'row', items };
  }

  function readArg(stops) {
    skipWs();
    const tk = tokens[pos];
    if (!tk) return emptyRow();
    if (tk.t === '{') {
      pos += 1;
      const row = parseRow(new Set(['}']));
      if (tokens[pos] && tokens[pos].t === '}') pos += 1;
      return row;
    }
    const atom = parseAtom(stops);
    return atom ? { type: 'row', items: [atom] } : emptyRow();
  }

  function parseScripts(stops) {
    const base = parseAtom(stops);
    if (!base) return null;
    let sub = null;
    let sup = null;
    for (;;) {
      skipWs();
      const tk = tokens[pos];
      if (!tk) break;
      if (tk.t === '^') { pos += 1; sup = readArg(stops); continue; }
      if (tk.t === '_') { pos += 1; sub = readArg(stops); continue; }
      break;
    }
    if (sub && sup) return { type: 'subsup', base, sub, sup };
    if (sub) return { type: 'sub', base, sub };
    if (sup) return { type: 'sup', base, sup };
    return base;
  }

  // 单行环境：这些环境只是「把内容包起来」，不该渲染成一张单格表格。
  // 之前 equation / gather 会被当成 matrix，Word 里就出现一个看不见边框的空表格，
  // 公式被挤在格子中间——这也是「转 Word 后公式位置怪」的来源之一。
  const SINGLE_ROW_ENVS = new Set([
    'equation', 'equation*', 'displaymath', 'gathered', 'gather', 'gather*',
    'multline', 'multline*', 'split', 'aligned', 'align', 'align*',
  ]);

  function cellHasContent(cell) {
    if (!cell) return false;
    if (cell.type === 'row') return cell.items.length > 0;
    return true;
  }

  function parseEnv(name) {
    const shape = MATRIX_ENVS[name] || ['', ''];
    // array/tabular 的列格式（{cc}、{lcr}、{|c|c|}）是排版声明，不是内容
    if (/^(array|tabular|tabularx|alignedat|alignat)$/.test(name)) readRawGroup();
    const rows = [];
    let cells = [];
    for (;;) {
      const cell = parseRow(new Set(['&', CMD_ROW_BREAK, 'cmd:end']));
      cells.push(cell);
      const tk = tokens[pos];
      if (!tk) break;
      if (tk.t === '&') { pos += 1; continue; }
      if (tk.t === 'cmd' && tk.v === '\\') { pos += 1; rows.push(cells); cells = []; continue; }
      if (tk.t === 'cmd' && tk.v === 'end') { pos += 1; readRawGroup(); break; }
      break;
    }
    if (cells.some(cellHasContent)) rows.push(cells);
    // 单行单列：直接返回内容本身（equation 不该长成表格）
    if (rows.length === 1 && rows[0].length === 1 && SINGLE_ROW_ENVS.has(name)) return rows[0][0];
    return { type: 'matrix', rows, open: shape[0], close: shape[1] };
  }

  function parseAtom(stops) {
    skipWs();
    const tk = tokens[pos];
    if (!tk) return null;
    if (tk.t === '{') {
      pos += 1;
      const row = parseRow(new Set(['}']));
      if (tokens[pos] && tokens[pos].t === '}') pos += 1;
      return row;
    }
    if (tk.t === 'num') { pos += 1; return { type: 'num', v: tk.v }; }
    if (tk.t === 'id') { pos += 1; return { type: 'id', v: tk.v }; }
    if (tk.t === 'op') { pos += 1; return { type: 'op', v: tk.v }; }
    if (tk.t === 'cmd') return parseCommand(tk.v);
    pos += 1;
    return null;
  }

  function parseCommand(name) {
    pos += 1; // 吃掉命令本身
    if (IGNORED.has(name)) return null;
    if (name === '{' || name === '}' || name === '%' || name === '&' || name === '#' || name === '_' || name === '$') {
      return { type: 'op', v: name };
    }
    // \| 在词法里是「一条反斜杠 + 一个竖线」，命令名就是 '|' 本身（不是字母命令）。
    // 漏掉它，\|x\|_2 这种范数写法就会吐成 "|x|" + 一个字面量命令名。
    if (name === '|') return { type: 'op', v: '‖' };
    if (SPACES[name] != null) return { type: 'space', w: SPACES[name] };
    if (name === '\\') return { type: 'linebreak' };
    if (NARY[name]) return { type: 'nary', chr: NARY[name] };
    if (FUNCS.has(name)) return { type: 'func', v: name };
    if (GREEK.has(name)) return { type: 'id', v: SYMBOLS[name] };
    if (SYMBOLS[name]) return { type: 'op', v: SYMBOLS[name] };
    if (ACCENTS[name]) return { type: 'accent', chr: ACCENTS[name], body: readArg() };

    // ---------- 以下是一批「论文里常见、以前会退化成正体字母」的命令 ----------
    // 共同点：都要先吃掉自己的参数，再产出结构节点；漏掉任何一个，
    // Word 里就会出现 "oversetdef="、"mathcalL" 这种字面量，也就是用户看到的乱码。
    if (name === 'tag' || name === 'tag*') { readRawGroup(); return null; }
    if (TEXT_VARIANTS[name]) return { type: 'text', v: readRawGroup(), style: TEXT_VARIANTS[name] };
    if (name === 'not') {
      skipWs();
      const tk = tokens[pos];
      if (!tk) return null;
      pos += 1;
      const sym = tk.t === 'cmd' ? (SYMBOLS[tk.v] || '') : (tk.v || '');
      const negated = NOT_MAP[sym] || (sym ? `${sym}\u0338` : '');
      return negated ? { type: 'op', v: negated } : null;
    }
    if (name === 'overset' || name === 'underset' || name === 'stackrel') {
      const mark = readArg();
      const base = readArg();
      return { type: 'stack', over: name === 'underset' ? null : mark, under: name === 'underset' ? mark : null, base };
    }
    if (XARROW[name]) {
      let below = null;
      skipWs();
      if (tokens[pos] && tokens[pos].t === 'op' && tokens[pos].v === '[') {
        pos += 1;
        below = parseRow(new Set([']']));
        if (tokens[pos] && tokens[pos].t === 'op' && tokens[pos].v === ']') pos += 1;
      }
      return { type: 'xarrow', chr: XARROW[name], above: readArg(), below };
    }
    if (name === 'overbrace' || name === 'underbrace') {
      const top = name === 'overbrace';
      return { type: 'brace', chr: top ? '\u23DE' : '\u23DF', top, body: readArg() };
    }
    if (name === 'boxed' || name === 'fbox') return { type: 'box', body: readArg() };
    if (name === 'substack') {
      // 参数是用 \\ 分行的一叠小行，渲染成单列堆叠（\sum_{\substack{i=1\\j=1}} 的写法）
      const rows = [];
      skipWs();
      if (tokens[pos] && tokens[pos].t === '{') {
        pos += 1;
        for (;;) {
          rows.push([parseRow(new Set(['}', CMD_ROW_BREAK]))]);
          const tk = tokens[pos];
          if (!tk) break;
          if (tk.t === 'cmd' && tk.v === '\\') { pos += 1; continue; }
          if (tk.t === '}') { pos += 1; break; }
          break;
        }
      }
      return { type: 'matrix', rows, open: '', close: '', stack: true };
    }
    if (name === 'hspace' || name === 'hskip' || name === 'kern' || name === 'mkern' || name === 'mskip') {
      const len = readLength();
      return { type: 'space', w: len || '0.5em' };
    }
    if (name === 'color') { readRawGroup(); return null; }
    if (name === 'textcolor' || name === 'colorbox') { readRawGroup(); return readArg(); }
    if (name === 'middle') return { type: 'op', v: readDelim(), stretchy: true };

    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': case 'cfrac':
        return { type: 'frac', num: readArg(), den: readArg() };
      case 'binom':
        return { type: 'fenced', open: '(', close: ')', body: { type: 'frac', num: readArg(), den: readArg(), noLine: true } };
      case 'sqrt': {
        let index = null;
        skipWs();
        if (tokens[pos] && tokens[pos].t === 'op' && tokens[pos].v === '[') {
          pos += 1;
          index = parseRow(new Set([']']));
          if (tokens[pos] && tokens[pos].t === 'op' && tokens[pos].v === ']') pos += 1;
        }
        return { type: 'sqrt', index, body: readArg() };
      }
      case 'text': case 'textrm': case 'mbox': case 'textnormal':
        return { type: 'text', v: readRawGroup(), style: 'normal' };
      case 'textbf':
        return { type: 'text', v: readRawGroup(), style: 'bold' };
      case 'textit': case 'mathit':
        return { type: 'text', v: readRawGroup(), style: 'italic' };
      case 'mathrm': case 'rm':
        return { type: 'text', v: readRawGroup(), style: 'normal' };
      case 'operatorname': {
        // \operatorname*{arg min}_\theta：星号表示下标写在正下方
        skipWs();
        let limits = false;
        if (tokens[pos] && tokens[pos].t === 'op' && tokens[pos].v === '*') { limits = true; pos += 1; }
        return { type: 'func', v: readRawGroup(), limits };
      }
      case 'mathbf': case 'bm': case 'boldsymbol':
        return { type: 'text', v: readRawGroup(), style: 'bold' };
      case 'mathbb': {
        const raw = readRawGroup();
        return { type: 'text', v: [...raw].map((ch) => BLACKBOARD[ch] || ch).join(''), style: 'normal' };
      }
      case 'overline':
        return { type: 'accent', chr: '\u0304', body: readArg(), bar: 'top' };
      case 'underline':
        return { type: 'accent', chr: '\u0332', body: readArg(), bar: 'bottom' };
      case 'left': {
        const open = readDelim();
        const body = parseRow(new Set(['cmd:right']));
        let close = '';
        if (tokens[pos] && tokens[pos].t === 'cmd' && tokens[pos].v === 'right') { pos += 1; close = readDelim(); }
        return { type: 'fenced', open, close, body };
      }
      case 'right':
        return null; // 没有配对的 \left：忽略
      case 'begin': {
        const env = readRawGroup().trim();
        return parseEnv(env);
      }
      case 'end':
        readRawGroup();
        return null;
      default:
        // 未知命令：按正体文字显示，作者能看见哪里没渲染对，不会整段空白。
        // 同时记进 root.unknown，体检时能报出「这条公式有 2 个命令没渲染」，
        // 而不是让用户自己盯着 Word 里的 "mathcalL" 猜哪里坏了。
        unknown.push(name);
        return { type: 'text', v: name, style: 'normal' };
    }
  }

  const unknown = [];
  const root = parseRow(new Set());
  root.unknown = unknown;
  return root;
}

// ---------- MathML ----------

function escapeXml(text) {
  // XML 1.0 不允许控制字符（模型偶尔会吐 \u000b），留着会让 Word 报「文件已损坏」。
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 函数名后面直接跟变量时（\ln v），要补一个「函数应用符」占位，否则渲染成 lnv 挤在一起。
// 只在行内相邻时补：函数带上下标时（\log_2 x）下标已经把它和后面隔开了，再补就多出空隙。
// 带上下标的变量（v_t）在语法树里是 sub/sup 节点，同样要算作函数参数。
const FUNC_ARG_TYPES = new Set([
  'id', 'num', 'row', 'frac', 'sqrt', 'fenced', 'matrix', 'nary', 'text',
  'sub', 'sup', 'subsup', 'accent', 'stack', 'xarrow', 'brace', 'box',
]);

const MATHML_VARIANT = {
  normal: '', bold: 'bold', italic: 'italic', script: 'script', fraktur: 'fraktur',
  sans: 'sans-serif', mono: 'monospace', double: 'double-struck',
};

function mathmlOf(node) {
  if (!node) return '';
  switch (node.type) {
    case 'row': {
      if (!node.items.length) return '';
      const parts = [];
      node.items.forEach((item, index) => {
        parts.push(mathmlOf(item));
        if (item.type === 'func' && FUNC_ARG_TYPES.has((node.items[index + 1] || {}).type)) {
          parts.push('<mo>&#x2061;</mo>');
        }
      });
      return `<mrow>${parts.join('')}</mrow>`;
    }
    case 'id': return `<mi>${escapeXml(node.v)}</mi>`;
    case 'num': return `<mn>${escapeXml(node.v)}</mn>`;
    case 'op': return `<mo${node.stretchy ? ' stretchy="true"' : ''}>${escapeXml(node.v)}</mo>`;
    case 'func': return `<mi mathvariant="normal">${escapeXml(node.v)}</mi>`;
    case 'text': {
      const variant = MATHML_VARIANT[node.style || 'normal'];
      if (!variant) return `<mtext>${escapeXml(node.v)}</mtext>`;
      // 数学字母变体（花体、哥特体、双线体）要挂在 <mi> 上才会被浏览器按数学字体渲染；
      // 挂在 <mtext> 上只会得到一个「斜体都没了」的普通文本。
      if (['script', 'fraktur', 'sans-serif', 'monospace', 'double-struck'].includes(variant)) {
        return `<mi mathvariant="${variant}">${escapeXml(node.v)}</mi>`;
      }
      return `<mtext mathvariant="${variant}">${escapeXml(node.v)}</mtext>`;
    }
    case 'space': return `<mspace width="${node.w}"/>`;
    case 'linebreak': return '<mspace linebreak="newline"/>';
    case 'frac':
      return `<mfrac${node.noLine ? ' linethickness="0"' : ''}><mrow>${mathmlOf(node.num)}</mrow><mrow>${mathmlOf(node.den)}</mrow></mfrac>`;
    case 'sqrt':
      return node.index
        ? `<mroot><mrow>${mathmlOf(node.body)}</mrow><mrow>${mathmlOf(node.index)}</mrow></mroot>`
        : `<msqrt><mrow>${mathmlOf(node.body)}</mrow></msqrt>`;
    case 'sup':
      return withLimits(node.base, 'sup', null, node.sup);
    case 'sub':
      return withLimits(node.base, 'sub', node.sub, null);
    case 'subsup':
      return withLimits(node.base, 'subsup', node.sub, node.sup);
    case 'accent':
      if (node.bar === 'bottom') return `<munder accentunder="true"><mrow>${mathmlOf(node.body)}</mrow><mo>${node.chr}</mo></munder>`;
      return `<mover accent="true"><mrow>${mathmlOf(node.body)}</mrow><mo>${node.chr}</mo></mover>`;
    // \overset{上}{下} / \underset / \stackrel
    case 'stack': {
      const base = `<mrow>${mathmlOf(node.base)}</mrow>`;
      if (node.over) return `<mover>${base}<mrow>${mathmlOf(node.over)}</mrow></mover>`;
      if (node.under) return `<munder>${base}<mrow>${mathmlOf(node.under)}</mrow></munder>`;
      return base;
    }
    // \xrightarrow[下]{上}：箭头本身拉伸，标注在上下
    case 'xarrow': {
      const arrow = `<mo stretchy="true">${escapeXml(node.chr)}</mo>`;
      if (node.below) {
        return `<munderover>${arrow}<mrow>${mathmlOf(node.below)}</mrow><mrow>${mathmlOf(node.above)}</mrow></munderover>`;
      }
      return `<mover>${arrow}<mrow>${mathmlOf(node.above)}</mrow></mover>`;
    }
    // \overbrace / \underbrace
    case 'brace': {
      const body = `<mrow>${mathmlOf(node.body)}</mrow>`;
      const chr = `<mo stretchy="true">${escapeXml(node.chr)}</mo>`;
      return node.top ? `<mover accent="true">${body}${chr}</mover>` : `<munder accentunder="true">${body}${chr}</munder>`;
    }
    case 'box': return `<menclose notation="box"><mrow>${mathmlOf(node.body)}</mrow></menclose>`;
    case 'fenced': {
      const open = node.open ? `<mo fence="true" stretchy="true">${escapeXml(node.open)}</mo>` : '';
      const close = node.close ? `<mo fence="true" stretchy="true">${escapeXml(node.close)}</mo>` : '';
      return `<mrow>${open}${mathmlOf(node.body)}${close}</mrow>`;
    }
    case 'matrix': {
      const cols = Math.max(...node.rows.map((row) => row.length), 1);
      const body = node.rows.map((row) => `<mtr>${Array.from({ length: cols }, (_, i) =>
        `<mtd>${mathmlOf(row[i] || { type: 'row', items: [] })}</mtd>`).join('')}</mtr>`).join('');
      // \substack 的每行要居中堆叠，不能按普通表格两端对齐
      const table = node.stack
        ? `<mtable columnalign="center">${body}</mtable>`
        : `<mtable>${body}</mtable>`;
      const open = node.open ? `<mo fence="true" stretchy="true">${escapeXml(node.open)}</mo>` : '';
      const close = node.close ? `<mo fence="true" stretchy="true">${escapeXml(node.close)}</mo>` : '';
      return `<mrow>${open}${table}${close}</mrow>`;
    }
    default:
      return '';
  }
}

// 上下限：求和/积分与 lim 类函数用「正上下」，其余用普通上下标
function withLimits(base, kind, sub, sup) {
  const isNary = base && base.type === 'nary';
  const isLimitFunc = base && base.type === 'func' && (LIMIT_FUNCS.has(base.v) || base.limits);
  const wrap = (inner) => `<mrow>${inner}</mrow>`;
  if (isNary) {
    const chr = `<mo largeop="true" movablelimits="false">${escapeXml(base.chr)}</mo>`;
    if (kind === 'subsup') return `<munderover>${chr}${wrap(mathmlOf(sub))}${wrap(mathmlOf(sup))}</munderover>`;
    if (kind === 'sub') return `<munder>${chr}${wrap(mathmlOf(sub))}</munder>`;
    return `<mover>${chr}${wrap(mathmlOf(sup))}</mover>`;
  }
  if (isLimitFunc && kind !== 'sup') {
    const name = `<mi mathvariant="normal">${escapeXml(base.v)}</mi>`;
    if (kind === 'subsup') return `<munderover>${name}${wrap(mathmlOf(sub))}${wrap(mathmlOf(sup))}</munderover>`;
    return `<munder>${name}${wrap(mathmlOf(sub))}</munder>`;
  }
  const inner = mathmlOf(base);
  if (kind === 'subsup') return `<msubsup>${inner}${wrap(mathmlOf(sub))}${wrap(mathmlOf(sup))}</msubsup>`;
  if (kind === 'sub') return `<msub>${inner}${wrap(mathmlOf(sub))}</msub>`;
  return `<msup>${inner}${wrap(mathmlOf(sup))}</msup>`;
}

function toMathML(tex, display = false) {
  const body = mathmlOf(parse(tex));
  if (!body) return '';
  return `<math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ''}>${body}</math>`;
}

// ---------- OMML（Word 原生公式） ----------

// OMML 的 run 必须显式指定 Cambria Math：Word 的公式区默认字体是 Cambria Math，
// 但当 w:rPr 里带了别的字体（或干脆没有 w:rPr）时，∑ ∫ ∂ ≤ 这些符号会掉字形，
// 显示成方框或问号——用户反馈的「公式乱码」就是这个。
// 顺序要求：m:rPr → w:rPr → m:t（schema 规定，顺序错了 Word 会报文档损坏）。
//
// 例外：\text{...} 里的中文。Cambria Math 没有汉字字形，中文会被回退到别的字体，
// 严重时整段发虚。这里给中文 run 单独指定宋体。
const MATH_RPR = `<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math" w:cs="Cambria Math"/></w:rPr>`;
const MATH_RPR_CJK = `<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math" w:eastAsia="宋体" w:cs="Cambria Math"/></w:rPr>`;
const CJK_PATTERN = /[\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]/;

// 组合箭头字符 → Word 里能真正画出来的箭头字形
const ARROW_ACCENTS = { '\u20D7': '\u2192', '\u20D6': '\u2190', '\u20E1': '\u2194' };

// m:sty 是单值元素，写两个（同时正体+加粗）会让 Word 判定文档结构非法。
// 所以这里只产出「一个」sty：加粗优先，其次正体。
function ommlText(text, { upright = false, bold = false, variant = '' } = {}) {
  const props = [];
  if (OMML_SCR[variant]) props.push(`<m:scr m:val="${OMML_SCR[variant]}"/>`);
  const sty = bold ? 'b' : (upright ? 'p' : '');
  if (sty) props.push(`<m:sty m:val="${sty}"/>`);
  const rPr = props.length ? `<m:rPr>${props.join('')}</m:rPr>` : '';
  const font = CJK_PATTERN.test(String(text || '')) ? MATH_RPR_CJK : MATH_RPR;
  return `<m:r>${rPr}${font}<m:t xml:space="preserve">${escapeXml(text)}</m:t></m:r>`;
}

function ommlOf(node) {
  if (!node) return '';
  switch (node.type) {
    case 'row': {
      if (!node.items.length) return '';
      const parts = [];
      node.items.forEach((item, index) => {
        parts.push(ommlOf(item));
        // 与 MathML 一致：函数名后面跟变量时补一个细空格（\ln v 不该挤成 lnv）
        if (item.type === 'func' && FUNC_ARG_TYPES.has((node.items[index + 1] || {}).type)) {
          parts.push(`<m:r>${MATH_RPR}<m:t xml:space="preserve">\u2009</m:t></m:r>`);
        }
      });
      return parts.join('');
    }
    case 'id': return ommlText(node.v);
    case 'num': return ommlText(node.v);
    case 'op': return ommlText(node.v);
    case 'func': return ommlText(node.v, { upright: true });
    case 'text': {
      const style = node.style || 'normal';
      // 数学字母变体走 m:scr（花体/哥特体/双线体），普通/加粗/斜体走 m:sty
      if (OMML_SCR[style]) return ommlText(node.v, { variant: style });
      return ommlText(node.v, { upright: style !== 'italic', bold: style === 'bold' });
    }
    case 'space': return `<m:r>${MATH_RPR}<m:t xml:space="preserve"> </m:t></m:r>`;
    case 'linebreak': return `<m:r>${MATH_RPR}<m:br/></m:r>`;
    case 'frac':
      return `<m:f>${node.noLine ? '<m:fPr><m:type m:val="noBar"/></m:fPr>' : ''}`
        + `<m:num>${ommlOf(node.num)}</m:num><m:den>${ommlOf(node.den)}</m:den></m:f>`;
    case 'sqrt':
      return node.index
        ? `<m:rad><m:deg>${ommlOf(node.index)}</m:deg><m:e>${ommlOf(node.body)}</m:e></m:rad>`
        : `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${ommlOf(node.body)}</m:e></m:rad>`;
    case 'sup': return ommlLimits(node.base, 'sup', null, node.sup);
    case 'sub': return ommlLimits(node.base, 'sub', node.sub, null);
    case 'subsup': return ommlLimits(node.base, 'subsup', node.sub, node.sup);
    case 'accent':
      if (node.bar) {
        return `<m:bar><m:barPr><m:pos m:val="${node.bar === 'bottom' ? 'bot' : 'top'}"/></m:barPr>`
          + `<m:e>${ommlOf(node.body)}</m:e></m:bar>`;
      }
      // \bar / \vec 在 OMML 里不用组合字符：横线用 m:bar，向量用箭头字符。
      // 组合字符（U+0304 之类）Word 画不出来，会留一片空白。
      if (node.chr === '\u0304') {
        return `<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>${ommlOf(node.body)}</m:e></m:bar>`;
      }
      if (ARROW_ACCENTS[node.chr]) {
        return `<m:acc><m:accPr><m:chr m:val="${ARROW_ACCENTS[node.chr]}"/></m:accPr><m:e>${ommlOf(node.body)}</m:e></m:acc>`;
      }
      return `<m:acc><m:accPr><m:chr m:val="${escapeXml(node.chr)}"/></m:accPr><m:e>${ommlOf(node.body)}</m:e></m:acc>`;
    case 'fenced':
      return `<m:d><m:dPr><m:begChr m:val="${escapeXml(node.open)}"/><m:endChr m:val="${escapeXml(node.close)}"/>`
        + '<m:grow m:val="1"/></m:dPr>'
        + `<m:e>${ommlOf(node.body)}</m:e></m:d>`;
    // \overset / \underset / \stackrel：标注在基底的角上
    case 'stack': {
      const base = ommlOf(node.base);
      if (node.over) return `<m:limUpp><m:e>${base}</m:e><m:lim>${ommlOf(node.over)}</m:lim></m:limUpp>`;
      if (node.under) return `<m:limLow><m:e>${base}</m:e><m:lim>${ommlOf(node.under)}</m:lim></m:limLow>`;
      return base;
    }
    // \xrightarrow[下]{上}：OMML 没有「可标注箭头」对象，用 limUpp/limLow 叠在箭头上
    case 'xarrow': {
      const arrow = ommlText(node.chr, { upright: true });
      let out = `<m:limUpp><m:e>${arrow}</m:e><m:lim>${ommlOf(node.above)}</m:lim></m:limUpp>`;
      if (node.below) out = `<m:limLow><m:e>${out}</m:e><m:lim>${ommlOf(node.below)}</m:lim></m:limLow>`;
      return out;
    }
    // \overbrace / \underbrace：用 groupChr 把花括号拉伸到内容宽度
    case 'brace':
      return `<m:groupChr><m:groupChrPr><m:chr m:val="${escapeXml(node.chr)}"/>`
        + `<m:pos m:val="${node.top ? 'top' : 'bot'}"/>`
        + `<m:vertJc m:val="${node.top ? 'bot' : 'top'}"/></m:groupChrPr>`
        + `<m:e>${ommlOf(node.body)}</m:e></m:groupChr>`;
    case 'box':
      return `<m:borderBox><m:borderBoxPr/><m:e>${ommlOf(node.body)}</m:e></m:borderBox>`;
    case 'matrix': {
      const cols = Math.max(...node.rows.map((row) => row.length), 1);
      const mc = `<m:mc><m:mcPr><m:count m:val="${cols}"/><m:mcJc m:val="center"/></m:mcPr></m:mc>`;
      const body = node.rows.map((row) => `<m:mr>${Array.from({ length: cols }, (_, i) =>
        `<m:e>${ommlOf(row[i] || { type: 'row', items: [] })}</m:e>`).join('')}</m:mr>`).join('');
      const table = `<m:m><m:mPr><m:mcs>${mc}</m:mcs></m:mPr>${body}</m:m>`;
      if (!node.open && !node.close) return table;
      return `<m:d><m:dPr><m:begChr m:val="${escapeXml(node.open)}"/><m:endChr m:val="${escapeXml(node.close)}"/>`
        + '<m:grow m:val="1"/></m:dPr>'
        + `<m:e>${table}</m:e></m:d>`;
    }
    default: return '';
  }
}

function ommlLimits(base, kind, sub, sup) {
  const isNary = base && base.type === 'nary';
  const isLimitFunc = base && base.type === 'func' && (LIMIT_FUNCS.has(base.v) || base.limits);
  if (isNary) {
    const subXml = sub ? ommlOf(sub) : '';
    const supXml = sup ? ommlOf(sup) : '';
    return '<m:nary><m:naryPr>'
      + `<m:chr m:val="${escapeXml(base.chr)}"/>`
      + '<m:limLoc m:val="undOvr"/>'
      + `<m:subHide m:val="${sub ? 0 : 1}"/><m:supHide m:val="${sup ? 0 : 1}"/>`
      + '</m:naryPr>'
      + `<m:sub>${subXml}</m:sub><m:sup>${supXml}</m:sup><m:e/></m:nary>`;
  }
  if (isLimitFunc && kind !== 'sup') {
    const name = ommlText(base.v, { upright: true });
    if (kind === 'subsup') {
      return `<m:limUpp><m:e>${name}</m:e><m:lim>${ommlOf(sup)}</m:lim></m:limUpp>`
        + `<m:limLow><m:e></m:e><m:lim>${ommlOf(sub)}</m:lim></m:limLow>`;
    }
    return `<m:limLow><m:e>${name}</m:e><m:lim>${ommlOf(sub)}</m:lim></m:limLow>`;
  }
  const inner = ommlOf(base);
  if (kind === 'subsup') {
    return `<m:sSubSup><m:e>${inner}</m:e><m:sub>${ommlOf(sub)}</m:sub><m:sup>${ommlOf(sup)}</m:sup></m:sSubSup>`;
  }
  if (kind === 'sub') return `<m:sSub><m:e>${inner}</m:e><m:sub>${ommlOf(sub)}</m:sub></m:sSub>`;
  return `<m:sSup><m:e>${inner}</m:e><m:sup>${ommlOf(sup)}</m:sup></m:sSup>`;
}

// 内联公式（放在正文段落里）
function toOmml(tex) {
  return ommlOf(parse(tex));
}

// 体检：这条公式里有哪些命令没能渲染出来（会退化成正体字母）。
// 空数组表示整条公式都是「真公式」，不会有 \mathcal 变 mathcalL 这种乱码。
function unknownCommands(tex) {
  try {
    const root = parse(tex);
    return Array.isArray(root && root.unknown) ? root.unknown.slice() : [];
  } catch (err) {
    return ['<parse-error>'];
  }
}

module.exports = {
  parse, toMathML, toOmml, tokenize, unknownCommands,
  SYMBOLS, NARY, FUNCS, ACCENTS, XARROW, TEXT_VARIANTS,
};
