'use strict';

// 文档工作台页面：/docs。与 /status 同一套打法——服务端直渲染、不依赖前端构建链、
// 变更操作带内嵌 CSRF。web/ 官方小说前端零改动，两条产品线互不干扰。
const docEngine = require('./doc-engine');
const statusPage = require('./status-page');
const { one } = require('./db');

const { escapeHtml, sendHtml, readForm } = statusPage;

const SHARED_CSS = `
  :root { color-scheme: light; }
  body { margin: 0; padding: 26px 24px 56px; background: #f6f7f9; color: #1c1f23;
    font: 14px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 26px 0 10px; }
  .lead { color: #6b7280; margin: 0 0 18px; font-size: 13px; }
  .nav { display: flex; gap: 10px; margin: 0 0 18px; font-size: 13px; }
  .nav a { color: #1c4f9c; text-decoration: none; padding: 3px 10px; border-radius: 999px; background: #fff;
    border: 1px solid #e3e6ea; }
  .banner { padding: 10px 12px; border-radius: 8px; margin: 0 0 16px; font-size: 13px; }
  .banner.ok { background: #eaf7ee; color: #1a6b36; }
  .banner.bad { background: #fdecec; color: #a1231f; }
  .card { background: #fff; border-radius: 10px; padding: 18px; margin-bottom: 16px;
    box-shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.1); }
  label { display: block; font-weight: 600; font-size: 13px; margin: 12px 0 4px; }
  input[type=text], select, textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 8px 10px;
    border: 1px solid #d5d9df; border-radius: 8px; background: #fff; }
  textarea { min-height: 90px; resize: vertical; }
  textarea.code { font-family: Consolas, monospace; font-size: 12.5px; }
  .row { display: flex; gap: 14px; }
  .row > * { flex: 1; }
  .radios { display: flex; gap: 18px; margin-top: 6px; }
  .radios label { display: flex; align-items: center; gap: 6px; font-weight: 400; margin: 0; }
  button { font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 8px; cursor: pointer;
    border: 1px solid #d5d9df; background: #fff; color: #1c1f23; }
  button.primary { background: #1c4f9c; border-color: #1c4f9c; color: #fff; }
  button.danger { color: #a1231f; border-color: #eccccc; }
  button.small { font-size: 12px; padding: 3px 10px; }
  button:hover { filter: brightness(.97); }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden;
    box-shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.1); }
  th { text-align: left; font-weight: 600; font-size: 12px; color: #6b7280; padding: 10px 12px;
    border-bottom: 1px solid #eceef1; background: #fafbfc; }
  td { padding: 11px 12px; border-bottom: 1px solid #f0f1f3; vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  .sub { color: #8a919b; font-size: 12px; margin-top: 2px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
  .badge.ok { background: #eaf7ee; color: #1a6b36; }
  .badge.live { background: #e8f1fe; color: #1c4f9c; }
  .badge.warn { background: #fff5e6; color: #8a5a00; }
  .badge.bad { background: #fdecec; color: #a1231f; }
  .badge.mute { background: #eef0f3; color: #6b7280; }
  .empty { text-align: center; color: #8a919b; padding: 30px; }
  details { margin: 6px 0; }
  summary { cursor: pointer; font-size: 12.5px; color: #1c4f9c; }
  .hint { color: #8a919b; font-size: 12px; }
  form.inline { display: inline; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
`;

const SECTION_STATUS = { planned: ['未撰写', 'mute'], done: ['已完成', 'ok'], quarantined: ['失败', 'bad'] };

function navHtml(active) {
  const items = [['/', '小说工作台'], ['/docs', '文档工作台'], ['/skills', '技能广场'], ['/status', '任务状态']];
  return `<div class="nav">${items.map(([href, label]) =>
    `<a href="${href}"${href === active ? ' style="font-weight:700;color:#123c7a"' : ''}>${label}</a>`).join('')}</div>`;
}

function layout({ title, body, csrf, active = '/docs', notice = '', error = '', refresh = 0 }) {
  const banner = error ? `<p class="banner bad">${escapeHtml(error)}</p>`
    : notice ? `<p class="banner ok">${escapeHtml(notice)}</p>` : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${escapeHtml(title)}</title>
<style>${SHARED_CSS}</style></head>
<body>
${navHtml(active)}
${banner}
${body}
<input type="hidden" id="__csrf" value="${escapeHtml(csrf)}">
</body></html>`;
}

function typeOptions(selected) {
  return Object.values(docEngine.DOC_TYPES).map((type) =>
    `<option value="${type.key}"${type.key === selected ? ' selected' : ''}>${escapeHtml(type.name)}</option>`).join('');
}

// ---------- 列表 + 新建 ----------

function renderDocsList({ csrf, notice = '', error = '' }) {
  const projects = docEngine.listProjects();
  const rows = projects.length ? projects.map((project) => {
    const progress = project.total ? `${project.done}/${project.total} 节` : '—';
    const [statusText, statusClass] = project.status === 'done' ? ['已完成', 'ok']
      : project.status === 'running' ? ['生成中', 'live']
        : project.status === 'paused_budget' ? ['预算暂停', 'warn']
          : project.status === 'quarantined' ? ['有小节失败', 'bad']
            : project.status === 'failed' ? ['中断', 'bad'] : ['撰写中', 'mute'];
    return `<tr>
      <td><a href="/docs/project/${project.id}" style="font-weight:600;color:#1c1f23;text-decoration:none">${escapeHtml(project.title)}</a>
        <div class="sub">${escapeHtml(docEngine.docTypeOf(project.docType).name)} · ${project.mode === 'auto' ? 'AI 全托管' : 'AI 共创'} · ${progress}</div></td>
      <td><span class="badge ${statusClass}">${statusText}</span></td>
      <td class="sub">${escapeHtml(String(project.lastError || '').slice(0, 120))}</td>
      <td>
        <form method="post" action="/docs/delete" class="inline" onsubmit="return confirm('删除该项目及其全部小节？')">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <input type="hidden" name="projectId" value="${project.id}">
          <button class="small danger">删除</button>
        </form>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="4" class="empty">还没有文档项目，从下面新建一个</td></tr>';

  const defaults = JSON.stringify(Object.fromEntries(Object.values(docEngine.DOC_TYPES)
    .map((type) => [type.key, type.sections])), null, 0);
  const body = `
  <h1>文档工作台</h1>
  <p class="lead">商业计划书、申报书、报告、论文、合同与自定义模板——同样的 AI 共创 / AI 全托管两种方式，与小说创作互不影响。</p>
  <div class="card">
    <h2 style="margin-top:0">新建文档</h2>
    <form method="post" action="/docs/create">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <div class="row">
        <div>
          <label>文档标题</label>
          <input type="text" name="title" required placeholder="如：智能家居创业计划书 / 2026 产学研项目申报书">
        </div>
        <div>
          <label>文档类型</label>
          <select name="docType" id="docType">${typeOptions('bp')}</select>
        </div>
      </div>
      <label>写作方式</label>
      <div class="radios">
        <label><input type="radio" name="mode" value="co" checked> AI 共创（逐节起草 / 带指示修改 / 手工编辑）</label>
        <label><input type="radio" name="mode" value="auto"> AI 全托管（整篇批量生成，断点可续跑）</label>
      </div>
      <label>项目说明（主题、背景、关键事实与数据——写得越具体，产出越好）</label>
      <textarea name="brief" placeholder="项目背景、目标读者/评审方、核心主张、已有数据……"></textarea>
      <label>文档模板（可选：粘贴或上传 .md/.txt 模板，按标题切分小节；留空则用类型默认结构）</label>
      <input type="file" id="tplFile" accept=".md,.txt,.markdown">
      <textarea name="template" id="tplArea" class="code" placeholder="# 一、执行摘要&#10;（本节要求…）&#10;&#10;# 二、市场分析&#10;（本节要求…）"></textarea>
      <div class="actions" style="margin-top:12px">
        <button type="button" class="small" onclick="fillDefault()">填入类型默认模板</button>
        <button type="submit" class="primary">创建文档项目</button>
      </div>
    </form>
  </div>
  <table>
    <thead><tr><th>文档</th><th>状态</th><th>说明</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <script>
    const DEFAULTS = ${defaults};
    function fillDefault() {
      const key = document.getElementById('docType').value;
      const sections = DEFAULTS[key] || [];
      document.getElementById('tplArea').value = sections.length
        ? sections.map(s => '# ' + s.title + '\\n' + (s.brief || '')).join('\\n\\n')
        : '';
    }
    document.getElementById('tplFile').addEventListener('change', function () {
      const file = this.files[0];
      if (!file) return;
      file.text().then(t => { document.getElementById('tplArea').value = t; })
        .catch(() => alert('读取文件失败（仅支持文本类 .md/.txt）'));
    });
  </script>`;
  return layout({ title: '文档工作台', body, csrf, notice, error });
}

// ---------- 项目工作台 ----------

function renderProjectPage(projectId, { csrf, notice = '', error = '' }) {
  const project = docEngine.getProject(projectId);
  if (!project) return layout({ title: '文档不存在', csrf, error: '文档项目不存在或已删除', body: '<p><a href="/docs">返回列表</a></p>' });
  const run = require('./db').one(
    `SELECT * FROM generation_runs WHERE book_id=? AND mode='doc' ORDER BY updated_at DESC LIMIT 1`, projectId);
  const runLive = run && ['running', 'queued', 'retrying'].includes(run.status);
  const runResumable = run && statusPage.RESUMABLE.has(run.status);
  const usage = run ? require('./db').one(
    `SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c FROM generation_attempts WHERE run_id=?`, run.id) : null;
  const tokens = usage ? Number(usage.p || 0) + Number(usage.c || 0) : 0;

  const sectionRows = project.sections.map((section) => {
    const [statusText, statusClass] = SECTION_STATUS[section.status] || ['未撰写', 'mute'];
    const preview = escapeHtml(String(section.content || '').slice(0, 160))
      + (section.content && section.content.length > 160 ? '…' : '');
    return `<tr>
      <td>${section.idx}</td>
      <td><strong>${escapeHtml(section.title)}</strong><div class="sub">${escapeHtml(String(section.brief || '').slice(0, 120))}</div></td>
      <td><span class="badge ${statusClass}">${statusText}</span>
        <div class="sub">${section.content ? section.content.length + ' 字' : ''}${section.source === 'ai-batch' ? ' · 托管生成' : section.source === 'ai-revise' ? ' · AI 修改' : section.source === 'ai-draft' ? ' · AI 起草' : ''}</div></td>
      <td class="sub">${preview}</td>
      <td style="min-width:260px">
        <details>
          <summary>编辑 / AI 协作</summary>
          <form method="post" action="/docs/section/save">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <input type="hidden" name="projectId" value="${project.id}">
            <input type="hidden" name="idx" value="${section.idx}">
            <textarea name="content" class="code" style="min-height:140px">${escapeHtml(section.content)}</textarea>
            <div class="actions">
              <button class="small">保存本节</button>
            </div>
          </form>
          <form method="post" action="/docs/section/revise" style="margin-top:8px">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <input type="hidden" name="projectId" value="${project.id}">
            <input type="hidden" name="idx" value="${section.idx}">
            <input type="text" name="instruction" placeholder="修改指示，如：更克制；补一段风险对策">
            <div class="actions">
              <button class="small">AI 按指示修改</button>
            </div>
          </form>
          <form method="post" action="/docs/section/draft" style="margin-top:8px">
            <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
            <input type="hidden" name="projectId" value="${project.id}">
            <input type="hidden" name="idx" value="${section.idx}">
            <button class="small">AI 重新起草本节</button>
          </form>
        </details>
      </td>
    </tr>`;
  }).join('');

  const done = project.sections.filter((section) => section.status === 'done').length;
  const body = `
  <p class="lead"><a href="/docs">← 文档列表</a></p>
  <h1>${escapeHtml(project.title)}</h1>
  <p class="lead">${escapeHtml(project.typeName)} · ${project.mode === 'auto' ? 'AI 全托管' : 'AI 共创'} · 进度 ${done}/${project.sections.length} 节${tokens ? ' · 已消耗 ' + tokens.toLocaleString('zh-CN') + ' tokens' : ''}</p>
  ${project.brief ? `<div class="card"><div class="hint">项目说明</div>${escapeHtml(project.brief)}</div>` : ''}
  <div class="card">
    <h2 style="margin-top:0">整篇生成（AI 全托管）</h2>
    ${run ? `<p class="hint">最近任务：${escapeHtml(run.status)}${run.last_error ? ' · ' + escapeHtml(String(run.last_error).slice(0, 140)) : ''}（详细进度见<a href="/status" target="_blank">任务状态页</a>）</p>` : '<p class="hint">还没有跑过整篇生成。已完成的节会自动跳过，不会覆盖。</p>'}
    <div class="actions">
      <form method="post" action="/docs/generate" class="inline">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="projectId" value="${project.id}">
        <button class="primary">${runLive ? '生成中…（点击重新发起会排队）' : '开始整篇生成'}</button>
      </form>
      ${runResumable ? `<form method="post" action="/docs/resume" class="inline">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="runId" value="${run.id}">
        <button>从断点续跑</button>
      </form>` : ''}
      <a href="/docs/project/${project.id}/export" style="align-self:center;font-size:13px">导出全文 Markdown ↓</a>
    </div>
    <p class="hint" style="margin-top:10px">逐节编辑与 AI 协作在下表（两种方式都可用）；合同草稿请务必在签署前交专业人士审核。</p>
  </div>
  <table>
    <thead><tr><th>#</th><th>小节</th><th>状态</th><th>内容预览</th><th>操作</th></tr></thead>
    <tbody>${sectionRows}</tbody>
  </table>`;

  return layout({
    title: project.title, body, csrf, notice, error,
    refresh: runLive ? 10 : 0,
  });
}

// ---------- 路由 ----------

const jobNotices = new Map();
function noticeFor(projectId) {
  const item = jobNotices.get(projectId);
  if (!item || Date.now() - item.at > 10 * 60 * 1000) return {};
  return item.ok ? { notice: item.message } : { error: item.message };
}

function bad(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function handleDocs(req, res, pathname, token) {
  const parts = pathname.split('/').filter(Boolean); // ['docs', ...]
  if (req.method === 'GET') {
    if (pathname === '/docs') {
      sendHtml(res, renderDocsList({ csrf: token }));
      return true;
    }
    if (parts.length === 3 && parts[1] === 'project') {
      sendHtml(res, renderProjectPage(parts[2], { csrf: token, ...noticeFor(parts[2]) }));
      return true;
    }
    if (parts.length === 4 && parts[1] === 'project' && parts[3] === 'export') {
      const assembled = docEngine.assembleMarkdown(parts[2]);
      if (!assembled) { bad(res, 404, 'not found'); return true; }
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="doc-${String(parts[2]).slice(0, 8)}.md"`,
        'Cache-Control': 'no-store',
      });
      res.end(assembled.markdown);
      return true;
    }
    return false;
  }
  if (req.method !== 'POST') return false;
  const action = `${parts[0]}/${parts[1] || ''}`;
  const routes = ['docs/create', 'docs/delete', 'docs/section', 'docs/generate', 'docs/resume'];
  if (!routes.includes(action)) return false;
  let form;
  try { form = await readForm(req, 512 * 1024); }
  catch (error) { bad(res, 413, 'too large'); return true; }
  if (String(form.get('csrf') || '') !== token) { bad(res, 403, 'bad csrf'); return true; }

  const projectId = String(form.get('projectId') || '');
  try {
    if (action === 'docs/create') {
      const project = docEngine.createProject({
        title: form.get('title'), docType: form.get('docType'), mode: form.get('mode'),
        brief: form.get('brief'), template: form.get('template'),
      });
      res.writeHead(303, { Location: `/docs/project/${project.id}` });
      res.end();
      return true;
    }
    if (action === 'docs/delete') {
      docEngine.deleteProject(projectId);
      res.writeHead(303, { Location: '/docs' });
      res.end();
      return true;
    }
    if (action === 'docs/section') {
      const op = String(parts[2] || '');
      const idx = Number(form.get('idx'));
      if (op === 'save') docEngine.saveSectionContent(projectId, idx, form.get('content'), 'manual');
      else if (op === 'draft') await docEngine.draftSection(projectId, idx);
      else if (op === 'revise') await docEngine.reviseSection(projectId, idx, form.get('instruction'));
      else { bad(res, 404, 'unknown op'); return true; }
      res.writeHead(303, { Location: `/docs/project/${projectId}` });
      res.end();
      return true;
    }
    if (action === 'docs/generate') {
      const project = docEngine.getProject(projectId);
      if (!project) { bad(res, 404, 'not found'); return true; }
      jobNotices.set(projectId, { at: Date.now(), ok: true, message: '整篇生成已启动…' });
      statusPage.startResume(projectId, {
        resume: (id) => docEngine.generateDocProject({ projectId: id }),
        onSettled: (id, error, result) => jobNotices.set(id, error
          ? { at: Date.now(), ok: false, message: `生成中断：${String(error.message || error).slice(0, 160)}` }
          : { at: Date.now(), ok: true, message: `生成结束：新写 ${result?.created?.length || 0} 节，跳过 ${result?.skipped?.length || 0} 节${result?.quarantined?.length ? '，' + result.quarantined.length + ' 节失败' : ''}${result?.stopReason ? '；' + result.stopReason : ''}` }),
      });
      res.writeHead(303, { Location: `/docs/project/${projectId}` });
      res.end();
      return true;
    }
    if (action === 'docs/resume') {
      const runId = String(form.get('runId') || '');
      const run = require('./db').one(`SELECT book_id FROM generation_runs WHERE id=? AND mode='doc'`, runId);
      if (!run) { bad(res, 400, 'run not found'); return true; }
      jobNotices.set(run.book_id, { at: Date.now(), ok: true, message: '续跑已启动…' });
      statusPage.startResume(runId, {
        resume: (id) => docEngine.resumeDocRun(id),
        onSettled: (id, error, result) => {
          const row = one(`SELECT book_id FROM generation_runs WHERE id=?`, id);
          const target = row ? row.book_id : '';
          jobNotices.set(target, error
            ? { at: Date.now(), ok: false, message: `续跑中断：${String(error.message || error).slice(0, 160)}` }
            : { at: Date.now(), ok: true, message: `续跑结束：新写 ${result?.created?.length || 0} 节` });
        },
      });
      res.writeHead(303, { Location: `/docs/project/${run.book_id}` });
      res.end();
      return true;
    }
  } catch (error) {
    const back = projectId || '/docs';
    jobNotices.set(back, { at: Date.now(), ok: false, message: String(error.message || error).slice(0, 200) });
    res.writeHead(303, { Location: projectId ? `/docs/project/${projectId}` : '/docs' });
    res.end();
    return true;
  }
  return false;
}

module.exports = { renderDocsList, renderProjectPage, handleDocs, _jobNotices: jobNotices };
