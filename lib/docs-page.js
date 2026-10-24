'use strict';

// 文档工作台页面：/docs。与小说主界面同款形态——
// 左栏项目列表 · 中间文档区 + 底部输入条（含 AI 共创 / AI 全托管 胶囊切换）· 右侧目录树。
// AI 共创模式 = 对话式协作：AI 追问 → 作者回答 → 成稿（与小说的新书共创同语义）。
// 服务端直渲染（web/ 无源码），状态走 URL（?id= 项目 &s= 小节 &edit=1 &new=1 &type=），
// 动作走表单 POST + 303 跳回原上下文。
const docEngine = require('./doc-engine');
const mis = require('./handlers-misc');
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

  /* ---------- 左栏：项目列表 ---------- */
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
  .work__acts { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
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

  .docbody { flex: 1; overflow-y: auto; padding: 22px 8%; 40px; }
  .docbody__inner { max-width: 780px; margin: 0 auto; }
  .sec__brief { color: var(--sub); font-size: 12.5px; background: #f6f7f9; border-radius: 8px;
    padding: 8px 12px; margin: 0 0 14px; }
  .sec__text { white-space: pre-wrap; word-break: break-word; font-size: 14.5px; line-height: 1.95; }
  .sec__text.is-empty { color: #9aa1a9; }
  .sec__text textarea { width: 100%; min-height: 320px; border: 1px solid var(--line); border-radius: 10px;
    padding: 14px; font: 13.5px/1.9 Consolas, monospace; }
  .sec__nav { display: flex; justify-content: space-between; margin-top: 26px; }

  /* ---------- AI 共创：对话线程 ---------- */
  .chatthread { display: flex; flex-direction: column; gap: 10px; margin: 0 0 10px; }
  .chatmsg { display: flex; }
  .chatmsg--me { justify-content: flex-end; }
  .chatmsg--ai { justify-content: flex-start; }
  .chatmsg__bubble { max-width: 82%; padding: 9px 13px; border-radius: 14px; font-size: 14px;
    white-space: pre-wrap; word-break: break-word; }
  .chatmsg--ai .chatmsg__bubble { background: #eef2f7; border-top-left-radius: 4px; }
  .chatmsg--me .chatmsg__bubble { background: var(--brand-weak); border-top-right-radius: 4px; }

  /* ---------- 底部输入条（仿主界面对话框） ---------- */
  .composer { flex: none; margin: 0 auto 14px; width: min(720px, calc(100% - 36px)); background: var(--panel);
    border: 1px solid var(--line); border-radius: 16px; padding: 12px 14px 8px; box-shadow: 0 2px 10px rgba(16,24,40,.05); }
  .composer textarea { width: 100%; border: 0; outline: none; resize: none; font: inherit;
    min-height: 44px; max-height: 160px; background: none; }
  .composer textarea::placeholder { color: #9aa1a9; }
  .composer input[type=text] { width: 100%; border: 0; outline: none; font: inherit; font-weight: 600;
    background: none; }
  .composer input[type=text]::placeholder { font-weight: 400; color: #9aa1a9; }
  .composer__acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
  .composer__hint { color: #9aa1a9; font-size: 11.5px; }
  .composer__send { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .sendbtn { width: 34px; height: 34px; border-radius: 50%; background: var(--brand); color: #fff;
    border: 0; font-size: 15px; line-height: 1; flex: none; }
  .sendbtn:hover { filter: brightness(.93); }

  /* 模式胶囊（仿主界面「全 AI 托管」分段切换） */
  .pillgroup { display: inline-flex; background: #eef2f7; border-radius: 999px; padding: 3px; gap: 2px; }
  .pill { border: 0; background: none; border-radius: 999px; padding: 4px 12px; font-size: 12px;
    color: #5b6470; white-space: nowrap; }
  .pill.is-on { background: var(--brand); color: #fff; font-weight: 600; }
  .pillgroup--static .pill { cursor: default; }
  form.inline { display: inline; }

  /* 下拉菜单（技能勾选 / 模板 / 更多操作） */
  .menu { position: relative; }
  .menu__btn { border: 1px solid var(--line); background: var(--panel); border-radius: 999px;
    padding: 4px 9px; font-size: 12px; color: var(--sub); list-style: none; }
  .menu__btn::-webkit-details-marker { display: none; }
  .menu[open] .menu__btn { background: #f1f4f8; }
  .menu--left .menu__panel { left: 0; right: auto; }
  .menu__panel { position: absolute; bottom: calc(100% + 8px); right: 0; background: var(--panel);
    border: 1px solid var(--line); border-radius: 12px; min-width: 200px; padding: 6px;
    box-shadow: 0 8px 24px rgba(16,24,40,.14); z-index: 30; }
  .menu__panel--wide { min-width: 360px; }
  .menu__panel--scroll { max-height: 320px; overflow-y: auto; }
  .menu__panel textarea { min-height: 90px; margin-bottom: 8px; }
  .menu__panel button, .menu__panel a { display: block; width: 100%; text-align: left; border: 0;
    background: none; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; color: var(--ink); }
  .menu__panel button:hover, .menu__panel a:hover { background: #f1f3f6; }
  .menu__panel .danger { color: #c03535; }
  .menu__panel hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; }
  .menu__group { padding: 6px 8px 2px; font-size: 10.5px; color: var(--sub); letter-spacing: .06em; }
  .menu__item { display: flex; align-items: center; gap: 7px; padding: 6px 8px; border-radius: 7px;
    font-size: 12.5px; cursor: pointer; }
  .menu__item:hover { background: #f1f3f6; }
  .menu__item input { accent-color: var(--brand); }
  .menu__item.is-disabled span { color: #9aa1a9; }
  .pill-select { border: 1px solid var(--line); border-radius: 999px; padding: 4px 8px;
    font-size: 12px; background: var(--panel); color: var(--ink); max-width: 150px; }

  /* ---------- 「新建文档」弹窗（仿官方开启新书） ---------- */
  .cmodal { position: fixed; inset: 0; z-index: 2147482000; display: flex; align-items: center;
    justify-content: center; }
  .cmodal__backdrop { position: absolute; inset: 0; background: rgba(16,24,40,.45); }
  .cmodal__card { position: relative; width: min(560px, calc(100% - 32px)); max-height: calc(100vh - 60px);
    overflow-y: auto; background: var(--panel); border-radius: 16px;
    box-shadow: 0 18px 50px rgba(16,24,40,.28); }
  .cmodal__head { display: flex; align-items: center; gap: 10px; padding: 16px 18px 10px; }
  .cmodal__icon { width: 30px; height: 30px; border-radius: 9px; background: var(--brand-weak);
    display: inline-flex; align-items: center; justify-content: center; }
  .cmodal__head b { font-size: 15px; flex: 1; }
  .cmodal__x { border: 0; background: none; font-size: 18px; color: var(--sub); padding: 2px 6px; }
  .cmodal__tabs { display: flex; margin: 4px 18px 0; background: #eef2f7; border-radius: 10px; padding: 3px; gap: 3px; }
  .cmodal__tab { flex: 1; border: 0; background: none; border-radius: 8px; padding: 7px 0;
    font-size: 12.5px; color: #5b6470; }
  .cmodal__tab.is-on { background: var(--panel); color: var(--ink); font-weight: 700;
    box-shadow: 0 1px 3px rgba(16,24,40,.12); }
  .cmodal__body { padding: 6px 18px 0; }
  .cmodal__label { font-weight: 700; font-size: 13px; margin: 12px 0 5px; }
  .cmodal__label .cmodal__opt, .cmodal__opt { font-weight: 400; color: var(--sub); font-size: 11.5px; }
  .cmodal__body textarea, .cmodal__body input[type=text], .cmodal__body select {
    width: 100%; font: inherit; padding: 9px 11px; border: 1px solid var(--line);
    border-radius: 10px; background: #fff; }
  .cmodal__body textarea { min-height: 88px; resize: vertical; }
  .cmodal__body textarea.code { font-family: Consolas, monospace; font-size: 12px; }
  .cmodal__hint { color: var(--sub); font-size: 11.5px; margin: 5px 0 8px; }
  .cmodal__uprow { font-size: 12px; color: var(--sub); margin: 8px 0 4px;
    display: flex; align-items: center; gap: 8px; }
  .cmodal__uprow input[type=file] { font-size: 11.5px; }
  .cmodal__fold summary { cursor: pointer; font-size: 12.5px; padding: 9px 12px;
    border: 1px solid var(--line); border-radius: 10px; list-style: none; color: var(--ink);
    display: flex; justify-content: space-between; align-items: center; }
  .cmodal__fold summary::-webkit-details-marker { display: none; }
  .cmodal__fold[open] summary { margin-bottom: 4px; }
  .cmodal__fold label { font-weight: 400; font-size: 11.5px; color: var(--sub); margin: 6px 0 3px; }
  .cmodal__check { display: flex; align-items: center; gap: 8px; font-size: 12.5px;
    border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; margin: 12px 0 4px;
    cursor: pointer; }
  .cmodal__check input { accent-color: var(--brand); }
  .cmodal__foot { display: flex; align-items: center; justify-content: space-between;
    padding: 12px 18px 16px; }
  .cmodal__foot .btn { padding: 7px 18px; }

  /* ---------- 右栏：目录树 ---------- */
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

  /* ---------- 空态 hero ---------- */
  .hero { text-align: center; margin-top: 14vh; margin-bottom: 22px; }
  .hero__icon { width: 74px; height: 74px; border-radius: 20px; margin: 0 auto 14px;
    background: linear-gradient(135deg, #2f6bdb, #173f9e); color: #fff; font-size: 34px;
    display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 24px rgba(29,78,216,.32); }
  .hero__title { font-size: 19px; font-weight: 700; }
  .hero__sub { color: var(--sub); font-size: 12.5px; margin-top: 4px; }
  .herozone { flex: 1 1 auto; display: flex; flex-direction: column; justify-content: center; align-items: center; overflow-y: auto; }

  /* ---------- 模板蒸馏与拆解 ---------- */
  .distillcard { background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    padding: 14px 16px; margin-top: 14px; }
  .distillcard summary { cursor: pointer; font-weight: 700; font-size: 13px; list-style: none; }
  .distillcard summary::-webkit-details-marker { display: none; }
  .distillcard .lead { color: var(--sub); font-size: 12px; margin: 4px 0 8px; }
  .distillcard label { display: block; font-weight: 600; font-size: 12px; margin: 8px 0 3px; }
  .distillcard input[type=text], .distillcard select, .distillcard textarea {
    width: 100%; font: inherit; padding: 7px 9px; border: 1px solid var(--line);
    border-radius: 8px; background: #fff; }
  .distillcard textarea { min-height: 90px; resize: vertical; }
  .distillcard textarea.code { font-family: Consolas, monospace; font-size: 12px; }
  .distillcard input[type=file] { font-size: 11.5px; }
  .tplrow { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; font-size: 12.5px; }
  .tplrow:hover { background: #f1f3f6; }
  .tplrow__name { flex: 1; font-weight: 600; }
  .tplrow__meta { color: var(--sub); font-size: 11.5px; }
  .distillresult { background: #f6f7f9; border-radius: 8px; padding: 10px 12px; font-size: 12.5px;
    white-space: pre-wrap; margin: 8px 0; }
  .outlinecard { background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    padding: 10px 14px; margin-bottom: 14px; }
  .outlinecard summary { cursor: pointer; font-weight: 700; font-size: 13px; list-style: none; }
  .outlinecard summary::-webkit-details-marker { display: none; }
  .outlinecard[open] summary { margin-bottom: 4px; }
  .outlinecard label { display: block; font-weight: 600; font-size: 12px; margin: 8px 0 3px; }
  .outlinecard textarea { width: 100%; font: inherit; padding: 7px 9px; border: 1px solid var(--line);
    border-radius: 8px; background: #fff; resize: vertical; }
  .outlinecard textarea.code { font-family: Consolas, monospace; font-size: 12px; }
  .outlinecard .actions { margin-top: 8px; }

  @media (max-width: 1000px) {
    .tree { display: none; }
    .docbody { padding: 22px 5%; 40px; }
  }
`;

const SECTION_STATUS = { planned: ['未撰写', 'mute'], done: ['已完成', 'ok'], quarantined: ['失败', 'bad'] };

function statusDot(status) {
  return status === 'done' ? 'ok' : status === 'quarantined' ? 'bad' : status === 'paused_budget' ? 'warn' : 'mute';
}

function projectStatusMeta(project) {
  if (project.status === 'done') return ['已完成', 'ok'];
  if (project.status === 'running') return ['生成中', 'warn'];
  if (project.status === 'paused_budget') return ['预算暂停', 'warn'];
  if (project.status === 'quarantined') return ['有小节失败', 'bad'];
  if (project.status === 'failed') return ['中断', 'bad'];
  return ['撰写中', 'mute'];
}

function typeOptions(selected) {
  return Object.values(docEngine.DOC_TYPES).map((type) =>
    `<option value="${type.key}"${type.key === selected ? ' selected' : ''}>${escapeHtml(type.name)}</option>`).join('');
}

// ---------- 左栏 ----------

function renderRail(activeId) {
  const projects = docEngine.listProjects();
  const cards = projects.map((project) => {
    const meta = projectStatusMeta(project);
    return `<a class="pcard${project.id === activeId ? ' is-active' : ''}" href="/docs?id=${project.id}">
      <span class="pcard__top"><span class="pcard__name">${escapeHtml(project.title)}</span>
      <span class="dot ${statusDot(meta[1])}" title="${escapeHtml(meta[0])}"></span></span>
      <span class="pcard__sub">${escapeHtml(docEngine.docTypeOf(project.docType).name)} · ${project.done}/${project.total} 节 · ${project.mode === 'auto' ? '全托管' : '共创'}</span>
    </a>`;
  }).join('');
  return `<aside class="rail">
    <div class="rail__brand">文档工作台<span class="sub">论文 · 商业文书 · 报告 · 合同</span></div>
    <a class="rail__new" href="/docs?new=1${activeId ? `&id=${activeId}` : ''}">＋ 新建文档</a>
    <div class="rail__sect">全部文档（${projects.length}）</div>
    <div class="rail__list">${cards || '<div class="pcard__sub" style="padding:8px 10px">还没有文档——点上方「新建文档」</div>'}</div>
    <div class="rail__foot">
      <a href="/">小说工作台</a>
      <a href="/skills">技能广场</a>
      <a href="/status">任务状态</a>
    </div>
  </aside>`;
}

// ---------- 右栏：目录树（项目 = 各部分小节；空态 = 类型模板） ----------

function renderTree(project, currentIdx) {
  const rows = project.sections.map((section) => {
    const [text] = SECTION_STATUS[section.status] || ['未撰写'];
    return `<a class="trow${section.idx === currentIdx ? ' is-active' : ''}" href="/docs?id=${project.id}&s=${section.idx}" title="${escapeHtml(section.title)}（${text}）">
      <span class="trow__no">${section.idx}</span>
      <span class="trow__name">${escapeHtml(section.title)}</span>
      <span class="dot ${statusDot(section.status)}"></span>
    </a>`;
  }).join('');
  return `<aside class="tree">
    <div class="tree__sect">目录（${project.sections.filter((s) => s.status === 'done').length}/${project.sections.length}）</div>
    <div class="tree__list">${rows}</div>
    ${project.brief ? `<div class="tree__info"><b>项目说明</b><br>${escapeHtml(project.brief.slice(0, 400))}</div>` : ''}
  </aside>`;
}

// 空状态右栏：写作要点面板（论题 / 论据要点 / 计划章节）——与中央创建表单联动提交。
function renderOutlinePanel() {
  return `<aside class="tree">
    <div class="tree__sect">写作要点（创建时一并保存）</div>
    <div style="padding:0 10px 8px;display:flex;flex-direction:column;gap:6px">
      <div>
        <div style="font-size:11px;color:var(--sub);margin-bottom:2px">论题 / 主线主张</div>
        <textarea id="__wx_thesis_rail" rows="3" style="width:100%;font:inherit;font-size:12px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;resize:vertical" placeholder="如：数字化改造不是成本，是制造业的生存问题"></textarea>
      </div>
      <div>
        <div style="font-size:11px;color:var(--sub);margin-bottom:2px">论据 / 要点（一行一条）</div>
        <textarea id="__wx_points_rail" rows="5" style="width:100%;font:inherit;font-size:12px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;resize:vertical" placeholder="已有 3 个标杆案例&#10;改造投入两年回本&#10;政策补贴覆盖 30%"></textarea>
      </div>
      <div>
        <div style="font-size:11px;color:var(--sub);margin-bottom:2px">计划的章节（一行一节，留空用类型结构）</div>
        <textarea id="__wx_secs_rail" rows="4" style="width:100%;font:inherit;font-size:12px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;resize:vertical" placeholder="现状与痛点&#10;解决方案&#10;案例与数据"></textarea>
      </div>
      <div style="font-size:11px;color:var(--sub)">类型在中央面板选择；这些要点会成为 AI 写作的论题与论据指引，创建后仍可修改。</div>
    </div>
  </aside>`;
}

// ---------- 技能勾选菜单（文档域：广场全部文档技能） ----------

function skillsPicker(allSkills, checkedIds) {
  // 技能域隔离：文档工作台只用 doc 域技能（小说技能在小说对话里用）。
  const docSkills = allSkills.filter((skill) => skill.domain === 'doc');
  if (!docSkills.length) {
    return `<span class="composer__hint">文档技能广场还没有技能——<a href="/skills?domain=doc&new=1">去新建一个</a></span>`;
  }
  const checked = new Set(checkedIds);
  const groups = [
    { label: '文档方法', list: docSkills.filter((skill) => skill.kind !== 'style') },
    { label: '文档文风', list: docSkills.filter((skill) => skill.kind === 'style') },
  ].filter((group) => group.list.length);
  const groupsHtml = groups.map((group) =>
    `<div class="menu__group">${escapeHtml(group.label)}</div>
     ${group.list.map((skill) =>
      `<label class="menu__item${skill.enabled ? '' : ' is-disabled'}" title="${skill.enabled ? '' : '该技能已停用，勾选仍可对本项目生效'}">
        <input type="checkbox" class="skillcheck" name="skillId" value="${escapeHtml(skill.id)}"${checked.has(skill.id) ? ' checked' : ''}>
        <span>${escapeHtml(skill.name)}${skill.enabled ? '' : ' <span class="badge mute">已停用</span>'}</span>
      </label>`).join('')}`).join('');
  return `<details class="menu menu--left">
    <summary class="menu__btn" title="选择叠加技能（文档技能广场全部可选，注入生成提示词）">✦ 技能</summary>
    <div class="menu__panel menu__panel--scroll">
      ${groupsHtml}
      <hr>
      <a href="/skills?domain=doc">管理文档技能 →</a>
    </div>
  </details>`;
}

// ---------- 空态：hero + 可直接创建的输入条（仿小说主界面：技能/模板/方式都在工具条上） ----------

function renderHeroComposer(csrf, selectedType, allSkills = []) {
  // 仿小说主页面排布：顶部标题条 + 中部居中 hero + 底部输入条（由 renderDocsPage 的 flex 结构钉住）
  const head = `<div class="work__head">
    <span class="work__title">新文档</span>
    <span class="work__meta">${escapeHtml(docEngine.docTypeOf(selectedType).name)} · 输入主题直接创建，创建后逐节协作或整篇生成</span>
  </div>`;
  const hero = `<div class="herozone"><div class="hero">
    <div class="hero__icon">✎</div>
    <div class="hero__title">开始撰写文档</div>
    <div class="hero__sub">商业计划书 · 申报书 · 报告 · 论文 · 合同 · 自定义模板——AI 共创 / AI 全托管任选</div>
  </div></div>`;
  const picker = skillsPicker(allSkills, []);
  const composer = `<div class="composer composer--new">
    <form method="post" action="/docs/create" onsubmit="return cxPrepare()">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="mode" id="cxMode" value="co">
      <input type="hidden" name="title" id="cxTitle">
      <input type="hidden" name="template" id="cxTemplate">
      <textarea name="brief" id="cxBrief" placeholder="想写什么？主题、背景与关键事实……（第一行将作为标题）"></textarea>
      <div class="composer__acts">
        <select name="docType" class="pill-select" id="cxType">${typeOptions(selectedType)}</select>
        ${picker}
        <details class="menu">
          <summary class="menu__btn" title="上传或粘贴模板（按标题切分小节）">📎 模板</summary>
          <div class="menu__panel menu__panel--wide menu__panel--up">
            <input type="file" id="tplFile" accept=".md,.txt,.markdown">
            <textarea name="template" id="tplArea" class="code" placeholder="# 一、执行摘要&#10;（本节要求…）&#10;&#10;留空则用类型默认结构"></textarea>
            <button type="button" class="btn btn--sm" onclick="fillDefault()">填入类型默认模板</button>
          </div>
        </details>
        <details class="menu">
          <summary class="menu__btn" title="样例文档 → 结构模板 + 文档技法">🧪 蒸馏</summary>
          <div class="menu__panel menu__panel--wide menu__panel--up">
            <label>模板名（留空让 AI 起）</label>
            <input type="text" id="cxDisName" placeholder="如：优秀 BP 结构 v1">
            <label>归属类型</label>
            <select id="cxDisType">${typeOptions(selectedType)}</select>
            <label>样例文档（粘贴全文，至少 200 字）</label>
            <textarea id="cxDisSample" placeholder="粘贴一篇写得好的样例文档全文……"></textarea>
            <button type="button" class="btn btn--primary btn--sm" onclick="cxDisill()" style="margin-top:8px">开始蒸馏与拆解</button>
          </div>
        </details>
        <span class="pillgroup" id="cxPill">
          <button type="button" class="pill is-on" onclick="cxModeSet('co')">AI 共创</button>
          <button type="button" class="pill" onclick="cxModeSet('auto')">AI 全托管</button>
        </span>
        <span class="composer__send"><button class="sendbtn" type="submit" title="创建并进入工作台">↑</button></span>
      </div>
    </form>
  </div>`;
  return `${head}${hero}${composer}`;
}

// ---------- 「新建文档」弹窗（仿官方开启新书） ----------

function renderCreateModal(csrf, allSkills, selectedType, open, templates = [], prefill = { thesis: '', points: [] }) {
  const defaults = JSON.stringify(Object.fromEntries(Object.values(docEngine.DOC_TYPES)
    .map((t) => [t.key, t.sections])));
  const picker = skillsPicker(allSkills, []);
  const tplMd = JSON.stringify(Object.fromEntries(templates.map((t) => [t.id, templateMarkdown(t)])));
  const tplOptions = templates.map((t) =>
    `<option value="${escapeHtml(t.id)}">📚 ${escapeHtml(t.name)}（${t.sections.length} 节）</option>`).join('');
  return `<div id="createModal" class="cmodal" style="display:${open ? 'flex' : 'none'}">
    <div class="cmodal__backdrop" onclick="closeCreate()"></div>
    <div class="cmodal__card">
      <div class="cmodal__head">
        <span class="cmodal__icon">📝</span>
        <b>新建文档</b>
        <button type="button" class="cmodal__x" onclick="closeCreate()" title="关闭">×</button>
      </div>
      <div class="cmodal__tabs">
        <button type="button" class="cmodal__tab is-on" id="cmTabCo" onclick="cmTab('co')">✦ AI 共创</button>
        <button type="button" class="cmodal__tab" id="cmTabAuto" onclick="cmTab('auto')">⚙ AI 全托管</button>
      </div>
      <form method="post" action="/docs/create" id="cmForm" onsubmit="return mergeDirection() && syncOutlineToForm()">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="mode" id="cmMode" value="co">
        <input type="hidden" name="thesis" id="cmThesis" value="${escapeHtml(prefill.thesis || '')}">
        <input type="hidden" name="pointsJson" id="cmPoints" value="${escapeHtml(JSON.stringify(prefill.points || []))}">
        <input type="hidden" name="sectionsJson" id="cmSecs" value="[]">
        <div class="cmodal__body">
          <div class="cmodal__label">这篇文档写什么？</div>
          <textarea name="brief" id="cmBrief" placeholder="主题、背景、核心主张、已有数据。例如：一家面向中小制造企业的数字化改造服务商，已落地 3 个标杆案例……"></textarea>
          <div class="cmodal__hint">写一两句就行——AI 会按文档类型拆分小节，并沿结构补全细节；缺数据处会标【待补】。</div>
          <div class="cmodal__uprow">📎 上传模板文件（.md / .txt）
            <input type="file" id="tplFile" accept=".md,.txt,.markdown">
          </div>
          ${templates.length ? `<label>📚 已蒸馏模板（选用后可再编辑）</label>
          <select id="tplSaved" onchange="applyTpl(this.value)"><option value="">——选择——</option>${tplOptions}</select>` : ''}
          <textarea name="template" id="tplArea" class="code" style="min-height:64px" placeholder="（可选）粘贴文档模板，按标题切分小节；留空则用类型默认结构"></textarea>
          <div class="cmodal__label">文档标题 <span class="cmodal__opt">选填</span></div>
          <input type="text" name="title" placeholder="留空让 AI 起几个候选">
          <details class="cmodal__fold">
            <summary>先定个方向 <span class="cmodal__opt">受众 / 语气 / 篇幅 · 都可跳过</span></summary>
            <div class="row" style="margin-top:8px">
              <div><label>目标读者 / 评审方</label><input type="text" name="dirAudience" placeholder="如：评审专家 / 投资人"></div>
              <div><label>语气</label><input type="text" name="dirTone" placeholder="如：克制、数据驱动"></div>
              <div><label>篇幅</label><input type="text" name="dirLen" placeholder="如：10 页 / 每节 800 字"></div>
            </div>
          </details>
          <div class="cmodal__label">文档类型与叠加技能</div>
          <div class="row">
            <div><select name="docType" id="docType">${typeOptions(selectedType)}</select></div>
            <div>${picker}</div>
          </div>
          <label class="cmodal__check" id="cmAutoRow" style="display:none">
            <input type="checkbox" name="autoStart" value="1"> 创建完成后自动开始整篇生成
          </label>
        </div>
        <div class="cmodal__foot">
          <span class="cmodal__hint">这里的所有设置只作用于这一份文档</span>
          <button class="btn btn--primary" type="submit">创建并进入</button>
        </div>
      </form>
    </div>
  </div>`;
}

// ---------- AI 共创：对话线程渲染 ----------

function renderSectionThread(section) {
  const history = Array.isArray(section.chat) ? section.chat : [];
  const opening = history.length ? '' : `<div class="chatmsg chatmsg--ai"><div class="chatmsg__bubble">本节任务：${escapeHtml(section.title)}。把你知道的信息告诉我（要点、数据、例子）；我会先追问细节，然后产出本节正文。也可以直接说「开始写」。</div></div>`;
  const items = history.map((m) =>
    `<div class="chatmsg chatmsg--${m.role === 'assistant' ? 'ai' : 'me'}"><div class="chatmsg__bubble">${escapeHtml(m.text)}</div></div>`).join('');
  return `<div class="chatthread">${opening}${items}</div>`;
}

// ---------- 模板蒸馏与拆解卡片 ----------

function renderDistillCard(csrf, templates) {
  const rows = templates.map((tpl) =>
    `<div class="tplrow">
      <span class="tplrow__name">${escapeHtml(tpl.name)}</span>
      <span class="tplrow__meta">${escapeHtml(docEngine.docTypeOf(tpl.docType).name)} · ${tpl.sections.length} 节</span>
      <a class="btn btn--sm" href="/docs?new=1&tpl=${tpl.id}">用于新建 ↓</a>
      <form method="post" action="/docs/template/delete" class="inline" onsubmit="return confirm('删除该模板？')">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="templateId" value="${tpl.id}">
        <button class="btn btn--sm btn--danger" type="submit">删除</button>
      </form>
    </div>`).join('');
  return `<details class="distillcard">
    <summary>🧪 模板蒸馏与拆解 <span class="composer__hint">——把一篇写得好的样例文档，蒸馏成可复用的结构模板与技法</span></summary>
    <p class="lead">粘贴或上传样例（一篇优秀的 BP / 论文 / 申报书…），AI 拆解出小节结构、写法要点与文风技法：保存为模板（新建文档时选用）+ 文档技能（可勾选叠加）。</p>
    <form method="post" action="/docs/distill">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <div class="row">
        <div><label>模板名（留空让 AI 起）</label><input type="text" name="name" placeholder="如：优秀 BP 结构 v1"></div>
        <div><label>归属类型</label><select name="docType">${typeOptions('custom')}</select></div>
      </div>
      <label>样例文档（粘贴全文，或上传 .md/.txt）</label>
      <input type="file" id="distillFile" accept=".md,.txt,.markdown">
      <textarea name="sample" required placeholder="粘贴样例文档全文……"></textarea>
      <div class="actions"><button class="btn btn--primary btn--sm" type="submit">开始蒸馏与拆解</button></div>
    </form>
    ${templates.length ? `<div style="margin-top:12px"><div class="cmodal__label" style="margin:0 0 4px">已蒸馏模板（${templates.length}）</div>${rows}</div>` : ''}
  </details>`;
}

// ---------- 工作区 ----------

function renderWorkArea(project, currentIdx, { csrf, edit = false, allSkills = [] }) {
  const run = one(`SELECT * FROM generation_runs WHERE book_id=? AND mode='doc' ORDER BY updated_at DESC LIMIT 1`, project.id);
  const runLive = run && ['running', 'queued', 'retrying'].includes(run.status);
  const runResumable = run && statusPage.RESUMABLE.has(run.status);
  const usage = run ? one(`SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c FROM generation_attempts WHERE run_id=?`, run.id) : null;
  const tokens = usage ? Number(usage.p || 0) + Number(usage.c || 0) : 0;
  const done = project.sections.filter((s) => s.status === 'done').length;
  const isCo = project.mode === 'co';

  const section = project.sections[currentIdx - 1];
  const prev = project.sections[currentIdx - 2];
  const next = project.sections[currentIdx];

  const head = `<div class="work__head">
    <span class="work__title">${escapeHtml(project.title)}</span>
    <span class="work__meta">${escapeHtml(project.typeName)} · ${done}/${project.sections.length} 节${tokens ? ' · ' + tokens.toLocaleString('zh-CN') + ' tokens' : ''}${run ? ' · 任务 ' + escapeHtml(run.status) : ''}</span>
    <span class="work__acts">
      <form method="post" action="/docs/generate" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="projectId" value="${project.id}">
        <button class="btn btn--primary btn--sm" type="submit">${runLive ? '生成中…' : '⚙ 整篇生成'}</button></form>
      ${runResumable ? `<form method="post" action="/docs/resume" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="runId" value="${run.id}">
        <button class="btn btn--sm" type="submit">↻ 从断点续跑</button></form>` : ''}
      <a class="btn btn--sm" href="/docs/project/${project.id}/export">⬇ 导出全文 Markdown</a>
      <form method="post" action="/docs/distill-project" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="projectId" value="${project.id}">
        <button class="btn btn--sm" type="submit" title="把本文结构蒸馏为可复用模板 + 文档技法技能">🧪 蒸馏本文</button></form>
      <form method="post" action="/docs/delete" class="inline" onsubmit="return confirm('删除该项目及其全部小节？')"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="projectId" value="${project.id}">
        <button class="btn btn--sm btn--danger" type="submit">删除</button></form>
    </span>
  </div>`;

  let body;
  if (!section) {
    body = `<div class="docbody"><div class="docbody__inner"><div class="formcard"><h2>选择左侧文档开始</h2></div></div></div>`;
  } else {
    const [statusText] = SECTION_STATUS[section.status] || ['未撰写'];
    let contentHtml;
    if (edit) {
      contentHtml = `<form method="post" action="/docs/section/save">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <input type="hidden" name="projectId" value="${project.id}">
          <input type="hidden" name="idx" value="${section.idx}">
          <div class="sec__text"><textarea name="content">${escapeHtml(section.content)}</textarea></div>
          <div class="actions"><button class="btn btn--primary btn--sm" type="submit">保存本节</button>
          <a class="btn btn--sm" href="/docs?id=${project.id}&s=${section.idx}">取消</a></div>
        </form>`;
    } else if (isCo) {
      contentHtml = renderSectionThread(section);
    } else {
      contentHtml = `<div class="sec__text${section.content ? '' : ' is-empty'}">${escapeHtml(section.content || `（${statusText}——全托管生成，或点「编辑本节」手写）`)}</div>
        <div class="actions"><a class="btn btn--sm" href="/docs?id=${project.id}&s=${section.idx}&edit=1">编辑本节</a></div>`;
    }
    // 写作要点卡（论题 + 论据要点）：随时改，AI 共创/起草/批量全部即时生效
    const outlineCard = `<details class="outlinecard">
      <summary>🎯 写作要点 <span class="work__meta">论题与论据——改完即生效到所有生成</span></summary>
      <form method="post" action="/docs/outline" style="margin-top:8px">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="projectId" value="${project.id}">
        <label style="margin-top:4px">论题 / 主线主张</label>
        <textarea name="thesis" style="min-height:56px">${escapeHtml(project.thesis || '')}</textarea>
        <label>论据 / 要点（一行一条）</label>
        <textarea name="points" class="code" style="min-height:80px">${escapeHtml((project.points || []).join('\n'))}</textarea>
        <div class="actions"><button class="btn btn--primary btn--sm" type="submit">保存要点</button></div>
      </form>
    </details>`;
    body = `<div class="docbody"><div class="docbody__inner">
      ${outlineCard}
      ${section.brief ? `<div class="sec__brief">第 ${section.idx} 节 · ${escapeHtml(section.brief)}</div>` : ''}
      <h2 style="margin:0 0 14px;font-size:17px">第 ${section.idx} 节　${escapeHtml(section.title)}
        <span class="work__meta">（${statusText}${section.source === 'ai-batch' ? ' · 托管生成' : section.source === 'ai-chat' ? ' · 对话共创' : section.source === 'ai-revise' ? ' · AI 修改' : section.source === 'ai-draft' ? ' · AI 起草' : ''}）</span></h2>
      ${contentHtml}
      <div class="sec__nav">
        ${prev ? `<a class="btn btn--sm" href="/docs?id=${project.id}&s=${prev.idx}">← 第${prev.idx}节 ${escapeHtml(prev.title)}</a>` : '<span></span>'}
        ${next ? `<a class="btn btn--sm" href="/docs?id=${project.id}&s=${next.idx}">第${next.idx}节 ${escapeHtml(next.title)} →</a>` : ''}
      </div>
    </div></div>`;
  }

  // 底部输入条：共创 = 对话消息（发给 sectionChat）；全托管 = 修改指示（发给 revise）。
  const composer = !section ? '' : (isCo ? `<div class="composer">
    ${skillsPicker(allSkills, project.skillIds)}
    <form method="post" action="/docs/section/chat" id="chatForm" onsubmit="syncSkills('skillSlotChat')">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="idx" value="${section.idx}">
      <input type="hidden" name="skillIdsJson" id="skillSlotChat" value="${escapeHtml(JSON.stringify(project.skillIds))}">
      <textarea name="message" required placeholder="回答上面的问题，或告诉 AI 本节要写什么……（说「开始写」直接成稿）"></textarea>
      <div class="composer__acts">
        <a class="btn btn--sm" href="/docs?id=${project.id}&s=${section.idx}&edit=1">编辑本节</a>
        <button class="btn btn--sm" type="submit" form="draftForm" onclick="syncSkills('skillSlotDraft')" title="跳过对话，AI 直接起草本节">AI 起草本节</button>
        <span class="composer__hint">共创模式：通过对话协作完成本节</span>
        <span class="composer__send"><button class="sendbtn" type="submit" title="发送">↑</button></span>
      </div>
    </form>
    <form method="post" action="/docs/section/draft" id="draftForm">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="idx" value="${section.idx}">
      <input type="hidden" name="skillIdsJson" id="skillSlotDraft" value="${escapeHtml(JSON.stringify(project.skillIds))}">
    </form>
  </div>` : `<div class="composer">
    ${skillsPicker(allSkills, project.skillIds)}
    <form method="post" action="/docs/section/revise" id="reviseForm" onsubmit="syncSkills('skillSlotRevise')">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="idx" value="${section.idx}">
      <input type="hidden" name="skillIdsJson" id="skillSlotRevise" value="${escapeHtml(JSON.stringify(project.skillIds))}">
      <textarea name="instruction" required placeholder="写下对本节的修改要求，让 AI 改写……"></textarea>
      <div class="composer__acts">
        <a class="btn btn--sm" href="/docs?id=${project.id}&s=${section.idx}&edit=1">编辑本节</a>
        <button class="btn btn--sm" type="submit" form="draftForm" onclick="syncSkills('skillSlotDraft')" title="AI 重新起草本节">AI 起草本节</button>
        <span class="composer__hint">全托管模式：逐节指示修改，或用头部按钮整篇批量</span>
        <span class="composer__send"><button class="sendbtn" type="submit" title="发送">↑</button></span>
      </div>
    </form>
    <form method="post" action="/docs/section/draft" id="draftForm">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="idx" value="${section.idx}">
      <input type="hidden" name="skillIdsJson" id="skillSlotDraft" value="${escapeHtml(JSON.stringify(project.skillIds))}">
    </form>
  </div>`);

  return `${head}${body}${composer}`;
}

// ---------- 页面装配 ----------

function renderDocsPage({ csrf, id = '', s = 0, edit = false, isNew = false, type = 'bp', notice = '', error = '' }) {
  let project = null;
  let currentIdx = Math.max(1, Number(s) || 1);
  if (id) {
    project = docEngine.getProject(id);
    if (project && currentIdx > project.sections.length) currentIdx = 1;
  }
  const banner = error ? `<p class="banner bad">${escapeHtml(error)}</p>`
    : notice ? `<p class="banner ok">${escapeHtml(notice)}</p>` : '';

  const docSkills = mis.listSkills().filter((skill) => skill.domain === 'doc');
  const docTemplates = docEngine.listDocTemplates();
  const main = (isNew || !project)
    ? renderHeroComposer(csrf, type, docSkills)
    : renderWorkArea(project, currentIdx, { csrf, edit, allSkills: docSkills });
  const distillCard = `<details class="distillcard">
    <summary>🧪 模板蒸馏与拆解 <span class="composer__hint">——样例文档 → 结构模板 + 文档技法（论文 / BP / 申报书通用）</span></summary>
    <p class="lead">粘贴或上传一篇写得好的样例文档，AI 拆解出小节结构（存为模板，新建时选用）与文风技法（存为文档技能，可勾选叠加）。</p>
    <form method="post" action="/docs/distill">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <div class="row">
        <div><label>模板名（留空让 AI 起）</label><input type="text" name="name" placeholder="如：优秀 BP 结构 v1"></div>
        <div><label>归属类型</label><select name="docType">${typeOptions('custom')}</select></div>
      </div>
      <label>样例文档（粘贴全文或上传 .md/.txt，至少 200 字）</label>
      <input type="file" id="distillFile" accept=".md,.txt,.markdown">
      <textarea name="sample" required placeholder="粘贴样例文档全文……"></textarea>
      <div class="actions"><button class="btn btn--primary btn--sm" type="submit">开始蒸馏与拆解</button></div>
    </form>
  </details>`;

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
    ${distillCard}
  </main>
  ${project ? renderTree(project, currentIdx) : renderOutlinePanel()}
  ${renderCreateModal(csrf, docSkills, project ? project.docType : type, isNew, docTemplates, project ? { thesis: project.thesis, points: project.points } : { thesis: '', points: [] })}
</div>
<script>
  function cxModeSet(mode) {
    document.getElementById('cxMode').value = mode;
    const pill = document.getElementById('cxPill');
    if (pill) for (const b of pill.querySelectorAll('.pill')) b.classList.toggle('is-on', b.textContent.includes(mode === 'co' ? '共创' : '托管'));
  }
  function cxPrepare() {
    const brief = document.getElementById('cxBrief').value.trim();
    if (!brief) { alert('先写一两句要做什么'); return false; }
    const lines = brief.split('
');
    document.getElementById('cxTitle').value = lines[0].slice(0, 80);
    const tpl = document.getElementById('tplArea');
    if (tpl) document.getElementById('cxTemplate').value = tpl.value;
    return true;
  }
  function syncSkills(slotId) {
    const ids = Array.from(document.querySelectorAll('.skillcheck:checked')).map((c) => c.value);
    const slot = document.getElementById(slotId);
    if (slot) slot.value = JSON.stringify(ids);
  }
  function openCreate(prefill) {
    const m = document.getElementById('createModal');
    if (!m) return;
    if (prefill) {
      const brief = document.getElementById('cmBrief');
      if (brief && !brief.value) brief.value = prefill;
    }
    m.style.display = 'flex';
    setTimeout(() => { const t = document.getElementById('cmBrief'); if (t) t.focus(); }, 60);
  }
  function closeCreate() { document.getElementById('createModal').style.display = 'none'; }
  function cmTab(mode) {
    document.getElementById('cmMode').value = mode;
    document.getElementById('cmTabCo').classList.toggle('is-on', mode === 'co');
    document.getElementById('cmTabAuto').classList.toggle('is-on', mode === 'auto');
    document.getElementById('cmAutoRow').style.display = mode === 'auto' ? 'flex' : 'none';
  }
  const DEFAULTS = ${JSON.stringify(Object.fromEntries(Object.values(docEngine.DOC_TYPES).map((t) => [t.key, t.sections])))};
  const TPL_MD = ${JSON.stringify(Object.fromEntries(docTemplates.map((t) => [t.id, templateMarkdown(t)])))};
  function applyTpl(id) {
    if (id && TPL_MD[id]) document.getElementById('tplArea').value = TPL_MD[id];
  }
  function fillDefault() {
    const key = document.getElementById('docType').value;
    const sections = DEFAULTS[key] || [];
    document.getElementById('tplArea').value = sections.length
      ? sections.map(s => '# ' + s.title + '\\n' + (s.brief || '')).join('\\n\\n') : '';
  }
  function syncOutlineToForm() {
    // 右栏「写作要点」面板 → 弹窗隐藏字段（论题/论据/计划章节）
    const g = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const split = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('cmThesis', g('__wx_thesis_rail'));
    set('cmPoints', JSON.stringify(split(g('__wx_points_rail'))));
    set('cmSecs', JSON.stringify(split(g('__wx_secs_rail')).map((title) => ({ title }))));
    return true;
  }
  async function cxDisill() {
    const sample = document.getElementById('cxDisSample').value.trim();
    if (sample.length < 200) { alert('样例文档太短（至少 200 字），蒸馏才有依据'); return; }
    const csrf = document.querySelector('#createModal input[name="csrf"]').value;
    const body = new URLSearchParams();
    body.set('csrf', csrf);
    body.set('name', document.getElementById('cxDisName').value);
    body.set('docType', document.getElementById('cxDisType').value);
    body.set('sample', sample);
    const btn = document.querySelector('button[onclick="cxDisill()"]');
    if (btn) { btn.disabled = true; btn.textContent = '蒸馏中…'; }
    try {
      const res = await fetch('/docs/distill', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) { alert('蒸馏失败：' + (data.message || ('HTTP ' + res.status))); return; }
      alert(data.message || '蒸馏完成');
      location.href = '/docs?new=1';
    } catch (e) {
      alert('蒸馏失败：' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '开始蒸馏与拆解'; }
    }
  }
  function mergeDirection() {
    const parts = [];
    for (const [id, label] of [['dirAudience', '受众'], ['dirTone', '语气'], ['dirLen', '篇幅']]) {
      const el = document.getElementById(id);
      const v = el && el.value.trim();
      if (v) parts.push(label + '：' + v);
    }
    if (parts.length) {
      const brief = document.getElementById('cmBrief');
      brief.value = (brief.value ? brief.value + '\\n' : '') + '【方向】' + parts.join('；');
    }
    return true;
  }
  const distillFile = document.getElementById('distillFile');
  if (distillFile) distillFile.addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;
    file.text().then(t => {
      const area = document.querySelector('textarea[name=sample]');
      if (area) area.value = t;
    }).catch(() => alert('读取文件失败（仅支持文本类 .md/.txt）'));
  });
</script>
</body></html>`;
}

// 兼容旧测试入口
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
      const type = docEngine.docTypeOf(u.searchParams.get('type') || 'bp').key;
      const outcome = id ? noticeFor(id) : {};
      sendHtml(res, renderDocsPage({ csrf: token, id, s, edit, isNew, type, ...outcome }));
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
  const routes = ['docs/create', 'docs/delete', 'docs/section', 'docs/generate', 'docs/resume', 'docs/mode', 'docs/continue', 'docs/distill', 'docs/distill-project', 'docs/template', 'docs/outline'];
  if (!routes.includes(action)) return false;
  let form;
  try { form = await readForm(req, 512 * 1024); }
  catch (error) { bad(res, 413, 'too large'); return true; }
  if (String(form.get('csrf') || '') !== token) { bad(res, 403, 'bad csrf'); return true; }

  const projectId = String(form.get('projectId') || '');
  const backIdx = Number(form.get('s')) || Number(form.get('idx')) || 1;
  try {
    if (action === 'docs/create') {
      // 右栏「写作要点」面板：论题 / 论据要点 / 计划章节（一行一节）
      let thesis = ''; let points = []; let plannedSections = null;
      try { thesis = String(form.get('thesis') || ''); } catch {}
      try { points = JSON.parse(String(form.get('pointsJson') || '[]')); } catch {}
      try { plannedSections = JSON.parse(String(form.get('sectionsJson') || 'null')); } catch {}
      const project = docEngine.createProject({
        title: form.get('title'), docType: form.get('docType'), mode: form.get('mode'),
        brief: form.get('brief'), template: form.get('template'),
        skillIds: form.getAll('skillId'),
        thesis, points,
        sections: Array.isArray(plannedSections) && plannedSections.length
          ? plannedSections.map((t) => ({ title: String(t || '') })) : null,
      });
      // 全托管勾选了「创建后自动开始整篇生成」：后台拉起批量，页面直接进工作台看进度。
      if (String(form.get('autoStart') || '') === '1' && project.mode === 'auto') {
        jobNotices.set(project.id, { at: Date.now(), ok: true, message: '整篇生成已启动…' });
        statusPage.startResume(project.id, {
          resume: (id) => docEngine.generateDocProject({ projectId: id }),
          onSettled: (id, error, result) => jobNotices.set(id, error
            ? { at: Date.now(), ok: false, message: `生成中断：${String(error.message || error).slice(0, 160)}` }
            : { at: Date.now(), ok: true, message: `生成结束：新写 ${result?.created?.length || 0} 节${result?.quarantined?.length ? '，' + result.quarantined.length + ' 节失败' : ''}` }),
        });
      }
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
    if (action === 'docs/mode') {
      docEngine.setProjectMode(projectId, String(form.get('mode') || 'co'));
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/section') {
      const op = String(parts[2] || '');
      const idx = Number(form.get('idx'));
      // 技能勾选：持久化到项目（整篇批量沿用同一份）并注入本次生成。
      let skillIds = [];
      try { skillIds = JSON.parse(String(form.get('skillIdsJson') || '[]') || '[]'); } catch {}
      if (op === 'save') docEngine.saveSectionContent(projectId, idx, form.get('content'), 'manual');
      else if (op === 'draft') { docEngine.setProjectSkills(projectId, skillIds); await docEngine.draftSection(projectId, idx, { skillIds }); }
      else if (op === 'revise') { docEngine.setProjectSkills(projectId, skillIds); await docEngine.reviseSection(projectId, idx, form.get('instruction'), { skillIds }); }
      else if (op === 'chat') { docEngine.setProjectSkills(projectId, skillIds); await docEngine.sectionChat({ projectId, idx, message: form.get('message') }); }
      else { bad(res, 404, 'unknown op'); return true; }
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${idx}` });
      res.end();
      return true;
    }
    if (action === 'docs/outline') {
      let points = [];
      try { points = JSON.parse(String(form.get('pointsJson') || '[]')); } catch {}
      docEngine.setProjectOutline({ projectId, thesis: form.get('thesis'), points });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/continue') {
      const project = docEngine.getProject(projectId);
      if (!project) { bad(res, 404, 'not found'); return true; }
      const result = await docEngine.continueNextSection(projectId);
      jobNotices.set(projectId, { at: Date.now(), ok: true, message: result.done ? result.message : `已续写第 ${result.idx} 节「${result.title}」` });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${result.idx || 1}` });
      res.end();
      return true;
    }
    if (action === 'docs/distill') {
      // fetch 调用：JSON 响应，成功/失败都能被前端区分
      try {
        const result = await docEngine.distillDocTemplate({
          name: form.get('name'), docType: form.get('docType'), sample: form.get('sample'),
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, templateId: result.templateId, name: result.name,
          message: `蒸馏完成「${result.name}」：已存为模板 + 文档技能（${result.sections.length} 节）` }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, message: String(error.message || error).slice(0, 200) }));
      }
      return true;
    }
    if (action === 'docs/distill-project') {
      const project = docEngine.getProject(projectId);
      if (!project) { bad(res, 404, 'not found'); return true; }
      const assembled = docEngine.assembleMarkdown(projectId);
      const result = await docEngine.distillDocTemplate({
        name: `${project.title} 结构`, docType: project.docType, sample: assembled.markdown,
      });
      jobNotices.set(projectId, { at: Date.now(), ok: true, message: `已把本文蒸馏为模板「${result.name}」（${result.sections.length} 节）+ 文档技法技能` });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/template') {
      if (String(parts[2] || '') !== 'delete') { bad(res, 404, 'unknown op'); return true; }
      docEngine.deleteDocTemplate(String(form.get('templateId') || ''));
      res.writeHead(303, { Location: backHref(projectId, backIdx) });
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
