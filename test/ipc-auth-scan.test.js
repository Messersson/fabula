'use strict';

// 浏览器里 POST /ipc/* 必须同时带 X-Fabula-Token 与同源 Cookie；只带 Cookie
// 在旧标签页/进程重启后会大面积 403。这里静态扫描所有前端直连 IPC 的 fetch，
// 防止再写出漏 header 的调用点。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'web', 'assets');

function sources() {
  const files = ['lib/glue.js'];
  for (const name of fs.readdirSync(ASSETS)) {
    if (/^fabula-.*\.js$/.test(name)) files.push(path.join('web', 'assets', name));
  }
  return files;
}

test('前端直连 /ipc/ 的 fetch 都携带 X-Fabula-Token', () => {
  let checked = 0;
  for (const rel of sources()) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    const re = /fetch\(\s*[`'"]\/ipc\//g;
    let m;
    while ((m = re.exec(src))) {
      checked += 1;
      const near = src.slice(Math.max(0, m.index - 700), Math.min(src.length, m.index + 200));
      assert.match(near, /X-Fabula-Token/,
        `${rel} 偏移 ${m.index} 的 /ipc/ fetch 没带 X-Fabula-Token`);
    }
  }
  assert.ok(checked >= 4, `直连 IPC 调用点计数异常：${checked}`);
});
