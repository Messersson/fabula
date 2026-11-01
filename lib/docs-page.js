'use strict';

// 文档工作台页面：/docs。与小说主界面同款形态——
// 左栏项目列表 · 中间文档区 + 底部输入条（含 AI 共创 / AI 全托管 胶囊切换）· 右侧目录树。
// AI 共创模式 = 对话式协作：AI 追问 → 作者回答 → 成稿（与小说的新书共创同语义）。
// 服务端直渲染（web/ 无源码），状态走 URL（?id= 项目 &s= 小节 &edit=1 &new=1 &type=），
// 动作走表单 POST + 303 跳回原上下文。
const docEngine = require('./doc-engine');
const docLayout = require('./doc-layout');
const docxProbe = require('./docx-probe');
const figure = require('./doc-figure');
const docMath = require('./doc-math');
const docQuality = require('./doc-quality');
const docTable = require('./doc-table');
const mis = require('./handlers-misc');
const llm = require('./llm');
const mdMini = require('./md-mini');
const statusPage = require('./status-page');
const { q, one } = require('./db');

const { escapeHtml, sendHtml, readForm } = statusPage;

const CSS = `
  /* ============ 设计令牌：与小说工作台同一套（web/assets/index-*.css 的 :root） ============ */
  :root {
    color-scheme: light;
    /* 底色与面板 */
    --c-app-bg:#fafafa; --c-topbar-bg:#ffffff; --c-left-bg:#ffffff; --c-center-bg:#ffffff;
    --c-card-light:#fafafa; --c-card-light-2:#f7f7f8; --c-card-light-3:#f8f8f8;
    /* 强调色 */
    --c-accent:#2563eb; --c-accent-hover:#1d4ed8; --c-accent-bg:#eff6ff; --c-accent-border:#bfdbfe;
    --c-accent-row-sel:#f5f9ff; --c-on-accent:#ffffff;
    /* 文字 */
    --c-text-main:#1a1a1a; --c-text-2:#3f3f46; --c-text-secondary:#52525b; --c-text-3:#6a6a71;
    --c-text-muted:#a1a1aa; --c-text-placeholder:#a4a4ab; --c-prose:#303036;
    /* 描边 */
    --c-border:#e5e5e5; --c-border-2:#e8e8e8; --c-border-3:#ededed; --c-border-soft:#efeff0;
    --c-border-input:#dcdcdf; --c-border-btn:#dcdcdf; --c-divider:#e8e8e8;
    /* 交互态 */
    --c-row-hover:#f4f4f5; --c-row-hover-2:#f6f6f7; --c-row-active-bg:#ececee;
    --c-icon-btn-hover:#efeff0; --c-tab-container:#f0f0f1; --c-badge-bg:#f0f0f1;
    /* 语义色 */
    --c-success-text:#16a34a; --c-success-bg:#f0fdf4; --c-success-border:#bbf7d0;
    --c-warn-text:#b45309; --c-warn-bg:#fffbeb; --c-warn-border:#fde68a;
    --c-danger-text:#dc2626; --c-danger-bg:#fef2f2; --c-danger-border:#fecaca;
    --c-dot-ok:#2fbf83; --c-dot-warn:#d9a406; --c-dot-idle:#d4d4d8;
    /* 圆角 */
    --r-btn-sm:6px; --r-btn:8px; --r-card-sm:10px; --r-card:12px; --r-dock:16px; --r-pill:999px;
    /* 阴影 */
    --sh-card:0 1px 2px rgba(17,17,19,.05); --sh-card-soft:0 1px 2px rgba(17,17,19,.04);
    --sh-card-hover:0 4px 16px rgba(17,17,19,.08); --sh-dock:0 4px 20px rgba(17,17,19,.08);
    --sh-modal:0 18px 50px rgba(17,17,19,.2); --sh-btn:0 1px 2px rgba(37,99,235,.28);
    /* 动效 */
    --t-fast:.12s; --t-med:.2s; --t-slow:.32s; --ease-out:cubic-bezier(.22,.61,.36,1);
    /* 字体与字号 */
    --font-ui:"Segoe UI Variable Text","Segoe UI","Noto Sans SC","Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif;
    --font-mono:"Cascadia Mono","SFMono-Regular",Consolas,"Liberation Mono",monospace;
    --fs-body:14px; --fs-ui-title:16px; --fs-ui-body:14px; --fs-ui-label:13px; --fs-ui-caption:12px;
    /* 尺寸 */
    --h-header:50px; --w-left:284px; --w-right:264px; --content-max:960px;
    --c-scrollbar:rgba(24,24,27,.16); --c-scrollbar-hover:rgba(24,24,27,.3);

    /* 兼容旧类名的别名（旧样式大量引用这些变量，映射到新令牌即可整体换肤） */
    --line:var(--c-border); --ink:var(--c-text-main); --sub:var(--c-text-secondary);
    --bg:var(--c-app-bg); --panel:var(--c-center-bg); --brand:var(--c-accent); --brand-weak:var(--c-accent-bg);
  }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body { margin:0; background:var(--c-app-bg); color:var(--c-text-main);
    font:var(--fs-ui-body)/1.7 var(--font-ui); -webkit-font-smoothing:antialiased; }
  button { font:inherit; cursor:pointer; }
  a { color:var(--c-accent); text-decoration:none; }
  a:hover { color:var(--c-accent-hover); }
  ::selection { background:var(--c-accent-bg); }
  :focus-visible { outline:2px solid var(--c-accent); outline-offset:1px; border-radius:var(--r-btn-sm); }
  ::-webkit-scrollbar { width:10px; height:10px; }
  ::-webkit-scrollbar-thumb { background:var(--c-scrollbar); border-radius:var(--r-pill);
    border:2px solid transparent; background-clip:content-box; }
  ::-webkit-scrollbar-thumb:hover { background:var(--c-scrollbar-hover); background-clip:content-box; }
  ::-webkit-scrollbar-track { background:transparent; }

  .app { display:flex; height:100vh; overflow:hidden; background:var(--c-app-bg); }

  /* ---------- 左栏：项目列表 ---------- */
  .rail { width:var(--w-left); flex:none; background:var(--c-left-bg); border-right:1px solid var(--c-border);
    display:flex; flex-direction:column; }
  .rail__brand { padding:16px 16px 10px; font-size:var(--fs-ui-title); font-weight:600;
    letter-spacing:-.01em; color:var(--c-text-main); }
  .rail__brand .sub { display:block; font-weight:400; font-size:var(--fs-ui-caption);
    color:var(--c-text-muted); margin-top:2px; letter-spacing:0; }
  .rail__new { margin:4px 12px 10px; display:flex; align-items:center; justify-content:center; gap:6px;
    padding:9px 0; border-radius:var(--r-btn); background:var(--c-accent); color:var(--c-on-accent);
    font-weight:600; font-size:var(--fs-ui-label); box-shadow:var(--sh-btn);
    transition:background var(--t-fast) var(--ease-out); }
  .rail__new:hover { background:var(--c-accent-hover); color:var(--c-on-accent); }
  .rail__sect { padding:10px 16px 4px; font-size:11px; font-weight:600; color:var(--c-text-muted);
    letter-spacing:.06em; text-transform:uppercase; }
  .rail__list { flex:1; overflow-y:auto; padding:0 8px 10px; }
  .pcard { display:block; width:100%; text-align:left; border:0; background:none;
    padding:8px 10px; border-radius:var(--r-btn); margin-bottom:2px; color:inherit;
    transition:background var(--t-fast) var(--ease-out); }
  .pcard:hover { background:var(--c-row-hover); }
  .pcard.is-active { background:var(--c-accent-bg); box-shadow:inset 0 0 0 1px var(--c-accent-border); }
  .pcard__top { display:flex; align-items:center; gap:7px; }
  .pcard__name { font-weight:600; font-size:var(--fs-ui-label); white-space:nowrap; overflow:hidden;
    text-overflow:ellipsis; flex:1; color:var(--c-text-main); }
  .pcard__sub { font-size:var(--fs-ui-caption); color:var(--c-text-muted); margin-top:2px; }
  .dot { width:7px; height:7px; border-radius:50%; flex:none; }
  .dot.ok { background:var(--c-dot-ok); } .dot.bad { background:var(--c-danger-text); }
  .dot.warn { background:var(--c-dot-warn); } .dot.mute { background:var(--c-dot-idle); }
  .rail__foot { border-top:1px solid var(--c-border); padding:10px 14px; display:flex;
    flex-direction:column; gap:2px; }
  .rail__foot a { color:var(--c-text-secondary); font-size:var(--fs-ui-caption); padding:4px 0;
    border-radius:var(--r-btn-sm); transition:color var(--t-fast) var(--ease-out); }
  .rail__foot a:hover { color:var(--c-text-main); }

  /* ---------- 中栏：工作区 ---------- */
  .work { flex:1; min-width:0; display:flex; flex-direction:column; background:var(--c-center-bg); }
  .work__head { flex:none; min-height:var(--h-header); display:flex; align-items:center; gap:10px;
    flex-wrap:wrap; padding:8px 20px; background:var(--c-topbar-bg);
    border-bottom:1px solid var(--c-border); position:sticky; top:0; z-index:20; }
  .work__title { font-size:var(--fs-ui-title); font-weight:600; letter-spacing:-.01em; }
  .work__meta { font-size:var(--fs-ui-caption); color:var(--c-text-muted); }
  .work__acts { margin-left:auto; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .btn { border:1px solid var(--c-border-btn); background:var(--c-center-bg); border-radius:var(--r-btn);
    padding:5px 12px; font-size:var(--fs-ui-label); color:var(--c-text-2);
    transition:background var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out); }
  .btn:hover { background:var(--c-row-hover); border-color:var(--c-border-input); }
  .btn--primary { background:var(--c-accent); border-color:var(--c-accent); color:var(--c-on-accent);
    font-weight:600; box-shadow:var(--sh-btn); }
  .btn--primary:hover { background:var(--c-accent-hover); border-color:var(--c-accent-hover); }
  .btn--danger { color:var(--c-danger-text); border-color:var(--c-danger-border); }
  .btn--danger:hover { background:var(--c-danger-bg); }
  .btn--sm { padding:3px 9px; font-size:var(--fs-ui-caption); border-radius:var(--r-btn-sm); }

  .banner { margin:10px 20px 0; padding:9px 12px; border-radius:var(--r-btn);
    font-size:var(--fs-ui-caption); border:1px solid transparent; }
  .banner.ok { background:var(--c-success-bg); color:var(--c-success-text); border-color:var(--c-success-border); }
  .banner.bad { background:var(--c-danger-bg); color:var(--c-danger-text); border-color:var(--c-danger-border); }

  .docbody { flex:1; overflow-y:auto; padding:28px 36px 56px; }
  .docbody__inner { max-width:var(--content-max); margin:0 auto; }
  .sec__brief { color:var(--c-text-secondary); font-size:var(--fs-ui-caption);
    background:var(--c-card-light-2); border:1px solid var(--c-border-3);
    border-radius:var(--r-card-sm); padding:9px 12px; margin:0 0 14px; }
  /* 正文预览用项目自己的版式变量（字体/字号/行距来自蒸馏或手改的规格）——
     不接变量的话，页面上永远是 15px 无衬线，作者看不出「蒸馏出的字体」到底生效没有。 */
  .sec__text { white-space:pre-wrap; word-break:break-word; color:var(--c-prose);
    font-family:var(--doc-body-font, inherit); font-size:var(--doc-body-size, 15px);
    line-height:var(--doc-line-height, 1.95); }
  .sec__text.is-empty { color:var(--c-text-placeholder); }
  .sec__text textarea { width:100%; min-height:320px; border:1px solid var(--c-border-input);
    border-radius:var(--r-card-sm); padding:14px; font:13px/1.9 var(--font-mono);
    background:var(--c-center-bg); color:var(--c-text-main); }
  .sec__nav { display:flex; justify-content:space-between; margin-top:26px; }
  .mdtable { width:100%; border-collapse:collapse; margin:12px 0; font-size:13px; }
  .mdtable th { background:var(--c-card-light-2); text-align:left; padding:7px 10px;
    border:1px solid var(--c-border); font-weight:600; }
  .mdtable td { padding:7px 10px; border:1px solid var(--c-border); }
  .mdh { margin:18px 0 8px; font-size:16px; font-weight:600; letter-spacing:-.01em; }
  .mdpre { background:#1f2430; color:#dce3ed; padding:12px 14px; border-radius:var(--r-card-sm);
    overflow-x:auto; font:12px/1.7 var(--font-mono); }
  .mdpre code { background:none; color:inherit; padding:0; }
  .mdc { background:var(--c-tab-container); border-radius:4px; padding:1px 5px;
    font-family:var(--font-mono); font-size:12px; }
  .mdlist { padding-left:22px; }
  .mdquote { border-left:3px solid var(--c-accent-border); margin:10px 0; padding:4px 12px;
    color:var(--c-text-secondary); background:var(--c-card-light-2); border-radius:0 var(--r-btn-sm) var(--r-btn-sm) 0; }
  .mdhr { border:0; border-top:1px solid var(--c-border); margin:16px 0; }

  /* ---------- AI 共创：对话线程 ---------- */
  .chatthread { display:flex; flex-direction:column; gap:10px; margin:0 0 10px; }
  .chatmsg { display:flex; }
  .chatmsg--me { justify-content:flex-end; }
  .chatmsg--ai { justify-content:flex-start; }
  .chatmsg__bubble { max-width:82%; padding:9px 13px; border-radius:var(--r-card);
    font-size:var(--fs-ui-body); white-space:pre-wrap; word-break:break-word; }
  .chatmsg--ai .chatmsg__bubble { background:var(--c-card-light-2); border:1px solid var(--c-border-3);
    border-top-left-radius:4px; }
  .chatmsg--me .chatmsg__bubble { background:var(--c-accent-bg); border:1px solid var(--c-accent-border);
    border-top-right-radius:4px; }

  /* ---------- 底部输入条（仿主界面对话坞） ---------- */
  .composer { flex:none; margin:0 auto 16px; width:min(760px, calc(100% - 40px));
    background:var(--c-center-bg); border:1px solid var(--c-border); border-radius:var(--r-dock);
    padding:12px 14px 8px; box-shadow:var(--sh-dock); }
  .composer textarea { width:100%; border:0; outline:none; resize:none; font:inherit;
    min-height:44px; max-height:160px; background:none; color:var(--c-text-main); }
  .composer textarea::placeholder { color:var(--c-text-placeholder); }
  .composer input[type=text] { width:100%; border:0; outline:none; font:inherit; font-weight:600;
    background:none; color:var(--c-text-main); }
  .composer input[type=text]::placeholder { font-weight:400; color:var(--c-text-placeholder); }
  .composer__acts { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:4px; }
  .composer__hint { color:var(--c-text-muted); font-size:var(--fs-ui-caption); }
  .composer__send { margin-left:auto; display:flex; align-items:center; gap:8px; }
  .sendbtn { width:32px; height:32px; border-radius:50%; background:var(--c-accent);
    color:var(--c-on-accent); border:0; font-size:15px; line-height:1; flex:none;
    display:inline-flex; align-items:center; justify-content:center; box-shadow:var(--sh-btn);
    transition:background var(--t-fast) var(--ease-out); }
  .sendbtn:hover { background:var(--c-accent-hover); }

  /* 模式胶囊（仿主界面分段控件：灰底 + 白色选中块） */
  .pillgroup { display:inline-flex; background:var(--c-tab-container); border-radius:var(--r-pill);
    padding:3px; gap:2px; }
  .pill { border:0; background:none; border-radius:var(--r-pill); padding:4px 12px;
    font-size:var(--fs-ui-caption); color:var(--c-text-secondary); white-space:nowrap;
    transition:background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out); }
  .pill:hover { color:var(--c-text-main); }
  .pill.is-on { background:var(--c-center-bg); color:var(--c-text-main); font-weight:600;
    box-shadow:0 1px 3px rgba(17,17,19,.12); }
  .pillgroup--static .pill { cursor:default; }
  form.inline { display:inline; }

  /* 下拉菜单（技能勾选 / 模板 / 更多操作） */
  .menu { position:relative; }
  .menu__btn { border:1px solid var(--c-border); background:var(--c-center-bg);
    border-radius:var(--r-pill); padding:4px 10px; font-size:var(--fs-ui-caption);
    color:var(--c-text-secondary); list-style:none; transition:background var(--t-fast) var(--ease-out); }
  .menu__btn:hover { background:var(--c-row-hover); }
  .menu__btn::-webkit-details-marker { display:none; }
  .menu[open] .menu__btn { background:var(--c-row-hover); }
  .menu--left .menu__panel { left:0; right:auto; }
  .menu__panel { position:absolute; bottom:calc(100% + 8px); right:0; background:var(--c-center-bg);
    border:1px solid var(--c-border); border-radius:var(--r-card); min-width:200px; padding:6px;
    box-shadow:var(--sh-card-hover); z-index:30; }
  .menu__panel--wide { min-width:360px; }
  .menu__panel--scroll { max-height:320px; overflow-y:auto; }
  .menu__panel textarea { min-height:90px; margin-bottom:8px; }
  .menu__panel button, .menu__panel a { display:block; width:100%; text-align:left; border:0;
    background:none; padding:8px 10px; border-radius:var(--r-btn); font-size:var(--fs-ui-caption);
    color:var(--c-text-main); transition:background var(--t-fast) var(--ease-out); }
  .menu__panel button:hover, .menu__panel a:hover { background:var(--c-row-hover); }
  .menu__panel .danger { color:var(--c-danger-text); }
  .menu__panel hr { border:0; border-top:1px solid var(--c-border); margin:4px 0; }
  .menu__group { padding:6px 8px 2px; font-size:10.5px; font-weight:600; color:var(--c-text-muted);
    letter-spacing:.06em; text-transform:uppercase; }
  .menu__item { display:flex; align-items:center; gap:7px; padding:6px 8px; border-radius:var(--r-btn-sm);
    font-size:var(--fs-ui-caption); cursor:pointer; transition:background var(--t-fast) var(--ease-out); }
  .menu__item:hover { background:var(--c-row-hover); }
  .menu__item input { accent-color:var(--c-accent); }
  .menu__item.is-disabled span { color:var(--c-text-muted); }
  /* 模型胶囊：显示当前渠道模型，点开切换 */
  .modelchip { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--c-border);
    background:var(--c-center-bg); border-radius:var(--r-pill); padding:4px 10px;
    font-size:var(--fs-ui-caption); color:var(--c-text-2); cursor:pointer; list-style:none;
    max-width:220px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    transition:background var(--t-fast) var(--ease-out), border-color var(--t-fast) var(--ease-out); }
  .modelchip::-webkit-details-marker { display:none; }
  .modelchip:hover { background:var(--c-row-hover); border-color:var(--c-border-input); }
  .modelchip__dot { width:6px; height:6px; border-radius:50%; background:var(--c-dot-ok); flex:none; }
  .modelchip--empty { color:var(--c-danger-text); border-color:var(--c-danger-border);
    background:var(--c-danger-bg); }
  .modelchip--empty .modelchip__dot { background:var(--c-danger-text); }
  .modelchip__panel { min-width:260px; padding:6px; }
  .modelitem { display:flex; flex-direction:column; align-items:flex-start; gap:1px;
    width:100%; text-align:left; border:0; background:none; padding:7px 10px;
    border-radius:var(--r-btn); cursor:pointer; }
  .modelitem:hover { background:var(--c-row-hover); }
  .modelitem.is-on { background:var(--c-accent-bg); }
  .modelitem__name { font-size:var(--fs-ui-label); font-weight:600; color:var(--c-text-main);
    max-width:230px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .modelitem.is-on .modelitem__name { color:var(--c-accent); }
  .modelitem__meta { font-size:11px; color:var(--c-text-muted); }
  .modelchip__note { padding:6px 10px 2px; font-size:11px; color:var(--c-text-muted); }
  .pill-select { border:1px solid var(--c-border); border-radius:var(--r-pill); padding:4px 9px;
    font-size:var(--fs-ui-caption); background:var(--c-center-bg); color:var(--c-text-main);
    max-width:150px; }

  /* ---------- 「新建文档」弹窗 ---------- */
  .cmodal { position:fixed; inset:0; z-index:2147482000; display:flex; align-items:center;
    justify-content:center; }
  .cmodal__backdrop { position:absolute; inset:0; background:rgba(24,24,27,.32); }
  .cmodal__card { position:relative; width:min(580px, calc(100% - 32px));
    max-height:calc(100vh - 60px); overflow-y:auto; background:var(--c-center-bg);
    border-radius:var(--r-dock); box-shadow:var(--sh-modal); }
  .cmodal__head { display:flex; align-items:center; gap:10px; padding:18px 20px 10px; }
  .cmodal__icon { width:30px; height:30px; border-radius:var(--r-btn); background:var(--c-accent-bg);
    color:var(--c-accent); display:inline-flex; align-items:center; justify-content:center; }
  .cmodal__head b { font-size:var(--fs-ui-title); font-weight:600; flex:1; }
  .cmodal__x { border:0; background:none; font-size:18px; color:var(--c-text-muted); padding:2px 6px;
    border-radius:var(--r-btn-sm); }
  .cmodal__x:hover { background:var(--c-row-hover); color:var(--c-text-main); }
  .cmodal__tabs { display:flex; margin:4px 20px 0; background:var(--c-tab-container);
    border-radius:var(--r-card-sm); padding:3px; gap:3px; }
  .cmodal__tab { flex:1; border:0; background:none; border-radius:var(--r-btn); padding:7px 0;
    font-size:var(--fs-ui-caption); color:var(--c-text-secondary);
    transition:background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out); }
  .cmodal__tab:hover { color:var(--c-text-main); }
  .cmodal__tab.is-on { background:var(--c-center-bg); color:var(--c-text-main); font-weight:600;
    box-shadow:0 1px 3px rgba(17,17,19,.12); }
  .cmodal__body { padding:6px 20px 0; }
  .cmodal__label { font-weight:600; font-size:var(--fs-ui-label); margin:14px 0 5px;
    color:var(--c-text-main); }
  .cmodal__label .cmodal__opt, .cmodal__opt { font-weight:400; color:var(--c-text-muted);
    font-size:var(--fs-ui-caption); }
  .cmodal__body textarea, .cmodal__body input[type=text], .cmodal__body select {
    width:100%; font:inherit; padding:9px 11px; border:1px solid var(--c-border-input);
    border-radius:var(--r-card-sm); background:var(--c-center-bg); color:var(--c-text-main);
    transition:border-color var(--t-fast) var(--ease-out), box-shadow var(--t-fast) var(--ease-out); }
  .cmodal__body textarea:focus, .cmodal__body input[type=text]:focus, .cmodal__body select:focus {
    outline:none; border-color:var(--c-accent); box-shadow:0 0 0 3px var(--c-accent-bg); }
  .cmodal__body textarea { min-height:88px; resize:vertical; }
  .cmodal__body textarea.code { font-family:var(--font-mono); font-size:12px; }
  .cmodal__hint { color:var(--c-text-muted); font-size:var(--fs-ui-caption); margin:5px 0 8px; }
  .cmodal__uprow { font-size:var(--fs-ui-caption); color:var(--c-text-secondary); margin:8px 0 4px;
    display:flex; align-items:center; gap:8px; }
  .cmodal__uprow input[type=file] { font-size:var(--fs-ui-caption); }
  .cmodal__fold summary { cursor:pointer; font-size:var(--fs-ui-caption); padding:9px 12px;
    border:1px solid var(--c-border); border-radius:var(--r-card-sm); list-style:none;
    color:var(--c-text-main); display:flex; justify-content:space-between; align-items:center;
    transition:background var(--t-fast) var(--ease-out); }
  .cmodal__fold summary:hover { background:var(--c-row-hover); }
  .cmodal__fold summary::-webkit-details-marker { display:none; }
  .cmodal__fold[open] summary { margin-bottom:4px; }
  .cmodal__fold label { font-weight:400; font-size:var(--fs-ui-caption);
    color:var(--c-text-muted); margin:6px 0 3px; }
  .cmodal__check { display:flex; align-items:center; gap:8px; font-size:var(--fs-ui-caption);
    border:1px solid var(--c-border); border-radius:var(--r-card-sm); padding:9px 12px;
    margin:12px 0 4px; cursor:pointer; transition:background var(--t-fast) var(--ease-out); }
  .cmodal__check:hover { background:var(--c-row-hover); }
  .cmodal__check input { accent-color:var(--c-accent); }
  .cmodal__foot { display:flex; align-items:center; justify-content:space-between;
    padding:14px 20px 18px; }
  .cmodal__foot .btn { padding:7px 18px; }

  /* ---------- 右栏：目录树 ---------- */
  .tree { width:var(--w-right); flex:none; background:var(--c-left-bg);
    border-left:1px solid var(--c-border); display:flex; flex-direction:column; }
  .tree__sect { padding:14px 16px 4px; font-size:11px; font-weight:600; color:var(--c-text-muted);
    letter-spacing:.06em; text-transform:uppercase; }
  .tree__list { flex:1; overflow-y:auto; padding:0 8px 10px; }
  .trow { display:flex; align-items:center; gap:7px; width:100%; text-align:left; border:0;
    background:none; padding:6px 9px; border-radius:var(--r-btn); font-size:var(--fs-ui-caption);
    color:var(--c-text-secondary); transition:background var(--t-fast) var(--ease-out); }
  .trow:hover { background:var(--c-row-hover); color:var(--c-text-main); }
  .trow.is-active { background:var(--c-accent-bg); color:var(--c-accent); font-weight:600;
    box-shadow:inset 0 0 0 1px var(--c-accent-border); }
  .trow__no { color:var(--c-text-muted); font-variant-numeric:tabular-nums; flex:none; }
  .trow.is-active .trow__no { color:var(--c-accent); }
  .trow__name { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* 目录层级：二级/三级小节缩进 + 降一档字号，结构一眼可见 */
  .trow--l2 { margin-left:14px; width:calc(100% - 14px); font-size:calc(var(--fs-ui-caption) - 0.5px); }
  .trow--l3 { margin-left:28px; width:calc(100% - 28px); font-size:calc(var(--fs-ui-caption) - 1px); }
  .trow--l2 .trow__name, .trow--l3 .trow__name { color:var(--c-text-3); }
  /* 版式卡：一行一项，读起来像「规格表」而不是表单 */
  .layoutspec { display:flex; flex-direction:column; gap:6px; margin:10px 0 12px; }
  .layoutspec__row { display:flex; gap:8px; align-items:baseline; font-size:var(--fs-ui-caption);
    color:var(--c-text-secondary); }
  .layoutspec__k { flex:none; width:56px; color:var(--c-text-muted); }
  .layoutspec__v { flex:1; color:var(--c-text-main); }
  .layoutgrid { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:8px; }
  .layoutgrid label { display:block; font-weight:600; font-size:11px; margin-bottom:3px; color:var(--c-text-3); }
  .layoutgrid input, .layoutgrid select { width:100%; font:inherit; font-size:12px; padding:5px 8px;
    border:1px solid var(--c-border-input); border-radius:var(--r-btn-sm); background:#fff; }
  .tree__info { border-top:1px solid var(--c-border); padding:12px 16px;
    font-size:var(--fs-ui-caption); color:var(--c-text-secondary); max-height:180px;
    overflow-y:auto; white-space:pre-wrap; }

  /* ---------- 空态 hero ---------- */
  .hero { text-align:center; margin-top:14vh; margin-bottom:22px; }
  .hero__icon { width:72px; height:72px; border-radius:20px; margin:0 auto 16px;
    background:linear-gradient(135deg, #3b82f6, #1d4ed8); color:#fff; font-size:32px;
    display:flex; align-items:center; justify-content:center;
    box-shadow:0 10px 24px rgba(37,99,235,.28); }
  .hero__title { font-size:19px; font-weight:600; letter-spacing:-.01em; }
  .hero__sub { color:var(--c-text-secondary); font-size:var(--fs-ui-caption); margin-top:6px; }
  .herozone { flex:1 1 auto; display:flex; flex-direction:column; justify-content:center;
    align-items:center; overflow-y:auto; }

  /* ---------- 折叠卡片（模板蒸馏 / 大纲 / 各类工具卡） ---------- */
  .distillcard, .outlinecard { background:var(--c-center-bg); border:1px solid var(--c-border);
    border-radius:var(--r-card); padding:12px 14px; box-shadow:var(--sh-card-soft); }
  .distillcard { margin-top:14px; }
  .outlinecard { margin-bottom:14px; }
  .distillcard summary, .outlinecard summary { cursor:pointer; font-weight:600;
    font-size:var(--fs-ui-label); list-style:none; color:var(--c-text-main);
    display:flex; align-items:center; gap:8px; }
  .distillcard summary::-webkit-details-marker,
  .outlinecard summary::-webkit-details-marker { display:none; }
  .distillcard summary::after, .outlinecard summary::after {
    content:"›"; margin-left:auto; color:var(--c-text-muted); font-size:15px;
    transition:transform var(--t-med) var(--ease-out); }
  .distillcard[open] summary::after, .outlinecard[open] summary::after { transform:rotate(90deg); }
  .outlinecard[open] summary { margin-bottom:6px; }
  .distillcard .lead { color:var(--c-text-secondary); font-size:var(--fs-ui-caption);
    margin:4px 0 8px; }
  .distillcard label, .outlinecard label { display:block; font-weight:600; font-size:12px;
    margin:8px 0 3px; color:var(--c-text-2); }
  /* 卡片内的表单控件统一成同一套外观（输入框、下拉、数字框、文件框） */
  .distillcard input[type=text], .distillcard input[type=number], .distillcard select,
  .distillcard textarea, .outlinecard input[type=text], .outlinecard input[type=number],
  .outlinecard select, .outlinecard textarea, .dataset input[type=text],
  .dataset select, .preset input[type=number], .preset select { width:100%; font:inherit;
    font-size:var(--fs-ui-label); padding:7px 9px; border:1px solid var(--c-border-input);
    border-radius:var(--r-btn); background:var(--c-center-bg); color:var(--c-text-main);
    transition:border-color var(--t-fast) var(--ease-out), box-shadow var(--t-fast) var(--ease-out); }
  .distillcard input[type=text]:focus, .distillcard input[type=number]:focus, .distillcard select:focus,
  .distillcard textarea:focus, .outlinecard input[type=text]:focus,
  .outlinecard input[type=number]:focus, .outlinecard select:focus, .outlinecard textarea:focus,
  .dataset input[type=text]:focus, .dataset select:focus,
  .preset input[type=number]:focus, .preset select:focus { outline:none;
    border-color:var(--c-accent); box-shadow:0 0 0 3px var(--c-accent-bg); }
  .outlinecard input[type=file], .distillcard input[type=file] { font-size:var(--fs-ui-caption);
    color:var(--c-text-secondary); }
  .outlinecard select[multiple] { padding:4px; min-height:64px; }
  .outlinecard input::placeholder, .distillcard input::placeholder,
  .outlinecard textarea::placeholder { color:var(--c-text-placeholder); }
  .distillcard textarea, .outlinecard textarea { min-height:90px; resize:vertical; }
  .distillcard textarea.code, .outlinecard textarea.code { font-family:var(--font-mono); font-size:12px; }
  .distillcard input[type=file] { font-size:var(--fs-ui-caption); }
  .tplrow { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:var(--r-btn);
    font-size:var(--fs-ui-caption); transition:background var(--t-fast) var(--ease-out); }
  .tplrow:hover { background:var(--c-row-hover); }
  .tplrow__name { flex:1; font-weight:600; }
  .tplrow__meta { color:var(--c-text-muted); font-size:var(--fs-ui-caption); }
  .distillresult { background:var(--c-card-light-2); border:1px solid var(--c-border-3);
    border-radius:var(--r-btn); padding:10px 12px; font-size:var(--fs-ui-caption);
    white-space:pre-wrap; margin:8px 0; color:var(--c-text-2); }
  .outlinecard .actions { margin-top:8px; }

  /* 通用行布局与清单（写作要点 / 素材 / 体检卡共用） */
  .row { display:flex; gap:10px; flex-wrap:wrap; }
  .row > * { flex:1 1 160px; min-width:0; }
  .actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px; }
  ul.q { margin:6px 0 0; padding-left:18px; font-size:var(--fs-ui-caption);
    color:var(--c-text-secondary); }
  ul.q li { margin:3px 0; }
  ul.q li.warn { color:var(--c-warn-text); }
  .matrow { display:flex; align-items:center; gap:8px; padding:5px 8px;
    border-radius:var(--r-btn); font-size:var(--fs-ui-caption);
    transition:background var(--t-fast) var(--ease-out); }
  .matrow:hover { background:var(--c-row-hover); }
  .matrow__name { flex:1; font-weight:600; overflow:hidden; text-overflow:ellipsis;
    white-space:nowrap; color:var(--c-text-main); }
  .matrow__key { color:var(--c-accent); font-weight:700; font-size:11px; flex:none;
    font-variant-numeric:tabular-nums; }
  .matrow__meta { color:var(--c-text-muted); font-size:11px; flex:none; }
  .matempty { color:var(--c-text-secondary); font-size:var(--fs-ui-caption); margin:6px 0 2px; }
  .matpreview { color:var(--c-text-muted); font-size:11px; }
  /* 空态卡片（未选中文档时） */
  .formcard { background:var(--c-center-bg); border:1px solid var(--c-border);
    border-radius:var(--r-card); padding:26px 22px; text-align:center;
    box-shadow:var(--sh-card-soft); color:var(--c-text-secondary); }
  .formcard h2 { margin:0; font-size:var(--fs-ui-title); font-weight:600; color:var(--c-text-main); }

  /* 质量工具条（评审 / 提问 / 计划 / 润色）与结果卡 */
  .qbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:0 0 14px; }
  .qbar .inline { display:inline-flex; }
  .score { display:inline-block; min-width:34px; text-align:center; padding:1px 8px;
    border-radius:var(--r-pill); font-size:11px; font-weight:700; border:1px solid transparent; }
  .score--good { background:var(--c-success-bg); color:var(--c-success-text);
    border-color:var(--c-success-border); }
  .score--ok { background:var(--c-warn-bg); color:var(--c-warn-text); border-color:var(--c-warn-border); }
  .score--bad { background:var(--c-danger-bg); color:var(--c-danger-text);
    border-color:var(--c-danger-border); }
  .notice { margin:0 0 12px; padding:9px 12px; border-radius:var(--r-btn);
    font-size:var(--fs-ui-caption); background:var(--c-accent-bg); color:var(--c-accent-hover);
    border:1px solid var(--c-accent-border); }
  .notice--bad { background:var(--c-danger-bg); color:var(--c-danger-text);
    border-color:var(--c-danger-border); }
  .planlist, .planq { margin:6px 0 0; padding-left:18px; font-size:var(--fs-ui-caption);
    color:var(--c-text-2); }
  .planlist li, .planq li { margin:3px 0; }
  .planlist .work__meta { margin-left:4px; }

  /* ---------- 图表：内联 SVG + 题注 + 资料来源 ---------- */
  .fig { margin:20px 0 22px; }
  .fig__canvas { border:1px solid var(--c-border); border-radius:var(--r-card-sm);
    background:var(--c-center-bg); padding:10px 8px 6px; }
  .fig figcaption { margin-top:8px; text-align:center; font-size:var(--fs-ui-caption);
    font-weight:600; color:var(--c-text-main); }
  .fig__unit { font-weight:400; color:var(--c-text-muted); }
  .fig__note { margin-top:2px; text-align:center; font-size:11px; color:var(--c-text-muted); }
  .figs--warn { margin-top:6px; font-size:var(--fs-ui-caption); color:var(--c-warn-text); }

  /* ---------- 三线表：顶线、表头线、底线，无竖线 ---------- */
  .tbl3wrap { margin:18px 0 20px; }
  .tbl3__cap { text-align:center; font-size:var(--fs-ui-caption); font-weight:600;
    color:var(--c-text-main); margin-bottom:6px; }
  .tbl3 { width:100%; border-collapse:collapse; font-size:var(--fs-ui-caption); }
  .tbl3 th, .tbl3 td { padding:5px 8px; border:none; }
  .tbl3 thead th { border-top:1.5px solid var(--c-text-main);
    border-bottom:.75px solid var(--c-text-main); font-weight:600; }
  .tbl3 tbody tr:last-child td { border-bottom:1.5px solid var(--c-text-main); }
  .tbl3 tbody tr:hover td { background:var(--c-card-light); }
  .tbl3__note { margin-top:6px; font-size:11px; color:var(--c-text-secondary); line-height:1.6; }

  /* ---------- 数据表卡 ---------- */
  .dataset { border:1px solid var(--c-border); border-radius:var(--r-card-sm);
    padding:10px 12px; margin-top:10px; background:var(--c-card-light); }
  .dataset__head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .dataset__cols { margin:6px 0 8px; line-height:2; }
  .lit__finding { color:var(--c-text-2); font-size:var(--fs-ui-caption); margin:2px 0 6px 0; }
  .topic__thesis { margin:8px 0 10px; padding:9px 12px; border-radius:var(--r-btn);
    background:var(--c-card-light-2); border:1px solid var(--c-border-3);
    font-size:var(--fs-ui-label); color:var(--c-text-main); line-height:1.7; }
  .topic__thesis .work__meta { display:block; margin-bottom:2px; }
  .topic__thesis--empty { color:var(--c-warn-text); background:var(--c-warn-bg);
    border-color:var(--c-warn-border); font-size:var(--fs-ui-caption); }
  .diag { margin-top:10px; padding:10px 12px; border-radius:var(--r-card-sm);
    border:1px solid var(--c-border); background:var(--c-center-bg); }
  .diag--empty { border-style:dashed; background:transparent; }
  .diag__head { font-size:var(--fs-ui-label); font-weight:600; margin-bottom:4px; }
  .diag__redo { margin-top:8px; }
  .diag__redo summary { font-size:var(--fs-ui-caption); color:var(--c-text-secondary); cursor:pointer; }
  .preset { margin-top:10px; border-top:1px dashed var(--c-border); padding-top:8px; }
  .preset summary { font-size:var(--fs-ui-caption); cursor:pointer; color:var(--c-text-secondary); }

  /* ---------- 公式：MathML 原生渲染，编号右对齐 ---------- */
  .eq { display:flex; align-items:center; gap:10px; margin:14px 0 16px; }
  .eq__body { flex:1; text-align:center; overflow-x:auto; overflow-y:hidden; }
  .eq__body math { font-size:1.06em; }
  .eq__no { flex:none; color:var(--c-text-secondary); font-size:var(--fs-ui-caption);
    white-space:nowrap; }
  .sec__text math { font-size:1.04em; }
  .chk-inline { display:inline-flex; align-items:center; gap:4px; font-size:11px;
    color:var(--c-text-secondary); }
  .chk-inline input { margin:0; accent-color:var(--c-accent); }
  .qlist { margin:6px 0 0; padding:0; list-style:none; }
  .qlist li { margin:6px 0; font-size:var(--fs-ui-caption); }
  .qlist .need { color:var(--c-text-muted); font-size:11px; display:block; }

  @media (max-width:1100px) {
    .tree { display:none; }
    .docbody { padding:24px 28px 48px; }
  }
  @media (max-width:820px) {
    .rail { display:none; }
    .docbody { padding:20px 16px 40px; }
    .composer { width:calc(100% - 24px); }
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

// 类型下拉：按业务分组（学术/商业/项目/行政/技术/传媒/法律/自定义）。
// 十几个类型平铺在一个 select 里没法扫读，分组后找类型不用从头看到尾。
function typeOptions(selected) {
  const types = Object.values(docEngine.DOC_TYPES);
  const groups = docEngine.TYPE_GROUPS || [];
  const option = (type) => `<option value="${type.key}"${type.key === selected ? ' selected' : ''}>${escapeHtml(type.name)}</option>`;
  // 没打 group 的类型（老数据/第三方扩展）兜到「其他」，不能因为缺字段就消失
  const known = new Set(groups);
  const bucket = new Map(groups.map((name) => [name, []]));
  for (const type of types) {
    const group = known.has(type.group) ? type.group : '其他';
    if (!bucket.has(group)) bucket.set(group, []);
    bucket.get(group).push(type);
  }
  return [...bucket.entries()]
    .filter(([, list]) => list.length)
    .map(([group, list]) => `<optgroup label="${escapeHtml(group)}">${list.map(option).join('')}</optgroup>`)
    .join('');
}

// 深度档位：决定篇幅乘数、段落计划段数、必答问题数、图表数。
// 「写深一点」不是一句形容词——档位切了，提示词里的这些量会一起变。
function depthOptions(selected = 'standard') {
  return Object.values(docEngine.DEPTH_LEVELS).map((level) =>
    `<option value="${level.key}"${level.key === selected ? ' selected' : ''}>深度：${level.name}</option>`).join('');
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
    <div class="rail__brand">文档工作台<span class="sub">学术 · 商业 · 项目 · 行政 · 技术 · 传媒 · 法律</span></div>
    <a class="rail__new" href="/docs?new=1${activeId ? `&id=${activeId}` : ''}">＋ 新建文档</a>
    <div class="rail__sect">全部文档（${projects.length}）</div>
    <div class="rail__list">${cards || '<div class="pcard__sub" style="padding:8px 10px">还没有文档——点上方「新建文档」</div>'}</div>
    <div class="rail__foot">
      <a href="/">小说工作台</a>
      <a href="/review?workbench=doc">评审团</a>
      <a href="/skills">技能广场</a>
      <a href="/status">任务状态</a>
    </div>
  </aside>`;
}

// ---------- 右栏：目录树（项目 = 各部分小节；空态 = 类型模板） ----------

function renderTree(project, currentIdx) {
  const rows = project.sections.map((section) => {
    const [text] = SECTION_STATUS[section.status] || ['未撰写'];
    // 目录按层级缩进：蒸馏出来的二级/三级小节在左栏就是缩进的，一眼能看出结构。
    const level = Math.min(3, Math.max(1, Number(section.level) || 1));
    const depthClass = level > 1 ? ` trow--l${level}` : '';
    return `<a class="trow${depthClass}${section.idx === currentIdx ? ' is-active' : ''}" href="/docs?id=${project.id}&s=${section.idx}" title="${escapeHtml(section.title)}（${text}）">
      <span class="trow__no">${section.idx}</span>
      <span class="trow__name">${escapeHtml(section.title)}</span>
      <span class="dot ${statusDot(section.status)}"></span>
    </a>`;
  }).join('');
  const levels = new Set(project.sections.map((section) => Number(section.level) || 1));
  const levelNote = levels.size > 1 ? ` · ${levels.size} 级` : '';
  return `<aside class="tree">
    <div class="tree__sect">目录（${project.sections.filter((s) => s.status === 'done').length}/${project.sections.length}${levelNote}）</div>
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
        <select name="depth" class="pill-select" title="写作深度：简洁/标准/深入——决定篇幅下限、段落数、必答问题数与图表数量">${depthOptions()}</select>
        ${picker}
        <details class="menu">
          <summary class="menu__btn" title="上传或粘贴模板（按标题切分小节）">📎 模板</summary>
          <div class="menu__panel menu__panel--wide menu__panel--up">
            <input type="file" class="js-readtext" data-target="cxTplArea" accept=".md,.txt,.markdown">
            <textarea id="cxTplArea" class="code" placeholder="# 一、执行摘要&#10;（本节要求…）&#10;&#10;留空则用类型默认结构"></textarea>
            <button type="button" class="btn btn--sm" onclick="fillDefault(this)">填入类型默认模板</button>
          </div>
        </details>
        <details class="menu">
          <summary class="menu__btn" title="样例文档 → 结构模板 + 文档技法">🧪 蒸馏</summary>
          <div class="menu__panel menu__panel--wide menu__panel--up">
            <label>模板名（留空让 AI 起）</label>
            <input type="text" id="cxDisName" placeholder="如：优秀 BP 结构 v1">
            <label>归属类型</label>
            <select id="cxDisType">${typeOptions(selectedType)}</select>
            <label>样例文档（.docx 可量出真实字体字号；或粘贴全文，至少 200 字）</label>
            <input type="file" class="js-distillfile" data-target="cxDisSample" data-hint="cxDisHint" accept=".docx,.md,.txt,.markdown">
            <div class="composer__hint" id="cxDisHint"></div>
            <textarea id="cxDisSample" placeholder="粘贴一篇写得好的样例文档全文……"></textarea>
            <button type="button" class="btn btn--primary btn--sm" data-act="distill" onclick="cxDistill()" style="margin-top:8px">开始蒸馏与拆解</button>
          </div>
        </details>
        ${modelChip(null, csrf, 1)}
        <span class="pillgroup" id="cxPill">
          <button type="button" class="pill is-on" data-mode="co" onclick="cxModeSet('co')">AI 共创</button>
          <button type="button" class="pill" data-mode="auto" onclick="cxModeSet('auto')">AI 全托管</button>
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
  const tplMd = JSON.stringify(Object.fromEntries(templates.map((t) => [t.id, docEngine.templateMarkdown(t)])));
  const tplOptions = templates.map((t) =>
    `<option value="${escapeHtml(t.id)}">📚 ${escapeHtml(t.name)}（${t.sections.length} 节 · ${escapeHtml(t.layout.bodyFont)}${t.layout.bodySize}磅）</option>`).join('');
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
      <p class="cmodal__hint" id="cmModeHint">共创：逐节和 AI 对话，追问清楚再成稿</p>
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
            <input type="file" class="js-readtext" data-target="cmTplArea" accept=".md,.txt,.markdown">
          </div>
          ${templates.length ? `<label>📚 已蒸馏模板（选用后目录、版式、写法全部沿用）</label>
          <select id="tplSaved" onchange="applyTpl(this.value)"><option value="">——选择——</option>${tplOptions}</select>
          <input type="hidden" name="templateId" id="cmTplId" value="">
          <div class="cmodal__hint" id="tplLayoutHint"></div>` : ''}
          <textarea name="template" id="cmTplArea" class="code" style="min-height:64px" placeholder="（可选）粘贴文档模板，按标题切分小节；留空则用类型默认结构"></textarea>
          <div class="cmodal__hint" id="tplRuleHint" style="display:none">🔒 已选中模板：目录顺序、层级与每节要点以模板为准，字体字号行距页边距也随模板锁定。下面的文本框只用于调整标题文字——删改小节会同步删改模板结构。</div>
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
            <div><select name="depth" title="深度决定篇幅下限、段落数、必答问题数与图表数量">${depthOptions()}</select></div>
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
  const opening = history.length ? '' : `<div class="chatmsg chatmsg--ai"><div class="chatmsg__bubble">本节任务：${escapeHtml(section.title)}。把你知道的信息告诉我（要点、数据、例子）；我会先追问细节，再产出本节正文。也可以直接说「开始写」。</div></div>`;
  const items = history.map((m) =>
    `<div class="chatmsg chatmsg--${m.role === 'assistant' ? 'ai' : 'me'}"><div class="chatmsg__bubble">${escapeHtml(m.text)}</div></div>`).join('');
  return `<div class="chatthread" id="chatThread">${opening}${items}</div>`;
}

// ---------- 工作区 ----------

const RUN_STATUS_TEXT = {
  running: '进行中', queued: '排队中', retrying: '重试中',
  quarantined: '有小节失败', paused_budget: '预算暂停', interrupted: '进程中断',
  completed: '已完成', cancelled: '已取消', abandoned: '已放弃', failed: '中断',
};

function formatStamp(ms) {
  if (!ms) return '';
  const date = new Date(Number(ms));
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 本轮报告：文档正文存在库里、没有文件系统，跑完的交代只能落在页面上
// （小说那边是写 设定/生成日志.md，这里等价物就是这张卡）。
function renderRunReport(run, project) {
  if (!run) return '';
  const counts = one(`SELECT SUM(CASE WHEN status='committed' THEN 1 ELSE 0 END) AS committed,
    SUM(CASE WHEN status='quarantined' THEN 1 ELSE 0 END) AS quarantined,
    COALESCE(SUM(attempt_count),0) AS attempts FROM chapter_runs WHERE run_id=?`, run.id) || {};
  const usage = one(`SELECT COALESCE(SUM(prompt_tokens),0) AS p, COALESCE(SUM(completion_tokens),0) AS c
    FROM generation_attempts WHERE run_id=?`, run.id) || {};
  const tokens = Number(usage.p || 0) + Number(usage.c || 0);
  const failed = q(`SELECT chapter_num, last_error FROM chapter_runs
    WHERE run_id=? AND status='quarantined' ORDER BY chapter_num LIMIT 20`, run.id);
  const statusText = RUN_STATUS_TEXT[run.status] || run.status;
  const summary = [
    `已提交 ${Number(counts.committed || 0)}/${project.sections.length} 节`,
    `尝试 ${Number(counts.attempts || 0)} 次`,
    tokens ? `${tokens.toLocaleString('zh-CN')} tokens` : '',
  ].filter(Boolean).join(' · ');
  const failedHtml = failed.length
    ? `<ul class="q">${failed.map((row) => `<li>第${row.chapter_num}节：${escapeHtml(String(row.last_error || '未知原因').slice(0, 160))}</li>`).join('')}</ul>`
    : '';
  return `<details class="outlinecard">
    <summary>📋 本轮报告 <span class="work__meta">${escapeHtml(statusText)}${run.completed_at ? ' · ' + escapeHtml(formatStamp(run.completed_at)) : ''}</span></summary>
    <div style="margin-top:6px;font-size:12px;color:var(--sub)">${escapeHtml(summary)}</div>
    ${run.last_error ? `<div style="margin-top:6px;font-size:12px;color:#a1231f">停机原因：${escapeHtml(String(run.last_error).slice(0, 200))}</div>` : ''}
    ${failedHtml}
  </details>`;
}

// 素材卡：论文的文献、BP 的财务假设、申报书的政策依据都从这里进。
// 没有它，AI 只能写「【待补文献】」——这是文档能不能「有内容」的唯一通道。
const MATERIAL_KIND_TEXT = { material: '通用素材', literature: '文献', data: '数据', policy: '政策' };

function renderMaterialsCard(project, csrf, currentIdx) {
  const materials = docEngine.listMaterials(project.id);
  const totalChars = materials.reduce((sum, item) => sum + item.chars, 0);
  const rows = materials.map((item) => {
    // 著录信息：参考文献页靠它排成「作者. 题名. 出处, 年份.」
    const meta = [item.authors, item.year, item.source].filter(Boolean).join(' · ');
    return `<div class="matrow">
      <span class="matrow__key">[${escapeHtml(item.key)}]</span>
      <span class="matrow__name" title="${escapeHtml(item.preview)}">${escapeHtml(item.title)}</span>
      <span class="matrow__meta">${escapeHtml(MATERIAL_KIND_TEXT[item.kind] || '素材')} · ${item.chars} 字${meta ? ` · ${escapeHtml(meta)}` : ' · 未填著录信息'}</span>
      <form method="post" action="/docs/material/delete" class="inline" onsubmit="return confirm('删除这条素材？已写入正文的内容不受影响')">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="projectId" value="${project.id}">
        <input type="hidden" name="s" value="${currentIdx}">
        <input type="hidden" name="materialId" value="${escapeHtml(item.id)}">
        <button class="btn btn--sm btn--danger" type="submit">删除</button>
      </form>
    </div>`;
  }).join('');
  const kindOptions = Object.entries(MATERIAL_KIND_TEXT)
    .map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  // 语料索引状态：素材条数说明不了「上下文能力」，能说明的是
  // 「这些素材被切成多少块、每节能装多少字」。作者看不到这两个数，
  // 就无法判断「写得空」到底是素材不够，还是检索没接上。
  let contextLine = '';
  if (materials.length) {
    try {
      const stats = docEngine.docContext.corpusStats(project.id);
      const budget = docEngine.docContext.budgetFor(project.docType, project.depth);
      const scale = stats.chars >= 10000 ? `${(stats.chars / 10000).toFixed(1)} 万字` : `${stats.chars} 字`;
      contextLine = `<div class="matempty" style="margin:6px 0 0">`
        + `语料已索引 ${stats.chunks} 块 / ${escapeHtml(scale)}（${stats.materials} 条素材）；`
        + `本节可用上下文约 ${budget.total.toLocaleString('zh-CN')} 字（证据 ${budget.evidence.toLocaleString('zh-CN')} + 论证记忆 ${budget.memory} + 语料地图 ${budget.map} + 邻近段落 ${budget.adjacent}）。`
        + `在「本节要求」里写「重点用 M7」可强制纳入指定素材。</div>`;
    } catch { contextLine = ''; }
  }
  return `<details class="outlinecard"${materials.length ? '' : ' open'}>
    <summary>📚 素材 <span class="work__meta">${materials.length} 条 · ${totalChars.toLocaleString('zh-CN')} 字——按节检索注入，正文用 [M1] 这类编号引用，导出自动生成参考文献</span></summary>
    ${contextLine}
    ${rows || `<div class="matempty">还没有素材。粘贴文献摘要、行业数据、政策条文或团队履历；不提供的部分，AI 会写【待补】而不是编造。</div>`}
    <form method="post" action="/docs/material/add" style="margin-top:10px">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="s" value="${currentIdx}">
      <div class="row">
        <div style="flex:0 0 130px"><label>类型</label><select name="kind">${kindOptions}</select></div>
        <div><label>标题</label><input type="text" name="title" placeholder="如：张三(2023) 制造业数字化转型研究"></div>
      </div>
      <div class="row">
        <div style="flex:0 0 170px"><label>作者</label><input type="text" name="authors" placeholder="如：张三, 李四"></div>
        <div style="flex:0 0 110px"><label>年份</label><input type="text" name="year" placeholder="如：2023"></div>
        <div><label>出处</label><input type="text" name="source" placeholder="如：工业研究 2023(4): 12-19 / 某某研究院"></div>
      </div>
      <label>内容（可上传 .md / .txt / .csv）</label>
      <input type="file" class="js-readtext" data-target="matText" accept=".md,.txt,.csv,.markdown">
      <textarea name="content" id="matText" required placeholder="粘贴文献摘要、调研数据、政策原文、团队履历……至少 20 字。"></textarea>
      <div class="actions"><button class="btn btn--primary btn--sm" type="submit">加入素材</button>
        <span class="composer__hint">填了作者/年份/出处，参考文献才能按体例排出来</span></div>
    </form>
  </details>`;
}

// 数据集卡：上传 CSV → 选变量 → 跑分析 → 结果段 + 三线表直接进本节。
// 数字全部由 lib/doc-stats 算出，模型只负责把结论写顺，改不动任何一个系数。
function renderDatasetCard(project, csrf, currentIdx) {
  const datasets = docEngine.listDatasets(project.id);
  if (!datasets.length) {
    return `<details class="outlinecard">
      <summary>📊 数据表 <span class="work__meta">上传 CSV，让「结果与分析」由数据算出来——不是由模型描述出来</span></summary>
      <div class="matempty">还没有数据表。上传一份 CSV（第一行列名，至少两列），
        系统会算描述统计、相关矩阵、OLS 回归（含稳健标准误）与分组比较，并把结果排成三线表插进本节。</div>
      ${datasetUploadForm(project, csrf, currentIdx)}
    </details>`;
  }
  const blocks = datasets.map((dataset) => {
    const numeric = dataset.columns.filter((column) => column.type === 'number');
    const categorical = dataset.columns.filter((column) => column.type === 'category');
    const columnList = dataset.columns
      .map((column) => `<span class="work__meta" title="${column.type === 'number' ? '数值列' : '分类列'}">${escapeHtml(column.name)}${column.type === 'number' ? '' : '（分类）'}</span>`)
      .join(' ');
    const numOptions = numeric.map((column) => `<option value="${escapeHtml(column.name)}">${escapeHtml(column.name)}</option>`).join('');
    const allOptions = dataset.columns.map((column) => `<option value="${escapeHtml(column.name)}">${escapeHtml(column.name)}</option>`).join('');
    const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="s" value="${currentIdx}">
      <input type="hidden" name="datasetId" value="${escapeHtml(dataset.id)}">`;
    return `<div class="dataset">
      <div class="dataset__head">
        <b>${escapeHtml(dataset.name)}</b>
        <span class="work__meta">${dataset.rows} 行 × ${dataset.cols} 列${dataset.truncated ? '（超出上限，只分析前 2 万行）' : ''}</span>
        <form method="post" action="/docs/dataset/delete" class="inline" onsubmit="return confirm('删除这个数据表？已插入正文的表格不受影响')">
          ${hidden}<button class="btn btn--sm btn--danger" type="submit">删除</button>
        </form>
      </div>
      <div class="dataset__cols">${columnList}</div>
      <form method="post" action="/docs/analysis" data-busy="计算中…">
        ${hidden}
        <div class="row">
          <div style="flex:0 0 190px"><label>分析</label>
            <select name="kind">
              <option value="describe">描述性统计</option>
              <option value="corr">相关系数矩阵</option>
              <option value="ols">OLS 回归</option>
              <option value="ttest">分组比较（t 检验）</option>
            </select>
          </div>
          <div><label>因变量 / 数值列</label><select name="y">${numOptions}</select></div>
          <div><label>自变量（回归用，可多选）</label>
            <select name="x" multiple size="3">${numOptions}</select></div>
          <div style="flex:0 0 150px"><label>分组列（t 检验用）</label>
            <select name="group"><option value="">——</option>${allOptions}</select></div>
        </div>
        <label class="chk-inline"><input type="checkbox" name="robust" value="1">稳健标准误（HC1）</label>
        <div class="actions">
          <button class="btn btn--primary btn--sm" type="submit">📈 跑分析并插入本节</button>
          <span class="composer__hint">系数、标准误、p 值由系统算出，结果段与三线表一起写进第 ${currentIdx} 节</span>
        </div>
      </form>
      ${renderDiagnosis(dataset, hidden, numOptions, allOptions)}
      ${presetForm(project, dataset, csrf, currentIdx, numOptions, allOptions)}
    </div>`;
  }).join('');
  return `<details class="outlinecard">
    <summary>📊 数据表 <span class="work__meta">${datasets.length} 份——结果由数据算出来，模型改不动系数</span></summary>
    ${blocks}
    ${datasetUploadForm(project, csrf, currentIdx)}
  </details>`;
}

// 数据体检结果：跑回归之前先看这份数据撑不撑得住。
// 放在数据集卡里，是因为「样本量不够」「两个自变量共线」这类问题必须在动笔前知道，
// 等结果算出来再说「这个系数不可信」就晚了。
function renderDiagnosis(dataset, hidden, numOptions, allOptions) {
  const diag = dataset.diagnosis;
  const form = `<form method="post" action="/docs/dataset/diagnose" data-busy="体检中…">
    ${hidden}
    <div class="row">
      <div style="flex:0 0 200px"><label>因变量</label><select name="y">${numOptions}</select></div>
      <div><label>自变量（可多选）</label><select name="x" multiple size="2">${numOptions}</select></div>
    </div>
    <div class="actions"><button class="btn btn--sm" type="submit">🩺 数据体检</button>
      <span class="composer__hint">样本量 / 缺失 / 共线（VIF）/ 异常值 / 偏斜——写之前先知道数据撑不撑得住</span></div>
  </form>`;
  if (!diag) return `<div class="diag diag--empty">${form}</div>`;
  const rows = diag.findings.map((item) =>
    `<li class="${item.level === 'warn' ? 'warn' : ''}"><b>${escapeHtml(item.title)}</b>：${escapeHtml(item.detail)}</li>`).join('');
  const warns = diag.findings.filter((item) => item.level === 'warn').length;
  return `<div class="diag">
    <div class="diag__head">🩺 数据体检 <span class="work__meta">${diag.n} 行 · ${diag.k} 个参数 · ${warns ? `<b style="color:var(--c-warn-text)">${warns} 处硬伤</b>` : '没有硬伤'}</span></div>
    <ul class="q">${rows}</ul>
    <details class="diag__redo"><summary>重新体检</summary>${form}</details>
  </div>`;
}

// 自动分析预设：把「哪一节、哪份数据、谁是因变量」存下来。
// 有了它，全托管批量起草到那一节时会自己跑回归、自己注入系数、自己补三线表，
// 不用作者守在旁边一节一节点。
function presetForm(project, dataset, csrf, currentIdx, numOptions, allOptions) {
  const preset = project.analysisPreset;
  const active = preset && preset.datasetId === dataset.id;
  const sectionOptions = project.sections
    .map((section) => `<option value="${section.idx}"${active && Number(preset.sectionIdx) === section.idx ? ' selected' : ''}>第 ${section.idx} 节　${escapeHtml(section.title)}</option>`)
    .join('');
  const kindOptions = [['ols', 'OLS 回归'], ['describe', '描述性统计'], ['corr', '相关矩阵'], ['ttest', '分组比较']]
    .map(([value, label]) => `<option value="${value}"${active && preset.kind === value ? ' selected' : ''}>${label}</option>`).join('');
  return `<details class="preset"${active ? ' open' : ''}>
    <summary>⚙️ 自动分析预设 ${active ? `<span class="work__meta">已启用：第 ${preset.sectionIdx} 节 · ${escapeHtml(preset.kind)}</span>` : '<span class="work__meta">让全托管起草到那一节时自己跑统计</span>'}</summary>
    <form method="post" action="/docs/preset">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="s" value="${currentIdx}">
      <input type="hidden" name="datasetId" value="${escapeHtml(dataset.id)}">
      <div class="row">
        <div style="flex:0 0 200px"><label>写进哪一节</label><select name="sectionIdx">${sectionOptions}</select></div>
        <div style="flex:0 0 150px"><label>分析</label><select name="kind">${kindOptions}</select></div>
        <div><label>因变量 / 数值列</label><select name="y">${numOptions}</select></div>
        <div><label>自变量（可多选）</label><select name="x" multiple size="3">${numOptions}</select></div>
      </div>
      <label class="chk-inline"><input type="checkbox" name="robust" value="1"${active && preset.robust ? ' checked' : ''}>稳健标准误（HC1）</label>
      <div class="actions">
        <button class="btn btn--sm" type="submit">保存预设</button>
        ${active ? '<button class="btn btn--sm btn--danger" type="submit" name="clear" value="1">取消预设</button>' : ''}
        <span class="composer__hint">起草到该节时自动跑分析、注入真实系数、补三线表</span>
      </div>
    </form>
  </details>`;
}

function datasetUploadForm(project, csrf, currentIdx) {
  return `<form method="post" action="/docs/dataset/add" style="margin-top:10px">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input type="hidden" name="projectId" value="${project.id}">
    <input type="hidden" name="s" value="${currentIdx}">
    <label>上传数据表（.csv / .tsv，第一行列名）</label>
    <input type="file" class="js-readtext" data-target="dsText" accept=".csv,.tsv,.txt">
    <input type="text" name="name" placeholder="数据表名称（选填）">
    <textarea name="content" id="dsText" required placeholder="year,投入,产值&#10;2020,128,42.6&#10;2021,186,43.9"></textarea>
    <div class="actions"><button class="btn btn--primary btn--sm" type="submit">加入数据表</button>
      <span class="composer__hint">数据不出本机；解析后只在本地计算</span></div>
  </form>`;
}

// 文献卡：导入 .bib / .ris / .json → 抽文献矩阵 → 综述初稿。
// 模型不可能凭记忆给真文献，所以综述的地基必须是作者自己的文献库。
function renderLiteratureCard(project, csrf, currentIdx) {
  const matrix = docEngine.getLiteratureMatrix(project.id);
  const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input type="hidden" name="projectId" value="${project.id}">
    <input type="hidden" name="s" value="${currentIdx}">`;
  const matrixBlock = matrix ? (() => {
    const rows = matrix.items.slice(0, 4).map((item) =>
      `<li>${escapeHtml(item.authors.split(',')[0])}${item.year ? `（${escapeHtml(item.year)}）` : ''}
        <span class="work__meta">${escapeHtml(item.method)}</span>
        <div class="lit__finding">${escapeHtml(item.finding)}</div></li>`).join('');
    return `<div class="work__meta" style="margin-top:10px">文献矩阵（${matrix.items.length} 条，取前 4 条预览）</div>
      <ul class="qlist">${rows}</ul>
      <div class="actions">
        <form method="post" action="/docs/lit/insert" class="inline" data-busy="插入中…">${hidden}
          <button class="btn btn--sm" type="submit">📋 把矩阵作为三线表插入本节</button></form>
        <form method="post" action="/docs/lit/draft" class="inline" data-busy="写综述中…">${hidden}
          <button class="btn btn--sm" type="submit" title="只依据矩阵归纳，不引矩阵外的文献">✍️ 生成文献综述初稿</button></form>
      </div>`;
  })() : '';
  return `<details class="outlinecard">
    <summary>📖 文献 <span class="work__meta">导入文献库 → 文献矩阵 → 综述初稿；模型不会替你编文献</span></summary>
    <form method="post" action="/docs/bib/import" style="margin-top:8px" data-busy="导入中…">
      ${hidden}
      <label>导入文献文件（BibTeX .bib / RIS .ris / Zotero 的 CSL-JSON .json）</label>
      <input type="file" class="js-readtext" data-target="bibText" accept=".bib,.bibtex,.ris,.json,.txt">
      <textarea name="text" id="bibText" required placeholder="@article{zhang2023,&#10;  author = {Zhang, San},&#10;  title = {…},&#10;  journal = {…},&#10;  year = {2023}&#10;}"></textarea>
      <div class="actions"><button class="btn btn--primary btn--sm" type="submit">导入文献</button>
        <span class="composer__hint">一条文献会变成一条素材，带作者/年份/出处/DOI</span></div>
    </form>
    <form method="post" action="/docs/lit/matrix" style="margin-top:10px" data-busy="抽取中…">
      ${hidden}
      <div class="actions"><button class="btn btn--sm" type="submit"${project.hasLiteratureMatrix ? '' : ''}>🔎 生成文献矩阵</button>
        <span class="composer__hint">从每条的摘要里抽「方法/样本/结论/局限」，摘要没写的标「未提及」</span></div>
    </form>
    ${matrixBlock}
  </details>`;
}

// 选题体检卡：把「值不值得研究」拆成可判断的几条。
// 完全机械化做不到，但可证伪性、文献重叠、数据可得性、贡献有没有说出口——
// 这几条判完，至少一半答案是明确的，剩下一半留给作者。
function renderTopicCard(project, csrf, currentIdx) {
  const result = docEngine.getTopicCheck(project.id);
  const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input type="hidden" name="projectId" value="${project.id}">
    <input type="hidden" name="s" value="${currentIdx}">`;
  const form = `<form method="post" action="/docs/topic" data-busy="体检中…">${hidden}
    <div class="actions"><button class="btn btn--sm" type="submit">🎯 选题体检</button>
      <span class="composer__hint">可证伪性 / 与文献重叠 / 数据可得 / 贡献陈述 / 竞争性解释</span></div>
  </form>`;
  const thesis = String(project.thesis || '').trim();
  const thesisLine = thesis
    ? `<div class="topic__thesis"><span class="work__meta">当前主张</span>${escapeHtml(thesis)}</div>`
    : `<div class="topic__thesis topic__thesis--empty">还没有写核心主张——没有主张就没有可检验的假设，写出来会是综述。</div>`;
  if (!result) {
    return `<details class="outlinecard">
      <summary>🎯 选题体检 <span class="work__meta">值不值得做，先看这几条</span></summary>
      ${thesisLine}${form}
    </details>`;
  }
  const warns = result.findings.filter((item) => item.level === 'warn').length;
  const rows = result.findings.map((item) =>
    `<li class="${item.level === 'warn' ? 'warn' : ''}"><b>${escapeHtml(item.title)}</b>${item.detail ? `：${escapeHtml(item.detail)}` : ''}</li>`).join('');
  return `<details class="outlinecard"${warns ? ' open' : ''}>
    <summary>🎯 选题体检 <span class="work__meta">${warns ? `${warns} 处需要注意` : '没有明显问题'}</span></summary>
    ${thesisLine}
    <ul class="q">${rows}</ul>
    ${form}
  </details>`;
}

// 方法论审查卡：规则扫描（零成本）+ 模型审查（按同一份清单）。
// 写作评审看文笔，这张卡看研究设计——两件事不能混。
function renderMethodCard(project, csrf, currentIdx) {
  const result = docEngine.getMethodologyReview(project.id);
  const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input type="hidden" name="projectId" value="${project.id}">
    <input type="hidden" name="s" value="${currentIdx}">`;
  const form = `<form method="post" action="/docs/method" data-busy="审查中…">${hidden}
    <div class="actions"><button class="btn btn--sm" type="submit">🔬 开始方法论审查</button>
      <span class="composer__hint">规则扫描 + 模型逐条判断：识别策略、样本、测量、稳健性、伦理、结论边界</span></div>
  </form>`;
  if (!result) {
    return `<details class="outlinecard">
      <summary>🔬 方法论审查 <span class="work__meta">看研究设计站不站得住，不是看文笔</span></summary>
      <div class="matempty">会检查八项：研究问题、抽样与样本量、变量测量、识别策略、稳健性、内生性、伦理、结论边界。
        其中「用了因果表述却没有识别策略」是最容易被一票否决的一条。</div>
      ${form}
    </details>`;
  }
  const scanRows = (result.scan.findings || []).map((item) =>
    `<li class="${item.level === 'warn' ? 'warn' : ''}"><b>${escapeHtml(item.title)}</b>：${escapeHtml(item.detail)}</li>`).join('');
  const reviewItems = (result.review && result.review.items ? result.review.items : []).map((item) => {
    const label = { pass: '做到', weak: '偏弱', fail: '不成立', missing: '未交代' }[item.verdict] || item.verdict;
    const tone = item.verdict === 'pass' ? 'good' : item.verdict === 'weak' ? 'ok' : 'bad';
    return `<li><span class="score ${tone === 'good' ? 'score--good' : tone === 'ok' ? 'score--ok' : 'score--bad'}">${label}</span>
      <b>${escapeHtml(item.name)}</b>：${escapeHtml(item.comment)}
      ${item.fix ? `<div class="work__meta">下一步：${escapeHtml(item.fix)}</div>` : ''}</li>`;
  }).join('');
  const fatal = result.review && result.review.fatal && result.review.fatal.length
    ? `<ul class="q">${result.review.fatal.map((item) => `<li class="warn">会被直接拒：${escapeHtml(item)}</li>`).join('')}</ul>` : '';
  return `<details class="outlinecard" open>
    <summary>🔬 方法论审查 <span class="work__meta">${escapeHtml((result.review && result.review.verdict) || '规则扫描结果')}</span></summary>
    ${fatal}
    ${reviewItems ? `<ul class="qlist">${reviewItems}</ul>` : ''}
    ${scanRows ? `<div class="work__meta" style="margin-top:10px">规则扫描（不调模型，可复现）</div><ul class="q">${scanRows}</ul>` : ''}
    ${form}
  </details>`;
}

// 文体专项卡：四类文档各自最硬的关节——BP 财务、申报书指标与预算、合同条款、调研样本。
// 共性是「结构化表格 + 必备项检查」，所以做成一张卡，按类型换内容。
function renderTypeCard(project, csrf, currentIdx, datasets) {
  const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input type="hidden" name="projectId" value="${project.id}">
    <input type="hidden" name="s" value="${currentIdx}">`;
  const check = `<form method="post" action="/docs/type/check" class="inline" data-busy="检查中…">${hidden}
    <button class="btn btn--sm" type="submit">🔍 专项检查</button></form>`;
  const fin = docEngine.getFinanceInput(project.id);
  const num = (name, label, value, placeholder = '') =>
    `<div style="flex:0 0 140px"><label>${label}</label>
      <input type="number" name="${name}" value="${value == null ? '' : value}" placeholder="${placeholder}" step="any"></div>`;

  let body = '';
  if (project.docType === 'bp') {
    const v = fin || {};
    body = `<form method="post" action="/docs/type/finance" data-busy="测算中…">${hidden}
      <div class="row">
        ${num('price', '客单价（元）', v.price)}
        ${num('customers', '首年客户数', v.customers)}
        ${num('growth', '年增长率（小数）', v.growth, '0.8')}
        ${num('retention', '留存率（小数）', v.retention, '0.8')}
      </div>
      <div class="row">
        ${num('variableRate', '变动成本率', v.variableRate, '0.35')}
        ${num('fixedCost', '年固定费用', v.fixedCost)}
        ${num('headcount', '人数', v.headcount)}
        ${num('costPerHead', '人均成本/年', v.costPerHead)}
      </div>
      <div class="row">
        ${num('taxRate', '税率', v.taxRate, '0.25')}
        ${num('capex', '资本开支', v.capex)}
        ${num('cash0', '期初现金', v.cash0)}
        ${num('marketingSpend', '营销费用', v.marketingSpend)}
      </div>
      <div class="row">
        ${num('funding', '拟融资额', v.funding)}
        ${num('preMoney', '投前估值', v.preMoney)}
        <div style="flex:0 0 110px"><label>预测年数</label>
          <select name="years">${[3, 5].map((y) => `<option value="${y}"${Number(v.years) === y ? ' selected' : ''}>${y} 年</option>`).join('')}</select></div>
      </div>
      <div class="actions">
        <button class="btn btn--primary btn--sm" type="submit">📊 测算三表并插入本节</button>
        ${check}
        <span class="composer__hint">假设存库，改一个增长率可一键重算；三表由代码算，不靠模型</span>
      </div>
    </form>`;
  } else if (project.docType === 'proposal') {
    body = `<form method="post" action="/docs/type/scheme" data-busy="生成中…">${hidden}
      <label>考核指标（每行一条：指标名 | 基线值 | 目标值 | 验收方式）</label>
      <textarea name="indicators" placeholder="改造企业数量 | 0 家 | 50 家 | 验收报告&#10;人均产值提升 | 42.6 万元 | 提升 15% | 企业报表"></textarea>
      <label>经费预算（每行一条：科目 | 金额（万元） | 测算依据）</label>
      <textarea name="budget" placeholder="设备费 | 120 | 询价 3 家，均价 40 万 × 3 台&#10;材料费 | 30 | 50 家企业 × 6000 元"></textarea>
      <div class="actions">
        <button class="btn btn--primary btn--sm" type="submit">📋 生成指标表与预算表并插入本节</button>
        ${check}
        <span class="composer__hint">占比与合计自动算；目标值不含数字会被标为「不可考核」</span>
      </div>
    </form>`;
  } else if (project.docType === 'contract') {
    const options = [['', '自动识别'], ['sale', '买卖合同'], ['service', '服务合同'], ['labor', '劳动合同'], ['lease', '租赁合同'], ['cooperation', '合作协议']]
      .map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    body = `<form method="post" action="/docs/type/clause" data-busy="生成中…">${hidden}
      <div class="row">
        <div style="flex:0 0 200px"><label>合同类型</label><select name="kind">${options}</select></div>
        <div class="actions" style="flex:1;margin:0">
          <button class="btn btn--primary btn--sm" type="submit">📑 插入必备条款对照表</button>
          ${check}
        </div>
      </div>
      <div class="composer__hint">对照表逐条标出「已具备/缺失」，缺失项给出该写什么。合同缺条款是实质风险，不是文笔问题。</div>
    </form>`;
  } else if (project.docType === 'report') {
    const options = datasets.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}（${item.rows} 行）</option>`).join('');
    const columnOptions = datasets.length
      ? datasets[0].columns.map((column) => `<option value="${escapeHtml(column.name)}">${escapeHtml(column.name)}</option>`).join('')
      : '';
    body = `<form method="post" action="/docs/type/sample" data-busy="生成中…">${hidden}
      <div class="row">
        <div style="flex:0 0 240px"><label>数据表</label>
          <select name="datasetId">${options || '<option value="">（先上传数据表）</option>'}</select></div>
        <div><label>按哪些列分组（可多选，留空则全部列）</label>
          <select name="columns" multiple size="3">${columnOptions}</select></div>
      </div>
      <div class="actions">
        <button class="btn btn--primary btn--sm" type="submit">📊 插入样本构成表</button>
        ${check}
        <span class="composer__hint">频数与占比自动算；构成明显偏斜时要在方法一节说明抽样偏差</span>
      </div>
    </form>`;
  } else {
    return '';
  }

  const result = docEngine.getTypeCheck(project.id);
  const rows = result && result.findings && result.findings.length
    ? `<ul class="q">${result.findings.map((item) =>
      `<li class="${item.level === 'warn' ? 'warn' : ''}"><b>${escapeHtml(item.title)}</b>：${escapeHtml(item.detail)}</li>`).join('')}</ul>`
    : '';
  return `<details class="outlinecard"${result ? ' open' : ''}>
    <summary>🧰 文体专项 <span class="work__meta">${escapeHtml(TYPE_HINT[project.docType] || '')}</span></summary>
    ${body}
    ${rows}
  </details>`;
}

const TYPE_HINT = {
  bp: '财务三表 + 单位经济 + 融资测算——BP 里最硬的部分',
  proposal: '考核指标表 + 经费预算表——评审最先看的两个表',
  contract: '必备条款对照 + 风险扫描——缺一条就是实质风险',
  report: '样本构成表——结论能不能信，先看样本',
};

// 模型胶囊：显示当前渠道的模型，点开可切换。
// 文档工作台与小说工作台共用同一份 settings（key='channels' / 'active_channel'），
// 所以这里切换 = 小说工作台那边也换了——不需要两边各配一次。
function modelChip(project, csrf, currentIdx) {
  let list = [];
  try { list = llm.channelList(); } catch { list = []; }
  const active = list.find((item) => item.active);
  if (!list.length) {
    return `<span class="modelchip modelchip--empty" title="还没有配置模型渠道：到「设置→渠道管理」添加，与小说工作台共用">
      <span class="modelchip__dot"></span>未配置模型</span>`;
  }
  const items = list.map((item) => `
      <button type="submit" class="modelitem${item.active ? ' is-on' : ''}" name="channelId" value="${escapeHtml(item.id)}">
        <span class="modelitem__name">${escapeHtml(item.model || item.label)}</span>
        <span class="modelitem__meta">${escapeHtml(item.label)}${item.hasKey ? '' : ' · 未配置 Key'}</span>
      </button>`).join('');
  const label = active ? (active.model || active.label) : (list[0].model || list[0].label);
  return `<details class="menu menu--left modelchip__menu">
    <summary class="modelchip" title="当前模型：${escapeHtml(label)}（与小说工作台共用同一套渠道）">
      <span class="modelchip__dot"></span>${escapeHtml(label)}
    </summary>
    <div class="menu__panel modelchip__panel">
      <div class="menu__group">切换模型</div>
      <form method="post" action="/docs/model">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="projectId" value="${escapeHtml(project && project.id ? project.id : '')}">
        <input type="hidden" name="s" value="${currentIdx || 1}">
        ${items}
      </form>
      <hr>
      <div class="modelchip__note">与小说工作台共用同一套渠道配置</div>
    </div>
  </details>`;
}

// 论文要素卡：投稿首页那一整套——作者、单位、关键词、分类号、基金、参考文献体例。
// 缺这些不是「写得不好」，是投稿系统直接退。
function renderMetaCard(project, csrf, currentIdx) {
  const meta = project.meta || {};
  const styleOptions = Object.entries(docQuality.REF_STYLES)
    .map(([value, item]) => `<option value="${value}"${project.refStyle === value ? ' selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
  return `<details class="outlinecard">
    <summary>📄 论文要素 <span class="work__meta">作者 / 单位 / 关键词 / 分类号 / 基金——投稿首页必须有</span></summary>
    <form method="post" action="/docs/meta" style="margin-top:8px">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="s" value="${currentIdx}">
      <div class="row">
        <div><label>作者</label><input type="text" name="authors" value="${escapeHtml(meta.authors || '')}" placeholder="如：张三, 李四"></div>
        <div><label>单位</label><input type="text" name="affiliation" value="${escapeHtml(meta.affiliation || '')}" placeholder="如：某某大学管理学院"></div>
      </div>
      <label>关键词（3~5 个，用分号或顿号隔开）</label>
      <input type="text" name="keywords" value="${escapeHtml(meta.keywords || '')}" placeholder="如：数字化改造；投入产出；中小制造企业">
      <div class="row">
        <div style="flex:0 0 170px"><label>中图分类号</label><input type="text" name="ccode" value="${escapeHtml(meta.ccode || '')}" placeholder="如：F272"></div>
        <div><label>基金项目</label><input type="text" name="fund" value="${escapeHtml(meta.fund || '')}" placeholder="如：国家自然科学基金 XXXXXXXX"></div>
      </div>
      <label>参考文献著录体例</label>
      <select name="refStyle">${styleOptions}</select>
      <div class="actions"><button class="btn btn--primary btn--sm" type="submit">保存要素</button></div>
    </form>
  </details>`;
}

// 全文体检卡：逐节门禁看不见的问题（跨节重复、篇幅塌陷、通篇待补、论据没用上）都在这里。
function renderAuditCard(audit) {
  if (!audit) return '';
  const { issues = [], summary = {} } = audit;
  if (!summary.done) return '';
  const head = [
    `${summary.done}/${summary.sections} 节`,
    `${Number(summary.chars || 0).toLocaleString('zh-CN')} 字`,
    summary.todo ? `${summary.todo} 处待补` : '',
    summary.duplicates ? `${summary.duplicates} 处重复` : '',
    summary.citations ? `引用 ${summary.citations} 条` : '',
    summary.ghosts ? `${summary.ghosts} 处假引用` : '',
    summary.figures ? `图 ${summary.figures} 张` : '',
    summary.math ? `公式 ${summary.math} 处${summary.equations ? `（含 ${summary.equations} 个编号公式）` : ''}` : '',
    summary.avgScore ? `均分 ${summary.avgScore}` : '',
    summary.qualityScore != null ? `质量基准 ${summary.qualityScore} 分` : '',
    summary.qualityTotal ? `（${summary.qualityPassed}/${summary.qualityTotal} 节达标）` : '',
  ].filter(Boolean).join(' · ');
  const items = issues.length
    ? `<ul class="q">${issues.map((issue) => `<li class="${issue.level === 'warn' ? 'warn' : ''}">${escapeHtml(issue.text)}</li>`).join('')}</ul>`
    : '<ul class="q"><li>没有发现跨节问题</li></ul>';
  return `<details class="outlinecard">
    <summary>📐 全文体检 <span class="work__meta">${escapeHtml(head)}</span></summary>
    ${items}
  </details>`;
}

// 版式卡：蒸馏出的排版规格在这里可见、可微调。
// 之前版式只存在数据库里、只在导出的 Word 里体现——作者看不到「蒸馏出了什么字体」，
// 也就没法判断蒸馏到底有没有成功。这里把规格摊开成一张表，并能当场改。
// 模板卡：把「按哪套模板写」这件事摊开给人看。
//
// 之前只有版式卡显示字体字号，模板的目录来源与写法要点完全不可见——
// 作者不知道自己的稿子是在套哪套结构，也就没法判断哪里该由 AI 写、哪里该自己补。
// 这里把三件事一起显示：模板名、目录（带层级）、蒸馏出的写法要点。
function renderTemplateCard(project, csrf, currentIdx) {
  if (!project.templateBound) return '';
  const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="s" value="${currentIdx}">`;
  const levels = new Set(project.sections.map((section) => Number(section.level) || 1));
  const outline = project.sections.map((section) => {
    const level = Math.min(3, Math.max(1, Number(section.level) || 1));
    const indent = (level - 1) * 14;
    return `<div style="padding-left:${indent}px;font-size:${13 - (level - 1)}px;line-height:1.9">`
      + `<span style="color:var(--sub)">${level === 1 ? '■' : level === 2 ? '·' : '·'}</span> `
      + `${escapeHtml(section.title)}</div>`;
  }).join('');
  const notes = String(project.templateNotes || '').trim();
  const lockNote = project.layoutLocked
    ? '章节目录、字体、字号、行距、页边距全部锁定；导出 Word 时正文前自动生成目录域，与本目录完全一致。'
    : '章节目录已锁定（按模板写）；版式来自你粘贴的模板文本，纯文本里没有字体信息，版式仍可自行调整。';
  return `<details class="outlinecard" open>
    <summary>📚 模板 <span class="work__meta">《${escapeHtml(project.templateName || '模板')}》· ${project.sections.length} 节${levels.size > 1 ? ` · ${levels.size} 级` : ''}</span></summary>
    <div class="composer__hint">${escapeHtml(lockNote)}</div>
    <div class="layoutspec" style="margin-top:8px">${outline}</div>
    ${notes ? `<div class="composer__hint" style="margin-top:8px"><b>写法要求（已注入每次生成）</b><br>${escapeHtml(notes.slice(0, 600))}</div>` : ''}
    <div class="actions">
      ${project.layoutLocked ? `<form method="post" action="/docs/template/reapply-outline" class="inline" data-busy="同步中…"
        onsubmit="return confirm('将按模板当前的目录重建小节：标题与层级会被覆盖，多余的小节会删除（正文随节一起删）。继续？')">${hidden}
        <button class="btn btn--sm" type="submit" title="模板被重新蒸馏过时，用它把目录与层级再对齐一次">↻ 重新套用模板目录</button></form>` : ''}
    </div>
  </details>`;
}

function renderLayoutCard(project, csrf, currentIdx) {
  const summary = docLayout.layoutSummary(project.layout);
  const spec = summary.spec;
  const row = (key, value) => `<div class="layoutspec__row"><span class="layoutspec__k">${key}</span><span class="layoutspec__v">${escapeHtml(value)}</span></div>`;
  const num = (name, value, extra = '') => `<input name="${name}" type="number" step="0.5" value="${escapeHtml(String(value))}"${extra}>`;
  const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="s" value="${currentIdx}">`;
  // 模板绑定 → 版式只读。这不是「少给一个功能」：说好严格沿用模板的排版与字体，
  // 却留着输入框随时能改，那这句话就不成立。要改就显式解除绑定。
  if (project.layoutLocked) {
    return `<details class="outlinecard">
    <summary>🎨 版式 <span class="work__meta">🔒 随模板《${escapeHtml(project.templateName || '模板')}》锁定</span></summary>
    <div class="layoutspec">
      ${row('正文', `${spec.bodyFont} ${spec.bodySize} 磅（西文 ${spec.bodyFontEn}）· 行距 ${spec.lineSpacing} 倍 · 首行缩进 ${spec.firstLineIndent} 字符`)}
      ${row('标题', `${spec.headingFont} ${spec.headingSizes[1]} / ${spec.headingSizes[2]} / ${spec.headingSizes[3]} 磅 · ${summary.numberingText}`)}
      ${row('题名', `${spec.titleFont} ${spec.titleSize} 磅`)}
      ${row('页面', summary.pageLine)}
    </div>
    <div class="composer__hint">这份文档按模板撰写：章节目录、字体、字号、行距、页边距都取自模板，导出 Word 与页面上看到的完全一致。</div>
    <div class="actions">
      <form method="post" action="/docs/layout/reapply" class="inline" data-busy="重新套用中…">${hidden}
        <button class="btn btn--sm" type="submit" title="模板被重新蒸馏过时，用它把版式再对齐一次">↻ 重新套用模板版式</button></form>
      <form method="post" action="/docs/unbind-template" class="inline" data-busy="解除中…"
        onsubmit="return confirm('解除绑定后，版式可以自由修改，但正文标题不再受模板约束。目录结构会保留。继续？')">${hidden}
        <button class="btn btn--sm" type="submit">解除模板绑定</button></form>
    </div>
  </details>`;
  }
  return `<details class="outlinecard">
    <summary>🎨 版式 <span class="work__meta">${escapeHtml(summary.bodyLine)}${project.templateBound ? ` · 目录随模板《${escapeHtml(project.templateName || '模板')}》锁定` : ''}</span></summary>
    <div class="layoutspec">
      ${row('正文', `${spec.bodyFont} ${spec.bodySize} 磅（西文 ${spec.bodyFontEn}）· 行距 ${spec.lineSpacing} 倍 · 首行缩进 ${spec.firstLineIndent} 字符`)}
      ${row('标题', `${spec.headingFont} ${spec.headingSizes[1]} / ${spec.headingSizes[2]} / ${spec.headingSizes[3]} 磅 · ${summary.numberingText}`)}
      ${row('题名', `${spec.titleFont} ${spec.titleSize} 磅`)}
      ${row('页面', summary.pageLine)}
    </div>
    <form method="post" action="/docs/layout">
      ${hidden}
      <div class="layoutgrid">
        <div><label>正文字体</label><input name="bodyFont" value="${escapeHtml(spec.bodyFont)}"></div>
        <div><label>正文字号（磅）</label>${num('bodySize', spec.bodySize, ' min="6" max="42"')}</div>
        <div><label>行距（倍）</label>${num('lineSpacing', spec.lineSpacing, ' min="0.6" max="3" step="0.05"')}</div>
        <div><label>首行缩进（字符）</label>${num('firstLineIndent', spec.firstLineIndent, ' min="0" max="8"')}</div>
        <div><label>标题字体</label><input name="headingFont" value="${escapeHtml(spec.headingFont)}"></div>
        <div><label>编号规则</label><select name="numbering">
          <option value="chinese"${spec.numbering === 'chinese' ? ' selected' : ''}>一、（一）1.</option>
          <option value="arabic"${spec.numbering === 'arabic' ? ' selected' : ''}>1 / 1.1 / 1.1.1</option>
          <option value="none"${spec.numbering === 'none' ? ' selected' : ''}>不编号</option>
        </select></div>
        <div><label>一级标题（磅）</label>${num('heading1', spec.headingSizes[1], ' min="6" max="42"')}</div>
        <div><label>二级标题（磅）</label>${num('heading2', spec.headingSizes[2], ' min="6" max="42"')}</div>
        <div><label>三级标题（磅）</label>${num('heading3', spec.headingSizes[3], ' min="6" max="42"')}</div>
        <div><label>纸张</label><select name="pageSize">
          ${['A4', 'Letter', 'B5'].map((size) => `<option value="${size}"${spec.pageSize === size ? ' selected' : ''}>${size}</option>`).join('')}
        </select></div>
        <div><label>上边距（cm）</label>${num('marginTop', spec.marginTop, ' min="1" max="6"')}</div>
        <div><label>下边距（cm）</label>${num('marginBottom', spec.marginBottom, ' min="1" max="6"')}</div>
        <div><label>左边距（cm）</label>${num('marginLeft', spec.marginLeft, ' min="1" max="6"')}</div>
        <div><label>右边距（cm）</label>${num('marginRight', spec.marginRight, ' min="1" max="6"')}</div>
      </div>
      <div class="actions">
        <button class="btn btn--primary btn--sm" type="submit">保存版式</button>
        <span class="composer__hint">改完立即作用于下一次生成与 Word 导出（已写好的正文不会重排）</span>
      </div>
    </form>
  </details>`;
}

function scoreClass(total) {  if (total >= 80) return 'score--good';
  if (total >= 70) return 'score--ok';
  return 'score--bad';
}

// 评审卡：分项分数 + 问题 + 必须修正项。分数不是目的，mustFix 才是能改的东西。
const REVIEW_LABELS = {
  argument: '论证', evidence: '证据', structure: '结构',
  terminology: '术语', substance: '空话', citation: '引用',
};

// 质量基准卡：客观检测这一节的论证层数、依据密度、空话与论点兑现。
// 与「本节评审」并列：评审分是模型的主观判断，基准分是系统可查的事实。
// 两者都摆出来，作者才能判断「低分是这稿真不行，还是评审给得严」。
function renderQualityCard(section) {
  const quality = section.review && section.review.quality;
  if (!quality || !quality.metrics) return '';
  const m = quality.metrics;
  const gaps = Array.isArray(quality.gaps) && quality.gaps.length
    ? `<ul class="q">${quality.gaps.map((gap) => `<li class="${gap.level === 'warn' ? 'warn' : ''}">${escapeHtml(gap.text)}</li>`).join('')}</ul>`
    : '<ul class="q"><li>各项基准均已达标</li></ul>';
  const bar = [
    `论证层 ${m.layerCount}/${m.layerNeed}`,
    `每千字依据 ${m.evidenceDensity}`,
    `引用 ${m.citations} 处`,
    m.filler ? `空话 ${m.filler} 处` : '',
    m.claimTotal ? `论点兑现 ${m.claimCovered}/${m.claimTotal}` : '',
    m.figureTotal ? `图表呼应 ${m.figureMention}/${m.figureTotal}` : '',
  ].filter(Boolean).join(' · ');
  return `<details class="outlinecard"${quality.score < 60 ? ' open' : ''}>
    <summary>📐 质量基准 <span class="score ${scoreClass(quality.score)}">${quality.score}</span>
      <span class="work__meta">${bar}</span></summary>
    ${gaps}
  </details>`;
}

// 上下文卡：这一节写作时到底读了什么。
//
// 上一版只有素材卡上的「语料已索引多少块」——那是全局状态，不是本节事实。
// 作者真正想知道的是：「这一节用了哪几条素材、注入了多少字、有没有吃满预算」。
// 没有这张卡，百万字语料和两千字检索在界面上长得一模一样。
function renderContextCard(section) {
  const ctx = section.context;
  if (!ctx) return '';
  if (ctx.legacy) {
    return `<details class="outlinecard">
      <summary>🧠 本节上下文 <span class="work__meta">旧检索通道 · 约 ${Number(ctx.contextChars || 0).toLocaleString('zh-CN')} 字</span></summary>
      <ul class="q"><li>这一节用的是窄口径检索（2000 字上限）。重新起草后会走语料索引通道。</li></ul>
    </details>`;
  }
  const corpus = Number(ctx.corpusChars || 0);
  const scale = corpus >= 10000 ? `${(corpus / 10000).toFixed(1)} 万字` : `${corpus} 字`;
  const budget = ctx.budget || {};
  const used = Number(ctx.contextChars || 0);
  const pct = budget.evidence ? Math.min(100, Math.round((Number(ctx.evidenceChars || 0) / budget.evidence) * 100)) : 0;
  const keys = Array.isArray(ctx.keys) ? ctx.keys : [];
  const head = [
    `语料 ${scale} / ${Number(ctx.materials || 0)} 条`,
    `注入 ${used.toLocaleString('zh-CN')} 字`,
    `证据 ${Number(ctx.items || 0)} 段${keys.length ? `（${keys.slice(0, 8).join('、')}${keys.length > 8 ? ' 等' : ''}）` : ''}`,
    budget.evidence ? `预算用掉 ${pct}%` : '',
    Number(ctx.forced || 0) ? `作者指定 ${ctx.forced} 条` : '',
    Number(ctx.deduped || 0) ? `去重 ${ctx.deduped} 段` : '',
  ].filter(Boolean).join(' · ');
  const notes = [];
  if (pct < 40 && corpus > 20000) {
    notes.push(`证据只用了预算的 ${pct}%：语料里与本节直接相关的内容不多，或者大量内容高度重复被去重了。`
      + '想要更多依据，可以补素材，或在「本节要求」里写「重点用 M7」指定必读条目。');
  }
  if (Number(ctx.deduped || 0) > 0) {
    notes.push(`有 ${ctx.deduped} 段因与其他素材高度重复未注入——同一内容多份收录时，引用一处即可。`);
  }
  const list = notes.length
    ? `<ul class="q">${notes.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>` : '';
  return `<details class="outlinecard"${pct < 40 && corpus > 20000 ? ' open' : ''}>
    <summary>🧠 本节上下文 <span class="work__meta">${escapeHtml(head)}</span></summary>
    ${list}
  </details>`;
}

// 评审团入口：把「这一节可以交给多厂商评审团」做成一个可点的入口。
//
// 评审机制本身在 /review（跨工作台共用），文档工作台这边只负责两件事：
// 告诉作者当前开没开、有没有配好的评审团；给一个带着本节上下文的直达链接。
// 不做成「点一下就改稿」——评审意见要不要采纳是作者的决定，不是按钮的默认值。
// 生成按钮旁的「送评审团」选择。
//
// 与左边的「六维打分」是两件事：六维打分是每节写完自评一次（单模型），
// 评审团是多厂商独立评审。两者都叫「评审」会让人以为只能选一个，所以这里标清名字。
// 只有机制已开启、且配了对应评审团时才显示——没开启时显示一个勾选框，
// 勾了也不会发生什么，那是骗人的。
function panelReviewChoice(project) {
  try {
    const reviewEngine = require('./review-engine');
    if (!reviewEngine.isEnabled('doc', project.docType)) return '';
    const panel = reviewEngine.defaultPanel('doc', project.docType);
    if (!panel) return '';
    return `<label class="chk-inline" title="生成完把新写的小节送给「${escapeHtml(panel.name)}」（${panel.reviewers.length} 位评审员）各评一轮。取消勾选只跳过本次，不改总开关。">
      <input type="checkbox" name="panelReview" value="1" checked>送评审团</label>`;
  } catch { return ''; }
}

function renderReviewPanelCard(project, currentIdx) {
  let reviewEngine = null;
  try { reviewEngine = require('./review-engine'); } catch { return ''; }
  const enabled = reviewEngine.isEnabled('doc', project.docType);
  const panels = reviewEngine.listPanels('doc');
  const matched = panels.find((panel) => panel.docType && panel.docType === project.docType)
    || panels.find((panel) => !panel.docType) || null;
  const rounds = reviewEngine.listRounds({ workbench: 'doc', workId: project.id, sectionIdx: currentIdx, limit: 3 });
  const href = `/review?workbench=doc&workId=${encodeURIComponent(project.id)}&sectionIdx=${currentIdx}`;
  const state = enabled
    ? (matched ? `<span class="pill pill--ok">已开启</span> 评审团「${escapeHtml(matched.name)}」· ${matched.reviewers.length} 位` : '<span class="pill">已开启</span> 还没有评审团')
    : '<span class="pill">未开启</span>';
  const history = rounds.length
    ? `<div class="work__meta" style="margin-top:6px">最近：${rounds.map((item) =>
      `<a href="/review?round=${encodeURIComponent(item.id)}">第 ${item.roundNo} 轮${item.score != null ? ` ${item.score} 分` : ''}</a>`).join(' · ')}</div>`
    : '';
  return `<details class="outlinecard">
    <summary>🧑‍⚖️ 评审团 <span class="work__meta">${state}</span></summary>
    <div class="work__meta" style="margin:6px 0 10px">多厂商评审团独立出具意见 → 交叉验证（共识合并、分歧仲裁）→ 采纳意见逐条落到正文。每位评审员一次调用、各自一份提示词，互不可见。</div>
    ${history}
    <div style="margin-top:8px"><a class="btn btn--sm" href="${href}">打开评审团（本节）</a></div>
  </details>`;
}

function renderReviewCard(section) {
  const review = section.review;
  if (!review || !Number.isFinite(Number(review.total))) return '';
  const total = Number(review.total);
  const dims = Object.entries(REVIEW_LABELS)
    .map(([key, label]) => {
      const value = Number((review.scores || {})[key] || 0);
      return `<span class="work__meta">${label} ${value}</span>`;
    }).join('　');
  const issues = Array.isArray(review.issues) && review.issues.length
    ? `<ul class="q">${review.issues.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '';
  const fixes = Array.isArray(review.mustFix) && review.mustFix.length
    ? `<ul class="q">${review.mustFix.map((item) => `<li class="warn">必修：${escapeHtml(item)}</li>`).join('')}</ul>` : '';
  // 未兑现的论点：与「问题被绕开」分开显示，前者是「该证明的没证明」，后者是「该回答的没回答」。
  const unsupported = Array.isArray(review.unsupported) && review.unsupported.length
    ? `<ul class="q">${review.unsupported.map((item) => `<li class="warn">论点未兑现：${escapeHtml(item)}</li>`).join('')}</ul>` : '';
  return `<details class="outlinecard"${total < 70 ? ' open' : ''}>
    <summary>🧐 本节评审 <span class="score ${scoreClass(total)}">${total}</span>
      <span class="work__meta">${dims}${review.afterFix ? ' · 已按意见修订一次' : ''}</span></summary>
    ${fixes}${unsupported}${issues}
  </details>`;
}

// 段落计划卡：AI 起草前先定「每段写什么、多少字、用哪条素材」，作者可以否决。
// 子问题与图表也在这一张卡里——它们是「深度」和「图文并茂」的具体落点，作者能看见才好判断。
function renderPlanCard(section) {
  const plan = section.plan;
  if (!plan || !Array.isArray(plan.paragraphs) || !plan.paragraphs.length) return '';
  const items = plan.paragraphs.map((item) => {
    const uses = item.materials && item.materials.length ? `<span class="work__meta">用 ${item.materials.join('、')}</span>` : '';
    // 论点与依据分开显示：只显示「这一段写什么」看不出「这一段要证明什么」，
    // 而后者才是深度所在。有 claim 就把它摆在目标前面。
    const claim = String(item.claim || '').trim();
    const evidence = String(item.evidence || '').trim();
    return `<li>${claim ? `<b>${escapeHtml(claim)}</b><span class="work__meta">${escapeHtml(item.goal)}</span>` : escapeHtml(item.goal)}`
      + `<span class="work__meta">约 ${item.chars} 字</span>${uses}`
      + (evidence ? `<div class="work__meta">依据：${escapeHtml(evidence)}</div>` : '')
      + '</li>';
  }).join('');
  const questions = Array.isArray(plan.questions) && plan.questions.length
    ? `<div class="work__meta" style="margin-top:10px">本节必须正面回答的问题</div>
       <ol class="planq">${plan.questions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>`
    : '';
  const figures = Array.isArray(section.figures) && section.figures.length
    ? `<div class="work__meta" style="margin-top:10px">本节配图 ${section.figures.length} 张</div>
       <ol class="planq">${section.figures.map((spec) =>
    `<li>${escapeHtml(spec.title)}<span class="work__meta">${escapeHtml(spec.type)} · ${spec.categories.length} 项${spec.unit ? ` · ${escapeHtml(spec.unit)}` : ''}${spec.note ? ` · 源：${escapeHtml(spec.note)}` : ''}</span></li>`).join('')}</ol>`
    : '';
  return `<details class="outlinecard">
    <summary>📋 段落计划 <span class="work__meta">${plan.paragraphs.length} 段 · 约 ${plan.targetChars} 字${plan.depth ? ` · 深度 ${escapeHtml(docEngine.depthName(plan.depth))}` : ''}——起草按这个骨架走</span></summary>
    <ol class="planlist">${items}</ol>
    ${questions}${figures}
  </details>`;
}

// 视角问题卡（STORM）：素材答不出的问题 + 需要补什么材料，可一键让 AI 先研究一轮并存成素材。
function renderQuestionsCard(project, section, csrf) {
  const stored = (project.questions || {})[String(section.idx)];
  if (!stored || !Array.isArray(stored.perspectives) || !stored.perspectives.length) return '';
  const blocks = stored.perspectives.map((item) => {
    const list = item.questions.map((entry) => `<li>${escapeHtml(entry.q)}${entry.need ? `<span class="need">需要补：${escapeHtml(entry.need)}</span>` : ''}</li>`).join('');
    return `<div style="margin-top:8px"><b style="font-size:12.5px">${escapeHtml(item.name)}</b><ul class="qlist">${list}</ul></div>`;
  }).join('');
  return `<details class="outlinecard">
    <summary>🔎 AI 想先确认的问题 <span class="work__meta">${stored.perspectives.length} 个视角——把答案补进素材，正文才不是空话</span></summary>
    ${blocks}
    <form method="post" action="/docs/research" class="actions" data-busy="研究一轮…">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="s" value="${section.idx}">
      <button class="btn btn--sm" type="submit" title="让 AI 以专家身份先答一遍这些问题，答不出的标【待核实】，结果存成一条素材">🔬 让 AI 先研究一轮</button>
      <span class="composer__hint">产出会存成素材，起草时自动引用</span>
    </form>
  </details>`;
}

// 润色进度：后台任务，不阻塞请求，也不自动刷新页面（避免冲掉正在编辑的输入）。
function renderPolishBanner(project) {
  const state = docEngine.polishStatus(project.id);
  if (state.running) {
    return `<div class="notice">✨ 全文润色中 ${state.done}/${state.total} 节……跑完刷新页面看结果（不会自动刷新，免得冲掉你正在写的内容）</div>`;
  }
  if (state.finishedAt && Date.now() - state.finishedAt < 10 * 60 * 1000) {
    if (state.error) return `<div class="notice notice--bad">✨ 上次润色中断：${escapeHtml(state.error)}</div>`;
    return `<div class="notice">✨ 上次润色完成：改了 ${state.changed.length} 节（${state.changed.map((idx) => `第${idx}节`).join('、') || '无改动'}）</div>`;
  }
  return '';
}

// 图表在页面上是内联 SVG：矢量、可缩放、不依赖图片服务，也不产生临时文件。
// 编号是全文连号（第 2 节的第一张图叫「图 3」），所以要先按整个项目铺一遍再切。
// 图号与表号各自独立连号，所以先铺图、再在铺好的正文上铺表。
function sectionLayout(project) {
  const withFigures = figure.globalizeFigures(project.sections.map((item) => ({
    content: item.content, figures: item.figures,
  })));
  const withTables = docTable.globalizeTables(project.sections.map((item, index) => ({
    content: withFigures[index].content, tables: item.tables,
  })));
  return withTables.map((item, index) => ({
    content: item.content,
    tables: item.tables,
    figures: withFigures[index].figures,
  }));
}

function renderFigure(spec) {
  return `<figure class="fig">
    <div class="fig__canvas">${figure.figureSvg(spec, { showTitle: false })}</div>
    <figcaption>图 ${spec.no}　${escapeHtml(spec.title)}${spec.unit ? `<span class="fig__unit">（单位：${escapeHtml(spec.unit)}）</span>` : ''}</figcaption>
    ${spec.note ? `<div class="fig__note">资料来源：${escapeHtml(spec.note)}</div>` : ''}
  </figure>`;
}

// 正文 + 图表 + 三线表交替渲染。占位符对不上数据时原样显示，作者能一眼看出哪张图缺数据。
// 公式同理：先换成占位符再交给 markdown（否则公式里的 _ 和 * 会被当成斜体/加粗），
// 渲染完再换回 MathML；块级公式的编号是全文连号的。
function renderSectionBody(project, section) {
  if (!String(section.content || '').trim()) return '';
  const startNo = 1 + project.sections
    .filter((item) => item.idx < section.idx)
    .reduce((sum, item) => sum + docMath.countDisplay(item.content), 0);
  // 正文里的 [M1] 是内部工单号，页面上要显示成论文序号 [1]
  const citationMap = docEngine.bibliography(project.id).map;
  const layout = sectionLayout(project);
  const index = project.sections.findIndex((item) => item.idx === section.idx);
  const mine = layout[index >= 0 ? index : 0];
  if (!mine) return '';
  let nextNo = startNo;
  const renderText = (text) => {
    // 模板绑定的文档：正文里的 # 标题降为加粗行，页面上看到的层次与导出保持一致，
    // 也不会在左栏目录里凭空多出一节。
    const normalized = project.templateBound ? docQuality.normalizeTemplateBody(text) : text;
    const protectedText = docMath.protectMath(normalized, nextNo);
    nextNo = protectedText.nextNo;
    const html = mdMini.render(protectedText.text);
    return docMath.restoreMathHtml(docQuality.remapCitations(html, citationMap), protectedText.items);
  };
  const parts = [];
  for (const block of docTable.splitTableBlocks(mine.content, mine.tables)) {
    if (block.type === 'table') { parts.push(docTable.tableBlockHtml(block.spec)); continue; }
    for (const piece of figure.splitFigureBlocks(block.text, mine.figures)) {
      parts.push(piece.type === 'figure' ? renderFigure(piece.spec) : renderText(piece.text));
    }
  }
  return parts.join('');
}

function renderWorkArea(project, currentIdx, { csrf, edit = false, allSkills = [] }) {
  const run = one(`SELECT * FROM generation_runs WHERE book_id=? AND mode='doc' ORDER BY updated_at DESC LIMIT 1`, project.id);
  const runLive = !!run && ['running', 'queued', 'retrying'].includes(run.status);
  const runResumable = !!run && statusPage.RESUMABLE.has(run.status);
  const usage = run ? one(`SELECT COALESCE(SUM(prompt_tokens),0) p, COALESCE(SUM(completion_tokens),0) c FROM generation_attempts WHERE run_id=?`, run.id) : null;
  const tokens = usage ? Number(usage.p || 0) + Number(usage.c || 0) : 0;
  const done = project.sections.filter((s) => s.status === 'done').length;
  const isCo = project.mode === 'co';

  const section = project.sections[currentIdx - 1];
  const prev = project.sections[currentIdx - 2];
  const next = project.sections[currentIdx];

  // 模式随时可切：共创 = 逐节对话，全托管 = 整篇批量。切换只影响后续动作，已有正文不动。
  const modePill = `<form method="post" action="/docs/mode" class="inline" title="切换写作方式：共创逐节对话，全托管整篇批量">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input type="hidden" name="projectId" value="${project.id}">
    <input type="hidden" name="s" value="${currentIdx}">
    <span class="pillgroup">
      <button type="submit" class="pill${isCo ? ' is-on' : ''}" name="mode" value="co">AI 共创</button>
      <button type="submit" class="pill${isCo ? '' : ' is-on'}" name="mode" value="auto">AI 全托管</button>
    </span>
  </form>`;

  // 深度档位：切换后篇幅下限按基数重算，旧段落计划作废（下次起草按新档位重出骨架）。
  const depthPill = `<form method="post" action="/docs/depth" class="inline" title="写作深度：简洁=只留结论与关键依据；标准=论证完整；深入=给机制、对比与边界条件，篇幅下限 ×1.4，每节 3~4 个必答问题、最多 2 张图">
    <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
    <input type="hidden" name="projectId" value="${project.id}">
    <input type="hidden" name="s" value="${currentIdx}">
    <span class="pillgroup">
      ${Object.values(docEngine.DEPTH_LEVELS).map((level) =>
    `<button type="submit" class="pill${project.depth === level.key ? ' is-on' : ''}" name="depth" value="${level.key}">${level.name}</button>`).join('')}
    </span>
  </form>`;

  // 共创模式不做整篇批量（那是全托管的语义），改为「续写下一节」单步推进。
  const primaryAction = isCo
    ? `<form method="post" action="/docs/continue" class="inline" data-busy="续写中…">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="projectId" value="${project.id}">
        <input type="hidden" name="s" value="${currentIdx}">
        <button class="btn btn--primary btn--sm" type="submit"${runLive ? ' disabled' : ''} title="从第一个未完成的小节起草一节">✦ AI 续写下一节</button>
      </form>`
    : `<form method="post" action="/docs/generate" class="inline" data-busy="生成中…">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="projectId" value="${project.id}">
        <input type="hidden" name="s" value="${currentIdx}">
        <label class="chk-inline" title="每节写完后按六个维度打分，低于 70 分自动修订一次（每节多一到两次调用）"><input type="checkbox" name="review" value="1" checked>六维打分</label>
        ${panelReviewChoice(project)}
        <button class="btn btn--primary btn--sm" type="submit"${runLive ? ' disabled' : ''}>${runLive ? '生成中…' : '⚙ 整篇生成'}</button>
      </form>`;

  const head = `<div class="work__head">
    <span class="work__title">${escapeHtml(project.title)}</span>
    <span class="work__meta">${escapeHtml(project.typeName)} · 深度${escapeHtml(project.depthName || '标准')} · ${done}/${project.sections.length} 节${tokens ? ' · ' + tokens.toLocaleString('zh-CN') + ' tokens' : ''}${run ? ' · ' + escapeHtml(RUN_STATUS_TEXT[run.status] || run.status) : ''}</span>
    <span class="work__acts">
      ${modePill}
      ${depthPill}
      ${primaryAction}
      ${runResumable ? `<form method="post" action="/docs/resume" class="inline" data-busy="续跑中…"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="projectId" value="${project.id}"><input type="hidden" name="s" value="${currentIdx}"><input type="hidden" name="runId" value="${run.id}">
        <button class="btn btn--sm" type="submit"${runLive ? ' disabled' : ''}>↻ 从断点续跑</button></form>` : ''}
      ${runResumable ? `<form method="post" action="/docs/cancel" class="inline" onsubmit="return confirm('停止生成？已完成的小节会保留。')"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="projectId" value="${project.id}"><input type="hidden" name="s" value="${currentIdx}"><input type="hidden" name="runId" value="${run.id}">
        <button class="btn btn--sm btn--danger" type="submit">■ 停止生成</button></form>` : ''}
      <a class="btn btn--sm" href="/docs/project/${project.id}/export" title="导出全文 Markdown">⬇ Markdown</a>
      <a class="btn btn--sm" href="/docs/project/${project.id}/docx" title="导出 Word（.docx），可直接交稿">⬇ Word</a>
      <form method="post" action="/docs/distill-project" class="inline"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="projectId" value="${project.id}"><input type="hidden" name="s" value="${currentIdx}">
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
    const mdHtml = section.content ? renderSectionBody(project, section) : '';
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
    } else {
      // 两种模式都先给正文：共创也要能看到成稿，否则文档只能从聊天气泡里读。
      const emptyHint = isCo
        ? '还没有正文。在下面把要点告诉 AI（它会先追问），或点「AI 起草本节」直接成稿。'
        : `（${statusText}——全托管生成，或点「编辑本节」手写）`;
      // 正文预览套用项目自己的版式（字体/字号/行距）：蒸馏出的版式在页面上就能看到效果
    const layoutVars = Object.entries(docLayout.layoutCssVars(project.layout))
      .map(([key, value]) => `${key}:${value}`).join(';');
    contentHtml = (mdHtml ? `<div class="sec__text" style="${escapeHtml(layoutVars)}">${mdHtml}</div>` : `<div class="sec__text is-empty">${emptyHint}</div>`) +
        `<div class="actions"><a class="btn btn--sm" href="/docs?id=${project.id}&s=${section.idx}&edit=1">编辑本节</a></div>` +
        (isCo ? `<details class="outlinecard"${Array.isArray(section.chat) && section.chat.length ? '' : ' open'}>
          <summary>💬 共创对话 <span class="work__meta">AI 会先追问，信息够了才成稿</span></summary>
          ${renderSectionThread(section)}
        </details>` : '');
    }
    // 写作要点卡（论题 + 论据要点）：随时改，AI 共创/起草/批量全部即时生效
    const outlineCard = `<details class="outlinecard">
      <summary>🎯 写作要点 <span class="work__meta">论题与论据——改完即生效到所有生成</span></summary>
      <form method="post" action="/docs/outline" style="margin-top:8px">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <input type="hidden" name="projectId" value="${project.id}">
        <input type="hidden" name="s" value="${currentIdx}">
        <label style="margin-top:4px">论题 / 主线主张</label>
        <textarea name="thesis" style="min-height:56px">${escapeHtml(project.thesis || '')}</textarea>
        <label>论据 / 要点（一行一条）</label>
        <textarea name="points" class="code" style="min-height:80px">${escapeHtml((project.points || []).join('\n'))}</textarea>
        <div class="actions"><button class="btn btn--primary btn--sm" type="submit">保存要点</button></div>
      </form>
    </details>`;
    // 质量工具条：评审、提问、计划、全文润色。都是「按一下、看一眼」的动作，不占主流程。
    const hidden = `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="s" value="${currentIdx}">`;
    const hasBody = !!String(section.content || '').trim();
    const qualityBar = `<div class="qbar">
      <form method="post" action="/docs/review" class="inline" data-busy="评审中…">${hidden}
        <button class="btn btn--sm" type="submit"${hasBody ? '' : ' disabled'} title="按六个维度打分并列出必须修正项">🧐 评审本节</button></form>
      <form method="post" action="/docs/review" class="inline" data-busy="按意见修改…">${hidden}
        <input type="hidden" name="fix" value="1">
        <button class="btn btn--sm" type="submit"${hasBody ? '' : ' disabled'} title="低于 70 分时按必须修正项重写一次">🛠 按评审意见改一次</button></form>
      <form method="post" action="/docs/review" class="inline" data-busy="多轮打磨中…" onsubmit="return confirm('深度打磨会反复评审与修补（最多 3 轮），耗时与消耗都更高。继续？')">${hidden}
        <input type="hidden" name="fix" value="1">
        <input type="hidden" name="rounds" value="3">
        <button class="btn btn--sm" type="submit"${hasBody ? '' : ' disabled'} title="反复评审→修补，直到没有可修的问题或分数不再提升（最多 3 轮）">✨ 深度打磨（3 轮）</button></form>
      <form method="post" action="/docs/questions" class="inline" data-busy="AI 提问中…">${hidden}
        <button class="btn btn--sm" type="submit" title="按多个视角问出「素材答不出的问题」，指出要补什么材料">🔎 AI 提问</button></form>
      <form method="post" action="/docs/plan" class="inline" data-busy="规划中…">${hidden}
        <button class="btn btn--sm" type="submit" title="让 AI 重出本节的段落计划，下次起草按新骨架走">📋 重出段落计划</button></form>
      <form method="post" action="/docs/polish" class="inline" data-busy="已开始…">${hidden}
        <button class="btn btn--sm" type="submit" title="逐节带前后文润色：补衔接、去重复、统一术语（不新增事实）">✨ 全文润色</button></form>
    </div>`;

    // 版本历史：AI 改写、润色、评审落改都是整节覆盖，没有恢复入口就只能重写。
    const versions = docEngine.listSectionVersions(project.id, section.idx, 10);
    const versionSourceLabel = (source) => ({
      'ai-draft': 'AI 起草', 'ai-revise': 'AI 修改', 'ai-chat': '对话共创',
      'ai-batch': '托管生成', 'ai-polish': '全文润色', 'review-restore': '评审恢复',
      restore: '版本恢复', manual: '手工保存',
    }[source] || String(source || '手工保存'));
    const versionsCard = versions.length ? `<details class="outlinecard">
      <summary>🕘 版本历史 <span class="work__meta">最近 ${versions.length} 版，可恢复到任一版</span></summary>
      <ul class="list">${versions.map((version) => `<li style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
        <span>${escapeHtml(new Date(version.createdAt).toLocaleString('zh-CN'))} · ${Number(version.chars).toLocaleString('zh-CN')} 字 · ${escapeHtml(versionSourceLabel(version.source))}</span>
        <form method="post" action="/docs/section/restore" class="inline" onsubmit="return confirm('用这一版覆盖当前正文？当前内容会先存进版本历史，可以再撤回。')">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <input type="hidden" name="projectId" value="${project.id}">
          <input type="hidden" name="idx" value="${section.idx}">
          <input type="hidden" name="versionId" value="${Number(version.id)}">
          <button class="btn btn--sm" type="submit">恢复到这一版</button>
        </form>
      </li>`).join('')}</ul>
    </details>` : '';

    body = `<div class="docbody"><div class="docbody__inner">
      ${renderPolishBanner(project)}
      ${renderRunReport(run, project)}
      ${renderAuditCard(docEngine.auditProject(project))}
      ${renderMaterialsCard(project, csrf, currentIdx)}
      ${project.docType === 'paper' ? renderLiteratureCard(project, csrf, currentIdx) : ''}
      ${renderDatasetCard(project, csrf, currentIdx)}
      ${project.docType === 'paper' ? renderMetaCard(project, csrf, currentIdx) : ''}
      ${project.docType === 'paper' ? renderTopicCard(project, csrf, currentIdx) : ''}
      ${project.docType === 'paper' ? renderMethodCard(project, csrf, currentIdx) : ''}
      ${renderTypeCard(project, csrf, currentIdx, docEngine.listDatasets(project.id))}
      ${outlineCard}
      ${renderTemplateCard(project, csrf, currentIdx)}
      ${renderLayoutCard(project, csrf, currentIdx)}
      ${section.brief ? `<div class="sec__brief">第 ${section.idx} 节 · ${escapeHtml(section.brief)}</div>` : ''}
      <h2 style="margin:0 0 10px;font-size:17px">第 ${section.idx} 节　${escapeHtml(section.title)}
        <span class="work__meta">（${statusText}${section.source === 'ai-batch' ? ' · 托管生成' : section.source === 'ai-chat' ? ' · 对话共创' : section.source === 'ai-revise' ? ' · AI 修改' : section.source === 'ai-draft' ? ' · AI 起草' : section.source === 'ai-polish' ? ' · 已润色' : ''}）</span></h2>
      ${qualityBar}
      ${contentHtml}
      ${versionsCard}
      ${renderReviewCard(section)}
      ${renderReviewPanelCard(project, section.idx)}
      ${renderQualityCard(section)}
      ${renderContextCard(section)}
      ${renderPlanCard(section)}
      ${renderQuestionsCard(project, section, csrf)}
      <div class="sec__nav">
        ${prev ? `<a class="btn btn--sm" href="/docs?id=${project.id}&s=${prev.idx}">← 第${prev.idx}节 ${escapeHtml(prev.title)}</a>` : '<span></span>'}
        ${next ? `<a class="btn btn--sm" href="/docs?id=${project.id}&s=${next.idx}">第${next.idx}节 ${escapeHtml(next.title)} →</a>` : ''}
      </div>
    </div></div>`;
  }

  // 底部输入条：共创 = 对话消息（发给 sectionChat）；全托管 = 修改指示（发给 revise）。
  const composer = !section ? '' : (isCo ? `<div class="composer">
    ${skillsPicker(allSkills, project.skillIds)}
    <form method="post" action="/docs/section/chat" id="chatForm" data-busy="AI 正在写…" onsubmit="syncSkills('skillSlotChat')">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="idx" value="${section.idx}">
      <input type="hidden" name="skillIdsJson" id="skillSlotChat" value="${escapeHtml(JSON.stringify(project.skillIds))}">
      <textarea name="message" required placeholder="回答上面的问题，或告诉 AI 本节要写什么……（说「开始写」直接成稿）"></textarea>
      <div class="composer__acts">
        <a class="btn btn--sm" href="/docs?id=${project.id}&s=${section.idx}&edit=1">编辑本节</a>
        <button class="btn btn--sm" type="submit" form="draftForm" onclick="syncSkills('skillSlotDraft')" title="跳过对话，AI 直接起草本节">AI 起草本节</button>
        ${modelChip(project, csrf, section.idx)}
        <span class="composer__hint">共创模式：通过对话协作完成本节</span>
        <span class="composer__send"><button class="sendbtn" type="submit" title="发送">↑</button></span>
      </div>
    </form>
    <form method="post" action="/docs/section/draft" id="draftForm" data-busy="起草中…">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="idx" value="${section.idx}">
      <input type="hidden" name="skillIdsJson" id="skillSlotDraft" value="${escapeHtml(JSON.stringify(project.skillIds))}">
    </form>
  </div>` : `<div class="composer">
    ${skillsPicker(allSkills, project.skillIds)}
    <form method="post" action="/docs/section/revise" id="reviseForm" data-busy="改写中…" onsubmit="syncSkills('skillSlotRevise')">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="idx" value="${section.idx}">
      <input type="hidden" name="skillIdsJson" id="skillSlotRevise" value="${escapeHtml(JSON.stringify(project.skillIds))}">
      <textarea name="instruction" required placeholder="写下对本节的修改要求，让 AI 改写……"></textarea>
      <div class="composer__acts">
        <a class="btn btn--sm" href="/docs?id=${project.id}&s=${section.idx}&edit=1">编辑本节</a>
        <button class="btn btn--sm" type="submit" form="draftForm" onclick="syncSkills('skillSlotDraft')" title="AI 重新起草本节">AI 起草本节</button>
        ${modelChip(project, csrf, section.idx)}
        <span class="composer__hint">全托管模式：逐节指示修改，或用头部按钮整篇批量</span>
        <span class="composer__send"><button class="sendbtn" type="submit" title="发送">↑</button></span>
      </div>
    </form>
    <form method="post" action="/docs/section/draft" id="draftForm" data-busy="起草中…">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <input type="hidden" name="projectId" value="${project.id}">
      <input type="hidden" name="idx" value="${section.idx}">
      <input type="hidden" name="skillIdsJson" id="skillSlotDraft" value="${escapeHtml(JSON.stringify(project.skillIds))}">
    </form>
  </div>`);

  return `${head}${body}${composer}`;
}

// ---------- 页面装配 ----------

// ---------- 页面内联脚本 ----------
//
// 必须用 String.raw 包裹：外层是模板字面量，普通写法里的 \n 会被转义成真换行，
// 落进 JS 的字符串字面量就是语法错误——整段脚本一行都不会执行，页面所有交互静默失效。
// 这里任何一个 '\n' 都必须是字面量（JS 源码里的转义序列），所以只能 String.raw。
function renderPageScript(docTemplates) {
  const defaults = JSON.stringify(Object.fromEntries(Object.values(docEngine.DOC_TYPES)
    .map((type) => [type.key, type.sections])));
  const tplMd = JSON.stringify(Object.fromEntries(docTemplates.map((tpl) => [tpl.id, docEngine.templateMarkdown(tpl)])));
  // 模板自带的版式摘要：选中模板时直接告诉作者「这套排版是什么」，
  // 而不是让他导出 Word 之后才发现字体字号没跟着来。
  const tplMeta = JSON.stringify(Object.fromEntries(docTemplates.map((tpl) => {
    const summary = docLayout.layoutSummary(tpl.layout);
    return [tpl.id, { sections: tpl.sections.length, line: summary.bodyLine, heading: summary.headingLine }];
  })));
  return String.raw`<script>
  const DEFAULTS = ${defaults};
  const TPL_MD = ${tplMd};
  const TPL_META = ${tplMeta};

  // 空态输入条的模式胶囊：只改隐藏域与高亮，不提交。
  function cxModeSet(mode) {
    const field = document.getElementById('cxMode');
    if (field) field.value = mode;
    const pill = document.getElementById('cxPill');
    if (pill) for (const btn of pill.querySelectorAll('[data-mode]')) {
      btn.classList.toggle('is-on', btn.dataset.mode === mode);
    }
  }

  // 空态输入条提交前：第一行当标题，模板 textarea 的值搬到唯一同名字段。
  function cxPrepare() {
    const brief = document.getElementById('cxBrief');
    const title = document.getElementById('cxTitle');
    const tpl = document.getElementById('cxTplArea');
    const tplField = document.getElementById('cxTemplate');
    const text = brief ? brief.value.trim() : '';
    if (!text) { alert('先写一两句要做什么'); return false; }
    if (title) title.value = text.split('\n')[0].slice(0, 80);
    if (tplField) tplField.value = tpl ? tpl.value : '';
    return true;
  }

  // 技能勾选 → 目标隐藏域（每个输入条各有一个槽位）。
  function syncSkills(slotId) {
    const ids = Array.from(document.querySelectorAll('.skillcheck:checked')).map((box) => box.value);
    const slot = document.getElementById(slotId);
    if (slot) slot.value = JSON.stringify(ids);
  }

  function openCreate(prefill) {
    const modal = document.getElementById('createModal');
    if (!modal) return;
    if (prefill) {
      const brief = document.getElementById('cmBrief');
      if (brief && !brief.value) brief.value = prefill;
    }
    modal.style.display = 'flex';
    setTimeout(() => { const brief = document.getElementById('cmBrief'); if (brief) brief.focus(); }, 60);
  }

  function closeCreate() {
    const modal = document.getElementById('createModal');
    if (modal) modal.style.display = 'none';
  }

  function cmTab(mode) {
    const field = document.getElementById('cmMode');
    if (field) field.value = mode;
    const co = document.getElementById('cmTabCo');
    const auto = document.getElementById('cmTabAuto');
    if (co) co.classList.toggle('is-on', mode === 'co');
    if (auto) auto.classList.toggle('is-on', mode === 'auto');
    const row = document.getElementById('cmAutoRow');
    if (row) row.style.display = mode === 'auto' ? 'flex' : 'none';
    const hint = document.getElementById('cmModeHint');
    if (hint) hint.textContent = mode === 'auto'
      ? '全托管：创建后按小节批量推进，可中断续跑'
      : '共创：逐节和 AI 对话，追问清楚再成稿';
  }

  function applyTpl(id) {
    const area = document.getElementById('cmTplArea');
    if (area && id && TPL_MD[id]) area.value = TPL_MD[id];
    // 版式只存在模板里：必须把 templateId 一起提交，否则只带走了目录、带不走字体字号。
    const slot = document.getElementById('cmTplId');
    if (slot) slot.value = id || '';
    const hint = document.getElementById('tplLayoutHint');
    if (hint) hint.textContent = id && TPL_META[id]
      ? '版式随模板套用：' + TPL_META[id].line + '；' + TPL_META[id].heading
      : '';
    // 明确告诉作者「选了模板会发生什么」：目录、版式、写法三条都随模板走。
    const rule = document.getElementById('tplRuleHint');
    if (rule) rule.style.display = id ? '' : 'none';
  }

  // 「填入类型默认模板」：类型下拉框必须在同一个表单里，页面上有两个 docType 下拉
  // （空态工具条与新建弹窗），按 id 取会拿错。
  function fillDefault(btn) {
    const form = btn && btn.form;
    const select = form ? form.querySelector('select[name="docType"]') : null;
    const area = document.getElementById('cxTplArea');
    if (!select || !area) return;
    const sections = DEFAULTS[select.value] || [];
    area.value = sections.length
      ? sections.map((section) => '# ' + section.title + '\n' + (section.brief || '')).join('\n\n')
      : '';
  }

  // 右栏「写作要点」面板 → 新建弹窗的隐藏字段（论题 / 论据 / 计划章节）。
  function syncOutlineToForm() {
    const read = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const write = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
    const split = (value) => value.split('\n').map((line) => line.trim()).filter(Boolean);
    write('cmThesis', read('__wx_thesis_rail'));
    write('cmPoints', JSON.stringify(split(read('__wx_points_rail'))));
    write('cmSecs', JSON.stringify(split(read('__wx_secs_rail')).map((title) => ({ title }))));
    return true;
  }

  // 读成 base64：.docx 是压缩包，按文本读只会得到乱码，只能整包交给服务端解析。
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        resolve(text.slice(text.indexOf(',') + 1));
      };
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });
  }

  function isDocxFile(file) { return !!file && /\.docx$/i.test(file.name || ''); }

  async function postDistill(options) {
    const csrfInput = document.querySelector('#createModal input[name="csrf"]')
      || document.querySelector('input[name="csrf"]');
    const body = new URLSearchParams();
    body.set('csrf', csrfInput ? csrfInput.value : '');
    body.set('name', options.name || '');
    body.set('docType', options.docType || 'custom');
    if (options.file) {
      body.set('fileName', options.file.name);
      body.set('sampleFile', await fileToBase64(options.file));
    } else {
      body.set('sample', options.sample || '');
    }
    const res = await fetch('/docs/distill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.message || ('HTTP ' + res.status));
    return data;
  }

  async function cxDistill() {
    const sample = document.getElementById('cxDisSample');
    const fileInput = document.getElementById('cxDisFile');
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!isDocxFile(file) && (!sample || sample.value.trim().length < 200)) {
      alert('样例文档太短（至少 200 字）；上传 .docx 可以直接量出真实字体字号与目录'); return;
    }
    const btn = document.querySelector('button[data-act="distill"]');
    if (btn) { btn.disabled = true; btn.textContent = '蒸馏中…'; }
    try {
      const data = await postDistill({
        name: (document.getElementById('cxDisName') || {}).value || '',
        docType: (document.getElementById('cxDisType') || {}).value || 'custom',
        sample: sample ? sample.value.trim() : '',
        file: isDocxFile(file) ? file : null,
      });
      alert(data.message || '蒸馏完成');
      location.href = '/docs?new=1';
    } catch (error) {
      alert('蒸馏失败：' + error.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '开始蒸馏与拆解'; }
    }
  }

  // 页面上的蒸馏卡：同一个接口，换成表单形态提交。
  async function distillCard(form) {
    const sampleArea = form.querySelector('textarea[name="sample"]');
    const fileInput = form.querySelector('input[type="file"]');
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (!isDocxFile(file) && (!sampleArea || sampleArea.value.trim().length < 200)) {
      alert('样例文档太短（至少 200 字）；上传 .docx 可以直接量出真实字体字号与目录'); return false;
    }
    const btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = '蒸馏中…'; }
    try {
      const nameInput = form.querySelector('input[name="name"]');
      const typeSelect = form.querySelector('select[name="docType"]');
      const data = await postDistill({
        name: nameInput ? nameInput.value : '',
        docType: typeSelect ? typeSelect.value : 'custom',
        sample: sampleArea ? sampleArea.value.trim() : '',
        file: isDocxFile(file) ? file : null,
      });
      alert(data.message || '蒸馏完成');
      location.reload();
    } catch (error) {
      alert('蒸馏失败：' + error.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '开始蒸馏与拆解'; }
    }
    return false;
  }

  // 蒸馏样例的文件选择：.docx 走服务端解析（真实版式），文本类直接读进文本框。
  for (const input of document.querySelectorAll('.js-distillfile')) {
    input.addEventListener('change', function () {
      const file = this.files && this.files[0];
      const hint = document.getElementById(this.dataset.hint || '');
      const target = document.getElementById(this.dataset.target || 'cxDisSample');
      if (!file) { if (hint) hint.textContent = ''; return; }
      if (isDocxFile(file)) {
        if (target) target.value = '';
        if (hint) hint.textContent = '已选 ' + file.name + '：将直接解析真实字体、字号、行距与章节目录';
        return;
      }
      if (hint) hint.textContent = '';
      file.text().then((text) => { if (target) target.value = text; })
        .catch(() => alert('读取文件失败（文本类 .md/.txt 可以直接读，.docx 请用文件选择）'));
    });
  }

  // 「先定个方向」→ 追加进正文说明，作者能看到它被写进去了。
  function mergeDirection() {
    const parts = [];
    for (const [id, label] of [['dirAudience', '受众'], ['dirTone', '语气'], ['dirLen', '篇幅']]) {
      const el = document.getElementById(id);
      const value = el && el.value.trim();
      if (value) parts.push(label + '：' + value);
    }
    if (parts.length) {
      const brief = document.getElementById('cmBrief');
      if (brief) brief.value = (brief.value ? brief.value + '\n' : '') + '【方向】' + parts.join('；');
    }
    return true;
  }

  // 模板 / 蒸馏样例的文件读取：class 委托，避免重复 id 抢同一个元素。
  for (const input of document.querySelectorAll('.js-readtext')) {
    input.addEventListener('change', function () {
      const file = this.files && this.files[0];
      if (!file) return;
      const target = document.getElementById(this.dataset.target || '');
      if (!target) return;
      file.text().then((text) => { target.value = text; })
        .catch(() => alert('读取文件失败（仅支持文本类 .md/.txt）'));
    });
  }

  // 共创对话：进入页面滚到最新一条，作者不用手动往下翻。
  const thread = document.getElementById('chatThread');
  if (thread) thread.scrollTop = thread.scrollHeight;

  // 生成中的提交按钮置灰，避免连点起两个任务（后端也有在途保护）。
  // 有些按钮在表单外（form="draftForm"），要按 form 属性回查。
  for (const form of document.querySelectorAll('form[data-busy]')) {
    form.addEventListener('submit', function () {
      const btn = this.querySelector('button[type="submit"]')
        || (this.id ? document.querySelector('button[form="' + this.id + '"]') : null);
      if (btn) { btn.disabled = true; btn.textContent = this.dataset.busy; }
    });
  }
</script>`;
}

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
    <summary>🧪 模板蒸馏与拆解 <span class="composer__hint">——样例文档 → 章节目录 + 版式（字体字号）+ 文风技法</span></summary>
    <p class="lead">上传一篇写得好的样例 .docx（或粘贴全文）：系统直接量出它的章节目录层级、字体字号行距页边距，再让 AI 补写每节要点与文风技法。新建文档时选中这套模板，写出来的稿子就是同一套结构与版式。</p>
    <form method="post" action="/docs/distill" onsubmit="distillCard(this); return false;">
      <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
      <div class="row">
        <div><label>模板名（留空让 AI 起）</label><input type="text" name="name" placeholder="如：优秀 BP 结构 v1"></div>
        <div><label>归属类型</label><select name="docType">${typeOptions('custom')}</select></div>
      </div>
      <label>样例文档（.docx 优先：只有它能提供真实版式）</label>
      <input type="file" class="js-distillfile" data-target="distillSample" data-hint="distillFileHint" accept=".docx,.md,.txt,.markdown">
      <div class="composer__hint" id="distillFileHint"></div>
      <textarea name="sample" id="distillSample" placeholder="粘贴样例文档全文……"></textarea>
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
${renderPageScript(docTemplates)}
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

// 论据要点有两种提交形态：工作区是「一行一条」的多行文本（points），
// 新建弹窗是 JSON 数组（pointsJson）。只读一种，另一种就会把已存论据清空。
function readPoints(form) {
  const raw = form.get('pointsJson');
  if (raw != null) {
    try {
      const parsed = JSON.parse(String(raw));
      if (Array.isArray(parsed)) {
        const list = parsed.map((item) => String(item || '').trim()).filter(Boolean);
        if (list.length) return list;
      }
    } catch (error) { /* 落到多行文本 */ }
  }
  return String(form.get('points') || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*·]\s*/, ''))
    .filter(Boolean);
}

// 生成结束的提示：有隔离小节或停机原因时不能报「成功」，否则作者以为跑完了。
function runOutcomeNotice(result, prefix = '生成结束') {
  const parts = [`新写 ${result?.created?.length || 0} 节`];
  if (result?.skipped?.length) parts.push(`跳过 ${result.skipped.length} 节`);
  if (result?.quarantined?.length) parts.push(`${result.quarantined.length} 节失败`);
  // 自动评审的上限与失败也要说出来：静默少评几节，作者会以为「评审团都看过了」。
  const auto = result?.autoReview;
  if (auto && !auto.skipped) {
    parts.push(`自动评审完成 ${Number(auto.reviewed) || 0} 节`);
    const requested = Number(auto.requested) || 0;
    const maxItems = Number(auto.maxItems) || 0;
    if (auto.capped && requested > maxItems) {
      parts.push(`另有 ${requested - maxItems} 节超过自动评审上限，请到评审页手动发起`);
    }
    // 预算用完 / 被「停止」中断同样要说出来：否则剩余小节会被当成「评审过了」。
    if (auto.budgetExhausted) {
      parts.push(`自动评审总预算 ${Number(auto.tokenBudget || 0).toLocaleString('zh-CN')} tokens 已用完`
        + `（已花 ${Number(auto.tokensUsed || 0).toLocaleString('zh-CN')}），剩余 ${Number(auto.notRun) || 0} 节未送评`);
    }
    if (auto.cancelled) {
      parts.push(`自动评审已按「停止」中断，剩余 ${Number(auto.notRun) || 0} 节未送评`);
    }
    const failedReview = (Array.isArray(auto.sections) ? auto.sections : []).filter((item) => item.error).length;
    if (failedReview) parts.push(`${failedReview} 节评审失败`);
  }
  const text = `${prefix}：${parts.join('，')}${result?.stopReason ? '；' + result.stopReason : ''}`;
  return { at: Date.now(), ok: !result?.quarantined?.length && !result?.stopReason, message: text };
}

function bad(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// 中文文件名：ASCII 回退 + RFC 5987 的 filename*（浏览器优先用它，下载下来就是文档标题）。
function contentDisposition(name, fallback) {
  const encoded = encodeURIComponent(String(name || fallback))
    .replace(/['()!*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${String(fallback || 'document').replace(/"/g, '')}"; filename*=UTF-8''${encoded}`;
}

function backHref(projectId, idx) {
  const id = String(projectId || '');
  if (!id) return '/docs';
  return `/docs?id=${encodeURIComponent(id)}&s=${Number(idx) || 1}`;
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
    if (parts.length === 4 && parts[1] === 'project' && parts[3] === 'docx') {
      const assembled = docEngine.assembleDocx(parts[2]);
      if (!assembled) { bad(res, 404, 'not found'); return true; }
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': contentDisposition(assembled.filename, `doc-${String(parts[2]).slice(0, 8)}.docx`),
        'Content-Length': assembled.buffer.length,
        'Cache-Control': 'no-store',
      });
      res.end(assembled.buffer);
      return true;
    }
    return false;
  }
  if (req.method !== 'POST') return false;
  const action = `${parts[0]}/${parts[1] || ''}`;
  const routes = ['docs/create', 'docs/delete', 'docs/section', 'docs/generate', 'docs/resume', 'docs/cancel', 'docs/mode', 'docs/depth', 'docs/meta', 'docs/dataset', 'docs/analysis', 'docs/dataset/diagnose', 'docs/preset', 'docs/type', 'docs/model', 'docs/topic', 'docs/bib', 'docs/lit', 'docs/method', 'docs/continue', 'docs/distill', 'docs/distill-project', 'docs/template', 'docs/outline', 'docs/layout', 'docs/layout/reapply', 'docs/template/reapply-outline', 'docs/unbind-template', 'docs/material', 'docs/review', 'docs/plan', 'docs/questions', 'docs/research', 'docs/polish'];
  if (!routes.includes(action)) return false;
  let form;
  // 素材是长文本：中文经 URL 编码后一字约 9 字节，512KB 只够 5 万字左右。
  // 本机服务、有 CSRF 校验，放宽到 2MB（素材上限仍是 6 万字）。
  // 蒸馏要收 .docx：base64 后体积膨胀 4/3，单独放到 20MB（解析器自己还有 12MB 上限）。
  try { form = await readForm(req, action === 'docs/distill' ? 20 * 1024 * 1024 : 2 * 1024 * 1024); }
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
        // 选中的已蒸馏模板要带上 id：章节目录来自大纲文本，版式（字体字号行距）只存在模板里。
        // 以前只把模板贴进 textarea、不带 id，选模板建出来的文档版式永远是默认值。
        templateId: String(form.get('templateId') || ''),
        skillIds: form.getAll('skillId'),
        thesis, points, depth: String(form.get('depth') || 'standard'),
        sections: Array.isArray(plannedSections) && plannedSections.length
          ? plannedSections.map((item) => (item && typeof item === 'object'
            ? { title: String(item.title || ''), level: Number(item.level) || 1 }
            : { title: String(item || '') })) : null,
      });
      // 全托管勾选了「创建后自动开始整篇生成」：后台拉起批量，页面直接进工作台看进度。
      if (String(form.get('autoStart') || '') === '1' && project.mode === 'auto') {
        const started = statusPage.startResume(project.id, {
          resume: (id) => docEngine.generateDocProject({ projectId: id }),
          onSettled: (id, error, result) => jobNotices.set(id, error
            ? { at: Date.now(), ok: false, message: `生成中断：${String(error.message || error).slice(0, 160)}` }
            : runOutcomeNotice(result)),
        });
        jobNotices.set(project.id, started
          ? { at: Date.now(), ok: true, message: '整篇生成已启动…' }
          : { at: Date.now(), ok: false, message: '这个项目已有任务在运行' });
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
    if (action === 'docs/depth') {
      docEngine.setProjectDepth(projectId, String(form.get('depth') || 'standard'));
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/dataset') {
      const op = String(parts[2] || '');
      if (op === 'add') {
        const added = docEngine.addDataset({
          projectId, name: form.get('name'), content: form.get('content'),
        });
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `已加入数据表「${added.name}」（${added.rows} 行 × ${added.cols} 列）——选好变量就能跑分析`,
        });
      } else if (op === 'delete') {
        docEngine.removeDataset({ projectId, id: form.get('datasetId') });
        jobNotices.set(projectId, { at: Date.now(), ok: true, message: '数据表已删除' });
      }
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/dataset/diagnose') {
      const result = docEngine.diagnoseDataset({
        projectId,
        datasetId: String(form.get('datasetId') || ''),
        spec: { y: String(form.get('y') || ''), x: form.getAll('x').map((item) => String(item)).filter(Boolean) },
      });
      const warns = result.findings.filter((item) => item.level === 'warn').length;
      jobNotices.set(projectId, {
        at: Date.now(), ok: true,
        message: warns
          ? `数据体检完成：${warns} 处硬伤（${result.findings.find((item) => item.level === 'warn').title}）——建议先处理再跑回归`
          : `数据体检完成：${result.n} 行、${result.k} 个参数，没有发现硬伤`,
      });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/analysis') {
      const kind = String(form.get('kind') || 'describe');
      const x = form.getAll('x').map((item) => String(item)).filter(Boolean);
      const y = String(form.get('y') || '');
      const group = String(form.get('group') || '');
      const result = docEngine.insertAnalysis({
        projectId, idx: backIdx, kind,
        spec: {
          datasetId: String(form.get('datasetId') || ''),
          y, x, group,
          value: kind === 'ttest' ? y : undefined,
          columns: kind === 'describe' || kind === 'corr' ? (x.length ? x : (y ? [y] : [])) : undefined,
          robust: String(form.get('robust') || '') === '1',
        },
      });
      jobNotices.set(projectId, {
        at: Date.now(), ok: true,
        message: `分析完成：「${result.table.title}」已插入第 ${result.idx} 节（表 ${result.table.no}）——结果段的数字是算出来的，改文字别改数`,
      });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/model') {
      const channelId = String(form.get('channelId') || '');
      try {
        llm.setActiveChannel(channelId);
        const picked = llm.channelList().find((item) => item.id === channelId);
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `已切换模型：${picked ? (picked.model || picked.label) : channelId}（与小说工作台共用同一套渠道）`,
        });
      } catch (error) {
        jobNotices.set(projectId, { at: Date.now(), ok: false, message: String(error.message || error) });
      }
      res.writeHead(303, { Location: `/docs?id=${encodeURIComponent(projectId)}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/type') {
      const op = String(parts[2] || '');
      // 多行文本 → 结构化条目：每行用 | 分隔，多余的空白自动去掉
      const lines = (raw) => String(raw || '').split(/\r?\n/)
        .map((line) => line.split(/[|｜]/).map((cell) => cell.trim()))
        .filter((cells) => cells.length && cells[0]);
      if (op === 'finance') {
        const input = {
          price: Number(form.get('price') || 0),
          customers: Number(form.get('customers') || 0),
          growth: Number(form.get('growth') || 0),
          retention: form.get('retention') ? Number(form.get('retention')) : 0.8,
          variableRate: form.get('variableRate') ? Number(form.get('variableRate')) : 0.35,
          fixedCost: Number(form.get('fixedCost') || 0),
          headcount: Number(form.get('headcount') || 0),
          costPerHead: Number(form.get('costPerHead') || 0),
          taxRate: form.get('taxRate') ? Number(form.get('taxRate')) : 0.25,
          capex: Number(form.get('capex') || 0),
          cash0: Number(form.get('cash0') || 0),
          marketingSpend: Number(form.get('marketingSpend') || 0),
          funding: Number(form.get('funding') || 0),
          preMoney: Number(form.get('preMoney') || 0),
          years: Number(form.get('years') || 3),
        };
        const built = docEngine.insertBusinessModel({ projectId, idx: backIdx, input });
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `财务模型已插入第 ${backIdx} 节（${built.tables.length} 张表）——三表由代码算，改假设可一键重算`,
        });
      } else if (op === 'scheme') {
        const indicators = lines(form.get('indicators')).map((cells) => ({
          name: cells[0], baseline: cells[1], target: cells[2], method: cells[3],
        }));
        const budget = lines(form.get('budget')).map((cells) => ({
          item: cells[0], amount: Number(String(cells[1] || '').replace(/[^\d.-]/g, '')) || 0, basis: cells[2],
        }));
        const inserted = docEngine.insertSchemeTables({ projectId, idx: backIdx, indicators, budget });
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `已插入 ${inserted.tables.length} 张表（${inserted.tables.map((item) => item.title).join('、')}）`,
        });
      } else if (op === 'clause') {
        const inserted = docEngine.insertClauseTable({ projectId, idx: backIdx, kind: String(form.get('kind') || '') });
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `条款对照表已插入第 ${backIdx} 节（${inserted.tables[0].title}）`,
        });
      } else if (op === 'sample') {
        const inserted = docEngine.insertSampleTables({
          projectId, idx: backIdx,
          datasetId: String(form.get('datasetId') || ''),
          columns: form.getAll('columns').map((item) => String(item)).filter(Boolean),
        });
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `样本构成表已插入第 ${backIdx} 节（${inserted.tables.length} 张）`,
        });
      } else if (op === 'check') {
        const result = docEngine.runTypeCheck(projectId);
        const warns = result ? result.findings.filter((item) => item.level === 'warn').length : 0;
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: result ? `专项检查完成：${warns} 处硬伤` : '这个文档类型没有专项检查',
        });
      }
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/preset') {
      if (String(form.get('clear') || '') === '1') {
        docEngine.setAnalysisPreset(projectId, null);
        jobNotices.set(projectId, { at: Date.now(), ok: true, message: '已取消自动分析预设' });
      } else {
        const preset = docEngine.setAnalysisPreset(projectId, {
          datasetId: String(form.get('datasetId') || ''),
          kind: String(form.get('kind') || 'ols'),
          y: String(form.get('y') || ''),
          x: form.getAll('x').map((item) => String(item)).filter(Boolean),
          robust: String(form.get('robust') || '') === '1',
          sectionIdx: Number(form.get('sectionIdx') || 0),
        });
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `自动分析预设已保存：第 ${preset.preset.sectionIdx} 节起草时会自动跑 ${preset.preset.kind} 并补三线表`,
        });
      }
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/bib') {
      const imported = docEngine.importBibliography({
        projectId, text: form.get('text'), filename: String(form.get('filename') || ''),
      });
      jobNotices.set(projectId, {
        at: Date.now(), ok: true,
        message: `已导入 ${imported.imported} 条文献（${imported.format}）${imported.skipped ? `，跳过 ${imported.skipped} 条重复或缺题名的` : ''}——接着可以生成文献矩阵`,
      });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/lit') {
      const op = String(parts[2] || '');
      if (op === 'matrix') {
        const matrix = await docEngine.buildLiteratureMatrix({ projectId });
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `文献矩阵已生成（${matrix.items.length} 条）——可以插入三线表或直接写综述初稿`,
        });
      } else if (op === 'insert') {
        const inserted = docEngine.insertLiteratureMatrix({ projectId, idx: backIdx });
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `文献矩阵已作为表 ${inserted.table.no} 插入第 ${inserted.idx} 节`,
        });
      } else if (op === 'draft') {
        const drafted = await docEngine.draftLiteratureReview({ projectId, idx: backIdx });
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `综述初稿已写入第 ${backIdx} 节（${drafted.chars} 字）——只依据文献矩阵归纳，没有引入矩阵外的文献`,
        });
      }
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/topic') {
      const result = docEngine.checkTopicNow(projectId);
      const warns = result.findings.filter((item) => item.level === 'warn').length;
      jobNotices.set(projectId, {
        at: Date.now(), ok: true,
        message: warns
          ? `选题体检完成：${warns} 处需要注意（${result.findings.find((item) => item.level === 'warn').title}）`
          : '选题体检完成：没有明显问题',
      });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/method') {
      const result = await docEngine.reviewMethodology(projectId);
      const warns = (result.scan.findings || []).filter((item) => item.level === 'warn').length;
      jobNotices.set(projectId, {
        at: Date.now(), ok: true,
        message: `方法论审查完成：规则扫描发现 ${warns} 处硬伤${result.review && result.review.fatal && result.review.fatal.length ? `，${result.review.fatal.length} 条会被直接拒` : ''}`,
      });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/meta') {
      docEngine.setProjectMeta(projectId, {
        authors: form.get('authors'), affiliation: form.get('affiliation'),
        keywords: form.get('keywords'), ccode: form.get('ccode'),
        fund: form.get('fund'), refStyle: form.get('refStyle'),
      });
      jobNotices.set(projectId, { at: Date.now(), ok: true, message: '论文要素已保存——导出时排在题名下方' });
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
      else if (op === 'restore') {
        const restored = docEngine.restoreSectionVersion(projectId, idx, Number(form.get('versionId')));
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `已恢复到 ${restored.chars.toLocaleString('zh-CN')} 字的旧版本——当前正文已存入版本历史，可再撤回`,
        });
      }
      else if (op === 'draft') { docEngine.setProjectSkills(projectId, skillIds); await docEngine.draftSection(projectId, idx, { skillIds }); }
      else if (op === 'revise') { docEngine.setProjectSkills(projectId, skillIds); await docEngine.reviseSection(projectId, idx, form.get('instruction'), { skillIds }); }
      else if (op === 'chat') {
        docEngine.setProjectSkills(projectId, skillIds);
        const result = await docEngine.sectionChat({ projectId, idx, message: form.get('message') });
        jobNotices.set(projectId, result.type === 'question'
          ? { at: Date.now(), ok: true, message: 'AI 需要更多信息，问题已列在对话里' }
          : result.type === 'rejected'
            ? { at: Date.now(), ok: false, message: `这一版没有落稿：${result.message}` }
            : { at: Date.now(), ok: true, message: `已写入第 ${idx} 节正文（${result.chars} 字）` });
      }
      else { bad(res, 404, 'unknown op'); return true; }
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${idx}` });
      res.end();
      return true;
    }
    if (action === 'docs/layout') {
      const project = docEngine.getProject(projectId);
      if (!project) { bad(res, 404, 'not found'); return true; }
      // 只覆盖表单里真的提交了的项：没提交的保持原值，避免改一个字段把蒸馏出的其余规格清成默认值。
      const spec = { ...project.layout, headingSizes: { ...project.layout.headingSizes } };
      for (const key of ['bodyFont', 'bodyFontEn', 'headingFont', 'titleFont', 'numbering', 'pageSize', 'align', 'orientation']) {
        const value = String(form.get(key) || '').trim();
        if (value) spec[key] = value;
      }
      for (const key of ['bodySize', 'lineSpacing', 'firstLineIndent', 'paraSpacing', 'titleSize',
        'marginTop', 'marginBottom', 'marginLeft', 'marginRight']) {
        const raw = String(form.get(key) || '').trim();
        if (raw) spec[key] = Number(raw);
      }
      for (const level of [1, 2, 3]) {
        const raw = String(form.get(`heading${level}`) || '').trim();
        if (raw) spec.headingSizes[level] = Number(raw);
      }
      let saved = null;
      try {
        saved = docEngine.setProjectLayout(projectId, spec);
      } catch (error) {
        // 模板锁定的项目：把原因说清楚，而不是抛 500 让人猜
        jobNotices.set(projectId, { at: Date.now(), ok: false, message: String(error.message || error) });
      }
      if (saved) {
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `版式已保存：${docLayout.layoutSummary(saved.layout).bodyLine}`,
        });
      }
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    // 模板绑定相关：解除绑定 / 重新套用模板版式
    if (action === 'docs/unbind-template') {
      const result = docEngine.unbindTemplate(projectId);
      jobNotices.set(projectId, {
        at: Date.now(), ok: true,
        message: result.previous
          ? `已解除模板《${result.previous}》的绑定——目录结构保留，版式现在可以自由调整`
          : '已解除模板绑定',
      });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/layout/reapply') {
      try {
        const result = docEngine.reapplyTemplateLayout(projectId);
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `已重新套用模板版式：${docLayout.layoutSummary(result.layout).bodyLine}`,
        });
      } catch (error) {
        jobNotices.set(projectId, { at: Date.now(), ok: false, message: String(error.message || error) });
      }
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    // 重新套用模板的章节目录（标题 + 层级 + 篇幅要点）
    if (action === 'docs/template/reapply-outline') {
      try {
        const result = docEngine.reapplyTemplateOutline(projectId);
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `已按模板重新套用目录：${result.sections} 节，标题与层级与模板一致`,
        });
      } catch (error) {
        jobNotices.set(projectId, { at: Date.now(), ok: false, message: String(error.message || error) });
      }
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/outline') {
      docEngine.setProjectOutline({ projectId, thesis: form.get('thesis'), points: readPoints(form) });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/review') {
      const idx = Number(form.get('idx') || form.get('s') || 1);
      const rounds = Math.max(1, Math.min(5, Number(form.get('rounds') || 1) || 1));
      const result = await docEngine.reviewSectionNow(projectId, idx, {
        fix: String(form.get('fix') || '') === '1', rounds,
      });
      const review = result.review;
      const trail = (result.history || []).map((item) => item.total).join(' → ');
      jobNotices.set(projectId, review
        ? {
          at: Date.now(), ok: true,
          message: `第${idx}节评审 ${review.total} 分`
            + (result.revised ? `，打磨 ${result.rounds} 轮${result.ended === 'regressed' ? '（有一轮改坏了，已回退到更好的版本）' : ''}` : '，无需修改')
            + (trail.includes('→') ? `；分数轨迹 ${trail}` : '')
            + (review.mustFix && review.mustFix.length ? `。首要问题：${review.mustFix[0]}` : ''),
        }
        : { at: Date.now(), ok: false, message: '评审没有返回可解析的结果，请重试' });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${idx}` });
      res.end();
      return true;
    }
    if (action === 'docs/plan') {
      const idx = Number(form.get('idx') || form.get('s') || 1);
      const result = await docEngine.regeneratePlan(projectId, idx);
      jobNotices.set(projectId, {
        at: Date.now(), ok: true,
        message: `已重出第${idx}节段落计划：${result.plan.paragraphs.length} 段 / 约 ${result.plan.targetChars} 字`,
      });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${idx}` });
      res.end();
      return true;
    }
    if (action === 'docs/questions') {
      const idx = Number(form.get('idx') || form.get('s') || 1);
      const result = await docEngine.suggestSectionQuestions(projectId, idx);
      const count = result.perspectives.reduce((total, item) => total + item.questions.length, 0);
      jobNotices.set(projectId, {
        at: Date.now(), ok: true,
        message: `AI 从 ${result.perspectives.length} 个视角提了 ${count} 个问题——答不上来的就是素材缺口`,
      });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${idx}` });
      res.end();
      return true;
    }
    if (action === 'docs/research') {
      const idx = Number(form.get('idx') || form.get('s') || 1);
      const result = await docEngine.researchSection(projectId, idx);
      jobNotices.set(projectId, {
        at: Date.now(), ok: true,
        message: `研究纪要已存为素材（${result.chars} 字，回答 ${result.questions} 个问题），下次起草本节会自动引用`,
      });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${idx}` });
      res.end();
      return true;
    }
    if (action === 'docs/polish') {
      const started = docEngine.startPolish(projectId);
      jobNotices.set(projectId, {
        at: Date.now(), ok: true,
        message: `已开始全文润色：${started.total} 节，跑完刷新页面看结果`,
      });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/material') {
      const op = String(parts[2] || '');
      if (op === 'add') {
        const added = docEngine.addMaterial({
          projectId, title: form.get('title'), kind: form.get('kind'), content: form.get('content'),
          authors: form.get('authors'), year: form.get('year'), source: form.get('source'),
        });
        jobNotices.set(projectId, {
          at: Date.now(), ok: true,
          message: `已加入素材「${added.title}」——下次起草本节就会按相关性引用`,
        });
      } else if (op === 'delete') {
        docEngine.removeMaterial({ projectId, id: form.get('materialId') });
        jobNotices.set(projectId, { at: Date.now(), ok: true, message: '素材已删除' });
      } else { bad(res, 404, 'unknown op'); return true; }
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
        let sample = String(form.get('sample') || '');
        let sampleLayout = null;
        let sampleOutline = null;
        let measured = '';
        const sampleFile = String(form.get('sampleFile') || '');
        if (sampleFile) {
          // .docx 是二进制：前端读成 base64 传上来，这里解压出真实版式与目录。
          // 文本里没有字体字号，只有 OOXML 里才有——所以 docx 走「测量」，纯文本只能「推断」。
          const probed = docxProbe.probeDocx(Buffer.from(sampleFile, 'base64'));
          sample = probed.text;
          sampleLayout = probed.layout;
          sampleOutline = probed.outline;
          measured = `（版式与目录实测自 ${String(form.get('fileName') || '.docx').slice(0, 60)}）`;
        }
        const result = await docEngine.distillDocTemplate({
          name: form.get('name'), docType: form.get('docType'), sample, sampleLayout, sampleOutline,
        });
        const summary = docLayout.layoutSummary(result.layout);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true, templateId: result.templateId, name: result.name,
          sections: result.sections.length, layout: summary.bodyLine,
          message: `蒸馏完成「${result.name}」：${result.sections.length} 节 · ${summary.bodyLine}${measured}`,
        }));
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
        // 本文的版式与目录就是「实测值」：从自己项目蒸馏，不该把版式换成模型猜的默认值。
        sampleLayout: project.layout,
        sampleOutline: project.sections.map((section) => ({
          level: section.level, title: section.title, brief: section.brief, minChars: section.minChars,
        })),
      });
      jobNotices.set(projectId, { at: Date.now(), ok: true, message: `已把本文蒸馏为模板「${result.name}」（${result.sections.length} 节 · ${docLayout.layoutSummary(result.layout).bodyLine}）+ 文档技法技能` });
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
      // 勾选框没提交 = 关闭评审；勾了 = 逐节评审 + 低分自动修订。
      const wantReview = String(form.get('review') || '') === '1';
      // 未勾选 = 本次不送评审团；勾了或表单里没有这个字段（老页面缓存）都按「送」处理
      const panelReview = form.get('panelReview') == null ? null : String(form.get('panelReview')) === '1';
      const started = statusPage.startResume(projectId, {
        resume: (id) => docEngine.generateDocProject({ projectId: id, review: wantReview, panelReview }),
        onSettled: (id, error, result) => jobNotices.set(id, error
          ? { at: Date.now(), ok: false, message: `生成中断：${String(error.message || error).slice(0, 160)}` }
          : runOutcomeNotice(result)),
      });
      jobNotices.set(projectId, started
        ? { at: Date.now(), ok: true, message: '整篇生成已启动…' }
        : { at: Date.now(), ok: false, message: '这个项目已有任务在运行，请等它结束或用「从断点续跑」' });
      res.writeHead(303, { Location: `/docs?id=${projectId}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/resume') {
      const runId = String(form.get('runId') || '');
      const run = one(`SELECT book_id FROM generation_runs WHERE id=? AND mode='doc'`, runId);
      if (!run) { bad(res, 400, 'run not found'); return true; }
      const started = statusPage.startResume(runId, {
        resume: (id) => docEngine.resumeDocRun(id),
        onSettled: (id, error, result) => {
          const row = one(`SELECT book_id FROM generation_runs WHERE id=?`, id);
          const target = row ? row.book_id : '';
          jobNotices.set(target, error
            ? { at: Date.now(), ok: false, message: `续跑中断：${String(error.message || error).slice(0, 160)}` }
            : runOutcomeNotice(result, '续跑结束'));
        },
      });
      jobNotices.set(run.book_id, started
        ? { at: Date.now(), ok: true, message: '续跑已启动…' }
        : { at: Date.now(), ok: false, message: '这个任务已经在运行，不用重复点' });
      res.writeHead(303, { Location: `/docs?id=${run.book_id}&s=${backIdx}` });
      res.end();
      return true;
    }
    if (action === 'docs/cancel') {
      const runId = String(form.get('runId') || '');
      const target = projectId || String(form.get('projectId') || '');
      const result = docEngine.cancelDocRun({ runId, projectId: target });
      jobNotices.set(target || '/', {
        at: Date.now(), ok: true,
        message: result.inProcess
          ? '已请求停止：当前小节写完后停下，已完成的小节会保留'
          : '任务已取消，已完成的小节会保留',
      });
      res.writeHead(303, { Location: backHref(target, backIdx) });
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

module.exports = {
  renderDocsList, renderProjectPage, renderDocsPage, handleDocs,
  // 评审入口卡：测试与外部页面都要能单独渲染它（不必拉起整个工作台）
  renderReviewPanelCard, renderQualityCard, renderContextCard,
  _jobNotices: jobNotices,
};
