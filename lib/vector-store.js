'use strict';

// 长篇作品的知识库与索引库。
//
// 设计要点（v2）：
// 1. 切片按"场景"而不是固定字符数，每个片段携带章节、人物、地点、伏笔编号，
//    这样检索可以做时间过滤（不泄漏未来章节），也能按人物/伏笔重排。
// 2. 检索是两阶段的：先用 id + 二进制向量打分，只对入选的少量片段取正文。
//    旧实现每次检索都把全书片段正文读进内存，百万字下是明显浪费。
// 3. 别称通过 entity_aliases 表做查询改写，解决"本名/称号/代称"互相召不回。
// 4. 重排考虑词面、向量、人物命中、伏笔命中、章节距离和分组权重，并按 Token 预算组装。
const crypto = require('node:crypto');
const { q, one, run, exec, transaction } = require('./db');
const llm = require('./llm');

const ENGINE = 'local-hybrid-scene-v2';
const DIMENSIONS = 256;
const CHUNK_CHARS = 1400;
const CHUNK_OVERLAP = 220;
const SCENE_MIN_CHARS = 360;
const SCENE_MAX_CHARS = 1200;
const MAX_RETRIEVAL_CHARS = 10000;
const CHARS_PER_TOKEN = 1.5;
const MAX_PER_FILE = 2;
const MAX_VECTOR_CACHE = 6000;
const SYNC_TTL_MS = 15000;
const DICT_TTL_MS = 30000;
const ALIAS_TTL_MS = 5000;
const NARRATIVE_GROUPS = new Set(['正文', 'chapters']);
const SUMMARY_FILES = new Set(['章节摘要.md']);

// ---------- 语义向量（可选叠加层） ----------
//
// 底层向量永远是 256 维的本地字符 n-gram 哈希：零依赖、离线可用。
// 配置了 embedding 模型（走用户渠道的 OpenAI 兼容 /embeddings，如 bge-m3）后，
// 片段向量懒填充进 kb_embeddings，矩阵带出第二个向量层，检索的"向量分量"
// 改用语义余弦。任何一步不可用（未配置/接口失败/只填充了一部分）都整本回落
// 到哈希引擎——两个向量空间不能混着算余弦。
const EMBED_BATCH = 16;
const EMBED_MAX_PER_PASS = 96;
const EMBED_COOLDOWN_MS = 60000;

// 连续失败后的冷却：避免每次检索都打一遍注定失败的接口。
let embedFailure = null; // { at, message }

function settingValue(key) {
  return String(one(`SELECT value FROM settings WHERE key=?`, key)?.value || '').trim();
}

function embeddingConfig() {
  const model = settingValue('embedding_model');
  if (!model) return null;
  let baseUrl = settingValue('embedding_base_url');
  let apiKey = settingValue('embedding_api_key');
  if (!baseUrl || !apiKey) {
    const chn = llm.activeChannel();
    if (chn) {
      baseUrl = baseUrl || chn.baseUrl || '';
      apiKey = apiKey || chn.key || '';
    }
  }
  if (!baseUrl) return null;
  return { model, baseUrl, apiKey };
}

function embedAvailable() {
  return !embedFailure || Date.now() - embedFailure.at > EMBED_COOLDOWN_MS;
}
function noteEmbedFailure(message) {
  embedFailure = { at: Date.now(), message: String(message || '').slice(0, 200) };
}
// 配置变更或手动重试时清掉冷却，否则改完配置还要白等一分钟。
function resetEmbeddingFailures() {
  embedFailure = null;
}

function encodeEmbed(vector) {
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  for (let i = 0; i < vector.length; i++) buffer.writeFloatLE(vector[i], i * 4);
  return buffer;
}
function decodeEmbed(buffer, dim) {
  if (!buffer || !dim || buffer.length < dim * 4) return null;
  const view = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const vector = new Float32Array(dim);
  for (let i = 0; i < dim; i++) vector[i] = view.readFloatLE(i * 4);
  return vector;
}

// 给该书尚未向量化（或模型换了）的片段补语义向量，一次最多 maxTexts 条，
// 让"首次检索顺手填充"而不是把整本书的向量化塞进一次请求。
async function ensureEmbeddings(bookId, { maxTexts = EMBED_MAX_PER_PASS } = {}) {
  const key = String(bookId || '');
  if (!key) return { ok: false, skipped: true, reason: 'no-book' };
  const config = embeddingConfig();
  if (!config) return { ok: false, skipped: true, reason: 'disabled' };
  if (!embedAvailable()) return { ok: false, skipped: true, reason: 'cooldown', error: embedFailure.message };
  // 换模型后清掉旧模型的残留，避免两个向量空间混存。
  const stale = Number(one(`SELECT COUNT(*) AS n FROM kb_embeddings WHERE book_id=? AND model<>?`, key, config.model)?.n || 0);
  if (stale) {
    transaction(() => run(`DELETE FROM kb_embeddings WHERE book_id=? AND model<>?`, key, config.model));
    dropMatrix(key);
  }
  const pending = q(`SELECT c.id, c.content FROM kb_chunks c
    LEFT JOIN kb_embeddings e ON e.chunk_id=c.id AND e.model=?
    WHERE c.book_id=? AND e.chunk_id IS NULL ORDER BY c.rowid LIMIT ?`,
  config.model, key, Math.max(1, Number(maxTexts) || EMBED_MAX_PER_PASS));
  if (!pending.length) return { ok: true, model: config.model, embedded: 0, remaining: 0 };
  let embedded = 0;
  let dim = 0;
  for (let offset = 0; offset < pending.length; offset += EMBED_BATCH) {
    const batch = pending.slice(offset, offset + EMBED_BATCH);
    let result;
    try {
      result = await llm.embedTexts(batch.map((row) => row.content), config);
    } catch (error) {
      noteEmbedFailure(error && error.message ? error.message : error);
      return { ok: false, model: config.model, embedded, error: embedFailure.message };
    }
    embedFailure = null;
    dim = result.dim;
    const vectors = result.vectors;
    transaction(() => {
      for (let i = 0; i < batch.length; i++) {
        run(`INSERT INTO kb_embeddings(chunk_id,book_id,model,dim,vector,updated_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(chunk_id) DO UPDATE SET model=excluded.model, dim=excluded.dim,
            vector=excluded.vector, updated_at=excluded.updated_at`,
        batch[i].id, key, result.model, result.dim, encodeEmbed(vectors[i]), Date.now());
      }
    });
    embedded += batch.length;
  }
  dropMatrix(key);
  const remaining = Number(one(`SELECT COUNT(*) AS n FROM kb_chunks c
    LEFT JOIN kb_embeddings e ON e.chunk_id=c.id AND e.model=?
    WHERE c.book_id=? AND e.chunk_id IS NULL`, config.model, key)?.n || 0);
  return { ok: true, model: config.model, dim, embedded, remaining };
}

// 查询向量。失败只回落到哈希路径并触发冷却，绝不阻塞检索本身。
async function embedQuery(query) {
  const config = embeddingConfig();
  if (!config || !embedAvailable()) return null;
  try {
    const result = await llm.embedTexts([query], config);
    embedFailure = null;
    return result.vectors[0];
  } catch (error) {
    noteEmbedFailure(error && error.message ? error.message : error);
    return null;
  }
}

// 检索前的异步准备：增量补齐片段向量 + 算查询向量。同步的 retrieve 不碰网络。
async function prepareRetrieval(bookId, query) {
  const config = embeddingConfig();
  if (!config || !String(query || '').trim()) return null;
  await ensureEmbeddings(bookId, { maxTexts: EMBED_MAX_PER_PASS });
  const queryVector = await embedQuery(query);
  return queryVector ? { queryVector, model: config.model } : null;
}

// 手动预热：把一本书补到全覆盖（带总量上限，防止失控）。
async function primeEmbeddings(bookId, { maxTexts = 4000 } = {}) {
  let embedded = 0;
  let last = null;
  while (embedded < maxTexts) {
    last = await ensureEmbeddings(bookId, { maxTexts: Math.min(EMBED_MAX_PER_PASS, maxTexts - embedded) });
    if (!last.ok || !last.embedded) break;
    embedded += last.embedded;
  }
  return { ...last, embeddedTotal: embedded };
}

const vectorCache = new Map();
const bookSyncAt = new Map();
const dictCache = new Map();
const primedBooks = new Set();
const aliasSyncAt = new Map();
let ftsReady = null;

function fileKey(bookId, group, name) { return `${bookId}\u0000${group}\u0000${name}`; }
function fileHash(content) { return crypto.createHash('sha256').update(content).digest('hex'); }
function hash32(value) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function tokens(text) {
  const out = [];
  const normalized = String(text || '').toLowerCase();
  for (const match of normalized.matchAll(/[\u3400-\u9fff]+|[a-z0-9_./:-]{2,}/g)) {
    const token = match[0];
    if (/^[\u3400-\u9fff]+$/.test(token)) {
      for (let i = 0; i < token.length; i++) out.push(token[i]);
      for (let i = 0; i + 1 < token.length; i++) out.push(token.slice(i, i + 2));
    } else {
      out.push(token);
      for (const part of token.split(/[./:_-]+/)) if (part.length > 1) out.push(part);
    }
  }
  return out;
}

function vectorFor(text) {
  const vector = new Float32Array(DIMENSIONS);
  for (const token of tokens(text)) {
    const hash = hash32(token);
    vector[hash % DIMENSIONS] += (hash & 0x100) === 0 ? 1 : -1;
  }
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}

// 二进制比 JSON 省 4~6 倍空间，也让"只取向量不取正文"的两阶段检索真正划算。
function encodeVector(vector) {
  const buffer = Buffer.allocUnsafe(DIMENSIONS * 4);
  for (let i = 0; i < DIMENSIONS; i++) buffer.writeFloatLE(vector[i], i * 4);
  return buffer;
}

function decodeVectorBuffer(buffer) {
  if (!buffer || buffer.length < DIMENSIONS * 4) return null;
  const view = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const vector = new Float32Array(DIMENSIONS);
  for (let i = 0; i < DIMENSIONS; i++) vector[i] = view.readFloatLE(i * 4);
  return vector;
}

function decodeJsonVector(raw) {
  try { return Float32Array.from(JSON.parse(raw)); } catch { return null; }
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < DIMENSIONS; i++) sum += a[i] * b[i];
  return sum;
}

function vectorOf(row) {
  const cached = vectorCache.get(row.id);
  if (cached) {
    vectorCache.delete(row.id);
    vectorCache.set(row.id, cached);
    return cached;
  }
  const vector = decodeVectorBuffer(row.vector_blob) || decodeJsonVector(row.vector_json) || new Float32Array(DIMENSIONS);
  vectorCache.set(row.id, vector);
  while (vectorCache.size > MAX_VECTOR_CACHE) vectorCache.delete(vectorCache.keys().next().value);
  return vector;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / CHARS_PER_TOKEN));
}

// ---------- 切片 ----------

// 通用字符切片：用于设定、参考等非叙事文件。
function splitChunks(content) {
  const source = String(content || '').trim();
  if (!source) return [];
  const chunks = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + CHUNK_CHARS);
    if (end < source.length) {
      const boundary = Math.max(source.lastIndexOf('\n', end), source.lastIndexOf('。', end), source.lastIndexOf('！', end), source.lastIndexOf('？', end));
      if (boundary > start + Math.floor(CHUNK_CHARS * 0.55)) end = boundary + 1;
    }
    const text = source.slice(start, end).trim();
    if (text) chunks.push(text);
    if (end >= source.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

// 场景切片：按段落聚合成 360~1200 字的自然场景，尽量不把一场戏劈成两半。
function splitScenes(content, { maxChars = SCENE_MAX_CHARS, minChars = SCENE_MIN_CHARS } = {}) {
  const source = String(content || '').trim();
  if (!source) return [];
  const units = [];
  for (const paragraph of source.split(/\n{2,}/)) {
    const text = paragraph.trim();
    if (!text) continue;
    if (text.length <= maxChars) { units.push(text); continue; }
    let rest = text;
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf('。', maxChars);
      if (cut < maxChars * 0.5) cut = rest.lastIndexOf('\n', maxChars);
      if (cut < maxChars * 0.5) cut = maxChars - 1;
      units.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1);
    }
    if (rest.trim()) units.push(rest.trim());
  }
  const chunks = [];
  let current = '';
  for (const unit of units) {
    if (current && current.length + unit.length + 2 > maxChars) {
      chunks.push(current);
      current = unit;
    } else {
      current = current ? `${current}\n\n${unit}` : unit;
    }
  }
  if (current) chunks.push(current);
  if (chunks.length > 1 && chunks[chunks.length - 1].length < minChars) {
    chunks[chunks.length - 2] = `${chunks[chunks.length - 2]}\n\n${chunks.pop()}`;
  }
  return chunks;
}

// 章节摘要按"## 第N章"切成一条条，让每片都带上自己的章号，避免远期摘要泄漏。
function splitSummarySections(content, { maxChars = SCENE_MAX_CHARS } = {}) {
  const source = String(content || '').trim();
  if (!source) return [];
  const marks = [...source.matchAll(/^#{1,4}\s*第\s*(\d+)\s*章[^\n]*$/gm)];
  if (!marks.length) {
    return splitScenes(source, { maxChars }).map((text) => ({ chapterNum: 0, text }));
  }
  const parts = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : source.length;
    const text = source.slice(start, end).trim();
    if (!text) continue;
    const chapterNum = Number(marks[i][1]) || 0;
    if (text.length <= maxChars) parts.push({ chapterNum, text });
    else for (const piece of splitScenes(text, { maxChars })) parts.push({ chapterNum, text: piece });
  }
  return parts;
}

function chapterNumFromName(name) {
  const matched = String(name || '').match(/第\s*([0-9]{1,6})\s*章/);
  return matched ? Number(matched[1]) : 0;
}

// ---------- 词典：别称 / 人物 / 伏笔 / 地点 ----------

// 人物库常见写法都要认：`## 沈砚`、`## 沈砚（墨七）`、`**沈砚**`、`## 沈砚 | 墨七`、
// `- 姓名：沈砚（墨七）`、`- 别名：墨七、断水客`。
// 括号内和竖线后的称谓是最容易漏的两种，AI 生成的人物库大量使用它们。
const ALIAS_SPLIT = /[、,，/|｜;；\s]+/;

function cleanName(raw) {
  return String(raw || '').replace(/[*`]/g, '').trim().slice(0, 20);
}

// 名字后面常跟说明（`沈砚，二十七岁` / `沈砚 主角`），取第一段才是人名。
function baseName(raw) {
  return cleanName(String(raw || '').split(/[，,。；;：:\s（(]/)[0]);
}

function splitAliasText(raw, canonical) {
  const out = [];
  for (const part of String(raw || '').split(ALIAS_SPLIT)) {
    const value = cleanName(part.replace(/[（(][^)）]*[)）]/g, ''));
    if (value && value !== canonical) out.push(value);
  }
  return out;
}

// `沈砚（墨七）` → 本体 沈砚 + 括号内 墨七；`沈砚 | 墨七` → 本体 沈砚 + 墨七。
function splitName(raw) {
  const segments = String(raw || '').split(/[|｜]/);
  const head = segments.shift() || '';
  const match = head.match(/^([^（(]+)[（(]([^)）]+)[)）]\s*$/);
  const base = baseName(match ? match[1] : head);
  const inner = [match ? match[2] : '', ...segments].filter(Boolean).join('、');
  return { base, inner };
}

function parseAliases(text) {
  const pairs = [];
  let canonical = '';
  const push = (alias) => {
    if (!alias || alias === canonical) return;
    if (pairs.some((pair) => pair.canonical === canonical && pair.alias === alias)) return;
    pairs.push({ canonical, alias });
  };
  const applyName = (raw) => {
    const { base, inner } = splitName(raw);
    if (!base) return;
    canonical = base;
    for (const alias of splitAliasText(inner, canonical)) push(alias);
  };
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s*(.+)$/);
    if (heading) { applyName(heading[1]); continue; }
    const bold = line.match(/^\*\*([^*]+)\*\*(.*)$/);
    if (bold) { applyName(bold[1] + bold[2]); continue; }
    const named = line.match(/^[-*]?\s*(?:姓名|本名|名字|真名)[：:]\s*(.+)$/);
    if (named) { applyName(named[1]); continue; }
    const alias = line.match(/^[-*]?\s*(?:别名|别称|称号|绰号|又名|化名|代称|外号)[：:]\s*(.+)$/);
    if (!alias || !canonical) continue;
    for (const value of splitAliasText(alias[1], canonical)) push(value);
  }
  return pairs;
}

function invalidateDictionaries(bookId) {
  dictCache.delete(String(bookId || ''));
}

// 别称来源：人物库里的"别名/称号"行 + 已经确立的人物状态。
function refreshAliases(bookId, { force = false } = {}) {
  if (!bookId) return 0;
  // 别称刷新要读人物库文件、扫 story_states、比对整张 entity_aliases。
  // 这是每次检索都会走到的固定开销，用短 TTL 挡住，写入路径再显式 force。
  const cacheKey = String(bookId);
  const cached = aliasSyncAt.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < ALIAS_TTL_MS) return cached.count;
  const stamp = Date.now();
  const pairs = new Map();
  const add = (canonical, alias, source) => {
    const name = String(canonical || '').trim();
    const value = String(alias || '').trim();
    if (!name || !value || name === value) return;
    if (pairs.has(value)) return;
    pairs.set(value, { canonical: name, source });
  };
  let charactersDoc = '';
  try {
    const core = require('./handlers-core');
    charactersDoc = core.readFileFrom({ bookId, group: '设定', name: '人物库.md' }) || '';
  } catch (error) {
    charactersDoc = '';
  }
  for (const pair of parseAliases(charactersDoc)) add(pair.canonical, pair.alias, '人物库');
  for (const row of q(`SELECT state_key FROM story_states WHERE book_id=? AND kind='character'`, bookId)) {
    add(row.state_key, row.state_key, 'state');
  }
  const existing = new Map(q(`SELECT alias, canonical FROM entity_aliases WHERE book_id=?`, bookId)
    .map((row) => [row.alias, row.canonical]));
  const changed = existing.size !== pairs.size ||
    [...pairs].some(([alias, item]) => existing.get(alias) !== item.canonical);
  primedBooks.add(String(bookId));
  aliasSyncAt.set(cacheKey, { at: stamp, count: pairs.size });
  if (!changed) return pairs.size;
  transaction(() => {
    run(`DELETE FROM entity_aliases WHERE book_id=?`, bookId);
    for (const [alias, item] of pairs) {
      run(`INSERT INTO entity_aliases(book_id, alias, canonical, source, updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(book_id, alias) DO UPDATE SET canonical=excluded.canonical, source=excluded.source, updated_at=excluded.updated_at`,
      bookId, alias, item.canonical, item.source, stamp);
    }
  });
  invalidateDictionaries(bookId);
  // 称谓变了，已索引片段里的人物元数据就过期了，标记该书下次同步时重建。
  if (one(`SELECT 1 AS present FROM kb_chunks WHERE book_id=? LIMIT 1`, bookId)) {
    run(`DELETE FROM kb_meta WHERE book_id=?`, bookId);
  }
  return pairs.size;
}

function dictionaries(bookId) {
  const key = String(bookId || '');
  const cached = dictCache.get(key);
  if (cached && Date.now() - cached.at < DICT_TTL_MS) return cached.value;
  const aliasMap = new Map();
  const families = new Map();
  let rows = q(`SELECT alias, canonical FROM entity_aliases WHERE book_id=?`, key);
  if (!rows.length && !primedBooks.has(key)) {
    primedBooks.add(key);
    try { refreshAliases(key); } catch (error) { /* 无人物库时忽略 */ }
    rows = q(`SELECT alias, canonical FROM entity_aliases WHERE book_id=?`, key);
  }
  for (const row of rows) {
    aliasMap.set(row.alias, row.canonical);
    if (!families.has(row.canonical)) families.set(row.canonical, new Set());
    families.get(row.canonical).add(row.alias);
  }
  const characters = [...families.keys()].sort((a, b) => b.length - a.length);
  // 长的先匹配，避免"断水"抢走"断水客"。
  const aliasEntries = [];
  for (const [canonical, aliases] of families) {
    aliasEntries.push([canonical, canonical]);
    for (const alias of aliases) aliasEntries.push([alias, canonical]);
  }
  aliasEntries.sort((a, b) => b[0].length - a[0].length);
  const threads = q(`SELECT thread_key, text FROM thread_events WHERE book_id=? ORDER BY chapter_num DESC, id DESC LIMIT 80`, key)
    .map((row) => ({ key: row.thread_key, probe: String(row.text || '').slice(0, 12) }))
    .filter((row) => row.probe.length >= 4);
  const value = { aliasMap, families, characters, aliasEntries, threads };
  dictCache.set(key, { at: Date.now(), value });
  return value;
}

function detectCharacters(text, dict, limit = 8) {
  if (!text || !dict.aliasEntries.length) return [];
  const found = new Set();
  for (const [surface, canonical] of dict.aliasEntries) {
    if (found.size >= limit) break;
    if (text.includes(surface)) found.add(canonical);
  }
  return [...found];
}

function detectThreads(text, dict, limit = 4) {
  const found = [];
  if (!text || !dict.threads.length) return found;
  for (const thread of dict.threads) {
    if (found.length >= limit) break;
    if (text.includes(thread.probe)) found.push(thread.key);
  }
  return found;
}

function chapterLocation(bookId, chapterNum) {
  if (!chapterNum) return '';
  const row = one(`SELECT state_json FROM chapter_continuity WHERE book_id=? AND chapter_num=?`, bookId, chapterNum);
  if (!row) return '';
  try {
    const state = JSON.parse(row.state_json);
    return String(state.location || '').slice(0, 40);
  } catch {
    return '';
  }
}

// 查询改写：命中的任一称谓都会扩展出同族全部称谓。
// 这样"用本名提问、正文里只出现别称"和"用别称提问、正文里只出现本名"都能召回。
function expandQuery(query, dict) {
  const text = String(query || '');
  const families = dict && dict.families;
  if (!families || !families.size) return text;
  const extra = [];
  const seen = new Set();
  for (const [canonical, aliases] of families) {
    const hit = text.includes(canonical) || [...aliases].some((alias) => text.includes(alias));
    if (!hit) continue;
    for (const value of [canonical, ...aliases]) {
      if (value && !text.includes(value) && !seen.has(value)) { seen.add(value); extra.push(value); }
    }
  }
  return extra.length ? `${text} ${extra.join(' ')}` : text;
}

function searchTerms(text, limit = 18) {
  const terms = [];
  const seen = new Set();
  const add = (value) => {
    const term = String(value || '').trim();
    if (!term || seen.has(term) || terms.length >= limit) return;
    seen.add(term);
    terms.push(term);
  };
  for (const match of String(text || '').matchAll(/[\u3400-\u9fff]+|[a-z0-9_./:-]{3,}/gi)) {
    const token = match[0];
    if (!/^[\u3400-\u9fff]+$/.test(token)) {
      add(token);
      continue;
    }
    const chars = [...token];
    if (chars.length <= 6) {
      if (chars.length >= 3) add(token);
      continue;
    }
    const step = Math.max(2, Math.floor(chars.length / 6));
    for (let index = 0; index + 3 <= chars.length && terms.length < limit; index += step) {
      add(chars.slice(index, index + 3).join(''));
    }
    add(chars.slice(-3).join(''));
  }
  return terms;
}

// ---------- FTS ----------

function ensureFts() {
  if (ftsReady !== null) return ftsReady;
  try {
    exec(`CREATE VIRTUAL TABLE IF NOT EXISTS kb_chunks_fts USING fts5(
      chunk_id UNINDEXED, book_id UNINDEXED, group_name UNINDEXED, file_name UNINDEXED,
      content, tokenize='trigram'
    )`);
    const indexed = Number((one(`SELECT COUNT(*) AS n FROM kb_chunks_fts`) || {}).n || 0);
    const total = Number((one(`SELECT COUNT(*) AS n FROM kb_chunks`) || {}).n || 0);
    if (indexed !== total) {
      exec(`DELETE FROM kb_chunks_fts;
        INSERT INTO kb_chunks_fts(chunk_id,book_id,group_name,file_name,content)
        SELECT id,book_id,group_name,file_name,content FROM kb_chunks;`);
    }
    ftsReady = true;
  } catch (error) {
    ftsReady = false;
  }
  return ftsReady;
}

function deleteFileRows(bookId, group, name) {
  const rows = q(`SELECT id FROM kb_chunks WHERE book_id=? AND group_name=? AND file_name=?`, bookId, group, name);
  if (ensureFts()) {
    run(`DELETE FROM kb_chunks_fts WHERE book_id=? AND group_name=? AND file_name=?`, bookId, group, name);
  }
  run(`DELETE FROM kb_chunks WHERE book_id=? AND group_name=? AND file_name=?`, bookId, group, name);
  run(`DELETE FROM kb_files WHERE book_id=? AND group_name=? AND file_name=?`, bookId, group, name);
  if (rows.length) {
    const placeholders = rows.map(() => '?').join(',');
    run(`DELETE FROM kb_embeddings WHERE chunk_id IN (${placeholders})`, ...rows.map((row) => row.id));
  }
  return rows.map((row) => row.id);
}

function removeFile({ bookId, group, name }) {
  let removedIds = [];
  transaction(() => { removedIds = deleteFileRows(bookId, group, name); });
  for (const id of removedIds) vectorCache.delete(id);
  dropMatrix(bookId);
  return { ok: true };
}

function markEngine(bookId) {
  run(`INSERT INTO kb_meta(book_id, engine, indexed_at) VALUES(?,?,?)
    ON CONFLICT(book_id) DO UPDATE SET engine=excluded.engine, indexed_at=excluded.indexed_at`,
  String(bookId), ENGINE, Date.now());
}

function needsRebuild(bookId) {
  const meta = one(`SELECT engine FROM kb_meta WHERE book_id=?`, String(bookId));
  if (meta) return meta.engine !== ENGINE;
  // 没有元数据但已有片段，说明是旧版索引，需要按新引擎重建。
  return !!one(`SELECT 1 AS present FROM kb_chunks WHERE book_id=? LIMIT 1`, String(bookId));
}

// ---------- 索引 ----------

function buildChunks({ bookId, group, name, content, dict }) {
  const chapterNum = chapterNumFromName(name);
  if (NARRATIVE_GROUPS.has(group)) {
    const location = chapterLocation(bookId, chapterNum);
    return splitScenes(content).map((text) => ({ text, kind: 'scene', chapterNum, location }));
  }
  if (SUMMARY_FILES.has(name) || group === '摘要') {
    return splitSummarySections(content).map((part) => ({
      text: part.text, kind: 'summary', chapterNum: part.chapterNum, location: '',
    }));
  }
  if (group === '细纲') {
    const text = String(content || '').trim();
    if (!text) return [];
    return [{ text, kind: 'outline', chapterNum, location: chapterLocation(bookId, chapterNum) }];
  }
  return splitChunks(content).map((text) => ({ text, kind: 'section', chapterNum: 0, location: '' }));
}

function insertChunk({ bookId, group, name, index, chunk, dict }) {
  const id = crypto.createHash('sha1').update(`${fileKey(bookId, group, name)}\u0000${index}`).digest('hex');
  const vector = vectorFor(chunk.text);
  const characters = detectCharacters(chunk.text, dict);
  const threads = detectThreads(chunk.text, dict);
  run(`INSERT INTO kb_chunks(id,book_id,group_name,file_name,chunk_index,content,vector_json,updated_at,
      chapter_num,chunk_kind,characters_json,location,threads_json,vector_blob)
      VALUES(?,?,?,?,?,?,'',?,?,?,?,?,?,?)`,
  id, bookId, group, name, index, chunk.text, Date.now(),
  Number(chunk.chapterNum || 0), String(chunk.kind || ''),
  JSON.stringify(characters), String(chunk.location || ''), JSON.stringify(threads), encodeVector(vector));
  if (ensureFts()) {
    run(`INSERT INTO kb_chunks_fts(chunk_id,book_id,group_name,file_name,content) VALUES(?,?,?,?,?)`,
      id, bookId, group, name, chunk.text);
  }
  vectorCache.delete(id);
  vectorCache.set(id, vector);
  return id;
}

function indexFile({ bookId, group, name, content, mtime = Date.now() }) {
  if (!bookId || !group || !name) return { ok: false, chunks: 0 };
  const source = String(content || '');
  const hash = fileHash(source);
  const previous = one(`SELECT content_hash FROM kb_files WHERE book_id=? AND group_name=? AND file_name=?`, bookId, group, name);
  if (previous && previous.content_hash === hash) {
    run(`UPDATE kb_files SET source_mtime=?, indexed_at=? WHERE book_id=? AND group_name=? AND file_name=?`, mtime, Date.now(), bookId, group, name);
    return { ok: true, skipped: true, chunks: 0 };
  }
  const dict = dictionaries(bookId);
  const chunks = buildChunks({ bookId, group, name, content: source, dict });
  const removedIds = [];
  transaction(() => {
    removedIds.push(...deleteFileRows(bookId, group, name));
    for (let index = 0; index < chunks.length; index++) {
      insertChunk({ bookId, group, name, index, chunk: chunks[index], dict });
    }
    run(`INSERT INTO kb_files(book_id,group_name,file_name,source_mtime,content_hash,chunk_count,indexed_at)
         VALUES(?,?,?,?,?,?,?)`, bookId, group, name, mtime, hash, chunks.length, Date.now());
  });
  for (const id of removedIds) vectorCache.delete(id);
  dropMatrix(bookId);
  markEngine(bookId);
  return { ok: true, chunks: chunks.length };
}

// 追加一节不影响之前的切片边界，因此只索引新尾巴；无法确定边界时回退全量。
function appendIndex({ bookId, group, name, content, mtime = Date.now() }) {
  if (!bookId || !group || !name) return { ok: false, chunks: 0, needsFullIndex: true };
  const indexed = one(`SELECT chunk_count FROM kb_files
    WHERE book_id=? AND group_name=? AND file_name=?`, bookId, group, name);
  if (!indexed) return { ok: false, chunks: 0, needsFullIndex: true };
  const actual = one(`SELECT COUNT(*) AS count, COALESCE(MAX(chunk_index), -1) AS max_index
    FROM kb_chunks WHERE book_id=? AND group_name=? AND file_name=?`, bookId, group, name) || {};
  const actualCount = Number(actual.count || 0);
  const maxIndex = Number(actual.max_index ?? -1);
  if (actualCount !== Number(indexed.chunk_count || 0) || actualCount !== maxIndex + 1) {
    return { ok: false, chunks: 0, needsFullIndex: true };
  }
  const tail = String(content || '');
  if (!tail.trim()) return { ok: true, skipped: true, chunks: 0 };
  // 摘要必须整章追加，否则新旧边界会错位。
  if (SUMMARY_FILES.has(name) && actualCount > 0 && !/^#{1,4}\s*第\s*\d+\s*章/m.test(tail)) {
    return { ok: false, chunks: 0, needsFullIndex: true };
  }
  const dict = dictionaries(bookId);
  const chunks = buildChunks({ bookId, group, name, content: tail, dict });
  if (!chunks.length) return { ok: true, skipped: true, chunks: 0 };
  const nextIndex = maxIndex + 1;
  transaction(() => {
    for (let offset = 0; offset < chunks.length; offset++) {
      insertChunk({ bookId, group, name, index: nextIndex + offset, chunk: chunks[offset], dict });
    }
    const chunkCount = Number(indexed.chunk_count || 0) + chunks.length;
    run(`UPDATE kb_files SET source_mtime=?, content_hash=?, chunk_count=?, indexed_at=?
      WHERE book_id=? AND group_name=? AND file_name=?`,
    mtime, `append:${mtime}:${chunkCount}`, chunkCount, Date.now(), bookId, group, name);
  });
  markEngine(bookId);
  dropMatrix(bookId);
  return { ok: true, chunks: chunks.length, appended: true };
}

function indexBookFiles(bookId, { force = false } = {}) {
  const core = require('./handlers-core');
  const present = new Set();
  let files = 0;
  let chunks = 0;
  for (const group of core.scanTree({ bookId })) {
    for (const file of group.files) {
      if (file.aiOff) continue;
      const key = fileKey(bookId, group.groupDir, file.name);
      present.add(key);
      const known = one(`SELECT source_mtime FROM kb_files WHERE book_id=? AND group_name=? AND file_name=?`, bookId, group.groupDir, file.name);
      if (!force && known && Number(known.source_mtime) === Math.floor(file.ts || 0)) continue;
      const result = indexFile({
        bookId, group: group.groupDir, name: file.name,
        content: core.readFileFrom({ bookId, group: group.groupDir, name: file.name }),
        mtime: Math.floor(file.ts || Date.now()),
      });
      files++;
      chunks += result.chunks || 0;
    }
  }
  for (const row of q(`SELECT group_name,file_name FROM kb_files WHERE book_id=?`, bookId)) {
    if (!present.has(fileKey(bookId, row.group_name, row.file_name))) {
      removeFile({ bookId, group: row.group_name, name: row.file_name });
    }
  }
  return { files, chunks };
}

function rebuildBook({ bookId } = {}) {
  if (!bookId) throw new Error('缺少 bookId');
  for (const row of q(`SELECT id FROM kb_chunks WHERE book_id=?`, bookId)) vectorCache.delete(row.id);
  transaction(() => {
    if (ensureFts()) run(`DELETE FROM kb_chunks_fts WHERE book_id=?`, bookId);
    run(`DELETE FROM kb_chunks WHERE book_id=?`, bookId);
    run(`DELETE FROM kb_files WHERE book_id=?`, bookId);
    run(`DELETE FROM kb_embeddings WHERE book_id=?`, bookId);
  });
  invalidateDictionaries(bookId);
  dropMatrix(bookId);
  try { refreshAliases(bookId, { force: true }); } catch (error) { /* 无人物库时忽略 */ }
  const result = indexBookFiles(bookId, { force: true });
  markEngine(bookId);
  bookSyncAt.set(bookId, Date.now());
  return result;
}

function syncBook(bookId, { force = false } = {}) {
  if (!bookId) return { files: 0, chunks: 0 };
  try { refreshAliases(bookId, { force }); } catch (error) { /* 别称刷新失败不影响索引 */ }
  if (needsRebuild(bookId)) return rebuildBook({ bookId });
  const lastSync = Number(bookSyncAt.get(bookId) || 0);
  if (!force && Date.now() - lastSync < SYNC_TTL_MS) return { files: 0, chunks: 0, cached: true };
  const result = indexBookFiles(bookId, { force });
  bookSyncAt.set(bookId, Date.now());
  return result;
}

function removeBook(bookId) {
  bookSyncAt.delete(bookId);
  invalidateDictionaries(bookId);
  dropMatrix(bookId);
  for (const row of q(`SELECT id FROM kb_chunks WHERE book_id=?`, bookId)) vectorCache.delete(row.id);
  transaction(() => {
    if (ensureFts()) run(`DELETE FROM kb_chunks_fts WHERE book_id=?`, bookId);
    run(`DELETE FROM kb_chunks WHERE book_id=?`, bookId);
    run(`DELETE FROM kb_files WHERE book_id=?`, bookId);
    run(`DELETE FROM kb_meta WHERE book_id=?`, bookId);
    run(`DELETE FROM entity_aliases WHERE book_id=?`, bookId);
  });
}

// ---------- 检索 ----------

function parseJsonArray(value) {
  try { return JSON.parse(value || '[]'); } catch { return []; }
}

function lexicalIds(bookId, terms, before, limit) {
  if (!ensureFts() || !terms.length) return new Map();
  try {
    const match = terms.map((term) => `"${String(term).replace(/"/g, '""')}"`).join(' OR ');
    const rows = before
      ? q(`SELECT f.chunk_id, f.rank FROM kb_chunks_fts f JOIN kb_chunks c ON c.id=f.chunk_id
          WHERE kb_chunks_fts MATCH ? AND f.book_id=? AND c.chapter_num<? ORDER BY f.rank LIMIT ?`,
      match, bookId, before, limit)
      : q(`SELECT f.chunk_id, f.rank FROM kb_chunks_fts f
          WHERE kb_chunks_fts MATCH ? AND f.book_id=? ORDER BY f.rank LIMIT ?`,
      match, bookId, limit);
    const ranks = new Map();
    rows.forEach((row, index) => ranks.set(row.chunk_id, Math.abs(Number(row.rank) || 0) + index * 0.01));
    return ranks;
  } catch (error) {
    return new Map();
  }
}

// 进程内向量矩阵：整本书的向量一次性读进连续 Float32Array，之后每次检索只做内存点积。
// 打分不再把整张 kb_chunks 表连同正文读一遍，正文只按入选 id 取一次。
// 一本百万字长篇约 1600 个片段、1.6MB 向量，矩阵驻留成本很低；
// 真正要防的是多本书累计把进程撑爆，所以用全局字节预算 + LRU，而不是"超限就不缓存"。
// 超限就不缓存会让大书每次检索都重新装载矩阵，那才是真正的性能悬崖。
const MATRIX_MEMORY_BUDGET = 192 * 1024 * 1024;
// 版本校验本身也是一次聚合查询，短时间内的连续检索没必要重复做。
const MATRIX_TTL_MS = 500;
const matrixCache = new Map();
let matrixBytes = 0;
const debugCounters = { matrixLoads: 0, versionChecks: 0, matrixEvictions: 0 };

function chunksVersion(bookId) {
  debugCounters.versionChecks += 1;
  const row = one(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),0) AS m FROM kb_chunks WHERE book_id=?`, bookId);
  let version = `${Number(row?.n || 0)}:${Number(row?.m || 0)}`;
  // 语义向量的覆盖进度也算进版本：填充跨过"全覆盖"门槛时矩阵要重建出语义层。
  const emb = embeddingConfig()
    ? one(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),0) AS m FROM kb_embeddings WHERE book_id=?`, bookId)
    : null;
  if (emb) version += `|emb:${Number(emb.n || 0)}:${Number(emb.m || 0)}`;
  return version;
}

function buildMatrix(rows) {
  const size = rows.length;
  const vectors = new Float32Array(size * DIMENSIONS);
  const ids = new Array(size);
  const chapters = new Int32Array(size);
  const groups = new Uint8Array(size);
  const groupNames = [];
  const groupPos = new Map();
  const charIndex = new Map();
  const threadIndex = new Map();
  // 语义层：只有全书片段都有同维度向量时才启用，否则整本回落哈希引擎。
  let embedDim = 0;
  let embedComplete = size > 0;
  for (const row of rows) {
    if (!row.embed_blob || !Number(row.embed_dim)) { embedComplete = false; break; }
    if (!embedDim) embedDim = Number(row.embed_dim);
    else if (embedDim !== Number(row.embed_dim)) { embedComplete = false; break; }
  }
  const embedVectors = embedComplete ? new Float32Array(size * embedDim) : null;
  const push = (map, key, index) => {
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(index);
  };
  rows.forEach((row, index) => {
    ids[index] = row.id;
    chapters[index] = Number(row.chapter_num) || 0;
    let position = groupPos.get(row.group_name);
    if (position === undefined) {
      position = groupNames.length;
      groupPos.set(row.group_name, position);
      groupNames.push(row.group_name);
    }
    groups[index] = position;
    const vector = decodeVectorBuffer(row.vector_blob) || decodeJsonVector(row.vector_json);
    if (vector) vectors.set(vector, index * DIMENSIONS);
    if (embedVectors) {
      const embed = decodeEmbed(row.embed_blob, embedDim);
      if (embed) embedVectors.set(embed, index * embedDim);
      else embedComplete = false;
    }
    for (const name of parseJsonArray(row.characters_json)) push(charIndex, name, index);
    for (const key of parseJsonArray(row.threads_json)) push(threadIndex, key, index);
  });
  return { size, ids, vectors, chapters, groups, groupNames, charIndex, threadIndex,
    emb: embedComplete && embedVectors ? { dim: embedDim, vectors: embedVectors } : null };
}

function matrixBytesOf(data) {
  return data.vectors.byteLength + data.chapters.byteLength + data.groups.byteLength + data.ids.length * 16;
}

// 重新插入到 Map 末尾即视为"最近使用"，迭代顺序就是 LRU 顺序。
function touchMatrix(key, entry) {
  matrixCache.delete(key);
  matrixCache.set(key, entry);
}

function rememberMatrix(key, version, data) {
  const entry = { version, data, checkedAt: Date.now(), bytes: matrixBytesOf(data) };
  const previous = matrixCache.get(key);
  if (previous) matrixBytes -= previous.bytes;
  matrixCache.delete(key);
  matrixCache.set(key, entry);
  matrixBytes += entry.bytes;
  for (const [otherKey, other] of matrixCache) {
    if (matrixBytes <= MATRIX_MEMORY_BUDGET) break;
    if (otherKey === key) continue; // 刚装载的这本即使独自超预算也保留，否则每次检索都要重装。
    matrixCache.delete(otherKey);
    matrixBytes -= other.bytes;
    debugCounters.matrixEvictions += 1;
  }
}

function matrixFor(bookId) {
  const key = String(bookId);
  const cached = matrixCache.get(key);
  if (cached && Date.now() - cached.checkedAt < MATRIX_TTL_MS) {
    touchMatrix(key, cached);
    return cached.data;
  }
  const version = chunksVersion(key);
  if (cached && cached.version === version) {
    cached.checkedAt = Date.now();
    touchMatrix(key, cached);
    return cached.data;
  }
  debugCounters.matrixLoads += 1;
  const config = embeddingConfig();
  let rows;
  if (config) {
    rows = q(`SELECT c.id, c.chapter_num, c.group_name, c.characters_json, c.threads_json,
        c.vector_blob, c.vector_json, e.vector AS embed_blob, e.dim AS embed_dim
      FROM kb_chunks c LEFT JOIN kb_embeddings e ON e.chunk_id=c.id AND e.model=?
      WHERE c.book_id=?`, config.model, key);
  } else {
    rows = q(`SELECT id, chapter_num, group_name, characters_json, threads_json, vector_blob, vector_json
      FROM kb_chunks WHERE book_id=?`, key);
  }
  const data = buildMatrix(rows);
  rememberMatrix(key, version, data);
  return data;
}

function dropMatrix(bookId) {
  const key = String(bookId || '');
  const entry = matrixCache.get(key);
  if (!entry) return;
  matrixBytes -= entry.bytes;
  matrixCache.delete(key);
}

// 整库重置后必须清空所有进程内缓存，否则会拿到已删除书目的残留。
function clearCache() {
  matrixCache.clear();
  matrixBytes = 0;
  vectorCache.clear();
  bookSyncAt.clear();
  dictCache.clear();
  aliasSyncAt.clear();
  primedBooks.clear();
}

function dotAt(vectors, index, needle, dim = DIMENSIONS) {
  const base = index * dim;
  let sum = 0;
  for (let i = 0; i < dim; i++) sum += vectors[base + i] * needle[i];
  return sum;
}

const GROUP_BOOST = { 设定: 0.08, 细纲: 0.05, 正文: 0.02, 参考: 0 };

function retrieve({ bookId, query, limit = 8, maxChars, maxTokens, beforeChapter = 0, groups = null, queryVector = null } = {}) {
  if (!bookId || !String(query || '').trim()) return [];
  syncBook(bookId);
  const dict = dictionaries(bookId);
  const expanded = expandQuery(query, dict);
  const terms = searchTerms(expanded, 18);
  const needle = vectorFor(expanded);
  const before = Math.max(0, Number(beforeChapter) || 0);
  const wanted = Math.max(1, Number(limit) || 8);
  const budgetChars = Math.max(400, Number(maxChars) || (maxTokens ? Math.ceil(Number(maxTokens) * CHARS_PER_TOKEN) : MAX_RETRIEVAL_CHARS));
  const budgetTokens = maxTokens ? Math.max(200, Number(maxTokens)) : Math.ceil(budgetChars / CHARS_PER_TOKEN);
  const groupFilter = Array.isArray(groups) && groups.length ? new Set(groups) : null;

  const matrix = matrixFor(bookId);
  if (!matrix.size) return [];
  // 语义路径：查询向量与矩阵语义层维度一致才启用；否则向量分量用哈希余弦。
  const useSemantic = !!(queryVector && matrix.emb && matrix.emb.dim === queryVector.length);
  const embDim = matrix.emb ? matrix.emb.dim : 0;

  const ranks = lexicalIds(bookId, terms, before, Math.min(600, Math.max(120, wanted * 40)));
  const queryCharacters = detectCharacters(String(query), dict);
  const queryThreads = dict.threads.filter((thread) => String(query).includes(thread.probe)).map((thread) => thread.key);
  const charSets = queryCharacters.map((name) => matrix.charIndex.get(name)).filter(Boolean);
  const threadSets = queryThreads.map((key) => matrix.threadIndex.get(key)).filter(Boolean);

  // 第一阶段：纯内存打分，不碰正文。
  const scored = [];
  for (let index = 0; index < matrix.size; index++) {
    const chapterNum = matrix.chapters[index];
    if (before && chapterNum >= before) continue;
    const groupName = matrix.groupNames[matrix.groups[index]];
    if (groupFilter && !groupFilter.has(groupName)) continue;
    const id = matrix.ids[index];
    const rank = ranks.get(id);
    const cosine = Math.max(0, useSemantic
      ? dotAt(matrix.emb.vectors, index, queryVector, embDim)
      : dotAt(matrix.vectors, index, needle));
    const lexical = rank == null ? 0 : 1 / (1 + rank);
    const entity = charSets.length
      ? charSets.reduce((count, set) => count + (set.has(index) ? 1 : 0), 0) / queryCharacters.length
      : 0;
    const thread = threadSets.some((set) => set.has(index)) ? 1 : 0;
    const recency = before && chapterNum > 0
      ? Math.max(0, 1 - Math.min(1, Math.abs(before - 1 - chapterNum) / 120))
      : 0;
    const score = 0.50 * cosine + 0.25 * lexical + (GROUP_BOOST[groupName] || 0) +
      0.10 * entity + 0.05 * thread + 0.05 * recency;
    // 纯向量路径分数过低说明只是共享了常见字，没必要进候选。
    if (rank == null && score < 0.04) continue;
    scored.push({ id, score });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => b.score - a.score);

  // 第二阶段：只对入选片段取一次正文与元数据。
  const shortlist = scored.slice(0, Math.max(wanted * 4, 24));
  const details = new Map();
  const idList = shortlist.map((item) => item.id);
  for (let offset = 0; offset < idList.length; offset += 200) {
    const slice = idList.slice(offset, offset + 200);
    const placeholders = slice.map(() => '?').join(',');
    for (const row of q(`SELECT id, group_name, file_name, chunk_index, chapter_num, characters_json,
        location, threads_json, content FROM kb_chunks WHERE id IN (${placeholders})`, ...slice)) {
      details.set(row.id, row);
    }
  }

  const perFile = new Map();
  const seenText = new Set();
  const picked = [];
  let chars = 0;
  let tokensUsed = 0;
  for (const item of shortlist) {
    const row = details.get(item.id);
    if (!row) continue;
    const content = row.content;
    if (!content) continue;
    const key = row.group_name + '\u0000' + row.file_name;
    const used = perFile.get(key) || 0;
    if (used >= MAX_PER_FILE) continue;
    const fingerprint = content.slice(0, 60);
    if (seenText.has(fingerprint)) continue;
    const cost = content.length;
    if (chars + cost > budgetChars) continue;
    const tokenCost = estimateTokens(content);
    if (tokensUsed + tokenCost > budgetTokens) continue;
    perFile.set(key, used + 1);
    seenText.add(fingerprint);
    chars += cost;
    tokensUsed += tokenCost;
    picked.push({
      group: row.group_name,
      name: row.file_name,
      chunkIndex: Number(row.chunk_index),
      chapterNum: Number(row.chapter_num) || 0,
      characters: parseJsonArray(row.characters_json),
      location: row.location || '',
      threads: parseJsonArray(row.threads_json),
      content,
      score: Number(item.score.toFixed(4)),
    });
    if (picked.length >= wanted) break;
  }
  return picked;
}

function retrievalText({ bookId, query, limit, maxChars, maxTokens, beforeChapter, queryVector }) {
  const matches = retrieve({ bookId, query, limit, maxChars, maxTokens, beforeChapter, queryVector });
  if (!matches.length) return '';
  return matches.map((item) => {
    const meta = [`${item.group}/${item.name}`, `片段 ${item.chunkIndex + 1}`];
    if (item.chapterNum) meta.push(`第${item.chapterNum}章`);
    if (item.location) meta.push(`地点：${item.location}`);
    if (item.characters.length) meta.push(`人物：${item.characters.slice(0, 4).join('、')}`);
    return `# 自动召回 · ${meta.join(' · ')}\n${item.content}`;
  }).join('\n\n');
}

function embeddingStatus({ bookId } = {}) {
  const config = embeddingConfig();
  const base = {
    model: config ? config.model : '',
    configured: !!config,
    baseUrl: config ? config.baseUrl : '',
    available: !!config && embedAvailable(),
    coolingDown: !!config && !embedAvailable(),
    lastError: embedFailure ? embedFailure.message : '',
  };
  if (!bookId) {
    const total = Number(one(`SELECT COUNT(*) AS n FROM kb_chunks`).n || 0);
    const embedded = Number(one(`SELECT COUNT(*) AS n FROM kb_embeddings`).n || 0);
    return { ...base, embedded, total, coverage: total ? Math.round(embedded / total * 100) / 100 : 1 };
  }
  const total = Number(one(`SELECT COUNT(*) AS n FROM kb_chunks WHERE book_id=?`, bookId)?.n || 0);
  const row = config
    ? one(`SELECT COUNT(*) AS n, COALESCE(MAX(dim),0) AS dim, COALESCE(MAX(model),'') AS model
        FROM kb_embeddings WHERE book_id=? AND model=?`, bookId, config.model)
    : null;
  const embedded = Number(row?.n || 0);
  return { ...base, embedded, total, dim: Number(row?.dim || 0),
    coverage: total ? Math.round(embedded / total * 100) / 100 : 1 };
}

function stats({ bookId } = {}) {
  const where = bookId ? ' WHERE book_id=?' : '';
  const params = bookId ? [bookId] : [];
  const files = q(`SELECT COUNT(*) AS count FROM kb_files${where}`, ...params)[0].count;
  const chunks = q(`SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(content)),0) AS chars FROM kb_chunks${where}`, ...params)[0];
  const scenes = bookId
    ? Number(one(`SELECT COUNT(*) AS n FROM kb_chunks WHERE book_id=? AND chunk_kind='scene'`, bookId).n || 0)
    : Number(one(`SELECT COUNT(*) AS n FROM kb_chunks WHERE chunk_kind='scene'`).n || 0);
  const aliases = bookId
    ? Number(one(`SELECT COUNT(*) AS n FROM entity_aliases WHERE book_id=?`, bookId).n || 0)
    : Number(one(`SELECT COUNT(*) AS n FROM entity_aliases`).n || 0);
  return {
    engine: ENGINE, dimensions: DIMENSIONS, chunkChars: CHUNK_CHARS, chunkOverlap: CHUNK_OVERLAP,
    sceneChunkChars: SCENE_MAX_CHARS, files, chunks: chunks.count, scenes, aliases,
    indexedChars: chunks.chars, estimatedTokens: Math.ceil(Number(chunks.chars || 0) / CHARS_PER_TOKEN),
    embedding: embeddingStatus({ bookId }),
  };
}

module.exports = {
  ENGINE,
  indexFile, appendIndex, removeFile, syncBook, retrieve, retrievalText, rebuildBook, removeBook, stats,
  refreshAliases, expandQuery, parseAliases, clearCache, debugCounters,
  vectorFor, splitChunks, splitScenes, splitSummarySections, searchTerms, estimateTokens,
  embeddingConfig, embeddingStatus, ensureEmbeddings, embedQuery, prepareRetrieval, primeEmbeddings,
  resetEmbeddingFailures,
};
