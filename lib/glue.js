// 注入到 index.html 的浏览器端 Tauri 胶水。
// 让前端认为自己运行在 Tauri 里：window.isTauri = true，
// IPC 走 POST /ipc/<cmd>，响应为 NDJSON：{"ch":id,"ev":...} 通道事件 / {"r":...} 结果 / {"err":...} 错误。
module.exports = function glueScript() {
  const name = '__WRITERX_GLUE__';
  return `
(() => {
  if (window.${name}) return; window.${name} = true;
  window.isTauri = true;
  window.__ipcLog = window.__ipcLog || [];
  const _log = (kind, msg) => { window.__ipcLog.push(kind + ': ' + msg); if (window.__ipcLog.length > 500) window.__ipcLog.shift(); };
  window.addEventListener('error', (e) => _log('ERR', (e.message || '') + ' || STACK: ' + String(e.error && e.error.stack || '') .slice(0, 1200)));
  window.addEventListener('unhandledrejection', (e) => _log('REJ', String(e.reason && e.reason.stack || e.reason || e)).slice(0, 1200));
  // 离线版清理：隐藏账号/会员相关 UI（左栏账号按钮 + 设置里的账号页）
  const purgeAccountUI = () => {
    try {
      if (!document.querySelector('style#__wx_no_account')) {
        const st = document.createElement('style');
        st.id = '__wx_no_account';
        st.textContent =
          '.notice-mask{display:none !important}' +
          '[class*="userbar"],button.mdrawer__user{display:none !important}' +
          'button.set__navitem[data-wx-hide]{display:none !important}' +
          '.acct__hd,.acct__vip,.acct__guest{display:none !important}' +
          // 文件树顶部的书名信息条（书名 · 连载中 · N 章 · 字数）按需隐藏
          '.librail__bookcard{display:none !important}' +
          // 主列顶部的 34px 空白带（官方客户端放会话标签的位置，web 版永远为空）：去掉并上提内容
          '.centerstage{padding-top:0 !important}';
        document.head.appendChild(st);
      }
      // 官方痕迹文本过滤：命中黑名单的小部件直接隐藏，长文本中清词
      const OFFICIAL_WORDS = ['QQ交流群', 'QQ 交流群', '550954548', '免费会员', '正式会员', '点此了解会员', '点此订阅',
        '注册即送', '试用已结束', '订阅已到期', '内置免费模型', '会员专供', '次数包', '永久授权', '预览通道',
        'mochang', 'writerx.cn', 'hub.writerx', '墨知', '检查更新', '使用手册与更新日志', '官网 · 最新版本'];
      // 营销文案简化：离线版无次数概念，去掉「免费模型」话术
      const SIMPLIFY_WORDS = [['v1.0.3', ''], ['版本 1.0.3', ''], ['免费模型不限量', ''], ['余额跨章结算，不够写下一章会暂停', '长文连写可随时停止'], ['免费模型', '模型']];
      const simplifyText = () => {
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const n = walker.currentNode;
            for (const pair of SIMPLIFY_WORDS) {
              if (n.nodeValue && n.nodeValue.includes(pair[0])) n.nodeValue = n.nodeValue.split(pair[0]).join(pair[1]);
            }
          }
        } catch (e) {}
      };
      simplifyText();
      const purgeText = () => {
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const hits = [];
          while (walker.nextNode()) {
            const n = walker.currentNode;
            for (const w of OFFICIAL_WORDS) {
              if (n.nodeValue && n.nodeValue.includes(w)) { hits.push({ n, w }); break; }
            }
          }
          for (const { n, w } of hits) {
            let el = n.parentElement;
            // 小元素：整块隐藏
            if (el && el.children.length <= 2 && el.textContent.length < 140) {
              el.closest('.userbar, [class*="userbar"], button, [class*="badge"], [class*="vip"], [class*="version"], [class*="chmgr"], [class*="builtin"]')?.style.setProperty('display', 'none', 'important');
              el.style.setProperty('display', 'none', 'important');
              continue;
            }
            // 卡片级容器（如「内置免费模型」整卡）：找最近的视觉卡再隐藏
            let card = el;
            for (let up = 0; up < 5 && card && card !== document.body; up++) {
              if (card.childElementCount <= 12 && (card.textContent || '').length <= 600) { if (up >= 2) break; card = card.parentElement; }
              else break;
            }
            if (card && card !== document.body && (card.textContent || '').length <= 600) {
              card.style.setProperty('display', 'none', 'important');
              continue;
            }
            n.nodeValue = n.nodeValue.split(w).join('');
          }
        } catch (e) {}
      };
      const markAccount = () => Array.from(document.querySelectorAll('button.set__navitem'))
        .forEach(b => { if (['账号', '反馈与支持'].includes(b.textContent.trim())) b.setAttribute('data-wx-hide', '1'); });
      purgeText();
      simplifyText();
      markAccount();
      // 设置面板打开时默认落在「模型」页（账号页已被隐藏）
      const modelBtn = Array.from(document.querySelectorAll('button.set__navitem'))
        .find(b => b.textContent.trim() === '模型' && !b.className.includes('is-active'));
      if (modelBtn && (!modelBtn.__wxLastClick || Date.now() - modelBtn.__wxLastClick > 1500)) {
        modelBtn.__wxLastClick = Date.now();
        modelBtn.click();
      }
      const mo = purgeAccountUI._mo || (purgeAccountUI._mo = new MutationObserver(() => {
        markAccount();
        simplifyText();
        const mb = Array.from(document.querySelectorAll('button.set__navitem'))
          .find(b => b.textContent.trim() === '模型' && !b.className.includes('is-active'));
        if (mb && (!mb.__wxLastClick || Date.now() - mb.__wxLastClick > 1500)) {
          mb.__wxLastClick = Date.now();
          mb.click();
        }
      }));
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) {}
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { setTimeout(purgeAccountUI, 800); });
  } else {
    setTimeout(purgeAccountUI, 800);
  }

  // 自动关闭官方欢迎/免责声明弹窗（离线版无更新提示，属于纯打扰）
  // 欢迎弹窗在加载后约 4 秒才出现：轮询直到它出现并关闭（最多 20 秒）
  let welcomeTries = 0;
  const dismissWelcome = () => {
    try {
      const dlg = document.querySelector('[role="dialog"]');
      if (dlg) {
        const btns = Array.from(dlg.querySelectorAll('button'));
        const know = btns.find((b) => b.textContent.trim() === '我知道了');
        if (know) { know.click(); }
      }
    } catch (e) {}
  };
  const welcomeTimer = setInterval(() => {
    try {
      const dlg = document.querySelector('[role="dialog"]');
      if (dlg) {
        const know = Array.from(dlg.querySelectorAll('button')).find((b) => b.textContent.trim() === '我知道了');
        if (know) know.click();
      }
    } catch (e) {}
    if (++welcomeTries > 25) clearInterval(welcomeTimer);
  }, 800);
  setTimeout(dismissWelcome, 1500);
  const channels = new Map();
  // 官方 Tauri v2 协议：Channel 通过 transformCallback 注册回调，得到数字 id；
  // 序列化为 "__CHANNEL__:<id>" 字符串，事件经 runCallback(id, {index, message}) 送达。
  const cbRegistry = new Map();
  let cbSeq = 1;
  function transformCallback(cb, once = false) {
    const id = cbSeq++;
    cbRegistry.set(id, { cb: typeof cb === 'function' ? cb : () => {}, once: !!once });
    return id;
  }
  function unregisterCallback(id) { cbRegistry.delete(Number(id)); }

  const isChannel = (x) =>
    x && typeof x === 'object' && x.id != null && typeof x.onmessage === 'function';

  function clone(v, seen) {
    if (v === null || typeof v !== 'object') return v;
    // 官方 Channel：toJSON() -> "__CHANNEL__:<id>"，走 transformCallback 回调协议
    if (typeof v.toJSON === 'function' && !(v instanceof Date)) {
      const j = v.toJSON();
      if (typeof j === 'string' && j.startsWith('__CHANNEL__')) return j;
    }
    if (isChannel(v)) {
      channels.set(String(v.id), v);
      return { id: v.id };
    }
    if (seen.has(v)) return undefined;
    seen.set(v, true);
    let out;
    if (Array.isArray(v)) {
      out = v.map((x) => clone(x, seen));
    } else if (v instanceof Date) {
      out = v.toISOString();
    } else {
      out = {};
      for (const k of Object.keys(v)) {
        const c = clone(v[k], seen);
        if (c !== undefined) out[k] = c;
      }
    }
    seen.delete(v);
    return out;
  }

  function parseLine(line, state) {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch (e) { return; }
    if (m.e !== undefined && channels.has(String(m.ch))) {
      try { channels.get(String(m.ch))(m.e); } catch (e) { console.warn('[glue] channel cb error', e); }
    } else if (m.e !== undefined) {
      const idx = state.seq.get(String(m.ch)) || 0;
      state.seq.set(String(m.ch), idx + 1);
      runCallbackId(m.ch, { index: idx, message: m.e });
    } else if (m.r !== undefined) {
      state.result = m.r;
    } else if (m.err) {
      const err = new Error(m.err.message || 'IPC error');
      if (m.err.msg) err.msg = m.err.msg;
      state.error = err;
    }
  }

  const browserFiles = new Map();
  const browserGroups = new Map();
  const browserSaves = new Map();
  let browserSeq = 1;
  const browserId = () => 'browser-' + Date.now().toString(36) + '-' + (browserSeq++);
  const browserPick = (options) => new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    if (options && options.multiple) input.multiple = true;
    if (options && options.directory) input.webkitdirectory = true;
    const exts = [];
    for (const filter of (options && options.filters) || []) {
      for (const ext of (filter && filter.extensions) || []) exts.push('.' + ext);
    }
    if (exts.length && !(options && options.directory)) input.accept = exts.join(',');
    document.body.appendChild(input);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      const paths = files.map((file) => {
        const fake = 'browser-file://' + browserId();
        browserFiles.set(fake, file);
        return fake;
      });
      if (options && options.directory && paths.length) browserGroups.set(paths[0], files);
      finish(options && options.multiple ? paths : (paths[0] || null));
    });
    input.addEventListener('cancel', () => finish(options && options.multiple ? [] : null));
    input.click();
  });
  const browserSave = (options) => {
    const suggested = String((options && (options.defaultPath || options.suggestedName)) || 'download');
    const name = suggested.split(/[\\/]/).pop() || 'download';
    const fake = 'browser-save://' + browserId();
    browserSaves.set(fake, { name, handle: null });
    if (typeof window.showSaveFilePicker === 'function') {
      return window.showSaveFilePicker({ suggestedName: name }).then((handle) => {
        browserSaves.set(fake, { name: handle.name || name, handle });
        return fake;
      }).catch(() => null);
    }
    return Promise.resolve(fake);
  };
  const browserRead = async (fake, asText) => {
    const file = browserFiles.get(fake);
    if (!file) throw new Error('浏览器文件已失效，请重新选择');
    if (asText) return file.text();
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  };
  const browserDownload = async (save, bytes, name, type) => {
    const blob = new Blob([bytes], { type: type || 'application/octet-stream' });
    if (save && save.handle) {
      const writable = await save.handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name || (save && save.name) || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  async function invoke(cmd, args = {}, options = {}) {
    _log('INVOKE', cmd);
    if (cmd === 'plugin:dialog|open') return browserPick(args || {});
    if (cmd === 'plugin:dialog|save') return browserSave(args || {});
    if (cmd === 'read_import_folder' && args && String(args.path || '').startsWith('browser-file://')) {
      const group = browserGroups.get(args.path) || [];
      const out = [];
      for (const file of group) out.push({ name: file.name, content: await file.text() });
      return out;
    }
    if (args && String(args.path || '').startsWith('browser-file://')) {
      if (cmd === 'import_book_zip') args = { data: await browserRead(args.path, false) };
      else if (cmd === 'inspect_skill_bundle' || cmd === 'install_skill_bundle' || cmd === 'inspect_skill_md') {
        args = { content: await browserRead(args.path, true), path: args.path };
      }
    }
    let browserSaveTarget = null;
    if (args && String(args.destPath || '').startsWith('browser-save://')) {
      browserSaveTarget = browserSaves.get(args.destPath) || { name: 'download', handle: null };
      const next = { ...args };
      delete next.destPath;
      args = next;
    }
    // 浏览器可本地完成的命令
    if (cmd === 'open_url' && args && args.url) {
      window.open(args.url, '_blank', 'noopener');
      return null;
    }
    if (cmd === 'log_frontend_error') {
      console.warn('[frontend error]', args && (args.message || args.context));
      return null;
    }
    const body = clone(args, new Map());
    let resp;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (window.__WX_IPC_TOKEN__) headers['X-Fabula-Token'] = window.__WX_IPC_TOKEN__;
      resp = await fetch('/ipc/' + cmd, {
        method: 'POST',
        headers,
        body: JSON.stringify({ args: body, options: options || {} }),
      });
    } catch (e) {
      throw new Error('[glue] 无法连接复刻后端，请确认 node server.js 正在运行：' + e.message);
    }
    if (!resp.ok) {
      let t = '';
      try { t = await resp.text(); } catch (e) {}
      throw new Error('[glue] IPC HTTP ' + resp.status + ': ' + (t || '').slice(0, 300));
    }
    const state = { result: undefined, error: null, seq: new Map() };
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\\n')) !== -1) {
        parseLine(buf.slice(0, nl), state);
        buf = buf.slice(nl + 1);
      }
    }
    if (state.error) throw state.error;
    if (browserSaveTarget) {
      if (cmd === 'export_diagnostics' && state.result && state.result.content != null) {
        await browserDownload(browserSaveTarget, new TextEncoder().encode(String(state.result.content)), state.result.file || browserSaveTarget.name, 'text/plain');
        return { ...state.result, path: browserSaveTarget.name, downloaded: true };
      }
      if (state.result && state.result.path) {
        const file = await invoke('read_export_file', { path: state.result.path });
        const binary = atob(file.data || '');
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await browserDownload(browserSaveTarget, bytes, file.name || browserSaveTarget.name, 'application/octet-stream');
        return { ...state.result, path: browserSaveTarget.name, downloaded: true };
      }
    }
    return state.result;
  }

  const runCallbackId = (cbId, value) => {
    const entry = cbRegistry.get(Number(cbId));
    if (entry) {
      if (entry.once) cbRegistry.delete(Number(cbId));
      try { entry.cb(value); } catch (e) { console.warn('[glue] cb error', e); }
    }
  };
  const internals = {
    invoke,
    convertFileSrc(p) { return p; },
    transformCallback,
    unregisterCallback,
    runCallback: runCallbackId,
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main' },
      currentWebviewWindow: { label: 'main' },
    },
  };
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: internals, configurable: true });
  // 部分内部代码会读 window.__TAURI__（如 isTauri 检查的另一形态）
  Object.defineProperty(window, '__TAURI__', { value: internals, configurable: true });

  // ============ 移动端紧凑样式：动态注入并常驻 head 末尾（压过应用内字号设置） ============
  (function mobileCss() {
    var ID = '__WX_MOBILE_CSS__';
    var CSS = [
      '@media (max-width:720px){',
      'html:root{--fs-body:17px !important;--font-ui:-apple-system,BlinkMacSystemFont,"PingFang SC","HarmonyOS Sans SC","MiSans","Microsoft YaHei",sans-serif !important;--font-prose:-apple-system,BlinkMacSystemFont,"PingFang SC","HarmonyOS Sans SC","MiSans","Microsoft YaHei",sans-serif !important}',
      '.mshell__top{height:40px !important}.header{height:40px !important}.header__tag{display:none !important}',
      'html .chathead{height:42px !important;padding:0 10px !important;gap:8px !important}',
      '.chathead__tools{gap:5px !important}',
      'html .chathead__toolbtn{height:28px !important;padding:0 8px !important;font-size:12px !important}',
      '.chathead__msgcount{display:none !important}',
      '.aimsg{gap:10px !important}',
      'html .usermsg__bubble{padding:8px 12px !important;font-size:17px !important}',
      '.dockwrap{padding:0 8px calc(6px + env(safe-area-inset-bottom,0px)) !important}',
      'html .dock__compose{padding:8px 10px 4px !important;font-size:17px !important}',
      'html .dock__textarea{max-height:38vh !important;font-size:17px !important}',
      '.dock__refs{top:8px !important;left:10px !important}',
      'html .dock__toolbar{padding:4px 8px 6px !important;gap:5px !important}',
      '.dock__tool,.dock__skill,.dock__file,.dock__web-search,.dock__next,.dock__model,.dock__reasoning{height:28px !important;padding:0 8px !important;font-size:12px !important}',
      'html .dock__send{flex:0 0 28px !important;width:28px !important;height:28px !important}',
      '.dock__disclaimer{display:none !important}',
      '.dock__batchhint{padding:6px 8px !important;font-size:11px !important}',
      '.dock__quota{margin-left:4px !important;font-size:10px !important}',
      '.dock__model{max-width:150px !important}',
      'html .editorpane__bar{min-height:42px !important;padding:5px 8px !important}',
      'html .editorpane__ai{height:28px !important;padding:0 8px !important;font-size:12px !important}',
      'html .mtool__scroll{padding:8px 10px 10px !important}',
      'html .modal__sub{font-size:12.5px !important}',
      'html .aimsg__body,html .aimsg__prose{font-size:17px !important;line-height:1.78 !important}',
      'html .aimsg__prose h1{font-size:21px !important}',
      'html .aimsg__prose h2{font-size:19px !important}',
      'html .aimsg__prose h3{font-size:17.5px !important}',
      'html .aimsg__prose h4{font-size:16.5px !important}',
      'html .aimsg__prose table{font-size:15px !important}',
      'html .aimsg__prose pre code{font-size:14px !important}',
      'html .usermsg__text{font-size:17px !important}',
      'html .mdock__input{font-size:17px !important}',
      'html .mdrawer__row{font-size:16.5px !important}',
      'html .chathead__title{font-size:17px !important}',
      'html .mshell__title{font-size:17px !important}',
      '}'
    ].join('');
    var ensure = function () {
      var el = document.getElementById(ID);
      if (!el) {
        el = document.createElement('style');
        el.id = ID;
        el.textContent = CSS;
      }
      // 常驻 head 末尾：被其它脚本挤掉位置就重新追加
      if (el.parentNode !== document.head || document.head.lastElementChild !== el) {
        document.head.appendChild(el);
      }
    };
    setInterval(ensure, 700);
    if (document.body) ensure();
    else document.addEventListener('DOMContentLoaded', ensure);
  })();

  // ============ 构建版本检测：服务器更新后客户端自动强刷一次 ============
  (function buildCheck() {
    try {
      var ts = window.__WX_BUILD__ || '';
      if (!ts) return;
      var k = '__wx_build_seen';
      var seen = localStorage.getItem(k);
      localStorage.setItem(k, ts);
      if (seen && seen !== ts) {
        sessionStorage.setItem('__wx_hard_reload', '1');
        window.location.reload();
      }
    } catch (e) {}
  })();

  // ============ 移动端自动识别：触屏小屏设备强制 ?mobile=1 进入移动布局 ============
  // 官方前端只认 Android UA（lt() 判定），iPhone/iPad 会被判成桌面三栏。这里补齐：
  (function mobileDetect() {
    try {
      var q = new URLSearchParams(window.location.search);
      if (q.get('mobile') === '1' || q.get('mobile') === '0') return; // 用户已显式指定
      var touch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
      var small = Math.min(window.screen.width, window.screen.height) <= 820;
      var mobileUA = /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent);
      if ((mobileUA && touch) || (touch && small)) {
        q.set('mobile', '1');
        window.location.replace(window.location.pathname + '?' + q.toString() + window.location.hash);
      }
    } catch (e) {}
  })();

  // ============ 移动抽屉：注入「书本目录」入口（直达资料库目录页） ============
  (function mdrawerLibrary() {
    setInterval(function () {
      try {
        var drawer = document.querySelector('.mdrawer');
        if (!drawer || drawer.querySelector('.__mdl_injected')) return;
        var rows = Array.prototype.slice.call(drawer.querySelectorAll('.mdrawer__row'));
        var searchRow = null;
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].textContent.indexOf('搜索') >= 0) { searchRow = rows[i]; break; }
        }
        if (!searchRow) return;
        var btn = document.createElement('button');
        btn.className = 'mdrawer__row __mdl_injected';
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg><span>书本目录</span>';
        btn.addEventListener('click', function () {
          var openLib = function () {
            var lib = document.querySelector('.mshell__top button[aria-label="资料库"]');
            if (lib) lib.click();
          };
          if (document.querySelector('.mshell__top button[aria-label="资料库"]')) {
            var burger = document.querySelector('.mshell__top button[aria-label="会话"]');
            if (burger) burger.click();
            setTimeout(openLib, 180);
          } else {
            var back = document.querySelector('button[aria-label="返回"]');
            if (back) back.click();
            setTimeout(openLib, 400);
          }
        });
        searchRow.insertAdjacentElement('afterend', btn);
      } catch (e) {}
    }, 800);
  })();

  // ============ 风格蒸馏：书源搜索增强（DOM 注入，不改打包 JS） ============
  const installDistillSearch = () => {
    const STYLE_ID = '__DSRC_STYLE__';
    if (!document.getElementById(STYLE_ID)) {
      const st = document.createElement('style');
      st.id = STYLE_ID;
      st.textContent =
        '.dsrc{border:1px dashed #c9d4e3;border-radius:12px;padding:10px 12px;margin:10px 0;background:#f7fafd}' +
        '.dsrc__row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
        '.dsrc__select,.dsrc__input{border:1px solid #d8e0ea;border-radius:8px;padding:6px 10px;font-size:13px;background:#fff;color:#33404f}' +
        '.dsrc__input{flex:1;min-width:160px}' +
        '.dsrc__btn{border:1px solid #d8e0ea;border-radius:8px;padding:6px 12px;font-size:13px;background:#fff;color:#33404f;cursor:pointer}' +
        '.dsrc__btn:hover{border-color:#8ab4ff;color:#1a73e8}' +
        '.dsrc__btn[disabled]{opacity:.5;cursor:default}' +
        '.dsrc__list{margin-top:8px;max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:4px}' +
        '.dsrc__hit{display:flex;justify-content:space-between;gap:10px;align-items:center;border:0;border-radius:8px;padding:7px 10px;background:#eef3f9;cursor:pointer;font-size:13px;text-align:left}' +
        '.dsrc__hit:hover{background:#e2ecf7}' +
        '.dsrc__hit b{color:#22303f;font-weight:600}' +
        '.dsrc__hit span{color:#7c8a99;font-size:12px}' +
        '.dsrc__chs{margin-top:8px;max-height:240px;overflow:auto;border-top:1px solid #e6ecf3;padding-top:8px;display:flex;flex-direction:column;gap:2px}' +
        '.dsrc__ch{display:flex;gap:8px;align-items:center;font-size:13px;padding:3px 6px;border-radius:6px;cursor:pointer;color:#33404f}' +
        '.dsrc__ch:hover{background:#eef3f9}' +
        '.dsrc__ch input{accent-color:#1a73e8}' +
        '.dsrc__foot{display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap}' +
        '.dsrc__status{font-size:12px;color:#7c8a99}' +
        '.dsrc__busy{color:#1a73e8}';
      document.head.appendChild(st);
    }
    const ipc = async (cmd, args) => {
      const resp = await fetch('/ipc/' + cmd, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: args || {} }),
      });
      let text = '';
      try { text = await resp.text(); } catch (e) {}
      let last = null;
      for (const line of text.split('\\n')) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (j && j.r !== undefined) last = j.r;
          if (j && j.err) throw new Error(j.err.message || 'IPC error');
        } catch (e) { if (e.message !== 'IPC error') throw e; }
      }
      return last;
    };
    const mount = (panel) => {
      const dialog = document.querySelector('.modal[class*="modal--"], .mtool, .modal-overlay .modal');
      if (!dialog) return null;
      const textEl = dialog.querySelector('textarea, textarea.mtool__textarea');
      if (!textEl) return null;
      const field = dialog.querySelector('input[placeholder*="风格名称"]') || dialog.querySelector('.modal__field') || dialog.querySelector('.mtool__field');
      if (!field) return null;
      const sub = dialog.querySelector('.modal__sub, p.mtool__desc');
      if (!sub || !sub.textContent.includes('提炼写作风格')) return null;
      // 插到风格名称输入行之前
      const fieldBox = field.closest('.modal__field, .mtool__field');
      const parent = fieldBox ? fieldBox.parentElement : null;
      if (!parent || parent.contains(panel) || dialog.contains(panel)) return null;
      parent.insertBefore(panel, fieldBox);
      return panel;
    };
    const build = () => {
      if (document.querySelector('.dsrc')) return document.querySelector('.dsrc');
      const panel = document.createElement('div');
      panel.className = 'dsrc';
      const s = {};
      panel.innerHTML =
        '<div class="dsrc__row">' +
        '<select class="dsrc__select"></select>' +
        '<input class="dsrc__input" placeholder="输入书名搜索，如：斗破苍穹" />' +
        '<button class="dsrc__btn dsrc__go">搜索</button>' +
        '<button class="dsrc__btn dsrc__refresh" title="刷新云端书源">刷新书源</button>' +
        '</div>' +
        '<div class="dsrc__list"></div>' +
        '<div class="dsrc__chs"></div>' +
        '<div class="dsrc__foot">' +
        '<button class="dsrc__btn dsrc__load" disabled>载入为蒸馏文本</button>' +
        '<button class="dsrc__btn dsrc__clear" disabled>清空</button>' +
        '<span class="dsrc__status"></span>' +
        '</div>';
      const $ = (sel) => panel.querySelector(sel);
      const status = (txt, busy) => { $('.dsrc__status').textContent = txt || ''; $('.dsrc__status').className = 'dsrc__status' + (busy ? ' dsrc__busy' : ''); };
      s.selected = new Set();
      const paintLoad = () => {
        $('.dsrc__load').disabled = s.selected.size === 0;
        $('.dsrc__load').textContent = s.selected.size > 0 ? ('载入为蒸馏文本（' + s.selected.size + ' 章）') : '载入为蒸馏文本';
      };
      s.reloadSources = async () => {
        try {
          const list = await ipc('list_book_sources');
          const sel = $('.dsrc__select');
          sel.innerHTML = '';
          for (const src of list || []) {
            const op = document.createElement('option');
            op.value = src.id;
            op.textContent = src.name + (src.remote === false ? '（本地）' : '');
            sel.appendChild(op);
          }
          if (list && list.length) sel.selectedIndex = 0;
        } catch (e) { status('书源加载失败：' + (e.message || e)); }
      };
      s.refreshBookSources = async () => {
        try { await ipc('sync_book_sources'); status('已刷新'); await s.reloadSources(); }
        catch (e) { status('刷新失败：' + (e.message || e)); }
      };
      s.search = async () => {
        const kw = $('.dsrc__input').value.trim();
        if (!kw) { status('先输入书名'); return; }
        const sourceId = $('.dsrc__select').value;
        if (!sourceId) { status('先选择书源'); return; }
        $('.dsrc__go').disabled = true;
        status('正在搜索“' + kw + '”…', true);
        const list = $('.dsrc__list');
        list.innerHTML = '';
        try {
          const hits = await ipc('search_books', { sourceId, keyword: kw });
          list.innerHTML = '';
          if (!hits || !hits.length) { status('没有搜到结果——换个更短的关键词试试'); return; }
          hits.slice(0, 20).forEach((h) => {
            const b = document.createElement('button');
            b.className = 'dsrc__hit';
            const title = document.createElement('span');
            const strong = document.createElement('b');
            strong.textContent = h.name || h.title || '';
            title.appendChild(strong);
            const author = document.createElement('span');
            author.textContent = h.author || '';
            b.append(title, author);
            b.addEventListener('click', async () => { await s.showCatalog(sourceId, h); });
            list.appendChild(b);
          });
          status('搜索结果（' + hits.length + '）——点书名选章');
        } catch (e) { status('搜索失败：' + (e.message || e)); }
        finally { $('.dsrc__go').disabled = false; }
      };
      s.showCatalog = async (sourceId, book) => {
        $('.dsrc__go').disabled = true;
        $('.dsrc__input').value = book.name || book.title || '';
        status('正在取《' + (book.name || '') + '》章节目录…', true);
        $('.dsrc__list').innerHTML = '';
        try {
          const cat = await ipc('fetch_book_catalog', { sourceId, bookUrl: book.url });
          const chs = $('.dsrc__chs');
          chs.innerHTML = '';
          s.selected = new Set();
          (cat && cat.chapters || []).slice(0, 60).forEach((c, idx) => {
            const el = document.createElement('label');
            el.className = 'dsrc__ch';
            el.dataset.url = c.url || '';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = idx < 10; // 默认前10章
            if (cb.checked) s.selected.add(c.url);
            cb.addEventListener('change', () => {
              if (cb.checked) s.selected.add(c.url); else s.selected.delete(c.url);
              paintLoad();
            });
            el.appendChild(cb);
            const span = document.createElement('span');
            span.textContent = c.title || c.name || '';
            el.appendChild(span);
            el.addEventListener('click', (ev) => { if (ev.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); } });
            chs.appendChild(el);
          });
          const total = (cat && cat.chapters || []).length;
          status('《' + (cat.bookName || book.name || '') + '》共 ' + total + ' 章（已载入前 60 章，默认选前 10 章）');
          $('.dsrc__clear').disabled = false;
          paintLoad();
        } catch (e) { status('目录获取失败：' + (e.message || e)); }
        finally { $('.dsrc__go').disabled = false; }
      };
      s.loadTexts = async () => {
        if (!s.selected.size) return;
        const sourceId = $('.dsrc__select').value;
        // 按 DOM 顺序收集勾选的章节（URL 挂在 label.dataset.url）
        const chapters = [];
        const seen = new Set();
        for (const el of panel.querySelectorAll('.dsrc__ch')) {
          const cb = el.querySelector('input');
          if (!cb || !cb.checked) continue;
          const title = el.querySelector('span').textContent || '';
          const url = el.dataset.url || '';
          if (url && !seen.has(url)) { seen.add(url); chapters.push({ name: title, title, url }); }
        }
        if (!chapters.length) { status('未选中章节'); return; }
        $('.dsrc__load').disabled = true;
        status('正在抓取正文（共 ' + chapters.length + ' 章）…', true);
        let parts = [];
        for (let i = 0; i < chapters.length; i++) {
          status('正在抓取第 ' + (i + 1) + '/' + chapters.length + ' 章 · ' + chapters[i].title + '…', true);
          try {
            const txt = await ipc('fetch_chapter_texts', { sourceId, chapters: [chapters[i]] });
            if (txt) parts.push('## ' + chapters[i].title + '\\n' + txt);
          } catch (e) { parts.push('## ' + chapters[i].title + '\\n（第 ' + (i + 1) + ' 章抓取失败：' + (e.message || e) + '）'); }
        }
        const full = parts.join('\\n\\n');
        // 写入 React 受控 textarea：native setter + input 事件触发 onChange
        const dlg = panel.closest('.modal, .mtool'); const ta = dlg ? dlg.querySelector('textarea') : null;
        if (!ta) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, full);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        status('已载入 ' + chapters.length + ' 章 · 约 ' + full.replace(/\s/g, '').length.toLocaleString() + ' 字，可点「开始蒸馏」');
        $('.dsrc__clear').disabled = false;
      };
      s.clearTexts = () => {
        const dlg = panel.closest('.modal, .mtool'); const ta = dlg ? dlg.querySelector('textarea') : null;
        if (ta) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, '');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        s.selected = new Set();
        $('.dsrc__chs').querySelectorAll('input').forEach((cb) => { cb.checked = false; });
        paintLoad();
        status('');
      };
      $('.dsrc__go').addEventListener('click', s.search);
      $('.dsrc__refresh').addEventListener('click', s.refreshBookSources);
      $('.dsrc__load').addEventListener('click', s.loadTexts);
      $('.dsrc__clear').addEventListener('click', s.clearTexts);
      $('.dsrc__input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') s.search(); });
      s.reloadSources();
      return panel;
    };
    const watch = () => {
      const panel = document.querySelector('.dsrc');
      if (!panel) { const p = build(); if (p) mount(p); }
    };
    if (document.body) {
      new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
      watch();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
        watch();
      });
    }
  };

  // 工作台入口 dock：小说主界面右下角常驻三个入口——文档工作台 / 技能广场 / 任务状态。
  // 这些页面由服务端直渲染（web/ 无源码，新能力进不去主界面），dock 只是跳转入口。
  const installWorkspaceDock = () => {
    const build = () => {
      if (document.getElementById('__fabula_dock')) return;
      const dock = document.createElement('div');
      dock.id = '__fabula_dock';
      dock.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;flex-direction:column;gap:8px;font:13px/1 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;';
      const items = [
        ['/docs', '📄 文档工作台', '#1c4f9c', '#e8f1fe'],
        ['/skills', '🧩 技能广场', '#8a5a00', '#fff5e6'],
        ['/status', '📊 任务状态', '#1a6b36', '#eaf7ee'],
      ];
      for (const [href, label, color, bg] of items) {
        const a = document.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.textContent = label;
        a.style.cssText = 'padding:8px 14px;border-radius:999px;background:' + bg + ';color:' + color +
          ';text-decoration:none;box-shadow:0 2px 8px rgba(16,24,40,.18);border:1px solid rgba(16,24,40,.08);';
        a.onmouseenter = () => { a.style.filter = 'brightness(.96)'; };
        a.onmouseleave = () => { a.style.filter = ''; };
        dock.appendChild(a);
      }
      document.body.appendChild(dock);
    };
    if (document.body) build();
    else document.addEventListener('DOMContentLoaded', build);
  };

  // ============ 开启新书时的写作配置：文风卡 + 叠加技能，新书落地自动写入本书 ============
  // 官方「开启新书」弹窗没有这两项选择；这里注入一个可选区块，
  // 点「开始共创」后监听新书出现（list_books 对比基线），把选择绑定到书——
  // 绑定走官方同款 IPC（set_book_style / set_book_support_skills），对话与批量管线都会读到。
  const installBookCreationConfig = () => {
    const PENDING_KEY = '__wx_pendingBookConfig';
    const KNOWN_KEY = '__wx_knownBooks';
    const readKnown = () => { try { return JSON.parse(localStorage.getItem(KNOWN_KEY) || '[]'); } catch (e) { return []; } };
    const toast = (msg) => {
      const t = document.createElement('div');
      t.textContent = msg;
      t.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483001;background:#173f9e;color:#fff;padding:9px 16px;border-radius:10px;font-size:13px;box-shadow:0 6px 20px rgba(16,24,40,.25)';
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 4000);
    };
    const findModalButton = () => Array.from(document.querySelectorAll('button'))
      .find((b) => (b.textContent || '').includes('开始共创'));
    const findInsertAnchor = (modalRoot) => {
      // 章节计划区块的卡片级父节点：把我们的小节插到它前面
      for (const el of modalRoot.querySelectorAll('*')) {
        const first = (el.textContent || '').trim();
        if (first.startsWith('章节计划') && el.getBoundingClientRect().height > 30) {
          let card = el;
          for (let i = 0; i < 3 && card.parentElement && card.parentElement !== modalRoot; i++) {
            if ((card.parentElement.textContent || '').includes('先定个方向')) break;
            card = card.parentElement;
          }
          return card;
        }
      }
      return null;
    };
    const inject = () => {
      if (document.getElementById('__wx_bookcfg')) return;
      const btn = findModalButton();
      if (!btn) return;
      const modalRoot = btn.closest('[class*="modal"],[class*="dialog"],[class*="overlay"],[class*="sheet"],[class*="drawer"]') || document.body;
      const anchor = findInsertAnchor(modalRoot);
      const section = document.createElement('div');
      section.id = '__wx_bookcfg';
      section.style.cssText = 'border:1px solid #e6e8ec;border-radius:12px;padding:12px 14px;margin:14px 0;background:#fafbfd;font-size:13px';
      section.innerHTML = [
        '<div style="font-weight:600;margin-bottom:6px">写作配置（可选 — 新书落地后自动写入本书）</div>',
        '<label style="display:block;font-size:12px;color:#70757d;margin:6px 0 3px">文风卡</label>',
        '<select id="__wx_bcfg_style" style="width:100%;padding:6px 8px;border:1px solid #dfe3e8;border-radius:8px;font:inherit"><option value="auto">自动 · 跟随题材</option></select>',
        '<label style="display:block;font-size:12px;color:#70757d;margin:10px 0 3px">叠加技能（最多 6 个，可在广场新建）</label>',
        '<div id="__wx_bcfg_skills" style="max-height:140px;overflow-y:auto;display:flex;flex-direction:column;gap:2px"></div>',
      ].join('');
      if (anchor) anchor.parentElement.insertBefore(section, anchor);
      else modalRoot.appendChild(section);
      // 数据填充：走官方同款 IPC
      Promise.resolve()
        .then(() => invoke('list_skills', {}))
        .then((skills) => {
          const list = Array.isArray(skills) ? skills : [];
          const styleSel = section.querySelector('#__wx_bcfg_style');
          for (const s of list.filter((x) => x.kind === 'style')) {
            const opt = document.createElement('option');
            opt.value = 'style:' + s.id;
            opt.textContent = '文风卡 · ' + (s.name || '未命名');
            styleSel.appendChild(opt);
          }
          const box = section.querySelector('#__wx_bcfg_skills');
          for (const s of list.filter((x) => x.kind !== 'style' && x.enabled)) {
            const label = document.createElement('label');
            label.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12.5px;padding:3px 2px;cursor:pointer';
            label.innerHTML = '<input type="checkbox" style="accent-color:#1d4ed8"> <span>' +
              String(s.name || '').replace(/[<>&]/g, '') + '</span>';
            const cb = label.querySelector('input');
            cb.dataset.skillId = s.id;
            cb.addEventListener('change', () => {
              const checked = Array.from(box.querySelectorAll('input:checked'));
              if (checked.length > 6) { cb.checked = false; toast('叠加技能最多选 6 个'); }
            });
            box.appendChild(label);
          }
          if (!box.children.length) box.innerHTML = '<span style="color:#9aa1a9;font-size:12px">技能广场暂无可叠加的技能</span>';
        })
        .catch(() => {});
      // 点「开始共创」：存下待应用配置，并启动新书监听
      btn.addEventListener('click', () => {
        const style = (section.querySelector('#__wx_bcfg_style') || {}).value || 'auto';
        const skills = Array.from(section.querySelectorAll('#__wx_bcfg_skills input:checked')).map((c) => c.dataset.skillId);
        const known = readKnown();
        localStorage.setItem(PENDING_KEY, JSON.stringify({ style, skills, at: Date.now(), baseline: known }));
        startApplyLoop();
      }, true);
    };
    const startApplyLoop = () => {
      if (installBookCreationConfig._applying) return;
      installBookCreationConfig._applying = true;
      const timer = setInterval(async () => {
        let pending = null;
        try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch (e) {}
        if (!pending) { clearInterval(timer); installBookCreationConfig._applying = false; return; }
        if (Date.now() - (pending.at || 0) > 15 * 60 * 1000) {
          // 15 分钟内没有新书落地（用户多半取消了创建）：放弃等待，清掉待配置。
          localStorage.removeItem(PENDING_KEY);
          clearInterval(timer);
          installBookCreationConfig._applying = false;
          return;
        }
        try {
          const books = await invoke('list_books', {});
          const ids = (Array.isArray(books) ? books : []).map((b) => b.id);
          const fresh = ids.find((id) => !(pending.baseline || readKnown()).includes(id));
          if (fresh) {
            clearInterval(timer);
            installBookCreationConfig._applying = false;
            localStorage.setItem(KNOWN_KEY, JSON.stringify(ids));
            localStorage.removeItem(PENDING_KEY);
            if (pending.style && pending.style !== 'auto') {
              await invoke('set_book_style', { bookId: fresh, style: pending.style });
            }
            for (const taskKind of ['plot', 'outline', 'body']) {
              if (pending.skills && pending.skills.length) {
                await invoke('set_book_support_skills', { bookId: fresh, taskKind, skillIds: pending.skills });
              }
            }
            toast('新书已创建：文风卡与叠加技能已写入本书');
          }
        } catch (e) { /* 轮询失败下一轮重试 */ }
      }, 2000);
    };
    // 基线维护：记录当前已有书目，避免把老书误判为新书
    const refreshBaseline = () => {
      invoke('list_books', {}).then((books) => {
        if (Array.isArray(books)) localStorage.setItem(KNOWN_KEY, JSON.stringify(books.map((b) => b.id)));
      }).catch(() => {});
      // 弹窗出现时注入
      if (findModalButton() && !document.getElementById('__wx_bookcfg')) inject();
    };
    setInterval(refreshBaseline, 1200);
    new MutationObserver(() => { if (findModalButton() && !document.getElementById('__wx_bookcfg')) inject(); })
      .observe(document.body, { childList: true, subtree: true });
  };

  installDistillSearch();
  installWorkspaceDock();
  installBookCreationConfig();
})();
`.trim();
};
