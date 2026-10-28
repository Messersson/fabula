// 非回环访问门禁。
//
// 背景：离线版是单用户工具，默认只绑 127.0.0.1；一旦用 BIND=0.0.0.0
// 放进 Docker 或局域网，任何能访问端口的人都应被视为「本机用户」吗？答案是否。
// 这里把「本机」与「网络访客」分开：回环地址免密；网络访客必须持有访问口令，
// 口令通过一次性的 ?access= 换 HttpOnly cookie，之后不再出现在 URL 里。
'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'fabula_access';
const LOOPBACK_NAMES = new Set(['localhost']);

function isLoopback(address) {
  let value = String(address || '').trim().toLowerCase();
  if (!value) return false;
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value.startsWith('::ffff:')) value = value.slice(7);
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  if (value.startsWith('127.')) return true;
  return false;
}

function isLoopbackBind(bind) {
  const value = String(bind || '').trim().toLowerCase();
  if (!value) return false;
  return isLoopback(value) || LOOPBACK_NAMES.has(value);
}

function cookieValue(header, key) {
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === key) {
      try { return decodeURIComponent(part.slice(index + 1).trim()); } catch (error) { return ''; }
    }
  }
  return '';
}

function tokenFromRequest(req) {
  const headers = (req && req.headers) || {};
  const header = String(headers['x-fabula-access'] || '').trim();
  if (header) return header;
  const auth = String(headers.authorization || '');
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return cookieValue(headers.cookie, COOKIE_NAME);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

// 口令策略：
// - 显式 FABULA_ACCESS_TOKEN 永远优先（部署时固定，重启不失效）。
// - 绑定非回环且没给口令时自动生成一个，启动日志打印，避免「裸奔」。
// - 只绑回环且没给口令时不启用，保持桌面版零打扰。
function resolveAccess({ bind = '', envToken = '' } = {}) {
  const explicit = String(envToken || '').trim();
  if (explicit) return { token: explicit, source: 'env', required: true };
  if (!isLoopbackBind(bind)) {
    return { token: crypto.randomBytes(24).toString('base64url'), source: 'generated', required: true };
  }
  return { token: '', source: 'none', required: false };
}

function accessAllowed({ req, token, trustLoopback = true } = {}) {
  if (!token) return true;
  const remote = req && req.socket ? req.socket.remoteAddress : '';
  if (trustLoopback && isLoopback(remote)) return true;
  return safeEqual(tokenFromRequest(req), token);
}

function renderLogin({ failed = false } = {}) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fabula · 访问口令</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #f6f7f9; color: #1c1f23;
    font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .card { width: min(380px, 100%); background: #fff; border-radius: 12px; padding: 28px;
    box-shadow: 0 1px 2px rgba(16,24,40,.06), 0 8px 24px rgba(16,24,40,.08); }
  h1 { font-size: 17px; margin: 0 0 6px; }
  p { color: #6b7280; font-size: 13px; margin: 0 0 18px; }
  label { display: block; font-size: 12px; color: #374151; margin-bottom: 6px; }
  input { width: 100%; font: inherit; font-size: 14px; padding: 9px 11px; border-radius: 8px;
    border: 1px solid #d5d9df; background: #fff; color: #1c1f23; }
  input:focus { outline: 2px solid #c7d7f5; border-color: #8fb0ea; }
  button { width: 100%; margin-top: 14px; font: inherit; font-size: 14px; padding: 9px 12px;
    border-radius: 8px; border: 1px solid #1c4f9c; background: #1c4f9c; color: #fff; cursor: pointer; }
  button:hover { background: #17407f; }
  .err { background: #fdecec; color: #a1231f; border-radius: 8px; padding: 8px 10px;
    font-size: 12px; margin: 0 0 14px; }
  .hint { color: #8a919b; font-size: 12px; margin: 14px 0 0; }
</style></head>
<body>
  <form class="card" method="get" action="">
    <h1>需要访问口令</h1>
    <p>这台 Fabula 监听在非本机地址上。输入部署日志里打印的口令，或部署时设置的 FABULA_ACCESS_TOKEN。</p>
    ${failed ? '<div class="err">口令不正确，请重试。</div>' : ''}
    <label for="access">访问口令</label>
    <input id="access" name="access" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">进入工作台</button>
    <p class="hint">口令只用于本机/局域网访问，不会上传到任何第三方。</p>
  </form>
</body></html>`;
}

module.exports = {
  COOKIE_NAME,
  isLoopback,
  isLoopbackBind,
  cookieValue,
  tokenFromRequest,
  safeEqual,
  resolveAccess,
  accessAllowed,
  renderLogin,
};
