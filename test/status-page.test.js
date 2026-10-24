'use strict';

// 状态页：无人值守的可观测面。重点验证转义与"哪些任务可续跑"。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-status-'));
process.env.FABULA_DATA_DIR = tempDir;
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';

const db = require('../lib/db');
db.open(path.join(__dirname, '..', 'data', 'writerx.seed.db'));

const core = require('../lib/handlers-core');
const orch = require('../lib/longform-orchestrator');
const statusPage = require('../lib/status-page');

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('状态页列出任务、隔离章节与用量，并给出续跑入口', () => {
  const bookId = core.createBook({ title: '状态页作品', genre: '长篇', pov: '第三人称' }).id;
  const runId = orch.createRun({
    bookId, mode: 'full', fromChapter: 1, toChapter: 3, chapterWords: 2400, maxRetries: 2, options: {},
  }).id;
  for (let n = 1; n <= 3; n++) {
    orch.ensureChapterRun({ runId, bookId, chapterNum: n });
    if (n === 1) orch.markChapterCommitted({ runId, bookId, chapterNum: n, title: '第1章', bodyChars: 100 });
    if (n === 2) orch.setChapterStatus(runId, n, 'quarantined', { bookId, error: '篇幅不达标' });
  }
  orch.quarantineRun(runId, '第2章失败');

  const html = statusPage.renderStatus({ csrf: 'test-csrf' });
  assert.match(html, /状态页作品/);
  assert.match(html, /有章节被隔离/);
  assert.match(html, /第2章：篇幅不达标/);
  assert.match(html, new RegExp(`name="runId" value="${runId}"`));
  assert.match(html, /name="csrf" value="test-csrf"/);
  assert.match(html, /1\/3 章/, '应显示已提交进度');
});

test('状态页对错误信息做 HTML 转义，不执行注入内容', () => {
  const bookId = core.createBook({ title: '<script>alert(1)</script>', genre: '长篇', pov: '第三人称' }).id;
  const runId = orch.createRun({
    bookId, mode: 'full', fromChapter: 1, toChapter: 2, chapterWords: 2400, maxRetries: 1, options: {},
  }).id;
  orch.ensureChapterRun({ runId, bookId, chapterNum: 1 });
  orch.setChapterStatus(runId, 1, 'quarantined', { bookId, error: '<img src=x onerror=alert(1)>' });

  const html = statusPage.renderStatus({ csrf: 'x' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('只有未结束的任务才允许续跑', () => {
  assert.ok(statusPage.RESUMABLE.has('quarantined'));
  assert.ok(statusPage.RESUMABLE.has('paused_budget'));
  assert.ok(statusPage.RESUMABLE.has('running'));
  assert.ok(!statusPage.RESUMABLE.has('completed'));
  assert.ok(!statusPage.RESUMABLE.has('cancelled'));
  assert.ok(!statusPage.RESUMABLE.has('abandoned'));
});
