'use strict';

// 端到端韧性：注入超时/质量不达标，验证不丢章、不重复、可续跑、可隔离。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-resilience-'));
process.env.FABULA_DATA_DIR = tempDir;
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';

const db = require('../lib/db');
db.open(path.join(__dirname, '..', 'data', 'writerx.seed.db'));

const core = require('../lib/handlers-core');
const llm = require('../lib/llm');
const misc = require('../lib/handlers-misc');
const orch = require('../lib/longform-orchestrator');

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const CHAPTER_WORDS = 400;

// 每章取不同的句子，保证相邻章节之间没有 40 字以上的逐字重合，
// 否则会被"跨章重复"硬门禁正确拦截。
const SENTENCE_POOL = [
  '铜灯的火苗被穿堂风压低，他把袖口拢紧，沿着潮湿的石阶一级一级往上走，鞋底在苔痕上打滑。',
  '墙上的刻痕比昨夜多了一道，刀口很新，边角还挂着细碎的白屑，说明刻的人走得很急。',
  '门后传来木轴转动的声响，随即又归于沉寂，像有人只是试了试把手，最终没有推开。',
  '她在窗棂上敲了三下，停顿，再敲一下，那是旧年约定的暗号，只有两个人知道。',
  '案上的茶已经凉透，杯沿留着一圈淡淡的盐渍，说明来客曾把杯子端到唇边又放下。',
  '廊柱的影子斜斜切过地面，正好落在门槛的第三块青砖上，砖缝里嵌着半枚铜钱。',
  '他把信纸对折两次，塞进内衬的夹层，指尖压了很久才松开，掌心的汗把纸角洇软了。',
  '远处的钟楼报过五更，城里却还没有一户点灯，连更夫都缩在檐下没有出声。',
  '雨水顺着瓦当连成线，砸在石臼里，溅起的水花打湿了半截裤脚，凉意一直往上爬。',
  '有人在低声争执，语速很快，隔着两重木门只剩模糊的音节，听不出是几个人。',
  '账册翻到最后一页，墨迹在这里断掉，剩下的空白被人用指甲划过，留下几道浅痕。',
  '她摘下兜帽，露出被风吹乱的一缕头发，眼神却始终落在门缝上，没有看他。',
  '巷口的灯笼晃了两下，火苗歪向内侧，随即被一只手扶正，那只手很快又缩回暗处。',
  '井台边积着薄冰，踩上去会先发出一声脆响，然后才碎，碎声在院子里荡开很久。',
  '他数着脚下的砖缝，数到第七块时停下，蹲下去摸那道凹槽，指尖沾了一层细灰。',
  '药炉上的白气散得很慢，屋里弥漫着一股微苦的焦味，混着陈年木头的气息。',
  '钥匙插进锁孔时并不顺畅，转了半圈便卡住，像是里面被什么东西顶住，退也退不出。',
  '窗外的槐树落了叶，枝桠的影子在纸上投出一片细密的网，随着风一点点挪动。',
  '她把那枚铜扣放在掌心，来回翻看，边缘的缺口和记忆里并不一样，像是被人磨过。',
  '楼板传来轻微的脚步声，从东侧走到西侧，然后停住不动，停了很久也没有再响。',
  '风把门帘掀起一角，露出院中那口被封了半年的枯井，井沿上压着三块青石。',
  '桌上的沙漏漏到一半，细沙卡在瓶颈，迟迟不肯落下，像是连时间也停在这里。',
  '他解开外袍的系带，露出腰间那圈旧伤，颜色比上回淡了些，边缘却仍是硬的。',
  '檐下的铁马响了一声，随即被谁按住，再没有响第二声，连余音都被吞掉了。',
  '她把纸灯笼递过来，纸面上还留着未干的墨点，指尖一碰就会晕开一片。',
  '走廊尽头那扇门半开着，里面没有点灯，只有一股陈年的尘土味顺着地面漫出来。',
  '他用指节叩了叩墙面，回声比预想的空，说明后面另有空间，而且不算小。',
  '桌上的棋子被收进木盒，只剩一枚孤零零地立在棋盘正中，位置偏了半格。',
  '更夫敲过梆子，声音由远及近，又渐渐远去，最后只剩下瓦上滴水的声音。',
  '她把手贴在门板上，能感觉到另一侧传来的轻微震动，一下，两下，然后停了。',
];

function longBody(chapterNum) {
  const sentences = [];
  // 每章取 10 句互不重叠的句子：第 1 章 0-9，第 2 章 10-19，第 3 章 20-29。
  const offset = ((chapterNum - 1) * 10) % SENTENCE_POOL.length;
  for (let i = 0; i < 10; i++) {
    sentences.push(SENTENCE_POOL[(offset + i) % SENTENCE_POOL.length]);
  }
  return sentences.join('');
}

function chapterFromOptions(options) {
  const system = String(options.messages?.[0]?.content || '');
  const matched = system.match(/本轮只生成第(\d+)章正文/);
  return matched ? Number(matched[1]) : 0;
}

function stubModel(handler) {
  llm.activeChannel = () => ({ baseUrl: 'http://stub.local', key: 'stub', model: 'stub-model', noThinking: true });
  llm.chatCompletion = async function* (options) {
    const text = handler(options);
    yield { type: 'delta', text };
    yield { type: 'meta', usage: { prompt_tokens: 11, completion_tokens: 22 }, finishReason: 'stop' };
  };
}

function createBookWithOutlines(title, chapters) {
  const bookId = core.createBook({ title, genre: '长篇', pov: '第三人称' }).id;
  core.setBookPlanSettings({ bookId, totalChapters: chapters, chapterWords: CHAPTER_WORDS });
  for (let n = 1; n <= chapters; n++) {
    const outline = {
      title: `第${n}章 试炼`,
      goal: `推进第${n}章的目标`,
      conflict: '与守门人僵持',
      hook: '门外传来第三个人的脚步声',
      scenes: [
        { title: '试探', location: '长廊', summary: '试探守门人的底线' },
        { title: '交锋', location: '石门', summary: '冲突升级并留下悬念' },
      ],
      continuity: {
        time: `第${n}日`, location: '长廊',
        characters: [{ name: '沈砚', status: '清醒', goal: '进入石门', relations: '独行', location: '长廊' }],
        facts: [`第${n}章的石门仍未开启`], openThreads: [], resolvedThreads: [],
      },
      foreshadow: { planted: [`第${n}章的陌生名字`], advanced: [], resolved: [] },
    };
    core.writeFileTo({ bookId, group: '细纲', name: `细纲_第${n}章.md`, content: JSON.stringify(outline, null, 2) });
  }
  return bookId;
}

function bodyFiles(bookId) {
  const group = core.scanTree({ bookId }).find((item) => item.groupDir === '正文') || { files: [] };
  return group.files.map((file) => file.name);
}

test('模型连续两次网络失败后自动重试成功，章节照常落盘并记账', async () => {
  const bookId = createBookWithOutlines('韧性-重试', 1);
  let calls = 0;
  stubModel(() => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return longBody(1);
  });

  const result = await misc.batchGenerateBodies({
    bookId, fromChapter: 1, toChapter: 1, chapterWords: CHAPTER_WORDS, maxRetries: 3, retryBaseDelayMs: 1,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.created.map((item) => item.n), [1]);
  assert.equal(calls, 3, '两次失败 + 一次成功');

  const diagnostics = misc.generationRunStatus({ runId: result.runId });
  assert.equal(diagnostics.run.status, 'completed');
  assert.equal(diagnostics.attempts.total, 3);
  assert.equal(diagnostics.attempts.failed, 2);
  // 失败的两次在拿到 usage 之前就断了，只有成功那一次产生 Token 记账。
  assert.equal(diagnostics.attempts.promptTokens, 11);
  assert.equal(diagnostics.chapterStats.committed, 1);
  assert.deepEqual(bodyFiles(bookId), ['第1章.md']);
});

test('质量门禁连续不达标会隔离该章并停在那里，不污染后续章节', async () => {
  const bookId = createBookWithOutlines('韧性-隔离', 3);
  stubModel((options) => {
    const chapter = chapterFromOptions(options);
    return chapter === 2 ? '太短了。' : longBody(chapter);
  });

  const result = await misc.batchGenerateBodies({
    bookId, fromChapter: 1, toChapter: 3, chapterWords: CHAPTER_WORDS, maxRetries: 2, retryBaseDelayMs: 1,
    recoverMode: 'stop',
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.created.map((item) => item.n), [1], '第2章不达标，第3章不得推进');
  assert.match(result.stopReason, /连续 1 章失败/);
  assert.deepEqual(result.quarantined.map((item) => item.n), [2]);
  assert.equal(bodyFiles(bookId).length, 1);

  const diagnostics = misc.generationRunStatus({ runId: result.runId });
  assert.equal(diagnostics.run.status, 'quarantined');
  assert.equal(diagnostics.chapterStats.quarantined, 1);
  assert.equal(diagnostics.quarantined[0].chapterNum, 2);
  assert.ok(diagnostics.attempts.failed >= 2, '质量失败必须被记录成多次尝试');

  // 被隔离的任务必须仍可被找回，才能谈续跑。
  const resumable = orch.findResumableRun(bookId);
  assert.equal(resumable.id, result.runId);
});

test('从隔离处续跑：已存在章节跳过，不产生重复文件，剩余章节补齐', async () => {
  const bookId = createBookWithOutlines('韧性-续跑', 3);
  stubModel((options) => {
    const chapter = chapterFromOptions(options);
    return chapter === 2 ? '太短了。' : longBody(chapter);
  });

  const first = await misc.batchGenerateBodies({
    bookId, fromChapter: 1, toChapter: 3, chapterWords: CHAPTER_WORDS, maxRetries: 2, retryBaseDelayMs: 1,
    recoverMode: 'stop',
  });
  assert.deepEqual(first.created.map((item) => item.n), [1]);
  assert.deepEqual(first.quarantined.map((item) => item.n), [2]);

  // 模型恢复后用续跑命令接着跑：必须从第 2 章起，并且复用同一个 run。
  stubModel((options) => longBody(chapterFromOptions(options)));
  const second = await misc.resumeGenerationRun({ runId: first.runId, maxRetries: 2, retryBaseDelayMs: 1 });

  assert.equal(second.resumed, true);
  assert.equal(second.fromChapter, 2, '续跑点应是第一个未提交的章节');
  assert.equal(second.runId, first.runId, '续跑复用原任务，不另起一个 run');
  assert.deepEqual(second.created.map((item) => item.n), [2, 3]);
  assert.equal(second.quarantined.length, 0);

  const files = bodyFiles(bookId);
  assert.equal(files.length, 3, '每章只允许一个正文文件');
  assert.deepEqual(files.slice().sort(), ['第1章.md', '第2章.md', '第3章.md']);
  assert.equal(orch.getRun(first.runId).status, 'completed', '续跑完成后原任务应收尾');
});

test('模型审核：硬性不通过触发重写，软性偏低触发定向修订', async () => {
  const bookId = createBookWithOutlines('韧性-审核', 1);
  const calls = { body: 0, review: 0, revise: 0 };
  const reviewPayload = (timeline, score) => JSON.stringify({
    hard: { world: true, knowledge: true, timeline, outline: true },
    scores: { causality: score, voice: score, pacing: score, style: score, information: score, hook: score },
    issues: score < 3 ? ['对白太整齐，缺少人物差异'] : [],
  });
  llm.activeChannel = () => ({ baseUrl: 'http://stub.local', key: 'stub', model: 'stub-model', noThinking: true });
  llm.chatCompletion = async function* (options) {
    const system = String(options.messages?.[0]?.content || '');
    if (system.includes('责任编辑')) {
      calls.review += 1;
      // 第一次判硬性矛盾，第二次软性偏低，第三次修订后达标。
      const text = calls.review === 1 ? reviewPayload(false, 3)
        : calls.review === 2 ? reviewPayload(true, 2.4)
          : reviewPayload(true, 4.2);
      yield { type: 'delta', text };
      return;
    }
    if (system.includes('修订者')) {
      calls.revise += 1;
      yield { type: 'delta', text: `${longBody(1)}他把灯留在阶前，转身走进雨里。` };
      return;
    }
    calls.body += 1;
    yield { type: 'delta', text: longBody(1) };
    yield { type: 'meta', usage: { prompt_tokens: 5, completion_tokens: 6 }, finishReason: 'stop' };
  };

  const result = await misc.batchGenerateBodies({
    bookId, fromChapter: 1, toChapter: 1, chapterWords: CHAPTER_WORDS,
    maxRetries: 3, retryBaseDelayMs: 1, reviewMode: 'model', maxRevisions: 1,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.created.map((item) => item.n), [1]);
  assert.equal(calls.body, 2, '第一次审核硬性不通过必须重写');
  assert.equal(calls.revise, 1, '软性偏低应做一次定向修订');
  assert.equal(calls.review, 3);

  const saved = core.readFileFrom({ bookId, group: '正文', name: '第1章.md' });
  assert.match(saved, /转身走进雨里/, '落盘的应是修订稿');
  assert.match(saved, /^# 第1章/, '修订稿也要补回章节标题');

  const reviews = db.q(`SELECT verdict, score FROM chapter_reviews WHERE run_id=? AND chapter_num=1 ORDER BY id`, result.runId);
  assert.ok(reviews.length >= 2);
  assert.equal(reviews[0].verdict, 'fail', '硬性不通过要留审核记录');
  assert.equal(reviews[reviews.length - 1].verdict, 'pass');
  assert.ok(Number(reviews[reviews.length - 1].score) > 4);
});

test('未配置模型渠道时不会留下僵尸任务', async () => {
  const bookId = createBookWithOutlines('韧性-前置校验', 1);
  llm.activeChannel = () => null;
  const before = Number(db.one(`SELECT COUNT(*) AS n FROM generation_runs WHERE book_id=?`, bookId).n);
  await assert.rejects(() => misc.batchGenerateBodies({
    bookId, fromChapter: 1, toChapter: 1, chapterWords: CHAPTER_WORDS,
  }), /未配置模型渠道/);
  const after = Number(db.one(`SELECT COUNT(*) AS n FROM generation_runs WHERE book_id=?`, bookId).n);
  assert.equal(after, before, '前置校验失败不应创建任务记录');
});

test('auto 模式：单章失败继续推进，连续两章失败才停机', async () => {
  const bookId = createBookWithOutlines('韧性-auto', 4);
  stubModel((options) => {
    const chapter = chapterFromOptions(options);
    return chapter === 2 ? '太短了。' : longBody(chapter);
  });

  const result = await misc.batchGenerateBodies({
    bookId, fromChapter: 1, toChapter: 4, chapterWords: CHAPTER_WORDS, maxRetries: 1, retryBaseDelayMs: 1,
  });

  assert.deepEqual(result.created.map((item) => item.n), [1, 3, 4], '单章失败不应拦住后面三章');
  assert.deepEqual(result.quarantined.map((item) => item.n), [2]);
  assert.equal(result.stopReason, '', '只有一次连续失败，不该停机');
  assert.equal(result.ok, false, '有隔离章节时整体不算成功');

  const diagnostics = misc.generationRunStatus({ runId: result.runId });
  assert.equal(diagnostics.run.status, 'quarantined');
  assert.deepEqual(diagnostics.quarantined.map((item) => item.chapterNum), [2]);
});

test('auto 模式：连续失败达到阈值立即停机，不再空转', async () => {
  const bookId = createBookWithOutlines('韧性-连续失败', 4);
  stubModel((options) => {
    const chapter = chapterFromOptions(options);
    return chapter >= 2 ? '太短了。' : longBody(chapter);
  });

  const result = await misc.batchGenerateBodies({
    bookId, fromChapter: 1, toChapter: 4, chapterWords: CHAPTER_WORDS, maxRetries: 1, retryBaseDelayMs: 1,
  });

  assert.deepEqual(result.created.map((item) => item.n), [1]);
  assert.deepEqual(result.quarantined.map((item) => item.n), [2, 3], '第4章不该再尝试');
  assert.match(result.stopReason, /连续 2 章失败/);
  assert.equal(bodyFiles(bookId).length, 1);
});

test('运行结束写一份人能直接读的生成日志', async () => {
  const bookId = createBookWithOutlines('韧性-日志', 2);
  stubModel((options) => {
    const chapter = chapterFromOptions(options);
    return chapter === 2 ? '太短了。' : longBody(chapter);
  });
  const result = await misc.batchGenerateBodies({
    bookId, fromChapter: 1, toChapter: 2, chapterWords: CHAPTER_WORDS, maxRetries: 1, retryBaseDelayMs: 1,
    recoverMode: 'stop',
  });

  const log = core.readFileFrom({ bookId, group: '设定', name: '生成日志.md' }) || '';
  assert.match(log, /第1-2章/);
  assert.match(log, /新建 1 章/);
  assert.match(log, /隔离 1 章/);
  assert.match(log, /第2章（正文）/);
  assert.match(log, new RegExp(`任务：${result.runId}`));
});

test('单次尝试 token 失控会被判定为预算错误，且不重试', async () => {
  const bookId = createBookWithOutlines('韧性-失控', 2);
  stubModel((options) => longBody(chapterFromOptions(options)));

  const result = await misc.batchGenerateBodies({
    bookId, fromChapter: 1, toChapter: 2, chapterWords: CHAPTER_WORDS,
    maxRetries: 3, retryBaseDelayMs: 1, maxTokensPerChapter: 5,
  });

  assert.deepEqual(result.created, []);
  assert.match(result.quarantined[0].message, /超过单次上限/);
  const diagnostics = misc.generationRunStatus({ runId: result.runId });
  assert.equal(diagnostics.attempts.total, 2, '预算错误不该重试，两次失败对应两章各一次');
  assert.equal(diagnostics.chapterStats.quarantined, 2);
});

test('整轮 token 超限时保留断点暂停，可以接着续跑', async () => {
  const bookId = createBookWithOutlines('韧性-预算', 3);
  stubModel((options) => longBody(chapterFromOptions(options)));

  const first = await misc.batchGenerateBodies({
    bookId, fromChapter: 1, toChapter: 3, chapterWords: CHAPTER_WORDS,
    maxRetries: 1, retryBaseDelayMs: 1, maxTokensPerRun: 10,
  });

  assert.deepEqual(first.created.map((item) => item.n), [1], '超限后不应继续写第二章');
  assert.equal(first.runStatus, 'paused_budget');
  assert.match(first.stopReason, /已达到上限/);
  assert.equal(orch.getRun(first.runId).status, 'paused_budget');
  assert.ok(first.usage.totalTokens > 0);

  // 续跑授予一整窗新预算（已花 33 + 原窗 10 = 43）：写完第 2 章又超了，但能推进，不再秒停。
  const second = await misc.resumeGenerationRun({ runId: first.runId, maxRetries: 1, retryBaseDelayMs: 1 });
  assert.deepEqual(second.created.map((item) => item.n), [2], '预算窗口太小，续跑只推进一章，但必须有推进');
  assert.equal(second.runStatus, 'paused_budget', '预算仍在生效，不是无限续跑');
  // 显式给一个更大的上限即可跑完，显式参数优先于原任务选项。
  const third = await misc.resumeGenerationRun({ runId: first.runId, maxRetries: 1, retryBaseDelayMs: 1, maxTokensPerRun: 1000 });
  assert.deepEqual(third.created.map((item) => item.n), [3]);
  assert.equal(orch.getRun(first.runId).status, 'completed');
});

test('重写时把上次失败原因写回提示词，而不是原样再问一遍', async () => {
  const bookId = createBookWithOutlines('韧性-升级', 1);
  const seen = [];
  stubModel((options) => {
    seen.push(String(options.messages?.[1]?.content || ''));
    // 前两次（首次尝试 + 一次续写）都太短，逼出第二次尝试。
    return seen.length <= 2 ? '太短了。' : longBody(1);
  });

  const result = await misc.batchGenerateBodies({
    bookId, fromChapter: 1, toChapter: 1, chapterWords: CHAPTER_WORDS,
    maxRetries: 2, retryBaseDelayMs: 1,
  });

  assert.equal(result.created.length, 1);
  assert.ok(!seen[0].includes('上一次尝试被判定不合格'), '第一次尝试不该带纠错提示');
  const escalated = seen.filter((text) => text.includes('上一次尝试被判定不合格'));
  assert.equal(escalated.length, 1, '第二次尝试必须带上一次失败原因');
  assert.match(escalated[0], /篇幅|完整收尾|质量门禁/, '要把具体不达标的原因带进去');
  assert.ok(escalated[0].length > seen[0].length);
});

// ---------- 批量细纲：同一套可靠设施 ----------

function outlineJson(n, ok = true) {
  if (!ok) return '这不是细纲，只是一句话。';
  return JSON.stringify({
    title: `第${n}章 试炼`,
    goal: `推进第${n}章的目标`,
    conflict: '与守门人僵持',
    hook: '门外传来第三个人的脚步声',
    scenes: [
      { title: '试探', location: '长廊', summary: '试探守门人的底线' },
      { title: '交锋', location: '石门', summary: '冲突升级并留下悬念' },
    ],
    continuity: {
      time: `第${n}日`, location: '长廊',
      characters: [{ name: '沈砚', status: '清醒', goal: '进入石门', relations: '独行', location: '长廊' }],
      facts: [`第${n}章的石门仍未开启`], openThreads: [], resolvedThreads: [],
    },
    foreshadow: { planted: [`第${n}章的陌生名字`], advanced: [], resolved: [] },
  });
}

function outlineChapterFromOptions(options) {
  const system = String(options.messages?.[0]?.content || '');
  const matched = system.match(/本轮只生成第(\d+)章/);
  return matched ? Number(matched[1]) : 0;
}

// 细纲缺失时 generateOutlineForChapter 会先触发滚动规划窗口调用，桩必须会应答。
function isPlanCall(options) {
  return String(options.messages?.[0]?.content || '').includes('本次规划范围');
}

function planJsonFor(options) {
  const system = String(options.messages?.[0]?.content || '');
  const match = system.match(/只规划第(\d+)章到第(\d+)章/);
  const from = match ? Number(match[1]) : 1;
  const to = match ? Number(match[2]) : 3;
  const chapters = [];
  for (let n = from; n <= to; n++) chapters.push({ n, title: `第${n}章`, summary: `第${n}章的走向级梗概` });
  return JSON.stringify({ arcPlan: { chapters } });
}

function createBareBook(title, chapters) {
  const bookId = core.createBook({ title, genre: '长篇', pov: '第三人称' }).id;
  core.setBookPlanSettings({ bookId, totalChapters: chapters, chapterWords: CHAPTER_WORDS });
  return bookId;
}

test('批量细纲纳入状态机：记账、跳过已有、成功提交', async () => {
  const bookId = createBareBook('细纲-正常', 3);
  // 第1章已有细纲，应跳过且提交，续跑不再重做。
  core.writeFileTo({ bookId, group: '细纲', name: '细纲_第1章.md', content: outlineJson(1) });
  stubModel((options) => {
    if (isPlanCall(options)) return planJsonFor(options);
    if (String(options.messages?.[0]?.content || '').includes('自动细纲模式')) {
      return outlineJson(outlineChapterFromOptions(options));
    }
    throw new Error('细纲批量不应触发其它类型的调用');
  });

  const result = await misc.batchGenerateOutlines({
    bookId, fromChapter: 1, toChapter: 3, maxRetries: 2, retryBaseDelayMs: 1,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.skipped, [1]);
  assert.deepEqual(result.created.map((item) => item.n), [2, 3]);
  assert.ok(result.runId, '必须有编排任务');
  assert.ok(result.usage.totalTokens > 0, '细纲调用也要记账');
  const diagnostics = misc.generationRunStatus({ runId: result.runId });
  assert.equal(diagnostics.run.status, 'completed');
  assert.equal(diagnostics.chapterStats.committed, 3);
  assert.ok(diagnostics.attempts.total >= 2, '每章至少一次尝试记录');

  const log = core.readFileFrom({ bookId, group: '设定', name: '生成日志.md' }) || '';
  assert.match(log, /阶段：细纲/);
});

test('细纲失败会重试并把原因写回提示词，之后按策略隔离', async () => {
  const bookId = createBareBook('细纲-重试', 1);
  const seen = [];
  stubModel((options) => {
    if (isPlanCall(options)) return planJsonFor(options);
    const user = String(options.messages?.[1]?.content || '');
    seen.push(user);
    if (String(options.messages?.[0]?.content || '').includes('自动细纲模式')) {
      // 单次批量尝试内部还有一层 2 次调用的兜底；两次都失败才会抛到批量层，
      // 触发带失败原因的升级重试（attemptNo > 1 才写回 hint）。
      return seen.length <= 2 ? outlineJson(outlineChapterFromOptions(options), false) : outlineJson(outlineChapterFromOptions(options));
    }
    return '意外调用';
  });

  const result = await misc.batchGenerateOutlines({
    bookId, fromChapter: 1, toChapter: 1, maxRetries: 2, retryBaseDelayMs: 1,
  });

  assert.equal(result.created.length, 1);
  const escalated = seen.filter((text) => text.includes('上一次细纲未通过校验'));
  assert.equal(escalated.length, 1, '第二次尝试必须带上一次失败原因');
  assert.ok(!seen[0].includes('上一次细纲未通过校验'));
});

test('细纲批量：stop 策略单章失败停机，auto 隔离后继续', async () => {
  const bookId = createBareBook('细纲-策略', 3);
  stubModel((options) => {
    if (isPlanCall(options)) return planJsonFor(options);
    const n = outlineChapterFromOptions(options);
    return n === 2 ? '不行。' : outlineJson(n);
  });

  const stop = await misc.batchGenerateOutlines({
    bookId, fromChapter: 1, toChapter: 3, maxRetries: 1, retryBaseDelayMs: 1, recoverMode: 'stop',
  });
  assert.deepEqual(stop.created.map((item) => item.n), [1]);
  assert.deepEqual(stop.quarantined.map((item) => item.n), [2]);
  assert.match(stop.stopReason, /连续 1 章失败/);
  assert.equal(misc.generationRunStatus({ runId: stop.runId }).run.status, 'quarantined');

  const bookId2 = createBareBook('细纲-auto', 3);
  stubModel((options) => {
    if (isPlanCall(options)) return planJsonFor(options);
    const n = outlineChapterFromOptions(options);
    return n === 2 ? '不行。' : outlineJson(n);
  });
  const auto = await misc.batchGenerateOutlines({
    bookId: bookId2, fromChapter: 1, toChapter: 3, maxRetries: 1, retryBaseDelayMs: 1,
  });
  assert.deepEqual(auto.created.map((item) => item.n), [1, 3], '单章失败不拦后面');
  assert.equal(auto.stopReason, '');
});

test('细纲任务从断点续跑：复用 run、从第一个未完成章继续、已提交不重写', async () => {
  const bookId = createBareBook('细纲-续跑', 3);
  let failFirst = true;
  stubModel((options) => {
    if (isPlanCall(options)) return planJsonFor(options);
    const n = outlineChapterFromOptions(options);
    if (failFirst && n === 2) return '不行。';
    return outlineJson(n);
  });

  const first = await misc.batchGenerateOutlines({
    bookId, fromChapter: 1, toChapter: 3, maxRetries: 1, retryBaseDelayMs: 1, recoverMode: 'stop',
  });
  assert.deepEqual(first.created.map((item) => item.n), [1]);
  assert.deepEqual(first.quarantined.map((item) => item.n), [2]);

  failFirst = false;
  const second = await misc.resumeGenerationRun({ runId: first.runId, retryBaseDelayMs: 1 });
  assert.equal(second.resumed, true);
  assert.equal(second.fromChapter, 2);
  assert.equal(second.runId, first.runId, '细纲续跑同样复用原任务');
  assert.deepEqual(second.created.map((item) => item.n), [2, 3]);
  assert.equal(orch.getRun(first.runId).status, 'completed');

  const files = core.scanTree({ bookId }).find((item) => item.groupDir === '细纲').files.map((file) => file.name);
  files.sort();
  assert.deepEqual(files, ['细纲_第1章.md', '细纲_第2章.md', '细纲_第3章.md']);
});

test('全托管续跑保留模型审核，不静默退化为 local', async () => {
  const bookId = createBareBook('托管-续跑审核', 2);
  const reviewSeen = [];
  stubModel((options) => {
    const system = String(options.messages?.[0]?.content || '');
    if (isPlanCall(options)) return planJsonFor(options);
    if (system.includes('责任编辑')) {
      reviewSeen.push(String(options.messages?.[1]?.content || '').slice(0, 40));
      return JSON.stringify({
        hard: { world: true, knowledge: true, timeline: true, outline: true },
        scores: { causality: 4.2, voice: 4.2, pacing: 4.2, style: 4.2, information: 4.2, hook: 4.2 },
        issues: [],
      });
    }
    if (system.includes('自动正文模式')) {
      const chapter = chapterFromOptions(options);
      return chapter === 1 ? '太短了。' : longBody(chapter);
    }
    if (system.includes('自动细纲模式')) return outlineJson(outlineChapterFromOptions(options));
    return '意外调用';
  });

  // 正文模式记录 reviewMode:'model'（全托管路径同款参数），第1章不达标且 stop 策略停机。
  const first = await misc.batchGenerateBodies({
    bookId, fromChapter: 1, toChapter: 2, chapterWords: CHAPTER_WORDS,
    maxRetries: 1, retryBaseDelayMs: 1, recoverMode: 'stop', reviewMode: 'model',
  });
  assert.equal(first.created.length, 0);
  assert.equal(first.quarantined.length, 1);
  assert.equal(reviewSeen.length, 0, '正文太短过不了本地门禁，不会走到模型审核');

  stubModel((options) => {
    const system = String(options.messages?.[0]?.content || '');
    if (isPlanCall(options)) return planJsonFor(options);
    if (system.includes('责任编辑')) {
      reviewSeen.push('review');
      return JSON.stringify({
        hard: { world: true, knowledge: true, timeline: true, outline: true },
        scores: { causality: 4.2, voice: 4.2, pacing: 4.2, style: 4.2, information: 4.2, hook: 4.2 },
        issues: [],
      });
    }
    if (system.includes('自动正文模式')) return longBody(chapterFromOptions(options));
    if (system.includes('自动细纲模式')) return outlineJson(outlineChapterFromOptions(options));
    return '意外调用';
  });

  const second = await misc.resumeGenerationRun({ runId: first.runId, retryBaseDelayMs: 1 });
  assert.deepEqual(second.created.map((item) => item.n), [1, 2]);
  assert.ok(reviewSeen.length >= 2, `续跑必须保留模型审核，实际审核 ${reviewSeen.length} 次`);
});
