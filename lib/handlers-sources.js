// 书源引擎：搜索 / 目录 / 正文抓取（含 charset 处理、页内清洗）。
'use strict';
const fs = require('fs');
const path = require('path');
const { parse, query, textOf, cleanText } = require('./htmlmini');
const { DATA_DIR } = require('./db');
const { crc32, makeZip } = require('./zip');

const SOURCES_FILE = path.join(DATA_DIR, 'sources.json');
const BUNDLED_SOURCES_FILE = path.join(__dirname, '..', 'resources', 'sources.json');
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.FABULA_SOURCE_TIMEOUT_MS || '', 10) || 30000;
const MAX_SOURCE_BYTES = Number.parseInt(process.env.FABULA_SOURCE_MAX_BYTES || '', 10) || 16 * 1024 * 1024;
const FETCH_CONCURRENCY = Math.max(1, Math.min(8, Number.parseInt(process.env.FABULA_SOURCE_CONCURRENCY || '', 10) || 3));
let sourcesCache = null;
let sourcesCacheAt = 0;
const sources = () => {
  if (sourcesCache && Date.now() - sourcesCacheAt < 2000) return sourcesCache;
  const fp = fs.existsSync(SOURCES_FILE) ? SOURCES_FILE : BUNDLED_SOURCES_FILE;
  sourcesCache = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  sourcesCacheAt = Date.now();
  return sourcesCache;
};

async function fetchHtml(url) {
  let parsed;
  try { parsed = new URL(url); } catch (error) { throw new Error(`书源 URL 非法: ${url}`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`不支持的书源协议: ${parsed.protocol}`);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, FETCH_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  try {
    const resp = await fetch(parsed, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36' },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`抓取失败 ${resp.status}: ${url}`);
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared > MAX_SOURCE_BYTES) {
      controller.abort();
      throw new Error(`书源页面超过 ${MAX_SOURCE_BYTES} 字节上限: ${url}`);
    }
    if (!resp.body) return '';
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SOURCE_BYTES) {
        try { await reader.cancel(); } catch (ignored) {}
        controller.abort();
        throw new Error(`书源页面超过 ${MAX_SOURCE_BYTES} 字节上限: ${url}`);
      }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks);
    let html = '';
    try { html = new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch (e) {}
    // GBK 判定：UTF-8 含大量替换/非法序列时试 gbk
    if (html.includes('\ufffd') && (html.match(/\ufffd/g) || []).length > 30) {
      try { html = new TextDecoder('gbk').decode(bytes); } catch (e) {}
    }
    return html;
  } catch (error) {
    if (timedOut) throw new Error(`书源抓取超时（${FETCH_TIMEOUT_MS}ms）: ${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function relUrl(base, link) {
  const l = String(link || '').trim();
  try { return new URL(l, base).toString(); } catch (e) { return l; }
}

function findFirst(root, sel) {
  const m = query(root, sel);
  return m[0] || null;
}

// 搜索结果：按 source.search 选择器解析
async function searchBooks({ sourceId, keyword }) {
  const src = sources().find((s) => s.id === sourceId);
  if (!src) throw new Error('未知书源 ' + sourceId);
  if (!src.search) return [];
  const url = src.search.url.replace(/\{\{key\}\}/g, encodeURIComponent(keyword));
  const html = await fetchHtml(url);
  const root = parse(html);
  const items = query(root, src.search.item || 'div.listitem');
  const out = [];
  for (const it of items.slice(0, 30)) {
    const nameEl = findFirst(it, src.search.name || 'h2');
    const linkEl = findFirst(it, src.search.link || 'a');
    const authorEl = src.search.author ? findFirst(it, src.search.author) : null;
    const title = cleanText(textOf(nameEl)) || cleanText(textOf(linkEl));
    const link = linkEl && (linkEl.attrs.href || '');
    if (!title || !link) continue;
    out.push({ title, name: title, author: authorEl ? cleanText(textOf(authorEl)) : '', url: relUrl(src.baseUrl, link) });
  }
  return out;
}

// 目录页
async function fetchBookCatalog({ sourceId, bookUrl }) {
  const src = sources().find((s) => s.id === sourceId);
  if (!src) throw new Error('未知书源 ' + sourceId);
  if (!src.catalog) throw new Error('书源无目录配置');
  const cleaned = String(bookUrl || '').replace(/\/+$/, '');
  const url = src.catalog.urlTemplate
    ? src.catalog.urlTemplate.replace(/\{\{url\}\}/g, cleaned)
    : bookUrl;
  let html;
  try {
    html = await fetchHtml(url);
  } catch (e) {
    if (url !== cleaned) html = await fetchHtml(cleaned);
    else throw e;
  }
  const root = parse(html);
  const bookNameEl = src.catalog.bookName ? findFirst(root, src.catalog.bookName) : null;
  const title = bookNameEl ? cleanText(textOf(bookNameEl)) : '';
  const items = query(root, src.catalog.item || '#list dd a');
  const chapters = [];
  for (const it of items) {
    const t = cleanText(textOf(it));
    const link = it.attrs.href || '';
    if (!t) continue;
    chapters.push({ name: t, title: t, url: relUrl(src.baseUrl, link) });
  }
  return { title, bookName: title, chapters };
}

// 正文清洗
function cleanBody(raw, src) {
  const junk = (src && src.content && src.content.junkLines) || [];
  let out = String(raw || '')
    .replace(/&\w+;/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(br|p|div|dd|li|h\d)[^>]*>/gi, '\n')
    .replace(/\r/g, '');
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => {
    if (!l) return false;
    return !junk.some((j) => j && l.includes(j));
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function fetchChapterTexts(args, ctx) {
  const { sourceId, chapters, onEvent: ch } = args;
  const channel = typeof ch === 'string' ? ch.replace(/^__CHANNEL__:/, '') : ch && ch.id != null ? String(ch.id) : null;
  const src = sources().find((s) => s.id === sourceId);
  if (!src) throw new Error('未知书源 ' + sourceId);
  const texts = [];
  const total = (chapters || []).length;
  const results = new Array(total);
  let nextIndex = 0;
  let completed = 0;
  const worker = async () => {
    for (;;) {
      const idx = nextIndex++;
      if (idx >= total) return;
      const c = chapters[idx];
      try {
        const html = await fetchHtml(c.url);
        let body = '';
        if (src.content && src.content.body) {
          const root = parse(html);
          const el = findFirst(root, src.content.body);
          if (el) body = textOf(el);
        }
        if (!body) {
          const root = parse(html);
          const el = findFirst(root, '#content');
          body = el ? textOf(el) : '';
        }
        results[idx] = { name: c.name, url: c.url, text: cleanBody(body, src) };
      } catch (error) {
        results[idx] = { name: c.name, url: c.url, text: '', error: error.message };
      }
      completed++;
      ctx.send(JSON.stringify({ ch: channel, e: { type: 'progress', index: completed, total } }) + '\n');
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, Math.max(1, total)) }, worker));
  for (const item of results) {
    if (!item) continue;
    texts.push(item);
  }
  const errors = texts.filter((item) => item.error).map((item) => ({ name: item.name, url: item.url, message: item.error }));
  if (total && errors.length === total) throw new Error(`全部章节抓取失败：${errors[0].message}`);
  const final = { type: 'done', texts, errors };
  ctx.send(JSON.stringify({ ch: channel, e: final }) + '\n');
  // 前端把该命令的返回值直接当作「拼接好的正文文本」
  return texts.map((t) => t.text).join('\n\n');
}

function listBookSources() {
  return sources().map((s) => ({ ...s, enabled: true }));
}

// 同步书源：离线版用本地配置
function syncBookSources() {
  return { ok: true, sources: listBookSources(), fromRemote: false };
}

module.exports = { sources, fetchHtml, searchBooks, fetchBookCatalog, fetchChapterTexts, listBookSources, syncBookSources, makeZip, crc32 };
