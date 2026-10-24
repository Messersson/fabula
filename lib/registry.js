// IPC 命令总表：把全部命令映射到 handler。未知命令默认返回 null（避免 UI 报错）。
'use strict';
const { q, one, run, exec } = require('./db');
const core = require('./handlers-core');
const comai = require('./handlers-ai');
const mis = require('./handlers-misc');
const src = require('./handlers-sources');
const llm = require('./llm');
const pk = require('./prompts');
const knowledge = require('./vector-store');
const { assertInside, resolveAllowedPath, atomicWriteFileSync, safeFileName } = require('./fs-safe');

const offline = (msg) => { const e = new Error(msg || '离线复刻版不支持'); throw e; };

// 直接渠道 Provider 预设（镜像前端 Dl() 期望的结构）
const REASONING_MODES = [
  { id: 'auto', label: '自动', description: '自动按任务选择档位' },
  { id: 'fast', label: '快速', description: '轻量思考，速度优先' },
  { id: 'deep', label: '深入', description: '高强度思考' },
  { id: 'max', label: '极致', description: '最大强度思考' },
];
const PROFILES = [
  { id: 'deepseek-official', version: 1, adapterId: 'deepseek-official', canonicalModelId: 'deepseek-chat', displayName: 'DeepSeek', officialBaseUrl: 'https://api.deepseek.com', altOfficialBaseUrls: [], contextWindowTokens: 128000, maxOutputTokens: 8192, reasoningModes: REASONING_MODES, autoPolicy: { instant: 'fast', writing: 'deep', planning: 'deep', analysis: 'deep', heavy: 'max' }, samplingPolicy: 'omit', paramStrategy: 'full-effort', capabilities: { searchTransport: '', serverTools: [] }, baseUrl: '', modelsUrl: '', model: 'deepseek-chat' },
  { id: 'kimi-official', version: 1, adapterId: 'moonshot-official', canonicalModelId: 'moonshot-v1-8k', displayName: 'Kimi（月之暗面）', officialBaseUrl: 'https://api.moonshot.cn', altOfficialBaseUrls: [], contextWindowTokens: 32768, maxOutputTokens: 8192, reasoningModes: REASONING_MODES, autoPolicy: { instant: 'fast', writing: 'deep', planning: 'deep', analysis: 'deep', heavy: 'max' }, samplingPolicy: 'omit', paramStrategy: 'full-effort', capabilities: { searchTransport: '', serverTools: [] }, baseUrl: '', modelsUrl: '', model: 'moonshot-v1-8k' },
  { id: 'qwen-official', version: 1, adapterId: 'dashscope-official', canonicalModelId: 'qwen-plus', displayName: '通义千问', officialBaseUrl: 'https://dashscope.aliyuncs.com', altOfficialBaseUrls: [], contextWindowTokens: 131072, maxOutputTokens: 8192, reasoningModes: REASONING_MODES, autoPolicy: { instant: 'fast', writing: 'deep', planning: 'deep', analysis: 'deep', heavy: 'max' }, samplingPolicy: 'omit', paramStrategy: 'full-effort', capabilities: { searchTransport: '', serverTools: [] }, baseUrl: '', modelsUrl: '', model: 'qwen-plus' },
  { id: 'glm-official', version: 1, adapterId: 'glm-official', canonicalModelId: 'glm-4.5', displayName: '智谱 GLM', officialBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', altOfficialBaseUrls: ['https://open.bigmodel.cn/api/coding/paas/v4'], contextWindowTokens: 200000, maxOutputTokens: 8192, reasoningModes: REASONING_MODES, autoPolicy: { instant: 'fast', writing: 'deep', planning: 'deep', analysis: 'deep', heavy: 'max' }, samplingPolicy: 'omit', paramStrategy: 'full-effort', capabilities: { searchTransport: '', serverTools: [] }, baseUrl: '', modelsUrl: '', model: 'glm-4.5' },
  { id: 'volcengine-official', version: 1, adapterId: 'ark-official', canonicalModelId: 'deepseek-v3', displayName: '火山方舟', officialBaseUrl: 'https://ark.cn-beijing.volces.com', altOfficialBaseUrls: [], contextWindowTokens: 65536, maxOutputTokens: 8192, reasoningModes: REASONING_MODES, autoPolicy: { instant: 'fast', writing: 'deep', planning: 'deep', analysis: 'deep', heavy: 'max' }, samplingPolicy: 'omit', paramStrategy: 'full-effort', capabilities: { searchTransport: '', serverTools: [] }, baseUrl: '', modelsUrl: '', model: 'deepseek-v3' },
  { id: 'minimax-official', version: 1, adapterId: 'minimax-official', canonicalModelId: 'MiniMax-Text-01', displayName: 'MiniMax', officialBaseUrl: 'https://api.minimaxi.com', altOfficialBaseUrls: [], contextWindowTokens: 245760, maxOutputTokens: 8192, reasoningModes: REASONING_MODES, autoPolicy: { instant: 'fast', writing: 'deep', planning: 'deep', analysis: 'deep', heavy: 'max' }, samplingPolicy: 'omit', paramStrategy: 'full-effort', capabilities: { searchTransport: '', serverTools: [] }, baseUrl: '', modelsUrl: '', model: 'MiniMax-Text-01' },
  { id: 'siliconflow-official', version: 1, adapterId: 'siliconflow-official', canonicalModelId: 'deepseek-ai/DeepSeek-V3', displayName: '硅基流动', officialBaseUrl: 'https://api.siliconflow.cn', altOfficialBaseUrls: [], contextWindowTokens: 65536, maxOutputTokens: 8192, reasoningModes: REASONING_MODES, autoPolicy: { instant: 'fast', writing: 'deep', planning: 'deep', analysis: 'deep', heavy: 'max' }, samplingPolicy: 'omit', paramStrategy: 'full-effort', capabilities: { searchTransport: '', serverTools: [] }, baseUrl: '', modelsUrl: '', model: 'deepseek-ai/DeepSeek-V3' },
  { id: 'openai-official', version: 1, adapterId: 'openai-official', canonicalModelId: 'gpt-4o-mini', displayName: 'OpenAI', officialBaseUrl: 'https://api.openai.com', altOfficialBaseUrls: [], contextWindowTokens: 128000, maxOutputTokens: 16384, reasoningModes: REASONING_MODES, autoPolicy: { instant: 'fast', writing: 'deep', planning: 'deep', analysis: 'deep', heavy: 'max' }, samplingPolicy: 'omit', paramStrategy: 'full-effort', capabilities: { searchTransport: '', serverTools: [] }, baseUrl: '', modelsUrl: '', model: 'gpt-4o-mini' },
  { id: 'custom', version: 1, adapterId: 'custom', canonicalModelId: '', displayName: '自定义（OpenAI 兼容）', officialBaseUrl: '', altOfficialBaseUrls: [], contextWindowTokens: 0, maxOutputTokens: 0, reasoningModes: REASONING_MODES, autoPolicy: { instant: 'fast', writing: 'deep', planning: 'deep', analysis: 'deep', heavy: 'max' }, samplingPolicy: 'omit', paramStrategy: 'full-effort', capabilities: { searchTransport: '', serverTools: [] }, baseUrl: '', modelsUrl: '', model: '' },
];

function directModelProfiles() {
  return { catalogVersion: 'replica-1', updatedAt: Date.now(), profiles: PROFILES.map((p) => ({ ...p })) };
}

// ---------- 设置 ----------
function setSettings(args) {
  // The web client sends bulk updates as { entries: { ... } } while older
  // callers use { settings: { ... } } or pass the settings object directly.
  const payload = args && typeof args === 'object' ? args : {};
  const obj = [payload.entries, payload.settings].find((value) => value && typeof value === 'object' && !Array.isArray(value)) || payload;
  for (const [k, v] of Object.entries(obj)) {
    if (!k || k === 'args') continue;
    core.setSetting(k, v != null && typeof v === 'object' ? JSON.stringify(v) : v);
  }
  return core.getSettings();
}
function setSetting({ key, value }) {
  core.setSetting(key, value);
  return { ok: true };
}

// ---------- 渠道 ----------
function setChannelKey({ id, key }) {
  core.setSetting('channel_key__' + id, key || '');
  // 同步标记到 channels 列表
  try {
    const { channels } = llm.allSettings();
    const cs = channels.map((c) => (c.id === id ? { ...c, key: !!key } : c));
    core.setSetting('channels', JSON.stringify(cs));
  } catch (e) {}
  return { ok: true };
}
function deleteChannelKey({ id }) {
  core.setSetting('channel_key__' + id, '');
  // Keep the denormalized channel flag in sync with the actual key store.
  try {
    const { channels } = llm.allSettings();
    const cs = channels.map((c) => (c.id === id ? { ...c, key: false } : c));
    core.setSetting('channels', JSON.stringify(cs));
  } catch (e) {}
  return { ok: true };
}
// 前端严格 === true 判定，必须返回纯布尔
function hasChannelKey({ id }) { return !!llm.channelKey(id); }
function hasApiKey() { return !!llm.hasAnyKey(); }

// ---------- 书 ----------
function createBook({ title, genre, pov, status, coverChar }) {
  return core.createBook({ title, genre: genre || '', pov: pov || '', status: status || '连载中', coverChar: coverChar || '' });
}
// 中文数字解析：'第一章'→1、'第十三章'→13、'一百零五'→105
function zhNum(s) {
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const map = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000 };
  let r = 0, cur = 0;
  for (const ch of s) {
    const v = map[ch];
    if (v == null) return NaN;
    if (v >= 10) { r += (cur || 1) * v; cur = 0; }
    else cur = v;
  }
  return r + cur;
}
function maxChapterNum(files) {
  let max = 0;
  let unnumbered = 0;
  for (const f of files) {
    const name = String(f.name || '');
    const m = /第\s*([0-9一二三四五六七八九十百千零两]+)\s*章/.exec(name);
    if (m) {
      const n = zhNum(m[1]);
      if (!Number.isNaN(n)) max = Math.max(max, n);
    } else if (/\.(md|txt)$/i.test(name) && !/^全文\.(md|txt)$/i.test(name)) {
      unnumbered += 1;
    }
  }
  if (max === 0 && unnumbered > 0) return unnumbered;
  return max;
}
function getNextChapterState({ bookId }) {
  const t = core.scanTree({ bookId });
  const ch = t.find((g) => g.groupDir === '正文') || { files: [] };
  const targetChapter = maxChapterNum(ch.files) + 1;
  const outline = t.find((g) => g.groupDir === '细纲') || { files: [] };
  const outlineName = outline.files.find((f) => {
    const n = zhNum((/第\s*([0-9一二三四五六七八九十百千零两]+)\s*章/.exec(f.name) || [])[1]);
    return !Number.isNaN(n) && n === targetChapter;
  })?.name || null;
  return { targetChapter, outlineName };
}
function getNextSectionState({ bookId }) {
  const t = core.scanTree({ bookId });
  const g = t.find((x) => x.groupDir === '细纲') || { files: [] };
  return maxChapterNum(g.files.map((f) => ({ name: f.name }))) + 1;
}

// ---------- 应用搭建 / 章节 ----------
function applyBookSetup({ bookId, title, genre, files, messageId }) {
  if (title || genre) core.updateBookMeta({ bookId, ...(title ? { title } : {}), ...(genre ? { genre } : {}) });
  for (const f of files || []) {
    core.writeFileTo({ bookId, group: (f.groupDir || f.group || '设定'), name: f.name, content: f.content || '' });
  }
  const required = ['世界观.md', '人物库.md', '剧情大纲.md'];
  const settingFiles = core.scanTree({ bookId }).find((g) => g.groupDir === '设定') || { files: [] };
  const allReady = required.every((name) => {
    const file = settingFiles.files.find((item) => item.name === name);
    return !!file && String(core.readFileFrom({ bookId, group: '设定', name }) || '').trim().length >= 80;
  });
  if (messageId) {
    const msg = one(`SELECT result_json FROM messages WHERE id=?`, messageId);
    let result = null;
    try { result = msg && msg.result_json ? JSON.parse(msg.result_json) : null; } catch (e) {}
    if (result && result.bookSetup) {
      result.bookSetup.saved = allReady;
      run(`UPDATE messages SET result_json=?, updated_at=? WHERE id=?`, JSON.stringify(result), Date.now(), messageId);
      return JSON.stringify(result);
    }
    run(`UPDATE messages SET updated_at=? WHERE id=?`, Date.now(), messageId);
  }
  return JSON.stringify({ ok: true, bookSetup: { saved: allReady, titles: title ? [title] : [], genre: genre || '', files: files || [] } });
}

// ---------- 风格 ----------
const GENRE_LABELS = {
  danvzhu: '大女主', dushi: '都市', gaowu: '高武', guyan: '古代言情', kehuan: '科幻',
  kuaichuan: '快穿穿书', lishi: '历史', moshi: '末世', niandai: '年代种田', nvshengcun: '女频悬疑末世',
  tongyong: '通用', xuanhuan: '玄幻', xuanyi: '悬疑', yanqing: '言情', youxi: '游戏',
};
function listGenreStyles() {
  const p = pk.prompts();
  return Object.keys(p)
    .filter((k) => k.startsWith('genre__'))
    .map((k) => ({ key: k.slice(7), label: GENRE_LABELS[k.slice(7)] || k.slice(7), text: p[k] }));
}

// ---------- 归档备份/诊断 ----------
function exportDiagnostics({ destPath } = {}) {
  const s = { ...core.getSettings() };
  for (const k of Object.keys(s)) if (/key|token|authorization/i.test(k)) s[k] = '***';
  const content = JSON.stringify({
    app: 'Fabula', os: process.platform, node: process.version,
    books: core.listBooks().length, skills: q('SELECT COUNT(*) c FROM skills')[0].c,
    settings: s,
  }, null, 2);
  if (destPath) {
    const path = require('path');
    const target = resolveAllowedPath(destPath, { mode: 'write', label: '诊断文件路径' });
    atomicWriteFileSync(target, content, { encoding: 'utf-8' });
    return { ok: true, path: target, file: path.basename(target), content };
  }
  return { ok: true, file: 'diagnostics.txt', content };
}
function readExportFile({ path: p }) {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(require('./db').DATA_DIR, 'exports');
  let resolved;
  try {
    resolved = assertInside(root, path.resolve(String(p || '')), '导出文件路径');
  } catch (error) {
    throw new Error('导出文件不存在或不可访问');
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error('导出文件不存在或不可访问');
  }
  return { name: path.basename(resolved), data: fs.readFileSync(resolved).toString('base64') };
}
function resetAllData() {
  exec(`DELETE FROM books; DELETE FROM sessions; DELETE FROM messages; DELETE FROM book_meta; DELETE FROM word_stats; DELETE FROM kb_chunks; DELETE FROM kb_files;`);
  try { require('./vector-store').clearCache(); } catch (error) { /* 缓存清理失败不影响重置 */ }
  const fs = require('fs');
  const path = require('path');
  for (const folder of ['books', 'versions', 'trash', 'exports', 'asset_updates']) {
    const dir = path.join(require('./db').DATA_DIR, folder);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
  return { ok: true };
}

// ---------- 拆书流程 ----------
function decomposeSingle(args, ctx) { return comai.decomposeNovel(args, ctx); }

// ---------- 导出 txt ----------
function exportTxt({ bookId, mode, destDir }) {
  const r = core.exportTxt({ bookId, mode });
  if (destDir) {
    const path = require('path');
    const book = one(`SELECT title FROM books WHERE id=?`, bookId);
    try {
      const fp = resolveAllowedPath(path.join(destDir, `${safeFileName((book && book.title) || 'book', 'book')}.txt`), { mode: 'write', label: '导出文本路径' });
      atomicWriteFileSync(fp, r.content, { encoding: 'utf-8' });
      return fp;
    } catch (error) {
      if (error.code !== 'PATH_NOT_ALLOWED') throw error;
    }
  }
  return r; // 浏览器模式：返回内容，由前端下载
}

function openLocalPath(target) {
  const fs = require('fs');
  const path = require('path');
  const { spawn } = require('child_process');
  const root = path.resolve(require('./db').DATA_DIR);
  const resolved = assertInside(root, path.resolve(String(target || '')), '打开路径');
  if (!fs.existsSync(resolved)) throw new Error('路径不存在');
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(command, [resolved], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, path: resolved };
}

// 交互保存（save_doc / save_section）落盘后补齐长期记忆（章节摘要/连续性），
// 否则 AI 共创写出的章节在两条写作路径里的世界状态会分叉。补齐失败不影响保存。
function saveDocAndRepair(args) {
  const result = core.saveDoc(args);
  try { mis.repairAfterBodySave(result); } catch (e) {}
  return result;
}

// 命令表
const TABLE = {
  // 设置
  get_settings: () => core.getSettings(),
  set_setting: setSetting,
  set_settings: setSettings,
  data_dir: () => mis.dataDir(),
  data_dir_info: mis.dataDirInfo,
  change_data_dir: mis.changeDataDir,
  open_data_dir: () => openLocalPath(require('./db').DATA_DIR),
  reveal_path: ({ path: target }) => openLocalPath(target),
  log_frontend_error: () => null,
  open_url: () => ({ ok: true }),
  app_os: () => 'win32',

  // 渠道 / 模型
  set_channel_key: setChannelKey,
  delete_channel_key: deleteChannelKey,
  has_channel_key: hasChannelKey,
  has_api_key: hasApiKey,
  list_models_channel: comai.listModelsChannel,
  list_models_ex: comai.listModelsEx,
  direct_model_profiles: directModelProfiles,
  test_chat_ex: comai.testChatEx,
  llm_catalog: mis.llmCatalog,
  llm_balance: () => ({ enabled: false, totalRemaining: 0, packs: [] }),
  llm_usage: () => ({ usage: [], items: [] }),
  llm_orders: () => ({ orders: [], items: [] }),
  trial_signup_enabled: () => false,
  license_status: mis.licenseStatus,
  check_feature: mis.checkFeature,

  // 本地知识库 / 向量检索
  knowledge_status: ({ bookId }) => knowledge.stats({ bookId }),
  rebuild_knowledge_index: ({ bookId }) => knowledge.rebuildBook({ bookId }),
  refresh_knowledge_aliases: ({ bookId }) => ({ ok: true, aliases: knowledge.refreshAliases(bookId, { force: true }) }),
  search_knowledge: async ({ bookId, query, limit }) => {
    const prepared = await knowledge.prepareRetrieval(bookId, query);
    return knowledge.retrieve({ bookId, query, limit: Number(limit) || 8,
      queryVector: prepared ? prepared.queryVector : null });
  },
  get_embedding_config: ({ bookId }) => knowledge.embeddingStatus({ bookId }),
  set_embedding_config: ({ model, baseUrl, apiKey } = {}) => {
    // 空模型 = 关闭语义召回，回落本地引擎；baseUrl/key 留空则跟随当前渠道。
    core.setSetting('embedding_model', String(model || '').trim());
    if (baseUrl !== undefined) core.setSetting('embedding_base_url', String(baseUrl || '').trim());
    if (apiKey !== undefined) core.setSetting('embedding_api_key', String(apiKey || ''));
    // 改配置意味着要重试：清掉接口失败的冷却。
    knowledge.resetEmbeddingFailures();
    return knowledge.embeddingStatus({});
  },
  prime_embeddings: async ({ bookId, maxTexts } = {}) => {
    if (!bookId) throw new Error('缺少 bookId');
    return knowledge.primeEmbeddings(String(bookId), { maxTexts: Number(maxTexts) || undefined });
  },

  // 书
  list_books: core.listBooks,
  create_book: createBook,
  update_book_meta: ({ bookId, ...f }) => core.updateBookMeta({ bookId, ...f }),
  delete_book: core.deleteBook,
  list_trash: ({ bookId }) => bookId ? core.listFileTrash({ bookId }) : core.listTrash(),
  restore_trash: ({ bookId, id }) => bookId ? core.restoreFileTrash({ bookId, id }) : core.restoreTrash({ id }),
  clear_trash: ({ bookId }) => bookId ? core.clearFileTrash({ bookId }) : core.clearTrash(),
  set_book_cover: ({ bookId, char, coverChar }) => core.setBookCover({ bookId, char: char || coverChar }),
  get_book_style: core.getBookStyle,
  set_book_style: core.setBookStyle,
  get_book_meta: ({ bookId }) => core.getBookMeta(bookId),
  set_book_humanize: core.setBookHumanize,
  set_book_primary_skill: core.setBookPrimarySkill,
  set_book_support_skills: core.setBookSupportSkills,
  get_book_plan_settings: core.getBookPlanSettings,
  set_book_plan_settings: core.setBookPlanSettings,
  save_lead: core.saveLead,
  apply_book_setup: applyBookSetup,
  get_next_chapter_state: getNextChapterState,
  get_next_section_state: getNextSectionState,

  // 会话 / 消息
  list_sessions: core.listSessions,
  create_session: core.createSession,
  rename_session: core.renameSession,
  delete_session: core.deleteSession,
  list_messages: core.listMessages,
  search_messages: core.searchMessages,
  search_book: core.searchBook,
  create_scene_message: core.createSceneMessage,
  refresh_empty_scene_messages: core.refreshEmptySceneMessages,
  update_scene_plan: core.updateScenePlan,
  update_arc_plan: core.updateArcPlan,

  // AI
  chat_stream: comai.chatStream,
  abort_chat: comai.abortChat,
  gen_session_title: comai.genSessionTitle,
  inline_chat: (a, ctx) => comai.inlineHelper(a, ctx, 'chat'),
  inline_assist: (a, ctx) => comai.inlineHelper(a, ctx, 'assist'),
  distill_style_stream: comai.distillStyleStream,
  redistill_book_style: comai.distillStyleStream,
  gen_style_sample: comai.genStyleSample,
  list_genre_styles: listGenreStyles,
  check_sensitive: comai.checkSensitive,
  read_sensitive_words: comai.readSensitiveWords,
  list_sensitive_words: comai.readSensitiveWords,
  write_sensitive_words: comai.writeSensitiveWords,

  // 大纲 / 场景
  gen_chapter_outline: mis.genChapterOutline,
  batch_generate_outlines: mis.batchGenerateOutlines,
  batch_generate_bodies: mis.batchGenerateBodies,
  batch_generate_full: mis.batchGenerateFull,
  cancel_batch: mis.cancelBatch,
  generation_run_status: mis.generationRunStatus,
  resume_generation_run: mis.resumeGenerationRun,
  run_consistency_audit: mis.runConsistencyAudit,
  get_world_rules: mis.getWorldRules,
  save_world_rule: mis.saveWorldRule,
  delete_world_rule: mis.deleteWorldRule,
  get_canon_events: mis.getCanonEvents,
  save_canon_event: mis.saveCanonEvent,
  delete_canon_event: mis.deleteCanonEvent,
  save_arc_plan: mis.saveArcPlan,
  gen_scene_body: mis.genSceneBody,
  assemble_scene_doc: mis.assembleSceneDoc,
  save_section: (args) => saveDocAndRepair({ bookId: args.bookId, messageId: args.messageId, draft: (args.op && args.op.draft) || null, replace: (args.op && args.op.replace) || null }),
  save_doc: (args) => saveDocAndRepair(args),

  // 拆书
  decompose_novel: decomposeSingle,
  pending_decompose: mis.pendingDecompose,
  save_decompose_report: comai.saveDecomposeReport,
  save_decompose_as_skill: mis.saveDecomposeAsSkill,
  save_capability_doc: mis.saveCapabilityDoc,

  // 技能
  list_skills: mis.listSkills,
  create_skill: mis.createSkill,
  update_skill: mis.updateSkill,
  delete_skill: mis.deleteSkill,
  set_skill_enabled: mis.setSkillEnabled,
  read_skill_ref: mis.readSkillRef,
  write_skill_ref: mis.writeSkillRef,
  read_skill_script: mis.readSkillScript,
  set_skill_script_authorization: mis.setSkillScriptAuthorization,
  draft_skill: comai.draftSkill,
  create_skill_from_draft: mis.createSkillFromDraft,
  test_run_skill_script: mis.testRunSkillScript,
  test_run_draft_script: mis.testRunDraftScript,
  export_skill_md: mis.exportSkillMd,
  export_skill_bundle: mis.exportSkillBundle,
  inspect_skill_bundle: mis.inspectSkillBundle,
  install_skill_bundle: mis.installSkillBundle,
  report_online_skill_download: mis.reportOnlineSkillDownload,

  // 文件树
  scan_tree: core.scanTree,
  create_folder: core.createFolder,
  rename_folder: mis.renameFolder,
  delete_folder: mis.deleteFolder,
  create_file: core.createFile,
  read_file: ({ bookId, group, name }) => core.readFileFrom({ bookId, group, name }) || '',
  write_file: core.writeFileTo,
  rename_file: core.renameFile,
  delete_file: core.deleteFile,
  set_file_ai_flag: core.setFileAiFlag,
  list_versions: core.listVersions,
  restore_version: core.restoreVersion,
  chapter_asset_footprint: mis.chapterAssetFootprint,
  apply_asset_update: mis.applyAssetUpdate,
  regen_arc_chapter: mis.regenArcChapter,
  evaluate_direct_model: mis.evaluateDirectModel,
  inspect_skill_md: mis.inspectSkillMd,
  rollback_chapter_assets: mis.rollbackChapterAssets,

  // 书源
  list_book_sources: src.listBookSources,
  sync_book_sources: src.syncBookSources,
  search_books: src.searchBooks,
  fetch_book_catalog: src.fetchBookCatalog,
  fetch_chapter_texts: src.fetchChapterTexts,

  // 导入导出
  import_book: ({ title, files, genre }) => core.importBook({ title, files, genre }),
  import_book_zip: mis.importBookZip,
  import_analyze: mis.importAnalyze,
  read_import_folder: mis.readImportFolder,
  pending_import: mis.pendingImports,
  export_txt: exportTxt,
  export_book_zip: mis.exportBookZip,
  export_all_data: mis.exportAllData,
  export_diagnostics: exportDiagnostics,
  read_export_file: readExportFile,
  reset_all_data: resetAllData,

  // 统计
  get_writing_stats: core.getWritingStats,
  refresh_word_stats: core.refreshWords,

  // 账号（离线降级）
  account_status: mis.accountStatus,
  account_logout: mis.accountLogout,
  account_login: () => mis.offlineErr(),
  account_register: () => mis.offlineErr(),
  account_send_code: () => mis.offlineErr(),
  account_reset_password: () => mis.offlineErr(),
  account_set_nickname: () => mis.offlineErr(),
  account_sync: () => ({ ok: true, synced: 0, changes: 0 }),

  // 支付（离线降级）
  payment_plans: () => ({ salesEnabled: false, channels: [], items: [] }),
  payment_create_order: () => mis.offlineErr(),
  payment_cancel_order: () => ({ ok: true }),
  payment_pending_order: () => null,
  payment_qr_data_url: ({ url }) => url,

  // 广场（离线降级）
  plaza_home: () => ({ featured: [], hot: [], fresh: [] }),
  plaza_list: () => ({ total: 0, items: [] }),
  plaza_me: () => [],
  plaza_mine: () => [],
  plaza_detail: mis.plazaDetail,
  plaza_comments: () => ({ items: [] }),
  plaza_comment: () => mis.offlineErr(),
  plaza_comment_reply: () => mis.offlineErr(),
  plaza_comment_helpful: () => mis.offlineErr(),
  plaza_comment_report: () => mis.offlineErr(),
  plaza_submit: () => mis.offlineErr(),
  plaza_set_nickname: () => mis.offlineErr(),
  plaza_download_bundle: () => mis.offlineErr(),

  // 同步（离线降级）
  sync_status: () => ({ loggedIn: false, pendingChanges: 0, lastSyncedAt: null }),
  sync_upload: () => ({ rev: 0, uploaded: 0, deleted: 0 }),
  sync_download: () => ({ written: 0, conflictCopies: 0, removed: 0, skipped: 0 }),
  sync_cloud_books: () => [],
  sync_adopt_cloud_book: () => ({ written: 0, conflictCopies: 0, removed: 0, skipped: 0 }),
  sync_app_config: () => ({ ok: true }),
  cloud_download_book: () => ({ ok: true }),

  // 更新器（离线）
  check_thread_update: () => null,
};

module.exports = { TABLE, PROFILES };
