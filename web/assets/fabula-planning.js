(() => {
  'use strict';

  let booksCache = null;
  let injecting = false;
  let injectTimer = null;
  let pendingSetupTimer = null;
  let pendingSetupRunToken = '';
  let fetchPatched = false;
  let workspaceBookId = '';
  let workspaceSessionId = '';
  let workspaceBooks = [];
  let workspaceSessionsByBook = {};
  let workspaceTabs = [];
  let workspaceSyncTimer = null;
  let workspaceSwitching = false;
  const autoTaskBooks = new Set();
  let activeAutopilotBookId = '';
  const autopilotReports = new Map();
  let globalSessionsTimer = null;
  let globalSessionsLoading = false;
  const PENDING_SETUP_KEY = 'fabula_pending_setup_plan';
  const WORKSPACE_TABS_KEY = 'fabula_workspace_tabs_v1';
  const customGenreCache = new WeakMap();

  const readWorkspaceTabs = () => {
    try {
      const value = JSON.parse(localStorage.getItem(WORKSPACE_TABS_KEY) || '[]');
      return Array.isArray(value) ? value.filter((tab) => tab && tab.key && tab.bookTitle && tab.bookTitle !== '选择作品') : [];
    } catch { return []; }
  };

  const saveWorkspaceTabs = () => {
    try { localStorage.setItem(WORKSPACE_TABS_KEY, JSON.stringify(workspaceTabs.slice(0, 12))); } catch {}
  };

  const workspaceKey = (bookId, sessionId, bookTitle, sessionTitle) =>
    `${bookId || bookTitle}\0${sessionId || sessionTitle || '<new-session>'}`;

  const workspaceBookTitle = () => document.querySelector('.librail__booktitle')?.textContent.trim() || '';

  const workspaceSessionTitle = () =>
    document.querySelector('.chathead__title--session')?.textContent.trim()
    || document.querySelector('.srail__card.is-active .srail__card-name')?.textContent.trim()
    || '';

  const rememberWorkspace = () => {
    const bookTitle = workspaceBookTitle();
    const sessionTitle = workspaceSessionTitle();
    if (!bookTitle || bookTitle === '选择作品') return;
    const key = workspaceKey(workspaceBookId, workspaceSessionId, bookTitle, sessionTitle);
    const current = {
      key,
      bookId: workspaceBookId,
      sessionId: workspaceSessionId,
      bookTitle,
      sessionTitle: sessionTitle || '新对话',
      updatedAt: Date.now(),
    };
    workspaceTabs = workspaceTabs.filter((tab) => !(
      current.sessionId
      && tab.bookId === current.bookId
      && !tab.sessionId
      && tab.sessionTitle === current.sessionTitle
    ));
    const existing = workspaceTabs.findIndex((tab) => tab.key === key);
    if (existing >= 0) workspaceTabs[existing] = { ...workspaceTabs[existing], ...current };
    else workspaceTabs.unshift(current);
    workspaceTabs = workspaceTabs.filter((tab, index, list) => list.findIndex((item) => item.key === tab.key) === index);
    workspaceTabs.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    saveWorkspaceTabs();
  };

  const addWorkspaceStyles = () => {
    if (document.getElementById('fabula-workspace-style')) return;
    const style = document.createElement('style');
    style.id = 'fabula-workspace-style';
    style.textContent = `
      .fabula-workspace-tabs { position:fixed; top:50px; left:302px; right:338px; z-index:100; height:34px; display:flex; align-items:center; gap:5px; padding:3px 8px; overflow-x:auto; border-bottom:1px solid var(--c-border); background:var(--c-bg,#fff); box-sizing:border-box; }
      .centerstage { padding-top:34px; box-sizing:border-box; }
      .fabula-workspace-tabs:empty { display:none; }
      .fabula-workspace-tab { flex:0 0 auto; max-width:230px; height:27px; display:inline-flex; align-items:center; gap:6px; padding:0 7px 0 10px; border:1px solid var(--c-border-btn); border-radius:6px; background:var(--c-white); color:var(--c-text-secondary); font:12px var(--font-ui); cursor:pointer; }
      .fabula-workspace-tab:hover { background:var(--c-row-hover); }
      .fabula-workspace-tab.is-active { border-color:var(--c-accent); background:var(--c-accent-bg); color:var(--c-accent); }
      .fabula-workspace-tab__label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .fabula-workspace-tab__close { width:18px; height:18px; flex:0 0 18px; padding:0; border:0; border-radius:4px; background:transparent; color:inherit; cursor:pointer; line-height:16px; }
      .fabula-workspace-tab__close:hover { background:var(--c-border); }
      .fabula-autopilot-btn { flex:0 0 auto; min-width:92px; height:30px; margin-left:6px; padding:0 11px; border:1px solid var(--c-accent); border-radius:7px; background:var(--c-accent-bg); color:var(--c-accent); font:600 12px var(--font-ui); cursor:pointer; white-space:nowrap; }
      .fabula-autopilot-btn:hover { background:var(--c-accent); color:var(--c-on-accent); }
      .fabula-autopilot-btn:disabled { opacity:.6; cursor:wait; }
      @media (max-width:900px) { .fabula-workspace-tabs { left:0; right:0; top:48px; } }
    `;
    document.head.appendChild(style);
  };

  const renderWorkspaceTabs = () => {
    document.querySelector('.fabula-workspace-tabs')?.remove();
    addWorkspaceStyles();
    assignWorkspaceBookIds?.();
    assignWorkspaceSessionIds?.();
    let bar = document.querySelector('.fabula-workspace-tabs');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'fabula-workspace-tabs';
      bar.setAttribute('aria-label', '已打开的工作区');
      document.body.appendChild(bar);
    }
    const activeKey = workspaceKey(workspaceBookId, workspaceSessionId, workspaceBookTitle(), workspaceSessionTitle());
    const visible = workspaceTabs.slice(0, 12);
    if (visible.length < 2) {
      bar.replaceChildren();
      return;
    }
    bar.replaceChildren(...visible.map((tab) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `fabula-workspace-tab${tab.key === activeKey ? ' is-active' : ''}`;
      button.title = `${tab.bookTitle} · ${tab.sessionTitle || '新对话'}`;
      button.dataset.workspaceKey = tab.key;
      const label = document.createElement('span');
      label.className = 'fabula-workspace-tab__label';
      label.textContent = `${tab.bookTitle} · ${tab.sessionTitle || '新对话'}`;
      const close = document.createElement('span');
      close.className = 'fabula-workspace-tab__close';
      close.setAttribute('role', 'button');
      close.setAttribute('aria-label', '关闭工作区标签');
      close.textContent = '×';
      button.append(label, close);
      return button;
    }));
  };

  const scheduleWorkspaceSync = () => {
    if (workspaceSyncTimer) return;
    workspaceSyncTimer = window.setTimeout(() => {
      workspaceSyncTimer = null;
      rememberWorkspace();
      renderWorkspaceTabs();
      scheduleGlobalSessionsSync();
    }, 100);
  };

  const parseIpcPacket = async (response) => {
    try {
      const text = await response.clone().text();
      const packet = JSON.parse(text.trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}');
      return packet.r;
    } catch { return null; }
  };

  const rememberWorkspaceRequest = (path, args) => {
    if (args?.__fabulaGlobal) return;
    if (path === '/ipc/list_books' && args?.bookId) workspaceBookId = String(args.bookId);
    if (path === '/ipc/list_sessions' && args?.bookId) workspaceBookId = String(args.bookId);
    if (path === '/ipc/list_messages' && args?.sessionId) workspaceSessionId = String(args.sessionId);
    if (path === '/ipc/get_next_chapter_state' && args?.bookId) workspaceBookId = String(args.bookId);
    if (path === '/ipc/set_setting' && args?.key === 'last_state') {
      try {
        const state = JSON.parse(String(args.value || '{}'));
        if (state.bookId) workspaceBookId = String(state.bookId);
        if (state.session !== undefined) workspaceSessionId = String(state.session || '');
      } catch {}
    }
  };

  const syncWorkspaceResponse = async (path, args, response) => {
    const result = await parseIpcPacket(response);
    if (path === '/ipc/list_books' && Array.isArray(result)) workspaceBooks = result;
    if (path === '/ipc/list_sessions' && args?.bookId && Array.isArray(result)) {
      workspaceSessionsByBook[args.bookId] = result;
    }
    if (path === '/ipc/create_book' && result?.id) workspaceBookId = String(result.id);
    if (path === '/ipc/create_session' && result?.id) {
      workspaceSessionId = String(result.id);
      workspaceSessionsByBook = {};
    }
    if (['/ipc/rename_session', '/ipc/delete_session', '/ipc/save_message', '/ipc/gen_session_title', '/ipc/chat_stream'].includes(path)) {
      workspaceSessionsByBook = {};
    }
    scheduleWorkspaceSync();
  };

  const assignWorkspaceBookIds = () => {
    const cards = [...document.querySelectorAll('.bookcard__main')];
    cards.forEach((card, index) => {
      const book = workspaceBooks[index];
      if (book?.id) card.dataset.fabulaBookId = book.id;
    });
  };

  const assignWorkspaceSessionIds = () => {
    const sessions = workspaceSessionsByBook[workspaceBookId] || [];
    const cards = [...document.querySelectorAll('.srail__card')];
    cards.forEach((card, index) => {
      const session = sessions[index];
      if (session?.id) card.dataset.fabulaSessionId = session.id;
    });
  };

  const waitForWorkspace = (predicate, timeout = 5000) => new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) { resolve(true); return; }
      if (Date.now() - started >= timeout) { resolve(false); return; }
      window.setTimeout(poll, 80);
    };
    poll();
  });

  const switchWorkspace = async (tab) => {
    if (!tab || workspaceSwitching) return;
    workspaceSwitching = true;
    try {
      if (tab.bookId && tab.bookId !== workspaceBookId) {
        const directSwitcher = document.querySelector('.librail__bookact') || document.querySelector('.librail__bookmain');
        if (directSwitcher) directSwitcher.click();
        else {
          const toggle = document.querySelector('.librail__bookact[title="切换作品"]')
            || document.querySelector('.librail__bookmain[title*="开启新书"]');
          toggle?.click();
        }
        await waitForWorkspace(() => document.querySelectorAll('.bookcard__main').length > 0, 2500);
        assignWorkspaceBookIds();
        let card = document.querySelector(`.bookcard__main[data-fabula-book-id="${CSS.escape(tab.bookId)}"]`);
        if (!card) {
          card = [...document.querySelectorAll('.bookcard__main')]
            .find((item) => item.querySelector('.bookcard__title')?.textContent.trim() === tab.bookTitle);
        }
        card?.click();
        await waitForWorkspace(() => workspaceBookId === tab.bookId, 5000);
      }
      assignWorkspaceSessionIds();
      if (tab.sessionId) {
        let card = document.querySelector(`.srail__card[data-fabula-session-id="${CSS.escape(tab.sessionId)}"] .srail__card-main`);
        if (!card) {
          card = [...document.querySelectorAll('.srail__card-main')]
            .find((item) => item.textContent.trim() === tab.sessionTitle);
        }
        card?.click();
        await waitForWorkspace(() => workspaceSessionId === tab.sessionId, 3500);
      } else {
        document.querySelector('.srail__entryrow .srail__entry')?.click();
      }
      scheduleWorkspaceSync();
    } finally {
      workspaceSwitching = false;
    }
  };

  workspaceTabs = readWorkspaceTabs();

  const ipcHeaders = () => {
    const headers = { 'Content-Type': 'application/json' };
    if (window.__WX_IPC_TOKEN__) headers['X-Fabula-Token'] = window.__WX_IPC_TOKEN__;
    return headers;
  };

  const ipc = async (command, args) => {
    const response = await fetch(`/ipc/${command}`, {
      method: 'POST',
      headers: ipcHeaders(),
      body: JSON.stringify({ args }),
    });
    const lines = (await response.text()).trim().split(/\r?\n/).filter(Boolean);
    const packet = JSON.parse(lines.at(-1) || '{}');
    if (!response.ok || packet.err) throw new Error(packet.err?.message || '操作失败');
    return packet.r;
  };

  const ipcStream = async (command, args, onEvent) => {
    const response = await fetch(`/ipc/${command}`, {
      method: 'POST',
      headers: ipcHeaders(),
      body: JSON.stringify({ args }),
    });
    if (!response.body) return ipc(command, args);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = null;
    let err = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const packet = JSON.parse(line);
        if (packet.e) onEvent?.(packet.e);
        if (packet.r !== undefined) result = packet.r;
        if (packet.err) err = packet.err;
      }
    }
    if (buffer.trim()) {
      const packet = JSON.parse(buffer.trim());
      if (packet.e) onEvent?.(packet.e);
      if (packet.r !== undefined) result = packet.r;
      if (packet.err) err = packet.err;
    }
    if (!response.ok || err) throw new Error(err?.message || '操作失败');
    return result;
  };

  const scheduleGlobalSessionsSync = (delay = 160) => {
    if (globalSessionsTimer) return;
    globalSessionsTimer = window.setTimeout(() => {
      globalSessionsTimer = null;
      renderGlobalSessions().catch(() => {});
    }, delay);
  };

  const sessionUpdatedAt = (session) => Number(session?.updatedAt || session?.createdAt || 0);

  const renderGlobalSessions = async () => {
    const body = document.querySelector('.srail__body');
    if (!body || globalSessionsLoading) return;
    body.style.overflowY = 'auto';
    body.style.webkitOverflowScrolling = 'touch';
    body.style.overscrollBehavior = 'contain';
    globalSessionsLoading = true;
    try {
      const books = (workspaceBooks.length
        ? workspaceBooks
        : (booksCache || await loadBooks().catch(() => []))).filter((book) => book?.id);
      if (!books.length) {
        body.querySelector('.fabula-global-sessions')?.remove();
        return;
      }
      const activeBookTitle = workspaceBookTitle();
      const activeBook = books.find((book) => String(book.id) === String(workspaceBookId))
        || books.find((book) => book.title === activeBookTitle);
      const currentBookId = String(activeBook?.id || workspaceBookId || '');
      const allSessions = [];
      await Promise.all(books.map(async (book) => {
        const bookId = String(book.id);
        let sessions = workspaceSessionsByBook[bookId];
        if (!Array.isArray(sessions)) {
          sessions = await ipc('list_sessions', { bookId, __fabulaGlobal: true }).catch(() => []);
          if (Array.isArray(sessions)) workspaceSessionsByBook[bookId] = sessions;
        }
        if (!Array.isArray(sessions)) return;
        sessions.forEach((session) => {
          if (!session?.id || bookId === currentBookId) return;
          allSessions.push({
            ...session,
            id: String(session.id),
            bookId,
            bookTitle: String(book.title || '未命名作品'),
          });
        });
      }));

      allSessions.sort((a, b) => sessionUpdatedAt(b) - sessionUpdatedAt(a));
      const visible = allSessions.slice(0, 100);
      const existing = body.querySelector('.fabula-global-sessions');
      if (!visible.length) {
        existing?.remove();
        return;
      }
      const signature = visible.map((session) => `${session.bookId}:${session.id}:${session.title || ''}`).join('|');
      if (existing?.dataset.signature === signature) return;

      const section = existing || document.createElement('section');
      section.className = 'fabula-global-sessions';
      section.dataset.signature = signature;
      const title = document.createElement('div');
      title.className = 'fabula-global-sessions__title';
      title.textContent = '其他作品会话';
      const list = document.createElement('div');
      visible.forEach((session) => {
        const row = document.createElement('div');
        row.className = 'fabula-global-session';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'srail__card-main';
        button.dataset.fabulaBookId = session.bookId;
        button.dataset.fabulaSessionId = session.id;
        button.dataset.fabulaBookTitle = session.bookTitle;
        button.dataset.fabulaSessionTitle = String(session.title || '新对话');
        button.title = `${session.bookTitle} · ${session.title || '新对话'}`;
        const dot = document.createElement('span');
        dot.className = 'srail__dot';
        const copy = document.createElement('span');
        copy.className = 'srail__card-copy';
        const book = document.createElement('span');
        book.className = 'fabula-global-session__book';
        book.textContent = session.bookTitle;
        const name = document.createElement('span');
        name.className = 'fabula-global-session__name';
        name.textContent = session.title || '新对话';
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'fabula-global-session__delete';
        deleteButton.dataset.fabulaSessionId = session.id;
        deleteButton.dataset.fabulaSessionTitle = String(session.title || '新对话');
        deleteButton.setAttribute('aria-label', `删除会话 ${session.title || '新对话'}`);
        deleteButton.title = '删除会话';
        deleteButton.textContent = '删除';
        copy.append(book, name);
        button.append(dot, copy);
        row.append(button, deleteButton);
        list.append(row);
      });
      section.replaceChildren(title, list);
      if (!existing) body.append(section);
    } finally {
      globalSessionsLoading = false;
    }
  };

  const addStyles = () => {
    if (document.getElementById('fabula-planning-style')) return;
    const style = document.createElement('style');
    style.id = 'fabula-planning-style';
    style.textContent = `
      .fabula-plan { flex:0 0 auto; margin:10px 10px 8px; padding:10px; border:1px solid var(--c-border-3); border-radius:8px; background:var(--c-card-light); display:grid; gap:9px; }
      .fabula-plan__head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .fabula-plan__title { font-size:13px; font-weight:700; color:var(--c-text-main); }
      .fabula-plan__mini { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color:var(--c-text-muted); }
      .fabula-plan__grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
      .fabula-plan__field { display:grid; gap:4px; min-width:0; }
      .fabula-plan__label { font-size:11.5px; color:var(--c-text-secondary); }
      .fabula-plan__input { width:100%; height:30px; padding:0 8px; border:1px solid var(--c-border-input); border-radius:6px; background:var(--c-white); color:var(--c-text-main); font:12.5px var(--font-ui); outline:none; }
      .fabula-plan__input:focus { border-color:var(--c-accent); }
      .fabula-plan__actions { display:flex; flex-wrap:wrap; gap:7px; }
      .fabula-plan__btn { flex:1 1 96px; height:30px; padding:0 8px; border:1px solid var(--c-border-btn); border-radius:7px; background:var(--c-white); color:var(--c-text-btn); font-size:12.5px; font-weight:600; white-space:nowrap; }
      .fabula-plan__btn:hover { background:var(--c-row-hover); }
      .fabula-plan__btn--primary { border-color:var(--c-accent); background:var(--c-accent); color:var(--c-on-accent); }
      .fabula-plan__btn--primary:hover { background:var(--c-accent-hover); }
      .fabula-plan__btn:disabled { opacity:.55; cursor:not-allowed; }
      .fabula-plan__status { min-height:17px; font-size:11.5px; color:var(--c-text-secondary); line-height:1.45; }
      .fabula-plan__status.is-error { color:var(--c-danger-text); }
      .fabula-plan__status.is-ok { color:var(--c-success-text); }
      .fabula-plan--setup { margin:14px 0 0; padding:14px 16px 13px; gap:10px; border-color:var(--c-border-input); background:var(--c-white); box-shadow:none; }
      .fabula-plan--setup .fabula-plan__title { font-size:15px; }
      .fabula-plan--setup .fabula-plan__mini { font-size:12px; }
      .fabula-plan--setup .fabula-plan__grid { grid-template-columns:1fr 1fr; }
      .fabula-plan--setup .fabula-plan__input { height:36px; font-size:14px; }
      .fabula-plan__toggle { width:100%; min-height:38px; padding:7px 12px; display:flex; align-items:center; justify-content:center; gap:8px; border:1px solid var(--c-border-btn); border-radius:8px; background:var(--c-white); color:var(--c-text-btn); font-size:13.5px; font-weight:650; line-height:1.35; }
      .fabula-plan__toggle:before { content:""; width:13px; height:13px; border:1.5px solid var(--c-checkbox-empty); border-radius:4px; background:var(--c-white); }
      .fabula-plan__toggle.is-on { border-color:var(--c-accent); color:var(--c-accent); background:var(--c-accent-bg); }
      .fabula-plan__toggle.is-on:before { border-color:var(--c-accent); background:var(--c-accent); box-shadow:inset 0 0 0 3px var(--c-accent-bg); }
      .fabula-plan__hint { font-size:11.5px; line-height:1.55; color:var(--c-text-muted); }
      .fabula-autopilot-chat { margin:18px 0 24px; padding:14px 16px; border:1px solid var(--c-accent-border); border-radius:10px; background:var(--c-accent-bg); color:var(--c-text-main); }
      .fabula-autopilot-chat__head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px; }
      .fabula-autopilot-chat__title { font-size:14px; font-weight:700; }
      .fabula-autopilot-chat__phase { font-size:12px; color:var(--c-accent); }
      .fabula-autopilot-chat__summary { font-size:12px; color:var(--c-text-secondary); line-height:1.5; margin-bottom:8px; }
      .fabula-autopilot-chat__items { display:grid; gap:6px; }
      .fabula-autopilot-chat__item { border:1px solid var(--c-border); border-radius:7px; background:var(--c-white); overflow:hidden; }
      .fabula-autopilot-chat__item > summary { cursor:pointer; padding:7px 9px; font-size:12px; color:var(--c-text-secondary); }
      .fabula-autopilot-chat__item > summary::marker { color:var(--c-accent); }
      .fabula-autopilot-chat__content { max-height:360px; overflow:auto; padding:9px; border-top:1px solid var(--c-border-soft); background:var(--c-card-light); color:var(--c-prose); font:12px/1.65 var(--font-mono); white-space:pre-wrap; user-select:text; }
      .fabula-autopilot-chat__item.is-live > summary { color:var(--c-accent); }
      .fabula-autopilot-config-overlay { position:fixed; inset:0; z-index:2200; display:flex; align-items:center; justify-content:center; padding:20px; background:rgba(20,24,32,.34); }
      .fabula-autopilot-config { width:min(760px,100%); max-height:min(82vh,760px); overflow:auto; padding:16px; border:1px solid var(--c-border); border-radius:8px; background:var(--c-white); box-shadow:var(--sh-floatbar); display:grid; gap:12px; }
      .fabula-autopilot-config__head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
      .fabula-autopilot-config__title { font-size:15px; font-weight:700; color:var(--c-text-main); }
      .fabula-autopilot-config__sub { margin-top:4px; font-size:12px; line-height:1.55; color:var(--c-text-secondary); }
      .fabula-autopilot-config__close { width:28px; height:28px; border:1px solid var(--c-border-btn); border-radius:6px; background:var(--c-white); color:var(--c-text-secondary); cursor:pointer; }
      .fabula-autopilot-config__row { display:grid; gap:6px; }
      .fabula-autopilot-config__label { font-size:12px; font-weight:600; color:var(--c-text-main); }
      .fabula-autopilot-config__hint { font-size:11.5px; line-height:1.5; color:var(--c-text-muted); }
      .fabula-autopilot-config__select { width:100%; height:34px; padding:0 9px; border:1px solid var(--c-border-input); border-radius:6px; background:var(--c-white); color:var(--c-text-main); font:12.5px var(--font-ui); }
      .fabula-autopilot-config__skills { max-height:190px; overflow:auto; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; padding:8px; border:1px solid var(--c-border-soft); border-radius:7px; background:var(--c-card-light); }
      .fabula-autopilot-config__skill { min-width:0; display:flex; align-items:flex-start; gap:7px; padding:7px 8px; border:1px solid var(--c-border-soft); border-radius:6px; background:var(--c-white); font-size:12px; color:var(--c-text-main); cursor:pointer; }
      .fabula-autopilot-config__skill input { margin-top:2px; flex:0 0 auto; }
      .fabula-autopilot-config__skill span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .fabula-autopilot-config__foot { display:flex; justify-content:flex-end; gap:8px; padding-top:4px; }
      .fabula-autopilot-config__btn { height:34px; padding:0 14px; border:1px solid var(--c-border-btn); border-radius:6px; background:var(--c-white); color:var(--c-text-btn); font-size:12.5px; font-weight:600; cursor:pointer; }
      .fabula-autopilot-config__btn--primary { border-color:var(--c-accent); background:var(--c-accent); color:var(--c-on-accent); }
      .fabula-autopilot-config__status { font-size:12px; color:var(--c-text-secondary); }
      @media (max-width:720px) { .fabula-autopilot-config-overlay { padding:10px; } .fabula-autopilot-config { max-height:90vh; padding:13px; } .fabula-autopilot-config__skills { grid-template-columns:1fr; } }
      .fabula-global-sessions { margin-top:10px; padding-top:9px; border-top:1px solid var(--c-border-soft); }
      .srail__body { overflow-y:auto !important; -webkit-overflow-scrolling:touch; overscroll-behavior:contain; }
      .fabula-global-sessions__title { padding:0 10px 6px; color:var(--c-text-muted); font-size:11px; }
      .fabula-global-session { position:relative; display:flex; align-items:center; width:100%; padding:0; text-align:left; }
      .fabula-global-session .srail__card-main { flex:1 1 auto; min-width:0; width:auto; min-height:38px; display:flex; align-items:center; gap:10px; padding:7px 8px 7px 12px; border-radius:8px; color:var(--c-text-secondary); text-align:left; }
      .fabula-global-session .srail__card-main:hover { background:var(--c-row-hover); color:var(--c-text-main); }
      .fabula-global-session .srail__card-copy { min-width:0; flex:1 1 auto; }
      .fabula-global-session__delete { flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; min-width:38px; height:26px; margin-right:6px; padding:0 6px; border:1px solid var(--c-border-btn); border-radius:6px; background:var(--c-white); color:var(--c-text-muted); font-size:11px; }
      .fabula-global-session__delete:hover { border-color:var(--c-danger-border); background:var(--c-danger-bg); color:var(--c-danger-text); }
      .fabula-global-session__book { display:block; overflow:hidden; color:var(--c-text-muted); font-size:10.5px; line-height:1.2; text-overflow:ellipsis; white-space:nowrap; }
      .fabula-global-session__name { display:block; overflow:hidden; font-size:13px; line-height:1.35; text-overflow:ellipsis; white-space:nowrap; }
      .booksetup--done[data-fabula-auto] .booksetup__done-foot { display:none !important; }
      .fabula-genre-custom { min-width:180px; height:34px; padding:0 10px 0 12px; display:inline-flex; align-items:center; gap:7px; border:1px solid var(--c-border-btn); border-radius:999px; background:var(--c-white); color:var(--c-text-secondary); box-sizing:border-box; }
      .fabula-genre-custom.is-on { border-color:var(--c-accent); color:var(--c-accent); background:var(--c-accent-bg); }
      .fabula-genre-custom__label { flex:0 0 auto; font-size:13px; font-weight:600; }
      .fabula-genre-custom__input { flex:1 1 auto; min-width:74px; width:104px; border:0; outline:0; background:transparent; color:var(--c-text-main); font:13px var(--font-ui); }
      .fabula-genre-custom__input::placeholder { color:var(--c-text-muted); }
    `;
    document.head.appendChild(style);
  };

  const loadBooks = async () => {
    booksCache = await ipc('list_books', {});
    return Array.isArray(booksCache) ? booksCache : [];
  };

  const activeTitleCandidates = () => [
    document.querySelector('.bookcard.is-active .bookcard__title')?.textContent,
    document.querySelector('.sidebar__back-book')?.textContent,
    document.querySelector('.mshell__title')?.textContent,
  ].map((text) => String(text || '').trim()).filter(Boolean);

  const activeBook = async () => {
    const books = booksCache || await loadBooks();
    if (workspaceBookId) {
      const byId = books.find((book) => book.id === workspaceBookId);
      if (byId) return byId;
    }
    const titles = activeTitleCandidates();
    for (const title of titles) {
      const exact = books.find((book) => book.title === title);
      if (exact) return exact;
      const contained = books.find((book) => title.includes(book.title) || book.title.includes(title));
      if (contained) return contained;
    }
    return books[0] || null;
  };

  const zhNum = (text) => {
    const s = String(text || '').trim();
    if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
    const map = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const unit = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
    let section = 0, number = 0, result = 0;
    for (const ch of s) {
      if (map[ch] != null) number = map[ch];
      else if (unit[ch]) {
        const u = unit[ch];
        if (u === 10000) { result += (section + number) * u; section = 0; }
        else section += (number || 1) * u;
        number = 0;
      } else return 0;
    }
    return result + section + number;
  };

  const chapterNumber = (name) => {
    const m = String(name || '').match(/第\s*([0-9零〇一二三四五六七八九十百千万两]+)\s*章/);
    return m ? zhNum(m[1]) : 0;
  };

  const updateCount = async (panel, bookId, total) => {
    const status = panel.querySelector('.fabula-plan__status');
    if (!bookId || !total) return;
    try {
      const tree = await ipc('scan_tree', { bookId });
      const outline = tree.find((group) => group.groupDir === '细纲') || { files: [] };
      const saved = new Set(outline.files.map((file) => chapterNumber(file.name)).filter(Boolean));
      status.textContent = `已存 ${saved.size} / ${total} 章细纲，缺 ${Math.max(0, total - saved.size)} 章`;
    } catch {}
  };

  const setBusy = (panel, busy) => {
    panel.querySelectorAll('input, button').forEach((el) => { el.disabled = busy; });
  };

  const numberFrom = (panel, field) => Number.parseInt(panel.querySelector(`[data-field="${field}"]`)?.value, 10) || 0;

  const activeBookByCreatedAt = async (since) => {
    const books = await loadBooks();
    const recent = books
      .filter((book) => !since || Number(book.createdAt || 0) >= since - 5000 || Number(book.updatedAt || 0) >= since - 5000)
      .sort((a, b) => Number(b.createdAt || b.updatedAt || 0) - Number(a.createdAt || a.updatedAt || 0));
    return recent[0] || null;
  };

  const hasSetupDocs = async (bookId) => {
    if (!bookId) return false;
    const read = async (name) => {
      const content = await ipc('read_file', { bookId, group: '设定', name }).catch(() => '');
      return String(content || '').trim();
    };
    const [outline, worldview, characters] = await Promise.all([
      read('剧情大纲.md'),
      read('世界观.md'),
      read('人物库.md'),
    ]);
    return outline.length >= 80 && (worldview.length >= 80 || characters.length >= 80);
  };

  const readPendingSetup = () => {
    try { return JSON.parse(sessionStorage.getItem(PENDING_SETUP_KEY) || 'null'); } catch { return null; }
  };

  const writePendingSetup = (value) => {
    try { sessionStorage.setItem(PENDING_SETUP_KEY, JSON.stringify(value)); } catch {}
  };

  const bindPendingSetupBook = (bookId, title = '') => {
    const pending = readPendingSetup();
    if (!pending || !bookId) return;
    if (pending.bookId && String(pending.bookId) !== String(bookId)) return;
    const expectedTitle = String(pending.setupTitle || '').trim();
    const actualTitle = String(title || '').trim();
    if (expectedTitle && actualTitle && expectedTitle !== actualTitle) return;
    pending.bookId = String(bookId);
    if (actualTitle) pending.setupTitle = actualTitle;
    writePendingSetup(pending);
  };

  const clearPendingSetup = () => {
    try { sessionStorage.removeItem(PENDING_SETUP_KEY); } catch {}
  };

  const autoTaskKey = (bookId) => String(bookId || '').trim();

  const beginAutoTask = (bookId) => {
    const key = autoTaskKey(bookId);
    if (!key || autoTaskBooks.has(key)) return false;
    autoTaskBooks.add(key);
    return true;
  };

  const endAutoTask = (bookId) => {
    const key = autoTaskKey(bookId);
    if (!key) return;
    autoTaskBooks.delete(key);
  };

  const syncAutoSetupUi = async () => {
    const done = document.querySelector('.booksetup--done');
    if (!done) return;
    addStyles();
    const pending = readPendingSetup();
    const sameBook = !pending?.bookId || !workspaceBookId || String(pending.bookId) === String(workspaceBookId);
    const auto = !!pending?.autoGenerate && sameBook;
    done.toggleAttribute('data-fabula-auto', auto);
  };

  const recentPendingSetup = () => {
    const pending = readPendingSetup();
    if (!pending) return null;
    const age = Date.now() - Number(pending.createdAt || 0);
    return age >= 0 && age < 2 * 60 * 1000 ? pending : null;
  };

  const creativePositionText = (customGenre) => `【作者已确认的创作定位】
主体题材：${customGenre}
如果前文存在其他主体题材，以这里的「${customGenre}」为准；请直接遵守，不要重复询问题材。`;

  const installCustomGenreFetchPatch = () => {
    if (fetchPatched) return;
    fetchPatched = true;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      let path = '';
      let requestArgs = {};
      try {
        const url = typeof input === 'string' ? input : input?.url;
        path = new URL(url, window.location.href).pathname;
        if (init?.body && typeof init.body === 'string' && path.startsWith('/ipc/')) {
          const payload = JSON.parse(init.body);
          requestArgs = payload.args || {};
          rememberWorkspaceRequest(path, requestArgs);
        }
        const pending = recentPendingSetup();
        const customGenre = String(pending?.customGenre || '').trim();
        if (init?.body && typeof init.body === 'string' && path.startsWith('/ipc/')) {
          const payload = JSON.parse(init.body);
          const args = payload.args || {};
          const setupTitleMatches = !pending?.setupTitle
            || !args.title
            || String(args.title).trim() === String(pending.setupTitle).trim();
          if (customGenre && path === '/ipc/create_book' && !pending?.bookId && setupTitleMatches) {
            args.genre = customGenre;
          }
          if (customGenre && path === '/ipc/chat_stream') {
            const skills = Array.isArray(args.skills) ? args.skills : [];
            const isSetupChat = skills.includes('新书共创') || skills.includes('设定整理');
            const message = String(args.message || '');
            if (isSetupChat && !message.includes(`主体题材：${customGenre}`)) {
              args.message = `${message}\n\n${creativePositionText(customGenre)}`;
            }
          }
          if (customGenre) {
            payload.args = args;
            init = { ...init, body: JSON.stringify(payload) };
          }
        }
      } catch {}
      const setupRequestBookId = path === '/ipc/apply_book_setup' ? String(requestArgs.bookId || '') : '';
      const setupFinalized = path === '/ipc/apply_book_setup' && !!String(requestArgs.title || '').trim();
      return nativeFetch(input, init).then(async (response) => {
        syncWorkspaceResponse(path, requestArgs, response).catch(() => {});
        if (path === '/ipc/create_book' && response.ok) {
          try {
            const created = await parseIpcPacket(response.clone());
            if (created?.id) bindPendingSetupBook(created.id, created.title || requestArgs.title || '');
          } catch {}
        }
        if (setupFinalized && setupRequestBookId && response.ok) {
          const pending = readPendingSetup();
          const boundBookId = String(pending?.bookId || '');
          const titleMatches = pending?.setupTitle
            && requestArgs.title
            && String(pending.setupTitle).trim() === String(requestArgs.title).trim();
          if (pending?.autoGenerate && (boundBookId === setupRequestBookId || (!boundBookId && titleMatches))) {
            pending.bookId = setupRequestBookId;
            pending.running = false;
            pending.waitingForDocs = false;
            writePendingSetup(pending);
            schedulePendingSetup();
            syncAutoSetupUi().catch(() => {});
          }
        }
        if (path !== '/ipc/get_next_chapter_state') return response;
        try {
          const text = await response.clone().text();
          const lines = text.split(/\r?\n/);
          const fixed = lines.map((line) => {
            if (!line.trim()) return line;
            const packet = JSON.parse(line);
            if (typeof packet.r === 'number') packet.r = { targetChapter: packet.r, outlineName: null };
            return JSON.stringify(packet);
          }).join('\n');
          return new Response(fixed, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        } catch {
          return response;
        }
      });
    };
  };

  const toast = (text, kind = 'info') => {
    const old = document.querySelector('.fabula-plan-toast');
    old?.remove();
    const box = document.createElement('div');
    box.className = `fabula-plan-toast fabula-plan-toast--${kind}`;
    box.textContent = text;
    Object.assign(box.style, {
      position: 'fixed',
      left: '50%',
      top: '64px',
      transform: 'translateX(-50%)',
      zIndex: '1400',
      maxWidth: '70vw',
      padding: '9px 14px',
      borderRadius: '8px',
      background: kind === 'error' ? 'var(--c-danger-bg)' : kind === 'success' ? 'var(--c-success-bg)' : 'var(--c-card-light)',
      border: `1px solid ${kind === 'error' ? 'var(--c-danger-border)' : kind === 'success' ? 'var(--c-success-border)' : 'var(--c-border)'}`,
      color: kind === 'error' ? 'var(--c-danger-text)' : kind === 'success' ? 'var(--c-success-text)' : 'var(--c-text-main)',
      boxShadow: 'var(--sh-floatbar)',
      fontSize: '13px',
    });
    document.body.appendChild(box);
    window.setTimeout(() => box.remove(), 3600);
  };

  const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));

  const refreshAutopilotDirectory = async (bookId) => {
    if (!bookId) return null;
    const tree = await ipc('scan_tree', { bookId }).catch(() => null);
    if (!Array.isArray(tree)) return null;
    const esc = window.CSS?.escape || ((value) => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
    const plans = document.querySelectorAll(`.fabula-plan[data-book-id="${esc(bookId)}"]`);
    plans.forEach((panel) => {
      const total = numberFrom(panel, 'total');
      if (total) updateCount(panel, bookId, total).catch(() => {});
    });
    if (workspaceBookId && String(workspaceBookId) !== String(bookId)) return tree;
    // Ask the main app to refresh its store when it supports the event.
    window.dispatchEvent(new CustomEvent('fabula-tree-refresh', { detail: { bookId, tree } }));
    window.dispatchEvent(new Event('focus'));

    // Keep the visible tree useful even while React is between store renders.
    const library = document.querySelector('.library, .filetree');
    if (!library) return tree;
    const totalCount = tree.reduce((sum, group) => sum + (Array.isArray(group.files) ? group.files.length : 0), 0);
    const libraryCount = library.querySelector('.library__count');
    if (libraryCount) libraryCount.textContent = String(totalCount);
    tree.forEach((group) => {
      const label = String(group.label || group.groupDir || group.dir || '').trim();
      if (!label || !Array.isArray(group.files)) return;
      const folder = [...library.querySelectorAll('.folderrow')].find((node) => (
        node.querySelector('.folderrow__label')?.textContent.trim() === label
      ));
      const count = folder?.querySelector('.folderrow__count');
      if (count) count.textContent = String(group.files.length);
      const groupNode = folder?.parentElement?.querySelector('.treegroup');
      if (!groupNode) return;
      const existing = new Set([...groupNode.querySelectorAll('.fileitem__name')].map((node) => node.textContent.trim()));
      const list = groupNode.querySelector('.treegroup__files') || groupNode;
      group.files.forEach((file) => {
        const name = String(file.name || '').trim();
        if (!name || existing.has(name)) return;
        const row = document.createElement('div');
        row.className = 'fileitem fabula-autopilot-fileitem';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'fileitem__open';
        open.title = `${label} / ${name}`;
        const icon = document.createElement('span');
        icon.className = 'fileitem__icon-gray';
        const text = document.createElement('span');
        text.className = 'fileitem__name';
        text.textContent = name;
        open.append(icon, text);
        open.addEventListener('click', () => {
          window.dispatchEvent(new CustomEvent('fabula-open-file', { detail: { bookId, group: label, name } }));
        });
        row.appendChild(open);
        list.appendChild(row);
      });
    });
    return tree;
  };

  const createAutopilotChatReporter = (bookId, totalChapters, titleText = '全 AI 托管生成') => {
    const existing = autopilotReports.get(bookId);
    if (existing) {
      existing.setTitle?.(titleText);
      return existing;
    }
    addStyles();
    const reportSessionId = workspaceSessionId;
    const state = { phase: '准备开始', completed: 0, total: Number(totalChapters || 0), items: new Map(), observer: null };
    const render = () => {
      if (workspaceBookId && String(workspaceBookId) !== String(bookId)) return false;
      if (reportSessionId && workspaceSessionId && String(reportSessionId) !== String(workspaceSessionId)) return false;
      let inner = document.querySelector('.msgscroll__inner');
      if (!inner) return false;
      if (!state.root.isConnected || state.root.parentElement !== inner) inner.appendChild(state.root);
      const scroller = inner.closest('.msgscroll');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      return true;
    };
    const root = document.createElement('div');
    root.className = 'aimsg fabula-autopilot-chat';
    root.dataset.bookId = bookId;
    const body = document.createElement('div');
    body.className = 'aimsg__body';
    const head = document.createElement('div');
    head.className = 'fabula-autopilot-chat__head';
    const title = document.createElement('div');
    title.className = 'fabula-autopilot-chat__title';
    title.textContent = titleText;
    const phase = document.createElement('div');
    phase.className = 'fabula-autopilot-chat__phase';
    phase.textContent = state.phase;
    head.append(title, phase);
    const summary = document.createElement('div');
    summary.className = 'fabula-autopilot-chat__summary';
    summary.textContent = state.total ? `已完成 0 / ${state.total} 章` : '正在准备任务';
    const items = document.createElement('div');
    items.className = 'fabula-autopilot-chat__items';
    body.append(head, summary, items);
    root.appendChild(body);
    state.root = root;
    state.render = render;
    state.setTitle = (text) => { title.textContent = String(text || '全 AI 托管生成'); };
    state.setPhase = (text) => { state.phase = String(text || state.phase); phase.textContent = state.phase; render(); };
    state.item = (key, label, content = '', live = false) => {
      let item = state.items.get(key);
      if (!item) {
        const details = document.createElement('details');
        details.className = 'fabula-autopilot-chat__item';
        if (live) details.classList.add('is-live');
        const caption = document.createElement('summary');
        caption.textContent = label;
        const pre = document.createElement('div');
        pre.className = 'fabula-autopilot-chat__content';
        details.append(caption, pre);
        items.appendChild(details);
        item = { details, caption, pre };
        state.items.set(key, item);
      }
      item.caption.textContent = label;
      item.pre.textContent = String(content || '');
      item.details.classList.toggle('is-live', live);
      return item;
    };
    state.reset = () => {
      state.phase = '准备开始';
      state.completed = 0;
      state.items.clear();
      items.replaceChildren();
      phase.textContent = state.phase;
      summary.textContent = state.total ? `已完成 0 / ${state.total} 章` : '正在准备任务';
      render();
    };
    state.event = (event) => {
      if (!event || typeof event !== 'object') return;
      const index = Number(event.index || 0);
      if (state.total && state.completed >= state.total
        && ((event.type === 'step' && event.kind === 'body') || event.type === 'delta')) {
        state.setPhase('本阶段已完成');
        summary.textContent = `本阶段完成 ${state.total} 章，已保存到目录`;
        state.items.forEach((item) => {
          item.details.classList.remove('is-live');
          item.caption.textContent = item.caption.textContent.replace('（生成中）', '');
        });
        render();
        return;
      }
      if (event.type === 'step') {
        state.setPhase(event.title || (event.kind === 'body' ? '正在生成正文' : '正在生成细纲'));
        if (event.kind === 'done' && event.name) {
          const group = state.phase.includes('正文') || event.title?.includes('正文') ? '正文' : '细纲';
          const key = `${group}/${event.name}`;
          state.item(key, `${group} · ${event.name}`, '正在读取已保存内容…');
          refreshAutopilotDirectory(bookId).catch(() => {});
          ipc('read_file', { bookId, group, name: event.name }).then((content) => {
            let text = String(content || '');
            if (group === '细纲') {
              try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {}
            }
            const savedItem = state.item(key, `${group} · ${event.name}`, text);
            savedItem.details.open = true;
            refreshAutopilotDirectory(bookId).catch(() => {});
          }).catch(() => {});
          state.completed = Math.max(state.completed, index);
          summary.textContent = state.total ? `已完成 ${state.completed} / ${state.total} 章` : `已完成第 ${index} 章`;
        } else if (event.kind === 'skip' && index) {
          state.completed = Math.max(state.completed, index);
          summary.textContent = state.total ? `已完成 ${state.completed} / ${state.total} 章` : `已完成第 ${index} 章`;
        }
      } else if (event.type === 'delta' && index) {
        if (state.total && state.completed >= state.total) {
          state.setPhase('本阶段已完成');
          summary.textContent = `本阶段完成 ${state.total} 章，已保存到目录`;
          state.items.forEach((item) => {
            item.details.classList.remove('is-live');
            item.caption.textContent = item.caption.textContent.replace('（生成中）', '');
          });
          render();
          return;
        }
        const key = `正文/第${index}章.md`;
        const previous = state.items.get(key)?.pre.textContent || '';
        const delta = String(event.text || '').replace(/<\|(?:eos|endoftext|im_end|end)\|>/gi, '');
        state.item(key, `正文 · 第${index}章（生成中）`, previous + delta, true);
        state.setPhase(`正在生成第${index}章正文`);
      } else if (event.type === 'done') {
        state.setPhase('本阶段已完成');
        if (Array.isArray(event.created)) summary.textContent = `本阶段完成 ${event.created.length} 章，已保存到目录`;
        refreshAutopilotDirectory(bookId).catch(() => {});
      }
      render();
    };
    state.finish = (result, label = '本阶段已完成') => {
      const created = Array.isArray(result?.created) ? result.created.length : 0;
      const skipped = Array.isArray(result?.skipped) ? result.skipped.length : 0;
      const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
      state.completed = Math.min(state.total || Number.MAX_SAFE_INTEGER, Math.max(state.completed, created + skipped));
      state.setPhase(label);
      summary.textContent = failed
        ? `本阶段完成 ${created + skipped} 章，${failed} 章失败`
        : `本阶段完成 ${created + skipped} 章，已保存到目录`;
      render();
    };
    state.observer = new MutationObserver(() => { if (!state.root.isConnected) render(); });
    state.observer.observe(document.body, { childList: true, subtree: true });
    autopilotReports.set(bookId, state);
    render();
    return state;
  };

  const applyPendingSetup = async () => {
    const pending = readPendingSetup();
    if (!pending) return;
    // running 只对当前页面实例有效；刷新后旧令牌失效，允许任务恢复。
    if (pending.running && pending.runnerToken !== pendingSetupRunToken) {
      pending.running = false;
      delete pending.runnerToken;
      writePendingSetup(pending);
    }
    if (pending.running) return;
    const elapsed = Date.now() - Number(pending.createdAt || 0);
    if (elapsed > 24 * 60 * 60 * 1000) {
      clearPendingSetup();
      return;
    }
    const books = await loadBooks();
    const book = pending.bookId
      ? books.find((item) => item.id === pending.bookId)
      : (() => {
        const title = String(pending.setupTitle || '').trim();
        if (!title) return null;
        return books
          .filter((item) => item.title === title && Number(item.createdAt || 0) >= Number(pending.createdAt || 0) - 1000)
          .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))[0] || null;
      })();
    if (!book?.id) {
      schedulePendingSetup();
      return;
    }
    if (pending.waitingForDocs) {
      const ready = await hasSetupDocs(book.id).catch(() => false);
      if (!ready) {
        schedulePendingSetup(15000);
        return;
      }
      pending.waitingForDocs = false;
      writePendingSetup(pending);
    }
    pending.bookId = book.id;
    pending.running = true;
    pendingSetupRunToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pending.runnerToken = pendingSetupRunToken;
    writePendingSetup(pending);
    let locked = false;
    try {
      if (pending.totalChapters || pending.chapterWords) {
        await ipc('set_book_plan_settings', {
          bookId: book.id,
          totalChapters: pending.totalChapters,
          chapterWords: pending.chapterWords,
        });
      }
      if (pending.customGenre) {
        await ipc('set_settings', { [`book_genre__${book.id}`]: pending.customGenre }).catch(() => {});
        await ipc('update_book_meta', { bookId: book.id, genre: pending.customGenre }).catch(() => {});
      }
      if (!pending.autoGenerate) {
        clearPendingSetup();
        toast(pending.totalChapters || pending.chapterWords ? '章节计划已保存到新书' : '自定义题材已保存到新书', 'success');
        return;
      }
      const reporter = createAutopilotChatReporter(book.id, pending.totalChapters, '全 AI 托管生成');
      reporter.reset?.();
      reporter.setPhase('等待设定资料就绪');
      toast('已记录自动滚动规划与正文生成：等设定入库后开始', 'info');
      const until = Date.now() + 8 * 60 * 1000;
      while (Date.now() < until) {
        const current = readPendingSetup();
        if (!current || current.runnerToken !== pending.runnerToken) return;
        if (await hasSetupDocs(book.id).catch(() => false)) break;
        await new Promise((resolve) => window.setTimeout(resolve, 5000));
      }
      if (!await hasSetupDocs(book.id).catch(() => false)) {
        pending.running = false;
        pending.waitingForDocs = true;
        writePendingSetup(pending);
        toast('整书计划已保存；设定入库后会自动滚动规划并逐章生成正文', 'info');
        return;
      }
      const currentPending = readPendingSetup();
      if (!currentPending || currentPending.runnerToken !== pending.runnerToken) return;
      if (!beginAutoTask(book.id)) {
        pending.running = false;
        writePendingSetup(pending);
        schedulePendingSetup(5000);
        return;
      }
      locked = true;
      const result = await ipcStream('batch_generate_full', {
        bookId: book.id,
        totalChapters: pending.totalChapters,
        chapterWords: pending.chapterWords,
        onEvent: `fabula-setup-${Date.now().toString(36)}`,
      }, (e) => {
        reporter.event(e);
        if (e.type === 'step') toast(e.title || '正在执行全 AI 托管...', 'info');
      });
      if (!result || !Array.isArray(result.created)) {
        throw new Error('全 AI 托管未返回有效结果，请重试');
      }
      const failed = result?.failed?.length || 0;
      if (failed) {
        const failedPhase = result.phase === 'outline' ? '细纲' : '正文';
        reporter.finish(result.phase === 'outline' ? result.outline : result, `${failedPhase}生成未完成`);
        clearPendingSetup();
        toast(`${failedPhase}生成未完成：${failed} 章失败，已退出自动模式，请用「全 AI 托管」重试`, 'error');
        return;
      }
      reporter.finish(result, '全 AI 托管已完成');
      clearPendingSetup();
      toast(`自动写作完成（正文新增 ${result.created.length} 章）`, 'success');
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      clearPendingSetup();
      toast(error instanceof Error ? error.message : '自动生成细纲失败', 'error');
    } finally {
      if (locked) endAutoTask(book.id);
    }
  };

  const schedulePendingSetup = (delay = 1200) => {
    if (pendingSetupTimer) return;
    pendingSetupTimer = window.setTimeout(() => {
      pendingSetupTimer = null;
      applyPendingSetup().catch(() => {});
    }, delay);
  };

  const saveSettings = async (panel, bookId) => {
    const total = numberFrom(panel, 'total');
    const words = numberFrom(panel, 'words');
    const status = panel.querySelector('.fabula-plan__status');
    status.className = 'fabula-plan__status';
    if (!total) throw new Error('请先填写总章节数');
    if (!words) throw new Error('请先填写每章字数');
    let saved = await ipc('set_book_plan_settings', { bookId, totalChapters: total, chapterWords: words });
    if (!saved) {
      await ipc('set_settings', {
        [`book_total_chapters__${bookId}`]: String(total),
        [`book_chapter_words__${bookId}`]: String(words),
      });
      saved = { totalChapters: total, chapterWords: words };
    }
    status.classList.add('is-ok');
    status.textContent = '设置已保存';
    window.setTimeout(() => updateCount(panel, bookId, saved.totalChapters), 450);
    return saved;
  };

  const saveOptionalSettings = async (panel, bookId) => {
    const total = numberFrom(panel, 'total');
    const words = numberFrom(panel, 'words');
    if (!total && !words) return null;
    return saveSettings(panel, bookId);
  };

  const sendOutlinePromptToChat = (chapterNum) => {
    const text = `我想写第${chapterNum}章，先基于前文问我几个关键走向问题，我选定后再生成第${chapterNum}章细纲。`;
    const textarea = document.querySelector('.dock__textarea, .mdock__input');
    if (!textarea) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(textarea, text);
    else textarea.value = text;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    textarea.focus();
    window.setTimeout(() => {
      const send = document.querySelector('.dock__send, .mdock__send');
      if (send && !send.disabled) send.click();
    }, 80);
    return true;
  };

  const readBookPlan = async (bookId) => {
    let plan = await ipc('get_book_plan_settings', { bookId }).catch(() => null);
    if (plan?.totalChapters && plan?.chapterWords) return plan;
    const settings = await ipc('get_settings', {});
    return {
      totalChapters: Number.parseInt(settings?.[`book_total_chapters__${bookId}`], 10) || Number(plan?.totalChapters) || 0,
      chapterWords: Number.parseInt(settings?.[`book_chapter_words__${bookId}`], 10) || Number(plan?.chapterWords) || 0,
    };
  };

  const openAutopilotConfig = async (bookId, button) => {
    if (!bookId || document.querySelector('.fabula-autopilot-config-overlay')) return;
    let skills = [];
    let style = null;
    let meta = null;
    try {
      [skills, style, meta] = await Promise.all([
        ipc('list_skills', {}),
        ipc('get_book_style', { bookId }),
        ipc('get_book_meta', { bookId }),
      ]);
    } catch (error) {
      toast(error instanceof Error ? error.message : '读取写作配置失败', 'error');
      return;
    }
    addStyles();
    const overlay = document.createElement('div');
    overlay.className = 'fabula-autopilot-config-overlay';
    const panel = document.createElement('div');
    panel.className = 'fabula-autopilot-config';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.innerHTML = `
      <div class="fabula-autopilot-config__head">
        <div>
          <div class="fabula-autopilot-config__title">全 AI 托管 · 写作配置</div>
          <div class="fabula-autopilot-config__sub">本次生成会使用你选中的文风卡和技能。配置会保存到本书，之后也可以继续修改。</div>
        </div>
        <button type="button" class="fabula-autopilot-config__close" aria-label="关闭">×</button>
      </div>
      <div class="fabula-autopilot-config__row">
        <label class="fabula-autopilot-config__label" for="fabula-auto-style">文风卡</label>
        <select id="fabula-auto-style" class="fabula-autopilot-config__select"></select>
        <div class="fabula-autopilot-config__hint">选择你蒸馏出来的文风，或使用自动跟随题材。</div>
      </div>
      <div class="fabula-autopilot-config__row">
        <label class="fabula-autopilot-config__label" for="fabula-auto-primary">主写法</label>
        <select id="fabula-auto-primary" class="fabula-autopilot-config__select"></select>
        <div class="fabula-autopilot-config__hint">主写法决定这本书的主要创作方法，可留空使用官方默认。</div>
      </div>
      <div class="fabula-autopilot-config__row">
        <div class="fabula-autopilot-config__label">叠加技能</div>
        <div class="fabula-autopilot-config__skills"></div>
        <div class="fabula-autopilot-config__hint">最多选择 6 个；它们会和主写法一起进入全书规划、细纲和正文生成。</div>
      </div>
      <div class="fabula-autopilot-config__status" role="status"></div>
      <div class="fabula-autopilot-config__foot">
        <button type="button" class="fabula-autopilot-config__btn" data-act="cancel">取消</button>
        <button type="button" class="fabula-autopilot-config__btn fabula-autopilot-config__btn--primary" data-act="start">开始全 AI 托管</button>
      </div>
    `;
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const styleSelect = panel.querySelector('#fabula-auto-style');
    const primarySelect = panel.querySelector('#fabula-auto-primary');
    const skillsBox = panel.querySelector('.fabula-autopilot-config__skills');
    const status = panel.querySelector('.fabula-autopilot-config__status');
    const start = panel.querySelector('[data-act="start"]');
    const addOption = (select, value, label) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    };
    const enabled = (Array.isArray(skills) ? skills : []).filter((skill) => skill && skill.enabled !== false);
    const styleSkills = enabled.filter((skill) => skill.kind === 'style');
    const workSkills = enabled.filter((skill) => skill.kind !== 'style' &&
      !/humanize|去味/i.test(`${skill.builtinKey || ''} ${skill.name || ''}`));
    addOption(styleSelect, 'auto', '自动 · 跟随题材');
    addOption(styleSelect, 'off', '不使用文风卡');
    for (const skill of styleSkills) addOption(styleSelect, `style:${skill.id}`, `文风 · ${skill.name}`);
    const currentStyle = style && style.key ? String(style.key) : 'auto';
    if (currentStyle && !Array.from(styleSelect.options).some((option) => option.value === currentStyle)) {
      addOption(styleSelect, currentStyle, style.resolvedName || '当前文风');
    }
    styleSelect.value = currentStyle;

    addOption(primarySelect, '', '不指定 · 使用官方默认');
    for (const skill of workSkills) addOption(primarySelect, skill.id, skill.name);
    primarySelect.value = meta && meta.primarySkill ? String(meta.primarySkill) : '';

    const selectedSupport = new Set((meta && Array.isArray(meta.supportSkills) ? meta.supportSkills : []).map(String));
    const renderSupport = () => {
      skillsBox.replaceChildren();
      const primary = primarySelect.value;
      const candidates = workSkills.filter((skill) => skill.id !== primary);
      if (!candidates.length) {
        const empty = document.createElement('div');
        empty.className = 'fabula-autopilot-config__hint';
        empty.textContent = '暂无可用叠加技能';
        skillsBox.appendChild(empty);
        return;
      }
      for (const skill of candidates) {
        const label = document.createElement('label');
        label.className = 'fabula-autopilot-config__skill';
        label.title = skill.description || skill.name || '';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = skill.id;
        input.checked = selectedSupport.has(String(skill.id));
        input.addEventListener('change', () => {
          if (input.checked && selectedSupport.size >= 6) {
            input.checked = false;
            status.textContent = '叠加技能最多选择 6 个';
            return;
          }
          if (input.checked) selectedSupport.add(String(skill.id));
          else selectedSupport.delete(String(skill.id));
        });
        const text = document.createElement('span');
        text.textContent = skill.name || '未命名技能';
        label.append(input, text);
        skillsBox.appendChild(label);
      }
    };
    renderSupport();
    primarySelect.addEventListener('change', () => {
      selectedSupport.delete(String(primarySelect.value));
      renderSupport();
    });

    const close = () => overlay.remove();
    panel.querySelector('.fabula-autopilot-config__close').addEventListener('click', close);
    panel.querySelector('[data-act="cancel"]').addEventListener('click', close);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) close(); });
    start.addEventListener('click', async () => {
      start.disabled = true;
      status.textContent = '正在保存写作配置...';
      try {
        await ipc('set_book_style', { bookId, key: styleSelect.value });
        await ipc('set_book_primary_skill', { bookId, skillId: primarySelect.value || null });
        await ipc('set_book_support_skills', { bookId, skillIds: [...selectedSupport] });
        close();
        await runFullAiHosted(bookId, button);
      } catch (error) {
        start.disabled = false;
        status.textContent = error instanceof Error ? error.message : '保存写作配置失败';
      }
    });
  };

  const runFullAiHosted = async (bookId, button) => {
    if (!bookId) return;
    if (autoTaskBooks.has(autoTaskKey(bookId))) {
      toast('该作品已有自动任务正在运行，请等待当前任务结束', 'info');
      return;
    }
    const original = button.textContent;
    const originalTitle = button.title;
    let reporter = null;
    let locked = false;
    button.disabled = true;
    try {
      const plan = await readBookPlan(bookId);
      if (!plan.totalChapters || !plan.chapterWords) {
        throw new Error('请先在章节计划中填写总章节数和每章字数');
      }
      if (!await hasSetupDocs(bookId)) {
        throw new Error('请先完成 AI 共创并保存世界观、人物库和剧情大纲，再启动全 AI 托管');
      }
      const tree = await ipc('scan_tree', { bookId });
      const bodyGroup = tree.find((group) => group.groupDir === '正文') || { files: [] };
      const existingBodies = bodyGroup.files.filter((file) => chapterNumber(file.name)).length;
      const confirmed = window.confirm([
        `将按 ${plan.totalChapters} 章计划滚动规划，并逐章补齐细纲和正文。`,
        existingBodies ? `已有 ${existingBodies} 章正文会原样保留，不会自动覆盖。` : '',
        '任务运行期间请保持页面打开。是否继续？',
      ].filter(Boolean).join('\n'));
      if (!confirmed) return;
      if (!beginAutoTask(bookId)) {
        toast('该作品已有自动任务正在运行，请等待当前任务结束', 'info');
        return;
      }
      locked = true;
      activeAutopilotBookId = String(bookId);
      button.title = '运行中，点击可停止；已完成章节会保留';
      const pending = readPendingSetup();
      if (pending && (!pending.bookId || String(pending.bookId) === String(bookId))) clearPendingSetup();
      const channel = `fabula-autopilot-${Date.now().toString(36)}`;
      reporter = createAutopilotChatReporter(bookId, plan.totalChapters, '全 AI 托管生成');
      reporter.reset?.();
      reporter.setPhase('正在生成当前滚动规划');
      button.textContent = '正在生成当前滚动规划';
      toast(`全 AI 托管已启动：按 20 章滚动规划，并逐章生成细纲与正文（共 ${plan.totalChapters} 章）`, 'info');
      const result = await ipcStream('batch_generate_full', {
        bookId,
        totalChapters: plan.totalChapters,
        chapterWords: plan.chapterWords,
        onEvent: channel,
      }, (event) => {
        reporter.event(event);
        if (event.type === 'step') button.textContent = event.title || '正在执行全 AI 托管';
      });
      if (!result || !Array.isArray(result.created)) {
        throw new Error('全 AI 托管未返回有效结果，请重试');
      }
      if (result.failed?.length) {
        const phase = result.phase === 'outline' ? '细纲' : '正文';
        reporter.finish(result.phase === 'outline' ? result.outline : result, `${phase}生成未完成`);
        throw new Error(`有 ${result.failed.length} 章${phase}生成失败，已完成章节已保留`);
      }
      reporter.finish(result, '全 AI 托管已完成');
      button.textContent = '全 AI 托管已完成';
      toast(`全 AI 托管完成：新增 ${result.created.length} 章正文，已写入小说正文`, 'success');
      window.setTimeout(() => window.location.reload(), 900);
    } catch (error) {
      if (reporter && reporter.phase && reporter.phase.includes('正在生成')) {
        reporter.setPhase('任务未完成');
      }
      button.textContent = original;
      toast(error instanceof Error ? error.message : '全 AI 托管失败，请重试', 'error');
    } finally {
      if (locked) endAutoTask(bookId);
      if (String(activeAutopilotBookId) === String(bookId)) activeAutopilotBookId = '';
      button.title = originalTitle;
      button.disabled = false;
    }
  };

  const injectAutopilotButton = () => {
    addStyles();
    document.querySelectorAll('.dock__next, .mdock__next').forEach((nextButton) => {
      const parent = nextButton.parentElement;
      if (!parent || parent.querySelector('.fabula-autopilot-btn')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fabula-autopilot-btn';
      button.textContent = '全 AI 托管';
      button.title = '补齐全书缺失细纲与正文；已有正文会保留，不自动覆盖';
      parent.insertBefore(button, nextButton.nextSibling);
    });
  };

  const buildPanel = async (library) => {
    addStyles();
    const book = await activeBook();
    if (!book) return null;
    let panel = Array.from(library.children).find((el) => (
      el.classList?.contains('fabula-plan') && !el.classList.contains('fabula-plan--setup')
    ));
    if (panel && panel.dataset.bookId === book.id) return panel;
    panel?.remove();

    panel = document.createElement('section');
    panel.className = 'fabula-plan';
    panel.dataset.bookId = book.id;
    const safeBookTitle = escapeHtml(book.title || '');
    panel.innerHTML = `
      <div class="fabula-plan__head">
        <span class="fabula-plan__title">章节计划</span>
        <span class="fabula-plan__mini" title="${safeBookTitle}">${safeBookTitle}</span>
      </div>
      <div class="fabula-plan__grid">
        <label class="fabula-plan__field">
          <span class="fabula-plan__label">总章节</span>
          <input class="fabula-plan__input" data-field="total" type="number" min="1" max="5000" inputmode="numeric" placeholder="120">
        </label>
        <label class="fabula-plan__field">
          <span class="fabula-plan__label">每章字数</span>
          <input class="fabula-plan__input" data-field="words" type="number" min="200" max="50000" step="100" inputmode="numeric" placeholder="3000">
        </label>
      </div>
      <div class="fabula-plan__actions">
        <button class="fabula-plan__btn" type="button" data-action="save">保存</button>
        <button class="fabula-plan__btn" type="button" data-action="outline">继续写细纲</button>
        <button class="fabula-plan__btn fabula-plan__btn--primary" type="button" data-action="auto" title="只补齐缺失细纲，不会生成正文">补齐缺失细纲</button>
      </div>
      <div class="fabula-plan__status" role="status"></div>
    `;

    const head = library.querySelector('.library__head');
    if (head) head.after(panel);
    else library.prepend(panel);

    try {
      let plan = await ipc('get_book_plan_settings', { bookId: book.id });
      if (!plan) {
        const settings = await ipc('get_settings', {});
        plan = {
          totalChapters: Number.parseInt(settings[`book_total_chapters__${book.id}`], 10) || 0,
          chapterWords: Number.parseInt(settings[`book_chapter_words__${book.id}`], 10) || 0,
        };
      }
      panel.querySelector('[data-field="total"]').value = plan.totalChapters || '';
      panel.querySelector('[data-field="words"]').value = plan.chapterWords || '';
      updateCount(panel, book.id, plan.totalChapters);
    } catch (error) {
      const status = panel.querySelector('.fabula-plan__status');
      status.classList.add('is-error');
      status.textContent = error instanceof Error ? error.message : '读取计划失败';
    }
    return panel;
  };

  const isBringSettingsModal = (modal) => {
    const title = modal.querySelector('.modal__title')?.textContent.trim() || '';
    return title.includes('我有设定') || title.includes('带稿共建');
  };

  const isAiCocreateModal = (modal) => {
    const title = modal.querySelector('.modal__title')?.textContent.trim() || '';
    if (!title.includes('开启新书')) return false;
    const activeTab = modal.querySelector('.nb__mode[aria-selected="true"], .nb__mode.is-on');
    return (activeTab?.textContent || '').includes('AI 共创');
  };

  const isSetupModal = (modal) => isBringSettingsModal(modal) || isAiCocreateModal(modal);

  const setupCopy = (modal) => isAiCocreateModal(modal)
    ? {
      mini: '共创前先定容量',
      auto: '共创完成后自动滚动规划并逐章生成正文',
      hint: '开启后，会按当前章节窗口滚动规划，再逐章补齐细纲、生成正文并归档摘要与伏笔；已完成章节会保留，可随时中断后续写。',
    }
    : {
      mini: '整理前先定容量',
      auto: '整理后自动滚动规划并逐章生成正文',
      hint: '开启后，会在资料库整理入库后按当前窗口滚动规划，再逐章补齐细纲、生成正文并归档；已完成章节会保留，可随时中断后续写。',
    };

  const rowLabelText = (row) => row?.querySelector('.nbopt__rowlabel')?.textContent.trim() || '';

  const customGenreFrom = (root) => {
    const input = root?.querySelector('.fabula-genre-custom__input');
    const value = String(input?.value || '').trim();
    return value || String(root ? customGenreCache.get(root) || '' : '').trim();
  };

  const updateCustomGenreUi = (modal, input) => {
    const value = String(input.value || '').trim();
    customGenreCache.set(modal, value);
    const pill = input.closest('.fabula-genre-custom');
    pill?.classList.toggle('is-on', !!value);
    if (value) {
      const row = pill?.closest('.nbopt__row');
      row?.querySelectorAll('.nbopt__chip.is-on').forEach((chip) => chip.classList.remove('is-on'));
      const summary = modal.querySelector('.nbopt__summary');
      if (summary) summary.textContent = value;
    }
  };

  const injectCustomGenre = (modal) => {
    const row = Array.from(modal.querySelectorAll('.nbopt__row')).find((item) => rowLabelText(item) === '题材');
    const chips = row?.querySelector('.nbopt__chips');
    if (!chips || chips.querySelector('.fabula-genre-custom')) return;
    addStyles();
    const pill = document.createElement('label');
    pill.className = 'fabula-genre-custom';
    pill.innerHTML = `
      <span class="fabula-genre-custom__label">自定义</span>
      <input class="fabula-genre-custom__input" type="text" maxlength="24" placeholder="输入题材">
    `;
    chips.appendChild(pill);
    const input = pill.querySelector('.fabula-genre-custom__input');
    input.value = customGenreCache.get(modal) || '';
    updateCustomGenreUi(modal, input);
    input.addEventListener('input', () => updateCustomGenreUi(modal, input));
    input.addEventListener('focus', () => updateCustomGenreUi(modal, input));
  };

  const setupAnchor = (modal) => (
    isAiCocreateModal(modal)
      ? modal.querySelector('.nbopt') || modal.querySelector('#nb-title')?.closest('.nb__field') || modal.querySelector('.modal__plainlink')
      : modal.querySelector('.nbopt') || modal.querySelector('#bs-title')?.closest('.nb__field')
  );

  const placeSetupPanel = (modal, panel) => {
    const anchor = setupAnchor(modal);
    if (anchor && panel.previousElementSibling !== anchor) {
      anchor.after(panel);
      return;
    }
    const foot = modal.querySelector('.modal__foot');
    if (!anchor && foot && panel.nextElementSibling !== foot) foot.before(panel);
  };

  const removeSetupPanel = () => {
    document.querySelectorAll('.modal .fabula-plan--setup').forEach((panel) => panel.remove());
  };

  const updateSetupPanelCopy = (modal, panel) => {
    const copy = setupCopy(modal);
    const mini = panel.querySelector('.fabula-plan__mini');
    const toggle = panel.querySelector('.fabula-plan__toggle');
    const hint = panel.querySelector('.fabula-plan__hint');
    if (mini && mini.textContent !== copy.mini) mini.textContent = copy.mini;
    if (toggle && toggle.textContent !== copy.auto) toggle.textContent = copy.auto;
    if (hint && hint.textContent !== copy.hint) hint.textContent = copy.hint;
  };

  const buildSetupPanel = (modal) => {
    if (!isSetupModal(modal)) return;
    document.querySelectorAll('.modal .fabula-plan--setup').forEach((panel) => {
      if (panel.closest('.modal') !== modal) panel.remove();
    });
    const existing = modal.querySelector('.fabula-plan--setup');
    if (existing) {
      updateSetupPanelCopy(modal, existing);
      placeSetupPanel(modal, existing);
      return;
    }
    addStyles();
    const copy = setupCopy(modal);
    const panel = document.createElement('section');
    panel.className = 'fabula-plan fabula-plan--setup';
    panel.innerHTML = `
      <div class="fabula-plan__head">
        <span class="fabula-plan__title">章节计划</span>
        <span class="fabula-plan__mini">${copy.mini}</span>
      </div>
      <div class="fabula-plan__grid">
        <label class="fabula-plan__field">
          <span class="fabula-plan__label">总章节</span>
          <input class="fabula-plan__input" data-field="total" type="number" min="1" max="5000" inputmode="numeric" placeholder="120">
        </label>
        <label class="fabula-plan__field">
          <span class="fabula-plan__label">每章字数</span>
          <input class="fabula-plan__input" data-field="words" type="number" min="200" max="50000" step="100" inputmode="numeric" placeholder="3000">
        </label>
      </div>
      <button class="fabula-plan__toggle" type="button" data-auto="0" aria-pressed="false">${copy.auto}</button>
      <div class="fabula-plan__hint">${copy.hint}</div>
      <div class="fabula-plan__status" role="status"></div>
    `;
    placeSetupPanel(modal, panel);
  };

  const injectSetup = () => {
    const modal = Array.from(document.querySelectorAll('.modal')).find((item) => isSetupModal(item));
    if (modal) {
      injectCustomGenre(modal);
      buildSetupPanel(modal);
    }
    else removeSetupPanel();
    syncAutoSetupUi().catch(() => {});
    if (readPendingSetup()) schedulePendingSetup();
  };

  const inject = () => {
    if (injecting) return;
    const library = document.querySelector('.body__side--right .library') || document.querySelector('.library');
    if (!library) return;
    injecting = true;
    buildPanel(library).finally(() => { injecting = false; });
  };

  document.addEventListener('click', async (event) => {
    const genreChip = event.target.closest('.nbopt__chip');
    if (genreChip) {
      const row = genreChip.closest('.nbopt__row');
      const modal = genreChip.closest('.modal');
      if (rowLabelText(row) === '题材' && modal) {
        const input = modal.querySelector('.fabula-genre-custom__input');
        if (input) {
          input.value = '';
          updateCustomGenreUi(modal, input);
        }
      }
    }

    const toggle = event.target.closest('.fabula-plan__toggle');
    if (toggle) {
      event.preventDefault();
      event.stopPropagation();
      const next = toggle.dataset.auto !== '1';
      toggle.dataset.auto = next ? '1' : '0';
      toggle.classList.toggle('is-on', next);
      toggle.setAttribute('aria-pressed', String(next));
      return;
    }

    const leadEntry = event.target.closest('.booksetup--done .booksetup__done-foot button');
    if (leadEntry) {
      const pending = readPendingSetup();
      const managed = !!pending?.autoGenerate
        && !!pending.bookId
        && String(pending.bookId) === String(workspaceBookId);
      if (managed) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toast('自动模式正在按章节滚动规划并生成正文，请等待任务完成', 'info');
        schedulePendingSetup();
        return;
      }
    }

    const autopilot = event.target.closest('.fabula-autopilot-btn');
    if (autopilot) {
      event.preventDefault();
      event.stopImmediatePropagation();
      activeBook().then((book) => {
        const bookId = book?.id || workspaceBookId;
        if (activeAutopilotBookId && String(activeAutopilotBookId) === String(bookId)) {
          return ipc('cancel_batch', { bookId }).then(() => {
            toast('正在停止全 AI 托管，已完成章节会保留', 'info');
          });
        }
        return openAutopilotConfig(bookId, autopilot);
      }).catch((error) => {
        toast(error instanceof Error ? error.message : '无法读取当前作品', 'error');
      });
      return;
    }

    const nextWriting = event.target.closest('.dock__next, .mdock__next');
    if (nextWriting) {
      const pending = readPendingSetup();
      const managed = !!pending?.autoGenerate
        && !!pending.bookId
        && String(pending.bookId) === String(workspaceBookId);
      if (managed) {
        if (pending.waitingForDocs) {
          const exitAuto = window.confirm('全 AI 托管正在等待设定资料。是否退出自动模式并改为手动写作？');
          if (exitAuto) {
            clearPendingSetup();
            toast('已退出全 AI 托管，可继续手动写作', 'success');
            return;
          }
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        toast(pending.waitingForDocs
          ? '正在等待设定资料入库，完成后会自动继续'
          : '自动模式正在按章节滚动规划并生成正文，请等待任务完成', 'info');
        schedulePendingSetup();
        return;
      }
    }

    const start = event.target.closest('.modal__primary');
    const setupModal = start?.closest('.modal');
    if (start && setupModal && isSetupModal(setupModal) && /开始整理|开始共创/.test(start.textContent)) {
      const panel = setupModal.querySelector('.fabula-plan--setup');
      if (panel) {
        const total = numberFrom(panel, 'total');
        const words = numberFrom(panel, 'words');
        const customGenre = customGenreFrom(setupModal);
        const autoGenerate = panel.querySelector('.fabula-plan__toggle')?.dataset.auto === '1';
        const setupTitle = setupModal.querySelector('#nb-title, #bs-title')?.value?.trim() || '';
        const status = panel.querySelector('.fabula-plan__status');
        status.className = 'fabula-plan__status';
        if ((total || words || autoGenerate) && (!total || !words)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          status.classList.add('is-error');
          status.textContent = isAiCocreateModal(setupModal)
            ? '填写总章节和每章字数后再开始共创'
            : '填写总章节和每章字数后再开始整理';
          return;
        }
        if ((total && words) || customGenre) {
          writePendingSetup({
            totalChapters: total,
            chapterWords: words,
            autoGenerate,
            customGenre,
            setupTitle,
            createdAt: Date.now(),
            running: false,
          });
          status.classList.add('is-ok');
          status.textContent = autoGenerate
            ? '已记下：资料入库后按章节滚动规划并生成正文'
            : customGenre && !total && !words
              ? '已记下：创建新书后保存自定义题材'
              : '已记下：创建新书后保存计划';
          schedulePendingSetup();
        } else {
          clearPendingSetup();
        }
      }
    }

    const button = event.target.closest('.fabula-plan__btn');
    if (!button) return;
    const panel = button.closest('.fabula-plan');
    const bookId = panel?.dataset.bookId;
    const status = panel?.querySelector('.fabula-plan__status');
    if (!panel || !bookId || !status) return;
    event.preventDefault();
    event.stopPropagation();
    status.className = 'fabula-plan__status';
    setBusy(panel, true);
    let autoLocked = false;
    try {
      const action = button.dataset.action;
      const saved = action === 'outline' ? await saveOptionalSettings(panel, bookId) : await saveSettings(panel, bookId);
      if (action === 'outline') {
        const next = await ipc('get_next_section_state', { bookId });
        const chapterNum = typeof next === 'number' ? next : Number(next?.targetChapter || next?.chapterNum || 1);
        if (!sendOutlinePromptToChat(chapterNum)) {
          throw new Error('找不到聊天输入框，请先切换到聊天视图后重试');
        }
        status.classList.add('is-ok');
        status.textContent = `已回到第${chapterNum}章细纲询问流程`;
        setBusy(panel, false);
        return;
      }
      if (action === 'auto') {
        const tree = await ipc('scan_tree', { bookId });
        const outline = tree.find((group) => group.groupDir === '细纲') || { files: [] };
        const savedNums = new Set(outline.files.map((file) => chapterNumber(file.name)).filter(Boolean));
        const missing = Math.max(0, saved.totalChapters - savedNums.size);
        if (missing > 30 && !window.confirm(`将补齐 ${missing} 章缺失细纲，不会生成正文。继续吗？`)) return;
        if (autoTaskBooks.has(autoTaskKey(bookId))) {
          throw new Error('该作品已有自动任务正在运行，请等待当前任务结束');
        }
        const pendingAuto = readPendingSetup();
        if (pendingAuto?.autoGenerate && (!pendingAuto.bookId || String(pendingAuto.bookId) === String(bookId))) {
          const exitAuto = window.confirm('本书还有待执行的全 AI 托管任务。继续补齐细纲将退出该托管任务，是否继续？');
          if (!exitAuto) return;
          clearPendingSetup();
        }
        if (!beginAutoTask(bookId)) throw new Error('该作品已有自动任务正在运行，请等待当前任务结束');
        autoLocked = true;
        const channel = `fabula-plan-${Date.now().toString(36)}`;
        const reporter = createAutopilotChatReporter(bookId, saved.totalChapters, '补齐缺失细纲');
        reporter.reset?.();
        reporter.setPhase('正在生成缺失细纲');
        status.textContent = '正在生成当前滚动规划并补齐缺失细纲...';
        const result = await ipcStream('batch_generate_outlines', {
          bookId,
          totalChapters: saved.totalChapters,
          chapterWords: saved.chapterWords,
          onEvent: channel,
        }, (e) => {
          reporter.event(e);
          if (e.type === 'step') status.textContent = e.title || '生成中...';
          if (e.type === 'done') status.textContent = `完成：新增 ${e.created?.length || 0} 章，跳过 ${e.skipped?.length || 0} 章`;
        });
        if (!result || !Array.isArray(result.created)) throw new Error('服务需重启后才能批量生成细纲');
        const failed = result?.failed?.length || 0;
        if (failed) {
          reporter.finish(result, '细纲生成未完成');
          status.classList.add('is-error');
          status.textContent = `有 ${failed} 章细纲失败，可再次点击继续`;
          return;
        }

        reporter.finish(result, '缺失细纲已补齐');
        status.classList.add('is-ok');
        status.textContent = `缺失细纲已补齐：新增 ${result.created.length} 章，正文未改动`;
        window.setTimeout(() => window.location.reload(), 900);
      }
    } catch (error) {
      status.classList.add('is-error');
      status.textContent = error instanceof Error ? error.message : '操作失败';
    } finally {
      if (autoLocked) endAutoTask(bookId);
      setBusy(panel, false);
    }
  }, true);

  const scheduleInject = () => {
    if (injectTimer) return;
    injectTimer = window.setTimeout(() => {
      injectTimer = null;
      inject();
      injectSetup();
      injectAutopilotButton();
      scheduleGlobalSessionsSync();
    }, 80);
  };

  document.addEventListener('click', (event) => {
    const deleteGlobalSession = event.target.closest('.fabula-global-session__delete');
    if (deleteGlobalSession) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const sessionId = deleteGlobalSession.dataset.fabulaSessionId;
      const sessionTitle = deleteGlobalSession.dataset.fabulaSessionTitle || '新对话';
      if (!sessionId || !window.confirm(`确定删除会话“${sessionTitle}”吗？聊天记录将被删除。`)) return;
      deleteGlobalSession.disabled = true;
      ipc('delete_session', { sessionId })
        .then(() => {
          Object.keys(workspaceSessionsByBook).forEach((bookId) => {
            workspaceSessionsByBook[bookId] = (workspaceSessionsByBook[bookId] || []).filter((session) => String(session.id) !== String(sessionId));
          });
          toast('会话已删除', 'success');
          scheduleGlobalSessionsSync(0);
        })
        .catch((error) => {
          deleteGlobalSession.disabled = false;
          toast(error instanceof Error ? error.message : '删除会话失败', 'error');
        });
      return;
    }
    const globalSession = event.target.closest('.fabula-global-session .srail__card-main');
    if (globalSession) {
      event.preventDefault();
      event.stopImmediatePropagation();
      switchWorkspace({
        bookId: globalSession.dataset.fabulaBookId,
        sessionId: globalSession.dataset.fabulaSessionId,
        bookTitle: globalSession.dataset.fabulaBookTitle,
        sessionTitle: globalSession.dataset.fabulaSessionTitle,
      }).catch(() => {});
      return;
    }
    const tab = event.target.closest('.fabula-workspace-tab');
    if (!tab) return;
    event.preventDefault();
    event.stopPropagation();
    const key = tab.dataset.workspaceKey;
    if (event.target.closest('.fabula-workspace-tab__close')) {
      workspaceTabs = workspaceTabs.filter((item) => item.key !== key);
      saveWorkspaceTabs();
      renderWorkspaceTabs();
      return;
    }
    const target = workspaceTabs.find((item) => item.key === key);
    switchWorkspace(target).catch(() => {});
  }, true);

  new MutationObserver((mutations) => {
    if (mutations.length && mutations.every((mutation) => mutation.target instanceof Element && mutation.target.closest('.fabula-workspace-tabs'))) return;
    scheduleInject();
    scheduleWorkspaceSync();
  }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('focus', () => {
    booksCache = null;
    workspaceBooks = [];
    workspaceSessionsByBook = {};
    inject();
    injectSetup();
    injectAutopilotButton();
    scheduleGlobalSessionsSync(0);
  });
  installCustomGenreFetchPatch();
  renderWorkspaceTabs();
  injectAutopilotButton();
  inject();
  injectSetup();
  scheduleGlobalSessionsSync(0);
})();
