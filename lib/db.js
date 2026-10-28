  // SQLite 封装（node:sqlite）。库在 data/writerx.db，混入少量复刻扩展表。
'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const BASE_DATA_DIR = path.join(__dirname, '..', 'data');
// 随代码分发的内置资源：种子库与默认提示词/书源/敏感词。
// data/ 是用户数据目录（不入库），干净检出时里面什么都没有——
// 这些资源必须跟着代码走，否则新机器连测试都跑不起来。
const RESOURCES_DIR = path.join(__dirname, '..', 'resources');
const BUNDLED_SEED = path.join(RESOURCES_DIR, 'writerx.seed.db');
const DEFAULT_ASSETS = ['prompts.defaults.json', 'sources.json', 'sensitive_words.txt'];
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

function ensureDataAssets() {
  for (const name of DEFAULT_ASSETS) {
    const dest = path.join(DATA_DIR, name);
    if (fs.existsSync(dest)) continue;
    const src = path.join(RESOURCES_DIR, name);
    if (!fs.existsSync(src)) continue;
    try {
      fs.copyFileSync(src, dest);
    } catch (err) {
      console.error(`[db] 默认资源 ${name} 补齐失败：${err && err.message}`);
    }
  }
}

function resolveSeed(seedPath) {
  if (seedPath && fs.existsSync(seedPath)) return seedPath;
  return fs.existsSync(BUNDLED_SEED) ? BUNDLED_SEED : '';
}

function open(seedPath) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  ensureDataAssets();
  const seed = resolveSeed(seedPath);
  if (!fs.existsSync(DB_PATH) && seed && path.resolve(seed) !== path.resolve(DB_PATH)) {
    fs.copyFileSync(seed, DB_PATH);
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
  // 小节要点（80~140 字）：写后续小节时注入「前文要点」，解决每节只看前 500 字导致的论证断裂。
  if (docSectionCols.length && !docSectionCols.includes('summary')) {
    db.exec(`ALTER TABLE doc_sections ADD COLUMN summary TEXT NOT NULL DEFAULT ''`);
  }
  // 小节篇幅下限：类型自带的 minChars（论文「结果与分析」900 字）此前只在内存里算过，
  // 建项目时就被丢掉了，门禁一律回落到 800——论文的篇幅要求等于没提。
  if (docSectionCols.length && !docSectionCols.includes('min_chars')) {
    db.exec(`ALTER TABLE doc_sections ADD COLUMN min_chars INTEGER NOT NULL DEFAULT 0`);
  }
  // 目录层级：1=一级标题（章），2=二级，3=三级。
  // 蒸馏出来的章节目录是带层级的，以前只存标题顺序、层级在这里就丢了，
  // 结果导出的 Word 里所有小节都是「一、二、三」同级——目录看着对，结构是平的。
  if (docSectionCols.length && !docSectionCols.includes('level')) {
    db.exec(`ALTER TABLE doc_sections ADD COLUMN level INTEGER NOT NULL DEFAULT 1`);
  }
  // 段落计划（AgentWrite）：每段要完成哪个论证动作、写多少字、用哪条素材。
  // 缓存下来重试/续写都用同一份计划，避免每次重试都换一套骨架。
  if (docSectionCols.length && !docSectionCols.includes('plan_json')) {
    db.exec(`ALTER TABLE doc_sections ADD COLUMN plan_json TEXT NOT NULL DEFAULT ''`);
  }
  // 最近一次 rubric 评审结果（分数 + 问题 + 必须修正项），「本轮报告」与页面直接读。
  if (docSectionCols.length && !docSectionCols.includes('review_json')) {
    db.exec(`ALTER TABLE doc_sections ADD COLUMN review_json TEXT NOT NULL DEFAULT ''`);
  }
  // 本节写作时实际用了多少上下文：语料多大、检索命中哪几条素材、注入了多少字。
  // 不落这个值，作者就永远看不到「百万字语料」到底有没有生效——
  // 一个看不见的能力，在作者眼里等于不存在。
  if (docSectionCols.length && !docSectionCols.includes('context_json')) {
    db.exec(`ALTER TABLE doc_sections ADD COLUMN context_json TEXT NOT NULL DEFAULT ''`);
  }
  // 深度档位前的原始篇幅下限。深度是乘数，没有基数就会越切越短（标准→深入→标准 三次之后字数是乱的）。
  if (docSectionCols.length && !docSectionCols.includes('base_chars')) {
    db.exec(`ALTER TABLE doc_sections ADD COLUMN base_chars INTEGER NOT NULL DEFAULT 0`);
    // 老数据没有基数：当前 min_chars 就是「标准」档的值，直接当基数用。
    db.exec(`UPDATE doc_sections SET base_chars = min_chars WHERE base_chars = 0`);
  }
  // 本节图表（柱/线/饼）：{no,type,title,unit,note,categories,series[]} 列表。
  // 正文里只放「【图N：标题】」占位，数字存在这里——渲染成 SVG / Word 原生图表 / Markdown 表格。
  if (docSectionCols.length && !docSectionCols.includes('figures_json')) {
    db.exec(`ALTER TABLE doc_sections ADD COLUMN figures_json TEXT NOT NULL DEFAULT '[]'`);
  }
  // 本节表格（三线表）：回归结果、描述统计、分组比较。正文里放「【表N：标题】」占位。
  if (docSectionCols.length && !docSectionCols.includes('tables_json')) {
    db.exec(`ALTER TABLE doc_sections ADD COLUMN tables_json TEXT NOT NULL DEFAULT '[]'`);
  }
  // 数据集：作者上传的 CSV。存原文而不是解析结果——解析规则改了以后老数据还能重算，
  // 存解析结果就等于把当时的解析 bug 一起冻进去了。
  db.exec(`CREATE TABLE IF NOT EXISTS doc_datasets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    rows INTEGER NOT NULL DEFAULT 0,
    cols INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_doc_datasets_project ON doc_datasets(project_id, created_at);`);
  // 数据体检结果：跑回归之前先看这份数据撑不撑得住
  const dsCols = tableCols('doc_datasets');
  if (dsCols.length && !dsCols.includes('diagnosis_json')) {
    db.exec(`ALTER TABLE doc_datasets ADD COLUMN diagnosis_json TEXT NOT NULL DEFAULT '{}'`);
  }
  // 技能域：novel（小说）/ doc（文档）——两个广场互不混用
  const skillCols = tableCols('skills');
  if (skillCols.length && !skillCols.includes('domain')) {
    db.exec(`ALTER TABLE skills ADD COLUMN domain TEXT NOT NULL DEFAULT 'novel'`);
  }
  // 文档项目的写作要点：论题 + 论据/要点列表（AI 共创与批量生成的核心指引）
  const docProjCols2 = tableCols('doc_projects');
  if (docProjCols2.length && !docProjCols2.includes('thesis')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN thesis TEXT NOT NULL DEFAULT ''`);
  }
  if (docProjCols2.length && !docProjCols2.includes('points_json')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN points_json TEXT NOT NULL DEFAULT '[]'`);
  }
  // 视角发现提问（STORM）：素材答不出的问题 + 需要补的素材。按小节存，随时可重问。
  if (docProjCols2.length && !docProjCols2.includes('questions_json')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN questions_json TEXT NOT NULL DEFAULT '{}'`);
  }
  // 深度档位：brief / standard / deep。决定篇幅乘数、段落计划段数、子问题个数与图表数量。
  // 存成项目级而不是每次生成传参——「这篇要写多深」是稿子的属性，不是某一次点击的属性。
  if (docProjCols2.length && !docProjCols2.includes('depth')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN depth TEXT NOT NULL DEFAULT 'standard'`);
  }
  // 文档项目可绑定技能（对话面板里勾选，注入生成提示词）
  const docCols = tableCols('doc_projects');
  // 已蒸馏的文档模板（样例文档 → 可复用小节结构 + 排版规格 + 文风技法）
  db.exec(`CREATE TABLE IF NOT EXISTS doc_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    doc_type TEXT NOT NULL DEFAULT 'custom',
    sections_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    layout_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  // 模板的排版规格（字体字号行距缩进编号页边距）。
  // 以前只有「结构 + 文风」，版式是空的，导出的稿子永远一套默认排版。
  const docTplCols = tableCols('doc_templates');
  if (docTplCols.length && !docTplCols.includes('layout_json')) {
    db.exec(`ALTER TABLE doc_templates ADD COLUMN layout_json TEXT NOT NULL DEFAULT '{}'`);
  }
  // 项目的排版规格：从模板套用或手工设置，写作与导出都读它。
  if (docCols.length && !docCols.includes('layout_json')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN layout_json TEXT NOT NULL DEFAULT '{}'`);
  }
  if (docCols.length && !docCols.includes('skills_json')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]'`);
  }
  // 文档素材：作者粘贴/上传的文献、数据、政策、团队履历。生成时按节检索注入，
  // 是「不编造」与「有内容」之间的唯一通道——没有它，论文的文献综述只能满篇【待补】。
  db.exec(`CREATE TABLE IF NOT EXISTS doc_materials (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'material',
    content TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_doc_materials_project ON doc_materials(project_id, updated_at DESC);`);
  // 素材元数据：参考文献著录要的是「作者. 题名. 出处, 年份.」，
  // 只存标题的话，参考文献页只能写成 [M1] 行业年报——那是工单号，不是参考文献。
  const docMaterialCols = tableCols('doc_materials');
  if (docMaterialCols.length && !docMaterialCols.includes('authors')) {
    db.exec(`ALTER TABLE doc_materials ADD COLUMN authors TEXT NOT NULL DEFAULT ''`);
    db.exec(`ALTER TABLE doc_materials ADD COLUMN year TEXT NOT NULL DEFAULT ''`);
    db.exec(`ALTER TABLE doc_materials ADD COLUMN source TEXT NOT NULL DEFAULT ''`);
  }
  // DOI：GB/T 7714 与 APA 都要求著录，导入 BibTeX/RIS 时顺手带进来
  if (docMaterialCols.length && !docMaterialCols.includes('doi')) {
    db.exec(`ALTER TABLE doc_materials ADD COLUMN doi TEXT NOT NULL DEFAULT ''`);
  }
  // 素材编号要**稳定**。原来按「最近更新」排序现算编号，作者写完正文再补一条素材，
  // 正文里所有 [M1] 会整体错位——参考文献全乱，而且看不出是哪一步坏的。
  // 改成插入时定号（项目内自增），编号一旦给出就不再变。
  if (docMaterialCols.length && !docMaterialCols.includes('seq')) {
    db.exec(`ALTER TABLE doc_materials ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`);
    // 老数据按原来的排序口径回填，保证已有正文里的编号继续指同一条素材
    const rows = db.prepare(`SELECT id, project_id FROM doc_materials WHERE seq=0 ORDER BY updated_at DESC, id`).all();
    const counters = new Map();
    const update = db.prepare(`UPDATE doc_materials SET seq=? WHERE id=?`);
    for (const row of rows) {
      const next = (counters.get(row.project_id) || 0) + 1;
      counters.set(row.project_id, next);
      update.run(next, row.id);
    }
  }
  // 编号计数器放项目上：删掉一条素材后，它的编号不能被下一条复用——
  // 否则旧正文里的 [M2] 会悄悄指向另一条文献，而且没人会发现。
  if (docProjCols2.length && !docProjCols2.includes('material_seq')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN material_seq INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE doc_projects SET material_seq = COALESCE(
      (SELECT MAX(seq) FROM doc_materials WHERE doc_materials.project_id = doc_projects.id), 0)`);
  }
  // 文档语料索引：把素材切成块并预存向量，让「百万字语料」也能在每节几百毫秒内检索完。  //
  // 为什么不复用小说的 kb_chunks：那张表绑在「书 + 磁盘文件」上（syncBook 会去扫书目录），
  // 文档没有那套文件结构。这里只借它的**思路**（两阶段检索：先向量粗筛、再取正文精排），
  // 表与缓存全部独立，小说侧一行不动。
  //
  // 存向量而不是每次现算：1M 字语料约 1500 块，现算每块都要做 700 次哈希；
  // 存成 256 维 float32（1KB/块，合计约 1.5MB）后，每节只需算一次查询向量。
  db.exec(`CREATE TABLE IF NOT EXISTS doc_corpus (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    material_id TEXT NOT NULL,
    ord INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    hash TEXT NOT NULL DEFAULT '',
    chars INTEGER NOT NULL DEFAULT 0,
    vector BLOB,
    indexed_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_doc_corpus_project ON doc_corpus(project_id, material_id, ord);
  CREATE INDEX IF NOT EXISTS idx_doc_corpus_material ON doc_corpus(material_id);`);

  // ===== AI 评审机制（多厂商评审团）=====
  //
  // 设计要点：评审对象是「作品」而不是「文档」或「小说」——两大工作台共用同一套
  // 评审表结构，靠 workbench + work_id + section_idx 定位，评审引擎本身不认识文档与小说。
  // 这样加第三个工作台时不用再写一套评审。
  db.exec(`CREATE TABLE IF NOT EXISTS review_panels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    workbench TEXT NOT NULL DEFAULT 'doc',
    doc_type TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS review_reviewers (
    id TEXT PRIMARY KEY,
    panel_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    channel_id TEXT NOT NULL DEFAULT '',
    model_label TEXT NOT NULL DEFAULT '',
    persona TEXT NOT NULL DEFAULT '',
    specialty TEXT NOT NULL DEFAULT '',
    style TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_review_reviewers_panel ON review_reviewers(panel_id, sort);
  CREATE TABLE IF NOT EXISTS review_skills (
    id TEXT PRIMARY KEY,
    reviewer_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'method',
    name TEXT NOT NULL DEFAULT '',
    applies_to TEXT NOT NULL DEFAULT '[]',
    body TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'user',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_review_skills_owner ON review_skills(reviewer_id, kind);
  CREATE TABLE IF NOT EXISTS review_rounds (
    id TEXT PRIMARY KEY,
    workbench TEXT NOT NULL DEFAULT 'doc',
    work_id TEXT NOT NULL DEFAULT '',
    section_idx INTEGER NOT NULL DEFAULT 0,
    target TEXT NOT NULL DEFAULT 'chapter',
    panel_id TEXT NOT NULL DEFAULT '',
    round_no INTEGER NOT NULL DEFAULT 1,
    version TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    score REAL,
    verdict TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL DEFAULT 0,
    report_json TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_review_rounds_work ON review_rounds(workbench, work_id, section_idx, round_no);
  CREATE TABLE IF NOT EXISTS review_opinions (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL,
    reviewer_id TEXT NOT NULL DEFAULT '',
    reviewer_name TEXT NOT NULL DEFAULT '',
    model_label TEXT NOT NULL DEFAULT '',
    score REAL,
    grade TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    highlights_json TEXT NOT NULL DEFAULT '[]',
    issues_json TEXT NOT NULL DEFAULT '[]',
    suggestions_json TEXT NOT NULL DEFAULT '[]',
    focus_json TEXT NOT NULL DEFAULT '[]',
    raw TEXT NOT NULL DEFAULT '',
    tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_review_opinions_round ON review_opinions(round_id);
  CREATE TABLE IF NOT EXISTS review_decisions (
    id TEXT PRIMARY KEY,
    round_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'single',
    dimension TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT 'minor',
    reviewers_json TEXT NOT NULL DEFAULT '[]',
    adopted INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    instruction TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_review_decisions_round ON review_decisions(round_id);
  CREATE TABLE IF NOT EXISTS review_reviewer_skills (
    reviewer_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (reviewer_id, skill_id)
  );
  CREATE INDEX IF NOT EXISTS idx_review_reviewer_skills_skill ON review_reviewer_skills(skill_id);`);

  // 评审轮次的补齐字段（幂等迁移：老库没有这些列时补上）。
  //   intent      评审时作者声明的创作意图（可行性评估要对照它判断「这条意见该不该采纳」）
  //   prev_score  上一轮均分（报告里要显示「评分变化」，只看单轮分数看不出有没有变好）
  //   before_text 落改前的正文（「保留修改前后对比」不能只留字数）
  //   after_text  落改后的正文
  const reviewRoundCols = tableCols('review_rounds');
  for (const [column, type] of [
    ['intent', `TEXT NOT NULL DEFAULT ''`],
    ['prev_score', 'REAL'],
    ['before_text', `TEXT NOT NULL DEFAULT ''`],
    ['after_text', `TEXT NOT NULL DEFAULT ''`],
    ['cancelled_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['target', `TEXT NOT NULL DEFAULT 'chapter'`],
    ['paused_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['resumed_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['apply_flag', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (reviewRoundCols.length && !reviewRoundCols.includes(column)) {
      db.exec(`ALTER TABLE review_rounds ADD COLUMN ${column} ${type}`);
    }
  }
  // 老库的文档评审记录没有 target（默认 chapter），但文档侧的评审对象是「小节」。
  // 不补这一条，迁移后文档的历史轮次会从列表里消失。
  db.exec(`UPDATE review_rounds SET target='section' WHERE workbench='doc' AND target='chapter'`);
  // 评审团可以设「最多几轮」：规范里终止条件之一是「达到用户设定的评审轮次」，
  // 没有这个字段就只能靠作者自己数。
  const reviewPanelCols = tableCols('review_panels');
  if (reviewPanelCols.length && !reviewPanelCols.includes('max_rounds')) {
    db.exec(`ALTER TABLE review_panels ADD COLUMN max_rounds INTEGER NOT NULL DEFAULT 0`);
  }
  // 维度权重：方案 7.2「各维度权重（默认均等，可配置）」。
  // 存成 JSON，如 {"论证论据":2,"逻辑结构":1.5}；为空表示各维度等权。
  const reviewSkillCols = tableCols('review_skills');
  if (reviewSkillCols.length && !reviewSkillCols.includes('weights')) {
    db.exec(`ALTER TABLE review_skills ADD COLUMN weights TEXT NOT NULL DEFAULT ''`);
  }
  // 停用不等于删除：作者想暂时不用某条标准时，直接删掉会丢掉正文与绑定关系，
  // 之后再想恢复只能重写一遍。
  if (reviewSkillCols.length && !reviewSkillCols.includes('enabled')) {
    db.exec(`ALTER TABLE review_skills ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`);
  }
  // 评审员给出的分维度得分：有权重时，总分由系统按维度加权算出，不采信模型自报的总分。
  const reviewOpinionCols = tableCols('review_opinions');
  if (reviewOpinionCols.length && !reviewOpinionCols.includes('dimensions_json')) {
    db.exec(`ALTER TABLE review_opinions ADD COLUMN dimensions_json TEXT NOT NULL DEFAULT '[]'`);
  }
  // 评审员给出的优先级排序：规范 5.2 要求「按对作品质量提升的贡献度排序」，
  // 之前只存在 raw 原文里，报告页与落改都用不上。
  if (reviewOpinionCols.length && !reviewOpinionCols.includes('priority_json')) {
    db.exec(`ALTER TABLE review_opinions ADD COLUMN priority_json TEXT NOT NULL DEFAULT '[]'`);
  }
  // 每条决策的具体改法：由评审员的 suggestions（改什么/怎么改/为什么）转化而来，
  // 报告页要能追溯「这条意见最终准备怎么改」，而不只是问题原文。
  const reviewDecisionCols = tableCols('review_decisions');
  if (reviewDecisionCols.length && !reviewDecisionCols.includes('suggestions_json')) {
    db.exec(`ALTER TABLE review_decisions ADD COLUMN suggestions_json TEXT NOT NULL DEFAULT '[]'`);
  }

  // 论文要素：作者、单位、关键词、分类号、基金、英文题名与摘要——投稿首页那一整套。
  if (docProjCols2.length && !docProjCols2.includes('meta_json')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}'`);
  }
  // 文献矩阵：从摘要里抽出的「方法/样本/结论/局限」，文献综述的骨架。
  if (docProjCols2.length && !docProjCols2.includes('lit_json')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN lit_json TEXT NOT NULL DEFAULT '{}'`);
  }
  // 方法论审查结果（识别策略/样本/测量/稳健性/伦理/结论边界）
  if (docProjCols2.length && !docProjCols2.includes('method_json')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN method_json TEXT NOT NULL DEFAULT '{}'`);
  }
  // 选题体检结果（可证伪性 / 文献重叠 / 数据可得性 / 贡献陈述）
  if (docProjCols2.length && !docProjCols2.includes('topic_json')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN topic_json TEXT NOT NULL DEFAULT '{}'`);
  }
  // 文体专项检查结果（BP 财务/申报书指标/合同条款/调研样本）
  if (docProjCols2.length && !docProjCols2.includes('type_json')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN type_json TEXT NOT NULL DEFAULT '{}'`);
  }
  // BP 财务模型输入（假设）与最近一次计算结果
  if (docProjCols2.length && !docProjCols2.includes('finance_json')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN finance_json TEXT NOT NULL DEFAULT '{}'`);
  }
  // 模板绑定：选了模板的项目要记住「按哪个模板写」。
  // 只把结构复制到 doc_sections 里是不够的——那样项目自己不知道有模板，
  // 后续改版式、重出计划、导出都没法回到「严格沿用模板」这个前提上。
  if (docProjCols2.length && !docProjCols2.includes('template_id')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN template_id TEXT NOT NULL DEFAULT ''`);
  }
  // 粘贴模板（没有已蒸馏模板 id）时留一个名字，用来区分「按模板写」与「自由写」
  if (docProjCols2.length && !docProjCols2.includes('template_name')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN template_name TEXT NOT NULL DEFAULT ''`);
  }
  // 模板蒸馏出的文风技法（结构要点 + 写法）。
  // 没有它，模板只贡献了「目录 + 版式」，最关键的「怎么写」在写作时完全用不上。
  if (docProjCols2.length && !docProjCols2.includes('template_notes')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN template_notes TEXT NOT NULL DEFAULT ''`);
  }
  // 自动分析预设：指定「哪一节用哪份数据、因变量是谁、自变量有哪几个」。
  // 有了它，全托管起草到「结果与分析」时能自己跑回归、自己把三线表插进去，
  // 而不是等作者手动点一次分析。
  if (docProjCols2.length && !docProjCols2.includes('analysis_json')) {
    db.exec(`ALTER TABLE doc_projects ADD COLUMN analysis_json TEXT NOT NULL DEFAULT '{}'`);
  }
  migrateWordStats();
  // 技能表：老库是历史版本建的，新库没人建——技能广场会直接报 no such table。
  // 这里补一条 CREATE IF NOT EXISTS（结构沿用既有库，别改字段语义）。
  db.exec(`CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
    prompt_template TEXT, kind TEXT, source TEXT, enabled INTEGER DEFAULT 1,
    builtin_key TEXT,
    usage_mode TEXT NOT NULL DEFAULT 'support'
      CHECK(usage_mode IN ('primary','support','standalone')),
    targets_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(targets_json)),
    origin TEXT NOT NULL DEFAULT 'user'
      CHECK(origin IN ('official','user','imported','decompose')),
    capabilities_json TEXT
      CHECK(capabilities_json IS NULL OR json_valid(capabilities_json)),
    domain TEXT NOT NULL DEFAULT 'novel'
  )`);
  // 内置文档技能：启动时幂等补齐（按 builtin_key 判重）。
  // 之前只在手工跑 scripts/seed-doc-skills.cjs 时才有，新库的技能广场是空的，
  // 「技能不完整」说的就是这个。放在迁移里保证每次启动都齐。
  try {
    const { seedDocSkills } = require('../scripts/seed-doc-skills.cjs');
    seedDocSkills(db);
  } catch (err) {
    // 技能只是增强项，写不进去不能把服务启不起来
    console.error('[db] 内置文档技能补齐失败：' + (err && err.message));
  }
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

// 事务深度：SQLite 不支持嵌套 BEGIN，直接再开一个会抛
// 「cannot start a transaction within a transaction」。
// 嵌套调用并入外层事务（内层失败由外层统一回滚）——
// 这比让调用方自己判断「我在不在事务里」可靠：那种判断迟早会漏一处，
// 而漏掉的那一处只会在生产环境的数据量下才触发。
let txDepth = 0;

function transaction(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth += 1;
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (ignored) {}
    throw error;
  } finally {
    txDepth -= 1;
  }
}

function close() {
  if (!db) return;
  db.close();
  db = null;
}

module.exports = { open, close, q, one, run, exec, transaction, tableCols, DATA_DIR, BASE_DATA_DIR, DB_PATH, RESOURCES_DIR, BUNDLED_SEED, ensureDataAssets };
