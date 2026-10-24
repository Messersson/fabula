'use strict';

// 语义召回（embedding 叠加层）：真实 HTTP 路径 + 混合打分 + 回落与断路。
// 本地起一个 OpenAI 兼容 /embeddings 桩：按语义主题返回确定性向量，
// 这样"获得武器"与只有"刀/铁匠"的片段零词面重叠仍能互相命中。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-embed-'));
process.env.FABULA_DATA_DIR = tempDir;
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';

const db = require('../lib/db');
db.open(path.join(__dirname, '..', 'data', 'writerx.seed.db'));

const core = require('../lib/handlers-core');
const knowledge = require('../lib/vector-store');
const llm = require('../lib/llm');

// 语义桩：主题词决定向量方向。武器簇 [1,0]，天气簇 [0,1]，无关文本均匀小值。
const WEAPON = /刀|剑|武器|兵器|铁匠/;
const WEATHER = /雨|天气|雨伞|积水/;
function stubEmbed(text) {
  const source = String(text || '');
  const vector = [0.01, 0.01];
  if (WEAPON.test(source)) vector[0] += 1;
  if (WEATHER.test(source)) vector[1] += 1;
  const sum = Math.sqrt(vector[0] * vector[0] + vector[1] * vector[1]);
  return vector.map((value) => value / sum);
}

let server = null;
let baseUrl = '';
let embedRequests = 0;
let lastBody = null;
let failMode = false;

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      embedRequests += 1;
      if (failMode) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'stub 故障' } }));
        return;
      }
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch {}
      lastBody = parsed;
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
      // 故意把两条返回倒序：embedTexts 必须按 index 对齐，而不是按到达顺序。
      const data = inputs.map((text, index) => ({ index, embedding: stubEmbed(text) }));
      if (data.length === 2) data.reverse();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: parsed.model, data }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

function setConfig(model, baseUrlOverride) {
  core.setSetting('embedding_model', model);
  core.setSetting('embedding_base_url', baseUrlOverride !== undefined ? baseUrlOverride : baseUrl);
  core.setSetting('embedding_api_key', 'stub-key');
  knowledge.resetEmbeddingFailures();
}

const WEAPON_TEXT = '沈砚的刀在上一战崩了口，他拿着旧刀走进铁匠铺，请老师傅重铸一把新刀，刀成之日，他在鞘上刻了一个"雁"字。';
const WEATHER_TEXT = '这天夜里城里落了一整夜的雨，清晨街面全是积水，卖伞的摊子前排起了长队。';
// 垫长到接近但不越过 1400 字符切分线：每个文件恰好一个 chunk，主题纯净。
function pad(text) {
  const filler = '他在庭院里来回踱步，看着檐角的影子一点点挪动，直到暮色把石阶染成灰色。\n';
  let out = text;
  while (out.length < 900) out += filler;
  return out;
}

function indexPairBook(title) {
  const bookId = core.createBook({ title, genre: '长篇', pov: '第三人称' }).id;
  core.writeFileTo({ bookId, group: '设定', name: '兵器资料.md', content: pad(WEAPON_TEXT) });
  core.writeFileTo({ bookId, group: '设定', name: '天气见闻.md', content: pad(WEATHER_TEXT) });
  return bookId;
}

test('embedTexts：批量请求、按 index 对齐、归一化', async () => {
  const result = await llm.embedTexts(['刀', '下雨'], { baseUrl, apiKey: 'k', model: 'stub-embed' });
  assert.equal(result.model, 'stub-embed');
  assert.equal(result.dim, 2);
  assert.equal(result.vectors.length, 2);
  assert.ok(result.vectors[0][0] > 0.99, '第一条输入是武器主题（乱序返回也必须按 index 对齐）');
  assert.ok(result.vectors[1][1] > 0.99, '第二条输入是天气主题');
  assert.equal(lastBody.input.length, 2, '两次输入应合并为一个批量请求');
  assert.equal(lastBody.model, 'stub-embed');
});

test('语义召回：零词面重叠的查询命中间义相关片段', async () => {
  const bookId = indexPairBook('语义-命中');
  setConfig('stub-embed');
  const first = await knowledge.ensureEmbeddings(bookId);
  assert.equal(first.ok, true);
  assert.equal(first.embedded, 2, '两个片段都已向量化');
  assert.equal(first.remaining, 0);

  const stats = knowledge.stats({ bookId });
  assert.equal(stats.embedding.model, 'stub-embed');
  assert.equal(stats.embedding.coverage, 1);
  assert.equal(stats.embedding.dim, 2);

  // "获得了一件武器" 与片段零词面共享（片段里只有 刀/铁匠），纯语义命中。
  const prepared = await knowledge.prepareRetrieval(bookId, '主角获得了一件武器');
  assert.ok(prepared, '查询向量化成功');
  const hits = knowledge.retrieve({ bookId, query: '主角获得了一件武器', queryVector: prepared.queryVector });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].content, /铁匠铺/, '语义路径必须把武器片段排在最前');

  const weatherPrepared = await knowledge.prepareRetrieval(bookId, '下雨天的街面');
  const weatherHits = knowledge.retrieve({ bookId, query: '下雨天的街面', queryVector: weatherPrepared.queryVector });
  assert.match(weatherHits[0].content, /落了一整夜的雨/, '天气查询命中天气片段');
});

test('接口故障时整本回落哈希引擎，且断路器阻止重试风暴', async () => {
  const bookId = indexPairBook('语义-回落');
  setConfig('stub-embed');
  failMode = true;
  try {
    const prepared = await knowledge.prepareRetrieval(bookId, '石门 台阶');
    assert.equal(prepared, null, 'embedding 接口故障时查询向量化返回空');
    const requestsAfterFirst = embedRequests;
    await knowledge.prepareRetrieval(bookId, '又一次查询');
    assert.equal(embedRequests, requestsAfterFirst, '冷却期内不再打接口（断路器生效）');
    const status = knowledge.embeddingStatus({ bookId });
    assert.equal(status.coolingDown, true);
    assert.ok(status.lastError.includes('stub 故障'));
  } finally {
    failMode = false;
  }

  const hits = knowledge.retrieve({ bookId, query: '铁匠铺 重铸 刀' });
  assert.ok(hits.length >= 1, '本地哈希引擎照常召回');

  // 冷却期内的自然行为是不再打接口；运维侧的出口是重存配置/手动重试清掉冷却。
  knowledge.resetEmbeddingFailures();
  const recovered = await knowledge.prepareRetrieval(bookId, '铁匠铺');
  assert.ok(recovered, '清除冷却且接口恢复后正常向量化');
});

test('换模型：旧向量清空重填，不留混合空间', async () => {
  const bookId = indexPairBook('语义-换模型');
  setConfig('stub-embed');
  await knowledge.ensureEmbeddings(bookId);
  const before = knowledge.embeddingStatus({ bookId });
  assert.equal(before.model, 'stub-embed');
  assert.equal(before.embedded, before.total);

  setConfig('stub-embed-v2');
  const primed = await knowledge.primeEmbeddings(bookId);
  assert.equal(primed.ok, true);
  assert.equal(primed.remaining, 0, '换模型后全量重填');
  const after = knowledge.embeddingStatus({ bookId });
  assert.equal(after.model, 'stub-embed-v2');
  assert.equal(after.embedded, after.total);
});

test('未配置 / 部分填充：检索照常，语义层按门槛启用', async () => {
  const bookId = indexPairBook('语义-未配置');
  core.setSetting('embedding_model', '');
  const requestsBefore = embedRequests;
  const prepared = await knowledge.prepareRetrieval(bookId, '铁匠铺');
  assert.equal(prepared, null, '未配置时不做任何 embedding 调用');
  assert.equal(embedRequests - requestsBefore, 0, '关闭状态绝不打接口');
  const hits = knowledge.retrieve({ bookId, query: '铁匠铺 重铸' });
  assert.ok(hits.length >= 1, '本地引擎独立工作');

  // 部分填充：只补 1 条时矩阵不带语义层（不同向量空间不能算余弦）。
  setConfig('stub-embed');
  const partial = await knowledge.ensureEmbeddings(bookId, { maxTexts: 1 });
  assert.equal(partial.embedded, 1);
  const partialHits = knowledge.retrieve({ bookId, query: '铁匠铺 重铸' });
  assert.ok(partialHits.length >= 1, '部分填充时回落哈希路径，检索不受影响');
  const rest = await knowledge.primeEmbeddings(bookId);
  assert.equal(rest.remaining, 0);
  const prepared2 = await knowledge.prepareRetrieval(bookId, '主角获得了一件武器');
  const semanticHits = knowledge.retrieve({ bookId, query: '主角获得了一件武器', queryVector: prepared2.queryVector });
  assert.match(semanticHits[0].content, /铁匠铺/, '补齐后语义路径生效');
});

test('删除文件时语义向量一并清理', async () => {
  const bookId = indexPairBook('语义-清理');
  setConfig('stub-embed');
  await knowledge.ensureEmbeddings(bookId);
  const before = knowledge.embeddingStatus({ bookId });
  assert.equal(before.embedded, before.total);
  knowledge.removeFile({ bookId, group: '设定', name: '兵器资料.md' });
  const after = knowledge.embeddingStatus({ bookId });
  assert.equal(after.total, 1, '只剩天气文件');
  assert.equal(after.embedded, 1);
  assert.ok(after.embedded <= after.total, '语义向量必须随片段一起删除');
});
