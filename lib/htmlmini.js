// 迷你 HTML 解析器 + 极简选择器（支持 tag / .class / #id / 空格后代链），
// 用于书源抓取（sources.json 的选择器都是简单形态）。
'use strict';

const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'wbr', 'area', 'base', 'col', 'embed', 'track']);

function parse(html) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)>/g;
  let last = 0;
  let m;
  html = String(html || '');
  const appendText = (t) => {
    if (!t) return;
    const cur = stack[stack.length - 1];
    cur.children.push({ tag: '#text', attrs: {}, children: [], text: t });
  };
  while ((m = re.exec(html))) {
    if (m.index > last) appendText(html.slice(last, m.index));
    last = re.lastIndex;
    const [, close, tag, attrStr] = m;
    const t = tag.toLowerCase();
    if (close) {
      // pop up to matching
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tag === t) { stack.length = i; break; }
      }
      continue;
    }
    const node = { tag: t, attrs: parseAttrs(attrStr), children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!VOID.has(t)) stack.push(node);
  }
  appendText(html.slice(last));
  root.text = collectText(root);
  flattenText(root);
  return root;
}

function parseAttrs(s) {
  const attrs = { id: '', classes: [] };
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*'([^']*)'|([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?=\s|$)/g;
  let m;
  while ((m = re.exec(s))) {
    const key = (m[1] || m[3] || m[5] || '').toLowerCase();
    const val = m[2] !== undefined ? m[2] : m[4] !== undefined ? m[4] : true;
    if (key === 'id') attrs.id = String(val == true ? '' : val);
    else if (key === 'class' && val) attrs.classes.push(...String(val).split(/\s+/).filter(Boolean));
    else if (key) attrs[key] = val == true ? '' : String(val);
  }
  return attrs;
}

function collectText(node) {
  if (node.tag === '#text') return node.text;
  let out = '';
  for (const c of node.children) out += collectText(c);
  return out;
}

function flattenText(node) {
  // 把 #text 叶子内容汇总到父节点 text 字段，便于取“元素文本”
  let s = '';
  for (const c of node.children) {
    if (c.tag === '#text') s += c.text;
    else { s += collectText(c); }
  }
  node.text = s;
  for (const c of node.children) if (c.tag !== '#text') flattenText(c);
}

function* allElements(node) {
  for (const c of node.children) {
    if (c.tag !== '#text') { yield* allElements(c); yield c; }
  }
}
function* walk(node) {
  for (const c of node.children) yield* walkInner(c, null, true);
}
let walkInner = function* (node, parentSep, first) {
  yield* (function* () { yield node; })();
  for (const c of node.children) yield* walkInner(c, null, false);
};

function matchPart(el, part) {
  // part: "div" | ".cls" | "#id" | "div.list" | "div.a.b"
  if (!part) return false;
  const tagRe = /^[a-zA-Z][a-zA-Z0-9-]*/;
  const tm = part.match(tagRe);
  if (tm && tagExpected(part)) {
    if (el.tag !== tm[0]) return false;
    part = part.slice(tm[0].length);
  }
  const cls = /\.([a-zA-Z0-9_-]+)/g; const ids = /#([a-zA-Z0-9_-]+)/g;
  let m;
  if (part.includes('#')) {
    const im = part.match(ids); if (im) for (const s of im) { if (el.attrs.id !== s.slice(1)) return false; }
  }
  if (part.includes('.')) {
    while ((m = cls.exec(part))) {
      if (!el.attrs.classes.includes(m[1])) return false;
    }
  }
  return true;
}

function tagExpected(part) {
  return /^[a-zA-Z][a-zA-Z0-9-]*[.#:]/.test(part) || /^[a-zA-Z][a-zA-Z0-9-]*$/.test(part);
}

function query(node, selector) {
  const parts = String(selector || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const all = [...allElements(node)];
  let candidates = [{ el: node, in: true }];
  // 简化：从上到下逐级筛选
  for (const part of parts) {
    const next = [];
    for (const c of candidates) {
      // part 要求匹配 c.el 自身(当前层级若未消耗)或其后代
      for (const el of all) {
        if (!matchPart(el, part)) continue;
        if ((c.el === node || descendants(c.el).has(el)) && !next.find((x) => x.el === el)) next.push({ el });
      }
    }
    candidates = next;
  }
  return candidates.map((c) => c.el).filter((el) => el !== node || parts.length === 1);
}

const descCache = new WeakMap();
function descendants(el) {
  if (!descCache.has(el)) {
    const s = new Set();
    (function go(n) { for (const c of n.children) { if (c.tag !== '#text') { s.add(c); go(c); } } })(el);
    descCache.set(el, s);
  }
  return descCache.get(el);
}

function textOf(el) { return (el && (el.text || collectText(el))) || ''; }
function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

module.exports = { parse, query, textOf, cleanText };
