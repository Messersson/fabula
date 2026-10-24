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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
});

function stubModel(handler) {
  llm.activeChannel = () => ({ baseUrl: 'http://stub.local', key: 'stub', model: 'stub-model' });
  llm.chatCompletion = async function* (options) {
    const text = handler(options);
    yield { type: 'delta', text };
    yield { type: 'meta', usage: { prompt_tokens: 7, completion_tokens: 13 }, finishReason: 'stop' };
  };
}

async function post(pathname, fields) {
  const body = new URLSearchParams(fields).toString();
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
  assert.ok(seen[0].includes('调研报告'), '提示词必须带文档类型文体卡');
  assert.ok(seen[0].includes('社区养老调研'), '提示词必须带项目说明');
  assert.ok(seen[0].includes('【全文结构】'), '提示词必须带全文结构');

  await docEngine.reviseSection(project.id, 1, '语气更克制');
  fresh = docEngine.getProject(project.id);
  assert.equal(fresh.sections[0].source, 'ai-revise');
  assert.ok(seen.at(-1).includes('语气更克制'), '修改指示必须进入提示词');

  docEngine.saveSectionContent(project.id, 2, longText(2, 300), 'manual');
  fresh = docEngine.getProject(project.id);
  assert.equal(fresh.sections[1].source, 'manual');
  assert.equal(fresh.sections[1].status, 'done');
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
  assert.match(workspace.text, /导出 Markdown/);

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
