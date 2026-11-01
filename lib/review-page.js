'use strict';

// 评审机制页面：开关 / 评审团 / 评审库 / 跑一轮 / 看报告。
//
// 页面只做三件事：把配置摊开、把轮次跑起来、把「谁说了什么、采纳了哪条」显示清楚。
// 评审逻辑一律在 lib/review-engine.js——页面不做判断，否则同一套规则会在页面与引擎里
// 各写一遍，最后两边不一致（文档工作台已经吃过这个亏）。

const statusPage = require('./status-page');
const review = require('./review-engine');

const { escapeHtml, sendHtml, readForm } = statusPage;

// 正在跑的轮次：内存集合即可——它只用于「同一作品不要并发跑两轮」，
// 真正的状态在 review_rounds.status 里，进程重启后以库为准。
const inflight = new Set();

function bad(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function redirect(res, location) {
  res.writeHead(303, { Location: location });
  res.end();
}

const CSS = `
:root{--c-bg:#fbfbf9;--c-card:#fff;--c-text:#1f1f1d;--c-sub:#6b6b66;--c-line:#e6e4dd;--c-accent:#185fa5;--c-warn:#a32d2d;--c-ok:#3b6d11}
*{box-sizing:border-box}
body{margin:0;background:var(--c-bg);color:var(--c-text);font:14px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:19px;font-weight:500;margin:0 0 4px}
h2{font-size:15px;font-weight:500;margin:26px 0 10px;display:flex;align-items:center;gap:8px}
.sub{color:var(--c-sub);font-size:12.5px}
.card{background:var(--c-card);border:1px solid var(--c-line);border-radius:12px;padding:16px 18px;margin:10px 0}
.row{display:flex;gap:12px;flex-wrap:wrap}
.row>*{flex:1;min-width:160px}
label{display:block;font-size:12px;color:var(--c-sub);margin:8px 0 4px}
input[type=text],input[type=password],select,textarea{width:100%;padding:8px 10px;border:1px solid var(--c-line);border-radius:8px;background:#fff;font:inherit;color:inherit}
textarea{min-height:88px;resize:vertical}
.btn{display:inline-block;padding:7px 14px;border:1px solid var(--c-line);border-radius:8px;background:#fff;color:inherit;font:inherit;cursor:pointer;text-decoration:none}
.btn:hover{border-color:#c9c6bd}
.btn--primary{background:var(--c-accent);border-color:var(--c-accent);color:#fff}
.btn--danger{color:var(--c-warn);border-color:#e8cfcf}
.btn--sm{padding:4px 10px;font-size:12.5px}
.meta{color:var(--c-sub);font-size:12px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid var(--c-line);font-size:11.5px;color:var(--c-sub);margin-right:6px}
.pill--ok{border-color:#cfe0b8;color:var(--c-ok)}
.pill--warn{border-color:#eccfcf;color:var(--c-warn)}
.list{list-style:none;padding:0;margin:0}
.list li{padding:9px 0;border-bottom:1px solid var(--c-line)}
.list li:last-child{border-bottom:none}
.q{margin:8px 0;padding-left:20px}
.q li{margin:4px 0}
.q li.warn{color:var(--c-warn)}
.inline{display:inline}
.rule{height:1px;background:var(--c-line);margin:16px 0}
.score{font-size:22px;font-weight:500}
.tabs{display:flex;gap:8px;margin:16px 0 4px;flex-wrap:wrap}
.tabs a{padding:5px 12px;border-radius:999px;border:1px solid var(--c-line);text-decoration:none;color:var(--c-sub);font-size:12.5px}
.tabs a.on{background:var(--c-accent);border-color:var(--c-accent);color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px}
`;

function layout(title, body, csrf, { workbench = 'doc', workId = '', sectionIdx = 0, target = '' } = {}) {
  // 工作台切换必须有：这套机制是给两个工作台的，但页面默认落在文档，
  // 小说用户进来只能看到「还没有小说」，然后以为功能不支持小说。
  const targetQuery = target ? `&target=${encodeURIComponent(target)}` : '';
  const backHref = workId
    ? `/review?workbench=${encodeURIComponent(workbench)}&workId=${encodeURIComponent(workId)}&sectionIdx=${Number(sectionIdx) || 0}${targetQuery}`
    : `/review?workbench=${encodeURIComponent(workbench)}`;
  const tab = (key, label) => `<a href="/review?workbench=${key}" class="${workbench === key ? 'on' : ''}">${label}</a>`;
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><div class="wrap">
<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
  <div><h1>${escapeHtml(title)}</h1><div class="sub">多厂商评审团 · 交叉验证 · 迭代优化</div></div>
  <div><a class="btn btn--sm" href="/docs">文档工作台</a> <a class="btn btn--sm" href="/">小说工作台</a></div>
</div>
<div class="tabs" style="margin-top:14px">
  ${tab('doc', '📄 文档工作台')}
  ${tab('novel', '📖 小说工作台')}
  ${workId ? `<a href="${backHref}">当前作品</a>` : ''}
</div>
${body}
</div></body></html>`;
}

function hidden(csrf, extra = {}) {
  const base = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
  const rest = Object.entries(extra)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(String(value))}">`)
    .join('');
  return base + rest;
}

// ---------- 开关 ----------

function renderSwitch(csrf, workbench, docType) {
  const docTypes = (() => {
    try {
      const types = require('./doc-engine').DOC_TYPES;
      return Object.values(types || {}).map((item) => ({ key: item.key, name: item.name, group: item.group }));
    } catch { return []; }
  })();
  const states = review.scopeStates(workbench, docTypes.map((item) => item.key));
  const stateText = (value, effective) => (value === '1' ? '显式开启' : value === '0' ? '显式关闭' : '跟随上一级')
    + `（当前${effective ? '开启' : '关闭'}）`;
  const scopeSelect = (name, value, effective) => `<select name="${name}">
      <option value=""${value === '' ? ' selected' : ''}>跟随上一级${value === '' ? `（${effective ? '开启' : '关闭'}）` : ''}</option>
      <option value="1"${value === '1' ? ' selected' : ''}>开启</option>
      <option value="0"${value === '0' ? ' selected' : ''}>关闭</option>
    </select>`;

  const typeRows = workbench === 'doc' && docTypes.length
    ? `<div class="rule"></div>
      <div class="meta">按文档类型单独控制（方案二：可以只对「申报书」开启，其他类型不受影响）</div>
      <form method="post" action="/review/scope" style="margin-top:8px">
        ${hidden(csrf, { workbench })}
        <div class="grid">
          ${docTypes.map((item) => {
            const row = states.types.find((entry) => entry.docType === item.key) || { own: '', effective: false };
            return `<div class="card" style="margin:0;padding:10px 12px">
              <div style="font-size:13px">${escapeHtml(item.name)}</div>
              <div class="meta">${escapeHtml(item.group || '')} · ${escapeHtml(stateText(row.own, row.effective))}</div>
              ${scopeSelect(`type_${item.key}`, row.own, row.effective)}
            </div>`;
          }).join('')}
        </div>
        <div style="margin-top:10px"><button class="btn btn--primary btn--sm" type="submit">保存类型开关</button></div>
      </form>`
    : '';

  return `<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div>
        <div style="font-size:13.5px">机制开关 <span class="pill ${states.global ? 'pill--ok' : ''}">${states.global ? '全局已开启' : '全局已关闭'}</span></div>
        <div class="meta">默认关闭。开启后，作品写完会自动进入评审流程；关闭完全不影响创作、保存与导出。三级开关：全局 → 工作台 → 文档类型，下一级可覆盖上一级。</div>
      </div>
      <form method="post" action="/review/scope" class="inline">
        ${hidden(csrf, { workbench })}
        <input type="hidden" name="global" value="${states.global ? '0' : '1'}">
        <button class="btn ${states.global ? 'btn--danger' : 'btn--primary'}" type="submit">${states.global ? '关闭全局' : '开启全局'}</button>
      </form>
    </div>
    <div class="rule"></div>
    <div class="row">
      <div>
        <div class="meta">全局</div>
        <div>${states.global ? '开启' : '关闭'}</div>
      </div>
      <div>
        <div class="meta">${escapeHtml(review.WORKBENCH_LABEL[workbench] || workbench)}</div>
        <div>${escapeHtml(stateText(states.workbench.own, states.workbench.effective))}</div>
        <form method="post" action="/review/scope" style="margin-top:6px">
          ${hidden(csrf, { workbench })}
          ${scopeSelect('workbenchValue', states.workbench.own, states.workbench.effective)}
          <button class="btn btn--sm" type="submit" style="margin-top:6px">保存</button>
        </form>
      </div>
      <div>
        <div class="meta">当前生效</div>
        <div>${review.isEnabled(workbench, docType) ? '开启' : '关闭'}</div>
      </div>
    </div>
    ${typeRows}
  </div>`;
}

// ---------- 评审团 ----------

function renderPanels(csrf, workbench) {
  const panels = review.listPanels(workbench);
  const channels = review.listChannels();
  // 默认留空：三个下拉都预选第一个渠道时，用户点保存会立刻撞上「渠道不能重复」，
  // 而他根本没意识到自己选了三次同一个。留空 = 这位评审员不加入。
  const channelSelect = (name, selected = '') => (channels.length
    ? `<select name="${name}"><option value="">（不启用这位评审员）</option>`
      + channels.map((item) => `<option value="${escapeHtml(item.id)}"${selected === item.id ? ' selected' : ''}>${escapeHtml(item.label)}${item.model ? ` · ${escapeHtml(item.model)}` : ''}</option>`).join('')
      + '</select>'
    : '<select name="' + name + '"><option value="">（还没有可用渠道，先去设置里添加）</option></select>');

  const workTypeOf = (panel) => (panel.workbench === 'novel'
    ? 'novel'
    : (panel.docType ? `doc:${panel.docType}` : 'doc'));

  const slot = (n, current = {}) => `<div class="card">
    <div class="meta">评审员 ${n}</div>
    <div class="row">
      <div><label>名称</label><input type="text" name="rv${n}name" value="${escapeHtml(current.name || '')}" placeholder="如：资深审稿人"></div>
      <div><label>渠道（厂商/模型）</label>${channelSelect(`rv${n}channel`, current.channelId || '')}</div>
    </div>
    <div class="row">
      <div><label>角色人设</label><input type="text" name="rv${n}persona" value="${escapeHtml(current.persona || '')}" placeholder="如：出版级审稿人 / 读者代表"></div>
      <div><label>评审风格</label><input type="text" name="rv${n}style" value="${escapeHtml(current.style || '')}" placeholder="如：犀利批判型 / 温和鼓励型"></div>
    </div>
    <label>评审专长</label>
    <input type="text" name="rv${n}specialty" value="${escapeHtml(current.specialty || '')}" placeholder="如：擅长论文的论证与引用规范；也可同时声明擅长小说">
    <div class="meta" style="margin-top:4px">厂商/模型标识会按所选渠道自动生成（厂商甲/模型 X 这类通用标识，不展示真实厂商名）。</div>
  </div>`;

  const cards = panels.map((panel) => {
    const members = panel.reviewers.map((item) => {
      // 每位评审员实际会用的 Skill：绑定的优先，没有绑定就按类型自动匹配。
      const skills = review.skillsFor({ reviewerId: item.id, workType: workTypeOf(panel) });
      const labels = [...skills.method, ...skills.style, ...skills.focus]
        .map((skill) => `${skill.name}${skill.builtin ? '（默认）' : ''}`);
      const weights = Object.entries(skills.weights || {});
      return `<li>
      <b>${escapeHtml(item.name)}</b>
      <span class="meta">${escapeHtml(item.modelLabel || '未标注厂商/模型')}${item.persona ? ` · ${escapeHtml(item.persona)}` : ''}</span>
      ${item.specialty ? `<div class="meta">专长：${escapeHtml(item.specialty)}</div>` : ''}
      <div class="meta">用到的 Skill：${escapeHtml(labels.join('、') || '（无）')}</div>
      ${weights.length ? `<div class="meta">权重：${escapeHtml(weights.map(([name, value]) => `${name}×${value}`).join('、'))}</div>` : ''}
    </li>`;
    }).join('');
    const warnings = review.panelWarnings(panel);
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
        <div><b>${escapeHtml(panel.name)}</b>
          <span class="pill">${panel.reviewers.length} 位</span>
          ${panel.docType ? `<span class="pill">${escapeHtml(panel.docType)}</span>` : '<span class="pill">通用</span>'}
          ${panel.maxRounds ? `<span class="pill">最多 ${panel.maxRounds} 轮</span>` : ''}
          ${panel.tokenBudget ? `<span class="pill">每轮 ≤ ${Number(panel.tokenBudget).toLocaleString('zh-CN')} tokens</span>` : ''}
        </div>
        <form method="post" action="/review/panel/delete" class="inline" onsubmit="return confirm('删除这个评审团？历史轮次记录会保留')">
          ${hidden(csrf, { panelId: panel.id, workbench })}
          <button class="btn btn--sm btn--danger" type="submit">删除</button>
        </form>
      </div>
      <ul class="list">${members}</ul>
      ${warnings.length ? `<div class="meta" style="margin-top:6px">独立性与兼容性提醒</div>
        <ul class="q">${warnings.map((text) => `<li class="warn">${escapeHtml(text)}</li>`).join('')}</ul>` : ''}
      <details style="margin-top:8px">
        <summary class="meta" style="cursor:pointer">编辑这个评审团（换人 / 增删 / 改类型与轮次上限）</summary>
        <form method="post" action="/review/panel/save" style="margin-top:10px">
          ${hidden(csrf, { workbench })}
          <input type="hidden" name="id" value="${escapeHtml(panel.id)}">
          <div class="row">
            <div><label>评审团名称</label><input type="text" name="name" value="${escapeHtml(panel.name)}" required></div>
            <div><label>绑定文档类型（可空）</label><input type="text" name="docType" value="${escapeHtml(panel.docType || '')}" placeholder="如 paper / proposal，空=通用"></div>
            <div style="flex:0 0 140px"><label>最多几轮（0=不限）</label><input type="text" name="maxRounds" value="${Number(panel.maxRounds) || 0}"></div>
            <div style="flex:0 0 170px"><label>每轮 token 预算（0=不限）</label><input type="text" name="tokenBudget" value="${Number(panel.tokenBudget) || 0}"></div>
          </div>
          <div class="grid" style="margin-top:10px">
            ${slot(1, panel.reviewers[0] || {})}${slot(2, panel.reviewers[1] || {})}${slot(3, panel.reviewers[2] || {})}
          </div>
          <div class="meta" style="margin-top:8px">留空的评审员不会加入；保存后成员按这里的填写整体替换。</div>
          <div style="margin-top:10px"><button class="btn btn--primary" type="submit">保存修改</button></div>
        </form>
      </details>
    </div>`;
  }).join('');

  return `<h2>评审团 <span class="meta">1~3 位，互不干扰、各自独立出意见</span></h2>
  ${cards || '<div class="card meta">还没有评审团。下面填一个：至少 1 位评审员，每位选一个不同渠道（否则「多厂商评审」会退化成同一模型自评）。</div>'}
  <details class="card">
    <summary style="cursor:pointer">＋ 新建 / 追加评审团</summary>
    <form method="post" action="/review/panel/save" style="margin-top:12px">
      ${hidden(csrf, { workbench })}
      <div class="row">
        <div><label>评审团名称</label><input type="text" name="name" placeholder="如：学术评审团" required></div>
        <div><label>绑定文档类型（可空）</label><input type="text" name="docType" placeholder="如 paper / proposal，空=通用"></div>
        <div style="flex:0 0 140px"><label>最多几轮（0=不限）</label><input type="text" name="maxRounds" value="0"></div>
        <div style="flex:0 0 170px"><label>每轮 token 预算（0=不限）</label><input type="text" name="tokenBudget" value="0"></div>
      </div>
      <div class="grid" style="margin-top:10px">${slot(1)}${slot(2)}${slot(3)}</div>
      <div class="meta" style="margin-top:8px">评审员 2、3 可留空（留空的不会被加入）。</div>
      <div style="margin-top:10px"><button class="btn btn--primary" type="submit">保存评审团</button></div>
    </form>
  </details>`;
}

// ---------- 评审库 ----------

function renderSkills(csrf, workbench) {
  // 管理页面要看得到停用的 Skill，否则停用之后它就从页面上消失了，
  // 作者既不知道它还在，也没法再启用回来。
  const all = review.listSkills({ includeDisabled: true });
  const shared = all.filter((item) => !item.reviewerId);
  const owned = all.filter((item) => item.reviewerId);
  const reviewers = review.listAllReviewers();
  const reviewerName = new Map(reviewers.map((item) => [item.id, `${item.name}（${item.panelName}）`]));
  // 一条 Skill 要能明确「配给谁」。没有这一步，方案里的
  // 「给编辑配这三条、给读者配那三条」就无法表达，三个评审员只能拿到同一套标准。
  const line = (skill) => {
    const bound = review.reviewerIdsOfSkill(skill.id);
    const weights = Object.entries(skill.weights || {});
    const bindBox = reviewers.length
      ? `<details style="margin-top:6px"><summary class="meta" style="cursor:pointer">绑定到评审员（已绑 ${bound.length} 位）</summary>
          <form method="post" action="/review/skill/bind" style="margin-top:6px">
            ${hidden(csrf, { skillId: skill.id, workbench })}
            <div class="row" style="gap:8px">
              ${reviewers.map((item) => `<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;min-width:180px">
                <input type="checkbox" name="reviewerId" value="${escapeHtml(item.id)}" ${bound.includes(item.id) ? 'checked' : ''}>
                ${escapeHtml(item.name)}<span class="meta">${escapeHtml(item.panelName)}</span>
              </label>`).join('')}
            </div>
            <div class="meta" style="margin-top:6px">不勾选 = 这条 Skill 只按作品类型自动匹配，不专属给任何人。</div>
            <div style="margin-top:8px"><button class="btn btn--sm" type="submit">保存绑定</button></div>
          </form>
        </details>`
      : '<div class="meta" style="margin-top:6px">还没有评审员——先在上面组建评审团，才能把 Skill 配给具体的人。</div>';
    return `<li>
    <b>${escapeHtml(skill.name)}</b>
    <span class="pill">${escapeHtml(review.SKILL_KINDS[skill.kind] || skill.kind)}</span>
    ${skill.enabled === false ? '<span class="pill pill--warn">已停用</span>' : ''}
    <span class="meta">适用：${escapeHtml(skill.appliesTo.join('、') || '未声明')}${skill.source === 'distilled' ? ' · 蒸馏产出' : ''}</span>
    ${bound.length ? `<div class="meta">绑定：${escapeHtml(bound.map((id) => reviewerName.get(id) || id).join('、'))}</div>` : ''}
    ${weights.length ? `<div class="meta">权重：${escapeHtml(weights.map(([name, value]) => `${name}×${value}`).join('、'))}</div>` : ''}
    <div class="meta" style="white-space:pre-wrap;margin-top:4px">${escapeHtml(skill.body.slice(0, 220))}${skill.body.length > 220 ? '…' : ''}</div>
    ${bindBox}
    <details style="margin-top:6px"><summary class="meta" style="cursor:pointer">编辑这条 Skill</summary>
      <form method="post" action="/review/skill/save" style="margin-top:8px">
        ${hidden(csrf, { workbench })}
        <input type="hidden" name="id" value="${escapeHtml(skill.id)}">
        <div class="row">
          <div><label>名称</label><input type="text" name="name" value="${escapeHtml(skill.name)}" required></div>
          <div><label>类型</label><select name="kind">
            ${Object.entries(review.SKILL_KINDS).map(([key, label]) => `<option value="${key}"${skill.kind === key ? ' selected' : ''}>${escapeHtml(label)}</option>`).join('')}
          </select></div>
        </div>
        <div class="row">
          <div><label>归属评审员（空=共享池）</label><input type="text" name="reviewerId" value="${escapeHtml(skill.reviewerId || '')}"></div>
          <div><label>适用类型</label><input type="text" name="appliesTo" value="${escapeHtml(skill.appliesTo.join(','))}" required></div>
        </div>
        <div class="row">
          <div><label>维度权重（可空）</label><input type="text" name="weights" value="${escapeHtml(weights.map(([name, value]) => `${name}=${value}`).join(', '))}"></div>
        </div>
        <label>内容</label>
        <textarea name="body" style="min-height:120px">${escapeHtml(skill.body)}</textarea>
        <div style="margin-top:8px"><button class="btn btn--sm" type="submit">保存修改</button></div>
      </form>
    </details>
    <form method="post" action="/review/skill/toggle" class="inline" style="margin-top:6px">
      ${hidden(csrf, { skillId: skill.id, workbench })}
      <input type="hidden" name="on" value="${skill.enabled === false ? '1' : '0'}">
      <button class="btn btn--sm" type="submit">${skill.enabled === false ? '启用' : '停用'}</button>
    </form>
    <form method="post" action="/review/skill/delete" class="inline" style="margin-top:6px">
      ${hidden(csrf, { skillId: skill.id, workbench })}
      <button class="btn btn--sm btn--danger" type="submit">删除</button>
    </form>
  </li>`;
  };
  return `<h2>评审库 <span class="meta">每位评审员独立拥有；共享池对所有评审员生效</span></h2>
  <div class="card">
    <div class="meta">共享池（${shared.length}）</div>
    <ul class="list">${shared.map(line).join('') || '<li class="meta">空</li>'}</ul>
    <div class="rule"></div>
    <div class="meta">评审员专属（${owned.length}）</div>
    <ul class="list">${owned.map(line).join('') || '<li class="meta">空</li>'}</ul>
  </div>
  <details class="card">
    <summary style="cursor:pointer">＋ 新建 Skill</summary>
    <form method="post" action="/review/skill/save" style="margin-top:12px">
      ${hidden(csrf, { workbench })}
      <div class="row">
        <div><label>名称</label><input type="text" name="name" placeholder="如：论证逻辑完整性检查" required></div>
        <div><label>类型</label><select name="kind">
          <option value="method">评审技能（怎么审）</option>
          <option value="style">评审风格（怎么说）</option>
          <option value="focus" selected>评审重点（审什么）</option>
        </select></div>
      </div>
      <div class="row">
        <div><label>归属评审员（空=共享池）</label><input type="text" name="reviewerId" placeholder="评审员 id，可留空"></div>
        <div><label>适用类型</label><input type="text" name="appliesTo" placeholder="novel / doc / doc:paper / *（逗号分隔）" required></div>
      </div>
      <div class="row">
        <div><label>维度权重（可空，等权即默认）</label><input type="text" name="weights" placeholder="如：论证论据=2, 逻辑结构=1.5"></div>
      </div>
      <div class="meta">填了权重后，评审员要按维度分别给分，总分由系统加权算出（不采信它自报的总分）。</div>
      <label>内容（写成可执行的检查项）</label>
      <textarea name="body" placeholder="如：&#10;1. 每个核心论点是否至少有一条可核对的依据；&#10;2. 结论是否回应了引言提出的问题；&#10;3. 是否存在只给结论不给机制的一段。"></textarea>
      <div style="margin-top:10px"><button class="btn btn--primary" type="submit">保存 Skill</button></div>
    </form>
  </details>
  <details class="card">
    <summary style="cursor:pointer">🧪 从优秀作品蒸馏 Skill</summary>
    ${(() => {
      // 方案 8.3「平台内已获高评分的作品」：不必让作者自己翻找哪篇写得好
      let sources = [];
      try { sources = review.suggestDistillSources({ workbench, limit: 6 }); } catch { sources = []; }
      if (!sources.length) {
        return '<div class="meta" style="margin-top:8px">还没有高评分作品可推荐——先跑几轮评审，均分 70 以上的小节会自动出现在这里。</div>';
      }
      return `<div class="meta" style="margin-top:8px">推荐蒸馏源（历史评审均分 ≥70）</div>
        <ul class="list">${sources.map((item) => `<li>
          <span>${escapeHtml(item.title)}</span>
          <span class="pill">${item.score} 分</span>
          <span class="meta">${item.rounds} 轮评审</span>
          <form method="post" action="/review/distill-from-work" class="inline" style="margin-left:8px">
            ${hidden(csrf, { workbench, workId: item.workId, sectionIdx: item.sectionIdx, kind: 'focus' })}
            <button class="btn btn--sm" type="submit">用这篇蒸馏</button>
          </form>
        </li>`).join('')}</ul>`;
    })()}
    <div class="rule"></div>
    <form method="post" action="/review/distill" style="margin-top:12px">
      ${hidden(csrf, { workbench })}
      <div class="row">
        <div><label>蒸馏源类型</label><input type="text" name="workType" value="${workbench === 'novel' ? 'novel' : 'doc:paper'}" required></div>
        <div><label>生成 Skill 类型</label><select name="kind">
          <option value="focus" selected>评审重点</option><option value="method">评审技能</option><option value="style">评审风格</option>
        </select></div>
        <div><label>归属评审员（空=共享池）</label><input type="text" name="reviewerId" placeholder="可留空"></div>
      </div>
      <label>粘贴优秀作品全文（至少 300 字）</label>
      <textarea name="sample" style="min-height:160px" placeholder="贴一篇你认为写得好的同类作品。系统会提炼成「可迁移的检查项」，而不是复制这篇作品。"></textarea>
      <div style="margin-top:10px"><button class="btn" type="submit">蒸馏成 Skill</button></div>
    </form>
  </details>`;
}

// ---------- 作品入口 ----------

function renderWorks(csrf, workbench, workId, sectionIdx, target = '') {
  if (workbench && workId) {
    let title = '';
    try {
      const work = review.resolveWork({ workbench, workId, sectionIdx, target });
      title = work.title;
      const rounds = review.listRounds({ workbench: work.workbench, workId: work.workId, sectionIdx: work.sectionIdx, target: work.target });
      const running = rounds.find((item) => item.status === 'running');
      const pausedRound = rounds.find((item) => item.status === 'paused');
      // 小说侧的评审对象不止正文章节：设定 / 细纲 / 番外 / 全文各有独立的轮次。
      // 没有这层导航，设定和细纲写得再好也进不了评审闭环。
      const targetNav = (() => {
        if (workbench !== 'novel') return '';
        let groups = [];
        try { groups = review.novelTargets(workId); } catch { groups = []; }
        if (!groups.length) return '';
        return `<details class="card"${groups.length > 1 ? '' : ' open'}>
          <summary style="cursor:pointer">切换评审对象 <span class="meta">章节 / 全文 / 设定 / 细纲 / 番外</span></summary>
          <div class="grid" style="margin-top:10px">
            ${groups.map((group) => `<div class="card" style="margin:0;padding:10px 12px${group.target === work.target ? ';border-color:var(--c-accent)' : ''}">
              <div><b>${escapeHtml(group.label)}</b> <span class="meta">${escapeHtml(group.typeName)}</span></div>
              <ul class="list">${group.files.slice(0, 60).map((file) => `<li>
                <a href="/review?workbench=novel&workId=${encodeURIComponent(workId)}&target=${encodeURIComponent(group.target)}&sectionIdx=${file.idx}">${escapeHtml(file.name)}</a>
              </li>`).join('')}</ul>
            </div>`).join('')}
          </div>
        </details>`;
      })();
      const history = rounds.map((item) => {
        const statusText = item.status === 'done' ? '已完成'
          : item.status === 'running' ? '评审中'
            : item.status === 'paused' ? '已暂停'
              : item.status === 'cancelled' ? '已终止' : '失败';
        return `<li>
        <a href="/review?round=${encodeURIComponent(item.id)}">第 ${item.roundNo} 轮</a>
        <span class="pill${item.status === 'cancelled' ? ' pill--warn' : ''}">${statusText}</span>
        ${item.score != null ? `<span class="meta">均分 ${item.score}</span>` : ''}
        ${item.verdict === 'converged' ? '<span class="pill pill--ok">已收敛</span>' : ''}
        ${item.verdict === 'rounds-reached' ? '<span class="pill">已达设定轮次</span>' : ''}
        <span class="meta">${new Date(item.createdAt).toLocaleString('zh-CN')}</span>
      </li>`;
      }).join('');
      // 运行中：给「终止」。规范要求用户可随时暂停或终止，且已产生的记录要保留——
      // 没有这个按钮，作者只能等它跑完或直接关页面。
      // 当场挑评审团：同一篇作品，这一轮想用哪个团评，由作者决定。
      // 自动匹配只是默认值——「论文默认用学术团」是预设，不是强制。
      const panelOptions = (() => {
        let panels = [];
        try { panels = review.listPanels(workbench); } catch { panels = []; }
        if (!panels.length) return '';
        const matched = (() => { try { return review.defaultPanel(workbench, String(work.type || '').split(':')[1] || ''); } catch { return null; } })();
        return `<label style="font-size:12px;color:var(--c-sub);display:block;margin-bottom:4px">这一轮用哪个评审团</label>
          <select name="panelId" style="max-width:320px">
            ${panels.map((panel) => `<option value="${escapeHtml(panel.id)}"${matched && panel.id === matched.id ? ' selected' : ''}>
              ${escapeHtml(panel.name)}（${panel.reviewers.length} 位${panel.docType ? ` · ${escapeHtml(panel.docType)}` : ' · 通用'}）${matched && panel.id === matched.id ? ' · 默认' : ''}
            </option>`).join('')}
          </select>`;
      })();
      // 一个表单两个提交按钮：评审团选择必须和「开始」在同一个表单里，
      // 否则下拉框的值根本不会被提交（第一版就写成了这样）。
      const startForm = running
        ? `<div class="meta">这一轮正在评审中（每位评审员一次调用），可以等它跑完、暂停（保留已产出的意见），或立即终止。</div>
           <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
             <form method="post" action="/review/pause" class="inline">
               ${hidden(csrf, { roundId: running.id, workbench, workId, sectionIdx, target: work.target })}
               <button class="btn" type="submit">暂停这一轮</button>
             </form>
             <form method="post" action="/review/cancel" class="inline">
               ${hidden(csrf, { roundId: running.id, workbench, workId, sectionIdx, target: work.target })}
               <button class="btn btn--danger" type="submit">终止这一轮</button>
             </form>
           </div>`
        : pausedRound
          ? `<div class="meta">第 ${pausedRound.roundNo} 轮已暂停：${pausedRound.opinions ? `${pausedRound.opinions} 位评审员的意见` : '已产生的意见'}已保留，继续后从汇总阶段接着跑，不会重新调用评审员。</div>
             <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
               <form method="post" action="/review/resume" class="inline">
                 ${hidden(csrf, { roundId: pausedRound.id, workbench, workId, sectionIdx, target: work.target })}
                 <button class="btn btn--primary" type="submit">继续这一轮</button>
               </form>
               <form method="post" action="/review/cancel" class="inline">
                 ${hidden(csrf, { roundId: pausedRound.id, workbench, workId, sectionIdx, target: work.target })}
                 <button class="btn btn--danger" type="submit">终止这一轮</button>
               </form>
             </div>`
          : `<form method="post" action="/review/run" style="margin-top:8px">
            ${hidden(csrf, { workbench, workId, sectionIdx, target: work.target })}
            ${panelOptions}
            <div style="margin-top:8px">
              <button class="btn btn--primary" type="submit" name="apply" value="1"${work.apply ? '' : ' disabled title="整篇/整组评审只出意见，请进单节/单份文件落改"'}>${rounds.length ? '继续下一轮（含自动落改）' : '开始新一轮评审（含自动落改）'}</button>
              <button class="btn" type="submit" name="apply" value="0" style="margin-left:8px">只评审、不改稿</button>
            </div>
            ${work.apply ? '' : '<div class="meta" style="margin-top:6px">整篇 / 整组评审不自动落改：跨节修改要逐节确认，避免一键改全文把好段落改坏。</div>'}
          </form>`;
      const whereLabel = workbench === 'novel'
        ? `${escapeHtml(work.typeName || '小说')} · ${escapeHtml(work.sectionIdx > 0 ? `第 ${work.sectionIdx} 份` : '整组')}`
        : `${escapeHtml(review.WORKBENCH_LABEL[workbench])} · ${work.sectionIdx ? `第 ${work.sectionIdx} 节` : '整篇'}`;
      return `<h2>评审对象</h2>
      <div class="card">
        <div><b>${escapeHtml(title)}</b></div>
        <div class="meta">${whereLabel} · 正文 ${work.text.length} 字</div>
        <div style="margin-top:10px">${startForm}</div>
      </div>
      ${targetNav}
      <h2>轮次记录 <span class="meta">每轮的意见、采纳与改动都可回溯</span></h2>
      <div class="card"><ul class="list">${history || '<li class="meta">还没有评审记录</li>'}</ul></div>`;
    } catch (error) {
      return `<div class="card"><div class="warn">${escapeHtml(String(error.message || error))}</div>
        <a class="btn btn--sm" href="/review?workbench=${encodeURIComponent(workbench)}">返回作品列表</a></div>`;
    }
  }
  // 没有指定作品：列出可评审对象
  const docs = (() => {
    try { return require('./doc-engine').listProjects(); } catch { return []; }
  })().slice(0, 20);
  const books = (() => {
    try { return require('./handlers-core').listBooks(); } catch { return []; }
  })().slice(0, 20);
  const typeName = (key) => {
    try { return require('./doc-engine').docTypeOf(key).name; } catch { return String(key || ''); }
  };
  const docList = docs.map((item) => `<li>
    <a href="/review?workbench=doc&workId=${encodeURIComponent(item.id)}&sectionIdx=1">${escapeHtml(item.title)}</a>
    <span class="meta">${escapeHtml(typeName(item.docType))} · ${Number(item.done || 0)}/${Number(item.total || 0)} 节</span>
  </li>`).join('');
  const bookList = books.map((item) => `<li>
    <a href="/review?workbench=novel&workId=${encodeURIComponent(item.id)}&sectionIdx=1">${escapeHtml(item.title || item.name || item.id)}</a>
    <span class="meta">小说</span>
  </li>`).join('');
  return `<h2>选择要评审的作品</h2>
  <div class="row">
    <div class="card"><div class="meta">文档工作台</div><ul class="list">${docList || '<li class="meta">还没有文档项目</li>'}</ul></div>
    <div class="card"><div class="meta">小说工作台</div><ul class="list">${bookList || '<li class="meta">还没有小说</li>'}</ul></div>
  </div>`;
}

// ---------- 报告 ----------

function renderRound(roundId, csrf) {
  const round = review.getRound(roundId);
  if (!round) return `<div class="card">没有找到这一轮评审。</div>`;
  if (round.status === 'running') {
    return `<div class="card">
      <div>第 ${round.roundNo} 轮评审进行中…</div>
      <div class="meta">评审团正在独立评审（每位评审员各自一份提示词，互不可见），完成后本页自动刷新。</div>
      <div class="meta">暂停会在意见收集完成后停下并保留已产出的意见；终止会立即打断在飞的调用。</div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <form method="post" action="/review/pause" class="inline">
          ${hidden(csrf, { roundId: round.id })}
          <button class="btn" type="submit">暂停这一轮</button>
        </form>
        <form method="post" action="/review/cancel" class="inline">
          ${hidden(csrf, { roundId: round.id })}
          <button class="btn btn--danger" type="submit">终止这一轮</button>
        </form>
        <a class="btn" href="/review?workbench=${escapeHtml(round.workbench)}&workId=${encodeURIComponent(round.workId)}&sectionIdx=${round.sectionIdx}&target=${encodeURIComponent(round.target)}">返回作品</a>
      </div>
      <meta http-equiv="refresh" content="4">
    </div>`;
  }
  if (round.status === 'paused') {
    // 暂停不是结束：意见已落库，继续时直接汇总，不重新调用评审员。
    // 所以这里要能看见「已经拿到了什么」，而不是只有一个继续按钮。
    const opList = round.opinions.map((item) => `<div class="card">
      <b>${escapeHtml(item.reviewerName)}</b>
      ${item.score != null ? `<span class="score">${item.score}</span>` : ''}
      ${item.error ? `<div class="meta">调用失败：${escapeHtml(item.error)}</div>` : ''}
      ${item.summary ? `<div class="meta">${escapeHtml(item.summary)}</div>` : ''}
    </div>`).join('');
    return `<div class="card">
      <div>第 ${round.roundNo} 轮评审已暂停 <span class="pill">意见已保留</span></div>
      <div class="meta" style="margin-top:6px">继续后从交叉验证与落改阶段接着跑，不会重新调用评审员。</div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <form method="post" action="/review/resume" class="inline">
          ${hidden(csrf, { roundId: round.id })}
          <button class="btn btn--primary" type="submit">继续这一轮</button>
        </form>
        <form method="post" action="/review/cancel" class="inline">
          ${hidden(csrf, { roundId: round.id })}
          <button class="btn btn--danger" type="submit">终止这一轮</button>
        </form>
        <a class="btn" href="/review?workbench=${escapeHtml(round.workbench)}&workId=${encodeURIComponent(round.workId)}&sectionIdx=${round.sectionIdx}&target=${encodeURIComponent(round.target)}">返回作品</a>
      </div>
    </div>
    <h2>已产生的意见 <span class="meta">暂停前已完成的部分</span></h2>${opList || '<div class="card meta">还没有评审员返回</div>'}`;
  }
  if (round.status === 'failed') {
    // 失败原因要能指导下一步：只说「失败」等于让作者去猜是网络、密钥还是配置。
    return `<div class="card">
      <div class="warn">第 ${round.roundNo} 轮评审没有成功</div>
      <div class="meta" style="margin-top:6px">${escapeHtml(round.error || '未知原因')}</div>
      <div class="rule"></div>
      <div class="meta">常见原因与处理：</div>
      <ul class="q">
        <li>渠道不可用或密钥失效——到设置里确认这些渠道能单独对话</li>
        <li>模型返回的不是 JSON——换一个支持结构化输出的模型，或降低温度</li>
        <li>网络/代理拦截——本地服务访问外部接口失败时通常报 fetch failed</li>
      </ul>
      <div style="margin-top:10px"><a class="btn" href="/review?workbench=${escapeHtml(round.workbench)}&workId=${encodeURIComponent(round.workId)}&sectionIdx=${round.sectionIdx}&target=${encodeURIComponent(round.target)}">返回作品重试</a></div>
    </div>`;
  }
  const report = round.report || {};
  const opinions = round.opinions.map((item) => {
    if (item.error) {
      return `<div class="card"><b>${escapeHtml(item.reviewerName)}</b>
        <span class="pill pill--warn">调用失败</span>
        <div class="meta">${escapeHtml(item.error)}</div></div>`;
    }
    const issues = item.issues.map((issue) => `<li class="${issue.severity === 'fatal' ? 'warn' : ''}">
      <span class="pill ${issue.severity === 'fatal' ? 'pill--warn' : ''}">${escapeHtml(review.SEVERITY_LABEL[issue.severity] || issue.severity)}</span>
      ${escapeHtml(issue.dimension)}：${escapeHtml(issue.text)}${issue.where ? `<span class="meta">（${escapeHtml(issue.where)}）</span>` : ''}
    </li>`).join('');
    const highlights = item.highlights.map((entry) => `<li>${escapeHtml(entry.text)}${entry.why ? `<span class="meta">——${escapeHtml(entry.why)}</span>` : ''}</li>`).join('');
    // 修改建议是评审员给「怎么改」的落点；只显示问题而不显示建议，
    // 作者拿到的仍然是一句「论证过简」，等于让作者自己重新想一遍。
    const suggestions = (item.suggestions || []).map((entry) => `<li><b>${escapeHtml(entry.change)}</b>`
      + `${entry.how ? `<div class="meta">怎么改：${escapeHtml(entry.how)}</div>` : ''}`
      + `${entry.why ? `<div class="meta">为什么：${escapeHtml(entry.why)}</div>` : ''}</li>`).join('');
    const priority = (item.priority || []).map((entry) => `<li>${escapeHtml(entry)}</li>`).join('');
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px">
        <div><b>${escapeHtml(item.reviewerName)}</b>
          <span class="meta">${escapeHtml(item.modelLabel || '')}</span></div>
        <div>${item.score != null ? `<span class="score">${item.score}</span>` : ''}${item.grade ? `<span class="pill">${escapeHtml(item.grade)}</span>` : ''}</div>
      </div>
      ${item.summary ? `<div style="margin:6px 0">${escapeHtml(item.summary)}</div>` : ''}
      ${highlights ? `<div class="meta">亮点</div><ul class="q">${highlights}</ul>` : ''}
      ${issues ? `<div class="meta">问题</div><ul class="q">${issues}</ul>` : ''}
      ${suggestions ? `<div class="meta">修改建议</div><ul class="q">${suggestions}</ul>` : ''}
      ${priority ? `<div class="meta">优先级排序</div><ol class="q">${priority}</ol>` : ''}
      ${item.dimensions && item.dimensions.length ? `<div class="meta">分维度：${escapeHtml(item.dimensions.map((d) => `${d.name} ${d.score}`).join('、'))}</div>` : ''}
      ${item.focus.length ? `<div class="meta">本轮聚焦：${escapeHtml(item.focus.join('、'))}</div>` : ''}
    </div>`;
  }).join('');

  const decisions = round.decisions.map((item) => `<li class="${item.adopted ? '' : 'warn'}">
    <span class="pill ${item.adopted ? 'pill--ok' : 'pill--warn'}">${item.adopted ? '采纳' : '不采纳'}</span>
    <span class="pill">${escapeHtml(item.kind === 'consensus' ? '共识' : item.kind === 'conflict' ? '分歧' : '单人')}</span>
    ${escapeHtml(item.dimension)}：${escapeHtml(item.text)}
    <div class="meta">${escapeHtml(item.reason)}</div>
    ${(item.suggestions || []).length ? `<div class="meta">改法：${escapeHtml(item.suggestions.map((entry) => entry.change).join('；'))}</div>` : ''}
    ${item.instruction && item.instruction !== item.text ? `<div class="meta">落地指令：${escapeHtml(item.instruction)}</div>` : ''}
  </li>`).join('');

  // 维度汇总：需求第六条要求按维度归类，作者要能一眼看出问题集中在哪个维度。
  const dimensionRows = (Array.isArray(report.dimensions) ? report.dimensions : []).map((row) => `<li>
    <b>${escapeHtml(row.dimension)}</b>
    <span class="meta">问题 ${Number(row.issues || 0)} · 采纳 ${Number(row.adopted || 0)}`
      + `${Number(row.consensus || 0) ? ` · 共识 ${Number(row.consensus || 0)}` : ''}`
      + ` · ${Number(row.reviewers || 0)} 位评审员参与</span>
  </li>`).join('');
  const delta = report.delta == null ? null : Number(report.delta);
  const deltaText = delta == null ? '—' : `${delta > 0 ? '+' : ''}${delta}`;
  const deltaCls = delta == null ? '' : (delta > 0 ? 'pill--ok' : delta < 0 ? 'pill--warn' : '');
  // 长稿只评审了前 N 字：不能让它看起来像「全文都审过了」。
  const coverage = report.coverage || null;
  const coverageBlock = coverage && coverage.truncated
    ? `<div class="card" style="border-color:#eccfcf">
        <div style="color:var(--c-warn)">本次评审只覆盖了正文前 ${Number(coverage.reviewedChars) || 0} 字
          （全文 ${Number(coverage.totalChars) || 0} 字，单次上限 ${Number(coverage.limit) || 0} 字），后半部分没有参与评审。</div>
        <div class="meta" style="margin-top:6px">请按章节 / 小节分别评审，确保每一段都进过评审；未覆盖部分的意见不要当作全文结论。</div>
      </div>`
    : '';
  const before = String(round.beforeText || '');
  const after = String(round.afterText || '');
  const diffBlock = before && after
    ? `<details class="card"><summary style="cursor:pointer">修改前后对比 <span class="meta">${before.length} 字 → ${after.length} 字</span></summary>
        <div class="row" style="margin-top:10px">
          <div><div class="meta">改前（${escapeHtml(round.version)}）</div>
            <div style="white-space:pre-wrap;max-height:320px;overflow:auto;border:1px solid var(--c-line);border-radius:8px;padding:10px;margin-top:6px">${escapeHtml(before)}</div></div>
          <div><div class="meta">改后</div>
            <div style="white-space:pre-wrap;max-height:320px;overflow:auto;border:1px solid var(--c-line);border-radius:8px;padding:10px;margin-top:6px">${escapeHtml(after)}</div></div>
        </div>
      </details>`
    : '';
  return `<h2>第 ${round.roundNo} 轮评审 <span class="meta">${escapeHtml(report.title || '')}</span></h2>
  <div class="card">
    <div class="row">
      <div><div class="meta">均分</div><div class="score">${round.score == null ? '—' : round.score}</div></div>
      <div><div class="meta">评分变化</div><div><span class="pill ${deltaCls}">${deltaText}</span></div></div>
      <div><div class="meta">问题数</div><div>${Number(report.issueCount || 0)}</div></div>
      <div><div class="meta">采纳 / 不采纳</div><div>${Number(report.adopted || 0)} / ${Number(report.rejected || 0)}</div></div>
      <div><div class="meta">分歧</div><div>${Number(report.conflicts || 0)}</div></div>
      <div><div class="meta">版本</div><div class="meta">${escapeHtml(round.version)}</div></div>
    </div>
    ${round.intent ? `<div class="rule"></div><div class="meta">作者意图（可行性评估的依据）</div><div class="meta" style="white-space:pre-wrap">${escapeHtml(round.intent)}</div>` : ''}
    ${report.feasibility ? `<div class="meta" style="margin-top:8px">可行性评估：检查 ${Number(report.feasibility.checked || 0)} 条，${escapeHtml(report.feasibility.note || '')}</div>` : ''}
    ${report.converged ? '<div class="meta" style="margin-top:8px">连续两轮没有新增有效意见，质量已趋稳，可以定稿。</div>' : ''}
    ${report.applied && report.applied.applied ? '<div class="meta" style="margin-top:8px">本轮采纳意见已落到正文。</div>' : ''}
    ${report.applied && report.applied.applied === false ? `<div class="meta" style="margin-top:8px">未落改：${escapeHtml(report.applied.reason || '')}</div>` : ''}
    ${report.failures && report.failures.length ? `<ul class="q">${report.failures.map((text) => `<li class="warn">${escapeHtml(text)}</li>`).join('')}</ul>` : ''}
  </div>
  ${coverageBlock}
  ${dimensionRows ? `<h2>维度汇总 <span class="meta">按评审维度归类，问题集中在哪一目了然</span></h2>
    <div class="card"><ul class="list">${dimensionRows}</ul></div>` : ''}
  <h2>评审意见 <span class="meta">各评审员独立出具，未互相参考</span></h2>
  ${opinions}
  <h2>交叉验证 <span class="meta">共识合并、分歧仲裁、可行性评估、逐条采纳与否</span></h2>
  <div class="card"><ul class="q" style="list-style:none;padding-left:0">${decisions || '<li class="meta">没有可处理的意见</li>'}</ul></div>
  ${diffBlock}`;
}

// ---------- 路由 ----------

async function handleReview(req, res, pathname, token) {
  const u = new URL(req.url, 'http://localhost');
  if (req.method === 'GET') {
    if (pathname !== '/review' && pathname !== '/review/') return false;
    const workbench = String(u.searchParams.get('workbench') || 'doc');
    const workId = String(u.searchParams.get('workId') || '');
    const sectionIdx = Number(u.searchParams.get('sectionIdx') || 0);
    const target = String(u.searchParams.get('target') || '');
    const roundId = String(u.searchParams.get('round') || '');
    const body = roundId
      ? `<div class="tabs"><a href="/review?workbench=${encodeURIComponent(workbench)}${workId ? `&workId=${encodeURIComponent(workId)}&sectionIdx=${sectionIdx}${target ? `&target=${encodeURIComponent(target)}` : ''}` : ''}">← 返回作品与轮次列表</a></div>${renderRound(roundId, token)}`
      : [
        renderSwitch(token, workbench, String(u.searchParams.get('docType') || '')),
        renderWorks(token, workbench, workId, sectionIdx, target),
        renderPanels(token, workbench),
        renderSkills(token, workbench),
      ].join('\n');
    sendHtml(res, layout('AI 评审机制', body, token, { workbench, workId, sectionIdx, target }));
    return true;
  }
  if (req.method !== 'POST') return false;
  if (!pathname.startsWith('/review/')) return false;
  const action = pathname.slice('/review/'.length);
  let form;
  try { form = await readForm(req, 8 * 1024 * 1024); } catch { bad(res, 400, 'bad form'); return true; }
  if (String(form.get('csrf') || '') !== token) { bad(res, 403, 'bad csrf'); return true; }
  const workbench = String(form.get('workbench') || 'doc');
  const back = `/review?workbench=${encodeURIComponent(workbench)}`;

  try {
    if (action === 'scope') {
      // 全局
      if (form.get('global') != null) {
        review.setScope({ workbench: '', docType: '', value: String(form.get('global')) });
      }
      // 工作台级
      if (form.get('workbenchValue') != null) {
        review.setScope({ workbench, docType: '', value: String(form.get('workbenchValue')) });
      }
      // 类型级：表单里带 type_xxx 的逐项保存
      for (const [key, value] of form.entries()) {
        if (!key.startsWith('type_')) continue;
        review.setScope({ workbench, docType: key.slice('type_'.length), value: String(value) });
      }
      redirect(res, back);
      return true;
    }
    if (action === 'toggle') {
      review.setEnabled({
        enabled: String(form.get('enabled') || '') === '1',
        workbench, docType: String(form.get('docType') || ''),
      });
      redirect(res, back);
      return true;
    }
    if (action === 'cancel') {
      const result = review.cancelRound(String(form.get('roundId') || ''));
      const backTarget = String(form.get('target') || '');
      const target = String(form.get('workId') || '')
        ? `/review?workbench=${encodeURIComponent(workbench)}&workId=${encodeURIComponent(String(form.get('workId')))}&sectionIdx=${Number(form.get('sectionIdx') || 0)}${backTarget ? `&target=${encodeURIComponent(backTarget)}` : ''}`
        : back;
      if (!result.ok) bad(res, 400, result.reason || '无法终止');
      else redirect(res, target);
      return true;
    }
    if (action === 'pause') {
      const roundId = String(form.get('roundId') || '');
      const result = review.pauseRound(roundId);
      if (!result.ok) { bad(res, 400, result.reason || '无法暂停'); return true; }
      redirect(res, `/review?round=${encodeURIComponent(roundId)}`);
      return true;
    }
    if (action === 'resume') {
      const roundId = String(form.get('roundId') || '');
      // resumeRound 先同步校验并把状态改回 running，再返回后台 Promise：
      // 这样页面能立即跳转，真正的模型调用不会卡住这个请求。
      const pending = review.resumeRound(roundId);
      pending.catch((error) => {
        try { console.error('[review] 继续失败：', error && error.message); } catch { /* ignore */ }
      });
      redirect(res, `/review?round=${encodeURIComponent(roundId)}`);
      return true;
    }
    if (action === 'panel/save') {
      const reviewers = [];
      for (const n of [1, 2, 3]) {
        const channelId = String(form.get(`rv${n}channel`) || '');
        if (!channelId) continue;
        reviewers.push({
          name: String(form.get(`rv${n}name`) || ''),
          channelId,
          modelLabel: String(form.get(`rv${n}label`) || ''),
          persona: String(form.get(`rv${n}persona`) || ''),
          specialty: String(form.get(`rv${n}specialty`) || ''),
          style: String(form.get(`rv${n}style`) || ''),
        });
      }
      review.savePanel({
        id: String(form.get('id') || ''),
        name: String(form.get('name') || ''), workbench,
        docType: String(form.get('docType') || ''),
        maxRounds: Number(form.get('maxRounds') || 0),
        tokenBudget: Number(form.get('tokenBudget') || 0),
        reviewers,
      });
      redirect(res, back);
      return true;
    }
    if (action === 'panel/delete') {
      review.deletePanel(String(form.get('panelId') || ''));
      redirect(res, back);
      return true;
    }
    if (action === 'skill/save') {
      review.saveSkill({
        name: String(form.get('name') || ''),
        kind: String(form.get('kind') || 'focus'),
        reviewerId: String(form.get('reviewerId') || ''),
        appliesTo: String(form.get('appliesTo') || ''),
        body: String(form.get('body') || ''),
        weights: String(form.get('weights') || ''),
      });
      redirect(res, back);
      return true;
    }
    if (action === 'skill/bind') {
      // 多选：URLSearchParams 的 getAll 才是全部勾选值
      review.setSkillReviewers(String(form.get('skillId') || ''), form.getAll('reviewerId'));
      redirect(res, back);
      return true;
    }
    if (action === 'skill/toggle') {
      review.setSkillEnabled(String(form.get('skillId') || ''), String(form.get('on') || '') === '1');
      redirect(res, back);
      return true;
    }
    if (action === 'skill/delete') {
      review.deleteSkill(String(form.get('skillId') || ''));
      redirect(res, back);
      return true;
    }
    if (action === 'distill') {
      await review.distillSkill({
        sample: String(form.get('sample') || ''),
        workType: String(form.get('workType') || 'doc:paper'),
        kind: String(form.get('kind') || 'focus'),
        reviewerId: String(form.get('reviewerId') || ''),
      });
      redirect(res, back);
      return true;
    }
    if (action === 'distill-from-work') {
      const skill = await review.distillFromWork({
        workbench,
        workId: String(form.get('workId') || ''),
        sectionIdx: Number(form.get('sectionIdx') || 0),
        kind: String(form.get('kind') || 'focus'),
        reviewerId: String(form.get('reviewerId') || ''),
      });
      redirect(res, back);
      return true;
    }
    if (action === 'run') {
      const workId = String(form.get('workId') || '');
      const sectionIdx = Number(form.get('sectionIdx') || 0);
      const target = String(form.get('target') || '');
      const apply = String(form.get('apply') || '') === '1';
      // 先做一次起跑校验：评审团没配、正文为空、轮次已满这些错误要当场告诉用户，
      // 而不是跳转过去、后台静默失败，让他对着一个没有新轮次的页面发呆。
      const panelId = String(form.get('panelId') || '');
      try {
        review.preflight({ workbench, workId, sectionIdx, panelId, target });
      } catch (error) {
        const message = String(error && error.message || error);
        const backTo = workId
          ? `/review?workbench=${encodeURIComponent(workbench)}&workId=${encodeURIComponent(workId)}&sectionIdx=${sectionIdx}${target ? `&target=${encodeURIComponent(target)}` : ''}`
          : back;
        sendHtml(res, layout('无法开始评审', `<div class="card">
          <div class="warn">${escapeHtml(message)}</div>
          <div style="margin-top:10px"><a class="btn" href="${backTo}">返回</a>
          <a class="btn btn--sm" href="/review?workbench=${encodeURIComponent(workbench)}" style="margin-left:8px">去配置评审团</a></div>
        </div>`, token, { workbench, workId, sectionIdx, target }));
        return true;
      }
      const key = `${workbench}:${workId}:${sectionIdx}:${review.normalizeTarget(workbench, target)}`;
      if (inflight.has(key)) { bad(res, 409, '这一轮还在评审中'); return true; }
      inflight.add(key);
      // 后台跑：三位评审员各一次调用，同步等待会让页面转圈几十秒。
      // 状态在 review_rounds.status 里，页面按 4 秒刷新。
      const placeholder = require('./review-engine');
      setImmediate(async () => {
        try {
          await placeholder.runRound({ workbench, workId, sectionIdx, apply, panelId, target });
        } catch (error) {
          // 失败已写进 review_rounds.error，这里只需保证不把进程带崩
          try { console.error('[review] 轮次失败：', error && error.message); } catch { /* ignore */ }
        } finally {
          inflight.delete(key);
        }
      });
      // 给页面一个可跳转的轮次页：等它写完 running 记录。
      // 轮询比固定等待可靠——固定 120ms 在慢机器上会跳回列表页，用户以为没跑起来。
      let rounds = [];
      for (let i = 0; i < 40; i += 1) {
        rounds = review.listRounds({ workbench, workId, sectionIdx, target, limit: 1 });
        if (rounds.length && rounds[0].status === 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const goTo = rounds[0] ? `/review?round=${encodeURIComponent(rounds[0].id)}` : back;
      redirect(res, goTo);
      return true;
    }
    bad(res, 404, 'unknown review action');
    return true;
  } catch (error) {
    bad(res, 400, String(error && error.message || error));
    return true;
  }
}

module.exports = { handleReview, renderRound, renderPanels, renderSkills, renderSwitch };
