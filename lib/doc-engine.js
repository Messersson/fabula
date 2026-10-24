'use strict';

// 文档工作台引擎：商业计划书 / 申报书 / 报告 / 论文 / 合同 / 自定义模板。
//
// 设计原则：小说管线（handlers-misc 的批量循环）一行不动，这里是平行的文档引擎，
// 只复用领域无关的底座——llm 调用、orchestrator 状态机（mode='doc'，小节号当章号）、
// 重试/预算/断点语义与小说完全一致。两条管线各自演化，互不污染。
//
// 两种写作方式共享同一套提示词组装：
// - AI 共创（mode='co'）：draftSection 单发起草、reviseSection 带指示改写、手工编辑落盘。
// - AI 全托管（mode='auto'）：generateDocProject 逐节批量，隔离/连续失败停机/预算暂停/续跑。
const crypto = require('node:crypto');
const { q, one, run, transaction } = require('./db');
const llm = require('./llm');
const orch = require('./longform-orchestrator');
const mis = require('./handlers-misc');

const DEFAULT_SECTION_CHARS = 800;
const MAX_CONSECUTIVE_FAILURES = 2;
const BATCH_YIELD_EVERY = 12;

// ---------- 内置文档类型 ----------
// sections 的 brief 是该节的写作要求；minChars 是门禁下限（全文含小标题）。
const DOC_TYPES = {
  bp: {
    key: 'bp', name: '商业计划书',
    tone: '商业文体：克制、专业、数据驱动；结论先行，论证跟上；不写空话与形容词堆砌。',
    sections: [
      { title: '执行摘要', brief: '一页讲清做什么、为谁、市场多大、凭什么赢、要多少钱、回报路径。', minChars: 500 },
      { title: '公司与团队', brief: '公司主体、核心团队背景与分工、组织现状。', minChars: 500 },
      { title: '产品与服务', brief: '产品体系、解决的核心痛点、差异化与壁垒。', minChars: 700 },
      { title: '市场分析', brief: '市场规模与增速、目标客群画像、需求验证依据。', minChars: 700 },
      { title: '竞争分析', brief: '主要竞品、竞争格局、本项目的定位与优劣势对比。', minChars: 500 },
      { title: '营销与增长策略', brief: '获客渠道、定价、转化路径、增长飞轮。', minChars: 600 },
      { title: '运营计划', brief: '落地节奏、里程碑、关键依赖与资源配置。', minChars: 500 },
      { title: '财务预测', brief: '收入模型、成本结构、三年预测的关键假设（缺数据处标注【待补】）。', minChars: 600 },
      { title: '融资需求与资金用途', brief: '融资金额、估值逻辑、资金用途拆分。', minChars: 300 },
      { title: '风险分析', brief: '主要经营风险与对策，逐条对应。', minChars: 400 },
    ],
  },
  proposal: {
    key: 'proposal', name: '项目申报书',
    tone: '申报文体：紧扣评审要点，条目清晰，一节一主题；用词规范，避免营销腔。',
    sections: [
      { title: '项目概述', brief: '项目名称、承担单位、建设内容、目标与周期的一段式总览。', minChars: 500 },
      { title: '立项背景与意义', brief: '政策与行业背景、现状痛点、立项必要性与预期意义。', minChars: 700 },
      { title: '目标与建设内容', brief: '总体目标分解为可考核的子目标；建设内容逐条与目标对应。', minChars: 800 },
      { title: '技术路线与方案', brief: '总体架构、关键技术、实现路径与创新点。', minChars: 800 },
      { title: '实施计划与进度安排', brief: '分阶段计划（阶段目标、时间节点、交付物）。', minChars: 500 },
      { title: '预期成果与考核指标', brief: '可量化的成果形式与验收指标，逐条编号。', minChars: 500 },
      { title: '经费预算', brief: '预算总表思路与科目说明（缺数据处标注【待补】）。', minChars: 400 },
      { title: '基础条件与团队', brief: '已有工作基础、场地设备、团队构成与分工。', minChars: 500 },
      { title: '风险分析与应对措施', brief: '技术、进度、资金等风险及对应措施。', minChars: 300 },
    ],
  },
  report: {
    key: 'report', name: '调研报告',
    tone: '报告文体：事实与判断分离，数据说话；先结论后论据，避免主观渲染。',
    sections: [
      { title: '摘要', brief: '核心发现与建议的一段式概括。', minChars: 400 },
      { title: '背景与调研方法', brief: '调研动因、范围、方法与样本说明、局限性声明。', minChars: 500 },
      { title: '现状分析', brief: '按主题分块的现状事实，引用数据须注明来源（缺数据标注【待补】）。', minChars: 900 },
      { title: '问题诊断', brief: '从现状归纳的问题清单，逐条给依据。', minChars: 600 },
      { title: '对策建议', brief: '与问题一一对应的可执行建议，注明责任层级与优先级。', minChars: 700 },
      { title: '结论', brief: '收束判断与后续行动建议。', minChars: 300 },
    ],
  },
  paper: {
    key: 'paper', name: '学术论文',
    tone: '学术文体：术语一致、论证严密、段落有主题句；禁止口语与营销表达。引用只能来自作者提供的材料，不得虚构文献。',
    sections: [
      { title: '摘要', brief: '目的、方法、结果、结论四要素摘要（200~300 字）。', minChars: 250 },
      { title: '引言', brief: '研究背景、问题提出、研究意义与文章结构。', minChars: 700 },
      { title: '文献综述', brief: '基于作者提供的文献材料梳理研究脉络；未提供文献的观点标注【待补文献】。', minChars: 900 },
      { title: '研究方法', brief: '研究设计、数据/材料来源、分析方法与信效度说明。', minChars: 700 },
      { title: '结果与分析', brief: '按研究问题组织结果，图表位置留【图/表：说明】占位。', minChars: 900 },
      { title: '讨论', brief: '结果的解释、与已有研究的对话、理论与实践意涵、局限。', minChars: 700 },
      { title: '结论', brief: '核心结论、贡献、后续研究方向。', minChars: 400 },
    ],
  },
  contract: {
    key: 'contract', name: '法律合同（共创建议）',
    tone: '合同文体：条款编号严谨（第X条），定义统一，权责对等表述；不使用模糊形容词。本工具产出的是草稿，签署前必须由专业人士审核。',
    sections: [
      { title: '合同标题与各方信息', brief: '合同名称，甲方/乙方全称、地址、联系方式（留【待补】占位）。', minChars: 200 },
      { title: '鉴于条款', brief: '签约背景与目的（Whereas 条款）。', minChars: 200 },
      { title: '定义与解释', brief: '本合同关键术语的定义条款。', minChars: 300 },
      { title: '标的与范围', brief: '合同标的物/服务内容的明确界定。', minChars: 400 },
      { title: '双方权利与义务', brief: '甲方义务、乙方义务分条列写，编号连续。', minChars: 700 },
      { title: '价款与支付', brief: '金额、币种、支付节点与方式、发票（留【待补】占位）。', minChars: 300 },
      { title: '保密条款', brief: '保密范围、期限与例外。', minChars: 250 },
      { title: '违约责任', brief: '违约情形与对应责任、赔偿上限。', minChars: 300 },
      { title: '不可抗力', brief: '不可抗力的界定与通知义务。', minChars: 150 },
      { title: '争议解决与签署栏', brief: '管辖/仲裁约定、生效条件、签署栏占位。', minChars: 200 },
    ],
  },
  custom: {
    key: 'custom', name: '自定义文档',
    tone: '通用公文文体：结构清晰、表达准确、一事一段。',
    sections: [],
  },
};

function docTypeOf(key) {
  return DOC_TYPES[String(key || 'custom')] || DOC_TYPES.custom;
}

// ---------- 模板解析 ----------
// 支持 markdown 标题（#/##/###）与中文序号（一、二、/ 1. 2. / 第一部分）两种小节划分；
// 标题下的正文并入该节 brief。无法识别出任何小节时返回空数组（由调用方决定回落）。
function parseDocTemplate(content) {
  const text = String(content || '').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const sections = [];
  const headingRe = /^(#{1,3})\s+(.+?)\s*#*\s*$|^(?:第[一二三四五六七八九十百\d]+[部分章节篇]|[一二三四五六七八九十]+、|\d+[.、．])\s*(.+)$/;
  let current = null;
  for (const line of lines) {
    const matched = line.trim().match(headingRe);
    if (matched) {
      const title = String(matched[2] || matched[3] || '').trim().replace(/^#+\s*/, '');
      if (title) {
        current = { title: title.slice(0, 120), brief: '' };
        sections.push(current);
        continue;
      }
    }
    if (current) current.brief += (current.brief ? '\n' : '') + line.trim();
  }
  for (const section of sections) {
    section.brief = String(section.brief || '').trim().slice(0, 1200);
    section.minChars = DEFAULT_SECTION_CHARS;
  }
  // 没有可识别的小节标题：整份模板当作单节。
  if (!sections.length && text.length > 40) {
    return [{ title: '正文', brief: text.slice(0, 1200), minChars: DEFAULT_SECTION_CHARS }];
  }
  return sections;
}

// ---------- 项目 CRUD ----------

function createProject({ title, docType = 'custom', mode = 'co', brief = '', template = '', sections = null, skillIds = [] } = {}) {
  const name = String(title || '').trim().slice(0, 120);
  if (!name) throw new Error('请填写文档标题');
  if (!['co', 'auto'].includes(mode)) mode = 'co';
  const type = docTypeOf(docType);
  let list = Array.isArray(sections) && sections.length
    ? sections.map((section, index) => ({
      title: String(section.title || `第${index + 1}节`).trim().slice(0, 120),
      brief: String(section.brief || '').trim().slice(0, 1200),
      minChars: Math.max(120, Number(section.minChars) || DEFAULT_SECTION_CHARS),
    }))
    : (template ? parseDocTemplate(template) : type.sections.map((section) => ({ ...section })));
  if (!list.length) {
    if (type.key === 'custom') throw new Error('自定义文档需要上传模板或手动填写小节');
    list = [{ title: '正文', brief: '', minChars: DEFAULT_SECTION_CHARS }];
  }
  const id = crypto.randomUUID();
  const stamp = Date.now();
  const skillJson = JSON.stringify(resolveSkills(skillIds).map((skill) => skill.id));
  transaction(() => {
    run(`INSERT INTO doc_projects(id,title,doc_type,mode,status,brief,skills_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`, id, name, type.key, mode, 'drafting', String(brief || '').trim().slice(0, 4000), skillJson, stamp, stamp);
    for (let index = 0; index < list.length; index++) {
      run(`INSERT INTO doc_sections(project_id,idx,title,brief,content,status,source,updated_at)
        VALUES(?,?,?,?,?,'planned','',?)`, id, index + 1, list[index].title, list[index].brief, '', stamp);
    }
  });
  return getProject(id);
}

// 把传入的技能 id/名称解析成技能行（对话面板勾选 → 生成提示词注入）。
// 广场里的所有技能都可勾选，包括已停用的（作者明确点名时以作者意图为准）。
function resolveSkills(skillIds) {
  const wanted = (Array.isArray(skillIds) ? skillIds : []).map((item) => String(item || '').trim()).filter(Boolean);
  if (!wanted.length) return [];
  const wantedSet = new Set(wanted);
  return mis.listSkills().filter((skill) => wantedSet.has(skill.id) || wantedSet.has(skill.name));
}

function listProjects() {
  return q(`SELECT p.*, COUNT(s.idx) AS total,
    SUM(CASE WHEN s.status='done' THEN 1 ELSE 0 END) AS done
    FROM doc_projects p LEFT JOIN doc_sections s ON s.project_id=p.id
    GROUP BY p.id ORDER BY p.updated_at DESC`).map((row) => ({
    id: row.id, title: row.title, docType: row.doc_type, mode: row.mode,
    status: row.status, brief: row.brief, lastError: row.last_error || '',
    total: Number(row.total || 0), done: Number(row.done || 0),
    updatedAt: Number(row.updated_at || 0),
  }));
}

function getProject(id) {
  const row = one(`SELECT * FROM doc_projects WHERE id=?`, String(id || ''));
  if (!row) return null;
  const sections = q(`SELECT * FROM doc_sections WHERE project_id=? ORDER BY idx`, row.id).map((section) => ({
    idx: Number(section.idx), title: section.title, brief: section.brief || '',
    content: section.content || '', status: section.status, source: section.source || '',
    minChars: 0,
  }));
  let skillIds = [];
  try { skillIds = JSON.parse(row.skills_json || '[]') || []; } catch {}
  return {
    id: row.id, title: row.title, docType: row.doc_type, mode: row.mode,
    status: row.status, brief: row.brief || '', lastError: row.last_error || '',
    skillIds: Array.isArray(skillIds) ? skillIds : [],
    skills: resolveSkills(skillIds),
    createdAt: Number(row.created_at || 0), updatedAt: Number(row.updated_at || 0),
    sections,
    typeName: docTypeOf(row.doc_type).name,
    tone: docTypeOf(row.doc_type).tone,
  };
}

function deleteProject(id) {
  const key = String(id || '');
  transaction(() => {
    run(`DELETE FROM doc_sections WHERE project_id=?`, key);
    run(`DELETE FROM doc_projects WHERE id=?`, key);
    run(`DELETE FROM chapter_runs WHERE run_id IN (SELECT id FROM generation_runs WHERE book_id=?)`, key);
    run(`DELETE FROM generation_attempts WHERE run_id IN (SELECT id FROM generation_runs WHERE book_id=?)`, key);
    run(`DELETE FROM generation_runs WHERE book_id=?`, key);
  });
  return { ok: true };
}

function touchProject(id, { status = null, error = null } = {}) {
  const stamp = Date.now();
  if (status) {
    run(`UPDATE doc_projects SET status=?, last_error=?, updated_at=? WHERE id=?`, status, error, stamp, id);
  } else {
    run(`UPDATE doc_projects SET updated_at=? WHERE id=?`, stamp, id);
  }
}

function saveSectionContent(projectId, idx, content, source) {
  const text = String(content || '').trim();
  run(`UPDATE doc_sections SET content=?, status=?, source=?, updated_at=? WHERE project_id=? AND idx=?`,
    text, text ? 'done' : 'planned', String(source || 'manual'), Date.now(), projectId, Number(idx));
  touchProject(projectId);
  return { ok: true };
}

function assembleMarkdown(projectId) {
  const project = getProject(projectId);
  if (!project) return null;
  const type = docTypeOf(project.docType);
  const parts = [`# ${project.title}`, '', project.brief ? `> ${project.brief.replace(/\n/g, '\n> ')}` : '', ''];
  for (const section of project.sections) {
    parts.push(`## ${section.title}`, '');
    parts.push(section.content || `（${section.status === 'quarantined' ? '生成失败，待处理' : '未撰写'}）`);
    parts.push('');
  }
  if (project.docType === 'contract') {
    parts.push('---', '', '> 本文档由 AI 辅助起草，不构成法律意见；签署前必须经专业人士审核。', '');
  }
  return { title: project.title, typeName: type.name, markdown: parts.join('\n') };
}

// ---------- 提示词组装（两种方式共用） ----------

function outlineText(sections) {
  return sections.map((section, index) => `${index + 1}. ${section.title}${section.brief ? `：${section.brief.slice(0, 160)}` : ''}`).join('\n');
}

function previousTail(sections, idx, maxChars = 900) {
  const parts = [];
  let used = 0;
  for (let i = idx - 1; i >= 0 && used < maxChars; i--) {
    const content = String(sections[i].content || '').trim();
    if (!content) continue;
    const head = `【第${i + 1}节：${sections[i].title}】\n${content.slice(0, 500)}`;
    parts.unshift(head);
    used += head.length;
  }
  return parts.join('\n\n');
}

function buildMessages({ project, idx, instruction = '', revision = null, skills = null }) {
  const type = docTypeOf(project.docType);
  const section = project.sections[idx - 1];
  if (!section) throw new Error('小节不存在');
  const minChars = Math.max(200, Math.min(3000, section.brief && section.brief.length > 800 ? 1200 : DEFAULT_SECTION_CHARS));
  // 叠加技能：对话面板勾选的技能模板注入系统提示词（与小说对话的 @技能 同语义）。
  const skillList = skills === null ? (project.skills || []) : resolveSkills(skills);
  const skillBlocks = skillList.map((skill) => `【叠加技能：${skill.name}】\n${skill.promptTemplate || ''}`);
  const sys = [
    '你是一位资深中文文书撰写专家，按照给定文档类型与结构撰写高质量文稿。',
    `【文档类型】${type.name}`,
    `【文体要求】${type.tone}`,
    project.docType === 'contract'
      ? '这是合同草稿：条款编号用「第X条」连续编号；信息未给出处一律写【待补】，禁止虚构当事人、金额或日期。'
      : '事实与数据未给出处一律标注【待补】，禁止编造数据、引用或文献；不输出任何写作说明或元信息。',
    ...(skillBlocks.length ? [skillBlocks.join('\n\n'), '以上叠加技能只取其方法与文风要求，产出仍须贴合本文档类型与本节任务。'] : []),
    '直接输出该节正文（可含小节标题），不要解释你的写法。',
  ].join('\n');
  const user = [
    `【文档主题】${project.title}`,
    project.brief ? `【项目说明】\n${project.brief}` : '',
    `【全文结构】\n${outlineText(project.sections)}`,
    `【已写内容摘要】\n${previousTail(project.sections, idx) || '（这是第一节）'}`,
    revision
      ? `【当前稿】\n${String(revision).slice(0, 6000)}`
      : '',
    `【本节任务】写第 ${idx} 节「${section.title}」。${section.brief ? `要求：${section.brief}` : ''}`,
    `篇幅不少于约 ${minChars} 字。`,
    instruction ? `【作者指示】${instruction}` : '',
  ].filter(Boolean).join('\n\n');
  return { sys, user, minChars, section };
}

async function generateOnce({ sys, user, onUsage = null }) {
  const chn = llm.activeChannel();
  if (!chn || !chn.baseUrl) throw new Error('未配置模型渠道');
  let out = '';
  for await (const ev of llm.chatCompletion({
    baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model || 'deepseek-chat',
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0.55, maxTokens: 8192,
  })) {
    if (ev.type === 'delta') out += ev.text;
    if (ev.type === 'meta' && ev.usage) onUsage?.(ev.usage);
  }
  // 剥掉模型偶尔加的代码围栏。
  return out.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
}

// ---------- AI 共创 ----------

async function draftSection(projectId, idx, { instruction = '', skillIds = null } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const { sys, user, minChars } = buildMessages({ project, idx, instruction, skills: skillIds });
  const content = await generateOnce({ sys, user });
  if (content.length < Math.max(120, minChars * 0.25)) {
    throw new Error(`起草内容过短（${content.length} 字），请重试或补充本节要求`);
  }
  saveSectionContent(projectId, idx, content, 'ai-draft');
  return { ok: true, chars: content.length };
}

async function reviseSection(projectId, idx, instruction, { skillIds = null } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const section = project.sections[idx - 1];
  if (!section) throw new Error('小节不存在');
  if (!String(instruction || '').trim()) throw new Error('请填写修改指示');
  if (!section.content) return draftSection(projectId, idx, { instruction, skillIds });
  const { sys, user } = buildMessages({ project, idx, instruction, revision: section.content, skills: skillIds });
  const content = await generateOnce({ sys, user });
  if (!content) throw new Error('模型没有返回修改稿');
  saveSectionContent(projectId, idx, content, 'ai-revise');
  return { ok: true, chars: content.length };
}

// 切换项目的写作方式（共创 / 全托管）。只影响后续动作：共创下输入条做单节起草/修改，
// 全托管下用「整篇生成」批量推进；已有内容两种方式都不覆盖。
function setProjectMode(projectId, mode) {
  if (!['co', 'auto'].includes(String(mode))) throw new Error('无效的写作方式');
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  run(`UPDATE doc_projects SET mode=?, updated_at=? WHERE id=?`, mode, Date.now(), projectId);
  return { ok: true, mode };
}

// 更新项目绑定的技能（对话面板勾选后持久化，整篇批量与续跑沿用同一份）。
function setProjectSkills(projectId, skillIds) {
  const list = resolveSkills(skillIds).map((skill) => skill.id);
  run(`UPDATE doc_projects SET skills_json=?, updated_at=? WHERE id=?`, JSON.stringify(list), Date.now(), projectId);
  return { ok: true, skillIds: list };
}

// AI 续写下一个未完成的小节（全托管思路的单步版：不批量，一次推一节）。
async function continueNextSection(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const next = project.sections.find((section) => section.status !== 'done');
  if (!next) return { ok: true, done: true, message: '全部小节已完成' };
  const result = await draftSection(projectId, next.idx, {});
  return { ...result, idx: next.idx, title: next.title };
}

// ---------- AI 全托管（批量引擎） ----------
//
// 复用 orchestrator 状态机：mode='doc'，小节号即章号。隔离/连续失败停机/
// 预算暂停/断点续跑与小说管线语义一致，/status 页与 resume 入口同样生效。

function sectionGate(content, minChars) {
  const text = String(content || '');
  if (!text || text.length < 30) return '内容为空或过短';
  if (text.length < Math.max(120, minChars * 0.25)) return `篇幅不足（${text.length}/${minChars} 字下限）`;
  if (/^\s*\{["[]/.test(text)) return '输出疑似 JSON 而非文稿';
  return '';
}

async function generateDocProject({ projectId, resumeRunId = '', maxRetries = 3, retryBaseDelayMs = 800,
  maxTokensPerRun = 0, maxTokensPerSection = 0, escalateRetry = true } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const start = 1;
  const end = project.sections.length;
  let runId = String(resumeRunId || '');
  if (runId) {
    const existing = orch.getRun(runId);
    if (!existing || existing.bookId !== String(projectId)) runId = '';
  }
  if (!runId) {
    runId = orch.createRun({
      bookId: String(projectId), mode: 'doc', fromChapter: start, toChapter: end,
      maxRetries, options: { docEngine: true, maxTokensPerRun, escalateRetry },
    })?.id || '';
  }
  const created = [];
  const skipped = [];
  const quarantined = [];
  let stopReason = '';
  let runStatus = 'failed';
  let consecutiveFailures = 0;
  let sectionTokens = 0;
  const perSectionBudget = maxTokensPerSection > 0 ? maxTokensPerSection : 0;
  const sections = getProject(projectId).sections;

  const assertBudget = () => {
    if (perSectionBudget > 0 && sectionTokens > perSectionBudget) {
      throw Object.assign(new Error(`本节累计消耗 ${sectionTokens} tokens，超过单节上限 ${perSectionBudget}`), { code: 'TOKEN_RUNAWAY' });
    }
  };

  try {
    for (let idx = 1; idx <= sections.length; idx++) {
      const section = sections[idx - 1];
      if (runId) orch.ensureChapterRun({ runId, bookId: String(projectId), chapterNum: idx });
      if (section.content && section.status === 'done') {
        skipped.push(idx);
        if (runId) orch.markChapterCommitted({
          runId, bookId: String(projectId), chapterNum: idx, title: section.title,
          quality: { gate: 'skipped', reason: 'existing' }, attemptCount: 0,
        });
        continue;
      }
      let lastFailure = '';
      let body = '';
      let attempts = 0;
      try {
        body = await orch.executeWithRetry({
          runId, bookId: String(projectId), chapterNum: idx, phase: 'section',
          maxAttempts: Math.max(1, maxRetries), baseDelayMs: retryBaseDelayMs,
          shouldRetry: (error, kind) => !['cancelled', 'auth', 'context', 'budget'].includes(kind),
          onRetry: ({ error }) => { lastFailure = String(error.message || error).slice(0, 200); },
          task: async (attemptNo, recordUsage) => {
            attempts = attemptNo;
            sectionTokens = 0;
            const hint = escalateRetry && attemptNo > 1 && lastFailure
              ? `\n\n【上一次尝试被判定不合格】${lastFailure}\n本次必须修正并达到篇幅要求。`
              : '';
            const fresh = getProject(projectId);
            const { sys, user, minChars } = buildMessages({
              project: fresh, idx, instruction: hint ? '按上一次失败原因修正重写。' : '',
            });
            const content = await generateOnce({
              sys, user: user + hint,
              onUsage: (usage) => {
                recordUsage(usage);
                sectionTokens += Number(usage.prompt_tokens || 0) + Number(usage.completion_tokens || 0);
              },
            });
            assertBudget();
            const failure = sectionGate(content, minChars);
            if (failure) throw Object.assign(new Error(`质量门禁未通过：${failure}`), { code: 'QUALITY_GATE' });
            return content;
          },
        });
      } catch (error) {
        if (error && error.code === 'BATCH_CANCELLED') throw error;
        const message = error instanceof Error ? error.message : String(error);
        quarantined.push({ idx, title: section.title, message });
        run(`UPDATE doc_sections SET status='quarantined', updated_at=? WHERE project_id=? AND idx=?`,
          Date.now(), projectId, idx);
        if (runId) orch.setChapterStatus(runId, idx, 'quarantined', { bookId: String(projectId), error: message, attemptCount: attempts });
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stopReason = `连续 ${consecutiveFailures} 节失败，已停机：${message.slice(0, 120)}`;
          break;
        }
        continue;
      }
      saveSectionContent(projectId, idx, body, 'ai-batch');
      created.push(idx);
      consecutiveFailures = 0;
      if (runId) {
        orch.markChapterCommitted({
          runId, bookId: String(projectId), chapterNum: idx, title: section.title,
          quality: { gate: 'passed', chars: body.length, attempts }, attemptCount: attempts,
        });
      }
      if (maxTokensPerRun > 0 && runId) {
        const spent = orch.runUsage(runId).totalTokens;
        if (spent >= maxTokensPerRun) {
          stopReason = `累计消耗 ${spent} tokens 已达到上限 ${maxTokensPerRun}`;
          runStatus = 'paused_budget';
          orch.pauseRun(runId, stopReason);
          break;
        }
      }
      if (idx % BATCH_YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    if (runStatus !== 'paused_budget') runStatus = quarantined.length ? 'quarantined' : 'completed';
  } catch (error) {
    runStatus = 'failed';
    if (runId) orch.quarantineRun(runId, String(error.message || error));
    touchProject(projectId, { status: 'failed', error: String(error.message || error).slice(0, 400) });
    throw error;
  }
  if (runId) {
    if (runStatus === 'completed') orch.completeRun(runId);
    else if (runStatus === 'quarantined') orch.quarantineRun(runId, quarantined[quarantined.length - 1]?.message || '存在被隔离的小节');
  }
  touchProject(projectId, {
    status: runStatus === 'completed' ? 'done' : runStatus,
    error: stopReason || '',
  });
  return { ok: !quarantined.length && !stopReason, runId, created, skipped, quarantined, stopReason, runStatus };
}

// 文档任务的续跑：重排未提交小节并重新拉起批量引擎（复用原 run）。
async function resumeDocRun(runId, args = {}) {
  const point = orch.resumePoint(String(runId || ''));
  if (!point) throw new Error('生成任务不存在');
  if (!orch.ACTIVE_STATUSES.includes(point.run.status)) {
    throw new Error(`任务已结束（${point.run.status}），无法续跑`);
  }
  if (point.fromChapter > point.toChapter) {
    return { ok: true, skipped: true, message: '所有小节已提交，无需续跑' };
  }
  const reopened = orch.reopenChapters(runId, point.reopen);
  orch.resumeRun(runId);
  const result = await generateDocProject({
    projectId: point.run.bookId, resumeRunId: runId,
    maxRetries: args.maxRetries || point.run.maxRetries,
    retryBaseDelayMs: args.retryBaseDelayMs,
    maxTokensPerRun: args.maxTokensPerRun != null ? Number(args.maxTokensPerRun) : 0,
  });
  return { ...result, resumed: true, fromSection: point.fromChapter, reopened };
}

module.exports = {
  DOC_TYPES, docTypeOf, parseDocTemplate,
  createProject, listProjects, getProject, deleteProject, saveSectionContent,
  assembleMarkdown, buildMessages, draftSection, reviseSection,
  setProjectMode, continueNextSection, setProjectSkills,
  generateDocProject, resumeDocRun, sectionGate,
};
