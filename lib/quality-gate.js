'use strict';

// 章节质量审核。
//
// 分两层：
// 1. 本地硬性门禁（零成本、确定性、可测试）：篇幅、收尾、格式、跨章逐字重复、
//    已死亡人物的主动行为、AI 套话密度、视角漂移、细纲偏离。
// 2. 模型软性评分（可选）：场景因果、人物声音、节奏、文风、信息增量、章末吸引力，
//    各 0~5 分；同时给出四项"是否违反设定"的硬判断。
//
// 审核结果只认结构化字段，不认模型的"我已经检查过了"。
const { q } = require('./db');
const llm = require('./llm');

const TERMINAL = /[。！？.!?…」』）》】\)\]"'”’]$/;
const FLASHBACK = /(回忆|想起|记起|当年|曾经|那一年|多年前|小时候|梦中|梦见|幻觉|仿佛看见|遗物|墓前|碑前|生前|临终|如果.{0,6}还活着)/;
const ACTION = /[说道笑走站抬伸看问答拿推拉坐转望叹皱低摇点跪扑抓握踏退闪跃冲咬喝喊叫]/;

const AI_CLICHES = [
  '嘴角勾起', '嘴角微微上扬', '眼中闪过一丝', '眼底掠过', '空气仿佛凝固', '空气瞬间凝固',
  '心中一凛', '心头一震', '心中一紧', '心中一震', '不由自主地', '下意识地', '仿佛整个世界都安静',
  '如同一把利刃', '宛如实质', '难以言喻', '五味杂陈', '不知为何', '鬼使神差',
  '深吸一口气', '缓缓开口', '淡淡地说', '意味深长地看了', '意味深长地笑',
];

const FORBIDDEN_META = [
  /作为(一个)?(AI|人工智能|语言模型)/i,
  /以下是(我)?(为你)?(生成|撰写|续写)/,
  /希望(这|本)章(能)?(让|令)你(满意)/,
  /本章(完|结束)[。\s]*$/,
  /<\|(?:eos|endoftext|im_end|end)\|>/i,
];

function bodyText(content) {
  return String(content || '')
    .replace(/^#{1,3}\s+[^\n]+\n*/, '')
    .trim();
}

function charCount(text) {
  return String(text || '').replace(/\s/g, '').length;
}

function normalize(text) {
  return String(text || '')
    .replace(/[「」『』“”"'‘’]/g, '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。！？、；：…—\-.!?,;:()（）\[\]【】]/g, '');
}

// 找出正文与上一章逐字重合的长片段。模型复制上一章桥段是最常见的长篇退化，
// 用 40 字以上的逐字重合做硬判定，比"相似度比例"更不容易误伤。
function sharedRuns(body, previous, { anchor = 20, minRun = 40, maxRuns = 3 } = {}) {
  const a = normalize(body);
  const b = normalize(previous);
  if (a.length < minRun || b.length < minRun) return [];
  const index = new Set();
  for (let i = 0; i + anchor <= b.length; i++) index.add(b.slice(i, i + anchor));
  const runs = [];
  let i = 0;
  while (i + anchor <= a.length) {
    if (!index.has(a.slice(i, i + anchor))) { i++; continue; }
    let end = i + anchor;
    while (end < a.length && b.includes(a.slice(i, end + 1))) end++;
    const length = end - i;
    if (length >= minRun) {
      runs.push({ text: a.slice(i, i + Math.min(length, 120)), length });
      i = end;
    } else {
      i++;
    }
    if (runs.length >= maxRuns) break;
  }
  return runs.sort((x, y) => y.length - x.length);
}

function duplicateParagraphs(body, { minLen = 80 } = {}) {
  const seen = new Map();
  const hits = [];
  for (const raw of String(body || '').split(/\n{2,}/)) {
    const text = normalize(raw);
    if (text.length < minLen) continue;
    if (seen.has(text)) hits.push(raw.trim().slice(0, 60));
    else seen.set(text, true);
  }
  return hits;
}

function clicheHits(body) {
  const text = String(body || '');
  const hits = [];
  for (const phrase of AI_CLICHES) {
    let count = 0;
    let index = text.indexOf(phrase);
    while (index >= 0 && count < 6) { count++; index = text.indexOf(phrase, index + 1); }
    if (count) hits.push({ phrase, count });
  }
  return hits;
}

function formatIssues(body, targetWords) {
  const issues = [];
  const text = String(body || '');
  if (/```/.test(text)) issues.push({ code: 'format', severity: 'hard', message: '正文里残留了代码围栏' });
  for (const pattern of FORBIDDEN_META) {
    if (pattern.test(text)) issues.push({ code: 'format', severity: 'hard', message: '正文里出现了模型自述或结束语' });
  }
  const headingLines = text.split('\n').filter((line) => /^#{1,3}\s+/.test(line.trim()));
  if (headingLines.length > 1) issues.push({ code: 'format', severity: 'hard', message: '正文里出现了多个 Markdown 标题' });
  const openQuotes = (text.match(/“/g) || []).length;
  const closeQuotes = (text.match(/”/g) || []).length;
  if (Math.abs(openQuotes - closeQuotes) > 2) {
    issues.push({ code: 'format', severity: 'soft', message: `引号不成对（${openQuotes}/${closeQuotes}）` });
  }
  if (/\n{4,}/.test(text)) issues.push({ code: 'format', severity: 'soft', message: '存在连续空行' });
  const words = charCount(bodyText(text));
  if (!TERMINAL.test(text.trim().slice(-1))) {
    issues.push({ code: 'ending', severity: 'hard', message: '本章没有以完整句子收尾' });
  }
  if (words < Math.max(320, Math.floor(Number(targetWords || 2400) * 0.85))) {
    issues.push({ code: 'length', severity: 'hard', message: `篇幅不足（${words}/${targetWords || 2400} 字）` });
  }
  return issues;
}

function characterStates(bookId) {
  return q(`SELECT state_key, value FROM story_states WHERE book_id=? AND kind='character'`, bookId).map((row) => {
    let value = {};
    try { value = JSON.parse(row.value) || {}; } catch { value = {}; }
    const status = String(value.status || '');
    const dead = /死|亡|殁|殒|断气|咽气|牺牲/.test(status) && !/未死|没死|假死|诈死|不死|未亡|生死未卜/.test(status);
    return { name: String(row.state_key || ''), status, dead };
  }).filter((item) => item.name);
}

// 已死亡人物出现在本章本身不算错（回忆、遗体、牌位都合理），
// 只有"带主动作"且附近没有追述标记时才算矛盾。
function deadCharacterIssues(body, states) {
  const text = String(body || '');
  const issues = [];
  for (const state of states) {
    if (!state.dead) continue;
    let index = text.indexOf(state.name);
    while (index >= 0) {
      const window = text.slice(Math.max(0, index - 40), index + state.name.length + 40);
      const after = text.slice(index + state.name.length, index + state.name.length + 14);
      if (!FLASHBACK.test(window) && ACTION.test(after)) {
        issues.push({
          code: 'dead_character', severity: 'hard',
          message: `已死亡人物「${state.name}」在本章仍有主动行为：…${window.replace(/\s+/g, '')}…`,
        });
        break;
      }
      index = text.indexOf(state.name, index + 1);
    }
  }
  return issues;
}

function povIssues(body, expectedPov) {
  const pov = String(expectedPov || '');
  if (!/第三人称/.test(pov)) return [];
  const narrative = String(body || '').replace(/[「『“][^」』”]*[」』”]/g, '');
  const self = (narrative.match(/[我咱]/g) || []).length;
  const sentences = narrative.split(/[。！？\n]/).filter((line) => line.trim().length > 4).length || 1;
  if (self > 12 && self / sentences > 0.25) {
    return [{
      code: 'pov', severity: 'soft',
      message: `第三人称叙事里出现大量第一人称（${self} 处 / ${sentences} 句），可能是视角漂移`,
    }];
  }
  return [];
}

function outlineAlignment(body, outline) {
  if (!outline || typeof outline !== 'object') return { coverage: 1, missing: [] };
  const pieces = [outline.goal, outline.conflict, outline.hook,
    ...(Array.isArray(outline.scenes) ? outline.scenes.map((scene) => `${scene.title || ''} ${scene.summary || ''}`) : [])]
    .filter(Boolean).join(' ');
  const terms = [...new Set(String(pieces).match(/[\u4e00-\u9fa5]{2,4}/g) || [])].slice(0, 24);
  if (!terms.length) return { coverage: 1, missing: [] };
  const text = String(body || '');
  const missing = terms.filter((term) => !text.includes(term));
  return { coverage: 1 - missing.length / terms.length, missing };
}

function runLocalGate({ bookId, body, outline = null, previousBody = '', targetWords = 2400, expectedPov = '' } = {}) {
  const issues = [];
  issues.push(...formatIssues(body, targetWords));

  const runs = sharedRuns(body, previousBody);
  if (runs.length) {
    issues.push({
      code: 'repeat_previous', severity: 'hard',
      message: `与上一章逐字重合 ${runs[0].length} 字：…${runs[0].text.slice(0, 40)}…`,
    });
  }
  const duplicates = duplicateParagraphs(body);
  if (duplicates.length) {
    issues.push({ code: 'repeat_internal', severity: 'hard', message: `本章内部有重复段落：…${duplicates[0]}…` });
  }

  const states = bookId ? characterStates(bookId) : [];
  issues.push(...deadCharacterIssues(body, states));

  const cliches = clicheHits(body);
  const clicheTotal = cliches.reduce((sum, item) => sum + item.count, 0);
  if (clicheTotal >= 4) {
    issues.push({
      code: 'cliche', severity: 'hard',
      message: `AI 套话密度过高（${clicheTotal} 处）：${cliches.slice(0, 3).map((item) => item.phrase).join('、')}`,
    });
  } else if (clicheTotal >= 2) {
    issues.push({
      code: 'cliche', severity: 'soft',
      message: `存在套话：${cliches.map((item) => item.phrase).join('、')}`,
    });
  }

  issues.push(...povIssues(body, expectedPov));

  const alignment = outlineAlignment(body, outline);
  if (alignment.coverage < 0.35) {
    issues.push({
      code: 'outline_drift', severity: 'soft',
      message: `与本章细纲关键词重合度仅 ${(alignment.coverage * 100).toFixed(0)}%，可能偏离细纲`,
    });
  }

  const hard = issues.filter((item) => item.severity === 'hard');
  const words = charCount(bodyText(body));
  const score = Math.max(0, 100 - hard.length * 40 - (issues.length - hard.length) * 8);
  return {
    passed: hard.length === 0,
    score,
    issues,
    metrics: {
      chars: words,
      targetWords: Number(targetWords) || 0,
      sharedRunChars: runs.length ? runs[0].length : 0,
      clicheCount: clicheTotal,
      outlineCoverage: Number(alignment.coverage.toFixed(2)),
      deadCharacters: states.filter((item) => item.dead).length,
    },
    summary: hard.length ? hard[0].message : (issues.length ? issues[0].message : '通过'),
  };
}

// ---------- 模型审核 ----------

const REVIEW_SYSTEM = [
  '你是长篇连载的责任编辑，只做审核，不改稿。',
  '必须只输出一个 JSON 对象，不要 markdown、不要代码围栏、不要任何解释。',
  'JSON 结构：',
  '{"hard":{"world":true,"knowledge":true,"timeline":true,"outline":true},',
  ' "scores":{"causality":0,"voice":0,"pacing":0,"style":0,"information":0,"hook":0},',
  ' "issues":["具体到句子的修改意见"]}',
  'hard 四项为 true 表示通过：world=不违反世界观与力量体系；knowledge=角色没有使用他不可能知道的信息；',
  'timeline=时间线与人物状态不矛盾（死者不复活、已毁道具不重现、地点转换合理）；outline=完成了本章细纲的目标与章末钩子。',
  'scores 每项 0~5：causality 场景因果、voice 人物声音、pacing 节奏、style 文风、information 信息增量、hook 章末吸引力。',
  '宁严勿宽：出现死者行动、道具复活、角色凭空知情、明显偏离细纲，一律判 false。',
].join('\n');

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(5, number));
}

async function reviewWithModel({ channel, model, body, outline, previousBody = '', targetWords = 2400, onUsage = null }) {
  if (!channel || !channel.baseUrl) return null;
  const outlineText = outline ? JSON.stringify(outline).slice(0, 1200) : '（本章无细纲）';
  const user = [
    `【本章细纲】\n${outlineText}`,
    previousBody ? `【上一章结尾】\n${String(previousBody).slice(-800)}` : '',
    `【本章正文】\n${String(body || '').slice(0, 8000)}`,
    `【要求】本章目标约 ${targetWords} 字。请按要求输出审核 JSON。`,
  ].filter(Boolean).join('\n\n');

  let raw = '';
  for await (const event of llm.chatCompletion({
    baseUrl: channel.baseUrl,
    apiKey: channel.key,
    model,
    messages: [{ role: 'system', content: REVIEW_SYSTEM }, { role: 'user', content: user }],
    temperature: 0.1,
    maxTokens: 900,
    noThinking: channel.noThinking,
  })) {
    if (event.type === 'delta') raw += event.text;
    if (event.type === 'meta' && event.usage && typeof onUsage === 'function') onUsage(event.usage);
  }
  const parsed = llm.extractJson(raw);
  if (!parsed || typeof parsed !== 'object') {
    return {
      passed: false, score: 0, issues: [{ code: 'review_parse', severity: 'soft', message: '审核模型没有返回可解析的 JSON' }],
      metrics: { stage: 'model', parseFailed: true },
      summary: '审核模型输出无法解析',
    };
  }
  const hard = parsed.hard || {};
  const hardKeys = ['world', 'knowledge', 'timeline', 'outline'];
  const failedHard = hardKeys.filter((key) => hard[key] === false || hard[key] === 'false');
  const scores = parsed.scores || {};
  const dimensions = {
    causality: clampScore(scores.causality),
    voice: clampScore(scores.voice),
    pacing: clampScore(scores.pacing),
    style: clampScore(scores.style),
    information: clampScore(scores.information),
    hook: clampScore(scores.hook),
  };
  const values = Object.values(dimensions);
  const score = values.reduce((sum, value) => sum + value, 0) / values.length;
  const issues = (Array.isArray(parsed.issues) ? parsed.issues : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((message) => ({ code: 'model_review', severity: 'soft', message }));
  for (const key of failedHard) {
    issues.unshift({ code: `model_${key}`, severity: 'hard', message: `审核判定未通过：${{ world: '违反世界观', knowledge: '角色使用了不该知道的信息', timeline: '时间线或人物状态矛盾', outline: '偏离本章细纲' }[key]}` });
  }
  return {
    passed: failedHard.length === 0,
    score: Number(score.toFixed(2)),
    dimensions,
    issues,
    metrics: { stage: 'model', dimensions, failedHard },
    summary: failedHard.length ? `审核硬性未通过：${failedHard.join(',')}` : `软性评分 ${score.toFixed(2)}/5`,
  };
}

const REVISE_SYSTEM = [
  '你是长篇小说的修订者。按编辑意见做定向修订，只改被指出的问题。',
  '保持原有情节走向、人物关系和章末钩子，不要新增支线，不要改变视角。',
  '直接输出修订后的完整章节正文，不要解释、不要 JSON、不要 markdown 标题以外的任何标记。',
].join('\n');

async function reviseChapter({ channel, model, body, issues, targetWords = 2400, onUsage = null }) {
  if (!channel || !channel.baseUrl) return '';
  const list = (issues || []).map((item, index) => `${index + 1}. ${item.message}`).join('\n');
  let raw = '';
  for await (const event of llm.chatCompletion({
    baseUrl: channel.baseUrl,
    apiKey: channel.key,
    model,
    messages: [
      { role: 'system', content: REVISE_SYSTEM },
      { role: 'user', content: `【需要修正的问题】\n${list}\n\n【本章正文】\n${String(body || '')}\n\n【要求】修订后仍约 ${targetWords} 字，完整收尾。直接输出正文。` },
    ],
    temperature: 0.5,
    maxTokens: Math.min(8192, Math.max(1024, Math.ceil(Number(targetWords) * 1.8))),
    noThinking: channel.noThinking,
  })) {
    if (event.type === 'delta') raw += event.text;
    if (event.type === 'meta' && event.usage && typeof onUsage === 'function') onUsage(event.usage);
  }
  return String(raw || '').trim();
}

module.exports = {
  AI_CLICHES,
  bodyText,
  charCount,
  sharedRuns,
  duplicateParagraphs,
  clicheHits,
  formatIssues,
  characterStates,
  deadCharacterIssues,
  povIssues,
  outlineAlignment,
  runLocalGate,
  reviewWithModel,
  reviseChapter,
};
