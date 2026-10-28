'use strict';

// 文档上下文引擎：让「百万字语料」在每一节写作时都真的用得上，同时保证提示词有界。
//
// 背景：文档工作台原来每节只注入约 2000 字素材（`MATERIAL_BUDGET_CHARS`）+ 2600 字前文要点。
// 一份十万字的调研材料、三十万字的政策汇编、百万字的年报合集，被压成 2000 字——
// 相当于把 98% 的证据扔掉，然后要求模型「写出有依据的稿子」。这就是「上下文能力差」的根。
//
// 但反过来「把百万字塞进提示词」是错的解法：
//   1. 成本线性爆炸（百万汉字 ≈ 60~70 万 token）；
//   2. 质量反而下降——长上下文中段的信息会被系统性忽略（lost in the middle），
//      模型看得见却不使用，等于花钱买噪音。
//
// 正确做法是「语料百万级 + 上下文分层预算」：语料全量索引，每节按需检索，
// 送进提示词的是**经过排序、去重、按预算装配**的几万字，而不是全部。
//
// 分层结构（越靠前越稳定，越靠后越贴题）：
//   L1 文档记忆   —— 已立论点、已用数据、章节术语（恒定 ~3k，不随语料增长）
//   L2 相关证据   —— 多查询混合检索出的连续片段（8k~30k，按深度档位）
//   L3 语料地图   —— 全语料索引概览，让模型知道「还有什么没被检索到」（~1.5k）
//   L4 邻近上下文 —— 核心来源的相邻段落，避免碎片化引用（~4k）
//
// 与小说工作台的关系：**只借原语，不共用状态**。
//   - 复用 `lib/vector-store.js` 的哈希向量（`vectorFor`）与 token 估算——纯函数，无副作用；
//   - 不复用 `syncBook` / `retrieve`：它们绑在「书 + 磁盘文件」上，文档没有那套结构；
//   - 索引表 `doc_corpus`、缓存、预算全部独立，小说侧的 `kb_chunks` 与检索链路一行不动。

const crypto = require('node:crypto');
const { q, run, transaction } = require('./db');
const retrieval = require('./doc-retrieval');

// 复用小说的向量原语。取不到时用本文件内的同算法实现兜底——
// 文档工作台不能因为小说侧改了导出就写不出稿子。
let novelVector = null;
try { novelVector = require('./vector-store'); } catch { novelVector = null; }

const VECTOR_DIM = 256;

// 切片长度：700 字。比小说的 1400 小一半——文档引用要的是「一段完整论述」，
// 不是「一个场景」，块太大时检索命中的片段里会混进无关段落，反而降低依据密度。
const CHUNK_CHARS = 700;
// 单项目索引上限：约 300 万字。超过只提示、不拒绝（作者可能真的在整理全集）。
const MAX_CORPUS_CHARS = 3000000;
// 第一阶段（向量粗筛）保留的候选数。80 足够覆盖多主题长文档，
// 又不会让第二阶段精排的代价随语料线性增长。
const STAGE1_CANDIDATES = 80;
// 同一素材最多贡献几块：允许 3 块，既保证长文档能给出连续论证，
// 又避免一条素材挤掉其他来源（依据单一是审稿人最先挑的毛病）。
const MAX_CHUNKS_PER_MATERIAL = 3;

// ---------- 向量（与小说侧同算法，仅作兜底） ----------

function localTokens(text) {
  const clean = String(text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').toLowerCase();
  const out = [];
  for (let i = 0; i < clean.length - 1; i++) out.push(clean.slice(i, i + 2));
  return out;
}

function localVectorFor(text) {
  const vector = new Float32Array(VECTOR_DIM);
  for (const token of localTokens(text)) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash = hash >>> 0;
    vector[hash % VECTOR_DIM] += (hash & 0x100) === 0 ? 1 : -1;
  }
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= norm;
  return vector;
}

function vectorOf(text) {
  const fn = novelVector && typeof novelVector.vectorFor === 'function' ? novelVector.vectorFor : localVectorFor;
  try {
    const vector = fn(text);
    if (vector && vector.length === VECTOR_DIM) return vector;
  } catch { /* 落到本地实现 */ }
  return localVectorFor(text);
}

function encodeVector(vector) {
  const buffer = Buffer.allocUnsafe(VECTOR_DIM * 4);
  for (let i = 0; i < VECTOR_DIM; i++) buffer.writeFloatLE(vector[i] || 0, i * 4);
  return buffer;
}

function decodeVector(blob) {
  if (!blob) return null;
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buffer.length !== VECTOR_DIM * 4) return null;
  const vector = new Float32Array(VECTOR_DIM);
  for (let i = 0; i < VECTOR_DIM; i++) vector[i] = buffer.readFloatLE(i * 4);
  return vector;
}

function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0;
  for (let i = 0; i < VECTOR_DIM; i++) dot += a[i] * b[i];
  return dot;
}

// ---------- 切片 ----------

// 去重要用的二元字组与相似度。和 doc-quality 里的实现同口径（那里用于跨节查重），
// 这里不直接 require 是为了避免上下文引擎反向依赖质量模块。
function bigramsOf(text) {
  const clean = String(text || '').replace(/[\s\u3000]/g, '');
  const set = new Set();
  for (let i = 0; i + 2 <= clean.length; i++) set.add(clean.slice(i, i + 2));
  return set;
}

function similarityOf(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const gram of a) if (b.has(gram)) hit += 1;
  return hit / Math.min(a.size, b.size);
}

// 数字签名：一段文字里出现的所有数字。
//
// 去重不能只看文字相似度。两份年报的模板段落措辞一模一样、只有数据不同，
// 相似度会轻松超过 0.82——按相似度去重就把第二份的真实数据丢掉了。
// 「文字相同但数字不同」不是重复，是**同一模板下的不同事实**，必须都保留。
function numberSignature(text) {
  const set = new Set();
  for (const matched of String(text || '').matchAll(/\d+(?:\.\d+)?/g)) set.add(matched[0]);
  return set;
}

function sameNumbers(a, b) {
  if (!a || !b) return false;
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

// 「这两段算不算重复」的判据。
//
// 只用文字相似度是错的：公文、年报、政策文件大量使用同一套模板句
//（「围绕X的Y展开讨论，涉及工艺参数、供应链配套、检测方法…」），
// 模板一样但主题不同的两段话，二元字组相似度轻松到 0.9——
// 按 0.9 一刀切，会把「精密机床」和「冷链物流」判成重复，
// 整块领域从上下文里消失，而作者只会觉得「模型怎么没提这个方面」。
//
// 所以判据必须以**数据**为主、文字为辅：
//   1. 两段都带数字且数字完全相同 → 同一组数据换了说法，算重复（≥0.85 即可）；
//   2. 两段都没有数字 → 只能靠文字：几乎逐字相同（≥0.97）才算重复；
//   3. 数字不同 → 一律不算重复（同一模板下的不同事实，必须都保留）。
function isDuplicate(grams, numbers, other) {
  const sim = similarityOf(grams, other.grams);
  const otherNumbers = other.numbers || new Set();
  const hasNumbers = numbers.size > 0 && otherNumbers.size > 0;
  if (hasNumbers) {
    if (sameNumbers(numbers, otherNumbers) && sim >= 0.85) return true;
    return false;
  }
  return sim >= 0.97;
}

function hashOf(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 16);
}

// 段落优先切片：文档的证据单元是「一个自然段/一个小标题下的内容」，
// 按固定字数硬切会把一句话劈成两半，引用时读起来是断的。
function splitCorpus(content, size = CHUNK_CHARS) {
  const paragraphs = String(content || '').split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let buffer = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > size * 1.6) {
      if (buffer) { chunks.push(buffer); buffer = ''; }
      for (let i = 0; i < paragraph.length; i += size) {
        const piece = paragraph.slice(i, i + size).trim();
        if (piece) chunks.push(piece);
      }
      continue;
    }
    if (buffer && buffer.length + paragraph.length + 1 > size) { chunks.push(buffer); buffer = ''; }
    buffer += (buffer ? '\n' : '') + paragraph;
  }
  if (buffer) chunks.push(buffer);
  // 极长且没有段落分隔的文本（粘贴的 PDF 全文）走兜底硬切
  if (!chunks.length && String(content || '').trim()) {
    const text = String(content).trim();
    for (let i = 0; i < text.length; i += size) {
      const piece = text.slice(i, i + size).trim();
      if (piece) chunks.push(piece);
    }
  }
  return chunks;
}

// ---------- 索引 ----------

// 增量索引：素材内容哈希与块数都没变就跳过。
// 百万字语料重建一次要切 1500 块并算 1500 个向量，每节都重建是不可接受的。
function syncCorpus(projectId, { force = false } = {}) {
  const key = String(projectId || '');
  const empty = { chunks: 0, rebuilt: 0, skipped: 0, chars: 0, materials: 0 };
  if (!key) return empty;
  const materials = q(`SELECT id, title, content FROM doc_materials WHERE project_id=? ORDER BY seq`, key);
  if (!materials.length) {
    run(`DELETE FROM doc_corpus WHERE project_id=?`, key);
    return empty;
  }
  const existing = new Map();
  for (const row of q(`SELECT material_id, hash, COUNT(*) AS n FROM doc_corpus WHERE project_id=? GROUP BY material_id, hash`, key)) {
    existing.set(String(row.material_id), { hash: String(row.hash || ''), count: Number(row.n) || 0 });
  }
  const alive = new Set(materials.map((item) => String(item.id)));
  let rebuilt = 0;
  let skipped = 0;
  let chunks = 0;
  let chars = 0;
  transaction(() => {
    // 素材被删了，它的块也要删——否则检索会引用到一条已经不存在的素材编号
    for (const materialId of existing.keys()) {
      if (alive.has(materialId)) continue;
      run(`DELETE FROM doc_corpus WHERE project_id=? AND material_id=?`, key, materialId);
    }
    for (const material of materials) {
      const materialId = String(material.id);
      const text = String(material.content || '');
      const hash = hashOf(text);
      const prev = existing.get(materialId);
      // 先比哈希再切片：内容没变就不必重新切一遍。
      // 百万字语料切一次要遍历 100 万字，而哈希比对是线性的字符串运算——
      // 每节写作都会调到这里，这个顺序直接决定「有没有白花的 CPU」。
      if (!force && prev && prev.hash === hash) {
        skipped += 1;
        chunks += prev.count;
        chars += text.length;
        continue;
      }
      const parts = splitCorpus(text);
      run(`DELETE FROM doc_corpus WHERE project_id=? AND material_id=?`, key, materialId);
      const stamp = Date.now();
      const title = String(material.title || '素材');
      for (let ord = 0; ord < parts.length; ord++) {
        const part = parts[ord];
        run(`INSERT INTO doc_corpus(project_id,material_id,ord,title,text,hash,chars,vector,indexed_at)
             VALUES(?,?,?,?,?,?,?,?,?)`,
          key, materialId, ord, title, part, hash, part.length, encodeVector(vectorOf(part)), stamp);
      }
      rebuilt += 1;
      chunks += parts.length;
      chars += text.length;
    }
  });
  return { chunks, rebuilt, skipped, chars, materials: materials.length };
}

function corpusStats(projectId) {
  const key = String(projectId || '');
  const row = q(`SELECT COUNT(*) AS chunks, COALESCE(SUM(chars),0) AS chars,
      COALESCE(MAX(indexed_at),0) AS at, COUNT(DISTINCT material_id) AS materials
    FROM doc_corpus WHERE project_id=?`, key)[0] || {};
  return {
    chunks: Number(row.chunks) || 0,
    chars: Number(row.chars) || 0,
    materials: Number(row.materials) || 0,
    indexedAt: Number(row.at) || 0,
  };
}

// 第一阶段矩阵缓存：只装「id + 位置 + 向量」，不装正文。
// 100 万字约 1500 块 × 1KB ≈ 1.5MB 常驻，换来每节检索只算一次查询向量。
const matrixCache = new Map();

function matrixFor(projectId) {
  const key = String(projectId || '');
  const stamp = q(`SELECT COUNT(*) AS n, COALESCE(MAX(indexed_at),0) AS at, COALESCE(SUM(chars),0) AS chars
    FROM doc_corpus WHERE project_id=?`, key)[0] || {};
  const version = `${Number(stamp.n) || 0}:${Number(stamp.at) || 0}:${Number(stamp.chars) || 0}`;
  const cached = matrixCache.get(key);
  if (cached && cached.version === version) return cached;
  // ORDER BY id：候选池的顺序必须稳定。
  // 不加排序时 SQLite 可能因索引选择返回不同顺序，而「余弦相同的片段」谁进候选池
  // 取决于这个顺序——同一份语料同一节，两次检索可能给出不同证据（实测偶发）。
  const rows = q(`SELECT id, material_id, ord, chars, vector FROM doc_corpus WHERE project_id=? ORDER BY id`, key)
    .map((row) => ({
      id: Number(row.id),
      materialId: String(row.material_id),
      ord: Number(row.ord) || 0,
      chars: Number(row.chars) || 0,
      vec: decodeVector(row.vector),
    }))
    .filter((row) => row.vec);
  const matrix = { version, rows, chars: Number(stamp.chars) || 0 };
  matrixCache.set(key, matrix);
  // 缓存不该无限长：超过 24 个项目就丢最早的（单机场景够用）
  if (matrixCache.size > 24) matrixCache.delete(matrixCache.keys().next().value);
  return matrix;
}

function clearCache(projectId) {
  if (projectId == null) { matrixCache.clear(); return; }
  matrixCache.delete(String(projectId));
}

// ---------- 多查询检索 ----------
//
// 一节该检索什么，不能只用标题。真正决定「这一段该引哪条素材」的是：
// 本节标题 + 本节要求 + 论题 + 段落计划里的论点 + 必答子问题。
// 单查询会漏掉其中一半——这正是「素材明明有，正文却写【待补】」的成因。

function buildQueries(project, section, plan) {
  const list = [];
  const add = (text, weight) => {
    const value = String(text || '').trim();
    if (value.length < 2) return;
    list.push({ text: value.slice(0, 200), weight });
  };
  add(section && section.title, 1.2);
  add(section && section.brief, 1.0);
  add(project.thesis, 0.8);
  for (const point of (project.points || []).slice(0, 6)) add(point, 0.7);
  const claims = (plan && Array.isArray(plan.claims)) ? plan.claims : [];
  for (const claim of claims.slice(0, 6)) {
    add(claim.goal, 1.3);
    add(claim.evidence, 0.6);
  }
  const questions = (plan && Array.isArray(plan.questions)) ? plan.questions : [];
  for (const question of questions.slice(0, 4)) add(question, 0.9);
  return list;
}

function queryVectorOf(queries) {
  const sum = new Float32Array(VECTOR_DIM);
  for (const item of queries) {
    const vector = vectorOf(item.text);
    const weight = Number(item.weight) || 1;
    for (let i = 0; i < VECTOR_DIM; i++) sum[i] += vector[i] * weight;
  }
  let norm = 0;
  for (const value of sum) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < VECTOR_DIM; i++) sum[i] /= norm;
  return sum;
}

// 稀有词的 IDF 下限：取候选池里非零 IDF 的中位数。
// 中位数而不是均值——均值会被少数极低频词拉高，导致几乎所有查询词都「不够稀有」。
function rareIdfFloor(idf) {
  const values = [...idf.values()].filter((value) => value > 0).sort((a, b) => a - b);
  if (!values.length) return Infinity;
  return values[Math.floor(values.length / 2)];
}

// 两阶段检索：
//   阶段一 —— 向量粗筛，从全语料里挑出候选（不读正文，代价与语料量线性、与块大小无关）
//   阶段二 —— 只对候选取正文做 BM25 精排（含同义扩展与标题加权）
// 这样「语料涨到百万字」只影响阶段一的循环次数，不影响提示词长度。
function retrieveEvidence(projectId, queries, { budgetChars = 12000, maxItems = 16, seedTexts = [] } = {}) {
  const matrix = matrixFor(projectId);
  if (!matrix.rows.length || !queries.length) return { items: [], pool: 0, chars: 0 };
  // 阶段一：按查询**方面**分别粗筛，而不是把整节压成一条混合向量。
  //
  // 混合向量的致命问题是「少数派主题被挤掉」：一节的论点是「精密机床」、
  // 必答问题却是「半导体材料」，混合后前者权重占绝对多数，候选池 80 条里
  // 一条半导体材料都进不来——最后写出来的稿子只回答了一半问题，
  // 而评审会以为「素材里没有」。（实测：1M 语料下确实复现，两个主题只剩一个。）
  //
  // 所以每个方面各自取 top-N 再合并：代价是几次 256 维余弦，
  // 换来的是「每个论点都有机会拿到自己的证据」。
  const aspects = queries.slice(0, 6);
  const scoredById = new Map();
  for (const aspect of aspects) {
    const vec = vectorOf(aspect.text);
    const scored = matrix.rows.map((row) => ({ row, cos: cosine(vec, row.vec) }));
    scored.sort((a, b) => b.cos - a.cos);
    const quota = Math.max(6, Math.ceil(STAGE1_CANDIDATES / Math.max(1, aspects.length)));
    for (const item of scored.slice(0, quota)) {
      const prev = scoredById.get(item.row.id);
      // 同一块被多个方面命中，取最高余弦：它同时支撑多个论点，应该优先
      if (!prev || item.cos > prev.cos) scoredById.set(item.row.id, { row: item.row, cos: item.cos });
    }
  }
  const pool = [...scoredById.values()].sort((a, b) => b.cos - a.cos)
    .slice(0, STAGE1_CANDIDATES * 2);
  const ids = pool.map((item) => item.row.id);
  if (!ids.length) return { items: [], pool: 0, chars: 0 };

  // 阶段二：取正文做 BM25
  const rows = q(`SELECT id, material_id, ord, title, text FROM doc_corpus WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const queryText = queries.map((item) => `${item.text} ${item.text}`).join(' ');
  const chunks = ids.map((id) => byId.get(id)).filter(Boolean).map((row) => ({
    key: String(row.id),
    materialId: String(row.material_id),
    ord: Number(row.ord) || 0,
    title: String(row.title || '素材'),
    text: String(row.text || ''),
  }));
  const ranked = retrieval.rank(chunks, queryText, { ratio: 0, maxChars: 1e9, maxItems: chunks.length });
  const bm25Max = ranked.reduce((max, item) => Math.max(max, item.score || 0), 0) || 1;
  const cosMax = pool.reduce((max, item) => Math.max(max, item.cos), 0) || 1;

  // 稀有词门槛：一段话与本节相关，必须至少命中一个「稀有词」。
  //
  // 为什么不能只靠分数阈值：公文、年报、政策文件大量使用同一套模板句，
  // 所有段落的 BM25 分数都挤在一起，归一化后都在 0.8 以上——
  // 0.18 的相对阈值等于没设，20 条素材会全部涌进来（实测：连「冷链物流」
  // 都能混进一份讲精密机床的稿子）。而模板词（围绕/展开/涉及/判断）本身没有区分度。
  //
  // 所以用 IDF 当门槛：把查询词里 IDF 高于候选池中位数的那些找出来（也就是本节真正的主题词），
  // 段落必须至少含一个，才算与本节相关。这比调阈值稳，因为它在不同语料上口径一致。
  const idf = retrieval.buildIdf(chunks.map((chunk) => ({
    ...chunk, grams: retrieval.gramsOf(chunk.text), titleGrams: retrieval.gramsOf(chunk.title),
  })));
  const queryWeights = retrieval.expandQuery(queryText);
  const rareGrams = [...queryWeights.keys()].filter((gram) => (idf.get(gram) || 0) >= rareIdfFloor(idf));

  // 混合打分：词面 0.6 + 向量 0.4。
  // 纯 BM25 会漏掉「换了说法」的相关段落；纯向量会把「主题相近但没数据」的段落排前面。
  const cosById = new Map(pool.map((item) => [item.row.id, item.cos]));
  const merged = ranked.map((item) => {
    const grams = retrieval.gramsOf(item.text);
    const rareHit = rareGrams.filter((gram) => grams.has(gram));
    return {
      ...item,
      rareHit: rareHit.length,
      mixed: (Number(item.score || 0) / bm25Max) * 0.6
        + (Math.max(0, cosById.get(Number(item.key)) || 0) / cosMax) * 0.4,
    };
  }).sort((a, b) => (b.rareHit - a.rareHit) || (b.mixed - a.mixed));

  // 词面完全对不上时（本节与语料没有共同用词），BM25 会给所有候选 0 分，
  // rank() 于是返回空数组——接着整节就拿不到任何证据。
  // 这时退到第一阶段的向量排序：给「最不无关」的一两条，
  // 至少能约束术语与口径；一条都不给，模型只会开始编。
  if (!merged.length) {
    for (const candidate of pool.slice(0, 3)) {
      const row = byId.get(candidate.row.id);
      if (!row) continue;
      merged.push({
        key: String(row.id),
        materialId: String(row.material_id),
        ord: Number(row.ord) || 0,
        title: String(row.title || '素材'),
        text: String(row.text || ''),
        score: 0,
        rareHit: 0,
        // 标记为兜底项：它们按定义就没通过相关性门槛，
        // 再拿门槛去筛一遍等于白兜底。
        fallback: true,
        mixed: Math.max(0, candidate.cos) / cosMax,
      });
    }
  }

  // 按素材配额选取：单条素材最多 3 块，保证依据来源多样
  const perMaterial = new Map();
  const picked = [];
  // 近似去重：真实语料里「同一段话被多份素材重复收录」很常见
  // （多份年报的模板段落、政策文件的重复条款、同一篇论文的预印本与正式版）。
  // 不去重的话，26 段名额可能全被 6 份几乎一样的素材占满——
  // 上下文看着很满，实际只有一份信息，模型还会以为「多来源互相印证」。
  // 种子：作者指定的素材已经进了上下文，检索结果里与它重复的也不必再给
  const pickedGrams = (seedTexts || []).map((text) => ({ grams: bigramsOf(text), numbers: numberSignature(text) }));
  let used = 0;
  let deduped = 0;
  for (const item of merged) {
    // 稀有词一个都没命中：这段话只是模板与本节相似，主题无关。
    // 语料很小、稀有词提不出来时（rareGrams 为空）不设这道门，否则会一条都选不上。
    // 兜底项（fallback）本来就过不了门，放行。
    if (!item.fallback) {
      if (rareGrams.length && item.rareHit === 0) continue;
      if (item.mixed < 0.12) continue;
    }
    const count = perMaterial.get(item.materialId) || 0;
    if (count >= MAX_CHUNKS_PER_MATERIAL) continue;
    if (picked.length && used + item.text.length > budgetChars) break;
    const grams = bigramsOf(item.text);
    const numbers = numberSignature(item.text);
    const duplicated = pickedGrams.some((other) => isDuplicate(grams, numbers, other));
    if (duplicated) { deduped += 1; continue; }
    perMaterial.set(item.materialId, count + 1);
    picked.push(item);
    pickedGrams.push({ grams, numbers });
    used += item.text.length;
    if (picked.length >= maxItems) break;
  }
  // 覆盖面兜底：每个查询方面至少要有一条自己的证据。
  //
  // 排序是「稀有词命中数优先」，命中多的方面会占满名额，命中少的方面可能一条都进不来——
  // 而那个方面往往正是必答问题。稿子只回答一半问题，评审却看不出是检索漏了。
  // 这里逐方面检查，缺的补一条最相关的。这是「性质保证」，不是调参：
  // 只靠阈值永远无法保证少数派主题一定被覆盖。
  for (const aspect of aspects) {
    const aspectGrams = retrieval.expandQuery(aspect.text);
    const rare = [...aspectGrams.keys()].filter((gram) => (idf.get(gram) || 0) >= rareIdfFloor(idf));
    if (!rare.length) continue;
    const covered = picked.some((item) => {
      const grams = retrieval.gramsOf(item.text);
      return rare.some((gram) => grams.has(gram));
    });
    if (covered) continue;
    const candidate = merged.find((item) => {
      if (picked.includes(item)) return false;
      const grams = retrieval.gramsOf(item.text);
      return rare.some((gram) => grams.has(gram));
    });
    if (!candidate) continue;
    picked.push(candidate);
    used += candidate.text.length;
  }

  // 一条都没过门槛：给最高分那一条。完全不给素材，模型就会开始编。
  // 但只给一条——给多了等于把「没找到相关依据」伪装成「依据充分」。
  if (!picked.length && merged.length) {
    picked.push(merged[0]);
    used = merged[0].text.length;
  }
  return { items: picked, pool: pool.length, chars: used, deduped };
}

// 核心来源的邻近段落：命中的块前后各取一块，拼成连续文本。
// 碎片引用是「看起来引了、其实没读懂」的典型：一段话被切成三块，
// 模型只看到中间那块，就敢断言作者的观点。
function adjacentBlocks(projectId, items, { budgetChars = 4000 } = {}) {  if (!items.length) return [];
  const out = [];
  let used = 0;
  for (const item of items.slice(0, 3)) {
    const rows = q(`SELECT ord, text FROM doc_corpus WHERE project_id=? AND material_id=? AND ord BETWEEN ? AND ? ORDER BY ord`,
      String(projectId), item.materialId, Math.max(0, item.ord - 1), item.ord + 1);
    if (rows.length <= 1) continue;
    const text = rows.map((row) => String(row.text || '')).join('\n');
    // 只有拼起来才有意义：单块本来就已在证据里给过了
    if (text.length <= item.text.length + 40) continue;
    if (used + text.length > budgetChars) continue;
    out.push({ materialId: item.materialId, title: item.title, text, from: rows[0].ord, to: rows[rows.length - 1].ord });
    used += text.length;
  }
  return out;
}

// ---------- 作者指定素材 ----------
//
// 「语料地图」告诉模型有哪些素材没用上，但模型没法在中途说「我要 M7 的第 3 段」。
// 所以给出一个作者可控的入口：在本节要求里写「重点用 M7」「依据 M3、M7」，
// 这些素材就被强制纳入本节证据，且优先于检索结果。
//
// 这不是锦上添花：百万字语料下，检索偶尔会漏掉作者心里最要紧的那一条，
// 而作者没法解释「为什么模型没引用它」——给一个显式入口，比调参可靠。
function focusMaterialsOf(section) {
  const text = `${(section && section.title) || ''} ${(section && section.brief) || ''}`;
  const seqs = [...new Set([...text.matchAll(/\bM(\d{1,3})\b/g)].map((matched) => Number(matched[1])))];
  return seqs.filter((seq) => seq > 0).slice(0, 4);
}

function forcedBlocks(projectId, seqs, { budgetChars = 3000 } = {}) {
  if (!seqs.length) return [];
  const rows = q(`SELECT id, seq, title FROM doc_materials WHERE project_id=? AND seq IN (${seqs.map(() => '?').join(',')})`,
    String(projectId), ...seqs);
  const out = [];
  let used = 0;
  for (const row of rows) {
    const chunks = q(`SELECT ord, title, text FROM doc_corpus WHERE project_id=? AND material_id=? ORDER BY ord LIMIT 2`,
      String(projectId), String(row.id));
    if (!chunks.length) continue;
    const text = chunks.map((chunk) => String(chunk.text || '')).join('\n');
    if (used + text.length > budgetChars && out.length) continue;
    out.push({ materialId: String(row.id), title: String(row.title || '素材'), text, ord: Number(chunks[0].ord) || 0 });
    used += text.length;
  }
  return out;
}

// ---------- 文档记忆（L1） ----------
//
// 小说侧的做法是「全书 → 分卷 → 章节」三层摘要。文档的对应物是
// 「论点链 + 已用数据 + 章节术语」：这三样决定跨节一致性，
// 而它们的长度**不随语料增长**——这正是百万字语料下还能保持一致的原因。

function documentMemory(project, uptoIdx, { maxChars = 3000 } = {}) {
  const sections = (project.sections || []).slice(0, Math.max(0, uptoIdx - 1));
  const claimLines = [];
  const terms = [];
  const numbers = [];
  for (const section of sections) {
    const claims = (section.plan && Array.isArray(section.plan.claims)) ? section.plan.claims : [];
    for (const claim of claims) {
      const goal = String(claim && claim.goal || '').trim();
      if (goal) claimLines.push(`- 第${section.idx}节：${goal.slice(0, 60)}`);
    }
    if (section.title) terms.push(String(section.title));
    const text = String(section.content || '');
    for (const matched of text.matchAll(/(\d+(?:,\d{3})*(?:\.\d+)?)\s*(%|‰|万元|亿元|人|家|倍|个百分点|吨|元)/g)) {
      numbers.push(`${matched[1]}${matched[2]}`);
    }
  }
  const lines = [];
  if (claimLines.length) {
    // 只留最近 8 条：更早的论点已经由「前文要点」覆盖，重复给出会挤占预算
    const recent = claimLines.slice(-8);
    lines.push('【前文已立论点（不要重复论证，要么推进，要么说明与前文的关系）】', ...recent);
  }
  if (terms.length) {
    lines.push(`【已用章节术语（同一概念全文用同一叫法）】${[...new Set(terms)].slice(0, 12).join('、')}`);
  }
  const uniqueNumbers = [...new Set(numbers)].slice(0, 24);
  if (uniqueNumbers.length) {
    lines.push(`【前文已用过的数据（再引用要说明为什么仍然适用）】${uniqueNumbers.join('、')}`);
  }
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return text;
}

// ---------- 语料地图（L3） ----------
//
// 这一层解决的是「模型不知道自己不知道什么」：
// 只给检索结果时，模型会以为手上的几段就是全部素材，于是该展开的地方写得很薄。
// 给出全语料概览（每条素材多少字、开头讲什么、本节是否已命中），
// 模型才知道「M7 那份年报我没看到，需要时可以说要哪一段」。
function corpusMap(projectId, { hitIds = new Set(), limit = 14 } = {}) {
  const rows = q(`SELECT c.material_id, COUNT(*) AS n, SUM(c.chars) AS chars, MIN(c.title) AS title,
      MIN(CASE WHEN c.ord=0 THEN c.text END) AS head
    FROM doc_corpus c WHERE c.project_id=? GROUP BY c.material_id ORDER BY chars DESC`, String(projectId));
  if (!rows.length) return '';
  const seqs = new Map(q(`SELECT id, seq FROM doc_materials WHERE project_id=?`, String(projectId))
    .map((row) => [String(row.id), Number(row.seq) || 0]));
  const lines = rows.slice(0, limit).map((row) => {
    const materialId = String(row.material_id);
    const key = `M${seqs.get(materialId) || 0}`;
    const title = String(row.title || '素材').slice(0, 24);
    const chars = Number(row.chars) || 0;
    const head = String(row.head || '').replace(/\s+/g, ' ').slice(0, 34);
    const mark = hitIds.has(materialId) ? '已命中' : '未命中';
    return `- ${key}｜${title}｜${chars} 字｜${mark}${head ? `｜开头：${head}…` : ''}`;
  });
  const rest = rows.length - lines.length;
  return lines.join('\n') + (rest > 0 ? `\n（另有 ${rest} 条素材未列出，需要时可指定编号）` : '');
}

// ---------- 预算 ----------

// 预算按文档类型与深度档位给。这不是「越大越好」：
// 证据给太多会稀释重点，模型对中段内容的利用率显著下降。
const DEPTH_FACTOR = { brief: 0.6, standard: 1, deep: 1.5 };

function budgetFor(docType, depth) {
  const factor = DEPTH_FACTOR[String(depth || 'standard')] || 1;
  const override = Math.max(0, Number(process.env.FABULA_DOC_CONTEXT_CHARS) || 0);
  const evidence = override > 0 ? override : Math.round(12000 * factor);
  return {
    memory: 3000,
    evidence,
    map: 1500,
    adjacent: Math.round(4000 * factor),
    total: 3000 + evidence + 1500 + Math.round(4000 * factor),
    factor,
  };
}

// ---------- 组装 ----------

function materialKeyOf(projectId) {
  const map = new Map();
  for (const row of q(`SELECT id, seq FROM doc_materials WHERE project_id=?`, String(projectId))) {
    map.set(String(row.id), `M${Number(row.seq) || 0}`);
  }
  return map;
}

// 主入口：给定项目与小节，产出这一节的完整上下文块。
//
// 返回 { text, stats }；text 为空表示没有可用素材（调用方按「无素材」处理）。
function buildContext(project, idx, { plan = null, budget = null } = {}) {
  const projectId = String(project.id);
  const section = (project.sections || [])[idx - 1];
  if (!section) return { text: '', stats: { chunks: 0, chars: 0, items: 0 } };
  const synced = syncCorpus(projectId);
  const stats = corpusStats(projectId);
  if (!stats.chunks) return { text: '', stats: { ...stats, items: 0, synced } };

  const spec = budget || budgetFor(project.docType, project.depth);
  const keys = materialKeyOf(projectId);
  const queries = buildQueries(project, section, plan);
  // 每节注入几段由预算决定，而不是写死 16：700 字一块时，
  // 18000 字预算能装 25 段，写死 16 就等于白白扔掉三分之一的预算。
  const maxItems = Math.max(10, Math.min(30, Math.round(spec.evidence / CHUNK_CHARS)));
  // 作者显式点名的素材先取：它们要参与后面的去重种子，
  // 否则检索会把「和指定素材几乎一样」的段落再塞一遍，白占预算。
  const forced = forcedBlocks(projectId, focusMaterialsOf(section), { budgetChars: 3000 });
  const evidence = retrieveEvidence(projectId, queries, {
    budgetChars: spec.evidence,
    maxItems,
    seedTexts: forced.map((item) => item.text),
  });
  const forcedIds = new Set(forced.map((item) => item.materialId));
  const items = [...forced, ...evidence.items.filter((item) => !forcedIds.has(item.materialId))];
  // 证据字数要把指定素材算进去，否则概览里「约 N 字」会明显小于实际注入量
  const evidenceChars = evidence.chars + forced.reduce((sum, item) => sum + item.text.length, 0);

  const parts = [];
  // 概览必须说清「语料有多大、本节用了多少」：这是作者判断上下文能力是否够用的唯一依据。
  // 小语料按字、大语料按万字，避免「共 2 条 / 0.0 万字」这种读起来像故障的写法。
  const scale = stats.chars >= 10000 ? `${(stats.chars / 10000).toFixed(1)} 万字` : `${stats.chars} 字`;
  // 「为什么只用了 6000 字预算」必须说清楚，否则作者会以为上下文能力没生效。
  // 最常见的原因是语料里高度重复：同一份年报被收了六遍，去重后只剩一份有信息量。
  const dedupNote = evidence.deduped
    ? `；另有 ${evidence.deduped} 段因与其他素材高度重复未重复注入（同一内容多份收录，引用时合并标注即可）`
    : '';
  const head = `【语料概览】全文素材共 ${stats.materials} 条 / ${scale}，已按本节需要检索出 ${items.length} 段`
    + `（约 ${evidenceChars} 字，上下文预算 ${spec.evidence} 字）${forced.length ? `，其中 ${forced.length} 条为作者指定` : ''}${dedupNote}。`;
  parts.push(head);

  const memory = documentMemory(project, idx, { maxChars: spec.memory });
  if (memory) parts.push(memory);

  if (items.length) {
    const lines = items.map((item) => {
      const key = keys.get(item.materialId) || 'M?';
      return `〈素材 ${key}：${item.title}〉\n${item.text}`;
    });
    parts.push([
      '【本节相关证据（唯一可用的事实来源，按编号引用；编号即引用编号）】',
      lines.join('\n\n'),
      '素材里有的观点、数据、文献，直接用，并把该句依据的素材编号标在句末（形如 [M2]，用哪条标哪条）；'
        + '素材里没有的一律写【待补】或【待补文献】，禁止编造数据、文献、政策条文或访谈结论。'
        + '不要引用没有出现在上面的编号。',
    ].join('\n'));
  } else {
    parts.push('【本节相关证据】（语料里没有与本节直接相关的段落——需要依据的地方写【待补】，不要编）');
  }

  // 邻近上下文：只在证据里确实出现核心来源时给，避免无谓地吃预算
  const adjacent = adjacentBlocks(projectId, items, { budgetChars: spec.adjacent });
  if (adjacent.length) {
    const blocks = adjacent.map((item) => {
      const key = keys.get(item.materialId) || 'M?';
      return `〈素材 ${key}：${item.title}（第 ${item.from + 1}~${item.to + 1} 段）〉\n${item.text}`;
    });
    parts.push(['【核心来源的连续上下文（引用时优先依据这里的完整论述，不要只看片段）】', blocks.join('\n\n')].join('\n'));
  }

  const map = corpusMap(projectId, { hitIds: new Set(items.map((item) => item.materialId)) });
  if (map) {
    parts.push([
      '【语料地图（全部素材的概览；本节没命中的素材不等于无关——'
        + '在「本节要求」里写「重点用 M7」即可强制纳入下一节）】',
      map,
    ].join('\n'));
  }

  const text = parts.filter(Boolean).join('\n\n');
  return {
    text,
    stats: {
      // chars = 语料总字数（索引规模）；contextChars = 本节实际注入的字数。
      // 两个数混用会让「语料 100 万字、上下文 2 万字」看起来自相矛盾——
      // 而这恰好是这个引擎最需要说清的一件事。
      ...stats,
      contextChars: text.length,
      evidenceChars,
      items: items.length,
      forced: forced.length,
      // 本节实际用到的素材编号：落库后页面能显示「这一节到底读了哪几条」，
      // 作者才有可能判断「模型没引用某条」是检索问题还是写作问题。
      keys: [...new Set(items.map((item) => keys.get(item.materialId) || '').filter(Boolean))],
      pool: evidence.pool,
      deduped: evidence.deduped || 0,
      budget: spec,
      adjacent: adjacent.length,
      synced,
    },
  };
}

module.exports = {
  VECTOR_DIM, CHUNK_CHARS, MAX_CORPUS_CHARS, MAX_CHUNKS_PER_MATERIAL,
  splitCorpus, hashOf, syncCorpus, corpusStats, clearCache, bigramsOf, similarityOf,
  buildQueries, retrieveEvidence, adjacentBlocks, corpusMap, documentMemory,
  focusMaterialsOf, forcedBlocks, isDuplicate, numberSignature,
  budgetFor, buildContext, vectorOf, cosine,
};
