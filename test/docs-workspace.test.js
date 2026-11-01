'use strict';

// 文档工作台：类型库/模板解析/两种写作方式/全托管韧性 + 页面路由与 CSRF。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-docs-'));
process.env.FABULA_DATA_DIR = tempDir;
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';

const db = require('../lib/db');
db.open(path.join(__dirname, '..', 'data', 'writerx.seed.db'));

const docEngine = require('../lib/doc-engine');
const docsPage = require('../lib/docs-page');
const skillsPage = require('../lib/skills-page');
const llm = require('../lib/llm');
const mis = require('../lib/handlers-misc');
const orch = require('../lib/longform-orchestrator');

const TOKEN = 'test-csrf-token';
let server = null;
let baseUrl = '';

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    docsPage.handleDocs(req, res, u.pathname, TOKEN).then((handled) => {
      if (handled) return;
      return skillsPage.handleSkills(req, res, u.pathname, TOKEN).then((ok) => {
        if (!ok && !res.writableEnded) { res.writeHead(404); res.end('nf'); }
      });
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
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

// 桩模型会顶掉 llm.activeChannel 与 chatCompletion。必须能还原：
// 不还原的话，后面所有测试（包括检查渠道/模型的）看到的都是这个假渠道，
// 真实缺陷会被悄悄盖住——这本身就踩过一次。
const REAL_LLM = { activeChannel: llm.activeChannel, chatCompletion: llm.chatCompletion };
function restoreModel() {
  llm.activeChannel = REAL_LLM.activeChannel;
  llm.chatCompletion = REAL_LLM.chatCompletion;
}

function stubModel(handler) {
  llm.activeChannel = () => ({ baseUrl: 'http://stub.local', key: 'stub', model: 'stub-model' });
  llm.chatCompletion = async function* (options) {
    const text = handler(options);
    yield { type: 'delta', text };
    yield { type: 'meta', usage: { prompt_tokens: 7, completion_tokens: 13 }, finishReason: 'stop' };
  };
}

async function post(pathname, fields) {
  // 支持数组值（多选 select）：x=a&x=b，而不是 x=a,b
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else params.append(key, value == null ? '' : value);
  }
  const body = params.toString();
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
  return { status: response.status, location: response.headers.get('location') || '', text: await response.text() };
}

async function get(pathname) {
  const response = await fetch(`${baseUrl}${pathname}`, { redirect: 'manual' });
  return { status: response.status, text: await response.text(), type: response.headers.get('content-type') || '' };
}

// 流水线是「段落计划 → 起草 → 补写 → 评审」，一次动作可能发好几次请求，
// 按下标取提示词会越来越脆。按内容找，测试关心的是「哪一句话进没进提示词」。
function findPrompt(prompts, needle) {
  const hits = prompts.filter((text) => String(text).includes(needle));
  return hits.length ? hits[hits.length - 1] : '';
}

function planJson(chars = 800) {
  return JSON.stringify({
    targetChars: chars,
    paragraphs: [
      { goal: '提出本节的核心判断', chars: Math.round(chars / 2), materials: [] },
      { goal: '给出依据并收束', chars: Math.round(chars / 2), materials: [] },
    ],
  });
}

function longText(seed, minChars) {
  const parts = [];
  let n = 0;
  while (parts.join('').length < minChars) {
    parts.push(`本节要点${seed}${++n}：围绕主题展开论证，给出对应的事实与推理链条，并保持术语一致。`);
  }
  return parts.join('');
}

// ---------- 引擎：类型库与模板解析 ----------

test('模板解析：markdown 标题与中文序号两种划分', () => {
  const md = docEngine.parseDocTemplate([
    '# 一、执行摘要', '一页讲清项目。', '',
    '# 二、市场分析', '市场规模与客群。', '补充要求第二行。', '',
  ].join('\n'));
  assert.equal(md.length, 2);
  assert.equal(md[0].title, '一、执行摘要');
  assert.equal(md[0].brief, '一页讲清项目。');
  assert.equal(md[1].brief.includes('补充要求第二行'), true);

  const cn = docEngine.parseDocTemplate('一、项目背景\n背景说明。\n\n二、建设内容\n内容说明。');
  assert.deepEqual(cn.map((s) => s.title), ['项目背景', '建设内容']);

  const none = docEngine.parseDocTemplate('整段没有任何小节标题的模板内容：当模板不按标题划分时，超过四十个字的纯文本会整体视为单节正文处理，标题与小节要求都并入该节。');
  assert.equal(none.length, 1);
  assert.equal(none[0].title, '正文');
});

test('建项目：类型默认结构 / 上传模板 / 自定义必须有模板', () => {
  const bp = docEngine.createProject({ title: '默认结构商业计划书', docType: 'bp', mode: 'auto' });
  assert.equal(bp.sections.length, docEngine.DOC_TYPES.bp.sections.length);
  assert.equal(bp.sections[0].title, '执行摘要');

  const custom = docEngine.createProject({
    title: '上传模板的项目', docType: 'custom', mode: 'co',
    template: '# 第一章 申请单位基本情况\n单位概况。\n\n# 第二章 项目建设方案\n方案要点。',
  });
  assert.deepEqual(custom.sections.map((s) => s.title), ['第一章 申请单位基本情况', '第二章 项目建设方案']);
  assert.equal(custom.mode, 'co');

  assert.throws(() => docEngine.createProject({ title: '无模板自定义', docType: 'custom' }), /模板/);
  assert.throws(() => docEngine.createProject({ title: '' }), /标题/);
});

// ---------- 类型库：扩充后的 15 种内置类型 ----------

test('类型库：每个类型都有分组、文风、小节与专属硬约束', () => {
  const types = Object.entries(docEngine.DOC_TYPES);
  // 5 种原有 + 10 种新增（另加 custom）
  assert.equal(types.length, 16, `内置类型应为 15 种 + 自定义，实际 ${types.length}`);
  const groups = new Set(docEngine.TYPE_GROUPS);
  for (const [key, type] of types) {
    assert.equal(type.key, key, `${key} 的 key 与对象键不一致`);
    assert.ok(type.name && type.name.length >= 2, `${key} 缺名称`);
    assert.ok(groups.has(type.group), `${key} 的分组「${type.group}」不在 TYPE_GROUPS 里`);
    if (key === 'custom') { assert.equal(type.sections.length, 0); continue; }
    assert.ok(type.tone && type.tone.length > 20, `${key} 缺文风要求`);
    assert.ok(type.sections.length >= 5, `${key} 小节太少（${type.sections.length}）`);
    // 结构真的不同：没有两个类型的小节标题完全一样
    const titles = type.sections.map((s) => s.title);
    assert.equal(new Set(titles).size, titles.length, `${key} 有重复小节名`);
    for (const section of type.sections) {
      assert.ok(section.brief && section.brief.length >= 10, `${key}「${section.title}」缺写作要求`);
      assert.ok(section.minChars >= 100 && section.minChars <= 2000, `${key}「${section.title}」篇幅下限不合理`);
    }
    // 每种非自定义类型都必须有自己的硬约束，否则只是换了个标题
    assert.ok(docEngine.typeRules(key).includes('硬约束'), `${key} 缺少 TYPE_RULES 专属约束`);
  }
});

test('类型库：15 种内置类型的结构互不相同，篇幅量级符合实际', () => {
  const totals = Object.entries(docEngine.DOC_TYPES)
    .filter(([key]) => key !== 'custom')
    .map(([key, type]) => [key, type.sections.reduce((sum, s) => sum + s.minChars, 0)]);
  // 短文体（公函/新闻稿/纪要）与长文体（论文/可研/技术方案）要拉开差距，不能一套篇幅走天下
  const short = totals.filter(([, n]) => n <= 3000).map(([key]) => key);
  const long = totals.filter(([, n]) => n >= 5000).map(([key]) => key);
  assert.ok(short.length >= 3, `应有至少 3 种短文体，实际 ${short.join(',')}`);
  assert.ok(long.length >= 4, `应有至少 4 种长文体，实际 ${long.join(',')}`);
  assert.ok(totals.find(([k]) => k === 'notice')[1] < totals.find(([k]) => k === 'feasibility')[1] / 2,
    '通知的篇幅下限应远小于可研');
});

test('类型库：新增类型都能建项目并把默认结构落库', () => {
  const added = ['feasibility', 'bid', 'summary', 'minutes', 'notice', 'policy', 'prd', 'techdoc', 'press', 'speech'];
  for (const key of added) {
    const project = docEngine.createProject({ title: `${key} 项目`, docType: key, mode: 'co' });
    const expected = docEngine.DOC_TYPES[key].sections;
    assert.equal(project.sections.length, expected.length, `${key} 小节数不对`);
    assert.deepEqual(project.sections.map((s) => s.title), expected.map((s) => s.title), `${key} 小节标题不对`);
    assert.equal(project.sections[0].minChars, expected[0].minChars, `${key} 篇幅下限没落库`);
    assert.equal(docEngine.docTypeOf(key).name, docEngine.DOC_TYPES[key].name);
  }
  // 未知类型仍然兜底到自定义，不抛错（老项目/拼错参数不该把页面打挂）
  assert.equal(docEngine.docTypeOf('nope').key, 'custom');
});

test('类型库：下拉框按分组渲染 optgroup，新增类型都在', async () => {
  const res = await fetch(`${baseUrl}/docs?new=1`);
  const html = await res.text();
  assert.match(html, /<optgroup label="学术研究">/);
  assert.match(html, /<optgroup label="工作与行政">/);
  assert.match(html, /<optgroup label="产品与技术">/);
  for (const name of ['可行性研究报告', '投标文件', '工作总结与述职', '会议纪要', '通知公告（公文）',
    '制度与管理办法', '产品需求文档', '技术方案设计', '新闻稿', '演讲稿']) {
    assert.ok(html.includes(`>${name}</option>`), `下拉框缺少「${name}」`);
  }
});

test('类型库：不需要公式/图表的类型不再注入对应约束', async () => {
  const seen = [];
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    const user = String(options.messages?.[1]?.content || '');
    seen.push({ sys, user });
    if (sys.includes('段落计划')) return planJson(400);
    return longText(31, 400);
  });
  // 会议纪要：不写公式、不出图表
  const minutes = docEngine.createProject({ title: '纪要约束', docType: 'minutes', mode: 'co' });
  await docEngine.draftSection(minutes.id, 1);
  const draft = seen.find((item) => String(item.user).includes('【本节任务】'));
  assert.ok(draft, '应当发出起草请求');
  assert.ok(!draft.sys.includes('公式写法'), '纪要不该被塞公式规则');
  assert.match(draft.sys, /【纪要硬约束】/, '要注入纪要专属硬约束');
  assert.match(draft.sys, /只记结论不记过程/, '纪要的核心约束要具体');

  // 计划阶段图表上限被压到 0
  const planPrompt = seen.find((item) => String(item.sys).includes('段落计划'));
  assert.ok(planPrompt, '应当发出计划请求');
  assert.match(planPrompt.user, /figures：0~0 个图表/, '不需要图表的类型上限应为 0');
  assert.match(planPrompt.user, /本文档类型不需要图表/);

  // 论文仍然要公式规则与图表
  seen.length = 0;
  const paper = docEngine.createProject({ title: '论文约束', docType: 'paper', mode: 'co' });
  await docEngine.draftSection(paper.id, 1);
  const paperDraft = seen.find((item) => String(item.user).includes('【本节任务】'));
  assert.match(paperDraft.sys, /公式写法/, '论文仍要公式规则');
});

test('学术论文类型：含参考文献节，提示词带图表与引用纪律', async () => {
  const paper = docEngine.createProject({ title: '论文结构测试', docType: 'paper', mode: 'co' });
  const titles = paper.sections.map((s) => s.title);
  assert.ok(titles.includes('参考文献'), '论文类型必须包含参考文献节');
  assert.ok(titles.includes('结果与分析'));

  // 提示词纪律：图表编号 + Mermaid/表格指引 + 禁止编造文献（文体要求在 sys）
  const sysAll = docEngine.buildMessages({ project: paper, idx: 5 });
  assert.match(sysAll.sys, /图表必须编号/, '文体要求含图表编号纪律');
  assert.match(sysAll.sys, /Mermaid/, '指引结构图用 Mermaid');
  assert.match(sysAll.sys, /不得虚构文献/, '引用纪律');
  // 参考文献节的 brief（本节任务在 user 里）明确「只整理格式、禁止编造」
  const refsSection = paper.sections.find((s) => s.title === '参考文献');
  const refsMsgs = docEngine.buildMessages({ project: paper, idx: refsSection.idx });
  assert.match(refsMsgs.user, /严禁编造任何文献/, '参考文献节的任务指令含反幻觉约束');
  assert.match(refsMsgs.user, /GB\/T 7714/, '默认引用格式');

  // 论文撰写·图文并茂技能注入后，系统提示词带 Mermaid+表格+图注协议
  const seen = [];
  stubModel((options) => {
    seen.push(options.messages.map((m) => String(m.content || '')).join('\n'));
    return longText(5, 600);
  });
  const rich = mis.createSkill({
    name: '论文图文测试技能', description: 'x',
    promptTemplate: '按图文并茂协议：Mermaid 图+数据表+规范图注，图表编号并在正文引用。',
    kind: 'method', usageMode: 'support', domain: 'doc',
  });
  const p2 = docEngine.createProject({ title: '论文技能测试', docType: 'paper', mode: 'co', skillIds: [rich.id] });
  await docEngine.draftSection(p2.id, 5);
  assert.ok(seen.some((text) => text.includes('图文并茂协议')), '论文起草注入叠加技能模板');
});

// ---------- AI 共创 ----------

test('AI 共创：起草、按指示修改、手工保存', async () => {
  const project = docEngine.createProject({ title: '共创测试', docType: 'report', mode: 'co', brief: '社区养老调研' });
  const seen = [];
  stubModel((options) => {
    seen.push(options.messages.map((message) => String(message.content || '')).join('\n'));
    return longText(1, 500);
  });

  await docEngine.draftSection(project.id, 1);
  let fresh = docEngine.getProject(project.id);
  assert.equal(fresh.sections[0].status, 'done');
  assert.equal(fresh.sections[0].source, 'ai-draft');
  const draftPrompt = findPrompt(seen, '【本节任务】');
  assert.ok(draftPrompt.includes('调研报告'), '提示词必须带文档类型文体卡');
  assert.ok(draftPrompt.includes('社区养老调研'), '提示词必须带项目说明');
  assert.ok(draftPrompt.includes('【全文结构】'), '提示词必须带全文结构');

  await docEngine.reviseSection(project.id, 1, '语气更克制');
  fresh = docEngine.getProject(project.id);
  assert.equal(fresh.sections[0].source, 'ai-revise');
  assert.ok(seen.at(-1).includes('语气更克制'), '修改指示必须进入提示词');

  docEngine.saveSectionContent(project.id, 2, longText(2, 300), 'manual');
  fresh = docEngine.getProject(project.id);
  assert.equal(fresh.sections[1].source, 'manual');
  assert.equal(fresh.sections[1].status, 'done');
});

test('共创修改：超过单次整节修改上限时明确拒绝，原文不动', async () => {
  const project = docEngine.createProject({ title: '超长修改', docType: 'paper', mode: 'co' });
  const longText = '甲'.repeat(7000);
  docEngine.saveSectionContent(project.id, 1, longText, 'manual');
  let calls = 0;
  stubModel(() => { calls += 1; return '乙'.repeat(7000); });
  await assert.rejects(
    () => docEngine.reviseSection(project.id, 1, '整体更简洁'),
    /超过单次整节修改上限 6000 字/,
  );
  restoreModel();
  assert.equal(calls, 0, '超长时不应调用模型再截断');
  assert.equal(docEngine.getProject(project.id).sections[0].content, longText);
});

test('共创修改：当前稿完整进提示词；返回稿不足原文 85% 时放弃保存', async () => {
  const project = docEngine.createProject({ title: '修改稿门禁', docType: 'paper', mode: 'co' });
  const source = `开头。${'中间内容。'.repeat(300)}结尾标记XYZ`;
  docEngine.saveSectionContent(project.id, 1, source, 'manual');
  const prompts = [];
  stubModel((options) => {
    prompts.push(String(options.messages?.[1]?.content || ''));
    return '短稿。'.repeat(10);
  });
  await assert.rejects(
    () => docEngine.reviseSection(project.id, 1, '压缩一下'),
    /不足原文 .* 字的 85%/,
  );
  restoreModel();
  assert.ok(prompts.length >= 1);
  assert.ok(prompts.every((text) => text.includes('结尾标记XYZ')), '当前稿必须完整交给模型，不能截掉后半段');
  assert.equal(docEngine.getProject(project.id).sections[0].content, source, '不合格的短稿不能覆盖原文');

  // 合格稿：整节保存，尾部不能丢
  stubModel(() => `${source}（已修改）`);
  const result = await docEngine.reviseSection(project.id, 1, '补一句结论');
  restoreModel();
  const fresh = docEngine.getProject(project.id).sections[0].content;
  assert.equal(result.ok, true);
  assert.ok(fresh.includes('结尾标记XYZ'));
  assert.ok(fresh.endsWith('（已修改）'));
});

test('评审兜底重写：超长小节不做整节重写，避免截断后抹掉后半段', async () => {
  const project = docEngine.createProject({ title: '超长兜底', docType: 'paper', mode: 'auto', depth: 'brief' });
  const source = `${'超长小节内容。'.repeat(1050)}结尾标记XYZ`;
  docEngine.saveSectionContent(project.id, 1, source, 'manual');
  const prompts = [];
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    const user = String(options.messages?.[1]?.content || '');
    prompts.push(user);
    if (sys.includes('审稿人')) {
      return JSON.stringify({
        scores: { argument: 8, evidence: 8, structure: 10, terminology: 10, substance: 8, citation: 10 },
        total: 52, issues: ['太长'], mustFix: ['压缩'],
        patches: [{ quote: '原文里不存在的句子。', issue: 'x', replacement: 'y' }],
        unanswered: [],
      });
    }
    return '不应该发生的整节重写。';
  });
  const fixed = await docEngine.reviewAndFix(docEngine.getProject(project.id), 1, source, { threshold: 70 });
  restoreModel();
  assert.equal(fixed.content, source, '超过上限时应保留原稿');
  assert.equal(fixed.revised, false);
  assert.ok(!prompts.some((text) => text.includes('【当前稿】')), '不应把截断后的稿件送去整节重写');
});

test('AI 共创：空内容与未配置渠道的失败路径', async () => {
  const project = docEngine.createProject({ title: '共创失败路径', docType: 'report', mode: 'co' });
  stubModel(() => '太短');
  await assert.rejects(() => docEngine.draftSection(project.id, 1), /过短/);
  llm.activeChannel = () => null;
  await assert.rejects(() => docEngine.draftSection(project.id, 1), /未配置模型渠道/);
});

// ---------- AI 全托管 ----------

test('全托管：逐节生成、跳过已有、隔离失败节、完成收尾', async () => {
  const project = docEngine.createProject({
    title: '托管测试', docType: 'report', mode: 'auto',
    template: '# 摘要\n概括。\n\n# 背景与调研方法\n说明方法。\n\n# 现状分析\n分块现状。\n\n# 结论\n收束。',
  });
  // 预置第 2 节为已完成：全托管必须跳过且不覆盖。
  docEngine.saveSectionContent(project.id, 2, longText(9, 400), 'manual');

  stubModel((options) => {
    const user = String(options.messages?.[1]?.content || '');
    const matched = user.match(/写第 (\d+) 节「([^」]+)」/);
    const idx = matched ? Number(matched[1]) : 0;
    return idx === 3 ? '不行。' : longText(idx || 1, 600);
  });

  const result = await docEngine.generateDocProject({ projectId: project.id, maxRetries: 1, retryBaseDelayMs: 1 });
  assert.equal(result.ok, false, '有隔离节整体不算成功');
  assert.deepEqual(result.created, [1, 4], '第2节已有内容跳过，第3节失败隔离，其余生成');
  assert.deepEqual(result.skipped, [2]);
  assert.deepEqual(result.quarantined.map((item) => item.idx), [3]);
  assert.match(result.quarantined[0].message, /门禁未通过/);

  const fresh = docEngine.getProject(project.id);
  assert.equal(fresh.sections[0].status, 'done');
  assert.equal(fresh.sections[1].source, 'manual', '已有内容不得被覆盖');
  assert.equal(fresh.sections[2].status, 'quarantined');
  assert.equal(fresh.sections[3].status, 'done');
  assert.equal(orch.getRun(result.runId).status, 'quarantined');

  // 模型恢复后从断点续跑：只补第 3 节，复用原 run。
  stubModel(() => longText(3, 600));
  const resumed = await docEngine.resumeDocRun(result.runId, { retryBaseDelayMs: 1 });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.runId, result.runId);
  assert.deepEqual(resumed.created, [3]);
  const done = docEngine.getProject(project.id);
  assert.equal(done.sections.filter((s) => s.status === 'done').length, 4);
  assert.equal(orch.getRun(result.runId).status, 'completed');

  const assembled = docEngine.assembleMarkdown(project.id);
  assert.match(assembled.markdown, /^# 托管测试/);
  assert.match(assembled.markdown, /## 摘要/);
  assert.ok(assembled.markdown.includes('## 结论'));
});

test('全托管：连续两节失败停机；预算暂停可续跑', async () => {
  const project = docEngine.createProject({
    title: '托管停机测试', docType: 'report', mode: 'auto',
    template: '# 摘要\n概括。\n\n# 背景与调研方法\n方法。\n\n# 现状分析\n现状。\n\n# 结论\n结论。',
  });
  stubModel(() => '不行。');
  const stopped = await docEngine.generateDocProject({ projectId: project.id, maxRetries: 1, retryBaseDelayMs: 1 });
  assert.equal(stopped.runStatus, 'quarantined');
  assert.match(stopped.stopReason, /连续 2 节失败/);
  assert.deepEqual(stopped.quarantined.map((item) => item.idx), [1, 2], '连续失败达到阈值立即停，第3节不再尝试');

  const budgetProject = docEngine.createProject({
    title: '托管预算测试', docType: 'report', mode: 'auto',
    template: '# 摘要\n概括。\n\n# 背景与调研方法\n方法。\n\n# 现状分析\n现状。',
  });
  stubModel((options) => {
    const user = String(options.messages?.[1]?.content || '');
    const matched = user.match(/写第 (\d+) 节/);
    return longText(matched ? Number(matched[1]) : 1, 600);
  });
  const paused = await docEngine.generateDocProject({
    projectId: budgetProject.id, maxRetries: 1, retryBaseDelayMs: 1, maxTokensPerRun: 40,
  });
  assert.equal(paused.runStatus, 'paused_budget');
  assert.match(paused.stopReason, /已达到上限/);
  assert.ok(paused.created.length >= 1, '预算耗尽前至少推进一节');
  assert.equal(orch.getRun(paused.runId).status, 'paused_budget');

  const resumed = await docEngine.resumeDocRun(paused.runId, { retryBaseDelayMs: 1, maxTokensPerRun: 10000 });
  assert.equal(resumed.runStatus, 'completed');
  assert.equal(orch.getRun(paused.runId).status, 'completed');
});

test('删除项目时状态机记录一并清理', async () => {
  const project = docEngine.createProject({ title: '清理测试', docType: 'report', mode: 'auto' });
  stubModel(() => longText(1, 600));
  const result = await docEngine.generateDocProject({ projectId: project.id, maxRetries: 1, retryBaseDelayMs: 1 });
  assert.ok(result.runId, '先产生一条任务记录');
  docEngine.deleteProject(project.id);
  assert.equal(docEngine.getProject(project.id), null);
  assert.equal(orch.getRun(result.runId), null, 'generation_runs 一并清理');
  assert.equal(Number(db.one(`SELECT COUNT(*) AS n FROM chapter_runs WHERE run_id=?`, result.runId).n), 0);
  assert.equal(Number(db.one(`SELECT COUNT(*) AS n FROM generation_attempts WHERE run_id=?`, result.runId).n), 0);
});

// ---------- 页面路由 ----------

test('页面路由：列表/创建/工作台/导出 + CSRF 防线', async () => {
  const list = await get('/docs');
  assert.equal(list.status, 200);
  assert.match(list.text, /文档工作台/);
  assert.match(list.text, /商业计划书/);
  assert.match(list.text, /AI 全托管/);
  assert.match(list.text, /AI 共创/);
  assert.match(list.text, /type="file"/, '模板上传入口存在');

  // 坏 CSRF 一律 403。
  assert.equal((await post('/docs/create', { csrf: 'wrong', title: 'X' })).status, 403);
  assert.equal((await post('/docs/section/save', { csrf: 'wrong', projectId: 'x', idx: '1', content: 'y' })).status, 403);
  assert.equal((await post('/docs/generate', { csrf: 'wrong', projectId: 'x' })).status, 403);
  assert.equal((await post('/skills/create', { csrf: 'wrong', name: 'X' })).status, 403);

  // 正常创建 → 跳转工作台。
  const created = await post('/docs/create', {
    csrf: TOKEN, title: '路由创建的申报书', docType: 'proposal', mode: 'co',
    brief: '数字化改造项目', template: '',
  });
  assert.equal(created.status, 303);
  const projectId = new URL(created.location, 'http://x').searchParams.get('id');
  const workspace = await get(created.location);
  assert.equal(workspace.status, 200);
  assert.match(workspace.text, /路由创建的申报书/);
  assert.match(workspace.text, /立项背景与意义/);
  assert.match(workspace.text, /导出全文 Markdown/);
  assert.match(workspace.text, /AI 共创/, '模式胶囊存在');
  assert.match(workspace.text, /AI 全托管/, '模式胶囊存在');
  // 共创模式做逐节推进，不做整篇批量（整篇批量是全托管的语义）。
  assert.match(workspace.text, /AI 续写下一节/, '共创模式含单步续写入口');
  assert.ok(!workspace.text.includes('⚙ 整篇生成'), '共创模式不应出现整篇生成按钮');

  // 手工保存小节。
  const saved = await post('/docs/section/save', {
    csrf: TOKEN, projectId, idx: '1', content: longText(5, 300),
  });
  assert.equal(saved.status, 303);
  const after = docEngine.getProject(projectId);
  assert.equal(after.sections[0].status, 'done');

  // 导出。
  const exported = await get(`/docs/project/${projectId}/export`);
  assert.equal(exported.status, 200);
  assert.match(exported.type, /text\/markdown/);
  assert.match(exported.text, /# 路由创建的申报书/);

  // 未知项目 404，未知路径回落 404。
  assert.equal((await get('/docs/project/not-exists')).status, 200, '未知项目渲染提示页而非崩溃');
  assert.match((await get('/docs/project/not-exists')).text, /不存在/);
});

test('技能广场页面：列表、新建、启停、导出', async () => {
  const page = await get('/skills');
  assert.equal(page.status, 200);
  assert.match(page.text, /技能广场/);
  assert.match(page.text, /官方内置/);
  assert.match(page.text, /新建技能/);

  const created = await post('/skills/create', {
    csrf: TOKEN, name: '竞品分析框架', description: '拆解竞争格局',
    promptTemplate: '你是资深行业分析师，请基于资料输出竞品分析。', kind: 'method', usageMode: 'support',
  });
  assert.equal(created.status, 303);
  const skill = mis.listSkills().find((item) => item.name === '竞品分析框架');
  assert.ok(skill, '新技能已入库');
  assert.equal(skill.origin, 'user');

  const disabled = await post('/skills/toggle', { csrf: TOKEN, id: skill.id });
  assert.equal(disabled.status, 303);
  assert.equal(mis.listSkills().find((item) => item.id === skill.id).enabled, false);

  const exported = await get(`/skills/export/${skill.id}`);
  assert.equal(exported.status, 200);
  assert.match(exported.text, /# 竞品分析框架/);

  const deleted = await post('/skills/delete', { csrf: TOKEN, id: skill.id });
  assert.equal(deleted.status, 303);
  assert.equal(mis.listSkills().find((item) => item.id === skill.id), undefined);
});

test('技能勾选注入生成提示词，并持久化到项目', async () => {
  const skill = mis.createSkill({
    name: '竞品分析框架', description: '拆解竞争格局',
    promptTemplate: '你是资深行业分析师，请用波特五力输出分析。', kind: 'method', usageMode: 'support',
    domain: 'doc',
  });
  // 域隔离：novel 域技能不得绑进文档项目。
  const novelSkill = mis.createSkill({ name: '小说技能', description: 'x', promptTemplate: 'y', kind: 'method', domain: 'novel' });
  const project = docEngine.createProject({
    title: '技能注入测试', docType: 'report', mode: 'co', skillIds: [skill.id, novelSkill.id],
  });
  assert.deepEqual(project.skillIds, [skill.id], '跨域的 novel 技能被过滤，doc 技能保留');

  const seen = [];
  stubModel((options) => {
    seen.push(options.messages.map((message) => String(message.content || '')).join('\n'));
    return longText(1, 500);
  });
  await docEngine.draftSection(project.id, 1);
  const draftPrompt = findPrompt(seen, '【本节任务】');
  assert.match(draftPrompt, /【叠加技能：竞品分析框架】/, '起草提示词必须注入勾选的技能模板');
  assert.match(draftPrompt, /波特五力/);

  // 解绑后不再注入。
  docEngine.setProjectSkills(project.id, []);
  await docEngine.reviseSection(project.id, 1, '语气更克制');
  const revisePrompt = findPrompt(seen, '语气更克制');
  assert.ok(revisePrompt && !revisePrompt.includes('【叠加技能'), '解绑后不得再注入');
});

test('技能域隔离：文档工作台只勾选 doc 域技能，小说技能不可见', async () => {
  const novelSkill = mis.createSkill({ name: '小说专属技能', description: '小说用', promptTemplate: '小说提示', kind: 'method', domain: 'novel' });
  const docSkill = mis.createSkill({ name: '文档专属技能', description: '文档用', promptTemplate: '文档提示', kind: 'method', domain: 'doc' });

  // 默认（不传 domain）= 小说域。
  assert.equal(mis.createSkill({ name: '默认域技能', description: 'x', promptTemplate: 'y' }).domain, 'novel');

  const project = docEngine.createProject({ title: '域隔离文档', docType: 'report', mode: 'co' });
  const workspace = docsPage.renderProjectPage(project.id, { csrf: 't' });
  // 文档技能在勾选菜单里可见；小说技能不可见。
  assert.match(workspace, /文档专属技能/, 'doc 域技能必须出现在文档工作台');
  assert.ok(!workspace.includes('小说专属技能'), 'novel 域技能不得混入文档工作台');
});

test('状态页兼容文档任务：标题、进度单位与续跑入口', async () => {
  const statusPage = require('../lib/status-page');
  const project = docEngine.createProject({ title: '状态页可见的文档', docType: 'bp', mode: 'auto' });
  stubModel(() => longText(1, 600));
  await docEngine.generateDocProject({ projectId: project.id, maxRetries: 1, retryBaseDelayMs: 1 });
  const runs = statusPage.collectRuns(5);
  const docRun = runs.find((run) => run.bookId === project.id);
  assert.ok(docRun, '文档任务必须出现在状态页');
  assert.equal(docRun.isDoc, true);
  assert.equal(docRun.bookTitle, '状态页可见的文档');
  const html = statusPage.renderStatus({ csrf: TOKEN });
  assert.match(html, /状态页可见的文档/);
  assert.match(html, /节/, '进度单位为节');
});

// ---------- 页面脚本与创建路径（曾经整体失效的地方） ----------

test('页面脚本能被浏览器解析，且页面内 id 不重复', () => {
  const empty = docsPage.renderDocsPage({ csrf: 't' });
  const project = docEngine.createProject({ title: '脚本检查', docType: 'report', mode: 'co' });
  const workspace = docsPage.renderProjectPage(project.id, { csrf: 't' });

  for (const [label, html] of [['空态', empty], ['工作台', workspace]]) {
    const script = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(script, `${label}页面必须有脚本`);
    assert.doesNotThrow(
      () => new Function(script[1]),
      `${label}页面的内联脚本必须是合法 JS——模板字面量里的 \\n 一旦被转义成真换行，整段脚本会静默失效`,
    );

    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    const duplicated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    assert.deepEqual(duplicated, [], `${label}页面存在重复 id：${duplicated.join('、')}`);
  }
});

test('创建表单的模板字段唯一，模板内容才进得了服务端', () => {
  const html = docsPage.renderDocsPage({ csrf: 't' });
  // 空态工具条与新建弹窗各有一个表单，每个表单只能有一个 name="template"。
  assert.equal([...html.matchAll(/name="template"/g)].length, 2, '两个表单各一个同名字段');
  assert.match(html, /<textarea id="cxTplArea"/, '空态模板框不再与隐藏域同名');
  assert.match(html, /<textarea name="template" id="cmTplArea"/, '弹窗模板框有独立 id');
  assert.match(html, /class="js-readtext" data-target="cxTplArea"/, '模板上传要写到空态模板框');
  assert.match(html, /class="js-readtext" data-target="cmTplArea"/, '模板上传要写到弹窗模板框');
});

test('保存写作要点：多行论据不会丢，JSON 形态也兼容', async () => {
  const project = docEngine.createProject({ title: '要点保存', docType: 'report', mode: 'co' });
  const saved = await post('/docs/outline', {
    csrf: TOKEN, projectId: project.id, thesis: '数字化是生存问题',
    points: '已有 3 个标杆案例\n改造两年回本\n- 政策补贴覆盖 30%',
  });
  assert.equal(saved.status, 303);

  let fresh = docEngine.getProject(project.id);
  assert.equal(fresh.thesis, '数字化是生存问题');
  assert.deepEqual(fresh.points, ['已有 3 个标杆案例', '改造两年回本', '政策补贴覆盖 30%']);

  await post('/docs/outline', { csrf: TOKEN, projectId: project.id, thesis: 'x', pointsJson: '["甲","乙"]' });
  fresh = docEngine.getProject(project.id);
  assert.deepEqual(fresh.points, ['甲', '乙'], '新建弹窗走 JSON 形态同样要能存');
});

test('模式可随时切换，两种模式的输入条与主按钮不同', async () => {
  const project = docEngine.createProject({ title: '模式切换', docType: 'report', mode: 'co' });

  const co = (await get(`/docs?id=${project.id}`)).text;
  assert.match(co, /共创模式：通过对话协作完成本节/);
  assert.match(co, /✦ AI 续写下一节/);
  assert.match(co, /共创对话/, '共创模式要显示对话线程');

  const switched = await post('/docs/mode', { csrf: TOKEN, projectId: project.id, mode: 'auto', s: '2' });
  assert.equal(switched.status, 303);
  assert.match(switched.location, /s=2/, '切换模式不应把作者踢回第一节');
  assert.equal(docEngine.getProject(project.id).mode, 'auto');

  const auto = (await get(`/docs?id=${project.id}&s=2`)).text;
  assert.match(auto, /全托管模式：逐节指示修改/);
  assert.match(auto, /⚙ 整篇生成/);
  assert.ok(!auto.includes('✦ AI 续写下一节'), '全托管不显示单步续写');
});

test('共创对话：追问不落稿、半截话不落稿、成稿落稿并显示正文', async () => {
  const project = docEngine.createProject({ title: '共创对话', docType: 'report', mode: 'co', brief: '社区养老' });

  stubModel(() => '问：这一节要覆盖哪些人群？\n问：有没有可用的调研数据？');
  let result = await docEngine.sectionChat({ projectId: project.id, idx: 1, message: '写调研方法' });
  assert.equal(result.type, 'question');
  assert.equal(docEngine.getProject(project.id).sections[0].content, '', '追问不能落稿');

  stubModel(() => '好的。');
  result = await docEngine.sectionChat({ projectId: project.id, idx: 1, message: '开始写' });
  assert.equal(result.type, 'rejected');
  assert.equal(docEngine.getProject(project.id).sections[0].content, '', '半截话不能覆盖正文');

  stubModel(() => longText(4, 600));
  result = await docEngine.sectionChat({ projectId: project.id, idx: 1, message: '开始写' });
  assert.equal(result.type, 'draft');
  const fresh = docEngine.getProject(project.id);
  assert.equal(fresh.sections[0].status, 'done');
  assert.equal(fresh.sections[0].source, 'ai-chat');
  assert.equal(fresh.sections[0].chat.length, 6, '三次回复都要留在对话历史里');

  const page = (await get(`/docs?id=${project.id}&s=1`)).text;
  assert.match(page, /class="sec__text"/, '成稿要出现在正文区，而不只在气泡里');
});

test('共创起草一次不达标会重写，并把原因写回提示词', async () => {
  const project = docEngine.createProject({ title: '共创重写', docType: 'report', mode: 'co' });
  const seen = [];
  let draftCalls = 0;
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    const user = String(options.messages?.[1]?.content || '');
    if (sys.includes('段落计划')) return planJson(800);
    seen.push(user);
    draftCalls += 1;
    return draftCalls === 1 ? '太短。' : longText(2, 700);
  });

  const result = await docEngine.draftSection(project.id, 1);
  assert.equal(result.ok, true);
  assert.equal(draftCalls, 2, '第一次不达标必须重写一次');
  assert.ok(!seen[0].includes('上一次尝试被判定不合格'));
  assert.match(seen[1], /上一次尝试被判定不合格/);
  assert.match(seen[1], /过短|不合格/);
});

test('全托管：已有任务时拒绝再起一个，续跑保留预算，报告可读', async () => {
  const project = docEngine.createProject({
    title: '托管韧性', docType: 'report', mode: 'auto',
    template: '# 摘要\n概括。\n\n# 背景与调研方法\n方法。\n\n# 现状分析\n现状。',
  });
  stubModel((options) => {
    const user = String(options.messages?.[1]?.content || '');
    const matched = user.match(/写第 (\d+) 节/);
    return longText(matched ? Number(matched[1]) : 1, 600);
  });

  const first = await docEngine.generateDocProject({
    projectId: project.id, maxRetries: 1, retryBaseDelayMs: 1, maxTokensPerRun: 120,
  });
  assert.equal(first.runStatus, 'paused_budget');
  assert.deepEqual(first.created, [1, 2]);
  assert.ok(first.usage.totalTokens > 0);
  assert.deepEqual(first.report.map((item) => item.status), ['created', 'created', 'pending']);
  assert.ok(first.report[0].chars > 0, '报告要带每节字数');

  // 已有未结束任务时不能再起一个（否则第二个 createRun 会把第一个标成 abandoned）。
  await assert.rejects(
    () => docEngine.generateDocProject({ projectId: project.id, maxRetries: 1, retryBaseDelayMs: 1 }),
    (error) => error.code === 'RUN_ACTIVE',
  );

  // 续跑不传预算：沿用原预算并给新窗（已花 + 原窗），不是清零后无限跑。
  const second = await docEngine.resumeDocRun(first.runId, { retryBaseDelayMs: 1 });
  assert.deepEqual(second.created, [3]);
  assert.equal(second.runStatus, 'completed');
  assert.deepEqual(second.report.map((item) => item.status), ['skipped', 'skipped', 'created']);
});

test('同一任务不会并发续跑两份', async () => {
  const statusPage = require('../lib/status-page');
  let calls = 0;
  const first = statusPage.startResume('guard-run', {
    resume: async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { created: [] }; },
    onSettled: () => {},
  });
  const second = statusPage.startResume('guard-run', {
    resume: async () => { calls += 1; return { created: [] }; },
    onSettled: () => {},
  });

  assert.equal(first, true);
  assert.equal(second, false, '在途时第二次启动必须被拒绝');
  assert.equal(statusPage.isRunning('guard-run'), true);

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls, 1, '只允许跑一份');
  assert.equal(statusPage.isRunning('guard-run'), false, '结束后标记要释放');
});

// ---------- 素材通道 / 跨节上下文 / 全文体检 / Word 导出 ----------

test('素材：加入、按节检索注入提示词、删除', async () => {
  const project = docEngine.createProject({ title: '素材通道论文', docType: 'paper', mode: 'co' });
  // 太短的素材没有信息量，直接拒绝（免得作者以为加上了）
  assert.throws(() => docEngine.addMaterial({ projectId: project.id, content: '太短' }), /素材太短/);

  const literature = docEngine.addMaterial({
    projectId: project.id, kind: 'literature', title: '张三(2023) 制造业数字化转型研究',
    content: '张三（2023）基于 312 家中小制造企业的问卷数据发现，数字化改造的投入回收期中位数为 2.1 年，'
      + '其中设备联网率高于 60% 的企业回收期缩短至 1.4 年。研究指出组织能力是调节变量。',
  });
  assert.ok(literature.id);
  docEngine.addMaterial({
    projectId: project.id, kind: 'data', title: '行业规模数据',
    content: '根据工信部 2024 年统计，中小制造企业数字化服务市场规模约 1280 亿元，同比增长 23.4%。',
  });
  assert.equal(docEngine.listMaterials(project.id).length, 2);
  assert.equal(docEngine.listMaterials(project.id)[0].chars > 20, true);

  // 第 3 节「文献综述」的提示词必须带上文献素材，并且明确「只能引用素材」。
  // 段头名称可以随上下文引擎演进（从「作者提供的素材」到「本节相关证据」），
  // 但两件事不能变：素材带稳定编号、只许引用素材里的事实。
  const project2 = docEngine.getProject(project.id);
  const { user } = docEngine.buildMessages({ project: project2, idx: 3 });
  assert.match(user, /唯一可用的事实来源，按编号引用/);
  assert.match(user, /〈素材 M\d：/, '素材必须带全文稳定的编号，参考文献页才对得上');
  assert.doesNotMatch(user, /\[M1\]/, '提示词里不能出现具体的示例编号，否则模型会照抄一个不存在的编号');
  assert.match(user, /张三（2023）/);
  assert.match(user, /禁止编造数据、文献/);
  assert.match(user, /【语料概览】/, '要告诉模型语料有多大、本节用了多少');

  // 无关小节也不至于把素材全丢掉（评分只是排序，不是过滤）
  const section2 = docEngine.buildMessages({ project: project2, idx: 5 }).user;
  assert.match(section2, /【本节相关证据|【作者提供的素材/);

  docEngine.removeMaterial({ projectId: project.id, id: literature.id });
  assert.equal(docEngine.listMaterials(project.id).length, 1);
  assert.doesNotMatch(docEngine.buildMessages({ project: docEngine.getProject(project.id), idx: 3 }).user, /张三（2023）/);
});

test('素材：页面可增删，且素材卡显示条数与字数', async () => {
  const project = docEngine.createProject({ title: '素材页论文', docType: 'paper', mode: 'co' });
  const added = await post('/docs/material/add', {
    csrf: TOKEN, projectId: project.id, s: '3', kind: 'literature', title: '李四(2022)',
    content: '李四（2022）以案例研究法分析 6 家标杆工厂，提出「先流程后系统」的改造顺序，并给出三阶段实施路径。',
  });
  assert.equal(added.status, 303);
  assert.match(added.location, new RegExp(`/docs\\?id=${project.id}&s=3`));

  const page = await get(`/docs?id=${project.id}&s=3`);
  assert.match(page.text, /📚 素材/);
  assert.match(page.text, /李四\(2022\)/);
  assert.match(page.text, /1 条/);

  const materialId = docEngine.listMaterials(project.id)[0].id;
  const removed = await post('/docs/material/delete', { csrf: TOKEN, projectId: project.id, s: '3', materialId });
  assert.equal(removed.status, 303);
  assert.equal(docEngine.listMaterials(project.id).length, 0);
});

test('跨节上下文：后文能看到全部前节要点与上一节结尾', async () => {
  const project = docEngine.createProject({
    title: '上下文论文', docType: 'paper', mode: 'co',
    sections: [{ title: '引言' }, { title: '文献综述' }, { title: '研究方法' }],
  });
  docEngine.saveSectionContent(project.id, 1, '本文讨论中小制造企业的数字化改造路径。核心判断是组织能力比设备投入更关键。');
  docEngine.saveSectionContent(project.id, 2, '已有研究分为技术决定论与组织能力论两支。前者强调设备联网率，后者强调流程再造。');

  const fresh = docEngine.getProject(project.id);
  const { user } = docEngine.buildMessages({ project: fresh, idx: 3 });
  // 第 1 节的要点（不只是上一节）也要在：原来只取前 500 字，第 3 节根本看不到第 1 节立了什么论
  assert.match(user, /【前文要点（不要重复论述，只做承接）】/);
  assert.match(user, /第1节「引言」：本文讨论中小制造企业/);
  assert.match(user, /第2节「文献综述」：已有研究分为技术决定论/);
  // 上一节结尾保留原文（语气衔接）
  assert.match(user, /【第2节「文献综述」结尾】/);
  assert.match(user, /强调流程再造/);
  // 第一节没有前文，不该出现空块
  assert.doesNotMatch(docEngine.buildMessages({ project: fresh, idx: 1 }).user, /【前文要点/);

  const chain = docEngine.contextChain(fresh.sections, 3);
  assert.equal(chain.points.split('\n').length, 2);
  assert.ok(docEngine.summarizeSection('一句话。'.repeat(80)).length <= 180, '要点要压到 180 字内');
});

test('篇幅下限按类型落库：论文「结果与分析」要求 1600 字，门禁就按 1600 算', () => {
  const paper = docEngine.createProject({ title: '篇幅论文', docType: 'paper', mode: 'auto' });
  const result = paper.sections.find((section) => section.title === '结果与分析');
  // 论文的篇幅下限按「真论文」量级定：正文 6000+ 字，结果与分析是最重的一节。
  // 低于这个量级时，无论模型怎么写都只能停在结论层——深度首先受篇幅约束。
  assert.equal(result.minChars, 1600);
  assert.equal(docEngine.sectionMinChars(result), 1600);
  // 旧项目（min_chars=0）仍按 brief 长度估算，不至于因为没落库就 0 字下限
  assert.equal(docEngine.sectionMinChars({ brief: '' }), 800);
});

test('全文体检：跨节重复、篇幅塌陷、待补占位、论据未用上都能报出来', () => {
  const project = docEngine.createProject({
    title: '体检论文', docType: 'paper', mode: 'auto',
    points: ['投入回收期两年', '政策补贴覆盖三成'],
    sections: [{ title: '引言' }, { title: '结果与分析' }],
  });
  const shared = '这一段在引言和结果里一字不差地出现了两次，属于典型的跨节复制粘贴——模型在批量生成时偷懒，'
    + '把上一节的结尾原样搬到下一节的开头，逐节门禁完全看不出来，只有把全文放在一起比才会暴露。';
  docEngine.saveSectionContent(project.id, 1, `${shared}\n\n引言部分补充说明研究背景与问题提出，篇幅勉强够。`);
  docEngine.saveSectionContent(project.id, 2, `${shared}\n\n结果与分析只写了这么一句，还留了【待补数据】和【待补文献】。`);

  const audit = docEngine.auditProject(project.id);
  assert.ok(audit.summary.done === 2);
  assert.equal(audit.summary.duplicates, 1);
  assert.equal(audit.summary.todo, 2);
  const codes = audit.issues.map((issue) => issue.code);
  assert.ok(codes.includes('duplicate'), '跨节重复要报');
  assert.ok(codes.includes('short'), '篇幅不足要报');
  assert.ok(codes.includes('todo'), '待补占位要报');
  assert.ok(codes.includes('unused-points'), '论据没写进正文要提示');
  assert.equal(audit.issues.find((issue) => issue.code === 'duplicate').level, 'warn');

  // 空项目不该炸，只是报「没有正文」
  const blank = docEngine.createProject({ title: '空白论文', docType: 'paper' });
  assert.equal(docEngine.auditProject(blank.id).summary.done, 0);
  assert.equal(docEngine.auditProject('not-exist'), null);
});

test('Word 导出：合法 zip、含标题与各节、中文文件名', async () => {
  const project = docEngine.createProject({ title: '制造业数字化转型研究', docType: 'paper', mode: 'auto' });
  docEngine.saveSectionContent(project.id, 1,
    '# 研究背景\n\n本文关注中小制造企业。\n\n- 设备联网率低\n- 组织能力不足\n\n| 指标 | 2023 | 2024 |\n| --- | --- | --- |\n| 规模 | 1280 | 1580 |\n\n**核心判断**：组织能力比设备投入更关键。');

  const { parseZip } = require('../lib/zip');
  const assembled = docEngine.assembleDocx(project.id);
  assert.equal(assembled.filename, '制造业数字化转型研究.docx');
  const entries = parseZip(assembled.buffer);
  const names = entries.map((entry) => entry.name).sort();
  assert.deepEqual(names, ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels',
    'word/document.xml', 'word/settings.xml', 'word/styles.xml']);

  const docXml = String(entries.find((entry) => entry.name === 'word/document.xml').data);
  assert.match(docXml, /制造业数字化转型研究/);
  assert.match(docXml, /摘要/);
  assert.match(docXml, /<w:tbl>/);              // 表格
  assert.match(docXml, /<w:b\/>/);              // 粗体
  assert.match(docXml, /w:pStyle w:val="Heading1"/); // 节标题走 Heading1
  // 正文里的 # 必须降级，不能和节标题同级
  assert.match(docXml, /w:pStyle w:val="Heading2"/);
  // 样式表里要有对应定义，否则 Word 会当成普通正文
  const stylesXml = String(entries.find((entry) => entry.name === 'word/styles.xml').data);
  assert.match(stylesXml, /w:styleId="Heading1"/);
  assert.match(stylesXml, /w:eastAsia="宋体"/);

  const response = await fetch(`${baseUrl}/docs/project/${project.id}/docx`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /wordprocessingml/);
  const disposition = response.headers.get('content-disposition') || '';
  assert.match(disposition, /filename\*=UTF-8''/);
  assert.ok((await response.arrayBuffer()).byteLength > 1000);

  assert.equal(await (await fetch(`${baseUrl}/docs/project/nope/docx`)).status, 404);
});

// ---------- 借鉴同类开源项目后的写作技法层 ----------
// 计划（AgentWrite）、评审（AI-Scientist reviewer）、润色（AutoSurvey refinement）、
// 视角提问（STORM）、引用与参考文献（STORM/AutoSurvey）。

test('段落计划：起草前先出计划、落库、重试时复用', async () => {
  const project = docEngine.createProject({ title: '计划测试', docType: 'report', mode: 'co', brief: '社区养老' });
  const calls = [];
  let draftCalls = 0;
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('段落计划')) { calls.push('plan'); return planJson(900); }
    calls.push('draft');
    draftCalls += 1;
    return draftCalls === 1 ? '太短。' : longText(3, 900);
  });

  await docEngine.draftSection(project.id, 1);
  const fresh = docEngine.getProject(project.id);
  assert.ok(fresh.sections[0].plan, '计划必须落库（重试与续写都要用同一份骨架）');
  assert.equal(fresh.sections[0].plan.paragraphs.length, 2);
  assert.equal(calls.filter((item) => item === 'plan').length, 1, '重试不得重出计划');
  assert.equal(draftCalls, 2, '第一次不达标仍要重写一次');

  // 计划里每段的目标字数必须进起草提示词，否则计划等于白做
  const seen = [];
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    seen.push(String(options.messages?.[1]?.content || ''));
    if (sys.includes('段落计划')) return planJson(900);
    return longText(4, 900);
  });
  await docEngine.draftSection(project.id, 2);
  const draftPrompt = findPrompt(seen, '【本节任务】');
  assert.match(draftPrompt, /【段落计划（按此顺序写，不要写成摘要）】/);
  assert.match(draftPrompt, /第 1 段｜约 \d+ 字/);
});

test('计划解析失败不影响写作：退回单段直写', async () => {
  const project = docEngine.createProject({ title: '计划兜底', docType: 'report', mode: 'co' });
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    return sys.includes('段落计划') ? '抱歉，我无法输出 JSON。' : longText(5, 800);
  });
  const result = await docEngine.draftSection(project.id, 1);
  assert.equal(result.ok, true);
  assert.equal(docEngine.getProject(project.id).sections[0].plan, null, '解析失败不落库');
  assert.ok(docEngine.getProject(project.id).sections[0].content.length > 500);
});

test('字数缺口续写：写短了接着写，拒答不接长', async () => {
  const project = docEngine.createProject({ title: '续写测试', docType: 'report', mode: 'co' });
  let draftCalls = 0;
  let contCalls = 0;
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('段落计划')) return planJson(900);
    if (sys.includes('正在续写同一节')) { contCalls += 1; return longText(7, 500); }
    draftCalls += 1;
    return longText(6, 400);
  });
  await docEngine.draftSection(project.id, 1);
  const body = docEngine.getProject(project.id).sections[0].content;
  assert.equal(draftCalls, 1, '一次生成没达标不整节重写，而是接着写');
  assert.equal(contCalls, 1);
  assert.ok(body.length >= 850, `续写后应接近目标，实际 ${body.length}`);

  // 拒答（极短）不接长：那不是「写短了」，是这次生成失败了
  const other = docEngine.createProject({ title: '拒答不接长', docType: 'report', mode: 'co' });
  let refuseCont = 0;
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('段落计划')) return planJson(900);
    if (sys.includes('正在续写同一节')) { refuseCont += 1; return longText(8, 500); }
    return '不行。';
  });
  await assert.rejects(() => docEngine.draftSection(other.id, 1), /过短|不合格/);
  assert.equal(refuseCont, 0, '拒答不能被续写接成 500 字混过门禁');
});

test('评审：六维打分、mustFix 落库、低于阈值自动修订一次', async () => {
  const project = docEngine.createProject({ title: '评审测试', docType: 'paper', mode: 'co' });
  let revised = 0;
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    const user = String(options.messages?.[1]?.content || '');
    if (sys.includes('段落计划')) return planJson(800);
    if (sys.includes('期刊审稿人')) {
      return JSON.stringify({
        scores: { argument: 8, evidence: 6, structure: 9, terminology: 12, substance: 6, citation: 14 },
        total: 999,
        issues: ['第二段只说「效果显著」，没有任何数据'],
        mustFix: ['给第二段补一个可核对的数字'],
      });
    }
    if (user.includes('评审必须修正')) { revised += 1; return longText(11, 900); }
    return longText(10, 800);
  });

  const result = await docEngine.draftSection(project.id, 1, { review: true });
  // 分项之和 55，模型把 total 写成 999 —— 以分项为准
  assert.equal(result.review.total, 55);
  assert.equal(result.reviewed, undefined);
  assert.equal(result.review.mustFix[0], '给第二段补一个可核对的数字');
  assert.equal(revised, 1, '低于 70 分必须带着 mustFix 修订一次');
  assert.equal(result.review.afterFix, true);
  const fresh = docEngine.getProject(project.id);
  assert.equal(fresh.sections[0].review.total, 55, '评审结果要落库');
  assert.equal(fresh.sections[0].source, 'ai-revise');
  assert.ok(fresh.sections[0].content.length >= 850);
});

test('评审：高分不修订；模型乱写也不阻断成稿', async () => {
  const project = docEngine.createProject({ title: '评审高分', docType: 'paper', mode: 'co' });
  let revised = 0;
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('段落计划')) return planJson(800);
    if (sys.includes('期刊审稿人')) {
      return JSON.stringify({ scores: { argument: 18, evidence: 16, structure: 17, terminology: 18, substance: 16, citation: 20 }, total: 105, issues: [], mustFix: [] });
    }
    revised += 1;
    return longText(12, 800);
  });
  const result = await docEngine.draftSection(project.id, 1, { review: true });
  assert.equal(result.review.total, 105);
  assert.equal(revised, 1, '只有起草那一次调用，不应再修订');
  assert.equal(docEngine.getProject(project.id).sections[0].source, 'ai-draft');

  // 评审返回垃圾：评分为空，但不影响正文落稿
  const other = docEngine.createProject({ title: '评审垃圾返回', docType: 'paper', mode: 'co' });
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('段落计划')) return planJson(800);
    if (sys.includes('期刊审稿人')) return '这段写得不错。';
    return longText(13, 800);
  });
  const second = await docEngine.draftSection(other.id, 1, { review: true });
  assert.equal(second.review, null);
  assert.equal(docEngine.getProject(other.id).sections[0].status, 'done');
});

test('引用：编号解析、参考文献页、假引用审计', () => {
  const project = docEngine.createProject({ title: '引用测试', docType: 'paper' });
  docEngine.addMaterial({ projectId: project.id, title: '张三(2023) 制造业数字化转型研究', content: '张三（2023）发现回收期中位数为 2.1 年，组织能力是调节变量。' });
  docEngine.addMaterial({ projectId: project.id, title: '工信部 2024 年行业统计', content: '中小制造企业数字化服务市场规模约 1280 亿元，同比增长 23.4%。' });
  docEngine.saveSectionContent(project.id, 1, '回收期中位数为 2.1 年[M1]，市场规模 1280 亿元[M2]，另见一处编造的引用[M9]。');

  const parsed = docEngine.parseCitations('a[M1] b[M2] c[M1]');
  assert.deepEqual([...parsed].sort(), ['M1', 'M2']);

  const bib = docEngine.bibliography(project.id);
  assert.deepEqual(bib.entries.map((item) => item.key), ['M1', 'M2']);
  assert.deepEqual(bib.ghosts, ['M9'], '引用了不存在的编号必须报出来');
  assert.equal(bib.uncited.length, 0);

  const markdown = docEngine.assembleMarkdown(project.id).markdown;
  assert.match(markdown, /## 参考文献/);
  // 正文工单号 [M1]/[M2] 导出时重编号为论文序号 [1]/[2]；ghost [M9] 保持原样可见（体检可对号）。
  assert.match(markdown, /\[1\] /);
  assert.match(markdown, /\[2\] /);
  assert.match(markdown, /\[M9\]/, '假引用不被重编号洗白');

  const audit = docEngine.auditProject(project.id);
  assert.ok(audit.issues.some((issue) => issue.code === 'ghost-citation'), '假引用要进体检报告');
  assert.equal(audit.summary.citations, 2);
  assert.equal(audit.summary.ghosts, 1);
});

test('引用：Word 导出自动带参考文献页', () => {
  const project = docEngine.createProject({ title: '参考文献论文', docType: 'paper' });
  docEngine.addMaterial({ projectId: project.id, title: '李四(2022) 标杆工厂案例研究', content: '李四（2022）分析 6 家标杆工厂，提出「先流程后系统」的三阶段路径。' });
  docEngine.saveSectionContent(project.id, 1, '已有研究提出先流程后系统[M1]。');
  const { parseZip } = require('../lib/zip');
  const entries = parseZip(docEngine.assembleDocx(project.id).buffer);
  const docXml = String(entries.find((entry) => entry.name === 'word/document.xml').data);
  assert.match(docXml, /参考文献/);
  assert.match(docXml, /李四\(2022\) 标杆工厂案例研究/);
});

test('全文润色：后台跑完、只收长度合规的节、并发保护', async () => {
  const project = docEngine.createProject({
    title: '润色测试', docType: 'report',
    sections: [{ title: '第一节' }, { title: '第二节' }],
  });
  docEngine.saveSectionContent(project.id, 1, longText(1, 300));
  docEngine.saveSectionContent(project.id, 2, longText(2, 300));
  let polished = 0;
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('资深编辑')) { polished += 1; return longText(9, 320); }
    return 'x';
  });

  const started = docEngine.startPolish(project.id);
  assert.equal(started.total, 2);
  // 在途时再点一次要被挡住
  assert.throws(() => docEngine.startPolish(project.id), /已在润色中/);

  for (let i = 0; i < 200 && docEngine.polishStatus(project.id).running; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const state = docEngine.polishStatus(project.id);
  assert.equal(state.running, false);
  assert.equal(state.done, 2);
  assert.equal(state.changed.length, 2);
  assert.equal(polished, 2);
  assert.equal(docEngine.getProject(project.id).sections[0].source, 'ai-polish');

  // 空项目点润色要给出人话，而不是跑一遍什么都不做
  const blank = docEngine.createProject({ title: '空项目润色', docType: 'report' });
  assert.throws(() => docEngine.startPolish(blank.id), /还没有可润色的正文/);
});

test('润色：长度不合规的返回不覆盖原文', async () => {
  const project = docEngine.createProject({ title: '润色不合规', docType: 'report', sections: [{ title: '一' }] });
  const original = longText(1, 400);
  docEngine.saveSectionContent(project.id, 1, original);
  stubModel(() => '太短了。');
  docEngine.startPolish(project.id);
  for (let i = 0; i < 200 && docEngine.polishStatus(project.id).running; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(docEngine.getProject(project.id).sections[0].content, original, '短到不像同一节就别覆盖');
  assert.deepEqual(docEngine.polishStatus(project.id).changed, []);
});

test('视角提问与研究纪要：问题落库、答案存成素材', async () => {
  const project = docEngine.createProject({ title: '提问测试', docType: 'paper', mode: 'co' });
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('选题策划')) {
      return JSON.stringify({
        perspectives: [
          { name: '成本与收益', questions: [{ q: '样本企业的改造投入中位数是多少？', need: '同行投入的公开数据' }] },
          { name: '政策与合规', questions: [{ q: '当地补贴的申领门槛是什么？', need: '地方政策原文' }] },
        ],
      });
    }
    if (sys.includes('资深专家')) return longText(14, 300);
    return 'x';
  });

  const questions = await docEngine.suggestSectionQuestions(project.id, 2);
  assert.equal(questions.perspectives.length, 2);
  assert.equal(questions.perspectives[0].questions[0].need, '同行投入的公开数据');
  assert.ok(docEngine.getProject(project.id).questions['2'], '问题要按小节落库');

  const research = await docEngine.researchSection(project.id, 2);
  assert.ok(research.materialId);
  const materials = docEngine.listMaterials(project.id);
  assert.equal(materials.length, 1);
  assert.match(materials[0].title, /第2节研究纪要/);

  // 没提问就要研究：给出可执行的提示
  const other = docEngine.createProject({ title: '未提问就研究', docType: 'paper' });
  await assert.rejects(() => docEngine.researchSection(other.id, 1), /先点「AI 提问」/);
});

test('页面：质量工具条、评审/计划/问题卡、生成表单的评审开关', async () => {
  const project = docEngine.createProject({ title: '页面质量卡', docType: 'paper', mode: 'co' });
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('段落计划')) return planJson(800);
    if (sys.includes('期刊审稿人')) {
      return JSON.stringify({ scores: { argument: 18, evidence: 17, structure: 17, terminology: 18, substance: 16, citation: 20 }, total: 106, issues: ['第三段略空'], mustFix: [] });
    }
    if (sys.includes('选题策划')) {
      return JSON.stringify({ perspectives: [{ name: '技术与方法', questions: [{ q: '样本如何抽样？', need: '抽样方法说明' }] }] });
    }
    return longText(15, 800);
  });
  await docEngine.draftSection(project.id, 1, { review: true });
  await docEngine.suggestSectionQuestions(project.id, 1);
  // 评审开关在「整篇生成」表单里，只有全托管模式才渲染
  docEngine.setProjectMode(project.id, 'auto');

  const page = await get(`/docs?id=${project.id}&s=1`);
  assert.match(page.text, /🧐 评审本节/);
  assert.match(page.text, /🛠 按评审意见改一次/);
  assert.match(page.text, /🔎 AI 提问/);
  assert.match(page.text, /📋 重出段落计划/);
  assert.match(page.text, /✨ 全文润色/);
  assert.match(page.text, /🧐 本节评审/);
  assert.match(page.text, /106/, '评审分数要显示在页面上');
  assert.match(page.text, /📋 段落计划/);
  assert.match(page.text, /🔎 AI 想先确认的问题/);
  assert.match(page.text, /样本如何抽样？/);
  assert.match(page.text, /name="review" value="1" checked/, '全托管的评审开关默认勾选');
});

test('页面：评审与提问按钮能把结果落库（POST 路由）', async () => {
  const project = docEngine.createProject({ title: '页面评审路由', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1, longText(16, 800));
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('期刊审稿人')) {
      return JSON.stringify({ scores: { argument: 17, evidence: 15, structure: 16, terminology: 17, substance: 15, citation: 20 }, total: 100, issues: [], mustFix: [] });
    }
    return 'x';
  });
  const reviewed = await post('/docs/review', { csrf: TOKEN, projectId: project.id, s: '1' });
  assert.equal(reviewed.status, 303);
  assert.equal(docEngine.getProject(project.id).sections[0].review.total, 100);

  const polished = await post('/docs/polish', { csrf: TOKEN, projectId: project.id, s: '1' });
  assert.equal(polished.status, 303);
  assert.match(polished.location, new RegExp(`/docs\\?id=${project.id}`));
});

// ---------- 深度档位 / 子问题 / 图表（图文并茂） ----------

const figure = require('../lib/doc-figure');
const craft = require('../lib/doc-craft');

const FIGURE_SPEC = {
  type: 'bar', title: '2019—2023年市场规模', unit: '亿元', note: 'M1 行业年报',
  categories: ['2019', '2020', '2021', '2022', '2023'],
  series: [{ name: '市场规模', values: [1280, 1420, 1690, 2050, 2480] }],
};

function planWithFigure(chars = 1200) {
  return JSON.stringify({
    targetChars: chars,
    questions: ['2023 年市场规模是多少？', '增速能否持续到 2026 年？'],
    paragraphs: [
      { goal: '提出本节的核心判断', chars: Math.round(chars / 2), materials: ['M1'] },
      { goal: '给出依据并收束', chars: Math.round(chars / 2), materials: [] },
    ],
    figures: [FIGURE_SPEC],
  });
}

test('深度档位：篇幅下限按基数缩放，来回切不漂移', async () => {
  const project = docEngine.createProject({ title: '深度档位', docType: 'paper', depth: 'deep' });
  const base = docEngine.DOC_TYPES.paper.sections[0].minChars;
  assert.equal(project.depth, 'deep');
  assert.equal(project.depthName, '深入');
  assert.equal(project.sections[0].minChars, Math.round(base * 1.4));

  // 先造一份段落计划，切档位时它必须作废（段数、子问题数、图表数都随档位变）
  stubModel(() => planJson(600));
  await docEngine.ensurePlan(docEngine.getProject(project.id), 1);
  assert.ok(docEngine.getProject(project.id).sections[0].plan, '计划应先落库');

  docEngine.setProjectDepth(project.id, 'brief');
  let fresh = docEngine.getProject(project.id);
  assert.equal(fresh.depth, 'brief');
  assert.equal(fresh.sections[0].minChars, Math.round(base * 0.75));
  assert.equal(fresh.sections[0].plan, null, '切档位要作废旧段落计划');

  // 再切回来必须回到原值：乘数乘在基数上，不是乘在上一次的结果上
  docEngine.setProjectDepth(project.id, 'deep');
  fresh = docEngine.getProject(project.id);
  assert.equal(fresh.sections[0].minChars, Math.round(base * 1.4));

  // 未知档位回落到标准，不抛错（老项目/拼错参数不该把页面打挂）
  docEngine.setProjectDepth(project.id, 'ludicrous');
  fresh = docEngine.getProject(project.id);
  assert.equal(fresh.depth, 'standard');
  assert.equal(fresh.sections[0].minChars, base);
});

test('深度档位：进入计划与起草提示词，段数与子问题个数随档位变', async () => {
  const seen = [];
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    seen.push(`${sys}\n\n${String(options.messages?.[1]?.content || '')}`);
    if (sys.includes('段落计划')) return planWithFigure(1400);
    return longText(31, 1400);
  });
  const deep = docEngine.createProject({ title: '深入档', docType: 'paper', mode: 'co', depth: 'deep' });
  await docEngine.draftSection(deep.id, 1);
  // 用策划角色的提示词做锚点：起草提示词里也含「段落计划」四个字（计划块标题），
  // 拿它当 needle 会取到起草提示词，断言就全串了。
  const planPrompt = findPrompt(seen, '资深的中文文书写作策划');
  assert.ok(planPrompt.includes('【写作深度】深入'), '计划提示词必须带深度说明');
  assert.ok(planPrompt.includes('5~8 段'), '深入档要更多段落');
  assert.ok(planPrompt.includes('3~4 个本节必须正面回答的问题'), '深入档要更多子问题');
  assert.ok(planPrompt.includes('绝对不允许为了「图文并茂」编造数据'), '图表数值必须限定来源');
  const draftPrompt = findPrompt(seen, '【本节任务】');
  assert.ok(draftPrompt.includes('【写作深度】深入'), '起草提示词也要带深度');
  assert.ok(draftPrompt.includes('2023 年市场规模是多少？'), '子问题要进起草提示词');
  assert.ok(draftPrompt.includes('【图1：2019—2023年市场规模】'), '图表占位符要进起草提示词');

  seen.length = 0;
  const brief = docEngine.createProject({ title: '简洁档', docType: 'paper', mode: 'co', depth: 'brief' });
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    seen.push(`${sys}\n\n${String(options.messages?.[1]?.content || '')}`);
    if (sys.includes('段落计划')) return planJson(400);
    return longText(32, 400);
  });
  await docEngine.draftSection(brief.id, 1);
  const briefPrompt = findPrompt(seen, '资深的中文文书写作策划');
  assert.ok(briefPrompt.includes('【写作深度】简洁'));
  assert.ok(briefPrompt.includes('2~4 段'));
  assert.ok(!briefPrompt.includes('【写作深度】深入'), '档位不能串');
});

test('图表 spec：非法类型兜底、数值全空丢弃、超量截断', () => {
  const list = craft.figuresOf([
    { type: 'radar', title: '非法类型', categories: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] },
    { type: 'bar', title: '全是空值', categories: ['a'], series: [{ name: 's', values: [null] }] },
    { type: 'pie', title: '构成', categories: ['a', 'b'], series: [{ name: 's', values: ['52%', '48%'] }, { name: 't', values: [1, 2] }] },
    { type: 'bar', title: '超量', categories: Array.from({ length: 20 }, (_, i) => `c${i}`), series: [{ name: 's', values: Array.from({ length: 20 }, (_, i) => i) }] },
  ], 2);
  assert.equal(list.length, 2, '上限 2 张');
  assert.equal(list[0].type, 'bar', '未知类型兜底成柱状');
  assert.equal(list[0].no, 1);
  assert.equal(list[1].type, 'pie');
  assert.equal(list[1].series.length, 1, '饼图只取第一个系列');
  assert.deepEqual(list[1].series[0].values, [52, 48], '百分号要能解析成数值');
  assert.equal(craft.figuresOf([], 2).length, 0);
  assert.equal(craft.figuresOf([FIGURE_SPEC], 0).length, 0, '档位为 0 张时不出图');
});

test('图表：SVG / Word / Markdown 三路渲染 + 全文连号', () => {
  const svg = figure.figureSvg(FIGURE_SPEC);
  assert.match(svg, /^<svg viewBox="0 0 640 360"/);
  assert.match(svg, /<rect /);
  assert.match(svg, /2480/);
  assert.match(svg, /2019—2023年市场规模/, '默认在 SVG 里画标题');
  const bare = figure.figureSvg(FIGURE_SPEC, { showTitle: false });
  assert.ok(!bare.includes('>2019—2023年市场规模<'), '页面有 HTML 题注时不再重复画标题');

  const md = figure.figureMarkdown({ ...FIGURE_SPEC, no: 2 });
  assert.match(md, /\*\*图2　2019—2023年市场规模\*\*（单位：亿元）/);
  assert.match(md, /\| 2023 \| 2480 \|/);
  assert.match(md, /> 资料来源：M1 行业年报/);

  const chart = figure.chartPartXml({ ...FIGURE_SPEC, no: 1 });
  assert.match(chart, /<c:barChart>/);
  assert.match(chart, /<c:strCache>/);
  assert.match(chart, /<c:numCache>/);
  assert.ok(!chart.includes('externalData'), '不引外部数据表：Word 用缓存渲染');

  // 全文连号：第 2 节的第一张图必须叫「图 3」，且正文占位符跟着改
  const laid = figure.globalizeFigures([
    { content: 'A\n【图1：甲】\nB\n【图2：乙】', figures: [{ no: 1, title: '甲' }, { no: 2, title: '乙' }] },
    { content: 'C\n【图1：丙】', figures: [{ no: 1, title: '丙' }] },
  ]);
  assert.deepEqual(laid.map((item) => item.figures.map((spec) => spec.no)), [[1, 2], [3]]);
  assert.ok(laid[1].content.includes('【图3：丙】'), '第二节的图1要改成图3');
  assert.ok(laid[0].content.includes('【图1：甲】'), '第一节不受影响');
});

test('图表：对不上数据的占位符原样保留，不静默吞行', () => {
  const blocks = figure.splitFigureBlocks('前文\n\n【图3：没有数据的图】\n\n后文', []);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.ok(blocks[0].text.includes('【图3：没有数据的图】'), '孤儿占位符要让人看见');
});

test('导出：Word 带原生图表部件，Markdown 降级为表格 + 题注', () => {
  const project = docEngine.createProject({ title: '导出图表', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1,
    `市场规模逐年扩大。\n\n【图1：2019—2023年市场规模】\n\n从数据看增速稳定。`, 'manual');
  db.run(`UPDATE doc_sections SET figures_json=? WHERE project_id=? AND idx=1`,
    JSON.stringify([{ ...FIGURE_SPEC, no: 1 }]), project.id);

  const md = docEngine.assembleMarkdown(project.id).markdown;
  assert.match(md, /\*\*图1　2019—2023年市场规模\*\*/);
  assert.match(md, /\| 2023 \| 2480 \|/);
  assert.match(md, /资料来源：M1 行业年报/);
  assert.ok(!md.includes('【图1：2019—2023年市场规模】'), 'Markdown 里占位符要换成真图表');

  const docx = docEngine.assembleDocx(project.id);
  assert.ok(docx.buffer.includes('word/charts/chart1.xml'), 'docx 包里必须有图表部件');
  assert.ok(docx.buffer.includes('[Content_Types].xml'));
});

test('体检：孤儿图表、全文无图、必答问题被绕开都要报出来', async () => {
  const orphan = docEngine.createProject({ title: '体检孤儿图', docType: 'paper' });
  docEngine.saveSectionContent(orphan.id, 1, '正文一段。\n\n【图3：没有数据的图】\n\n继续一段。', 'manual');
  let audit = docEngine.auditProject(orphan.id);
  const figureIssue = audit.issues.find((item) => item.code === 'figure');
  assert.ok(figureIssue, '孤儿占位符必须报警');
  assert.match(figureIssue.text, /第1节的【图3】没有数据/);

  const bare = docEngine.createProject({ title: '体检无图', docType: 'paper' });
  docEngine.saveSectionContent(bare.id, 1, longText(41, 300), 'manual');
  audit = docEngine.auditProject(bare.id);
  assert.ok(audit.issues.some((item) => item.code === 'no-figure'), '论文没图要提示');
  assert.equal(audit.summary.figures, 0);

  // 必答问题被绕开：评审给出 unanswered，体检汇总成人话
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('期刊审稿人')) {
      return JSON.stringify({
        scores: { argument: 12, evidence: 9, structure: 14, terminology: 16, substance: 12, citation: 20 },
        issues: ['没有给出任何数字'], mustFix: ['补上 2023 年市场规模'],
        unanswered: ['第 1 问只写了「有待观察」，没有给出数字'],
      });
    }
    return planWithFigure(600);
  });
  const asked = docEngine.createProject({ title: '体检未回答', docType: 'paper' });
  docEngine.saveSectionContent(asked.id, 1, longText(42, 300), 'manual');
  await docEngine.ensurePlan(docEngine.getProject(asked.id), 1);
  await docEngine.reviewSectionNow(asked.id, 1);
  audit = docEngine.auditProject(asked.id);
  const unanswered = audit.issues.find((item) => item.code === 'unanswered');
  assert.ok(unanswered, '未回答的必答问题必须汇总');
  assert.match(unanswered.text, /第1节：第 1 问只写了/);
  assert.equal(audit.summary.unanswered, 1);
});

test('页面：正文渲染内联 SVG 图表、题注与资料来源、深度胶囊与切换路由', async () => {
  const project = docEngine.createProject({ title: '页面图表', docType: 'paper', mode: 'co', depth: 'deep' });
  docEngine.saveSectionContent(project.id, 1,
    `市场规模逐年扩大。\n\n【图1：2019—2023年市场规模】\n\n从数据看增速稳定。`, 'manual');
  db.run(`UPDATE doc_sections SET figures_json=? WHERE project_id=? AND idx=1`,
    JSON.stringify([{ ...FIGURE_SPEC, no: 1 }]), project.id);

  const page = await get(`/docs?id=${project.id}&s=1`);
  assert.match(page.text, /<svg viewBox="0 0 640 360"/, '图表要在页面上渲染成 SVG');
  assert.match(page.text, /<figure class="fig">/);
  assert.match(page.text, /图 1　2019—2023年市场规模/);
  assert.match(page.text, /资料来源：M1 行业年报/);
  assert.ok(!page.text.includes('【图1：2019—2023年市场规模】'), '占位符不能漏到页面上');
  assert.match(page.text, /深度深入/, '标题栏要显示当前深度');
  assert.match(page.text, /action="\/docs\/depth"/);
  assert.match(page.text, /name="depth" value="brief"/);

  const switched = await post('/docs/depth', { csrf: TOKEN, projectId: project.id, s: '1', depth: 'brief' });
  assert.equal(switched.status, 303);
  assert.equal(docEngine.getProject(project.id).depth, 'brief');
  const after = await get(`/docs?id=${project.id}&s=1`);
  assert.match(after.text, /深度简洁/);

  // 新建表单里的深度选择要真的带进建项目
  const created = await post('/docs/create', {
    csrf: TOKEN, title: '表单带深度', docType: 'paper', mode: 'co', brief: '一句话说明。', depth: 'deep',
  });
  assert.equal(created.status, 303);
  const newId = /id=([^&]+)/.exec(created.location)[1];
  assert.equal(docEngine.getProject(newId).depth, 'deep');
});

// ---------- 公式（LaTeX → MathML / Word 原生公式） ----------

const mathTex = require('../lib/math-tex');
const docMath = require('../lib/doc-math');

test('公式解析：上下标、分式、根式、求和上下限、矩阵与 cases', () => {
  assert.match(mathTex.toMathML('E=mc^2'), /<msup><mi>c<\/mi>/);
  assert.match(mathTex.toMathML('R^2'), /<msup><mi>R<\/mi><mrow><mrow><mn>2<\/mn>/);
  assert.match(mathTex.toMathML('\\frac{a+b}{c}'), /<mfrac>/);
  assert.match(mathTex.toMathML('\\sqrt[3]{x}'), /<mroot>/);
  assert.match(mathTex.toMathML('\\sqrt{x}'), /<msqrt>/);
  // 求和的上下限要落在符号正上下方，不是普通上下标
  assert.match(mathTex.toMathML('\\sum_{i=1}^{n} x_i'), /<munderover><mo largeop="true"/);
  assert.match(mathTex.toMathML('\\lim_{x \\to 0} f(x)'), /<munder><mi mathvariant="normal">lim<\/mi>/);
  const matrix = mathTex.toMathML('\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}');
  assert.match(matrix, /<mtable><mtr><mtd>/);
  assert.equal((matrix.match(/<mtr>/g) || []).length, 2, '两行');
  assert.equal((matrix.match(/<mtd>/g) || []).length, 4, '两列两行');
  assert.match(matrix, /<mo fence="true" stretchy="true">\(<\/mo>/, 'pmatrix 要有圆括号');
  const cases = mathTex.toOmml('\\begin{cases}1 & x>0 \\\\ 0 & x\\le 0\\end{cases}');
  assert.match(cases, /<m:m>/);
  assert.equal((cases.match(/<m:mr>/g) || []).length, 2, 'cases 两行');
});

test('公式解析：希腊字母是变量不是运算符，未知命令不炸整条公式', () => {
  // ΔV 若按 <mo> 渲染会多出运算符间距，看起来像「Δ V」
  const delta = mathTex.toMathML('\\Delta V');
  assert.match(delta, /<mi>Δ<\/mi><mi>V<\/mi>/);
  assert.ok(!/<mo>Δ<\/mo>/.test(delta));
  const unknown = mathTex.toMathML('\\foo{x} + y');
  assert.ok(unknown.includes('foo'), '未知命令按文字呈现，让人看见哪里没渲染对');
  assert.ok(unknown.includes('<mi>y</mi>'), '未知命令不能吞掉后面的内容');
  // 定界符不配对也不能抛异常
  assert.ok(mathTex.toMathML('\\frac{a}{').length > 0);
  assert.equal(mathTex.toMathML(''), '');
});

test('公式：先保护再渲染，markdown 不会吃掉公式里的 _ 和 *', () => {
  const src = '其中 $x_{i,j}$ 与 $a*b$ 是变量。\n\n$$\\sum_{i=1}^{n} x_i$$';
  const guarded = docMath.protectMath(src, 1);
  assert.equal(guarded.items.length, 3);
  // 块级公式先被摘出来（编号也只编它们），行内公式在后
  assert.equal(guarded.items[0].display, true);
  assert.equal(guarded.items[0].no, 1);
  assert.equal(guarded.items[2].display, false);
  assert.equal(guarded.nextNo, 2);
  assert.ok(!guarded.text.includes('$'), '公式已经被换成占位符');
  const html = docMath.restoreMathHtml(`<p>${guarded.text}</p>`, guarded.items);
  assert.ok(html.includes('<math xmlns="http://www.w3.org/1998/Math/MathML"'), '要渲染成 MathML');
  assert.match(html, /<div class="eq" id="eq-1">/, '块级公式要带编号锚点');
  assert.match(html, /（式 1）/);
  assert.ok(!html.includes('@@MATH'), '占位符不能漏到页面上');
  assert.ok(!html.includes('<p><div'), '块级公式不能套在 <p> 里');
});

test('公式：编号全文连号、\\tag 覆盖编号、货币符号不误判', () => {
  const first = docMath.protectMath('$$a=b$$', 1);
  assert.equal(first.nextNo, 2);
  const second = docMath.protectMath('$$c=d$$\n\n$$e=f$$', first.nextNo);
  assert.deepEqual(second.items.map((item) => item.no), [2, 3], '跨小节继续编号');

  const tagged = docMath.protectMath('$$x=y \\tag{3.2}$$', 1);
  assert.equal(tagged.items[0].tag, '3.2');
  assert.match(docMath.restoreMathHtml('<p>@@MATH0@@</p>', tagged.items), /（3\.2）/);

  // 「US$100」「价格 $ 100」不是公式
  const money = docMath.protectMath('价格为 US$100，预算 $ 200。', 1);
  assert.equal(money.items.length, 0);
  assert.ok(money.text.includes('US$100'));

  // 字面美元符号 \$ 要还原成 $，不能吃掉后面的文字
  const escaped = docMath.protectMath('成本 \\$5 与 $x$ 不同', 1);
  assert.equal(escaped.items.length, 1);
  assert.ok(escaped.text.includes('$5'));
});

test('公式：定界符没配对要能查出来', () => {
  assert.equal(docMath.inspectMath('$x$ 与 $y$ 都对').unbalanced, false);
  assert.equal(docMath.inspectMath('这里 $x + y 忘了收尾').unbalanced, true);
  assert.equal(docMath.inspectMath('$$x+1 忘了收尾').unbalanced, true);
  assert.equal(docMath.inspectMath('价格为 US$100').unbalanced, false, '货币符号不算未配对');
  const info = docMath.inspectMath('$$a=b$$\n\n其中 $c$ 与 $d$ 是两个变量。');
  assert.equal(info.display, 1);
  assert.equal(info.inline, 2);
  assert.equal(info.total, 3);
});

test('公式：论文里常见命令都要渲染成真公式，不能退化成正体字母', () => {
  // 这一批以前会原样吐成 "Xtop"、"mathcalL"、"oversetdef="、"substacki=1j=2"，
  // 在 Word 里就是用户说的「数学符号乱码」。
  const corpus = [
    'X^{\\top}', 'A^{\\bot}', 'f(x)\\mid_{x=0}', '\\vert y\\vert', '\\Vert z\\Vert',
    '\\overset{def}{=}', '\\underset{x\\to0}{\\lim}', '\\xrightarrow{n\\to\\infty}',
    '\\mathcal{L}', '\\overline{AB}', '\\substack{i=1\\\\j=2}', 'a \\over b',
    '\\left. \\frac{dy}{dx} \\right|_{x=0}', '\\left( \\frac{a}{b} \\middle| c \\right)',
    '\\big( x \\big)', '\\hspace{1em} x', '\\vspace{2mm}', '\\color{red}{x}',
    '\\boxed{E=mc^2}', '\\stackrel{?}{=}', '\\underbrace{a+b}_{n}', '\\overbrace{a+b}^{n}',
    '\\widehat{xyz}', '\\widetilde{xyz}', '\\overrightarrow{AB}', '\\not= \\not\\in',
    '\\mathfrak{g}', '\\mathsf{T}', '\\mathtt{x}', '\\lesssim\\gtrsim\\lessgtr',
    '\\hat{\\beta}=(X^{\\top}X)^{-1}X^{\\top}y',
    '\\sum_{\\substack{i=1\\\\j=1}}^{n} a_{ij}',
    '\\operatorname*{arg\\,min}_{\\theta}',
    '\\begin{array}{cc} a&b\\\\c&d \\end{array}',
    '\\begin{equation} E=mc^2 \\end{equation}',
  ];
  const bad = [];
  for (const tex of corpus) {
    const missing = mathTex.unknownCommands(tex);
    if (missing.length) bad.push(`${tex} → ${missing.join(',')}`);
  }
  assert.deepEqual(bad, [], '不能有命令退化成文字');

  // 转置：⊤ 必须出现在上标里，而不是 "top" 两个字母
  const transpose = mathTex.toOmml('X^{\\top}');
  assert.match(transpose, /<m:sSup>[\s\S]*⊤/);
  assert.ok(!/top/.test(transpose));

  // \overset / \underset 用 limUpp / limLow，不是把命令名当文字
  assert.match(mathTex.toOmml('\\overset{def}{=}'), /<m:limUpp><m:e>/);
  assert.match(mathTex.toOmml('\\underset{x}{\\lim}'), /<m:limLow><m:e>/);

  // \mathcal 走 m:scr（花体），不是 m:sty
  assert.match(mathTex.toOmml('\\mathcal{L}'), /<m:scr m:val="script"\/>/);

  // \substack 是一列堆叠，不是一行
  const substack = mathTex.toOmml('\\substack{i=1\\\\j=2}');
  assert.equal((substack.match(/<m:mr>/g) || []).length, 2);

  // \over 变成真分式
  assert.match(mathTex.toOmml('a \\over b'), /<m:f><m:num>[\s\S]*<m:den>/);

  // \tag 只影响编号，不该出现在公式体里
  assert.ok(!/tag/.test(mathTex.toOmml('a=b \\tag{2.1}')));

  // \begin{equation} 不该渲染成一张单格表格
  assert.ok(!/<m:m>/.test(mathTex.toOmml('\\begin{equation} E=mc^2 \\end{equation}')));

  // \not= 是 ≠ 而不是 = 加一个斜线字符
  assert.match(mathTex.toOmml('\\not='), /≠/);

  // \hspace 变成间距，不是字面量 "1em"
  assert.match(mathTex.toOmml('\\hspace{1em}x'), /<m:t xml:space="preserve"> <\/m:t>/);
});

// ---------- 深度：可执行的深度要求，不是一句形容词 ----------

test('深度：档位决定要求几条，deep 五条全要', () => {
  const craft = require('../lib/doc-craft');
  assert.equal(craft.DEPTH_GUIDE.length, 5);
  const brief = craft.depthGuide('brief');
  assert.match(brief, /【机制】/);
  assert.match(brief, /【依据】/);
  assert.ok(!brief.includes('【边界】'), '简洁档不要求边界条件');

  const standard = craft.depthGuide('standard');
  assert.match(standard, /【对比】/);
  assert.ok(!standard.includes('【边界】'));

  const deep = craft.depthGuide('deep');
  for (const name of ['机制', '依据', '对比', '边界', '推进']) {
    assert.ok(deep.includes(`【${name}】`), `深入档要要求${name}`);
  }
  // 未知档位按标准处理，不抛错
  assert.equal(craft.depthGuide('ludicrous'), standard);
});

test('深度：起草提示词对每一档都注入深度要求与浅层写法禁令', async () => {
  const seen = [];
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    const user = String(options.messages?.[1]?.content || '');
    seen.push({ sys, user });
    if (sys.includes('段落计划')) return planJson(600);
    return longText(51, 600);
  });
  // 标准档（默认档）以前什么深度约束都没有，只剩「写不少于 N 字」
  const project = docEngine.createProject({ title: '深度提示', docType: 'paper', mode: 'co', depth: 'standard' });
  await docEngine.draftSection(project.id, 1);
  const draft = seen.find((item) => String(item.user).includes('【本节任务】'));
  assert.ok(draft, '应当发出起草请求');
  assert.match(draft.user, /【论证深度要求/, '标准档也要有深度要求');
  assert.match(draft.user, /【禁止的浅层写法】/, '要明确禁止同义反复、名词罗列、结论复述');
  assert.match(draft.user, /【机制】/, '标准档至少要求机制');
});

// ---------- 技能：新库也要有完整的文档技能 ----------

test('技能：内置文档技能在启动时自动补齐，且覆盖公式/图表/统计', () => {
  const rows = db.q("SELECT builtin_key, name FROM skills WHERE domain='doc'");
  assert.ok(rows.length >= 33, `doc 域技能应不少于 33 个，实际 ${rows.length}`);
  const keys = new Set(rows.map((row) => row.builtin_key));
  for (const key of ['doc.paper.math', 'doc.paper.chart', 'doc.paper.stats']) {
    assert.ok(keys.has(key), `缺少技能 ${key}`);
  }
  // 幂等：再补齐一次不会写重复行（否则每次启动技能广场都会翻倍）
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(db.DB_PATH);
  try {
    const { seedDocSkills } = require('../scripts/seed-doc-skills.cjs');
    const again = seedDocSkills(raw);
    assert.equal(again.added, 0, '第二次补齐不该新增');
    assert.equal(again.total, rows.length);
  } finally {
    raw.close();
  }
});

test('公式：m:sty 只能出现一次，重复会让 Word 判文档损坏', () => {
  // 加粗且正体时以前会同时写 <m:sty val="p"/> 和 val="b"
  const bold = mathTex.toOmml('\\textbf{定义}');
  assert.equal((bold.match(/<m:sty /g) || []).length, 1);
});

test('公式：起草提示词带写法约定，合同类不带', async () => {
  const seen = [];
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    seen.push(sys);
    if (sys.includes('段落计划')) return planJson(600);
    return longText(51, 600);
  });
  const paper = docEngine.createProject({ title: '公式提示词', docType: 'paper', mode: 'co' });
  await docEngine.draftSection(paper.id, 1);
  const sys = findPrompt(seen, '公式写法');
  assert.ok(sys.includes('行内写 $...$'), '要说明行内公式写法');
  assert.ok(sys.includes('不要用 \\begin{equation}'), '要禁止 equation 环境');
  assert.ok(sys.includes('编号由系统按出现顺序自动生成'), '要说明编号由系统生成');

  seen.length = 0;
  const contract = docEngine.createProject({ title: '合同不带公式约定', docType: 'contract', mode: 'co' });
  await docEngine.draftSection(contract.id, 1);
  assert.ok(!seen.join('\n').includes('【公式写法】'), '合同不需要公式约定');
});

test('公式：页面渲染 MathML、跨节连号、体检统计', async () => {
  const project = docEngine.createProject({ title: '页面公式', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1,
    '回收期按下式计算：\n\n$$T = \\frac{C}{\\Delta V}$$\n\n其中 $C$ 为累计投入，$\\Delta V$ 为年产值增量。', 'manual');
  docEngine.saveSectionContent(project.id, 2,
    '回归模型为：\n\n$$Y = \\beta_0 + \\beta_1 X + \\varepsilon$$', 'manual');

  const first = await get(`/docs?id=${project.id}&s=1`);
  assert.ok(first.text.includes('<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">'), '块级公式要渲染成 display MathML');
  assert.match(first.text, /<mfrac>/);
  assert.match(first.text, /（式 1）/);
  assert.ok(!first.text.includes('$$T ='), '页面上不能残留 LaTeX 源码');

  // 第二节的公式接着编号：应该是「式 2」而不是重新从 1 开始
  const second = await get(`/docs?id=${project.id}&s=2`);
  assert.match(second.text, /（式 2）/);
  assert.ok(!second.text.includes('（式 1）'), '同一页里不该出现重复编号');

  const audit = docEngine.auditProject(project.id);
  assert.equal(audit.summary.equations, 2);
  assert.equal(audit.summary.math, 4, '2 个块级 + 2 个行内');
  assert.ok(!audit.issues.some((issue) => issue.code === 'math-delimiter'));

  docEngine.saveSectionContent(project.id, 3, '这一节公式没写完：$x + y 就断了。', 'manual');
  const bad = docEngine.auditProject(project.id);
  const issue = bad.issues.find((item) => item.code === 'math-delimiter');
  assert.ok(issue, '定界符没配对必须报警');
  assert.match(issue.text, /第3节/);
});

test('公式：Word 导出成原生公式对象，不是图片也不是一行美元符号', () => {
  const project = docEngine.createProject({ title: '公式导出', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1,
    '回收期按下式计算：\n\n$$T = \\frac{C}{\\Delta V}$$\n\n'
    + '其中 $C$ 为累计投入，$\\Delta V$ 为年产值增量，约束为 $T \\leq 30$。\n\n'
    + '$$R^2 = 1 - \\frac{SS_{res}}{SS_{tot}} \\tag{3.2}$$', 'manual');

  const docx = docEngine.assembleDocx(project.id);
  const xml = docx.buffer.toString('utf8');
  assert.ok(xml.includes('xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"'), '必须声明公式命名空间');
  // 2 个块级 + 3 个行内 = 5 个公式对象
  assert.equal((xml.match(/<m:oMath>/g) || []).length, 5);
  assert.match(xml, /<m:f>/, '分式要导出成 Word 的 m:f');
  assert.match(xml, /（式 1）/, '第一个块级公式自动编号');
  assert.match(xml, /（3\.2）/, '\\tag 指定的编号优先');
  assert.ok(!xml.includes('$$T ='), '不能把 LaTeX 源码原样塞进 Word');
  assert.ok(!xml.includes('<m:oMathPara'), '公式放在普通段落里居中，不用 oMathPara');
});

test('公式：Markdown 导出保留 LaTeX 源码（通用写法，便于二次编辑）', () => {
  const project = docEngine.createProject({ title: '公式 Markdown', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1, '如下：\n\n$$T = \\frac{C}{\\Delta V}$$\n\n其中 $C$ 为投入。', 'manual');
  const md = docEngine.assembleMarkdown(project.id).markdown;
  assert.ok(md.includes('$$T = \\frac{C}{\\Delta V}$$'));
  assert.ok(md.includes('其中 $C$ 为投入'));
});

// ---------- 成稿质量：参考文献著录 / 数字溯源 / 图表呼应 / 近似重复 / 论文要素 ----------

const docQuality = require('../lib/doc-quality');

test('参考文献：按正文首次引用顺序编号，著录成 GB/T 7714，正文不再出现 [M1]', () => {
  const project = docEngine.createProject({ title: '参考文献著录', docType: 'paper', mode: 'co' });
  docEngine.addMaterial({
    projectId: project.id, title: '制造业数字化转型研究', kind: 'literature',
    authors: '张三, 李四', year: '2023', source: '工业经济 2023(4): 12-19',
    content: '样本 12 家企业，2020—2023 年改造投入分别为 128、186、242、298 万元。',
  });
  docEngine.addMaterial({
    projectId: project.id, title: '中小企业发展报告', kind: 'data',
    authors: '中国中小企业协会', year: '2024', source: '中国中小企业协会',
    content: '规模以下工业企业数字化改造覆盖率不足三成。',
  });
  // 先引 M2 再引 M1：编号必须按正文出现顺序，不是素材录入顺序
  docEngine.saveSectionContent(project.id, 1, '覆盖率不足三成 [M2]。投入逐年上升 [M1]。', 'manual');
  docEngine.saveSectionContent(project.id, 2, '再次引用同一文献 [M1]。', 'manual');

  const bib = docEngine.bibliography(project.id);
  assert.deepEqual(bib.entries.map((item) => item.no), [1, 2]);
  assert.equal(bib.entries[0].key, 'M2', '先出现的 M2 拿 1 号');
  assert.equal(bib.map.get('M2'), 1);
  assert.equal(bib.map.get('M1'), 2);

  const md = docEngine.assembleMarkdown(project.id).markdown;
  assert.ok(md.includes('[1] 中国中小企业协会. 中小企业发展报告[R]. 中国中小企业协会.'), '按体例著录');
  assert.ok(md.includes('[2] 张三, 李四. 制造业数字化转型研究[J]. 工业经济 2023(4): 12-19.'));
  assert.ok(!md.includes('[M1]') && !md.includes('[M2]'), '正文里不能残留内部编号');
  assert.ok(md.includes('覆盖率不足三成 [1]'), '正文引用换成论文序号');

  const docx = docEngine.assembleDocx(project.id);
  const xml = docx.buffer.toString('utf8');
  assert.ok(!xml.includes('[M1]'), 'Word 里也不能出现内部编号');
  assert.ok(xml.includes('工业经济 2023(4): 12-19'));
});

test('参考文献：APA 体例与缺著录信息时的最简形式', () => {
  const entry = { no: 3, authors: '张三, 李四', year: '2023', title: '制造业数字化转型研究', source: '工业经济', kind: 'literature' };
  assert.match(docQuality.formatReference(entry, 'apa'), /^张三, 李四 \(2023\)\. 制造业数字化转型研究\. 工业经济\.$/);
  const bare = { no: 4, title: '无元数据的资料', kind: 'material' };
  assert.match(docQuality.formatReference(bare, 'gbt7714'), /^\[4\] 无元数据的资料\. 无元数据的资料\[Z\]\.$/);
});

test('数字溯源：素材里有的数字放过，编造的数字要抓出来', () => {
  const project = docEngine.createProject({ title: '数字溯源', docType: 'paper', mode: 'co' });
  docEngine.addMaterial({
    projectId: project.id, title: '调研数据', kind: 'data',
    content: '样本 12 家企业，2020—2023 年改造投入分别为 128、186、242、298 万元，人均产值提升 11.4%。',
  });
  // 128 是素材里的（单位后置的枚举写法），73% 与 500 万元是编的
  docEngine.saveSectionContent(project.id, 1,
    '改造投入 128 万元，人均产值提升 11.4%。另有 73% 的企业持观望态度，平均投入 500 万元。', 'manual');

  const audit = docEngine.auditProject(project.id);
  const issue = audit.issues.find((item) => item.code === 'unbacked-number');
  assert.ok(issue, '编造的数字必须报警');
  assert.match(issue.text, /73%/);
  assert.match(issue.text, /500万元/);
  assert.ok(!issue.text.includes('128'), '素材里有的数字不能误报');
  assert.equal(audit.summary.unbackedNumbers, 2);
});

test('数字溯源：图表里的数值算有出处，单位换算不误报', () => {
  const project = docEngine.createProject({ title: '图表数值溯源', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1, '投入为 128 万元，占比 46%。', 'manual');
  db.run(`UPDATE doc_sections SET figures_json=? WHERE project_id=? AND idx=1`,
    JSON.stringify([{ no: 1, type: 'bar', title: '投入', unit: '万元', categories: ['2020', '2021'],
      series: [{ name: '投入', values: [128, 186] }] }]), project.id);
  let audit = docEngine.auditProject(project.id);
  // 128 来自图表，46 没有出处
  const issue = audit.issues.find((item) => item.code === 'unbacked-number');
  assert.ok(issue);
  assert.match(issue.text, /46%/);
  assert.ok(!issue.text.includes('128'));

  // 素材写「3.2 万」，正文写「32000 元」：同一个数，不该报
  const other = docEngine.createProject({ title: '单位换算', docType: 'paper', mode: 'co' });
  docEngine.addMaterial({ projectId: other.id, title: '投入数据', content: '该系统实施费用约为 3.2 万元，覆盖三个车间。' });
  docEngine.saveSectionContent(other.id, 1, '系统实施费用 32000 元。', 'manual');
  audit = docEngine.auditProject(other.id);
  assert.ok(!audit.issues.some((item) => item.code === 'unbacked-number'), '单位换算后同一个数不应报警');
});

test('图表呼应：正文不提「如图 N 所示」要提示，提了就不报', () => {
  const spec = { no: 1, type: 'bar', title: '投入', unit: '万元', categories: ['2020'], series: [{ name: '投入', values: [128] }] };
  const silent = docEngine.createProject({ title: '图表未呼应', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(silent.id, 1, '投入逐年上升。\n\n【图1：投入】\n\n以上说明改造在推进。', 'manual');
  db.run(`UPDATE doc_sections SET figures_json=? WHERE project_id=? AND idx=1`, JSON.stringify([spec]), silent.id);
  let audit = docEngine.auditProject(silent.id);
  assert.ok(audit.issues.some((item) => item.code === 'figure-mention'), '只放图不提要提示');

  const spoken = docEngine.createProject({ title: '图表已呼应', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(spoken.id, 1, '投入逐年上升，如图 1 所示。\n\n【图1：投入】\n\n以上说明改造在推进。', 'manual');
  db.run(`UPDATE doc_sections SET figures_json=? WHERE project_id=? AND idx=1`, JSON.stringify([spec]), spoken.id);
  audit = docEngine.auditProject(spoken.id);
  assert.ok(!audit.issues.some((item) => item.code === 'figure-mention'), '正文提了就不该报');
});

test('近似重复：换个说法重复同一段也要抓出来', () => {
  const project = docEngine.createProject({ title: '近似重复', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1,
    '样本企业的改造投入从 2020 年的 128 万元逐年增至 2023 年的 298 万元，四年累计 854 万元，年均增速约 32%。', 'manual');
  docEngine.saveSectionContent(project.id, 2,
    '样本企业的改造投入从 2020 年的 128 万元逐年增至 2023 年的 298 万元，四年累计 854 万元，年均增速约 31%。', 'manual');
  const audit = docEngine.auditProject(project.id);
  const issue = audit.issues.find((item) => item.code === 'near-duplicate');
  assert.ok(issue, '高度相似的跨节内容必须报');
  assert.match(issue.text, /第1节与第2节/);
  assert.equal(audit.summary.nearDuplicates, 1);
});

test('论文要素：作者/单位/关键词/分类号/基金落库，导出排在题名下方', async () => {
  const project = docEngine.createProject({ title: '论文要素测试', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1, longText(61, 300), 'manual');
  const saved = docEngine.setProjectMeta(project.id, {
    authors: '张三, 李四', affiliation: '某某大学管理学院',
    keywords: '数字化改造；投入产出；中小制造企业',
    ccode: 'F272', fund: '国家自然科学基金 72000001', refStyle: 'apa',
  });
  assert.equal(saved.meta.ccode, 'F272');
  const fresh = docEngine.getProject(project.id);
  assert.equal(fresh.meta.keywords, '数字化改造；投入产出；中小制造企业');
  assert.equal(fresh.refStyle, 'apa', '参考文献体例要落库');

  const md = docEngine.assembleMarkdown(project.id).markdown;
  assert.ok(md.includes('张三, 李四'));
  assert.ok(md.includes('关键词：数字化改造；投入产出；中小制造企业'));
  assert.ok(md.includes('中图分类号：F272'));

  const docx = docEngine.assembleDocx(project.id);
  const xml = docx.buffer.toString('utf8');
  assert.ok(xml.includes('国家自然科学基金 72000001'), 'Word 首页也要有基金信息');

  const page = await get(`/docs?id=${project.id}&s=1`);
  assert.match(page.text, /📄 论文要素/);
  assert.match(page.text, /name="keywords"/);
  assert.match(page.text, /name="refStyle"/);

  const posted = await post('/docs/meta', {
    csrf: TOKEN, projectId: project.id, s: '1',
    authors: '王五', affiliation: '某研究所', keywords: '甲；乙', ccode: 'TP311', fund: '', refStyle: 'gbt7714',
  });
  assert.equal(posted.status, 303);
  assert.equal(docEngine.getProject(project.id).meta.authors, '王五');
});

test('素材编号稳定：后补素材不会让正文里的 [M1] 指向另一条文献', () => {
  const project = docEngine.createProject({ title: '素材编号稳定性', docType: 'paper', mode: 'co' });
  const first = docEngine.addMaterial({ projectId: project.id, title: '第一条文献', content: '第一条文献的正文内容，足够长到能通过素材长度校验。' });
  assert.equal(first.key, 'M1');
  docEngine.saveSectionContent(project.id, 1, '这是第一条文献的结论 [M1]。', 'manual');

  const second = docEngine.addMaterial({ projectId: project.id, title: '后补的第二条', content: '后补的一条素材，内容也足够长，用来检验编号是否稳定。' });
  assert.equal(second.key, 'M2', '后补的拿新号，不能挤掉已有编号');

  // 关键：正文里的 [M1] 仍然指向第一条文献
  const bib = docEngine.bibliography(project.id);
  assert.equal(bib.map.get('M1'), 1);
  const md = docEngine.assembleMarkdown(project.id).markdown;
  assert.ok(md.includes('[1] 第一条文献'), 'M1 必须还指向第一条文献');
  assert.ok(!md.includes('[2] 第一条文献'), '编号不能错位');

  // 删除也不该让后面的编号往前挤
  docEngine.removeMaterial({ projectId: project.id, id: second.id });
  const after = docEngine.addMaterial({ projectId: project.id, title: '第三条', content: '删掉第二条之后再加一条，编号应该继续往后排而不是复用。' });
  assert.equal(after.key, 'M3', '删掉的号不复用，避免和旧正文冲突');
});

// ---------- 数据分析：CSV → 统计 → 三线表 + 结果段 ----------

const docStats = require('../lib/doc-stats');
const docTable = require('../lib/doc-table');

const SAMPLE_CSV = [
  '企业,投入,产值,规模',
  'A,128,42.6,小', 'B,186,43.9,大', 'C,242,47.5,大', 'D,298,49.2,小',
  'E,150,44.1,小', 'F,210,46.3,大', 'G,175,45.0,小', 'H,260,48.4,大',
].join('\n');

test('统计内核：分布函数与教科书值一致', () => {
  assert.equal(docStats.mean([1, 2, 3, 4, 5]), 3);
  assert.equal(docStats.sd([1, 2, 3, 4, 5]).toFixed(4), '1.5811');
  // t 分布双侧 p 值：t=2.0, df=10 → 0.0734；t=2.228, df=10 → 0.05
  assert.equal(docStats.tPValue(2.0, 10).toFixed(4), '0.0734');
  assert.equal(docStats.tPValue(2.228, 10).toFixed(4), '0.0500');
  // F 分布：F=4.9646, df=(1,10) → 0.05
  assert.equal(docStats.fPValue(4.9646, 1, 10).toFixed(4), '0.0500');
  assert.equal(docStats.pearson([1, 2, 3], [2, 4, 6]).r, 1);
});

test('统计内核：OLS 与闭式解逐项对齐，HC1 稳健标准误可用', () => {
  const x = [3, 5, 2, 7, 4, 8, 5, 9, 6, 11];
  const y = [12, 17, 9, 21, 15, 24, 18, 27, 20, 31];
  // 简单回归的闭式解
  const mx = docStats.mean(x);
  const my = docStats.mean(y);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const b1 = sxy / sxx;
  const b0 = my - b1 * mx;
  const sse = y.reduce((total, value, i) => total + (value - (b0 + b1 * x[i])) ** 2, 0);
  const s2 = sse / (x.length - 2);
  const seB1 = Math.sqrt(s2 / sxx);

  const fit = docStats.ols(y, [x], { names: ['x'] });
  assert.ok(Math.abs(fit.terms[1].estimate - b1) < 1e-9, '斜率要与闭式解一致');
  assert.ok(Math.abs(fit.terms[0].estimate - b0) < 1e-9, '截距要与闭式解一致');
  assert.ok(Math.abs(fit.terms[1].se - seB1) < 1e-9, '标准误要与闭式解一致');
  assert.ok(fit.r2 > 0.99);

  const robust = docStats.ols(y, [x], { names: ['x'], robust: true });
  assert.notEqual(robust.terms[1].se, fit.terms[1].se, 'HC1 稳健标准误应当与普通标准误不同');
  assert.equal(robust.terms[1].estimate, fit.terms[1].estimate, '稳健标准误不改变点估计');

  // 完全共线要给出人话错误，不能返回 NaN
  assert.match(docStats.ols(y, [x, x.map((v) => v * 2)], { names: ['a', 'b'] }).error, /共线性/);
  // 样本太少也要明确拒绝
  assert.match(docStats.ols([1, 2], [[1, 2]], { names: ['a'] }).error, /样本量不足/);
});

test('CSV 解析：引号、逗号、BOM、缺失值、类型推断', () => {
  const csv = '\uFEFF姓名,收入,备注\n"张,三",1200,"他说""你好"""\n李四,NA,空\n王五,1350,ok\n';
  const table = docStats.parseCsv(csv);
  assert.deepEqual(table.columns, ['姓名', '收入', '备注']);
  assert.equal(table.rows[0][0], '张,三', '引号里的逗号不能切开');
  assert.equal(table.rows[0][2], '他说"你好"', '双引号转义');
  assert.equal(table.rows[1][1], 'NA');
  const columns = docStats.describeColumns(table);
  assert.equal(columns[1].type, 'number', '收入是数值列');
  assert.equal(columns[0].type, 'category');
  assert.equal(columns[1].missing, 1, 'NA 算缺失');
  // 分号与制表符也要能识别
  assert.deepEqual(docStats.parseCsv('a;b\n1;2').columns, ['a', 'b']);
  assert.deepEqual(docStats.parseCsv('a\tb\n1\t2').columns, ['a', 'b']);
});

test('数据表：上传、列类型、删除', () => {
  const project = docEngine.createProject({ title: '数据表管理', docType: 'paper', mode: 'co' });
  const added = docEngine.addDataset({ projectId: project.id, name: '样本企业', content: SAMPLE_CSV });
  assert.equal(added.rows, 8);
  assert.equal(added.cols, 4);
  const list = docEngine.listDatasets(project.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].columns.filter((column) => column.type === 'number').length, 2);
  assert.throws(() => docEngine.addDataset({ projectId: project.id, content: '只有一列\n第一行数据\n第二行数据' }), /至少要两列/);
  assert.throws(() => docEngine.addDataset({ projectId: project.id, content: '' }), /空的/);
  docEngine.removeDataset({ projectId: project.id, id: added.id });
  assert.equal(docEngine.listDatasets(project.id).length, 0);
});

test('分析：描述统计 / 相关 / OLS / t 检验，数字都来自计算', () => {
  const project = docEngine.createProject({ title: '四种分析', docType: 'paper', mode: 'co' });
  const dataset = docEngine.addDataset({ projectId: project.id, name: '样本', content: SAMPLE_CSV });

  const describe = docEngine.runAnalysis({ projectId: project.id, datasetId: dataset.id, kind: 'describe', spec: {} });
  assert.deepEqual(describe.table.columns, ['变量', 'N', '均值', '标准差', '最小值', '中位数', '最大值']);
  assert.equal(describe.table.rows[0][0], '投入');
  assert.equal(describe.table.rows[0][2], '206.125', '均值必须是算出来的');

  const corr = docEngine.runAnalysis({ projectId: project.id, datasetId: dataset.id, kind: 'corr', spec: { columns: ['投入', '产值'] } });
  assert.equal(corr.table.rows[0][1], '1');
  assert.match(corr.table.rows[0][2], /\*\*\*/, '相关系数要带显著性星号');

  const ols = docEngine.runAnalysis({ projectId: project.id, datasetId: dataset.id, kind: 'ols', spec: { y: '产值', x: ['投入'] } });
  assert.equal(ols.table.rows[0][0], '常数项');
  assert.equal(ols.table.rows[1][0], '投入');
  // 系数必须与直接调用统计内核的结果一致（模型不参与计算）
  const columns = docStats.numericColumns(docStats.parseCsv(SAMPLE_CSV), ['产值', '投入']);
  const direct = docStats.ols(columns[0], [columns[1]], { names: ['投入'] });
  assert.equal(ols.table.rows[1][1], String(Number(direct.terms[1].estimate.toFixed(3))));
  assert.match(ols.narrative, /投入的系数为/);
  assert.match(ols.narrative, /p<0\.001/, 'p 值不能写成 p=<0.001');

  const ttest = docEngine.runAnalysis({ projectId: project.id, datasetId: dataset.id, kind: 'ttest', spec: { value: '产值', group: '规模' } });
  assert.equal(ttest.table.rows.length, 4, '两组 + 差值 + t 检验');
  assert.match(ttest.narrative, /Welch t 检验/);
});

test('分析：插入本节后表号连号、结果段的「表 N」换成真号、表格落库', () => {
  const project = docEngine.createProject({ title: '插入分析', docType: 'paper', mode: 'co' });
  const dataset = docEngine.addDataset({ projectId: project.id, name: '样本', content: SAMPLE_CSV });
  docEngine.saveSectionContent(project.id, 1, '本节先有一段文字。', 'manual');
  const first = docEngine.insertAnalysis({ projectId: project.id, idx: 1, kind: 'describe', spec: { datasetId: dataset.id } });
  assert.equal(first.table.no, 1);
  assert.match(first.narrative, /表 1 报告了/, '结果段里的表号要替换成真号');

  const second = docEngine.insertAnalysis({ projectId: project.id, idx: 5, kind: 'ols', spec: { datasetId: dataset.id, y: '产值', x: ['投入'] } });
  assert.equal(second.table.no, 2, '跨节连号，不是每节从 1 开始');

  const fresh = docEngine.getProject(project.id);
  assert.equal(fresh.sections[0].tables.length, 1);
  assert.equal(fresh.sections[4].tables.length, 1);
  assert.ok(fresh.sections[0].content.includes('【表1：'), '正文要留下占位符');

  // 表格里的数字算「有出处」，不该被数字溯源报出来
  const audit = docEngine.auditProject(project.id);
  assert.equal(audit.summary.tables, 2);
  assert.equal(audit.summary.unbackedNumbers, 0, '表里的数字是算出来的，不能被当成编造');
});

test('三线表：Markdown / Word / 页面三路渲染', () => {
  const spec = {
    no: 1, title: '回归结果', note: '*** p<0.001；N=8。',
    columns: ['变量', '系数', '标准误'], rows: [['投入', '0.04', '0.003']],
  };
  const md = docTable.tableMarkdown(spec);
  assert.match(md, /\*\*表1　回归结果\*\*/);
  assert.match(md, /\| 变量 \| 系数 \| 标准误 \|/);
  assert.match(md, /注：\*\*\* p<0\.001/);

  const xml = docTable.tableCaptionXml(spec);
  // 三线表：只有顶线与底线，表头下一条细线，不能有竖线
  assert.match(xml, /<w:top w:val="single" w:sz="12"/);
  assert.match(xml, /<w:bottom w:val="single" w:sz="12"/);
  assert.ok(!xml.includes('w:left w:val="single"'), '三线表不能有竖线');
  assert.ok(!xml.includes('insideV'), '三线表不能有内部竖线');
  assert.match(xml, /<w:tcBorders><w:bottom w:val="single" w:sz="8"/, '表头下要有一条细线');

  const html = docTable.tableBlockHtml(spec);
  assert.match(html, /<table class="tbl3">/);
  assert.match(html, /表 1　回归结果/);
  assert.match(html, /注：/);
});

test('页面：数据表卡、跑分析按钮、正文渲染三线表', async () => {
  const project = docEngine.createProject({ title: '页面数据分析', docType: 'paper', mode: 'co' });
  const dataset = docEngine.addDataset({ projectId: project.id, name: '样本企业', content: SAMPLE_CSV });
  docEngine.saveSectionContent(project.id, 1, '描述性统计如下。', 'manual');

  const page = await get(`/docs?id=${project.id}&s=1`);
  assert.match(page.text, /📊 数据表/);
  assert.match(page.text, /样本企业/);
  assert.match(page.text, /action="\/docs\/analysis"/);
  assert.match(page.text, /name="kind"/);
  assert.match(page.text, /稳健标准误/);

  const ran = await post('/docs/analysis', {
    csrf: TOKEN, projectId: project.id, s: '1', datasetId: dataset.id, kind: 'ols', y: '产值', x: ['投入'],
  });
  assert.equal(ran.status, 303);
  const fresh = docEngine.getProject(project.id);
  assert.equal(fresh.sections[0].tables.length, 1);

  const after = await get(`/docs?id=${project.id}&s=1`);
  assert.match(after.text, /<table class="tbl3">/);
  assert.match(after.text, /表 1　以产值为因变量的回归结果/);
  assert.ok(!after.text.includes('【表1：'), '占位符不能漏到页面上');
});

test('体检：表格没被正文提及要提示', () => {
  const project = docEngine.createProject({ title: '表格未呼应', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1, '结果见下表。\n\n【表1：回归结果】\n\n以上。', 'manual');
  db.run(`UPDATE doc_sections SET tables_json=? WHERE project_id=? AND idx=1`,
    JSON.stringify([{ no: 1, title: '回归结果', columns: ['变量'], rows: [['投入']] }]), project.id);
  const audit = docEngine.auditProject(project.id);
  assert.ok(audit.issues.some((issue) => issue.code === 'table'), '只放表不提要提示');

  docEngine.saveSectionContent(project.id, 1, '结果如表 1 所示。\n\n【表1：回归结果】\n\n以上。', 'manual');
  const fixed = docEngine.auditProject(project.id);
  assert.ok(!fixed.issues.some((issue) => issue.code === 'table'), '正文提了就不该报');
});

test('导出：Markdown 与 Word 都带三线表', () => {
  const project = docEngine.createProject({ title: '表格导出', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1, '回归结果如表 1 所示。\n\n【表1：回归结果】\n\n系数为正。', 'manual');
  db.run(`UPDATE doc_sections SET tables_json=? WHERE project_id=? AND idx=1`,
    JSON.stringify([{ no: 1, title: '回归结果', note: 'N=8。', columns: ['变量', '系数'], rows: [['投入', '0.04']] }]), project.id);

  const md = docEngine.assembleMarkdown(project.id).markdown;
  assert.match(md, /\*\*表1　回归结果\*\*/);
  assert.match(md, /\| 投入 \| 0\.04 \|/);
  assert.ok(!md.includes('【表1：'), 'Markdown 里占位符要换成真表格');

  const docx = docEngine.assembleDocx(project.id);
  const xml = docx.buffer.toString('utf8');
  assert.match(xml, /<w:tblBorders><w:top w:val="single" w:sz="12"/);
  assert.ok(!xml.includes('【表1：'), 'Word 里占位符要换成真表格');
  assert.ok(xml.includes('回归结果'));
});

// ---------- 文献接入与方法论审查 ----------

const docBib = require('../lib/doc-bib');
const docMethod = require('../lib/doc-method');

test('文献解析：BibTeX / RIS / CSL-JSON 三种格式与 LaTeX 重音', () => {
  const bibtex = [
    '@article{zhang2023,',
    '  author = {Zhang, San and Li, Si},',
    '  title = {Digital Transformation in Manufacturing},',
    '  journal = {Industrial Economics}, year = {2023},',
    '  volume = {4}, number = {2}, pages = {12--19}, doi = {10.1000/xyz},',
    '  abstract = {We study 12 firms.}',
    '}',
    '@book{wang2021, author={王五}, title={中小企业数字化转型}, publisher={经济出版社}, year={2021}}',
  ].join('\n');
  const parsedBib = docBib.parseBibliography(bibtex);
  assert.equal(parsedBib.format, 'bibtex');
  assert.equal(parsedBib.entries.length, 2);
  assert.equal(parsedBib.entries[0].authors, 'San Zhang, Si Li', '「姓, 名」要转成「名 姓」');
  assert.equal(parsedBib.entries[0].source, 'Industrial Economics, 2023, 4(2): 12-19');
  assert.equal(parsedBib.entries[0].doi, '10.1000/xyz');
  assert.match(parsedBib.entries[1].content, /没有摘要/, '没摘要要明说，不能编');

  const ris = 'TY  - JOUR\nAU  - 张三\nAU  - 李四\nTI  - 制造业数字化转型研究\nJO  - 工业经济\nPY  - 2023\nAB  - 基于 12 家企业调研。\nER  - \n';
  const parsedRis = docBib.parseBibliography(ris, { filename: 'refs.ris' });
  assert.equal(parsedRis.format, 'ris');
  assert.equal(parsedRis.entries[0].authors, '张三, 李四');
  assert.equal(parsedRis.entries[0].year, '2023');

  const csl = JSON.stringify([{
    type: 'article-journal', title: 'CSL 测试',
    author: [{ family: 'Chen', given: 'Wei' }],
    issued: { 'date-parts': [[2022]] }, 'container-title': '管理世界', DOI: '10.1/x',
  }]);
  const parsedCsl = docBib.parseBibliography(csl, { filename: 'zotero.json' });
  assert.equal(parsedCsl.format, 'csl');
  assert.equal(parsedCsl.entries[0].year, '2022');

  assert.equal(docBib.latexToText('M{\\"u}ller and \\c{c}a'), 'Müller and ça');
  // 重复条目要去重
  const dup = docBib.parseBibliography(`${bibtex}\n${bibtex}`);
  assert.equal(dup.entries.length, 2);
  assert.ok(dup.skipped >= 2);
});

test('文献导入：一条文献变成一条带著录信息的素材', () => {
  const project = docEngine.createProject({ title: '文献导入', docType: 'paper', mode: 'co' });
  const bibtex = '@article{a2023, author={张三}, title={制造业数字化转型研究}, journal={工业经济}, year={2023}, abstract={基于 312 家企业问卷。}}';
  const imported = docEngine.importBibliography({ projectId: project.id, text: bibtex });
  assert.equal(imported.imported, 1);
  const materials = docEngine.listMaterials(project.id);
  assert.equal(materials[0].authors, '张三');
  assert.equal(materials[0].year, '2023');
  assert.match(materials[0].source, /工业经济/);
  assert.equal(materials[0].kind, 'literature');

  // 摘要过短时补题名与出处当上下文，而不是拒绝导入
  const short = docEngine.importBibliography({
    projectId: project.id,
    text: '@article{b2022, author={李四}, title={回收期研究}, journal={管理世界}, year={2022}, abstract={案例研究。}}',
  });
  assert.equal(short.imported, 1);
  const all = docEngine.listMaterials(project.id);
  assert.ok(all.some((item) => item.text.includes('题名：回收期研究')));

  assert.throws(() => docEngine.importBibliography({ projectId: project.id, text: '这不是文献格式' }), /没有解析出文献条目/);
});

test('文献矩阵：模型只抽取不推测，key 必须对得上', async () => {
  const project = docEngine.createProject({ title: '文献矩阵', docType: 'paper', mode: 'co' });
  docEngine.addMaterial({
    projectId: project.id, kind: 'literature', title: '制造业数字化转型研究',
    authors: '张三', year: '2023', source: '工业经济 2023(4)',
    content: '基于 312 家企业问卷，发现改造投入与人均产值正相关。',
  });
  const seen = [];
  stubModel((options) => {
    seen.push(options.messages.map((message) => String(message.content || '')).join('\n'));
    return JSON.stringify({
      items: [
        { key: 'M1', method: '问卷调查', sample: '312 家企业', finding: '改造投入与人均产值正相关', limit: '未提及' },
        { key: 'M9', method: '编的', sample: '不存在', finding: '不该出现', limit: '' },
      ],
    });
  });
  const matrix = await docEngine.buildLiteratureMatrix({ projectId: project.id });
  assert.equal(matrix.items.length, 1, '矩阵里不存在的编号要被丢掉');
  assert.equal(matrix.items[0].key, 'M1');
  assert.equal(matrix.items[0].limit, '未提及');
  assert.ok(seen[0].includes('摘要没提到的内容一律写「未提及」'), '提示词必须约束不许推测');
  assert.equal(docEngine.getProject(project.id).hasLiteratureMatrix, true);
});

test('文献矩阵：插入三线表 + 生成综述初稿只引矩阵里的编号', async () => {
  const project = docEngine.createProject({ title: '文献综述', docType: 'paper', mode: 'co' });
  docEngine.addMaterial({
    projectId: project.id, kind: 'literature', title: '甲文献', authors: '张三', year: '2023',
    content: '基于 312 家企业问卷，发现改造投入与人均产值正相关。',
  });
  const prompts = [];
  stubModel((options) => {
    const sys = String(options.messages[0].content || '');
    prompts.push(`${sys}\n${String(options.messages[1].content || '')}`);
    if (sys.includes('文献分析助手')) {
      return JSON.stringify({ items: [{ key: 'M1', method: '问卷调查', sample: '312 家企业', finding: '正相关', limit: '未提及' }] });
    }
    return '张三（2023）基于 312 家企业问卷发现改造投入与人均产值正相关 [M1]。'.repeat(8);
  });
  await docEngine.buildLiteratureMatrix({ projectId: project.id });
  const inserted = docEngine.insertLiteratureMatrix({ projectId: project.id, idx: 3 });
  assert.equal(inserted.table.no, 1);
  assert.deepEqual(inserted.table.columns, ['文献', '方法', '样本', '主要结论', '局限', '方法判断']);
  assert.match(inserted.table.rows[0][0], /张三（2023）\s*\[M1\]/);

  const drafted = await docEngine.draftLiteratureReview({ projectId: project.id, idx: 3 });
  assert.ok(drafted.chars > 200);
  const prompt = findPrompt(prompts, '文献综述');
  assert.ok(prompt.includes('编号必须是矩阵里出现过的'), '必须约束不许引矩阵外的文献');
  assert.ok(prompt.includes('不要替它补内容'), '「未提及」的字段不许补');
  const section = docEngine.getProject(project.id).sections[2];
  assert.ok(section.content.includes('[M1]'), '综述要写进正文');
});

test('方法论审查：规则扫描能抓出「因果表述但无识别策略」', () => {
  const project = docEngine.createProject({ title: '方法扫描', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1,
    '本文发现改造投入显著提升了企业的人均产值，说明加大投入能带来更好的效益。'
    + '样本来自 12 家企业。', 'manual');
  const scan = docMethod.scanMethodology(docEngine.getProject(project.id));
  const codes = scan.findings.map((item) => item.code);
  assert.ok(codes.includes('identification'), '有因果表述但没有识别策略，必须报');
  const issue = scan.findings.find((item) => item.code === 'identification');
  assert.equal(issue.level, 'warn');
  assert.ok(codes.includes('robustness'), '没有稳健性检验要报');
  assert.ok(codes.includes('boundary'), '没有写局限要报');

  // 补上识别策略与稳健性后，这两条应当消失
  docEngine.saveSectionContent(project.id, 1,
    '本文用双重差分识别改造投入对人均产值的影响，并做了替换变量与缩尾的稳健性检验。'
    + '样本来自 12 家企业，受限于样本量，结论不能推广，这是本文的局限。', 'manual');
  const fixed = docMethod.scanMethodology(docEngine.getProject(project.id));
  const fixedCodes = fixed.findings.map((item) => item.code);
  assert.ok(!fixedCodes.includes('identification'), '补了识别策略就不该再报');
  assert.ok(!fixedCodes.includes('robustness'));
  assert.ok(!fixedCodes.includes('boundary'));
});

test('方法论审查：模型逐条判断落库，页面显示结论与致命项', async () => {
  const project = docEngine.createProject({ title: '方法审查', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1, '本文发现投入显著提升了产值。样本来自 12 家企业。', 'manual');
  stubModel((options) => {
    const sys = String(options.messages[0].content || '');
    if (sys.includes('方法论审稿人')) {
      return JSON.stringify({
        items: [
          { key: 'identification', verdict: 'fail', comment: '用了「提升」但没有任何识别策略', fix: '补双重差分，或把表述改成「相关」' },
          { key: 'sample', verdict: 'weak', comment: '只写了 12 家，没说抽样方式', fix: '补一句抽样与样本量依据' },
        ],
        fatal: ['因果表述无识别策略'],
        verdict: '方法部分目前不能投',
      });
    }
    return 'x';
  });
  const result = await docEngine.reviewMethodology(project.id);
  assert.equal(result.review.items.length, 2);
  assert.equal(result.review.items[0].verdict, 'fail');
  assert.deepEqual(result.review.fatal, ['因果表述无识别策略']);
  assert.ok(result.scan.findings.length > 0);
  assert.equal(docEngine.getProject(project.id).hasMethodology, true);

  const page = await get(`/docs?id=${project.id}&s=1`);
  assert.match(page.text, /🔬 方法论审查/);
  assert.match(page.text, /会被直接拒：因果表述无识别策略/);
  assert.match(page.text, /用了「提升」但没有任何识别策略/);
  assert.match(page.text, /下一步：补双重差分/);
});

test('页面：文献卡与方法卡，导入走路由', async () => {
  const project = docEngine.createProject({ title: '页面文献', docType: 'paper', mode: 'co' });
  const page = await get(`/docs?id=${project.id}&s=1`);
  assert.match(page.text, /📖 文献/);
  assert.match(page.text, /action="\/docs\/bib\/import"/);
  assert.match(page.text, /action="\/docs\/lit\/matrix"/);
  assert.match(page.text, /🔬 方法论审查/);
  assert.match(page.text, /action="\/docs\/method"/);

  const imported = await post('/docs/bib/import', {
    csrf: TOKEN, projectId: project.id, s: '1',
    text: '@article{a2023, author={张三}, title={制造业数字化转型研究}, journal={工业经济}, year={2023}, abstract={基于 312 家企业问卷。}}',
  });
  assert.equal(imported.status, 303);
  assert.equal(docEngine.listMaterials(project.id).length, 1);
});

// ---------- 两种写作方式是否真的用上了新能力 ----------

test('分析预设：设置、校验、取消', () => {
  const project = docEngine.createProject({ title: '预设管理', docType: 'paper', mode: 'co' });
  const dataset = docEngine.addDataset({ projectId: project.id, name: '样本', content: SAMPLE_CSV });
  const saved = docEngine.setAnalysisPreset(project.id, {
    datasetId: dataset.id, kind: 'ols', y: '产值', x: ['投入'], robust: true, sectionIdx: 5,
  });
  assert.equal(saved.preset.sectionIdx, 5);
  assert.deepEqual(saved.preset.x, ['投入']);
  assert.equal(docEngine.getAnalysisPreset(project.id).robust, true);
  assert.equal(docEngine.getProject(project.id).analysisPreset.y, '产值');

  assert.throws(() => docEngine.setAnalysisPreset(project.id, { datasetId: 'nope' }), /数据集不存在/);
  docEngine.setAnalysisPreset(project.id, null);
  assert.equal(docEngine.getAnalysisPreset(project.id), null);
});

test('共创起草：提示词注入真实统计结果，起草后自动补三线表', async () => {
  const project = docEngine.createProject({ title: '共创接线', docType: 'paper', mode: 'co' });
  const dataset = docEngine.addDataset({ projectId: project.id, name: '样本', content: SAMPLE_CSV });
  docEngine.setAnalysisPreset(project.id, {
    datasetId: dataset.id, kind: 'ols', y: '产值', x: ['投入'], robust: true, sectionIdx: 5,
  });
  const seen = [];
  stubModel((options) => {
    seen.push(options.messages.map((message) => String(message.content || '')).join('\n'));
    if (seen[seen.length - 1].includes('段落计划')) {
      return JSON.stringify({ points: ['一', '二', '三'], questions: ['问一'], figures: [] });
    }
    return longText(71, 400);
  });
  await docEngine.draftSection(project.id, 5);

  const prompt = seen.find((text) => text.includes('【本节统计结果')) || '';
  assert.ok(prompt, '起草「结果与分析」时必须注入统计结果');
  assert.match(prompt, /数字一个都不能改/, '必须明确禁止改数字');
  assert.match(prompt, /系数/, '要给出系数表');
  // 系数必须与统计内核算出来的一致，不能是模型编的
  const columns = docStats.numericColumns(docStats.parseCsv(SAMPLE_CSV), ['产值', '投入']);
  const direct = docStats.ols(columns[0], [columns[1]], { names: ['投入'], robust: true });
  assert.ok(prompt.includes(docEngine.runAnalysis({
    projectId: project.id, datasetId: dataset.id, kind: 'ols', spec: { y: '产值', x: ['投入'], robust: true },
  }).table.rows[1][1]), '提示词里的系数必须是系统算出的那个');

  const section = docEngine.getProject(project.id).sections[4];
  assert.equal(section.tables.length, 1, '起草完成后要自动补上三线表');
  assert.ok(section.content.includes('【表1：'), '正文里要有表格占位符');
  // 只补表，不追加模板结果段（模型已经写过一段，避免重复）
  assert.equal((section.content.match(/报告了以/g) || []).length, 0);
});

test('全托管：自动生成文献矩阵、自动补表、写完后自动方法审查', async () => {
  const project = docEngine.createProject({ title: '全托管接线', docType: 'paper', mode: 'auto', depth: 'brief' });
  docEngine.addMaterial({
    projectId: project.id, kind: 'literature', title: '甲文献', authors: '张三', year: '2023',
    content: '基于 312 家企业问卷，发现改造投入与人均产值正相关。',
  });
  const dataset = docEngine.addDataset({ projectId: project.id, name: '样本', content: SAMPLE_CSV });
  docEngine.setAnalysisPreset(project.id, {
    datasetId: dataset.id, kind: 'ols', y: '产值', x: ['投入'], sectionIdx: 5,
  });

  const seen = [];
  stubModel((options) => {
    const sys = String(options.messages[0].content || '');
    seen.push(`${sys}\n${String(options.messages[1].content || '')}`);
    if (sys.includes('段落计划')) return JSON.stringify({ points: ['一', '二', '三'], questions: ['问一'], figures: [] });
    if (sys.includes('文献分析助手')) {
      return JSON.stringify({ items: [{ key: 'M1', method: '问卷调查', sample: '312 家', finding: '正相关', limit: '未提及' }] });
    }
    if (sys.includes('方法论审稿人')) {
      return JSON.stringify({
        items: [{ key: 'identification', verdict: 'missing', comment: '没有识别策略', fix: '补双重差分' }],
        fatal: ['无识别策略'], verdict: '不能投',
      });
    }
    if (sys.includes('评审')) {
      return JSON.stringify({
        scores: { argument: 16, evidence: 16, structure: 16, originality: 14, language: 15, rigor: 14 },
        total: 91, issues: [], mustFix: [], comments: '可以',
      });
    }
    return longText(81, 400);
  });

  const run = await docEngine.generateDocProject({ projectId: project.id, maxRetries: 1 });
  assert.equal(run.runStatus, 'completed');
  assert.equal(run.autoMatrix, true, '有文献素材时批量前要自动生成矩阵');
  assert.equal(run.autoMethodology, true, '整篇写完后要自动跑方法论审查');
  assert.equal(docEngine.getProject(project.id).hasLiteratureMatrix, true);
  assert.equal(docEngine.getProject(project.id).hasMethodology, true);

  // 文献综述那一节必须拿到矩阵
  const litPrompt = seen.find((text) => text.includes('【文献矩阵（从你导入的文献里抽取'));
  assert.ok(litPrompt, '文献综述类小节要注入矩阵');
  assert.match(litPrompt, /不要替它补内容/, '「未提及」的字段不许补');

  // 分析预设那一节自动补表
  assert.equal(docEngine.getProject(project.id).sections[4].tables.length, 1);
});

test('文献综述类小节才注入矩阵，方法类小节不注入', async () => {
  const project = docEngine.createProject({ title: '矩阵注入范围', docType: 'paper', mode: 'co' });
  docEngine.addMaterial({
    projectId: project.id, kind: 'literature', title: '甲文献', authors: '张三', year: '2023',
    content: '基于 312 家企业问卷，发现改造投入与人均产值正相关。',
  });
  stubModel((options) => {
    const sys = String(options.messages[0].content || '');
    if (sys.includes('文献分析助手')) {
      return JSON.stringify({ items: [{ key: 'M1', method: '问卷', sample: '312 家', finding: '正相关', limit: '未提及' }] });
    }
    if (sys.includes('段落计划')) return JSON.stringify({ points: ['一'], questions: ['问'], figures: [] });
    return longText(91, 400);
  });
  await docEngine.buildLiteratureMatrix({ projectId: project.id });

  const seen = [];
  stubModel((options) => {
    seen.push(options.messages.map((message) => String(message.content || '')).join('\n'));
    if (seen[seen.length - 1].includes('段落计划')) return JSON.stringify({ points: ['一'], questions: ['问'], figures: [] });
    return longText(92, 400);
  });
  const project2 = docEngine.createProject({ title: '矩阵注入范围2', docType: 'paper', mode: 'co' });
  // 把矩阵搬过去（同一套接口，直接建一份）
  docEngine.addMaterial({
    projectId: project2.id, kind: 'literature', title: '甲文献', authors: '张三', year: '2023',
    content: '基于 312 家企业问卷，发现改造投入与人均产值正相关。',
  });
  db.run(`UPDATE doc_projects SET lit_json=(SELECT lit_json FROM doc_projects WHERE id=?) WHERE id=?`,
    project.id, project2.id);

  // 第 3 节是「文献综述」，第 4 节是「研究方法」
  await docEngine.draftSection(project2.id, 3);
  const reviewPrompt = seen.find((text) => text.includes('【文献矩阵（从你导入的文献里抽取'));
  assert.ok(reviewPrompt, '文献综述节要注入矩阵');

  seen.length = 0;
  await docEngine.draftSection(project2.id, 4);
  assert.ok(!seen.some((text) => text.includes('【文献矩阵（从你导入的文献里抽取')), '研究方法节不该注入矩阵');
});

// ---------- 其他文体的专项能力 ----------

const docFinance = require('../lib/doc-finance');
const docTypekit = require('../lib/doc-typekit');

const FIN_INPUT = {
  price: 3000, customers: 200, growth: 0.8, retention: 0.75, variableRate: 0.3,
  fixedCost: 120000, headcount: 8, costPerHead: 180000, taxRate: 0.25,
  capex: 600000, wcRate: 0.1, cash0: 500000, funding: 3000000, preMoney: 12000000,
  marketingSpend: 400000, years: 3,
};

test('BP 财务模型：三表内部一致，单位经济与融资可核对', () => {
  const model = docFinance.buildModel(FIN_INPUT);
  assert.equal(model.years.length, 3);
  // 收入 = 客户数 × 客单价；毛利 = 收入 × (1 − 变动成本率)
  const y1 = model.years[0];
  assert.equal(y1.revenue, 200 * 3000);
  assert.equal(Math.round(y1.gross), Math.round(y1.revenue * 0.7));
  // 净利 = EBIT − 税；EBIT = 毛利 − 费用 − 折旧
  assert.equal(Math.round(y1.ebit), Math.round(y1.gross - y1.opex - y1.depreciation));
  assert.equal(Math.round(y1.net), Math.round(y1.ebit - y1.tax));
  // 期末现金 = 期初 + 经营 + 投资 + 筹资（三表必须闭环）
  for (const year of model.years) {
    assert.ok(Math.abs(year.cashEnd - (year.cashBegin + year.ocf + year.icf + year.fcf)) < 1e-6, '现金流必须闭环');
  }
  // 单位经济
  assert.equal(model.unit.ltv, (3000 * 0.7) / 0.25);
  assert.equal(model.unit.cac, 400000 / 200);
  assert.ok(model.unit.ltvCac > 3);
  // 融资稀释
  assert.equal(model.funding.postMoney, 15000000);
  assert.equal(model.funding.dilution, 3000000 / 15000000);
  // 客户数按增长率扩张
  assert.equal(model.years[1].customers, 200 * 1.8);
});

test('BP 财务模型：现金缺口要能算出来并写进结果段', () => {
  const model = docFinance.buildModel({
    price: 3000, customers: 100, growth: 0.5, variableRate: 0.3,
    fixedCost: 200000, headcount: 10, costPerHead: 180000, capex: 1000000, cash0: 200000,
  });
  assert.ok(model.minCash < 0, '这个假设下现金必然是负的');
  assert.equal(model.cashPositiveYear, null, '预测期内没有转正');
  const text = docFinance.narrative(model);
  assert.match(text, /期末现金始终为负/, '必须明确写出缺口，而不是含糊过去');
  assert.match(text, /需要说明融资额能否覆盖/, '要点出下一步该做什么');
});

test('BP 表格：五张表齐全，列宽按内容分配', () => {
  const model = docFinance.buildModel(FIN_INPUT);
  const tables = docFinance.allTables(model);
  assert.equal(tables.length, 5);
  assert.deepEqual(tables.map((item) => item.title),
    ['关键假设', '收入与毛利预测', '利润表预测', '现金流量表预测', '单位经济与融资测算']);
  // 假设表的说明列要比取值列宽得多，否则三线表没有竖线会视觉粘连
  const assumption = tables[0];
  assert.ok(assumption.widths[2] > assumption.widths[1] * 2, '说明列要明显更宽');
  // 财务表必须有表注（口径说明）
  for (const table of tables.slice(1)) assert.ok(table.note.length > 10, `${table.title} 要有口径注`);
});

test('申报书：指标表能标出不可考核项，预算表占比与合计自动算', () => {
  const indicators = docTypekit.indicatorTable([
    { name: '改造企业数量', baseline: '0 家', target: '50 家', method: '验收报告' },
    { name: '人均产值提升', baseline: '42.6 万元', target: '显著提升', method: '企业报表' },
  ]);
  assert.deepEqual(indicators.columns, ['序号', '考核指标', '基线值', '目标值', '验收方式']);
  assert.match(indicators.note, /1 项目标值不含数字/, '「显著提升」必须被标为不可考核');

  const budget = docTypekit.budgetTable([
    { item: '设备费', amount: 120, basis: '询价 3 家' },
    { item: '材料费', amount: 30 },
    { item: '劳务费', amount: 50 },
  ]);
  assert.equal(budget.rows[0][2], '60.0%', '占比自动算');
  assert.equal(budget.rows[1][3], '【待补：测算依据】', '缺依据要标出来');
  const total = budget.rows[budget.rows.length - 1];
  assert.equal(total[0], '合计');
  assert.equal(total[1], '200.00');
});

test('合同：按内容识别类型，条款对照与风险扫描', () => {
  const contract = {
    docType: 'contract', title: '设备采购合同',
    sections: [
      { title: '标的与范围', content: '甲方向乙方采购数控设备 3 台，型号 X200。' },
      { title: '交付与验收', content: '乙方应于签约后 30 日内交付，甲方在 7 日内验收。' },
      { title: '价款与支付', content: '合同总价 120 万元，签订后 7 日内支付 30%。' },
      { title: '双方权利与义务', content: '甲方有权随时单方面变更交付地点，无需征得乙方同意。乙方应尽快交付。' },
    ],
  };
  assert.equal(docTypekit.detectContractKind(contract), 'sale');

  const table = docTypekit.clauseTable(contract);
  const status = Object.fromEntries(table.rows.map((row) => [row[0], row[1]]));
  assert.equal(status['标的物'], '已具备');
  assert.equal(status['违约责任'], '缺失');
  assert.equal(status['争议解决'], '缺失');

  const scan = docTypekit.scanContract(contract);
  const codes = scan.findings.map((item) => item.code);
  assert.ok(codes.includes('clause-missing'), '缺必备条款必须报');
  assert.ok(codes.includes('one-sided'), '「单方面变更」必须报');
  const missing = scan.findings.find((item) => item.code === 'clause-missing');
  assert.match(missing.title, /违约责任/);
});

test('合同：写了违约责任但没有具体比例也要报', () => {
  const contract = {
    docType: 'contract', title: '服务合同',
    sections: [
      { title: '服务内容', content: '乙方提供系统运维服务。' },
      { title: '违约责任', content: '任何一方违约应承担违约责任。' },
      { title: '争议解决', content: '协商不成的，向有管辖权的法院起诉。' },
    ],
  };
  const scan = docTypekit.scanContract(contract);
  const codes = scan.findings.map((item) => item.code);
  assert.ok(codes.includes('liability-vague'), '「承担违约责任」等于没说，要报');
  assert.ok(codes.includes('dispute-vague'), '「有管辖权的法院」是空话，要报');
});

test('调研报告：样本构成表的占比与累计自动算', () => {
  const dataset = {
    columns: ['企业', '规模', '地区'],
    rows: [['A', '小', '华东'], ['B', '大', '华东'], ['C', '小', '华北'], ['D', '中', '华东'], ['E', '小', '华南']],
  };
  const tables = docTypekit.sampleTable(dataset, { columns: ['规模', '地区'] });
  assert.equal(tables.length, 2);
  assert.equal(tables[0].title, '样本构成：按规模分布');
  assert.deepEqual(tables[0].rows[0], ['小', '3', '60.0%', '60.0%']);
  const total = tables[0].rows[tables[0].rows.length - 1];
  assert.deepEqual(total, ['合计', '5', '100.0%', '—']);
  // 累计占比最后一行应当是 100%
  const lastData = tables[0].rows[tables[0].rows.length - 2];
  assert.equal(lastData[3], '100.0%');
});

test('文体专项：类型化写作约束进提示词，且各类型不同', async () => {
  const prompts = {};
  stubModel((options) => {
    const sys = String(options.messages[0].content || '');
    prompts[sys.includes('商业计划书') ? 'bp' : sys.includes('法律合同') || sys.includes('合同文体') ? 'contract' : 'other'] = sys;
    if (sys.includes('段落计划')) return JSON.stringify({ points: ['一'], questions: ['问'], figures: [] });
    return longText(101, 400);
  });

  const bp = docEngine.createProject({ title: 'BP 约束', docType: 'bp', mode: 'co', depth: 'brief' });
  await docEngine.draftSection(bp.id, 1);
  const bpSys = Object.values(prompts).find((text) => text.includes('【BP 硬约束】'));
  assert.ok(bpSys, 'BP 要有自己的硬约束');
  assert.match(bpSys, /财务预测必须给假设/);
  assert.match(bpSys, /市场规模必须给推算/);

  const contract = docEngine.createProject({ title: '合同约束', docType: 'contract', mode: 'co', depth: 'brief' });
  await docEngine.draftSection(contract.id, 1);
  const contractSys = Object.values(prompts).find((text) => text.includes('【合同硬约束】'));
  assert.ok(contractSys, '合同要有自己的硬约束');
  assert.match(contractSys, /禁止单方权利表述/);
  assert.match(contractSys, /禁止模糊表述/);
  // 合同不该出现公式与数字溯源那套（那是论文/BP 的规则）
  assert.ok(!contractSys.includes('【公式写法】'), '合同不该要求写 LaTeX 公式');
});

test('文体专项：表格插入与专项检查端到端', () => {
  // BP
  const bp = docEngine.createProject({ title: 'BP 插入', docType: 'bp', mode: 'co' });
  const built = docEngine.insertBusinessModel({ projectId: bp.id, idx: 8, input: FIN_INPUT });
  assert.equal(built.tables.length, 5);
  assert.equal(docEngine.getProject(bp.id).sections[7].tables.length, 5);
  assert.ok(docEngine.getProject(bp.id).sections[7].content.includes('【表1：关键假设】'));
  assert.ok(docEngine.getFinanceInput(bp.id), '假设要存库，方便改一个数重算');

  // 申报书
  const proposal = docEngine.createProject({ title: '申报书插入', docType: 'proposal', mode: 'co' });
  const scheme = docEngine.insertSchemeTables({
    projectId: proposal.id, idx: 6,
    indicators: [{ name: '改造企业数', baseline: '0 家', target: '50 家', method: '验收报告' }],
    budget: [{ item: '设备费', amount: 120, basis: '询价 3 家' }],
  });
  assert.equal(scheme.tables.length, 2);

  // 合同
  const contract = docEngine.createProject({ title: '设备采购合同', docType: 'contract', mode: 'co' });
  docEngine.saveSectionContent(contract.id, 4, '甲方向乙方采购设备 3 台。', 'manual');
  const clause = docEngine.insertClauseTable({ projectId: contract.id, idx: 8 });
  assert.match(clause.tables[0].title, /买卖合同必备条款对照/);

  // 调研报告
  const report = docEngine.createProject({ title: '调研插入', docType: 'report', mode: 'co' });
  const dataset = docEngine.addDataset({ projectId: report.id, name: '问卷', content: '编号,规模\n1,小\n2,大\n3,小' });
  const sample = docEngine.insertSampleTables({ projectId: report.id, idx: 3, datasetId: dataset.id, columns: ['规模'] });
  assert.equal(sample.tables.length, 1);

  // 专项检查落库 + 进体检
  const check = docEngine.runTypeCheck(contract.id);
  assert.equal(check.kindName, '买卖合同');
  assert.ok(docEngine.getTypeCheck(contract.id));
  const audit = docEngine.auditProject(contract.id);
  assert.ok(audit.issues.some((issue) => issue.code.startsWith('type-')), '专项检查要进全文体检');
});

test('页面：四类文档各有自己的文体专项卡', async () => {
  const bp = docEngine.createProject({ title: '页面 BP', docType: 'bp', mode: 'co' });
  const bpPage = await get(`/docs?id=${bp.id}&s=8`);
  assert.match(bpPage.text, /🧰 文体专项/);
  assert.match(bpPage.text, /action="\/docs\/type\/finance"/);
  assert.match(bpPage.text, /name="variableRate"/);

  const proposal = docEngine.createProject({ title: '页面申报', docType: 'proposal', mode: 'co' });
  const proposalPage = await get(`/docs?id=${proposal.id}&s=6`);
  assert.match(proposalPage.text, /action="\/docs\/type\/scheme"/);
  assert.match(proposalPage.text, /name="indicators"/);

  const contract = docEngine.createProject({ title: '页面合同', docType: 'contract', mode: 'co' });
  const contractPage = await get(`/docs?id=${contract.id}&s=3`);
  assert.match(contractPage.text, /action="\/docs\/type\/clause"/);
  assert.match(contractPage.text, /name="kind"/);

  const report = docEngine.createProject({ title: '页面调研', docType: 'report', mode: 'co' });
  docEngine.addDataset({ projectId: report.id, name: '问卷', content: '编号,规模\n1,小\n2,大' });
  const reportPage = await get(`/docs?id=${report.id}&s=3`);
  assert.match(reportPage.text, /action="\/docs\/type\/sample"/);
  assert.match(reportPage.text, /问卷/);
});

// ---------- 生成算法：检索 / 定点修补 / 接缝裁剪 ----------

const docRetrieval = require('../lib/doc-retrieval');

test('检索算法：IDF 压掉泛词，稀有实词排到前面', () => {
  const chunks = [
    { key: 'M1', title: '综述', text: '企业是市场主体，企业要发展，企业要创新，企业要重视管理，企业要加强能力建设。' },
    { key: 'M2', title: '数据', text: '改造投入的回收期为 2.1 年。' },
    { key: 'M3', title: '其他', text: '另一家企业也做了类似工作。' },
  ];
  const ranked = docRetrieval.rank(chunks, '企业的投入', { ratio: 0.01 });
  // 旧算法（裸计数）三个块得分完全相同，都是 1；IDF 之后含「投入」的那块必须排第一
  assert.match(ranked[0].text, /投入的回收期/);
  assert.ok(ranked[0].normalized > ranked[ranked.length - 1].normalized, '泛词块要被压到后面');
});

test('检索算法：同义扩展能命中同义表述（旧算法命中 0 条）', () => {
  const chunks = [
    { key: 'M1', title: 'A', text: '项目的投资回收年限为三年左右。' },
    { key: 'M2', title: 'B', text: '项目需要较多前期准备。' },
  ];
  // 「回本周期」与素材里的「投资回收年限」没有任何共同二元字组
  const ranked = docRetrieval.rank(chunks, '回本周期', { ratio: 0.01 });
  assert.ok(ranked.length > 0, '同义扩展后必须能命中');
  assert.match(ranked[0].text, /投资回收年限/);
});

test('检索算法：长度归一，灌水长块不会因为字多就排前面', () => {
  const chunks = [
    { key: 'M1', title: '长', text: '企业数字化改造是趋势。'.repeat(30) },
    { key: 'M2', title: '短', text: '改造投入 128 万元，回收期 2.1 年。' },
  ];
  const ranked = docRetrieval.rank(chunks, '改造投入回收期', { ratio: 0.01 });
  assert.match(ranked[0].text, /128 万元/);
  assert.ok(ranked[0].normalized > 0.5, '真正对题的短块要明显领先');
});

test('检索算法：标题命中的素材整体加权', () => {
  const chunks = [
    { key: 'M1', title: '回收期研究', text: '样本企业的投入与产出存在差异。' },
    { key: 'M2', title: '其他资料', text: '样本企业的投入与产出存在差异。' },
  ];
  const ranked = docRetrieval.rank(chunks, '回收期', { ratio: 0.01 });
  assert.equal(ranked[0].title, '回收期研究', '标题对题的要排前面');
});

test('定点修补：只替换指出的那一句，其余原样保留', () => {
  const content = '第一段讲背景。第二段说效果显著。第三段给数据。';
  const patched = docEngine.applyPatches(content, [
    { quote: '第二段说效果显著。', replacement: '第二段给出具体数据：提升 11.4%。' },
  ]);
  assert.equal(patched.applied.length, 1);
  assert.equal(patched.content, '第一段讲背景。第二段给出具体数据：提升 11.4%。第三段给数据。');
  assert.ok(patched.content.startsWith('第一段讲背景。'), '没被指出的段落不能动');
  assert.ok(patched.content.endsWith('第三段给数据。'));
});

test('定点修补：定位不准时宁可不改', () => {
  const content = '第一段。第二段。';
  // 摘录对不上
  const miss = docEngine.applyPatches(content, [{ quote: '不存在的句子。', replacement: 'x' }]);
  assert.equal(miss.content, content, '对不上就不动');
  assert.equal(miss.skipped.length, 1);
  // 同一句出现多次，无法确定改哪一处
  const dup = docEngine.applyPatches('重复句。中间。重复句。', [{ quote: '重复句。', replacement: '改了。' }]);
  assert.equal(dup.content, '重复句。中间。重复句。', '出现多次就不动，改错地方比不改更糟');
  assert.equal(dup.skipped.length, 1);
});

test('接缝裁剪：完全重叠裁掉、近似重叠丢首句、无关不动', () => {
  // 完全重叠
  assert.equal(
    docEngine.trimSeam('前面写了很多内容结尾是这样的一句话。', '结尾是这样的一句话。然后继续写新的内容。'),
    '然后继续写新的内容。',
  );
  // 长句重叠
  assert.equal(
    docEngine.trimSeam('样本企业的改造投入从128万元逐年增至298万元。', '样本企业的改造投入从128万元逐年增至298万元。其中第三年增幅最大。'),
    '其中第三年增幅最大。',
  );
  // 近似重叠（换个说法复述末句）→ 丢掉首句
  const near = docEngine.trimSeam(
    '样本企业的改造投入从128万元增至298万元。',
    '样本企业的改造投入从128万元增长到298万元。接下来分析产出。',
  );
  assert.equal(near, '接下来分析产出。');
  // 无关内容不动
  assert.equal(docEngine.trimSeam('前面。', '完全新的内容。'), '完全新的内容。');
});

test('评审修订：有 patches 时走定点修补，不整节重写', async () => {
  const project = docEngine.createProject({ title: '定点修补接线', docType: 'paper', mode: 'auto', depth: 'brief' });
  const draft = '第一段讲背景与研究缺口。第二段说效果显著但没有数据。第三段给出后续安排。';
  docEngine.saveSectionContent(project.id, 1, draft, 'manual');

  const calls = [];
  stubModel((options) => {
    const sys = String(options.messages[0].content || '');
    calls.push(sys);
    if (sys.includes('审稿人')) {
      return JSON.stringify({
        scores: { argument: 10, evidence: 8, structure: 12, terminology: 12, substance: 8, citation: 10 },
        total: 60,
        issues: ['第二段没有数据'],
        mustFix: ['第二段要给出具体数据'],
        patches: [{
          quote: '第二段说效果显著但没有数据。',
          issue: '只说效果显著，没有数据',
          replacement: '第二段引用样本数据：人均产值提升 11.4%。',
        }],
        unanswered: [],
      });
    }
    return '重写后的整节内容，这段不应该被采用。'.repeat(10);
  });

  const fixed = await docEngine.reviewAndFix(docEngine.getProject(project.id), 1, draft, { threshold: 70 });
  assert.equal(fixed.review.fixMode, 'patch', '应当走定点修补');
  assert.equal(fixed.review.patched, 1);
  assert.match(fixed.content, /人均产值提升 11\.4%/, '问题句要被替换');
  assert.ok(fixed.content.startsWith('第一段讲背景与研究缺口。'), '没被指出的段落要原样保留');
  assert.ok(!fixed.content.includes('重写后的整节内容'), '不应该整节重写');
});

test('评审修订：patches 定位不上时退回整节重写', async () => {
  const project = docEngine.createProject({ title: '兜底重写', docType: 'paper', mode: 'auto', depth: 'brief' });
  const draft = '第一段。第二段。';
  docEngine.saveSectionContent(project.id, 1, draft, 'manual');
  const longBody = '这是重写后的正文，内容更长更完整，用于验证兜底路径确实被走到。'.repeat(6);
  stubModel((options) => {
    const sys = String(options.messages[0].content || '');
    if (sys.includes('审稿人')) {
      return JSON.stringify({
        scores: { argument: 8, evidence: 8, structure: 10, terminology: 10, substance: 8, citation: 10 },
        total: 54, issues: ['太短'], mustFix: ['扩写'],
        patches: [{ quote: '这段原文里根本不存在。', issue: 'x', replacement: 'y' }],
        unanswered: [],
      });
    }
    return longBody;
  });
  const fixed = await docEngine.reviewAndFix(docEngine.getProject(project.id), 1, draft, { threshold: 70 });
  assert.equal(fixed.review.fixMode, 'rewrite', '定位不上要退回整节重写');
  assert.ok(fixed.content.includes('这是重写后的正文'));
});

test('续写：提示词带上已讲要点，且接缝重复被裁掉', async () => {
  const project = docEngine.createProject({ title: '续写接缝', docType: 'report', mode: 'co', depth: 'brief' });
  const section = project.sections[0];
  const first = '第一段讲背景，说明这次调研的动因与范围。调研覆盖机械加工、电子组装、食品加工三个细分行业，'
    + '回收有效问卷若干，受访对象以中小企业为主，访谈与问卷结合，尽量覆盖不同规模与地区，以便观察差异。'
    + '样本量虽然有限，但足以支撑对现状的初步判断。';
  const seam = '最后这句是结尾，会被下一段重复一遍。';
  const draft = `${first}\n\n${seam}`;
  const prompts = [];
  stubModel((options) => {
    const sys = String(options.messages[0].content || '');
    const user = String(options.messages[1].content || '');
    prompts.push(user);
    if (sys.includes('段落计划')) return JSON.stringify({ points: ['一'], questions: ['问'], figures: [] });
    // 续写：真实模型最常见的毛病是「先把上文最后一句抄一遍，再往下写」。
    // 桩里也照这个来：从提示词的结尾片段里取出末句，原样复述后再续。
    if (sys.includes('续写')) {
      const matched = user.match(/【已经写到这里（结尾片段）】\n…([\s\S]*?)\n\n【继续写】/);
      const tail = matched ? matched[1] : '';
      const lastSentence = (tail.match(/[^。！？\n]*[。！？]\s*$/) || [''])[0].trim();
      return `${lastSentence}接下来是新的内容，继续推进本节，给出更多细节与判断，并把前文留下的缺口补上。`;
    }
    return draft;
  });

  const result = await docEngine.writeSection(docEngine.getProject(project.id), 1, {});
  const continuation = prompts.filter((text) => text.includes('继续写'));
  assert.ok(continuation.length, '应当发生过续写');
  assert.match(continuation[0], /【已经讲过的要点/, '续写要带上已讲要点，避免绕回去重复');
  // 拼接后重复句只应出现一次
  const occurrences = (result.content.match(/最后这句是结尾/g) || []).length;
  assert.equal(occurrences, 1, '接缝处的重复要被裁掉');
});

// ---------- 真实模型跑出来的四个缺陷（桩测试发现不了，只有真跑才暴露） ----------

test('引用修复：裸编号 M1 补成 [M1]，否则参考文献页会是空的', () => {
  const project = docEngine.createProject({ title: '引用修复', docType: 'paper', mode: 'co' });
  docEngine.addMaterial({
    projectId: project.id, kind: 'literature', title: '甲文献', authors: '张三', year: '2023',
    content: '基于 312 家企业问卷，发现改造投入与人均产值正相关。',
  });
  // 模型实际写出来的样子：M1 裸用，没有方括号
  const raw = 'M1 的研究显示改造投入弹性约为 0.12。本节的 M1 结论一致。';
  const repaired = docEngine.repairCitations(raw, project.id);
  assert.match(repaired, /\[M1\] 的研究显示/);
  assert.equal((repaired.match(/\[M1\]/g) || []).length, 2);
  // 不存在的编号不能被补（避免误伤型号、编号）
  assert.equal(docEngine.repairCitations('M9 型号的设备', project.id), 'M9 型号的设备');
  // 已经是方括号的不要重复加
  assert.equal(docEngine.repairCitations('[M1] 已经正确', project.id), '[M1] 已经正确');
});

test('起草时自动修复引用：正文写裸 M1 也能进参考文献页', async () => {
  const project = docEngine.createProject({ title: '自动修引用', docType: 'paper', mode: 'co', depth: 'brief' });
  docEngine.addMaterial({
    projectId: project.id, kind: 'literature', title: '甲文献', authors: '张三', year: '2023', source: '工业经济 2023(4)',
    content: '基于 312 家企业问卷，发现改造投入与人均产值正相关。',
  });
  stubModel((options) => {
    const sys = String(options.messages[0].content || '');
    if (sys.includes('段落计划')) return JSON.stringify({ points: ['一'], questions: ['问'], figures: [] });
    // 故意写裸编号
    return ('M1 的研究发现改造投入与人均产值正相关，这一点在本节数据中也得到印证。'.repeat(12));
  });
  await docEngine.draftSection(project.id, 1);
  const content = docEngine.getProject(project.id).sections[0].content;
  assert.ok(content.includes('[M1]'), '存下来的正文里必须是方括号编号');
  assert.equal((content.match(/(?<!\[)M1(?!\])/g) || []).length, 0, '不能残留裸编号');
  // 参考文献页要能收到这一条
  assert.equal(docEngine.bibliography(project.id).entries.length, 1);
});

test('数字溯源：「0.1% 的显著性水平」不算无出处数据', () => {
  const project = docEngine.createProject({ title: '显著性水平', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1,
    '系数为 0.046，在 0.1% 的显著性水平上显著（p<0.001）；在 5% 水平上显著。', 'manual');
  const audit = docEngine.auditProject(project.id);
  const issue = audit.issues.find((item) => item.code === 'unbacked-number');
  assert.ok(!issue || !issue.text.includes('0.1%'), '显著性水平不该被当成无出处数据');
  assert.ok(!issue || !issue.text.includes('5%'));
});

test('近似重复：同一节内部的重复也要抓出来', () => {
  const project = docEngine.createProject({ title: '同节重复', docType: 'paper', mode: 'co' });
  const para = 'M1 中指出改造投入与培训投入高度相关，未加区分可能高估设备投入的回报。'
    + '在本研究中，由于样本量较小，难以有效分离出培训投入的独特贡献。';
  docEngine.saveSectionContent(project.id, 1, `${para}\n\n${para}\n\n第三段是新的内容，与前两段没有重叠。`, 'manual');
  const audit = docEngine.auditProject(project.id);
  const issue = audit.issues.find((item) => item.code === 'near-duplicate');
  assert.ok(issue, '同节内两段几乎一样，必须报');
  assert.match(issue.text, /第1节内部两段高度相似/);
});

test('因果表述自相矛盾：一边说条件相关一边说带来提升，要报', () => {
  const project = docEngine.createProject({ title: '因果矛盾', docType: 'paper', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1,
    '本节的结论只能是条件相关，不能读成因果效应。'
    + '但数据显示数字化改造投入的增加能够带来人均产值的提升。', 'manual');
  const audit = docEngine.auditProject(project.id);
  const issue = audit.issues.find((item) => item.code === 'causal-contradiction');
  assert.ok(issue, '自相矛盾必须报');
  assert.match(issue.text, /第1节/);
});

test('评审触发修补：有 mustFix 时即使总分达标也要改', async () => {
  const project = docEngine.createProject({ title: '高分也要修', docType: 'paper', mode: 'auto', depth: 'brief' });
  const draft = '第一段讲背景与研究缺口。第二段说效果显著但没有数据。第三段给出后续安排。';
  docEngine.saveSectionContent(project.id, 1, draft, 'manual');
  stubModel((options) => {
    const sys = String(options.messages[0].content || '');
    if (sys.includes('审稿人')) {
      // 真实模型就是这样：明明列了 mustFix，总分还给 94
      return JSON.stringify({
        scores: { argument: 16, evidence: 12, structure: 16, terminology: 18, substance: 13, citation: 19 },
        total: 94, issues: ['第二段没有数据'], mustFix: ['第二段要给出具体数据'],
        patches: [{ quote: '第二段说效果显著但没有数据。', issue: '缺数据', replacement: '第二段给出数据：提升 11.4%。' }],
        unanswered: [],
      });
    }
    return '不应该走到整节重写。'.repeat(20);
  });
  const fixed = await docEngine.reviewAndFix(docEngine.getProject(project.id), 1, draft, { threshold: 70 });
  assert.equal(fixed.revised, true, '有 mustFix 就必须修订，不能因为分数高就放过');
  assert.equal(fixed.review.fixMode, 'patch');
  assert.match(fixed.content, /提升 11\.4%/);
});

// ---------- 模型胶囊：显示并切换共用渠道 ----------

test('模型胶囊：显示当前渠道模型，与小说工作台读同一份 settings', async () => {
  restoreModel(); // 前面的用例用过桩模型，这里要拿回真实的渠道解析
  // 造两条渠道（与小说工作台共用 settings 的 channels / active_channel）
  const channels = [
    { id: 'ch_a', label: '渠道甲', baseUrl: 'https://a.example/v1', model: 'model-alpha', builtin: false },
    { id: 'ch_b', label: '渠道乙', baseUrl: 'https://b.example/v1', model: 'model-beta', builtin: false },
  ];
  db.run(`INSERT INTO settings(key,value) VALUES('channels',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify(channels));
  db.run(`INSERT INTO settings(key,value) VALUES('channel_key__ch_a','k-a')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  db.run(`INSERT INTO settings(key,value) VALUES('channel_key__ch_b','k-b')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  db.run(`INSERT INTO settings(key,value) VALUES('active_channel','ch_a')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);

  const project = docEngine.createProject({ title: '模型胶囊', docType: 'paper', mode: 'co' });
  const page = await get(`/docs?id=${project.id}&s=1`);
  assert.match(page.text, /class="modelchip"/, '输入条里要有模型胶囊');
  assert.match(page.text, /model-alpha/, '要显示当前渠道的模型名');
  assert.match(page.text, /与小说工作台共用同一套渠道配置/, '要说明与小说工作台共用');
  // 下拉里两条渠道都在
  assert.match(page.text, /name="channelId" value="ch_a"/);
  assert.match(page.text, /name="channelId" value="ch_b"/);

  // 切换后：settings.active_channel 变了，页面跟着变
  const switched = await post('/docs/model', { csrf: TOKEN, projectId: project.id, s: '1', channelId: 'ch_b' });
  assert.equal(switched.status, 303);
  assert.equal(llm.activeChannel().model, 'model-beta', '切换要落到 settings.active_channel');

  const after = await get(`/docs?id=${project.id}&s=1`);
  assert.match(after.text, /model-beta/, '页面要显示新模型');
  assert.ok(!/modelchip__dot"><\/span>model-alpha/.test(after.text), '旧模型不再作为当前显示');
});

test('模型胶囊：没有配置渠道时给出明确提示', async () => {
  restoreModel();
  db.run(`INSERT INTO settings(key,value) VALUES('channels','[]')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
  const project = docEngine.createProject({ title: '无渠道', docType: 'paper', mode: 'co' });
  const page = await get(`/docs?id=${project.id}&s=1`);
  assert.match(page.text, /未配置模型/, '没有渠道时要明确提示，而不是空白');
  assert.match(page.text, /modelchip--empty/);
});

// ---------- 排版规格（蒸馏出的版式） ----------

test('排版规格：归一化把非法值夹回合法范围', () => {
  const layout = require('../lib/doc-layout');
  const spec = layout.normalizeLayout({
    bodySize: 999, lineSpacing: -3, firstLineIndent: 100,
    align: 'diagonal', numbering: 'roman', headingSizes: { 1: 0, 2: 60 },
    bodyFont: '方正兰亭超细黑', titleFont: '<script>',
  });
  assert.equal(spec.bodySize, 42, '字号超上限要夹住');
  assert.equal(spec.lineSpacing, 0.6, '行距负数要夹到下限');
  assert.equal(spec.firstLineIndent, 8, '缩进字符数超上限要夹住');
  assert.equal(spec.align, 'both', '非法对齐要回落');
  assert.equal(spec.numbering, 'chinese', '非法编号规则要回落');
  assert.equal(spec.headingSizes[1], 6, '标题字号下限');
  assert.equal(spec.headingSizes[2], 42, '标题字号上限');
  assert.equal(spec.titleFont, '黑体', '含非法字符的字体名要回落');
  assert.equal(spec.bodyFont, '方正兰亭超细黑', '合法自定义字体要保留');
});

test('排版规格：章节编号规则与已有编号不重复加', () => {
  const layout = require('../lib/doc-layout');
  assert.equal(layout.numberTitle('引言', 1, 'chinese'), '一、引言');
  assert.equal(layout.numberTitle('文献综述', 2, 'chinese'), '二、文献综述');
  assert.equal(layout.numberTitle('引言', 1, 'arabic'), '1. 引言');
  assert.equal(layout.numberTitle('引言', 1, 'none'), '引言', '编号规则为 none 时不加前缀');
  assert.equal(layout.numberTitle('一、引言', 1, 'chinese'), '一、引言', '已自带编号的不重复加');
  assert.equal(layout.numberTitle('第一章 引言', 1, 'chinese'), '第一章 引言', '已自带序数的不重复加');
});

test('排版规格：写入项目、随导出落到 Word 样式表', () => {
  const project = docEngine.createProject({ title: '排版测试', docType: 'paper', mode: 'co' });
  docEngine.setProjectLayout(project.id, {
    bodySize: 10.5, lineSpacing: 1.25, firstLineIndent: 2,
    headingSizes: { 1: 16, 2: 14, 3: 12 }, numbering: 'chinese', bodyFont: '仿宋',
  });
  const reread = docEngine.getProject(project.id);
  assert.equal(reread.layout.bodySize, 10.5);
  assert.equal(reread.layout.bodyFont, '仿宋');

  const { parseZip } = require('../lib/zip');
  const assembled = docEngine.assembleDocx(project.id);
  const entries = parseZip(assembled.buffer);
  const styles = String(entries.find((e) => e.name === 'word/styles.xml').data);
  assert.match(styles, /w:sz w:val="21"/, '正文 10.5 磅 = 21 半磅');
  assert.match(styles, /w:line="300"/, '行距 1.25 倍 = 300 twips');
  assert.match(styles, /eastAsia="仿宋"/, '正文字体要落到样式表');
  assert.match(styles, /w:sz w:val="32"/, '一级标题 16 磅 = 32 半磅');

  const docXml = String(entries.find((e) => e.name === 'word/document.xml').data);
  assert.match(docXml, /一、/, '章节标题按编号规则加了前缀');
});

test('排版规格：页面尺寸与页边距按规格生成', () => {
  const { buildDocx } = require('../lib/docx-export');
  const { parseZip } = require('../lib/zip');
  const buffer = buildDocx({
    title: '页面测试', sections: [{ title: '正文', content: '内容' }],
    layout: { pageSize: 'B5', marginTop: 2, marginBottom: 2, marginLeft: 3, marginRight: 3 },
  });
  const entries = parseZip(buffer);
  const docXml = String(entries.find((e) => e.name === 'word/document.xml').data);
  assert.match(docXml, /w:pgSz w:w="9979" w:h="14175"/, 'B5 纸张尺寸');
  assert.match(docXml, /w:top="1134"/, '2 厘米 = 1134 twips');
  assert.match(docXml, /w:left="1701"/, '3 厘米 = 1701 twips');
});

// ---------- 公式与符号不乱码 ----------

test('Word 公式：OMML 的每个 run 都指定 Cambria Math', () => {
  const { toOmml } = require('../lib/math-tex');
  const omml = toOmml('\\beta_1 = \\frac{\\sum_i x_i}{n} \\leq 0.05');
  const runs = omml.match(/<m:r>[\s\S]*?<\/m:r>/g) || [];
  assert.ok(runs.length >= 5, '应有多段 run');
  for (const run of runs) {
    assert.match(run, /Cambria Math/, '每个 m:r 都要带 Cambria Math 字体，否则符号掉字形');
    assert.match(run, /<w:rPr>[\s\S]*?<m:t/, 'w:rPr 必须排在 m:t 之前（schema 顺序）');
  }
  assert.match(omml, /≤/, '≤ 要保留为真正的数学符号');
});

test('Word 正文符号：希腊字母与关系符单独切段并用数学字体', () => {
  const { buildDocx } = require('../lib/docx-export');
  const { parseZip } = require('../lib/zip');
  const buffer = buildDocx({
    title: '符号测试', sections: [{ title: '结果', content: '系数 β=0.35，p≤0.05，Δ 显著。' }],
  });
  const entries = parseZip(buffer);
  const docXml = String(entries.find((e) => e.name === 'word/document.xml').data);
  // β 与 ≤ 必须各自落在带 Cambria Math 的 run 里
  assert.match(docXml, /<w:rPr><w:rFonts w:ascii="Cambria Math"[^>]*\/><\/w:rPr><w:t xml:space="preserve">β<\/w:t>/);
  assert.match(docXml, /<w:rPr><w:rFonts w:ascii="Cambria Math"[^>]*\/><\/w:rPr><w:t xml:space="preserve">≤<\/w:t>/);
  assert.match(docXml, /<w:t xml:space="preserve">系数 <\/w:t>/, '普通文字不该被切成符号段');
});

test('Word 公式：\\text{} 里的中文用宋体，避免数学字体缺汉字', () => {
  const { toOmml } = require('../lib/math-tex');
  const omml = toOmml('\\text{回收期} = 3.2');
  assert.match(omml, /eastAsia="宋体"/, '含中文的公式 run 要指定东亚字体');
});

test('Word 包结构：settings.xml 存在且声明了数学属性', () => {
  const { buildDocx } = require('../lib/docx-export');
  const { parseZip } = require('../lib/zip');
  const buffer = buildDocx({ title: 'x', sections: [{ title: 'a', content: 'b' }] });
  const entries = parseZip(buffer);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('word/settings.xml'), '要带 settings.xml');
  const settings = String(entries.find((e) => e.name === 'word/settings.xml').data);
  assert.match(settings, /<m:mathFont m:val="Cambria Math"\/>/, '要显式声明数学字体');
  const contentTypes = String(entries.find((e) => e.name === '[Content_Types].xml').data);
  assert.match(contentTypes, /word\/settings\.xml/, 'Content_Types 要注册 settings.xml');
});

// ---------- 图表质量 ----------

test('图表：支持散点图并自动画拟合线', () => {
  const figure = require('../lib/doc-figure');
  const spec = figure.normalizeFigure({
    type: 'scatter', title: '投入与产出', xLabel: '投入', yLabel: '产出',
    series: [{ name: '观测', xs: [1, 2, 3, 4, 5], ys: [2.1, 3.9, 6.2, 7.8, 10.1] }],
  }, 0);
  assert.ok(spec, '散点图应能归一化');
  assert.equal(spec.points.length, 5);
  const svg = figure.figureSvg(spec, { showTitle: false });
  assert.match(svg, /拟合线/, '散点图要带拟合线');
  assert.match(svg, /y =/, '拟合线要给出方程');
  assert.match(svg, /投入/, '要渲染横轴名称');
  assert.match(svg, /产出/, '要渲染纵轴名称');
});

test('图表：直方图自动分箱，带误差线的图保留误差', () => {
  const figure = require('../lib/doc-figure');
  const hist = figure.normalizeFigure({
    type: 'hist', title: '分布', yLabel: '频数',
    series: [{ name: '样本', values: [1, 2, 2, 3, 3, 3, 4, 4, 5, 5, 6, 7] }],
  }, 0);
  assert.ok(hist, '直方图应能归一化');
  assert.ok(hist.categories.length >= 4, '要分箱');
  assert.equal(hist.series[0].values.reduce((a, b) => a + b, 0), 12, '频数总和要等于样本数');

  const err = figure.normalizeFigure({
    type: 'errorbar', title: '均值对比', categories: ['A', 'B', 'C'],
    series: [{ name: '均值', values: [10, 12, 15] }], errors: [1.2, 0.8, 2.0],
  }, 0);
  assert.ok(err, '误差线图应能归一化');
  assert.deepEqual(err.errors, [1.2, 0.8, 2.0]);
  const svg = figure.figureSvg(err, { showTitle: false });
  assert.match(svg, /stroke="#3c4043" stroke-width="1.2"/, '要画出误差线');
});

test('图表：配色色盲友好，且柱状图纵轴从 0 起', () => {
  const figure = require('../lib/doc-figure');
  // Okabe-Ito 的橙与绿要区分得开（旧的网页蓝橙红紫对色觉障碍读者不可分）
  assert.equal(figure.PALETTE[0], '#0072B2');
  assert.ok(figure.PALETTE.includes('#009E73'));
  assert.ok(figure.PALETTE.includes('#D55E00'));
  const chart = figure.chartPartXml({
    no: 1, type: 'bar', title: 't', unit: '', note: '', categories: ['a', 'b'],
    series: [{ name: 's', values: [1, 2] }],
  });
  assert.match(chart, /<c:min val="0"\/>/, '柱状图纵轴必须从 0 起');
});

test('图表：Word 端支持散点图与轴标题', () => {
  const figure = require('../lib/doc-figure');
  const chart = figure.chartPartXml(figure.normalizeFigure({
    type: 'scatter', title: '关系', xLabel: 'X变量', yLabel: 'Y变量',
    series: [{ name: '观测', xs: [1, 2, 3], ys: [2, 4, 5] }],
  }, 0));
  assert.match(chart, /<c:scatterChart>/, '要有散点图类型');
  assert.match(chart, /<c:xVal>/);
  assert.match(chart, /<c:yVal>/);
  assert.match(chart, /X变量/, '要有横轴标题');
  assert.match(chart, /Y变量/, '要有纵轴标题');
});

test('写作计划：图表类型放宽到六种，xLabel/yLabel 落库', () => {
  const craft = require('../lib/doc-craft');
  const figs = craft.figuresOf([
    { type: 'scatter', title: '关系图', xLabel: 'X', yLabel: 'Y',
      series: [{ name: 's', xs: [1, 2, 3], ys: [4, 5, 6] }] },
    { type: 'hist', title: '分布', series: [{ name: 's', values: [1, 2, 3, 4, 5] }] },
    { type: 'errorbar', title: '误差', categories: ['A'], series: [{ name: 's', values: [1] }], errors: [0.5] },
  ], 3);
  assert.equal(figs.length, 3, '三种新图型都要通过校验');
  assert.equal(figs[0].type, 'scatter');
  assert.equal(figs[0].xLabel, 'X');
  assert.deepEqual(figs[0].series[0].xs, [1, 2, 3]);
  assert.equal(figs[1].type, 'hist');
  assert.equal(figs[2].type, 'errorbar');
  assert.deepEqual(figs[2].errors, [0.5]);
});

// ---------- 图表：论文级能力（统计标注 / 堆叠 / 对数轴 / 置信带） ----------

test('图表：散点图必须给出 R² 与样本量，Word 端用原生趋势线', () => {
  const figure = require('../lib/doc-figure');
  const spec = figure.normalizeFigure({
    type: 'scatter', title: '投入与产出', xLabel: '投入', yLabel: '产出',
    series: [{ name: '观测', xs: [1, 2, 3, 4, 5, 6], ys: [2.1, 3.9, 6.2, 7.8, 10.1, 11.9] }],
  }, 0);
  assert.ok(spec.stats, '散点图要算出回归统计量');
  assert.equal(spec.stats.n, 6);
  assert.ok(spec.stats.r2 > 0.98, '这组数据 R² 应接近 1');
  assert.ok(spec.stats.se > 0, '要有残差标准误，置信带才有宽度');

  const svg = figure.figureSvg(spec, { showTitle: false });
  assert.match(svg, /R² = /, '图里要写 R²');
  assert.match(svg, /n = 6/, '图里要写样本量');
  assert.match(svg, /fill-opacity="0.13"/, '要画 95% 置信带');

  // Word 端交给原生趋势线（可双击改类型），我们只额外补一行 n
  const chart = figure.chartPartXml(spec);
  assert.match(chart, /<c:trendline><c:trendlineType val="linear"\/><c:dispRSqr val="1"\/><c:dispEq val="1"\/>/);
  assert.match(chart, /n = 6/);
});

test('图表：堆叠柱、百分比堆叠、对数轴都要真的改变画法', () => {
  const figure = require('../lib/doc-figure');
  const base = {
    type: 'bar', title: '构成', categories: ['2022', '2023'],
    series: [{ name: '硬件', values: [80, 90] }, { name: '软件', values: [20, 30] }],
  };
  const clustered = figure.chartPartXml(figure.normalizeFigure(base, 0));
  assert.match(clustered, /<c:grouping val="clustered"\/>/);

  const stacked = figure.normalizeFigure({ ...base, stacked: true }, 0);
  assert.equal(stacked.stacked, true);
  const stackedXml = figure.chartPartXml(stacked);
  assert.match(stackedXml, /<c:grouping val="stacked"\/>/);
  assert.match(stackedXml, /<c:overlap val="100"\/>/);
  // 堆叠时一根柱子占满整条带，上界按「每列之和」算，不能按最大单值
  assert.match(figure.figureSvg(stacked, { showTitle: false }), /堆叠/);

  const percent = figure.normalizeFigure({ ...base, grouping: 'percent' }, 0);
  assert.equal(percent.percent, true);
  const percentXml = figure.chartPartXml(percent);
  assert.match(percentXml, /<c:grouping val="percentStacked"\/>/);
  assert.match(percentXml, /<c:numFmt formatCode="0%" sourceLinked="0"\/>/, '百分比轴要按百分数显示');

  const logSpec = figure.normalizeFigure({
    type: 'line', title: '规模', logY: true, categories: ['a', 'b', 'c'],
    series: [{ name: 's', values: [3, 120, 9000] }],
  }, 0);
  assert.equal(logSpec.logY, true);
  assert.match(figure.chartPartXml(logSpec), /<c:logBase val="10"\/>/);
  assert.match(figure.figureSvg(logSpec, { showTitle: false }), /纵轴对数刻度/);
});

test('图表：折线置信带画成阴影带，误差线不连成折线', () => {
  const figure = require('../lib/doc-figure');
  const band = figure.normalizeFigure({
    type: 'line', title: '满意度', band: [0.2, 0.3, 0.2], categories: ['Q1', 'Q2', 'Q3'],
    series: [{ name: '满意度', values: [3.8, 3.9, 4.1] }],
  }, 0);
  assert.deepEqual(band.band, [0.2, 0.3, 0.2]);
  const svg = figure.figureSvg(band, { showTitle: false });
  assert.match(svg, /fill-opacity="0.16"/, '置信带要画成半透明阴影');

  // errorbar 是「各组均值对比」：连成折线会暗示一个不存在的趋势
  const err = figure.normalizeFigure({
    type: 'errorbar', title: '均值', categories: ['A', 'B', 'C'],
    series: [{ name: '均值', values: [10, 12, 15] }], errors: [1, 1, 1],
  }, 0);
  const errSvg = figure.figureSvg(err, { showTitle: false });
  assert.ok(!/<path d="M[\d.]+ [\d.]+ L/.test(errSvg), '误差线图不该有连接折线');
});

test('图表：数据标签在点数过多时关闭，避免糊满整张图', () => {
  const figure = require('../lib/doc-figure');
  // 8 类目 × 2 系列 = 16 个数字，标出来会糊满图
  const many = figure.normalizeFigure({
    type: 'bar', title: '多类目',
    categories: Array.from({ length: 8 }, (_, i) => `c${i}`),
    series: [
      { name: 's1', values: [1, 2, 3, 4, 5, 6, 7, 8] },
      { name: 's2', values: [8, 7, 6, 5, 4, 3, 2, 1] },
    ],
  }, 0);
  assert.ok(!/<c:showVal val="1"\/>/.test(figure.chartPartXml(many)), '16 个点不该逐个标数');

  const few = figure.normalizeFigure({
    type: 'bar', title: '少类目', categories: ['a', 'b'],
    series: [{ name: 's', values: [1, 2] }],
  }, 0);
  assert.match(figure.chartPartXml(few), /<c:showVal val="1"\/>/, '2 个类目应该标数');
});

test('图表：chart XML 不能残留模板占位符（会让 Word 丢掉整张图）', () => {
  const figure = require('../lib/doc-figure');
  // 这条是回归测试：crossAx 曾经写在单引号字符串里，${axis2} 原样进了 XML，
  // schema 校验失败 → Word 把柱状图/折线图整张丢弃，只剩题注和一块留白。
  const cases = [
    { type: 'bar', title: 'a', categories: ['x'], series: [{ name: 's', values: [1] }] },
    { type: 'line', title: 'b', categories: ['x'], series: [{ name: 's', values: [1] }] },
    { type: 'bar', title: 'c', stacked: true, categories: ['x'], series: [{ name: 's', values: [1] }, { name: 't', values: [2] }] },
    { type: 'hist', title: 'd', series: [{ name: 's', values: [1, 2, 3, 4] }] },
    { type: 'scatter', title: 'e', series: [{ name: 's', xs: [1, 2, 3], ys: [2, 4, 5] }] },
    { type: 'errorbar', title: 'g', categories: ['a'], series: [{ name: 's', values: [1] }], errors: [0.2] },
  ];
  for (const raw of cases) {
    const xml = figure.chartPartXml(figure.normalizeFigure(raw, 0));
    assert.ok(!xml.includes('${'), `${raw.type} 的 chart XML 里有未替换的占位符`);
    assert.match(xml, /<c:crossAx val="\d+"\/>/, `${raw.type} 的 crossAx 必须是数字`);
  }
  // 饼图没有坐标轴，但同样不能有残留占位符
  const pie = figure.chartPartXml(figure.normalizeFigure({
    type: 'pie', title: 'f', categories: ['a', 'b'], series: [{ name: 's', values: [1, 2] }],
  }, 0));
  assert.ok(!pie.includes('${'));
  assert.match(pie, /<c:pieChart>/);
});

test('图表：没写轴名时不能输出空的 c:title', () => {
  const figure = require('../lib/doc-figure');
  const xml = figure.chartPartXml(figure.normalizeFigure({
    type: 'bar', title: '无轴名', categories: ['a'], series: [{ name: 's', values: [1] }],
  }, 0));
  assert.ok(!xml.includes('<c:title></c:title>'), '空标题框会让图上留一块空白');
});

// ---------- 蒸馏：样例 .docx → 章节目录层级 + 真实版式 ----------
//
// 这几条守的是「蒸馏出来的东西必须等于样例本身」：
// 目录层级、字体字号行距页边距、编号规则，都从 OOXML 里量出来，
// 再由 Word 导出原样还原——中间任何一步靠模型猜，这条链就断了。

test('docx 解析：导出的文档能被原样量回版式与层级', () => {
  const { buildDocx } = require('../lib/docx-export');
  const { probeDocx } = require('../lib/docx-probe');
  const buffer = buildDocx({
    title: '城市更新中的社区参与机制研究',
    front: ['张三　某某大学'],
    sections: [
      { level: 1, title: '引言', content: '这是引言的正文段落，用来测试正文版式能否被正确解析出来。' },
      { level: 2, title: '研究背景', content: '研究背景的正文段落，长度要够，才能进入正文字号与行距的统计。' },
      { level: 2, title: '研究问题', content: '研究问题的正文段落，同样需要足够长度以被识别为正文而不是标题。' },
      { level: 1, title: '研究方法', content: '研究方法的正文段落，继续凑一点字数，方便观察行距与首行缩进。' },
    ],
    layout: {
      bodyFont: '仿宋', bodyFontEn: 'Times New Roman', bodySize: 12, lineSpacing: 1.5,
      firstLineIndent: 2, numbering: 'arabic', marginTop: 3, marginBottom: 2.5,
      marginLeft: 2.8, marginRight: 2.8, headingFont: '黑体',
      headingSizes: { 1: 16, 2: 14, 3: 12 }, titleSize: 20,
    },
  });
  const probed = probeDocx(buffer);
  assert.equal(probed.layout.bodyFont, '仿宋', '正文字体要量出来');
  assert.equal(probed.layout.bodySize, 12, '正文字号要量出来');
  assert.equal(probed.layout.lineSpacing, 1.5, '行距要量出来');
  assert.equal(probed.layout.firstLineIndent, 2, '首行缩进要量出来（写在默认段落样式里）');
  assert.equal(probed.layout.align, 'both', '对齐不能被封面题名带偏');
  assert.equal(probed.layout.headingFont, '黑体');
  assert.equal(probed.layout.headingSizes[2], 14);
  assert.equal(probed.layout.titleSize, 20, '题名字号要单独识别出来');
  assert.equal(probed.layout.marginTop, 3, '页边距要量出来');
  assert.equal(probed.layout.numbering, 'arabic', '编号体例要认出来');
  assert.deepEqual(probed.outline.map((item) => [item.level, item.title]),
    [[1, '引言'], [2, '研究背景'], [2, '研究问题'], [1, '研究方法']], '目录层级要跟样例一致');
  assert.match(probed.text, /^# 1\. 引言$/m, '交给模型的文本要带层级标记');
});

test('docx 解析：不是 docx 的文件给出可读错误', () => {
  const { probeDocx } = require('../lib/docx-probe');
  assert.throws(() => probeDocx(Buffer.from('这只是一段纯文本，不是压缩包')), /docx|ZIP/);
});

test('排版规格：二级/三级编号跟着层级走', () => {
  const layout = require('../lib/doc-layout');
  assert.equal(layout.headingTitle('背景', [1, 1, 0], 'chinese', 2), '（一）背景');
  assert.equal(layout.headingTitle('样本', [1, 1, 2], 'arabic', 3), '1.1.2 样本');
  assert.equal(layout.headingTitle('引言', [2, 0, 0], 'arabic', 1), '2. 引言');
  assert.equal(layout.headingTitle('一、引言', [1, 0, 0], 'chinese', 1), '一、引言', '已自带编号的不重复加');
});

test('目录层级：落库、Markdown 与 Word 都按层级出标题', () => {
  const { parseZip } = require('../lib/zip');
  const project = docEngine.createProject({
    title: '层级测试', docType: 'custom',
    template: '# 引言\n\n引言要求。\n\n## 研究背景\n\n背景要求。\n\n## 研究问题\n\n问题要求。\n\n# 研究方法\n\n方法要求。',
  });
  const reread = docEngine.getProject(project.id);
  assert.deepEqual(reread.sections.map((section) => section.level), [1, 2, 2, 1], '层级要落库');

  const markdown = docEngine.assembleMarkdown(project.id).markdown;
  assert.match(markdown, /^## 引言$/m);
  assert.match(markdown, /^### 研究背景$/m, '二级小节在 Markdown 里也要降一级');

  const entries = parseZip(docEngine.assembleDocx(project.id).buffer);
  const docXml = String(entries.find((entry) => entry.name === 'word/document.xml').data);
  assert.match(docXml, /Heading2/, '二级小节要用 Heading2 样式');
  assert.match(docXml, /一、引言/, '一级节用「一、」');
  assert.match(docXml, /（一）研究背景/, '二级节用「（一）」，不能也顶着「二、」');
});

test('模板：选中已蒸馏模板时目录与版式一起套用', () => {
  const saved = docEngine.saveDocTemplate({
    name: '样例模板', docType: 'report',
    sections: [{ level: 1, title: '引言' }, { level: 2, title: '背景' }],
    layout: { bodyFont: '楷体', bodySize: 11, lineSpacing: 1.75, numbering: 'arabic' },
  });
  const project = docEngine.createProject({ title: '套模板', docType: 'report', templateId: saved.id });
  assert.equal(project.layout.bodyFont, '楷体', '模板的字体要跟着来');
  assert.equal(project.layout.lineSpacing, 1.75);
  assert.equal(project.layout.numbering, 'arabic');
  assert.deepEqual(project.sections.map((section) => [section.level, section.title]),
    [[1, '引言'], [2, '背景']]);

  // 手改过大纲：章节听手改的，版式仍来自模板（作者改结构不等于放弃版式）
  const edited = docEngine.createProject({
    title: '改过大纲', docType: 'report', templateId: saved.id, template: '# 背景与问题\n\n# 方案设计',
  });
  assert.equal(edited.sections.length, 2);
  assert.equal(edited.sections[0].title, '背景与问题');
  assert.equal(edited.layout.bodyFont, '楷体');
});

test('版式卡：页面上可见、可改，改完落到项目', async () => {
  const project = docEngine.createProject({ title: '版式卡', docType: 'report' });
  const page = await get(`/docs?id=${project.id}&s=1`);
  assert.match(page.text, /🎨 版式/, '工作台要有版式卡');
  assert.match(page.text, /正文字体/, '版式要能看能改');

  const saved = await post('/docs/layout', {
    csrf: TOKEN, projectId: project.id, s: '1',
    bodyFont: '楷体', bodySize: '11', lineSpacing: '1.75', firstLineIndent: '2',
    headingFont: '黑体', numbering: 'arabic',
    heading1: '16', heading2: '14', heading3: '12',
    pageSize: 'A4', marginTop: '2.5', marginBottom: '2.5', marginLeft: '3', marginRight: '3',
  });
  assert.equal(saved.status, 303);
  const reread = docEngine.getProject(project.id);
  assert.equal(reread.layout.bodyFont, '楷体');
  assert.equal(reread.layout.bodySize, 11);
  assert.equal(reread.layout.lineSpacing, 1.75);
  assert.equal(reread.layout.numbering, 'arabic');

  // 预览要真的按这套版式渲染：不然作者只能导出 Word 才知道字体有没有生效
  docEngine.saveSectionContent(project.id, 1, '本节正文用于验证预览字体。', 'manual');
  const rendered = await get(`/docs?id=${project.id}&s=1`);
  assert.match(rendered.text, /--doc-body-font/, '正文预览要带版式变量');
  assert.match(rendered.text, /楷体/, '预览字体来自项目版式');
});

test('蒸馏：docx 量出的目录与版式优先于模型猜测', async () => {
  stubModel(() => JSON.stringify({
    title: '模型起的名字', summary: '结构清晰', styleNotes: '短句、数据先行',
    sections: [{ level: 1, title: '模型编的标题', brief: '该节讲清背景与问题', minChars: 800 }],
    layout: { bodyFont: '微软雅黑', bodySize: 10 },
  }));
  try {
    const result = await docEngine.distillDocTemplate({
      name: '', docType: 'report', sample: '样例正文内容。'.repeat(60),
      sampleLayout: { bodyFont: '仿宋', bodySize: 12, lineSpacing: 1.5, numbering: 'arabic' },
      sampleOutline: [{ level: 1, title: '引言' }, { level: 2, title: '研究背景' }],
    });
    assert.deepEqual(result.sections.map((section) => [section.level, section.title]),
      [[1, '引言'], [2, '研究背景']], '目录必须以样例实际结构为准');
    assert.equal(result.sections[0].brief, '该节讲清背景与问题', 'brief 仍由模型补');
    assert.equal(result.layout.bodyFont, '仿宋', '实测字体不能被模型猜的值覆盖');
    assert.equal(result.layout.bodySize, 12);
    assert.equal(result.layout.numbering, 'arabic');
  } finally {
    restoreModel();
  }
});

test('蒸馏：上传 .docx 时走服务端解析，模板拿到真实版式', async () => {
  const { buildDocx } = require('../lib/docx-export');
  stubModel(() => JSON.stringify({
    title: 'docx 模板', summary: '由 docx 蒸馏', styleNotes: '克制的书面语',
    sections: [{ level: 1, title: '占位', brief: '本节要交代研究缘起', minChars: 600 }],
  }));
  try {
    const buffer = buildDocx({
      title: '样例文档',
      sections: [{ level: 1, title: '引言', content: '样例正文内容，用于验证上传解析链路是否走通，并确认正文段落足够长。'.repeat(10) }],
      layout: { bodyFont: '楷体', bodySize: 14, lineSpacing: 2, numbering: 'arabic', marginTop: 3.2 },
    });
    const response = await post('/docs/distill', {
      csrf: TOKEN, name: 'docx 模板', docType: 'report',
      sampleFile: buffer.toString('base64'), fileName: '样例.docx',
    });
    assert.equal(response.status, 200, response.text);
    const data = JSON.parse(response.text);
    assert.equal(data.ok, true);
    assert.match(data.message, /楷体/, '提示里要说明量到了什么字体');

    const template = docEngine.listDocTemplates().find((item) => item.id === data.templateId);
    assert.ok(template, '模板要落库');
    assert.equal(template.layout.bodyFont, '楷体');
    assert.equal(template.layout.bodySize, 14);
    assert.equal(template.layout.lineSpacing, 2);
    assert.equal(template.layout.marginTop, 3.2);
    assert.equal(template.sections[0].title, '引言', '目录来自样例，不是模型编的');
  } finally {
    restoreModel();
  }
});

// ---------- 模板严格沿用：目录、层级、版式、写法、导出 ----------

test('模板沿用：选模板时层级与篇幅不被文本框冲掉', () => {
  const saved = docEngine.saveDocTemplate({
    name: '沿用模板', docType: 'report',
    sections: [
      { level: 1, title: '一、绪论', brief: '交代研究缘起', minChars: 1200 },
      { level: 2, title: '（一）研究背景', brief: '梳理已有研究', minChars: 900 },
      { level: 1, title: '二、方法', brief: '说明方法', minChars: 1500 },
    ],
    layout: { bodyFont: '仿宋', bodySize: 12, lineSpacing: 1.75, numbering: 'chinese' },
    notes: '写法：先给判断再给依据；每段只讲一件事。',
  });
  // 页面选模板时会自动把目录填进文本框，作者顺手改了一个标题
  const project = docEngine.createProject({
    title: '沿用模板稿', docType: 'report', templateId: saved.id,
    template: '# 一、绪论\n\n# 研究背景与问题\n\n# 二、方法',
  });
  assert.equal(project.sections.length, 3);
  assert.equal(project.sections[1].title, '研究背景与问题', '作者改的标题要保留');
  // 层级与篇幅必须来自模板：文本框那份只有标题，层级/篇幅都是默认值
  assert.equal(project.sections[0].level, 1);
  assert.equal(project.sections[2].level, 1);
  assert.ok(project.sections[0].minChars >= 1200, `篇幅下限应来自模板，实际 ${project.sections[0].minChars}`);
  assert.equal(project.layout.bodyFont, '仿宋', '版式来自模板');
  assert.equal(project.layout.lineSpacing, 1.75);
  assert.equal(project.templateNotes, '写法：先给判断再给依据；每段只讲一件事。', '模板写法要存到项目');
});

test('模板沿用：作者另写一套结构时不硬套层级', () => {
  const saved = docEngine.saveDocTemplate({
    name: '结构模板', docType: 'report',
    sections: [{ level: 1, title: 'A', minChars: 800 }, { level: 2, title: 'B', minChars: 600 }],
    layout: { bodyFont: '仿宋' },
  });
  const project = docEngine.createProject({
    title: '换结构', docType: 'report', templateId: saved.id,
    sections: [{ title: '一' }, { title: '二' }, { title: '三' }, { title: '四' }],
  });
  assert.equal(project.sections.length, 4, '作者自己的四节要保留');
  assert.equal(project.sections[3].title, '四');
});

test('模板沿用：写作提示词只要求正文，不再教模型写 Markdown 标题', () => {
  const saved = docEngine.saveDocTemplate({
    name: '提示词模板', docType: 'report',
    sections: [{ level: 1, title: '绪论', minChars: 800 }],
    layout: { bodyFont: '仿宋', numbering: 'chinese' },
    notes: '行文克制，先结论后依据。',
  });
  const project = docEngine.createProject({ title: '提示词稿', docType: 'report', templateId: saved.id });
  const messages = docEngine.buildMessages({ project, idx: 1 });
  assert.match(messages.sys, /模板约束/, '要有模板约束');
  assert.match(messages.sys, /不要输出 Markdown 标题/, '模板模式下不许模型写标题');
  assert.doesNotMatch(messages.sys, /小标题按上述层级用 Markdown/, '不能一边禁止标题一边教它写标题');
  assert.match(messages.sys, /行文克制，先结论后依据/, '模板写法要注入提示词');
});

test('模板沿用：正文里的自造标题与编号行被规范化，不与模板目录打架', () => {
  const docQuality = require('../lib/doc-quality');
  const text = '## 现状分析\n\n一、需求侧\n\n（1）政策因素\n\n1.2 数据说明\n\n1. 这是有序列表项，不该被剥掉编号';
  const out = docQuality.normalizeTemplateBody(text);
  assert.match(out, /\*\*现状分析\*\*/, 'Markdown 标题降级为加粗');
  assert.match(out, /\*\*需求侧\*\*/, '中文编号的标题行要去掉编号');
  assert.match(out, /\*\*数据说明\*\*/, '多层数字编号要去掉编号');
  assert.match(out, /1\. 这是有序列表项/, '单层数字是有序列表，不能剥编号');
  assert.doesNotMatch(out, /一、需求侧/, '原编号不应残留');
});

test('模板沿用：导出的 Word 带目录域，标题层级取自模板', async () => {
  const saved = docEngine.saveDocTemplate({
    name: '导出模板', docType: 'report',
    sections: [{ level: 1, title: '绪论', minChars: 300 }, { level: 2, title: '研究背景', minChars: 300 }],
    layout: { bodyFont: '仿宋', headingFont: '黑体', numbering: 'chinese' },
  });
  const project = docEngine.createProject({ title: '导出稿', docType: 'report', templateId: saved.id });
  docEngine.saveSectionContent(project.id, 1, '一、模型自造的小标题\n\n这是本节的正文内容，用来占位，需要足够长以便导出时形成完整段落。'.repeat(8), 'manual');
  docEngine.saveSectionContent(project.id, 2, '研究背景正文内容，用来占位，需要足够长以便导出时形成完整段落。'.repeat(8), 'manual');
  const assembled = docEngine.assembleDocx(project.id);
  assert.ok(assembled && assembled.buffer.length > 0);
  const zip = require('../lib/zip');
  const entries = zip.parseZip(assembled.buffer);
  const docXml = entries.find((item) => item.name === 'word/document.xml').data.toString('utf8');
  assert.match(docXml, /TOC \\o "1-3"/, '模板绑定文档要有 Word 目录域');
  assert.match(docXml, /Heading2/, '二级模板节要用 Heading2');
  assert.doesNotMatch(docXml, />一、模型自造的小标题/, '正文里的自造编号行应被规范化');
});

test('模板沿用：目录可按模板重新同步，版式可重新套用', () => {
  const saved = docEngine.saveDocTemplate({
    name: '同步模板', docType: 'report',
    sections: [{ level: 1, title: '旧标题', minChars: 700 }],
    layout: { bodyFont: '楷体' },
  });
  const project = docEngine.createProject({ title: '同步稿', docType: 'report', templateId: saved.id });
  // 模板被重新蒸馏：目录与版式都变了
  docEngine.saveDocTemplate({
    id: saved.id, name: '同步模板', docType: 'report',
    sections: [{ level: 1, title: '新标题', minChars: 700 }, { level: 2, title: '新小节', minChars: 500 }],
    layout: { bodyFont: '仿宋', bodySize: 14 },
    notes: '新的写法要求',
  });
  const result = docEngine.reapplyTemplateOutline(project.id);
  assert.equal(result.sections, 2);
  const after = docEngine.getProject(project.id);
  assert.equal(after.sections.length, 2, '小节数随模板补齐');
  assert.equal(after.sections[0].title, '新标题');
  assert.equal(after.sections[1].level, 2, '层级也要跟着刷');
  assert.equal(after.templateNotes, '新的写法要求');
  const reapplied = docEngine.reapplyTemplateLayout(project.id);
  assert.equal(reapplied.layout.bodyFont, '仿宋');
  assert.equal(reapplied.layout.bodySize, 14);
});

test('模板沿用：页面上能看到模板卡（目录 + 写法）与重新同步入口', async () => {
  const saved = docEngine.saveDocTemplate({
    name: '页面模板', docType: 'report',
    sections: [{ level: 1, title: '绪论', minChars: 600 }],
    layout: { bodyFont: '仿宋' },
    notes: '写法要求示例文本',
  });
  const project = docEngine.createProject({ title: '页面稿', docType: 'report', templateId: saved.id });
  const page = await get(`/docs?id=${project.id}&s=1`);
  assert.match(page.text, /📚 模板/, '要有模板卡');
  assert.match(page.text, /页面模板/, '模板名要显示');
  assert.match(page.text, /写法要求示例文本/, '模板的写法要点要能看到');
  assert.match(page.text, /docs\/template\/reapply-outline/, '要有重新同步目录的入口');
  assert.match(page.text, /🔒 随模板/, '版式要显示为锁定');
});

// ---------- 质量基准：把「写得深不深」变成可测的量 ----------
// 这一层解决的问题是：提示词里写「要深入」模型接不住，模型自评又天然偏高。
// 基准用正文里可查的特征（论证层、依据密度、空话、论点兑现）来判断，
// 既能写进提示词当要求，也能进评审当判据，还能进体检当事实。

const benchmarkLib = require('../lib/doc-benchmark');

// 带论点的段落计划：claim 是判断句（不是「提出核心判断」这类动作描述）。
function claimPlanJson() {
  return JSON.stringify({
    targetChars: 800,
    questions: [],
    paragraphs: [
      {
        goal: '指出产能扩张的约束',
        claim: '设备国产化率偏低是产能扩张的主要约束',
        evidence: 'M1 给出的设备进口占比 62%',
        chars: 400, materials: ['M1'],
      },
      {
        goal: '区分替代的层次',
        claim: '中低端替代已经完成而高端仍受制于光刻环节',
        evidence: 'M2 的分环节自给率数据',
        chars: 400, materials: ['M2'],
      },
    ],
  });
}

test('质量基准：论证层数不够时指出缺哪一层', () => {
  // 只有结论与罗列，没有机制、没有对比、没有边界——典型的「写到了但没写透」
  const flat = '数字化转型提升了企业效率。企业应当推进数字化。数字化是当前的重要趋势。';
  const evaluated = benchmarkLib.evaluateSection(flat, { docType: 'paper', depth: 'deep', hasMaterials: false });
  const codes = evaluated.gaps.map((gap) => gap.code);
  assert.ok(codes.includes('layers'), '缺论证层要报出来');
  assert.equal(evaluated.layers['机制'].hit, false);
  assert.ok(evaluated.metrics.layerNeed >= 3, '深入档至少要三层');
  // 层数是启发式判断，不强制重写（误判一次就是一次无谓的整节重写）
  assert.equal(evaluated.forceGaps.some((gap) => gap.code === 'layers'), false);

  // 补上机制与对比后，层数要真的被认出来
  const deep = '设备国产化率偏低是产能扩张的主要约束，原因在于关键环节的进口依赖导致交付周期不可控，'
    + '从而压低了扩产节奏。与同类企业相比，本企业的设备自给率低于行业平均水平约 20 个百分点。'
    + '这一结论在现有产能规模下成立，一旦进入更大规模扩产，约束会转移到资金端。';
  const evaluated2 = benchmarkLib.evaluateSection(deep, { docType: 'paper', depth: 'standard', hasMaterials: false });
  assert.equal(evaluated2.layers['机制'].hit, true);
  assert.equal(evaluated2.layers['对比'].hit, true);
  assert.ok(evaluated2.metrics.layerCount >= 2);
});

test('质量基准：有素材却一处引用都没有，属于硬缺陷', () => {
  const content = '市场规模在过去三年持续扩大，增速保持在较高水平。行业集中度进一步提高，头部企业份额上升。';
  const evaluated = benchmarkLib.evaluateSection(content, { docType: 'paper', hasMaterials: true });
  const gap = evaluated.gaps.find((item) => item.code === 'evidence-density');
  assert.ok(gap, '有素材但没标依据要报出来');
  assert.equal(gap.force, true, '依据缺失是硬缺陷，要驱动修订');

  // 素材为空时不该报这条：没有依据可标，报出来只会制造噪音
  const noMaterial = benchmarkLib.evaluateSection(content, { docType: 'paper', hasMaterials: false });
  assert.equal(noMaterial.gaps.some((item) => item.code === 'evidence-density'), false);

  // 标了编号就不报
  const cited = `${content}（数据来源 [M1]）`;
  const evaluated3 = benchmarkLib.evaluateSection(cited, { docType: 'paper', hasMaterials: true });
  assert.equal(evaluated3.gaps.some((item) => item.code === 'evidence-density'), false);
});

test('质量基准：空话要报，但一处空话不强制重写', () => {
  const one = '随着数字技术的发展，企业开始推进转型。设备国产化率偏低是产能扩张的主要约束，'
    + '原因在于关键环节依赖进口导致交付周期不可控。与同行相比自给率低 20 个百分点。';
  const a = benchmarkLib.evaluateSection(one, { docType: 'report' });
  assert.ok(a.metrics.filler >= 1, '「随着…的发展」要被认成空话');
  assert.equal(a.forceGaps.some((gap) => gap.code === 'filler'), false, '一处空话不值得重写');

  const many = '随着技术的发展，行业不断进步。众所周知，数字化转型具有重要意义。'
    + '在新形势下，企业应当大力推进相关工作。设备国产化率偏低是主要约束。';
  const b = benchmarkLib.evaluateSection(many, { docType: 'report' });
  assert.ok(b.metrics.filler >= 3);
  assert.equal(b.forceGaps.some((gap) => gap.code === 'filler'), true, '通篇空话必须改');
});

test('质量基准：论点—证据对应，计划里说要立的论点没写出来要报', () => {
  const plan = JSON.parse(claimPlanJson());
  const covered = '设备国产化率偏低是产能扩张的主要约束，原因在于关键环节的进口依赖导致交付周期不可控，'
    + '从而压低了扩产节奏（[M1]）。与同行相比，本企业自给率低约 20 个百分点，差距主要来自光刻环节。';
  const partial = benchmarkLib.evaluateSection(covered, {
    plan: { claims: plan.paragraphs.map((item) => ({ goal: item.claim, evidence: item.evidence, materials: item.materials })) },
    docType: 'report', hasMaterials: true,
  });
  const gap = partial.gaps.find((item) => item.code === 'claim-missing');
  assert.ok(gap, '第二个论点没写出来要报');
  assert.equal(gap.force, true);
  assert.equal(partial.metrics.claimTotal, 2);
  assert.equal(partial.metrics.claimCovered, 1);

  // 两个论点都写到了，就没有 claim-missing
  const both = covered + '\n\n中低端替代已经完成，而高端仍受制于光刻环节，分环节自给率数据显示高端不足三成（[M2]）。';
  const full = benchmarkLib.evaluateSection(both, {
    plan: { claims: plan.paragraphs.map((item) => ({ goal: item.claim, evidence: item.evidence, materials: item.materials })) },
    docType: 'report', hasMaterials: true,
  });
  assert.equal(full.gaps.some((item) => item.code === 'claim-missing'), false);
  assert.equal(full.metrics.claimCovered, 2);
});

test('质量基准：动作描述不算论点，不给假缺陷', () => {
  // 「提出本节的核心判断」是写作动作，不是论点。拿它比对正文必然判「没写」，
  // 于是每节都被标缺陷、每节都多跑一轮补写——假缺陷比不检查更有害。
  const plan = { paragraphs: [{ goal: '提出本节的核心判断', materials: [] }, { goal: '给出依据并收束', materials: [] }] };
  assert.equal(docEngine.qualityBenchmark.evaluateClaims('任意正文。', plan).total, 0);
  assert.equal(benchmarkLib.baselineOf('paper', 'standard').minLayers >= 3, true, '论文默认要求三层');
  assert.equal(benchmarkLib.baselineOf('notice', 'deep').minLayers >= 1, true);
});

test('质量基准：写进提示词，写之前就知道验收标准', () => {
  const project = docEngine.createProject({ title: '基准提示词', docType: 'paper', mode: 'co', depth: 'deep' });
  const { sys, user } = docEngine.buildMessages({ project, idx: 1 });
  const all = `${sys}\n${user}`;
  assert.match(all, /【本节质量基准（写完会逐项对照）】/);
  assert.match(all, /论证层数不少于 3 层/);
  assert.match(all, /每千字至少 1 条带编号的依据/);
  // 通知类不需要引用，基准里不能出现依据密度要求（错误的约束就是反向引导）
  const notice = docEngine.createProject({ title: '通知稿', docType: 'notice', mode: 'co' });
  const noticeMsg = docEngine.buildMessages({ project: notice, idx: 1 });
  assert.doesNotMatch(`${noticeMsg.sys}\n${noticeMsg.user}`, /每千字至少/);
});

test('论点—证据：计划阶段产出论点并落库，起草提示词带对照表', async () => {
  const project = docEngine.createProject({ title: '论点落库', docType: 'report', mode: 'co' });
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('段落计划')) return claimPlanJson();
    return longText(21, 900);
  });
  await docEngine.draftSection(project.id, 1);
  const plan = docEngine.getProject(project.id).sections[0].plan;
  assert.equal(plan.claims.length, 2, '论点要随计划一起落库');
  assert.match(plan.claims[0].goal, /设备国产化率偏低/);
  assert.equal(plan.claims[0].materials[0], 'M1');

  // 起草提示词要把「这一段立什么论、用哪条依据」摆出来
  const seen = [];
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    seen.push(`${sys}\n${String(options.messages?.[1]?.content || '')}`);
    if (sys.includes('段落计划')) return claimPlanJson();
    return longText(22, 900);
  });
  await docEngine.draftSection(project.id, 2);
  const prompt = findPrompt(seen, '【本节任务】');
  assert.match(prompt, /【论点—证据对照表/);
  assert.match(prompt, /论点：设备国产化率偏低是产能扩张的主要约束/);
  assert.match(prompt, /依据：M1 给出的设备进口占比 62%/);
});

test('论点—证据：评审提示词把系统检测到的缺口交给评审', async () => {
  const project = docEngine.createProject({ title: '缺口评审', docType: 'report', mode: 'co' });
  // 造一条素材：有素材却完全不标引用，基准会报依据密度不足
  docEngine.addMaterial({ projectId: project.id, title: '行业年报', content: '2025 年行业年报显示：关键设备进口占比 62%，高端环节自给率不足三成，中低端已完成替代。' });
  const seen = [];
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    const user = String(options.messages?.[1]?.content || '');
    if (sys.includes('段落计划')) return claimPlanJson();
    if (sys.includes('期刊审稿人')) {
      seen.push(user);
      return JSON.stringify({
        scores: { argument: 16, evidence: 15, structure: 16, terminology: 17, substance: 15, citation: 18 },
        total: 97, issues: [], mustFix: [],
      });
    }
    return longText(23, 900);
  });
  await docEngine.draftSection(project.id, 1, { review: true });
  const reviewPrompt = findPrompt(seen, '【待评审正文】');
  assert.match(reviewPrompt, /【系统检测到的质量缺口/, '客观缺口要交给评审，避免只凭印象打分');
  assert.match(reviewPrompt, /依据密度不足/);
});

test('多轮深审：分数不涨但缺陷减少时要继续，不能一轮就停', async () => {
  const project = docEngine.createProject({ title: '深审收敛', docType: 'report', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1, longText(31, 900), 'manual');
  let reviewCalls = 0;
  let rewriteCalls = 0;
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    const user = String(options.messages?.[1]?.content || '');
    if (sys.includes('段落计划')) return planJson(900);
    if (sys.includes('期刊审稿人')) {
      reviewCalls += 1;
      // 第一轮 80 分 3 条必修；第二轮 78 分 2 条（分数降了但缺陷少了）；第三轮同上
      const table = [
        { total: 80, mustFix: ['甲', '乙', '丙'] },
        { total: 78, mustFix: ['甲', '乙'] },
        { total: 78, mustFix: ['甲', '乙'] },
      ];
      const pick = table[Math.min(reviewCalls - 1, table.length - 1)];
      return JSON.stringify({
        scores: { argument: 13, evidence: 13, structure: 13, terminology: 13, substance: 13, citation: 13 },
        total: pick.total, issues: [], mustFix: pick.mustFix,
      });
    }
    if (user.includes('评审必须修正')) { rewriteCalls += 1; return longText(32 + rewriteCalls, 900); }
    return longText(31, 900);
  });
  const fresh = docEngine.getProject(project.id);
  const result = await docEngine.reviewAndFix(fresh, 1, fresh.sections[0].content, { maxRounds: 3 });
  assert.equal(reviewCalls, 3, '缺陷在减少时要继续评审，不能因分数不涨就停');
  assert.equal(result.ended, 'regressed');
  assert.equal(result.rounds, 3);
  assert.ok(result.history[1].defects < result.history[0].defects, '缺陷数要真的下降');
});

test('上下文继承：前节已立论点与已用素材进入本节提示词', () => {
  const project = docEngine.createProject({ title: '上下文继承', docType: 'report', mode: 'co' });
  // 第 1 节：有计划（含论点）与正文（含引用编号）
  docEngine.saveSectionContent(project.id, 1, '设备国产化率偏低是产能扩张的主要约束，原因在于进口依赖（[M1]）。', 'manual');
  docEngine.saveSectionContent(project.id, 2, '中低端替代已经完成，高端仍受制于光刻环节（[M2]）。', 'manual');
  // 手工写入第 1 节的计划（模拟已生成的论点链）
  const db2 = require('../lib/db');
  db2.run(`UPDATE doc_sections SET plan_json=? WHERE project_id=? AND idx=?`,
    JSON.stringify({ paragraphs: [{ goal: 'x', chars: 200, materials: [] }], claims: [{ goal: '设备国产化率偏低是产能扩张的主要约束', materials: ['M1'] }] }),
    project.id, 1);

  const fresh = docEngine.getProject(project.id);
  const chain = docEngine.contextChain(fresh.sections, 3);
  assert.match(chain.claims, /第1节已立：设备国产化率偏低是产能扩张的主要约束/);
  assert.match(chain.usedMaterials, /M1/);
  assert.match(chain.usedMaterials, /M2/, '正文里引用过的编号也算已用素材');

  const { user } = docEngine.buildMessages({ project: fresh, idx: 3 });
  assert.match(user, /【前文已立论点（不要重复论证/);
  assert.match(user, /【前文已用过的素材编号/);
});

test('体检：质量基准缺口进报告，并给出基准均分', () => {
  const project = docEngine.createProject({ title: '体检基准', docType: 'paper', mode: 'co' });
  docEngine.addMaterial({ projectId: project.id, title: '行业数据', content: '2025 年行业统计显示：关键设备进口占比 62%，国产化率 38%，高端环节自给率不足三成。' });
  // 通篇空话 + 没有引用：基准要报出来
  docEngine.saveSectionContent(project.id, 1,
    '随着技术的发展，行业不断进步。众所周知，数字化转型具有重要意义。在新形势下，企业应当大力推进相关工作。', 'manual');
  const audit = docEngine.auditProject(project.id);
  const codes = audit.issues.map((issue) => issue.code);
  assert.ok(codes.some((code) => String(code).startsWith('quality-')), '基准缺口要进体检');
  assert.equal(typeof audit.summary.qualityScore, 'number');
  assert.equal(audit.summary.qualityTotal, 1);
  assert.ok(Array.isArray(audit.baseline) && audit.baseline[0].metrics, '体检要带每节的基准明细');
});

test('页面：质量基准卡能看到论证层与缺口', async () => {
  const project = docEngine.createProject({ title: '基准页', docType: 'paper', mode: 'co' });
  docEngine.addMaterial({ projectId: project.id, title: '行业数据', content: '2025 年行业统计显示：关键设备进口占比 62%，国产化率 38%，高端环节自给率不足三成。' });
  docEngine.saveSectionContent(project.id, 1,
    '随着技术的发展，行业不断进步。众所周知，数字化转型具有重要意义。在新形势下，企业应当大力推进相关工作。', 'manual');
  // 先跑一次评审，把基准结果落到 review_json（页面读的是这份）
  const fresh = docEngine.getProject(project.id);
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('期刊审稿人')) {
      return JSON.stringify({
        scores: { argument: 14, evidence: 12, structure: 15, terminology: 16, substance: 12, citation: 16 },
        total: 85, issues: [], mustFix: [],
      });
    }
    return longText(41, 600);
  });
  await docEngine.reviewAndFix(fresh, 1, fresh.sections[0].content, { maxRounds: 1 });
  restoreModel();
  const page = await get(`/docs?id=${project.id}&s=1`);
  assert.match(page.text, /📐 质量基准/, '页面上要有质量基准卡');
  assert.match(page.text, /论证层/, '要显示论证层数');
  assert.match(page.text, /每千字依据/, '要显示依据密度');
});

test('段落计划：目标字数不得低于篇幅下限（否则提示词自相矛盾）', async () => {
  const project = docEngine.createProject({ title: '目标字数', docType: 'paper', mode: 'co', depth: 'deep' });
  // 模型给了一个偏小的目标字数：深度档位算出的下限更高，两者不能同时出现在提示词里
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('段落计划')) {
      return JSON.stringify({
        targetChars: 300,
        paragraphs: [{ goal: '给出判断', chars: 150, materials: [] }, { goal: '给出依据', chars: 150, materials: [] }],
      });
    }
    return longText(51, 900);
  });
  await docEngine.draftSection(project.id, 1);
  const plan = docEngine.getProject(project.id).sections[0].plan;
  const minChars = docEngine.sectionMinChars(docEngine.getProject(project.id).sections[0]);
  assert.ok(plan.targetChars >= minChars, `目标字数 ${plan.targetChars} 不得低于下限 ${minChars}`);
});

// ---------- 文档上下文引擎：百万字语料 + 分层预算 ----------
// 这一层解决的是「素材十万字、上下文两千字」：不是模型不会写，是它只看到 2% 的证据。
// 做法是语料全量索引、每节按需检索、按预算装配——语料可以到百万字，提示词仍然有界。

const docContext = require('../lib/doc-context');

// 造一条「主题 + 独有事实 + 大量填充」的素材：填充让语料变大，独有事实用于验证检索是否命中。
function corpusMaterial(topic, index, paragraphs = 30) {
  const filler = '本节围绕产业现状展开描述，涉及产能、投资、区域分布与政策环境等方面的一般性说明。';
  const parts = [];
  for (let i = 0; i < paragraphs; i++) parts.push(`第${i + 1}段：${filler.repeat(3)}`);
  const fact = `关键数据：${topic}领域 2025 年关键设备进口占比 ${50 + index}%，国产化率 ${50 - index}%，该口径来自本年度行业统计。`;
  parts.splice(Math.floor(paragraphs / 2), 0, fact);
  return { content: parts.join('\n\n'), fact };
}

test('上下文：百万字语料能建索引，且增量同步不重建未变更素材', () => {
  const project = docEngine.createProject({ title: '百万语料', docType: 'paper', mode: 'co' });
  const topics = ['光伏装备', '动力电池', '工业软件', '精密机床', '半导体材料'];
  let chars = 0;
  for (let i = 0; i < 20; i++) {
    const topic = topics[i % topics.length];
    const { content } = corpusMaterial(topic, i, 60);
    chars += content.length;
    docEngine.addMaterial({ projectId: project.id, title: `${topic}年报${i}`, kind: 'data', content });
  }
  assert.ok(chars > 100000, `语料要足够大才有意义，实际 ${chars}`);

  const first = docContext.syncCorpus(project.id);
  assert.ok(first.chunks > 100, `应切出上百块，实际 ${first.chunks}`);
  assert.equal(first.rebuilt, 20);

  // 没改素材：一块都不该重建（百万字重建一次要切几千块、算几千个向量）
  const again = docContext.syncCorpus(project.id);
  assert.equal(again.rebuilt, 0, '未变更的素材不得重建');
  assert.equal(again.skipped, 20);

  const stats = docContext.corpusStats(project.id);
  assert.equal(stats.materials, 20);
  // 索引字数按「切块后去空白」统计，比原文略少（段落之间的空行不计入）
  assert.ok(stats.chars > chars * 0.9, `索引字数 ${stats.chars} 应接近原文 ${chars}`);
});

test('上下文：百万字语料里能检索到「只出现一次」的关键数据', () => {
  const project = docEngine.createProject({
    title: '检索命中', docType: 'paper', mode: 'co',
    thesis: '装备国产化是产业升级的主要约束',
  });
  // 30 条素材，每条一个独有事实；只有「精密机床」这条与本节相关
  for (let i = 0; i < 30; i++) {
    const topic = i === 17 ? '精密机床' : `行业${i}`;
    const { content } = corpusMaterial(topic, i, 40);
    docEngine.addMaterial({ projectId: project.id, title: `${topic}年报`, kind: 'data', content });
  }
  const fresh = docEngine.getProject(project.id);
  // 本节论点是「精密机床高端自给率不足」，检索要能定位到第 17 条
  const plan = {
    claims: [{ goal: '精密机床领域高端设备自给率不足三成是产能扩张的主要约束', evidence: '进口占比与自给率', materials: [] }],
    questions: ['精密机床环节的进口依赖集中在哪几个细分品类？'],
  };
  const pack = docContext.buildContext(fresh, 2, { plan });
  assert.ok(pack.text.length > 3000, '上下文不能只有几百字');
  assert.match(pack.text, /精密机床领域 2025 年关键设备进口占比 67%/, '独有事实必须被检索到（50+17=67）');
  assert.ok(pack.stats.items >= 1);
});

test('上下文：装配结果有界，不随语料增长而线性膨胀', () => {
  const small = docEngine.createProject({ title: '小语料', docType: 'report', mode: 'co' });
  docEngine.addMaterial({ projectId: small.id, title: '小样本', kind: 'data', content: corpusMaterial('光伏装备', 1, 30).content });
  const smallPack = docContext.buildContext(docEngine.getProject(small.id), 1, {});

  const big = docEngine.createProject({ title: '大语料', docType: 'report', mode: 'co' });
  for (let i = 0; i < 40; i++) {
    docEngine.addMaterial({ projectId: big.id, title: `年报${i}`, kind: 'data', content: corpusMaterial('光伏装备', i, 40).content });
  }
  const bigPack = docContext.buildContext(docEngine.getProject(big.id), 1, {});
  const budget = docContext.budgetFor('report', 'standard');

  assert.ok(bigPack.stats.chars > smallPack.stats.chars * 3, '大语料的原始规模要真的更大');
  assert.ok(bigPack.stats.contextChars <= budget.total * 1.25,
    `上下文必须受预算约束：${bigPack.stats.contextChars} vs 预算 ${budget.total}`);
  assert.ok(bigPack.stats.contextChars < 26000, '单节上下文不该超过约 2.6 万字');
  // 语料规模与上下文规模是两个数：前者可以很大，后者必须有界
  assert.ok(bigPack.stats.chars > bigPack.stats.contextChars, '语料字数应大于本节注入字数');
});

test('上下文：语料地图列出未命中的素材，让模型知道自己还有什么没用', () => {
  const project = docEngine.createProject({ title: '地图', docType: 'report', mode: 'co' });
  docEngine.addMaterial({ projectId: project.id, title: '冷链物流年报', kind: 'data', content: corpusMaterial('冷链物流', 3, 20).content });
  docEngine.addMaterial({ projectId: project.id, title: '生物医药年报', kind: 'data', content: corpusMaterial('生物医药', 4, 20).content });
  const fresh = docEngine.getProject(project.id);
  const pack = docContext.buildContext(fresh, 1, {});
  assert.match(pack.text, /【语料地图/, '要有语料地图');
  assert.match(pack.text, /已命中|未命中/, '要标出每条素材是否被本节用到');
  assert.match(pack.text, /重点用 M\d/, '要告诉作者怎么强制指定素材');
});

test('上下文：作者在「本节要求」里点名 M 编号，该素材被强制纳入', () => {
  const project = docEngine.createProject({ title: '指定素材', docType: 'report', mode: 'co' });
  for (let i = 0; i < 6; i++) {
    docEngine.addMaterial({ projectId: project.id, title: `素材${i}`, kind: 'data', content: corpusMaterial(`行业${i}`, i, 20).content });
  }
  // 把第 5 条（M5）点名为必用：检索不一定命中它，但作者要它
  const db3 = require('../lib/db');
  db3.run(`UPDATE doc_sections SET brief=? WHERE project_id=? AND idx=?`,
    '只写行业无关内容，重点用 M5', project.id, 2);
  const fresh = docEngine.getProject(project.id);
  const pack = docContext.buildContext(fresh, 2, {});
  assert.ok(pack.stats.forced >= 1, '被点名的素材要被强制纳入');
  assert.match(pack.text, /其中 \d+ 条为作者指定/);
  assert.match(pack.text, /行业4领域 2025 年关键设备进口占比 54%/, 'M5 的独有事实必须在上下文里（50+4=54）');
});

test('上下文：文档记忆给前节论点与已用数据，且长度不随节数膨胀', () => {
  const project = docEngine.createProject({ title: '记忆', docType: 'report', mode: 'co' });
  const db4 = require('../lib/db');
  for (let idx = 1; idx <= 6; idx++) {
    docEngine.saveSectionContent(project.id, idx, `第${idx}节正文，设备进口占比 ${60 + idx}%，与同行相比自给率偏低。`, 'manual');
    db4.run(`UPDATE doc_sections SET plan_json=? WHERE project_id=? AND idx=?`,
      JSON.stringify({ claims: [{ goal: `第${idx}节的核心论点：高端环节仍受制于核心设备`, materials: [] }] }),
      project.id, idx);
  }
  const fresh = docEngine.getProject(project.id);
  const memory = docContext.documentMemory(fresh, 7, { maxChars: 3000 });
  assert.match(memory, /前文已立论点/);
  assert.match(memory, /第6节的核心论点/);
  assert.match(memory, /前文已用过的数据/);
  assert.ok(memory.length <= 3000, '记忆长度必须有上限，否则节数一多就吃掉全部预算');

  // 前 6 节只留最近 8 条论点：再多也不该无限增长
  const long = docContext.documentMemory(fresh, 7, { maxChars: 3000 });
  assert.ok(long.split('\n').length < 30);
});

test('上下文：素材删除后语料索引同步清理，不会引用到不存在的编号', () => {
  const project = docEngine.createProject({ title: '删除清理', docType: 'report', mode: 'co' });
  const added = docEngine.addMaterial({ projectId: project.id, title: '待删素材', kind: 'data', content: corpusMaterial('氢能储运', 2, 20).content });
  docContext.syncCorpus(project.id);
  assert.ok(docContext.corpusStats(project.id).chunks > 0);
  docEngine.removeMaterial({ projectId: project.id, id: added.id });
  assert.equal(docContext.corpusStats(project.id).chunks, 0, '素材删了，语料块也要删');
});

test('上下文：小说工作台的检索链路完全不受影响', () => {
  const vectorStore = require('../lib/vector-store');
  // 文档侧只借了 vectorFor / estimateTokens 两个纯函数，不该改动小说的引擎标识与检索入口
  assert.equal(vectorStore.ENGINE, 'local-hybrid-scene-v2', '小说检索引擎标识不能被文档侧改掉');
  assert.equal(typeof vectorStore.retrieve, 'function');
  assert.equal(typeof vectorStore.syncBook, 'function');
  // 文档语料表独立存在，不写 kb_chunks
  const db5 = require('../lib/db');
  const project = docEngine.createProject({ title: '隔离', docType: 'report', mode: 'co' });
  docEngine.addMaterial({ projectId: project.id, title: '隔离素材', kind: 'data', content: corpusMaterial('工业软件', 5, 20).content });
  docContext.syncCorpus(project.id);
  const kb = db5.one(`SELECT COUNT(*) AS n FROM kb_chunks WHERE book_id=?`, project.id);
  assert.equal(Number(kb.n), 0, '文档语料不得写进小说的 kb_chunks');
});

test('上下文：内容高度重复的素材不会占满预算（多份年报收同一段话）', () => {
  const project = docEngine.createProject({ title: '重复语料', docType: 'report', mode: 'co' });
  // 同一段内容收 5 份（真实场景：同一份年报的多个版本、论文的预印本与正式版）
  const same = corpusMaterial('光伏装备', 2, 30).content;
  for (let i = 0; i < 5; i++) {
    docEngine.addMaterial({ projectId: project.id, title: `同一份年报v${i}`, kind: 'data', content: same });
  }
  // 另有一条不同主题，必须还能被看到
  docEngine.addMaterial({ projectId: project.id, title: '冷链物流年报', kind: 'data', content: corpusMaterial('冷链物流', 9, 30).content });

  const fresh = docEngine.getProject(project.id);
  const pack = docContext.buildContext(fresh, 1, {});
  assert.ok(pack.stats.deduped > 0, '重复内容要被识别出来');
  assert.match(pack.text, /高度重复未重复注入/, '要说明为什么预算没用满');
  // 去重后不应把 5 份一模一样的内容全塞进来
  const occurrences = (pack.text.match(/光伏装备领域 2025 年关键设备进口占比 52%/g) || []).length;
  assert.ok(occurrences <= 2, `同一事实最多出现 2 次，实际 ${occurrences}`);
});

// ---------- 上下文引擎的四个真实缺陷（都是先踩到才补的） ----------

// 主题互不重叠的多样语料：验证「相关素材进得来、无关素材进不来」。
function diverseMaterial(projectId, topic, words, index, paragraphs = 24) {
  const parts = [];
  for (let i = 0; i < paragraphs; i++) {
    const word = words[i % words.length];
    parts.push(`第${i + 1}段：围绕${topic}的${word}展开讨论，涉及工艺参数、供应链配套、检测方法与产线改造投入，具体结论需结合企业实际工况判断。`);
  }
  parts.splice(Math.floor(paragraphs / 2), 0,
    `关键数据：${topic}领域 2025 年${words[0]}环节进口依赖度 ${40 + index}%，国产化率 ${60 - index}%，与上年相比下降 ${2 + (index % 5)} 个百分点。`);
  return docEngine.addMaterial({
    projectId, title: `${topic}专题材料（${index}）`, kind: 'data', content: parts.join('\n\n'),
  });
}

test('上下文：模板句相同的无关主题不会被塞进本节（稀有词门槛）', () => {
  const project = docEngine.createProject({
    title: '稀有词门槛', docType: 'paper', mode: 'co', depth: 'deep',
    thesis: '装备国产化是产业升级的关键约束',
  });
  // 六类主题共用同一套模板句，只有主题词与数据不同——真实公文的常见形态
  const domains = [
    ['光伏装备', ['硅片切割良率', '单晶炉', '逆变器']],
    ['动力电池', ['正极材料', '隔膜涂覆', '热失控']],
    ['工业软件', ['CAE 求解器', '几何内核', '求解精度']],
    ['精密机床', ['五轴联动机床', '主轴热变形', '丝杠精度']],
    ['半导体材料', ['光刻胶', '大硅片', '电子特气']],
    ['冷链物流', ['冷库能耗', '断链率', '冷藏车温控']],
  ];
  for (let i = 0; i < 18; i++) {
    const [topic, words] = domains[i % domains.length];
    diverseMaterial(project.id, topic, words, i);
  }
  const db6 = require('../lib/db');
  db6.run(`UPDATE doc_sections SET plan_json=? WHERE project_id=? AND idx=?`, JSON.stringify({
    claims: [
      { goal: '精密机床五轴联动环节进口依赖度偏高是产能扩张的主要约束', evidence: '进口依赖度', materials: [] },
      { goal: '光刻胶与电子特气的国产化进度落后于硅片环节', evidence: '分环节国产化率', materials: [] },
    ],
    questions: ['精密机床的定位重复性指标差距有多大？'],
  }), project.id, 5);

  const fresh = docEngine.getProject(project.id);
  const pack = docContext.buildContext(fresh, 5, { plan: fresh.sections[4].plan });

  assert.match(pack.text, /精密机床领域 2025 年五轴联动机床环节进口依赖度 \d+%/, '相关主题必须命中');
  assert.match(pack.text, /半导体材料领域 2025 年光刻胶环节进口依赖度 \d+%/, '第二个论点对应的主题也要命中');
  // 模板句让所有段落文字相似，但主题无关的不该进「证据」区。
  // 注意：语料地图会列出全部素材（这是设计如此，让模型知道自己还有什么没用），
  // 所以只能检查证据段，不能对全文做否定断言。
  const evidence = pack.text.split('【语料地图')[0];
  assert.doesNotMatch(evidence, /冷链物流/, '完全无关的主题不能混进本节证据');
  assert.doesNotMatch(evidence, /工业软件/, '无关主题也不能混进本节证据');
});

test('上下文：同模板但数据不同的素材不能算重复（去重不能吞掉事实）', () => {
  const project = docEngine.createProject({ title: '模板不同数据', docType: 'report', mode: 'co' });
  const template = '年度统计显示：关键设备进口依赖度较高，国产化率仍有提升空间，行业整体处于替代进程中。';
  docEngine.addMaterial({
    projectId: project.id, title: '甲厂年报', kind: 'data',
    content: `${template}\n\n关键数据：精密机床领域 2025 年进口依赖度 62%，国产化率 38%，较上年下降 3 个百分点。`,
  });
  docEngine.addMaterial({
    projectId: project.id, title: '乙厂年报', kind: 'data',
    content: `${template}\n\n关键数据：精密机床领域 2025 年进口依赖度 71%，国产化率 29%，较上年下降 1 个百分点。`,
  });
  const fresh = docEngine.getProject(project.id);
  const pack = docContext.buildContext(fresh, 2, {});
  // 两段模板相同、数据不同：两份数据都必须保留，否则等于丢了一半事实
  assert.match(pack.text, /进口依赖度 62%/, '甲厂数据要保留');
  assert.match(pack.text, /进口依赖度 71%/, '乙厂数据也要保留——模板相同不代表内容重复');
});

test('上下文：评审看到的素材编号是全部素材，不是检索到的那几条', async () => {
  const project = docEngine.createProject({ title: '评审编号范围', docType: 'paper', mode: 'co' });
  // 12 条素材：起草时只会检索到少数几条，但正文可能引到任意一条
  for (let i = 0; i < 12; i++) {
    docEngine.addMaterial({
      projectId: project.id, title: `材料${i}`, kind: 'data',
      content: `第${i}份材料：围绕装备国产化的工艺参数与检测方法展开说明，结论需结合企业工况判断，涉及产线改造投入与供应链配套。`,
    });
  }
  const seen = [];
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    const user = String(options.messages?.[1]?.content || '');
    if (sys.includes('段落计划')) return planJson(800);
    if (sys.includes('期刊审稿人')) {
      seen.push(user);
      return JSON.stringify({
        scores: { argument: 17, evidence: 16, structure: 17, terminology: 17, substance: 16, citation: 19 },
        total: 102, issues: [], mustFix: [],
      });
    }
    return longText(61, 900);
  });
  await docEngine.draftSection(project.id, 1, { review: true });
  const prompt = findPrompt(seen, '【待评审正文】');
  // 素材编号是 [M1]..[M12]，评审必须知道全部合法编号
  assert.match(prompt, /M12/, '第 12 条素材的编号也要在评审的可用清单里');
  assert.match(prompt, /【可用素材编号】/);
});

test('上下文：用量落库并在页面上可见（否则能力是隐形的）', async () => {
  const project = docEngine.createProject({ title: '上下文可见', docType: 'report', mode: 'co' });
  docEngine.addMaterial({
    projectId: project.id, title: '行业年报', kind: 'data',
    content: corpusMaterial('光伏装备', 4, 24).content,
  });
  stubModel((options) => {
    const sys = String(options.messages?.[0]?.content || '');
    if (sys.includes('段落计划')) return planJson(900);
    return longText(62, 900);
  });
  await docEngine.draftSection(project.id, 1);
  restoreModel();

  const fresh = docEngine.getProject(project.id);
  const ctx = fresh.sections[0].context;
  assert.ok(ctx, '上下文用量要落库');
  assert.ok(ctx.corpusChars > 1000, `语料字数要记下来，实际 ${ctx.corpusChars}`);
  assert.ok(ctx.contextChars > 1000, '注入字数要记下来');
  assert.ok(Array.isArray(ctx.keys) && ctx.keys.length >= 1, '用了哪几条素材要记下来');
  assert.ok(ctx.budget && ctx.budget.evidence > 0, '预算要记下来');

  const page = await get(`/docs?id=${project.id}&s=1`);
  assert.match(page.text, /🧠 本节上下文/, '页面上要能看到本节读了什么');
  assert.match(page.text, /注入 \d/, '要显示注入字数');
});

test('上下文：语料同步可以在外层事务里调用（事务可重入）', () => {
  const db7 = require('../lib/db');
  const project = docEngine.createProject({ title: '事务重入', docType: 'report', mode: 'co' });
  docEngine.addMaterial({ projectId: project.id, title: '素材', kind: 'data', content: corpusMaterial('工业软件', 1, 20).content });
  // 语料同步内部用了事务；被包在别的事务里时不能抛
  // 「cannot start a transaction within a transaction」
  let result = null;
  db7.transaction(() => {
    result = docContext.syncCorpus(project.id);
  });
  assert.ok(result && result.chunks > 0, '外层事务里调用语料同步必须成功');
});

test('上下文：一节有两个主题时，少数派主题不会被挤出候选池', () => {
  // 结构性缺陷：把整节压成一条混合查询向量时，权重高的论点会占满候选池，
  // 权重低的必答问题一条都进不来——稿子只回答一半问题，评审还以为「素材里没有」。
  const project = docEngine.createProject({
    title: '多主题覆盖', docType: 'paper', mode: 'co', depth: 'deep',
    thesis: '装备国产化是产业升级的关键约束',
  });
  // 同一套填充段落（真实年报常见），只有主题词与数据不同
  const filler = '本节围绕产业现状展开描述，涉及产能、投资、区域分布与政策环境等方面的一般性说明。';
  const topics = ['精密机床', '半导体材料', '光伏装备', '冷链物流'];
  for (let i = 0; i < 24; i++) {
    const topic = topics[i % topics.length];
    const parts = [];
    for (let j = 0; j < 60; j++) parts.push(`第${j + 1}段：${filler.repeat(2)}`);
    parts.splice(30, 0,
      `关键数据：${topic}领域 2025 年关键设备进口占比 ${50 + i}%，国产化率 ${50 - i}%，该口径来自本年度行业统计。`);
    docEngine.addMaterial({ projectId: project.id, title: `${topic}年报${i}`, kind: 'data', content: parts.join('\n\n') });
  }
  const db8 = require('../lib/db');
  db8.run(`UPDATE doc_sections SET plan_json=? WHERE project_id=? AND idx=?`, JSON.stringify({
    // 论点只讲精密机床；必答问题却问半导体材料——典型的两主题小节
    claims: [{ goal: '精密机床领域高端设备自给率不足三成是产能扩张的主要约束', evidence: '进口占比', materials: [] }],
    questions: ['半导体材料环节的进口依赖集中在哪几个细分品类？'],
  }), project.id, 5);

  const fresh = docEngine.getProject(project.id);
  const pack = docContext.buildContext(fresh, 5, { plan: fresh.sections[4].plan });
  const evidence = pack.text.split('【语料地图')[0];
  assert.match(evidence, /精密机床领域 2025 年关键设备进口占比 \d+%/, '论点主题要有证据');
  assert.match(evidence, /半导体材料领域 2025 年关键设备进口占比 \d+%/, '必答问题的主题也要有证据');
});

test('全托管：手动停止在下一节边界生效，已完成小节保留', async () => {
  const project = docEngine.createProject({
    title: '取消测试', docType: 'report', mode: 'auto',
    template: '# 摘要\n概括。\n\n# 背景与调研方法\n方法。\n\n# 现状分析\n现状。\n\n# 结论\n结论。',
  });
  let calls = 0;
  stubModel(() => {
    calls += 1;
    // 第 1 节起草时请求停止：本节照常落盘，下一节开始前停下。
    if (calls === 1) docEngine.cancelDocRun({ projectId: project.id });
    return longText(calls, 600);
  });
  const result = await docEngine.generateDocProject({ projectId: project.id, maxRetries: 1, retryBaseDelayMs: 1 });
  restoreModel();

  assert.equal(result.runStatus, 'cancelled');
  assert.deepEqual(result.created, [1], '仅完成请求停止前正在写的那一节');
  assert.equal(orch.getRun(result.runId).status, 'cancelled');
  assert.equal(docEngine.getProject(project.id).status, 'cancelled');
});

test('版本历史：覆盖保存留旧版，可恢复到任一版且恢复本身可撤回', async () => {
  const project = docEngine.createProject({ title: '版本历史稿', docType: 'report', mode: 'co' });
  docEngine.saveSectionContent(project.id, 1, '第一版正文。', 'ai-draft');
  docEngine.saveSectionContent(project.id, 1, '第二版正文。', 'ai-polish');

  const versions = docEngine.listSectionVersions(project.id, 1);
  assert.equal(versions.length, 1, '首次覆盖只留一版旧正文');
  assert.equal(versions[0].source, 'ai-draft', '版本记录的是旧正文的来源');
  assert.equal(versions[0].chars, '第一版正文。'.length);

  const page = await get(`/docs?id=${project.id}&s=1`);
  assert.equal(page.status, 200);
  assert.match(page.text, /版本历史/);
  assert.match(page.text, /恢复到这一版/);

  const res = await post('/docs/section/restore', {
    csrf: TOKEN, projectId: project.id, idx: 1, versionId: versions[0].id,
  });
  assert.equal(res.status, 303);
  assert.equal(docEngine.getProject(project.id).sections[0].content, '第一版正文。');
  const after = docEngine.listSectionVersions(project.id, 1);
  assert.equal(after.length, 2, '恢复前的第二版也要留档，恢复可以再撤回');
  assert.equal(after[0].source, 'ai-polish');

  // 再恢复回第二版
  docEngine.restoreSectionVersion(project.id, 1, after[0].id);
  assert.equal(docEngine.getProject(project.id).sections[0].content, '第二版正文。');

  // 内容没变的保存不产生噪声版本
  const before = docEngine.listSectionVersions(project.id, 1).length;
  docEngine.saveSectionContent(project.id, 1, '第二版正文。', 'manual');
  assert.equal(docEngine.listSectionVersions(project.id, 1).length, before);

  // 删除项目时版本一并清理
  docEngine.deleteProject(project.id);
  assert.equal(docEngine.listSectionVersions(project.id, 1).length, 0);
});
