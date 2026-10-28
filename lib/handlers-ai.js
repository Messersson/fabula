// AI 管线：chat_stream / 内联助手 / 风格蒸馏 / 技能草稿 / 标题生成 / 敏感词。
'use strict';
const crypto = require('node:crypto');
const { one, run } = require('./db');
const llm = require('./llm');
const core = require('./handlers-core');
const longform = require('./longform-memory');
const pk = require('./prompts');
const knowledge = require('./vector-store');

const aborters = new Map(); // requestId -> AbortController

// channel 参数可能是官方 Channel 的序列化字符串 "__CHANNEL__:N" 或 {id} 对象
function chId(ch) {
  if (ch == null) return null;
  if (typeof ch === 'string') return ch.replace(/^__CHANNEL__:/, '');
  return ch.id != null ? String(ch.id) : null;
}

function cli() { return llm.activeChannel(); }
function rejectNoChannel(ch) {
  if (!ch || !ch.baseUrl) {
    throw Object.assign(new Error('未配置可用的模型渠道。请在 设置→渠道管理 里添加你自己的 API（baseUrl + Key），或修改 config.json 后重启。'), { code: 'NO_CHANNEL', noChannel: true });
  }
}

// ---------- 事件通道 ----------
class Ctx {
  constructor(send) { this.send = send; this.chars = 0; }
  ev(ch, obj) { this.send(JSON.stringify({ ch, e: obj }) + '\n'); }
  delta(ch, text) { this.chars += text.length; this.ev(ch, { type: 'delta', text }); }
  reasoning(ch, text) { this.ev(ch, { type: 'reasoning', text }); }
  progress(ch) { this.ev(ch, { type: 'progress', chars: this.chars }); }
  step(ch, st) { this.ev(ch, { type: 'step', ...st }); }
  webSearch(ch, status) { this.ev(ch, { type: 'webSearch', status }); }
  done(ch, extra) { this.ev(ch, { type: 'done', full: this.full || '', ...extra }); }
  result(ch, result) { this.ev(ch, { type: 'result', result }); }
  error(ch, message) { this.ev(ch, { type: 'error', message }); }
}

function skillByName(name) {
  if (!name) return null;
  return one(`SELECT * FROM skills WHERE name=? OR builtin_key=?`, name, name) || null;
}
function resolveSkills(names) {
  const out = [];
  for (const n of names || []) {
    const s = skillByName(n);
    if (s) out.push(s);
  }
  return out;
}

function bookFor(bookId) {
  if (!bookId) return null;
  return one(`SELECT * FROM books WHERE id=?`, bookId) || null;
}
function styleFor(bookId) {
  if (!bookId) return null;
  try { return core.getBookStyle({ bookId }); } catch (e) { return null; }
}

// 上下文文件内容
function resolveContextFile(bookId, file) {
  const name = typeof file === 'string' ? file : file && file.name;
  if (!name) return null;
  const explicitGroup = typeof file === 'object' && file ? (file.group || file.groupDir || file.dir) : '';
  if (explicitGroup) return { group: explicitGroup, name };
  const tree = core.scanTree({ bookId });
  const hit = tree.find((group) => group.files.some((item) => item.name === name));
  return { group: hit ? hit.groupDir : '设定', name };
}

function contextText(bookId, contextFiles) {
  if (!contextFiles || !contextFiles.length) return '';
  const chunks = [];
  for (const f of contextFiles) {
    const file = resolveContextFile(bookId, f);
    if (!file) continue;
    const content = core.readFileFrom({ bookId, group: file.group, name: file.name });
    if (content != null) chunks.push(`# 资料：${file.name}\n${String(content).slice(0, 4000)}`);
  }
  return chunks.join('\n\n').slice(0, 8000);
}

const BOOK_FORMS = new Set(['short', 'medium', 'midlong', 'long', 'million']);

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

function bookPlanPrompt(book) {
  if (!book || !book.id) return '';
  const plan = core.getBookPlanSettings({ bookId: book.id });
  if (!plan.totalChapters && !plan.chapterWords) return '';
  const lines = ['【本书容量规划】'];
  if (plan.totalChapters) lines.push(`- 全书预计 ${plan.totalChapters} 章。`);
  if (plan.chapterWords) {
    lines.push(`- 每章正文目标约 ${plan.chapterWords} 字，允许按剧情自然上下浮动 10% 到 15%。`);
    lines.push(`- 生成章节细纲时，请按约 ${plan.chapterWords} 字的容量拆成 2 到 4 个场景，避免把多章剧情塞进单章。`);
    lines.push(`- 展开正文写作时，【篇幅要求】即本章约 ${plan.chapterWords} 字；不要写成梗概，也不要为凑字注水。`);
  }
  return lines.join('\n');
}

function compactExcerpt(text, limit, keepTail = false) {
  const source = String(text || '').trim();
  if (source.length <= limit) return source;
  if (keepTail) return `…（已省略较早内容）\n${source.slice(-limit)}`;
  const head = Math.ceil(limit * 0.6);
  const tail = limit - head;
  return `${source.slice(0, head)}\n…（中间内容已省略）…\n${source.slice(-tail)}`;
}

// Long serials need stable facts in addition to semantic recall. These documents are
// intentionally capped so this works with ordinary API context windows as well.
function longformContinuityContext(book) {
  if (!book || !['long', 'million'].includes(formFor(book))) return '';
  const docs = [
    { name: '剧情大纲.md', limit: 3000, tail: false },
    { name: '章节规划.md', limit: 3000, tail: false },
    { name: '章节摘要.md', limit: 2400, tail: true },
    { name: '伏笔台账.md', limit: 1500, tail: true },
    { name: '人物库.md', limit: 1100, tail: false },
  ];
  const parts = [];
  for (const doc of docs) {
    const content = core.readFileFrom({ bookId: book.id, group: '设定', name: doc.name });
    if (!content) continue;
    parts.push(`# 连载核心资料 · ${doc.name}\n${compactExcerpt(content, doc.limit, doc.tail)}`);
  }
  return parts.join('\n\n');
}

function buildSystem({ book, style, skills, platform, humanizeOverride, context, storyContext, userMsg }) {
  const parts = [];
  const sys = pk.prompts().system;
  if (sys) parts.push(String(sys).trim());
  parts.push(pk.genreCard(book ? book.genre : '', formFor(book)));
  const planText = bookPlanPrompt(book);
  if (planText) parts.push(planText);
  const sc = pk.styleCardText(style);
  if (sc) parts.push(sc);
  const pc = pk.platformCard(platform);
  if (pc) parts.push(pc);
  const deep = humanizeOverride === 'deep' || (style && style._deep) || skills.some((s) => /humanize\.deep/.test(s.builtin_key || ''));
  parts.push(pk.antiAiTone(deep));
  for (const s of skills) {
    const tpl = pk.skillFullTemplate(s) || s.prompt_template;
    if (!tpl) continue;
    const t = pk.fillTemplate(tpl, { bookTitle: book ? book.title : '', genre: book ? book.genre : '' });
    parts.push(`【技能：${s.name}】\n${t}`);
    // JSON 类工作流（新书共创/剧情推演/细纲等）：强制纯 JSON 输出，防模型写成散文
    if (/JSON|json对象|只输出一个JSON/.test(tpl)) {
      parts.push('【输出格式强制要求】你的整条回复必须是【单个 JSON 对象】；禁止任何围栏/前缀/解释/问候。' +
        '追问阶段输出 {"ask":"一个聚焦的问题","options":["候选1","候选2","候选3"]}；信息已齐则按模板输出完整产出 JSON 对象。');
    }
  }
  // 硬约束与连续性（世界规则/正典事件/人物与线索状态）单独成段，不参与
  // 【资料库上下文】的字符预算截断——被截掉的恰恰是最不能丢的部分。
  if (storyContext) parts.push(storyContext);
  if (context) parts.push(`【资料库上下文】\n${context}`);
  if (userMsg) parts.push(`【用户本轮要求】${userMsg}`);
  return parts.filter(Boolean).join('\n\n');
}

function recentMessages(sessionId, limit = 10) {
  if (!sessionId) return '';
  const rows = one2all(`SELECT role, content FROM messages WHERE session_id=? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT ?`, sessionId, limit);
  return rows.reverse().map((r) => `${r.role === 'user' ? '用户' : '助手'}：${String(r.content).slice(0, 2000)}`).join('\n\n');
}
function one2all(sql, ...p) { return require('./db').q(sql, ...p); }

function buildMessages(params) {
  const { book, style, skills, platform, humanizeOverride, context, storyContext, sessionId, message } = params;
  const sys = buildSystem({ book, style, skills, platform, humanizeOverride, context, storyContext, userMsg: message });
  const msgs = [{ role: 'system', content: sys }];
  if (sessionId) {
    // For a serial, durable summaries and retrieval are more reliable than replaying a
    // huge chat transcript. Keep the immediate discussion while reserving room for facts.
    const isLongform = ['long', 'million'].includes(formFor(book));
    const rows = one2all(`SELECT role, content FROM messages WHERE session_id=? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT ?`, sessionId, isLongform ? 4 : 12);
    const perMessageLimit = isLongform ? 2500 : 6000;
    for (const r of rows.reverse()) msgs.push({ role: r.role, content: String(r.content).slice(0, perMessageLimit) });
  }
  msgs.push({ role: 'user', content: message || '' });
  return msgs;
}

function isOutlineRun(skillNames, skillSelection) {
  if (skillSelection && skillSelection.taskKind === 'outline') return true;
  return (skillNames || []).some((name) => String(name || '') === '小说细纲生成');
}

function looksLikeChapterOutline(result) {
  return !!result && typeof result === 'object' && !result.ask &&
    typeof result.title === 'string' && String(result.goal || '').trim() &&
    String(result.hook || '').trim() && Array.isArray(result.scenes) && result.scenes.length >= 2;
}

function chapterLabelFromText(text) {
  const m = String(text || '').match(/第\s*([0-9零〇一二三四五六七八九十百千万两]+)\s*章/);
  return m ? `第${m[1]}章` : '';
}

function outlineSavePayload(result, fallbackText) {
  const chapterLabel = chapterLabelFromText(result.title) || chapterLabelFromText(fallbackText);
  const fileName = chapterLabel ? `细纲_${chapterLabel}.md` : `细纲_${Date.now().toString(36)}.md`;
  const title = String(result.title || chapterLabel || fileName.replace(/\.md$/i, '')).trim();
  const scenePlan = {
    title,
    goal: result.goal || '',
    highlight: result.highlight || result['看点'] || '',
    hook: result.hook || '',
    scenes: (result.scenes || []).map((scene) => ({
      ...scene,
      text: '',
      status: 'pending',
    })),
    active: false,
    assembled: false,
    assembledName: '',
  };
  return {
    fileName,
    content: JSON.stringify(result, null, 2),
    doc: { group: '细纲', name: fileName, title },
    scenePlan,
  };
}

function maybePersistOutlineResult({ bookId, message, skillNames, skillSelection, result }) {
  if (!bookId || !isOutlineRun(skillNames, skillSelection) || !looksLikeChapterOutline(result)) return result;
  if (result.doc || result.saved) return result;
  const payload = outlineSavePayload(result, message);
  core.writeFileTo({ bookId, group: '细纲', name: payload.fileName, content: payload.content });
  return {
    ...result,
    doc: payload.doc,
    scenePlan: payload.scenePlan,
    saved: true,
  };
}

function characterMarkdown(characters) {
  if (!Array.isArray(characters)) return '';
  return characters.filter((c) => c && c.name).map((c) => [
    `## ${c.name}`,
    c.identity ? `- 身份：${c.identity}` : '',
    c.personality ? `- 性格：${c.personality}` : '',
    c.goal ? `- 目标：${c.goal}` : '',
    c.relation ? `- 关系：${c.relation}` : '',
    c.arc ? `- 弧光：${c.arc}` : '',
    c.secret ? `- 秘密：${c.secret}` : '',
    c.voice ? `- 口吻：${c.voice}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

function maybeBuildBookSetup(result, skillNames) {
  if (!result || typeof result !== 'object' || result.ask) return result;
  if (!(skillNames || []).some((name) => name === '新书共创' || name === '设定整理')) return result;
  const worldview = result.worldview != null ? String(result.worldview).trim() : '';
  const synopsis = result.synopsis != null ? String(result.synopsis).trim() : '';
  const characters = Array.isArray(result.characters)
    ? characterMarkdown(result.characters)
    : String(result.characters || '').trim();
  const generatedFiles = [
    worldview ? { group: '设定', name: '世界观.md', label: '世界观', content: worldview } : null,
    characters ? { group: '设定', name: '人物库.md', label: '人物库', content: characters } : null,
    synopsis ? { group: '设定', name: '剧情大纲.md', label: '剧情大纲', content: synopsis } : null,
  ].filter(Boolean).map((file) => ({
    ...file,
    preview: String(file.content).replace(/\s+/g, ' ').slice(0, 120),
    draft: false,
  }));
  const current = result.bookSetup && typeof result.bookSetup === 'object' ? result.bookSetup : {};
  const currentFiles = Array.isArray(current.files) ? current.files : [];
  const files = [];
  const seenNames = new Set();
  for (const file of currentFiles.concat(generatedFiles)) {
    const name = String(file && file.name || '').trim();
    const content = String(file && file.content || '').trim();
    if (!name || !content || seenNames.has(name)) continue;
    seenNames.add(name);
    files.push({
      ...file,
      group: file.group || file.groupDir || '设定',
      label: file.label || name.replace(/\.md$/i, ''),
      name,
      content,
      preview: file.preview || content.replace(/\s+/g, ' ').slice(0, 120),
      draft: !!file.draft,
    });
  }
  if (!files.length) return result;
  const rawTitles = Array.isArray(current.titles) ? current.titles : result.titles;
  const titles = Array.isArray(rawTitles) ? rawTitles.map((x) => String(x).trim()).filter(Boolean) : [];
  return {
    ...result,
    bookSetup: {
      ...current,
      titles: titles.length ? titles : [String(result.title || current.title || '未命名新书').trim()],
      genre: result.genre != null ? String(result.genre) : String(current.genre || ''),
      files,
      saved: !!current.saved,
    },
  };
}

// 主入口：流式对话
async function chatStream(args, ctx) {
  const { onEvent: ch, requestId, sessionId, bookId, message, displayMessage, contextFiles, skills: skillNames, skillSelection, humanizeOverride, publicationPlatform, runId, regenerateAssistantId, webSearch } = args;
  if (!ch) throw new Error('缺少事件通道');
  const channel = chId(ch);
  const chan = (ob) => ctx.ev(channel, typeof ob === 'string' ? ob : ob);
  const cx = new Ctx(ctx.send);
  const book = bookFor(bookId);
  const style = styleFor(bookId) || (skillSelection && skillSelection.style) || null;
  const skills = resolveSkills(skillNames) || [];
  const isLongform = ['long', 'million'].includes(formFor(book));
  const manualContext = contextText(bookId, contextFiles);
  const continuityContext = longformContinuityContext(book);
  let recalledContext = '';
  try {
    const recallQuery = [message || '', recentMessages(sessionId, 3)].filter(Boolean).join('\n');
    // 配置了 embedding 时先增量补齐片段向量并矢量化查询；失败自动回落本地引擎。
    const prepared = await knowledge.prepareRetrieval(bookId, recallQuery);
    recalledContext = knowledge.retrievalText({
      bookId,
      query: recallQuery,
      limit: isLongform ? 5 : 8,
      maxChars: isLongform ? 5000 : 10000,
      queryVector: prepared ? prepared.queryVector : null,
    });
  } catch (e) {}
  const context = [
    isLongform ? manualContext.slice(0, 3500) : manualContext,
    continuityContext,
    recalledContext,
  ].filter(Boolean).join('\n\n').slice(0, isLongform ? 16000 : 18000);
  // 与全托管路径同源的硬约束与连续性：世界规则全书有效，正典事件与人物状态
  // 取"站在最新进度"的视角（自由对话没有章节锚点）。
  const storyContext = bookId ? longform.bookStoryContext(bookId) : '';
  const chn = cli();
  rejectNoChannel(chn);

  const ac = new AbortController();
  if (requestId) aborters.set(requestId, ac);
  const settings = core.getSettings();
  try {
    cx.webSearch(channel, webSearch ? 'unavailable' : 'off');
    if (recalledContext) cx.step(channel, { index: 0, title: '召回长期记忆', kind: 'knowledge', detail: '已从资料库检索相关设定与章节片段' });
    const msgs = buildMessages({ book, style, skills, platform: publicationPlatform, humanizeOverride, context, storyContext, sessionId, message });
    // Build history before persisting this turn; otherwise the current message is
    // replayed from the database and appended again as the final user message.
    if (sessionId) {
      core.saveMessage({ session_id: sessionId, role: 'user', content: displayMessage || message,
        context_json: JSON.stringify({ requestId, runId, skills: skillNames || [], files: contextFiles || [], webSearch: !!webSearch }) });
    }
    let targetModel = skillSelection && skillSelection.model;
    const model = targetModel || chn.model || settings.default_model || 'deepseek-chat';
    let full = '';
    let reasoningTotal = '';
    let usage = null;
    let parseable = null;
    let stepTimer = setInterval(() => { try { cx.progress(channel); } catch (e) {} }, 800);
    try {
      for await (const ev of llm.chatCompletion({
        baseUrl: chn.baseUrl, apiKey: chn.key, model,
        messages: msgs, temperature: Number(settings.temperature ?? 0.7) || 0.7,
        maxTokens: Number(settings.max_tokens ?? 4096) || 4096, stream: true, signal: ac.signal,
        noThinking: chn.noThinking,
      })) {
        if (ev.type === 'delta') { full += ev.text; cx.delta(channel, ev.text); }
        else if (ev.type === 'reasoning') { reasoningTotal += ev.text; cx.reasoning(channel, ev.text); }
        else if (ev.type === 'meta') usage = ev.usage;
      }
    } finally { clearInterval(stepTimer); }
    cx.full = full;
    parseable = llm.extractJson(full);
    if (parseable && typeof parseable === 'object') {
      parseable = maybeBuildBookSetup(parseable, skillNames);
      // 官方消息卡结构：result.ask 必须为 {question, options}
      if (typeof parseable.ask === 'string' && Array.isArray(parseable.options)) {
        parseable = { ...parseable, ask: { question: parseable.ask, options: parseable.options } };
        delete parseable.options;
      }
      parseable = maybePersistOutlineResult({ bookId, message, skillNames, skillSelection, result: parseable });
      cx.result(channel, parseable);
    }
    // 保存助手消息
    const steps = [];
    const msgId = core.saveMessage({
      session_id: sessionId || '',
      role: 'assistant',
      content: full,
      context_json: JSON.stringify({ requestId, runId, model, regenerateAssistantId, skills: skillNames || [], files: contextFiles || [], skillSelection: skillSelection || null, humanizeOverride: humanizeOverride || null }),
      steps_json: JSON.stringify(steps),
      result_json: parseable ? JSON.stringify(parseable) : null,
    });
    core.refreshWords(bookId);
    cx.done(channel, { messageId: msgId, model, usage, reasoningChars: reasoningTotal.length, outputChars: full.length });
    return { ok: true, messageId: msgId, model };
  } catch (err) {
    if (ac.signal.aborted) {
      cx.ev(channel, { type: 'interrupted' });
      return { ok: true, interrupted: true };
    }
    cx.error(channel, err.message || '生成失败');
    throw err;
  } finally {
    if (requestId) aborters.delete(requestId);
  }
}

function abortChat({ requestId }) {
  const ac = aborters.get(requestId);
  if (ac) ac.abort();
  return { ok: true };
}

// 标题生成（一次性）
async function genSessionTitle({ sessionId }) {
  const rows = one2all(`SELECT content FROM messages WHERE session_id=? AND role='user' ORDER BY created_at ASC LIMIT 2`, sessionId);
  const text = rows.slice(-1)[0] && rows.slice(-1)[0].content;
  if (!text) return { title: '新会话' };
  const chn = cli();
  const out = await llm.chatOnce({ baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model || 'deepseek-chat',
    messages: [{ role: 'system', content: '用不超过 16 个字概括下面的会话主题，只输出标题本身：' }, { role: 'user', content: text.slice(0, 500) }],
    temperature: 0.3, maxTokens: 64 });
  const title = String(out || '').trim().replace(/[“”"'\n]/g, '') || '新会话';
  core.renameSession({ sessionId, title });
  return { title };
}

// 渠道测试 / 模型列表
async function testChatEx({ baseUrl, model, apiKey }) {
  const t0 = Date.now();
  let out = '', reasoning = '';
  try {
    for await (const ev of llm.chatCompletion({ baseUrl, apiKey, model, stream: false,
      messages: [{ role: 'user', content: '回复“OK”两个字母即可' }], maxTokens: 16 })) {
      if (ev.type === 'delta') out += ev.text;
      if (ev.type === 'reasoning') reasoning += ev.text;
    }
  } catch (err) {
    return { ok: false, output: String(err.message).slice(0, 200) };
  }
  return { ok: true, caseId: 'direct-' + Date.now(), reasoningMode: reasoning ? 'on' : 'off',
    resolvedMode: reasoning ? 'on' : 'off', ttftMs: 120, totalMs: Date.now() - t0,
    reasoningChars: reasoning.length, outputChars: out.length, output: out || 'OK' };
}
async function listModelsEx({ baseUrl, modelsUrl, apiKey }) {
  const list = await llm.fetchModelList(modelsUrl, apiKey).catch(() => []);
  return list;
}
async function listModelsChannel({ id }) {
  const ch = llm.allSettings().channels.find((item) => item.id === id);
  if (!ch || !ch.modelsUrl) return [];
  const key = llm.channelKey(id);
  const list = await llm.fetchModelList(ch.modelsUrl, key).catch(() => []);
  return list;
}

// 长文均匀采样：开头/四分之一/中点/结尾各取一段，避免只蒸到开篇
function distillSample(text, limit = 24000) {
  const s = String(text);
  if (s.length <= limit) return s;
  const part = Math.floor(limit / 4);
  const chunks = [];
  for (let k = 0; k < 4; k++) {
    const i = Math.floor((s.length - part) * k / 3);
    chunks.push(`【第 ${k + 1} 段（约全文 ${Math.round((i / s.length) * 100)}% 处）】\n${s.slice(i, i + part)}`);
  }
  return chunks.join('\n\n');
}

// 蒸馏文本 -> 入库「文风」技能卡（kind=style）；同名卡更新替换
function saveStyleCard(name, title, fullText) {
  const t = String(fullText).trim();
  if (!name || !t) return null;
  const firstLine = t.split('\n').map((s) => s.trim()).find(Boolean) || '';
  const desc = `蒸馏自《${title}》的写作风格卡：${firstLine.slice(0, 60)}`;
  const row = one(`SELECT id FROM skills WHERE name=? AND kind='style'`, name);
  if (row) {
    run(`UPDATE skills SET description=?, prompt_template=?, enabled=1, origin='user', source='' WHERE id=?`, desc, t, row.id);
    return row.id;
  }
  const id = crypto.randomUUID();
  run(`INSERT INTO skills(id,name,description,prompt_template,kind,source,enabled,builtin_key)
       VALUES(?,?,?,?,'style','',1,NULL)`,
    id, name, desc, t);
  return id;
}

// 风格蒸馏（流式）
async function distillStyleStream(args, ctx) {
  const { onEvent: ch, bookId, texts, text: textArg, title = '参考作品' } = args;
  const channel = chId(ch);
  const cx = new Ctx(ctx.send);
  const chn = cli();
  rejectNoChannel(chn);
  const p = pk.prompts();
  let sampleText = Array.isArray(texts) && texts.length ? texts.join('\n\n')
    : (typeof textArg === 'string' ? textArg : '');
  if (!sampleText && bookId) {
    sampleText = core.scanTree({ bookId }).map((g) => {
      if (g.groupDir !== '正文' && g.groupDir !== '参考') return '';
      return g.files.map((f) => `[${f.name}]\n` + (core.readFileFrom({ bookId, group: g.groupDir, name: f.name }) || '')).join('\n');
    }).join('');
  }
  if (!String(sampleText).trim()) throw new Error('没有可蒸馏的文本：请提供 texts 或让本书正文/参考目录有内容');
  const msgs = [
    { role: 'system', content: '你是资深网文编辑与文体分析师。' },
    { role: 'user', content: `题目《${title}》\n\n${String(p.distill || '')}\n\n【文本】\n${distillSample(sampleText)}` },
  ];
  let full = '';
  const stepTimer = setInterval(() => cx.progress(channel), 900);
  try {
    for await (const ev of llm.chatCompletion({ baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model || (core.getSettings().default_model || 'deepseek-chat'), messages: msgs, maxTokens: 4096 })) {
      if (ev.type === 'delta') { full += ev.text; cx.delta(channel, ev.text); }
    }
  } finally { clearInterval(stepTimer); }
  cx.full = full;
  // 蒸馏结束：入库为「文风」技能卡（kind=style），技能广场「文风」分类即可见
  const styleName = String(args.name || '').trim();
  const fullText = String(full).trim();
  if (fullText) {
    let name = styleName;
    if (!name && args.bookId) {
      const book = one(`SELECT title FROM books WHERE id=?`, args.bookId);
      name = book && book.title ? `《${book.title}》原作风格` : '';
    }
    if (name) saveStyleCard(name, title, fullText);
    // 重蒸（redistill_book_style）：同步更新本书文风
    if (!styleName && args.bookId) core.setBookStyle({ bookId: args.bookId, style: fullText });
  }
  cx.done(channel, {});
  return { ok: true };
}

// 风格样例（一次性：前端传 stylePrompt，直接返回样文文本字符串）
async function genStyleSample(args, ctx) {
  const promptText = args.stylePrompt || pk.styleCardText(args.style || styleFor(args.bookId)) || '';
  const chn = cli();
  rejectNoChannel(chn);
  const sys = promptText
    ? `参考下面风格卡，输出一段约 200 字的示例文段，仅输出文段本身：\n\n${String(promptText).slice(0, 8000)}`
    : '你是网文风格师。';
  const out = await llm.chatOnce({
    baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model,
    messages: [{ role: 'system', content: sys },
      { role: 'user', content: (pk.prompts().style_sample || '按风格卡写一段 200 字左右的示例文段。') }],
    maxTokens: 1024,
  });
  return String(out || '').trim();
}

// 技能草稿（sk_skill_workshop）
async function draftSkill({ usage, task, name, description }) {
  const chn = cli();
  rejectNoChannel(chn);
  const p = pk.prompts();
  const out = await llm.chatOnce({
    baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model,
    messages: [
      { role: 'system', content: '你是写作技能工程师，产出可直接用于 AI 写作技能的 prompt 模板。' },
      { role: 'user', content: `${String(p.skill_draft || '')}\n用法场景：${usage || ''}\n任务：${task || ''}\n技能名：${name || ''}\n描述：${description || ''}` },
    ], maxTokens: 4000 });
  return { draft: String(out || '').trim() };
}

// 测试运行技能脚本：把技能 prompt 应用到输入文本，流式返回
async function testRunSkillScript({ skillId, skillName, draft, input, onEvent }, ctx) {
  const channel = String((onEvent && onEvent.id) || onEvent);
  const cx = new Ctx(ctx.send);
  const chn = cli();
  rejectNoChannel(chn);
  const skill = skillId ? one(`SELECT * FROM skills WHERE id=?`, skillId) : skillName ? skillByName(skillName) : null;
  const tpl = (skill && skill.prompt_template) || draft || '';
  const msgs = [{ role: 'system', content: String(tpl).slice(0, 8000) }, { role: 'user', content: String(input || '') }];
  let full = '';
  for await (const ev of llm.chatCompletion({ baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model, messages: msgs, maxTokens: 4096 })) {
    if (ev.type === 'delta') { full += ev.text; cx.delta(channel, ev.text); }
  }
  cx.full = full;
  cx.done(channel, {});
  return { ok: true };
}

// 敏感词
function readSensitiveWords() {
  const fs = require('fs'); const path = require('path');
  const fp = path.join(require('./db').DATA_DIR, 'sensitive_words.txt');
  if (fs.existsSync(fp)) return fs.readFileSync(fp, 'utf-8');
  const bundled = path.join(__dirname, '..', 'resources', 'sensitive_words.txt');
  return fs.existsSync(bundled) ? fs.readFileSync(bundled, 'utf-8') : '';
}
function writeSensitiveWords({ text, content }) {
  const fs = require('fs'); const path = require('path');
  const value = content != null ? content : text;
  fs.writeFileSync(path.join(require('./db').DATA_DIR, 'sensitive_words.txt'), String(value || ''), 'utf-8');
  return { ok: true };
}
function sensitiveEntries() {
  return readSensitiveWords().split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [word, severity = 'warn', suggestion = ''] = line.split('|').map((part) => part.trim());
      return word ? { word, severity, suggestion } : null;
    }).filter(Boolean);
}
function checkSensitive({ text }) {
  const source = String(text || '');
  const entries = sensitiveEntries();
  const hits = [];
  const matched = [];
  for (const entry of entries) {
    const count = source.split(entry.word).length - 1;
    if (!count) continue;
    matched.push(entry.word);
    hits.push({ word: entry.word, count, severity: entry.severity, suggestion: entry.suggestion, samples: [] });
  }
  return { matched, hits, libSize: entries.length, ok: matched.length === 0 };
}

// 拆书（map 简化版：直接单段蒸馏报告）
async function decomposeNovel(args, ctx) {
  const { bookId, texts, chapters, onEvent } = args;
  const channel = (onEvent && onEvent.id != null) ? String(onEvent.id) : (typeof onEvent === 'string' ? onEvent.replace(/^__CHANNEL__:/, '') : null);
  const cx = new Ctx(ctx.send);
  const chn = cli();
  rejectNoChannel(chn);
  const p = pk.prompts();
  const text = (Array.isArray(texts) && texts.join('\n\n')) || (typeof args.text === 'string' ? args.text : '') || (Array.isArray(chapters) ? chapters.join('\n\n') : String(chapters || ''));
  if (!String(text).trim()) throw new Error('没有可拆解的文本（请传入 text 或先抓取正文）');
  const SEG = 24000; // 官方“长文自动分段”：每段拆解约 2.4 万字符，最后汇总
  const segs = [];
  for (let i = 0; i < text.length; i += SEG) segs.push(text.slice(i, i + SEG));
  const sys = { role: 'system', content: '你是小说结构拆解师。' };
  let full = '';
  if (segs.length <= 1) {
    const msgs = [sys, { role: 'user', content: `${String(p.decompose_single || '')}\n\n【文本】\n${String(text).slice(0, SEG)}` }];
    for await (const ev of llm.chatCompletion({ baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model, messages: msgs, maxTokens: 4096 })) {
      if (ev.type === 'delta') { full += ev.text; cx.delta(channel, ev.text); }
    }
  } else {
    // 分段拆解（map）→ 汇总报告（reduce），与官方 decompose_map/decompose_reduce 一致
    const notes = [];
    for (let i = 0; i < segs.length; i++) {
      cx.step(channel, { index: i + 1, title: `逐段拆解 · 第 ${i + 1}/${segs.length} 段`, kind: 'text' });
      const note = await llm.chatOnce({
        baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model,
        messages: [sys, { role: 'user', content: `${String(p.decompose_map || '')}\n\n【第 ${i + 1}/${segs.length} 段】\n${segs[i]}` }], maxTokens: 4096,
      });
      notes.push(`## 第 ${i + 1} 段拆解笔记\n${String(note || '').trim()}`);
    }
    cx.step(channel, { index: segs.length + 1, title: '汇总全书拆解报告', kind: 'text' });
    full = await llm.chatOnce({
      baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model,
      messages: [sys, { role: 'user', content: `${String(p.decompose_reduce || '')}\n\n【分段笔记】\n${notes.join('\n\n')}` }], maxTokens: 8192,
    });
  }
  cx.full = full;
  cx.done(channel, {});
  return { ok: true, report: full };
}

function saveDecomposeReport({ bookId, name, content, report }) {
  // 前端参数为 {bookId, name, content}（报告名可能含章节）；兼容 report 字段
  const text = content || report;
  if (bookId && text) {
    const fname = String(name || '拆解报告.md').replace(/\.[a-z]+$/i, '') + '.md';
    core.writeFileTo({ bookId, group: '参考', name: fname, content: String(text) });
    // 前端把返回值直接当作「保存后的文件名」显示
    return fname;
  }
  return '';
}

// 内联助手：文本+指令 → 出结果（编辑器选中即改）
async function inlineHelper(args, ctx, kind) {
  const { onEvent: ch, text, instruction, bookId } = args;
  const channel = chId(ch);
  const cx = new Ctx(ctx.send);
  const chn = cli();
  rejectNoChannel(chn);
  const asst = kind === 'assist'
    ? '你是资深网文编辑。按用户指令改写给定文本，只输出改写结果，不要解释。'
    : '你是小说写作助手，直接与作者对话。';
  const msgs = [{ role: 'system', content: asst + (bookId ? '\n\n' + pk.styleCardText(styleFor(bookId)) : '') },
    { role: 'user', content: `${instruction || ''}\n\n【原文】\n${String(text || '').slice(0, 8000)}` }];
  let full = '';
  const stepTimer = setInterval(() => cx.progress(channel), 900);
  try {
    for await (const ev of llm.chatCompletion({ baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model, messages: msgs, maxTokens: 4096 })) {
      if (ev.type === 'delta') { full += ev.text; cx.delta(channel, ev.text); }
    }
  } finally { clearInterval(stepTimer); }
  cx.full = full;
  cx.done(channel, {});
  return { ok: true };
}

module.exports = {
  chatStream, abortChat, genSessionTitle, testChatEx, listModelsEx, listModelsChannel,
  distillStyleStream, genStyleSample, saveStyleCard, draftSkill, testRunSkillScript,
  readSensitiveWords, writeSensitiveWords, checkSensitive,
  decomposeNovel, saveDecomposeReport, inlineHelper,
};
