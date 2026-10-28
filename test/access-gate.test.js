'use strict';

// 非回环访问门禁：默认只信任 127.0.0.1；绑定 0.0.0.0 时必须带口令。
const assert = require('node:assert/strict');
const { test } = require('node:test');

const gate = require('../lib/access-gate');

function req({ remote = '192.168.1.20', headers = {}, cookie = '' } = {}) {
  return {
    socket: { remoteAddress: remote },
    headers: cookie ? { ...headers, cookie } : headers,
  };
}

test('回环地址识别覆盖 IPv4 / IPv6 / 映射地址', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '[::1]', '0:0:0:0:0:0:0:1']) {
    assert.equal(gate.isLoopback(address), true, `${address} 应视为本机`);
  }
  for (const address of ['', '192.168.1.2', '10.0.0.8', '::ffff:192.168.1.2', '8.8.8.8']) {
    assert.equal(gate.isLoopback(address), false, `${address} 不应视为本机`);
  }
});

test('口令来源：显式环境变量 > 非回环自动生成 > 回环免密', () => {
  const explicit = gate.resolveAccess({ bind: '0.0.0.0', envToken: 'open-sesame' });
  assert.equal(explicit.token, 'open-sesame');
  assert.equal(explicit.source, 'env');

  const generated = gate.resolveAccess({ bind: '0.0.0.0' });
  assert.ok(generated.token.length >= 20, '非回环必须生成一个足够长的口令');
  assert.equal(generated.source, 'generated');

  const local = gate.resolveAccess({ bind: '127.0.0.1' });
  assert.equal(local.token, '');
  assert.equal(local.required, false);
  assert.equal(gate.resolveAccess({ bind: 'localhost' }).required, false);
});

test('口令可以来自 header / Bearer / cookie', () => {
  assert.equal(gate.tokenFromRequest(req({ headers: { 'x-fabula-access': 'abc' } })), 'abc');
  assert.equal(gate.tokenFromRequest(req({ headers: { authorization: 'Bearer xyz' } })), 'xyz');
  assert.equal(gate.tokenFromRequest(req({ cookie: 'foo=1; fabula_access=from-cookie; bar=2' })), 'from-cookie');
  assert.equal(gate.tokenFromRequest(req()), '');
});

test('门禁只放行本机或持有正确口令的访客', () => {
  const token = 'secret-token';
  assert.equal(gate.accessAllowed({ req: req({ remote: '127.0.0.1' }), token }), true);
  assert.equal(gate.accessAllowed({ req: req(), token }), false);
  assert.equal(gate.accessAllowed({
    req: req({ headers: { 'x-fabula-access': 'secret-token' } }), token,
  }), true);
  assert.equal(gate.accessAllowed({ req: req(), token: '' }), true, '未启用门禁时全部放行');
  assert.equal(gate.safeEqual('abc', 'abc'), true);
  assert.equal(gate.safeEqual('abc', 'abd'), false);
  assert.equal(gate.safeEqual('', ''), false, '空口令不能互相匹配');
});

test('登录页带失败提示且不反射外部输入', () => {
  const html = gate.renderLogin({ failed: true });
  assert.match(html, /需要访问口令/);
  assert.match(html, /口令不正确/);
  assert.match(html, /method="get"/);
  assert.match(html, /name="access"/);
  // 页面没有任何动态插值：不存在把 query 原样回显导致 XSS 的路径。
  assert.ok(!html.includes('<script src='));
});
