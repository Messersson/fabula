'use strict';

// 技能广场（本地版）：浏览/启停/新建/导出全部技能。
// 官方云端广场不可用（离线复刻定位），这里把"广场"落在本地技能库上。
const mis = require('./handlers-misc');
const statusPage = require('./status-page');

const { escapeHtml, sendHtml, readForm } = statusPage;

const KIND_TEXT = { method: '方法论', workflow: '工作流', craft: '技法', style: '文风', user: '自建' };

function skillMarkdown(skill) {
  return `# ${skill.name}\n\n> ${skill.description || ''}\n\n## 使用方式\n\n${skill.usageMode || 'support'}\n\n## 提示词模板\n\n\`\`\`text\n${skill.promptTemplate || ''}\n\`\`\`\n`;
}

function renderSkillsPage({ csrf, notice = '', error = '' }) {
  const skills = mis.listSkills();
  const cards = skills.map((skill) => {
    const official = skill.origin === 'official';
    const kind = KIND_TEXT[skill.kind] || skill.kind || '通用';
    return `<div class="card">
      <div class="head">
        <strong>${escapeHtml(skill.name)}</strong>
        <span class="badge mute">${escapeHtml(kind)}</span>
        ${official ? '<span class="badge live">官方内置</span>' : '<span class="badge warn">自建</span>'}
        <span class="badge ${skill.enabled ? 'ok' : 'bad'}">${skill.enabled ? '已启用' : '已停用'}</span>
      </div>
      <p class="desc">${escapeHtml(String(skill.description || '').slice(0, 220))}</p>
      <div class="actions">
        <form method="post" action="/skills/toggle" class="inline">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <input type="hidden" name="id" value="${skill.id}">
          <button class="small">${skill.enabled ? '停用' : '启用'}</button>
        </form>
        <a class="btn small" href="/skills/export/${skill.id}">导出 .md ↓</a>
        ${official ? '' : `<form method="post" action="/skills/delete" class="inline" onsubmit="return confirm('删除该技能？')">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <input type="hidden" name="id" value="${skill.id}">
          <button class="small danger">删除</button>
        </form>`}
      </div>
    </div>`;
  }).join('');

  const body = `
  <h1>技能广场</h1>
  <p class="lead">共 ${skills.length} 个技能（${skills.filter((s) => s.origin === 'official').length} 个官方内置 + ${skills.filter((s) => s.origin !== 'official').length} 个自建）。技能在小说对话与文档工作台中都会生效；官方云端广场在离线版不可用，这里就是本地广场。</p>
  <div class="grid">${cards || '<p class="empty">还没有技能</p>'}</div>
  <div class="card">
    <h2 style="margin-top:0">新建技能</h2>
    <form method="post" action="/skills/create">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <div class="row">
        <div><label>技能名</label><input type="text" name="name" required placeholder="如：竞品分析框架"></div>
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
      <label>提示词模板（正文中可写任务要求；保持"你是…请…"的祈使结构效果最好）</label>
      <textarea name="promptTemplate" class="code" style="min-height:140px" placeholder="你是资深行业分析师。请基于用户提供的资料……"></textarea>
      <div class="actions" style="margin-top:10px">
        <button class="primary" type="submit">创建技能</button>
      </div>
    </form>
  </div>`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>技能广场</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 26px 24px 56px; background: #f6f7f9; color: #1c1f23;
    font: 14px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 0 0 10px; }
  .lead { color: #6b7280; margin: 0 0 18px; font-size: 13px; }
  .nav { display: flex; gap: 10px; margin: 0 0 18px; font-size: 13px; }
  .nav a { color: #1c4f9c; text-decoration: none; padding: 3px 10px; border-radius: 999px; background: #fff; border: 1px solid #e3e6ea; }
  .banner { padding: 10px 12px; border-radius: 8px; margin: 0 0 16px; font-size: 13px; }
  .banner.ok { background: #eaf7ee; color: #1a6b36; }
  .banner.bad { background: #fdecec; color: #a1231f; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: #fff; border-radius: 10px; padding: 14px 16px;
    box-shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.1); }
  .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .desc { color: #6b7280; font-size: 12.5px; margin: 8px 0; min-height: 20px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; white-space: nowrap; }
  .badge.ok { background: #eaf7ee; color: #1a6b36; }
  .badge.live { background: #e8f1fe; color: #1c4f9c; }
  .badge.warn { background: #fff5e6; color: #8a5a00; }
  .badge.bad { background: #fdecec; color: #a1231f; }
  .badge.mute { background: #eef0f3; color: #6b7280; }
  label { display: block; font-weight: 600; font-size: 13px; margin: 12px 0 4px; }
  input[type=text], select, textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 8px 10px;
    border: 1px solid #d5d9df; border-radius: 8px; background: #fff; }
  textarea { min-height: 90px; resize: vertical; }
  textarea.code { font-family: Consolas, monospace; font-size: 12.5px; }
  .row { display: flex; gap: 14px; }
  .row > * { flex: 1; }
  button { font: inherit; font-size: 13px; padding: 6px 14px; border-radius: 8px; cursor: pointer;
    border: 1px solid #d5d9df; background: #fff; color: #1c1f23; }
  button.primary { background: #1c4f9c; border-color: #1c4f9c; color: #fff; }
  button.danger { color: #a1231f; border-color: #eccccc; }
  button.small { font-size: 12px; padding: 3px 10px; }
  .btn.small { display: inline-block; font-size: 12px; padding: 3px 10px; border-radius: 7px; cursor: pointer;
    border: 1px solid #d5d9df; background: #fff; color: #1c1f23; text-decoration: none; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; align-items: center; }
  form.inline { display: inline; }
  .empty { text-align: center; color: #8a919b; padding: 30px; grid-column: 1/-1; }
</style></head>
<body>
<div class="nav">
  <a href="/">小说工作台</a>
  <a href="/docs" style="font-weight:700;color:#123c7a">文档工作台</a>
  <a href="/skills" style="font-weight:700;color:#123c7a">技能广场</a>
  <a href="/status">任务状态</a>
</div>
${error ? `<p class="banner bad">${escapeHtml(error)}</p>` : notice ? `<p class="banner ok">${escapeHtml(notice)}</p>` : ''}
${body}
</body></html>`;
}

async function handleSkills(req, res, pathname, token) {
  const parts = pathname.split('/').filter(Boolean);
  if (req.method === 'GET') {
    if (pathname === '/skills') {
      sendHtml(res, renderSkillsPage({ csrf: token }));
      return true;
    }
    if (parts.length === 3 && parts[1] === 'export') {
      const skill = mis.listSkills().find((item) => item.id === parts[2]);
      if (!skill) { res.writeHead(404); res.end('not found'); return true; }
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        // 头部只允许 ASCII：中文技能名不能直接进 filename。
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

module.exports = { renderSkillsPage, handleSkills };
