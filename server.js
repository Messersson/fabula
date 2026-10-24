// Fabula 离线版 —— 零依赖 Node 服务。
// 1) 静态提供前端；2) 向 index.html 注入 Tauri 胶水；3) 处理全部 IPC 命令（NDJSON）。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbmod = require('./lib/db');
const DATA_DIR_VISIBLE = () => dbmod.DATA_DIR;
const glue = require('./lib/glue');
const registry = require('./lib/registry');

const PORT = Number(process.env.PORT || process.argv[2] || 17381);
const ROOT = __dirname;
const WEB = path.join(ROOT, 'web');
const IPC_TOKEN = crypto.randomBytes(32).toString('hex');
const CONFIG_PATH = process.env.FABULA_CONFIG_PATH
  ? path.resolve(process.env.FABULA_CONFIG_PATH)
  : (fs.existsSync(path.join(DATA_DIR_VISIBLE(), 'config.json'))
    ? path.join(DATA_DIR_VISIBLE(), 'config.json')
    : path.join(ROOT, 'config.json'));

// ---------- 配置 ----------
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); } catch (e) {
    console.error('[config] config.json 解析失败:', e.message);
    return {};
  }
}

// ---------- DB ----------
// 种子库优先：writerx.seed.db（干净初始化库）→ 本机现库兜底（老用户升级场景）
const seedDb = fs.existsSync(path.join(ROOT, 'data', 'writerx.seed.db'))
  ? path.join(ROOT, 'data', 'writerx.seed.db')
  : path.join(ROOT, 'data', 'writerx.db');
dbmod.open(seedDb);
const { run, q, one } = require('./lib/db');

// ---------- 应用 config.json（只在首次生效，避免覆盖用户在 UI 里的修改） ----------
// ---------- 应用 config.json（只在 config 变化时合并；不覆盖用户在 UI 中的修改） ----------
const isPlaceholderKey = (k) => !k || !!/(在这里填|CHANGE_ME|your[-_]?key|example)/i.test(String(k));
const nonEmptyString = (v) => v != null && String(v).trim() !== '';
function applyConfig() {
  const cfg = loadConfig();
  if (!cfg) return;
  const raw = JSON.stringify(cfg);
  const h = require('crypto').createHash('sha1').update(raw).digest('hex').slice(0, 16);
  const applied = one(`SELECT value FROM settings WHERE key='replica_config_hash'`);
  if (applied && applied.value === h) return;
  const { channels = [] } = cfg;
  const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
  if (channels && channels.length) {
    let cur = [];
    try { cur = JSON.parse((one(`SELECT value FROM settings WHERE key='channels'`) || { value: '[]' }).value); } catch (e) {}
    for (const c of channels) {
      if (c.id === 'ch_builtin_free') continue;
      const existing = cur.find((x) => x.id === c.id);
      const entry = existing || { id: c.id, type: 'direct', builtin: false };
      if (c.label) entry.label = c.label;
      if (c.name && !entry.label) entry.label = c.name;
      if (hasOwn(c, 'baseUrl')) {
        const v = c.baseUrl == null ? '' : String(c.baseUrl);
        if (nonEmptyString(v) || !existing || !entry.baseUrl) entry.baseUrl = v;
      }
      if (hasOwn(c, 'modelsUrl')) {
        const v = c.modelsUrl == null ? '' : String(c.modelsUrl);
        if (nonEmptyString(v) || !existing || !entry.modelsUrl) entry.modelsUrl = v;
      }
      if (hasOwn(c, 'model')) {
        const v = c.model == null ? '' : String(c.model);
        if (nonEmptyString(v) || !existing || !entry.model) entry.model = v;
      }
      if (Array.isArray(c.models) && c.models.length) entry.models = c.models;
      if (!existing) cur.push(entry);
      if (c.apiKey && !isPlaceholderKey(c.apiKey)) {
        run(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, 'channel_key__' + c.id, c.apiKey);
      }
    }
    run(`INSERT INTO settings(key,value) VALUES('channels',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify(cur));
    if (cfg.activeChannelId && cur.some((c) => c.id === cfg.activeChannelId)) {
      const ch = cur.find((c) => c.id === cfg.activeChannelId);
      run(`INSERT INTO settings(key,value) VALUES('active_channel',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, cfg.activeChannelId);
      if (hasOwn(ch, 'baseUrl') && nonEmptyString(ch.baseUrl)) run(`INSERT INTO settings(key,value) VALUES('base_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, String(ch.baseUrl));
      if (hasOwn(ch, 'modelsUrl') && nonEmptyString(ch.modelsUrl)) run(`INSERT INTO settings(key,value) VALUES('models_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, String(ch.modelsUrl));
      if (hasOwn(ch, 'model') && nonEmptyString(ch.model)) run(`INSERT INTO settings(key,value) VALUES('default_model',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, String(ch.model));
    }
  }
  if (cfg.llm !== undefined) run(`INSERT INTO settings(key,value) VALUES('replica_llm',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify(cfg.llm));
  run(`INSERT INTO settings(key,value) VALUES('replica_config_hash',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, h);
}
applyConfig();

// ---------- MIME ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.txt': 'text/plain', '.map': 'application/json', '.gif': 'image/gif',
  '.webp': 'image/webp', '.md': 'text/plain', '.wasm': 'application/wasm',
};

// ---------- 静态服务 ----------
function serveStatic(req, res, pathname) {
  let p;
  try { p = decodeURIComponent(pathname.split('?')[0]); }
  catch (e) { res.writeHead(400); res.end('bad path'); return; }
  if (p === '/' || p === '') p = '/index.html';
  const fp = path.normalize(path.join(WEB, p));
  const rel = path.relative(WEB, fp);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); res.end('forbidden'); return; }
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) { res.writeHead(404); res.end('not found'); return; }
  const ext = path.extname(fp).toLowerCase();
  if (fp.endsWith('index.html')) {
    let html = fs.readFileSync(fp, 'utf-8');
    // 构建时间戳：客户端检测到变化自动强刷一次（对抗无视 no-store 的浏览器缓存）
    const buildTs = String(Math.min(fs.statSync(fp).mtimeMs, Date.now()));
    const inject = `<script>window.__WX_BUILD__="${buildTs}";window.__WX_IPC_TOKEN__="${IPC_TOKEN}";${glue()}</script>`;
    if (!html.includes('__WRITERX_GLUE__')) {
      html = html.replace(/<head>/i, '<head>' + inject).replace(/<!doctype html>/i, (m) => m + inject);
    }
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Set-Cookie': `fabula_ipc=${IPC_TOKEN}; Path=/; HttpOnly; SameSite=Strict`,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    res.end(html);
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  fs.createReadStream(fp).pipe(res);
}

function cookieValue(req, key) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === key) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch (error) { return ''; }
    }
  }
  return '';
}

function ipcAuthorized(req) {
  const header = String(req.headers['x-fabula-token'] || '');
  const cookie = cookieValue(req, 'fabula_ipc');
  return header.length === IPC_TOKEN.length && cookie.length === IPC_TOKEN.length
    && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(IPC_TOKEN))
    && crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(IPC_TOKEN));
}

// ---------- IPC ----------
async function handleIpc(req, res, cmd) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > 32 * 1024 * 1024) {
      res.writeHead(413); res.end(JSON.stringify({ err: { message: '请求体过大' } })); return;
    }
    chunks.push(c);
  }
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch (e) {
    res.writeHead(400); res.end(JSON.stringify({ err: { message: 'bad json body' } })); return;
  }
  const args = body.args || {};
  const ctx = { send: (line) => { if (!res.writableEnded) res.write(line); } };
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  let handler = registry.TABLE[cmd];
  if (!handler && String(cmd).startsWith('plugin:')) handler = (a, cx, n) => { // 插件桩
    const stub = require('./lib/handlers-misc').pluginStub(cmd, a);
    return stub;
  };
  if (!handler) {
    if (!res.writableEnded) res.write(JSON.stringify({ err: { message: `未知 IPC 命令: ${cmd}` } }) + '\n');
    if (!res.writableEnded) res.end();
    return;
  }
  const t0 = Date.now();
  try {
    const result = await handler(args, ctx, cmd);
    if (!res.writableEnded && !ctx.sent) {
      res.write(JSON.stringify({ r: result === undefined ? null : result }) + '\n');
    }
    if (process.env.IPC_VERBOSE !== '0') console.log(`[ipc] ${cmd} OK ${Date.now() - t0}ms`);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (!res.writableEnded) res.write(JSON.stringify({ err: { message: msg } }) + '\n');
    console.log(`[ipc] ${cmd} ERR ${Date.now() - t0}ms: ${msg}`);
  } finally {
    if (!res.writableEnded) res.end();
  }
}

// ---------- 生成任务状态页 ----------
// web/ 只有预构建产物，新能力进不去主界面；这里由服务端直接渲染一个只读页面，
// 让"看任务 / 看隔离章节 / 从断点续跑"在没有前端源码的情况下也可用。
const statusPage = require('./lib/status-page');
const resumeOutcomes = new Map();

function recentResumeOutcomes() {
  const fresh = [...resumeOutcomes.entries()].filter(([, item]) => Date.now() - item.at < 10 * 60 * 1000);
  if (!fresh.length) return {};
  const failed = fresh.filter(([, item]) => !item.ok);
  const list = (failed.length ? failed : fresh)
    .map(([id, item]) => `${id.slice(0, 8)}：${item.message}`);
  return failed.length ? { error: list.join('；') } : { notice: list.join('；') };
}

async function handleStatusResume(req, res) {
  let form;
  try { form = await statusPage.readForm(req); }
  catch (error) { res.writeHead(413); res.end('too large'); return; }
  if (String(form.get('csrf') || '') !== IPC_TOKEN) { res.writeHead(403); res.end('bad csrf'); return; }
  const runId = String(form.get('runId') || '');
  const orchestrator = require('./lib/longform-orchestrator');
  const run = runId ? orchestrator.getRun(runId) : null;
  if (!run || !statusPage.RESUMABLE.has(run.status)) { res.writeHead(400); res.end('run not resumable'); return; }
  statusPage.startResume(runId, {
    resume: (id) => require('./lib/handlers-misc').resumeGenerationRun({ runId: id }),
    onSettled: (id, error, result) => {
      resumeOutcomes.set(id, error
        ? { at: Date.now(), ok: false, message: String(error.message || error).slice(0, 200) }
        : { at: Date.now(), ok: true, message: `续跑结束，新建 ${result?.created?.length || 0} 章` });
    },
  });
  resumeOutcomes.set(runId, { at: Date.now(), ok: true, message: '已启动，正在续跑…' });
  res.writeHead(303, { Location: '/status' });
  res.end();
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const origin = req.headers.origin;
  if (origin) {
    try {
      const expected = req.headers.host;
      if (new URL(origin).host !== expected) { res.writeHead(403); res.end('cross-origin request blocked'); return; }
    } catch (e) { res.writeHead(403); res.end('bad origin'); return; }
  }
  if (req.method === 'POST' && u.pathname.startsWith('/ipc/')) {
    if (!ipcAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ err: { message: 'IPC 授权失效，请刷新页面后重试' } }));
      return;
    }
    const cmd = decodeURIComponent(u.pathname.slice(5));
    handleIpc(req, res, cmd).catch((e) => {
      if (!res.writableEnded) { res.write(JSON.stringify({ err: { message: e.message } }) + '\n'); res.end(); }
    });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/status') {
    const outcome = recentResumeOutcomes();
    statusPage.sendHtml(res, statusPage.renderStatus({ csrf: IPC_TOKEN, ...outcome }));
    return;
  }
  if (req.method === 'POST' && u.pathname === '/status/resume') {
    handleStatusResume(req, res).catch((error) => {
      if (!res.writableEnded) { res.writeHead(500); res.end('resume failed'); }
      console.log('[status] resume ERR', error && error.message);
    });
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, u.pathname);
    return;
  }
  res.writeHead(405); res.end();
});

// ---------- 一次性清理：移除官方内置渠道/内置模型目录（离线版只走用户自有渠道） ----------
function purgeBuiltin() {
  let cur = [];
  try { cur = JSON.parse((one(`SELECT value FROM settings WHERE key='channels'`) || { value: '[]' }).value); } catch (e) {}
  const before = cur.length;
  cur = cur.filter((c) => c.id !== 'ch_builtin_free' && !(c && c.builtin === true && c.id && !c.baseUrl && !c.model));
  if (cur.length !== before) {
    run(`INSERT INTO settings(key,value) VALUES('channels',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, JSON.stringify(cur));
    console.log('[init] 已移除官方内置渠道（离线版仅使用你自己的渠道）');
  }
  const active = one(`SELECT value FROM settings WHERE key='active_channel'`);
  if (active && active.value === 'ch_builtin_free') {
    const first = cur.find((c) => !c.builtin);
    run(`INSERT INTO settings(key,value) VALUES('active_channel',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, first ? first.id : '');
  }
  run(`DELETE FROM settings WHERE key='llm_catalog_cache'`);
}
purgeBuiltin();

const BIND = process.env.BIND || '127.0.0.1';
server.listen(PORT, BIND, () => {
  const cfg = require('./lib/llm').activeChannel();
  console.log('┌──────────────────────────────────────────────────┐');
  console.log('│ Fabula 离线版 已启动                                │');
  console.log(`│ 打开: http://${BIND}:${PORT}                   │`);
  console.log(`│ 当前渠道: ${(cfg && (cfg.label || cfg.id)) || '（未配置，请在设置→渠道管理添加）'} `);
  console.log('└──────────────────────────────────────────────────┘');
});
