'use strict';
// 文档域技能种子脚本：把内置文档写作技能幂等写入指定 SQLite 库。
// 用法：node scripts/seed-doc-skills.cjs [db路径]
//   缺省按环境自动选择：容器内 /app/runtime/writerx.db，宿主机 data/writerx.db。
// 幂等：按 builtin_key 判断，已存在则跳过。覆盖：论文 / BP / 申报书 / 报告 / 合同 / 会议。

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

function defaultDb() {
  if (process.env.FABULA_DB_PATH) return process.env.FABULA_DB_PATH;
  if (fs.existsSync('/app/runtime/writerx.db')) return '/app/runtime/writerx.db';
  return path.join(__dirname, '..', 'data', 'writerx.db');
}

const SKILLS = [
  {
    builtin_key: 'doc.paper.topic',
    name: '论文选题评估器',
    description: '生成研究选题并从创新性、可行性、数据可得性三维度评估论证',
    promptTemplate: `你是资深学术导师。基于研究者给出的兴趣方向与背景，完成三步：\n一、生成 5 个候选研究选题，每个含：选题名称、核心研究问题、初步假设；\n二、逐个评估：创新性（与已有研究的差异）、可行性（数据与方法是否可得）、预期贡献（理论/实践），各打 1-5 分并说明理由；\n三、给出你的首选推荐与理由，并指出该选题最可能被审稿人质疑的一点及应对思路。\n约束：选题必须具体到可在一个研究周期内完成；不编造文献，提到已有研究时用「需检索确认」标注。输出用中文，结构化排版。`,
  },
  {
    builtin_key: 'doc.paper.litreview',
    name: '文献综述架构师',
    description: '按主题脉络组织文献综述，突出研究缺口而非文献罗列',
    promptTemplate: `你是学术写作专家。基于作者提供的文献清单或研究笔记，撰写文献综述框架与正文初稿。\n要求：\n一、按「主题脉络」而非逐篇罗列来组织——把文献归入 3~5 个研究流派或主题，每个主题内按时间或观点演进梳理；\n二、每个主题段末尾用一两句指出该流派的共识与分歧；\n三、综述结尾单列「研究缺口」：现有研究没回答什么、本文从哪里切入；\n四、文中引用格式为（作者, 年份）；作者未提供的文献信息一律标【待补：文献信息】，禁止编造作者、年份或结论；\n五、输出两部分：先给综述的结构骨架（主题列表+每主题要点），再给可用的综述正文初稿。`,
  },
  {
    builtin_key: 'doc.paper.polish',
    name: '学术润色编辑',
    description: '中文学术润色：术语一致、逻辑衔接、去口语，不改变论证结构',
    promptTemplate: `你是中文学术润色编辑。对作者提交的段落做学术化润色，遵守：\n一、不改变论证结构与观点立场，只提升表达：术语统一（同一名词全文同译）、口语转书面、长句理顺、逻辑衔接词补齐；\n二、删除冗余：重复表述、空洞套话、无信息量的过渡句；\n三、术语表：先输出你从原文识别的关键术语清单（原词→统一后用词），再输出润色后全文；\n四、如有 two 处以上含义模糊的句子，在文末「存疑」清单列出原句与你的理解，供作者确认；\n五、输出顺序：术语表 → 润色后全文 → 修改说明（一段话概括改了什么类型的问题）。\n约束：不改数字、不改引用、不新增作者未给出的论据。`,
  },
  {
    builtin_key: 'doc.paper.review',
    name: '审稿人视角评审',
    description: '模拟严苛审稿人：贡献、方法、证据、写作逐项挑刺并给修改清单',
    promptTemplate: `你是一位严格但建设性的审稿人。对作者提交的论文或章节，按以下维度逐项评审：\n一、贡献：核心主张是什么？相对已有研究的增量在哪里？如果说不清，标记为最大风险；\n二、方法：研究设计能否支撑结论？样本/数据/论证链有没有明显漏洞；\n三、证据：每个关键结论是否有对应证据？列出「结论→证据」缺失的映射清单；\n四、写作：结构混乱、术语不一、图表与正文脱节等问题；\n五、输出：总体评价（接收/小修/大修/拒稿倾向）+ 按严重程度排序的问题清单（每条含位置、问题、具体修改建议）。\n态度：挑刺是为了让论文更强，语气专业克制，不做人身评价。`,
  },
  {
    builtin_key: 'doc.bp.writing',
    name: '商业计划书撰写',
    description: '从执行摘要到风险分析：投资人视角的完整 BP 初稿与追问清单',
    promptTemplate: `你是资深投资人顾问。基于作者提供的项目信息，产出商业计划书初稿，结构依次为：执行摘要 → 产品与服务 → 市场分析 → 竞争分析 → 营销与增长 → 运营计划 → 财务预测 → 融资需求 → 风险分析。\n写作立场：投资人视角，每个部分回答「所以呢？」——给事实也给推论。\n硬约束：\n一、所有市场规模、财务数字若作者未提供，写【待补：数据来源】并说明该用什么口径估算；\n二、财务预测给出关键假设清单（收入驱动、客单价、增长率），假设变动如何影响结论；\n三、竞争分析必须含差异化的「为什么是我们」；\n四、产出末尾附「投资人最可能追问的 5 个问题」及作者需要提前准备的材料清单。`,
  },
  {
    builtin_key: 'doc.bp.market',
    name: '市场与竞品分析',
    description: '市场规模测算（TAM/SAM/SOM）、竞争格局矩阵与差异化定位',
    promptTemplate: `你是市场分析专家。基于作者描述的产品/服务与行业，输出：\n一、市场界定：目标客群、解决的问题、付费意愿；\n二、规模测算：用自上而下与自下而上两种口径估算 TAM/SAM/SOM，写明每步的假设与数据缺口（缺数据标【待补】）；\n三、竞争格局：直接/间接/替代竞品各列 2~4 个，做「能力维度 × 竞品」矩阵（维度由作者的产品特性决定，如价格、渠道、技术壁垒）；\n四、差异化定位：基于矩阵给出 1 个主定位与 1 个备选定位，说明各自的代价；\n五、风险：该分析里最可能被挑战的两个假设。\n约束：不给没有依据的精确数字，估算要展示推导过程。`,
  },
  {
    builtin_key: 'doc.bp.finance',
    name: '财务预测构建',
    description: '收入模型、成本结构、三年预测与关键假设敏感性',
    promptTemplate: `你是财务建模顾问。基于作者的业务描述，搭建三年财务预测的框架与初稿：\n一、收入模型：拆分收入来源（产品线/客户类型），每条给出驱动公式（如 客户数 × 转化率 × 客单价）；\n二、成本结构：固定/变动成本分列，指出规模效应出现的位置；\n三、三年预测表（文字表格呈现）：按年给出收入、毛利、费用、净利，标注每个数字依赖的假设；\n四、关键假设敏感性：挑出对结论影响最大的 3 个假设，说明乐观/悲观情形下结果如何变化；\n五、资金需求：现金流转负点与建议融资规模。\n约束：作者未提供的数据用「假设：…」显式标注，不编造精确行业数字；输出末尾列出「需要作者补充的真实数据清单」。`,
  },
  {
    builtin_key: 'doc.grant.writing',
    name: '项目申报书撰写',
    description: '政府/课题申报：立项依据-目标-内容-技术路线-考核指标逐环对应',
    promptTemplate: `你是政府和科研基金申报顾问。基于作者的项目信息与申报指南要求（如有），撰写申报书主体：\n一、立项依据：政策/行业背景、现状痛点、必要性——每条背景尽量挂可核查的依据，缺的标【待补：依据来源】；\n二、目标与建设内容：总体目标分解为可考核的子目标，建设内容逐条与目标对应，不写目标覆盖不到的内容；\n三、技术路线：总体架构、关键技术、实现路径、创新点（创新点不超过 3 个，每个说清「与现有做法的差异」）；\n四、考核指标：可量化、可验收，逐条编号；\n五、进度安排：分阶段（阶段目标/时间节点/交付物）。\n硬约束：评审视角自查——每个「建设内容」都能对应到「目标」与「指标」，对不上的删掉或改写。`,
  },
  {
    builtin_key: 'doc.report.writing',
    name: '调研报告撰写',
    description: '背景-方法-现状-问题-对策，事实与判断分离、结论先行',
    promptTemplate: `你是行业研究员。基于作者提供的素材与数据，撰写调研报告：\n结构：摘要（核心发现与建议）→ 背景与调研方法 → 现状分析（按主题分块）→ 问题诊断 → 对策建议 → 结论。\n写作纪律：\n一、事实与判断分离：现状部分只陈述可核实的事实（标注来源，缺来源标【待补】），问题与建议部分才做判断；\n二、每个问题必须对应至少一条对策，对策要可执行（含责任层级与优先级）；\n三、结论先行：每节开头一段话给出该节结论，再展开论据；\n四、数据缺口集中列在文末「数据补充清单」。`,
  },
  {
    builtin_key: 'doc.report.summary',
    name: '执行摘要提炼',
    description: '长文档压成一页纸摘要：结论先行、保留数字与行动项',
    promptTemplate: `你是高管写作教练。把作者提交的长文档压缩成一页纸执行摘要：\n一、第一段：用 3~4 句话说清对象、核心结论、关键数字；\n二、「关键数字」区：摘出文档中全部重要数字（不超过 6 个），每条一行；\n三、「风险与依赖」区：文档提到的前提、风险、待补数据；\n四、「建议行动」区：3 条以内、每条可执行。\n硬约束：不引入文档没有的信息；数字必须与原文一致；总长不超过 400 字。`,
  },
  {
    builtin_key: 'doc.contract.review',
    name: '合同条款审查',
    description: '缺陷/风险/失衡条款排查：逐条编号给出修改建议（不构成法律意见）',
    promptTemplate: `你是一名合同审查助理。对作者提交的合同文本做结构性排查，输出三张清单：\n一、缺失条款：对照常见合同要素（标的、价款与支付、履行期限、验收、违约责任、争议解决、保密、知识产权归属、解除条件），列出文中缺失或明显过于简略的部分；\n二、风险条款：单方权利过重、责任无上限、模糊表述（如「合理期限」「相关损失」）、对我方不利的违约与解除条款——逐条引用原文并说明风险；\n三、修改建议：每条风险给出修改后的条款表述示例。\n约束：你是辅助审查工具，不是律师；输出开头注明「本清单不构成法律意见，签署前请咨询执业律师」；不评价合同商业条款的合理性，只看文本风险。`,
  },
  {
    builtin_key: 'doc.meeting.minutes',
    name: '会议纪要与行动项',
    description: '讨论要点 → 决议 → 行动项（责任人/期限），分歧单独标注',
    promptTemplate: `你是会议纪要助手。把作者提供的会议记录/聊天片段/口述要点整理成纪要：\n一、「决议」：会上确定的事项，逐条编号；\n二、「行动项」：表格呈现——事项 / 责任人 / 截止时间（缺失的标【待确认】）；\n三、「分歧与待定」：会上有争议或悬而未决的点，如实记录双方立场；\n四、「下一步会议议题」（如有）。\n纪律：只整理不发明——记录里没有的责任人、时间不要补；有歧义的表述原样引用并标【待确认】。`,
  },
];

const dbPath = process.argv[2] || defaultDb();
if (!fs.existsSync(dbPath)) {
  console.error('数据库不存在：' + dbPath);
  process.exit(1);
}
const db = new DatabaseSync(dbPath);
// 老库补 domain 列
const cols = db.prepare('PRAGMA table_info(skills)').all().map((c) => c.name);
if (!cols.includes('domain')) db.exec(`ALTER TABLE skills ADD COLUMN domain TEXT NOT NULL DEFAULT 'novel'`);

const insert = db.prepare(`INSERT INTO skills
  (id, name, description, prompt_template, kind, source, enabled, builtin_key, usage_mode, targets_json, origin, capabilities_json, domain)
  SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?
  WHERE NOT EXISTS (SELECT 1 FROM skills WHERE builtin_key = ?)`);

let added = 0;
let skipped = 0;
for (const s of SKILLS) {
  const exists = db.prepare('SELECT 1 FROM skills WHERE builtin_key = ?').get(s.builtin_key);
  if (exists) { skipped++; continue; }
  const id = cryptoRandom();
  insert.run(cryptoRandom(), s.name, s.description, s.promptTemplate, 'method', '', 1, s.builtin_key,
    'support', JSON.stringify(['chat']), 'official', null, 'doc', s.builtin_key);
  added++;
}
const total = db.prepare("SELECT COUNT(*) n FROM skills WHERE domain='doc'").get().n;
console.log(`完成：新增 ${added} 个，跳过 ${skipped} 个（已存在）；doc 域技能现有 ${total} 个。库：${dbPath}`);

function cryptoRandom() {
  return globalThis.crypto.randomUUID();
}
