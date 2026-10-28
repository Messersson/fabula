'use strict';

// 启动冒烟：用干净数据目录拉起真实 server.js，确认五个页面都能打开。
// 单元测试覆盖的是函数，这一条覆盖「装配完还能不能跑」。

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const ROOT = path.join(__dirname, '..');
let child = null;
let tempDir = '';
let baseUrl = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, getOutput, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`服务提前退出（code=${child.exitCode}）：\n${getOutput()}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200) return;
    } catch (error) {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内没有就绪：\n${getOutput()}`);
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-smoke-'));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BIND: '127.0.0.1',
      FABULA_DATA_DIR: tempDir,
      FABULA_DB_PATH: path.join(tempDir, 'writerx.db'),
      FABULA_SQLITE_JOURNAL: 'DELETE',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await waitForServer(baseUrl + '/', () => output);
});

after(async () => {
  if (child && child.exitCode == null) {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
      setTimeout(resolve, 5000).unref();
    });
  }
  // Windows 上进程退出到释放 SQLite 文件句柄之间有一小段延迟。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

test('五个页面在干净数据目录下都能打开', async () => {
  for (const pathname of ['/', '/docs', '/skills', '/review', '/status']) {
    const response = await fetch(baseUrl + pathname);
    assert.equal(response.status, 200, `${pathname} 应返回 200`);
    const html = await response.text();
    assert.ok(html.length > 0, `${pathname} 不应为空`);
  }
});

test('健康检查端点可用于容器探活', async () => {
  const response = await fetch(baseUrl + '/healthz');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, true);
  assert.ok(body.uptime >= 0);
});

test('干净启动后官方技能已经播种', async () => {
  const response = await fetch(baseUrl + '/skills');
  const html = await response.text();
  assert.match(html, /技能/, '/skills 应渲染技能广场');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(tempDir, 'writerx.db'), { readOnly: true });
  try {
    const novel = db.prepare("SELECT count(*) c FROM skills WHERE domain='novel' AND origin='official'").get().c;
    const doc = db.prepare("SELECT count(*) c FROM skills WHERE domain='doc' AND origin='official'").get().c;
    assert.ok(novel >= 25, `小说官方技能应至少 25 条，实际 ${novel}`);
    assert.ok(doc >= 30, `文档官方技能应至少 30 条，实际 ${doc}`);
  } finally {
    db.close();
  }
});
