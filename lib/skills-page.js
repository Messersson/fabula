'use strict';

// 技能广场（本地版）：与文档工作台同款的工作台形态——
// 左栏分类导航 · 主区技能卡片网格 · 新建表单。
// 官方云端广场不可用（离线复刻定位），这里把"广场"落在本地技能库上。
const mis = require('./handlers-misc');
const statusPage = require('./status-page');

const { escapeHtml, sendHtml, readForm } = statusPage;

const CSS = `
  :root { color-scheme: light; --line:#e6e8ec; --ink:#202124; --sub:#70757d;
    --bg:#f4f5f7; --panel:#ffffff; --brand:#1d4ed8; --brand-weak:#eaf1f7; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 13.5px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  button { font: inherit; cursor: pointer; }
  a { color: var(--brand); text-decoration: none; }

  .app { display: flex; height: 100vh; overflow: hidden; }

  .rail { width: 240px; flex: none; background: var(--panel); border-right: 1px solid var(--line);
    display: flex; flex-direction: column; }
  .rail__brand { padding: 14px 14px 8px; font-weight: 700; font-size: 14px; }
  .rail__brand .sub { display: block; font-weight: 400; font-size: 11.5px; color: var(--sub); }
  .rail__new { margin: 6px 12px 10px; display: block; text-align: center; padding: 8px 0;
    border-radius: 9px; background: var(--brand); color: #fff; font-weight: 600; font-size: 13px; }
  .rail__new:hover { filter: brightness(.95); }
  .rail__sect { padding: 8px 14px 4px; font-size: 11px; color: var(--sub); letter-spacing: .05em; }
  .rail__list { flex: 1; overflow-y: auto; padding: 0 8px 10px; }
  .frow { display: flex; align-items: center; gap: 7px; padding: 7px 10px; border-radius: 8px;
    font-size: 12.5px; color: var(--ink); }
  .frow:hover { background: #f1f3f6; }
  .frow.is-active { background: var(--brand-weak); font-weight: 600; }
  .frow__name { flex: 1; }
  .frow__count { color: var(--sub); font-variant-numeric: tabular-nums; font-size: 11.5px; }
  .rail__foot { border-top: 1px solid var(--line); padding: 8px 12px; display: flex; flex-direction: column; gap: 2px; }
  .rail__foot a { color: var(--sub); font-size: 12px; padding: 3px 0; }
  .rail__foot a:hover { color: var(--ink); }

  .work { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .work__head { flex: none; display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 12px 20px; background: var(--panel); border-bottom: 1px solid var(--line); }
  .work__title { font-size: 15px; font-weight: 700; }
  .work__meta { font-size: 12px; color: var(--sub); }
  .banner { margin: 10px 20px 0; padding: 8px 12px; border-radius: 8px; font-size: 12.5px; }
  .banner.ok { background: #e9f7ee; color: #17693a; }
  .banner.bad { background: #fdecec; color: #a1231f; }

  .scroll { flex: 1; overflow-y: auto; padding: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
  .card { background: var(--panel); border-radius: 12px; padding: 14px 16px;
    box-shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.1); }
  .card__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .card__name { font-weight: 700; font-size: 13.5px; }
  .card__desc { color: var(--sub); font-size: 12.5px; margin: 8px 0; min-height: 20px; }
  .card__tpl { font-family: Consolas, monospace; font-size: 11.5px; color: var(--sub);
    background: #f6f7f9; border-radius: 8px; padding: 8px 10px; margin: 8px 0;
    max-height: 84px; overflow: hidden; white-space: pre-wrap; word-break: break-word; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; white-space: nowrap; }
  .badge.ok { background: #e9f7ee; color: #17693a; }
  .badge.live { background: #e8f1fe; color: #1c4f9c; }
  .badge.warn { background: #fff5e6; color: #8a5a00; }
  .badge.bad { background: #fdecec; color: #a1231f; }
  .badge.mute { background: #eef0f3; color: #6b7280; }

  .btn { border: 1px solid var(--line); background: var(--panel); border-radius: 8px;
    padding: 5px 12px; font-size: 12.5px; }
  .btn:hover { background: #f3f5f8; }
  .btn--primary { background: var(--brand); border-color: var(--brand); color: #fff; font-weight: 600; }
  .btn--primary:hover { filter: brightness(.95); background: var(--brand); }
  .btn--danger { color: #c03535; border-color: #eedbdb; }
  .btn--sm { padding: 3px 9px; font-size: 12px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; align-items: center; }
  form.inline { display: inline; }

  .formcard { background: var(--panel); border-radius: 12px; padding: 18px 20px; max-width: 720px;
    box-shadow: 0 1px 3px rgba(16,24,40,.07); margin-bottom: 20px; }
  .formcard h2 { margin: 0 0 4px; font-size: 15px; }
  .formcard .lead { margin: 0 0 10px; color: var(--sub); font-size: 12.5px; }
  label { display: block; font-weight: 600; font-size: 12.5px; margin: 12px 0 4px; }
  input[type=text], select, textarea { width: 100%; font: inherit; padding: 8px 10px;
    border: 1px solid var(--line); border-radius: 9px; background: #fff; }
  textarea { min-height: 96px; resize: vertical; }
  textarea.code { font-family: Consolas, monospace; font-size: 12.5px; }
  .row { display: flex; gap: 12px; }
  .row > * { flex: 1; }
  .empty { text-align: center; color: #9aa1a9; padding: 40px; grid-column: 1/-1; }
`;

const KIND_TEXT = { builtin: '内置', method: '方法论', workflow: '工作流', craft: '技法', style: '文风', user: '自建' };

function kindBadge(kind) {
  return KIND_TEXT[kind] || String(kind || '通用');
}

function skillMarkdown(skill) {
  return `# ${skill.name}\n\n> ${skill.description || ''}\n\n## 使用方式\n\n${skill.usageMode || 'support'}\n\n## 提示词模板\n\n\`\`\`text\n${skill.promptTemplate || ''}\n\`\`\`\n`;
}

function renderSkillsPage({ csrf, kind = '', domain = '', notice = '', error = '' }) {
  const all = mis.listSkills();
  // ?new=1 只是"主区显示新建表单"，列表仍展示全部。
  const filterKind = kind === 'new' ? '' : kind;
  const officialCount = all.filter((skill) => skill.origin === 'official').length;
  const styleCount = all.filter((skill) => skill.kind === 'style').length;
  const userCount = all.filter((skill) => skill.origin !== 'official').length;
  const novelCount = all.filter((skill) => skill.domain !== 'doc').length;
  const docCount = all.filter((skill) => skill.domain === 'doc').length;
  // 过滤语义：domain=技能使用场景（novel/doc，不能混用）；kind=技能类别。
  const match = (skill) =>
    (!domain || (domain === 'novel' ? skill.domain !== 'doc' : skill.domain === domain)) &&
    (!filterKind ||
      (filterKind === 'official' && skill.origin === 'official') ||
      (filterKind === 'style' && skill.kind === 'style') ||
      (filterKind === 'user' && skill.origin !== 'official'));
  const skills = all.filter(match);

  const filterRow = (href, label, count, active) =>
    `<a class="frow${active ? ' is-active' : ''}" href="${href}"><span class="frow__name">${escapeHtml(label)}</span><span class="frow__count">${count}</span></a>`;
  const dq = (extra) => {
    const params = new URLSearchParams();
    if (domain) params.set('domain', domain);
    if (extra) params.set('kind', extra);
    const q = params.toString();
    return `/skills${q ? '?' + q : ''}`;
  };
  const filters = [
    filterRow(dq(''), '全部技能', all.length, !filterKind && !domain),
    filterRow('/skills?domain=novel', '小说技能', novelCount, domain === 'novel'),
    filterRow('/skills?domain=doc', '文档技能', docCount, domain === 'doc'),
    filterRow(dq('official'), '官方内置', officialCount, filterKind === 'official'),
    filterRow(dq('style'), '文风', styleCount, filterKind === 'style'),
    filterRow(dq('user'), '自建技能', userCount, filterKind === 'user'),
  ].join('');

  const cards = skills.map((skill) => {
    const official = skill.origin === 'official';
    return `<div class="card">
      <div class="card__head">
        <span class="card__name">${escapeHtml(skill.name)}</span>
        <span class="badge mute">${escapeHtml(kindBadge(skill.kind))}</span>
        <span class="badge ${skill.domain === 'doc' ? 'warn' : 'live'}">${skill.domain === 'doc' ? '文档' : '小说'}</span>
        ${official ? '<span class="badge live">官方内置</span>' : '<span class="badge warn">自建</span>'}
        <span class="badge ${skill.enabled ? 'ok' : 'bad'}">${skill.enabled ? '已启用' : '已停用'}</span>
      </div>
      <p class="card__desc">${escapeHtml(String(skill.description || '').slice(0, 220))}</p>
      ${skill.promptTemplate ? `<div class="card__tpl">${escapeHtml(String(skill.promptTemplate).slice(0, 160))}${skill.promptTemplate.length > 160 ? '…' : ''}</div>` : ''}
      <div class="actions">
        <form method="post" action="/skills/toggle" class="inline">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <input type="hidden" name="id" value="${skill.id}">
          <button class="btn btn--sm" type="submit">${skill.enabled ? '停用' : '启用'}</button>
        </form>
        <a class="btn btn--sm" href="/skills/export/${skill.id}">导出 .md ↓</a>
        ${official ? '' : `<form method="post" action="/skills/delete" class="inline" onsubmit="return confirm('删除该技能？')">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <input type="hidden" name="id" value="${skill.id}">
          <button class="btn btn--sm btn--danger" type="submit">删除</button>
        </form>`}
      </div>
    </div>`;
  }).join('');

  const createForm = `<div class="formcard">
    <h2>新建技能</h2>
    <p class="lead">小说技能只在小说对话里可选，文档技能只在文档工作台里可选——两个场景互不混用。</p>
    <form method="post" action="/skills/create">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <div class="row">
        <div><label>技能名</label><input type="text" name="name" required placeholder="如：竞品分析框架"></div>
        <div><label>写作场景</label>
          <select name="domain">
            <option value="novel">小说技能</option>
            <option value="doc">文档技能</option>
          </select>
        </div>
        <div><label>类别</label>
          <select name="kind">
            <option value="method">方法论</option>
            <option value="workflow">工作流</option>
            <option value="craft">技法</option>
            <option value="style">文风</option>
          </select>
        </div>
        <div><label>使用方式</label>
          <select name="usageMode">
            <option value="support">叠加辅助（默认）</option>
            <option value="standalone">独立运行</option>
          </select>
        </div>
      </div>
      <label>描述（一句话说明干什么用）</label>
      <input type="text" name="description" placeholder="用波特五力拆解市场竞争格局，输出结构化分析">
      <label>提示词模板（保持"你是…请…"的祈使结构效果最好）</label>
      <textarea name="promptTemplate" class="code" placeholder="你是资深行业分析师。请基于用户提供的资料……"></textarea>
      <div class="actions" style="margin-top:10px">
        <button class="btn btn--primary btn--sm" type="submit">创建技能</button>
      </div>
    </form>
  </div>`;

  const body = `
    <div class="work__head">
      <span class="work__title">技能广场</span>
      <span class="work__meta">共 ${all.length} 个技能 · ${all.filter((s) => s.origin === 'official').length} 官方内置 + ${userCount} 自建 · 小说与文档共用</span>
    </div>
    ${error ? `<p class="banner bad">${escapeHtml(error)}</p>` : notice ? `<p class="banner ok">${escapeHtml(notice)}</p>` : ''}
    <div class="scroll">
      ${isNewVisible(kind) ? createForm : ''}
      <div class="grid">${cards || `<div class="empty">该分类下还没有技能</div>`}</div>    </div>`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>技能广场 · Fabula</title>
<style>${CSS}</style></head>
<body>
<div class="app">
  <aside class="rail">
    <div class="rail__brand">技能广场<span class="sub">找现成写法，或造一个自己的</span></div>
    <a class="rail__new" href="/skills?new=1">＋ 新建技能</a>
    <div class="rail__sect">分类</div>
    <div class="rail__list">${filters}</div>
    <div class="rail__foot">
      <a href="/">小说工作台</a>
      <a href="/docs">文档工作台</a>
      <a href="/status">任务状态</a>
    </div>
  </aside>
  <main class="work">${body}</main>
</div>
</body></html>`;
}

function isNewVisible(kind) {
  return kind === 'new';
}

async function handleSkills(req, res, pathname, token) {
  const u = new URL(req.url, 'http://localhost');
  const parts = pathname.split('/').filter(Boolean);
  if (req.method === 'GET') {
    if (pathname === '/skills') {
      const kind = u.searchParams.get('kind') || '';
      const domain = ['novel', 'doc'].includes(u.searchParams.get('domain')) ? u.searchParams.get('domain') : '';
      const outcome = noticeFor();
      // new=1 时主区显示新建表单（分类过滤仍可用）
      sendHtml(res, renderSkillsPage({ csrf: token, kind: u.searchParams.get('new') === '1' ? 'new' : kind, domain, ...outcome }));
      return true;
    }
    if (parts.length === 3 && parts[1] === 'export') {
      const skill = mis.listSkills().find((item) => item.id === parts[2]);
      if (!skill) { res.writeHead(404); res.end('not found'); return true; }
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="skill-${String(skill.id).slice(0, 8)}.md"`,
        'Cache-Control': 'no-store',
      });
      res.end(skillMarkdown(skill));
      return true;
    }
    return false;
  }
  if (req.method !== 'POST' || !['create', 'toggle', 'delete'].includes(parts[1] || '')) return false;
  let form;
  try { form = await readForm(req); }
  catch (error) { res.writeHead(413); res.end('too large'); return true; }
  if (String(form.get('csrf') || '') !== token) { res.writeHead(403); res.end('bad csrf'); return true; }
  try {
    if (parts[1] === 'create') {
      mis.createSkill({
        name: String(form.get('name') || '').trim(),
        description: String(form.get('description') || '').trim(),
        promptTemplate: String(form.get('promptTemplate') || '').trim(),
        kind: String(form.get('kind') || 'method'),
        usageMode: String(form.get('usageMode') || 'support'),
        domain: ['novel', 'doc'].includes(String(form.get('domain') || '')) ? String(form.get('domain')) : 'novel',
      });
    } else if (parts[1] === 'toggle') {
      const skill = mis.listSkills().find((item) => item.id === String(form.get('id') || ''));
      if (skill) mis.setSkillEnabled({ id: skill.id, enabled: !skill.enabled });
    } else if (parts[1] === 'delete') {
      const skill = mis.listSkills().find((item) => item.id === String(form.get('id') || ''));
      if (skill && skill.origin !== 'official') mis.deleteSkill({ id: skill.id });
    }
  } catch (error) {
    sendHtml(res, renderSkillsPage({ csrf: token, error: String(error.message || error).slice(0, 200) }), 200);
    return true;
  }
  res.writeHead(303, { Location: '/skills' });
  res.end();
  return true;
}

const _notice = { at: 0, ok: true, message: '' };
function noticeFor() {
  if (!_notice.at || Date.now() - _notice.at > 10 * 60 * 1000) return {};
  return _notice.ok ? { notice: _notice.message } : { error: _notice.message };
}

module.exports = { renderSkillsPage, handleSkills };
