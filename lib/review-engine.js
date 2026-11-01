'use strict';

// AI 评审机制：多厂商评审团 → 交叉验证 → 迭代优化。
//
// 设计边界（决定了它能扩展到哪里）：
//   1. **不认识工作台**。引擎只处理「作品」= {workbench, workId, sectionIdx, text}。
//      文档与小说各自提供两个适配器：读正文、写回修改。加第三个工作台时只加适配器，
//      评审流程、交叉验证、Skill 体系、轮次记录全部复用。
//   2. **不新建调用层**。评审员的模型来自用户已配置的渠道（`llm.channelList()`），
//      按 `channel_id` 显式指定——这正是现有 API 系统该承担的鉴权/配额/路由，
//      评审机制只负责「谁、按什么角色、按什么标准、审什么」。
//   3. **独立性靠结构保证，不靠提示词**。每位评审员各自一次调用、各自一份提示词、
//      互不可见；汇总发生在全部返回之后（`Promise.all`），任何评审员都拿不到别人的结论。
//   4. **可追溯**。每轮落 `review_rounds` + `review_opinions` + `review_decisions`：
//      谁说了什么、哪条被采纳、为什么没采纳、改前改后是什么，都能查回来。

const crypto = require('node:crypto');
const { q, one, run, transaction } = require('./db');
const llm = require('./llm');
const quality = require('./doc-quality');
const { chapterNumberFromName } = require('./chapter-names');
const {
  REVIEW_TEXT_MAX_CHARS, APPLY_INPUT_MAX_CHARS, APPLY_MIN_KEEP_RATIO, AUTO_REVIEW_LIMIT,
} = require('./review-limits');

const MAX_REVIEWERS = 3;
const DEFAULT_REVIEWER_TOKENS = 3000;
const MIN_REVIEWER_TOKENS = 600;
const WORKBENCH_LABEL = { novel: '小说工作台', doc: '文档工作台' };
const SKILL_KINDS = { method: '评审技能', style: '评审风格', focus: '评审重点' };
const SEVERITY_LABEL = { fatal: '致命', major: '重要', minor: '一般' };
const SEVERITY_WEIGHT = { fatal: 3, major: 2, minor: 1 };

function idOf(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function nowMs() { return Date.now(); }

// ---------- 设置（开关按工作台、按文档类型独立生效） ----------

function readSetting(key) {
  const row = one(`SELECT value FROM settings WHERE key=?`, String(key));
  return row ? String(row.value || '') : '';
}

function writeSetting(key, value) {
  run(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    String(key), String(value == null ? '' : value));
}

// 三级开关：全局 → 工作台 → 文档类型。任一级显式关闭即关闭；
// 都没有配置时跟随上一级。默认全局关闭（这是「可选功能」的含义）。
function isEnabled(workbench, docType = '') {
  // 关闭是「硬」的，开启是「软」的：
  // 上一级关掉，下级一律关闭——不能被下级的显式开启绕过。
  // 否则「关掉整个文档工作台」之后，之前单独开过的「申报书」还在跑，
  // 用户会认为开关失效（这正是「用户可随时关闭」这条最容易破的地方）。
  if (readSetting('review_enabled') !== '1') return false;
  const wb = readSetting(`review_scope__${workbench}`);
  if (wb === '0') return false;
  if (docType) {
    const scoped = readSetting(`review_scope__${workbench}__${docType}`);
    if (scoped === '0') return false;
    if (scoped === '1') return true;
  }
  return true;
}

function setEnabled({ enabled, workbench = '', docType = '' }) {
  const value = enabled ? '1' : '0';
  if (!workbench) {
    writeSetting('review_enabled', value);
  } else {
    // 打开任何一级作用域时同时打开全局：作者点的是「开启这一项」，
    // 如果因为总开关是关的就什么都不发生，这个按钮等于坏的。
    if (enabled) writeSetting('review_enabled', '1');
    if (!docType) writeSetting(`review_scope__${workbench}`, value);
    else writeSetting(`review_scope__${workbench}__${docType}`, value);
  }
  return { ok: true, enabled: !!enabled, workbench, docType };
}

// 三级开关的显式设置：'1' 开 / '0' 关 / '' 清除（跟随上一级）。
// 清除这一档必须有——否则一旦对某个类型设过「关」，就再也回不到「跟随工作台」。
function setScope({ workbench = '', docType = '', value = '' } = {}) {
  const v = String(value);
  // 三级各自的存储键：全局 review_enabled / 工作台 review_scope__<wb> / 类型 review_scope__<wb>__<type>
  const key = !workbench
    ? 'review_enabled'
    : (docType ? `review_scope__${workbench}__${docType}` : `review_scope__${workbench}`);
  if (v !== '0' && v !== '1') {
    // 全局没有「跟随上一级」这一档，清空即关闭
    if (key === 'review_enabled') writeSetting(key, '0');
    else run(`DELETE FROM settings WHERE key=?`, key);
    return { ok: true, cleared: true };
  }
  if (v === '1' && key !== 'review_enabled') writeSetting('review_enabled', '1');
  writeSetting(key, v);
  return { ok: true, cleared: false };
}

function enableState(workbench, docType = '') {
  return {
    global: readSetting('review_enabled') === '1',
    scoped: docType ? readSetting(`review_scope__${workbench}__${docType}`) : readSetting(`review_scope__${workbench}`),
    effective: isEnabled(workbench, docType),
  };
}

// ---------- 默认 Skill 组合 ----------
//
// 规范 7.3 要求「未配置时使用默认组合」。没有默认组合时，一位没配 Skill 的评审员
// 会退化成「你看着审」——它会给出一堆「可以更深入」式的空评语，这等于机制没生效。
// 默认组合写成代码常量而不是数据库行：它不该被误删，也不该在页面上被当成用户资产。
const DEFAULT_SKILLS = {
  novel: {
    method: [{
      name: '叙事审稿框架',
      body: '先通读判断能否读下去（钩子、代入感）；再拆情节、人物、世界观、节奏四项逐项给判断；'
        + '最后复核每条问题是否指向具体段落。禁止只给「好看/不好看」的整体印象。',
    }],
    style: [{
      name: '编辑口吻点评',
      body: '像资深编辑对作者说话：先肯定有效的地方（说清为什么有效），再指出问题；'
        + '每条意见控制在两句话内，给一个可立刻动手的改法。',
    }],
    focus: [{
      name: '情节与人设',
      body: '1. 每章是否有一个明确的冲突或悬念推进；\n2. 人物行为是否有动机支撑，是否存在「为剧情服务」的突兀决定；\n'
        + '3. 对话是否承担信息或性格功能，有没有纯寒暄；\n4. 节奏是否存在大段说明性文字拖慢叙事。',
    }],
  },
  doc: {
    method: [{
      name: '通用文档评审框架',
      body: '先判断文体是否成立（该有的结构有没有）；再按维度逐项检查；最后复核每条意见是否可执行。'
        + '结构缺失比措辞问题优先，事实错误比表达问题优先。',
    }],
    style: [{
      name: '严谨点评',
      body: '客观、具体、可核对：每条问题指出位置并给出改法，不用形容词代替判断，不写「建议进一步优化」这类空话。',
    }],
    focus: [{
      name: '论证与规范',
      body: '1. 每个核心判断是否有可核对的依据；\n2. 结论是否回应了开头提出的问题；\n'
        + '3. 该文体要求的必备结构是否齐全（如申报书的考核指标、论文的方法与局限）；\n4. 数字与引用是否前后一致。',
    }],
  },
};

function defaultSkillsFor(workType) {
  const family = String(workType || '').split(':')[0];
  const spec = DEFAULT_SKILLS[family] || DEFAULT_SKILLS.doc;
  const tag = (list, kind) => list.map((item) => ({ ...item, id: `builtin_${kind}`, kind, appliesTo: ['*'], builtin: true, source: 'builtin' }));
  return {
    method: tag(spec.method, 'method'),
    style: tag(spec.style, 'style'),
    focus: tag(spec.focus, 'focus'),
  };
}

// 按类型的开关状态清单：方案二要求「可只对文档工作台的申报书开启」，
// 页面上必须能一眼看到每种类型各自开没开、以及它为什么是当前这个状态。
function scopeStates(workbench, docTypes = []) {
  const global = readSetting('review_enabled') === '1';
  const wbValue = readSetting(`review_scope__${workbench}`);
  const rows = docTypes.map((docType) => {
    const own = readSetting(`review_scope__${workbench}__${docType}`);
    return {
      docType,
      // '1' 显式开 / '0' 显式关 / '' 跟随上一级
      own,
      effective: isEnabled(workbench, docType),
    };
  });
  return { global, workbench: { own: wbValue, effective: isEnabled(workbench) }, types: rows };
}

// ---------- 评审团 ----------

function listChannels() {
  return llm.channelList().filter((item) => item.hasKey);
}

function channelOf(channelId) {
  const id = String(channelId || '');
  const channel = llm.channelList().find((item) => item.id === id);
  if (!channel) throw new Error(`评审员的渠道不存在：${id || '（未指定）'}`);
  const key = llm.channelKey(id);
  if (!key) throw new Error(`渠道「${channel.label}」没有可用的密钥`);
  return { id: channel.id, label: channel.label, baseUrl: channel.baseUrl, model: channel.model, key };
}

// 评审员的厂商/模型标识：按渠道自动生成通用标识。
//
// 方案四要求「以通用标识记录（如厂商甲/模型 X），仅用于区分能力差异，不展示具体名称」。
// 但标识必须**跟着渠道走**：之前表单里写死「厂商甲/厂商乙/厂商丙」，
// 换一个渠道仍然显示「甲」，两个评审团用同一条渠道却标着不同名字——
// 标识一旦和真实来源脱钩，作者就没法用它判断「这条意见是谁给的」。
const VENDOR_MARKS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];
const MODEL_MARKS = ['X', 'Y', 'Z', 'W', 'V', 'U'];

function genericLabelFor(channelId) {
  const id = String(channelId || '');
  if (!id) return '';
  const channels = llm.channelList();
  const index = channels.findIndex((item) => item.id === id);
  if (index < 0) return '';
  const vendor = VENDOR_MARKS[index] || String(index + 1);
  const model = MODEL_MARKS[index] || String(index + 1);
  return `厂商${vendor} / 模型 ${model}`;
}

function normalizeReviewer(raw, index) {
  return {
    id: String(raw && raw.id || '') || idOf('rv'),
    name: String(raw && raw.name || '').trim().slice(0, 24) || `评审员${index + 1}`,
    channelId: String(raw && raw.channelId || '').trim(),
    // 厂商/模型只存通用标识：界面显示「厂商甲 / 模型 X」这类占位，
    // 不把具体厂商名写进数据库与报告——这是产品表述规范，不是技术限制。
    // 标识以渠道为准：传进来的可能是旧值或占位，能对上渠道就重新生成
    modelLabel: genericLabelFor(raw && raw.channelId)
      || String(raw && raw.modelLabel || '').trim().slice(0, 40),
    persona: String(raw && raw.persona || '').trim().slice(0, 120),
    specialty: String(raw && raw.specialty || '').trim().slice(0, 200),
    style: String(raw && raw.style || '').trim().slice(0, 120),
  };
}

function savePanel({ id = '', name = '', workbench = 'doc', docType = '', reviewers = [], maxRounds = 0, tokenBudget = 0 } = {}) {
  const list = (Array.isArray(reviewers) ? reviewers : []).map(normalizeReviewer).filter((item) => item.channelId);
  if (!list.length) throw new Error('评审团至少要有一位评审员（并且要选渠道）');
  if (list.length > MAX_REVIEWERS) throw new Error(`评审团最多 ${MAX_REVIEWERS} 位评审员`);
  const seen = new Set();
  for (const reviewer of list) {
    if (seen.has(reviewer.channelId)) {
      throw new Error('同一位评审员不能重复：请为每位评审员指定不同渠道，否则「多厂商评审」退化成同一模型自评');
    }
    seen.add(reviewer.channelId);
  }
  // 渠道不同也可能指向同一服务地址与模型（同一模型的第二把密钥）。
  // 保存时就拦下来，而不是等报告出来才发现「三位评审员」其实是同一个模型自评三次。
  const endpoints = new Map();
  for (const reviewer of list) {
    const channel = llm.channelList().find((item) => item.id === reviewer.channelId);
    if (!channel) continue;
    const endpoint = `${String(channel.baseUrl || '').replace(/\/+$/, '')}::${String(channel.model || '')}`;
    if (endpoints.has(endpoint)) {
      throw new Error(`「${endpoints.get(endpoint)}」与「${reviewer.name}」指向同一服务地址与模型：这只是同一模型自评两次，请换成真正不同的厂商/模型`);
    }
    endpoints.set(endpoint, reviewer.name);
  }
  const wb = ['novel', 'doc'].includes(String(workbench)) ? String(workbench) : 'doc';
  const budget = Math.max(0, Math.min(500000, Math.floor(Number(tokenBudget) || 0)));
  const rounds = Math.max(0, Math.min(20, Number(maxRounds) || 0));
  const panelId = String(id || '') || idOf('pn');
  const stamp = nowMs();
  transaction(() => {
    const exists = one(`SELECT id FROM review_panels WHERE id=?`, panelId);
    if (exists) {
      run(`UPDATE review_panels SET name=?, workbench=?, doc_type=?, max_rounds=?, token_budget=?, updated_at=? WHERE id=?`,
        String(name || '未命名评审团').slice(0, 60), wb, String(docType || ''),
        rounds, budget, stamp, panelId);
      run(`DELETE FROM review_reviewers WHERE panel_id=?`, panelId);
    } else {
      run(`INSERT INTO review_panels(id,name,workbench,doc_type,max_rounds,token_budget,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
        panelId, String(name || '未命名评审团').slice(0, 60), wb, String(docType || ''),
        rounds, budget, stamp, stamp);
    }
    list.forEach((reviewer, index) => {
      run(`INSERT INTO review_reviewers(id,panel_id,name,channel_id,model_label,persona,specialty,style,sort,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        reviewer.id, panelId, reviewer.name, reviewer.channelId, reviewer.modelLabel,
        reviewer.persona, reviewer.specialty, reviewer.style, index, stamp);
    });
  });
  return getPanel(panelId);
}

function getPanel(panelId) {
  const row = one(`SELECT * FROM review_panels WHERE id=?`, String(panelId || ''));
  if (!row) return null;
  const reviewers = q(`SELECT * FROM review_reviewers WHERE panel_id=? ORDER BY sort, created_at`, row.id)
    .map((item) => ({
      id: item.id, name: item.name, channelId: item.channel_id, modelLabel: item.model_label,
      persona: item.persona, specialty: item.specialty, style: item.style,
    }));
  return {
    id: row.id, name: row.name, workbench: row.workbench, docType: row.doc_type,
    maxRounds: Number(row.max_rounds) || 0,
    tokenBudget: Number(row.token_budget) || 0,
    createdAt: Number(row.created_at || 0), reviewers,
  };
}

function listPanels(workbench = '') {
  const rows = workbench
    ? q(`SELECT id FROM review_panels WHERE workbench=? ORDER BY updated_at DESC`, String(workbench))
    : q(`SELECT id FROM review_panels ORDER BY updated_at DESC`);
  return rows.map((row) => getPanel(row.id)).filter(Boolean);
}

function deletePanel(panelId) {
  const key = String(panelId || '');
  transaction(() => {
    run(`DELETE FROM review_reviewers WHERE panel_id=?`, key);
    run(`DELETE FROM review_panels WHERE id=?`, key);
  });
  return { ok: true };
}

// 独立性的可见检查：结构上已经强制「渠道互不相同」，但两个渠道如果指向
// 同一服务地址与同一模型，实质仍是同一个模型自评两次，多厂商评审名存实亡。
// 只提示不拦截：同一网关下也可能挂着不同提供方的模型，硬拦会误伤正常配置。
function panelWarnings(panel) {
  if (!panel || !Array.isArray(panel.reviewers)) return [];
  const channels = llm.channelList();
  const byId = new Map(channels.map((item) => [item.id, item]));
  const out = [];
  const groups = new Map();
  for (const reviewer of panel.reviewers) {
    const channel = byId.get(reviewer.channelId);
    if (!channel) {
      out.push(`${reviewer.name} 使用的渠道已不存在，评审时会调用失败`);
      continue;
    }
    if (!channel.hasKey) out.push(`渠道「${reviewer.name}」没有可用密钥`);
    if (!channel.model) out.push(`${reviewer.name} 的渠道没有配置模型，评审调用会失败`);
    const key = `${String(channel.baseUrl || '').replace(/\/+$/, '')}::${String(channel.model || '')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(reviewer.name);
  }
  for (const names of groups.values()) {
    if (names.length > 1) {
      out.push(`${names.join('、')} 指向同一服务地址与模型，独立性可能不成立（很可能只是同一模型自评两次）`);
    }
  }
  // Skill 冲突也要在组建评审团时可见：等到评审跑完才发现「三句话短评」和
  // 「逐项详评」互相打架，已经付过账单了。
  const workType = panel.workbench === 'novel' ? 'novel' : (panel.docType ? `doc:${panel.docType}` : 'doc');
  for (const reviewer of panel.reviewers) {
    try {
      const skills = skillsFor({ reviewerId: reviewer.id, workType });
      for (const warning of checkCompatibility(skills)) out.push(`${reviewer.name}：${warning}`);
    } catch { /* Skill 读取失败不该让评审团页整页报错 */ }
  }
  return [...new Set(out)];
}

// 默认评审团：按工作台 + 文档类型挑第一个匹配的预设。
function defaultPanel(workbench, docType = '') {
  const panels = listPanels(workbench);
  return panels.find((panel) => panel.docType && panel.docType === docType)
    || panels.find((panel) => !panel.docType)
    || null;
}

// ---------- 评审库（Skill） ----------

function parseAppliesTo(raw) {
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean).slice(0, 8);
  const text = String(raw || '').trim();
  if (!text) return [];
  return text.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean).slice(0, 8);
}

// 维度权重解析：接受 "论证论据=2, 逻辑结构=1.5" 或对象。
// 空 = 各维度等权（方案 7.2 的默认值）。
function parseWeights(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
      const weight = Number(value);
      if (key && Number.isFinite(weight) && weight > 0) out[String(key).slice(0, 20)] = Math.min(9, weight);
    }
    return out;
  }
  const text = String(raw || '').trim();
  if (!text) return {};
  const out = {};
  for (const part of text.split(/[,，;；\n]+/)) {
    const matched = part.match(/^\s*([^=＝:：]+)\s*[=＝:：]\s*([0-9.]+)\s*$/);
    if (!matched) continue;
    const weight = Number(matched[2]);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    out[matched[1].trim().slice(0, 20)] = Math.min(9, weight);
  }
  return out;
}

// 合并多位评审员（各自 focus Skill）的权重：同一维度取最大值。
// 取最大而不是求和——权重是「这个维度相对多重要」，不是可以累加的分数。
function mergeWeights(list) {
  const out = {};
  for (const weights of list) {
    for (const [key, value] of Object.entries(weights || {})) {
      out[key] = Math.max(out[key] || 0, Number(value) || 0);
    }
  }
  return out;
}

function saveSkill({ id = '', reviewerId = '', kind = 'method', name = '', appliesTo = [], body = '', source = 'user', weights = '', enabled = null } = {}) {
  const kinds = Object.keys(SKILL_KINDS);
  const k = kinds.includes(String(kind)) ? String(kind) : 'method';
  const text = String(body || '').trim();
  if (text.length < 20) throw new Error('Skill 内容太短（至少 20 字）：太短的规则无法约束评审');
  const scopes = parseAppliesTo(appliesTo);
  if (!scopes.length) throw new Error('Skill 必须声明适用作品类型（如 novel / doc / doc:paper / *）');
  const skillId = String(id || '') || idOf('sk');
  const stamp = nowMs();
  const exists = one(`SELECT id, enabled FROM review_skills WHERE id=?`, skillId);
  const weightJson = JSON.stringify(parseWeights(weights));
  // 编辑时没传 enabled 就沿用原值：改正文不该顺带把一条停用的 Skill 重新启用。
  const enabledValue = enabled == null
    ? (exists ? Number(exists.enabled ?? 1) : 1)
    : (enabled ? 1 : 0);
  if (exists) {
    run(`UPDATE review_skills SET reviewer_id=?, kind=?, name=?, applies_to=?, body=?, source=?, weights=?, enabled=?, updated_at=? WHERE id=?`,
      String(reviewerId || ''), k, String(name || '未命名 Skill').slice(0, 60), JSON.stringify(scopes),
      text.slice(0, 4000), String(source || 'user'), weightJson, enabledValue, stamp, skillId);
  } else {
    run(`INSERT INTO review_skills(id,reviewer_id,kind,name,applies_to,body,source,weights,enabled,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      skillId, String(reviewerId || ''), k, String(name || '未命名 Skill').slice(0, 60),
      JSON.stringify(scopes), text.slice(0, 4000), String(source || 'user'), weightJson, enabledValue, stamp, stamp);
  }
  return getSkill(skillId);
}

function getSkill(skillId) {
  const row = one(`SELECT * FROM review_skills WHERE id=?`, String(skillId || ''));
  if (!row) return null;
  let scopes = [];
  try { scopes = JSON.parse(row.applies_to || '[]') || []; } catch { scopes = []; }
  let weights = {};
  try { weights = JSON.parse(row.weights || '{}') || {}; } catch { weights = {}; }
  return {
    id: row.id, reviewerId: row.reviewer_id, kind: row.kind, name: row.name,
    appliesTo: Array.isArray(scopes) ? scopes : [], body: row.body, source: row.source,
    weights: weights && typeof weights === 'object' ? weights : {},
    enabled: Number(row.enabled ?? 1) !== 0,
    createdAt: Number(row.created_at || 0),
  };
}

function listSkills({ reviewerId = null, kind = '', includeDisabled = false } = {}) {
  const clauses = [];
  const args = [];
  if (reviewerId !== null) { clauses.push('reviewer_id=?'); args.push(String(reviewerId)); }
  if (kind) { clauses.push('kind=?'); args.push(String(kind)); }
  // 管理页面要看得到停用的 Skill；评审流程只取启用的那些。
  if (!includeDisabled) clauses.push('enabled=1');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return q(`SELECT id FROM review_skills ${where} ORDER BY updated_at DESC`, ...args)
    .map((row) => getSkill(row.id)).filter(Boolean);
}

function deleteSkill(skillId) {
  run(`DELETE FROM review_skills WHERE id=?`, String(skillId || ''));
  return { ok: true };
}

// 停用 / 启用：绑定关系与正文都保留，只是评审时不再使用。
function setSkillEnabled(skillId, on) {
  const key = String(skillId || '');
  if (!key) throw new Error('缺少 Skill id');
  run(`UPDATE review_skills SET enabled=?, updated_at=? WHERE id=?`, on ? 1 : 0, nowMs(), key);
  return getSkill(key);
}

// ---------- Skill 与评审员的绑定 ----------
//
// 方案 7.1/7.3 的核心是「为**某位**评审员配置这几条 Skill」——
// 只按作品类型自动匹配是不够的：同一份论文上，学术审稿人该用「论证完整性」，
// 格式审查员该用「引用与排版规范」，两者的库不能混。没有绑定，
// 三个评审员会拿到同一套标准，多厂商评审就退化成「三个模型用同一把尺子量」。
function setSkillReviewers(skillId, reviewerIds = []) {
  const key = String(skillId || '');
  if (!key) throw new Error('缺少 Skill id');
  const ids = [...new Set((Array.isArray(reviewerIds) ? reviewerIds : []).map((item) => String(item || '').trim()).filter(Boolean))];
  transaction(() => {
    run(`DELETE FROM review_reviewer_skills WHERE skill_id=?`, key);
    ids.forEach((reviewerId, index) => {
      run(`INSERT INTO review_reviewer_skills(reviewer_id, skill_id, sort) VALUES(?,?,?)`, reviewerId, key, index);
    });
  });
  return { ok: true, reviewerIds: ids };
}

function reviewerIdsOfSkill(skillId) {
  return q(`SELECT reviewer_id FROM review_reviewer_skills WHERE skill_id=? ORDER BY sort`, String(skillId || ''))
    .map((row) => String(row.reviewer_id));
}

// 一位评审员被绑定的 Skill（按绑定顺序）。
function skillsBoundTo(reviewerId) {
  const ids = q(`SELECT skill_id FROM review_reviewer_skills WHERE reviewer_id=? ORDER BY sort`, String(reviewerId || ''))
    .map((row) => String(row.skill_id));
  if (!ids.length) return [];
  const rows = q(`SELECT id FROM review_skills WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const byId = new Map(rows.map((row) => [String(row.id), getSkill(row.id)]));
  return ids.map((id) => byId.get(id)).filter((skill) => skill && skill.enabled !== false);
}

// 所有评审员（跨评审团），供「把这条 Skill 绑给谁」的选择器使用。
function listAllReviewers() {
  return q(`SELECT r.id, r.name, r.panel_id, p.name AS panel_name, p.workbench
    FROM review_reviewers r JOIN review_panels p ON p.id = r.panel_id
    ORDER BY p.updated_at DESC, r.sort`).map((row) => ({
    id: row.id, name: row.name, panelId: row.panel_id,
    panelName: row.panel_name, workbench: row.workbench,
  }));
}

// Skill 与作品类型匹配：'*' 通配；'doc' 匹配所有文档类型；'doc:paper' 只匹配论文。
function scopeMatches(scopes, workType) {
  const type = String(workType || '');
  const family = type.split(':')[0];
  return (scopes || []).some((scope) => {
    const value = String(scope || '').trim();
    if (!value) return false;
    if (value === '*') return true;
    if (value === type) return true;
    if (!value.includes(':') && value === family) return true;
    return false;
  });
}

// 一位评审员在某一类作品上可用的 Skill：自己的 + 共享池的。
// 取一位评审员在某类作品上该用的 Skill。
//
// 优先级：**显式绑定** > 该评审员专属库（旧数据）> 共享池 > 默认组合。
// 绑定优先是方案 7.3 的要求：用户指定了「给编辑配这三条」，就不该再被
// 自动匹配塞进别的标准。
function skillsFor({ reviewerId = '', workType = '' } = {}) {
  const bound = skillsBoundTo(reviewerId).filter((skill) => scopeMatches(skill.appliesTo, workType));
  const own = listSkills({ reviewerId: String(reviewerId || '') })
    .filter((skill) => scopeMatches(skill.appliesTo, workType));
  const shared = listSkills({ reviewerId: '' })
    .filter((skill) => scopeMatches(skill.appliesTo, workType));
  const fallback = defaultSkillsFor(workType);

  // **按类别排他**：只要这位评审员在某类上被显式绑定过，该类就只用绑定的那些，
  // 不再自动并入共享池。
  //
  // 为什么必须排他：绑定表达的是「这位评审员该用这把尺子」。如果绑定之后
  // 共享池里的同类别 Skill 还照旧并进来，那「给学术审稿人配论证检查、
  // 给格式审查员配引用规范」就落不了地——两人最终都会拿到同一套标准，
  // 多厂商评审就退化成三个模型用同一把尺子量（实测踩过）。
  const matched = { method: [], style: [], focus: [], bound: bound.map((skill) => skill.id) };
  for (const kind of ['method', 'style', 'focus']) {
    const boundOfKind = bound.filter((skill) => skill.kind === kind);
    if (boundOfKind.length) {
      matched[kind] = boundOfKind;
      continue;
    }
    // 该类没有绑定：专属库 + 共享池按 id 去重；都没有才用默认组合。
    // 空着的类别会让评审员自由发挥，而「自由发挥」在多轮评审里表现为风格漂移与空评语。
    const seen = new Set();
    for (const skill of [...own, ...shared]) {
      if (skill.kind !== kind || seen.has(skill.id)) continue;
      seen.add(skill.id);
      matched[kind].push(skill);
    }
    if (!matched[kind].length) matched[kind] = fallback[kind];
  }
  // 维度权重：来自 focus Skill（方案 7.2「各维度权重可配置」）
  matched.weights = mergeWeights(matched.focus.map((skill) => skill.weights));
  return matched;
}

// 组合校验：风格说「三句话短评」而技能要求「逐项详评」，评审员会不知道写多长。
// 这类冲突不能留给模型自己权衡——它只会挑一个执行，另一个白配。
function checkCompatibility({ method = [], style = [], focus = [] } = {}) {
  const warnings = [];
  const styleText = style.map((item) => `${item.name} ${item.body}`).join(' ');
  const methodText = method.map((item) => `${item.name} ${item.body}`).join(' ');
  if (/短评|三句|精简|一句话|极简/.test(styleText) && /逐项|详评|完整框架|分维度|逐条打分/.test(methodText)) {
    warnings.push('风格要求「简短」，但评审技能要求「逐项详评」——两者冲突，评审员会只执行其中一个。');
  }
  if (/口语|轻松|鼓励/.test(styleText) && /学术|严谨|规范/.test(methodText)) {
    warnings.push('风格偏口语化，但评审技能要求学术严谨——同一份意见会出现两种语域。');
  }
  if (!method.length && !focus.length) {
    warnings.push('没有匹配到评审技能与评审重点：评审员只能凭通用印象打分，建议至少配一项评审重点。');
  }
  if (!style.length) {
    warnings.push('没有匹配到评审风格：输出篇幅与语气不受控，三轮之间可能风格漂移。');
  }
  return warnings;
}

// ---------- 作品适配器 ----------

// 创作意图：评审的可行性评估必须对照它。
//
// 规范第六条要求「与用户明确表达的创作目标冲突的意见标记为不采纳」。
// 没有这份意图，评审员会按自己的审美标准要求作者改——一篇 800 字的短评会被要求补数据，
// 一份内部通知会被要求「增加文献综述」。这不是评审，是跑偏。
function intentOfDoc(project, section) {
  const parts = [];
  if (project.brief) parts.push(`项目说明：${String(project.brief).slice(0, 400)}`);
  if (project.thesis) parts.push(`核心论题：${String(project.thesis).slice(0, 300)}`);
  if (Array.isArray(project.points) && project.points.length) {
    parts.push(`必须覆盖的论据：${project.points.slice(0, 8).join('；')}`);
  }
  if (section && section.brief) parts.push(`本节要求：${String(section.brief).slice(0, 300)}`);
  parts.push(`文档类型：${project.docTypeName}${project.depthName ? `（深度：${project.depthName}）` : ''}`);
  return parts.join('\n');
}

function intentOfNovel(book, file) {
  const parts = [];
  if (book) {
    if (book.genre) parts.push(`题材：${book.genre}`);
    if (book.pov) parts.push(`叙事视角：${book.pov}`);
    if (book.title) parts.push(`作品名：${book.title}`);
  }
  parts.push(`当前章节：${file ? file.name : '未知'}`);
  return parts.join('\n');
}

// 文档：按小节评审（sectionIdx >= 1），或整篇评审（sectionIdx = 0）。
function docWork(workId, sectionIdx) {
  const docEngine = require('./doc-engine');
  const project = docEngine.getProject(workId);
  if (!project) throw new Error('文档项目不存在');
  const idx = Math.max(0, Number(sectionIdx) || 0);
  if (idx >= 1 && project.sections[idx - 1]) {
    const section = project.sections[idx - 1];
    return {
      workbench: 'doc', workId: project.id, sectionIdx: idx, target: 'section',
      type: `doc:${project.docType}`, typeName: `${project.docTypeName}·${section.title}`,
      title: `${project.title}／第${idx}节 ${section.title}`,
      text: String(section.content || ''),
      intent: intentOfDoc(project, section),
      apply: async (instruction) => docEngine.reviseSection(project.id, idx, instruction),
    };
  }
  const assembled = docEngine.assembleMarkdown(project.id);
  return {
    workbench: 'doc', workId: project.id, sectionIdx: 0, target: 'section',
    type: `doc:${project.docType}`, typeName: `${project.docTypeName}（整篇）`,
    title: project.title, text: String(assembled.markdown || ''),
    intent: intentOfDoc(project, null),
    // 整篇不自动落改：跨节修改要逐节确认，这里只给意见，避免「一键改全文」把好段落改坏。
    apply: null,
  };
}

// 小说评审对象：不只正文章节，设定/细纲/番外/全书都可以是「作品」。
// 需求把小说工作台的产出列为「章节、全文、世界观设定、人物设定、剧情大纲、番外等」，
// 如果只认正文章节，其余产出的质量就永远进不了评审闭环。
const NOVEL_TARGETS = {
  chapter: { dirs: ['正文', 'chapters'], label: '章节', typeName: '小说·章节' },
  setting: { dirs: ['设定'], label: '设定资料', typeName: '小说·设定资料' },
  outline: { dirs: ['细纲'], label: '章节细纲', typeName: '小说·细纲' },
  reference: { dirs: ['参考'], label: '参考拆解', typeName: '小说·参考拆解' },
  extra: { dirs: ['番外', '外传', 'extra'], label: '番外', typeName: '小说·番外' },
};

function normalizeTarget(workbench, target = '') {
  if (String(workbench) === 'doc') return 'section';
  const value = String(target || '');
  return ['chapter', 'whole', 'setting', 'outline', 'reference', 'extra'].includes(value) ? value : 'chapter';
}

// 文件名排序必须带数字感知：默认的 localeCompare 会把「第10章」排到「第1章」前面，
// 而评审页与自动评审都按「排序后的第 N 个」定位文件，排错就会评错章。
const NOVEL_NAME_COLLATOR = new Intl.Collator('zh', { numeric: true, sensitivity: 'base' });

function sortedNovelFiles(group) {
  return (group && Array.isArray(group.files) ? group.files : [])
    .slice()
    .filter((file) => !/\.(png|jpe?g|webp|gif)$/i.test(String(file.name || '')))
    .sort((a, b) => NOVEL_NAME_COLLATOR.compare(String(a.name || ''), String(b.name || '')));
}

// 小说可评审对象清单：页面用它列出「章节 / 全文 / 设定 / 细纲 / 番外」。
// 返回的是目标 + 文件列表，页面不必自己理解目录结构。
function novelTargets(workId) {
  const core = require('./handlers-core');
  const tree = core.scanTree({ bookId: String(workId) });
  const bodies = sortedNovelFiles(tree.find((item) => item.groupDir === '正文' || item.groupDir === 'chapters'));
  const out = [];
  if (bodies.length) {
    out.push({
      target: 'chapter', label: '章节', typeName: '小说·章节', groupDir: '正文',
      files: bodies.map((file, index) => ({ idx: index + 1, name: file.name })),
    });
    out.push({
      target: 'whole', label: '全文', typeName: '小说·全文', groupDir: '正文',
      files: [{ idx: 0, name: `全部正文（${bodies.length} 个文件）` }],
    });
  }
  for (const key of ['setting', 'outline', 'reference']) {
    const spec = NOVEL_TARGETS[key];
    const group = tree.find((item) => spec.dirs.includes(item.groupDir));
    const files = sortedNovelFiles(group);
    if (!files.length) continue;
    out.push({
      target: key, label: spec.label, typeName: spec.typeName, groupDir: group.groupDir,
      files: files.map((file, index) => ({ idx: index + 1, name: file.name })),
    });
  }
  // 番外可能放在独立目录，也可能只是正文里名字带「番外」的文件。
  const extraGroup = tree.find((item) => NOVEL_TARGETS.extra.dirs.includes(item.groupDir));
  const extraFiles = extraGroup ? sortedNovelFiles(extraGroup) : bodies.filter((file) => /番外|外传/.test(String(file.name)));
  if (extraFiles.length) {
    out.push({
      target: 'extra', label: '番外', typeName: '小说·番外',
      groupDir: extraGroup ? extraGroup.groupDir : '正文',
      files: extraFiles.map((file, index) => ({ idx: index + 1, name: file.name })),
    });
  }
  return out;
}

// 取某一类小说评审对象的文件集合。whole = 全部正文；其余按目录/文件名识别。
function novelFilesFor(workId, target) {
  const core = require('./handlers-core');
  const tree = core.scanTree({ bookId: String(workId) });
  const norm = normalizeTarget('novel', target);
  if (norm === 'whole') {
    const group = tree.find((item) => item.groupDir === '正文' || item.groupDir === 'chapters');
    return { target: norm, typeName: '小说·全文', groupDir: '正文', files: sortedNovelFiles(group) };
  }
  const spec = NOVEL_TARGETS[norm];
  if (norm === 'extra') {
    const group = tree.find((item) => NOVEL_TARGETS.extra.dirs.includes(item.groupDir));
    const files = group
      ? sortedNovelFiles(group)
      : sortedNovelFiles(tree.find((item) => item.groupDir === '正文' || item.groupDir === 'chapters'))
        .filter((file) => /番外|外传/.test(String(file.name)));
    return { target: norm, typeName: spec.typeName, groupDir: group ? group.groupDir : '正文', files };
  }
  const group = tree.find((item) => spec.dirs.includes(item.groupDir));
  return { target: norm, typeName: spec.typeName, groupDir: group ? group.groupDir : spec.dirs[0], files: sortedNovelFiles(group) };
}

// 自动评审拿到的是章号，必须按文件名解析出的章号定位，不能把章号当排序序号。
// 章号缺失时返回 0（调用方报错），绝不退回「取第 N 个」——那正是之前串章的原因。
function novelChapterOrdinal(workId, chapterNum) {
  const n = Number(chapterNum) || 0;
  if (n <= 0) return 0;
  const bundle = novelFilesFor(workId, 'chapter');
  const matches = bundle.files
    .map((file, index) => ({ file, index: index + 1, number: chapterNumberFromName(file.name) }))
    .filter((item) => item.number === n);
  if (!matches.length) return 0;
  if (matches.length > 1) {
    throw new Error(`第${n}章对应多个正文文件（${matches.map((item) => item.file.name).join('、')}），无法确定评审对象`);
  }
  return matches[0].index;
}

// 小说：单个文件（章节/设定/细纲/番外）按文件名顺序取第 N 个；sectionIdx=0 或整本时拼接整组。
function novelWork(workId, sectionIdx, target = 'chapter') {
  const core = require('./handlers-core');
  const book = core.listBooks().find((item) => item.id === String(workId)) || null;
  const norm = normalizeTarget('novel', target);
  const bundle = novelFilesFor(workId, norm);
  if (!bundle.files.length) {
    throw new Error(`这本小说还没有「${bundle.typeName.replace('小说·', '')}」文件，无法评审`);
  }
  const bookTitle = book ? book.title || book.name || workId : workId;
  const read = (file) => core.readFileFrom({ bookId: String(workId), group: bundle.groupDir, name: file.name }) || '';
  const idx = Number(sectionIdx) || 0;
  // 全文 / 整组：只给意见，不自动落改。跨文件重写会把多份设定或章节揉成一份，
  // 这与「一键改全文」是同一类风险；要改哪一份，就进那一份单独评审。
  if (norm === 'whole' || idx <= 0) {
    const text = bundle.files.map(read).filter(Boolean).join('\n\n');
    const label = norm === 'whole' ? '全文' : `${bundle.typeName.replace('小说·', '')}（整组）`;
    return {
      workbench: 'novel', workId: String(workId), sectionIdx: 0, target: norm,
      type: 'novel', typeName: bundle.typeName,
      title: `${bookTitle}／${label}`,
      text,
      intent: intentOfNovel(book, null),
      apply: null,
    };
  }
  const index = Math.max(1, Math.min(bundle.files.length, idx));
  const file = bundle.files[index - 1];
  const text = read(file);
  return {
    workbench: 'novel', workId: String(workId), sectionIdx: index, target: norm,
    type: 'novel', typeName: bundle.typeName,
    title: `${bookTitle}／${file.name}`,
    text,
    intent: intentOfNovel(book, file),
    apply: async (instruction) => {
      const revised = await rewriteWork(text, instruction);
      if (!revised) return { ok: false, reason: '模型没有返回可用的修改稿' };
      core.writeFileTo({ bookId: String(workId), group: bundle.groupDir, name: file.name, content: revised });
      return { ok: true, chars: revised.length };
    },
  };
}

function resolveWork({ workbench = 'doc', workId = '', sectionIdx = 0, target = '' } = {}) {
  if (!workId) throw new Error('缺少作品 ID');
  return String(workbench) === 'novel'
    ? novelWork(workId, sectionIdx, target)
    : docWork(workId, sectionIdx);
}

// 修改稿：只做「按意见改」，不允许扩写或新增事实。
async function rewriteWork(text, instruction) {
  const source = String(text || '');
  // 超过单次上限就明确拒绝：截掉后半段再让模型输出「完整正文」，
  // 等于让它在没见过后文的情况下重写，落改会把原文后半段直接抹掉。
  if (source.length > APPLY_INPUT_MAX_CHARS) {
    throw new Error(`这份稿子 ${source.length} 字，超过单次落改上限 ${APPLY_INPUT_MAX_CHARS} 字：为避免只送前半段导致后文丢失，请分段修改`);
  }
  const channel = llm.activeChannel();
  if (!channel || !channel.baseUrl) throw new Error('未配置模型渠道');
  const sys = [
    '你是这份作品的作者，正在按评审意见修改自己的稿子。',
    '硬约束：不得新增未在原文出现的事实、数据、文献或引用编号；不得改变作品的核心主张；',
    '不得删除原文中已有的引用标记（如 [M2]）；篇幅不得少于原文的 85%，不得多于 125%。',
    '直接输出修改后的完整正文，不要解释、不要写「以下是」。',
  ].join('\n');
  const user = [
    `【修改要求】\n${instruction}`,
    `【原文】\n${source}`,
  ].join('\n\n');
  let out = '';
  for await (const ev of llm.chatCompletion({
    baseUrl: channel.baseUrl, apiKey: channel.key, model: channel.model || '',
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0.4, maxTokens: 8192,
  })) {
    if (ev.type === 'delta') out += ev.text;
  }
  const cleaned = out.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  // 与提示词里的「篇幅不得少于原文的 85%」一致：模型截断时宁可不落改。
  return cleaned.length >= Math.max(120, Math.ceil(source.length * APPLY_MIN_KEEP_RATIO)) ? cleaned : '';
}

// ---------- 评审员调用 ----------

function buildReviewerPrompt({ reviewer, work, skills, roundNo }) {
  const skillBlocks = [];
  if (skills.method.length) {
    skillBlocks.push(['【评审技能（方法论：先按这个框架审）】',
      skills.method.map((item) => `- ${item.name}：${item.body}`).join('\n')].join('\n'));
  }
  if (skills.style.length) {
    skillBlocks.push(['【评审风格（怎么表达）】',
      skills.style.map((item) => `- ${item.name}：${item.body}`).join('\n')].join('\n'));
  }
  if (skills.focus.length) {
    skillBlocks.push(['【评审重点（审什么，按此排序）】',
      skills.focus.map((item) => `- ${item.name}：${item.body}`).join('\n')].join('\n'));
  }
  const weights = skills.weights || {};
  const weightEntries = Object.entries(weights);
  if (weightEntries.length) {
    skillBlocks.push([
      '【维度权重（按此加权，不要自己平均）】',
      weightEntries.map(([name, value]) => `- ${name}：${value}`).join('\n'),
      '请为每个维度单独给 0~100 分并写进 dimensions；总分由系统按权重算出，你不用自己算总分。',
    ].join('\n'));
  }
  const sys = [
    `你是「${reviewer.name}」，一位独立评审员。`,
    reviewer.persona ? `【角色人设】${reviewer.persona}` : '',
    reviewer.specialty ? `【评审专长】${reviewer.specialty}` : '',
    reviewer.style ? `【风格偏好】${reviewer.style}` : '',
    `【作品类型】${work.typeName}`,
    ...skillBlocks,
    '【评审纪律】',
    '1. 只依据正文判断。正文没写的内容不要臆测为「应该有」，也不要替作者补写。',
    '2. 禁止空泛评论：「可以更深入」「有待提升」「建议加强」这类话一律不要。',
    '3. 每条问题必须指出位置（第几段/哪一句），并给出一条可执行的修改动作。',
    '4. 这是第 ' + roundNo + ' 轮评审。如果上一轮的意见已经改好，不要重复提同样的问题。',
    '5. 只输出 JSON，不要任何解释文字或代码围栏。',
  ].filter(Boolean).join('\n');
  const user = [
    `【作品】${work.title}`,
    `【正文】\n${String(work.text || '').slice(0, REVIEW_TEXT_MAX_CHARS)}`,
    '【输出格式（严格按此 JSON）】',
    '{"score": 78, "grade": "B", "summary": "3~5 句总体判断",',
    ' "highlights": [{"text": "亮点是什么", "why": "为什么好"}],',
    ' "issues": [{"severity": "fatal|major|minor", "dimension": "维度名", "text": "问题是什么", "where": "第几段"}],',
    ' "suggestions": [{"issue": "对应哪条问题", "change": "改什么", "how": "怎么改", "why": "为什么"}],',
    ' "dimensions": [{"name": "维度名（与评审重点/权重里的叫法一致）", "score": 75}],',
    ' "priority": ["按对质量提升的贡献排序的条目"],',
    ' "focus": ["本轮聚焦的维度"]}',
    '要求：issues 最多 8 条，按严重度排序；severity 只能是 fatal / major / minor；',
    'dimension 用该作品类型的通用维度（论文：论点论据/逻辑结构/数据引用/学术表达；',
    '小说：情节/人物/节奏/文笔；申报书：条件匹配/目标可行性/预算合理性/格式规范）。',
  ].join('\n\n');
  return { sys, user };
}

function clampScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function normalizeSeverity(value) {
  const text = String(value || '').toLowerCase();
  if (/fatal|致命|严重/.test(text)) return 'fatal';
  if (/major|重要|较大/.test(text)) return 'major';
  return 'minor';
}

// 按维度权重算总分：只对评审员真的给了分的维度加权，
// 没给分的维度不参与（按 0 分会把它当成「很差」，按 100 又会放水）。
// 没有权重时返回 null，由调用方退回模型自报的总分。
function weightedScore(dimensions, weights) {
  const map = weights || {};
  if (!Object.keys(map).length) return null;
  if (!Array.isArray(dimensions) || !dimensions.length) return null;
  let sum = 0;
  let totalWeight = 0;
  for (const item of dimensions) {
    const weight = Number(map[item.name]);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    sum += Number(item.score) * weight;
    totalWeight += weight;
  }
  if (!totalWeight) return null;
  return Math.max(0, Math.min(100, Math.round(sum / totalWeight)));
}

function normalizeOpinion(parsed, { reviewer, channel, latencyMs, tokens, raw, weights = {} }) {
  const issues = (Array.isArray(parsed && parsed.issues) ? parsed.issues : [])
    .map((item) => {
      if (typeof item === 'string') return { severity: 'major', dimension: '综合', text: item.trim().slice(0, 240), where: '' };
      return {
        severity: normalizeSeverity(item && item.severity),
        dimension: String(item && item.dimension || '综合').trim().slice(0, 20),
        text: String(item && item.text || '').trim().slice(0, 240),
        where: String(item && item.where || '').trim().slice(0, 40),
      };
    })
    .filter((item) => item.text)
    .sort((a, b) => (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0))
    .slice(0, 8);
  const highlights = (Array.isArray(parsed && parsed.highlights) ? parsed.highlights : [])
    .map((item) => (typeof item === 'string'
      ? { text: item.trim().slice(0, 160), why: '' }
      : { text: String(item && item.text || '').trim().slice(0, 160), why: String(item && item.why || '').trim().slice(0, 160) }))
    .filter((item) => item.text).slice(0, 6);
  const suggestions = (Array.isArray(parsed && parsed.suggestions) ? parsed.suggestions : [])
    .map((item) => ({
      issue: String(item && item.issue || '').trim().slice(0, 160),
      change: String(item && item.change || '').trim().slice(0, 200),
      how: String(item && item.how || '').trim().slice(0, 200),
      why: String(item && item.why || '').trim().slice(0, 200),
    }))
    .filter((item) => item.change).slice(0, 8);
  const dimensions = (Array.isArray(parsed && parsed.dimensions) ? parsed.dimensions : [])
    .map((item) => ({
      name: String(item && item.name || '').trim().slice(0, 20),
      score: clampScore(item && item.score),
    }))
    .filter((item) => item.name && item.score != null)
    .slice(0, 12);
  const weighted = weightedScore(dimensions, weights);
  return {
    reviewerId: reviewer.id,
    reviewerName: reviewer.name,
    modelLabel: reviewer.modelLabel || channel.label,
    // 有权重时用系统算的分：模型自报的总分经常和它自己的分维度分对不上。
    score: weighted != null ? weighted : clampScore(parsed && parsed.score),
    scoreBasis: weighted != null ? 'weighted' : 'model',
    dimensions,
    grade: String(parsed && parsed.grade || '').trim().slice(0, 8),
    summary: String(parsed && parsed.summary || '').trim().slice(0, 600),
    highlights, issues, suggestions,
    focus: (Array.isArray(parsed && parsed.focus) ? parsed.focus : []).map((item) => String(item).trim().slice(0, 40)).filter(Boolean).slice(0, 8),
    priority: (Array.isArray(parsed && parsed.priority) ? parsed.priority : []).map((item) => String(item).trim().slice(0, 160)).filter(Boolean).slice(0, 8),
    latencyMs, tokens, raw: String(raw || '').slice(0, 8000), error: '',
  };
}

async function callReviewer({ reviewer, work, skills, roundNo, signal = null, maxTokens = DEFAULT_REVIEWER_TOKENS }) {
  const channel = channelOf(reviewer.channelId);
  const { sys, user } = buildReviewerPrompt({ reviewer, work, skills, roundNo });
  const started = nowMs();
  let raw = '';
  let tokens = 0;
  for await (const ev of llm.chatCompletion({
    baseUrl: channel.baseUrl, apiKey: channel.key, model: channel.model || '',
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0.4, maxTokens, signal: signal || undefined,
  })) {
    if (ev.type === 'delta') raw += ev.text;
    if (ev.type === 'meta' && ev.usage) {
      tokens += Number(ev.usage.prompt_tokens || 0) + Number(ev.usage.completion_tokens || 0);
    }
  }
  const latencyMs = nowMs() - started;
  const cleaned = raw.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  const parsed = llm.extractJson(cleaned) || require('./doc-craft').extractJson(cleaned);
  if (!parsed) {
    throw new Error(`评审员「${reviewer.name}」没有返回可解析的 JSON（原文前 80 字：${cleaned.slice(0, 80)}）`);
  }
  return normalizeOpinion(parsed, {
    reviewer, channel, latencyMs, tokens, raw: cleaned, weights: skills.weights || {},
  });
}

// 偶发 429/5xx/连接中断值得再试一次；401/403 这类鉴权错误重试只会多打一次。
// 返回不可解析 JSON 也重试一次，但设了每轮预算时不重试——那一次调用已经花满 token，
// 再试会突破预算上限，宁可把错误如实交给作者。
const RETRYABLE_REVIEW_ERROR = /(fetch failed|timed out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network|429|(^|\D)5\d\d(\D|$))/i;
const RETRYABLE_PARSE_ERROR = /没有返回可解析的 JSON/;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    if (signal && signal.addEventListener) {
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    }
  });
}

async function callReviewerWithRetry({ allowParseRetry = true, ...args }) {
  try {
    return await callReviewer(args);
  } catch (error) {
    if (args.signal && args.signal.aborted) throw error;
    const message = String(error && error.message || error);
    const retryable = RETRYABLE_REVIEW_ERROR.test(message)
      || (allowParseRetry && RETRYABLE_PARSE_ERROR.test(message));
    if (!retryable) throw error;
    console.log(`[review] 评审员「${args.reviewer && args.reviewer.name}」首次调用失败，重试一次：${message.slice(0, 120)}`);
    await sleep(800, args.signal);
    if (args.signal && args.signal.aborted) throw error;
    return callReviewer(args);
  }
}

// ---------- 交叉验证 ----------

// 两位评审员说的是不是同一件事。
//
// 只比文字相似度是不行的，实测数据说明了原因：
//   「论证过于简略，只有结论没有机制解释」vs「论证过简，缺少机制层面的解释」= 0.333（同一问题换说法）
//   「论证缺少机制解释」vs「论证缺少数据支撑」                      = 0.429（同维度两个不同问题）
// 后者的相似度反而更高——任何单一阈值都会同时犯两种错：要么漏合并共识，要么把两个问题并成一个。
//
// 所以判据分三层：
//   1. 问题类型（缺 / 冗余 / 不一致 / 格式）不同 → 一定不是同一件事（它们甚至可能构成分歧）；
//   2. 类型相同但核心词没有重合（「机制」vs「数据」）→ 是同一维度下的两个问题；
//   3. 类型相同且核心词有重合 → 是同一件事的两种说法。
const SIGNATURE_RULES = [
  ['lack', /(简略|过简|缺少|缺失|不足|没有|单薄|不够|空泛|空洞|模糊|偏少)/],
  ['redundant', /(冗余|重复|啰嗦|过长|堆砌|偏多)/],
  ['inconsistent', /(不一致|矛盾|漂移|前后不一|自相矛盾)/],
  ['format', /(不规范|格式|体例|缺项|编号乱)/],
];

function signatureOf(text) {
  const source = String(text || '');
  return SIGNATURE_RULES.filter(([, pattern]) => pattern.test(source)).map(([name]) => name).sort().join('+');
}

// 核心词：去掉问题类型词与高频虚词之后剩下的二元字组。
// 「机制解释」与「机制层面的解释」共享「机制」；「机制」与「数据支撑」什么都不共享。
const FILLER_GRAMS = new Set([
  '这个', '那个', '以及', '并且', '而且', '但是', '所以', '因为', '如果', '可以', '需要', '应该',
  '没有', '缺少', '不足', '过于', '比较', '非常', '比较', '部分', '问题', '方面', '情况', '进行',
  '一个', '一些', '这些', '那些', '不是', '就是', '还是', '或者', '同时', '另外', '此外',
]);

function coreTokens(text) {
  const clean = String(text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const set = new Set();
  for (let i = 0; i + 2 <= clean.length; i += 1) {
    const gram = clean.slice(i, i + 2);
    if (!FILLER_GRAMS.has(gram)) set.add(gram);
  }
  return set;
}

function sameIssue(a, b) {
  const textA = String(a && a.text || '');
  const textB = String(b && b.text || '');
  if (!textA || !textB) return false;
  const sigA = signatureOf(textA);
  const sigB = signatureOf(textB);
  // 类型明确且不同：不是同一件事（过简 vs 冗余 就是这种）
  if (sigA && sigB && sigA !== sigB) return false;

  const tokensA = coreTokens(textA);
  const tokensB = coreTokens(textB);
  let shared = 0;
  for (const gram of tokensA) if (tokensB.has(gram)) shared += 1;
  const sameDimension = a.dimension && b.dimension && a.dimension === b.dimension;

  // 核心词有重合，且（类型相同或维度相同）→ 同一件事的两种说法
  if (shared >= 1 && (sigA === sigB || sameDimension)) {
    // 同维度下核心词重合太少时，要求类型一致，避免「都提到论证」就被并成一条
    if (shared >= 2 || sigA === sigB) return true;
  }
  // 没有类型词可比时退回文字相似度（阈值高，避免误并）
  if (!sigA && !sigB) {
    const score = quality.similarity(quality.bigrams(textA), quality.bigrams(textB));
    return sameDimension ? score >= 0.5 : score >= 0.7;
  }
  return false;
}

// 冲突识别：同一维度上出现方向相反的评价。
// 「论证过简」与「论证冗余」不是同一条意见的两种说法，是两种相反的修改方向——
// 盲目合并会让创作者 AI 收到「加长」和「删减」两条互斥指令。
const OPPOSITE_PAIRS = [
  [/(简略|不足|缺少|单薄|过于简|不够充分|太短)/, /(冗余|啰嗦|过长|重复|堆砌|过于详|太长)/],
  [/(过多|过量|偏多)/, /(过少|偏少)/],
  [/(过于抽象|太虚|空泛)/, /(过于琐碎|太细|细节堆砌)/],
];

function detectConflict(a, b) {
  if (a.dimension !== b.dimension) return false;
  for (const [left, right] of OPPOSITE_PAIRS) {
    if ((left.test(a.text) && right.test(b.text)) || (right.test(a.text) && left.test(b.text))) return true;
  }
  return false;
}

// 评审员给出的建议里，哪几条是在回应这条问题。
// 建议的 issue 字段是对应的问题原文；换一种说法也要能对上，所以复用 sameIssue。
function suggestionsFor(issue, suggestions) {
  const list = Array.isArray(suggestions) ? suggestions : [];
  const seen = new Set();
  return list.filter((item) => {
    if (!item || !item.change) return false;
    const anchor = String(item.issue || '').trim();
    if (!anchor) return false;
    const same = sameIssue(
      { text: anchor, dimension: issue.dimension },
      { text: issue.text, dimension: issue.dimension },
    ) || String(anchor).includes(String(issue.text).slice(0, 12))
      || String(issue.text).includes(anchor.slice(0, 12));
    if (!same) return false;
    if (seen.has(item.change)) return false;
    seen.add(item.change);
    return true;
  }).slice(0, 4);
}

// 把一条问题 + 对应建议写成可执行的修改指令。
// 只写问题原文（「论证过简」）模型会自己猜怎么改；写清「改什么/怎么改/为什么」才能落地。
function instructionOf(issue, suggestions = []) {
  if (!suggestions.length) return issue.text;
  return suggestions.map((item) => {
    const how = item.how ? `；怎么改：${item.how}` : '';
    const why = item.why ? `；为什么：${item.why}` : '';
    return `改什么：${item.change}${how}${why}`;
  }).join(' ／ ').slice(0, 500);
}

// 合并一个簇里所有评审员对同一问题的建议（按 change 去重）。
function suggestionsOf(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    for (const suggestion of item.suggestions || []) {
      const key = String(suggestion.change || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ ...suggestion, reviewer: item.reviewerName || '' });
    }
  }
  return out.slice(0, 6);
}

// 维度汇总：需求第六条要求「按维度归类」。
// 报告里给出一张维度表（问题数/采纳数/共识数/参与评审员），作者一眼能看出问题集中在哪。
function summarizeDimensions(decisions = []) {
  const map = new Map();
  for (const item of decisions) {
    const key = String(item.dimension || '综合');
    const row = map.get(key) || { dimension: key, issues: 0, adopted: 0, consensus: 0, reviewers: new Set() };
    row.issues += 1;
    if (item.adopted) row.adopted += 1;
    if (item.kind === 'consensus') row.consensus += 1;
    for (const reviewer of item.reviewers || []) row.reviewers.add(String(reviewer));
    map.set(key, row);
  }
  return [...map.values()]
    .map((row) => ({ dimension: row.dimension, issues: row.issues, adopted: row.adopted, consensus: row.consensus, reviewers: row.reviewers.size }))
    .sort((a, b) => b.issues - a.issues || b.adopted - a.adopted);
}

function crossValidate(opinions) {
  const valid = opinions.filter((item) => item && !item.error);
  const entries = [];
  for (const opinion of valid) {
    for (const issue of opinion.issues) {
      entries.push({
        ...issue,
        reviewerId: opinion.reviewerId,
        reviewerName: opinion.reviewerName,
        suggestions: suggestionsFor(issue, opinion.suggestions),
      });
    }
  }
  // 聚类：跨评审员的同一问题合并成一条「共识」
  const clusters = [];
  for (const entry of entries) {
    const hit = clusters.find((cluster) => cluster.items.some((item) => sameIssue(item, entry)));
    if (hit) hit.items.push(entry);
    else clusters.push({ items: [entry] });
  }

  // 分歧识别必须在**聚类之间**做，而不是只在聚类内部。
  // 「论证过简」与「论证冗余」是方向相反的两条意见，相似度很低、一定落在两个簇里——
  // 只在簇内比对，这类最需要仲裁的分歧永远不会被发现，两条互斥指令会一起被采纳。
  const conflictGroups = [];
  const consumed = new Set();
  for (let i = 0; i < clusters.length; i += 1) {
    if (consumed.has(i)) continue;
    for (let j = i + 1; j < clusters.length; j += 1) {
      if (consumed.has(j)) continue;
      const a = clusters[i].items[0];
      const b = clusters[j].items[0];
      if (!detectConflict(a, b)) continue;
      consumed.add(i); consumed.add(j);
      conflictGroups.push([clusters[i], clusters[j]]);
      break;
    }
  }

  const decisions = [];
  const needArbitration = [];
  // 分歧处理按「多数倾向优先」：
  //   2 票 vs 1 票 → 采纳多数、把少数意见写进理由（这正是评审机制要保留的信息）；
  //   1 票 vs 1 票 → 才需要评审组长仲裁。
  // 一有分歧就全部回抛给仲裁，既慢又贵，而且多数倾向本来就已经是可靠信号。
  for (const group of conflictGroups) {
    const sides = group.map((cluster) => ({
      items: cluster.items,
      reviewers: [...new Set(cluster.items.map((item) => item.reviewerId))],
      text: cluster.items[0].text,
      suggestions: suggestionsOf(cluster.items),
      severity: cluster.items.reduce((worst, item) => ((SEVERITY_WEIGHT[item.severity] || 0) > (SEVERITY_WEIGHT[worst] || 0) ? item.severity : worst), 'minor'),
    })).sort((a, b) => b.reviewers.length - a.reviewers.length);
    const majority = sides[0];
    const minority = sides[1];
    const allReviewers = [...new Set(sides.flatMap((side) => side.reviewers))];
    const dimension = majority.items[0].dimension || '综合';
    if (majority.reviewers.length > minority.reviewers.length) {
      const suggestions = suggestionsOf(majority.items);
      decisions.push({
        kind: 'conflict',
        dimension,
        text: majority.text,
        severity: majority.severity,
        reviewers: allReviewers,
        suggestions,
        adopted: 1,
        reason: `分歧（${majority.reviewers.length} 票 vs ${minority.reviewers.length} 票）：`
          + `按多数倾向采纳「${majority.text.slice(0, 60)}」；`
          + `少数意见已记录——「${minority.text.slice(0, 60)}」`,
        instruction: instructionOf(majority.items[0], suggestions),
      });
      continue;
    }
    const decision = {
      kind: 'conflict',
      dimension,
      text: `${majority.text} ／ ${minority.text}`,
      severity: majority.severity,
      reviewers: allReviewers,
      suggestions: [...suggestionsOf(majority.items), ...suggestionsOf(minority.items)].slice(0, 6),
      adopted: 0,
      reason: '评审员意见均分（1 票 vs 1 票）且方向相反，待复评裁决',
      instruction: '',
      // 两方原文要留着：回抛给评审团复评时，必须把「两种相反意见」原样摆出来
      sides: [
        { text: majority.text, reviewers: majority.reviewers },
        { text: minority.text, reviewers: minority.reviewers },
      ],
    };
    decisions.push(decision);
    needArbitration.push(decision);
  }
  const activeClusters = clusters.filter((cluster, index) => !consumed.has(index));
  for (const cluster of activeClusters) {
    const items = cluster.items;
    const reviewers = [...new Set(items.map((item) => item.reviewerId))];
    const severity = items.reduce((worst, item) => ((SEVERITY_WEIGHT[item.severity] || 0) > (SEVERITY_WEIGHT[worst] || 0) ? item.severity : worst), 'minor');
    const dimension = items[0].dimension || '综合';
    const suggestions = suggestionsOf(items);
    // 共识：两位以上评审员独立提出同一问题，权重最高
    if (reviewers.length >= 2) {
      decisions.push({
        kind: 'consensus',
        dimension,
        text: items[0].text,
        severity,
        reviewers,
        suggestions,
        adopted: 1,
        reason: `${reviewers.length} 位评审员独立提出同一问题，按共识处理`,
        instruction: instructionOf(items[0], suggestions),
      });
      continue;
    }
    // 单人意见：致命问题一律采纳；重要问题采纳；一般问题记录不采纳
    const adopted = severity === 'fatal' || severity === 'major';
    decisions.push({
      kind: 'single',
      dimension,
      text: items[0].text,
      severity,
      reviewers,
      suggestions,
      adopted,
      reason: adopted
        ? (severity === 'fatal' ? '单人提出但属致命问题：影响作品成立，必须改' : '单人提出但属重要问题：建议采纳')
        : '单人提出的一般问题：记录备查，本轮不改',
      instruction: instructionOf(items[0], suggestions),
    });
  }
  // conflicts 只返回真正需要仲裁的那些（平票），多数倾向已就地裁决
  return { decisions, conflicts: needArbitration, opinionCount: valid.length, issueCount: entries.length };
}

// 冲突仲裁：方案六要求「若意见均分且争议影响重大，可将该争议点单独回抛给评审团补充说明」。
//
// 所以先回抛给评审团本身：每位评审员看到「两种相反意见」的原文，各自判一次哪边更站得住。
// 票多的一方胜出——这比让一个没参与评审的「组长」拍板更符合机制的本意：
// 裁决应该来自评审团内部的分歧收敛，而不是外部权威。
// 只有复评也平票（或全部调用失败）时，才退回单一组长裁决。
async function arbitrate({ work, decisions = [], panel = null, onUsage = null, signal = null }) {
  // 只处理「待裁决的分歧」，其余原样返回。
  // 返回的是**完整决策数组**，调用方按位置合并——早先按 text 匹配，
  // 而裁决会把 text 换成胜方原文，于是匹配不上、裁决结果被静默丢弃。
  const pending = decisions.filter((item) => item.kind === 'conflict' && !item.adopted);
  if (!pending.length) return decisions;
  const channel = llm.activeChannel();
  if (!channel || !channel.baseUrl) return decisions;

  const replaced = new Map();
  // 第一步：回抛给评审团复评
  for (const conflict of pending) {
    if (!Array.isArray(conflict.sides) || conflict.sides.length < 2) continue;
    const reviewers = (panel && Array.isArray(panel.reviewers)) ? panel.reviewers : [];
    const votes = [];
    for (const reviewer of reviewers) {
      try {
        const vote = await pollConflict({
          reviewer, work, conflict, onUsage, signal,
        });
        if (vote) votes.push(vote);
      } catch { /* 单个评审员复评失败不影响其他票 */ }
    }
    const sideOne = votes.filter((item) => item.side === 1).length;
    const sideTwo = votes.filter((item) => item.side === 2).length;
    if (sideOne !== sideTwo) {
      const winnerIndex = sideOne > sideTwo ? 0 : 1;
      const winner = conflict.sides[winnerIndex];
      const loser = conflict.sides[winnerIndex === 0 ? 1 : 0];
      replaced.set(conflict, {
        ...conflict,
        adopted: 1,
        text: winner.text,
        suggestions: winner.suggestions || [],
        instruction: instructionOf({ text: winner.text }, winner.suggestions || []),
        reason: `评审团复评（${Math.max(sideOne, sideTwo)} 票 vs ${Math.min(sideOne, sideTwo)} 票）：`
          + `采纳「${winner.text.slice(0, 50)}」；另一种意见已记录——「${loser.text.slice(0, 50)}」`,
        arbitration: { mode: 'panel', votes: votes.length, sideOne, sideTwo },
      });
      continue;
    }
    // 复评仍平票：交给组长
    replaced.set(conflict, { ...conflict, arbitration: { mode: 'chief-pending', votes: votes.length, sideOne, sideTwo } });
  }

  // 用「原始决策 → 最新状态」的映射：裁决会生成新对象，
  // 若拿新对象当 key，后面组长裁决的结果会写到错的键上，合并时读不到。
  const needChief = [...replaced.entries()].filter(([, item]) => item.arbitration && item.arbitration.mode === 'chief-pending');
  const merge = () => decisions.map((item) => replaced.get(item) || item);
  if (!needChief.length) return merge();
  const sys = [
    '你是评审组长，负责裁决评审团内部的分歧。',
    '只依据正文判断哪一方更站得住，不要折中成「既要又要」。',
    '只输出 JSON。',
  ].join('\n');
  const user = [
    `【作品】${work.title}`,
    '【分歧清单】',
    ...needChief.map(([, item], index) => `${index + 1}. [${item.dimension}] ${item.text}（提出者：${item.reviewers.join('、')}）`),
    `【正文】\n${String(work.text || '').slice(0, 12000)}`,
    '【输出格式】',
    '{"rulings":[{"index":1,"winner":"意见原文里更成立的那一方","reason":"为什么","instruction":"给作者的具体修改指令"}]}',
  ].join('\n\n');
  let raw = '';
  for await (const ev of llm.chatCompletion({
    baseUrl: channel.baseUrl, apiKey: channel.key, model: channel.model || '',
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0.2, maxTokens: 1200, signal: signal || undefined,
  })) {
    if (ev.type === 'delta') raw += ev.text;
    if (ev.type === 'meta' && ev.usage && onUsage) onUsage(ev.usage);
  }
  const parsed = require('./doc-craft').extractJson(raw);
  const rulings = Array.isArray(parsed && parsed.rulings) ? parsed.rulings : [];
  needChief.forEach(([original, item], index) => {
    const ruling = rulings.find((entry) => Number(entry && entry.index) === index + 1) || null;
    if (!ruling) {
      replaced.set(original, { ...item, reason: `${item.reason}；组长裁决没有返回结论，本轮不改` });
      return;
    }
    replaced.set(original, {
      ...item,
      adopted: 1,
      reason: `评审团复评平票（${item.arbitration.sideOne} 票 vs ${item.arbitration.sideTwo} 票），由评审组长裁决：`
        + String(ruling.reason || '采纳更站得住的一方').slice(0, 180),
      instruction: String(ruling.instruction || ruling.winner || item.text).slice(0, 240),
      arbitration: { ...item.arbitration, mode: 'chief' },
    });
  });
  return merge();
}

// 向一位评审员复评一个分歧点：只让他判「哪边更站得住」，不重新审全篇。
async function pollConflict({ reviewer, work, conflict, onUsage = null, signal = null }) {
  const channel = channelOf(reviewer.channelId);
  const sys = [
    `你是「${reviewer.name}」，评审团成员。现在评审团内部出现分歧，需要你补充说明。`,
    reviewer.persona ? `【角色人设】${reviewer.persona}` : '',
    '只判断哪一方更站得住，不要折中成「两者都要注意」。只输出 JSON。',
  ].filter(Boolean).join('\n');
  const user = [
    `【作品】${work.title}（${work.typeName}）`,
    `【分歧维度】${conflict.dimension}`,
    `【意见 A】${conflict.sides[0].text}`,
    `【意见 B】${conflict.sides[1].text}`,
    `【正文节选】\n${String(work.text || '').slice(0, 6000)}`,
    '【输出格式】{"side": 1 或 2, "reason": "为什么这一方更站得住（一句话）"}',
  ].join('\n\n');
  let raw = '';
  for await (const ev of llm.chatCompletion({
    baseUrl: channel.baseUrl, apiKey: channel.key, model: channel.model || '',
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0.2, maxTokens: 400, signal: signal || undefined,
  })) {
    if (ev.type === 'delta') raw += ev.text;
    if (ev.type === 'meta' && ev.usage && onUsage) onUsage(ev.usage);
  }
  const parsed = require('./doc-craft').extractJson(raw);
  const side = Number(parsed && parsed.side);
  if (side !== 1 && side !== 2) return null;
  return { reviewerId: reviewer.id, reviewerName: reviewer.name, side, reason: String(parsed.reason || '').slice(0, 200) };
}

// ---------- 轮次 ----------

function nextRoundNo({ workbench, workId, sectionIdx, target = '' }) {
  const scope = normalizeTarget(workbench, target);
  const row = one(`SELECT COALESCE(MAX(round_no),0) AS n FROM review_rounds
    WHERE workbench=? AND work_id=? AND section_idx=? AND target=?`,
    String(workbench), String(workId), Number(sectionIdx) || 0, scope);
  return (Number(row && row.n) || 0) + 1;
}

function versionOf(text) {
  return crypto.createHash('sha1').update(String(text || '')).digest('hex').slice(0, 8);
}

function saveOpinion(roundId, opinion) {
  run(`INSERT INTO review_opinions(id,round_id,reviewer_id,reviewer_name,model_label,score,grade,summary,
      highlights_json,issues_json,suggestions_json,focus_json,dimensions_json,priority_json,raw,tokens,latency_ms,error)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    idOf('op'), roundId, opinion.reviewerId || '', opinion.reviewerName || '', opinion.modelLabel || '',
    opinion.score == null ? null : Number(opinion.score), opinion.grade || '', opinion.summary || '',
    JSON.stringify(opinion.highlights || []), JSON.stringify(opinion.issues || []),
    JSON.stringify(opinion.suggestions || []), JSON.stringify(opinion.focus || []),
    JSON.stringify(opinion.dimensions || []), JSON.stringify(opinion.priority || []),
    opinion.raw || '', Number(opinion.tokens) || 0, Number(opinion.latencyMs) || 0, opinion.error || '');
}

function saveDecision(roundId, decision) {
  run(`INSERT INTO review_decisions(id,round_id,kind,dimension,text,severity,reviewers_json,suggestions_json,adopted,reason,instruction)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    idOf('dc'), roundId, decision.kind, decision.dimension || '', decision.text || '',
    decision.severity || 'minor', JSON.stringify(decision.reviewers || []),
    JSON.stringify(decision.suggestions || []),
    decision.adopted ? 1 : 0, decision.reason || '', decision.instruction || '');
}

// 一轮评审的主流程。
// 运行中的轮次：roundId → { controller, cancelled, startedAt }。
// 规范第二条要求「用户可随时暂停或终止评审，已产生的记录与版本需完整保留」。
// 光有 UI 上的按钮不够：必须能真的打断正在飞的模型调用，否则「终止」只是不再显示进度。
const activeRounds = new Map();

function cancelRound(roundId) {
  const key = String(roundId || '');
  const entry = activeRounds.get(key);
  if (!entry) {
    // 不在内存里（进程重启过）：只把库里的状态改成 cancelled，避免页面一直转圈
    const row = one(`SELECT status FROM review_rounds WHERE id=?`, key);
    if (!row) return { ok: false, reason: '轮次不存在' };
    // 暂停中的轮次也可以终止：它们同样有已产生的意见，不能让用户只能「继续」不能放弃。
    if (row.status !== 'running' && row.status !== 'paused') {
      return { ok: false, reason: `这一轮已结束（${row.status}）` };
    }
    run(`UPDATE review_rounds SET status='cancelled', cancelled_at=?, finished_at=? WHERE id=?`, nowMs(), nowMs(), key);
    return { ok: true, cancelled: true, note: '进程内没有这一轮的执行体，已标记为已终止' };
  }
  entry.cancelled = true;
  try { entry.controller.abort(); } catch { /* 已经结束 */ }
  return { ok: true, cancelled: true };
}

// 暂停与终止的区别：终止丢弃后续流程，暂停保留已产生的意见，之后可以接着汇总。
// 暂停请求在「意见收集」阶段生效：等每位评审员这次调用返回（已花的钱不白花），
// 停下且不进入仲裁；继续时直接从汇总开始，不会重新调用评审员。
function pauseRound(roundId) {
  const key = String(roundId || '');
  const entry = activeRounds.get(key);
  if (entry) {
    if (entry.phase && entry.phase !== 'collecting') {
      return { ok: false, reason: '这一轮已进入汇总阶段，暂停会丢掉已完成的仲裁，建议等它完成或直接终止' };
    }
    entry.paused = true;
    return { ok: true, paused: true, note: '已请求暂停：本轮意见收集结束后停下，已产生的意见保留' };
  }
  const row = one(`SELECT status FROM review_rounds WHERE id=?`, key);
  if (!row) return { ok: false, reason: '轮次不存在' };
  if (row.status === 'paused') return { ok: true, paused: true, note: '已经是暂停状态' };
  if (row.status !== 'running') return { ok: false, reason: `这一轮已结束（${row.status}）` };
  run(`UPDATE review_rounds SET status='paused', paused_at=? WHERE id=?`, nowMs(), key);
  return { ok: true, paused: true, note: '进程内没有这一轮的执行体，已标记为暂停；继续时从意见汇总阶段开始' };
}

function isRoundRunning(roundId) {
  return activeRounds.has(String(roundId || ''));
}

// 起跑前校验：把「评审团找不到」「作品没正文」「轮次已满」这些错误
// 在**发起之前**就抛出来，页面能立刻提示，而不是先跳转再在后台静默失败。
function preflight({ workbench = 'doc', workId = '', sectionIdx = 0, panelId = '', target = '' } = {}) {
  const work = resolveWork({ workbench, workId, sectionIdx, target });
  if (!String(work.text || '').trim()) throw new Error('这份作品还没有正文，无法评审');
  // 必须先解析作品才知道它是什么类型，再拿类型去挑评审团。
  // 这里踩过：先 defaultPanel(workbench) 再解析作品，于是「绑定论文类型的评审团」
  // 永远匹配不到（docType 传的是空串），页面上显示着评审团、跑起来却报「还没有配置评审团」。
  const docType = String(work.type || '').includes(':') ? String(work.type).split(':')[1] : '';
  const panel = panelId ? getPanel(panelId) : defaultPanel(workbench, docType);
  if (!panel) {
    throw new Error(docType
      ? `还没有配置评审团：请组建一个「${docType}」类型或通用的评审团（1~3 位评审员）`
      : '还没有配置评审团：先在「评审团」里组建一个（1~3 位评审员）');
  }
  const roundNo = nextRoundNo({
    workbench: work.workbench, workId: work.workId, sectionIdx: work.sectionIdx, target: work.target,
  });
  // 终止条件之一：达到用户设定的评审轮次。到了就不再起新一轮，而不是让作者自己数。
  const maxRounds = Number(panel.maxRounds) || 0;
  if (maxRounds > 0 && roundNo > maxRounds) {
    throw new Error(`这个评审团设定了最多 ${maxRounds} 轮，已跑满（当前第 ${roundNo} 轮）。要接着评审请先调高轮次上限`);
  }
  // 每轮预算按评审人数硬切分：3 位评审员各 3000 是「单次上限」，不是「整轮上限」。
  // 设了预算就把每个人的 maxTokens 降到预算/人数，保证一轮最多花这么多。
  const tokenBudget = Math.max(0, Number(panel.tokenBudget) || 0);
  const reviewerCount = Math.max(1, (panel.reviewers || []).length);
  if (tokenBudget > 0 && tokenBudget < reviewerCount * MIN_REVIEWER_TOKENS) {
    throw new Error(`评审团每轮预算 ${tokenBudget} tokens 太低：${reviewerCount} 位评审员至少需要 ${reviewerCount * MIN_REVIEWER_TOKENS}（每人 ${MIN_REVIEWER_TOKENS}）`);
  }
  const maxTokensPerReviewer = tokenBudget > 0
    ? Math.max(MIN_REVIEWER_TOKENS, Math.floor(tokenBudget / reviewerCount))
    : DEFAULT_REVIEWER_TOKENS;
  return { work, panel, roundNo, maxRounds, tokenBudget, maxTokensPerReviewer };
}

async function runRound({ workbench = 'doc', workId = '', sectionIdx = 0, panelId = '', target = '', apply = false, onUsage = null } = {}) {
  const { work, panel, roundNo, maxRounds, tokenBudget, maxTokensPerReviewer } = preflight({ workbench, workId, sectionIdx, panelId, target });
  const roundId = idOf('rd');
  const version = versionOf(work.text);
  const controller = new AbortController();
  const state = { controller, cancelled: false, paused: false, phase: 'collecting', startedAt: nowMs() };
  activeRounds.set(roundId, state);
  run(`INSERT INTO review_rounds(id,workbench,work_id,section_idx,target,panel_id,round_no,version,status,created_at,intent,before_text,apply_flag)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    roundId, work.workbench, work.workId, work.sectionIdx, work.target, panel.id, roundNo, version, 'running',
    nowMs(), String(work.intent || '').slice(0, 1200), String(work.text || '').slice(0, 60000), apply ? 1 : 0);

  try {
    // 独立性：并发调用，各自一份提示词，汇总发生在全部返回之后
    const opinions = await Promise.all(panel.reviewers.map(async (reviewer) => {
      try {
        const skills = skillsFor({ reviewerId: reviewer.id, workType: work.type });
        return await callReviewerWithRetry({
          reviewer, work, skills, roundNo, signal: controller.signal,
          maxTokens: maxTokensPerReviewer, allowParseRetry: tokenBudget === 0,
        });
      } catch (error) {
        return {
          reviewerId: reviewer.id, reviewerName: reviewer.name, modelLabel: reviewer.modelLabel,
          score: null, grade: '', summary: '', highlights: [], issues: [], suggestions: [], focus: [],
          error: String(error && error.message || error).slice(0, 300),
        };
      }
    }));
    for (const opinion of opinions) saveOpinion(roundId, opinion);

    // 终止：已产生的意见保留，不再往下走（不仲裁、不落改）
    if (state.cancelled) return finishCancelled(roundId, opinions);
    // 暂停：意见收集完成后停下，已产生的意见保留；继续时跳过重新评审，直接汇总
    if (state.paused) return finishPaused(roundId, opinions);

    return await finalizeRound({ roundId, work, panel, roundNo, maxRounds, opinions, apply, state, onUsage });
  } catch (error) {
    if (state.cancelled) return finishCancelled(roundId, []);
    run(`UPDATE review_rounds SET status=?, error=?, finished_at=? WHERE id=?`,
      'failed', String(error && error.message || error).slice(0, 400), nowMs(), roundId);
    throw error;
  } finally {
    activeRounds.delete(roundId);
  }
}

// 汇总阶段：交叉验证 → 仲裁 → 可行性评估 → 落库 → 可选落改。
// 单列出来是为了暂停恢复时能从这里接着跑：评审员调用是最慢的一步，
// 继续一轮不应该把已经付费拿到的意见重新问一遍。
async function finalizeRound({ roundId, work, panel, roundNo, maxRounds, opinions, apply = false, state, onUsage = null }) {
  state.phase = 'finalizing';
  const controller = state.controller || new AbortController();
  const { decisions, issueCount } = crossValidate(opinions);
  let merged = await arbitrate({ work, decisions, panel, onUsage, signal: controller.signal });
  if (state.cancelled) return finishCancelled(roundId, opinions);

  // 可行性评估：对照作者意图判断「这条意见该不该采纳」。
  // 放在仲裁之后、落改之前——顺序反了会把已被判为不适用的意见又改回去。
  const feasibility = await assessFeasibility({
    work, decisions: merged, onUsage, signal: controller.signal,
  });
  if (feasibility.decisions) merged = feasibility.decisions;
  for (const decision of merged) saveDecision(roundId, decision);

  const valid = opinions.filter((item) => !item.error);
  // 全员失败不能标「已完成」：那会让作者以为评审跑完了、只是没意见。
  // 真实原因通常是渠道不可用/密钥失效，必须显式报出来。
  if (!valid.length) {
    const reasons = [...new Set(opinions.map((item) => item.error).filter(Boolean))];
    const message = `全部评审员调用失败：${reasons.slice(0, 2).join('；')}`.slice(0, 400);
    run(`UPDATE review_rounds SET status=?, error=?, finished_at=?, report_json=? WHERE id=?`,
      'failed', message, nowMs(),
      JSON.stringify({ failed: true, failures: opinions.map((item) => `${item.reviewerName}：${item.error}`) }),
      roundId);
    return { ok: false, roundId, error: message, report: { failed: true } };
  }
  const avg = valid.length
    ? Math.round(valid.reduce((sum, item) => sum + (Number(item.score) || 0), 0) / valid.length) : null;
  // 终止建议：连续两轮没有新的可采纳意见，说明质量已趋稳
  const previous = q(`SELECT id, score FROM review_rounds WHERE workbench=? AND work_id=? AND section_idx=?
    AND target=? AND round_no=? AND status='done'`,
    work.workbench, work.workId, work.sectionIdx, work.target, roundNo - 1)[0];
  let converged = false;
  if (previous) {
    const prevAdopted = q(`SELECT text FROM review_decisions WHERE round_id=? AND adopted=1`, previous.id)
      .map((row) => String(row.text || ''));
    const currentAdopted = merged.filter((item) => item.adopted).map((item) => String(item.text || ''));
    const fresh = currentAdopted.filter((text) => !prevAdopted.some((prev) => sameIssue({ text, dimension: '' }, { text: prev, dimension: '' })));
    converged = currentAdopted.length > 0 && fresh.length === 0;
  }
  // 评分变化：只给单轮分数看不出「改完有没有变好」，这是规范 5.3 明确要的字段
  const prevScore = previous && previous.score != null ? Number(previous.score) : null;

  let applied = null;
  if (apply) {
    applied = await applyDecisions({ work, decisions: merged });
    // 落改后的正文单独存一份：报告里要能给出「改前 / 改后」而不是只有字数差
    const afterText = applied.applied ? await reloadWorkText(work) : '';
    if (afterText) {
      run(`UPDATE review_rounds SET after_text=? WHERE id=?`, afterText.slice(0, 60000), roundId);
    }
    applied.afterChars = afterText ? afterText.length : null;
    applied.beforeChars = String(work.text || '').length;
  }

  const workChars = String(work.text || '').length;
  const report = {
    roundNo, version: versionOf(work.text), title: work.title, typeName: work.typeName, target: work.target,
    intent: String(work.intent || '').slice(0, 1200),
    // 评审员只读到前 REVIEW_TEXT_MAX_CHARS 字。长稿不能假装「审了全文」：
    // 报告里把覆盖范围写清楚，页面据此提示作者改按章节/小节评审。
    coverage: {
      totalChars: workChars,
      reviewedChars: Math.min(workChars, REVIEW_TEXT_MAX_CHARS),
      limit: REVIEW_TEXT_MAX_CHARS,
      truncated: workChars > REVIEW_TEXT_MAX_CHARS,
    },
    panel: { id: panel.id, name: panel.name, maxRounds, reviewers: panel.reviewers.map((item) => ({ name: item.name, modelLabel: item.modelLabel })) },
    scores: valid.map((item) => ({ reviewer: item.reviewerName, score: item.score, grade: item.grade })),
    average: avg,
    prevScore,
    delta: avg != null && prevScore != null ? avg - prevScore : null,
    issueCount,
    adopted: merged.filter((item) => item.adopted).length,
    rejected: merged.filter((item) => !item.adopted).length,
    conflicts: merged.filter((item) => item.kind === 'conflict').length,
    dimensions: summarizeDimensions(merged),
    feasibility: feasibility.summary,
    converged,
    applied,
    failures: opinions.filter((item) => item.error).map((item) => `${item.reviewerName}：${item.error}`),
  };
  const verdict = converged ? 'converged' : (maxRounds > 0 && roundNo >= maxRounds ? 'rounds-reached' : 'revise');
  run(`UPDATE review_rounds SET status=?, score=?, prev_score=?, verdict=?, finished_at=?, report_json=? WHERE id=?`,
    'done', avg, prevScore, verdict, nowMs(), JSON.stringify(report), roundId);
  return { ok: true, roundId, report };
}

// 从暂停处继续：评审员调用不重跑，直接进入汇总与落改。
// 页面上「暂停」之后必须能「继续」，否则暂停就等于终止，只是换了个名字。
// 校验和状态更新是同步完成的（页面调用后可以立刻跳转），真正的模型调用在返回的 Promise 里。
function resumeRound(roundId) {
  const key = String(roundId || '');
  if (activeRounds.has(key)) throw new Error('这一轮仍在收尾，请等它停下来再继续');
  const row = one(`SELECT * FROM review_rounds WHERE id=?`, key);
  if (!row) throw new Error('轮次不存在');
  if (row.status !== 'paused') throw new Error(`这一轮不是暂停状态（${row.status}），无需继续`);
  const work = resolveWork({
    workbench: row.workbench, workId: row.work_id,
    sectionIdx: Number(row.section_idx || 0), target: row.target || '',
  });
  const panel = getPanel(row.panel_id);
  if (!panel) throw new Error('这一轮的评审团已被删除，无法继续；可以终止后重新起一轮');
  const snapshot = getRound(key);
  const opinions = snapshot ? snapshot.opinions : [];
  if (!opinions.some((item) => !item.error)) {
    throw new Error('这一轮没有可用的评审意见，无法继续；请终止后重新评审');
  }
  const controller = new AbortController();
  const state = { controller, cancelled: false, paused: false, phase: 'finalizing', startedAt: nowMs() };
  activeRounds.set(key, state);
  run(`UPDATE review_rounds SET status='running', resumed_at=? WHERE id=?`, nowMs(), key);
  return finalizeRound({
    roundId: key, work, panel,
    roundNo: Number(row.round_no || 1), maxRounds: Number(panel.maxRounds) || 0,
    opinions, apply: !!Number(row.apply_flag || 0), state,
  }).catch((error) => {
    if (state.cancelled) return finishCancelled(key, opinions);
    run(`UPDATE review_rounds SET status=?, error=?, finished_at=? WHERE id=?`,
      'failed', String(error && error.message || error).slice(0, 400), nowMs(), key);
    throw error;
  }).finally(() => {
    activeRounds.delete(key);
  });
}

// 暂停后收尾：状态置 paused，意见与轮次信息保留。
function finishPaused(roundId, opinions) {
  const report = {
    paused: true,
    opinions: opinions.length,
    note: '评审已暂停，已产生的意见保留。继续时从汇总阶段开始，不会重新调用评审员。',
  };
  run(`UPDATE review_rounds SET status='paused', paused_at=?, report_json=? WHERE id=?`,
    nowMs(), JSON.stringify(report), roundId);
  return { ok: true, roundId, paused: true, report };
}

// 终止后收尾：状态置 cancelled，已写入的意见保留（规范：已产生的记录需完整保留）。
function finishCancelled(roundId, opinions) {
  const report = {
    cancelled: true,
    opinions: opinions.length,
    note: '评审被手动终止，已产生的意见保留，未执行仲裁与落改。',
  };
  run(`UPDATE review_rounds SET status='cancelled', cancelled_at=?, finished_at=?, report_json=? WHERE id=?`,
    nowMs(), nowMs(), JSON.stringify(report), roundId);
  return { ok: true, roundId, cancelled: true, report };
}

// 落改后重新读一遍正文：不同工作台的读法不同，统一在这里取。
async function reloadWorkText(work) {
  try {
    const fresh = resolveWork({
      workbench: work.workbench, workId: work.workId, sectionIdx: work.sectionIdx, target: work.target,
    });
    return String(fresh.text || '');
  } catch { return ''; }
}

// 可行性评估：对照作者意图，把「不该采纳」的意见挡下来。
//
// 规范第六条：「判断每条意见是否适用于当前作品类型、是否符合用户创作意图、是否可执行落地；
// 与用户明确表达的创作目标冲突的意见应标记为不采纳，并说明理由」。
//
// 只对已采纳的意见做一次调用（通常 3~8 条），比每条各调一次便宜得多，
// 而且判断本来就需要看到全部意见——逐条判会丢掉「这几条之间互相矛盾」的上下文。
async function assessFeasibility({ work, decisions = [], onUsage = null, signal = null } = {}) {
  const candidates = decisions.filter((item) => item.adopted);
  if (!candidates.length) return { decisions, summary: null };
  const channel = llm.activeChannel();
  if (!channel || !channel.baseUrl) return { decisions, summary: null };
  const sys = [
    '你是这份作品的负责人，正在判断评审意见是否值得执行。',
    '判断标准只有三条：是否适用于该文体、是否符合作者已声明的意图、是否可落地执行。',
    '与作者意图冲突的意见，即使评审员说得有道理，也要判为不采纳——作者的目标不是把作品改成评审员的作品。',
    '只输出 JSON。',
  ].join('\n');
  const user = [
    `【作品】${work.title}（${work.typeName}）`,
    `【作者意图】\n${String(work.intent || '（作者没有声明意图）').slice(0, 1200)}`,
    '【待判断的意见】',
    ...candidates.map((item, index) => `${index + 1}. [${item.dimension}] ${item.instruction || item.text}`),
    '【输出格式】',
    '{"rulings":[{"index":1,"applicable":true,"reason":"为什么适用/不适用（一句话）"}]}',
    '只有确实与作者意图或文体冲突时才判 false；拿不准就判 true。',
  ].join('\n\n');
  let raw = '';
  try {
    for await (const ev of llm.chatCompletion({
      baseUrl: channel.baseUrl, apiKey: channel.key, model: channel.model || '',
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      temperature: 0.2, maxTokens: 1200, signal: signal || undefined,
    })) {
      if (ev.type === 'delta') raw += ev.text;
      if (ev.type === 'meta' && ev.usage && onUsage) onUsage(ev.usage);
    }
  } catch {
    // 评估失败不阻断评审：宁可多采纳一条，也不要整轮作废
    return { decisions, summary: null };
  }
  const parsed = require('./doc-craft').extractJson(raw);
  const rulings = Array.isArray(parsed && parsed.rulings) ? parsed.rulings : [];
  if (!rulings.length) return { decisions, summary: null };

  let rejected = 0;
  const next = decisions.map((item) => {
    if (!item.adopted) return item;
    const index = candidates.indexOf(item) + 1;
    const ruling = rulings.find((entry) => Number(entry && entry.index) === index);
    if (!ruling) return item;
    if (ruling.applicable === false) {
      rejected += 1;
      return {
        ...item,
        adopted: 0,
        reason: `${item.reason}；可行性评估判为不适用——${String(ruling.reason || '与作者意图或文体不符').slice(0, 160)}`,
      };
    }
    return { ...item, reason: `${item.reason}；可行性评估通过` };
  });
  return {
    decisions: next,
    summary: { checked: candidates.length, rejected, note: rejected ? `${rejected} 条因与作者意图或文体冲突未采纳` : '全部意见与作者意图一致' },
  };
}

// 把采纳的意见转成一次修改。逐条列出来，而不是笼统「按意见修改」——
// 笼统指令会让作者模型自己挑，挑的往往是最省事的那几条。
async function applyDecisions({ work, decisions }) {
  if (!work.apply) {
    return { applied: false, reason: '这份作品不支持自动落改（整篇评审只给意见，请到具体小节执行）' };
  }
  const adopted = decisions.filter((item) => item.adopted);
  if (!adopted.length) return { applied: false, reason: '本轮没有可采纳的意见' };
  const instruction = [
    '按以下评审意见逐条修改（保留原文已有的事实、数据与引用编号，不要新增未提供的材料）：',
    ...adopted.map((item, index) => `${index + 1}. [${item.dimension}] ${item.instruction || item.text}`),
  ].join('\n');
  // 落改被拒绝（超长、模型截断、写盘失败）时保留意见与轮次，
  // 只在报告里说明「未落改」——不能因为改稿失败把整轮评审判成失败。
  try {
    const result = await work.apply(instruction);
    return { applied: !!(result && result.ok !== false), instruction, result };
  } catch (error) {
    return { applied: false, reason: String(error && error.message || error).slice(0, 300), instruction };
  }
}

function getRound(roundId) {
  const row = one(`SELECT * FROM review_rounds WHERE id=?`, String(roundId || ''));
  if (!row) return null;
  const opinions = q(`SELECT * FROM review_opinions WHERE round_id=?`, row.id).map((item) => ({
    reviewerId: item.reviewer_id, reviewerName: item.reviewer_name, modelLabel: item.model_label,
    score: item.score == null ? null : Number(item.score), grade: item.grade, summary: item.summary,
    highlights: safeJson(item.highlights_json), issues: safeJson(item.issues_json),
    suggestions: safeJson(item.suggestions_json), focus: safeJson(item.focus_json),
    dimensions: safeJson(item.dimensions_json), priority: safeJson(item.priority_json),
    latencyMs: Number(item.latency_ms || 0), tokens: Number(item.tokens || 0), error: item.error,
  }));
  const decisions = q(`SELECT * FROM review_decisions WHERE round_id=? ORDER BY adopted DESC, severity DESC`, row.id)
    .map((item) => ({
      kind: item.kind, dimension: item.dimension, text: item.text, severity: item.severity,
      reviewers: safeJson(item.reviewers_json), suggestions: safeJson(item.suggestions_json),
      adopted: !!Number(item.adopted),
      reason: item.reason, instruction: item.instruction,
    }));
  let report = null;
  try { report = JSON.parse(row.report_json || 'null'); } catch { report = null; }
  return {
    id: row.id, workbench: row.workbench, workId: row.work_id, sectionIdx: Number(row.section_idx || 0),
    target: row.target || (row.workbench === 'doc' ? 'section' : 'chapter'),
    panelId: row.panel_id, roundNo: Number(row.round_no || 1), version: row.version,
    status: row.status, score: row.score == null ? null : Number(row.score),
    prevScore: row.prev_score == null ? null : Number(row.prev_score),
    intent: String(row.intent || ''),
    beforeText: String(row.before_text || ''),
    afterText: String(row.after_text || ''),
    cancelledAt: Number(row.cancelled_at || 0),
    pausedAt: Number(row.paused_at || 0), resumedAt: Number(row.resumed_at || 0),
    verdict: row.verdict, createdAt: Number(row.created_at || 0), finishedAt: Number(row.finished_at || 0),
    error: row.error, report, opinions, decisions,
  };
}

function safeJson(raw) {
  try {
    const value = JSON.parse(raw || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function listRounds({ workbench, workId, sectionIdx = null, target = '', limit = 20 } = {}) {
  const clauses = ['workbench=?', 'work_id=?', 'target=?'];
  const args = [String(workbench), String(workId), normalizeTarget(workbench, target)];
  if (sectionIdx != null) { clauses.push('section_idx=?'); args.push(Number(sectionIdx) || 0); }
  return q(`SELECT id, round_no, status, score, verdict, created_at, finished_at, version
    FROM review_rounds WHERE ${clauses.join(' AND ')} ORDER BY round_no DESC LIMIT ?`, ...args, Math.max(1, Number(limit) || 20))
    .map((row) => ({
      id: row.id, roundNo: Number(row.round_no || 1), status: row.status,
      score: row.score == null ? null : Number(row.score), verdict: row.verdict,
      createdAt: Number(row.created_at || 0), finishedAt: Number(row.finished_at || 0), version: row.version,
    }));
}

// ---------- 蒸馏 ----------

// 从优秀作品里提炼「可迁移的评审标准」，而不是复制作品本身。
// 判据：产出的规则必须能拿去审另一篇稿子——「这篇文章用了三个小标题」不是标准，
// 「引言须在 300 字内交代研究问题与创新点」才是。
async function distillSkill({ sample = '', workType = 'doc:paper', kind = 'focus', name = '', reviewerId = '' } = {}) {
  const text = String(sample || '').trim();
  if (text.length < 300) throw new Error('蒸馏样本太短（至少 300 字），否则提炼不出可迁移的标准');
  const channel = llm.activeChannel();
  if (!channel || !channel.baseUrl) throw new Error('未配置模型渠道');
  const kindLabel = SKILL_KINDS[kind] || SKILL_KINDS.focus;
  // 优劣甄别是方案 8.2 明确要求的一步：不是所有「这篇作品的写法」都值得变成标准。
  // 优秀作品里也有平庸段落（凑字数的过渡、模板化的开头），照单全收会把噪声固化成规则，
  // 之后每个评审员都拿它扣分——这比不蒸馏更糟。
  const sys = [
    '你是评审体系设计者。任务是从一份作品里提炼「可迁移的评审标准」，供评审员审其他作品时使用。',
    '必须先做优劣甄别：这篇作品里哪些写法确实值得标准化，哪些只是这篇的个别选择或平庸之处。',
    '关键区分：不能复述作品内容，也不能写「本文结构清晰」这种评价；',
    '要写成对**任何同类作品**都成立的检查项，形如「X 部分必须包含 Y，否则扣分」。',
    '只输出 JSON。',
  ].join('\n');
  const user = [
    `【蒸馏源类型】${workType}`,
    `【要生成的 Skill 类型】${kindLabel}`,
    `【样本】\n${text.slice(0, 14000)}`,
    '【输出格式】',
    '{"name":"不超过 14 字的 Skill 名","appliesTo":["doc:paper"],"body":"3~6 条可执行检查项，每条一行，写清「检查什么、什么算不合格」",',
    ' "evidence":["样本里支撑这条标准的具体位置或写法"],',
    ' "discarded":["样本里有、但不值得标准化的写法，以及为什么不值得"]}',
    `appliesTo 用这些取值：novel / doc / doc:${String(workType).split(':')[1] || 'paper'} / *`,
    'discarded 至少写一条：如果连一条都说不出，说明你没做甄别，只是把全文抽象了一遍。',
  ].join('\n\n');
  let raw = '';
  for await (const ev of llm.chatCompletion({
    baseUrl: channel.baseUrl, apiKey: channel.key, model: channel.model || '',
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0.3, maxTokens: 1500,
  })) {
    if (ev.type === 'delta') raw += ev.text;
  }
  const parsed = require('./doc-craft').extractJson(raw);
  if (!parsed || !String(parsed.body || '').trim()) throw new Error('模型没有返回可用的 Skill 草稿');
  const body = String(parsed.body || '').trim().slice(0, 2000);
  if (body.length < 20) throw new Error('生成的 Skill 太短，无法作为评审标准使用');
  const appliesTo = parseAppliesTo(parsed.appliesTo);
  // 入库校验：适用类型必须明确，否则这条 Skill 会在所有作品上乱匹配
  const scopes = appliesTo.length ? appliesTo : [workType];
  const skillName = String(name || parsed.name || '蒸馏 Skill').slice(0, 60);

  // 入库校验（方案 8.2）：不与现有同类型 Skill 重复。
  // 重复的 Skill 不会让评审更准，只会让同一件事被扣两次分。
  const duplicate = findDuplicateSkill({ name: skillName, body, kind, scopes });
  if (duplicate) {
    throw new Error(`这条 Skill 与已有的「${duplicate.name}」高度重复（相似度 ${Math.round(duplicate.score * 100)}%），`
      + '请换一个蒸馏角度，或直接改那条 Skill');
  }
  // 甄别结果不能是空的：一条都写不出「不值得标准化」的地方，说明模型只是把全文
  // 抽象了一遍，而不是在判断哪些写法值得沉淀。这种 Skill 入库后会把噪声固化成规则。
  const discarded = (Array.isArray(parsed.discarded) ? parsed.discarded : [])
    .map((item) => String(item).trim()).filter(Boolean).map((item) => item.slice(0, 160)).slice(0, 6);
  if (!discarded.length) {
    throw new Error('模型没有指出样本里「不值得标准化」的写法，说明它没有做优劣甄别；请重试，或换一篇更有代表性的样本');
  }

  const skill = saveSkill({
    reviewerId: String(reviewerId || ''), kind, name: skillName,
    appliesTo: scopes, body, source: 'distilled',
  });
  return {
    ...skill,
    evidence: (Array.isArray(parsed.evidence) ? parsed.evidence : []).slice(0, 6),
    discarded,
  };
}

// 重复校验：同类、适用范围有交集、名字或正文高度相似。
// 阈值取 0.72——同一套标准的两种措辞通常在这个区间，而「都讲论证」的两条
// 不同检查项会低于它（实测：同一问题的两种说法约 0.33）。
function findDuplicateSkill({ name, body, kind, scopes }) {
  const existing = listSkills({ kind });
  const nameGrams = quality.bigrams(String(name || ''));
  const bodyGrams = quality.bigrams(String(body || ''));
  for (const skill of existing) {
    if (!skill.appliesTo.some((scope) => scopes.includes(scope) || scope === '*' || scopes.includes('*'))) continue;
    const nameScore = quality.similarity(nameGrams, quality.bigrams(skill.name));
    const bodyScore = quality.similarity(bodyGrams, quality.bigrams(skill.body));
    const score = Math.max(nameScore, bodyScore);
    if (score >= 0.72) return { id: skill.id, name: skill.name, score };
  }
  return null;
}

// 蒸馏源推荐（方案 8.3「平台内已获高评分的作品」）：
// 从历史评审里挑均分高的小节，作者不必自己翻找「哪篇写得好」。
function suggestDistillSources({ workbench = 'doc', limit = 8 } = {}) {
  const rows = q(`SELECT work_id, section_idx, MAX(score) AS best, MAX(round_no) AS round_no, COUNT(*) AS rounds
    FROM review_rounds WHERE workbench=? AND status='done' AND score IS NOT NULL
    GROUP BY work_id, section_idx HAVING best >= 70 ORDER BY best DESC LIMIT ?`,
    String(workbench), Math.max(1, Math.min(30, Number(limit) || 8)));
  return rows.map((row) => {
    let title = String(row.work_id);
    try {
      const work = resolveWork({ workbench, workId: row.work_id, sectionIdx: row.section_idx });
      title = work.title;
    } catch { /* 作品可能已删除，保留 id */ }
    return {
      workbench, workId: String(row.work_id), sectionIdx: Number(row.section_idx) || 0,
      title, score: Number(row.best) || null, rounds: Number(row.rounds) || 0,
    };
  });
}

// 直接从一篇高评分作品蒸馏（不必手工粘贴全文）。
async function distillFromWork({ workbench = 'doc', workId = '', sectionIdx = 0, kind = 'focus', reviewerId = '', name = '' } = {}) {
  const work = resolveWork({ workbench, workId, sectionIdx });
  if (!String(work.text || '').trim()) throw new Error('这篇作品没有正文，无法蒸馏');
  // 给一句能指导下一步的话，而不是抛一个「样本太短」让作者猜要补多少
  if (String(work.text).length < 300) {
    throw new Error(`这篇作品只有 ${String(work.text).length} 字，蒸馏不出可迁移的标准。`
      + '换一篇更完整的作品，或在「整篇」维度上蒸馏（sectionIdx=0）');
  }
  const skill = await distillSkill({
    sample: work.text, workType: work.type, kind, reviewerId, name,
  });
  return { ...skill, sourceTitle: work.title };
}

// 作品写完后自动进入评审：这是「开启状态」的定义。
//
// 两条自我约束：
//   1. **只评审、不自动落改**。自动改稿意味着「AI 未经确认就改了你的正文」，
//      而评审意见本来就该由作者决定采不采纳。自动落改留给用户在轮次页显式点。
//   2. **只跑一轮**。自动连跑多轮会在作者离开电脑时把账单翻几倍；
//      质量是否收敛是作者看到第一轮报告后的判断。
// 自动评审一次最多送多少节/章：这是「自动」的上限，不是评审引擎的上限。
// 超出的部分不静默丢弃——返回值里带上 requested/capped，页面要能告诉作者差多少。
function autoReviewSelection(idxs, maxItems) {
  const cap = Math.max(1, Math.min(AUTO_REVIEW_LIMIT, Number(maxItems) || AUTO_REVIEW_LIMIT));
  const requested = [...new Set((Array.isArray(idxs) ? idxs : [])
    .map((idx) => Math.floor(Number(idx)))
    .filter((idx) => idx > 0))];
  return { cap, requested, list: requested.slice(0, cap), capped: requested.length > cap };
}

async function autoReviewSections({ projectId, idxs = [], maxItems = AUTO_REVIEW_LIMIT } = {}) {
  const docEngine = require('./doc-engine');
  const project = docEngine.getProject(projectId);
  if (!project) return { skipped: true, reason: '文档项目不存在' };
  if (!isEnabled('doc', project.docType)) return { skipped: true, reason: '评审机制未开启' };
  const panel = defaultPanel('doc', project.docType);
  if (!panel) return { skipped: true, reason: '还没有配置评审团' };
  const { cap, requested, list, capped } = autoReviewSelection(idxs, maxItems);
  if (!list.length) return { skipped: true, reason: '没有新写的小节' };
  const results = [];
  for (const idx of list) {
    try {
      const round = await runRound({
        workbench: 'doc', workId: projectId, sectionIdx: idx, target: 'section',
        panelId: panel.id, apply: false,
      });
      results.push({ idx, title: round.report.title, roundId: round.roundId, score: round.report.average });
    } catch (error) {
      // 单节评审失败不影响其它节，也不该让整篇生成报错
      results.push({ idx, error: String(error && error.message || error).slice(0, 200) });
    }
  }
  return {
    skipped: false, panel: panel.name, sections: results,
    requested: requested.length, reviewed: results.filter((item) => !item.error).length,
    capped, maxItems: cap,
  };
}

// 小说章节写完自动进入评审：与文档侧同一条规则——只评一轮、只出意见、不自动改稿。
async function autoReviewNovelChapters({ bookId, idxs = [], panelReview = null, maxItems = AUTO_REVIEW_LIMIT } = {}) {
  if (!bookId) return { skipped: true, reason: '缺少作品 ID' };
  if (panelReview === false) return { skipped: true, reason: '本次生成取消勾选送评审团' };
  if (!isEnabled('novel')) return { skipped: true, reason: '评审机制未开启' };
  const panel = defaultPanel('novel');
  if (!panel) return { skipped: true, reason: '还没有配置评审团' };
  // idxs 是章号（生成循环给出的 n），评审对象却按文件名排序后的第 N 个文件取。
  // 章号有缺章/断更时两者不相等，必须逐章解析，不能直接把章号当序号。
  const { cap, requested, list, capped } = autoReviewSelection(idxs, maxItems);
  if (!list.length) return { skipped: true, reason: '没有新写的章节' };
  const results = [];
  for (const chapterNo of list) {
    try {
      const sectionIdx = novelChapterOrdinal(bookId, chapterNo);
      if (!sectionIdx) {
        results.push({ idx: chapterNo, error: `找不到第${chapterNo}章的正文文件，已跳过` });
        continue;
      }
      const round = await runRound({
        workbench: 'novel', workId: String(bookId), sectionIdx, target: 'chapter',
        panelId: panel.id, apply: false,
      });
      results.push({
        idx: chapterNo, sectionIdx, title: round.report.title,
        roundId: round.roundId, score: round.report.average,
      });
    } catch (error) {
      results.push({ idx: chapterNo, error: String(error && error.message || error).slice(0, 200) });
    }
  }
  return {
    skipped: false, panel: panel.name, sections: results,
    requested: requested.length, reviewed: results.filter((item) => !item.error).length,
    capped, maxItems: cap,
  };
}

module.exports = {
  MAX_REVIEWERS, WORKBENCH_LABEL, SKILL_KINDS, SEVERITY_LABEL,
  isEnabled, setEnabled, enableState, scopeStates, setScope,
  listChannels, savePanel, getPanel, listPanels, deletePanel, defaultPanel, genericLabelFor, panelWarnings,
  saveSkill, getSkill, listSkills, deleteSkill, setSkillEnabled, skillsFor, checkCompatibility, scopeMatches,
  setSkillReviewers, reviewerIdsOfSkill, skillsBoundTo, listAllReviewers,
  parseWeights, mergeWeights, weightedScore, DEFAULT_SKILLS, defaultSkillsFor,
  resolveWork, runRound, applyDecisions, getRound, listRounds,
  novelTargets, novelFilesFor, normalizeTarget, autoReviewNovelChapters,
  crossValidate, detectConflict, sameIssue, buildReviewerPrompt, distillSkill, autoReviewSections, arbitrate, pollConflict,
  summarizeDimensions, suggestionsFor, instructionOf,
  findDuplicateSkill, suggestDistillSources, distillFromWork,
  cancelRound, pauseRound, resumeRound, isRoundRunning, assessFeasibility, reloadWorkText, defaultSkillsFor, DEFAULT_SKILLS, preflight,
  rewriteWork, versionOf, nextRoundNo,
};
