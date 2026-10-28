'use strict';

// AI 评审机制：开关 / 评审团 / 评审库 / 独立评审 / 交叉验证 / 轮次记录 / 页面。
//
// 这一层最容易「看起来做了、其实没做」的地方是独立性与交叉验证：
// 如果三位评审员收到的是同一份提示词、或者汇总时把互斥意见一起采纳，
// 界面上依然会显示「三位评审员已出具意见」，但机制已经退化成一次自评。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-review-'));
process.env.FABULA_DATA_DIR = tempDir;
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';

const db = require('../lib/db');
db.open(path.join(__dirname, '..', 'data', 'writerx.seed.db'));

const llm = require('../lib/llm');
const review = require('../lib/review-engine');
const reviewPage = require('../lib/review-page');
const docEngine = require('../lib/doc-engine');

const TOKEN = 'review-csrf-token';
let server = null;
let baseUrl = '';

// 三个渠道：评审团要求渠道互不相同，否则「多厂商评审」退化
const CHANNELS = [
  { id: 'ch_a', label: '厂商甲 / 模型 X', model: 'model-x', baseUrl: 'http://stub.local' },
  { id: 'ch_b', label: '厂商乙 / 模型 Y', model: 'model-y', baseUrl: 'http://stub.local' },
  { id: 'ch_c', label: '厂商丙 / 模型 Z', model: 'model-z', baseUrl: 'http://stub.local' },
];

const REAL_LLM = { chatCompletion: llm.chatCompletion, activeChannel: llm.activeChannel };

function restoreModel() {
  llm.chatCompletion = REAL_LLM.chatCompletion;
  llm.activeChannel = REAL_LLM.activeChannel;
}

function stubModel(handler) {
  llm.activeChannel = () => ({ baseUrl: 'http://stub.local', key: 'stub', model: 'stub-model' });
  llm.chatCompletion = async function* (options) {
    const text = handler(options);
    yield { type: 'delta', text };
    yield { type: 'meta', usage: { prompt_tokens: 10, completion_tokens: 20 }, finishReason: 'stop' };
  };
}

function seedChannels() {
  db.run(`INSERT INTO settings(key,value) VALUES('channels',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify(CHANNELS));
  for (const channel of CHANNELS) {
    db.run(`INSERT INTO settings(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`, `channel_key__${channel.id}`, 'sk-test');
  }
}

before(async () => {
  seedChannels();
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    reviewPage.handleReview(req, res, u.pathname, TOKEN).then((handled) => {
      if (!handled && !res.writableEnded) { res.writeHead(404); res.end('nf'); }
    }).catch((error) => { if (!res.writableEnded) { res.writeHead(500); res.end(String(error.message)); } });
  });
  // keep-alive 要长于用例之间的空档：默认 5 秒，而两个 HTTP 用例之间可能隔十几秒，
  // 服务端先关掉空闲连接、undici 又复用了它，就会报「fetch failed」——
  // 看起来像业务崩了，其实是测试脚手架的连接复用竞态。
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  restoreModel();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

async function get(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, { redirect: 'manual' });
  return { status: response.status, text: await response.text() };
}

async function post(pathname, fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) params.append(key, value == null ? '' : String(value));
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    redirect: 'manual',
  });
  return { status: response.status, location: response.headers.get('location') || '', text: await response.text() };
}

function makePanel(overrides = {}) {
  return review.savePanel({
    name: overrides.name || '测试评审团',
    workbench: overrides.workbench || 'doc',
    docType: overrides.docType || '',
    reviewers: overrides.reviewers || [
      { name: '审稿人甲', channelId: 'ch_a', modelLabel: '厂商甲 / 模型 X', persona: '学术审稿人' },
      { name: '逻辑专家乙', channelId: 'ch_b', modelLabel: '厂商乙 / 模型 Y', persona: '论证逻辑专家' },
      { name: '规范审查丙', channelId: 'ch_c', modelLabel: '厂商丙 / 模型 Z', persona: '引用与格式规范审查员' },
    ],
  });
}

// 开关状态是全局设置，会跨用例泄漏：前一个用例关掉「文档工作台」，
// 后一个用例只打开全局，仍然全是关的。每个涉及开关的用例先清干净。
function resetReviewScopes() {
  db.run(`DELETE FROM settings WHERE key LIKE 'review_scope__%'`);
  db.run(`INSERT INTO settings(key,value) VALUES('review_enabled','0')
    ON CONFLICT(key) DO UPDATE SET value='0'`);
}

function makeDoc(text) {
  const project = docEngine.createProject({ title: '评审测试稿', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1, text || '设备国产化率偏低是产能扩张的主要约束。企业应当推进数字化。', 'manual');
  return project;
}

// ---------- 开关 ----------

test('开关：默认关闭，按工作台与文档类型独立生效', () => {
  review.setEnabled({ enabled: false });
  assert.equal(review.isEnabled('doc', 'paper'), false, '默认必须关闭');
  assert.equal(review.isEnabled('novel'), false);

  review.setEnabled({ enabled: true });
  assert.equal(review.isEnabled('doc', 'paper'), true);
  assert.equal(review.isEnabled('novel'), true);

  // 只关文档的论文类型：其他类型与工作台不受影响
  review.setEnabled({ enabled: false, workbench: 'doc', docType: 'paper' });
  assert.equal(review.isEnabled('doc', 'paper'), false);
  assert.equal(review.isEnabled('doc', 'proposal'), true);
  assert.equal(review.isEnabled('novel'), true);

  // 关整个文档工作台：小说仍然开着
  review.setEnabled({ enabled: false, workbench: 'doc' });
  assert.equal(review.isEnabled('doc', 'proposal'), false);
  assert.equal(review.isEnabled('novel'), true);

  const state = review.enableState('doc', 'paper');
  assert.equal(state.global, true);
  assert.equal(state.scoped, '0');
  assert.equal(state.effective, false);

  review.setEnabled({ enabled: false });
});

// ---------- 评审团 ----------

test('评审团：1~3 位，渠道必须互不相同', () => {
  assert.throws(() => review.savePanel({ name: '空团', reviewers: [] }), /至少要有一位/);
  assert.throws(() => review.savePanel({
    name: '重复渠道',
    reviewers: [{ name: 'A', channelId: 'ch_a' }, { name: 'B', channelId: 'ch_a' }],
  }), /不能重复/);
  assert.throws(() => review.savePanel({
    name: '太多',
    reviewers: ['ch_a', 'ch_b', 'ch_c', 'ch_a'].map((channelId, index) => ({ name: `R${index}`, channelId })),
  }), /最多 3 位/);

  // 不同渠道、同一服务地址与模型：仍然只是同一个模型自评两次，保存时就要拒绝
  const withTwin = [...CHANNELS, { id: 'ch_a2', label: '厂商甲 / 模型 X（第二把密钥）', model: 'model-x', baseUrl: 'http://stub.local' }];
  db.run(`UPDATE settings SET value=? WHERE key='channels'`, JSON.stringify(withTwin));
  db.run(`INSERT INTO settings(key,value) VALUES('channel_key__ch_a2','sk-test')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  try {
    assert.throws(() => review.savePanel({
      name: '同模型团',
      reviewers: [
        { name: '甲', channelId: 'ch_a' },
        { name: '乙', channelId: 'ch_b' },
        { name: '甲的二号密钥', channelId: 'ch_a2' },
      ],
    }), /同一服务地址与模型/);
  } finally {
    db.run(`UPDATE settings SET value=? WHERE key='channels'`, JSON.stringify(CHANNELS));
    db.run(`DELETE FROM settings WHERE key='channel_key__ch_a2'`);
  }

  const panel = makePanel({ name: '学术评审团', docType: 'paper' });
  assert.equal(panel.reviewers.length, 3);
  assert.equal(panel.reviewers[0].persona, '学术审稿人');
  // 重新保存同一个团：成员被整体替换，不会残留旧成员
  const updated = review.savePanel({
    id: panel.id, name: '学术评审团', workbench: 'doc', docType: 'paper',
    reviewers: [{ name: '唯一的评审员', channelId: 'ch_a' }],
  });
  assert.equal(updated.reviewers.length, 1);
  review.deletePanel(panel.id);
  assert.equal(review.getPanel(panel.id), null);
});

test('评审团：按文档类型挑默认团，类型优先于通用', () => {
  const generic = makePanel({ name: '通用团', docType: '' });
  const paper = makePanel({ name: '论文团', docType: 'paper' });
  assert.equal(review.defaultPanel('doc', 'paper').name, '论文团');
  assert.equal(review.defaultPanel('doc', 'proposal').name, '通用团');
  review.deletePanel(generic.id);
  review.deletePanel(paper.id);
});

test('用户自定义文档类型：自定义小节能进入评审，类型级开关可单独控制', () => {
  const project = docEngine.createProject({
    title: '自定义类型稿', docType: 'custom', mode: 'co',
    sections: [
      { title: '背景与问题', brief: '交代背景与要解决的问题', minChars: 100 },
      { title: '方案与取舍', brief: '说明方案与取舍理由', minChars: 100 },
    ],
  });
  assert.equal(docEngine.docTypeOf('custom').name, '自定义文档');
  const work = review.resolveWork({ workbench: 'doc', workId: project.id, sectionIdx: 1 });
  assert.equal(work.type, 'doc:custom', '自定义类型也要有自己的类型标识，采购默认 Skill 与评审团');
  assert.match(work.title, /背景与问题/);

  resetReviewScopes();
  review.setEnabled({ enabled: true });
  review.setEnabled({ enabled: false, workbench: 'doc', docType: 'custom' });
  assert.equal(review.isEnabled('doc', 'custom'), false, '自定义类型可以单独关闭');
  assert.equal(review.isEnabled('doc', 'paper'), true, '其他文档类型不受影响');
  review.setEnabled({ enabled: false });
  // 类型级开关页面也要列出「自定义」，否则自定义文档永远无法单独配置
  const page = reviewPage.renderSwitch(TOKEN, 'doc', 'custom');
  assert.match(page, /自定义文档/);
});

test('评审团：可以编辑成员与上限，页面预填现有配置', () => {
  const panel = makePanel({ name: '待编辑团' });
  const edited = review.savePanel({
    id: panel.id, name: '改过的团', workbench: 'doc', docType: 'report', maxRounds: 3,
    reviewers: [
      { name: '新评审甲', channelId: 'ch_a', persona: '新的人设' },
      { name: '新评审乙', channelId: 'ch_b' },
    ],
  });
  assert.equal(edited.id, panel.id, '编辑必须复用同一个评审团，而不是新建一个');
  assert.equal(edited.name, '改过的团');
  assert.equal(edited.maxRounds, 3);
  assert.equal(edited.reviewers.length, 2, '成员按表单整体替换');
  assert.equal(edited.reviewers[0].persona, '新的人设');

  const page = reviewPage.renderPanels(TOKEN, 'doc');
  assert.match(page, /编辑这个评审团/);
  assert.match(page, /改过的团/);
  assert.match(page, /新评审甲/);
  assert.match(page, /新的人设/);
  review.deletePanel(panel.id);
});

test('评审团：同一渠道的两个评审员会被标出「独立性可能不成立」，Skill 冲突也可见', () => {
  // 直接构造一个绕过保存校验的团，用来验证检查本身：
  // 两条记录指向同一渠道时，提示必须出现——这正是多厂商评审最容易名存实亡的地方。
  const fake = {
    workbench: 'doc', docType: '',
    reviewers: [
      { id: 'rv_fake1', name: '评审员甲', channelId: 'ch_a' },
      { id: 'rv_fake2', name: '评审员乙', channelId: 'ch_a' },
    ],
  };
  const warnings = review.panelWarnings(fake);
  assert.ok(warnings.some((text) => /同一服务地址与模型/.test(text)), '同渠道要提示独立性不成立');

  const method = review.saveSkill({
    name: '逐项详评框架', kind: 'method', appliesTo: 'doc',
    body: '按完整框架逐项打分，每个维度都要写详评，不得省略任何一项。',
  });
  const style = review.saveSkill({
    name: '三句话短评风格', kind: 'style', appliesTo: 'doc',
    body: '只写三句话短评，极简表达，不做逐项展开。',
  });
  const conflictWarnings = review.panelWarnings(makePanel({ name: '冲突团' }));
  assert.ok(conflictWarnings.some((text) => /冲突/.test(text)), '风格与技能冲突要在评审团页面上可见');
  review.deleteSkill(method.id);
  review.deleteSkill(style.id);
  for (const panel of review.listPanels('doc')) {
    if (panel.name === '冲突团') review.deletePanel(panel.id);
  }
});

// ---------- 评审库 ----------

test('评审库：共享池 + 专属库，按作品类型匹配', () => {
  const paperSkill = review.saveSkill({
    name: '论文引用规范', kind: 'focus', appliesTo: 'doc:paper',
    body: '每条引用必须在参考文献里出现；正文引用编号与文献顺序一致；不得引用未提供文献。',
  });
  const novelSkill = review.saveSkill({
    name: '开篇钩子检查', kind: 'focus', appliesTo: 'novel',
    body: '前 300 字内必须出现一个具体冲突或悬念；不得用天气、回忆、设定说明开场。',
  });
  const sharedMethod = review.saveSkill({
    name: '通用评审框架', kind: 'method', appliesTo: '*',
    body: '先通读判断整体印象，再按维度逐项打分，最后复核必须修改项是否可执行。',
  });

  const paper = review.skillsFor({ workType: 'doc:paper' });
  assert.ok(paper.focus.some((item) => item.name === '论文引用规范'), '论文类 Skill 要匹配上');
  assert.ok(!paper.focus.some((item) => item.name === '开篇钩子检查'), '小说 Skill 不能匹配论文');
  assert.ok(paper.method.some((item) => item.name === '通用评审框架'), '通配 Skill 对所有类型生效');

  const novel = review.skillsFor({ workType: 'novel' });
  assert.ok(novel.focus.some((item) => item.name === '开篇钩子检查'));
  assert.ok(!novel.focus.some((item) => item.name === '论文引用规范'));

  // 专属库只对该评审员生效
  const owned = review.saveSkill({
    reviewerId: 'rv_test', name: '专属重点', kind: 'focus', appliesTo: 'doc',
    body: '这一条只给某位评审员用，其他评审员看不到，用于验证归属隔离。',
  });
  assert.ok(review.skillsFor({ reviewerId: 'rv_test', workType: 'doc:paper' }).focus.some((item) => item.id === owned.id));
  assert.ok(!review.skillsFor({ reviewerId: 'rv_other', workType: 'doc:paper' }).focus.some((item) => item.id === owned.id));

  assert.throws(() => review.saveSkill({ name: 'x', appliesTo: '', body: '这段内容足够长，但故意不声明适用作品类型，用来验证入库校验会拦住它。' }), /适用作品类型/);
  for (const skill of [paperSkill, novelSkill, sharedMethod, owned]) review.deleteSkill(skill.id);
});

test('评审库：风格与技能冲突要拦下来', () => {
  const warnings = review.checkCompatibility({
    method: [{ name: '框架', body: '逐项打分，按完整框架分维度详评' }],
    style: [{ name: '短评', body: '三句话短评，极简' }],
    focus: [{ name: '重点', body: '论证' }],
  });
  assert.ok(warnings.some((text) => /冲突/.test(text)), '短评 + 逐项详评 必须提示冲突');

  const quiet = review.checkCompatibility({
    method: [{ name: '框架', body: '逐项打分' }],
    style: [{ name: '严谨', body: '学术严谨，条理清晰' }],
    focus: [{ name: '重点', body: '论证' }],
  });
  assert.equal(quiet.length, 0);
});

// ---------- 独立评审 ----------

test('一轮评审：三位评审员各拿一份提示词，互不可见', async () => {
  const project = makeDoc();
  const panel = makePanel();
  const prompts = [];
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    const user = String(options.messages?.[1]?.content || '');
    prompts.push(`${sys}\n${user}`);
    return JSON.stringify({
      score: 70, grade: 'B', summary: '整体可用。',
      highlights: [{ text: '结论明确', why: '每段有判断句' }],
      issues: [{ severity: 'major', dimension: '论证论据', text: '论证缺少机制解释', where: '第 1 段' }],
      suggestions: [{ issue: '论证缺少机制解释', change: '补因果链', how: '说明为什么', why: '否则只是结论' }],
      priority: ['补机制'], focus: ['论证'],
    });
  });
  const result = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  assert.equal(result.ok, true);
  assert.equal(result.report.scores.length, 3, '三位评审员都要有独立结果');
  // 提示词里带【角色人设】的才是评审员调用；另外一次是可行性评估（规范第六条）
  const reviewerPrompts = prompts.filter((text) => text.includes('【角色人设】'));
  assert.equal(reviewerPrompts.length, 3, '每位评审员各自一次调用');

  // 独立性的证据：三份提示词各自带自己的人设，且不含别人的名字
  const byPersona = ['学术审稿人', '论证逻辑专家', '引用与格式规范审查员'];
  for (const persona of byPersona) {
    const hit = prompts.filter((text) => text.includes(`【角色人设】${persona}`));
    assert.equal(hit.length, 1, `人设「${persona}」应只出现在一份提示词里`);
    const others = byPersona.filter((item) => item !== persona);
    for (const other of others) {
      assert.ok(!hit[0].includes(other), `「${persona}」的提示词里不能出现「${other}」（评审员之间不得互相参考）`);
    }
  }
  review.deletePanel(panel.id);
});

test('一轮评审：共识合并、单人一般问题不采纳、分歧先仲裁再采纳', async () => {
  const project = makeDoc('这一节只有结论没有论证。设备国产化率偏低是主要约束，企业应当推进数字化。');
  const panel = makePanel();
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('评审组长')) {
      // 仲裁：判定「过简」这一方成立
      return JSON.stringify({
        rulings: [{ index: 1, winner: '论证过简', reason: '正文只有结论，确实没有机制', instruction: '补一段因果链，说明为什么国产化率低会限制扩产' }],
      });
    }
    const name = (sys.match(/你是「([^」]+)」/) || [])[1] || '';
    if (name === '审稿人甲') {
      return JSON.stringify({
        score: 55, grade: 'C', summary: '论证不足。', highlights: [],
        issues: [
          { severity: 'fatal', dimension: '论证论据', text: '论证过于简略，只有结论没有机制解释', where: '第 1 段' },
          { severity: 'minor', dimension: '术语', text: '个别术语前后不一致', where: '全文' },
        ],
        suggestions: [], priority: [], focus: [],
      });
    }
    if (name === '逻辑专家乙') {
      return JSON.stringify({
        score: 60, grade: 'C', summary: '论证链条断裂。', highlights: [],
        issues: [
          // 与甲同一问题（换了说法）→ 应合并为共识
          { severity: 'major', dimension: '论证论据', text: '论证过简，缺少机制层面的解释', where: '第 1 段' },
        ],
        suggestions: [], priority: [], focus: [],
      });
    }
    return JSON.stringify({
      score: 75, grade: 'B', summary: '篇幅可以再收。', highlights: [],
      issues: [
        // 与「过简」方向相反 → 应识别为分歧，而不是两条都采纳
        { severity: 'major', dimension: '论证论据', text: '论证冗余，同一意思重复了三遍', where: '第 1 段' },
      ],
      suggestions: [], priority: [], focus: [],
    });
  });
  const result = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  const round = review.getRound(result.roundId);
  const consensus = round.decisions.filter((item) => item.kind === 'consensus');
  const conflicts = round.decisions.filter((item) => item.kind === 'conflict');
  const singleMinor = round.decisions.filter((item) => item.kind === 'single' && item.severity === 'minor');

  // 甲 + 乙 换着说法提同一问题（2 票）→ 与丙的相反意见（1 票）构成分歧，
  // 按多数倾向就地裁决：采纳多数、记录少数，不再单独产出一条「共识」。
  assert.equal(consensus.length, 0, '参与分歧的多数方不再单列为共识，避免同一条既采纳又待定');
  assert.equal(conflicts.length, 1, '方向相反的意见要识别成分歧');
  assert.equal(conflicts[0].adopted, true, '2 票 vs 1 票：按多数倾向采纳');
  assert.match(conflicts[0].reason, /2 票 vs 1 票/);
  assert.match(conflicts[0].reason, /少数意见已记录/, '少数意见不能丢，要写进理由');
  assert.equal(singleMinor.length, 1, '单人提出的一般问题要单独记录');
  assert.equal(singleMinor[0].adopted, false, '单人一般问题不采纳');
  // 互斥指令不能同时进修改清单
  const instructions = round.decisions.filter((item) => item.adopted).map((item) => item.instruction);
  assert.ok(!instructions.some((text) => /冗余/.test(text)), '被否决的那一方不能进修改指令');
  review.deletePanel(panel.id);
});

// ---------- 轮次记录 ----------

test('轮次记录：轮次递增、版本哈希、报告可回读', async () => {
  const project = makeDoc('第一版正文，只有结论。');
  const panel = makePanel({ name: '单轮团' });
  stubModel(() => JSON.stringify({
    score: 66, grade: 'C', summary: '需要补论证。', highlights: [],
    issues: [{ severity: 'major', dimension: '论证论据', text: '缺少机制解释', where: '第 1 段' }],
    suggestions: [], priority: [], focus: [],
  }));
  const first = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  // 改一版正文再跑第二轮
  docEngine.saveSectionContent(project.id, 1, '第二版正文，补了一段机制解释，但仍然缺少对比。', 'manual');
  const second = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  const rounds = review.listRounds({ workbench: 'doc', workId: project.id, sectionIdx: 1 });
  assert.equal(rounds.length, 2);
  assert.deepEqual(rounds.map((item) => item.roundNo).sort(), [1, 2], '轮次必须递增');
  const r1 = review.getRound(first.roundId);
  const r2 = review.getRound(second.roundId);
  assert.notEqual(r1.version, r2.version, '正文变了，版本哈希必须变');
  assert.equal(r2.report.roundNo, 2);
  assert.ok(Array.isArray(r2.opinions) && r2.opinions.length === 3);
  review.deletePanel(panel.id);
});

test('评审失败：某位评审员返回垃圾时，其余意见仍要产出且失败原因可见', async () => {
  const project = makeDoc();
  const panel = makePanel({ name: '容错团' });
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    const name = (sys.match(/你是「([^」]+)」/) || [])[1] || '';
    if (name === '审稿人甲') return '抱歉，我无法评审。';
    return JSON.stringify({
      score: 72, grade: 'B', summary: '可用。', highlights: [],
      issues: [{ severity: 'minor', dimension: '格式', text: '段落偏长', where: '第 1 段' }],
      suggestions: [], priority: [], focus: [],
    });
  });
  const result = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  assert.equal(result.ok, true, '一位评审员失败不该让整轮失败');
  assert.equal(result.report.failures.length, 1);
  assert.match(result.report.failures[0], /审稿人甲/);
  assert.equal(result.report.scores.length, 2, '另外两位的意见照常产出');
  review.deletePanel(panel.id);
});

// ---------- 落改 ----------

test('落改：只把采纳的意见转成修改指令，不采纳的不进指令', async () => {
  const instructions = [];
  const work = {
    title: '测试作品', text: '正文',
    apply: async (instruction) => { instructions.push(instruction); return { ok: true }; },
  };
  const result = await review.applyDecisions({
    work,
    decisions: [
      { adopted: 1, dimension: '论证论据', instruction: '补一段因果链', text: '论证过简' },
      { adopted: 0, dimension: '格式', instruction: '这个不该出现', text: '段落偏长' },
    ],
  });
  assert.equal(result.applied, true);
  assert.equal(instructions.length, 1);
  assert.match(instructions[0], /补一段因果链/);
  assert.doesNotMatch(instructions[0], /这个不该出现/);

  // 整篇评审不自动落改：跨节修改要逐节确认
  const whole = await review.applyDecisions({ work: { apply: null }, decisions: [{ adopted: 1, instruction: 'x' }] });
  assert.equal(whole.applied, false);
  assert.match(whole.reason, /不支持自动落改/);
});

// ---------- 蒸馏 ----------

test('蒸馏：样本太短要拒绝；正常样本产出可入库、可匹配的 Skill', async () => {
  await assert.rejects(() => review.distillSkill({ sample: '太短了', workType: 'doc:paper' }), /样本太短/);

  stubModel(() => JSON.stringify({
    name: '引言创新点检查',
    appliesTo: ['doc:paper'],
    body: '1. 引言须在 300 字内交代研究问题；\n2. 须明确指出与既有研究的差异；\n3. 缺少任一项即判为「创新点不突出」。',
    evidence: ['样本第 2 段用一句话点明了缺口'],
    discarded: ['样本的致谢写法属于个人习惯，不适合标准化'],
  }));
  const skill = await review.distillSkill({
    sample: ('引言：现有研究多聚焦于设备采购，鲜有讨论运维环节的国产化替代路径。本文以三家企业的运维数据为例，'
      + '提出运维环节的替代优先级模型，填补了这一空白。').repeat(6),
    workType: 'doc:paper', kind: 'focus',
  });
  restoreModel();

  assert.equal(skill.source, 'distilled');
  assert.ok(skill.appliesTo.includes('doc:paper'));
  assert.match(skill.body, /引言须在 300 字内/);
  const matched = review.skillsFor({ workType: 'doc:paper' });
  assert.ok(matched.focus.some((item) => item.id === skill.id), '蒸馏出的 Skill 要能被论文类作品匹配到');
  review.deleteSkill(skill.id);
});

// ---------- 页面 ----------

test('页面：开关可切换、评审团可见、报告页显示共识与分歧', async () => {
  review.setEnabled({ enabled: false });
  const page = await get('/review?workbench=doc');
  assert.equal(page.status, 200);
  assert.match(page.text, /机制开关/);
  assert.match(page.text, /默认关闭/);
  assert.match(page.text, /评审团/);

  const toggled = await post('/review/toggle', { csrf: TOKEN, workbench: 'doc', docType: '', enabled: '1' });
  assert.equal(toggled.status, 303);
  assert.equal(review.enableState('doc', '').effective, true);

  // 报告页：跑一轮后能看到三位评审员的意见与交叉验证结果
  const project = makeDoc();
  const panel = makePanel({ name: '页面团' });
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    const name = (sys.match(/你是「([^」]+)」/) || [])[1] || '';
    const common = {
      score: 70, grade: 'B', summary: `${name} 的总体判断。`, highlights: [{ text: '结论明确', why: '有判断句' }],
      suggestions: [], priority: [], focus: ['论证'],
    };
    if (name === '审稿人甲') return JSON.stringify({ ...common, issues: [{ severity: 'fatal', dimension: '论证论据', text: '论证过于简略，缺少机制', where: '第 1 段' }] });
    if (name === '逻辑专家乙') return JSON.stringify({ ...common, issues: [{ severity: 'major', dimension: '论证论据', text: '论证过简，缺少机制解释', where: '第 1 段' }] });
    return JSON.stringify({ ...common, issues: [{ severity: 'major', dimension: '论证论据', text: '论证冗余，重复太多', where: '第 1 段' }] });
  });
  const result = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  const report = await get(`/review?round=${encodeURIComponent(result.roundId)}`);
  assert.equal(report.status, 200);
  assert.match(report.text, /评审意见/);
  assert.match(report.text, /交叉验证/);
  assert.match(report.text, /共识/);
  assert.match(report.text, /分歧/);
  assert.match(report.text, /采纳/);

  // 文档工作台里要有直达入口
  const docsPage = require('../lib/docs-page');
  const card = docsPage.renderReviewPanelCard(docEngine.getProject(project.id), 1);
  assert.match(card, /评审团/);
  assert.match(card, /\/review\?workbench=doc/);

  review.deletePanel(panel.id);
  review.setEnabled({ enabled: false });
});

// ---------- 平票仲裁 ----------

test('分歧平票：1 票 vs 1 票要交评审组长裁决，裁决结果落库', async () => {
  const project = makeDoc('这一节只有结论。设备国产化率偏低是主要约束。');
  const panel = review.savePanel({
    name: '两人民主团', workbench: 'doc',
    reviewers: [
      { name: '甲', channelId: 'ch_a', modelLabel: '厂商甲 / 模型 X' },
      { name: '乙', channelId: 'ch_b', modelLabel: '厂商乙 / 模型 Y' },
    ],
  });
  let arbitrated = 0;
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('评审组长')) {
      arbitrated += 1;
      return JSON.stringify({
        rulings: [{ index: 1, winner: '论证过简', reason: '正文确实只有结论', instruction: '补一段因果链' }],
      });
    }
    const name = (sys.match(/你是「([^」]+)」/) || [])[1] || '';
    const issue = name === '甲'
      ? { severity: 'major', dimension: '论证论据', text: '论证过于简略，缺少机制解释', where: '第 1 段' }
      : { severity: 'major', dimension: '论证论据', text: '论证冗余，同一意思反复出现', where: '第 1 段' };
    return JSON.stringify({
      score: 65, grade: 'C', summary: '有分歧。', highlights: [],
      issues: [issue], suggestions: [], priority: [], focus: [],
    });
  });
  const result = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  const round = review.getRound(result.roundId);
  const conflict = round.decisions.find((item) => item.kind === 'conflict');
  assert.ok(conflict, '平票也要识别成分歧');
  assert.equal(arbitrated, 1, '平票时必须调用一次评审组长');
  assert.equal(conflict.adopted, true, '裁决后要有明确结论');
  assert.match(conflict.reason, /裁决/);
  assert.match(conflict.instruction, /补一段因果链/);
  review.deletePanel(panel.id);
});

// ---------- 小说工作台 ----------

test('小说工作台：能按章节读取正文并评审（两个工作台共用同一套评审流程）', async () => {
  const core = require('../lib/handlers-core');
  const book = core.createBook({ title: '评审用小说' });
  core.writeFileTo({
    bookId: book.id, group: '正文', name: '第1章 开端.md',
    content: '雨下了一夜。他推开门，街上的灯全灭了。远处有人在喊他的名字，他没有回头。',
  });

  const work = review.resolveWork({ workbench: 'novel', workId: book.id, sectionIdx: 1 });
  assert.equal(work.type, 'novel');
  assert.match(work.title, /第1章/);
  assert.match(work.text, /雨下了一夜/);

  const panel = review.savePanel({
    name: '小说评审团', workbench: 'novel',
    reviewers: [{ name: '网文编辑', channelId: 'ch_a', modelLabel: '厂商甲 / 模型 X', persona: '资深网文编辑' }],
  });
  stubModel(() => JSON.stringify({
    score: 70, grade: 'B', summary: '开篇有画面。', highlights: [{ text: '开场具体', why: '有动作有环境' }],
    issues: [{ severity: 'major', dimension: '情节', text: '缺少冲突动机', where: '第 1 段' }],
    suggestions: [], priority: [], focus: ['情节'],
  }));
  const result = await review.runRound({ workbench: 'novel', workId: book.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  assert.equal(result.ok, true);
  assert.equal(result.report.typeName, '小说·章节');
  assert.equal(result.report.scores.length, 1);
  review.deletePanel(panel.id);
});

test('小说多评审对象：章节 / 全文 / 设定 / 细纲各自独立，轮次互不串号', async () => {
  const core = require('../lib/handlers-core');
  const book = core.createBook({ title: '多对象评审小说' });
  core.writeFileTo({ bookId: book.id, group: '正文', name: '第1章 开端.md', content: '雨下了一夜。他推开门，街上的灯全灭了。' });
  core.writeFileTo({ bookId: book.id, group: '正文', name: '第2章 转折.md', content: '第二天，城里传出了消息。' });
  core.writeFileTo({ bookId: book.id, group: '设定', name: '世界观.md', content: '这个世界没有太阳，照明靠地火。' });
  core.writeFileTo({ bookId: book.id, group: '细纲', name: '第一卷细纲.md', content: '第1章：主角出门；第2章：得知消息。' });

  const targets = review.novelTargets(book.id);
  const keys = targets.map((item) => item.target);
  assert.ok(keys.includes('chapter') && keys.includes('whole'), '正文要同时提供章节与全文');
  assert.ok(keys.includes('setting') && keys.includes('outline'), '设定与细纲要成为可评审对象');

  const setting = review.resolveWork({ workbench: 'novel', workId: book.id, target: 'setting', sectionIdx: 1 });
  assert.equal(setting.target, 'setting');
  assert.equal(setting.typeName, '小说·设定资料');
  assert.match(setting.text, /没有太阳/);
  // 设定只有一份，整组评审只出意见、不自动落改
  const settingGroup = review.resolveWork({ workbench: 'novel', workId: book.id, target: 'setting', sectionIdx: 0 });
  assert.equal(settingGroup.apply, null);

  const whole = review.resolveWork({ workbench: 'novel', workId: book.id, target: 'whole', sectionIdx: 0 });
  assert.equal(whole.target, 'whole');
  assert.match(whole.text, /雨下了一夜[\s\S]*第二天/, '全文要把所有正文拼起来');
  assert.equal(whole.apply, null);

  const panel = review.savePanel({
    name: '多对象团', workbench: 'novel',
    reviewers: [{ name: '编辑', channelId: 'ch_a', persona: '网文编辑' }],
  });
  stubModel(() => JSON.stringify({
    score: 70, grade: 'B', summary: '可用。', highlights: [],
    issues: [{ severity: 'minor', dimension: '设定', text: '设定缺少边界条件', where: '第 1 段' }],
    suggestions: [], priority: [], focus: [],
  }));
  const settingRound = await review.runRound({ workbench: 'novel', workId: book.id, target: 'setting', sectionIdx: 1, panelId: panel.id });
  const chapterRound = await review.runRound({ workbench: 'novel', workId: book.id, target: 'chapter', sectionIdx: 1, panelId: panel.id });
  restoreModel();

  assert.equal(review.getRound(settingRound.roundId).target, 'setting');
  assert.equal(review.getRound(chapterRound.roundId).target, 'chapter');
  // 不同对象各自从第 1 轮数起：否则「设定第 3 轮」会被误读成正文第 3 轮
  assert.equal(review.getRound(settingRound.roundId).roundNo, 1);
  assert.equal(review.getRound(chapterRound.roundId).roundNo, 1);

  const settingRounds = review.listRounds({ workbench: 'novel', workId: book.id, target: 'setting', sectionIdx: 1 });
  assert.equal(settingRounds.length, 1, '按对象过滤，设定不会混进章节的轮次');
  const chapterRounds = review.listRounds({ workbench: 'novel', workId: book.id, target: 'chapter', sectionIdx: 1 });
  assert.equal(chapterRounds.length, 1);
  assert.notEqual(settingRounds[0].id, chapterRounds[0].id);

  const page = await get(`/review?workbench=novel&workId=${encodeURIComponent(book.id)}&target=setting&sectionIdx=1`);
  assert.equal(page.status, 200);
  assert.match(page.text, /切换评审对象/, '页面要能切换到设定 / 细纲');
  assert.match(page.text, /世界观\.md/);
  review.deletePanel(panel.id);
});

test('自动评审（小说）：开启且配了默认团时新章自动过一轮；取消勾选或未开启则跳过', async () => {
  const core = require('../lib/handlers-core');
  const book = core.createBook({ title: '自动评审小说' });
  core.writeFileTo({ bookId: book.id, group: '正文', name: '第1章 开端.md', content: '雨下了一夜。他推开门。' });
  const panel = review.savePanel({
    name: '自动小说团', workbench: 'novel',
    reviewers: [{ name: '编辑', channelId: 'ch_a', persona: '网文编辑' }],
  });

  resetReviewScopes();
  const off = await review.autoReviewNovelChapters({ bookId: book.id, idxs: [1] });
  assert.equal(off.skipped, true);
  assert.match(off.reason, /未开启/);

  review.setEnabled({ enabled: true });
  stubModel(() => JSON.stringify({
    score: 70, grade: 'B', summary: '可用。', highlights: [],
    issues: [], suggestions: [], priority: [], focus: [],
  }));
  const cancelled = await review.autoReviewNovelChapters({ bookId: book.id, idxs: [1], panelReview: false });
  assert.equal(cancelled.skipped, true, '本次生成勾掉「送评审团」时只跳过这一次');

  const on = await review.autoReviewNovelChapters({ bookId: book.id, idxs: [1] });
  restoreModel();
  assert.equal(on.skipped, false);
  assert.equal(on.panel, '自动小说团');
  assert.ok(on.sections[0].roundId);
  assert.equal(review.listRounds({ workbench: 'novel', workId: book.id, target: 'chapter', sectionIdx: 1 }).length, 1);
  review.deletePanel(panel.id);
  review.setEnabled({ enabled: false });
});



test('自动评审：开启后新写小节自动过一轮，但只出意见、不自动改稿', async () => {
  review.setEnabled({ enabled: false });
  const project = docEngine.createProject({ title: '自动评审稿', docType: 'report', mode: 'auto' });
  docEngine.saveSectionContent(project.id, 1, '第一节正文，只有结论。', 'manual');
  docEngine.saveSectionContent(project.id, 2, '第二节正文，同样只有结论。', 'manual');
  const panel = makePanel({ name: '自动团' });
  stubModel(() => JSON.stringify({
    score: 68, grade: 'C', summary: '需要补论证。', highlights: [],
    issues: [{ severity: 'major', dimension: '论证论据', text: '缺少机制解释', where: '第 1 段' }],
    suggestions: [], priority: [], focus: [],
  }));

  // 未开启：不跑
  const off = await review.autoReviewSections({ projectId: project.id, idxs: [1, 2] });
  assert.equal(off.skipped, true);
  assert.match(off.reason, /未开启/);

  review.setEnabled({ enabled: true, workbench: 'doc' });
  const on = await review.autoReviewSections({ projectId: project.id, idxs: [1, 2] });
  restoreModel();

  assert.equal(on.skipped, false);
  assert.equal(on.sections.length, 2, '两节各跑一轮');
  assert.ok(on.sections.every((item) => item.roundId), '每节都要留下轮次记录');
  const rounds = review.listRounds({ workbench: 'doc', workId: project.id, sectionIdx: 1 });
  assert.equal(rounds.length, 1);
  // 只评审不改稿：正文保持原样
  const fresh = docEngine.getProject(project.id);
  assert.equal(fresh.sections[0].content, '第一节正文，只有结论。');

  review.deletePanel(panel.id);
  review.setEnabled({ enabled: false });
});

// ---------- 规范里此前漏掉的五项 ----------

test('可行性评估：与作者意图冲突的意见判为不采纳，并写明理由', async () => {
  const project = docEngine.createProject({
    title: '短评稿', docType: 'report', mode: 'co',
    brief: '这是一篇 800 字的内部短评，不需要补充外部数据，也不要求学术规范',
  });
  docEngine.saveSectionContent(project.id, 1, '短评正文，观点明确但没有任何数据。', 'manual');
  const panel = makePanel({ name: '可行性团' });
  let feasibilityPrompt = '';
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('负责人')) {
      feasibilityPrompt = String(options.messages?.[1]?.content || '');
      // 第 1 条判为不适用（要求补数据，与「不需要补充外部数据」冲突），第 2 条通过
      return JSON.stringify({
        rulings: [
          { index: 1, applicable: false, reason: '作者已声明这是短评，不需要补充外部数据' },
          { index: 2, applicable: true, reason: '观点表述确实可以更明确' },
        ],
      });
    }
    return JSON.stringify({
      score: 70, grade: 'B', summary: '可用。', highlights: [],
      issues: [
        { severity: 'major', dimension: '数据引用', text: '缺少数据支撑，应补充行业统计', where: '第 1 段' },
        { severity: 'major', dimension: '表达', text: '观点表述不够明确', where: '第 1 段' },
      ],
      suggestions: [], priority: [], focus: [],
    });
  });
  const result = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  assert.match(feasibilityPrompt, /作者意图/, '可行性评估必须把作者意图交给模型');
  assert.match(feasibilityPrompt, /不需要补充外部数据/, '意图原文要进提示词');
  const round = review.getRound(result.roundId);
  const dataDecision = round.decisions.find((item) => /缺少数据支撑/.test(item.text));
  assert.equal(dataDecision.adopted, false, '与意图冲突的意见不能采纳');
  assert.match(dataDecision.reason, /可行性评估判为不适用/);
  assert.ok(result.report.feasibility, '报告里要有可行性结论');
  assert.equal(result.report.feasibility.rejected, 1);
  review.deletePanel(panel.id);
});

test('终止：能打断正在进行的评审，已产生的意见保留', async () => {
  const project = makeDoc();
  const panel = makePanel({ name: '可终止团' });
  // 三位评审员各自挂在等待上，模拟「调用正在飞」；终止后它们都收到 abort
  const waiters = [];
  llm.activeChannel = () => ({ baseUrl: 'http://stub.local', key: 'stub', model: 'stub-model' });
  llm.chatCompletion = async function* (options) {
    await new Promise((resolve) => { waiters.push(resolve); });
    if (options.signal && options.signal.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    yield { type: 'delta', text: JSON.stringify({ score: 70, grade: 'B', summary: 'x', highlights: [], issues: [], suggestions: [], priority: [], focus: [] }) };
  };
  const running = review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  // 等它把轮次写进库并进入调用
  await new Promise((resolve) => setTimeout(resolve, 80));
  const rounds = review.listRounds({ workbench: 'doc', workId: project.id, sectionIdx: 1 });
  const roundId = rounds[0].id;
  assert.equal(review.isRoundRunning(roundId), true, '运行中要能被识别');
  const cancelled = review.cancelRound(roundId);
  assert.equal(cancelled.ok, true);
  // 放行所有在飞的调用：它们会看到 aborted 并抛错
  for (const resolve of waiters) resolve();
  const result = await running;
  restoreModel();

  assert.equal(result.cancelled, true);
  const round = review.getRound(roundId);
  assert.equal(round.status, 'cancelled', '终止后状态必须是 cancelled');
  assert.ok(round.cancelledAt > 0);
  review.deletePanel(panel.id);
});

test('暂停与继续：暂停保留已产出的意见，继续时不重新调用评审员', async () => {
  const project = makeDoc('暂停测试正文，只有结论没有论证。');
  const panel = makePanel({ name: '可暂停团' });
  const waiters = [];
  let calls = 0;
  llm.activeChannel = () => ({ baseUrl: 'http://stub.local', key: 'stub', model: 'stub-model' });
  llm.chatCompletion = async function* () {
    calls += 1;
    await new Promise((resolve) => { waiters.push(resolve); });
    yield { type: 'delta', text: JSON.stringify({
      score: 70, grade: 'B', summary: '可用。', highlights: [],
      issues: [], suggestions: [], priority: [], focus: [],
    }) };
  };
  const running = review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const roundId = review.listRounds({ workbench: 'doc', workId: project.id, sectionIdx: 1 })[0].id;

  const paused = review.pauseRound(roundId);
  assert.equal(paused.ok, true);
  for (const resolve of waiters) resolve();
  const result = await running;
  assert.equal(result.paused, true, '意见收集结束后停下，而不是继续仲裁');
  const callsAfterPause = calls;

  const snapshot = review.getRound(roundId);
  assert.equal(snapshot.status, 'paused');
  assert.ok(snapshot.pausedAt > 0);
  assert.equal(snapshot.opinions.length, 3, '暂停前的意见必须全部保留');
  assert.equal(snapshot.decisions.length, 0, '暂停时还没进入仲裁，不应有决策记录');
  // 暂停页要能继续，而不只是显示「已暂停」
  const pausedPage = reviewPage.renderRound(roundId, TOKEN);
  assert.match(pausedPage, /已暂停/);
  assert.match(pausedPage, /继续这一轮/);

  const resumed = await review.resumeRound(roundId);
  assert.equal(resumed.ok, true);
  assert.equal(calls, callsAfterPause, '继续时不能再调用评审员（已经付费的意见不重问一遍）');

  const done = review.getRound(roundId);
  assert.equal(done.status, 'done');
  assert.ok(done.resumedAt > 0);
  assert.equal(done.opinions.length, 3, '继续后意见不重复入库');
  assert.equal(done.score, done.report.average);
  review.deletePanel(panel.id);
});

test('评分变化：第二轮报告要给出与上一轮的分数差', async () => {
  const project = makeDoc('第一版正文。');
  const panel = makePanel({ name: '分数变化团' });
  let score = 60;
  stubModel(() => JSON.stringify({
    score, grade: 'C', summary: '一般。', highlights: [],
    issues: [{ severity: 'major', dimension: '论证论据', text: '缺少机制解释', where: '第 1 段' }],
    suggestions: [], priority: [], focus: [],
  }));
  const first = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  score = 78;
  const second = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  assert.equal(first.report.delta, null, '第一轮没有上一轮可比');
  assert.equal(second.report.prevScore, 60);
  assert.equal(second.report.average, 78);
  assert.equal(second.report.delta, 18, '评分变化要算出来');
  const round = review.getRound(second.roundId);
  assert.equal(round.prevScore, 60);
  review.deletePanel(panel.id);
});

test('修改前后对比：落改后要留下改前与改后两份正文', async () => {
  const project = makeDoc('改前：设备国产化率偏低是主要约束。');
  const panel = makePanel({ name: '对比团' });
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    const user = String(options.messages?.[1]?.content || '');
    if (sys.includes('负责人')) return JSON.stringify({ rulings: [] });
    // 作者 AI 的修改稿：指令是通过 buildMessages 的【作者指示】传进去的，不在 system 里
    if (user.includes('按以下评审意见逐条修改')) {
      return '改后：设备国产化率偏低是产能扩张的主要约束。原因在于关键环节依赖进口，交付周期不可控，'
        + '企业只能靠提前备货维持排产，资金占用随产能扩张同步上升。与同行相比，本企业的设备自给率低约二十个百分点，'
        + '差距集中在高端环节。这一判断在现有产能规模下成立，进入更大规模扩产时约束会转向资金端。';
    }
    return JSON.stringify({
      score: 70, grade: 'B', summary: '可补机制。', highlights: [],
      issues: [{ severity: 'major', dimension: '论证论据', text: '缺少机制解释', where: '第 1 段' }],
      suggestions: [], priority: [], focus: [],
    });
  });
  const result = await review.runRound({
    workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id, apply: true,
  });
  restoreModel();

  const round = review.getRound(result.roundId);
  assert.match(round.beforeText, /改前/, '改前正文要留档');
  assert.match(round.afterText, /改后/, '改后正文要留档');
  assert.ok(round.afterText.length > round.beforeText.length);
  review.deletePanel(panel.id);
});

test('默认 Skill：没配任何 Skill 时用默认组合，而不是让评审员自由发挥', () => {
  const defaults = review.defaultSkillsFor('doc:paper');
  assert.ok(defaults.method.length >= 1);
  assert.ok(defaults.style.length >= 1);
  assert.ok(defaults.focus.length >= 1);
  assert.equal(defaults.method[0].builtin, true);

  const skills = review.skillsFor({ workType: 'doc:paper' });
  assert.ok(skills.method.some((item) => item.builtin), '未配置时要回落到默认组合');
  assert.ok(skills.focus.some((item) => item.builtin));

  // 小说用另一套默认组合
  const novelDefaults = review.defaultSkillsFor('novel');
  assert.match(novelDefaults.focus[0].body, /冲突|悬念/);
  assert.notEqual(novelDefaults.focus[0].name, defaults.focus[0].name);
});

test('轮次上限：达到设定轮次后不再起新一轮', async () => {
  const project = makeDoc();
  const panel = review.savePanel({
    name: '限两轮团', workbench: 'doc', maxRounds: 1,
    reviewers: [{ name: '甲', channelId: 'ch_a', modelLabel: '厂商甲 / 模型 X' }],
  });
  stubModel(() => JSON.stringify({
    score: 70, grade: 'B', summary: 'x', highlights: [],
    issues: [], suggestions: [], priority: [], focus: [],
  }));
  await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  await assert.rejects(
    () => review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id }),
    /最多 1 轮/,
  );
  restoreModel();
  review.deletePanel(panel.id);
});

test('页面：报告显示评分变化、作者意图、可行性结论与修改前后对比', async () => {
  const project = docEngine.createProject({
    title: '报告要素稿', docType: 'report', mode: 'co',
    brief: '内部短评，不需要补充外部数据',
  });
  docEngine.saveSectionContent(project.id, 1, '改前：设备国产化率偏低是主要约束。', 'manual');
  const panel = makePanel({ name: '报告要素团' });
  let score = 62;
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    const user = String(options.messages?.[1]?.content || '');
    if (sys.includes('负责人')) {
      return JSON.stringify({ rulings: [{ index: 1, applicable: true, reason: '与短评定位一致' }] });
    }
    if (user.includes('按以下评审意见逐条修改')) {
      return '改后：设备国产化率偏低是产能扩张的主要约束，原因在于关键环节依赖进口，交付周期不可控，'
        + '企业只能靠提前备货维持排产，资金占用随产能扩张同步上升。与同行相比自给率低约二十个百分点，'
        + '差距集中在高端环节而非中低端。这一判断在现有产能规模下成立；一旦进入更大规模扩产，'
        + '约束会从设备端转向资金端，届时的应对手段也不同。';
    }
    return JSON.stringify({
      score, grade: 'C', summary: '可补机制。', highlights: [],
      issues: [{ severity: 'major', dimension: '论证论据', text: '缺少机制解释', where: '第 1 段' }],
      suggestions: [], priority: [], focus: [],
    });
  });
  await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  score = 75;
  const second = await review.runRound({
    workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id, apply: true,
  });
  restoreModel();

  const page = await get(`/review?round=${encodeURIComponent(second.roundId)}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /评分变化/);
  assert.match(page.text, /\+13/, '第二轮 75 比第一轮 62 高 13，要显示出来');
  assert.match(page.text, /作者意图/, '报告要显示可行性评估所依据的意图');
  assert.match(page.text, /内部短评/, '意图原文要可见');
  assert.match(page.text, /可行性评估/);
  assert.match(page.text, /修改前后对比/, '落改后要能看到改前改后');
  assert.match(page.text, /改前：/);
  assert.match(page.text, /改后：/);
  review.deletePanel(panel.id);
});

test('页面：运行中的轮次可以点终止', async () => {
  const project = makeDoc();
  const panel = makePanel({ name: '页面终止团' });
  const waiters = [];
  llm.activeChannel = () => ({ baseUrl: 'http://stub.local', key: 'stub', model: 'stub-model' });
  llm.chatCompletion = async function* (options) {
    await new Promise((resolve) => { waiters.push(resolve); });
    if (options.signal && options.signal.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    yield { type: 'delta', text: '{}' };
  };
  const running = review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const roundId = review.listRounds({ workbench: 'doc', workId: project.id, sectionIdx: 1 })[0].id;

  // 作品页应出现「终止这一轮」
  const page = await get(`/review?workbench=doc&workId=${encodeURIComponent(project.id)}&sectionIdx=1`);
  assert.match(page.text, /终止这一轮/, '运行中要能终止');
  assert.match(page.text, /\/review\/cancel/);

  const res = await post('/review/cancel', {
    csrf: TOKEN, roundId, workbench: 'doc', workId: project.id, sectionIdx: 1,
  });
  assert.equal(res.status, 303);
  for (const resolve of waiters) resolve();
  await running;
  restoreModel();

  const round = review.getRound(roundId);
  assert.equal(round.status, 'cancelled');
  review.deletePanel(panel.id);
});

test('默认评审团按文档类型匹配：不传 panelId 也要找到「绑定该类型的团」', async () => {
  // 这条是补漏：曾经 runRound 先取 defaultPanel(workbench) 再解析作品，
  // 于是 docType 传的是空串，「绑定 paper 的评审团」永远匹配不到——
  // 页面上明明显示着这个团，跑起来却报「还没有配置评审团」。
  // 以前的测试全都显式传了 panelId，把这个洞完整绕过去了。
  const project = docEngine.createProject({ title: '默认团稿', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1, '正文只有结论，没有论证。', 'manual');
  const generic = review.savePanel({
    name: '通用团', workbench: 'doc', docType: '',
    reviewers: [{ name: '通用评审员', channelId: 'ch_c', modelLabel: '厂商丙 / 模型 Z' }],
  });
  const typed = review.savePanel({
    name: '论文专用团', workbench: 'doc', docType: 'paper',
    reviewers: [{ name: '论文评审员', channelId: 'ch_a', modelLabel: '厂商甲 / 模型 X' }],
  });

  stubModel(() => JSON.stringify({
    score: 70, grade: 'B', summary: 'x', highlights: [], issues: [], suggestions: [], priority: [], focus: [],
  }));
  // 不传 panelId：必须挑「绑定 paper」的那个，而不是通用团
  const result = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1 });
  restoreModel();

  assert.equal(result.report.panel.name, '论文专用团', '类型匹配的团优先于通用团');
  assert.equal(result.report.panel.reviewers[0].name, '论文评审员');

  // 起跑校验要把错误提前抛出来，而不是让页面跳转后静默失败
  const other = docEngine.createProject({ title: '空稿', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(other.id, 1, '', 'manual');
  assert.throws(() => review.preflight({ workbench: 'doc', workId: other.id, sectionIdx: 1 }), /还没有正文/);
  assert.throws(() => review.preflight({ workbench: 'doc', workId: 'nope', sectionIdx: 1 }), /不存在/);

  review.deletePanel(generic.id);
  review.deletePanel(typed.id);
});

test('全员失败：轮次判为失败而不是「已完成」，并给出排查方向', async () => {
  const project = makeDoc();
  const panel = makePanel({ name: '全失败团' });
  stubModel(() => '抱歉，我无法评审。');
  const result = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  assert.equal(result.ok, false, '一个有效意见都没有时不能报成功');
  const round = review.getRound(result.roundId);
  assert.equal(round.status, 'failed', '全员失败要标 failed，不能让作者以为评审跑完了');
  assert.match(round.error, /全部评审员调用失败/);

  const page = await get(`/review?round=${encodeURIComponent(result.roundId)}`);
  assert.match(page.text, /没有成功/);
  assert.match(page.text, /常见原因与处理/, '失败页要给出可执行的排查方向');
  assert.match(page.text, /密钥失效/);
  review.deletePanel(panel.id);
});

// ---------- 评审库：把 Skill 配给具体评审员 ----------

test('评审库：Skill 可以配给具体评审员，绑定优先于按类型自动匹配', () => {
  const panel = review.savePanel({
    name: '绑定测试团', workbench: 'doc', docType: 'paper',
    reviewers: [
      { name: '学术审稿人', channelId: 'ch_a', modelLabel: '厂商甲 / 模型 X' },
      { name: '格式审查员', channelId: 'ch_b', modelLabel: '厂商乙 / 模型 Y' },
    ],
  });
  const [academic, formatter] = panel.reviewers;
  const integrity = review.saveSkill({
    name: '论证完整性检查', kind: 'focus', appliesTo: 'doc:paper',
    body: '1. 每个核心判断是否至少有一条可核对的依据；2. 结论是否回应了引言提出的问题。',
  });
  const formatRule = review.saveSkill({
    name: '引用与排版规范', kind: 'focus', appliesTo: 'doc:paper',
    body: '1. 正文引用编号与参考文献顺序一致；2. 图表须有编号与题注；3. 标题层级不得跳级。',
  });

  // 各配各的：学术审稿人只看论证，格式审查员只看规范
  review.setSkillReviewers(integrity.id, [academic.id]);
  review.setSkillReviewers(formatRule.id, [formatter.id]);

  const academicSkills = review.skillsFor({ reviewerId: academic.id, workType: 'doc:paper' });
  const formatterSkills = review.skillsFor({ reviewerId: formatter.id, workType: 'doc:paper' });
  assert.ok(academicSkills.focus.some((item) => item.name === '论证完整性检查'), '绑定的 Skill 要用上');
  assert.ok(!academicSkills.focus.some((item) => item.name === '引用与排版规范'),
    '没绑给他的 Skill 不能塞给他——否则三个评审员用同一把尺子');
  assert.ok(formatterSkills.focus.some((item) => item.name === '引用与排版规范'));
  assert.ok(!formatterSkills.focus.some((item) => item.name === '论证完整性检查'));

  // 绑定关系可查、可改
  assert.deepEqual(review.reviewerIdsOfSkill(integrity.id), [academic.id]);
  review.setSkillReviewers(integrity.id, [academic.id, formatter.id]);
  assert.equal(review.reviewerIdsOfSkill(integrity.id).length, 2);
  review.setSkillReviewers(integrity.id, []);
  assert.equal(review.reviewerIdsOfSkill(integrity.id).length, 0);
  // 解绑后回到按类型自动匹配
  const after = review.skillsFor({ reviewerId: academic.id, workType: 'doc:paper' });
  assert.ok(after.focus.some((item) => item.name === '引用与排版规范'), '解绑后按类型匹配');

  review.deleteSkill(integrity.id);
  review.deleteSkill(formatRule.id);
  review.deletePanel(panel.id);
});

test('评审库：维度权重可配置，总分由系统按权重算出', async () => {
  // 权重解析：接受字符串与对象，非法值忽略
  assert.deepEqual(review.parseWeights('论证论据=2, 逻辑结构=1.5'), { 论证论据: 2, 逻辑结构: 1.5 });
  assert.deepEqual(review.parseWeights({ 论证论据: 3 }), { 论证论据: 3 });
  assert.deepEqual(review.parseWeights('乱写=abc'), {});
  assert.deepEqual(review.parseWeights(''), {});

  // 加权：论证 60 分权重 3、结构 90 分权重 1 → (180+90)/4 = 67.5 → 68
  assert.equal(review.weightedScore(
    [{ name: '论证论据', score: 60 }, { name: '逻辑结构', score: 90 }],
    { 论证论据: 3, 逻辑结构: 1 },
  ), 68);
  // 没有权重 → 不接管，交给模型总分
  assert.equal(review.weightedScore([{ name: '论证论据', score: 60 }], {}), null);

  const project = makeDoc();
  const panel = makePanel({ name: '权重团' });
  const focus = review.saveSkill({
    name: '加权重点', kind: 'focus', appliesTo: 'doc:paper',
    body: '论证优先于结构：论证不成立时，结构再整齐也不算合格。',
    weights: '论证论据=3, 逻辑结构=1',
  });
  let reviewerPrompt = '';
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    const user = String(options.messages?.[1]?.content || '');
    if (sys.includes('负责人')) return JSON.stringify({ rulings: [] });
    if (sys.includes('【角色人设】')) reviewerPrompt = `${sys}\n${user}`;
    return JSON.stringify({
      score: 95, grade: 'A', summary: '模型自报 95 分。', highlights: [],
      issues: [], suggestions: [], priority: [], focus: [],
      // 分维度分明显低于它自报的总分——正是加权要纠正的情况
      dimensions: [{ name: '论证论据', score: 60 }, { name: '逻辑结构', score: 90 }],
    });
  });
  const result = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  assert.match(reviewerPrompt, /【维度权重（按此加权，不要自己平均）】/, '权重必须进提示词');
  assert.match(reviewerPrompt, /论证论据：3/);
  assert.equal(result.report.scores[0].score, 68, '总分按权重算出，不采信模型自报的 95');
  const round = review.getRound(result.roundId);
  assert.equal(round.opinions[0].dimensions.length, 2);
  assert.equal(round.opinions[0].dimensions[0].name, '论证论据');

  review.deleteSkill(focus.id);
  review.deletePanel(panel.id);
});

test('页面：评审库能绑定 Skill 到评审员，评审团卡片显示实际用到的 Skill', async () => {
  const panel = review.savePanel({
    name: '页面绑定团', workbench: 'doc', docType: 'paper',
    reviewers: [{ name: '审稿人甲', channelId: 'ch_a', modelLabel: '厂商甲 / 模型 X' }],
  });
  const skill = review.saveSkill({
    name: '页面绑定用 Skill', kind: 'focus', appliesTo: 'doc:paper',
    body: '这一条用来验证页面上的绑定表单能把它配给具体评审员。',
    weights: '论证论据=2',
  });

  const page = await get('/review?workbench=doc');
  assert.match(page.text, /绑定到评审员/, '要有绑定入口');
  assert.match(page.text, /页面绑定用 Skill/);
  assert.match(page.text, /权重：论证论据×2/, '权重要在页面上可见');
  assert.match(page.text, /用到的 Skill/, '评审团卡片要显示每位评审员实际用什么');

  const res = await post('/review/skill/bind', {
    csrf: TOKEN, skillId: skill.id, workbench: 'doc', reviewerId: panel.reviewers[0].id,
  });
  assert.equal(res.status, 303);
  assert.deepEqual(review.reviewerIdsOfSkill(skill.id), [panel.reviewers[0].id]);

  review.deleteSkill(skill.id);
  review.deletePanel(panel.id);
});

// ---------- 蒸馏：优劣甄别、冲突校验、推荐源 ----------

test('蒸馏：要求做优劣甄别，重复的 Skill 不予入库', async () => {
  let distillPrompt = '';
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('评审体系设计者')) {
      // 甄别要求写在 system 里，输出格式要求写在 user 里——两段一起断言
      distillPrompt = `${sys}\n${String(options.messages?.[1]?.content || '')}`;
      return JSON.stringify({
        name: '引言创新点检查',
        appliesTo: ['doc:paper'],
        body: '1. 引言须在 300 字内交代研究问题；2. 须明确指出与既有研究的差异；3. 缺少任一项即判为创新点不突出。',
        evidence: ['样本第 2 段用一句话点明了缺口'],
        discarded: ['样本的致谢写法属于个人风格，不适合标准化'],
      });
    }
    return '{}';
  });
  const sample = ('引言：现有研究多聚焦于设备采购，鲜有讨论运维环节的国产化替代路径。本文以三家企业的运维数据为例，'
    + '提出运维环节的替代优先级模型，填补了这一空白。').repeat(6);
  const first = await review.distillSkill({ sample, workType: 'doc:paper', kind: 'focus' });
  restoreModel();

  assert.match(distillPrompt, /优劣甄别/, '提示词里要有甄别要求');
  assert.match(distillPrompt, /discarded/, '要要求模型写出「哪些不值得标准化」');
  assert.ok(Array.isArray(first.discarded) && first.discarded.length >= 1, '甄别结果要返回');

  // 再蒸馏一条几乎一样的：必须被挡下，否则同一件事会被扣两次分
  stubModel(() => JSON.stringify({
    name: '引言创新点检查',
    appliesTo: ['doc:paper'],
    body: first.body,
    evidence: [],
    discarded: ['同上'],
  }));
  await assert.rejects(
    () => review.distillSkill({ sample, workType: 'doc:paper', kind: 'focus' }),
    /高度重复/,
  );
  restoreModel();
  review.deleteSkill(first.id);
});

test('蒸馏：没有给出「不值得标准化」的写法时拒绝入库', async () => {
  // 甄别结果是蒸馏质量的门槛，不是装饰字段：一条都说不出，说明模型只是把全文抽象了一遍。
  stubModel(() => JSON.stringify({
    name: '通用检查', appliesTo: ['doc:paper'],
    body: '1. 结构要清晰；2. 论证要充分；3. 语言要准确。',
    evidence: [], discarded: [],
  }));
  await assert.rejects(
    () => review.distillSkill({ sample: '这'.repeat(320), workType: 'doc:paper', kind: 'focus' }),
    /没有做优劣甄别|不值得标准化/,
  );
  restoreModel();
});

test('评审库：Skill 可停用、可编辑，停用后不再进入评审但仍在管理页可见', () => {
  const skill = review.saveSkill({
    name: '可停用规则', kind: 'focus', appliesTo: 'doc',
    body: '每一个论断都必须给出可核对的事实依据，否则判为论证不足。',
  });
  assert.ok(review.skillsFor({ workType: 'doc:paper' }).focus.some((item) => item.id === skill.id));

  review.setSkillEnabled(skill.id, false);
  assert.equal(review.getSkill(skill.id).enabled, false);
  assert.ok(!review.skillsFor({ workType: 'doc:paper' }).focus.some((item) => item.id === skill.id), '停用后不进入评审');

  const page = reviewPage.renderSkills(TOKEN, 'doc');
  assert.match(page, /已停用/);
  assert.match(page, /编辑这条 Skill/);
  assert.match(page, /启用/);

  // 编辑正文时没传 enabled，不应悄悄把停用的 Skill 重新启用
  const edited = review.saveSkill({
    id: skill.id, name: '改过的规则', kind: 'focus', appliesTo: 'doc',
    body: '每一个论断都必须给出可核对的事实依据，并注明数据来源与时点。',
  });
  assert.equal(edited.name, '改过的规则');
  assert.equal(edited.enabled, false, '编辑正文不该改动启用状态');

  review.setSkillEnabled(skill.id, true);
  assert.equal(review.getSkill(skill.id).enabled, true);
  assert.ok(review.skillsFor({ workType: 'doc:paper' }).focus.some((item) => item.id === skill.id));
  review.deleteSkill(skill.id);
});

test('蒸馏：可以从历史高评分作品一键蒸馏，不必手工粘贴全文', async () => {
  const project = makeDoc(('设备国产化率偏低是产能扩张的主要约束。原因在于关键环节依赖进口，交付周期不可控，'
    + '企业只能靠提前备货维持排产，资金占用随产能扩张同步上升。与同行相比自给率低约二十个百分点，'
    + '差距集中在高端环节而非中低端。这一判断在现有产能规模下成立；一旦进入更大规模扩产，'
    + '约束会从设备端转向资金端，届时的应对手段也不同。').repeat(3));
  const panel = makePanel({ name: '推荐源团' });
  stubModel(() => JSON.stringify({
    score: 82, grade: 'A', summary: '写得好。', highlights: [],
    issues: [], suggestions: [], priority: [], focus: [],
  }));
  await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });

  const sources = review.suggestDistillSources({ workbench: 'doc' });
  assert.ok(sources.length >= 1, '均分 ≥70 的小节要出现在推荐里');
  assert.match(sources[0].title, /评审测试稿/);
  assert.ok(sources[0].score >= 70);

  stubModel(() => JSON.stringify({
    name: '结构完整性检查',
    appliesTo: ['doc:paper'],
    body: '1. 每节是否都有明确结论；2. 结论是否与开头的目标对应；3. 缺少任一项即判为结构不完整。',
    evidence: [],
    discarded: ['个别措辞习惯不值得标准化'],
  }));
  const skill = await review.distillFromWork({
    workbench: 'doc', workId: project.id, sectionIdx: 1, kind: 'focus',
  });
  restoreModel();

  assert.equal(skill.source, 'distilled');
  assert.match(skill.sourceTitle, /评审测试稿/);
  review.deleteSkill(skill.id);
  review.deletePanel(panel.id);
});

// ---------- 用户自己选择：三级开关 + 本次生成可跳过 ----------

test('开关：按文档类型独立控制，且能清回「跟随上一级」', () => {
  resetReviewScopes();
  assert.equal(review.isEnabled('doc', 'paper'), false);

  // 只对论文开启
  review.setScope({ workbench: 'doc', docType: 'paper', value: '1' });
  assert.equal(review.isEnabled('doc', 'paper'), true, '论文开启');
  assert.equal(review.isEnabled('doc', 'proposal'), true, '开启某个类型时会同时打开全局，其他类型跟随全局');
  // 只对申报书关闭
  review.setScope({ workbench: 'doc', docType: 'proposal', value: '0' });
  assert.equal(review.isEnabled('doc', 'proposal'), false, '申报书单独关闭');
  assert.equal(review.isEnabled('doc', 'paper'), true, '论文不受影响');

  const states = review.scopeStates('doc', ['paper', 'proposal', 'bp']);
  assert.equal(states.global, true);
  assert.equal(states.types.find((item) => item.docType === 'paper').own, '1');
  assert.equal(states.types.find((item) => item.docType === 'proposal').own, '0');
  assert.equal(states.types.find((item) => item.docType === 'bp').own, '', '没设过的类型是「跟随」');

  // 清除 → 回到跟随上一级
  review.setScope({ workbench: 'doc', docType: 'proposal', value: '' });
  assert.equal(review.scopeStates('doc', ['proposal']).types[0].own, '');
  assert.equal(review.isEnabled('doc', 'proposal'), true, '清除后跟随全局（开启）');

  // 关整个工作台：小说不受影响
  review.setScope({ workbench: 'doc', docType: '', value: '0' });
  assert.equal(review.isEnabled('doc', 'paper'), false);
  assert.equal(review.isEnabled('novel'), true);
  review.setScope({ workbench: '', docType: '', value: '0' });
  assert.equal(review.isEnabled('novel'), false);
});

test('页面：能看到并保存「按文档类型」的开关', async () => {
  resetReviewScopes();
  const page = await get('/review?workbench=doc');
  assert.match(page.text, /按文档类型单独控制/, '要有类型级开关区');
  assert.match(page.text, /学术论文/, '要列出具体类型');
  assert.match(page.text, /跟随上一级/);

  const res = await post('/review/scope', {
    csrf: TOKEN, workbench: 'doc', type_paper: '1', type_proposal: '0',
  });
  assert.equal(res.status, 303);
  assert.equal(review.isEnabled('doc', 'paper'), true);
  assert.equal(review.isEnabled('doc', 'proposal'), false);
  review.setScope({ workbench: '', docType: '', value: '0' });
});

test('本次生成：取消勾选「送评审团」只跳过这一次，不改总开关', async () => {
  resetReviewScopes();
  review.setScope({ workbench: '', docType: '', value: '1' });
  const panel = makePanel({ name: '本次选择团', docType: 'report' });
  const project = docEngine.createProject({
    title: '本次选择稿', docType: 'report', mode: 'auto',
    template: '# 摘要\n概括。\n\n# 背景\n背景说明。',
  });
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    // 起草要返回正文，否则小节会被门禁判失败、created 为空，评审根本没东西可评
    if (!/期刊审稿人|负责人/.test(sys)) {
      return ('设备国产化率偏低是产能扩张的主要约束，原因在于关键环节依赖进口导致交付周期不可控。'
        + '与同行相比自给率低约二十个百分点，差距集中在高端环节。这一判断在现有规模下成立。').repeat(3);
    }
    return JSON.stringify({
      score: 75, grade: 'B', summary: 'ok', highlights: [], issues: [], suggestions: [], priority: [], focus: [],
    });
  });

  // 本次明确不送
  const skipped = await docEngine.generateDocProject({
    projectId: project.id, review: false, panelReview: false, maxRetries: 1, retryBaseDelayMs: 1,
  });
  const roundsAfterSkip = review.listRounds({ workbench: 'doc', workId: project.id, sectionIdx: 1 });
  assert.equal(roundsAfterSkip.length, 0, '取消勾选后本次不跑评审团');
  assert.equal(skipped.autoReview, null);

  // 总开关没被改动
  assert.equal(review.isEnabled('doc', 'report'), true, '取消勾选不该改总开关');

  // 换一篇、这次送
  const other = docEngine.createProject({
    title: '本次选择稿2', docType: 'report', mode: 'auto',
    template: '# 摘要\n概括。\n\n# 背景\n背景说明。',
  });
  await docEngine.generateDocProject({
    projectId: other.id, review: false, panelReview: true, maxRetries: 1, retryBaseDelayMs: 1,
  });
  restoreModel();
  const roundsAfterRun = review.listRounds({ workbench: 'doc', workId: other.id, sectionIdx: 1 });
  assert.ok(roundsAfterRun.length >= 1, '勾选后本次要跑评审团');

  review.deletePanel(panel.id);
  review.setScope({ workbench: '', docType: '', value: '0' });
});

test('文档页：开启时才出现「送评审团」勾选，且与「六维打分」区分清楚', async () => {
  resetReviewScopes();
  const panel = makePanel({ name: '勾选可见团', docType: 'report' });
  const project = docEngine.createProject({ title: '勾选可见稿', docType: 'report', mode: 'auto' });
  docEngine.saveSectionContent(project.id, 1, '正文内容。', 'manual');

  // 直接渲染文档页（review 的测试服务器只挂了 /review，不走 HTTP）
  const docsPage = require('../lib/docs-page');
  const render = () => docsPage.renderDocsPage({ csrf: TOKEN, id: project.id, s: 0 });

  // 关闭时不显示——显示一个勾了也没用的框是骗人
  const off = render();
  assert.doesNotMatch(off, /送评审团/);
  assert.match(off, /六维打分/, '原来自评那个勾选要改名，避免与评审团混淆');

  review.setScope({ workbench: '', docType: '', value: '1' });
  const on = render();
  assert.match(on, /送评审团/, '开启后要能在生成按钮旁选择');
  assert.match(on, /name="panelReview"/);

  review.deletePanel(panel.id);
  review.setScope({ workbench: '', docType: '', value: '0' });
});

// ---------- 三件补齐：当场挑评审团 / 争议回抛 / 厂商标识 ----------

test('评审员标识：按渠道自动生成通用标识，同一渠道标识一致', () => {
  const panel = review.savePanel({
    name: '标识团', workbench: 'doc',
    reviewers: [
      { name: '甲', channelId: 'ch_a' },
      { name: '乙', channelId: 'ch_b' },
    ],
  });
  // 渠道顺序决定标识，且不含真实厂商名
  assert.match(panel.reviewers[0].modelLabel, /^厂商.+ \/ 模型 [A-Z]$/);
  assert.notEqual(panel.reviewers[0].modelLabel, panel.reviewers[1].modelLabel, '不同渠道不能是同一个标识');
  assert.doesNotMatch(panel.reviewers[0].modelLabel, /model-|http|api/i, '不能把真实厂商/模型名写进标识');

  // 同一个渠道，在另一个评审团里标识必须一致
  const other = review.savePanel({
    name: '标识团2', workbench: 'doc',
    reviewers: [{ name: '丙', channelId: 'ch_a' }],
  });
  assert.equal(other.reviewers[0].modelLabel, panel.reviewers[0].modelLabel,
    '同一渠道在不同评审团里必须同一个标识，否则作者无法判断「这条意见来自谁」');

  review.deletePanel(panel.id);
  review.deletePanel(other.id);
});

test('当场挑评审团：指定 panelId 时不走默认匹配', async () => {
  const project = docEngine.createProject({ title: '挑团稿', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1, '正文只有结论。', 'manual');
  const typed = review.savePanel({
    name: '论文默认团', workbench: 'doc', docType: 'paper',
    reviewers: [{ name: '默认评审员', channelId: 'ch_a' }],
  });
  const chosen = review.savePanel({
    name: '另一个团', workbench: 'doc', docType: '',
    reviewers: [{ name: '被挑中的评审员', channelId: 'ch_b' }],
  });

  stubModel(() => JSON.stringify({
    score: 70, grade: 'B', summary: 'x', highlights: [], issues: [], suggestions: [], priority: [], focus: [],
  }));
  // 不指定 → 默认匹配到「论文默认团」
  const auto = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1 });
  // 指定 → 用「另一个团」
  const picked = await review.runRound({
    workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: chosen.id,
  });
  restoreModel();

  assert.equal(auto.report.panel.name, '论文默认团');
  assert.equal(picked.report.panel.name, '另一个团', '作者挑了哪个团就用哪个');
  assert.equal(picked.report.panel.reviewers[0].name, '被挑中的评审员');

  // 页面上要有这个选择器
  const page = await get(`/review?workbench=doc&workId=${encodeURIComponent(project.id)}&sectionIdx=1`);
  assert.match(page.text, /这一轮用哪个评审团/);
  assert.match(page.text, /name="panelId"/);
  assert.match(page.text, /论文默认团/);

  review.deletePanel(typed.id);
  review.deletePanel(chosen.id);
});

test('争议回抛：先让评审团复评，票多的一方胜出（不再直接找组长）', async () => {
  const project = makeDoc('这一节只有结论。设备国产化率偏低是主要约束。');
  const panel = review.savePanel({
    name: '复评团', workbench: 'doc',
    reviewers: [
      { name: '甲', channelId: 'ch_a', persona: '学术审稿人' },
      { name: '乙', channelId: 'ch_b', persona: '结构专家' },
    ],
  });
  let chiefCalls = 0;
  let pollCalls = 0;
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('评审组长')) { chiefCalls += 1; return JSON.stringify({ rulings: [] }); }
    if (sys.includes('需要你补充说明')) {
      pollCalls += 1;
      // 两位评审员都判「意见 A（论证过简）」更站得住
      return JSON.stringify({ side: 1, reason: '正文确实只有结论' });
    }
    const name = (sys.match(/你是「([^」]+)」/) || [])[1] || '';
    const issue = name === '甲'
      ? { severity: 'major', dimension: '论证论据', text: '论证过于简略，缺少机制解释', where: '第 1 段' }
      : { severity: 'major', dimension: '论证论据', text: '论证冗余，同一意思反复出现', where: '第 1 段' };
    return JSON.stringify({
      score: 65, grade: 'C', summary: '有分歧。', highlights: [],
      issues: [issue], suggestions: [], priority: [], focus: [],
    });
  });
  const result = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  const round = review.getRound(result.roundId);
  const conflict = round.decisions.find((item) => item.kind === 'conflict');
  assert.equal(pollCalls, 2, '两位评审员各被问一次');
  assert.equal(chiefCalls, 0, '复评能分出胜负时不该再找组长');
  assert.equal(conflict.adopted, true);
  assert.match(conflict.reason, /评审团复评/);
  assert.match(conflict.reason, /另一种意见已记录/);
  assert.match(conflict.instruction, /简略/, '采纳的是 A 方');
  review.deletePanel(panel.id);
});

test('修改建议与优先级：进入决策指令、报告页，并生成维度汇总', async () => {
  const project = makeDoc('这一节只有结论。设备国产化率偏低是主要约束。');
  const panel = makePanel({ name: '建议团' });
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('负责人') || sys.includes('评审组长')) return JSON.stringify({ rulings: [] });
    return JSON.stringify({
      score: 70, grade: 'B', summary: '可补机制。', highlights: [],
      issues: [{ severity: 'major', dimension: '论证论据', text: '论证过简，缺少机制解释', where: '第 1 段' }],
      suggestions: [{
        issue: '论证过简，缺少机制解释',
        change: '补一段因果链',
        how: '先写约束条件，再写后果',
        why: '否则读者只能看到结论',
      }],
      priority: ['补因果链', '统一术语'],
      focus: ['论证'],
    });
  });
  const result = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  const round = review.getRound(result.roundId);
  const decision = round.decisions.find((item) => /论证过简/.test(item.text));
  assert.ok(decision, '问题要进入决策');
  assert.deepEqual(decision.suggestions.map((item) => item.change), ['补一段因果链'], '建议要挂到对应决策上');
  assert.match(decision.instruction, /补一段因果链/, '落改指令必须用建议，而不是只有问题原文');
  assert.match(decision.instruction, /先写约束条件/, '怎么改也要进指令');
  assert.ok(round.report.dimensions.some((row) => row.dimension === '论证论据' && row.issues >= 1), '报告要有维度汇总');

  const page = await get(`/review?round=${encodeURIComponent(result.roundId)}`);
  assert.match(page.text, /修改建议/);
  assert.match(page.text, /补一段因果链/);
  assert.match(page.text, /优先级排序/);
  assert.match(page.text, /维度汇总/);
  review.deletePanel(panel.id);
});

test('争议回抛：复评仍平票时退回组长裁决', async () => {
  const project = makeDoc('这一节只有结论。');
  const panel = review.savePanel({
    name: '平票团', workbench: 'doc',
    reviewers: [
      { name: '甲', channelId: 'ch_a' },
      { name: '乙', channelId: 'ch_b' },
    ],
  });
  let chiefCalls = 0;
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('评审组长')) {
      chiefCalls += 1;
      return JSON.stringify({ rulings: [{ index: 1, winner: '过简', reason: '确实没论证', instruction: '补一段因果链' }] });
    }
    if (sys.includes('需要你补充说明')) {
      // 一人支持 A、一人支持 B → 复评平票
      const name = (sys.match(/你是「([^」]+)」/) || [])[1] || '';
      return JSON.stringify({ side: name === '甲' ? 1 : 2, reason: '各执一词' });
    }
    const name = (sys.match(/你是「([^」]+)」/) || [])[1] || '';
    const issue = name === '甲'
      ? { severity: 'major', dimension: '论证论据', text: '论证过于简略，缺少机制解释', where: '第 1 段' }
      : { severity: 'major', dimension: '论证论据', text: '论证冗余，重复太多', where: '第 1 段' };
    return JSON.stringify({
      score: 65, grade: 'C', summary: '有分歧。', highlights: [],
      issues: [issue], suggestions: [], priority: [], focus: [],
    });
  });
  const result = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  const round = review.getRound(result.roundId);
  const conflict = round.decisions.find((item) => item.kind === 'conflict');
  assert.equal(chiefCalls, 1, '复评平票才找组长');
  assert.match(conflict.reason, /复评平票/);
  assert.match(conflict.instruction, /补一段因果链/);
  review.deletePanel(panel.id);
});

// ---------- 成本与容错 ----------

test('评审预算：每轮按人数切分 maxTokens，预算过低当场拒绝', async () => {
  const project = makeDoc('这一节只有结论没有论证。设备国产化率偏低是主要约束。');
  const panel = review.savePanel({
    name: '预算团', workbench: 'doc',
    tokenBudget: 2400,
    reviewers: [
      { name: '甲', channelId: 'ch_a', persona: '学术审稿人' },
      { name: '乙', channelId: 'ch_b', persona: '逻辑专家' },
      { name: '丙', channelId: 'ch_c', persona: '规范审查员' },
    ],
  });
  const reviewerTokens = [];
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('【角色人设】')) reviewerTokens.push(options.maxTokens);
    return JSON.stringify({
      score: 72, grade: 'B', summary: '可用。',
      highlights: [{ text: '结论明确', why: '有判断句' }],
      issues: [], suggestions: [], priority: [], focus: [],
    });
  });
  const result = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  assert.equal(result.ok, true);
  assert.deepEqual(reviewerTokens, [800, 800, 800], '2400 / 3 位评审员 = 每人 800');
  assert.equal(result.report.scores.length, 3);

  const tooSmall = review.savePanel({
    name: '预算过小团', workbench: 'doc', tokenBudget: 300,
    reviewers: [{ name: '甲', channelId: 'ch_a' }, { name: '乙', channelId: 'ch_b' }],
  });
  await assert.rejects(
    () => review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: tooSmall.id }),
    /预算 300 tokens 太低/,
  );
  review.deletePanel(tooSmall.id);
  review.deletePanel(panel.id);
});

test('评审容错：连接类失败重试一次后继续出报告', async () => {
  const project = makeDoc('这一节只有结论没有论证。设备国产化率偏低是主要约束。');
  const panel = review.savePanel({
    name: '重试团', workbench: 'doc',
    reviewers: [
      { name: '甲', channelId: 'ch_a', persona: '学术审稿人' },
      { name: '乙', channelId: 'ch_b', persona: '逻辑专家' },
      { name: '丙', channelId: 'ch_c', persona: '规范审查员' },
    ],
  });
  let reviewerCalls = 0;
  let failTimes = 3;
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('【角色人设】')) {
      reviewerCalls += 1;
      if (failTimes > 0) {
        failTimes -= 1;
        throw new Error('fetch failed');
      }
    }
    return JSON.stringify({
      score: 76, grade: 'B', summary: '可用。',
      highlights: [{ text: '结论明确', why: '有判断句' }],
      issues: [], suggestions: [], priority: [], focus: [],
    });
  });
  const result = await review.runRound({ workbench: 'doc', workId: project.id, sectionIdx: 1, panelId: panel.id });
  restoreModel();

  assert.equal(result.ok, true);
  assert.equal(reviewerCalls, 6, '3 位评审员各失败一次、各重试一次');
  assert.equal(result.report.scores.length, 3);
  review.deletePanel(panel.id);
});
