'use strict';

// 无人值守的观测面。
//
// 为什么单独做一个页面而不是加进主界面：web/ 下只有预构建产物（app-*.js），
// 没有前端源码，任何新能力都进不去。这个页面由服务端直接渲染，不依赖构建链。
//
// 只做三件事：看任务状态、看隔离章节、从断点续跑。
// 变更类操作要求带上页面内嵌的 CSRF 令牌（跨站读不到这个页面，因此拿不到令牌）。
const { q, one } = require('./db');

const RUN_STATUS_TEXT = {
  running: '进行中',
  queued: '排队中',
  retrying: '重试中',
  quarantined: '有章节被隔离',
  paused_budget: '预算暂停',
  completed: '已完成',
  cancelled: '已取消',
  abandoned: '已放弃',
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatTime(ms) {
  if (!ms) return '';
  const date = new Date(Number(ms));
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function statusClass(status) {
  if (status === 'completed') return 'ok';
  if (status === 'running' || status === 'queued' || status === 'retrying') return 'live';
  if (status === 'paused_budget') return 'warn';
  return 'bad';
}

function collectRuns(limit = 40) {
  // LEFT JOIN books + doc_projects：小说任务与文档任务同页展示（mode='doc' 的 book_id 是文档项目 id）。
  const rows = q(`SELECT r.*, COALESCE(b.title, d.title, '（已删除的作品）') AS display_title,
      CASE WHEN d.id IS NOT NULL THEN 1 ELSE 0 END AS is_doc, d.doc_type
    FROM generation_runs r
    LEFT JOIN books b ON b.id = r.book_id
    LEFT JOIN doc_projects d ON d.id = r.book_id
    ORDER BY r.updated_at DESC LIMIT ?`, limit);
  return rows.map((row) => {
    const counts = one(`SELECT
      SUM(CASE WHEN status='committed' THEN 1 ELSE 0 END) AS committed,
      SUM(CASE WHEN status='quarantined' THEN 1 ELSE 0 END) AS quarantined,
      COUNT(*) AS total FROM chapter_runs WHERE run_id=?`, row.id) || {};
    const usage = one(`SELECT COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens),0) AS completion_tokens
      FROM generation_attempts WHERE run_id=?`, row.id) || {};
    const quarantined = q(`SELECT chapter_num, last_error FROM chapter_runs
      WHERE run_id=? AND status='quarantined' ORDER BY chapter_num LIMIT 20`, row.id);
    return {
      id: row.id,
      bookId: row.book_id,
      bookTitle: row.display_title,
      isDoc: !!Number(row.is_doc),
      status: row.status,
      from: Number(row.from_chapter),
      to: Number(row.to_chapter),
      current: Number(row.current_chapter),
      committed: Number(counts.committed || 0),
      quarantinedCount: Number(counts.quarantined || 0),
      total: Number(counts.total || 0),
      promptTokens: Number(usage.prompt_tokens || 0),
      completionTokens: Number(usage.completion_tokens || 0),
      lastError: row.last_error || '',
      updatedAt: Number(row.updated_at),
      quarantined: quarantined.map((item) => ({
        chapterNum: Number(item.chapter_num),
        error: String(item.last_error || '').slice(0, 160),
      })),
    };
  });
}

const RESUMABLE = new Set(['queued', 'running', 'retrying', 'quarantined', 'paused_budget']);

function renderRun(run, csrf) {
  const usage = run.promptTokens + run.completionTokens;
  const unit = run.isDoc ? '节' : '章';
  const progress = run.total
    ? `${run.committed}/${run.total} ${unit}`
    : `第${run.from}-${run.to}${unit}`;
  const actions = RESUMABLE.has(run.status)
    ? `<form method="post" action="/status/resume">
         <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
         <input type="hidden" name="runId" value="${escapeHtml(run.id)}">
         <button type="submit">从断点续跑</button>
       </form>`
    : '';
  const quarantined = run.quarantined.length
    ? `<ul class="q">${run.quarantined.map((item) => (
      `<li>第${item.chapterNum}${unit}：${escapeHtml(item.error || '未知原因')}</li>`
    )).join('')}</ul>`
    : '';
  return `<tr>
    <td class="title">${run.isDoc ? '📄 ' : ''}${escapeHtml(run.bookTitle)}<div class="sub">第${run.from}-${run.to}${unit} · ${escapeHtml(formatTime(run.updatedAt))}</div></td>
    <td><span class="badge ${statusClass(run.status)}">${escapeHtml(RUN_STATUS_TEXT[run.status] || run.status)}</span></td>
    <td>${escapeHtml(progress)}</td>
    <td class="num">${usage ? usage.toLocaleString('zh-CN') : '—'}</td>
    <td class="err">${escapeHtml(run.lastError).slice(0, 200)}${quarantined}</td>
    <td>${actions}</td>
  </tr>`;
}

function renderPage({ csrf, runs, notice = '', error = '' }) {
  const rows = runs.length
    ? runs.map((run) => renderRun(run, csrf)).join('')
    : '<tr><td colspan="6" class="empty">还没有任何生成任务</td></tr>';
  const banner = error
    ? `<p class="banner bad">${escapeHtml(error)}</p>`
    : notice ? `<p class="banner ok">${escapeHtml(notice)}</p>` : '';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>生成任务状态</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 28px 24px 48px; background: #f6f7f9; color: #1c1f23;
    font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .lead { color: #6b7280; margin: 0 0 20px; font-size: 13px; }
  .banner { padding: 10px 12px; border-radius: 8px; margin: 0 0 16px; font-size: 13px; }
  .banner.ok { background: #eaf7ee; color: #1a6b36; }
  .banner.bad { background: #fdecec; color: #a1231f; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px;
    overflow: hidden; box-shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.1); }
  th { text-align: left; font-weight: 600; font-size: 12px; color: #6b7280;
    padding: 10px 12px; border-bottom: 1px solid #eceef1; background: #fafbfc; }
  td { padding: 12px; border-bottom: 1px solid #f0f1f3; vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  .title { font-weight: 600; }
  .sub { font-weight: 400; color: #8a919b; font-size: 12px; margin-top: 2px; }
  .num { font-variant-numeric: tabular-nums; }
  .err { color: #6b7280; font-size: 12px; max-width: 320px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
  .badge.ok { background: #eaf7ee; color: #1a6b36; }
  .badge.live { background: #e8f1fe; color: #1c4f9c; }
  .badge.warn { background: #fff5e6; color: #8a5a00; }
  .badge.bad { background: #fdecec; color: #a1231f; }
  ul.q { margin: 6px 0 0; padding-left: 16px; }
  ul.q li { margin: 2px 0; }
  button { font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 7px; cursor: pointer;
    border: 1px solid #d5d9df; background: #fff; color: #1c1f23; }
  button:hover { background: #f2f4f7; }
  .empty { text-align: center; color: #8a919b; padding: 32px; }
  .hint { color: #8a919b; font-size: 12px; margin-top: 18px; }
</style></head>
<body>
  <h1>生成任务状态</h1>
  <p class="lead">每 15 秒自动刷新。续跑会从第一个未提交的章节继续，已提交的章节不会被覆盖。</p>
  ${banner}
  <table>
    <thead><tr><th>作品</th><th>状态</th><th>进度</th><th>tokens</th><th>说明</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="hint">详细日志见作品的「设定/生成日志.md」，一致性审计见「设定/一致性报告.md」。</p>
</body></html>`;
}

function sendHtml(res, html, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

function renderStatus({ csrf, notice = '', error = '' }) {
  return renderPage({ csrf, runs: collectRuns(), notice, error });
}

async function readForm(req, limit = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf-8'));
}

// 续跑是长任务，不能等在 HTTP 请求里。这里只负责启动，结果靠页面轮询。
function startResume(runId, deps) {
  const { resume, onSettled } = deps;
  setImmediate(() => {
    Promise.resolve()
      .then(() => resume(runId))
      .then((result) => onSettled(runId, null, result))
      .catch((error) => onSettled(runId, error, null));
  });
}

module.exports = {
  renderStatus,
  renderPage,
  collectRuns,
  readForm,
  startResume,
  sendHtml,
  escapeHtml,
  RESUMABLE,
};
