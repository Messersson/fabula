'use strict';

// 访问门禁的端到端验证：服务绑 0.0.0.0 时，从非回环地址访问必须凭口令换取会话。
// 单机测试通过本机网卡地址访问自己，源地址就是非回环地址；没有可用网卡时跳过。
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const TOKEN = 'gate-test-token';

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '';
}

function freePort(host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

const address = lanAddress();
const skip = !address ? '没有可用的非回环 IPv4 地址' : false;
let child = null;
let tempDir = '';
let baseUrl = '';

before(async () => {
  if (skip) return;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-gate-'));
  const port = await freePort();
  baseUrl = `http://${address}:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BIND: '0.0.0.0',
      FABULA_ACCESS_TOKEN: TOKEN,
      FABULA_DATA_DIR: tempDir,
      FABULA_DB_PATH: path.join(tempDir, 'writerx.db'),
      FABULA_SQLITE_JOURNAL: 'DELETE',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`服务提前退出（code=${child.exitCode}）`);
    try {
      const response = await fetch(baseUrl + '/healthz', { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return;
    } catch (error) { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('服务未在 30 秒内就绪');
});

after(async () => {
  if (child && child.exitCode == null) {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
      setTimeout(resolve, 5000).unref();
    });
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

test('非回环访客没有口令拿不到页面与 IPC token', { skip }, async () => {
  const response = await fetch(baseUrl + '/', { redirect: 'manual' });
  assert.equal(response.status, 401);
  const html = await response.text();
  assert.match(html, /需要访问口令/);
  assert.ok(!html.includes('__WX_IPC_TOKEN__'), '未授权页面不能带 IPC token');
});

test('错误口令被拒绝', { skip }, async () => {
  const response = await fetch(`${baseUrl}/?access=wrong-token`, { redirect: 'manual' });
  assert.equal(response.status, 401);
  assert.match(await response.text(), /口令不正确/);
});

test('正确口令换取 HttpOnly 会话后正常打开工作台', { skip }, async () => {
  const first = await fetch(`${baseUrl}/?access=${TOKEN}`, { redirect: 'manual' });
  assert.equal(first.status, 303);
  assert.equal(first.headers.get('location'), '/');
  const cookie = String(first.headers.get('set-cookie') || '');
  assert.match(cookie, /fabula_access=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);

  const session = cookie.split(';')[0];
  const page = await fetch(baseUrl + '/', { headers: { cookie: session } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('__WX_IPC_TOKEN__'), '授权后应注入 IPC token');
});

test('健康检查不需要口令，方便容器探活', { skip }, async () => {
  const response = await fetch(baseUrl + '/healthz');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});
