'use strict';

// 文档工作台页面：/docs。与小说主界面同款的工作台形态——
// 左栏项目列表 · 中间编辑区 + 底部输入条 · 右侧小节树。
// 服务端直渲染（web/ 无源码），全部状态走 URL（?id= 项目 &s= 小节 &edit=1 &new=1），
// 动作走表单 POST + 303 跳回原上下文。引擎与路由动作与上一版完全一致。
const docEngine = require('./doc-engine');
const statusPage = require('./status-page');
const { one } = require('./db');

const { escapeHtml, sendHtml, readForm } = statusPage;

const CSS = `
  :root { color-scheme: light; --line:#e6e8ec; --ink:#202124; --sub:#70757d;
    --bg:#f4f5f7; --panel:#ffffff; --brand:#1d4ed8; --brand-weak:#eaf1ff; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 13.5px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  button { font: inherit; cursor: pointer; }
  a { color: var(--brand); text-decoration: none; }

  .app { display: flex; height: 100vh; overflow: hidden; }

  /* ---------- 左栏：项目列表（仿会话栏） ---------- */
  .rail { width: 240px; flex: none; background: var(--panel); border-right: 1px solid var(--line);
    display: flex; flex-direction: column; }
  .rail__brand { padding: 14px 14px 8px; font-weight: 700; font-size: 14px; }
  .rail__brand .sub { display: block; font-weight: 400; font-size: 11.5px; color: var(--sub); }
  .rail__new { margin: 6px 12px 10px; display: block; text-align: center; padding: 8px 0;
    border-radius: 9px; background: var(--brand); color: #fff; font-weight: 600; font-size: 13px; }
  .rail__new:hover { filter: brightness(.95); }
  .rail__sect { padding: 8px 14px 4px; font-size: 11px; color: var(--sub); letter-spacing: .05em; }
  .rail__list { flex: 1; overflow-y: auto; padding: 0 8px 10px; }
  .pcard { display: block; width: 100%; text-align: left; border: 0; background: none;
    padding: 8px 10px; border-radius: 9px; margin-bottom: 2px; }
  .pcard:hover { background: #f1f3f6; }
  .pcard.is-active { background: var(--brand-weak); }
  .pcard__top { display: flex; align-items: center; gap: 6px; }
  .pcard__name { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .pcard__sub { font-size: 11.5px; color: var(--sub); margin-top: 1px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.ok { background: #22a55e; } .dot.bad { background: #d64545; }
  .dot.warn { background: #d99114; } .dot.mute { background: #c3c8cf; }
  .rail__foot { border-top: 1px solid var(--line); padding: 8px 12px; display: flex; flex-direction: column; gap: 2px; }
  .rail__foot a { color: var(--sub); font-size: 12px; padding: 3px 0; }
  .rail__foot a:hover { color: var(--ink); }

  /* ---------- 中栏：工作区 ---------- */
  .work { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .work__head { flex: none; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 10px 18px; background: var(--panel); border-bottom: 1px solid var(--line); }
  .work__title { font-size: 15px; font-weight: 700; }
  .work__meta { font-size: 12px; color: var(--sub); }
  .work__acts { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
  .btn { border: 1px solid var(--line); background: var(--panel); border-radius: 8px;
    padding: 5px 12px; font-size: 12.5px; }
  .btn:hover { background: #f3f5f8; }
  .btn--primary { background: var(--brand); border-color: var(--brand); color: #fff; font-weight: 600; }
  .btn--primary:hover { filter: brightness(.95); background: var(--brand); }
  .btn--danger { color: #c03535; border-color: #eedbdb; }
  .btn--sm { padding: 3px 9px; font-size: 12px; }

  .banner { margin: 10px 18px 0; padding: 8px 12px; border-radius: 8px; font-size: 12.5px; }
  .banner.ok { background: #e9f7ee; color: #17693a; }
  .banner.bad { background: #fdecec; color: #a1231f; }

  .docbody { flex: 1; overflow-y: auto; padding: 26px 8%; 60px; }
  .docbody__inner { max-width: 780px; margin: 0 auto; }
  .sec__brief { color: var(--sub); font-size: 12.5px; background: #f6f7f9; border-radius: 8px;
    padding: 8px 12px; margin: 0 0 14px; }
  .sec__text { white-space: pre-wrap; word-break: break-word; font-size: 14.5px; line-height: 1.95; }
  .sec__text.is-empty { color: #9aa1a9; }
  .sec__text textarea { width: 100%; min-height: 320px; border: 1px solid var(--line); border-radius: 10px;
    padding: 14px; font: 13.5px/1.9 Consolas, monospace; }
  .sec__nav { display: flex; justify-content: space-between; margin-top: 26px; }

  /* ---------- 底部输入条（仿主界面对话框） ---------- */
  .composer { flex: none; margin: 0 18px 14px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 14px; padding: 10px 12px 8px; box-shadow: 0 2px 10px rgba(16,24,40,.05); }
  .composer textarea { width: 100%; border: 0; outline: none; resize: none; font: inherit;
    min-height: 44px; max-height: 160px; }
  .composer__acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
  .composer__hint { color: #9aa1a9; font-size: 11.5px; }
  .composer__send { margin-left: auto; }

  /* ---------- 右栏：小节树 ---------- */
  .tree { width: 232px; flex: none; background: var(--panel); border-left: 1px solid var(--line);
    display: flex; flex-direction: column; }
  .tree__sect { padding: 12px 14px 4px; font-size: 11px; color: var(--sub); letter-spacing: .05em; }
  .tree__list { flex: 1; overflow-y: auto; padding: 0 8px 10px; }
  .trow { display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; border: 0;
    background: none; padding: 6px 9px; border-radius: 8px; font-size: 12.5px; }
  .trow:hover { background: #f1f3f6; }
  .trow.is-active { background: var(--brand-weak); font-weight: 600; }
  .trow__no { color: var(--sub); font-variant-numeric: tabular-nums; flex: none; }
  .trow__name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tree__info { border-top: 1px solid var(--line); padding: 10px 14px; font-size: 11.5px; color: var(--sub);
    max-height: 180px; overflow-y: auto; white-space: pre-wrap; }

  /* ---------- 新建 / 空态（中栏内容） ---------- */
  .formcard { max-width: 640px; margin: 30px auto; background: var(--panel); border-radius: 14px;
    padding: 22px 26px; box-shadow: 0 1px 3px rgba(16,24,40,.07); }
  .formcard h2 { margin: 0 0 4px; font-size: 15px; }
  .formcard .lead { margin: 0 0 14px; color: var(--sub); font-size: 12.5px; }
  label { display: block; font-weight: 600; font-size: 12.5px; margin: 13px 0 4px; }
  input[type=text], select, textarea { width: 100%; font: inherit; padding: 8px 10px;
    border: 1px solid var(--line); border-radius: 9px; background: #fff; }
  textarea { min-height: 84px; resize: vertical; }
  textarea.code { font-family: Consolas, monospace; font-size: 12.5px; }
  .radios { display: flex; gap: 16px; margin-top: 6px; }
  .radios label { display: flex; align-items: center; gap: 6px; font-weight: 400; margin: 0; }
  .actions { display: flex; gap: 8px; margin-top: 16px; }

  @media (max-width: 1000px) {
    .tree { display: none; }
    .docbody { padding: 22px 5%; 60px; }
  }
`;

const SECTION_STATUS = { planned: ['未撰写', 'mute'], done: ['已完成', 'ok'], quarantined: ['失败', 'bad'] };

function statusDot(status) {
  const key = status === 'done' ? 'ok' : status === 'quarantined' ? 'bad' : status === 'paused_budget' ? 'warn' : status === 'done' ? 'ok' : 'mute';
  return key;
}

function projectStatusMeta(project) {
  if (project.status === 'done') return ['已完成', 'ok'];
  if (project.status === 'running') return ['生成中', 'warn'];
  if (project.status === 'paused_budget') return ['预算暂停', 'warn'];
  if (project.status === 'quarantined') return ['有小节失败', 'bad'];
  if (project.status === 'failed') return ['中断', 'bad'];
  return ['撰写中', 'mute'];
}

function backHref(projectId, idx, edit) {
  const params = new URLSearchParams();
  if (projectId) params.set('id', projectId);
  if (idx) params.set('s', String(idx));
  if (edit) params.set('edit', '1');
  const query = params.toString();
  return `/docs${query ? '?' + query : ''}`;
}

// ---------- 左栏 ----------

function renderRail(activeId) {
  const projects = docEngine.listProjects();
  const cards = projects.map((project) => {
    const [, dot] = projectStatusMeta(project);
    return `<a class="pcard${project.id === activeId ? ' is-active' : ''}" href="/docs?id=${project.id}">
      <span class="pcard__top"><span class="pcard__name">${escapeHtml(project.title)}</span>
      <span class="dot ${statusDot(dot)}" title="${escapeHtml(projectStatusMeta(project)[0])}"></span></span>
      <span class="pcard__sub">${escapeHtml(docEngine.docTypeOf(project.docType).name)} · ${project.done}/${project.total} 节 · ${project.mode === 'auto' ? '全托管' : '共创'}</span>
    </a>`;
  }).join('');
  return `<aside class="rail">
    <div class="rail__brand">文档工作台<span class="sub">论文 · 商业文书 · 报告 · 合同</span></div>
    <a class="rail__new" href="/docs?new=1">＋ 新建文档</a>
    <div class="rail__sect">全部文档（${projects.length}）</div>
    <div class="rail__list">${cards || '<div class="pcard__sub" style="padding:8px 10px">还没有文档</div>'}</div>
    <div class="rail__foot">
      <a href="/">小说工作台</a>
      <a href="/skills">技能广场</a>
      <a href="/status">任务状态</a>
    </div>
  </aside>`;
}

// ---------- 右栏 ----------

function renderTree(project, currentIdx) {
  const rows = project.sections.map((section) => {
    const [text, dot] = SECTION_STATUS[section.status] || ['未撰写', 'mute'];
    return `<a class="trow${section.idx === currentIdx ? ' is-active' : ''}" href="/docs?id=${project.id}&s=${section.idx}" title="${escapeHtml(section.title)}（${text}）">
      <span class="trow__no">${section.idx}</span>
      <span class="trow__name">${escapeHtml(section.title)}</span>
      <span class="dot ${statusDot(dot)}"></span>
    </a>`;
  }).join('');
  return `<aside class="tree">
    <div class="tree__sect">小节（${project.sections.filter((s) => s.status === 'done').length}/${project.sections.length}）</div>
    <div class="tree__list">${rows}</div>
    ${project.brief ? `<div class="tree__info"><b>项目说明</b><br>${escapeHtml(project.brief.slice(0, 400))}</div>` : ''}
  </aside>`;
}

// ---------- 新建表单 ----------

function typeOptions(selected) {
  return Object.values(docEngine.DOC_TYPES).map((type) =>
    `<option value="${type.key}"${type.key === selected ? ' selected' : ''}>${escapeHtml(type.name)}</option>`).join('');
}

function renderNewForm(csrf) {
  const defaults = JSON.stringify(Object.fromEntries(Object.values(docEngine.DOC_TYPES)
    .map((type) => [type.key, type.sections])));
  return `<div class="formcard">
    <h2>新建文档</h2>
    <p class="lead">选类型、贴模板（可选）、选写作方式；创建后进入工作台逐节写作。</p>
    <form method="post" action="/docs/create">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <label>文档标题</label>
      <input type="text" name="title" required placeholder="如：智能家居创业计划书 / 2026 产学研项目申报书">
      <div class="radios" style="gap:14px">
        <div style="flex:1"><label>文档类型</label><select name="docType" id="docType">${typeOptions('bp')}</select></div>
        <div><label>写作方式</label>
          <div class="radios">
            <label><input type="radio" name="mode" value="co" checked> AI 共创</label>
            <label><input type="radio" name="mode" value="auto"> AI 全托管</label>
          </div>
        </div>
      </div>
      <label>项目说明（主题 / 背景 / 关键事实——越具体越好）</label>
      <textarea name="brief" placeholder="项目背景、目标读者或评审方、核心主张、已有数据……"></textarea>
      <label>文档模板（可选：粘贴或上传 .md/.txt，按标题切分小节；留空用类型默认结构）</label>
      <input type="file" id="tplFile" accept=".md,.txt,.markdown">
      <textarea name="template" id="tplArea" class="code" placeholder="# 一、执行摘要&#10;（本节要求…）&#10;&#10;# 二、市场分析&#10;（本节要求…）"></textarea>
      <div class="actions">
        <button type="button" class="btn btn--sm" onclick="fillDefault()">填入类型默认模板</button>
        <button type="submit" class="btn btn--primary">创建并进入工作台</button>
      </div>
    </form>
  </div>
  <script>
    const DEFAULTS = ${defaults};
    function fillDefault() {
      const key = document.getElementById('docType').value;
      const sections = DEFAULTS[key] || [];
      document.getElementById('tplArea').value = sections.length
        ? sections.map(s => '# ' + s.title + '\\n' + (s.brief || '')).join('\\n\\n') : '';
    }
    document.getElementById('tplFile').addEventListener('change', function () {
      const file = this.files[0];
      if (!file) return;
      file.text().then(t => { document.getElementById('tplArea').value = t; })
        .catch(() => alert('读取文件失败（仅支持文本类 .md/.txt）'));
    });
  </script>`;
}

// ---------- 工作区（项目头部 + 当前节 + 输入条） ----------

function renderWorkArea(project, currentIdx, { csrf, edit = false }) {
  const run = one(`SELECT * FROM generation_runs WHERE book_id=? AND mode='doc' ORDER BY updated_at DESC LIMIT 1`, project.id);
  const runLive = run && ['running', 'queued', 'retrying'].includes(run.status);
  const runResumable = run && statusPage.RESUMABLE.has(run.status);
  const usage = run ? one(`SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c FROM generation_attempts WHERE run_id=?`, run.id) : null;
  const tokens = usage ? Number(usage.p || 0) + Number(usage.c || 0) : 0;
  const done = project.sections.filter((s) => s.status === 'done').length;

  const section = project.sections[currentIdx - 1];
  const prev = project.sections[currentIdx - 2];
  const next = project.sections[currentIdx];

  const head = `<div class="work__head">
    <span class="work__title">${escapeHtml(project.title)}</span>
    <span class="work__meta">${escapeHtml(project.typeName)} · ${project.mode === 'auto' ? 'AI 全托管' : 'AI 共创'} · ${done}/${project.sections.length} 节${tokens ? ' · ' + tokens.toLocaleString('zh-CN') + ' tokens' : ''}${run ? ' · 任务 ' + escapeHtml(run.status) : ''}</span>
    <span class="work__acts">
      <form method="post" action="/docs/generate" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="projectId" value="${project.id}"><input type="hidden" name="s" value="${currentIdx}">
        <button class="btn btn--primary btn--sm">${runLive ? '生成中…' : '整篇生成'}</button></form>
      ${runResumable ? `<form method="post" action="/docs/resume" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="runId" value="${run.id}">
        <button class="btn btn--sm">从断点续跑</button></form>` : ''}
      <a class="btn btn--sm" href="/docs/project/${project.id}/export">导出 Markdown</a>
      <form method="post" action="/docs/delete" class="inline" onsubmit="return confirm('删除该项目及其全部小节？')"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="projectId" value="${project.id}">
        <button class="btn btn--sm btn--danger">删除</button></form>
    </span>
  </div>`;

  let body;
  if (!section) {
    body = `<div class="docbody"><div class="docbody__inner"><div class="formcard"><h2>选择左侧文档开始</h2></div></div></div>`;
  } else {
    const [statusText] = SECTION_STATUS[section.status] || ['未撰写', 'mute'];
    const contentHtml = edit
      ? `<form method="post" action="/docs/section/save">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <input type="hidden" name="projectId" value="${project.id}">
          <input type="hidden" name="idx" value="${section.idx}">
          <div class="sec__text"><textarea name="content">${escapeHtml(section.content)}</textarea></div>
          <div class="actions"><button class="btn btn--primary btn--sm" type="submit">保存本节</button>
          <a class="btn btn--sm" href="/docs?id=${project.id}&s=${section.idx}">取消</a></div>
        </form>`
      : `<div class="sec__text${section.content ? '' : ' is-empty'}">${escapeHtml(section.content || `（${statusText}——用下方输入条让 AI 起草，或点右上"编辑"手写）`)}</div>
        <div class="actions"><a class="btn btn--sm" href="/docs?id=${project.id}&s=${section.idx}&edit=1">编辑本节</a></div>`;
    body = `<div class="docbody"><div class="docbody__inner">
      ${section.brief ? `<div class="sec__brief">第 ${section.idx} 节 · ${escapeHtml(section.brief)}</div>` : ''}
      <h2 style="margin:0 0 14px;font-size:17px">第 ${section.idx} 节　${escapeHtml(section.title)}
        <span class="work__meta">（${statusText}${section.source === 'ai-batch' ? ' · 托管生成' : section.source === 'ai-revise' ? ' · AI 修改' : section.source === 'ai-draft' ? ' · AI 起草' : ''}）</span></h2>
      ${contentHtml}
      <div class="sec__nav">
        ${prev ? `<a class="btn btn--sm" href="/docs?id=${project.id}&s=${prev.idx}">← 第${prev.idx}节 ${escapeHtml(prev.title)}</a>` : '<span></span>'}
        ${next ? `<a class="btn btn--sm" href="/docs?id=${project.id}&s=${next.idx}">第${next.idx}节 ${escapeHtml(next.title)} →</a>` : ''}
      </div>
    </div></div>`;
  }

  const composer = section ? `<div class="composer">
    <form method="post" action="/docs/section/revise">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="idx" value="${section.idx}">
      <textarea name="instruction" required placeholder="写下对本节的修改要求，让 AI 改写（如：语气更克制；补一段风险对策）…"></textarea>
      <div class="composer__acts">
        <button class="btn btn--primary btn--sm composer__send" type="submit">AI 修改本节</button>
      </div>
    </form>
    <form method="post" action="/docs/section/draft" style="margin-top:6px">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="idx" value="${section.idx}">
      <span class="composer__hint">本节还没有内容？</span>
      <button class="btn btn--sm" type="submit">AI 起草本节</button>
      <span class="composer__hint">${project.docType === 'contract' ? '合同草稿需专业人士审核后使用' : '数据未给出处 AI 会标注【待补】'}</span>
    </form>
  </div>` : '';

  return `${head}${composer ? body : body}${composer}`;
}

// ---------- 页面装配 ----------

function renderDocsPage({ csrf, id = '', s = 0, edit = false, isNew = false, notice = '', error = '' }) {
  let project = null;
  let currentIdx = Math.max(1, Number(s) || 1);
  if (id) {
    project = docEngine.getProject(id);
    if (project && currentIdx > project.sections.length) currentIdx = 1;
  }
  const banner = error ? `<p class="banner bad">${escapeHtml(error)}</p>`
    : notice ? `<p class="banner ok">${escapeHtml(notice)}</p>` : '';

  let main;
  if (isNew || !project) {
    main = renderNewForm(csrf);
    if (!isNew && !project && docEngine.listProjects().length === 0) {
      // 空态直接显示新建表单
    }
  } else {
    main = renderWorkArea(project, currentIdx, { csrf, edit });
  }

  const refresh = project && one(`SELECT 1 FROM generation_runs WHERE book_id=? AND mode='doc' AND status IN ('running','queued','retrying') LIMIT 1`, project.id)
    ? '<meta http-equiv="refresh" content="10">' : '';

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refresh}
<title>文档工作台 · Fabula</title>
<style>${CSS}</style></head>
<body>
<div class="app">
  ${renderRail(project ? project.id : '')}
  <main class="work">
    ${banner}
    ${main}
  </main>
  ${project ? renderTree(project, currentIdx) : ''}
</div>
</body></html>`;
}

// 兼容旧测试入口：完整页面渲染
function renderDocsList({ csrf, notice = '', error = '' }) {
  return renderDocsPage({ csrf, notice, error });
}
function renderProjectPage(projectId, { csrf, notice = '', error = '' } = {}) {
  const project = docEngine.getProject(projectId);
  return renderDocsPage({
    csrf, id: project ? projectId : '', notice,
    error: project ? error : (error || '文档项目不存在或已删除'),
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
  const u = new URL(req.url, 'http://localhost');
  const parts = pathname.split('/').filter(Boolean); // ['docs', ...]
  if (req.method === 'GET') {
    if (pathname === '/docs') {
      const id = u.searchParams.get('id') || '';
      const s = Number(u.searchParams.get('s')) || 1;
      const edit = u.searchParams.get('edit') === '1';
      const isNew = u.searchParams.get('new') === '1';
      const outcome = id ? noticeFor(id) : {};
      sendHtml(res, renderDocsPage({ csrf: token, id, s, edit, isNew, ...outcome }));
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
  const backIdx = Number(form.get('s')) || Number(form.get('idx')) || 1;
  try {
    if (action === 'docs/create') {
      const project = docEngine.createProject({
        title: form.get('title'), docType: form.get('docType'), mode: form.get('mode'),
        brief: form.get('brief'), template: form.get('template'),
      });
      res.writeHead(303, { Location: `/docs?id=${project.id}` });
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
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${idx}` });
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
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/resume') {
      const runId = String(form.get('runId') || '');
      const run = one(`SELECT book_id FROM generation_runs WHERE id=? AND mode='doc'`, runId);
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
      res.writeHead(303, { Location: `/docs?id=${run.book_id}` });
      res.end();
      return true;
    }
  } catch (error) {
    const back = projectId ? `/docs?id=${projectId}&s=${backIdx}` : '/docs';
    jobNotices.set(projectId || '/', { at: Date.now(), ok: false, message: String(error.message || error).slice(0, 200) });
    res.writeHead(303, { Location: back });
    res.end();
    return true;
  }
  return false;
}

module.exports = { renderDocsList, renderProjectPage, renderDocsPage, handleDocs, _jobNotices: jobNotices };
