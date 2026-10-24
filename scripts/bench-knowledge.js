'use strict';

// 百万字级知识库基准：node scripts/bench-knowledge.js [章节数]
// 用临时数据目录跑，不会碰真实作品。输出索引耗时、片段数、单次检索平均耗时。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chapters = Number(process.argv[2] || 400);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-bench-'));
process.env.FABULA_DATA_DIR = dir;
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';
const root = path.join(__dirname, '..');
const db = require(root + '/lib/db');
db.open(path.join(root, 'data', 'writerx.seed.db'));
const core = require(root + '/lib/handlers-core');
const kb = require(root + '/lib/vector-store');

const bookId = core.createBook({ title: '基准', genre: '长篇', pov: '第三人称' }).id;
core.writeFileTo({ bookId, group: '设定', name: '人物库.md', content: '# 人物库\n\n## 沈砚\n- 姓名：沈砚\n- 别名：墨七、断水客\n' });
const names = ['沈砚', '顾长夜', '白露', '陆沉舟', '苏问梅'];
function body(n) {
  const parts = [];
  for (let i = 0; i < 10; i++) {
    const who = names[(n + i) % names.length];
    const line = `${who}在第${n}章的第${i}段里绕过回廊，石阶上积着薄霜。他把灯举高，照见墙上新刻的一道痕，痕迹末端停着一枚铜扣，扣面上压着半句没写完的话。远处钟声撞了三下，风把话尾吹散了，他伸手去接，掌心只落下一层灰。回廊尽头有人在等他，那人背对着光，肩线绷得很紧，像是已经站了很久，也像是不打算再等下去。他没有立刻走过去，先把灯放在阶前，让影子铺在自己和对方之间。`;
    parts.push(line);
  }
  return `# 第${n}章 回廊\n\n` + parts.join('\n\n');
}
const t0 = Date.now();
for (let n = 1; n <= chapters; n++) core.writeFileTo({ bookId, group: '正文', name: `第${n}章.md`, content: body(n) });
const indexMs = Date.now() - t0;
kb.syncBook(bookId, { force: true });
const stats = kb.stats({ bookId });

const queries = ['沈砚 最近在查什么', '断水客 铜扣 线索', '钟声 回廊 石阶', '顾长夜 与沈砚的关系', '白露 在哪'];
// 冷查询包含一次整书向量装载；热查询只做内存点积 + 入选片段取正文。
const coldStart = Date.now();
kb.retrieve({ bookId, query: queries[0], limit: 8, maxChars: 6000 });
const coldQueryMs = Date.now() - coldStart;
const loadsAfterCold = kb.debugCounters.matrixLoads;

const rounds = 10;
let hits = 0;
let warmTotal = 0;
let warmMax = 0;
for (let r = 0; r < rounds; r++) {
  for (const q of queries) {
    const started = Date.now();
    const items = r % 2 === 0
      ? kb.retrieve({ bookId, query: q, limit: 8, maxChars: 6000 })
      : kb.retrieve({ bookId, query: q, limit: 8, maxChars: 6000, beforeChapter: Math.floor(chapters * 0.8) });
    const cost = Date.now() - started;
    warmTotal += cost;
    if (cost > warmMax) warmMax = cost;
    hits += items.length;
  }
}
const calls = rounds * queries.length;
// 旧实现每次检索都要把整本书的片段（含正文）读一遍再逐行解析向量。
// 这里只测其中不可避免的那部分（读全表 id+正文），作为旧方案的下限参照。
const legacyStart = Date.now();
const legacyRows = db.q(`SELECT id, content FROM kb_chunks WHERE book_id=?`, bookId);
const legacyScanMs = Date.now() - legacyStart;
console.log(JSON.stringify({
  chapters, chars: stats.indexedChars, chunks: stats.chunks, scenes: stats.scenes,
  indexMs,
  coldQueryMs,
  avgQueryMs: Number((warmTotal / calls).toFixed(2)),
  maxQueryMs: warmMax,
  avgHits: Number((hits / calls).toFixed(1)),
  legacyScanMs, legacyRows: legacyRows.length,
  matrixLoads: kb.debugCounters.matrixLoads,
  matrixReloadedOnWarm: kb.debugCounters.matrixLoads !== loadsAfterCold,
  versionChecks: kb.debugCounters.versionChecks,
}));
db.close();
fs.rmSync(dir, { recursive: true, force: true });
