// 杂项命令：技能 CRUD / 智能写作（大纲·剧情·场景）/ 导入导出 / 在线服务降级 / 插件插件桩。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { q, one, run, transaction, DATA_DIR, BASE_DATA_DIR, DB_PATH, exec } = require('./db');
const core = require('./handlers-core');
const ai = require('./handlers-ai');
const llm = require('./llm');
const pk = require('./prompts');
const knowledge = require('./vector-store');
const longform = require('./longform-memory');
const orch = require('./longform-orchestrator');
const quality = require('./quality-gate');
const audit = require('./consistency-audit');
const { chapterNumberFromName } = require('./chapter-names');
const { parseZip, makeZip } = require('./zip');
const { resolveAllowedPath, atomicWriteFileSync, safeFileName } = require('./fs-safe');
const crypto = require('crypto');

const uid = () => crypto.randomUUID();
const now = () => Date.now();

const BOOK_FORMS = new Set(['short', 'medium', 'midlong', 'long', 'million']);
const FULL_AUTO_SETUP_DOCS = ['世界观.md', '人物库.md', '剧情大纲.md'];
const PLAN_WINDOW_CHAPTERS = 20;
const SUMMARY_CONTEXT_CHAPTERS = 10;
const SUMMARY_SNAPSHOT_CHAPTERS = 20;
const BATCH_YIELD_EVERY = 25;
const OUTLINE_CONTEXT_CHARS = 27000;
const OUTLINE_PROMPT_CONTEXT_CHARS = 26000;
const BODY_PROMPT_CONTEXT_CHARS = 30000;
const CONTINUATION_ANCHOR_CHARS = 6500;
const CHAPTER_SUMMARY_CHARS = 1400;
const SUMMARY_APPEND_PENDING_PREFIX = 'chapter_summary_append_pending__';
const batchTaskLocks = new Map();
const batchCancellations = new Set();
const ASSET_UPDATES_DIR = path.join(DATA_DIR, 'asset_updates');

function throwIfCancelled(bookId) {
  if (batchCancellations.has(String(bookId || ''))) {
    throw Object.assign(new Error('任务已取消，已完成章节会保留'), { code: 'BATCH_CANCELLED' });
  }
}

function hasReadySetupDocs(bookId) {
  const tree = core.scanTree({ bookId });
  const settings = tree.find((group) => group.groupDir === '设定') || { files: [] };
  const names = new Set(settings.files.map((file) => file.name));
  if (!FULL_AUTO_SETUP_DOCS.every((name) => names.has(name))) return false;
  return FULL_AUTO_SETUP_DOCS.every((name) => {
    const content = core.readFileFrom({ bookId, group: '设定', name }) || '';
    return String(content).trim().length >= 80;
  });
}

async function withBatchTaskLock(bookId, label, task) {
  const key = String(bookId || '').trim();
  if (!key) throw new Error('缺少 bookId');
  const running = batchTaskLocks.get(key);
  if (running) {
    throw new Error(`本书正在执行「${running}」，请等待当前任务结束`);
  }
  batchTaskLocks.set(key, label);
  try {
    return await task();
  } finally {
    batchTaskLocks.delete(key);
  }
}

function configuredForm(book) {
  if (!book || !book.id) return '';
  const form = String(core.getSettings()[`book_form__${book.id}`] || '').trim();
  return BOOK_FORMS.has(form) ? form : '';
}
function formFor(book) {
  const explicit = configuredForm(book);
  if (explicit) return explicit;
  if (!book) return 'midlong';
  const w = book.word_count || 0;
  if (w > 0 && w < 30000) return 'short';
  if (w <= 150000) return 'medium';
  if (w <= 500000) return 'midlong';
  if (w <= 1000000) return 'long';
  return 'million';
}
function bookPlanPrompt(bookId) {
  const plan = core.getBookPlanSettings({ bookId });
  if (!plan.totalChapters && !plan.chapterWords) return '';
  const lines = ['【本书容量规划】'];
  if (plan.totalChapters) lines.push(`- 全书预计 ${plan.totalChapters} 章。`);
  if (plan.chapterWords) {
    lines.push(`- 每章正文目标约 ${plan.chapterWords} 字，允许按剧情自然上下浮动 10% 到 15%。`);
    lines.push(`- 细纲按约 ${plan.chapterWords} 字的容量拆为 2 到 4 个场景；正文写作的【篇幅要求】即本章约 ${plan.chapterWords} 字。`);
  }
  return lines.join('\n');
}
function chapterFileIndex(tree, groupDir) {
  const group = tree.find((g) => g.groupDir === groupDir) || { files: [] };
  const files = new Map();
  for (const file of group.files) {
    const n = chapterNumberFromName(file.name);
    if (!n || files.has(n)) continue;
    files.set(n, { name: file.name, aiOff: !!file.aiOff });
  }
  return files;
}
function chapterFileIndexes(bookId) {
  const tree = core.scanTree({ bookId });
  return {
    tree,
    outlines: chapterFileIndex(tree, '细纲'),
    bodies: chapterFileIndex(tree, '正文'),
  };
}
function chapterFileContent(bookId, group, file) {
  if (!file || file.aiOff) return '';
  return core.readFileFrom({ bookId, group, name: file.name }) || '';
}
function readOutlineFile(bookId, file) {
  const content = chapterFileContent(bookId, '细纲', file);
  if (!content.trim()) return null;
  try {
    return { name: file.name, content, value: JSON.parse(content) };
  } catch (error) {
    return { name: file.name, content, value: null };
  }
}
async function yieldBatch() {
  await new Promise((resolve) => setImmediate(resolve));
}
function nextChapterNum(bookId) {
  const group = core.scanTree({ bookId }).find((g) => g.groupDir === '正文') || { files: [] };
  const max = group.files.reduce((n, f) => Math.max(n, chapterNumberFromName(f.name)), 0);
  return max + 1;
}
function compactText(text, limit) {
  const s = String(text || '').trim();
  if (s.length <= limit) return s;
  const head = Math.ceil(limit * 0.45);
  return `${s.slice(0, head)}\n...（中间内容已省略）...\n${s.slice(-(limit - head))}`;
}
function tailText(text, limit) {
  const s = String(text || '').trim();
  if (s.length <= limit) return s;
  return `...（前文已省略）...\n${s.slice(-limit)}`;
}

function fitTextBudget(text, limit, keepTail = false) {
  const value = String(text || '').trim();
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  if (!value || !max) return '';
  if (value.length <= max) return value;
  const marker = keepTail ? '\n...（前文已压缩）...\n' : '\n...（中间内容已压缩）...\n';
  if (max <= marker.length) return value.slice(0, max);
  const room = max - marker.length;
  if (keepTail) return `${marker}${value.slice(-room)}`;
  const head = Math.ceil(room * 0.55);
  return `${value.slice(0, head)}${marker}${value.slice(-(room - head))}`;
}

// Allocate a hard character budget across prompt sections. Minimums protect
// critical facts; weights determine how spare room is shared by longer input.
function composePromptSections(sections, maxChars) {
  const active = (Array.isArray(sections) ? sections : [])
    .map((section) => ({
      text: String(section && section.text || '').trim(),
      min: Math.max(0, Number(section && section.minChars) || 0),
      weight: Math.max(0.1, Number(section && section.weight) || 1),
      keepTail: !!(section && section.keepTail),
    }))
    .filter((section) => section.text);
  if (!active.length) return '';
  const limit = Math.max(200, Math.floor(Number(maxChars) || 0));
  const separator = '\n\n';
  const contentLimit = Math.max(0, limit - separator.length * Math.max(0, active.length - 1));
  const minimums = active.map((section) => Math.min(section.text.length, section.min));
  const minimumTotal = minimums.reduce((sum, value) => sum + value, 0);
  const scale = minimumTotal > contentLimit ? contentLimit / Math.max(1, minimumTotal) : 1;
  const allocations = minimums.map((value) => Math.floor(value * scale));
  let remaining = contentLimit - allocations.reduce((sum, value) => sum + value, 0);
  const deficits = active.map((section, index) => Math.max(0, section.text.length - allocations[index]));
  const totalWeight = deficits.reduce((sum, deficit, index) => sum + (deficit > 0 ? active[index].weight : 0), 0);
  if (remaining > 0 && totalWeight > 0) {
    active.forEach((section, index) => {
      if (!deficits[index]) return;
      const extra = Math.min(deficits[index], Math.floor(remaining * section.weight / totalWeight));
      allocations[index] += extra;
    });
    remaining = contentLimit - allocations.reduce((sum, value) => sum + value, 0);
    for (const index of active.map((_, i) => i).sort((a, b) => active[b].weight - active[a].weight)) {
      if (remaining <= 0) break;
      const extra = Math.min(remaining, Math.max(0, active[index].text.length - allocations[index]));
      allocations[index] += extra;
      remaining -= extra;
    }
  }
  const rendered = active
    .map((section, index) => fitTextBudget(section.text, allocations[index], section.keepTail))
    .filter(Boolean)
    .join(separator);
  return rendered.length <= limit ? rendered : fitTextBudget(rendered, limit);
}

function composeOutlinePromptContext({ bookTitle, n, direction, planned, context, previousContext, recalledContext }) {
  return composePromptSections([
    { text: `为《${bookTitle || '本书'}》生成【第${n}章】细纲。`, minChars: 80, weight: 0.2 },
    { text: direction ? `作者补充方向：${direction}` : '', minChars: 300, weight: 0.6 },
    { text: planned ? `【章节规划】\n${planned}` : '', minChars: 900, weight: 2 },
    { text: context ? `【本书资料与前序内容】\n${context}` : '', minChars: 5500, weight: 6 },
    { text: previousContext ? `【章节承接锚点】\n${previousContext}\n本章必须紧接上一章的时间、地点、人物状态和未解决冲突，不得跳跃或重置。` : '', minChars: 2800, weight: 4, keepTail: true },
    { text: recalledContext ? `【知识库相关召回】\n${recalledContext}\n仅将其中与本章相关的设定、伏笔和人物状态纳入细纲，不要机械复述。` : '', minChars: 1600, weight: 3 },
    { text: '请直接产出本章细纲 JSON。', minChars: 80, weight: 0.2 },
  ], OUTLINE_PROMPT_CONTEXT_CHARS);
}

function composeBodyPromptContext({
  bookTitle, n, direction, planText, outlineText, nextOutlineText, nextPlanText,
  context, previousContext, recalledContext, targetWords, minimumWords,
}) {
  return composePromptSections([
    { text: `为《${bookTitle || '本书'}》写第${n}章正文。`, minChars: 80, weight: 0.2 },
    { text: direction ? `作者补充方向：${direction}` : '', minChars: 300, weight: 0.5 },
    { text: planText ? `【本章规划】\n${planText}` : '', minChars: 700, weight: 1.5 },
    { text: `【第${n}章细纲】\n${outlineText}`, minChars: 6500, weight: 8 },
    { text: nextOutlineText ? `【下一章细纲·只用于本章收束钩子，禁止提前展开】\n${nextOutlineText}` : '', minChars: 1000, weight: 1.2 },
    { text: nextPlanText ? `【下一章规划·只用于本章收束钩子】\n${nextPlanText}` : '', minChars: 200, weight: 0.3 },
    { text: context ? `【本书资料与前文】\n${context}` : '', minChars: 5000, weight: 5 },
    { text: previousContext ? `【上一章承接锚点】\n${previousContext}\n请从上一章正文最后的动作、对话或悬念继续写，第一段不得重新介绍世界观或跳到无关场景。` : '', minChars: 3200, weight: 5, keepTail: true },
    { text: recalledContext ? `【知识库相关召回】\n${recalledContext}\n优先遵守其中已确定的人物、世界观、时间线和伏笔；如与本章细纲冲突，以最新细纲和上一章正文为准。` : '', minChars: 1600, weight: 3 },
    { text: `【篇幅要求】本章正文目标约 ${targetWords} 字，至少完成约 ${minimumWords} 字；不要刚写完开头就结束。`, minChars: 150, weight: 0.2 },
    { text: '只输出本章正文，不要解释，不要输出代码围栏，不要提前写下一章。', minChars: 80, weight: 0.2 },
  ], BODY_PROMPT_CONTEXT_CHARS);
}

function continuationAnchorText(raw, limit = CONTINUATION_ANCHOR_CHARS) {
  const value = String(raw || '').trim();
  const max = Math.max(1000, Number(limit) || CONTINUATION_ANCHOR_CHARS);
  if (value.length <= max) return value;
  return `...（更早正文已省略）...\n${value.slice(-max)}`;
}

function composeContinuationMessages({ system, user, raw, currentWords, targetWords, minimumWords }) {
  return [
    { role: 'system', content: String(system || '') },
    { role: 'user', content: String(user || '') },
    { role: 'assistant', content: continuationAnchorText(raw) },
    {
      role: 'user',
      content: `上面的助手消息只保留了已生成正文的结尾，前文已省略。正文目前约 ${currentWords} 字；请从最后一句自然接续，只输出续写内容。本章总长度目标约 ${targetWords} 字，至少写到约 ${minimumWords} 字并完成结尾，不要重复前文。`,
    },
  ];
}
function parseChapterSummaryMarkdown(content) {
  const sections = new Map();
  const source = String(content || '');
  const headings = [...source.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)];
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const title = String(heading[1] || '').trim();
    const n = chapterNumberFromName(title);
    if (!n) continue;
    const start = heading.index + heading[0].length;
    const end = i + 1 < headings.length ? headings[i + 1].index : source.length;
    const body = source.slice(start, end).trim();
    if (body) sections.set(n, { title, content: body });
  }
  return sections;
}

function replaceChapterSummaryRows(bookId, sections) {
  transaction(() => {
    run(`DELETE FROM chapter_summaries WHERE book_id=?`, bookId);
    const t = now();
    for (const [n, section] of sections) {
      run(`INSERT INTO chapter_summaries(book_id, chapter_num, title, content, updated_at) VALUES(?,?,?,?,?)`,
        bookId, n, section.title || `第${n}章`, section.content, t);
    }
  });
  const latest = Math.max(0, ...[...sections.keys()].map(Number));
  core.setSetting(`chapter_summary_materialized_until__${bookId}`, String(latest));
}

function ensureChapterSummariesImported(bookId) {
  const stamp = sourceFileStamp(bookId, '章节摘要.md');
  if (!stamp) return;
  // While an append is pending, the Markdown tail may be incomplete or newer
  // than its committed marker. SQLite remains authoritative until materialize
  // rolls the append forward or back.
  if (one(`SELECT value FROM settings WHERE key=?`, `${SUMMARY_APPEND_PENDING_PREFIX}${bookId}`)) return;
  const count = Number(one(`SELECT COUNT(*) AS count FROM chapter_summaries WHERE book_id=?`, bookId)?.count || 0);
  const key = `chapter_summary_source_stamp__${bookId}`;
  const saved = one(`SELECT value FROM settings WHERE key=?`, key)?.value || '';
  if (count > 0 && saved === stamp) return;
  const sections = parseChapterSummaryMarkdown(core.readFileFrom({ bookId, group: '设定', name: '章节摘要.md' }) || '');
  if (!sections.size) return;
  replaceChapterSummaryRows(bookId, sections);
  core.setSetting(key, stamp);
}

function chapterSummarySection(row) {
  return `## ${row.title || `第${row.chapter_num}章`}\n${String(row.content || '').trim()}\n\n`;
}

function materializeChapterSummaries(bookId, { force = false, changedChapter = 0 } = {}) {
  ensureChapterSummariesImported(bookId);
  const stats = one(`SELECT COUNT(*) AS count, MAX(chapter_num) AS latest
    FROM chapter_summaries WHERE book_id=?`, bookId) || {};
  const latest = Number(stats.latest) || 0;
  if (!latest) return { mode: 'empty', chapters: 0, until: 0 };
  const markerKey = `chapter_summary_materialized_until__${bookId}`;
  const pendingKey = `${SUMMARY_APPEND_PENDING_PREFIX}${bookId}`;
  const marker = Number(one(`SELECT value FROM settings WHERE key=?`, markerKey)?.value || 0);
  const changed = Number(changedChapter) || 0;
  const fileStat = core.fileStatFrom({ bookId, group: '设定', name: '章节摘要.md' });
  let fullRewrite = force || !fileStat || !marker || marker > latest || (changed > 0 && changed <= marker);

  // A crash can leave appended bytes on disk before the materialization marker
  // is committed. Roll back to the pre-append offset and append from SQLite
  // again, which makes summary materialization idempotent.
  const pendingRaw = one(`SELECT value FROM settings WHERE key=?`, pendingKey)?.value || '';
  let pending = null;
  try { pending = pendingRaw ? JSON.parse(pendingRaw) : null; } catch {}
  let recoveredPending = false;
  if (pending) {
    if (marker >= Number(pending.until || 0)) {
      run(`DELETE FROM settings WHERE key=?`, pendingKey);
    } else if (!fileStat || Number(fileStat.size) < Number(pending.offset || 0)) {
      fullRewrite = true;
      run(`DELETE FROM settings WHERE key=?`, pendingKey);
    } else {
      core.truncateFileTo({ bookId, group: '设定', name: '章节摘要.md', size: Number(pending.offset) });
      try { knowledge.removeFile({ bookId, group: '设定', name: '章节摘要.md' }); } catch {}
      run(`DELETE FROM settings WHERE key=?`, pendingKey);
      recoveredPending = true;
    }
  }

  if (!fullRewrite && marker === latest) {
    return { mode: 'unchanged', chapters: 0, until: latest };
  }
  if (!fullRewrite && marker < latest) {
    const missing = q(`SELECT chapter_num, title, content FROM chapter_summaries
      WHERE book_id=? AND chapter_num>? ORDER BY chapter_num`, bookId, marker);
    if (missing.length) {
      const appendStat = core.fileStatFrom({ bookId, group: '设定', name: '章节摘要.md' });
      core.setSetting(pendingKey, JSON.stringify({
        offset: Number(appendStat?.size || 0), marker, until: latest, startedAt: now(),
      }));
      core.appendFileTo({
        bookId,
        group: '设定',
        name: '章节摘要.md',
        content: missing.map(chapterSummarySection).join(''),
      });
      if (recoveredPending) {
        try {
          knowledge.indexFile({
            bookId,
            group: '设定',
            name: '章节摘要.md',
            content: core.readFileFrom({ bookId, group: '设定', name: '章节摘要.md' }),
            mtime: Math.floor(core.fileStatFrom({ bookId, group: '设定', name: '章节摘要.md' }).mtimeMs),
          });
        } catch {}
      }
      core.setSetting(markerKey, String(latest));
      run(`DELETE FROM settings WHERE key=?`, pendingKey);
      core.setSetting(`chapter_summary_source_stamp__${bookId}`, sourceFileStamp(bookId, '章节摘要.md'));
      return { mode: 'append', chapters: missing.length, until: latest };
    }
  }

  run(`DELETE FROM settings WHERE key=?`, pendingKey);
  const rows = q(`SELECT chapter_num, title, content FROM chapter_summaries
    WHERE book_id=? ORDER BY chapter_num`, bookId);
  const content = `# 章节摘要\n\n${rows.map(chapterSummarySection).join('')}`.trimEnd() + '\n';
  core.writeFileTo({ bookId, group: '设定', name: '章节摘要.md', content });
  core.setSetting(markerKey, String(latest));
  core.setSetting(`chapter_summary_source_stamp__${bookId}`, sourceFileStamp(bookId, '章节摘要.md'));
  return { mode: 'rewrite', chapters: rows.length, until: latest };
}

function recentChapterSummaries(bookId, targetChapter, limit = SUMMARY_CONTEXT_CHAPTERS) {
  ensureChapterSummariesImported(bookId);
  return q(`SELECT chapter_num, title, content FROM chapter_summaries
    WHERE book_id=? AND chapter_num<? ORDER BY chapter_num DESC LIMIT ?`, bookId, Number(targetChapter || 1), limit)
    .reverse()
    .map((row) => `## ${row.title || `第${row.chapter_num}章`}\n${compactText(row.content, 420)}`)
    .join('\n\n');
}
function bookContextForOutline(bookId, targetChapter, indexes = null, maxChars = OUTLINE_CONTEXT_CHARS) {
  const tree = indexes?.tree || core.scanTree({ bookId });
  const parts = [];
  const settings = tree.find((g) => g.groupDir === '设定');
  if (settings) {
    const budgets = new Map([
      ['剧情大纲.md', 2600], ['人物库.md', 2000], ['世界观.md', 1400],
      ['伏笔台账.md', 2000], ['连载进度.md', 700], ['大事记.md', 700],
    ]);
    const special = new Set(['章节规划.md', '章节摘要.md', '世界规则.md', '正典事件.md', ...budgets.keys()]);
    const ordered = settings.files.filter((file) => !file.aiOff).slice().sort((a, b) => {
      const ai = [...budgets.keys()].indexOf(a.name);
      const bi = [...budgets.keys()].indexOf(b.name);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    let supplemental = 0;
    for (const f of ordered) {
      if (special.has(f.name)) continue;
      const text = core.readFileFrom({ bookId, group: '设定', name: f.name });
      if (text) {
        parts.push(`# 补充设定：${f.name}\n${compactText(text, 450)}`);
        supplemental++;
      }
      if (supplemental >= 4) break;
    }
    for (const [name, budget] of budgets) {
      const text = core.readFileFrom({ bookId, group: '设定', name });
      if (text) parts.push(`# 核心资料：${name}\n${name === '伏笔台账.md' ? tailText(text, budget) : compactText(text, budget)}`);
    }
  }
  const storyState = longform.storyStateContext(bookId, targetChapter, 3000);
  if (storyState) parts.push(storyState);
  const volumeSummary = longform.volumeSummaryContext(bookId, targetChapter, longform.DEFAULT_VOLUME_CHAPTERS, 2200);
  if (volumeSummary) parts.push(volumeSummary);
  // 世界规则与正典事件是"任何章节都不得违背"的硬约束，细纲与正文两条路径都要带上。
  const worldRules = longform.worldRulesContext(bookId, 1600);
  if (worldRules) parts.push(worldRules);
  const canonEvents = longform.canonEventsContext(bookId, targetChapter, 2200);
  if (canonEvents) parts.push(canonEvents);
  const planEntries = chapterPlanRange(bookId, Number(targetChapter || 1) - 5, Number(targetChapter || 1) + 2);
  const nearbyPlan = [...planEntries.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, text]) => `### 第${n}章\n${compactText(text, 450)}`)
    .join('\n\n');
  if (nearbyPlan) parts.push(`# 当前章节规划窗口\n${nearbyPlan}`);
  const summaries = recentChapterSummaries(bookId, targetChapter);
  if (summaries) parts.push(`# 最近章节摘要\n${summaries}`);
  const outlineIndex = indexes?.outlines || chapterFileIndex(tree, '细纲');
  const priorOutlineNumbers = [...outlineIndex.keys()]
    .filter((n) => n < targetChapter && !outlineIndex.get(n).aiOff)
    .sort((a, b) => b - a)
    .slice(0, 1)
    .sort((a, b) => a - b);
  for (const n of priorOutlineNumbers) {
    const file = outlineIndex.get(n);
    const text = chapterFileContent(bookId, '细纲', file);
    if (text) parts.push(`# 前序细纲：${file.name}\n${compactText(text, 700)}`);
  }
  const bodyIndex = indexes?.bodies || chapterFileIndex(tree, '正文');
  const priorBodyNumbers = [...bodyIndex.keys()]
    .filter((n) => n < targetChapter && !bodyIndex.get(n).aiOff)
    .sort((a, b) => b - a)
    .slice(0, 1)
    .sort((a, b) => a - b);
  for (const n of priorBodyNumbers) {
    const file = bodyIndex.get(n);
    const text = chapterFileContent(bookId, '正文', file);
    if (text) parts.push(`# 前文结尾：${file.name}\n${tailText(text, 1200)}`);
  }
  return fitTextBudget(parts.join('\n\n'), maxChars);
}

function bookSkillText(bookId, taskKind = '') {
  const meta = core.getBookMeta(bookId);
  const settings = core.getSettings();
  const ids = [meta.primarySkill, ...(meta.supportSkills || [])].filter(Boolean);
  if (taskKind) {
    const primary = settings[`book_primary_skill__${bookId}__${taskKind}`];
    if (primary) ids.push(primary);
    try {
      const support = JSON.parse(settings[`book_support_skills__${bookId}__${taskKind}`] || '[]');
      if (Array.isArray(support)) ids.push(...support);
    } catch (e) {}
  }
  const seen = new Set();
  const parts = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const skill = one(`SELECT * FROM skills WHERE id=?`, id);
    if (!skill) continue;
    const tpl = pk.skillFullTemplate(skill) || skill.prompt_template || '';
    if (tpl) parts.push(`【本书技能：${skill.name}】\n${tpl}`);
  }
  return parts.join('\n\n');
}

function generationContext(bookId, book, style, taskKind = '') {
  const settings = core.getSettings();
  const meta = core.getBookMeta(bookId);
  const platform = settings[`book_platform__${bookId}`] || '';
  const audience = settings[`book_audience__${bookId}`] || '';
  const genre = settings[`book_genre__${bookId}`] || (book ? book.genre : '') || '';
  const parts = [
    book ? `【作品】《${book.title}》${genre ? ` · ${genre}` : ''}` : '',
    book && book.pov ? `【叙事人称】${book.pov}` : '',
    genre ? pk.genreCard(genre, formFor(book)) : '',
    bookPlanPrompt(bookId),
    pk.styleCardText(style),
    pk.platformCard(platform),
    audience ? `【目标读者】${audience}` : '',
    pk.prefCards(settings),
    pk.antiAiTone(!!meta.humanize),
    bookSkillText(bookId, taskKind),
  ];
  return parts.filter(Boolean).join('\n\n');
}

function sourceFileStamp(bookId, name) {
  const stat = core.fileStatFrom({ bookId, group: '设定', name });
  return stat ? `${Math.floor(stat.mtimeMs)}:${stat.size}` : '';
}
function parseChapterPlanMarkdown(content) {
  const entries = new Map();
  const re = /^#{2,4}[ \t]*第\s*(\d+)\s*章[^\n]*\n([\s\S]*?)(?=^#{2,4}[ \t]*第\s*\d+\s*章|(?![\s\S]))/gm;
  for (const match of String(content || '').matchAll(re)) {
    const n = Number(match[1]);
    const text = String(match[2] || '').trim();
    if (n && text) entries.set(n, text);
  }
  return entries;
}

function replaceChapterPlanRows(bookId, entries) {
  transaction(() => {
    run(`DELETE FROM chapter_plans WHERE book_id=?`, bookId);
    const t = now();
    for (const [n, text] of entries) {
      run(`INSERT INTO chapter_plans(book_id, chapter_num, content, updated_at) VALUES(?,?,?,?)`,
        bookId, n, String(text || '').trim(), t);
    }
  });
}

function ensureChapterPlansImported(bookId) {
  const stamp = sourceFileStamp(bookId, '章节规划.md');
  if (!stamp) return;
  const count = Number(one(`SELECT COUNT(*) AS count FROM chapter_plans WHERE book_id=?`, bookId)?.count || 0);
  const key = `chapter_plan_source_stamp__${bookId}`;
  const saved = one(`SELECT value FROM settings WHERE key=?`, key)?.value || '';
  if (count > 0 && saved === stamp) return;
  const entries = parseChapterPlanMarkdown(core.readFileFrom({ bookId, group: '设定', name: '章节规划.md' }) || '');
  if (!entries.size) return;
  replaceChapterPlanRows(bookId, entries);
  core.setSetting(key, stamp);
}

function chapterPlanRange(bookId, fromChapter, toChapter) {
  ensureChapterPlansImported(bookId);
  const rows = q(`SELECT chapter_num, content FROM chapter_plans
    WHERE book_id=? AND chapter_num BETWEEN ? AND ? ORDER BY chapter_num`, bookId,
  Number(fromChapter), Number(toChapter));
  return new Map(rows.map((row) => [Number(row.chapter_num), String(row.content || '')]));
}

function chapterPlanEntries(bookId) {
  ensureChapterPlansImported(bookId);
  const rows = q(`SELECT chapter_num, content FROM chapter_plans WHERE book_id=? ORDER BY chapter_num`, bookId);
  return new Map(rows.map((row) => [Number(row.chapter_num), String(row.content || '')]));
}

function chapterPlanEntryText(bookId, chapterNum) {
  ensureChapterPlansImported(bookId);
  const text = one(`SELECT content FROM chapter_plans WHERE book_id=? AND chapter_num=?`, bookId, Number(chapterNum))?.content;
  return text ? `第${chapterNum}章规划：\n${text}` : '';
}

function upsertChapterPlanEntries(bookId, entries) {
  const t = now();
  transaction(() => {
    for (const [n, text] of entries) {
      run(`INSERT INTO chapter_plans(book_id, chapter_num, content, updated_at) VALUES(?,?,?,?)
        ON CONFLICT(book_id, chapter_num) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
      bookId, Number(n), String(text || '').trim(), t);
    }
  });
}

function materializeChapterPlan(bookId, entries = null) {
  const source = entries || chapterPlanEntries(bookId);
  if (!source.size) return;
  core.writeFileTo({ bookId, group: '设定', name: '章节规划.md', content: serializeChapterPlan(source) });
  core.setSetting(`chapter_plan_source_stamp__${bookId}`, sourceFileStamp(bookId, '章节规划.md'));
}

function serializeChapterPlan(entries) {
  const sorted = [...entries.entries()].sort((a, b) => a[0] - b[0]);
  let content = '# 章节规划\n\n';
  for (let i = 0; i < sorted.length; i += PLAN_WINDOW_CHAPTERS) {
    const window = sorted.slice(i, i + PLAN_WINDOW_CHAPTERS);
    content += `## 第${window[0][0]}-${window[window.length - 1][0]}章\n\n`;
    for (const [n, text] of window) content += `### 第${n}章\n${String(text || '').trim()}\n\n`;
  }
  return content.trimEnd() + '\n';
}

async function ensureChapterPlan({ bookId, totalChapters, chapterWords, fromChapter = 1, ctx, channel, chn, book, style, model, indexes = null, onUsage = null }) {
  const total = Math.max(1, Number(totalChapters) || 1);
  const windowStart = Math.min(total, Math.max(1, Number(fromChapter) || 1));
  const windowEnd = Math.min(total, windowStart + PLAN_WINDOW_CHAPTERS - 1);
  const existing = chapterPlanRange(bookId, windowStart, windowEnd);
  const missing = [];
  for (let n = windowStart; n <= windowEnd; n++) if (!existing.has(n)) missing.push(n);
  if (!missing.length) return { created: 0, total, windowStart, windowEnd };

  const p = pk.prompts();
  const baseContext = bookContextForOutline(bookId, windowStart, indexes, 16000);
  const priorText = q(`SELECT chapter_num, content FROM chapter_plans
    WHERE book_id=? AND chapter_num<? ORDER BY chapter_num DESC LIMIT 8`, bookId, windowStart)
    .reverse()
    .map((row) => `### 第${row.chapter_num}章\n${compactText(row.content, 900)}`)
    .join('\n\n');
  const chunkStart = missing[0];
  const chunkEnd = missing[missing.length - 1];
  sendEvent(ctx, channel, { type: 'step', index: chunkStart, title: `正在规划第${chunkStart}-${chunkEnd}章`, kind: 'plan' });
    const sys = [
      p.system ? String(p.system).trim() : '',
      generationContext(bookId, book, style, 'plot'),
      String(p.arc_plan || ''),
      String(p.arc_span_volume || ''),
      String(p.arc_force_deliver || ''),
      [
        '【本次规划范围】',
        `这是滚动分卷规划，只规划第${chunkStart}章到第${chunkEnd}章，不能缺章、不能跳号。`,
        '远期章节只保留剧情大纲中的卷级里程碑，不要提前编造后续卷的逐章流水账。',
        '每章 summary 写 2~4 句走向级梗概：本章目标、核心冲突、关系/实力变化、章末钩子。',
        '章节之间必须因果递进，不得原地打转、重复桥段或把高潮提前透支。',
        '只输出 {"arcPlan":{"chapters":[{"n":章号,"title":"标题","summary":"梗概"}]}}，不要解释。',
      ].join('\n'),
    ].filter(Boolean).join('\n\n');
    const user = [
      baseContext ? `【本书资料】\n${baseContext}` : '',
      priorText ? `【已规划章节】\n${priorText}` : '',
      `【容量】全书 ${total} 章，每章约 ${chapterWords || 2400} 字；本次只交付当前规划窗口。`,
      `现在直接规划第${chunkStart}-${chunkEnd}章。`,
    ].filter(Boolean).join('\n\n');
    let parsed = null;
    let raw = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      raw = await llm.chatOnce({
        baseUrl: chn.baseUrl, apiKey: chn.key, model,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        temperature: 0.55, maxTokens: 8192,
        onMeta: (ev) => { if (ev.usage) onUsage?.(ev.usage); },
      });
      parsed = llm.extractJson(raw);
      const chapters = parsed && parsed.arcPlan && Array.isArray(parsed.arcPlan.chapters)
        ? parsed.arcPlan.chapters : (Array.isArray(parsed && parsed.chapters) ? parsed.chapters : []);
      const nums = new Set(chapters.map((c) => Number(c && c.n)).filter(Boolean));
      if (chapters.length && [...Array(chunkEnd - chunkStart + 1)].every((_, j) => nums.has(chunkStart + j))) break;
      user += '\n\n上一次输出缺章或格式不对。现在必须补齐所有章号，只输出完整 arcPlan JSON。';
      parsed = null;
    }
    const chapters = parsed && parsed.arcPlan && Array.isArray(parsed.arcPlan.chapters)
      ? parsed.arcPlan.chapters : (Array.isArray(parsed && parsed.chapters) ? parsed.chapters : []);
    if (!chapters.length) throw new Error(`第${chunkStart}-${chunkEnd}章规划失败：模型没有返回完整章节规划`);
    const plannedNums = new Set(chapters.map((c) => Number(c && c.n)).filter(Boolean));
    if (![...Array(chunkEnd - chunkStart + 1)].every((_, j) => plannedNums.has(chunkStart + j))) {
      throw new Error(`第${chunkStart}-${chunkEnd}章规划不完整，请重试`);
    }
    let created = 0;
    const planned = new Map();
    for (const c of chapters.slice().sort((a, b) => Number(a.n) - Number(b.n))) {
      const n = Number(c.n);
      if (!n || n < chunkStart || n > chunkEnd) continue;
      planned.set(n, `${String(c.title || '').trim()}\n${String(c.summary || '').trim()}`.trim());
      created++;
    }
    upsertChapterPlanEntries(bookId, planned);
    materializeChapterPlan(bookId);
  sendEvent(ctx, channel, { type: 'step', index: windowEnd, title: `第${windowStart}-${windowEnd}章规划窗口已就绪`, kind: 'plan-done' });
  return { created, total, windowStart, windowEnd };
}

function previousChapterContext(bookId, targetChapter, indexes = null) {
  const previous = Number(targetChapter || 0) - 1;
  if (previous <= 0) return '';
  const parts = [];
  const source = indexes || chapterFileIndexes(bookId);
  const outlineFile = source.outlines.get(previous);
  if (outlineFile) {
    const text = chapterFileContent(bookId, '细纲', outlineFile);
    if (text) parts.push(`【上一章细纲：${outlineFile.name}】\n${compactText(text, 2600)}`);
  }
  const bodyFile = source.bodies.get(previous);
  if (bodyFile) {
    const text = chapterFileContent(bookId, '正文', bodyFile);
    if (text) {
      const normalized = String(text).trim();
      parts.push(`【上一章正文结尾：${bodyFile.name}】\n${normalized.slice(-6500)}`);
    }
  }
  return parts.length ? parts.join('\n\n') : '';
}

async function chapterKnowledgeContext(bookId, query, maxChars = 8000, beforeChapter = 0) {
  try {
    // beforeChapter 是硬过滤：写第 N 章时不得召回第 N 章及以后的片段，否则会把未来的
    // 伏笔回收、人物死亡等结论提前泄漏进当前章。
    // 配置了 embedding 时先做增量补齐与查询向量化（异步）；任何失败都回落到本地引擎。
    const prepared = await knowledge.prepareRetrieval(bookId, query);
    return knowledge.retrievalText({ bookId, query, limit: 8, maxChars, beforeChapter,
      queryVector: prepared ? prepared.queryVector : null }) || '';
  } catch (error) {
    return '';
  }
}
function outlineLooksComplete(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !value.ask &&
    typeof value.title === 'string' && String(value.goal || '').trim() &&
    String(value.hook || '').trim() && Array.isArray(value.scenes) && value.scenes.length >= 2;
}
function normalizeOutline(value, chapterNum) {
  const out = { ...value };
  const title = String(out.title || '').trim();
  if (!new RegExp(`第\\s*${chapterNum}\\s*章`).test(title) && chapterNumberFromName(title) !== chapterNum) {
    out.title = `第${chapterNum}章 ${title.replace(/^第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*章\s*/, '') || '细纲'}`;
  }
  if (out.highlight && !out['看点']) out['看点'] = out.highlight;
  out.scenes = out.scenes.map((scene) => ({
    title: scene.title || '场景',
    location: scene.location || '',
    characters: scene.characters || '',
    event: scene.event || '',
    purpose: scene.purpose || '',
  }));
  out.continuity = longform.normalizeContinuity(out, chapterNum);
  return out;
}
function eventChannel(onEvent) {
  if (onEvent == null) return null;
  if (typeof onEvent === 'string') return onEvent.replace(/^__CHANNEL__:/, '');
  return onEvent.id != null ? String(onEvent.id) : null;
}
function sendEvent(ctx, channel, e) {
  if (channel) ctx.send(JSON.stringify({ ch: channel, e }) + '\n');
}

// ---------- 技能 ----------
function skillRow(r) {
  return {
    id: r.id, name: r.name, description: r.description || '', kind: r.kind || 'user',
    source: r.source || '', enabled: !!r.enabled, builtinKey: r.builtin_key || '',
    usageMode: r.usage_mode || 'support', origin: r.origin || 'user',
    domain: r.domain || 'novel',
    promptTemplate: r.prompt_template || '', targets: JSON.parse(r.targets_json || '[]'),
    capabilities: r.capabilities_json ? JSON.parse(r.capabilities_json) : null,
  };
}
function listSkills() {
  return q(`SELECT * FROM skills ORDER BY origin='official' DESC, name`).map(skillRow);
}
function createSkill({ name, description = '', promptTemplate = '', kind = 'user', usageMode = 'support', origin = 'user', enabled = 1, builtinKey = '', targets = [], source = '', capabilities = null, domain = 'novel' }) {
  const id = uid();
  const dom = ['novel', 'doc'].includes(String(domain)) ? String(domain) : 'novel';
  run(`INSERT INTO skills(id,name,description,prompt_template,kind,source,enabled,builtin_key,usage_mode,origin,targets_json,capabilities_json,domain)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, name, description, promptTemplate, kind, source, enabled ? 1 : 0, builtinKey || null, usageMode, origin, JSON.stringify(targets || []),
    capabilities ? JSON.stringify(capabilities) : null, dom);
  return skillRow(one(`SELECT * FROM skills WHERE id=?`, id));
}
function updateSkill({ id, ...f }) {
  const sets = []; const args = [];
  const map = { name: 'name', description: 'description', promptTemplate: 'prompt_template', kind: 'kind', source: 'source',
    enabled: 'enabled', usageMode: 'usage_mode', origin: 'origin', builtinKey: 'builtin_key', targets: 'targets_json',
    capabilities: 'capabilities_json' };
  for (const [k, col] of Object.entries(map)) {
    if (f[k] !== undefined) {
      sets.push(`${col}=?`);
      args.push(col === 'enabled' ? (f[k] ? 1 : 0) : (col === 'targets_json' || col === 'capabilities_json') ? JSON.stringify(f[k]) : f[k]);
    }
  }
  if (sets.length) { args.push(id); run(`UPDATE skills SET ${sets.join(',')} WHERE id=?`, ...args); }
  return skillRow(one(`SELECT * FROM skills WHERE id=?`, id));
}
function deleteSkill({ id }) { run(`DELETE FROM skills WHERE id=?`, id); return { ok: true }; }
function setSkillEnabled({ id, on }) { run(`UPDATE skills SET enabled=? WHERE id=?`, on ? 1 : 0, id); return { ok: true }; }
function readSkillRef({ id, name }) {
  const r = one(`SELECT * FROM skills WHERE id=?`, id);
  if (!r) return null;
  const skill = skillRow(r);
  if (name) {
    const file = skill.capabilities?.bundledRefs?.files?.find((item) => item.name === name);
    return file ? String(file.content || '') : '';
  }
  return skill;
}
function writeSkillRef({ id, name, content }) {
  const r = one(`SELECT * FROM skills WHERE id=?`, id);
  if (!r) throw new Error('技能不存在');
  const skill = skillRow(r);
  const capabilities = skill.capabilities || {};
  const bundledRefs = capabilities.bundledRefs || { files: [], totalBytes: 0 };
  const files = Array.isArray(bundledRefs.files) ? bundledRefs.files.slice() : [];
  const existing = files.find((item) => item.name === name);
  if (existing) existing.content = String(content || '');
  else files.push({ name, content: String(content || '') });
  bundledRefs.files = files;
  bundledRefs.totalBytes = files.reduce((sum, item) => sum + String(item.content || '').length, 0);
  capabilities.bundledRefs = bundledRefs;
  return updateSkill({ id, capabilities });
}

function createSkillFromDraft({ draft, name = '', description = '' }) {
  const d = draft && typeof draft === 'object' ? draft : {};
  const capabilities = {};
  const refs = Array.isArray(d.references) ? d.references : [];
  if (refs.length) {
    capabilities.bundledRefs = {
      files: refs.map((item) => ({ name: item.name, content: String(item.content || '') })),
      totalBytes: refs.reduce((sum, item) => sum + String(item.content || '').length, 0),
    };
  }
  if (d.script && d.script.source) {
    capabilities.runScript = {
      entry: 'main.js', hook: d.script.hook || 'post',
      sha256: crypto.createHash('sha256').update(String(d.script.source)).digest('hex'),
      source: String(d.script.source),
    };
  }
  return createSkill({
    name: name || d.name || '新技能',
    description: description || d.description || '',
    promptTemplate: d.instructions || d.promptTemplate || String(draft || ''),
    kind: 'method', usageMode: d.usageMode || 'standalone', origin: 'user',
    targets: Array.isArray(d.targets) ? d.targets : [],
    capabilities: Object.keys(capabilities).length ? capabilities : null,
  });
}
function saveDecomposeAsSkill({ name, description, report, skillName, skillDescription }) {
  return createSkill({
    name: skillName || name || '拆解手法',
    description: skillDescription || description || '源自拆解可借鉴手法',
    promptTemplate: '【任务】基于以下拆解报告，把手法用运用指导写成可执行的写作技能。\n\n【拆解报告】\n' + String(report || '').slice(0, 8000),
    kind: 'craft', usageMode: 'standalone', origin: 'decompose',
  });
}
function readSkillScript({ id }) {
  const r = one(`SELECT * FROM skills WHERE id=?`, id);
  if (!r) throw new Error('技能不存在');
  const capabilities = r.capabilities_json ? JSON.parse(r.capabilities_json) : {};
  const script = capabilities.runScript;
  if (!script || !script.source) throw new Error('该技能没有脚本');
  const auth = one(`SELECT value FROM settings WHERE key=?`, `skill_script_auth__${id}`);
  return {
    source: String(script.source),
    hook: script.hook || 'post',
    declaredSha256: script.sha256 || '',
    currentSha256: crypto.createHash('sha256').update(String(script.source)).digest('hex'),
    authorized: !!(auth && auth.value === '1'),
  };
}
function setSkillScriptAuthorization({ id, allow }) {
  if (!id) throw new Error('缺少技能 id');
  core.setSetting(`skill_script_auth__${id}`, allow ? '1' : '0');
  return { ok: true, authorized: !!allow };
}
function runSkillSandbox(source, input, refs) {
  const code = String(source || '').trim();
  if (!code) throw new Error('技能脚本为空');
  const context = { input: String(input || ''), refs: refs && typeof refs === 'object' ? refs : {} };
  vm.createContext(context);
  const value = new vm.Script(`${code}\n; typeof run === 'function' ? run(input, refs) : null;`, { timeout: 1000 })
    .runInContext(context, { timeout: 1000 });
  return String(value == null ? '' : value);
}
function skillScriptRefs(skill) {
  const files = skill.capabilities?.bundledRefs?.files || [];
  return Object.fromEntries(files.map((file) => [file.name, String(file.content || '')]));
}
function testRunSkillScript({ id, input }) {
  const r = one(`SELECT * FROM skills WHERE id=?`, id);
  if (!r) throw new Error('技能不存在');
  const skill = skillRow(r);
  const auth = one(`SELECT value FROM settings WHERE key=?`, `skill_script_auth__${id}`);
  if (!auth || auth.value !== '1') throw new Error('技能脚本尚未授权');
  const source = skill.capabilities?.runScript?.source;
  if (!source) throw new Error('该技能没有脚本');
  return runSkillSandbox(source, input, skillScriptRefs(skill));
}
function testRunDraftScript({ source, input, refs }) {
  return runSkillSandbox(source, input, refs || {});
}
function saveCapabilityDoc({ bookId, content }) {
  if (bookId && content != null) core.writeFileTo({ bookId, group: '设定', name: '能力清单.md', content });
  return { ok: true };
}

// ---------- 智能写作 ----------
async function runSmart({ bookId, messageId, promptKey, userText, saveName, saveGroup = '细纲', maxTokens = 8192, chapterNum = null }) {
  const chn = llm.activeChannel();
  if (!chn || !chn.baseUrl) throw new Error('未配置模型渠道');
  const p = pk.prompts();
  const book = one(`SELECT * FROM books WHERE id=?`, bookId);
  const style = core.getBookStyle({ bookId });
  const sys = [
    p.system ? String(p.system).trim() : '',
    generationContext(bookId, book, style, 'outline'),
    // 与全托管路径同源的硬约束与连续性：世界规则、正典事件（按锚点过滤）、当前状态。
    longform.bookStoryContext(bookId, { chapterNum }),
    p[promptKey] ? String(p[promptKey]) : '',
  ].filter(Boolean).join('\n\n');
  const msgs = [{ role: 'system', content: sys }];
  if (userText) msgs.push({ role: 'user', content: String(userText) });
  let out = '';
  for await (const ev of llm.chatCompletion({ baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model || 'deepseek-chat', messages: msgs, maxTokens })) {
    if (ev.type === 'delta') out += ev.text;
  }
  const parsed = llm.extractJson(out);
  if (saveName && bookId) core.writeFileTo({ bookId, group: saveGroup, name: saveName, content: String(out).trim() });
  if (messageId) run(`UPDATE messages SET result_json=?, updated_at=? WHERE id=?`,
    JSON.stringify(parsed ?? { text: out }), now(), messageId);
  return { ok: true, text: out, parsed };
}

async function genChapterOutline({ bookId, chapterNum, direction }) {
  const st = nextChapterNum(bookId);
  const num = chapterNum || st;
  const briefRows = q(`SELECT content FROM messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT 5`,
    `%第${num}%`);
  const brief = briefRows.map((r) => r.content).join('\n') || '';
  const planned = chapterPlanEntryText(bookId, num);
  return runSmart({ bookId, promptKey: 'outline_json', chapterNum: num, userText:
    `为本书生成【第 ${num} 章】细纲。\n方向：${direction || ''}\n${planned ? `章节规划：${planned}\n` : ''}已有题要：${brief.slice(0, 2000)}\n请按大纲 JSON 格式输出。`,
    saveName: `细纲_第${num}章.md` });
}

async function generateOutlineOnce({ chn, model, messages, maxTokens, onUsage = null }) {
  let out = '';
  for await (const ev of llm.chatCompletion({
    baseUrl: chn.baseUrl,
    apiKey: chn.key,
    model,
    messages,
    temperature: 0.65,
    maxTokens,
  })) {
    if (ev.type === 'delta') out += ev.text;
    if (ev.type === 'meta' && ev.usage) onUsage?.(ev.usage);
  }
  return out;
}

async function generateOutlineForChapter({ bookId, n, end, plan, direction, chn, model, book, style, ctx, channel, indexes = null, onUsage = null }) {
  if (indexes?.outlines?.get(n)?.aiOff) {
    return { ok: false, message: `第${n}章细纲已标记禁止 AI 修改` };
  }
  let planned = chapterPlanEntryText(bookId, n);
  if (!planned) {
    await ensureChapterPlan({
      bookId, totalChapters: end, chapterWords: plan.chapterWords, fromChapter: n,
      ctx, channel, chn, book, style, model, indexes, onUsage,
    });
    planned = chapterPlanEntryText(bookId, n);
  }
  const p = pk.prompts();
  const autoRule = [
    '【自动细纲模式】',
    '这是长篇连载中的按章细纲任务。禁止返回 ask / options，禁止追问作者；信息不足时基于当前卷规划、前文事实与伏笔台账做合理补全。',
    `本轮只生成第${n}章，章号必须是第${n}章，不要生成其它章节。`,
    `全书预计 ${end} 章${plan.chapterWords ? `，每章正文目标约 ${plan.chapterWords} 字` : ''}。`,
    '必须严格遵守本章在【章节规划】中的目标、冲突、关系变化和章末钩子；至少拆成 2~4 个有因果推进的场景。',
    '细纲必须包含 "foreshadow"：{"planted":[],"advanced":[],"resolved":[]}，只列本章实际涉及且可在正文中兑现的伏笔。',
    '细纲必须包含 "continuity"：{"time":"","location":"","characters":[{"name":"","status":"","goal":"","relations":"","location":""}],"facts":[],"openThreads":[],"resolvedThreads":[]}。只记录截至本章末仍然成立的状态；人物状态要具体，不要写空泛评价。',
    '只输出一个完整细纲 JSON 对象，不要 markdown，不要代码围栏，不要解释。',
  ].join('\n');
  const sys = [
    p.system ? String(p.system).trim() : '',
    generationContext(bookId, book, style, 'outline'),
    String(p.outline_json || ''),
    autoRule,
  ].filter(Boolean).join('\n\n');
  const context = bookContextForOutline(bookId, n, indexes, 14000);
  const previousContext = previousChapterContext(bookId, n, indexes);
  const recalledContext = await chapterKnowledgeContext(
    bookId,
    [`第${n}章`, previousContext, context].filter(Boolean).join('\n'),
    6000,
    n,
  );
  let user = composeOutlinePromptContext({
    bookTitle: book && book.title, n, direction, planned, context, previousContext, recalledContext,
  });

  let parsed = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await generateOutlineOnce({
      chn,
      model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      maxTokens: 8192,
      onUsage,
    });
    parsed = llm.extractJson(raw);
    if (outlineLooksComplete(parsed)) break;
    if (attempt === 0) {
      user += '\n\n上一次输出不合格：必须直接产出完整细纲 JSON，至少 2 个场景，并包含 goal 与 hook；禁止追问、禁止只给单场景梗概。';
    }
  }
  if (!outlineLooksComplete(parsed)) {
    return { ok: false, message: '模型没有返回可保存的细纲 JSON' };
  }
  const outline = normalizeOutline(parsed, n);
  const name = `细纲_第${n}章.md`;
  core.writeFileTo({ bookId, group: '细纲', name, content: JSON.stringify(outline, null, 2) });
  return { ok: true, outline, name };
}

async function batchGenerateOutlinesUnlocked(args, ctx) {
  const { bookId, fromChapter, toChapter, totalChapters, chapterWords, direction, onEvent } = args;
  if (!bookId) throw new Error('缺少 bookId');
  const maxRetries = Math.max(1, Number.parseInt(String(args.maxRetries || 3), 10) || 3);
  const retryBaseDelayMs = Math.max(0, Number(args.retryBaseDelayMs ?? 1000) || 0);
  // 与正文批量同一套恢复语义：细纲失败同样会连累后面所有章节，没必要另立规则。
  const recoverMode = ['stop', 'skip', 'auto'].includes(String(args.recoverMode || ''))
    ? String(args.recoverMode)
    : (args.continueOnQuarantine === true ? 'skip' : 'auto');
  const maxConsecutiveFailures = Math.max(1, Number.parseInt(String(args.maxConsecutiveFailures ?? 2), 10) || 2);
  // 细纲没有独立的纠错提示入口，失败原因通过 direction 附加写回提示词。
  const escalateRetry = args.escalateRetry !== false;
  const maxTokensPerRun = Math.max(0, Number(args.maxTokensPerRun ?? 0) || 0);
  const savedPlan = totalChapters || chapterWords
    ? core.setBookPlanSettings({ bookId, totalChapters, chapterWords })
    : core.getBookPlanSettings({ bookId });
  const plan = core.getBookPlanSettings({ bookId });
  const end = Number.parseInt(String(toChapter || savedPlan.totalChapters || plan.totalChapters || ''), 10);
  if (!Number.isFinite(end) || end <= 0) throw new Error('请先填写本书总章节数');
  const start = Math.max(1, Number.parseInt(String(fromChapter || 1), 10) || 1);
  if (start > end) throw new Error('起始章节不能大于结束章节');

  const chn = llm.activeChannel();
  if (!chn || !chn.baseUrl) throw new Error('未配置模型渠道');
  const book = one(`SELECT * FROM books WHERE id=?`, bookId);
  if (!book) throw new Error('作品不存在');
  const style = core.getBookStyle({ bookId });
  const model = chn.model || core.getSettings().default_model || 'deepseek-chat';
  const channel = eventChannel(onEvent);
  const indexes = chapterFileIndexes(bookId);
  const created = [];
  const skipped = [];
  const failed = [];
  const quarantined = [];

  // 编排状态与正文共用同一套表；mode='outlines' 决定续跑时分派到哪条循环。
  let runId = '';
  const resumeRunId = String(args.resumeRunId || '');
  if (resumeRunId) {
    const existing = orch.getRun(resumeRunId);
    if (existing && existing.bookId === String(bookId)) runId = existing.id;
  }
  if (!runId) {
    try {
      runId = orch.createRun({
        bookId,
        mode: 'outlines',
        fromChapter: start,
        toChapter: end,
        chapterWords: plan.chapterWords,
        maxRetries,
        options: { recoverMode, maxTokensPerRun, maxConsecutiveFailures, direction: direction || '' },
      })?.id || '';
    } catch (error) {
      runId = '';
    }
  }

  let runStatus = 'failed';
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let stopReason = '';
  let consecutiveFailures = 0;
  const noteFailure = () => {
    consecutiveFailures += 1;
    if (recoverMode === 'stop') return true;
    if (recoverMode === 'skip') return false;
    return consecutiveFailures >= maxConsecutiveFailures;
  };
  const skipChapter = (n, title, reason) => {
    skipped.push(n);
    if (runId) {
      orch.markChapterCommitted({
        runId, bookId, chapterNum: n, title,
        quality: { gate: 'skipped', reason }, attemptCount: 0,
      });
    }
  };
  try {
    for (let n = start; n <= end; n++) {
      throwIfCancelled(bookId);
      if (runId) orch.ensureChapterRun({ runId, bookId, chapterNum: n });
      const protectedOutline = indexes.outlines.get(n);
      if (protectedOutline?.aiOff) {
        skipChapter(n, `第${n}章`, 'ai-off');
        sendEvent(ctx, channel, { type: 'step', index: n, title: `第${n}章细纲已标记禁止 AI 修改，跳过`, kind: 'skip' });
        if ((n - start + 1) % BATCH_YIELD_EVERY === 0) await yieldBatch();
        continue;
      }
      const existingOutline = readOutlineFile(bookId, protectedOutline);
      if (existingOutline && outlineLooksComplete(existingOutline.value)) {
        skipChapter(n, String(existingOutline.value?.title || `第${n}章`), 'existing-outline');
        sendEvent(ctx, channel, { type: 'step', index: n, title: `第${n}章已有细纲，跳过`, kind: 'skip' });
        if ((n - start + 1) % BATCH_YIELD_EVERY === 0) await yieldBatch();
        continue;
      }

      sendEvent(ctx, channel, { type: 'step', index: n, title: `正在生成第${n}章细纲`, kind: 'outline' });
      let lastFailureText = '';
      let attempts = 0;
      try {
        const generated = await orch.executeWithRetry({
          runId, bookId, chapterNum: n, phase: 'outline',
          maxAttempts: maxRetries, baseDelayMs: retryBaseDelayMs,
          shouldRetry: (error, kind) => !['cancelled', 'auth', 'context', 'budget'].includes(kind),
          onRetry: ({ error, attemptNo, delayMs }) => {
            lastFailureText = String(error.message || error).slice(0, 200);
            sendEvent(ctx, channel, {
              type: 'step', index: n, kind: 'retry',
              title: `第${n}章细纲未通过（${String(error.message || error).slice(0, 60)}），${Math.round(delayMs / 1000)} 秒后第 ${attemptNo + 1} 次重试`,
            });
          },
          task: async (attemptNo, recordUsage) => {
            attempts = attemptNo;
            const hint = escalateRetry && attemptNo > 1 && lastFailureText
              ? `【上一次细纲未通过校验】${lastFailureText}\n本次必须修正：直接产出完整细纲 JSON，至少 2~4 个有因果推进的场景，并包含 continuity 与 foreshadow。`
              : '';
            const result = await generateOutlineForChapter({
              bookId, n, end, plan,
              direction: [direction, hint].filter(Boolean).join('\n'),
              chn, model, book, style, ctx, channel, indexes,
              onUsage: recordUsage,
            });
            if (!result.ok) {
              throw Object.assign(new Error(result.message || '细纲生成失败'), { code: 'QUALITY_GATE' });
            }
            return result;
          },
        });
        indexes.outlines.set(n, { name: generated.name, aiOff: false });
        created.push({ n, name: generated.name, title: generated.outline.title });
        consecutiveFailures = 0;
        if (runId) {
          orch.markChapterCommitted({
            runId, bookId, chapterNum: n,
            title: String(generated.outline?.title || `第${n}章`),
            outlinePath: generated.name,
            quality: { gate: 'outline', attempts }, attemptCount: attempts,
          });
        }
        sendEvent(ctx, channel, { type: 'step', index: n, title: `已保存第${n}章细纲`, kind: 'done', name: generated.name });
      } catch (error) {
        if (error && error.code === 'BATCH_CANCELLED') throw error;
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ n, message });
        quarantined.push({ n, phase: 'outline', message });
        if (runId) orch.setChapterStatus(runId, n, 'quarantined', { bookId, error: message, attemptCount: attempts });
        sendEvent(ctx, channel, { type: 'step', index: n, title: `第${n}章细纲生成失败，本章已隔离`, kind: 'error' });
        if (noteFailure()) {
          stopReason = `连续 ${consecutiveFailures} 章失败，已停机：${message.slice(0, 80)}`;
          break;
        }
        continue;
      }

      if (maxTokensPerRun > 0) {
        const spent = runId ? orch.runUsage(runId).totalTokens : 0;
        if (spent >= maxTokensPerRun) {
          stopReason = `累计消耗 ${spent} tokens 已达到上限 ${maxTokensPerRun}`;
          runStatus = 'paused_budget';
          if (runId) orch.pauseRun(runId, stopReason);
          sendEvent(ctx, channel, {
            type: 'step', index: n, kind: 'budget',
            title: `已达到本轮 token 上限（${spent}/${maxTokensPerRun}），任务暂停，可从第 ${n + 1} 章续跑`,
          });
          break;
        }
      }
      if ((n - start + 1) % BATCH_YIELD_EVERY === 0) await yieldBatch();
    }
    if (runStatus !== 'paused_budget') runStatus = quarantined.length ? 'quarantined' : 'completed';
  } catch (error) {
    runStatus = error && error.code === 'BATCH_CANCELLED' ? 'cancelled' : 'failed';
    throw error;
  } finally {
    usage = runId ? orch.runUsage(runId) : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    if (runId) {
      try {
        if (runStatus === 'completed') orch.completeRun(runId);
        else if (runStatus === 'cancelled') orch.cancelRun(runId, '任务已取消');
        else if (runStatus === 'paused_budget') { /* 循环里已 pauseRun，保留断点等续跑 */ }
        else if (runStatus === 'quarantined') orch.quarantineRun(runId, failed[failed.length - 1]?.message || '存在被隔离的章节');
        else orch.quarantineRun(runId, failed[failed.length - 1]?.message || '生成中断');
      } catch (error) {
        // 编排状态写不进去不应掩盖真正的生成错误。
      }
    }
    appendRunLog({
      bookId, runId, from: start, to: end, created, skipped, repaired: [],
      quarantined, usage, stopReason, status: runStatus, kind: '细纲',
    });
  }
  sendEvent(ctx, channel, {
    type: 'done', full: '', created, skipped, failed, runId, stopReason, usage,
  });
  return {
    ok: failed.length === 0 && !stopReason,
    created, skipped, failed, quarantined, runId,
    total: end - start + 1, stopReason, runStatus, usage,
  };
}

function dedupeRepeatedParagraphs(text) {
  const source = String(text || '');
  const parts = source.split(/\n{2,}/);
  const seen = new Set();
  const kept = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.replace(/\s/g, '');
    if (key.length >= 40 && seen.has(key)) continue;
    if (key.length >= 40) seen.add(key);
    kept.push(trimmed);
  }
  return kept.join('\n\n');
}

function appendContinuationText(base, addition) {
  const current = String(base || '').trimEnd();
  const next = String(addition || '').trim();
  if (!next) return current;
  const max = Math.min(1600, current.length, next.length);
  for (let len = max; len >= 40; len--) {
    if (current.endsWith(next.slice(0, len))) return `${current}\n\n${next.slice(len)}`.trim();
  }
  return `${current}\n\n${next}`.trim();
}

function normalizeChapterBody(text, title, chapterNum) {
  let out = String(text || '').trim()
    .replace(/<\|(?:eos|endoftext|im_end|end)\|>/gi, '')
    .replace(/\[(?:DONE|END)\]/gi, '')
    .replace(/^```(?:markdown|md|text)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  if (!out || out.length < 80 || (out.startsWith('{') && out.endsWith('}'))) return '';
  out = dedupeRepeatedParagraphs(out);
  const firstHeading = out.split(/\r?\n/).find((line) => /^#{1,3}\s+/.test(line));
  if (chapterNumberFromName(firstHeading) !== chapterNum) out = `# ${title}\n\n${out}`;
  const lines = out.split(/\r?\n/);
  if (lines.length > 2 && /^#{1,3}\s+/.test(lines[0]) && lines[1].trim() === lines[0].replace(/^#{1,3}\s+/, '').trim()) {
    lines.splice(1, 2);
    out = lines.join('\n');
  }
  return out;
}

function summaryText(value, limit = 360) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function summaryLine(label, value, limit = 360) {
  const text = summaryText(value, limit);
  return text ? `- ${label}：${text}` : '';
}

function composeChapterSummaryContent(bookId, chapterNum, outline, body) {
  const n = Number(chapterNum);
  const continuity = outline.continuity || longform.normalizeContinuity(outline, n);
  const planRow = one(`SELECT content FROM chapter_plans WHERE book_id=? AND chapter_num=?`, bookId, n);
  const planText = planRow ? String(planRow.content || '').trim() : '';
  const plannedSummary = planText.replace(/^[^\n]*\n/, '').trim();
  const scenes = Array.isArray(outline.scenes) ? outline.scenes : [];
  const progress = scenes
    .map((scene) => scene && (scene.event || scene.purpose || scene.title))
    .filter(Boolean)
    .slice(0, 4)
    .join('；');
  const conflict = outline.conflict || outline.coreConflict || outline['核心冲突'] || progress;
  const characterChanges = (Array.isArray(continuity.characters) ? continuity.characters : [])
    .filter((character) => character && character.name && (character.status || character.relations || character.goal))
    .slice(0, 5)
    .map((character) => {
      const details = [
        character.status,
        character.relations ? `关系：${character.relations}` : '',
        character.goal ? `目标：${character.goal}` : '',
      ].filter(Boolean).join('；');
      return `${character.name}${details ? `（${details}）` : ''}`;
    })
    .join('；');
  const facts = (Array.isArray(continuity.facts) ? continuity.facts : []).slice(0, 6);
  const foreshadow = outline.foreshadow || {};
  const threadChanges = [
    ...(Array.isArray(continuity.openThreads) ? continuity.openThreads : []).map((item) => `埋设/保持「${item}」`),
    ...(Array.isArray(foreshadow.planted) ? foreshadow.planted : []).map((item) => `埋设「${item}」`),
    ...(Array.isArray(foreshadow.advanced) ? foreshadow.advanced : []).map((item) => `推进「${item}」`),
    ...(Array.isArray(continuity.resolvedThreads) ? continuity.resolvedThreads : []).map((item) => `回收「${item}」`),
    ...(Array.isArray(foreshadow.resolved) ? foreshadow.resolved : []).map((item) => `回收「${item}」`),
  ].filter((item, index, items) => items.indexOf(item) === index);
  const cleanBody = String(body || '').replace(/^#{1,3}\s+[^\n]+\n*/, '').trim();
  const ending = tailText(cleanBody, 320).replace(/\s+/g, ' ').trim();
  const lines = [
    summaryLine('本章目标', outline.goal, 260),
    summaryLine('规划走向', plannedSummary, 360),
    summaryLine('关键冲突与推进', conflict, 420),
    summaryLine('人物与关系变化', characterChanges, 420),
    summaryLine('关键既定事实', facts.join('；'), 420),
    summaryLine('伏笔变化', threadChanges.join('；'), 380),
    summaryLine('章末钩子', outline.hook, 260),
    summaryLine('章末承接', ending, 360),
    `- 正文字数：${bodyCharCount(body)}`,
  ].filter(Boolean);
  return fitTextBudget(lines.join('\n'), CHAPTER_SUMMARY_CHARS);
}

function upsertChapterSummary(bookId, chapterNum, outline, body) {
  ensureChapterSummariesImported(bookId);
  const n = Number(chapterNum);
  let title = String(outline.title || `第${chapterNum}章`).trim();
  if (chapterNumberFromName(title) !== n) title = `第${n}章 ${title}`;
  const content = composeChapterSummaryContent(bookId, n, outline, body);
  run(`INSERT INTO chapter_summaries(book_id, chapter_num, title, content, updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(book_id, chapter_num) DO UPDATE SET title=excluded.title, content=excluded.content, updated_at=excluded.updated_at`,
  bookId, n, title, content, now());
  longform.recordContinuity(bookId, n, outline);
  longform.refreshVolumeSummary(bookId, n);
  materializeChapterSummaries(bookId, { changedChapter: n });
}

function repairChapterMemory(bookId, chapterNum, outlineFile, body) {
  const outlineRef = typeof outlineFile === 'string' ? { name: outlineFile, aiOff: false } : outlineFile;
  const outline = readOutlineFile(bookId, outlineRef);
  if (!outline || !outlineLooksComplete(outline.value)) return '';
  ensureChapterSummariesImported(bookId);
  const summaryExists = !!one(`SELECT 1 AS present FROM chapter_summaries WHERE book_id=? AND chapter_num=?`,
    bookId, chapterNum);
  const continuityExists = !!one(`SELECT 1 AS present FROM chapter_continuity WHERE book_id=? AND chapter_num=?`,
    bookId, chapterNum);
  if (!summaryExists) {
    upsertChapterSummary(bookId, chapterNum, outline.value, body);
    return 'summary';
  }
  const repaired = [];
  if (!continuityExists) {
    longform.recordContinuity(bookId, chapterNum, outline.value);
    repaired.push('continuity');
  }
  if (chapterNum % longform.DEFAULT_VOLUME_CHAPTERS === 0) {
    const volumeNum = Math.ceil(chapterNum / longform.DEFAULT_VOLUME_CHAPTERS);
    const volumeExists = !!one(`SELECT 1 AS present FROM volume_summaries WHERE book_id=? AND volume_num=?`,
      bookId, volumeNum);
    if (!volumeExists) {
      longform.refreshVolumeSummary(bookId, chapterNum);
      repaired.push('volume');
    }
  }
  return repaired.join('+');
}

// AI 共创路径保存正文后的长期记忆补齐：与批量跳过路径共用 repairChapterMemory。
// 没有细纲的交互章节退化为最小摘要（章末承接 + 标题），保证章节摘要、知识召回
// 和跨书审计的人物/伏笔统计不至于断档。
function repairAfterBodySave({ bookId, group, name } = {}) {
  if (!bookId || (group !== '正文' && group !== 'chapters')) return null;
  const n = chapterNumberFromName(name);
  if (!n) return null;
  const indexes = chapterFileIndexes(bookId);
  const body = core.readFileFrom({ bookId, group: '正文', name }) || '';
  const repaired = repairChapterMemory(bookId, n, indexes.outlines.get(n) || null, body);
  if (repaired) return { repaired };
  const hasSummary = !!one(`SELECT 1 AS present FROM chapter_summaries WHERE book_id=? AND chapter_num=?`, bookId, n);
  if (hasSummary) return null;
  const title = String(name || '').replace(/\.md$/i, '');
  upsertChapterSummary(bookId, n, { title, goal: '', scenes: [], hook: '' }, body);
  return { repaired: 'summary-minimal' };
}

function upsertForeshadowLedger(bookId) {
  const content = longform.foreshadowLedgerMarkdown(bookId);
  core.writeFileTo({ bookId, group: '设定', name: '伏笔台账.md', content });
}

function upsertWritingCheckpoint(bookId, chapterNum, fileName, body) {
  const ending = tailText(String(body || '').replace(/^#{1,3}\s+[^\n]+\n*/, '').trim(), 700);
  const content = [
    '# 连载进度',
    '',
    `- 最后完成章节：第${chapterNum}章`,
    `- 最后正文文件：${fileName}`,
    `- 本章正文字数：${bodyCharCount(body)}`,
    `- 更新时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '## 下一章承接点',
    '',
    ending || '无',
    '',
  ].join('\n');
  core.writeFileTo({ bookId, group: '设定', name: '连载进度.md', content });
}

function bodyCharCount(content) {
  return String(content || '')
    .replace(/^#{1,3}\s+[^\n]+\n*/i, '')
    .replace(/\s/g, '')
    .length;
}

function bodyLooksComplete(content, targetWords) {
  const text = String(content || '').replace(/<\|(?:eos|endoftext|im_end|end)\|>/gi, '').trim();
  if (!text || /<\|(?:eos|endoftext|im_end|end)\|>/i.test(String(content || ''))) return false;
  if (bodyCharCount(text) < Math.max(320, Math.floor(Number(targetWords || 2400) * 0.85))) return false;
  return /[。！？.!?…」』）》】\)\]"'”’]$/.test(text.slice(-1));
}

function existingBodyLooksUsable(content) {
  const text = String(content || '').replace(/<\|(?:eos|endoftext|im_end|end)\|>/gi, '').trim();
  return Boolean(text);
}

function shouldSkipExistingBody(file, content, overwriteExisting = false) {
  return Boolean(file && file.aiOff) || (!overwriteExisting && existingBodyLooksUsable(content));
}

async function generateBodyOnce({ chn, model, messages, maxTokens, onDelta, onMeta }) {
  let out = '';
  for await (const ev of llm.chatCompletion({
    baseUrl: chn.baseUrl,
    apiKey: chn.key,
    model,
    messages,
    temperature: 0.7,
    maxTokens,
    noThinking: chn.noThinking,
  })) {
    if (ev.type === 'delta') {
      out += ev.text;
      onDelta?.(ev.text);
    }
    if (ev.type === 'meta') onMeta?.(ev);
  }
  return out;
}

// 无人值守跑完之后，人需要一份能直接读的交代：哪几章没写出来、为什么、花了多少。
// 追加到 设定/生成日志.md，不覆盖历史。
function appendRunLog({ bookId, runId, from, to, created, skipped, repaired, quarantined, usage, stopReason, status, kind = '正文' }) {
  try {
    const stamp = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const when = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ` +
      `${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;
    const statusText = {
      completed: '完成', quarantined: '有章节被隔离', paused_budget: '预算暂停', interrupted: '进程中断', failed: '中断', cancelled: '已取消',
    }[status] || String(status || '');
    const lines = [`## ${when} 第${from}-${to}章（${statusText}）`, ''];
    if (kind !== '正文') lines.push(`- 阶段：${kind}`);
    lines.push(`- 新建 ${created.length} 章，跳过 ${skipped.length} 章，补齐记忆 ${repaired.length} 处`);
    if (quarantined.length) {
      lines.push(`- 隔离 ${quarantined.length} 章：`);
      for (const item of quarantined.slice(0, 20)) {
        const phase = item.phase === 'outline' ? '细纲' : '正文';
        lines.push(`  - 第${item.n}章（${phase}）：${String(item.message || '').slice(0, 160)}`);
      }
      if (quarantined.length > 20) lines.push(`  - 其余 ${quarantined.length - 20} 章省略`);
    }
    if (usage && usage.totalTokens) {
      lines.push(`- 消耗：提示 ${usage.promptTokens} / 生成 ${usage.completionTokens} tokens`);
    }
    if (stopReason) lines.push(`- 停机原因：${stopReason}`);
    lines.push(`- 任务：${runId || '无状态'}`);
    lines.push('');
    core.appendFileTo({ bookId, group: '设定', name: '生成日志.md', content: lines.join('\n') + '\n' });
  } catch (error) {
    // 日志写失败不能影响生成结果。
  }
}

async function batchGenerateBodiesUnlocked(args, ctx) {
  const { bookId, fromChapter, toChapter, totalChapters, chapterWords, direction, onEvent, overwriteExisting = false } = args;
  const maxRetries = Math.max(1, Number.parseInt(String(args.maxRetries || 3), 10) || 3);
  const retryBaseDelayMs = Math.max(0, Number(args.retryBaseDelayMs ?? 1000) || 0);
  // local = 只跑确定性门禁（零成本）；model = 追加一次独立审核调用并做定向修订。
  const reviewMode = args.reviewMode === 'model' ? 'model' : 'local';
  const softThreshold = Number.isFinite(Number(args.softThreshold)) ? Number(args.softThreshold) : 3.2;
  const maxRevisions = Math.max(0, Number.parseInt(String(args.maxRevisions ?? 1), 10) || 0);
  // 默认保持历史行为：某一章彻底失败就停在原地。开启后改为隔离该章并继续，
  // 适合无人值守长跑，但会让后续章节在缺少前章正文的情况下推进。
  //   stop —— 任一章失败立即停机（旧行为，适合有人盯着）
  //   skip —— 隔离失败章节并继续，永不因单章失败停机
  //   auto —— 默认：隔离并继续，但连续失败达到 maxConsecutiveFailures 时停机
  // auto 的取舍：单章失败多半是这一章的问题（细纲太满、篇幅不达标），继续跑代价可控；
  // 连续多章失败多半是渠道/配额/上下文这类系统性问题，继续跑只会把错误扩散到整卷。
  const recoverMode = ['stop', 'skip', 'auto'].includes(String(args.recoverMode || ''))
    ? String(args.recoverMode)
    : (args.continueOnQuarantine === true ? 'skip' : 'auto');
  const continueOnQuarantine = recoverMode !== 'stop';
  const maxConsecutiveFailures = Math.max(1, Number.parseInt(String(args.maxConsecutiveFailures ?? 2), 10) || 2);
  // 重写时把上次失败原因喂回提示词，避免"同样的话再问一遍得到同样的错"。
  const escalateRetry = args.escalateRetry !== false;
  if (!bookId) throw new Error('缺少 bookId');
  const savedPlan = totalChapters || chapterWords
    ? core.setBookPlanSettings({ bookId, totalChapters, chapterWords })
    : core.getBookPlanSettings({ bookId });
  const plan = core.getBookPlanSettings({ bookId });
  const end = Number.parseInt(String(toChapter || savedPlan.totalChapters || plan.totalChapters || ''), 10);
  if (!Number.isFinite(end) || end <= 0) throw new Error('请先填写本书总章节数');
  const start = Math.max(1, Number.parseInt(String(fromChapter || 1), 10) || 1);
  if (start > end) throw new Error('起始章节不能大于结束章节');
  // 单次尝试的 token 上限是"跑飞检测"而不是成本上限：按目标字数推算正常开销再乘 6 倍，
  // 正常章节远达不到，只有续写/重试进入循环时才会触发。
  const expectedChapterTokens = Math.max(8000, Math.ceil(Number(plan.chapterWords || 2400) * 1.5) + 8000);
  const maxTokensPerChapter = Math.max(0, Number(args.maxTokensPerChapter ?? 0) || 0) ||
    Math.round(expectedChapterTokens * 6);
  // 整轮 token 上限（0 = 不限制）。无人值守长跑建议显式给一个，超限时保留断点暂停。
  const maxTokensPerRun = Math.max(0, Number(args.maxTokensPerRun ?? 0) || 0);

  const chn = llm.activeChannel();
  if (!chn || !chn.baseUrl) throw new Error('未配置模型渠道');
  const p = pk.prompts();
  const book = one(`SELECT * FROM books WHERE id=?`, bookId);
  if (!book) throw new Error('作品不存在');
  const style = core.getBookStyle({ bookId });
  const model = chn.model || core.getSettings().default_model || 'deepseek-chat';
  const channel = eventChannel(onEvent);
  const indexes = chapterFileIndexes(bookId);
  const created = [];
  const skipped = [];
  const repaired = [];
  const failed = [];
  const quarantined = [];
  // 编排状态是增强项：写不进数据库时降级为原来的无状态批量，不让整个任务失败。
  // 放在前置校验之后创建，避免模型渠道未配置时留下永远 running 的僵尸任务。
  let runId = '';
  // 续跑时复用原来的 run，不新建：否则 token 账目、章节状态和失败原因会被切成两段。
  const resumeRunId = String(args.resumeRunId || '');
  if (resumeRunId) {
    const existing = orch.getRun(resumeRunId);
    if (existing && existing.bookId === String(bookId)) runId = existing.id;
  }
  if (!runId) {
    try {
      const createdRun = orch.createRun({
        bookId,
        mode: 'full',
        fromChapter: start,
        toChapter: end,
        chapterWords: plan.chapterWords,
        maxRetries,
        options: {
          continueOnQuarantine, recoverMode, reviewMode, overwriteExisting: !!overwriteExisting,
          direction: direction || '', maxTokensPerRun, maxTokensPerChapter, maxConsecutiveFailures,
        },
      });
      runId = createdRun?.id || '';
    } catch (error) {
      runId = '';
    }
  }
  let keepAlive = null;
  let summariesDirty = false;
  let foreshadowDirty = false;
  let runStatus = 'failed';
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let stopReason = '';
  let consecutiveFailures = 0;
  let latestAudit = null;
  // 单次尝试的 token 累计（含续写与审核调用），用于识别"越写越长"的失控。
  // 每次尝试开始时清零：上一次的消耗已经是沉没成本，不该让下一次尝试直接撞上限。
  let chapterTokens = 0;
  const noteFailure = () => {
    consecutiveFailures += 1;
    if (recoverMode === 'stop') return true;
    if (recoverMode === 'skip') return false;
    return consecutiveFailures >= maxConsecutiveFailures;
  };
  const assertChapterBudget = () => {
    if (maxTokensPerChapter > 0 && chapterTokens > maxTokensPerChapter) {
      throw Object.assign(
        new Error(`本次尝试累计消耗 ${chapterTokens} tokens，超过单次上限 ${maxTokensPerChapter}，判定为失控`),
        { code: 'TOKEN_RUNAWAY' },
      );
    }
  };
  try {
    for (let n = start; n <= end; n++) {
      throwIfCancelled(bookId);
      if (runId) orch.ensureChapterRun({ runId, bookId, chapterNum: n });
      const existingFile = indexes.bodies.get(n);
      const existingContent = existingFile && (!overwriteExisting || existingFile.aiOff)
        ? (core.readFileFrom({ bookId, group: '正文', name: existingFile.name }) || '')
        : '';
      if (shouldSkipExistingBody(existingFile, existingContent, overwriteExisting)) {
        const memory = repairChapterMemory(bookId, n, indexes.outlines.get(n), existingContent);
        if (memory) {
          repaired.push({ n, kind: memory });
          const repairedKinds = new Set(memory.split('+'));
          if (repairedKinds.has('summary') || repairedKinds.has('volume')) summariesDirty = true;
          if (repairedKinds.has('summary') || repairedKinds.has('continuity')) foreshadowDirty = true;
        }
        skipped.push({ n, name: existingFile.name });
        if (runId) {
          orch.markChapterCommitted({
            runId, bookId, chapterNum: n,
            title: String(existingFile.name || '').replace(/\.md$/i, ''),
            bodyPath: existingFile.name,
            bodyChars: bodyCharCount(existingContent),
            quality: { gate: 'skipped', reason: existingFile.aiOff ? 'ai-off' : 'existing-body' },
            attemptCount: 0,
          });
        }
        const reason = existingFile.aiOff ? '已标记禁止 AI 修改' : '已有正文';
        sendEvent(ctx, channel, { type: 'step', index: n, title: `第${n}章${reason}，保留原文并跳过`, kind: 'skip' });
        if ((n - start + 1) % BATCH_YIELD_EVERY === 0) await yieldBatch();
        continue;
      }

      let outline = readOutlineFile(bookId, indexes.outlines.get(n));
      let outlineValue = outline?.value || null;
      if (!outline || !outlineLooksComplete(outlineValue)) {
        sendEvent(ctx, channel, { type: 'step', index: n, title: `第${n}章细纲缺失，正在按需补齐`, kind: 'outline' });
        let generated;
        try {
          generated = await orch.executeWithRetry({
            runId, bookId, chapterNum: n, phase: 'outline', maxAttempts: maxRetries, baseDelayMs: retryBaseDelayMs,
            shouldRetry: (error, kind) => !['cancelled', 'auth', 'context', 'budget'].includes(kind),
            onRetry: ({ error, attemptNo, delayMs }) => sendEvent(ctx, channel, {
              type: 'step', index: n, kind: 'retry',
              title: `第${n}章细纲生成失败（${String(error.message || error).slice(0, 60)}），${Math.round(delayMs / 1000)} 秒后第 ${attemptNo + 1} 次重试`,
            }),
            task: async (_attemptNo, recordUsage) => {
              const result = await generateOutlineForChapter({
                bookId, n, end, plan, direction, chn, model, book, style, ctx, channel, indexes,
                // 全托管模式下细纲与规划调用同样要进账，否则整轮预算刹车看不见这部分消耗。
                onUsage: recordUsage,
              });
              if (!result.ok) {
                throw Object.assign(new Error(result.message || '细纲生成失败'), { code: 'QUALITY_GATE' });
              }
              return result;
            },
          });
        } catch (error) {
          if (error && error.code === 'BATCH_CANCELLED') throw error;
          const message = error instanceof Error ? error.message : String(error);
          failed.push({ n, message });
          quarantined.push({ n, phase: 'outline', message });
          if (runId) orch.setChapterStatus(runId, n, 'quarantined', { bookId, error: message });
          sendEvent(ctx, channel, { type: 'step', index: n, title: `第${n}章细纲生成失败，本章已隔离`, kind: 'error' });
          if (noteFailure()) {
            stopReason = `连续 ${consecutiveFailures} 章失败，已停机：${message.slice(0, 80)}`;
            break;
          }
          continue;
        }
        outlineValue = generated.outline;
        outline = { name: generated.name, content: JSON.stringify(generated.outline, null, 2) };
        indexes.outlines.set(n, { name: generated.name, aiOff: false });
      }
      if (runId) {
        orch.setChapterStatus(runId, n, 'outlined', {
          bookId,
          title: String(outlineValue?.title || `第${n}章`).trim(),
          outlinePath: outline?.name || null,
        });
      }
      const nextOutline = n < end ? readOutlineFile(bookId, indexes.outlines.get(n + 1)) : null;
      const planText = chapterPlanEntryText(bookId, n);
      const nextPlanText = !nextOutline && n < end ? chapterPlanEntryText(bookId, n + 1) : '';
      const title = String(outlineValue?.title || `第${n}章`).trim();
      const context = bookContextForOutline(bookId, n, indexes, 12000);
      const previousContext = previousChapterContext(bookId, n, indexes);
      const recalledContext = await chapterKnowledgeContext(
        bookId,
        [title, outline.content, previousContext].filter(Boolean).join('\n'),
        6000,
        n,
      );
      const sys = [
        p.system ? String(p.system).trim() : '',
        generationContext(bookId, book, style, 'body'),
        String(p.skill_body || ''),
        [
          '【自动正文模式】',
          '这是全书自动写作任务，禁止返回提问、选项、JSON 或写作说明。',
          `本轮只生成第${n}章正文，不要写其它章节。`,
          `全书预计 ${end} 章；本章标题为「${title}」。`,
          `本章正文目标约 ${plan.chapterWords || 2400} 字，正文主体不得提前结束；请写到完整收束并以完整句子结尾。`,
          previousContext ? '必须从上一章结尾的具体状态自然接续，保持人物位置、时间线、视角和未解决冲突一致。' : '',
          '必须遵守长期连续性状态中的人物状态、时空、既定事实和未回收线索；若资料彼此冲突，以最近正文和本章细纲为准，不得静默改写已确立事实。',
          '正文必须承接前文，并严格执行本章细纲；直接输出可发布的章节正文。',
        ].join('\n'),
      ].filter(Boolean).join('\n\n');
      const targetWords = Number(plan.chapterWords || 2400);
      const minimumWords = Math.max(320, Math.floor(targetWords * 0.85));
      const user = composeBodyPromptContext({
        bookTitle: book && book.title,
        n,
        direction,
        planText,
        outlineText: outline.content,
        nextOutlineText: nextOutline ? nextOutline.content : '',
        nextPlanText,
        context,
        previousContext,
        recalledContext,
        targetWords,
        minimumWords,
      });

      const previousBodyRaw = n > 1
        ? chapterFileContent(bookId, '正文', indexes.bodies.get(n - 1))
        : '';
      const expectedPov = String(book.pov || '');
      sendEvent(ctx, channel, { type: 'step', index: n, title: `正在生成第${n}章正文`, kind: 'body' });
      keepAlive = setInterval(() => {
        sendEvent(ctx, channel, { type: 'progress', index: n, chars: 0 });
      }, 12000);
      let body = '';
      let bodyAttempts = 0;
      let lastReview = null;
      let lastFailureText = '';
      try {
        body = await orch.executeWithRetry({
          runId, bookId, chapterNum: n, phase: 'body', maxAttempts: maxRetries, baseDelayMs: retryBaseDelayMs,
          shouldRetry: (error, kind) => !['cancelled', 'auth', 'context', 'budget'].includes(kind),
          onRetry: ({ error, attemptNo, delayMs }) => {
            lastFailureText = String(error.message || error).slice(0, 200);
            sendEvent(ctx, channel, {
              type: 'step', index: n, kind: 'retry',
              title: `第${n}章正文未通过校验（${String(error.message || error).slice(0, 60)}），${Math.round(delayMs / 1000)} 秒后第 ${attemptNo + 1} 次重写`,
            });
          },
          task: async (attemptNo, recordUsage) => {
            bodyAttempts = attemptNo;
            chapterTokens = 0;
            // 第二次起把上次被判不合格的原因写回提示词，否则同样的输入只会得到同样的错。
            const escalation = escalateRetry && attemptNo > 1 && lastFailureText
              ? [
                '【上一次尝试被判定不合格】',
                lastFailureText,
                '本次重写必须避开上一版的问题：不要复用上一版的开头、句式与收尾；不要输出任何解释、标题说明或元信息；确保正文完整收束并以完整句子结尾。',
              ].join('\n')
              : '';
            const attemptUser = escalation ? `${user}\n\n${escalation}` : user;
            const trackUsage = (raw) => {
              recordUsage(raw);
              chapterTokens += Number(raw?.prompt_tokens || raw?.promptTokens || 0) +
                Number(raw?.completion_tokens || raw?.completionTokens || 0);
            };
            // 只让第一次尝试把增量推给前端，重写不再重复刷屏。
            const streamDelta = attemptNo === 1
              ? (text) => sendEvent(ctx, channel, { type: 'delta', index: n, text })
              : null;
            let finishReason = null;
            const maxBodyTokens = Math.min(8192, Math.max(1024, Math.ceil(Number(plan.chapterWords || 2400) * 1.8)));
            let raw = await generateBodyOnce({
              chn,
              model,
              messages: [{ role: 'system', content: sys }, { role: 'user', content: attemptUser }],
              maxTokens: maxBodyTokens,
              onDelta: streamDelta,
              onMeta: (meta) => {
                if (meta.finishReason) finishReason = meta.finishReason;
                if (meta.usage) trackUsage(meta.usage);
              },
            });
            assertChapterBudget();
            // Models may stop early with a normal period. Continue until the chapter
            // reaches the configured length floor and has a complete ending.
            const attemptTargetWords = Number(plan.chapterWords || 2400);
            const attemptMinimumWords = Math.max(320, Math.floor(attemptTargetWords * 0.85));
            const maximumWords = Math.max(attemptMinimumWords, Math.ceil(attemptTargetWords * 1.25));
            let continuationCount = 0;
            while (continuationCount < 4) {
              const currentWords = bodyCharCount(raw);
              const tail = raw.trim().slice(-1);
              const hasEnding = /[。！？.!?…」』）》】\)\]"'”’]$/.test(tail);
              const needsMore = currentWords < attemptMinimumWords || !hasEnding || finishReason === 'length';
              if (!needsMore || (currentWords >= maximumWords && hasEnding)) break;
              continuationCount += 1;
              const remaining = Math.max(600, attemptTargetWords * 1.08 - currentWords);
              const continuationMaxTokens = Math.min(8192, Math.max(1024, Math.ceil(remaining * 1.7)));
              const continuation = await generateBodyOnce({
                chn,
                model,
                messages: composeContinuationMessages({
                  system: sys,
                  user,
                  raw,
                  currentWords,
                  targetWords: attemptTargetWords,
                  minimumWords: attemptMinimumWords,
                }),
                maxTokens: continuationMaxTokens,
                onDelta: streamDelta,
                // 续写同样要进账并刷新截断信号：漏记会让整轮预算和单章失控检测都看不见这部分消耗。
                onMeta: (meta) => {
                  if (meta.finishReason) finishReason = meta.finishReason;
                  if (meta.usage) trackUsage(meta.usage);
                },
              });
              if (!continuation.trim()) break;
              const merged = appendContinuationText(raw, continuation);
              if (merged.length - raw.length < 40) break;
              raw = merged;
              assertChapterBudget();
            }
            raw = dedupeRepeatedParagraphs(raw);
            const candidate = normalizeChapterBody(raw, title, n);
            if (!candidate) {
              throw Object.assign(new Error('模型返回的正文为空'), { code: 'QUALITY_GATE' });
            }

            // 第一层：确定性门禁。不通过就重写，不落盘。
            const gate = quality.runLocalGate({
              bookId,
              body: candidate,
              outline: outlineValue,
              previousBody: previousBodyRaw,
              targetWords: plan.chapterWords,
              expectedPov,
            });
            if (!gate.passed) {
              if (runId) {
                orch.recordReview({
                  runId, bookId, chapterNum: n, attemptNo,
                  review: { passed: false, score: gate.score, issues: gate.issues, metrics: { ...gate.metrics, stage: 'local' } },
                });
              }
              throw Object.assign(new Error(`质量门禁未通过：${gate.summary}`), { code: 'QUALITY_GATE', gate });
            }

            let finalBody = candidate;
            if (reviewMode === 'model') {
              // 第二层：独立审核调用。硬性不通过必须重写；软性偏低做定向修订。
              let review = await quality.reviewWithModel({
                channel: chn, model, body: finalBody, outline: outlineValue,
                previousBody: previousBodyRaw, targetWords: plan.chapterWords, onUsage: trackUsage,
              });
              if (review && !review.passed) {
                if (runId) orch.recordReview({ runId, bookId, chapterNum: n, attemptNo, review });
                throw Object.assign(new Error(`质量审核未通过：${review.summary}`), { code: 'QUALITY_GATE' });
              }
              if (review) {
                let revisions = 0;
                while (review.score < softThreshold && revisions < maxRevisions) {
                  revisions += 1;
                  const revised = await quality.reviseChapter({
                    channel: chn, model, body: finalBody,
                    issues: review.issues.filter((item) => item.message),
                    targetWords: plan.chapterWords, onUsage: trackUsage,
                  });
                  if (!revised) break;
                  // 修订稿同样要过一遍标题规范化与本地门禁，否则会绕过格式检查。
                  const revisedBody = normalizeChapterBody(revised, title, n);
                  const regate = quality.runLocalGate({
                    bookId, body: revisedBody, outline: outlineValue, previousBody: previousBodyRaw,
                    targetWords: plan.chapterWords, expectedPov,
                  });
                  if (!regate.passed) break;
                  const second = await quality.reviewWithModel({
                    channel: chn, model, body: revisedBody, outline: outlineValue,
                    previousBody: previousBodyRaw, targetWords: plan.chapterWords, onUsage: trackUsage,
                  });
                  if (!second || !second.passed || second.score <= review.score) break;
                  finalBody = revisedBody;
                  review = second;
                }
                lastReview = review;
                if (runId) orch.recordReview({ runId, bookId, chapterNum: n, attemptNo, review });
              }
            } else if (runId) {
              orch.recordReview({
                runId, bookId, chapterNum: n, attemptNo,
                review: { passed: true, score: gate.score, issues: gate.issues, metrics: { ...gate.metrics, stage: 'local' } },
              });
            }
            return finalBody;
          },
        });
      } catch (error) {
        // 取消不是章节的错，不能把它记成隔离。
        if (error && error.code === 'BATCH_CANCELLED') throw error;
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ n, message });
        quarantined.push({ n, phase: 'body', message });
        if (runId) orch.setChapterStatus(runId, n, 'quarantined', { bookId, error: message, attemptCount: bodyAttempts });
        sendEvent(ctx, channel, { type: 'step', index: n, title: `第${n}章正文生成失败，本章已隔离`, kind: 'error' });
        if (noteFailure()) {
          stopReason = `连续 ${consecutiveFailures} 章失败，已停机：${message.slice(0, 80)}`;
          break;
        }
        continue;
      } finally {
        clearInterval(keepAlive);
        keepAlive = null;
      }

      const name = `第${n}章.md`;
      if (runId) {
        const qualityInfo = {
          gate: 'passed',
          reviewMode,
          chars: bodyCharCount(body),
          targetWords: Number(plan.chapterWords || 2400),
          attempts: bodyAttempts,
          score: lastReview ? lastReview.score : null,
          dimensions: lastReview && lastReview.dimensions ? lastReview.dimensions : null,
        };
        orch.setChapterStatus(runId, n, 'reviewed', {
          bookId, title, bodyChars: qualityInfo.chars, quality: qualityInfo, attemptCount: bodyAttempts,
        });
      }
      core.writeFileTo({ bookId, group: '正文', name, content: body });
      upsertChapterSummary(bookId, n, outlineValue || { title, goal: '', scenes: [], hook: '' }, body);
      summariesDirty = true;
      foreshadowDirty = true;
      if (n % SUMMARY_SNAPSHOT_CHAPTERS === 0) upsertForeshadowLedger(bookId);
      upsertWritingCheckpoint(bookId, n, name, body);
      indexes.bodies.set(n, { name, aiOff: false });
      created.push({ n, name, title });
      if (runId) {
        orch.markChapterCommitted({
          runId, bookId, chapterNum: n, title,
          outlinePath: outline?.name || null,
          bodyPath: name,
          bodyChars: bodyCharCount(body),
          quality: {
            gate: 'passed', reviewMode, chars: bodyCharCount(body), attempts: bodyAttempts,
            score: lastReview ? lastReview.score : null,
          },
          attemptCount: bodyAttempts,
        });
      }
      // 每 10 章做跨章审计，每卷末做全局审计。审计只报告，不阻断生成。
      if (n % audit.WINDOW_SIZE === 0) {
        try {
          const report = audit.auditWindow({
            bookId, fromChapter: Math.max(start, n - audit.WINDOW_SIZE + 1), toChapter: n,
          });
          audit.save(report);
          audit.appendReportToFile({ bookId, report });
          latestAudit = report;
          if (report.issues.length) {
            sendEvent(ctx, channel, {
              type: 'step', index: n, kind: 'audit',
              title: `第${report.fromChapter}-${report.toChapter}章审计：${report.issues[0].message}`,
            });
          }
        } catch (error) { /* 审计是附加能力，不能影响正文落盘 */ }
      }
      if (n % audit.VOLUME_SIZE === 0) {
        try {
          const report = audit.auditVolume({ bookId, volumeNum: Math.ceil(n / audit.VOLUME_SIZE) });
          audit.save(report);
          audit.appendReportToFile({ bookId, report });
          latestAudit = report;
          if (report.issues.length) {
            sendEvent(ctx, channel, {
              type: 'step', index: n, kind: 'audit',
              title: `第${report.metrics.volume}卷审计：${report.issues[0].message}`,
            });
          }
        } catch (error) { /* 同上 */ }
      }
      sendEvent(ctx, channel, { type: 'step', index: n, title: `已保存第${n}章正文`, kind: 'done', name });
      consecutiveFailures = 0;
      // 整轮预算：超限就保留断点暂停，而不是把剩下的章节全跑成失败。
      if (maxTokensPerRun > 0) {
        const spent = runId ? orch.runUsage(runId).totalTokens : chapterTokens;
        if (spent >= maxTokensPerRun) {
          stopReason = `累计消耗 ${spent} tokens 已达到上限 ${maxTokensPerRun}`;
          runStatus = 'paused_budget';
          if (runId) orch.pauseRun(runId, stopReason);
          sendEvent(ctx, channel, {
            type: 'step', index: n, kind: 'budget',
            title: `已达到本轮 token 上限（${spent}/${maxTokensPerRun}），任务暂停，可从第 ${n + 1} 章续跑`,
          });
          break;
        }
      }
    }
    if (runStatus !== 'paused_budget') runStatus = quarantined.length ? 'quarantined' : 'completed';
  } catch (error) {
    runStatus = error && error.code === 'BATCH_CANCELLED' ? 'cancelled' : 'failed';
    throw error;
  } finally {
    if (keepAlive) clearInterval(keepAlive);
    // This is a cheap no-op when the materialized file is current, and closes
    // the crash window where SQLite was updated but Markdown was not.
    materializeChapterSummaries(bookId);
    if (foreshadowDirty) upsertForeshadowLedger(bookId);
    // 取消和异常路径同样要留痕，所以日志写在 finally 里而不是 return 之前。
    usage = runId ? orch.runUsage(runId) : { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    appendRunLog({
      bookId, runId, from: start, to: end, created, skipped, repaired,
      quarantined, usage, stopReason, status: runStatus,
    });
    if (runId) {
      try {
        if (runStatus === 'completed') orch.completeRun(runId);
        else if (runStatus === 'cancelled') orch.cancelRun(runId, '任务已取消');
        else if (runStatus === 'paused_budget') { /* 循环里已 pauseRun，保留断点等续跑 */ }
        else if (runStatus === 'quarantined') orch.quarantineRun(runId, failed[failed.length - 1]?.message || '存在被隔离的章节');
        else orch.quarantineRun(runId, failed[failed.length - 1]?.message || '生成中断');
      } catch (error) {
        // 编排状态写不进去不应掩盖真正的生成错误。
      }
    }
  }
  sendEvent(ctx, channel, {
    type: 'done', full: '', created, skipped, repaired, failed, quarantined, runId, stopReason, usage,
  });
  // 自动送评审团：只对本次新写的章节各跑一轮（只出意见、不自动改稿）。
  // 放在 finally 之后：评审失败不该把「正文已生成」的批次改判为失败。
  let autoReview = null;
  // quarantined = 个别章被隔离，但本次新写成的章仍应送评；
  // 取消 / 预算暂停 / 异常失败时不自动送评，避免作者已叫停后继续产生费用。
  if ((runStatus === 'completed' || runStatus === 'quarantined') && created.length) {
    try {
      autoReview = await require('./review-engine').autoReviewNovelChapters({
        bookId, idxs: created.map((item) => item.n), panelReview: args.panelReview,
      });
      if (autoReview && autoReview.panel) {
        const failedChapters = autoReview.sections.filter((item) => item.error);
        let title = `已送出评审团（${autoReview.panel}）：${autoReview.reviewed} 章有意见`;
        if (autoReview.capped) {
          title += `；本次只自动评审前 ${autoReview.maxItems} 章（共 ${autoReview.requested} 章），其余请在评审页手动发起`;
        }
        if (failedChapters.length) {
          title += `；${failedChapters.length} 章未能评审（${failedChapters[0].error}）`;
        }
        sendEvent(ctx, channel, { type: 'step', index: 0, kind: 'review', title });
      }
    } catch (error) { /* 评审是增强项，不影响本次生成结果 */ }
  }
  return {
    ok: failed.length === 0 && !stopReason,
    created, skipped, repaired, failed, quarantined, runId,
    total: end - start + 1, stopReason, runStatus, usage, latestAudit, autoReview,
  };
}

async function batchGenerateOutlines(args, ctx) {
  batchCancellations.delete(String(args.bookId || ''));
  return withBatchTaskLock(args.bookId, '批量生成细纲', () => batchGenerateOutlinesUnlocked(args, ctx));
}

async function batchGenerateBodies(args, ctx) {
  batchCancellations.delete(String(args.bookId || ''));
  return withBatchTaskLock(args.bookId, '批量生成正文', () => batchGenerateBodiesUnlocked(args, ctx));
}

async function batchGenerateFull(args, ctx) {
  const { bookId } = args || {};
  batchCancellations.delete(String(bookId || ''));
  try {
    return await withBatchTaskLock(bookId, '全 AI 托管', async () => {
      if (!hasReadySetupDocs(bookId)) {
        throw new Error('设定尚未就绪：请先完成 AI 共创并保存世界观、人物库和剧情大纲');
      }
      // 长篇托管采用逐章滚动：规划当前窗口 -> 细纲 -> 正文 -> 审核 -> 摘要/伏笔归档。
      // 不预先生成全书细纲，因此任何一章完成后都可以安全中断并从下一章续写。
      // 无人值守路径默认开启模型审核，显式传入的 reviewMode 优先。
      // 全托管就是无人值守路径：默认给一个宽松的 token 上限（约 600 章的量），
      // 超限只是暂停并可续跑，但能挡住"重试死循环烧穿账单"这一种最坏情况。
      const body = await batchGenerateBodiesUnlocked({
        reviewMode: 'model',
        maxTokensPerRun: 8000000,
        ...args,
      }, ctx);
      return {
        ok: body.ok,
        phase: 'rolling',
        outline: null,
        body,
        created: body.created,
        skipped: body.skipped,
        failed: body.failed,
      };
    });
  } finally {
    batchCancellations.delete(String(bookId || ''));
  }
}

function cancelBatch({ bookId }) {
  if (bookId) batchCancellations.add(String(bookId));
  return { ok: true };
}

// 无人值守长跑的可观测面：能查进度、能看隔离章节、能从断点续跑。
function generationRunStatus({ runId, bookId }) {
  let targetId = String(runId || '').trim();
  if (!targetId) {
    if (!bookId) throw new Error('缺少 runId 或 bookId');
    const active = orch.findResumableRun(bookId);
    const fallback = active || one(`SELECT id FROM generation_runs WHERE book_id=? ORDER BY updated_at DESC LIMIT 1`, bookId);
    targetId = String(fallback?.id || '');
  }
  if (!targetId) {
    return {
      run: null, chapters: [], chapterStats: {}, quarantined: [],
      attempts: { total: 0, failed: 0, promptTokens: 0, completionTokens: 0 },
      reviews: { total: 0, failed: 0, averageScore: null },
    };
  }
  const diagnostics = orch.runDiagnostics(targetId);
  if (!diagnostics) throw new Error('生成任务不存在');
  return diagnostics;
}

function runConsistencyAudit({ bookId, scope = 'window', fromChapter, toChapter, volumeNum } = {}) {
  if (!bookId) throw new Error('缺少 bookId');
  const report = scope === 'volume'
    ? audit.auditVolume({ bookId, volumeNum })
    : audit.auditWindow({ bookId, fromChapter, toChapter });
  audit.save(report);
  // 手动审计同样要留下可读产物，否则报告只躺在数据库里没人看得见。
  audit.appendReportToFile({ bookId, report });
  return report;
}

// ---------- 世界规则 / 正典事件 ----------
// 表是缓存、设定文件是真相源：CRUD 落库后立刻物化 Markdown，读取前按 stamp 回导。

function requireBook(bookId) {
  if (!bookId) throw new Error('缺少 bookId');
  const book = one(`SELECT id FROM books WHERE id=?`, bookId);
  if (!book) throw new Error('作品不存在');
  return bookId;
}

function getWorldRules({ bookId } = {}) {
  return { rules: longform.listWorldRules(requireBook(bookId)) };
}

function saveWorldRule(args = {}) {
  const bookId = requireBook(args.bookId);
  longform.upsertWorldRule(bookId, args);
  longform.materializeWorldRules(bookId);
  return { ok: true, rules: longform.listWorldRules(bookId) };
}

function deleteWorldRule(args = {}) {
  const bookId = requireBook(args.bookId);
  longform.deleteWorldRule(bookId, args.ruleKey);
  longform.materializeWorldRules(bookId);
  return { ok: true, rules: longform.listWorldRules(bookId) };
}

function getCanonEvents({ bookId } = {}) {
  return { events: longform.listCanonEvents(requireBook(bookId)) };
}

function saveCanonEvent(args = {}) {
  const bookId = requireBook(args.bookId);
  longform.upsertCanonEvent(bookId, args);
  longform.materializeCanonEvents(bookId);
  return { ok: true, events: longform.listCanonEvents(bookId) };
}

function deleteCanonEvent(args = {}) {
  const bookId = requireBook(args.bookId);
  longform.deleteCanonEvent(bookId, args.eventKey);
  longform.materializeCanonEvents(bookId);
  return { ok: true, events: longform.listCanonEvents(bookId) };
}

// 续跑 = 重排未提交的章节 + 复用原 run + 真正把批量循环重新拉起来。
// 只把状态改回 running 是没用的：没有驱动者，run 会一直挂着。
async function resumeGenerationRun(args, ctx) {
  const runId = String(args?.runId || '');
  if (!runId) throw new Error('缺少 runId');
  const point = orch.resumePoint(runId);
  if (!point) throw new Error('生成任务不存在');
  const run = point.run;
  if (!orch.ACTIVE_STATUSES.includes(run.status)) {
    throw new Error(`任务已结束（${run.status}），无法续跑`);
  }
  if (point.fromChapter > point.toChapter) {
    return { ok: true, run, skipped: true, message: '范围内章节已全部提交，无需续跑' };
  }
  const reopened = orch.reopenChapters(runId, point.reopen);
  orch.resumeRun(runId);
  sendEvent(ctx, eventChannel(args?.onEvent), {
    type: 'step', kind: 'resume',
    title: `从第${point.fromChapter}章继续（重排 ${reopened} 章）`,
  });
  // 原任务的选项必须还原，否则续跑会静默降级：
  // 全托管（reviewMode='model'）续跑变成 local 审核、预算上限原样带回然后秒停。
  const options = run.options || {};
  let maxTokensPerRun = args?.maxTokensPerRun;
  if (maxTokensPerRun == null) {
    const original = Math.max(0, Number(options.maxTokensPerRun || 0));
    if (original > 0) {
      // 预算暂停的续跑授予一整窗新预算：已花的钱不算进新窗口，
      // 否则"续跑"只是把暂停状态再触发一遍。
      const spentBefore = run.status === 'paused_budget' ? orch.runUsage(runId).totalTokens : 0;
      maxTokensPerRun = spentBefore + original;
    } else {
      maxTokensPerRun = 0;
    }
  }
  const base = {
    bookId: run.bookId,
    fromChapter: point.fromChapter,
    toChapter: point.toChapter,
    resumeRunId: runId,
    recoverMode: args?.recoverMode || options.recoverMode || 'auto',
    maxConsecutiveFailures: args?.maxConsecutiveFailures ?? options.maxConsecutiveFailures,
    maxRetries: args?.maxRetries || run.maxRetries,
    retryBaseDelayMs: args?.retryBaseDelayMs,
    escalateRetry: args?.escalateRetry,
    maxTokensPerRun,
    onEvent: args?.onEvent,
  };
  const result = run.mode === 'outlines'
    ? await batchGenerateOutlines(base, ctx)
    : await batchGenerateBodies({
      ...base,
      reviewMode: args?.reviewMode ?? options.reviewMode,
      maxTokensPerChapter: args?.maxTokensPerChapter ?? options.maxTokensPerChapter,
    }, ctx);
  return { ...result, resumed: true, fromChapter: point.fromChapter, reopened };
}

async function saveArcPlan({ bookId, messageId }) {
  const plan = await runSmart({
    bookId, messageId, promptKey: 'arc_plan', saveName: `剧情规划_${uid().slice(0, 4)}.md`,
    userText: pk.prompts().arc_force_deliver + '\n请给出下一段章节规划。',
  });
  run(`UPDATE messages SET result_json=?, updated_at=? WHERE id=?`, JSON.stringify(plan.parsed ?? plan.text), now(), messageId);
  return { ok: true, arcPlan: plan.parsed ?? plan.text };
}
async function genSceneBody(args, ctx) {
  const { onEvent: ch, requestId, bookId, chapterTitle, chapterBrief, sceneJson, sceneIndex, sceneCount, messageId } = args;
  const channel = typeof ch === 'string' ? ch.replace(/^__CHANNEL__:/, '') : ch && ch.id != null ? String(ch.id) : null;
  const send = (o) => ctx.send(JSON.stringify({ ch: channel, e: o }) + '\n');
  const chn = llm.activeChannel();
  if (!chn || !chn.baseUrl) throw new Error('未配置模型渠道');
  const p = pk.prompts();
  const book = one(`SELECT * FROM books WHERE id=?`, bookId);
  const style = core.getBookStyle({ bookId });
  const plan = core.getBookPlanSettings({ bookId });
  const sys = [p.system ? String(p.system).trim() : '', pk.genreCard(book ? book.genre : '', formFor(book)), bookPlanPrompt(bookId), pk.styleCardText(style), pk.antiAiTone(false), String(p.scene_body || ''), longform.bookStoryContext(bookId)].filter(Boolean).join('\n\n');
  const sceneTarget = plan.chapterWords && sceneCount ? Math.max(300, Math.round(plan.chapterWords / Number(sceneCount || 1))) : 0;
  const lengthText = sceneTarget ? `【场景篇幅】本场景目标约 ${sceneTarget} 字；全章约 ${plan.chapterWords} 字。` : '';
  const user = `【章节】${chapterTitle || ''}\n【章节摘要】${chapterBrief || ''}\n${lengthText}\n【场景 ${sceneIndex ?? 1}/${sceneCount ?? 1}】\n${String(sceneJson || '')}`;
  let full = '';
  send({ type: 'progress', chars: 0 });
  try {
    for await (const ev of llm.chatCompletion({ baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model || 'deepseek-chat', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens: 6000 })) {
      if (ev.type === 'delta') { full += ev.text; send({ type: 'delta', text: ev.text }); }
    }
    send({ type: 'done', full, messageId: messageId || null });
  } catch (e) {
    send({ type: 'error', message: e.message });
    throw e;
  }
  return { ok: true };
}

function assembleSceneDoc({ bookId, messageId }) {
  const msg = one(`SELECT * FROM messages WHERE id=?`, messageId);
  const sessionId = msg ? msg.session_id : null;
  let content = msg ? (msg.content || '') : '';
  if (sessionId) {
    const scenes = q(`SELECT * FROM messages WHERE session_id=? AND role='scene' ORDER BY created_at`, sessionId);
    content = scenes.map((s) => `\n\n--- 场景 ---\n${s.content || ''}`).join('');
  }
  const name = `场景_${uid().slice(0, 4)}.md`;
  if (bookId) {
    core.writeFileTo({ bookId, group: '正文', name, content });
    if (msg) run(`UPDATE messages SET content=?, updated_at=? WHERE id=?`, name, now(), messageId);
  }
  return { ok: true, content: content.trim(), fileName: name || null };
}

// ---------- 导入导出 ----------
function extractZipFiles(buf) {
  return parseZip(buf);
}

function importBookZip({ path: p, files, data }) {
  let buf = null;
  if (p) {
    const safePath = resolveAllowedPath(p, { mode: 'read', label: '导入文件' });
    if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) throw new Error('导入文件不存在');
    buf = fs.readFileSync(safePath);
  } else if (data) buf = Buffer.from(data, 'base64');
  else if (files && files.length) {
    // 前端直传：files [{name, content}]
    const bk = core.importBook({ title: '导入书籍', files });
    return { bookId: bk.bookId, imported: files.length };
  }
  if (!buf) throw new Error('未提供导入文件');
  const list = extractZipFiles(buf);
  const docs = list.filter((f) => /\.(md|txt)$/i.test(f.name));
  const title = path.basename((list[0] || {}).name || '', path.extname((list[0] || {}).name || ''));
  const bk = core.importBook({ title: title || '导入书籍', files: docs.map((f) => ({ name: f.name, content: f.data.toString('utf-8') })) });
  return { bookId: bk.bookId, imported: docs.length };
}

function exportBookZip({ bookId, destPath }) {
  const files = [];
  for (const g of core.scanTree({ bookId })) {
    for (const f of g.files) {
      const content = core.readFileFrom({ bookId, group: g.groupDir, name: f.name });
      files.push({ name: `${g.groupDir}/${f.name}`, data: Buffer.from(content || '', 'utf-8') });
    }
  }
  const zip = makeZip(files);
  const p = resolveAllowedPath(destPath || path.join(DATA_DIR, 'exports', `book_${String(bookId || 'book').slice(0, 8)}.zip`), { mode: 'write', label: '导出路径' });
  atomicWriteFileSync(p, zip);
  return { path: p, fileCount: files.length };
}

function sanitizeConfigValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeConfigValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(apiKey|api_key|token|authorization)$/i.test(key)) out[key] = '***';
    else if (key === 'key' && typeof item === 'string') out[key] = '***';
    else out[key] = sanitizeConfigValue(item);
  }
  return out;
}

function sanitizeConfigText(content) {
  try {
    return JSON.stringify(sanitizeConfigValue(JSON.parse(String(content || '{}'))), null, 2);
  } catch (e) {
    return content;
  }
}

function exportAllData({ destPath }) {
  try { exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
  const files = [];
  const os = require('node:os');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-backup-'));
  const outputPath = resolveAllowedPath(destPath || path.join(DATA_DIR, 'exports', 'fabula_backup.zip'), { mode: 'write', label: '备份路径' });
  try {
    if (fs.existsSync(DB_PATH)) {
      const tempDb = path.join(tempDir, 'fabula.db');
      fs.copyFileSync(DB_PATH, tempDb);
      const { DatabaseSync } = require('node:sqlite');
      const copy = new DatabaseSync(tempDb);
      copy.prepare("UPDATE settings SET value='***' WHERE key LIKE 'channel_key__%'").run();
      copy.close();
      files.push({ name: 'fabula.db', data: fs.readFileSync(tempDb) });
    }
    for (const name of ['prompts.defaults.json', 'sources.json', 'sensitive_words.txt', 'config.json']) {
      const fp = path.join(DATA_DIR, name);
      if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) continue;
      const data = name === 'config.json' ? sanitizeConfigText(fs.readFileSync(fp, 'utf-8')) : fs.readFileSync(fp);
      files.push({ name, data });
    }
    const rootConfig = path.join(__dirname, '..', 'config.json');
    if (!files.some((f) => f.name === 'config.json') && fs.existsSync(rootConfig)) {
      files.push({ name: 'config.json', data: sanitizeConfigText(fs.readFileSync(rootConfig, 'utf-8')) });
    }
    const addFolder = (folder, prefix) => {
      const walk = (abs, rel) => {
        if (!fs.existsSync(abs)) return;
        for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
          const fp = path.join(abs, entry.name);
          const nextRel = `${rel}/${entry.name}`;
          if (entry.isDirectory()) walk(fp, nextRel);
          else if (entry.isFile() && path.resolve(fp) !== path.resolve(outputPath)) files.push({ name: nextRel, data: fs.readFileSync(fp) });
        }
      };
      walk(path.join(DATA_DIR, folder), prefix);
    };
    addFolder('books', 'books');
    addFolder('versions', 'versions');
    addFolder('trash', 'trash');
    addFolder('asset_updates', 'asset_updates');
    addFolder('exports', 'exports');
    const zip = makeZip(files);
    atomicWriteFileSync(outputPath, zip);
    return { path: outputPath, fileCount: files.length };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function exportSkillMd({ id, destPath }) {
  const s = readSkillRef({ id });
  if (!s) throw new Error('技能不存在');
  const md = `# ${s.name}\n\n${s.description || ''}\n\n## 模板\n\n\`\`\`text\n${s.promptTemplate || ''}\n\`\`\`\n`;
  const p = resolveAllowedPath(destPath || path.join(DATA_DIR, 'exports', `${safeFileName(s.name, 'skill')}.md`), { mode: 'write', label: '技能导出路径' });
  atomicWriteFileSync(p, md, { encoding: 'utf-8' });
  return { path: p };
}
function exportSkillBundle({ id, destPath }) {
  const s = readSkillRef({ id });
  if (!s) throw new Error('技能不存在');
  const bundle = JSON.stringify({ kind: 'fabula-skill-bundle', version: 1, skills: [s] }, null, 2);
  const p = resolveAllowedPath(destPath || path.join(DATA_DIR, 'exports', `skill_${String(id || 'skill').slice(0, 8)}.json`), { mode: 'write', label: '技能导出路径' });
  atomicWriteFileSync(p, bundle, { encoding: 'utf-8' });
  return { path: p };
}
function inspectSkillBundle({ id, path: p, content }) {
  let j;
  try {
    const source = content != null ? String(content) : fs.readFileSync(resolveAllowedPath(p || id, { mode: 'read', label: '技能包路径' }), 'utf-8');
    j = JSON.parse(source);
  } catch (e) { throw new Error('不是有效的技能包 JSON'); }
  if (!j.skills && !j.prompt_template) throw new Error('技能包结构中缺少 skills');
  return { valid: true, skills: j.skills || [{ ...j, id: undefined }], kind: j.kind || 'fabula-skill-bundle' };
}
function installSkillBundle({ id, path: p, content }) {
  const info = inspectSkillBundle({ id, path: p, content });
  let n = 0;
  for (const s of info.skills) {
    if (!s || !s.name) continue;
    createSkill({
      name: s.name,
      description: s.description || '',
      promptTemplate: s.promptTemplate || s.prompt_template || '',
      kind: s.kind || 'imported',
      usageMode: s.usageMode || 'standalone',
      origin: 'imported',
      targets: s.targets || [],
      capabilities: s.capabilities || null,
    });
    n++;
  }
  return { ok: true, added: n };
}
function reportOnlineSkillDownload() { return { ok: true }; }

function readImportFolder({ path: folder } = {}) {
  if (!folder) return [];
  const root = resolveAllowedPath(folder, { mode: 'read', label: '导入目录' });
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const out = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(fp, rel);
      else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
        out.push({ name: rel, content: fs.readFileSync(fp, 'utf-8') });
      }
    }
  };
  walk(root);
  return out;
}

// ---------- 文件夹操作（用户自定义目录；未注册前默认返回 null 曾导致前端 .filter 崩溃） ----------
function renameFolder({ bookId, from, to }) {
  if (!bookId || !from || !to) return { ok: true };
  try {
    const base = path.join(DATA_DIR, 'books', safeDirName(bookId));
    const fromDir = path.join(base, safeDirName(from));
    const toDir = path.join(base, safeDirName(to));
    if (fs.existsSync(fromDir) && !fs.existsSync(toDir)) fs.renameSync(fromDir, toDir);
  } catch (e) {}
  return { ok: true };
}
function deleteFolder({ bookId, name }) {
  if (!bookId || !name) return '';
  // 文件夹删除 = 其中所有文件逐个进文件级回收站（内容可恢复）
  try {
    const base = path.join(DATA_DIR, 'books', safeDirName(bookId), safeDirName(name));
    if (fs.existsSync(base)) {
      for (const f of fs.readdirSync(base)) {
        const fp = path.join(base, f);
        if (fs.statSync(fp).isFile()) {
          const tid = crypto.randomUUID();
          const meta = { id: tid, kind: 'file', bookId, group: name, name: f, deletedAt: Date.now(), content: fs.readFileSync(fp, 'utf-8') };
          const out = path.join(DATA_DIR, 'trash', safeDirName(bookId), tid + '.json');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(out, JSON.stringify(meta), 'utf-8');
        }
      }
    }
    fs.rmSync(base, { recursive: true, force: true });
  } catch (e) {}
  return name; // 撤销入口（restore_trash 需 id，但前端仅 toast 撤销；真实还原走回收站视图）
}
function safeDirName(n) { return String(n || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'); }

function assetUpdateFiles(bookId) {
  const dir = path.join(ASSET_UPDATES_DIR, safeDirName(bookId));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name));
}

function inferAssetChapter(bookId, messageId, ...texts) {
  for (const text of texts) {
    const n = chapterNumberFromName(text);
    if (n) return n;
  }
  if (messageId) {
    const msg = one(`SELECT content, context_json FROM messages WHERE id=?`, messageId);
    if (msg) {
      const n = chapterNumberFromName(msg.content) || chapterNumberFromName(msg.context_json);
      if (n) return n;
    }
  }
  return 0;
}

function chapterAssetFootprint({ bookId, chapterNum }) {
  const n = Number(chapterNum) || 0;
  if (!bookId || !n) return [];
  return assetUpdateFiles(bookId).map((fp) => {
    try {
      const record = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (Number(record.chapterNum) !== n) return null;
      return { file: record.name, entry: record.replaceSection || record.name, action: '可回滚到应用前版本' };
    } catch (e) { return null; }
  }).filter(Boolean);
}

function rollbackChapterAssets({ bookId, chapterNum }) {
  const n = Number(chapterNum) || 0;
  if (!bookId || !n) return { ok: false, restored: 0 };
  let restored = 0;
  const records = assetUpdateFiles(bookId).map((fp) => {
    try { return { fp, record: JSON.parse(fs.readFileSync(fp, 'utf-8')) }; } catch (e) { return null; }
  }).filter(Boolean).sort((a, b) => Number(b.record.appliedAt || 0) - Number(a.record.appliedAt || 0));
  for (const { fp, record } of records) {
    try {
      if (Number(record.chapterNum) !== n) continue;
      core.writeFileTo({ bookId, group: record.group || '设定', name: record.name, content: String(record.before ?? '') });
      fs.unlinkSync(fp);
      restored++;
    } catch (e) {}
  }
  return { ok: restored > 0, restored };
}

// 应用资产提议（设定更新）：targetName 在书目录里找到即回写内容，返回前端期望的 JSON 字符串
function applyAssetUpdate({ bookId, targetName, content, messageId, proposalId, replaceSection }) {
  const t = String(targetName || '');
  const c = String(content || '');
  if (bookId && t && c) {
    // 目标组判定：同名文件先按名字归属（正文 > 细纲 > 设定 > 参考），避免重复文件跨组误写
    let group = '设定';
    const tree = core.scanTree({ bookId });
    const order = { 正文: 0, 细纲: 1, 设定: 2, 参考: 3 };
    let best = null;
    for (const g of tree) {
      if (best != null && (order[g.groupDir] ?? 9) >= (order[best] ?? 9)) continue;
      if (g.files.some((f) => f.name === t)) best = g.groupDir;
    }
    if (best != null) group = best;
    const targetFile = tree.find((g) => g.groupDir === group)?.files.find((f) => f.name === t);
    if (targetFile?.locked) {
      return JSON.stringify({ ok: false, error: '目标文件已锁定，拒绝 AI 改写', targetName: t, messageId: messageId || null });
    }
    const previous = core.readFileFrom({ bookId, group, name: t }) || '';
    let next = c;
    const section = String(replaceSection || '').replace(/^#+\s*/, '').trim();
    if (section) {
      const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`^##+\\s*${escaped}[^\\n]*\\n[\\s\\S]*?(?=^##+\\s|(?![\\s\\S]))`, 'm');
      next = re.test(previous) ? previous.replace(re, c.trimEnd() + '\n\n') : `${previous.trimEnd()}\n\n${c}`.trim() + '\n';
    }
    core.writeFileTo({ bookId, group, name: t, content: next });
    try {
      const chapterNum = inferAssetChapter(bookId, messageId, replaceSection, c, t);
      if (chapterNum) {
        const dir = path.join(ASSET_UPDATES_DIR, safeDirName(bookId));
        fs.mkdirSync(dir, { recursive: true });
        const record = {
          id: crypto.randomUUID(), bookId, chapterNum, group, name: t,
          before: previous, after: next, replaceSection: section || '', messageId: messageId || null,
          proposalId: proposalId || null, appliedAt: Date.now(),
        };
        fs.writeFileSync(path.join(dir, `${record.appliedAt}-${record.id}.json`), JSON.stringify(record), 'utf-8');
      }
    } catch (e) {}
  }
  return JSON.stringify({
    ok: true, applied: true, proposalId: proposalId || null,
    targetName: t, messageId: messageId || null, appliedAt: Date.now(),
  });
}

async function regenArcChapter({ bookId, chapterN, instruction }) {
  const chn = llm.activeChannel();
  if (!chn || !chn.baseUrl) throw new Error('未配置模型渠道');
  const book = one(`SELECT * FROM books WHERE id=?`, bookId);
  if (!book) throw new Error('作品不存在');
  const n = Number(chapterN) || 1;
  const p = pk.prompts();
  const context = bookContextForOutline(bookId, n, null, 16000);
  const plan = chapterPlanEntryText(bookId, n);
  const sys = [
    p.system ? String(p.system).trim() : '',
    generationContext(bookId, book, core.getBookStyle({ bookId }), 'plot'),
    String(p.arc_plan || ''),
    String(p.arc_force_deliver || ''),
    '【任务】只重推演指定章节的走向，不写正文、不追问。只输出 JSON：{"n":章号,"title":"章节标题","summary":"2~4句走向级梗概"}。',
  ].filter(Boolean).join('\n\n');
  const raw = await llm.chatOnce({
    baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model || core.getSettings().default_model || 'deepseek-chat',
    messages: [{ role: 'system', content: sys }, { role: 'user', content: [
      `重推演第${n}章。`,
      plan ? `【原章节规划】\n${plan}` : '',
      instruction ? `【作者要求】${instruction}` : '',
      context ? `【本书上下文】\n${context}` : '',
    ].filter(Boolean).join('\n\n') }],
    temperature: 0.65, maxTokens: 4096,
  });
  const parsed = llm.extractJson(raw);
  if (!parsed || !String(parsed.title || '').trim() || !String(parsed.summary || '').trim()) {
    throw new Error('章节重推演没有返回有效结果');
  }
  return JSON.stringify({ n, title: String(parsed.title).trim(), summary: String(parsed.summary).trim() });
}

async function evaluateDirectModel({ caseId, reasoningMode }) {
  const chn = llm.activeChannel();
  if (!chn || !chn.baseUrl) throw new Error('未配置模型渠道');
  const started = Date.now();
  let ttftMs = 0;
  let output = '';
  let reasoning = '';
  for await (const ev of llm.chatCompletion({
    baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model || core.getSettings().default_model || 'deepseek-chat',
    messages: [{ role: 'user', content: '用一句话说明你已准备好进行小说写作评测。' }],
    stream: true, maxTokens: 256, noThinking: reasoningMode === 'fast' || chn.noThinking,
  })) {
    if (ev.type === 'reasoning') reasoning += ev.text;
    if (ev.type === 'delta') {
      if (!ttftMs) ttftMs = Date.now() - started;
      output += ev.text;
    }
  }
  return {
    caseId: caseId || 'direct-' + Date.now().toString(36),
    reasoningMode: reasoningMode || 'auto',
    resolvedMode: reasoning ? 'on' : 'off',
    ttftMs: ttftMs || (Date.now() - started),
    totalMs: Date.now() - started,
    reasoningChars: reasoning.length,
    outputChars: output.length,
    output: output.trim() || '模型已连接',
  };
}

// 导入技能包（.md 单文件）：读出内容作为 inspection
function inspectSkillMd({ path: p, content }) {
  if (content == null && (!p || !fs.existsSync(p))) return { name: '', description: '', instructions: '' };
  const text = content != null ? String(content) : fs.readFileSync(p, 'utf-8');
  return { name: path.basename(p, path.extname(p)), description: '', instructions: text };
}

// ---------- 导入通读分析（事件流：step/done/error） ----------
// LLM JSON 输出 -> 可读 markdown（不把原始 JSON 落盘到用户文件）
function unwrapImportJson(text) {
  const s = String(text || '').trim();
  if (!s.startsWith('{')) return s;
  try {
    const j = JSON.parse(s);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return s;
    if (Array.isArray(j.chapters)) {
      return '# 导入分析 · 章节摘要\n\n' + j.chapters.map((c) => `## ${c.title || '章节'}\n${c.summary || ''}`).join('\n\n');
    }
    if (j.worldview || j.synopsis || j.characters) {
      const parts = ['# 导入分析 · 设定资料'];
      if (j.genre) parts.push(`**题材**：${j.genre}\n`);
      if (j.worldview) parts.push(String(j.worldview).trim() + '\n');
      if (Array.isArray(j.characters) && j.characters.length) {
        parts.push('## 人物');
        for (const c of j.characters) {
          parts.push(`### ${c.name || '无名'}\n- 身份：${c.identity || ''}\n- 性格：${c.personality || ''}\n- 目标：${c.goal || ''}\n- 关系：${c.relation || ''}`);
        }
        parts.push('');
      }
      if (j.synopsis) parts.push(String(j.synopsis).trim() + '\n');
      return parts.join('\n\n');
    }
  } catch (e) {}
  return s;
}

function analyzeChannel(ch) {
  if (ch == null) return null;
  if (typeof ch === 'string') return ch.replace(/^__CHANNEL__:/, '');
  return ch.id != null ? String(ch.id) : null;
}

async function importAnalyze(args, ctx) {
  const { onEvent: ch, bookId } = args;
  const channel = analyzeChannel(ch);
  if (channel == null) throw new Error('缺少事件通道');
  const send = (obj) => ctx.send(JSON.stringify({ ch: channel, e: obj }) + '\n');
  const step = (index, title) => send({ type: 'step', index, title });
  if (!bookId) { send({ type: 'error', message: '缺少 bookId' }); return { ok: true }; }
  const book = one(`SELECT title FROM books WHERE id=?`, bookId);
  const tree = core.scanTree({ bookId });
  const docs = [];
  for (const g of tree) {
    if (g.groupDir !== '正文' && g.groupDir !== '参考') continue;
    for (const f of g.files) {
      const content = core.readFileFrom({ bookId, group: g.groupDir, name: f.name }) || '';
      if (content.trim()) docs.push({ name: f.name, content });
    }
  }
  if (!docs.length) { send({ type: 'error', message: '该书正文/参考目录里没有可分析的导入内容' }); return { ok: true }; }
  const p = pk.prompts();
  const chn = llm.activeChannel();
  const useLlm = !!(chn && chn.baseUrl && chn.key);
  let fullText = docs.map((d) => `## 章节标题：${d.name}\n${d.content}`).join('\n\n');
  if (fullText.length > 48000) fullText = fullText.slice(0, 48000) + '\n（后续内容过长已截断）';
  const chatOnce = (sys, user, maxTokens = 3000) => llm.chatOnce({
    baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], maxTokens,
  });

  // 1 通读全书（分段提取）
  step(1, '通读全书 · 第 1/1 段');
  const maps = [];
  if (useLlm) {
    const n = Math.max(1, Math.ceil(fullText.length / 12000));
    for (let k = 0; k < n; k++) {
      const seg = fullText.slice(k * 12000, (k + 1) * 12000);
      if (!seg.trim()) continue;
      try { maps.push(String(await chatOnce(String(p.import_map || ''), seg, 2048))); } catch (e) { maps.push(''); }
    }
  }
  // 2 汇总重建设定（世界观 / 人物 / 大纲）
  step(2, '汇总重建设定（世界观 / 人物 / 大纲）');
  let settingDoc = '';
  if (useLlm && maps.some(Boolean)) {
    try { settingDoc = String(await chatOnce(String(p.import_reduce || ''), maps.filter(Boolean).join('\n\n').slice(0, 24000), 3000)); } catch (e) { settingDoc = ''; }
  }
  if (settingDoc) core.writeFileTo({ bookId, group: '设定', name: '导入分析_设定.md', content: unwrapImportJson(settingDoc) });
  // 3 整理章节摘要
  step(3, '整理章节摘要');
  let summaryDoc = '';
  if (useLlm) {
    try { summaryDoc = String(await chatOnce(String(p.import_summary || ''), fullText.slice(0, 24000), 3000)); } catch (e) { summaryDoc = ''; }
  }
  if (summaryDoc) core.writeFileTo({ bookId, group: '细纲', name: '导入分析_章节摘要.md', content: unwrapImportJson(summaryDoc) });
  // 4 蒸馏原作风格
  step(4, '蒸馏原作风格');
  let styleText = '';
  if (useLlm) {
    try {
      styleText = String(await chatOnce('你是资深网文编辑与文体分析师。',
        `题目《${(book && book.title) || '导入小说'}》\n\n${String(p.distill || '')}\n\n【文本】\n${fullText.slice(0, 24000)}`, 3000));
    } catch (e) { styleText = ''; }
  }
  if (styleText) {
    const t = ((book && book.title) || '').trim();
    const base = (t && t !== '未命名新书') ? t
      : (docs[0] && docs[0].name || '导入小说').replace(/\.(md|txt)$/i, '').replace(/[_\-—：:].*第[0-9一二三四五六七八九十百]+章.*$/i, '').replace(/[_\-—：:].*$/, '');
    ai.saveStyleCard(`《${base}》原作风格`, base, styleText);
  }
  run(`INSERT INTO settings(key,value) VALUES(?,'1') ON CONFLICT(key) DO UPDATE SET value='1'`, `import_analyzed__${bookId}`);
  send({ type: 'done', full: '' });
  return { ok: true };
}

function pendingImports({ bookId } = {}) {
  if (!bookId) return false;
  try {
    const mark = one(`SELECT value FROM settings WHERE key=?`, `import_analyzed__${bookId}`);
    if (mark && mark.value === '1') return false;
    const tree = core.scanTree({ bookId });
    const files = (tree.find((g) => g.groupDir === '正文') || { files: [] }).files
      .concat((tree.find((g) => g.groupDir === '参考') || { files: [] }).files);
    return files.length > 0;
  } catch (e) { return false; }
}
function pendingDecompose() { return { text: '' }; }

// ---------- 在线服务：优雅降级 ----------
const OFFLINE = '离线复刻版不支持该在线功能（账号/支付/广场/云同步），请使用本地功能。';
function accountStatus() {
  // 离线复刻：假装是已登录的本地账号，隐藏登录/注册入口（不连官方任何服务）
  return { loggedIn: true, profile: { nickname: '本地版', email: 'local@fabula.local', avatarUrl: '' }, local: true };
}
function accountLogout() { return { ok: true }; }
function offlineErr() { const e = new Error(OFFLINE); e.message = OFFLINE; throw e; }
function tryLogin() { offlineErr(); }
function plazaList() { return { items: [], isEnd: true }; }
function plazaDetail() { return { item: null }; }
function plazaList2() { return { items: [] }; }
function llmCatalog() {
  // 内置模型目录反代：离线版的"内置模型" = 你自有渠道的模型清单。
  // 优先读缓存（渠道变更时由 purge/渠道写入方失效），否则实时聚合所有渠道 models。
  try {
    const k = one(`SELECT value FROM settings WHERE key='llm_catalog_cache'`);
    const j = JSON.parse(k && k.value ? k.value : '{}');
    if (Array.isArray(j.models) && j.models.length) {
      return { models: j.models, premium: [], enabled: true, rolloutMode: 'public' };
    }
  } catch (e) {}
  const models = new Set();
  try {
    const rows = JSON.parse((one(`SELECT value FROM settings WHERE key='channels'`) || { value: '[]' }).value || '[]');
    for (const c of rows) {
      if (Array.isArray(c.models)) for (const m of c.models) if (m) models.add(m);
      else if (c.model) models.add(c.model);
    }
  } catch (e) {}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '..', 'config.json'), 'utf-8'));
    for (const c of cfg.channels || []) {
      if (Array.isArray(c.models)) for (const m of c.models) if (m) models.add(m);
      else if (c.model) models.add(c.model);
    }
  } catch (e) {}
  const list = [...models].filter(Boolean);
  return { models: list, premium: [], enabled: list.length > 0, rolloutMode: 'public' };
}
function licenseStatus() {
  return { state: 'active', trialDaysLeft: 0, licensee: '', expiresAt: 0, sku: '', betaUntil: 0, purchaseUrl: '', codeRevokedNote: '' };
}
function checkFeature({ feature }) {
  const cloudish = ['sync', 'cloud', 'account', 'payment', 'plaza', 'updater', 'llm_balance', 'llm_usage', 'llm_orders', 'workshop_online'];
  if (cloudish.includes(feature)) { const e = new Error('该功能在离线复刻版中不可用'); e.message = e.message; throw e; }
  return null;
}
function dataDir() { return DATA_DIR; }
function dataDirInfo() { return { current: DATA_DIR, pending: null }; }
function changeDataDir({ newDir }) {
  if (!newDir) throw new Error('请选择新的数据目录');
  const target = path.resolve(String(newDir));
  if (target === DATA_DIR) return { ok: true, current: DATA_DIR, note: '目录未变化' };
  const insideCurrent = !path.relative(DATA_DIR, target).startsWith('..');
  const containsCurrent = !path.relative(target, DATA_DIR).startsWith('..');
  if (insideCurrent || containsCurrent) throw new Error('新数据目录不能与当前数据目录互相包含');
  fs.mkdirSync(target, { recursive: true });
  try { exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
  fs.cpSync(DATA_DIR, target, { recursive: true, force: false, errorOnExist: false });
  fs.mkdirSync(BASE_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(BASE_DATA_DIR, '.data_dir'), target, 'utf-8');
  const s = one(`SELECT value FROM settings WHERE key='replica_data_dir'`);
  run(`INSERT INTO settings(key,value) VALUES('replica_data_dir',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, newDir);
  return { ok: true, current: target, note: '已复制数据，重启后生效' };
}

// ---------- 插件桩 ----------
function pluginStub(name, args) {
  switch (name) {
    case 'plugin:app|app_os': return 'win32';
    case 'plugin:app|name': return 'Fabula';
    case 'plugin:app|version': return '1.0.3';
    case 'plugin:app|tauri_version': return '2.11.3';
    case 'plugin:app|identifier': return 'com.fabula.app';
    case 'plugin:app|set_app_theme': case 'plugin:app|app_hide': case 'plugin:app|app_show': case 'plugin:app|set_dock_visibility':
    case 'plugin:event|emit': case 'plugin:event|emit_to': case 'plugin:event|listen': case 'plugin:event|unlisten':
    case 'plugin:event|register_listener': case 'plugin:event|registerListener': case 'plugin:event|remove_listener':
    case 'plugin:process|restart': case 'plugin:resources|close':
      return null;
    case 'plugin:dialog|open': case 'plugin:dialog|save': return null;
    case 'plugin:window|theme': return 'light';
    case 'plugin:window|title': return 'Fabula';
    case 'plugin:window|inner_size': case 'plugin:window|outer_size': return { width: 1280, height: 800 };
    case 'plugin:window|inner_position': case 'plugin:window|outer_position': return { x: 0, y: 0 };
    case 'plugin:window|scale_factor': return 1;
    case 'plugin:window|is_maximized': case 'plugin:window|is_focused': case 'plugin:window|is_visible':
    case 'plugin:window|is_resizable': case 'plugin:window|is_closable': case 'plugin:window|is_minimizable':
    case 'plugin:window|is_maximizable': case 'plugin:window|is_decorated': case 'plugin:window|is_enabled':
    case 'plugin:window|is_fullscreen': case 'plugin:window|is_minimized': case 'plugin:window|is_always_on_top':
      return true;
    case 'plugin:window|set_title': case 'plugin:window|set_size': case 'plugin:window|set_position':
    case 'plugin:window|set_min_size': case 'plugin:window|set_max_size': case 'plugin:window|set_theme':
    case 'plugin:window|set_icon': case 'plugin:window|set_title_bar_style': case 'plugin:window|start_dragging':
    case 'plugin:window|set_decorations': case 'plugin:window|set_shadow': case 'plugin:window|set_effects':
    case 'plugin:window|set_ignore_cursor_events': case 'plugin:window|set_cursor_visible':
    case 'plugin:window|set_cursor_icon': case 'plugin:window|set_cursor_position':
    case 'plugin:window|set_cursor_grab': case 'plugin:window|set_cursor_position': case 'plugin:window|set_badge_count':
    case 'plugin:window|set_badge_label': case 'plugin:window|set_visible_on_all_workspaces':
    case 'plugin:window|set_skip_taskbar': case 'plugin:window|set_closable': case 'plugin:window|set_always_on_top':
    case 'plugin:window|set_always_on_bottom': case 'plugin:window|set_minimizable': case 'plugin:window|set_maximizable':
    case 'plugin:window|set_resizable': case 'plugin:window|set_focusable': case 'plugin:window|set_enabled':
    case 'plugin:window|set_content_protected': case 'plugin:window|set_focus': case 'plugin:window|show':
    case 'plugin:window|hide': case 'plugin:window|minimize': case 'plugin:window|maximize': case 'plugin:window|unmaximize':
    case 'plugin:window|toggle_maximize': case 'plugin:window|close': case 'plugin:window|destroy':
    case 'plugin:window|center': case 'plugin:window|set_focus': case 'plugin:window|set_progress_bar':
    case 'plugin:window|start_resize_dragging': case 'plugin:window|request_user_attention':
    case 'plugin:window|set_badge_count': case 'plugin:window|set_size_constraints':
      return null;
    case 'plugin:window|get_all_windows': return [{ label: 'main' }];
    case 'plugin:image|new': return { width: 1, height: 1 };
    case 'plugin:image|size': case 'plugin:image|rgba': return { width: 1, height: 1 };
    case 'plugin:image|from_bytes': case 'plugin:image|from_path': return { width: 1, height: 1 };
    case 'plugin:updater|check': return null;
    case 'plugin:updater|download': case 'plugin:updater|install': case 'plugin:updater|download_and_install':
      { const e = new Error('离线复刻版无更新通道'); throw e; }
    default: return null;
  }
}

module.exports = {
  listSkills, createSkill, updateSkill, deleteSkill, setSkillEnabled, readSkillRef, writeSkillRef,
  readSkillScript, setSkillScriptAuthorization, testRunSkillScript, testRunDraftScript, saveCapabilityDoc, createSkillFromDraft, saveDecomposeAsSkill,
  genChapterOutline, batchGenerateOutlines, batchGenerateBodies, batchGenerateFull, cancelBatch, saveArcPlan, genSceneBody, assembleSceneDoc,
  generationRunStatus, resumeGenerationRun, runConsistencyAudit,
  getWorldRules, saveWorldRule, deleteWorldRule, getCanonEvents, saveCanonEvent, deleteCanonEvent,
  repairAfterBodySave,
  importBookZip, exportBookZip, exportAllData, exportSkillMd, exportSkillBundle, inspectSkillBundle,
  installSkillBundle, reportOnlineSkillDownload, readImportFolder, importAnalyze, pendingImports, pendingDecompose,
  renameFolder, deleteFolder, chapterAssetFootprint, rollbackChapterAssets, applyAssetUpdate, regenArcChapter, evaluateDirectModel, inspectSkillMd,
  accountStatus, accountLogout, offlineErr, plazaList, plazaDetail, llmCatalog, licenseStatus, checkFeature,
  dataDir, dataDirInfo, changeDataDir, pluginStub, extractZipFiles,
  __test: {
    parseChapterPlanMarkdown, parseChapterSummaryMarkdown, replaceChapterPlanRows,
    ensureChapterPlansImported, chapterPlanRange, chapterPlanEntries, upsertChapterPlanEntries,
    materializeChapterPlan, ensureChapterSummariesImported, replaceChapterSummaryRows,
    materializeChapterSummaries, recentChapterSummaries, upsertChapterSummary,
    bookContextForOutline, chapterFileIndexes, normalizeOutline, yieldBatch,
    repairChapterMemory, existingBodyLooksUsable, shouldSkipExistingBody, bodyCharCount,
    composePromptSections, composeOutlinePromptContext, composeBodyPromptContext,
    composeChapterSummaryContent, composeContinuationMessages, continuationAnchorText,
    BODY_PROMPT_CONTEXT_CHARS, OUTLINE_PROMPT_CONTEXT_CHARS,
    CONTINUATION_ANCHOR_CHARS, CHAPTER_SUMMARY_CHARS,
  },
};
