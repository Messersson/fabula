'use strict';

// 优雅退出：SIGTERM 后停止监听、关闭数据库，并以 0 退出（容器滚动更新依赖它）。
// Windows 上 Node 不真正投递 SIGTERM（kill 直接终止进程），所以只在 POSIX 上验证。
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const skip = process.platform === 'win32' ? 'Windows 不投递 SIGTERM' : false;

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

test('SIGTERM 触发优雅退出并关闭数据库', { skip, timeout: 30000 }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-shutdown-'));
  const port = await freePort();
  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BIND: '127.0.0.1',
      FABULA_DATA_DIR: tempDir,
      FABULA_DB_PATH: path.join(tempDir, 'writerx.db'),
      FABULA_SQLITE_JOURNAL: 'DELETE',
      FABULA_SHUTDOWN_GRACE_MS: '5000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`服务提前退出：${output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
        if (response.status === 200) break;
      } catch (error) { /* 还没起来 */ }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.match(output, /Fabula 离线版 已启动/);

    child.kill('SIGTERM');
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`优雅退出超时：\n${output}`)), 15000);
      child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    assert.equal(code, 0, `应以 0 退出，实际 ${code}`);
    assert.match(output, /收到 SIGTERM/);
    assert.match(output, /数据库已关闭/);
  } finally {
    if (child.exitCode == null) child.kill();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        break;
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});
