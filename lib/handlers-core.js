// 核心业务命令：设置 / 书 / 会话 / 消息 / 文件树 / 版本 / 回收站 / 字数统计。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dbmod = require('./db');
const { q, one, run, transaction, DATA_DIR } = dbmod;
const { atomicWriteFileSync, assertInside, isInside, safeFileName } = require('./fs-safe');

const BOOKS_DIR = path.join(DATA_DIR, 'books');
const VERSIONS_DIR = path.join(DATA_DIR, 'versions');
const TRASH_DIR = path.join(DATA_DIR, 'trash');
const MAX_VERSION_SNAPSHOTS = 50;
const bodyWordTotals = new Map();

// 分组定义（与前端 Jv 树一致）
const GROUPS = [
  { key: 'settings', label: '设定资料', groupDir: '设定', icon: 'green' },
  { key: 'outline', label: '章节细纲', groupDir: '细纲', icon: 'amber' },
  { key: 'chapters', label: '小说正文', groupDir: '正文', icon: 'gray' },
  { key: 'reference', label: '参考拆解', groupDir: '参考', icon: 'muted' },
];

function ensureBookDir(bookId) {
  const base = path.join(BOOKS_DIR, safeName(bookId));
  for (const g of GROUPS) fs.mkdirSync(path.join(base, g.groupDir), { recursive: true });
  fs.mkdirSync(TRASH_DIR, { recursive: true });
  return base;
}
function safeName(n) {
  return safeFileName(n, 'untitled');
}
function bookBase(bookId, group, name) {
  const g = GROUPS.find((x) => x.groupDir === group || x.key === group) || GROUPS.find((x) => x.groupDir === group);
  const gd = g ? g.groupDir : '设定';
  return assertInside(BOOKS_DIR, path.join(BOOKS_DIR, safeName(bookId), gd, safeName(name)), '书稿路径');
}

function now() { return Date.now(); }
function uid() { return crypto.randomUUID(); }
function localDateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function rowBook(r) {
  if (!r) return null;
  return {
    id: r.id, title: r.title, genre: r.genre || '', pov: r.pov || '', status: r.status || '',
    coverChar: r.cover_char || '', wordCount: r.word_count || 0, chapterCount: r.chapter_count || 0,
    createdAt: r.created_at || 0, updatedAt: r.updated_at || 0,
  };
}

// ---------- 设置 ----------
// 渠道条目标准化：前端依赖 models/modelLabels 等字段
function normalizeChannelsJson(raw) {
  try {
    if (!raw) return '[]';
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return '[]';
    const out = arr
      .filter((c) => c.id !== 'ch_builtin_free' && !(c && c.builtin && c.providerId === 'builtin'))
      .map((c) => ({
        ...c,
        models: Array.isArray(c.models) ? c.models : [],
        modelLabels: c.modelLabels && typeof c.modelLabels === 'object' ? c.modelLabels : {},
        type: c.type || 'direct',
        builtin: !!c.builtin,
      }));
    return JSON.stringify(out);
  } catch (e) {
    return '[]';
  }
}
function getSettings() {
  const out = {};
  for (const r of q(`SELECT key, value FROM settings`)) {
    out[r.key] = /^channel_key__/.test(r.key) ? '***' : r.value;
  }
  if (out.channels) out.channels = normalizeChannelsJson(out.channels);
  return out;
}
function setSetting(k, v) {
  if (/^channel_key__/.test(k) && v === '***') return;
  if (k === 'channels') v = normalizeChannelsJson(v);
  run(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, v == null ? '' : String(v));
}
function positiveInt(value) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function getBookPlanSettings({ bookId }) {
  if (!bookId) return { totalChapters: 0, chapterWords: 0 };
  const s = getSettings();
  return {
    totalChapters: positiveInt(s[`book_total_chapters__${bookId}`]),
    chapterWords: positiveInt(s[`book_chapter_words__${bookId}`]),
  };
}
function setBookPlanSettings({ bookId, totalChapters, chapterWords }) {
  if (!bookId) throw new Error('缺少 bookId');
  const total = Math.min(5000, positiveInt(totalChapters));
  const words = Math.min(50000, positiveInt(chapterWords));
  setSetting(`book_total_chapters__${bookId}`, total || '');
  setSetting(`book_chapter_words__${bookId}`, words || '');
  return { ok: true, totalChapters: total, chapterWords: words };
}

// ---------- 书 ----------
function listBooks() {
  return q(`SELECT * FROM books WHERE deleted_at IS NULL ORDER BY updated_at DESC`).map(rowBook);
}
function createBook({ title, genre = '', pov = '', status = '连载中', coverChar = '' }) {
  const id = uid();
  const t = now();
  run(`INSERT INTO books(id,title,genre,pov,status,cover_char,word_count,chapter_count,created_at,updated_at)
       VALUES(?,?,?,?,?,?,0,0,?,?)`, id, title, genre, pov, status, coverChar, t, t);
  ensureBookDir(id);
  run(`INSERT INTO book_meta(book_id,style_json,humanize,primary_skill,support_skills_json)
       VALUES(?,?,0,NULL,'[]')`, id, 'null');
  return rowBook(one(`SELECT * FROM books WHERE id=?`, id));
}
function updateBookMeta({ bookId, ...fields }) {
  const allowed = { title: 'title', genre: 'genre', pov: 'pov', status: 'status', cover_char: 'cover_char' };
  const sets = []; const args = [];
  for (const [k, col] of Object.entries(allowed)) {
    if (fields[k] !== undefined) { sets.push(`SET ${col}=?`); args.push(fields[k]); }
  }
  if (sets.length) {
    const sql = `UPDATE books ${sets.join(', ')} , updated_at=? WHERE id=?`;
    run(sql, ...args, now(), bookId);
  } else {
    run(`UPDATE books SET updated_at=? WHERE id=?`, now(), bookId);
  }
  return rowBook(one(`SELECT * FROM books WHERE id=?`, bookId));
}
function deleteBook({ bookId }) {
  run(`UPDATE books SET deleted_at=?, deleted_reason='user' WHERE id=?`, now(), bookId);
  return { ok: true };
}
function listTrash() {
  return q(`SELECT * FROM books WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`).map(rowBook);
}
function restoreTrash({ id }) {
  run(`UPDATE books SET deleted_at=NULL, deleted_reason=NULL WHERE id=?`, id);
  return { ok: true };
}
function clearTrash() {
  const rows = q(`SELECT id FROM books WHERE deleted_at IS NOT NULL`);
  for (const r of rows) {
    bodyWordTotals.delete(r.id);
    fs.rmSync(path.join(BOOKS_DIR, safeName(r.id)), { recursive: true, force: true });
    fs.rmSync(path.join(VERSIONS_DIR, safeName(r.id)), { recursive: true, force: true });
    run(`DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE book_id=?)`, r.id);
    run(`DELETE FROM sessions WHERE book_id=?`, r.id);
    run(`DELETE FROM book_meta WHERE book_id=?`, r.id);
    try { require('./vector-store').removeBook(r.id); } catch (e) {}
    run(`DELETE FROM books WHERE id=?`, r.id);
  }
  return { ok: true };
}

// ---------- 书本级 meta ----------
function getBookMeta(bookId) {
  let m = one(`SELECT * FROM book_meta WHERE book_id=?`, bookId);
  if (!m) {
    run(`INSERT INTO book_meta(book_id,style_json,humanize,primary_skill,support_skills_json) VALUES(?,?,0,NULL,'[]')`, bookId, 'null');
    m = one(`SELECT * FROM book_meta WHERE book_id=?`, bookId);
  }
  return {
    styleJson: m.style_json, humanize: !!m.humanize, primarySkill: m.primary_skill,
    supportSkills: JSON.parse(m.support_skills_json || '[]'), leadText: m.lead_text || '',
  };
}
function setBookMeta(bookId, { styleJson, humanize, primarySkill, supportSkills, leadText }) {
  const m = getBookMeta(bookId);
  run(`INSERT INTO book_meta(book_id,style_json,humanize,primary_skill,support_skills_json,lead_text)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(book_id) DO UPDATE SET style_json=excluded.style_json, humanize=excluded.humanize,
         primary_skill=excluded.primary_skill, support_skills_json=excluded.support_skills_json,
         lead_text=excluded.lead_text`,
    bookId,
    styleJson !== undefined ? JSON.stringify(styleJson) : m.styleJson,
    humanize !== undefined ? (humanize ? 1 : 0) : (m.humanize ? 1 : 0),
    primarySkill !== undefined ? primarySkill : m.primarySkill,
    supportSkills !== undefined ? JSON.stringify(supportSkills) : JSON.stringify(m.supportSkills),
    leadText !== undefined ? leadText : m.leadText);
}
function getBookStyle({ bookId }) {
  const m = getBookMeta(bookId);
  let raw = null;
  try { raw = m.styleJson ? JSON.parse(m.styleJson) : null; } catch (e) { raw = m.styleJson; }
  const fallback = {
    key: 'auto', resolvedKey: 'auto', resolvedName: '自动·跟随题材',
    isAuto: true, hasDistill: false, needsRedistill: false, styleSkillId: null,
  };
  if (!raw) return fallback;
  if (typeof raw === 'string') {
    if (raw === 'auto') return fallback;
    if (raw === 'off') return { ...fallback, key: 'off', resolvedKey: 'off', resolvedName: '关闭', isAuto: false };
    if (raw === 'distill') return { ...fallback, key: 'distill', resolvedKey: 'distill', resolvedName: '原作风格', isAuto: false };
    if (raw.startsWith('style:')) {
      const id = raw.slice(6);
      const skill = one(`SELECT * FROM skills WHERE id=?`, id);
      return {
        ...fallback, key: raw, resolvedKey: raw, resolvedName: skill ? skill.name : '已失效文风',
        isAuto: false, styleSkillId: id, summary: skill ? skill.prompt_template : '',
      };
    }
    return { ...fallback, key: raw, resolvedKey: raw, resolvedName: raw, isAuto: false };
  }
  if (raw && typeof raw === 'object') {
    const id = raw.styleSkillId || (String(raw.key || '').startsWith('style:') ? String(raw.key).slice(6) : '');
    const skill = id ? one(`SELECT * FROM skills WHERE id=?`, id) : null;
    return {
      ...fallback, ...raw,
      styleSkillId: id || raw.styleSkillId || null,
      resolvedName: raw.resolvedName || (skill ? skill.name : raw.key || '本书文风'),
      summary: raw.summary || (skill ? skill.prompt_template : ''),
      hasDistill: !!raw.hasDistill,
      needsRedistill: !!raw.needsRedistill,
      isAuto: raw.key === 'auto' || !!raw.isAuto,
    };
  }
  return fallback;
}
function setBookStyle({ bookId, style, key }) {
  const value = style !== undefined ? style : key;
  setBookMeta(bookId, { styleJson: value ?? null });
  return { ok: true, style: getBookStyle({ bookId }) };
}
function setBookCover({ bookId, char }) { setBookMeta(bookId, { styleJson: undefined }); run(`UPDATE books SET cover_char=? WHERE id=?`, char, bookId); return { ok: true }; }
function setBookHumanize({ bookId, value }) { setBookMeta(bookId, { humanize: value }); return { ok: true }; }
function setBookPrimarySkill({ bookId, taskKind, skillId }) {
  if (taskKind) setSetting(`book_primary_skill__${bookId}__${taskKind}`, skillId || '');
  setBookMeta(bookId, { primarySkill: skillId || null });
  return { ok: true };
}
function setBookSupportSkills({ bookId, taskKind, skillIds }) {
  const ids = Array.isArray(skillIds) ? skillIds : [];
  if (taskKind) setSetting(`book_support_skills__${bookId}__${taskKind}`, JSON.stringify(ids));
  setBookMeta(bookId, { supportSkills: ids });
  return { ok: true };
}
function saveLead({ bookId, text }) { setBookMeta(bookId, { leadText: text }); return { ok: true }; }
function getLead(bookId) { return getBookMeta(bookId).leadText; }

// ---------- 会话 / 消息 ----------
function listSessions({ bookId }) {
  return q(`SELECT * FROM sessions WHERE book_id=? ORDER BY updated_at DESC`, bookId).map((r) => ({
    id: r.id, bookId: r.book_id, title: r.title || '', preview: r.preview || '',
    msgCount: r.msg_count || 0, updatedAt: r.updated_at || 0,
  }));
}
function createSession({ bookId, title = '新会话' }) {
  const id = uid(); const t = now();
  run(`INSERT INTO sessions(id,book_id,title,preview,msg_count,updated_at) VALUES(?,?,?,NULL,0,?)`, id, bookId, title, t);
  return { id, bookId, title, preview: '', msgCount: 0, updatedAt: t };
}
function renameSession({ sessionId, title }) {
  run(`UPDATE sessions SET title=?, updated_at=? WHERE id=?`, title, now(), sessionId);
  return { ok: true };
}
function deleteSession({ sessionId }) {
  run(`DELETE FROM messages WHERE session_id=?`, sessionId);
  run(`DELETE FROM sessions WHERE id=?`, sessionId);
  return { ok: true };
}
function normalizeContext(context) {
  // 前端消息渲染假设：context 为对象（非数组），且带 skills/files 等字段
  if (context == null) return {};
  if (Array.isArray(context)) return { skills: [], files: context, webSearch: false };
  const c = { ...context };
  if (!Array.isArray(c.skills)) c.skills = [];
  if (!Array.isArray(c.files)) c.files = [];
  return c;
}
function normalizeResult(result) {
  // 前端消息卡渲染假设：result.ask 必带 options；sections/assetProposals/saveDocs/chapters/arcPlan 等数组字段兜底
  if (result == null || typeof result !== 'object') return result;
  const r = { ...result };
  // 官方前端消息卡约定：result = { ask: { question, options } }（两层结构）
  if (typeof r.ask === 'string' && Array.isArray(r.options)) {
    r.ask = { question: r.ask, options: r.options };
    delete r.options;
  }
  if (r.ask && typeof r.ask === 'object' && !Array.isArray(r.ask.options)) r.ask.options = [];
  for (const k of ['sections', 'assetProposals', 'saveDocs', 'chapters', 'files', 'skills', 'arcPlan', 'library']) {
    if (r[k] != null && !Array.isArray(r[k])) r[k] = [r[k]];
  }
  return r;
}
function msgRow(r) {
  let context = null, steps = null, result = null;
  try { context = r.context_json ? JSON.parse(r.context_json) : null; } catch (e) {}
  try { steps = r.steps_json ? JSON.parse(r.steps_json) : null; } catch (e) {}
  try { result = r.result_json ? JSON.parse(r.result_json) : null; } catch (e) {}
  context = normalizeContext(context);
  result = normalizeResult(result);
  return {
    id: r.id, sessionId: r.session_id, role: r.role, content: r.content || '',
    context, steps, result,
    contextJson: r.context_json || '', stepsJson: r.steps_json || '', resultJson: r.result_json || '',
    createdAt: r.created_at || 0, interrupted: !!r.interrupted,
  };
}
function listMessages({ sessionId }) {
  return q(`SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC`, sessionId).map(msgRow);
}
function saveMessage(row) {
  const id = row.id || uid();
  if (!row.id) {
    run(`INSERT INTO messages(id,session_id,role,content,context_json,steps_json,result_json,created_at,interrupted)
         VALUES(?,?,?,?,?,?,?,?,?)`,
      id, row.session_id, row.role || 'user', row.content || '',
      row.context_json || null, row.steps_json || null, row.result_json || null,
      row.created_at || now(), row.interrupted ? 1 : 0);
  } else {
    run(`UPDATE messages SET content=?, context_json=?, steps_json=?, result_json=?, interrupted=? WHERE id=?`,
      row.content || '', row.context_json || null, row.steps_json || null, row.result_json || null,
      row.interrupted ? 1 : 0, id);
  }
  const s = one(`UPDATE sessions SET msg_count=(SELECT COUNT(*) FROM messages WHERE session_id=?), preview=?, updated_at=? WHERE id=? RETURNING id`,
    row.session_id, String(row.content || '').slice(0, 80), now(), row.session_id);
  return id;
}
function searchMessages({ sessionId, query }) {
  const like = `%${query || ''}%`;
  if (sessionId) return q(`SELECT * FROM messages WHERE session_id=? AND content LIKE ? ORDER BY created_at ASC`, sessionId, like).map(msgRow);
  return q(`SELECT * FROM messages WHERE content LIKE ? ORDER BY created_at DESC LIMIT 200`, like).map(msgRow);
}
function searchBook({ bookId, query }) {
  const like = `%${query || ''}%`;
  const rows = q(`
    SELECT m.* FROM messages m JOIN sessions s ON s.id=m.session_id
    WHERE s.book_id=? AND m.content LIKE ? ORDER BY m.created_at DESC LIMIT 200`, bookId, like);
  return rows.map(msgRow);
}
function createSceneMessage({ sessionId, docName, scenePlanJson }) {
  const id = uid(); const t = now();
  let plan = null;
  try { plan = typeof scenePlanJson === 'string' ? JSON.parse(scenePlanJson) : scenePlanJson; } catch (e) {}
  run(`INSERT INTO messages(id,session_id,role,content,context_json,steps_json,result_json,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    id, sessionId, 'scene', plan ? (plan.title || docName || '场景') : String(docName || ''), '',
    JSON.stringify({ docName, plan }), null, t);
  run(`UPDATE sessions SET updated_at=? WHERE id=?`, t, sessionId);
  return msgRow(one(`SELECT * FROM messages WHERE id=?`, id));
}
function refreshEmptySceneMessages({ sessionId }) {
  return q(`SELECT * FROM messages WHERE session_id=? AND role='scene' ORDER BY created_at ASC`, sessionId).map(msgRow);
}
function updateScenePlan({ messageId, plan }) {
  const msg = one(`SELECT * FROM messages WHERE id=?`, messageId);
  if (!msg) throw new Error('场景消息不存在');
  let context = {};
  try { context = JSON.parse(msg.context_json || '{}'); } catch (e) {}
  context.plan = plan || null;
  const content = plan && plan.title ? String(plan.title) : (msg.content || '场景');
  run(`UPDATE messages SET content=?, context_json=?, result_json=?, updated_at=? WHERE id=?`,
    content, JSON.stringify(context), plan ? JSON.stringify({ scenePlan: plan }) : null, now(), messageId);
  return msgRow(one(`SELECT * FROM messages WHERE id=?`, messageId));
}
function updateArcPlan({ messageId, chaptersJson }) {
  run(`UPDATE messages SET result_json=?, updated_at=? WHERE id=?`, JSON.stringify({ arcPlan: chaptersJson }), now(), messageId);
  return { ok: true };
}

// ---------- 文件树 / 版本 ----------
function scanTree({ bookId }) {
  ensureBookDir(bookId);
  const base = path.join(BOOKS_DIR, safeName(bookId));
  let flags = {};
  try {
    const row = one(`SELECT value FROM settings WHERE key=?`, `file_flags__${bookId}`);
    flags = row && row.value ? JSON.parse(row.value) : {};
  } catch (e) { flags = {}; }
  return GROUPS.map((g) => {
    const files = [];
    const dir = path.join(base, g.groupDir);
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => !x.startsWith('.'))) {
        const fp = path.join(dir, f);
        if (fs.statSync(fp).isFile()) {
          const st = fs.statSync(fp);
          const fileFlags = flags[`${g.groupDir}/${f}`] || {};
          files.push({
            name: f,
            size: st.size < 1024 ? Math.max(1, Math.round(st.size / 102.4) / 10).toString() + 'k'
              : Math.round(st.size / 1024).toString() + 'k',
            desc: '', draft: false, ts: st.mtimeMs,
            aiOff: !!fileFlags.aiOff, locked: !!fileFlags.locked,
          });
        }
      }
    }
    return { key: g.key, label: g.label, dir: g.groupDir, groupDir: g.groupDir, icon: g.icon, files };
  });
}

function setFileAiFlag({ bookId, group, name, flag, value }) {
  if (!bookId || !group || !name) throw new Error('缺少文件标识');
  if (!['aiOff', 'locked'].includes(flag)) throw new Error('未知文件标记');
  const key = `file_flags__${bookId}`;
  let flags = {};
  try {
    const row = one(`SELECT value FROM settings WHERE key=?`, key);
    flags = row && row.value ? JSON.parse(row.value) : {};
  } catch (e) { flags = {}; }
  const fileKey = `${group}/${name}`;
  flags[fileKey] = { ...(flags[fileKey] || {}), [flag]: !!value };
  setSetting(key, JSON.stringify(flags));
  return { ok: true, flags: flags[fileKey] };
}
function readFileFrom({ bookId, group, name }) {
  if (!bookId || !name) return null;
  const fp = bookBase(bookId, group, name);
  if (!isInside(BOOKS_DIR, fp) || !fs.existsSync(fp)) return null;
  const stat = fs.statSync(fp);
  if (!stat.isFile()) return null;
  return fs.readFileSync(fp, 'utf-8');
}
function fileStatFrom({ bookId, group, name }) {
  if (!bookId || !name) return null;
  const fp = bookBase(bookId, group, name);
  if (!isInside(BOOKS_DIR, fp) || !fs.existsSync(fp)) return null;
  const stat = fs.statSync(fp);
  if (!stat.isFile()) return null;
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}
function writeFileTo({ bookId, group, name, content }) {
  const fp = bookBase(bookId, group, name);
  const previous = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : null;
  const nextContent = String(content == null ? '' : content);
  const isBody = group === '正文' || group === 'chapters';
  const beforeBodyTotal = isBody ? (bodyWordTotals.has(bookId) ? bodyWordTotals.get(bookId) : bookChars(bookId)) : 0;
  if (previous != null) saveVersion(bookId, group, name, previous);
  atomicWriteFileSync(fp, nextContent, { encoding: 'utf-8' });

  let indexed = true;
  let warning = '';
  try {
    require('./vector-store').indexFile({
      bookId, group, name, content: nextContent, mtime: Math.floor(fs.statSync(fp).mtimeMs),
    });
  } catch (error) {
    indexed = false;
    warning = `正文已保存，但长期记忆索引更新失败：${error.message}`;
  }
  if (isBody) {
    const afterBodyTotal = Math.max(0, beforeBodyTotal - (previous ? previous.length : 0) + nextContent.length);
    bodyWordTotals.set(bookId, afterBodyTotal);
    updateBookStatsAfterWrite(bookId, beforeBodyTotal, afterBodyTotal);
  }
  return { ok: true, indexed, ...(warning ? { warning } : {}) };
}

// Append-only materialization avoids rewriting a multi-megabyte summary file
// after every chapter. Knowledge indexing is refreshed separately at checkpoints.
function appendFileTo({ bookId, group, name, content }) {
  ensureBookDir(bookId);
  const fp = bookBase(bookId, group, name);
  const nextContent = String(content == null ? '' : content);
  fs.appendFileSync(fp, nextContent, { encoding: 'utf-8' });
  let indexed = true;
  let warning = '';
  try {
    const kb = require('./vector-store');
    const mtime = Math.floor(fs.statSync(fp).mtimeMs);
    const result = kb.appendIndex({ bookId, group, name, content: nextContent, mtime });
    if (result.needsFullIndex) {
      kb.indexFile({ bookId, group, name, content: fs.readFileSync(fp, 'utf-8'), mtime });
    }
  } catch (error) {
    indexed = false;
    warning = `文件已追加，但长期记忆索引更新失败：${error.message}`;
  }
  return { ok: true, indexed, ...(warning ? { warning } : {}) };
}
function truncateFileTo({ bookId, group, name, size }) {
  const fp = bookBase(bookId, group, name);
  if (!fs.existsSync(fp)) throw new Error('文件不存在');
  const currentSize = fs.statSync(fp).size;
  const nextSize = Number(size);
  if (!Number.isFinite(nextSize) || nextSize < 0 || nextSize > currentSize) {
    throw new Error('无效的截断长度');
  }
  fs.truncateSync(fp, nextSize);
  return { ok: true, size: nextSize };
}
function createFolder({ bookId, name }) {
  const dir = assertInside(BOOKS_DIR, path.join(BOOKS_DIR, safeName(bookId), safeName(name)), '文件夹路径');
  fs.mkdirSync(dir, { recursive: true });
  return { ok: true };
}
function createFile({ bookId, group, name }) {
  const fp = bookBase(bookId, group, name);
  if (!fs.existsSync(fp)) atomicWriteFileSync(fp, '', { encoding: 'utf-8' });
  if (group === '正文' || group === 'chapters') refreshWords(bookId);
  return { ok: true };
}
function renameFile({ bookId, group, name, newName }) {
  const old = bookBase(bookId, group, name);
  const neu = bookBase(bookId, group, newName);
  if (old !== neu && fs.existsSync(neu)) throw new Error('目标文件已存在');
  let warning = '';
  if (fs.existsSync(old)) {
    const content = fs.readFileSync(old, 'utf-8');
    fs.renameSync(old, neu);
    try {
      const kb = require('./vector-store');
      kb.removeFile({ bookId, group, name });
      kb.indexFile({ bookId, group, name: newName, content, mtime: Math.floor(fs.statSync(neu).mtimeMs) });
    } catch (error) {
      warning = `文件已重命名，但长期记忆索引更新失败：${error.message}`;
    }
  }
  if (group === '正文' || group === 'chapters') refreshWords(bookId);
  return { ok: true, indexed: !warning, ...(warning ? { warning } : {}) };
}
function deleteFile({ bookId, group, name }) {
  const fp = bookBase(bookId, group, name);
  let warning = '';
  if (fs.existsSync(fp)) {
    // 移入文件级回收站（内容留存可恢复），不直接删除
    const content = fs.readFileSync(fp, 'utf-8');
    const meta = { id: crypto.randomUUID(), kind: 'file', bookId, group, name, deletedAt: now(), content };
    const out = path.join(TRASH_DIR, safeName(bookId), meta.id + '.json');
    atomicWriteFileSync(out, JSON.stringify(meta), { encoding: 'utf-8' });
    fs.unlinkSync(fp);
    try { require('./vector-store').removeFile({ bookId, group, name }); } catch (error) {
      warning = `文件已移入回收站，但长期记忆索引清理失败：${error.message}`;
    }
    if (group === '正文' || group === 'chapters') {
      const current = bodyWordTotals.has(bookId) ? bodyWordTotals.get(bookId) : bookChars(bookId) + content.length;
      bodyWordTotals.set(bookId, Math.max(0, current - content.length));
    }
  }
  if (group === '正文' || group === 'chapters') refreshWords(bookId);
  return { ok: true, indexed: !warning, ...(warning ? { warning } : {}) };
}

// ---------- 文件级回收站（书内文件/文件夹；与书本回收站并存，用 bookId 分流） ----------
function listFileTrash({ bookId }) {
  const dir = path.join(TRASH_DIR, safeName(bookId || ''));
  if (!fs.existsSync(dir)) return [];
  const items = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (j.bookId === bookId) items.push({ id: j.id, kind: j.kind || 'file', group: j.group || '', name: j.name, deletedAt: j.deletedAt || 0 });
    } catch (e) {}
  }
  return items.sort((a, b) => b.deletedAt - a.deletedAt);
}
function restoreFileTrash({ bookId, id }) {
  const out = path.join(TRASH_DIR, safeName(bookId), safeName(id) + '.json');
  if (!fs.existsSync(out)) return { ok: false };
  const j = JSON.parse(fs.readFileSync(out, 'utf-8'));
  if (j.bookId !== bookId || !j.name) return { ok: false };
  writeFileTo({ bookId, group: j.group, name: j.name, content: String(j.content ?? '') });
  fs.unlinkSync(out);
  return { ok: true };
}
function clearFileTrash({ bookId }) {
  const dir = path.join(TRASH_DIR, safeName(bookId || ''));
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}
function saveVersion(bookId, group, name, content) {
  if (content == null) return 0;
  const dir = path.join(VERSIONS_DIR, safeName(bookId), safeName(group), safeName(name));
  fs.mkdirSync(dir, { recursive: true });
  let ts = now();
  while (fs.existsSync(path.join(dir, ts + '.json'))) ts++;
  atomicWriteFileSync(path.join(dir, ts + '.json'), JSON.stringify({ ts, content, note: '' }), { encoding: 'utf-8' });
  const snapshots = fs.readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({ file, ts: Number(file.slice(0, -5)) || 0 }))
    .sort((a, b) => b.ts - a.ts);
  for (const stale of snapshots.slice(MAX_VERSION_SNAPSHOTS)) {
    try { fs.rmSync(path.join(dir, stale.file), { force: true }); } catch (ignored) {}
  }
  return ts;
}
function listVersions({ bookId, group, name }) {
  const dir = path.join(VERSIONS_DIR, safeName(bookId), safeName(group), safeName(name));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => {
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')); return { ts: j.ts, size: j.content ? j.content.length : 0 }; }
    catch (e) { return { ts: Number(f.split('.')[0]) || 0, size: 0 }; }
  }).sort((a, b) => b.ts - a.ts);
}
function restoreVersion({ bookId, group, name, ts }) {
  const version = Number(ts);
  if (!Number.isSafeInteger(version) || version <= 0) return { ok: false };
  const fp = path.join(VERSIONS_DIR, safeName(bookId), safeName(group), safeName(name), String(version) + '.json');
  if (fs.existsSync(fp)) {
    const j = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    writeFileTo({ bookId, group, name, content: j.content });
    return { ok: true };
  }
  return { ok: false };
}
function zhChapterNum(s) {
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const map = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000 };
  let r = 0, cur = 0;
  for (const ch of String(s)) {
    const v = map[ch];
    if (v == null) return NaN;
    if (v >= 10) { r += (cur || 1) * v; cur = 0; }
    else cur = v;
  }
  return r + cur;
}
function chapterNumFromText(text) {
  const m = String(text || '').match(/第\s*([0-9一二三四五六七八九十百千零两]+)\s*章/);
  if (!m) return 0;
  const n = zhChapterNum(m[1]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function nextBodyChapterNumber(bookId) {
  const base = path.join(BOOKS_DIR, safeName(bookId), '正文');
  if (!fs.existsSync(base)) return 1;
  let max = 0, unnumbered = 0;
  for (const f of fs.readdirSync(base)) {
    const n = chapterNumFromText(f);
    if (n) max = Math.max(max, n);
    else if (/\.(md|txt)$/i.test(f) && !/^全文\.(md|txt)$/i.test(f)) unnumbered += 1;
  }
  return max > 0 ? max + 1 : unnumbered + 1;
}
function titleFromBody(content, n) {
  const heading = String(content || '').split(/\r?\n/).map((line) => line.trim()).find((line) => /^#{1,3}\s+/.test(line));
  if (heading && chapterNumFromText(heading) === n) return heading.replace(/^#{1,3}\s+/, '').trim();
  return `第${n}章`;
}
function chapterNumFromMessageContext(msg) {
  if (!msg) return 0;
  try {
    const c = JSON.parse(msg.context_json || '{}');
    for (const f of c.files || []) {
      const name = typeof f === 'string' ? f : f && f.name;
      const n = chapterNumFromText(name);
      if (n) return n;
    }
  } catch (e) {}
  return 0;
}
function saveDoc({ bookId, messageId, draft, replace }) {
  const msg = one(`SELECT * FROM messages WHERE id=?`, messageId);
  let docName = '', group = '正文', content = replace != null ? String(replace) : String(draft || '');
  if (msg) {
    try { const c = JSON.parse(msg.context_json || '{}'); docName = c.docName || (msg.content || ''); } catch (e) { docName = msg.content || ''; }
  }
  if (docName.endsWith('.md') || docName.includes('|')) {
    if (docName.includes('|')) { const [g, n] = docName.split('|'); group = g; docName = n; }
  }
  if (!docName) docName = '正文_' + msgIdShort(messageId) + '.md';
  if ((group === '正文' || group === 'chapters') && !chapterNumFromText(docName)) {
    const n = chapterNumFromText(content) || chapterNumFromMessageContext(msg) || nextBodyChapterNumber(bookId);
    docName = `${titleFromBody(content, n)}.md`;
  }
  docName = safeName(docName);
  if (!/\.(md|txt)$/.test(docName)) docName += '.md';
  if (msg) {
    run(`UPDATE messages SET content=?, updated_at=? WHERE id=?`, docName, now(), messageId);
  }
  writeFileTo({ bookId, group, name: docName, content });
  return { ok: true, group, name: docName };
}
function msgIdShort(id) { return String(id || 'x').slice(0, 8); }

// ---------- 字数统计 ----------
function bookChars(bookId, { fresh = false } = {}) {
  if (!fresh && bodyWordTotals.has(bookId)) return bodyWordTotals.get(bookId);
  let total = 0;
  const base = path.join(BOOKS_DIR, safeName(bookId), '正文');
  if (fs.existsSync(base)) {
    for (const f of fs.readdirSync(base)) {
      const fp = path.join(base, f);
      try { if (fs.statSync(fp).isFile()) total += fs.readFileSync(fp, 'utf-8').length; } catch (e) {}
    }
  }
  bodyWordTotals.set(bookId, total);
  return total;
}
function chapterCount(bookId) {
  // 章节数 = 正文目录下「第X章」文件数（兼容中文数字/阿拉伯数字/纯 md 文件）
  const base = path.join(BOOKS_DIR, safeName(bookId), '正文');
  if (!fs.existsSync(base)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(base)) {
    if (/第[0-9一二三四五六七八九十百千零两]+章/.test(f)) n++;
    else if (/\.(md|txt)$/i.test(f)) n++;
  }
  return n;
}
function updateBookStatsAfterWrite(bookId, beforeTotal, afterTotal) {
  const date = localDateKey();
  const chCount = chapterCount(bookId);
  const latest = Math.max(0, Number(afterTotal) || 0);
  const before = Math.max(0, Number(beforeTotal) || 0);
  transaction(() => {
    const row = one(`SELECT date FROM word_stats WHERE date=? AND book_id=?`, date, bookId);
    if (!row) {
      run(`INSERT INTO word_stats(date,book_id,start_words,latest_words) VALUES(?,?,?,?)`, date, bookId, before, latest);
    } else {
      run(`UPDATE word_stats SET latest_words=? WHERE date=? AND book_id=?`, latest, date, bookId);
    }
    run(`UPDATE books SET word_count=?, chapter_count=?, updated_at=? WHERE id=?`, latest, chCount, now(), bookId);
  });
}
function refreshWords(bookId, { fresh = false } = {}) {
  if (!bookId) return;
  const d = localDateKey();
  const recorded = Number((one(`SELECT word_count FROM books WHERE id=?`, bookId) || {}).word_count || 0);
  const before = bodyWordTotals.has(bookId) ? bodyWordTotals.get(bookId) : (fresh ? recorded : bookChars(bookId));
  const chars = bookChars(bookId, { fresh });
  const chCount = chapterCount(bookId);
  const r = one(`SELECT * FROM word_stats WHERE date=? AND book_id=?`, d, bookId);
  if (!r) run(`INSERT INTO word_stats(date,book_id,start_words,latest_words) VALUES(?,?,?,?)`, d, bookId, before, chars);
  else run(`UPDATE word_stats SET latest_words=? WHERE date=? AND book_id=?`, chars, d, bookId);
  run(`UPDATE books SET word_count=?, chapter_count=?, updated_at=? WHERE id=?`, chars, chCount, now(), bookId);
}
function getWritingStats({ bookId } = {}) {
  const dailyRows = bookId
    ? q(`SELECT * FROM word_stats WHERE book_id=? ORDER BY date DESC LIMIT 7`, bookId)
    : q(`SELECT date, SUM(start_words) AS start_words, SUM(latest_words) AS latest_words
         FROM word_stats GROUP BY date ORDER BY date DESC LIMIT 7`);
  const daily = dailyRows.map((r) => ({
    date: r.date, startWords: r.start_words, latestWords: r.latest_words,
  }));
  const today = localDateKey();
  const m = daily.find((r) => r.date === today) || null;
  const totalBooks = bookId
    ? Number((one(`SELECT word_count FROM books WHERE id=? AND deleted_at IS NULL`, bookId) || {}).word_count || 0)
    : Number((q(`SELECT COALESCE(SUM(word_count),0) AS s FROM books WHERE deleted_at IS NULL`)[0] || {}).s || 0);
  return {
    totalWords: totalBooks,
    todayWords: m ? Math.max(0, Number(m.latestWords || 0) - Number(m.startWords || 0)) : 0,
    weekWords: daily.reduce((s, r) => s + Math.max(0, r.latestWords - r.startWords), 0),
    daily,
  };
}

// ---------- 导入导出 ----------
function exportTxt({ bookId, mode = 'full' }) {
  const book = one(`SELECT * FROM books WHERE id=?`, bookId);
  const base = path.join(BOOKS_DIR, safeName(bookId), '正文');
  const lines = [book ? `《${book.title}》` : '', ''];
  if (fs.existsSync(base)) {
    const files = fs.readdirSync(base).sort((a, b) => {
      const an = chapterNumFromText(a), bn = chapterNumFromText(b);
      return (an || 999999) - (bn || 999999) || a.localeCompare(b, 'zh-CN');
    });
    for (const f of files) {
      lines.push('\n\n' + f.replace(/\.\w+$/, '') + '\n\n' + fs.readFileSync(path.join(base, f), 'utf-8'));
    }
  }
  return { content: lines.join(''), count: lines.length, chars: lines.join('').length, path: null };
}
function importBook({ title, files, genre = '' }) {
  const b = createBook({ title, genre, status: '连载中' });
  for (const f of (files || [])) {
    if (!f || !f.name) continue;
    const parts = String(f.name).split(/[\\/]+/).filter(Boolean);
    const inferredGroup = parts.find((part) => GROUPS.some((g) => g.groupDir === part));
    const group = f.group || inferredGroup || (f.content != null ? '正文' : '设定');
    const name = parts.at(-1) || '章节.md';
    writeFileTo({ bookId: b.id, group, name, content: f.content != null ? f.content : '' });
  }
  refreshWords(b.id);
  return { bookId: b.id };
}

module.exports = {
  getSettings, setSetting, getBookPlanSettings, setBookPlanSettings, setFileAiFlag,
  listBooks, createBook, updateBookMeta, deleteBook, listTrash, restoreTrash, clearTrash,
  getBookStyle, setBookStyle, setBookCover, setBookHumanize, setBookPrimarySkill, setBookSupportSkills,
  saveLead, getLead, getBookMeta,
  listSessions, createSession, renameSession, deleteSession, listMessages, saveMessage, searchMessages,
  searchBook, createSceneMessage, refreshEmptySceneMessages, updateScenePlan, updateArcPlan,
  scanTree, readFileFrom, fileStatFrom, writeFileTo, appendFileTo, truncateFileTo, createFolder, createFile, renameFile, deleteFile, saveDoc,
  listVersions, restoreVersion, refreshWords, updateBookStatsAfterWrite, getWritingStats, exportTxt, importBook,
  listFileTrash, restoreFileTrash, clearFileTrash,
  GROUPS, BOOKS_DIR, ensureBookDir, safeName,
};
