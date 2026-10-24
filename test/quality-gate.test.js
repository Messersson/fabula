'use strict';

// 质量审核层：确定性门禁 + 模型审核 + 定向修订。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-quality-'));
process.env.FABULA_DATA_DIR = tempDir;
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';

const db = require('../lib/db');
db.open(path.join(__dirname, '..', 'data', 'writerx.seed.db'));

const llm = require('../lib/llm');
const quality = require('../lib/quality-gate');

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const FILLER = [
  '铜灯的火苗被穿堂风压低，他把袖口拢紧，沿着潮湿的石阶一级一级往上走，鞋底在苔痕上打滑。',
  '墙上的刻痕比昨夜多了一道，刀口很新，边角还挂着细碎的白屑，说明刻的人走得很急。',
  '门后传来木轴转动的声响，随即又归于沉寂，像有人只是试了试把手，最终没有推开。',
  '她在窗棂上敲了三下，停顿，再敲一下，那是旧年约定的暗号，只有两个人知道。',
  '案上的茶已经凉透，杯沿留着一圈淡淡的盐渍，说明来客曾把杯子端到唇边又放下。',
  '廊柱的影子斜斜切过地面，正好落在门槛的第三块青砖上，砖缝里嵌着半枚铜钱。',
  '他把信纸对折两次，塞进内衬的夹层，指尖压了很久才松开，掌心的汗把纸角洇软了。',
  '远处的钟楼报过五更，城里却还没有一户点灯，连更夫都缩在檐下没有出声。',
];

function body(lines = 12) {
  const pool = [...FILLER, ...FILLER, ...FILLER];
  return `# 第3章 回廊\n\n${pool.slice(0, lines).join('')}`;
}

function codes(result) {
  return result.issues.map((item) => item.code);
}

test('篇幅不足和未完整收尾是硬性失败', () => {
  const short = quality.runLocalGate({ body: '# 第1章 短\n\n他走了。', targetWords: 2400 });
  assert.equal(short.passed, false);
  assert.ok(codes(short).includes('length'));

  const noEnding = quality.runLocalGate({ body: `${body()}\n\n他抬起手，却什么也`, targetWords: 400 });
  assert.equal(noEnding.passed, false);
  assert.ok(codes(noEnding).includes('ending'));
});

test('合格正文通过本地门禁', () => {
  const result = quality.runLocalGate({ body: body(), targetWords: 400 });
  assert.equal(result.passed, true, result.summary);
  assert.equal(result.score, 100);
});

test('与上一章逐字重合 40 字以上判硬性失败，短句重合不误伤', () => {
  const current = body();
  const copied = `# 第2章 回廊\n\n${FILLER[0]}${FILLER[1]}`;
  const hit = quality.runLocalGate({ body: copied, previousBody: current, targetWords: 300 });
  assert.equal(hit.passed, false);
  assert.ok(codes(hit).includes('repeat_previous'));
  assert.ok(hit.metrics.sharedRunChars >= 40);

  // 只有一句常见短语重合时不应拦截。
  const shortOverlap = `# 第2章 回廊\n\n${FILLER[0].slice(0, 20)}他停了下来。${FILLER[4]}`;
  const miss = quality.runLocalGate({ body: shortOverlap, previousBody: current, targetWords: 200 });
  assert.equal(codes(miss).includes('repeat_previous'), false);
});

test('本章内部重复段落判硬性失败', () => {
  const paragraph = `${FILLER[0]}${FILLER[1]}${FILLER[2]}`;
  const repeated = `# 第3章 回廊\n\n${paragraph}\n\n${FILLER[4]}${FILLER[5]}\n\n${paragraph}`;
  const result = quality.runLocalGate({ body: repeated, targetWords: 300 });
  assert.equal(result.passed, false);
  assert.ok(codes(result).includes('repeat_internal'));
});

test('已死亡人物的主动作被拦截，回忆与遗物场景放行', () => {
  const bookId = 'quality-dead';
  db.run(`INSERT INTO story_states(book_id, kind, state_key, value, chapter_num, updated_at)
    VALUES(?,?,?,?,?,?)`, bookId, 'character', '沈砚', JSON.stringify({ name: '沈砚', status: '已死亡' }), 5, Date.now());
  db.run(`INSERT INTO story_states(book_id, kind, state_key, value, chapter_num, updated_at)
    VALUES(?,?,?,?,?,?)`, bookId, 'character', '顾长夜', JSON.stringify({ name: '顾长夜', status: '重伤未死' }), 5, Date.now());

  const alive = quality.runLocalGate({ bookId, body: body(), targetWords: 400 });
  assert.equal(alive.passed, true, '死者没出场时不应误报');

  const acting = quality.runLocalGate({
    bookId, targetWords: 400,
    body: `${body()}\n\n沈砚推开门走了进来，抬手把灯放在阶前。`,
  });
  assert.equal(acting.passed, false);
  assert.ok(codes(acting).includes('dead_character'));

  const flashback = quality.runLocalGate({
    bookId, targetWords: 400,
    body: `${body()}\n\n他想起沈砚推开门的样子，那是三年前的事了。`,
  });
  assert.equal(codes(flashback).includes('dead_character'), false, '回忆里的死者不应拦截');

  // "重伤未死"不是死亡状态。
  assert.equal(quality.characterStates(bookId).find((item) => item.name === '顾长夜').dead, false);
});

test('AI 套话达到阈值判硬性失败，少量只记软性', () => {
  const heavy = `${body()}\n\n他嘴角勾起一抹弧度，眼中闪过一丝复杂。空气仿佛凝固。心中一震。`;
  const result = quality.runLocalGate({ body: heavy, targetWords: 400 });
  assert.equal(result.passed, false);
  assert.ok(codes(result).includes('cliche'));

  const light = `${body()}\n\n他嘴角勾起，眼中闪过一丝复杂。`;
  const mild = quality.runLocalGate({ body: light, targetWords: 400 });
  assert.equal(mild.passed, true, '一处套话不该拦下整章');
  assert.ok(codes(mild).includes('cliche'));
});

test('代码围栏、模型自述、多标题都是硬性格式错误', () => {
  const fenced = quality.runLocalGate({ body: `${body()}\n\n\`\`\`\n片段\n\`\`\``, targetWords: 400 });
  assert.ok(codes(fenced).includes('format'));

  const meta = quality.runLocalGate({ body: `${body()}\n\n以下是为你续写的章节。`, targetWords: 400 });
  assert.ok(codes(meta).includes('format'));

  const headings = quality.runLocalGate({ body: `# 第3章 回廊\n\n${FILLER[0]}\n\n## 场景二\n\n${FILLER[1]}`, targetWords: 200 });
  assert.ok(codes(headings).includes('format'));
});

test('第三人称里的第一人称堆叠只记软性，不阻断', () => {
  const selfLines = [];
  for (let i = 0; i < 16; i++) selfLines.push(`我推开门，我看见灯焰在晃，我知道他在等我。`);
  const narrative = `# 第3章 回廊\n\n${selfLines.join('')}${FILLER[0]}${FILLER[1]}${FILLER[2]}${FILLER[3]}`;
  const result = quality.runLocalGate({ body: narrative, targetWords: 400, expectedPov: '第三人称' });
  assert.ok(codes(result).includes('pov'));
  assert.equal(result.passed, true, '视角漂移是软性提示，交给模型审核与人工判断');
});

test('模型审核解析结构化 JSON，硬性 false 直接判不通过', async () => {
  const channel = { baseUrl: 'http://stub.local', key: 'k', model: 'm' };
  const reply = (payload) => {
    llm.chatCompletion = async function* () {
      yield { type: 'delta', text: JSON.stringify(payload) };
      yield { type: 'meta', usage: { prompt_tokens: 1, completion_tokens: 2 }, finishReason: 'stop' };
    };
  };

  reply({
    hard: { world: true, knowledge: true, timeline: true, outline: true },
    scores: { causality: 4, voice: 4, pacing: 3, style: 4, information: 3, hook: 4 },
    issues: [],
  });
  const pass = await quality.reviewWithModel({ channel, model: 'm', body: body(), targetWords: 400 });
  assert.equal(pass.passed, true);
  assert.equal(pass.score, 3.67);
  assert.deepEqual(Object.keys(pass.dimensions).sort(), ['causality', 'hook', 'information', 'pacing', 'style', 'voice']);

  reply({
    hard: { world: true, knowledge: true, timeline: false, outline: true },
    scores: { causality: 3, voice: 3, pacing: 3, style: 3, information: 3, hook: 3 },
    issues: ['第三段让死者开口'],
  });
  const fail = await quality.reviewWithModel({ channel, model: 'm', body: body(), targetWords: 400 });
  assert.equal(fail.passed, false);
  assert.ok(fail.issues.some((item) => item.severity === 'hard' && item.message.includes('时间线')));

  llm.chatCompletion = async function* () { yield { type: 'delta', text: '这不是 JSON' }; };
  const broken = await quality.reviewWithModel({ channel, model: 'm', body: body(), targetWords: 400 });
  assert.equal(broken.passed, false);
  assert.equal(broken.metrics.parseFailed, true);
});

test('定向修订只返回正文，不带解释', async () => {
  llm.chatCompletion = async function* () {
    yield { type: 'delta', text: '# 第3章 回廊\n\n修订后的正文。' };
  };
  const revised = await quality.reviseChapter({
    channel: { baseUrl: 'http://stub.local', key: 'k', model: 'm' },
    model: 'm', body: body(), issues: [{ message: '删掉重复段落' }], targetWords: 400,
  });
  assert.match(revised, /修订后的正文/);
});
