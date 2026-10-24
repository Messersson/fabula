'use strict';

// 无人值守编排器：重试、隔离、断点续跑、Token 记账。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-orch-'));
process.env.FABULA_DATA_DIR = tempDir;
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';

const db = require('../lib/db');
db.open(path.join(__dirname, '..', 'data', 'writerx.seed.db'));

const orch = require('../lib/longform-orchestrator');

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const BOOK = 'orch-test-book';

function newRun(from = 1, to = 5, maxRetries = 3) {
  return orch.createRun({ bookId: BOOK, mode: 'full', fromChapter: from, toChapter: to, maxRetries });
}

test('瞬时错误会按退避重试，并累计每次尝试的 Token', async () => {
  const run = newRun(1, 1);
  let calls = 0;
  const result = await orch.executeWithRetry({
    runId: run.id, bookId: BOOK, chapterNum: 1, phase: 'body', maxAttempts: 3,
    baseDelayMs: 1, maxDelayMs: 2,
    task: async (attemptNo, recordUsage) => {
      calls += 1;
      recordUsage({ prompt_tokens: 100, completion_tokens: 40 });
      if (attemptNo < 3) throw new Error('socket hang up');
      return 'ok';
    },
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);

  const attempts = db.q(`SELECT attempt_no, status, prompt_tokens, completion_tokens
    FROM generation_attempts WHERE run_id=? ORDER BY attempt_no`, run.id);
  assert.deepEqual(attempts.map((row) => row.status), ['failed', 'failed', 'succeeded']);
  assert.deepEqual(attempts.map((row) => Number(row.prompt_tokens)), [100, 100, 100]);
  assert.equal(attempts.reduce((sum, row) => sum + Number(row.completion_tokens), 0), 120);

  const diagnostics = orch.runDiagnostics(run.id);
  assert.equal(diagnostics.attempts.total, 3);
  assert.equal(diagnostics.attempts.failed, 2);
  assert.equal(diagnostics.attempts.promptTokens, 300);
  assert.equal(diagnostics.attempts.completionTokens, 120);
});

test('鉴权错误不重试，直接失败', async () => {
  const run = newRun(2, 2);
  let calls = 0;
  await assert.rejects(() => orch.executeWithRetry({
    runId: run.id, bookId: BOOK, chapterNum: 2, phase: 'body', maxAttempts: 3, baseDelayMs: 1,
    task: async () => {
      calls += 1;
      throw Object.assign(new Error('invalid api key'), { status: 401 });
    },
  }), /invalid api key/);
  assert.equal(calls, 1);
});

test('质量门禁失败耗尽重试后，章节被隔离且任务仍可续跑', async () => {
  const run = newRun(3, 3, 2);
  await assert.rejects(() => orch.executeWithRetry({
    runId: run.id, bookId: BOOK, chapterNum: 3, phase: 'body', maxAttempts: 2, baseDelayMs: 1,
    task: async () => {
      throw Object.assign(new Error('正文未达到篇幅或未完整收尾（900/2400 字）'), { code: 'QUALITY_GATE' });
    },
  }), /未达到篇幅/);

  orch.setChapterStatus(run.id, 3, 'quarantined', { bookId: BOOK, error: '篇幅不足', attemptCount: 2 });
  orch.quarantineRun(run.id, '存在被隔离的章节');

  const diagnostics = orch.runDiagnostics(run.id);
  assert.equal(diagnostics.chapterStats.quarantined, 1);
  assert.equal(diagnostics.quarantined.length, 1);
  assert.equal(diagnostics.quarantined[0].chapterNum, 3);

  const resumable = orch.findResumableRun(BOOK);
  assert.equal(resumable.id, run.id, '被隔离的任务必须仍能被找回续跑');
  const resumed = orch.resumeRun(run.id);
  assert.equal(resumed.status, 'running');
});

test('只传 runId 时 chapter_runs 仍写入正确 book_id', () => {
  const run = newRun(7, 7);
  orch.setChapterStatus(run.id, 7, 'drafted', { bodyChars: 1200 });
  const row = db.one(`SELECT book_id, status, body_chars FROM chapter_runs WHERE run_id=? AND chapter_num=7`, run.id);
  assert.equal(row.book_id, BOOK);
  assert.equal(row.status, 'drafted');
  assert.equal(Number(row.body_chars), 1200);
});

test('不相交的章节范围不会被新任务误弃，相交的会被弃', () => {
  const left = orch.createRun({ bookId: BOOK, mode: 'full', fromChapter: 1, toChapter: 20 });
  const right = orch.createRun({ bookId: BOOK, mode: 'full', fromChapter: 300, toChapter: 400 });
  assert.equal(orch.getRun(left.id).status, 'running', '不重叠的任务必须存活');
  assert.equal(orch.getRun(right.id).status, 'running');

  const overlap = orch.createRun({ bookId: BOOK, mode: 'full', fromChapter: 300, toChapter: 320 });
  assert.equal(orch.getRun(left.id).status, 'running');
  assert.equal(orch.getRun(right.id).status, 'abandoned', '重叠范围必须被弃，避免双写同章');
  assert.equal(orch.getRun(overlap.id).status, 'running');
});

test('重试延迟按指数退避并尊重服务端 retryAfterMs', () => {
  assert.equal(orch.retryDelayMs(1, { baseDelayMs: 1000, maxDelayMs: 30000 }), 1000);
  assert.equal(orch.retryDelayMs(3, { baseDelayMs: 1000, maxDelayMs: 30000 }), 4000);
  assert.equal(orch.retryDelayMs(9, { baseDelayMs: 1000, maxDelayMs: 30000 }), 30000);
  assert.equal(orch.retryDelayMs(1, { baseDelayMs: 1000, maxDelayMs: 30000, error: { retryAfterMs: 7000 } }), 7000);
});

test('取消状态不会被当作可重试错误', () => {
  const error = Object.assign(new Error('任务已取消，已完成章节会保留'), { code: 'BATCH_CANCELLED' });
  assert.equal(orch.classifyError(error), 'cancelled');
  assert.equal(orch.isRetryableError(error), false);
});
