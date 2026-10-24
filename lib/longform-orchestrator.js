'use strict';

// Durable execution state for book-scale generation. Manuscript text stays in
// Markdown files; this module records enough state to resume safely after a
// timeout, model error, cancellation, or process restart.
const crypto = require('node:crypto');
const { q, one, run, transaction } = require('./db');

const ACTIVE_STATUSES = ['queued', 'running', 'retrying', 'quarantined', 'paused_budget'];
const TERMINAL_STATUSES = ['completed', 'cancelled', 'abandoned'];
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 1000;
const DEFAULT_RETRY_MAX_MS = 30000;

const uid = () => crypto.randomUUID();
const now = () => Date.now();

function asPositiveInt(value, fallback = 0) {
  const number = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function rowRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookId: row.book_id,
    mode: row.mode,
    status: row.status,
    fromChapter: Number(row.from_chapter),
    toChapter: Number(row.to_chapter),
    currentChapter: Number(row.current_chapter),
    totalChapters: Number(row.total_chapters),
    chapterWords: Number(row.chapter_words),
    maxRetries: Number(row.max_retries),
    attemptCount: Number(row.attempt_count),
    options: parseJson(row.options_json, {}),
    lastError: row.last_error || '',
    startedAt: row.started_at ? Number(row.started_at) : null,
    completedAt: row.completed_at ? Number(row.completed_at) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function getRun(runId) {
  if (!runId) return null;
  return rowRun(one(`SELECT * FROM generation_runs WHERE id=?`, String(runId)));
}

function findResumableRun(bookId, mode = 'full', preferredRunId = '') {
  if (!bookId) return null;
  if (preferredRunId) {
    const preferred = getRun(preferredRunId);
    if (preferred && preferred.bookId === String(bookId) && preferred.mode === mode &&
        ACTIVE_STATUSES.includes(preferred.status)) return preferred;
  }
  return rowRun(one(`SELECT * FROM generation_runs
    WHERE book_id=? AND mode=? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})
    ORDER BY updated_at DESC LIMIT 1`, String(bookId), mode, ...ACTIVE_STATUSES));
}

// Only runs whose chapter range actually overlaps get abandoned. Two runs over
// disjoint ranges (e.g. backfilling 1-20 while 300-400 continues) can coexist
// without either one being silently killed.
function abandonActiveRuns(bookId, exceptRunId = '', { from = 0, to = 0 } = {}) {
  if (!bookId) return 0;
  const stamp = now();
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
  const ranged = Number(from) > 0 && Number(to) > 0;
  const result = run(`UPDATE generation_runs SET status='abandoned', completed_at=?, updated_at=?
    WHERE book_id=? AND id<>? AND status IN (${placeholders})
    ${ranged ? 'AND from_chapter<=? AND to_chapter>=?' : ''}`,
  stamp, stamp, String(bookId), String(exceptRunId || ''), ...ACTIVE_STATUSES,
  ...(ranged ? [Number(to), Number(from)] : []));
  return result.changes;
}

function createRun({ bookId, mode = 'full', fromChapter, toChapter, chapterWords = 0,
  maxRetries = DEFAULT_MAX_RETRIES, options = {} }) {
  if (!bookId) throw new Error('missing bookId');
  const from = asPositiveInt(fromChapter, 1);
  const to = asPositiveInt(toChapter, from);
  if (to < from) throw new Error('invalid generation range');
  const id = uid();
  const stamp = now();
  transaction(() => {
    abandonActiveRuns(bookId, '', { from, to });
    run(`INSERT INTO generation_runs(id, book_id, mode, status, from_chapter, to_chapter,
      current_chapter, total_chapters, chapter_words, max_retries, attempt_count,
      options_json, started_at, created_at, updated_at)
      VALUES(?,?,?,'running',?,?,?,?,?,?,0,?,?,?,?)`,
    id, String(bookId), String(mode), from, to, Math.max(0, from - 1), to - from + 1,
    asPositiveInt(chapterWords), Math.max(1, asPositiveInt(maxRetries, DEFAULT_MAX_RETRIES)),
    JSON.stringify(options || {}), stamp, stamp, stamp);
  });
  return getRun(id);
}

function setRunStatus(runId, status, { error = '', currentChapter = null } = {}) {
  if (!runId) return;
  const stamp = now();
  const terminal = TERMINAL_STATUSES.includes(status);
  run(`UPDATE generation_runs SET status=?, last_error=?,
    current_chapter=CASE WHEN ? IS NULL THEN current_chapter ELSE MAX(current_chapter, ?) END,
    completed_at=CASE WHEN ? THEN ? ELSE completed_at END, updated_at=? WHERE id=?`,
  status, error ? String(error).slice(0, 4000) : null,
  currentChapter == null ? null : Number(currentChapter), Number(currentChapter) || 0,
  terminal ? 1 : 0, stamp, stamp, String(runId));
}

function resumeRun(runId) {
  const current = getRun(runId);
  if (!current || !ACTIVE_STATUSES.includes(current.status)) return current;
  const stamp = now();
  run(`UPDATE generation_runs SET status='running', last_error=NULL,
    started_at=COALESCE(started_at, ?), completed_at=NULL, updated_at=? WHERE id=?`,
  stamp, stamp, String(runId));
  return getRun(runId);
}

function updateRunProgress(runId, chapterNum) {
  if (!runId || !chapterNum) return;
  const stamp = now();
  run(`UPDATE generation_runs SET status='running', current_chapter=MAX(current_chapter, ?), updated_at=?
    WHERE id=?`, Number(chapterNum), stamp, String(runId));
}

function completeRun(runId) {
  setRunStatus(runId, 'completed');
}

function quarantineRun(runId, error) {
  setRunStatus(runId, 'quarantined', { error: error instanceof Error ? error.message : String(error || '') });
}

// 预算用尽不是失败：保留断点，等人工确认后可以原样续跑。
function pauseRun(runId, reason) {
  setRunStatus(runId, 'paused_budget', { error: reason });
}

function runUsage(runId) {
  const row = one(`SELECT COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
    COALESCE(SUM(completion_tokens),0) AS completion_tokens
    FROM generation_attempts WHERE run_id=?`, String(runId));
  const promptTokens = Number(row?.prompt_tokens || 0);
  const completionTokens = Number(row?.completion_tokens || 0);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

// 续跑点：范围内第一个未提交的章节。已被隔离的章节会重新排队，允许再试一次。
function resumePoint(runId) {
  const runRow = getRun(runId);
  if (!runRow) return null;
  const rows = q(`SELECT chapter_num, status FROM chapter_runs WHERE run_id=? ORDER BY chapter_num`, String(runId));
  const byChapter = new Map(rows.map((row) => [Number(row.chapter_num), row.status]));
  let fromChapter = runRow.toChapter;
  for (let n = runRow.fromChapter; n <= runRow.toChapter; n++) {
    if (byChapter.get(n) !== 'committed') { fromChapter = n; break; }
    fromChapter = Math.min(n + 1, runRow.toChapter);
  }
  const pending = rows.filter((row) => row.status !== 'committed').map((row) => Number(row.chapter_num));
  return {
    run: runRow,
    fromChapter,
    toChapter: runRow.toChapter,
    // 只重排范围内真正没写完的章节，已提交的绝不动。
    reopen: pending.filter((n) => n >= fromChapter && n <= runRow.toChapter),
  };
}

function reopenChapters(runId, chapterNums = []) {
  const list = (chapterNums || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!list.length) return 0;
  let changed = 0;
  transaction(() => {
    for (const n of list) {
      const result = run(`UPDATE chapter_runs SET status='planned', last_error=NULL, committed_at=NULL, updated_at=?
        WHERE run_id=? AND chapter_num=? AND status<>'committed'`, now(), String(runId), n);
      changed += Number(result.changes || 0);
    }
  });
  return changed;
}

function cancelRun(runId, error = '') {
  setRunStatus(runId, 'cancelled', { error });
}

function cancelActiveRun(bookId, error = '') {
  if (!bookId) return 0;
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',');
  const stamp = now();
  const result = run(`UPDATE generation_runs SET status='cancelled', last_error=?, completed_at=?, updated_at=?
    WHERE book_id=? AND status IN (${placeholders})`,
  error ? String(error).slice(0, 4000) : null, stamp, stamp, String(bookId), ...ACTIVE_STATUSES);
  return result.changes;
}

function bookIdForRun(runId) {
  if (!runId) return '';
  return String(one(`SELECT book_id FROM generation_runs WHERE id=?`, String(runId))?.book_id || '');
}

function ensureChapterRun({ runId, bookId = '', chapterNum }) {
  if (!runId || !chapterNum) return;
  // chapter_runs.book_id is NOT NULL; derive it from the run so callers that
  // only know the run id cannot insert an empty book reference.
  const owner = String(bookId || bookIdForRun(runId) || '');
  const stamp = now();
  run(`INSERT INTO chapter_runs(run_id, book_id, chapter_num, status, created_at, updated_at)
    VALUES(?,?,?,'planned',?,?) ON CONFLICT(run_id, chapter_num) DO NOTHING`,
  String(runId), owner, Number(chapterNum), stamp, stamp);
}

function setChapterStatus(runId, chapterNum, status, fields = {}) {
  if (!runId || !chapterNum) return;
  ensureChapterRun({ runId, bookId: fields.bookId || '', chapterNum });
  const stamp = now();
  const current = one(`SELECT * FROM chapter_runs WHERE run_id=? AND chapter_num=?`,
    String(runId), Number(chapterNum));
  run(`UPDATE chapter_runs SET status=?, attempt_count=?, title=?, outline_path=?, body_path=?,
    body_chars=?, quality_json=?, last_error=?, committed_at=?, updated_at=?
    WHERE run_id=? AND chapter_num=?`,
  status,
  fields.attemptCount == null ? Number(current?.attempt_count || 0) : Number(fields.attemptCount),
  fields.title == null ? current?.title || null : String(fields.title).slice(0, 500),
  fields.outlinePath == null ? current?.outline_path || null : String(fields.outlinePath),
  fields.bodyPath == null ? current?.body_path || null : String(fields.bodyPath),
  fields.bodyChars == null ? Number(current?.body_chars || 0) : Number(fields.bodyChars),
  fields.quality == null ? current?.quality_json || null : JSON.stringify(fields.quality),
  fields.error == null ? current?.last_error || null : String(fields.error).slice(0, 4000),
  fields.committedAt == null ? current?.committed_at || null : Number(fields.committedAt),
  stamp, String(runId), Number(chapterNum));
}

function markChapterCommitted({ runId, bookId, chapterNum, title, outlinePath, bodyPath,
  bodyChars, quality, attemptCount }) {
  setChapterStatus(runId, chapterNum, 'committed', {
    bookId, title, outlinePath, bodyPath, bodyChars, quality, attemptCount,
    error: '', committedAt: now(),
  });
  updateRunProgress(runId, chapterNum);
}

function recordReview({ runId, bookId, chapterNum, attemptNo = 1, review }) {
  if (!runId || !review) return;
  run(`INSERT INTO chapter_reviews(run_id, book_id, chapter_num, attempt_no, verdict, score,
    issues_json, metrics_json, created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
  String(runId), String(bookId), Number(chapterNum), Number(attemptNo),
  review.passed ? 'pass' : 'fail', Number(review.score) || 0,
  JSON.stringify(review.issues || []), JSON.stringify(review.metrics || {}), now());
}

function beginAttempt({ runId, bookId, chapterNum, phase, attemptNo }) {
  if (!runId) return null;
  const startedAt = now();
  const result = run(`INSERT INTO generation_attempts(run_id, book_id, chapter_num, phase,
    attempt_no, status, started_at) VALUES(?,?,?,?,?,'running',?)`,
  String(runId), String(bookId), Number(chapterNum), String(phase), Number(attemptNo), startedAt);
  run(`UPDATE generation_runs SET attempt_count=attempt_count+1, updated_at=? WHERE id=?`,
    startedAt, String(runId));
  return { id: result.lastInsertRowid, startedAt };
}

function finishAttempt(attempt, { status, error = null, errorKind = null, usage = null }) {
  if (!attempt?.id) return;
  const finishedAt = now();
  const promptTokens = Math.max(0, Number(usage?.promptTokens || 0));
  const completionTokens = Math.max(0, Number(usage?.completionTokens || 0));
  run(`UPDATE generation_attempts SET status=?, error_kind=?, error_message=?,
    finished_at=?, duration_ms=?, prompt_tokens=?, completion_tokens=? WHERE id=?`,
  String(status), errorKind, error ? String(error).slice(0, 4000) : null,
  finishedAt, Math.max(0, finishedAt - attempt.startedAt),
  promptTokens, completionTokens, attempt.id);
}

function classifyError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '').toLowerCase();
  const status = Number(error?.status || error?.statusCode || 0);
  if (code === 'BATCH_CANCELLED' || /cancelled|canceled|已取消/.test(message)) return 'cancelled';
  if (status === 401 || status === 403 || /unauthorized|forbidden|invalid api key|鉴权|密钥/.test(message)) return 'auth';
  if (code === 'TOKEN_RUNAWAY') return 'budget';
  if (code === 'QUALITY_GATE' || /quality gate|质量门禁|篇幅|完整收尾/.test(message)) return 'quality';
  if (status === 429 || /rate.?limit|too many requests|限流/.test(message)) return 'rate_limit';
  if (/timeout|timed out|etimedout|超时/.test(message)) return 'timeout';
  if (/econnreset|econnrefused|enotfound|socket|network|fetch failed|网络/.test(message)) return 'network';
  if (/context|token limit|too long|上下文/.test(message)) return 'context';
  return 'model';
}

function isRetryableError(error, errorKind = classifyError(error)) {
  // budget 表示这一章已经烧掉远超预期的 token，重试只会继续烧。
  if (['cancelled', 'auth', 'context', 'budget'].includes(errorKind)) return false;
  if (error?.retryable === false) return false;
  return true;
}

function retryDelayMs(attemptNo, { baseDelayMs = DEFAULT_RETRY_BASE_MS,
  maxDelayMs = DEFAULT_RETRY_MAX_MS, error = null } = {}) {
  const requested = Number(error?.retryAfterMs);
  if (Number.isFinite(requested) && requested >= 0) return Math.min(maxDelayMs, requested);
  const base = Math.max(0, Number(baseDelayMs) || 0);
  const max = Math.max(base, Number(maxDelayMs) || DEFAULT_RETRY_MAX_MS);
  return Math.min(max, base * (2 ** Math.max(0, Number(attemptNo) - 1)));
}

function sleep(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeWithRetry({ runId = '', bookId = '', chapterNum = 0, phase,
  maxAttempts = DEFAULT_MAX_RETRIES, baseDelayMs = DEFAULT_RETRY_BASE_MS,
  maxDelayMs = DEFAULT_RETRY_MAX_MS, task, onRetry = null, shouldRetry = null }) {
  if (typeof task !== 'function') throw new Error('retry task is required');
  const limit = Math.max(1, asPositiveInt(maxAttempts, DEFAULT_MAX_RETRIES));
  let lastError = null;
  for (let attemptNo = 1; attemptNo <= limit; attemptNo++) {
    const attempt = beginAttempt({ runId, bookId, chapterNum, phase, attemptNo });
    const usage = { promptTokens: 0, completionTokens: 0 };
    const recordUsage = (raw) => {
      if (!raw) return;
      usage.promptTokens += Number(raw.prompt_tokens || raw.promptTokens || 0) || 0;
      usage.completionTokens += Number(raw.completion_tokens || raw.completionTokens || 0) || 0;
    };
    try {
      const result = await task(attemptNo, recordUsage);
      finishAttempt(attempt, { status: 'succeeded', usage });
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const kind = classifyError(lastError);
      finishAttempt(attempt, { status: 'failed', error: lastError.message, errorKind: kind, usage });
      const retry = attemptNo < limit &&
        (typeof shouldRetry === 'function' ? shouldRetry(lastError, kind, attemptNo) : isRetryableError(lastError, kind));
      if (!retry) {
        lastError.attempts = attemptNo;
        lastError.errorKind = kind;
        throw lastError;
      }
      const delayMs = retryDelayMs(attemptNo, { baseDelayMs, maxDelayMs, error: lastError });
      if (typeof onRetry === 'function') {
        await onRetry({ error: lastError, errorKind: kind, attemptNo, nextAttemptNo: attemptNo + 1, delayMs });
      }
      await sleep(delayMs);
    }
  }
  throw lastError || new Error('generation failed');
}

function runDiagnostics(runId) {
  const runRow = getRun(runId);
  if (!runRow) return null;
  const chapters = q(`SELECT chapter_num, status, attempt_count, body_chars, quality_json,
    last_error, committed_at FROM chapter_runs WHERE run_id=? ORDER BY chapter_num`, String(runId));
  const attempts = one(`SELECT COUNT(*) AS count, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
    COALESCE(SUM(prompt_tokens),0) AS prompt_tokens, COALESCE(SUM(completion_tokens),0) AS completion_tokens
    FROM generation_attempts WHERE run_id=?`, String(runId));
  const reviews = one(`SELECT COUNT(*) AS count, AVG(score) AS avg_score,
    SUM(CASE WHEN verdict='fail' THEN 1 ELSE 0 END) AS failed
    FROM chapter_reviews WHERE run_id=?`, String(runId));
  return {
    run: runRow,
    chapters: chapters.map((chapter) => ({
      chapterNum: Number(chapter.chapter_num),
      status: chapter.status,
      attemptCount: Number(chapter.attempt_count),
      bodyChars: Number(chapter.body_chars),
      quality: parseJson(chapter.quality_json, null),
      lastError: chapter.last_error || '',
      committedAt: chapter.committed_at ? Number(chapter.committed_at) : null,
    })),
    attempts: {
      total: Number(attempts?.count || 0),
      failed: Number(attempts?.failed || 0),
      promptTokens: Number(attempts?.prompt_tokens || 0),
      completionTokens: Number(attempts?.completion_tokens || 0),
    },
    chapterStats: chapters.reduce((acc, chapter) => {
      acc[chapter.status] = (acc[chapter.status] || 0) + 1;
      return acc;
    }, {}),
    quarantined: chapters
      .filter((chapter) => chapter.status === 'quarantined')
      .map((chapter) => ({ chapterNum: Number(chapter.chapter_num), lastError: chapter.last_error || '' })),
    reviews: {
      total: Number(reviews?.count || 0),
      failed: Number(reviews?.failed || 0),
      averageScore: reviews?.avg_score == null ? null : Number(reviews.avg_score),
    },
  };
}

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  DEFAULT_MAX_RETRIES,
  classifyError,
  isRetryableError,
  retryDelayMs,
  getRun,
  findResumableRun,
  createRun,
  resumeRun,
  pauseRun,
  runUsage,
  resumePoint,
  reopenChapters,
  updateRunProgress,
  completeRun,
  quarantineRun,
  cancelRun,
  cancelActiveRun,
  ensureChapterRun,
  setChapterStatus,
  markChapterCommitted,
  recordReview,
  executeWithRetry,
  runDiagnostics,
};
