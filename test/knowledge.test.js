'use strict';

// 知识库/索引库 v2：场景切片、时间过滤、别称召回、Token 预算、旧索引自愈。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-kb-'));
process.env.FABULA_DATA_DIR = tempDir;
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';

const db = require('../lib/db');
db.open(path.join(__dirname, '..', 'data', 'writerx.seed.db'));

const core = require('../lib/handlers-core');
const knowledge = require('../lib/vector-store');

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createBook(title) {
  return core.createBook({ title, genre: '长篇', pov: '第三人称' }).id;
}

function paragraphs(seed, count = 3) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(`${seed}的第${i + 1}段：风从石门缝里挤进来，吹得灯焰歪向一侧。他把手按在石壁上，听见远处有人在数台阶，一声比一声近。`);
  }
  return out.join('\n\n');
}

const CHARACTERS_DOC = [
  '# 人物库',
  '',
  '## 沈砚',
  '- 姓名：沈砚',
  '- 别名：墨七、断水客',
  '',
  '## 顾长夜',
  '- 姓名：顾长夜',
  '- 称号：守门人',
  '',
].join('\n');

function seedBook(title) {
  const bookId = createBook(title);
  core.writeFileTo({ bookId, group: '设定', name: '人物库.md', content: CHARACTERS_DOC });
  core.writeFileTo({
    bookId, group: '正文', name: '第3章.md',
    content: `# 第3章 断水\n\n${paragraphs('断水客在长廊尽头停下脚步')}\n\n${paragraphs('守门人没有抬头，只把钥匙推过桌面')}`,
  });
  knowledge.syncBook(bookId, { force: true });
  return bookId;
}

test('正文按场景切片，每片带章节、人物和类型元数据', () => {
  const bookId = seedBook('场景切片');
  const rows = db.q(`SELECT chapter_num, chunk_kind, characters_json, location FROM kb_chunks
    WHERE book_id=? AND file_name='第3章.md' ORDER BY chunk_index`, bookId);
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.equal(Number(row.chapter_num), 3, '每个正文片段都要带章号，才能做时间过滤');
    assert.equal(row.chunk_kind, 'scene');
  }
  const characters = new Set(rows.flatMap((row) => JSON.parse(row.characters_json)));
  assert.ok(characters.has('沈砚'), '别称"断水客"应归一成本名"沈砚"');
  assert.ok(characters.has('顾长夜'), '称号"守门人"应归一成本名"顾长夜"');
});

test('时间过滤：写第 N 章时不召回第 N 章及以后的片段', () => {
  const bookId = seedBook('时间过滤');
  core.writeFileTo({
    bookId, group: '正文', name: '第9章.md',
    content: `# 第9章 寒潭\n\n${paragraphs('断水客最终沉入寒潭再未浮起')}`,
  });
  knowledge.syncBook(bookId, { force: true });

  const early = knowledge.retrieve({ bookId, query: '断水客 寒潭 结局', limit: 8, beforeChapter: 5 });
  assert.ok(early.length > 0);
  assert.equal(early.filter((item) => item.name === '第9章.md').length, 0, '第9章对第5章而言是未来，不得召回');
  assert.ok(early.some((item) => item.name === '第3章.md'));

  const later = knowledge.retrieve({ bookId, query: '断水客 寒潭 结局', limit: 8, beforeChapter: 10 });
  assert.ok(later.some((item) => item.name === '第9章.md'), '过了第9章之后应能召回');
});

test('别称双向召回：用本名提问也能命中只写了别称的正文', () => {
  const bookId = seedBook('别称召回');
  const byCanonical = knowledge.retrieve({ bookId, query: '沈砚 最近在做什么', limit: 5, beforeChapter: 10 });
  assert.ok(byCanonical.some((item) => item.name === '第3章.md'), '本名提问应召回别称成文的片段');

  const byAlias = knowledge.retrieve({ bookId, query: '断水客 最近在做什么', limit: 5, beforeChapter: 10 });
  assert.ok(byAlias.some((item) => item.name === '第3章.md'));

  const expanded = knowledge.expandQuery('沈砚的来历', {
    families: new Map([['沈砚', new Set(['墨七', '断水客'])]]),
  });
  assert.match(expanded, /墨七/);
  assert.match(expanded, /断水客/);
});

test('召回按 Token 预算组装，不超预算也不塞重复片段', () => {
  const bookId = seedBook('预算');
  const items = knowledge.retrieve({ bookId, query: '石门 钥匙 台阶', limit: 8, maxTokens: 220 });
  assert.ok(items.length > 0);
  const used = items.reduce((sum, item) => sum + knowledge.estimateTokens(item.content), 0);
  assert.ok(used <= 220, `实际 ${used} tokens 超出预算`);
  const fingerprints = items.map((item) => item.content.slice(0, 60));
  assert.equal(new Set(fingerprints).size, fingerprints.length, '不允许重复片段');
});

test('旧版索引（无元数据）在下次同步时按新引擎重建', () => {
  const bookId = seedBook('旧索引自愈');
  db.run(`DELETE FROM kb_meta WHERE book_id=?`, bookId);
  db.run(`UPDATE kb_chunks SET chapter_num=0, chunk_kind='' WHERE book_id=?`, bookId);

  knowledge.syncBook(bookId, { force: true });
  const meta = db.one(`SELECT engine FROM kb_meta WHERE book_id=?`, bookId);
  assert.equal(meta.engine, knowledge.ENGINE);
  const scenes = db.q(`SELECT chapter_num FROM kb_chunks WHERE book_id=? AND chunk_kind='scene'`, bookId);
  assert.ok(scenes.length > 0);
  assert.ok(scenes.every((row) => Number(row.chapter_num) === 3));
});

test('摘要必须整章追加，否则回退全量重建而不是错位索引', () => {
  const bookId = createBook('摘要追加约束');
  core.writeFileTo({
    bookId, group: '设定', name: '章节摘要.md',
    content: '## 第1章 起\n第一章的正式摘要内容足够长，可以形成稳定片段。\n',
  });
  const tail = '这一行没有章标题，直接追加会破坏切片边界。';
  const result = knowledge.appendIndex({ bookId, group: '设定', name: '章节摘要.md', content: tail, mtime: Date.now() });
  assert.equal(result.needsFullIndex, true);

  const ok = knowledge.appendIndex({
    bookId, group: '设定', name: '章节摘要.md',
    content: '\n## 第2章 承\n第二章的正式摘要内容同样完整。\n', mtime: Date.now(),
  });
  assert.equal(ok.needsFullIndex, undefined);
  const chapters = db.q(`SELECT chapter_num FROM kb_chunks WHERE book_id=? AND file_name='章节摘要.md' ORDER BY chunk_index`, bookId)
    .map((row) => Number(row.chapter_num));
  assert.deepEqual(chapters, [1, 2]);
});

test('stats 暴露新引擎与别称统计', () => {
  const bookId = seedBook('统计');
  const stats = knowledge.stats({ bookId });
  assert.equal(stats.engine, knowledge.ENGINE);
  assert.ok(stats.scenes >= 1);
  assert.ok(stats.aliases >= 2, '应至少记录墨七、断水客、守门人');
  assert.ok(stats.estimatedTokens > 0);
});

test('热查询复用向量矩阵，不重复整表加载', () => {
  const bookId = seedBook('矩阵复用');
  knowledge.retrieve({ bookId, query: '断水客在长廊尽头停下脚步' });
  const baseline = knowledge.debugCounters.matrixLoads;
  for (let i = 0; i < 12; i++) {
    const items = knowledge.retrieve({ bookId, query: `石门 台阶 ${i}` });
    assert.ok(Array.isArray(items));
  }
  assert.equal(knowledge.debugCounters.matrixLoads, baseline, '连续检索不应重新加载矩阵');
});

test('写入新片段后矩阵立即失效，不会召回旧快照', () => {
  const bookId = seedBook('矩阵失效');
  knowledge.retrieve({ bookId, query: '断水客' });
  const before = knowledge.debugCounters.matrixLoads;

  const body = `# 第9章 井底\n\n${paragraphs('赤铜密钥被藏在北塔地下的旧井石缝里')}`;
  core.writeFileTo({ bookId, group: '正文', name: '第9章.md', content: body });
  knowledge.indexFile({ bookId, group: '正文', name: '第9章.md', content: body, mtime: Date.now() });

  const items = knowledge.retrieve({ bookId, query: '赤铜密钥 北塔 旧井' });
  assert.ok(items.length > 0, '新写入的章节必须能立刻召回');
  assert.ok(items.some((item) => item.chapterNum === 9));
  assert.ok(knowledge.debugCounters.matrixLoads > before, '写入后应重建矩阵');
});

test('clearCache 后重新加载，不会留下已删除书目的残留', () => {
  const bookId = seedBook('缓存清理');
  knowledge.retrieve({ bookId, query: '守门人' });
  knowledge.clearCache();
  const before = knowledge.debugCounters.matrixLoads;
  knowledge.retrieve({ bookId, query: '守门人' });
  assert.equal(knowledge.debugCounters.matrixLoads, before + 1);
});

test('别称解析覆盖括号、竖线、加粗和带说明的写法', () => {
  const cases = [
    ['## 沈砚（墨七）', { canonical: '沈砚', alias: '墨七' }],
    ['## 顾长夜(守门人、断水客)', { canonical: '顾长夜', alias: '断水客' }],
    ['**沈砚**（墨七）', { canonical: '沈砚', alias: '墨七' }],
    ['## 沈砚 | 墨七 | 断水客', { canonical: '沈砚', alias: '断水客' }],
    ['- 姓名：沈砚（墨七）', { canonical: '沈砚', alias: '墨七' }],
    ['- 姓名：沈砚，二十七岁\n- 别名：墨七', { canonical: '沈砚', alias: '墨七' }],
  ];
  for (const [doc, expected] of cases) {
    const pairs = knowledge.parseAliases(doc);
    assert.ok(
      pairs.some((pair) => pair.canonical === expected.canonical && pair.alias === expected.alias),
      `${doc} 应解析出 ${expected.canonical}→${expected.alias}，实际 ${JSON.stringify(pairs)}`,
    );
    assert.ok(
      pairs.every((pair) => pair.canonical.length <= 20 && pair.alias.length <= 20),
      '人名不应把整行说明带进来',
    );
  }
});

test('括号写法的别称也能双向召回', () => {
  const bookId = createBook('括号别称');
  core.writeFileTo({
    bookId, group: '设定', name: '人物库.md',
    content: '# 人物库\n\n## 沈砚（墨七）\n- 身份：捕快\n',
  });
  core.writeFileTo({
    bookId, group: '正文', name: '第4章.md',
    content: `# 第4章 夜行\n\n${paragraphs('墨七在城西的旧仓里等到三更，才听见门外有人敲了两下')}`,
  });
  knowledge.syncBook(bookId, { force: true });

  const viaCanonical = knowledge.retrieve({ bookId, query: '沈砚 在旧仓做什么' });
  assert.ok(viaCanonical.some((item) => item.chapterNum === 4), '用本名应召回只写了别称的正文');

  const viaAlias = knowledge.retrieve({ bookId, query: '墨七 在旧仓做什么' });
  assert.ok(viaAlias.some((item) => item.chapterNum === 4));
});
