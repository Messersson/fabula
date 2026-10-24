'use strict';

// 500 章端到端仿真。单元与韧性测试证明"每个部件正确"，这里证明的是
// "这套状态机能独立跑完全程"：全托管模式（细纲+正文一体）连跑 500 章，
// 中途注入三类故障——
//   1. 第 50/150/400 章首次尝试不达标（升级重试后恢复，考察 escalateRetry）；
//   2. 第 100/300 章在首轮永远不达标（auto 模式隔离后继续，续跑补齐）；
//   3. 每窗 12000 tokens 的整轮预算（两次预算暂停，最后一段显式放大预算收尾）。
// 通过标准：500 章全部提交、三段共用同一个 run、token 账目与桩的调用次数
// 分毫不差、已提交章节零重做、生成日志/一致性报告/连载进度真实落盘。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-sim-'));
process.env.FABULA_DATA_DIR = tempDir;
// 重负载仿真沿用本机默认的 WAL，不要容器场景的回滚日志。
process.env.FABULA_SQLITE_JOURNAL = 'WAL';

const db = require('../lib/db');
db.open(path.join(__dirname, '..', 'data', 'writerx.seed.db'));

const audit = require('../lib/consistency-audit');
const core = require('../lib/handlers-core');
const llm = require('../lib/llm');
const misc = require('../lib/handlers-misc');
const orch = require('../lib/longform-orchestrator');

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const TOTAL = 500;
const CHAPTER_WORDS = 400;
const FAIL_CHAPTERS = new Set([100, 300]); // 首轮永远失败 → 隔离，末段续跑补齐
const ESCALATE_CHAPTERS = new Set([50, 150, 400]); // 仅首次尝试失败 → 升级重试恢复
const USAGE = { prompt_tokens: 11, completion_tokens: 22 };
const TOKENS_PER_CALL = 33;

// 与韧性测试相同的句子池；正文每句带上章号盐，保证 500 章之间没有逐字重合。
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

function uniqueBody(n) {
  const parts = [];
  // 步进 10 取句：相邻章共享 0 句（本地门禁 40 字逐字重合阈值），
  // 相距 3 章的章共享整句但被章号盐打断，凑不出跨章审计的 80 字阈值。
  const offset = ((n - 1) * 10) % SENTENCE_POOL.length;
  for (let i = 0; i < 8; i++) {
    parts.push(`第${n}章第${i + 1}景，${SENTENCE_POOL[(offset + i) % SENTENCE_POOL.length]}`);
  }
  parts.push(`第${n}章的灯火渐次熄灭，门外为什么又响起了第三个人的脚步声？`);
  return parts.join('');
}

function outlineJson(n) {
  return JSON.stringify({
    title: `第${n}章 试炼`,
    goal: `推进第${n}章的目标`,
    conflict: '与守门人僵持',
    hook: '门外传来第三个人的脚步声',
    scenes: [
      { title: '试探', location: '长廊', summary: `第${n}章试探守门人的底线` },
      { title: '交锋', location: '石门', summary: `第${n}章冲突升级并留下悬念` },
    ],
    continuity: {
      time: `第${n}日`, location: '长廊',
      characters: [{ name: '沈砚', status: '清醒', goal: '进入石门', relations: '独行', location: '长廊' }],
      facts: [`第${n}章的石门仍未开启`], openThreads: [], resolvedThreads: [],
    },
    foreshadow: { planted: [`第${n}章的陌生名字`], advanced: [], resolved: [] },
  });
}

function chapterFromSystem(options) {
  const matched = String(options.messages?.[0]?.content || '').match(/本轮只生成第(\d+)章/);
  return matched ? Number(matched[1]) : 0;
}

function planJsonFor(options) {
  const matched = String(options.messages?.[0]?.content || '').match(/只规划第(\d+)章到第(\d+)章/);
  const from = matched ? Number(matched[1]) : 1;
  const to = matched ? Number(matched[2]) : 20;
  const chapters = [];
  for (let n = from; n <= to; n++) chapters.push({ n, title: `第${n}章`, summary: `第${n}章的走向级梗概` });
  return JSON.stringify({ arcPlan: { chapters } });
}

function stubSimulationModel() {
  const state = { planCalls: 0, outlineCalls: 0, bodyCalls: new Map(), escalationPrompts: 0, firstPass: true };
  llm.activeChannel = () => ({ baseUrl: 'http://stub.local', key: 'stub', model: 'stub-model', noThinking: true });
  llm.chatCompletion = async function* (options) {
    const system = String(options.messages?.[0]?.content || '');
    const user = String(options.messages?.[1]?.content || '');
    if (system.includes('本次规划范围')) {
      state.planCalls += 1;
      yield { type: 'delta', text: planJsonFor(options) };
      yield { type: 'meta', usage: USAGE, finishReason: 'stop' };
      return;
    }
    if (system.includes('自动正文模式')) {
      const n = chapterFromSystem(options);
      state.bodyCalls.set(n, (state.bodyCalls.get(n) || 0) + 1);
      const escalated = user.includes('上一次尝试被判定不合格');
      if (escalated) state.escalationPrompts += 1;
      // 永久失败章在首轮无视升级提示；升级章只在带失败原因的重试里恢复。
      const fail = FAIL_CHAPTERS.has(n) ? state.firstPass : (ESCALATE_CHAPTERS.has(n) && !escalated);
      yield { type: 'delta', text: fail ? '太短了。' : uniqueBody(n) };
      yield { type: 'meta', usage: USAGE, finishReason: 'stop' };
      return;
    }
    if (system.includes('自动细纲模式')) {
      state.outlineCalls += 1;
      yield { type: 'delta', text: outlineJson(chapterFromSystem(options)) };
      yield { type: 'meta', usage: USAGE, finishReason: 'stop' };
      return;
    }
    throw new Error(`仿真桩收到未预期的调用：${system.slice(0, 80)}`);
  };
  return state;
}

function groupFileNames(bookId, groupDir) {
  const group = core.scanTree({ bookId }).find((item) => item.groupDir === groupDir) || { files: [] };
  return group.files.map((file) => file.name);
}

test('500 章全托管仿真：故障隔离、两次预算暂停、续跑收尾，最终全部提交', async () => {
  const bookId = core.createBook({ title: '仿真-五百章', genre: '长篇', pov: '第三人称' }).id;
  core.setBookPlanSettings({ bookId, totalChapters: TOTAL, chapterWords: CHAPTER_WORDS });
  const stub = stubSimulationModel();

  // ---- 第一段：从第 1 章起跑，第 100 章被隔离，预算耗尽后暂停 ----
  const first = await misc.batchGenerateBodies({
    bookId, fromChapter: 1, toChapter: TOTAL, chapterWords: CHAPTER_WORDS,
    maxRetries: 2, retryBaseDelayMs: 1, maxTokensPerRun: 12000,
  });

  assert.equal(first.runStatus, 'paused_budget');
  assert.match(first.stopReason, /已达到上限/);
  assert.ok(first.usage.totalTokens >= 12000, '暂停时本轮已花满一窗预算');
  assert.deepEqual(first.quarantined.map((item) => item.n), [100], '第100章隔离后循环必须继续推进');
  assert.ok(first.created.length >= 140, `第一段应推进百余章，实际 ${first.created.length}`);
  assert.ok(first.created.every((item) => item.n !== 100));
  assert.equal(orch.getRun(first.runId).status, 'paused_budget', '任务保留断点');

  // ---- 第二段：续跑重排第 100 章（仍然失败），推进到第二次预算暂停 ----
  const second = await misc.resumeGenerationRun({ runId: first.runId, retryBaseDelayMs: 1 });
  assert.equal(second.resumed, true);
  assert.equal(second.runId, first.runId, '续跑复用原任务');
  assert.equal(second.runStatus, 'paused_budget', '预算窗口按原任务选项续算，再次暂停');
  assert.deepEqual(second.quarantined.map((item) => item.n), [100, 300], '第100章复隔离，第300章首次隔离');
  assert.equal(second.fromChapter, 100, '续跑点从第一个未提交章开始');

  // ---- 第三段：故障解除 + 显式放大预算，收尾 ----
  stub.firstPass = false;
  const third = await misc.resumeGenerationRun({
    runId: first.runId, retryBaseDelayMs: 1, maxTokensPerRun: 1000000,
  });
  assert.equal(third.resumed, true);
  assert.equal(third.runStatus, 'completed');
  assert.equal(third.stopReason, '');
  assert.equal(third.quarantined.length, 0);
  assert.ok(third.created.some((item) => item.n === 100), '续跑必须把隔离的第100章补上');
  assert.ok(third.created.some((item) => item.n === 300), '续跑必须把隔离的第300章补上');
  assert.equal(orch.getRun(first.runId).status, 'completed', '三段共用一个任务并收尾');

  // ---- 全局状态机不变量 ----
  const runs = db.q(`SELECT mode, status FROM generation_runs WHERE book_id=?`, bookId);
  assert.equal(runs.length, 1, '全程只允许存在一个 run，不因续跑分裂');
  assert.equal(runs[0].mode, 'full');
  assert.equal(runs[0].status, 'completed');

  const diagnostics = misc.generationRunStatus({ runId: first.runId });
  assert.equal(diagnostics.chapterStats.committed, TOTAL);
  assert.equal(diagnostics.quarantined.length, 0, '收尾后不允许残留隔离章节');
  // 失败尝试：升级章 3 次 + 第100章（2+2）+ 第300章 2 次。
  assert.equal(diagnostics.attempts.failed, 9);
  // 尝试总数：500 次细纲 + 正文（495 次成功 + 升级章各多 1 次共 6 + 第100章 5 + 第300章 3）。
  assert.equal(diagnostics.attempts.total, 500 + 495 + 6 + 5 + 3);

  // ---- token 账目：库里记的必须等于桩实际收到的调用次数 × 每次消耗 ----
  const bodyCallTotal = [...stub.bodyCalls.values()].reduce((sum, value) => sum + value, 0);
  const totalCalls = stub.planCalls + stub.outlineCalls + bodyCallTotal;
  const usage = orch.runUsage(first.runId);
  assert.equal(usage.totalTokens, totalCalls * TOKENS_PER_CALL,
    `账目 ${usage.totalTokens} ≠ 桩记录 ${totalCalls} 次调用的 ${totalCalls * TOKENS_PER_CALL}`);
  assert.equal(stub.outlineCalls, TOTAL, '每章细纲只生成一次');

  // ---- 零重做：每章正文的生成次数必须精确等于故障注入方案 ----
  for (let n = 1; n <= TOTAL; n++) {
    const calls = stub.bodyCalls.get(n) || 0;
    if (n === 100) assert.equal(calls, 9, `第${n}章：两轮各 2 次失败尝试（含续写）+ 收尾 1 次`);
    else if (n === 300) assert.equal(calls, 5, `第${n}章：1 轮 2 次失败尝试 + 收尾 1 次`);
    else if (ESCALATE_CHAPTERS.has(n)) assert.equal(calls, 3, `第${n}章：失败尝试（含续写）+ 升级重试`);
    else assert.equal(calls, 1, `第${n}章正文只应生成一次，实际 ${calls} 次`);
  }
  assert.equal(stub.escalationPrompts, 6, '升级提示只出现在带失败原因的重试里（3 升级章 + 3 永久失败章的末次尝试）');

  // ---- 文件系统：500 章正文与细纲，各一份，无重复 ----
  const bodies = groupFileNames(bookId, '正文').sort();
  assert.equal(bodies.length, TOTAL);
  assert.deepEqual(bodies, Array.from({ length: TOTAL }, (_, i) => `第${i + 1}章.md`).sort());
  const outlines = groupFileNames(bookId, '细纲').sort();
  assert.equal(outlines.length, TOTAL);

  // ---- 长期记忆 ----
  assert.equal(Number(db.one(`SELECT COUNT(*) AS n FROM chapter_summaries WHERE book_id=?`, bookId).n), TOTAL);
  assert.equal(Number(db.one(`SELECT COUNT(*) AS n FROM chapter_plans WHERE book_id=?`, bookId).n), TOTAL);
  assert.ok(Number(db.one(`SELECT COUNT(*) AS n FROM chapter_continuity WHERE book_id=?`, bookId).n), TOTAL,
    '每章都应留下连续性状态');
  assert.ok(Number(db.one(`SELECT COUNT(*) AS n FROM character_mentions WHERE book_id=?`, bookId).n) >= TOTAL);

  // ---- 人能读的产物 ----
  const log = core.readFileFrom({ bookId, group: '设定', name: '生成日志.md' }) || '';
  assert.equal((log.match(/^## /gm) || []).length, 3, '三段推进各留一条日志（取消和异常也要留痕，这里是正常三段）');
  assert.match(log, /第1-500章（预算暂停）/);
  assert.match(log, /第100-500章（预算暂停）/);
  assert.match(log, /第100-500章（完成）/);
  assert.match(log, /隔离 1 章/);
  assert.match(log, /隔离 2 章/);
  assert.match(log, /停机原因：累计消耗/);
  assert.equal((log.match(new RegExp(`任务：${first.runId}`, 'g')) || []).length, 3, '三段日志指向同一个任务');

  const report = core.readFileFrom({ bookId, group: '设定', name: '一致性报告.md' }) || '';
  assert.match(report, /第491-500章/, '最后一个窗口审计必须落进报告');
  assert.match(report, /第10卷（第451-500章）/);
  const windowAudit = audit.latest({ bookId, scope: 'window' });
  assert.equal(windowAudit.toChapter, TOTAL);
  assert.equal(windowAudit.verdict, 'ok', '正文按章加盐后，末窗不应有重复桥段、钩子缺失或篇幅漂移');
  const volumeAudit = audit.latest({ bookId, scope: 'volume' });
  assert.equal(volumeAudit.toChapter, TOTAL);
  assert.ok(volumeAudit.metrics.openThreads >= 450, '500 章各埋一条伏笔且从不回收，卷审计必须抓到堆积');
  assert.ok(volumeAudit.issues.some((issue) => issue.code === 'thread_backlog'), '卷审计要报告伏笔堆积');

  const progress = core.readFileFrom({ bookId, group: '设定', name: '连载进度.md' }) || '';
  assert.match(progress, /最后完成章节：第500章/);
});
