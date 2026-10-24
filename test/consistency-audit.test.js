'use strict';

// 跨章 / 分卷一致性审计。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-audit-'));
process.env.FABULA_DATA_DIR = tempDir;
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';

const db = require('../lib/db');
db.open(path.join(__dirname, '..', 'data', 'writerx.seed.db'));

const core = require('../lib/handlers-core');
const audit = require('../lib/consistency-audit');
const misc = require('../lib/handlers-misc');

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const NOUNS = [
  '长廊', '石阶', '回廊', '井台', '药炉', '账册', '铜灯', '门帘', '瓦当', '槐树',
  '沙漏', '棋盘', '灯罩', '锁孔', '窗棂', '廊柱', '石臼', '门槛', '檐角', '铁马',
  '木箱', '竹帘', '砚台', '笔架', '茶盏', '酒瓮', '火盆', '衣柜', '屏风', '经幡',
  '水缸', '柴房', '马厩', '灶台', '横梁', '地砖', '砖缝', '台阶', '门环', '铜锁',
];

function createBook(title) {
  return core.createBook({ title, genre: '长篇', pov: '第三人称' }).id;
}

// 每章用不同名词，保证章与章之间没有 80 字以上的逐字重合。
function neutralChapter(n, { hook = false } = {}) {
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push(`他绕过${NOUNS[(n * 4 + i) % NOUNS.length]}，看见${NOUNS[(n * 4 + i + 7) % NOUNS.length]}还亮着，于是停下脚步。`);
  }
  if (hook) lines.push('他忽然听见门外有人低声叫他的名字。');
  return `# 第${n}章 回廊\n\n${lines.join('')}`;
}

function seedChapters(bookId, from, to, options = {}) {
  for (let n = from; n <= to; n++) {
    core.writeFileTo({ bookId, group: '正文', name: `第${n}章.md`, content: neutralChapter(n, options) });
  }
}

test('窗口内跨章逐字重复会被标出来', () => {
  const bookId = createBook('审计-重复桥段');
  seedChapters(bookId, 1, 3);
  const shared = '他站在门前没有动，风从缝隙里钻进来，把灯焰压得很低，影子在地上拉成一条细线，一直铺到台阶下面，又顺着砖缝折向内侧，像是有人在那里站了很久，也像是不打算再往前走一步，连呼吸都压得极轻。';
  core.writeFileTo({ bookId, group: '正文', name: '第4章.md', content: `# 第4章 回廊\n\n${shared}${neutralChapter(4).slice(0, 80)}` });
  core.writeFileTo({ bookId, group: '正文', name: '第5章.md', content: `# 第5章 回廊\n\n${shared}${neutralChapter(5).slice(0, 80)}` });

  const report = audit.auditWindow({ bookId, fromChapter: 1, toChapter: 5 });
  assert.equal(report.verdict, 'warn');
  const repeat = report.issues.find((item) => item.code === 'repeat_bridge');
  assert.ok(repeat, '应识别出复用桥段');
  assert.match(repeat.message, /第4章与第5章/);
  assert.ok(report.metrics.repeatChars >= 80);
});

test('章末钩子普遍缺失会被标出来', () => {
  const bookId = createBook('审计-钩子');
  seedChapters(bookId, 1, 10);
  const flat = audit.auditWindow({ bookId, fromChapter: 1, toChapter: 10 });
  assert.equal(flat.metrics.hooklessChapters, 10);
  assert.ok(flat.issues.some((item) => item.code === 'hook_missing'));

  const hooked = createBook('审计-钩子-有');
  seedChapters(hooked, 1, 10, { hook: true });
  const report = audit.auditWindow({ bookId: hooked, fromChapter: 1, toChapter: 10 });
  assert.equal(report.metrics.hooklessChapters, 0);
  assert.equal(report.issues.some((item) => item.code === 'hook_missing'), false);
});

test('连续多章没有核心人物出场会被标出来', () => {
  const bookId = createBook('审计-人物断层');
  seedChapters(bookId, 1, 8);
  db.run(`INSERT INTO character_mentions(book_id, state_key, chapter_num) VALUES(?,?,?)`, bookId, '沈砚', 1);
  db.run(`INSERT INTO character_mentions(book_id, state_key, chapter_num) VALUES(?,?,?)`, bookId, '沈砚', 2);

  const report = audit.auditWindow({ bookId, fromChapter: 1, toChapter: 8 });
  assert.ok(report.metrics.corelessStreak >= 3);
  assert.ok(report.issues.some((item) => item.code === 'core_character_gap'));
});

test('分卷审计统计未回收伏笔的数量与年龄', () => {
  const bookId = createBook('审计-分卷');
  seedChapters(bookId, 1, 3);
  for (let i = 0; i < 9; i++) {
    db.run(`INSERT INTO story_states(book_id, kind, state_key, value, chapter_num, updated_at)
      VALUES(?,?,?,?,?,?)`,
    bookId, 'thread', `伏笔${i}`, JSON.stringify({ text: `第${i}条未回收的线索`, status: 'open' }), 1, Date.now());
  }
  db.run(`INSERT INTO story_states(book_id, kind, state_key, value, chapter_num, updated_at)
    VALUES(?,?,?,?,?,?)`,
  bookId, 'thread', '已回收', JSON.stringify({ text: '已经兑现的线索', status: 'resolved' }), 1, Date.now());

  const report = audit.auditVolume({ bookId, volumeNum: 1 });
  assert.equal(report.metrics.openThreads, 9);
  assert.equal(report.metrics.chapters, 3);
  assert.ok(report.issues.some((item) => item.code === 'thread_backlog'));
  assert.ok(report.issues.some((item) => item.code === 'volume_short'));
});

test('审计结果落库，可按 scope 取回最近一次', () => {
  const bookId = createBook('审计-落库');
  seedChapters(bookId, 1, 2);
  const report = misc.runConsistencyAudit({ bookId, scope: 'window', fromChapter: 1, toChapter: 2 });
  assert.equal(report.scope, 'window');

  const stored = audit.latest({ bookId, scope: 'window' });
  assert.equal(stored.toChapter, 2);
  assert.deepEqual(stored.metrics, report.metrics);
});

test('审计报告落成 Markdown，跑完能直接读', () => {
  const bookId = createBook('审计报告');
  const report = audit.auditWindow({ bookId, fromChapter: 1, toChapter: 3 });
  const text = audit.reportMarkdown(report);
  assert.match(text, /第1-3章/);
  assert.match(text, /未发现跨章一致性问题|\[/);

  const written = audit.appendReportToFile({ bookId, report });
  assert.ok(written > 0);
  const file = core.readFileFrom({ bookId, group: '设定', name: '一致性报告.md' }) || '';
  assert.match(file, /第1-3章/);

  // 再写一次是追加，不是覆盖。
  audit.appendReportToFile({ bookId, report });
  const twice = core.readFileFrom({ bookId, group: '设定', name: '一致性报告.md' }) || '';
  assert.ok(twice.length > file.length);
});
