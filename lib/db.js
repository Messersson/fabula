  // SQLite 封装（node:sqlite）。库在 data/writerx.db，混入少量复刻扩展表。
'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const BASE_DATA_DIR = path.join(__dirname, '..', 'data');
const dataDirPointer = path.join(BASE_DATA_DIR, '.data_dir');
let DATA_DIR = process.env.FABULA_DATA_DIR ? path.resolve(process.env.FABULA_DATA_DIR) : BASE_DATA_DIR;
if (!process.env.FABULA_DATA_DIR) {
  try {
    const configured = fs.readFileSync(dataDirPointer, 'utf-8').trim();
    if (configured) DATA_DIR = path.resolve(BASE_DATA_DIR, configured);
  } catch (e) {}
}
const DB_PATH = process.env.FABULA_DB_PATH || path.join(DATA_DIR, 'writerx.db');

let db = null;

function open(seedPath) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH) && seedPath && path.resolve(seedPath) !== path.resolve(DB_PATH)) {
    fs.copyFileSync(seedPath, DB_PATH);
  }
  db = new DatabaseSync(DB_PATH);
  // Docker Desktop bind mounts on Windows can reject SQLite WAL shared-memory files.
  // Keep WAL for direct local runs; use rollback journaling inside Linux containers.
  const journalMode = process.env.FABULA_SQLITE_JOURNAL || (process.platform === 'linux' ? 'DELETE' : 'WAL');
  db.exec(`PRAGMA journal_mode=${journalMode};
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;`);
  migrate();
  return db;
}

function migrate() {
  // 复刻扩展：书本级元数据（风格卡/人设/主技能等）
  db.exec(`CREATE TABLE IF NOT EXISTS book_meta (
    book_id TEXT PRIMARY KEY,
    style_json TEXT,
    humanize INTEGER NOT NULL DEFAULT 0,
    primary_skill TEXT,
    support_skills_json TEXT NOT NULL DEFAULT '[]',
    lead_text TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS kb_files (
    book_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    source_mtime INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    indexed_at INTEGER NOT NULL,
    PRIMARY KEY (book_id, group_name, file_name)
  );
  CREATE TABLE IF NOT EXISTS kb_chunks (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    vector_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    chapter_num INTEGER NOT NULL DEFAULT 0,
    chunk_kind TEXT NOT NULL DEFAULT '',
    characters_json TEXT NOT NULL DEFAULT '[]',
    location TEXT NOT NULL DEFAULT '',
    threads_json TEXT NOT NULL DEFAULT '[]',
    vector_blob BLOB
  );
  CREATE INDEX IF NOT EXISTS idx_kb_chunks_book ON kb_chunks(book_id);
  CREATE TABLE IF NOT EXISTS kb_meta (
    book_id TEXT PRIMARY KEY,
    engine TEXT NOT NULL,
    indexed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entity_aliases (
    book_id TEXT NOT NULL,
    alias TEXT NOT NULL,
    canonical TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (book_id, alias)
  );
  CREATE TABLE IF NOT EXISTS consistency_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    from_chapter INTEGER NOT NULL,
    to_chapter INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    issues_json TEXT NOT NULL DEFAULT '[]',
    metrics_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_consistency_audits_book ON consistency_audits(book_id, scope, to_chapter);`);
  db.exec(`CREATE TABLE IF NOT EXISTS chapter_plans (
    book_id TEXT NOT NULL,
    chapter_num INTEGER NOT NULL,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (book_id, chapter_num)
  );
  CREATE TABLE IF NOT EXISTS chapter_summaries (
    book_id TEXT NOT NULL,
    chapter_num INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (book_id, chapter_num)
  );
  CREATE TABLE IF NOT EXISTS chapter_continuity (
    book_id TEXT NOT NULL,
    chapter_num INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (book_id, chapter_num)
  );
  CREATE TABLE IF NOT EXISTS story_states (
    book_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    state_key TEXT NOT NULL,
    value TEXT NOT NULL,
    chapter_num INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (book_id, kind, state_key)
  );
  CREATE TABLE IF NOT EXISTS character_mentions (
    book_id TEXT NOT NULL,
    state_key TEXT NOT NULL,
    chapter_num INTEGER NOT NULL,
    PRIMARY KEY (book_id, state_key, chapter_num)
  );
  CREATE TABLE IF NOT EXISTS volume_summaries (
    book_id TEXT NOT NULL,
    volume_num INTEGER NOT NULL,
    start_chapter INTEGER NOT NULL,
    end_chapter INTEGER NOT NULL,
    content TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (book_id, volume_num)
  );
  CREATE TABLE IF NOT EXISTS thread_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id TEXT NOT NULL,
    chapter_num INTEGER NOT NULL,
    kind TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(book_id, chapter_num, kind, thread_key)
  );
  CREATE TABLE IF NOT EXISTS generation_runs (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'full',
    status TEXT NOT NULL,
    from_chapter INTEGER NOT NULL,
    to_chapter INTEGER NOT NULL,
    current_chapter INTEGER NOT NULL DEFAULT 0,
    total_chapters INTEGER NOT NULL DEFAULT 0,
    chapter_words INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    options_json TEXT NOT NULL DEFAULT '{}',
    last_error TEXT,
    started_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chapter_runs (
    run_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    chapter_num INTEGER NOT NULL,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    outline_path TEXT,
    body_path TEXT,
    body_chars INTEGER NOT NULL DEFAULT 0,
    quality_json TEXT,
    last_error TEXT,
    committed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, chapter_num)
  );
  CREATE TABLE IF NOT EXISTS generation_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    chapter_num INTEGER NOT NULL,
    phase TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    status TEXT NOT NULL,
    error_kind TEXT,
    error_message TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS chapter_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    book_id TEXT NOT NULL,
    chapter_num INTEGER NOT NULL,
    attempt_no INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    issues_json TEXT NOT NULL DEFAULT '[]',
    metrics_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS world_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id TEXT NOT NULL,
    rule_key TEXT NOT NULL,
    content TEXT NOT NULL,
    ban_terms_json TEXT NOT NULL DEFAULT '[]',
    priority INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    UNIQUE(book_id, rule_key)
  );
  CREATE TABLE IF NOT EXISTS canon_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id TEXT NOT NULL,
    event_key TEXT NOT NULL,
    chapter_num INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '',
    keywords_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    UNIQUE(book_id, event_key)
  );
  CREATE TABLE IF NOT EXISTS kb_embeddings (
    chunk_id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vector BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS doc_projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    doc_type TEXT NOT NULL DEFAULT 'custom',
    mode TEXT NOT NULL DEFAULT 'co',
    status TEXT NOT NULL DEFAULT 'drafting',
    brief TEXT NOT NULL DEFAULT '',
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS doc_sections (
    project_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    title TEXT NOT NULL,
    brief TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'planned',
    source TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, idx)
  );
  CREATE INDEX IF NOT EXISTS idx_chapter_plans_book ON chapter_plans(book_id, chapter_num);
  CREATE INDEX IF NOT EXISTS idx_chapter_summaries_book ON chapter_summaries(book_id, chapter_num);
  CREATE INDEX IF NOT EXISTS idx_chapter_continuity_book ON chapter_continuity(book_id, chapter_num);
  CREATE INDEX IF NOT EXISTS idx_story_states_book_chapter ON story_states(book_id, chapter_num);
  CREATE INDEX IF NOT EXISTS idx_character_mentions_book_chapter ON character_mentions(book_id, chapter_num);
  CREATE INDEX IF NOT EXISTS idx_volume_summaries_book ON volume_summaries(book_id, volume_num);
  CREATE INDEX IF NOT EXISTS idx_thread_events_book_chapter ON thread_events(book_id, chapter_num);
  CREATE INDEX IF NOT EXISTS idx_generation_runs_book_status ON generation_runs(book_id, status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_chapter_runs_run_status ON chapter_runs(run_id, status, chapter_num);
  CREATE INDEX IF NOT EXISTS idx_generation_attempts_run_chapter ON generation_attempts(run_id, chapter_num, phase, attempt_no);
  CREATE INDEX IF NOT EXISTS idx_chapter_reviews_run_chapter ON chapter_reviews(run_id, chapter_num, attempt_no);
  CREATE INDEX IF NOT EXISTS idx_world_rules_book ON world_rules(book_id, enabled, priority DESC);
  CREATE INDEX IF NOT EXISTS idx_canon_events_book_chapter ON canon_events(book_id, chapter_num);
  CREATE INDEX IF NOT EXISTS idx_kb_embeddings_book_model ON kb_embeddings(book_id, model, updated_at);
  CREATE INDEX IF NOT EXISTS idx_doc_sections_project ON doc_sections(project_id, idx);`);
  // 小节级对话共创历史（AI 共创模式：追问 → 作者回答 → 成稿）
  const docSectionCols = tableCols('doc_sections');
  if (docSectionCols.length && !docSectionCols.includes('chat_json')) {
    db.exec(`ALTER TABLE doc_sections ADD COLUMN chat_json TEXT NOT NULL DEFAULT '[]'`);
  }
  // 文档项目可绑定技能（对话面板里勾选，注入生成提示词）
  const docCols = tableCols('doc_projects');
  if (docCols.length && !docCols.includes('skills_json')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'`);
  }
  migrateWordStats();
  // 知识库 v2 列（旧库增量补齐；引擎版本不一致时按书重建）
  const chunkCols = tableCols('kb_chunks');
  if (chunkCols.length) {
    const additions = {
      chapter_num: 'INTEGER NOT NULL DEFAULT 0',
      chunk_kind: "TEXT NOT NULL DEFAULT ''",
      characters_json: "TEXT NOT NULL DEFAULT '[]'",
      location: "TEXT NOT NULL DEFAULT ''",
      threads_json: "TEXT NOT NULL DEFAULT '[]'",
      vector_blob: 'BLOB',
    };
    for (const [column, ddl] of Object.entries(additions)) {
      if (!chunkCols.includes(column)) {
        try { db.exec(`ALTER TABLE kb_chunks ADD COLUMN ${column} ${ddl}`); } catch (e) {}
      }
    }
    try { db.exec(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_chapter ON kb_chunks(book_id, chapter_num)`); } catch (e) {}
  }
  // 生成尝试的 Token 记账列（旧库增量补齐）
  const attemptCols = tableCols('generation_attempts');
  for (const column of ['prompt_tokens', 'completion_tokens']) {
    if (attemptCols.length && !attemptCols.includes(column)) {
      try { db.exec(`ALTER TABLE generation_attempts ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
    }
  }
  // 书本级“删除到回收站”标记
  const cols = tableCols('books');
  if (!cols.includes('deleted_at')) {
    try { db.exec(`ALTER TABLE books ADD COLUMN deleted_at INTEGER`); } catch (e) {}
  }
  if (!cols.includes('deleted_reason')) {
    try { db.exec(`ALTER TABLE books ADD COLUMN deleted_reason TEXT`); } catch (e) {}
  }
}

function migrateWordStats() {
  const cols = tableCols('word_stats');
  if (!cols.length) {
    db.exec(`CREATE TABLE word_stats (
      date TEXT NOT NULL,
      book_id TEXT NOT NULL DEFAULT '',
      start_words INTEGER NOT NULL DEFAULT 0,
      latest_words INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, book_id)
    )`);
    return;
  }
  if (cols.includes('book_id')) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE word_stats RENAME TO word_stats_legacy;
      CREATE TABLE word_stats (
        date TEXT NOT NULL,
        book_id TEXT NOT NULL DEFAULT '',
        start_words INTEGER NOT NULL DEFAULT 0,
        latest_words INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, book_id)
      );
      INSERT INTO word_stats(date, book_id, start_words, latest_words)
        SELECT date, '', COALESCE(start_words, 0), COALESCE(latest_words, 0) FROM word_stats_legacy;
      DROP TABLE word_stats_legacy;`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (ignored) {}
    throw error;
  }
}

function tableCols(t) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${t})`).all();
    return rows.map((r) => r.name);
  } catch (e) {
    return [];
  }
}

function q(sql, ...params) {
  return db.prepare(sql).all(...params);
}
function one(sql, ...params) {
  return db.prepare(sql).get(...params);
}
function run(sql, ...params) {
  const r = db.prepare(sql).run(...params);
  return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
}
function exec(sql) {
  db.exec(sql);
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (ignored) {}
    throw error;
  }
}

function close() {
  if (!db) return;
  db.close();
  db = null;
}

module.exports = { open, close, q, one, run, exec, transaction, tableCols, DATA_DIR, BASE_DATA_DIR, DB_PATH };
