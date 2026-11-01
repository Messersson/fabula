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
const gate = require('./quality-gate');
const { buildDocx } = require('./docx-export');
const craft = require('./doc-craft');
const figure = require('./doc-figure');
const docMath = require('./doc-math');
const quality = require('./doc-quality');
const stats = require('./doc-stats');
const bib = require('./doc-bib');
const method = require('./doc-method');
const typekit = require('./doc-typekit');
const retrieval = require('./doc-retrieval');
const finance = require('./doc-finance');
const docTable = require('./doc-table');
const layout = require('./doc-layout');
const benchmark = require('./doc-benchmark');
const docContext = require('./doc-context');
const { APPLY_INPUT_MAX_CHARS, APPLY_MIN_KEEP_RATIO } = require('./review-limits');
const { planBlock } = craft;

const DEFAULT_SECTION_CHARS = 800;
// 全托管批量循环的取消标记：只在本进程内有效。循环在每节边界检查，
// 已写完的小节保留；进程重启后没有循环体，cancelDocRun 直接改数据库状态。
const docCancellations = new Set();
const activeDocRuns = new Set();
const MAX_CONSECUTIVE_FAILURES = 2;
const BATCH_YIELD_EVERY = 12;

// ---------- 内置文档类型 ----------
// sections 的 brief 是该节的写作要求；minChars 是门禁下限（全文含小标题）。
//
// 加类型的门槛不是「名字好听」，而是三条都成立：
//   1. 结构真的不同——会议纪要不是短一点的报告，公文不是随便排版的总结；
//   2. 有专属硬约束（TYPE_RULES）——否则写出来还是通用文体，只是标题换了；
//   3. 篇幅量级符合实际——公函 1500 字够了，可研没有 6000 字撑不起来。
// 只满足第 1 条的类型不要加：它只会让下拉框变长，不会让稿子变好。
const DOC_TYPES = {
  // ===== 学术研究 =====
  paper: {
    key: 'paper', name: '学术论文', group: '学术研究',
    tone: '学术文体：术语一致、论证严密、段落有主题句；禁止口语与营销表达。引用只能来自作者提供的材料，不得虚构文献。图表必须编号（图 1 / 表 1）并在正文中引用；结构图优先用 Mermaid 代码块，数据对比用 Markdown 表格。',
    // 篇幅下限按「真论文」的量级定：摘要 300 + 正文 6000+。
    // 之前每节 700~900 字，全文不到 5000 字，无论模型多努力都写不出有深度的论文——
    // 深度首先受篇幅约束，其次才是论证方法。1.4 倍（深入档）≈ 1 万字，是期刊论文的正常体量。
    sections: [
      { title: '摘要', brief: '目的、方法、结果、结论四要素摘要（250~350 字），不出现图表引用；末句点明创新点。', minChars: 300 },
      { title: '引言', brief: '研究背景与问题的提出（现有研究缺什么）、研究问题与假设、研究意义、本文结构安排；末段预告各节。', minChars: 1200 },
      { title: '文献综述', brief: '基于作者提供的文献材料按主题脉络梳理（不是按时间罗列）：分主题归纳已有结论、指出分歧与方法局限、落到本文的研究缺口；未提供文献的观点标注【待补文献】。', minChars: 1500 },
      { title: '研究方法', brief: '研究设计（为何这样设计）、数据/材料来源与样本、变量定义与测量、分析模型与识别策略、信效度与稳健性说明；技术路线用 Mermaid flowchart 呈现并配图注。', minChars: 1100 },
      { title: '结果与分析', brief: '按研究问题逐一给结果：先描述统计，再主效应，再做异质性与稳健性检验；数据对比用 Markdown 表格（表头+表注），真实数据图给【图 N：标题】占位；每个结果都要说明它支持或否证了哪个假设。', minChars: 1600 },
      { title: '讨论', brief: '结果的含义与机制解释、与已有研究的一致与冲突（冲突要解释为什么）、理论与实践意涵、研究局限与未来方向。', minChars: 1200 },
      { title: '结论', brief: '核心结论（逐条对应研究问题）、理论贡献与实践启示、后续研究方向。', minChars: 500 },
      { title: '参考文献', brief: '本节以作者维护为主：AI 只把作者提供的文献条目整理为规范格式（默认 GB/T 7714，可按期刊要求切换），逐条与正文引用对应；严禁编造任何文献——作者未提供的条目一律保留【待补：文献信息】占位。', minChars: 150 },
    ],
  },

  // ===== 商业与投资 =====
  bp: {
    key: 'bp', name: '商业计划书', group: '商业与投资',
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
  feasibility: {
    key: 'feasibility', name: '可行性研究报告', group: '商业与投资',
    tone: '可研文体：以「必要性—可行性—经济性—风险」四问组织全文；每个结论都要有测算或依据支撑，不做定性表态。',
    sections: [
      { title: '项目概况', brief: '项目名称、建设单位、建设地点与规模、建设内容、投资总额与资金来源、编制依据（委托文件与规范）。', minChars: 500 },
      { title: '项目建设必要性', brief: '政策依据（引文号）、行业与区域现状、现状痛点与缺口、不建设的后果；必要性要落到「不做会怎样」，不能只讲「做了很好」。', minChars: 900 },
      { title: '市场需求与建设规模', brief: '需求现状与预测（方法、口径、数据来源）、目标客群或服务对象、建设规模如何由需求推导得出（不是拍脑袋定规模）。', minChars: 900 },
      { title: '建设方案与技术可行性', brief: '总体方案与技术路线（Mermaid 图）、主要建设内容与设备、技术来源与成熟度、选址与配套条件。', minChars: 1000 },
      { title: '实施方案与组织管理', brief: '建设周期与进度安排、招标与采购方式、组织架构与人员配置、质量与安全管理。', minChars: 600 },
      { title: '投资估算与资金筹措', brief: '投资估算（建设投资/建设期利息/流动资金分科目）、估算依据与单位造价、资金来源与使用计划、还款或退出安排。', minChars: 700 },
      { title: '经济与社会效益评价', brief: '财务指标（IRR、NPV、投资回收期、盈亏平衡点）与其计算假设、敏感性分析、社会效益（就业、税收、产业带动）。', minChars: 800 },
      { title: '风险分析与对策', brief: '市场、技术、资金、政策、实施五类风险，逐条给发生条件、影响程度与应对措施。', minChars: 600 },
      { title: '结论与建议', brief: '逐条回应「是否可行」并给条件：在什么前提下可行、需要落实哪些前置条件。', minChars: 400 },
    ],
  },

  // ===== 项目与申报 =====
  proposal: {
    key: 'proposal', name: '项目申报书', group: '项目与申报',
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
  bid: {
    key: 'bid', name: '投标文件', group: '项目与申报',
    tone: '投标文体：逐条响应招标要求，不回避、不含糊；每个承诺都要可核验（谁做、什么时候做、达到什么标准）。',
    sections: [
      { title: '投标函与承诺', brief: '投标函正文：响应招标文件、投标总价（大写+小写）、工期/服务期、投标有效期、对招标文件条款的接受声明。', minChars: 400 },
      { title: '投标人资格与业绩', brief: '主体资格、资质证书（编号与有效期）、类似项目业绩（项目名/金额/时间/甲方）、财务与信用状况。', minChars: 700 },
      { title: '技术方案响应', brief: '逐条对照招标文件的技术要求给响应：需求条目 → 我方方案 → 响应结论（完全响应/优于/偏离）。技术路线用 Mermaid 图。', minChars: 1200 },
      { title: '项目实施与组织', brief: '项目组织架构、人员配置与资历、实施计划与里程碑、沟通与汇报机制。', minChars: 800 },
      { title: '质量保证与售后服务', brief: '质量目标与保证体系、过程控制节点、验收方式、售后响应时限与升级机制、备件与培训。', minChars: 700 },
      { title: '商务报价说明', brief: '报价构成（分项到可核对）、计价依据、税费与付款方式、价格调整条件。', minChars: 500 },
      { title: '偏离表与说明', brief: '逐条列出与招标文件的偏离项并说明原因与替代方案；无偏离也要写明「无偏离」并声明。', minChars: 500 },
      { title: '附件清单', brief: '资格证明、业绩证明、人员证书、授权书等附件的清单与页码对应。', minChars: 200 },
    ],
  },

  // ===== 工作与行政 =====
  report: {
    key: 'report', name: '调研报告', group: '工作与行政',
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
  summary: {
    key: 'summary', name: '工作总结与述职', group: '工作与行政',
    tone: '总结文体：用事实、数据、结果说话；成绩与问题并陈，不自我表扬、不推卸责任；每条工作都要对应可核对的结果。',
    needsFigure: false,
    sections: [
      { title: '履职概况', brief: '岗位与职责范围、本期工作主线、总体完成情况（用 2~3 个关键数字概括：完成率、增长率、交付量）。', minChars: 400 },
      { title: '主要工作与成效', brief: '按职责模块分条：做了什么 → 怎么做的 → 结果如何（带数字）。每条只讲一件事，成效必须可核对，不能只写「认真完成」。', minChars: 1200 },
      { title: '重点举措与做法', brief: '挑 2~3 件最有分量的事展开：为什么这么做（判断依据）、具体做法、遇到的阻力与化解方式、可复用的经验。', minChars: 900 },
      { title: '存在的问题与不足', brief: '具体到事、到环节、到自己的责任：哪项工作没做好、原因是什么（能力/资源/判断/协作）、造成了什么影响。禁止「学习不够深入」这类套话。', minChars: 600 },
      { title: '下一步工作计划', brief: '针对问题与目标给措施：做什么、什么时候做、达到什么可衡量的结果、需要什么资源。', minChars: 700 },
      { title: '需要支持与建议', brief: '向上级或组织提出的具体请求（资源、权限、协同），说明理由与预期效果；没有就写「暂无」。', minChars: 300 },
    ],
  },
  minutes: {
    key: 'minutes', name: '会议纪要', group: '工作与行政',
    tone: '纪要是执行文件，不是速记：只记结论、决议与分工，不记发言过程；不评价人，只记录定下来的事。',
    needsFigure: false,
    sections: [
      { title: '会议基本信息', brief: '会议名称、时间、地点、主持人、参会人、列席人、缺席人、记录人（缺项写【待补】）。', minChars: 200 },
      { title: '议题与讨论要点', brief: '按议题分条：每个议题写清「争点是什么、各方主要观点、倾向性意见」，不按人流水记录，不复述客套话。', minChars: 800 },
      { title: '会议决议', brief: '逐条编号列出已定事项，每条是完整可执行的判断句（做什么、到什么程度、什么时候），不写「原则同意」这类空决议。', minChars: 600 },
      { title: '任务分工与时限', brief: '表格化：事项 | 责任人 | 配合方 | 完成时间 | 交付物。每项必须有责任人和时间，缺一个就等于没安排。', minChars: 500 },
      { title: '待明确事项', brief: '本次未形成决议、需下次会议或另行请示的问题，写清卡在哪里、由谁在什么时候给出结论。', minChars: 300 },
    ],
  },
  notice: {
    key: 'notice', name: '通知公告（公文）', group: '工作与行政',
    tone: '公文文体：一文一事；标题为「发文机关＋事由＋文种」；正文按「依据—事项—要求」三段式；不用口语、比喻与修辞。',
    needsFigure: false,
    sections: [
      { title: '标题与主送机关', brief: '标题三要素齐全（如「XX 局关于开展 2026 年度安全生产检查的通知」）；主送机关用全称或规范简称，多个之间用顿号。', minChars: 150 },
      { title: '发文缘由', brief: '依据（上级文件名称与文号、法律法规条款）+ 目的 + 一句过渡（「现将有关事项通知如下」）。依据不能含糊成「根据有关要求」。', minChars: 300 },
      { title: '通知事项', brief: '分条列项（一、二、三），每条一事、动宾开头；涉及范围、标准、时间、地点、材料的，逐项写清，不留解释空间。', minChars: 700 },
      { title: '执行要求', brief: '落实责任（谁牵头、谁配合）、时限、报送方式与联系人电话；对不落实的后果作出提示。', minChars: 400 },
      { title: '附件与落款', brief: '附件名称逐项列出；发文机关署名、成文日期（汉字数字）、印章位置说明。', minChars: 150 },
    ],
  },
  policy: {
    key: 'policy', name: '制度与管理办法', group: '工作与行政',
    tone: '制度文体：章条体例（第一章 总则 … 附则），条文用「应当/不得/可以」，权责主体明确，违规后果可追责。',
    needsFigure: false,
    sections: [
      { title: '第一章 总则', brief: '制定目的与依据、适用范围（对谁、对什么事）、管理原则、术语定义。第一条写目的依据，第二条写适用范围。', minChars: 400 },
      { title: '第二章 组织与职责', brief: '分层写清决策机构、主管部门、执行部门、监督部门的职责边界；避免「有关部门负责」这种无主体表述。', minChars: 500 },
      { title: '第三章 管理内容与流程', brief: '制度主体：按业务环节分节（申请—审批—执行—变更—归档），每个环节写清触发条件、责任主体、时限、留痕要求、禁止情形。', minChars: 1200 },
      { title: '第四章 监督与检查', brief: '检查主体、频次、方式、检查内容清单、结果处理与通报机制。', minChars: 400 },
      { title: '第五章 责任追究', brief: '违规情形分级、对应处理措施（约谈/通报/经济处理/纪律处分/移交）、从重与从轻情形、申诉渠道。', minChars: 400 },
      { title: '第六章 附则', brief: '解释权归属、施行日期、与原制度的衔接（废止哪些旧制度）、过渡期安排。', minChars: 300 },
    ],
  },

  // ===== 产品与技术 =====
  prd: {
    key: 'prd', name: '产品需求文档', group: '产品与技术',
    tone: '产品文体：以用户场景与验收标准为中心；每条需求必须可测（谁、在什么场景、做什么、系统怎么响应、怎么算通过）。',
    sections: [
      { title: '文档信息', brief: '版本号、修订记录（版本/日期/修订人/变更内容）、关联文档与原型链接、术语表。', minChars: 200 },
      { title: '背景与目标', brief: '业务背景与要解决的问题（用数据说明现状）、本期可量化目标（指标名 + 基线值 + 目标值）、明确不做什么。', minChars: 600 },
      { title: '用户与场景', brief: '用户角色（画像、权限、使用频次）、典型场景（触发条件 → 用户目标 → 当前障碍）、核心任务流程。', minChars: 700 },
      { title: '需求范围', brief: '本期范围（必须做/应该做）与不做范围（明确排除项及原因），以及与其他版本的关系。', minChars: 600 },
      { title: '功能需求', brief: '逐个功能写：功能描述、前置条件、主流程（步骤化）、分支与异常流程、业务规则（含边界值与校验规则）、权限与可见性。规则要能直接转成测试用例。', minChars: 1400 },
      { title: '非功能需求', brief: '性能（响应时间、并发量）、兼容性（端/浏览器/分辨率）、安全与合规（权限、脱敏、审计）、可用性、埋点与监控指标。', minChars: 500 },
      { title: '验收标准', brief: '逐条给可判定的验收条件（Given 前置 / When 操作 / Then 预期），覆盖主流程与关键异常；不可量化的需求在此退回重写。', minChars: 600 },
      { title: '依赖与风险', brief: '上下游依赖（接口、数据、其他团队排期）、风险与应对、上线与回滚方案。', minChars: 400 },
    ],
  },
  techdoc: {
    key: 'techdoc', name: '技术方案设计', group: '产品与技术',
    tone: '技术文体：结论与权衡并列——每个技术选择都要写清候选方案、选择理由与被放弃的理由；接口与数据结构必须可直接实施。',
    sections: [
      { title: '背景与目标', brief: '业务背景、要解决的技术问题、量化目标（QPS、延迟、可用性、成本）、非目标（本次不解决什么）。', minChars: 500 },
      { title: '现状与问题', brief: '现有架构与关键指标、瓶颈定位（带数据或压测结论）、为什么现有方案撑不住。', minChars: 600 },
      { title: '总体设计', brief: '架构图（Mermaid）、模块划分与职责、核心数据流与调用链、与外部系统的边界。', minChars: 1000 },
      { title: '关键技术选型', brief: '逐项对比候选方案（表格：方案/优点/缺点/适用条件），给出选择结论与放弃理由；不做对比直接给结论视为未论证。', minChars: 900 },
      { title: '接口与数据设计', brief: '关键接口（路径、方法、入参出参、错误码、幂等与超时约定）、数据模型（表结构/字段/索引/分片键）、状态机与一致性方案。', minChars: 1000 },
      { title: '部署与运维', brief: '部署拓扑、容量规划与扩缩容、灰度与回滚、监控告警指标与阈值、日志与链路追踪。', minChars: 600 },
      { title: '性能与容量', brief: '预估流量与存储增长、压测方案与目标值、缓存与限流降级策略、单点与热点处理。', minChars: 500 },
      { title: '风险与兜底', brief: '技术风险（数据迁移、依赖不可用、性能不达标）逐条给发生条件、影响面与兜底方案。', minChars: 500 },
      { title: '实施计划', brief: '任务拆解与排期、里程碑与交付物、人力分工、上线验收标准。', minChars: 400 },
    ],
  },

  // ===== 传媒与演讲 =====
  press: {
    key: 'press', name: '新闻稿', group: '传媒与演讲',
    tone: '新闻文体：倒金字塔结构，最重要的事实放最前；用事实、数据与引语说话，不用形容词堆砌与自我表扬。',
    needsFigure: false,
    sections: [
      { title: '标题与副标题', brief: '主标题一句话说清「谁做了什么、有什么结果」，不超过 25 字，不用问句与夸张词；副标题补充关键信息（时间、地点、数据）。', minChars: 120 },
      { title: '导语', brief: '第一段交代 5W1H 中最重要的四要素：谁、做了什么、什么时候、意味着什么；读者只看这一段也能知道发生了什么。', minChars: 300 },
      { title: '正文主体', brief: '按重要性递减展开：支撑导语的事实与数据、背景与来龙去脉、行业或政策语境；每段一个信息点，段首即结论。', minChars: 700 },
      { title: '关键引语', brief: '1~2 条核心人物原话（署名+职务），引语要有信息量或态度，不能是「我们很高兴」这类空话；引语需明确标注为引语。', minChars: 300 },
      { title: '关于我们', brief: '机构简介（成立时间、主营业务、规模资质），控制在 100 字内，作为固定模板段。', minChars: 200 },
      { title: '媒体联系', brief: '联系人、职务、电话、邮箱（未提供处写【待补】）。', minChars: 120 },
    ],
  },
  speech: {
    key: 'speech', name: '演讲稿', group: '传媒与演讲',
    tone: '演讲文体：为耳朵写而不是为眼睛写——短句、口语节奏、可停顿；全篇只讲一个核心观点，用故事和数据支撑。',
    needsFigure: false,
    sections: [
      { title: '开场', brief: '30 秒内抓住注意力：用一个反常识的事实、一个具体场景或一个问题切入；不用「大家好，我很荣幸」式开场。', minChars: 300 },
      { title: '核心观点', brief: '一句话讲清全篇主张（听众离场后应该记住的那句），并预告支撑它的两到三条论据。', minChars: 400 },
      { title: '论据一', brief: '第一个支撑点：先给判断，再给案例或数据，最后落回主张；配一个可复述的细节。', minChars: 500 },
      { title: '论据二', brief: '第二个支撑点：换一个角度（对比、反例、时间线），避免与前一点同构。', minChars: 500 },
      { title: '论据三', brief: '第三个支撑点：给边界或代价（在什么条件下成立、需要付出什么），让主张可信。', minChars: 400 },
      { title: '回应质疑', brief: '主动提出听众最可能的两个反对意见并回应，比回避更能建立信任。', minChars: 400 },
      { title: '结尾与号召', brief: '收束到核心观点，给一句可被转述的金句，最后是明确的行动号召（做什么、什么时候开始）。', minChars: 300 },
    ],
  },

  // ===== 法律与合规 =====
  contract: {
    key: 'contract', name: '法律合同（共创建议）', group: '法律与合规',
    tone: '合同文体：条款编号严谨（第X条），定义统一，权责对等表述；不使用模糊形容词。本工具产出的是草稿，签署前必须由专业人士审核。',
    needsFigure: false,
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

  // ===== 自定义 =====
  custom: {
    key: 'custom', name: '自定义文档', group: '自定义',
    tone: '通用公文文体：结构清晰、表达准确、一事一段。',
    sections: [],
  },
};

// 下拉框的分组顺序。对象键是插入顺序，但业务上要按「学术→商业→项目→行政→技术→传媒→法律→自定义」排，
// 否则新增类型只能追加到末尾，用户找类型要滚到底。
const TYPE_GROUPS = ['学术研究', '商业与投资', '项目与申报', '工作与行政', '产品与技术', '传媒与演讲', '法律与合规', '自定义'];

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
        // Markdown 的 # 数量就是层级；中文序号里「（一）」按二级算，其余按一级。
        const level = matched[1]
          ? Math.min(3, matched[1].length)
          : (/^[（(]/.test(line.trim()) ? 2 : 1);
        current = { title: title.slice(0, 120), brief: '', level };
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

// 把「作者改过的标题」与「模板的层级/篇幅/要点」合并成一份目录。
//
// 页面上选中一个已蒸馏模板时，模板目录的 markdown 形态会被填进「模板大纲」文本框，
// 用户可能顺手改一两个标题。作者改的标题要尊重；但层级（1/2/3 级）、每节篇幅下限、
// 蒸馏出的写作要点都是模板的语义，改标题不该把它们清成默认值。
//
// 匹配规则：先按标题精确匹配（作者没改的那几节），匹配不上的按顺序兜底对齐。
function mergeTemplateSections(templateSections, editedSections) {
  const tpl = Array.isArray(templateSections) ? templateSections : [];
  const edited = Array.isArray(editedSections) ? editedSections : [];
  if (!tpl.length) return edited;
  const byTitle = new Map(tpl.map((item) => [String(item.title || '').trim(), item]));
  const used = new Set();
  // 标题对不上时按顺序兜底只在两边节数一致时启用：
  // 作者完全换了一套结构（节数都变了）时按顺序硬套，会把层级安到不相干的小节上。
  const alignByOrder = tpl.length === edited.length;
  return edited.map((section, index) => {
    const title = String(section.title || '').trim();
    let match = byTitle.get(title);
    if (match && used.has(match)) match = null;
    if (!match && alignByOrder) match = tpl.find((item) => !used.has(item)) || null;
    if (!match) return { ...section };
    used.add(match);
    return {
      ...section,
      level: Math.max(1, Math.min(3, Number(match.level) || 1)),
      minChars: Math.max(120, Number(match.minChars) || DEFAULT_SECTION_CHARS),
      // 要点：作者在文本框里给这一节写了说明就以作者为准，否则用模板蒸馏出的要点。
      brief: String(section.brief || '').trim() || String(match.brief || '').trim(),
    };
  });
}

function createProject({ title, docType = 'custom', mode = 'co', brief = '', template = '', sections = null, skillIds = [], thesis = '', points = [], depth = 'standard', templateId = '', layout: layoutSpec = null } = {}) {
  const name = String(title || '').trim().slice(0, 120);
  if (!name) throw new Error('请填写文档标题');
  if (!['co', 'auto'].includes(mode)) mode = 'co';
  const type = docTypeOf(docType);
  const level = craft.depthOf(depth);
  // 套用已蒸馏的模板：同时带出章节目录与排版规格。
  // 排版规格必须一起带——只带结构不带版式，等于「章节对了但排版还是默认」，
  // 用户要的是「照着样例写出来的那份文档」，两样缺一不可。
  let templateRow = null;
  if (templateId) {
    const row = one(`SELECT * FROM doc_templates WHERE id=?`, String(templateId));
    if (row) templateRow = row;
  }
  // 章节来源优先级：显式小节 > 粘贴/上传的模板文本 > 选中的已蒸馏模板 > 类型默认结构。
  // 粘贴的模板文本排第二：作者手改过的大纲就是他想要的，不能再被模板里的旧结构盖掉。
  const normalizeList = (raw) => (Array.isArray(raw) ? raw : []).map((section, index) => ({
    title: String((section && section.title) || `第${index + 1}节`).trim().slice(0, 120),
    brief: String((section && section.brief) || '').trim().slice(0, 1200),
    minChars: Math.max(120, Number(section && section.minChars) || DEFAULT_SECTION_CHARS),
    level: Math.max(1, Math.min(3, Number(section && section.level) || 1)),
  })).filter((section) => section.title);
  let list = null;
  // 结构来源要记下来：只有知道「这一份结构是从哪来的」，后面才能决定要不要锁目录。
  let listSource = 'type';
  if (Array.isArray(sections) && sections.length) { list = normalizeList(sections); listSource = 'sections'; }
  if (!list && String(template || '').trim()) {
    const parsedTemplate = parseDocTemplate(template);
    if (parsedTemplate.length) { list = normalizeList(parsedTemplate); listSource = 'template'; }
  }
  if (!list && templateRow) {
    list = layout.normalizeSections((() => {
      try { return JSON.parse(templateRow.sections_json || '[]') || []; } catch { return []; }
    })());
    listSource = 'saved';
  }
  // 选了已蒸馏模板时，模板才是目录的基准。
  //
  // 页面上选中模板会自动把它的目录填进文本框，用户还可能顺手改一两个标题、
  // 或在右侧「计划章节」里另写一份。这两种改法都只应该改标题，
  // 层级、每节篇幅下限、蒸馏出的写作要点仍然以模板为准——
  // 否则「严格沿用模板」就只剩标题像模板，排版层级与篇幅其实全丢了。
  // 标题以作者改过的为准（作者有意调整结构就尊重），其余以模板为准。
  if (templateRow && (listSource === 'template' || listSource === 'sections')) {
    list = mergeTemplateSections(layout.normalizeSections((() => {
      try { return JSON.parse(templateRow.sections_json || '[]') || []; } catch { return []; }
    })()), list);
    listSource = `${listSource}+saved`;
  }
  if (!list) list = type.sections.map((section) => ({ ...section, level: Number(section.level) || 1 }));
  if (!list.length) {
    if (type.key === 'custom') throw new Error('自定义文档需要上传模板或手动填写小节');
    list = [{ title: '正文', brief: '', minChars: DEFAULT_SECTION_CHARS, level: 1 }];
  }
  // 排版规格优先级：显式传入 > 模板自带 > 默认
  let effectiveLayout = null;
  if (layoutSpec && Object.keys(layoutSpec).length) {
    effectiveLayout = layout.normalizeLayout(layoutSpec);
  } else if (templateRow) {
    try { effectiveLayout = layout.normalizeLayout(JSON.parse(templateRow.layout_json || '{}')); } catch { effectiveLayout = null; }
  } else {
    effectiveLayout = layout.normalizeLayout({});
  }
  // 模板绑定：记下来源，后面才有「严格沿用」的依据。
  // 已蒸馏模板 → 目录 + 版式都锁；只粘贴了模板文本 → 目录锁、版式仍可调
  // （纯文本里本来就没有字体信息，锁版式没有意义）。
  const boundTemplateId = templateRow ? String(templateRow.id) : '';
  const boundTemplateName = templateRow
    ? String(templateRow.name || '未命名模板')
    : (listSource === 'template' ? '粘贴的模板' : '');
  // 模板的文风技法（结构要点 + 写法）：写作时注入，否则模板只贡献了形，没贡献神。
  const boundTemplateNotes = templateRow ? String(templateRow.notes || '').trim().slice(0, 4000) : '';
  const id = crypto.randomUUID();
  const stamp = Date.now();
  const skillJson = JSON.stringify(resolveSkills(skillIds).map((skill) => skill.id));
  transaction(() => {
    run(`INSERT INTO doc_projects(id,title,doc_type,mode,status,brief,thesis,points_json,skills_json,depth,layout_json,template_id,template_name,template_notes,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, name, type.key, mode, 'drafting', String(brief || '').trim().slice(0, 4000),
    String(thesis || '').trim().slice(0, 2000),
    JSON.stringify((Array.isArray(points) ? points : []).map((p) => String(p || '').trim()).filter(Boolean).slice(0, 30)),
    skillJson, level.key, JSON.stringify(effectiveLayout), boundTemplateId, boundTemplateName, boundTemplateNotes, stamp, stamp);
    for (let index = 0; index < list.length; index++) {
      const base = Math.max(0, Number(list[index].minChars) || 0);
      run(`INSERT INTO doc_sections(project_id,idx,title,brief,content,status,source,min_chars,base_chars,level,updated_at)
        VALUES(?,?,?,?,?,'planned','',?,?,?,?)`, id, index + 1, list[index].title, list[index].brief, '',
      scaleChars(base, level.factor), base, Math.max(1, Math.min(3, Number(list[index].level) || 1)), stamp);
    }
  });
  return getProject(id);
}

// 修改项目的排版规格（手工微调蒸馏结果，或直接换一套版式）。
// 模板绑定的项目默认拒绝改版式：「严格沿用模板的排版、字体」如果允许随手改一个字，
// 就等于没锁。要改必须先解除绑定（unbindTemplate），把「我不再照模板写」这件事显式化。
function setProjectLayout(projectId, spec = {}, { force = false } = {}) {
  const key = String(projectId || '');
  const row = one(`SELECT id, template_id, template_name FROM doc_projects WHERE id=?`, key);
  if (!row) throw new Error('文档项目不存在');
  if (String(row.template_id || '') && !force) {
    throw new Error('这份文档按模板撰写，版式随模板锁定；如需自由调整，请先解除模板绑定');
  }
  const normalized = layout.normalizeLayout(spec);
  run(`UPDATE doc_projects SET layout_json=?, updated_at=? WHERE id=?`,
    JSON.stringify(normalized), Date.now(), key);
  return { ok: true, layout: normalized };
}

// 解除模板绑定：目录结构保留在 doc_sections 里（那是已经定下来的内容），
// 但项目不再声称「按模板写」——版式可改、正文标题不再被强制压平。
// 不做这件事就只能二选一：要么永远不能改版式，要么偷偷改掉却还显示「按模板撰写」。
function unbindTemplate(projectId) {
  const key = String(projectId || '');
  const row = one(`SELECT id, template_name FROM doc_projects WHERE id=?`, key);
  if (!row) throw new Error('文档项目不存在');
  run(`UPDATE doc_projects SET template_id='', template_name='', updated_at=? WHERE id=?`, Date.now(), key);
  return { ok: true, previous: String(row.template_name || '') };
}

// 重新套用模板的版式（模板被重新蒸馏过、或作者想回到模板原样时用）。
function reapplyTemplateLayout(projectId) {
  const key = String(projectId || '');
  const row = one(`SELECT id, template_id FROM doc_projects WHERE id=?`, key);
  if (!row) throw new Error('文档项目不存在');
  if (!String(row.template_id || '')) throw new Error('这份文档没有绑定模板');
  const tpl = one(`SELECT layout_json FROM doc_templates WHERE id=?`, String(row.template_id));
  if (!tpl) throw new Error('模板已被删除');
  let spec = {};
  try { spec = JSON.parse(tpl.layout_json || '{}') || {}; } catch { spec = {}; }
  const normalized = layout.normalizeLayout(spec);
  run(`UPDATE doc_projects SET layout_json=?, updated_at=? WHERE id=?`,
    JSON.stringify(normalized), Date.now(), key);
  return { ok: true, layout: normalized };
}

// 重新套用模板的章节目录（模板被重新蒸馏过、或作者手动改乱了目录时用）。
//
// 只改标题与层级，不动已写的正文：正文是按 idx 对应的小节存的，
// 换标题不换位置，作者写过的段落不会跑到别的节里去。
// 层级要一起刷：模板的目录层级变了（原来是一级、现在是二级），
// 只刷标题不刷层级，导出的 Word 里标题样式与目录就对不上了。
function reapplyTemplateOutline(projectId) {
  const key = String(projectId || '');
  const row = one(`SELECT id, template_id FROM doc_projects WHERE id=?`, key);
  if (!row) throw new Error('文档项目不存在');
  if (!String(row.template_id || '')) throw new Error('这份文档没有绑定模板');
  const tpl = one(`SELECT sections_json, notes FROM doc_templates WHERE id=?`, String(row.template_id));
  if (!tpl) throw new Error('模板已被删除');
  let sections = [];
  try { sections = JSON.parse(tpl.sections_json || '[]') || []; } catch { sections = []; }
  const list = layout.normalizeSections(sections);
  if (!list.length) throw new Error('模板没有可用目录');
  const current = q(`SELECT idx FROM doc_sections WHERE project_id=? ORDER BY idx`, key);
  const stamp = Date.now();
  transaction(() => {
    // 模板节数与项目不一致时，以模板为准补齐/裁剪：模板说 8 节、项目只有 5 节，
    // 这时缺的 3 节必须补上，否则「严格沿用目录」根本无从谈起。
    for (let index = 0; index < list.length; index++) {
      const item = list[index];
      const base = Math.max(120, Number(item.minChars) || DEFAULT_SECTION_CHARS);
      const depth = craft.depthOf(one(`SELECT depth FROM doc_projects WHERE id=?`, key)?.depth || 'standard');
      const existing = current[index];
      if (existing) {
        run(`UPDATE doc_sections SET title=?, brief=?, level=?, base_chars=?, min_chars=?, updated_at=? WHERE project_id=? AND idx=?`,
          item.title, item.brief || '', Math.max(1, Math.min(3, Number(item.level) || 1)),
          base, scaleChars(base, depth.factor), stamp, key, index + 1);
      } else {
        run(`INSERT INTO doc_sections(project_id,idx,title,brief,content,status,source,min_chars,base_chars,level,updated_at)
          VALUES(?,?,?,?,?,'planned','',?,?,?,?)`, key, index + 1, item.title, item.brief || '', '',
          scaleChars(base, depth.factor), base, Math.max(1, Math.min(3, Number(item.level) || 1)), stamp);
      }
    }
    // 项目多出来的节：模板里没有，删掉（正文随节一起走）。
    for (const extra of current.slice(list.length)) {
      run(`DELETE FROM doc_sections WHERE project_id=? AND idx=?`, key, extra.idx);
    }
    run(`UPDATE doc_projects SET template_notes=?, updated_at=? WHERE id=?`,
      String(tpl.notes || '').trim().slice(0, 4000), stamp, key);
  });
  return { ok: true, sections: list.length };
}

// 深度乘数。基数是模板/作者给的原值，单独存一列：
// 只有乘数没有基数，切三次档位字数是乱的（900 → 1260 → 945 → 1323）。
function scaleChars(base, factor) {
  const value = Math.max(0, Number(base) || 0);
  if (!value) return 0;
  const factorValue = Number(factor) > 0 ? Number(factor) : 1;
  return Math.max(120, Math.min(4000, Math.round(value * factorValue)));
}

// 切深度档位：项目级设置，改完所有小节的篇幅下限按基数重算。
// 旧段落计划一并作废（段数、子问题数、图表数都随档位变），但已写的正文不动——
// 作者已经认可的稿子不该因为调了个档位就被清掉。
function setProjectDepth(projectId, depth) {
  const key = String(projectId || '');
  const row = one(`SELECT id, depth FROM doc_projects WHERE id=?`, key);
  if (!row) throw new Error('文档项目不存在');
  const level = craft.depthOf(depth);
  const changed = String(row.depth || 'standard') !== level.key;
  transaction(() => {
    run(`UPDATE doc_projects SET depth=?, updated_at=? WHERE id=?`, level.key, Date.now(), key);
    for (const section of q(`SELECT idx, min_chars, base_chars FROM doc_sections WHERE project_id=?`, key)) {
      const base = Number(section.base_chars || 0) || Number(section.min_chars || 0) || DEFAULT_SECTION_CHARS;
      run(`UPDATE doc_sections SET base_chars=?, min_chars=? WHERE project_id=? AND idx=?`,
        base, scaleChars(base, level.factor), key, Number(section.idx));
    }
    if (changed) run(`UPDATE doc_sections SET plan_json='' WHERE project_id=?`, key);
  });
  return { ok: true, depth: level.key, name: level.name, changed };
}

// 把传入的技能 id/名称解析成技能行（对话面板勾选 → 生成提示词注入）。
// 广场里的所有技能都可勾选，包括已停用的（作者明确点名时以作者意图为准）。
// 域隔离：文档引擎只绑定 doc 域技能——小说技能在小说对话里用，两域不混。
function resolveSkills(skillIds) {
  const wanted = (Array.isArray(skillIds) ? skillIds : []).map((item) => String(item || '').trim()).filter(Boolean);
  if (!wanted.length) return [];
  const wantedSet = new Set(wanted);
  return mis.listSkills().filter((skill) =>
    skill.domain === 'doc' && (wantedSet.has(skill.id) || wantedSet.has(skill.name)));
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
    // 目录层级：1=一级标题，2=二级，3=三级。Word 导出与页面目录都按它排版。
    level: Math.max(1, Math.min(3, Number(section.level) || 1)),
    content: section.content || '', status: section.status, source: section.source || '',
    // 旧数据没有 summary：读时现算，不回写（回写会在 GET 里制造写事务）。
    summary: String(section.summary || '').trim() || summarizeSection(section.content || ''),
    chat: (() => { try { return JSON.parse(section.chat_json || '[]') || []; } catch { return []; } })(),
    minChars: Number(section.min_chars || 0),
    baseChars: Number(section.base_chars || 0),
    plan: (() => { try { return JSON.parse(section.plan_json || 'null'); } catch { return null; } })(),
    review: (() => { try { return JSON.parse(section.review_json || 'null'); } catch { return null; } })(),
    // 本节写作时的上下文用量（语料规模、命中素材、注入字数），页面据此显示「这一节读了什么」
    context: (() => { try { return JSON.parse(section.context_json || 'null'); } catch { return null; } })(),
    // 本节图表 spec（数字存在这里，正文只放【图N：标题】占位）。
    figures: (() => {
      try {
        const list = JSON.parse(section.figures_json || '[]');
        return Array.isArray(list) ? list : [];
      } catch { return []; }
    })(),
    // 本节三线表 spec（回归结果 / 描述统计 / 分组比较），正文只放【表N：标题】占位。
    tables: (() => {
      try {
        const list = JSON.parse(section.tables_json || '[]');
        return Array.isArray(list) ? list : [];
      } catch { return []; }
    })(),
  }));
  let skillIds = [];
  try { skillIds = JSON.parse(row.skills_json || '[]') || []; } catch {}
  let thesis = '';
  try { thesis = String(row.thesis || ''); } catch {}
  let points = [];
  try { points = JSON.parse(row.points_json || '[]') || []; } catch {}
  let questions = {};
  try { questions = JSON.parse(row.questions_json || '{}') || {}; } catch {}
  let meta = {};
  try { meta = JSON.parse(row.meta_json || '{}') || {}; } catch {}
  if (!meta || typeof meta !== 'object') meta = {};
  let layoutSpec = {};
  try { layoutSpec = JSON.parse(row.layout_json || '{}') || {}; } catch {}
  const depth = craft.depthOf(row.depth);
  return {
    id: row.id, title: row.title, docType: row.doc_type, mode: row.mode,
    status: row.status, brief: row.brief || '', lastError: row.last_error || '',
    thesis, points: Array.isArray(points) ? points : [],
    questions: questions && typeof questions === 'object' ? questions : {},
    // 论文要素：作者、单位、关键词、分类号、基金、参考文献体例
    meta,
    // 排版规格：字体字号行距缩进编号规则页边距。
    // 写作提示词与 Word 导出都读它——这是「蒸馏出的版式」真正落地的地方。
    layout: layout.normalizeLayout(layoutSpec),
    // 文献矩阵与方法论审查的「有没有做过」，页面据此显示按钮状态
    hasLiteratureMatrix: (() => { try { const l = JSON.parse(row.lit_json || '{}'); return !!(l && Array.isArray(l.items) && l.items.length); } catch { return false; } })(),
    hasMethodology: (() => { try { const m = JSON.parse(row.method_json || '{}'); return !!(m && m.scan); } catch { return false; } })(),
    analysisPreset: (() => { try { const a = JSON.parse(row.analysis_json || '{}'); return a && a.datasetId ? a : null; } catch { return null; } })(),
    refStyle: quality.REF_STYLES[meta.refStyle] ? meta.refStyle : 'gbt7714',
    depth: depth.key, depthName: depth.name, depthNote: depth.note,
    skillIds: Array.isArray(skillIds) ? skillIds : [],
    skills: resolveSkills(skillIds),
    // 模板绑定：templateBound 决定「目录与版式是否锁定」，
    // layoutLocked 只在来源是已蒸馏模板时为真（纯文本模板没有字体信息，锁版式没意义）。
    templateId: String(row.template_id || ''),
    templateName: String(row.template_name || ''),
    // 模板的文风技法：写作提示词要注入，页面也要让人看见「这套模板还管写法」。
    templateNotes: String(row.template_notes || ''),
    templateBound: !!(String(row.template_id || '') || String(row.template_name || '')),
    layoutLocked: !!String(row.template_id || ''),
    createdAt: Number(row.created_at || 0), updatedAt: Number(row.updated_at || 0),
    sections,
    typeName: docTypeOf(row.doc_type).name,
    docTypeName: docTypeOf(row.doc_type).name,
    tone: docTypeOf(row.doc_type).tone,
  };
}

function deleteProject(id) {
  const key = String(id || '');
  transaction(() => {
    run(`DELETE FROM doc_sections WHERE project_id=?`, key);
    run(`DELETE FROM doc_corpus WHERE project_id=?`, key);
    run(`DELETE FROM doc_projects WHERE id=?`, key);
    run(`DELETE FROM chapter_runs WHERE run_id IN (SELECT id FROM generation_runs WHERE book_id=?)`, key);
    run(`DELETE FROM generation_attempts WHERE run_id IN (SELECT id FROM generation_runs WHERE book_id=?)`, key);
    run(`DELETE FROM generation_runs WHERE book_id=?`, key);
  });
  docContext.clearCache(key);
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

// 小节要点：取正文开头的完整句子，压到 60~160 字。刻意不用模型——每节多一次调用不值，
// 这里要的不是「摘要得好」，而是让后文知道这一节到底立了什么论、给了什么数。
function summarizeSection(content) {
  const text = String(content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s.*$/gm, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const sentences = text.match(/[^。！？；!?;]+[。！？；!?;]?/g) || [text];
  let out = '';
  for (const sentence of sentences) {
    if (out.length >= 60 && out.length + sentence.length > 160) break;
    out += sentence;
    if (out.length >= 160) break;
  }
  return out.trim().slice(0, 180);
}

function saveSectionContent(projectId, idx, content, source) {
  const text = String(content || '').trim();
  run(`UPDATE doc_sections SET content=?, status=?, source=?, summary=?, updated_at=? WHERE project_id=? AND idx=?`,
    text, text ? 'done' : 'planned', String(source || 'manual'), summarizeSection(text), Date.now(), projectId, Number(idx));
  touchProject(projectId);
  return { ok: true };
}

// 参考文献：只列正文真正引用过的素材，按**正文首次引用顺序**编号（学术惯例，不是录入顺序）。
// 引用了不存在的编号（模型编的）单独返回，供体检卡报警——这是论文最容易被一眼看穿的错。
// map 是内部编号 [M1] → 正文序号 [1] 的映射：论文正文里出现工单号是不能交的。
function bibliography(projectId) {
  const project = getProject(projectId);
  if (!project) return { entries: [], uncited: [], ghosts: [], map: new Map() };
  const index = materialIndex(projectId);
  const cited = new Set();
  for (const section of project.sections) {
    for (const key of parseCitations(section.content)) cited.add(key);
  }
  const byNumber = (a, b) => Number(a.slice(1)) - Number(b.slice(1));
  const { order } = quality.citationMap(project.sections, index);
  // entries/map 只收真实素材：ghost 编号（模型编的 [M9]）不进参考文献页也不被重编号，
  // 导出后保持 [M9] 原样可见，体检报告的报警才对得上号。
  const entries = order.filter((key) => index.has(key)).map((key, position) => ({ key, no: position + 1, ...index.get(key) }));
  const map = new Map(entries.map((item) => [item.key, item.no]));
  const ghosts = [...cited].filter((key) => !index.has(key)).sort(byNumber);
  const uncited = [...index.keys()].filter((key) => !cited.has(key)).sort(byNumber)
    .map((key) => ({ key, ...index.get(key) }));
  return { entries, uncited, ghosts, map };
}

// 参考文献正文：按著录体例排版，缺元数据时退回「题名[类型]」的最简形式。
function bibliographyLines(entries, style = 'gbt7714') {
  return entries.map((item) => quality.formatReference(item, style));
}

function assembleMarkdown(projectId) {
  const project = getProject(projectId);
  if (!project) return null;
  const type = docTypeOf(project.docType);
  const parts = [`# ${project.title}`, ''];
  // 投稿首页要素：作者、单位、关键词、分类号、基金
  for (const line of frontMatter(project)) parts.push(line);
  if (frontMatter(project).length) parts.push('');
  parts.push(project.brief ? `> ${project.brief.replace(/\n/g, '\n> ')}` : '', '');
  // 图表全文连号：每节的图在计划阶段是从「图1」编起的（一节内自洽），交出去必须 1,2,3…
  // 图表/表全文连号：每节的图表在计划阶段是从「图1」编起的，交出去必须 1,2,3…
  const laid = figure.globalizeFigures(project.sections.map((item) => ({ content: item.content, figures: item.figures })));
  const laidTables = docTable.globalizeTables(project.sections.map((item, index) => ({
    content: laid[index].content, tables: item.tables,
  })));
  const bib = bibliography(projectId);
  project.sections.forEach((section, index) => {
    // 层级决定 Markdown 标题深度：一级节 ##，二级节 ###，三级节 ####。
    // 蒸馏出的目录是什么层级，导出的 Markdown 就是什么层级。
    const depth = 1 + Math.min(3, Math.max(1, Number(section.level) || 1));
    parts.push(`${'#'.repeat(depth)} ${section.title}`, '');
    const content = String(laidTables[index].content || '').trim();
    if (!content) {
      parts.push(`（${section.status === 'quarantined' ? '生成失败，待处理' : '未撰写'}）`);
      parts.push('');
      return;
    }
    // 正文里的 [M1] 是内部工单号，导出时换成论文正文序号 [1]
    // 模板绑定：正文里的 # 标题降为加粗行，Markdown 的目录与模板保持一致
    const remapped = quality.remapCitations(content, bib.map);
    const body = project.templateBound ? quality.normalizeTemplateBody(remapped) : remapped;
    // Markdown 没有图表语法：降级成「表格 + 题注 + 资料来源」，比塞 base64 图片更好改。
    for (const block of docTable.splitTableBlocks(body, laidTables[index].tables)) {
      if (block.type === 'table') {
        parts.push(docTable.tableMarkdown(block.spec));
        parts.push('');
        continue;
      }
      for (const piece of figure.splitFigureBlocks(block.text, laid[index].figures)) {
        parts.push(piece.type === 'figure' ? figure.figureMarkdown(piece.spec) : piece.text);
        parts.push('');
      }
    }
  });
  if (bib.entries.length) {
    parts.push('## 参考文献', '');
    for (const line of bibliographyLines(bib.entries, project.refStyle)) parts.push(line);
    parts.push('');
  }
  if (project.docType === 'contract') {
    parts.push('---', '', '> 本文档由 AI 辅助起草，不构成法律意见；签署前必须经专业人士审核。', '');
  }
  return { title: project.title, typeName: type.name, markdown: parts.join('\n') };
}

// ---------- 文档素材（文献 / 数据 / 政策 / 履历） ----------
//
// 「不编造」与「有内容」之间唯一的通道：模型只能用手上有的事实。
// 按节检索而不是全量注入——一份三万字素材全塞进每节提示词既贵又稀释重点。

const MATERIAL_KINDS = new Set(['material', 'literature', 'data', 'policy']);
const MATERIAL_CHUNK_CHARS = 560;
const MATERIAL_BUDGET_CHARS = 2000;

function listMaterials(projectId) {
  return q(`SELECT id, title, kind, content, authors, year, source, doi, seq, created_at, updated_at FROM doc_materials
    WHERE project_id=? ORDER BY seq DESC`, String(projectId)).map((row) => ({
    id: row.id,
    // 编号与正文里的 [M1] 一一对应，页面显示、参考文献、审计共用同一个来源。
    key: materialKeyAt(row.seq),
    seq: Number(row.seq || 0),
    title: row.title || '',
    kind: row.kind || 'material',
    // 著录元数据：参考文献页靠它们排出「作者. 题名. 出处, 年份.」
    authors: row.authors || '',
    year: row.year || '',
    source: row.source || '',
    doi: row.doi || '',
    text: row.content || '',
    chars: String(row.content || '').length,
    preview: String(row.content || '').replace(/\s+/g, ' ').slice(0, 120),
    updatedAt: Number(row.updated_at || 0),
  }));
}

function addMaterial({ projectId, title = '', content = '', kind = 'material', authors = '', year = '', source = '', doi = '' } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const text = String(content || '').trim();
  if (text.length < 20) throw new Error('素材太短（至少 20 字），贴进来才用得上');
  const id = crypto.randomUUID();
  const stamp = Date.now();
  const name = String(title || '').trim().slice(0, 120)
    || `素材 ${new Date(stamp).toLocaleString('zh-CN', { hour12: false })}`;
  // 编号在插入时定下来（项目内自增，删掉的号不复用），之后不再变动
  run(`UPDATE doc_projects SET material_seq = material_seq + 1 WHERE id=?`, String(projectId));
  const counter = one(`SELECT material_seq FROM doc_projects WHERE id=?`, String(projectId));
  const seq = Math.max(1, Number(counter && counter.material_seq) || 1);
  run(`INSERT INTO doc_materials(id,project_id,title,kind,content,authors,year,source,doi,seq,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, String(projectId), name, MATERIAL_KINDS.has(kind) ? kind : 'material', text.slice(0, 60000),
    String(authors || '').trim().slice(0, 200), String(year || '').trim().slice(0, 20),
    String(source || '').trim().slice(0, 200), String(doi || '').trim().slice(0, 200), seq, stamp, stamp);
  touchProject(projectId);
  return { ok: true, id, title: name, key: materialKeyAt(seq) };
}

function removeMaterial({ projectId, id } = {}) {
  run(`DELETE FROM doc_materials WHERE id=? AND project_id=?`, String(id || ''), String(projectId || ''));
  // 语料索引跟着删：留着的话检索仍会命中一条已经不存在的素材，
  // 正文里就会出现指向空编号的 [M7]。
  run(`DELETE FROM doc_corpus WHERE project_id=? AND material_id=?`, String(projectId || ''), String(id || ''));
  docContext.clearCache(projectId);
  touchProject(projectId);
  return { ok: true };
}

function splitMaterialChunks(content, size = MATERIAL_CHUNK_CHARS) {
  const paragraphs = String(content || '').split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let buffer = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > size * 1.5) {
      if (buffer) { chunks.push(buffer); buffer = ''; }
      for (let i = 0; i < paragraph.length; i += size) chunks.push(paragraph.slice(i, i + size));
      continue;
    }
    if (buffer && buffer.length + paragraph.length + 1 > size) { chunks.push(buffer); buffer = ''; }
    buffer += (buffer ? '\n' : '') + paragraph;
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

// 中文没有空格，用二元字组做词面相似度：够用、无依赖、可预期。
function bigrams(text) {
  const clean = String(text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}

// 素材编号：全文稳定（M1 永远是同一份素材），不随每节检索结果变化——
// 否则正文里的 [M2] 换一节就指向另一篇文献，参考文献页会全错。
// 素材编号用插入时定下的 seq，不是「当前排序里的位置」。
// 位置是会变的：作者后补一条素材，所有旧编号都会错位，正文里的 [M1] 指向另一条文献。
function materialKeyAt(seq) {
  return `M${Math.max(1, Number(seq) || 1)}`;
}

// 检索：BM25 + 同义扩展 + 标题加权（算法在 lib/doc-retrieval.js）。
// 换掉原来的「裸二元字组计数」，是因为那个算法有三个硬伤，每一个都直接让稿子写空：
// 没有 IDF 时「企业」「进行」和「回收期」同权，检索出来的永远是泛泛段落；
// 没有长度归一时越啰嗦的素材越容易被选中；
// 没有同义扩展时查「回本周期」检索不到「投资回收期」——明明有素材，模型只能写【待补】。
function selectMaterialSnippets(projectId, queryText, { maxChars = MATERIAL_BUDGET_CHARS, ratio = 0.5 } = {}) {
  const rows = q(`SELECT id, title, content, seq FROM doc_materials WHERE project_id=? ORDER BY seq DESC`, String(projectId));
  if (!rows.length) return [];
  const chunks = [];
  for (const row of rows) {
    for (const chunk of splitMaterialChunks(row.content)) {
      chunks.push({
        key: materialKeyAt(row.seq),
        materialId: row.id,
        title: row.title || '素材',
        text: chunk,
      });
    }
  }
  return retrieval.rank(chunks, queryText, { ratio, maxChars, maxItems: 6 })
    .map((item) => ({
      key: item.key, materialId: item.materialId, title: item.title, text: item.text,
      score: item.score, relevance: item.normalized,
    }));
}

// 全文引用清单：编号 → 素材。导出参考文献、审计幻觉引用都靠它。
function materialIndex(projectId) {
  const rows = q(`SELECT id, title, kind, authors, year, source, doi, seq FROM doc_materials WHERE project_id=? ORDER BY seq`, String(projectId));
  const map = new Map();
  rows.forEach((row) => {
    map.set(materialKeyAt(row.seq), {
      id: row.id, title: row.title || '素材', kind: row.kind || 'material',
      authors: row.authors || '', year: row.year || '', source: row.source || '', doi: row.doi || '',
    });
  });
  return map;
}

const CITATION_PATTERN = /\[(M\d{1,3})\]/g;

function parseCitations(text) {
  const used = new Set();
  const matches = String(text || '').match(CITATION_PATTERN) || [];
  for (const token of matches) used.add(token.slice(1, -1).toUpperCase());
  return used;
}

// 小节质量基准：把「这一节写到了什么深度」变成可测的量。
//
// 与模型自评分数并存的第二把尺：自评有天花板（模型倾向于给自己打高分），
// 客观基准没有——论证层有没有、依据密不密、空话多不多，都能在正文里查到。
// 评审阶段拿它当「提示」，避免评审被一句「写得很好」带偏；
// 体检阶段拿它当「事实」，让作者看到的是缺哪一项而不是笼统的建议。
function evaluateSectionQuality(project, idx, content, plan = null) {
  const section = project.sections[idx - 1];
  if (!section) return null;
  const planData = plan || section.plan || null;
  const materials = listMaterials(project.id);
  const specs = Array.isArray(section.figures) ? section.figures : [];
  return benchmark.evaluateSection(content, {
    plan: planData,
    docType: project.docType,
    depth: project.depth,
    hasMaterials: materials.length > 0,
    figureNos: specs.map((spec) => Number(spec.no)).filter((no) => Number.isFinite(no)),
  });
}

// ---------- 提示词组装（两种方式共用） ----------

// 全文结构：带层级的编号路径（1 / 1.1 / 1.1.1）。
// 平铺成「1. 2. 3.」会让模型以为所有小节都是章，写出来的一级小节里又套一层
// 「（一）（二）」，导出的目录和正文编号对不上。
function outlineText(sections) {
  const counters = [0, 0, 0];
  return sections.map((section) => {
    const level = Math.min(3, Math.max(1, Number(section && section.level) || 1));
    counters[level - 1] += 1;
    for (let deeper = level; deeper < counters.length; deeper++) counters[deeper] = 0;
    const path = counters.slice(0, level).join('.');
    const indent = '　'.repeat(level - 1);
    const title = String((section && section.title) || '');
    const brief = section && section.brief ? `：${String(section.brief).slice(0, 160)}` : '';
    return `${path} ${indent}${title}${brief}`;
  }).join('\n');
}

// 跨节上下文。原来只给「前文每节的前 500 字、总量 900 字」——写第 8 节时几乎看不到
// 第 1~6 节立了什么论，于是论证断裂、前后重复、术语漂移。
// 现在给全部前节的一句话要点（短，可以全给）+ 上一节结尾（保语气衔接）。
//
// 再加一层：**论点链与已用素材清单**。
// 只给「前文要点」不够——要点是摘要，模型不知道前节具体立了哪些论点、用了哪些素材编号，
// 于是要么重复论证（同一件事换个说法再讲一遍），要么重复引用（同一份数据反复出现）。
// 论点链给出「前节已经立过的判断」，已用素材清单给出「哪些编号已经用过了」，
// 本节要么推进这些论点，要么换新依据。
function contextChain(sections, idx, { maxChars = 2600, tailChars = 420 } = {}) {
  const lines = [];
  const claimLines = [];
  const usedMaterials = new Set();
  for (let i = 0; i < idx - 1; i++) {
    const section = sections[i];
    const point = String(section.summary || '').trim() || summarizeSection(section.content);
    if (point) lines.push(`- 第${i + 1}节「${section.title}」：${point}`);
    // 论点链：从段落计划里取该节的核心论点。
    const claims = (section.plan && Array.isArray(section.plan.claims) && section.plan.claims.length)
      ? section.plan.claims
      : (section.plan && Array.isArray(section.plan.paragraphs)
        ? section.plan.paragraphs.map((item) => ({ goal: item.goal, materials: item.materials }))
        : []);
    for (const claim of claims.slice(0, 3)) {
      const goal = String(claim && claim.goal || '').trim();
      if (goal) claimLines.push(`- 第${i + 1}节已立：${goal}`);
    }
    // 已用素材：正文里出现过的 [M编号] 与计划里声明过的素材都算。
    for (const matched of String(section.content || '').matchAll(/\[(M\d{1,3})\]/gi)) {
      usedMaterials.add(matched[1].toUpperCase());
    }
    for (const claim of claims) {
      for (const key of (Array.isArray(claim && claim.materials) ? claim.materials : [])) {
        usedMaterials.add(String(key).toUpperCase());
      }
    }
  }
  // 条数太多时丢最早的，但至少保留最近 6 条。
  while (lines.join('\n').length > maxChars && lines.length > 6) lines.shift();
  while (claimLines.join('\n').length > maxChars && claimLines.length > 6) claimLines.shift();
  const previous = idx >= 2 ? sections[idx - 2] : null;
  const tailText = previous && previous.content ? String(previous.content).trim().slice(-tailChars) : '';
  return {
    points: lines.join('\n'),
    // 已立论点：告诉本节「这些别再论证一遍，要么推进要么说明与前文的关系」。
    claims: claimLines.join('\n'),
    // 已用素材：提醒换新依据或说明为什么这条仍然适用。
    usedMaterials: [...usedMaterials].sort().join('、'),
    tail: tailText ? `【第${idx - 1}节「${previous.title}」结尾】\n…${tailText}` : '',
  };
}

// 小节篇幅下限：优先用类型/模板自带的下限（论文「结果与分析」900、申报书「技术路线」800），
// 没有落库值时按 brief 长短估一个（要求写得细的给 1200，其余 800），两头都夹住。
// 共创落稿门禁与全托管门禁必须用同一套口径，否则同一段文字一边过一个不过。
function sectionMinChars(section) {
  const stored = Math.max(0, Number(section && section.minChars) || 0);
  if (stored > 0) return Math.max(120, Math.min(4000, stored));
  const brief = String(section && section.brief ? section.brief : '');
  return Math.max(200, Math.min(3000, brief.length > 800 ? 1200 : DEFAULT_SECTION_CHARS));
}

// 按节装配素材上下文。
//
// 原来这里只有一个「BM25 检索 2000 字」的窄口子：一份十万字的调研材料被压成 2000 字，
// 等于把 98% 的证据扔掉，再要求模型「写出有依据的稿子」。
// 现在交给 lib/doc-context.js 做分层装配（文档记忆 / 相关证据 / 语料地图 / 邻近上下文），
// 语料可以到百万字级，提示词仍然有界。
//
// 保留这个函数名与「素材编号 + 引用纪律」的契约：正文里的 [M2] 语义、参考文献页、
// 数字溯源都依赖它，换实现不能换契约。取不到语料索引时退回旧的窄口子，保证不阻断出稿。
// 上下文包：新引擎优先，异常时退回旧窄口子。
// 返回 { text, stats }，stats 会被落库并在页面上显示——
// 一个看不见的能力，在作者眼里等于不存在。
function contextFor(project, section, plan = null) {
  try {
    const pack = docContext.buildContext(project, section.idx, { plan: plan || section.plan || null });
    if (pack && pack.text) return pack;
  } catch { /* 语料引擎异常时退回下面的旧路径，宁可上下文窄一点也不能写不出稿 */ }
  const text = legacyMaterialBlock(project, section);
  return { text, stats: text ? { legacy: true, contextChars: text.length } : {} };
}

function materialBlock(project, section, plan = null) {
  return contextFor(project, section, plan).text;
}

function legacyMaterialBlock(project, section) {
  const query = [project.title, section.title, section.brief, project.thesis, ...(project.points || [])].join(' ');
  const snippets = selectMaterialSnippets(project.id, query);
  if (!snippets.length) return '';
  const items = snippets.map((item) => `〈素材 ${item.key}：${item.title}〉\n${item.text}`).join('\n\n');
  return `【作者提供的素材（唯一可用的事实来源，按编号引用）】\n${items}\n`
    + '素材里有的观点、数据、文献，直接用，并把该句依据的素材编号标在句末（形如 [M2]，用哪条标哪条）；'
    + '素材里没有的一律写【待补】或【待补文献】，禁止编造数据、文献、政策条文或访谈结论。'
    + '不要引用没有出现在上面的编号。';
}

// 公式写法约定：论文/申报书/BP 里的数量关系必须能读、能导出成 Word 原生公式。
// 「投入增加会提升效率」这种判断不是公式——模型很容易把每句话都套成公式来显得专业，
// 这里把边界写死：只有真正的数量关系才写成公式，且符号必须在正文里解释。
const MATH_RULES = [
  '【公式写法】数量关系用 LaTeX 表达：行内写 $...$，独立成行的写 $$...$$（前后各空一行）。',
  '不要用 \\begin{equation} 之类的环境，也不要自己写「（式1）」——编号由系统按出现顺序自动生成；'
    + '投稿模板要求固定编号时写 \\tag{3.2}。',
  '变量直接写字母（斜体由排版决定），单位与中文说明用 \\text{} 保持正体，'
    + '例如 $$\\text{回收期} = \\frac{\\text{累计投入}}{\\text{年产值增量}}$$。',
  '公式里的每个符号在正文首次出现时都要用文字说明含义与单位；只有真正的数量关系才写成公式，'
    + '判断句、观点句一律用文字写，不要为了显得专业把每段话都套成公式。',
].join('\n');

// 证据规则：论文最致命的两类错误——编数据、编文献——在这里堵。
// 引用编号编出来会被查出来（体检会报假引用），编数据不会，只能靠「数字必须能在素材里找到」。
const EVIDENCE_RULES = [
  '【数字与证据】',
  '1. 具体数字只能来自素材：写「128 万元」之前，确认这个数字在素材原文里出现过，并标上素材编号（形如 [M2]）。',
  '2. 素材里没有的数字，不要写具体值。要么写【待补】，要么用有边界的定性表述（「增幅在 10% 上下」也要有素材依据）。'
    + '严禁为了论证顺口而编造百分比、样本量、金额或年份。',
  '3. 自己推算出来的数，要写清测算口径（「按三年累计投入除以年产值增量计算」），不要冒充原始数据。',
  '4. 图表不是装饰：每一张图都要在正文里被提到（「如图 1 所示」「见图 2」），并说明它支持了哪个判断。',
  '5. 不要自造参考文献。正文只标素材编号，参考文献页由系统按著录体例自动生成。',
].join('\n');

// 不会出现数学公式的文档类型：不注入 MATH_RULES。
// 合同原本就是这么处理的（单点判断），类型变多之后改成集合，避免再散落条件。
const NO_MATH_TYPES = new Set(['contract', 'notice', 'policy', 'minutes', 'summary', 'press', 'speech']);

function buildMessages({ project, idx, instruction = '', revision = null, skills = null, plan = null }) {
  const type = docTypeOf(project.docType);
  const section = project.sections[idx - 1];
  if (!section) throw new Error('小节不存在');
  const minChars = sectionMinChars(section);
  const level = craft.depthOf(project.depth);
  // 叠加技能：对话面板勾选的技能模板注入系统提示词（与小说对话的 @技能 同语义）。
  const skillList = skills === null ? (project.skills || []) : resolveSkills(skills);
  const skillBlocks = skillList.map((skill) => `【叠加技能：${skill.name}】\n${skill.promptTemplate || ''}`);
  const sys = [
    '你是一位资深中文文书撰写专家，按照给定文档类型与结构撰写高质量文稿。',
    `【文档类型】${type.name}`,
    `【文体要求】${type.tone}`,
    // 模板约束放在最前面、且标明「最高优先级」：模型对「不要写标题」这类否定指令
    // 很容易在长文里忘掉，所以既要在系统提示里说，也要在本节任务里再说一遍。
    project.templateBound
      ? [
        `【模板约束（最高优先级，违反即视为不合格）】`,
        `本文档按模板《${project.templateName}》撰写，章节目录已固定为 ${project.sections.length} 节，`
          + '顺序、标题、层级一字不改。',
        `1. 只写第 ${idx} 节「${section.title}」的正文。不要输出任何小节标题——`
          + '「一、」「（一）」「1.1」「## xxx」这类标题一律不要，标题由系统按模板统一加。',
        '2. 不要新增、删除、合并或拆分小节；不要把相邻小节该写的内容提前写进来。',
        '3. 不要重复文档标题、作者、日期这类头部信息；模板里若有对应小节，就在那一节写。',
        `4. 全文固定结构（仅供你判断本节位置与前后衔接，不要照抄）：\n${outlineText(project.sections)}`,
      ].join('\n')
      : '',
    // 排版规格：蒸馏出来的版式必须落到写作上，否则导出的稿子标题层级与编号
    // 全是后贴的，与正文自相矛盾（「一、引言」在正文里出现两次这种）。
    // 模板模式下换成「标题由系统统一添加」的说法，避免与「禁止输出小节标题」打架。
    layout.layoutPrompt(project.layout, { templateBound: project.templateBound }),
    // 模板蒸馏出的文风技法：不注入就等于白蒸馏。
    // 模板 notes 存的是「结构要点 + 文风技法」，它描述的正是「怎么写」，
    // 只拿到目录和版式而不给写法，产出的稿子只有形没有神。
    project.templateNotes ? `【模板写法要求（来自样例文档蒸馏）】\n${project.templateNotes}` : '',
    project.docType === 'contract'
      ? '这是合同草稿：条款编号用「第X条」连续编号；信息未给出处一律写【待补】，禁止虚构当事人、金额或日期。'
      : '事实与数据未给出处一律标注【待补】，禁止编造数据、引用或文献；不输出任何写作说明或元信息。',
    typeRules(project.docType),
    // 公式规则只给「可能出现公式」的类型。给通知、纪要、制度、新闻稿、演讲稿塞一套 LaTeX 约定，
    // 只会让模型以为该在通知里写公式——约束用错了地方就是反向引导。
    ...(NO_MATH_TYPES.has(project.docType) ? [EVIDENCE_RULES] : [MATH_RULES, EVIDENCE_RULES]),
    ...(skillBlocks.length ? [skillBlocks.join('\n\n'), '以上叠加技能只取其方法与文风要求，产出仍须贴合本文档类型与本节任务。'] : []),
    project.templateBound
      ? '直接输出本节正文：从第一段开始写，不要输出小节标题、不要写「本节将……」，也不要解释你的写法。'
      : '直接输出该节正文（可含小节标题），不要解释你的写法。',
  ].join('\n');
  const context = contextChain(project.sections, idx);
  const planInfo = plan || section.plan;
  // 只装配一次：装配要跑两阶段检索（百万字语料约 100ms），
  // 为了取统计再调一次是纯粹的浪费。
  const contextPack = contextFor(project, section, planInfo);
  const user = [
    `【文档主题】${project.title}`,
    project.brief ? `【项目说明】\n${project.brief}` : '',
    project.thesis ? `【论题】\n${project.thesis}` : '',
    (project.points || []).length ? `【论据要点】\n${project.points.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '',
    `【全文结构】\n${outlineText(project.sections)}`,
    // 前文：全部前节的一句话要点（可以全给，很短）+ 上一节结尾（保语气衔接）。
    context.points ? `【前文要点（不要重复论述，只做承接）】\n${context.points}` : '',
    // 前节已立的论点：这些不要再论证一遍。要么往下推进，要么明确说明与前文的关系。
    context.claims ? `【前文已立论点（不要重复论证；要么推进，要么说明与前文的关系）】\n${context.claims}` : '',
    // 已用过的素材编号：重复引用同一份数据是审稿人最容易抓的把柄。
    context.usedMaterials
      ? `【前文已用过的素材编号（${context.usedMaterials}）：能换新依据就换新依据；`
        + '确实还要用这条，必须说明为什么它仍然成立或换了一个角度】'
      : '',
    context.tail,
    // 传计划进去：段落计划里的论点是检索最强的查询词（比标题具体得多），
    // 不传的话「本节要证明什么」与「检索到什么」会脱节。
    contextPack.text,
    // 文献综述类小节：文献矩阵注入（有矩阵才注入，没有就不编）
    literatureContext(project, section),
    // 「结果与分析」类小节：自动跑好的统计结果注入（数字由系统算，模型不许改）
    analysisContext(project, section),
    // 当前稿必须完整交给模型：截掉后半段再让它「输出修改后的完整本节」，
    // 等于让它在没见过后文的情况下重写，落盘会把原文后半段抹掉。
    // 长度上限由调用方在进入这里之前检查（reviseSection / reviewOnce）。
    revision
      ? `【当前稿】\n${String(revision)}`
      : '',
    `【本节任务】写第 ${idx} 节「${section.title}」。${section.brief ? `要求：${section.brief}` : ''}`,
    // 深度要求对每一档都要给：之前只在非标准档注入一句形容词，标准档（默认档）什么约束都没有，
    // 结果就是「每节都写了、但每节都停在结论层」。
    craft.depthGuide(project.depth),
    // 质量基准：写之前就把可验收的标准摆出来。
    // 之前只有「要深入」这种形容词，模型接不住；现在是可查的层数与依据密度。
    benchmark.baselineGuide(project.docType, project.depth),
    craft.SHALLOW_BAN,
    level.key === 'standard' ? '' : `【写作深度】${level.name}——${level.note}`,
    planBlock(planInfo),
    `篇幅不少于约 ${minChars} 字。`,
    instruction ? `【作者指示】${instruction}` : '',
  ].filter(Boolean).join('\n\n');
  return { sys, user, minChars, section, contextStats: contextPack.stats || {} };
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

// ---------- 写作流水线：计划 → 起草 → 补写缺口 → 评审 → 修订 ----------
//
// 共创与全托管共用同一条流水线，差别只在「谁触发、要不要评审」。
// 分开写两份的教训已经吃过一次：同一个门禁阈值在两条路径上不一致，同一段文字一边过一边不过。

function materialQuery(project, section) {
  return [project.title, section.title, section.brief, project.thesis, ...(project.points || [])].join(' ');
}

// 段落计划缓存：重试与续写复用同一份骨架，避免每次重试都换一套结构（那样重试只会越改越乱）。
async function ensurePlan(project, idx, { onUsage = null, force = false } = {}) {
  const section = project.sections[idx - 1];
  if (!section) return null;
  if (!force && section.plan && Array.isArray(section.plan.paragraphs) && section.plan.paragraphs.length) return section.plan;
  const materials = selectMaterialSnippets(project.id, materialQuery(project, section));
  const plan = await craft.planSection({
    generate: generateOnce, project, idx, materials,
    minChars: sectionMinChars(section), depth: project.depth, onUsage,
    // 不需要图表的类型（纪要/通知/制度/新闻稿/演讲稿/合同/总结）直接把上限压到 0：
    // 不压的话模型会为了「图文并茂」硬凑一张图，而这种文体里出现数据图本身就是错的。
    maxFigures: docTypeOf(project.docType).needsFigure === false ? 0 : null,
  });
  if (plan) {
    // 图表 spec 与计划一起落库：数字只在计划阶段由素材定一次，
    // 之后正文、页面、Word 导出都读同一份 spec，不会出现「正文说 1280、图上画 1500」。
    run(`UPDATE doc_sections SET plan_json=?, figures_json=? WHERE project_id=? AND idx=?`,
      JSON.stringify(plan), JSON.stringify(plan.figures || []), String(project.id), idx);
    section.plan = plan;
    section.figures = plan.figures || [];
  }
  return plan;
}

// 字数缺口补写（LongWriter 的核心观察）：一次生成经常只写到目标的一半，
// 与其整节重写（贵且容易换骨架），不如让同一位作者接着写剩下的段落。
//
// 补写有两个驱动：一是篇幅不够，二是**论点没兑现**。
// 只按字数补写会出现一种典型坏稿：篇幅够了、字数门禁也过了，但计划里的某个论点根本没写出来
// （模型把三段写成了三段同义的描述）。这时字数是够的，稿子却是空的。
// 所以这里同时检测论点覆盖，缺哪个论点就补哪个。
async function continueToTarget({ project, idx, content, plan, minChars, onUsage = null }) {
  const section = project.sections[idx - 1];
  const target = Math.max(minChars, Number(plan && plan.targetChars) || 0);
  let body = String(content || '').trim();
  // 明显没写起来（拒答、半句、只写了个开头）就不要接长：那不是「写短了」，
  // 是这次生成失败了。接长只会把一句「不行。」接成 600 字的垃圾，还把门禁骗过去。
  if (body.length < target * 0.35) return body;
  // 两类补写各自有配额：篇幅最多 2 轮（和原来一致），论点最多 1 轮。
  // 只按「字数不够就接着写」会漏掉一种坏稿：字数够了但某个论点没写出来。
  // 但也不能让它无限补——论点补一轮还没写出来，说明素材撑不起这个论点，
  // 再补只会让模型硬编。这种情况留给评审去判，而不是继续烧 token。
  let claimRounds = 0;
  for (let round = 0; round < 2 + 1; round++) {
    const claims = (plan && Array.isArray(plan.claims)) ? plan.claims : [];
    const needLength = body.length < target * 0.85;
    let missingClaims = [];
    if (claims.length && claimRounds < 1) {
      const claimState = benchmark.evaluateClaims(body, plan);
      missingClaims = claims.filter((item) => claimState.missing.includes(String(item && item.goal || '')));
      if (missingClaims.length && !needLength) claimRounds += 1;
    }
    if (!needLength && !missingClaims.length) break;
    const need = Math.max(150, Math.round(target - body.length));
    const written = body.slice(-400);
    // 已经讲过的要点：续写最容易犯的错不是「接不上」，而是「绕回去把前面讲过的再讲一遍」。
    // 只给结尾片段时模型看不到前面写了什么，给一份首句清单能显著减少重复论述。
    const covered = body.split(/\n{2,}/)
      .map((paragraph) => String(paragraph).split(/[。！？]/)[0].trim())
      .filter((line) => line.length >= 8)
      .slice(-8);
    const sys = '你是同一位作者，正在续写同一节的正文。只输出接下来的段落，不要重复已经写过的内容，不要解释，不要写标题。';
    const user = [
      `【文档】${project.title}`,
      `【本节】第 ${idx} 节「${section.title}」${section.brief ? `——${section.brief}` : ''}`,
      planBlock(plan),
      materialBlock(project, section, plan),
      literatureContext(project, section),
      analysisContext(project, section),
      covered.length ? `【已经讲过的要点（不要重复论述，只做推进）】\n${covered.map((line) => `· ${line}`).join('\n')}` : '',
      `【已经写到这里（结尾片段）】\n…${written}`,
      // 两个驱动分别给指令：字数不够就补够，论点缺了就把它论证出来。
      missingClaims.length
        ? `【这一轮必须补上这些论点（正文里还没有写出来，现在写清楚，并落实依据）】\n`
          + missingClaims.map((item, index) => {
            const ev = String(item.evidence || '').trim();
            const mats = Array.isArray(item.materials) && item.materials.length ? `（素材 ${item.materials.join('、')}）` : '';
            return `${index + 1}. ${String(item.goal || '').trim()}${mats}${ev ? `\n   计划依据：${ev}` : ''}`;
          }).join('\n')
          + '\n每个论点单独写一段：先明确说出这个判断，再给依据。不要用「此外」「值得注意的是」开头敷衍。'
        : '',
      needLength
        ? `【继续写】再写约 ${need} 字，接着上面的段落往下推进，不要重复结尾片段里已有的句子，不要写小结式收尾（本节后面还有内容）。`
        : `【这一轮继续写】再写约 ${Math.max(200, Math.round(target * 0.25))} 字，补充本节还没展开的论证层次（机制、对比或边界），不要重复已有内容。`,
    ].filter(Boolean).join('\n\n');
    const more = (await generateOnce({ sys, user, onUsage })).trim();
    if (!more || more.length < 40) break;
    // 接缝裁剪：完全重叠裁掉、近似重叠丢掉首句
    const seam = trimSeam(body, more);
    if (!seam || seam.length < 40) break;
    body = `${body}\n\n${seam}`;
  }
  return body;
}

// 落库上下文用量：这一节读了哪几条素材、语料多大、注入多少字。
// 写的是「起草时真实使用的」那份，而不是事后重算的——事后重算会随着语料变化而漂移，
// 作者看到的数字就与当时写出来的正文对不上了。
function saveContextStats(projectId, idx, stats) {
  if (!stats || !Object.keys(stats).length) return;
  const payload = {
    at: Date.now(),
    corpusChars: Number(stats.chars) || 0,
    materials: Number(stats.materials) || 0,
    chunks: Number(stats.chunks) || 0,
    contextChars: Number(stats.contextChars) || 0,
    evidenceChars: Number(stats.evidenceChars) || 0,
    items: Number(stats.items) || 0,
    forced: Number(stats.forced) || 0,
    deduped: Number(stats.deduped) || 0,
    keys: Array.isArray(stats.keys) ? stats.keys.slice(0, 40) : [],
    budget: stats.budget || null,
    legacy: !!stats.legacy,
  };
  try {
    run(`UPDATE doc_sections SET context_json=? WHERE project_id=? AND idx=?`,
      JSON.stringify(payload), String(projectId), Number(idx));
  } catch { /* 记不上不影响正文 */ }
}

// 一次完整起草：计划（缓存）→ 正文 → 补写缺口。token 全部经 onUsage 记账。
async function writeSection(project, idx, { instruction = '', hint = '', onUsage = null } = {}) {
  const section = project.sections[idx - 1];
  const minChars = sectionMinChars(section);
  const plan = await ensurePlan(project, idx, { onUsage });
  const { sys, user, contextStats } = buildMessages({ project, idx, instruction, plan });
  // 先记上下文：即便下面生成失败，作者也能看到「这次尝试读到了什么」
  saveContextStats(project.id, idx, contextStats);
  let content = await generateOnce({ sys, user: user + hint, onUsage });
  content = await continueToTarget({ project, idx, content, plan, minChars, onUsage });
  // 裸编号 M1 → [M1]：不修的话参考文献页会空着，而正文看起来「引了文献」
  content = repairCitations(content, project.id);
  return { content, minChars, plan };
}

// 引用标记修复：真实跑下来模型会把 [M1] 写成裸的 M1（「M1 的研究显示…」）。
// 后果很严重——parseCitations 只认方括号，参考文献页会一条都收不到，
// 而正文里看起来「引了文献」，作者很难发现。这里把裸编号补成方括号，
// 只补真实存在的素材编号，避免误伤正文里的型号、编号。
function repairCitations(content, projectId) {
  const index = materialIndex(projectId);
  return String(content || '').replace(/(?<!\[)\bM(\d{1,3})\b(?!\])/g, (whole, num) => {
    const key = `M${num}`;
    return index.has(key) ? `[${key}]` : whole;
  });
}

// 定点修补：只替换评审指出的那几句，其余原样保留。
// 为什么不用「整节重写」：整节重写会把本来写得好的段落也一起改掉——
// 六段里有一段有问题，重写后往往是五段变差、一段变好，净收益接近零。
// 定位不准（摘录对不上、出现多次）时宁可不改，交给整节重写兜底。
function applyPatches(content, patches = []) {
  let body = String(content || '');
  const applied = [];
  const skipped = [];
  for (const patch of patches) {
    const quote = String((patch && patch.quote) || '');
    const replacement = String((patch && patch.replacement) || '');
    if (!quote || !replacement) { skipped.push(patch); continue; }
    const at = body.indexOf(quote);
    if (at < 0) { skipped.push(patch); continue; }
    // 同一句出现多次时无法确定改哪一处，跳过——改错地方比不改更糟
    if (body.indexOf(quote, at + 1) >= 0) { skipped.push(patch); continue; }
    body = body.slice(0, at) + replacement + body.slice(at + quote.length);
    applied.push(patch);
  }
  return { content: body, applied, skipped };
}

// 续写接缝：模型常常把上一段抄一遍再往下写。
// 原来只查「开头 80 字是否完全重复」，换个说法就漏过去了；
// 现在先做最长重叠裁剪，再用二元字组相似度判断首句是否在复述上一句。
function trimSeam(existing, addition) {
  let add = String(addition || '').trim();
  if (!add) return '';
  const tail = String(existing || '').slice(-500);
  // 完全重叠：existing 的结尾就是 addition 的开头。
  // 下限取 8 而不是 12：中文一句话常只有 10 个字左右（「结尾是这样的一句话。」），
  // 门槛定高了反而漏掉最常见的整句重复。
  const maxLen = Math.min(220, add.length, tail.length);
  let trimmedPrefix = '';
  for (let len = maxLen; len >= 8; len -= 1) {
    if (tail.slice(-len) === add.slice(0, len)) {
      trimmedPrefix = add.slice(0, len);
      add = add.slice(len).trim();
      break;
    }
  }
  // 模型在同一次输出里又从头讲了一遍（重复了刚裁掉的那段）：
  // 只保留第一次出现之前的部分，否则整段会被灌两遍。
  if (trimmedPrefix && trimmedPrefix.length >= 12) {
    const again = add.indexOf(trimmedPrefix);
    if (again > 0) add = add.slice(0, again).trim();
  }
  if (!add) return '';
  // 近似重叠：addition 的首句在复述 existing 的末句 → 丢掉首句
  const lastSentence = (tail.match(/[^。！？\n]*[。！？]\s*$/) || [''])[0].trim();
  const firstSentence = (add.match(/^[^。！？\n]*[。！？]/) || [''])[0].trim();
  if (lastSentence.length >= 12 && firstSentence.length >= 12) {
    const score = quality.similarity(quality.bigrams(lastSentence), quality.bigrams(firstSentence));
    if (score >= 0.7) add = add.slice(firstSentence.length).trim();
  }
  return add;
}

// 评审 + 一次修订。修订后不再复评：那会变成无限打磨，成本不可控。
// 单轮：评审 → 判断要不要改 → 定点修补或整节重写。
// 拆出来是为了让「多轮打磨」能反复调用，而不是把循环塞进一个巨型函数。
async function reviewOnce(project, idx, content, { threshold = 70, onUsage = null } = {}) {
  const section = project.sections[idx - 1];
  // 评审要知道「哪些编号是合法的」，这个集合必须是**全部素材**，不能是检索到的那几条。
  //
  // 这里踩过一个坑：起草走百万字语料引擎，正文里可能引到 M12；
  // 而评审只拿到 6 条检索片段（M1~M6），于是把 M12 判成「编造的引用」并写进 mustFix，
  // 下一轮修订就把一个正确的引用删掉了。上下文变宽之后，评审的判据必须同步变宽。
  const materials = listMaterials(project.id).map((item) => ({
    key: item.key, title: item.title, text: item.preview,
  }));
  // 客观基准先算好，评审时作为「系统检测到的缺口」交给评审参考。
  // 没有它，评审只能凭印象打分，模型的「写得不错」就是终审。
  const qualityEval = evaluateSectionQuality(project, idx, content, section.plan);
  const review = await craft.reviewSection({
    generate: generateOnce, project, idx, content, materials, onUsage,
    benchmark: qualityEval,
  });
  if (!review) return { content, review: null, revised: false, fixMode: 'none', quality: qualityEval };
  // 触发修补的条件不能只看总分：真实跑下来，模型会给一份「3 条 mustFix + 2 个必答问题被绕开」
  // 的稿子打 98 分（自评天然偏高）。只看分数的话这些明确缺陷一个都不会被改。
  const hasDefect = (Array.isArray(review.mustFix) && review.mustFix.length > 0)
    || (Array.isArray(review.unanswered) && review.unanswered.length > 0)
    || (Array.isArray(review.unsupported) && review.unsupported.length > 0);
  // 客观缺口也是缺陷：模型自评说满分，但系统检测到「有素材却一处引用都没有」「计划论点没写」，
  // 这时候必须走修订，否则基准形同虚设。
  // 只认 forceGaps（高置信项）——论证层数是启发式判断，误判会带来无谓的整节重写。
  const hasGap = !!(qualityEval && Array.isArray(qualityEval.forceGaps) && qualityEval.forceGaps.length);
  if (!hasDefect && !hasGap && review.total >= threshold) {
    return { content, review, revised: false, fixMode: 'none', quality: qualityEval };
  }
  if (!hasDefect && !hasGap && !review.patches.length) {
    return { content, review, revised: false, fixMode: 'none', quality: qualityEval };
  }
  // 先试定点修补：改动面小、不伤及已经写好的段落
  if (Array.isArray(review.patches) && review.patches.length) {
    const patched = applyPatches(content, review.patches);
    if (patched.applied.length) {
      const after = {
        ...review, afterFix: true, fixMode: 'patch',
        patched: patched.applied.length, patchSkipped: patched.skipped.length,
      };
      return { content: patched.content, review: after, revised: true, fixMode: 'patch', quality: qualityEval };
    }
  }
  // 兜底：整节重写。重写时把客观缺口一并交给模型——只给评审的定性意见，
  // 模型经常改完结构却还是缺同一层。
  //
  // 超过单次整节重写上限时不做兜底：定点修补已在上面试过，而整节重写必须把
  // 当前稿完整交给模型，截断后重写会把后半段改没。保留原稿，让作者按意见手动改。
  if (String(content).length > APPLY_INPUT_MAX_CHARS) {
    return { content, review, revised: false, fixMode: 'none', quality: qualityEval };
  }
  const { sys, user } = buildMessages({
    project, idx, revision: content, plan: section.plan,
    instruction: '按评审意见逐条修正：保留已有的事实、数据与引用编号，只补强被指出的问题。',
  });
  const gapText = benchmark.gapGuide(qualityEval);
  const fixed = (await generateOnce({ sys, user: `${user}\n\n${craft.reviseBlock(review)}${gapText ? `\n\n${gapText}` : ''}`, onUsage })).trim();
  // 重写稿明显短于原稿时不要：那不是「改」，是把后半段弄丢了。
  const usable = fixed && fixed.length >= content.length * APPLY_MIN_KEEP_RATIO
    && !sectionGate(fixed, sectionMinChars(section));
  if (!usable) return { content, review, revised: false, fixMode: 'none', quality: qualityEval };
  const after = { ...review, afterFix: true, fixMode: 'rewrite' };
  return { content: fixed, review: after, revised: true, fixMode: 'rewrite', quality: qualityEval };
}

// 打磨：默认只跑一轮（成本可控）；maxRounds > 1 时反复「评审→修补」，直到
// 没有可修的问题、或分数不再提升为止。
//
// 为什么要停条件而不是跑满：改稿不是单调变好。第二轮的改写经常把第一轮改对的地方又改坏，
// 所以按分数取最优稿，而不是取最后一稿；分数一旦不涨就立刻停，继续跑只是在烧 token。
//
// 但「只看分数」这个停条件本身是不够的：模型自评分数会有天花板，
// 分数不动时缺陷数可能还在降（缺陷从 3 条降到 1 条，分数还是 85，因为模型给分很粗）。
// 所以这里用双维度收敛：分数不涨 **且** 缺陷数没减少 才停。
// 只有分数这一个信号时，「有改进但分数没动」的稿子会被提前砍掉。
async function reviewAndFix(project, idx, content, { threshold = 70, maxRounds = 1, onUsage = null } = {}) {
  const rounds = Math.max(1, Math.min(5, Number(maxRounds) || 1));
  let current = String(content || '');
  let best = current;
  let bestScore = -1;
  let bestReview = null;
  let bestDefects = Infinity;
  const history = [];
  // 三种收尾：clean（不用改了）/ regressed（改了反而更差）/ rounds（轮次用尽）
  let ended = 'rounds';

  for (let round = 1; round <= rounds; round += 1) {
    const result = await reviewOnce(project, idx, current, { threshold, onUsage });
    const review = result.review;
    const score = review ? Number(review.total) || 0 : 0;
    // 缺陷数 = 评审认定的必修项 + 绕开的必答问题 + 未兑现的论点 + 客观基准缺口。
    // 三者都要算：只看前两项，模型漏报的缺陷就不会触发下一轮。
    const defects = (review ? (review.mustFix || []).length + (review.unanswered || []).length
      + (review.unsupported || []).length : 0)
      + (result.quality && Array.isArray(result.quality.forceGaps) ? result.quality.forceGaps.length : 0);
    history.push({
      round,
      total: score,
      revised: !!result.revised,
      fixMode: result.fixMode || 'none',
      defects,
      chars: current.length,
    });
    // 取最优稿：先比缺陷数，再比分数。
    // 缺陷少的稿子质量更高，即使模型给的分数一样（分数粗、缺陷细）。
    const better = defects < bestDefects || (defects === bestDefects && score > bestScore);
    if (review && better) { bestScore = score; bestDefects = defects; best = current; bestReview = review; }
    if (!result.revised) { ended = 'clean'; break; }
    // 双维度收敛：分数不涨 **且** 缺陷没减少，才算改不动了。
    // 只看分数会砍掉「缺陷在降、分数没动」的有价值的一轮。
    if (history.length >= 2) {
      const prev = history[history.length - 2];
      const scoreStalled = score <= prev.total;
      const defectStalled = defects >= prev.defects;
      if (scoreStalled && defectStalled) { ended = 'regressed'; break; }
    }
    current = result.content;
    ended = 'rounds';
  }

  // 轮次用尽时，最后一轮「改完的稿」还没被评过。按作者的预期取它——
  // 修正是照着评审意见做的，没理由默认它更差；只有真的评出「更差」才回退。
  const finalContent = ended === 'regressed' ? best : current;
  const last = history[history.length - 1] || {};
  // 质量基准随评审一起落库：页面要显示「这一节客观上缺什么」，
  // 光有模型分数是不够的——分数只说「好不好」，基准说「缺哪一层」。
  const finalQuality = evaluateSectionQuality(project, idx, finalContent, project.sections[idx - 1].plan);
  if (bestReview) {
    bestReview = {
      ...bestReview,
      fixMode: last.fixMode || bestReview.fixMode || 'none',
      afterFix: history.some((item) => item.revised),
      rounds: history.length,
      ended,
      history,
      quality: finalQuality ? { score: finalQuality.score, metrics: finalQuality.metrics, gaps: finalQuality.gaps } : null,
    };
    run(`UPDATE doc_sections SET review_json=? WHERE project_id=? AND idx=?`,
      JSON.stringify(bestReview), String(project.id), idx);
  }
  return {
    content: finalContent,
    review: bestReview,
    revised: history.some((item) => item.revised),
    rounds: history.length,
    ended,
    history,
    quality: finalQuality,
  };
}

// ---------- AI 共创 ----------

// 共创的起草：一次不达标就再写一次，并把上一次的判定原因写回提示词。
// 原来只发一次，篇幅类失败会稳定复现（同样的输入得到同样的错）。
async function draftSection(projectId, idx, { instruction = '', skillIds = null, review = false } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  let content = '';
  let failure = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const hint = attempt > 1 && failure
      ? `\n\n【上一次尝试被判定不合格】${failure}\n本次必须修正：不要复用上一版的开头与句式，确保篇幅达标并完整收束。`
      : '';
    const written = await writeSection(project, idx, { instruction, hint });
    content = written.content;
    failure = sectionGate(content, written.minChars);
    if (!failure) break;
  }
  if (failure) throw new Error(`起草内容过短或不合格（${failure}），请补充本节要求后重试`);
  saveSectionContent(projectId, idx, content, 'ai-draft');
  // 若本节是分析预设指定的那一节，把三线表补进去（正文里模型已引用同一批系数）
  attachPresetTable(projectId, idx);
  let reviewResult = null;
  if (review) {
    const fixed = await reviewAndFix(project, idx, content);
    content = fixed.content;
    reviewResult = fixed.review;
    if (fixed.revised) saveSectionContent(projectId, idx, content, 'ai-revise');
  }
  return { ok: true, chars: content.length, review: reviewResult };
}

async function reviseSection(projectId, idx, instruction, { skillIds = null } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const section = project.sections[idx - 1];
  if (!section) throw new Error('小节不存在');
  if (!String(instruction || '').trim()) throw new Error('请填写修改指示');
  if (!section.content) return draftSection(projectId, idx, { instruction, skillIds });
  const source = String(section.content);
  // 整节修改要求模型输出完整正文。超过单次上限就明确拒绝：
  // 截掉后半段再让它「输出完整本节」，落盘会把本节后半段直接抹掉。
  if (source.length > APPLY_INPUT_MAX_CHARS) {
    throw new Error(`本节 ${source.length} 字，超过单次整节修改上限 ${APPLY_INPUT_MAX_CHARS} 字：`
      + '为避免只送前半段导致后文丢失，请用更具体的局部修改指示，或分段修改（本次原文未改动）');
  }
  const minKeep = Math.max(120, Math.ceil(source.length * APPLY_MIN_KEEP_RATIO));
  const { sys, user } = buildMessages({ project, idx, instruction, revision: source, skills: skillIds });
  let content = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const hint = attempt > 1
      ? '\n\n【上一次修改没有返回可用正文】本次必须直接输出修改后的完整本节正文，不要解释。'
      : '';
    content = await generateOnce({ sys, user: user + hint });
    if (content && content.length >= minKeep) break;
  }
  if (!content || content.length < minKeep) {
    throw new Error(`模型返回的修改稿只有 ${content ? content.length : 0} 字，`
      + `不足原文 ${source.length} 字的 ${Math.round(APPLY_MIN_KEEP_RATIO * 100)}%（${minKeep} 字）：`
      + '为避免丢失后文已放弃保存，原文未改动。请重试，或改用局部修改指示。');
  }
  saveSectionContent(projectId, idx, content, 'ai-revise');
  return { ok: true, chars: content.length };
}

// 切换项目的写作方式（共创 / 全托管）。只影响后续动作：共创下输入条做单节起草/修改，
// 全托管下用「整篇生成」批量推进；已有内容两种方式都不覆盖。
// 更新写作要点（论题 + 论据/要点列表）：AI 共创与批量生成的核心指引，随时可改。
function setProjectOutline({ projectId, thesis, points }) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const list = (Array.isArray(points) ? points : []).map((p) => String(p || '').trim()).filter(Boolean).slice(0, 30);
  run(`UPDATE doc_projects SET thesis=?, points_json=?, updated_at=? WHERE id=?`,
    String(thesis || '').trim().slice(0, 2000), JSON.stringify(list), Date.now(), projectId);
  return { ok: true, thesis: String(thesis || '').trim(), points: list };
}

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

// 论文要素：作者、单位、关键词、分类号、基金、参考文献体例。
// 这些不是「写得好不好」的问题，是投稿首页必须有、缺了直接退稿的问题。
function setProjectMeta(projectId, meta = {}) {
  const row = one(`SELECT id, meta_json FROM doc_projects WHERE id=?`, String(projectId || ''));
  if (!row) throw new Error('文档项目不存在');
  let current = {};
  try { current = JSON.parse(row.meta_json || '{}') || {}; } catch {}
  const next = {
    ...current,
    authors: String(meta.authors != null ? meta.authors : current.authors || '').trim().slice(0, 200),
    affiliation: String(meta.affiliation != null ? meta.affiliation : current.affiliation || '').trim().slice(0, 200),
    keywords: String(meta.keywords != null ? meta.keywords : current.keywords || '').trim().slice(0, 300),
    ccode: String(meta.ccode != null ? meta.ccode : current.ccode || '').trim().slice(0, 60),
    fund: String(meta.fund != null ? meta.fund : current.fund || '').trim().slice(0, 200),
    enTitle: String(meta.enTitle != null ? meta.enTitle : current.enTitle || '').trim().slice(0, 300),
    refStyle: quality.REF_STYLES[meta.refStyle] ? meta.refStyle : (current.refStyle || 'gbt7714'),
  };
  run(`UPDATE doc_projects SET meta_json=?, updated_at=? WHERE id=?`,
    JSON.stringify(next), Date.now(), String(projectId));
  return { ok: true, meta: next };
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

// 整篇生成的默认预算：10~20 节的正常开销远低于这个数，它的作用是挡住
// 「重试死循环把账单烧穿」，超限只是暂停、可以续跑。
const DEFAULT_RUN_TOKEN_BUDGET = 200000;

// 同一项目已有未结束的任务：再起一个只会互相覆盖——第二个 createRun 会把第一个
// 标成 abandoned，token 账目和失败原因被切成两段。要接着跑就走续跑。
function activeDocRun(projectId) {
  return orch.findResumableRun(String(projectId), 'doc');
}

async function generateDocProject({ projectId, resumeRunId = '', maxRetries = 3, retryBaseDelayMs = 800,
  maxTokensPerRun = 0, maxTokensPerSection = 0, escalateRetry = null, review = null, reviewThreshold = 0,
  panelReview = null } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const start = 1;
  const end = project.sections.length;

  let runId = String(resumeRunId || '');
  let existing = runId ? orch.getRun(runId) : null;
  if (existing && existing.bookId !== String(projectId)) { existing = null; runId = ''; }
  if (!runId) {
    const active = activeDocRun(projectId);
    if (active) {
      throw Object.assign(
        new Error(`已有未完成的生成任务（${active.status}），请用「从断点续跑」继续`),
        { code: 'RUN_ACTIVE', runId: active.id },
      );
    }
  }

  const stored = (existing && existing.options) || {};
  // 预算优先级：显式参数 > 任务里存的 > 默认。续跑绝不清零，否则刹车永久失效。
  const explicitBudget = Math.max(0, Number(maxTokensPerRun) || 0);
  const storedBudget = Math.max(0, Number(stored.maxTokensPerRun) || 0);
  const budget = explicitBudget || storedBudget || DEFAULT_RUN_TOKEN_BUDGET;
  const escalate = escalateRetry === null ? stored.escalateRetry !== false : escalateRetry !== false;
  // 逐节评审默认开：它是一次便宜的判定 + 只在低分时修订，换来的是「交得出去」而不是「看着像」。
  const reviewEnabled = review === null ? stored.review !== false : review !== false;
  const threshold = Math.max(0, Number(reviewThreshold) || Number(stored.reviewThreshold) || 70);

  if (!runId) {
    runId = orch.createRun({
      bookId: String(projectId), mode: 'doc', fromChapter: start, toChapter: end,
      maxRetries,
      options: {
        docEngine: true, maxTokensPerRun: budget, escalateRetry: escalate,
        review: reviewEnabled, reviewThreshold: threshold,
      },
    })?.id || '';
  }
  activeDocRuns.add(String(runId));
  // 新一轮/续跑开始时清掉旧的取消标记，否则「取消后马上续跑」会立刻又被停掉。
  docCancellations.delete(String(runId));
  docCancellations.delete(String(projectId));

  // 有文献素材但还没矩阵：批量起草前先自动生成一次。
  // 文献综述那一节的质量几乎完全取决于有没有这个矩阵——没有它，模型只能从素材片段里凑。
  // best effort：失败不阻断整篇生成。
  let autoMatrix = false;
  if (!getLiteratureMatrix(projectId)) {
    const literatures = listMaterials(projectId).filter((item) => item.kind === 'literature');
    if (literatures.length) {
      try {
        await buildLiteratureMatrix({ projectId });
        autoMatrix = true;
      } catch { /* 没有矩阵也能写，只是综述会弱一些 */ }
    }
  }

  const created = [];
  const skipped = [];
  const quarantined = [];
  let stopReason = '';
  let runStatus = 'failed';
  let consecutiveFailures = 0;
  let sectionTokens = 0;
  const perSectionBudget = maxTokensPerSection > 0 ? maxTokensPerSection : 0;
  const sections = project.sections;

  const assertBudget = () => {
    if (perSectionBudget > 0 && sectionTokens > perSectionBudget) {
      throw Object.assign(new Error(`本节累计消耗 ${sectionTokens} tokens，超过单节上限 ${perSectionBudget}`), { code: 'TOKEN_RUNAWAY' });
    }
  };

  try {
    for (let idx = 1; idx <= sections.length; idx++) {
      if (docCancellations.has(String(runId)) || docCancellations.has(String(projectId))) {
        throw Object.assign(new Error('任务已取消，已完成小节会保留'), { code: 'BATCH_CANCELLED' });
      }
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
      let bodyReview = null;
      let attempts = 0;
      try {
        const result = await orch.executeWithRetry({
          runId, bookId: String(projectId), chapterNum: idx, phase: 'section',
          maxAttempts: Math.max(1, maxRetries), baseDelayMs: retryBaseDelayMs,
          shouldRetry: (error, kind) => !['cancelled', 'auth', 'context', 'budget'].includes(kind),
          onRetry: ({ error }) => { lastFailure = String(error.message || error).slice(0, 200); },
          task: async (attemptNo, recordUsage) => {
            attempts = attemptNo;
            sectionTokens = 0;
            const usage = (payload) => {
              recordUsage(payload);
              sectionTokens += Number(payload.prompt_tokens || 0) + Number(payload.completion_tokens || 0);
            };
            const hint = escalate && attemptNo > 1 && lastFailure
              ? `\n\n【上一次尝试被判定不合格】${lastFailure}\n本次必须修正并达到篇幅要求。`
              : '';
            const fresh = getProject(projectId);
            const written = await writeSection(fresh, idx, { hint, onUsage: usage });
            assertBudget();
            const failure = sectionGate(written.content, written.minChars);
            if (failure) throw Object.assign(new Error(`质量门禁未通过：${failure}`), { code: 'QUALITY_GATE' });
            if (!reviewEnabled) return { content: written.content, review: null };
            // 深入档多打磨一轮：深度问题（缺机制、缺对比、缺边界）很少能一轮改干净，
            // 而 reviewAndFix 内部有「分数不涨就停」的收敛条件，多给一轮不会无限烧 token。
            const fixed = await reviewAndFix(fresh, idx, written.content, {
              threshold, maxRounds: fresh.depth === 'deep' ? 2 : 1, onUsage: usage,
            });
            assertBudget();
            return { content: fixed.content, review: fixed.review };
          },
        });
        body = result.content;
        bodyReview = result.review;
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
      // 分析预设指定的那一节：正文写完后把三线表补进去
      attachPresetTable(projectId, idx);
      created.push(idx);
      consecutiveFailures = 0;
      if (runId) {
        orch.markChapterCommitted({
          runId, bookId: String(projectId), chapterNum: idx, title: section.title,
          quality: {
            gate: 'passed', chars: body.length, attempts,
            review: bodyReview ? bodyReview.total : null,
            revised: bodyReview ? !!bodyReview.afterFix : false,
          },
          attemptCount: attempts,
        });
      }
      if (budget > 0 && runId) {
        const spent = orch.runUsage(runId).totalTokens;
        if (spent >= budget) {
          stopReason = `累计消耗 ${spent} tokens 已达到上限 ${budget}`;
          runStatus = 'paused_budget';
          orch.pauseRun(runId, stopReason);
          break;
        }
      }
      if (idx % BATCH_YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    if (runStatus !== 'paused_budget') runStatus = quarantined.length ? 'quarantined' : 'completed';
  } catch (error) {
    const cancelled = error && error.code === 'BATCH_CANCELLED';
    runStatus = cancelled ? 'cancelled' : 'failed';
    if (runId) {
      if (cancelled) orch.cancelRun(runId, '任务已取消');
      else orch.quarantineRun(runId, String(error.message || error));
    }
    touchProject(projectId, {
      status: runStatus,
      error: cancelled ? '任务已取消，已完成小节会保留' : String(error.message || error).slice(0, 400),
    });
    if (!cancelled) {
      activeDocRuns.delete(String(runId));
      docCancellations.delete(String(runId));
      docCancellations.delete(String(projectId));
      throw error;
    }
  }
  if (runId) {
    if (runStatus === 'completed') orch.completeRun(runId);
    else if (runStatus === 'quarantined') orch.quarantineRun(runId, quarantined[quarantined.length - 1]?.message || '存在被隔离的小节');
  }
  touchProject(projectId, {
    status: runStatus === 'completed' ? 'done' : runStatus,
    error: stopReason || '',
  });
  // 整篇写完后自动跑一次方法论审查：写作评审看的是单节文笔，
  // 「有没有识别策略」「有没有稳健性检验」是跨节的判断，只能等全文写完再看。
  // best effort：审查失败不影响已经生成的稿子。
  let autoMethodology = false;
  if (runStatus === 'completed') {
    try {
      await reviewMethodology(projectId);
      autoMethodology = true;
    } catch { /* 作者仍可手动点一次 */ }
  }
  // 评审机制开启时，刚写完的小节自动进入一轮评审（只出意见、不自动改稿）。
  // 放在方法论审查之后：方法论看的是全文，评审看的是单节，两者互不依赖。
  //
  // panelReview 是**本次生成**的选择：作者可以在生成按钮旁取消勾选，
  // 只跳过这一次，不改动总开关（方案二：开关由用户掌控，AI 不擅自改变）。
  let autoReview = null;
  // quarantined 只表示个别小节被隔离，本次新写成的节仍应送评；
  // 取消 / 预算暂停 / 异常失败时不自动送评，避免在作者已叫停或额度耗尽后继续产生费用。
  if ((runStatus === 'completed' || runStatus === 'quarantined') && created.length && panelReview !== false) {
    try {
      const reviewEngine = require('./review-engine');
      autoReview = await reviewEngine.autoReviewSections({ projectId, idxs: created });
    } catch { /* 评审不可用不影响已生成的稿子 */ }
  }
  // 本轮报告：页面直接渲染（文档没有文件系统，等价于小说的 设定/生成日志.md）。
  const failureOf = new Map(quarantined.map((item) => [item.idx, item.message]));
  const report = getProject(projectId).sections.map((section) => ({
    idx: section.idx,
    title: section.title,
    status: failureOf.has(section.idx) ? 'quarantined'
      : created.includes(section.idx) ? 'created'
        : skipped.includes(section.idx) ? 'skipped'
          : section.content ? 'existing' : 'pending',
    chars: String(section.content || '').length,
    failure: failureOf.get(section.idx) || '',
    review: section.review ? Number(section.review.total) || 0 : null,
    revised: section.review ? !!section.review.afterFix : false,
  }));
  activeDocRuns.delete(String(runId));
  docCancellations.delete(String(runId));
  docCancellations.delete(String(projectId));
  return {
    ok: !quarantined.length && !stopReason,
    runId, created, skipped, quarantined, stopReason, runStatus,
    autoMatrix, autoMethodology, autoReview,
    usage: runId ? orch.runUsage(runId) : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    report,
    // 跑完顺手体检一遍：批量生成最容易出的问题（节间重复、篇幅塌陷）逐节门禁看不出来。
    audit: auditProject(projectId),
  };
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
  const stored = point.run.options || {};
  const storedBudget = Math.max(0, Number(stored.maxTokensPerRun) || 0);
  // 预算暂停后续跑：授予一个新窗口（已花 + 原窗），否则刚续上就又撞线；
  // 显式传参优先，传 0 表示这次不设上限。
  let budget = args.maxTokensPerRun != null ? Math.max(0, Number(args.maxTokensPerRun) || 0) : storedBudget;
  if (args.maxTokensPerRun == null && storedBudget > 0 && point.run.status === 'paused_budget') {
    budget = orch.runUsage(runId).totalTokens + storedBudget;
  }
  const reopened = orch.reopenChapters(runId, point.reopen);
  orch.resumeRun(runId);
  const result = await generateDocProject({
    projectId: point.run.bookId, resumeRunId: runId,
    maxRetries: args.maxRetries || point.run.maxRetries,
    retryBaseDelayMs: args.retryBaseDelayMs,
    maxTokensPerRun: budget,
    escalateRetry: args.escalateRetry != null ? args.escalateRetry : (stored.escalateRetry !== false),
  });
  return { ...result, resumed: true, fromSection: point.fromChapter, reopened };
}

// 取消文档全托管：进程内有循环时只打标记，循环在下一节边界收尾（当前节写完后停）；
// 没有循环时（重启后、排队中、预算暂停）直接落库，避免一直显示可续跑。
function cancelDocRun({ runId = '', projectId = '' } = {}) {
  const project = String(projectId || '');
  let key = String(runId || '');
  if (!key && project) {
    const latest = activeDocRun(project);
    if (latest) key = latest.id;
  }
  if (!key && !project) throw new Error('缺少 runId 或 projectId');
  if (key) docCancellations.add(key);
  if (project) docCancellations.add(project);
  const inProcess = !!key && activeDocRuns.has(key);
  if (!inProcess && key) {
    const run = orch.getRun(key);
    if (run && orch.ACTIVE_STATUSES.includes(run.status)) {
      orch.cancelRun(key, '任务已取消');
      touchProject(run.bookId, { status: 'cancelled', error: '任务已取消，已完成小节会保留' });
    }
  }
  return { ok: true, runId: key, inProcess };
}

// 小节级对话共创（仿小说的新书共创交互）：作者给信息/指示，AI 追问或成稿。
// 协议：AI 回复以「问：」开头 = 追问（不落稿）；否则视为本节正文，直接保存。
async function sectionChat({ projectId, idx, message }) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const section = project.sections[idx - 1];
  if (!section) throw new Error('小节不存在');
  const text = String(message || '').trim();
  if (!text) throw new Error('请输入内容');
  const chn = llm.activeChannel();
  if (!chn || !chn.baseUrl) throw new Error('未配置模型渠道');
  const type = docTypeOf(project.docType);
  const history = Array.isArray(section.chat) ? section.chat.slice(-12) : [];
  const context = contextChain(project.sections, idx);
  const sys = [
    '你正在与作者协作撰写一份文档的小节——像资深编辑一样先问清、再动笔。',
    `【文档类型】${type.name}`,
    `【文体要求】${type.tone}`,
    project.thesis ? `【论题】\n${project.thesis}` : '',
    (project.points || []).length ? `【论据要点】\n${project.points.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '',
    project.brief ? `【项目说明】\n${project.brief}` : '',
    `【全文结构】\n${outlineText(project.sections)}`,
    context.points ? `【前文要点（承接，不要重复）】\n${context.points}` : '',
    // 前节已立的论点与已用素材：共创时同样要避免「换个说法把前文再讲一遍」。
    context.claims ? `【前文已立论点（不要重复论证）】\n${context.claims}` : '',
    context.usedMaterials ? `【前文已用过的素材编号】${context.usedMaterials}` : '',
    context.tail,
    materialBlock(project, section, section.plan || null),
    literatureContext(project, section),
    analysisContext(project, section),
    `【本节任务】第 ${idx} 节「${section.title}」${section.brief ? '——' + section.brief : ''}`,
    section.content ? `【当前稿】\n${section.content.slice(0, 3000)}` : '',
    '协作规则：',
    '- 作者的消息可能是补充信息、回答你的问题、或对稿件的要求；',
    '- 若关键信息缺失导致无法成稿，先追问：每条问题单独一行、以「问：」开头，一轮最多三条，不要反复追问；',
    '- 若信息足够、或作者明确让你开始写（如「开始写」「写吧」），直接输出本节完整正文：不要任何解释、元信息或代码围栏，输出即可发布；',
    '- 素材之外的事实一律写【待补】，不要编造；',
    '- 作者要求修改当前稿时，输出修改后的完整本节正文。',
  ].filter(Boolean).join('\n');
  const msgs = [{ role: 'system', content: sys }];
  for (const h of history) msgs.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.text });
  msgs.push({ role: 'user', content: text });
  let out = '';
  for await (const ev of llm.chatCompletion({
    baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model || 'deepseek-chat',
    messages: msgs, temperature: 0.55, maxTokens: 8192,
  })) {
    if (ev.type === 'delta') out += ev.text;
  }
  out = out.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  if (!out) throw new Error('模型没有返回内容');
  const isQuestion = /^问\s*[:：]/m.test(out) && out.length < 1200;
  // 成稿也要过一遍门禁：否则「好的」「问：……」以外的半截话、JSON、代码围栏
  // 会直接覆盖正文，作者还以为 AI 写完了。
  const failure = isQuestion ? '' : sectionGate(out, sectionMinChars(section));
  const stamp = Date.now();
  let reply = out;
  if (failure) {
    reply = `（这一版还不能落稿：${failure}）\n请再补充一些具体信息，或直接说「开始写」，我再出完整一节。`;
  }
  const nextHistory = [...history, { role: 'user', text, at: stamp }, { role: 'assistant', text: reply, at: stamp }].slice(-24);
  if (!isQuestion && !failure) saveSectionContent(projectId, idx, out, 'ai-chat');
  run(`UPDATE doc_sections SET chat_json=?, updated_at=? WHERE project_id=? AND idx=?`,
    JSON.stringify(nextHistory), stamp, projectId, idx);
  touchProject(projectId);
  return {
    ok: true,
    type: isQuestion ? 'question' : failure ? 'rejected' : 'draft',
    chars: out.length,
    message: failure,
  };
}

// ---------- 文档级体检与导出 ----------
//
// 逐节门禁只看得到本节：篇幅够、不是 JSON 就放行。可一份论文/申报书真正致命的问题
// 都是跨节的——两节写同一段、某节只有半页、通篇【待补】、论据列了却没用上。
// 这里做确定性审计（不调模型、零成本、可预期），只出报告不阻断：没人能定义「合格」的阈值，
// 硬门禁只会让无人值守直接停死。

const TODO_PATTERN = /【[^】]{0,12}待补[^】]{0,12}】/g;
const DUP_MIN_CHARS = 60;

// 既能接 project 对象（页面渲染时已经取过一次，不必重复查库）也能接 id。
function auditProject(projectOrId) {
  const project = typeof projectOrId === 'string' ? getProject(projectOrId) : projectOrId;
  if (!project || !Array.isArray(project.sections)) return null;
  const sections = project.sections;
  const done = sections.filter((section) => String(section.content || '').trim());
  const issues = [];

  const missing = sections.filter((section) => !String(section.content || '').trim());
  if (missing.length) {
    issues.push({
      level: 'warn', code: 'missing',
      text: `还有 ${missing.length} 节没有正文：${missing.slice(0, 6).map((s) => `第${s.idx}节`).join('、')}${missing.length > 6 ? ' 等' : ''}`,
    });
  }

  const short = done
    .map((section) => ({ idx: section.idx, chars: gate.charCount(section.content), min: sectionMinChars(section) }))
    .filter((item) => item.chars < item.min * 0.7);
  if (short.length) {
    issues.push({
      level: 'warn', code: 'short',
      text: `篇幅不足：${short.slice(0, 5).map((item) => `第${item.idx}节 ${item.chars}/${item.min} 字`).join('；')}${short.length > 5 ? ` 等 ${short.length} 节` : ''}`,
    });
  }

  const firstSeen = new Map();
  const duplicates = [];
  for (const section of done) {
    for (const raw of String(section.content).split(/\n{2,}/)) {
      const normalized = String(raw).replace(/[\s\u3000]/g, '');
      if (normalized.length < DUP_MIN_CHARS) continue;
      const key = normalized.slice(0, 120);
      const owner = firstSeen.get(key);
      if (owner && owner !== section.idx) {
        duplicates.push(`第${owner}节与第${section.idx}节重复：${String(raw).trim().slice(0, 26)}…`);
      } else if (!owner) {
        firstSeen.set(key, section.idx);
      }
    }
  }
  if (duplicates.length) {
    issues.push({
      level: 'warn', code: 'duplicate',
      text: `跨节重复 ${duplicates.length} 处：${duplicates.slice(0, 3).join('；')}`,
    });
  }

  let todo = 0;
  const todoBySection = [];
  for (const section of done) {
    const hits = (String(section.content).match(TODO_PATTERN) || []).length;
    if (!hits) continue;
    todo += hits;
    todoBySection.push(`第${section.idx}节 ${hits} 处`);
  }
  if (todo) {
    issues.push({
      level: todo > 10 ? 'warn' : 'info', code: 'todo',
      text: `还有 ${todo} 处【待补】占位：${todoBySection.slice(0, 6).join('、')}${todoBySection.length > 6 ? ' 等' : ''}——补齐素材后重写这些小节即可`,
    });
  }

  // 论据是否真的用上了：要点被换种说法很常见，所以只做「字面覆盖度」提示，不下结论。
  const wholeText = done.map((section) => section.content).join('\n');
  const wholeGrams = bigrams(wholeText);
  const unused = (project.points || []).filter((point) => {
    const grams = [...bigrams(point)];
    if (!grams.length) return false;
    const hit = grams.filter((gram) => wholeGrams.has(gram)).length;
    return hit / grams.length < 0.3;
  });
  if (unused.length) {
    issues.push({
      level: 'info', code: 'unused-points',
      text: `${unused.length} 条论据在正文里几乎没出现：${unused.slice(0, 3).map((p) => String(p).slice(0, 18)).join('；')}`,
    });
  }

  // 引用合规：编造编号是最容易被一眼看穿的错，单独报警。
  const bib = bibliography(project.id);
  if (bib.ghosts.length) {
    issues.push({
      level: 'warn', code: 'ghost-citation',
      text: `引用了不存在的素材编号 ${bib.ghosts.join('、')}——正文里这些编号没有对应素材，交稿前必须删掉或补素材`,
    });
  }
  if (bib.entries.length) {
    issues.push({
      level: 'info', code: 'citation',
      text: `正文引用了 ${bib.entries.length} 条素材${bib.uncited.length ? `，另有 ${bib.uncited.length} 条素材没被任何小节用到` : ''}`,
    });
  } else if (bib.uncited.length && wholeText) {
    issues.push({
      level: 'info', code: 'no-citation',
      text: `有 ${bib.uncited.length} 条素材，但正文一处编号引用都没有——模型没用你给的事实，先去「素材」里补得更具体些`,
    });
  }

  // 评审分数汇总：全托管逐节评审的结果在这里汇总成一句人话。
  const scored = done.map((section) => section.review).filter((review) => review && Number.isFinite(Number(review.total)));
  const lowScore = scored.filter((review) => Number(review.total) < 70);
  if (scored.length && lowScore.length) {
    issues.push({
      level: 'warn', code: 'low-score',
      text: `${lowScore.length} 节评审低于 70 分（最低 ${Math.min(...lowScore.map((r) => Number(r.total)))} 分），建议逐节重写或补充素材`,
    });
  }

  // 图文并茂：图表 spec 与正文占位符必须对得上。
  // 孤儿占位符（正文里有【图3：…】但没有数据）比没有图更糟——读者会看到一行方括号。
  let figureCount = 0;
  const figureIssues = [];
  const mentionIssues = [];
  let globalFigureNo = 0;
  for (const section of done) {
    const specs = Array.isArray(section.figures) ? section.figures : [];
    figureCount += specs.length;
    const specNos = new Set(specs.map((spec) => Number(spec.no)));
    const placeholders = [...String(section.content).matchAll(/【图\s*(\d{1,2})\s*[：:]/g)].map((m) => Number(m[1]));
    const orphans = [...new Set(placeholders.filter((no) => !specNos.has(no)))];
    if (orphans.length) figureIssues.push(`第${section.idx}节的【图${orphans.join('】【图')}】没有数据`);
    const noPlaceholder = specs.filter((spec) => !placeholders.includes(Number(spec.no)));
    if (noPlaceholder.length) figureIssues.push(`第${section.idx}节有 ${noPlaceholder.length} 张图没在正文里留位置`);
    // 图表要在正文里被提到（「如图 1 所示」），否则读者根本不知道该往哪看。
    const mentioned = quality.figureMentions(section.content);
    for (const spec of specs) {
      globalFigureNo += 1;
      if (!mentioned.has(globalFigureNo)) {
        mentionIssues.push(`图 ${globalFigureNo}（第${section.idx}节）正文没提「图 ${globalFigureNo}」`);
      }
    }
  }
  if (mentionIssues.length) {
    issues.push({
      level: 'info', code: 'figure-mention',
      text: `正文没有呼应图表：${mentionIssues.slice(0, 3).join('；')}——投稿要求正文逐一提及图表（如图 1 所示）`,
    });
  }
  // 表格同样要被正文提及（「如表 1 所示」），并检查表格占位符有没有对应的 spec。
  let tableCount = 0;
  const tableIssues = [];
  let globalTableNo = 0;
  for (const section of done) {
    const specs = Array.isArray(section.tables) ? section.tables : [];
    tableCount += specs.length;
    const specNos = new Set(specs.map((spec) => Number(spec.no)));
    const placeholders = [...String(section.content).matchAll(/【表\s*(\d{1,2})\s*[：:]/g)].map((m) => Number(m[1]));
    const orphans = [...new Set(placeholders.filter((no) => !specNos.has(no)))];
    if (orphans.length) tableIssues.push(`第${section.idx}节的【表${orphans.join('】【表')}】没有数据`);
    const mentioned = quality.figureMentions(section.content, '表');
    for (const spec of specs) {
      globalTableNo += 1;
      if (!mentioned.has(globalTableNo)) {
        tableIssues.push(`表 ${globalTableNo}（第${section.idx}节）正文没提「表 ${globalTableNo}」`);
      }
    }
  }
  if (tableIssues.length) {
    issues.push({
      level: 'info', code: 'table',
      text: `表格需要核对：${tableIssues.slice(0, 3).join('；')}——正文要逐一提及表格，占位符与数据要对得上`,
    });
  }
  if (figureIssues.length) {
    issues.push({
      level: 'warn', code: 'figure',
      text: `图表对不上：${figureIssues.slice(0, 3).join('；')}——重出本节段落计划即可重新生成图表`,
    });
  } else if (!figureCount && done.length && docTypeOf(project.docType).needsFigure !== false) {
    // 只有「该有图」的类型才提示。会议纪要、通知、制度、新闻稿、演讲稿、合同本来就不配数据图，
    // 对这些类型报「全文没有一张图表」是纯噪音，会让人忽略真正该改的地方。
    issues.push({
      level: 'info', code: 'no-figure',
      text: '全文没有一张图表。论文/申报书/BP 至少要有数据图（规模、趋势、结构占比）；'
        + '在「素材」里补一条带数字的数据，重出段落计划时就会自动配图',
    });
  }

  // 子问题没答：这是「深度不够」最具体的证据——给了问题还绕开，说明这一节只是把标题写了一遍。
  const unanswered = [];
  for (const section of done) {
    const list = (section.review && Array.isArray(section.review.unanswered)) ? section.review.unanswered : [];
    for (const item of list) unanswered.push(`第${section.idx}节：${item}`);
  }
  if (unanswered.length) {
    issues.push({
      level: 'warn', code: 'unanswered',
      text: `${unanswered.length} 个必答问题被绕开：${unanswered.slice(0, 2).join('；')}`,
    });
  }

  // 公式：定界符没配对是最致命的坏稿——一整段会被当成公式，渲染出来一片空白。
  let mathTotal = 0;
  let equations = 0;
  const mathBad = [];
  for (const section of done) {
    const info = docMath.inspectMath(section.content);
    mathTotal += info.total;
    equations += info.display;
    if (info.unbalanced) mathBad.push(`第${section.idx}节`);
  }
  if (mathBad.length) {
    issues.push({
      level: 'warn', code: 'math-delimiter',
      text: `${mathBad.join('、')} 的公式定界符没配对（$ 或 $$ 的个数是奇数）——导出后这段文字会被当成公式，显示成空白，交稿前必须补齐`,
    });
  }

  // 数字溯源：正文里的数字必须能在素材或图表里找到出处。
  // 模型顺着语境编一个「73% 的企业」是论文最危险的一类错误——引用编号编出来会被查出来，
  // 编数据不会被。等审稿人拿原始调研对一遍才发现，代价就大了。
  const sourceNumbers = quality.sourceNumberSet(
    listMaterials(project.id),
    done.map((section) => section.figures || []),
    done.map((section) => section.tables || []),
  );
  const unbacked = [];
  let unbackedCount = 0;
  for (const section of done) {
    const items = quality.unbackedNumbers(section.content, sourceNumbers);
    if (!items.length) continue;
    unbackedCount += items.length;
    unbacked.push(`第${section.idx}节 ${items.map((item) => `${item.raw}${item.unit}`).join('、')}`);
  }
  if (unbacked.length) {
    issues.push({
      level: 'warn', code: 'unbacked-number',
      text: `${unbackedCount} 个数字在素材与图表里找不到出处：${unbacked.slice(0, 3).join('；')}`
        + '——如果是你自己测算的请补上测算口径，如果是模型编的必须删掉或换成【待补】',
    });
  }

  // 近似重复：换个说法把同一件事讲两遍，精确查重查不出来，审稿人一眼看得出。
  // 真实跑下来，同一节内部的重复比跨节更常见（模型会反复引用同一条文献的同一个数字），
  // 所以同节段落对也要查，只是阈值更高一点。
  const near = quality.nearDuplicates(project.sections, { threshold: 0.72, sameSectionThreshold: 0.82 });
  if (near.length) {
    const first = near[0];
    const where = first.sameSection
      ? `第${first.a.idx}节内部两段高度相似`
      : `第${first.a.idx}节与第${first.b.idx}节高度相似`;
    issues.push({
      level: 'warn', code: 'near-duplicate',
      text: `有 ${near.length} 处内容高度相似（最高 ${Math.round(first.score * 100)}%）：`
        + `${where}，讲的是「${first.snippet}…」——合并或删掉一处`,
    });
  }

  // 因果表述自相矛盾：同一节里既声明「只能是条件相关/不能读成因果」，
  // 又用「带来/导致/使得」这类因果动词，等于自己打自己。
  const contradiction = [];
  for (const section of done) {
    const text = String(section.content || '');
    const disclaims = /条件相关|非因果|不能读成因果|不代表因果|相关关系而非因果/.test(text);
    const causal = /带来|导致|引起|使得.{0,10}(提升|提高|增加|下降)/.test(text);
    if (disclaims && causal) contradiction.push(`第${section.idx}节`);
  }
  if (contradiction.length) {
    issues.push({
      level: 'warn', code: 'causal-contradiction',
      text: `${contradiction.join('、')} 一边声明「只能读作条件相关」，一边用「带来/导致」这类因果动词`
        + '——审稿人会把这里当成论证不严谨的证据。要么全篇统一为相关表述，要么补识别策略后再说因果',
    });
  }

  // 文体专项：BP 财务假设、申报书指标、合同条款、调研样本——按类型各自的硬要求。
  const typeScan = typekit.scanByType(project);
  if (typeScan) {
    for (const item of typeScan.findings) {
      issues.push({ level: item.level, code: `type-${item.code}`, text: `${item.title}——${item.detail}` });
    }
  }

  // 非法引用标记：正文里出现 [xxx] 但既不是素材编号、也不是参考文献序号、也不是 Markdown 链接。
  // 真实跑下来模型会自己造「[本节数据]」这种标记——它不在素材清单里，ghost-citation 也查不到
  //（那个只认 [M\d]），但读者一眼就看出这是个没落地的占位。
  const bogus = [];
  for (const section of done) {
    const text = String(section.content || '');
    for (const matched of text.matchAll(/\[([^\]\n]{1,24})\](?!\()/g)) {
      const inner = matched[1].trim();
      if (/^M\d{1,3}$/i.test(inner)) continue;   // 素材编号
      if (/^\d{1,3}$/.test(inner)) continue;      // 参考文献序号
      if (!inner) continue;
      bogus.push(`第${section.idx}节「[${inner}]」`);
    }
  }
  if (bogus.length) {
    issues.push({
      level: 'warn', code: 'bogus-citation',
      text: `正文里有 ${bogus.length} 处非标准引用标记：${bogus.slice(0, 4).join('、')}`
        + '——这些方括号既不是素材编号也不是参考文献序号，交稿前要么换成素材编号，要么删掉',
    });
  }

  // 参考文献著录不完整：缺作者/年份的条目在投稿系统里会被要求补全。
  const incomplete = bib.entries.filter((entry) => !entry.authors || !entry.year);
  if (incomplete.length) {
    issues.push({
      level: 'info', code: 'reference-meta',
      text: `${incomplete.length} 条参考文献缺著录信息（作者或年份）——在「素材」里补上，参考文献页才能按体例排出来`,
    });
  }

  // 质量基准：客观检测每一节的论证层数、依据密度、空话与论点兑现情况。
  // 这是体检里最有用的一块——它不靠模型自评，直接指出「第 3 节只有结论没有机制」。
  //
  // 按缺口类型聚合，而不是每节每缺口各报一条：一篇 8 节的论文按条报会刷出十几条，
  // 作者只会全部忽略。聚合成「依据密度不足：第 2、4、7 节」才有可操作性。
  const baselineReports = [];
  const gapGroups = new Map();
  for (const section of done) {
    const evalResult = evaluateSectionQuality(project, section.idx, section.content, section.plan);
    if (!evalResult) continue;
    baselineReports.push({ idx: section.idx, title: section.title, ...evalResult });
    for (const gap of evalResult.gaps) {
      const group = gapGroups.get(gap.code) || { level: gap.level, code: gap.code, sections: [], text: gap.text };
      group.sections.push(section.idx);
      // 保留第一条的完整描述（它带具体的缺项），后面的只累计节号。
      gapGroups.set(gap.code, group);
    }
  }
  for (const group of gapGroups.values()) {
    const where = `第${group.sections.slice(0, 6).join('、')}节${group.sections.length > 6 ? ' 等' : ''}`;
    issues.push({
      level: group.level,
      code: `quality-${group.code}`,
      text: `${where} ${group.text}`,
    });
  }
  const weakSections = baselineReports.filter((item) => item.score < 60);
  if (weakSections.length) {
    issues.push({
      level: 'info', code: 'quality-baseline',
      text: `${weakSections.length} 节质量基准低于 60 分（最低 ${Math.min(...weakSections.map((item) => item.score))} 分）：`
        + `${weakSections.slice(0, 3).map((item) => `第${item.idx}节 ${item.score} 分`).join('；')}`
        + '——「深度打磨」会按检测到的缺口逐条补强',
    });
  }

  return {
    issues,
    summary: {
      sections: sections.length,
      done: done.length,
      chars: done.reduce((sum, section) => sum + gate.charCount(section.content), 0),
      todo,
      duplicates: duplicates.length,
      short: short.length,
      citations: bib.entries.length,
      ghosts: bib.ghosts.length,
      figures: figureCount,
      tables: tableCount,
      math: mathTotal,
      equations,
      unbackedNumbers: unbackedCount,
      nearDuplicates: near.length,
      unanswered: unanswered.length,
      // 质量基准汇总：平均分 + 达标的节数。作者一眼能看出整体处在什么水平。
      qualityScore: baselineReports.length
        ? Math.round(baselineReports.reduce((sum, item) => sum + item.score, 0) / baselineReports.length) : null,
      qualityPassed: baselineReports.filter((item) => item.pass).length,
      qualityTotal: baselineReports.length,
      avgScore: scored.length
        ? Math.round(scored.reduce((sum, review) => sum + Number(review.total), 0) / scored.length) : null,
    },
    baseline: baselineReports.map((item) => ({
      idx: item.idx, title: item.title, score: item.score, pass: item.pass,
      metrics: item.metrics, gaps: item.gaps.map((gap) => gap.text),
    })),
  };
}

// Word 导出：论文要交 Word、申报书要用单位模板、BP 要给投资人——只给 Markdown 等于没交付。
function assembleDocx(projectId) {
  const project = getProject(projectId);
  if (!project) return null;
  const type = docTypeOf(project.docType);
  const stamp = new Date().toLocaleDateString('zh-CN');
  const bib = bibliography(projectId);
  const laid = figure.globalizeFigures(project.sections.map((item) => ({ content: item.content, figures: item.figures })));
  const laidTables = docTable.globalizeTables(project.sections.map((item, index) => ({
    content: laid[index].content, tables: item.tables,
  })));
  // 正文里的 [M1] 是内部工单号，导出时换成论文正文序号 [1]
  // 模板绑定：正文里模型自写的标题与「一、xxx」编号行都要规范化，
  // 否则它们会和模板节标题的编号撞车，看起来像目录被改写了一遍。
  const sections = project.sections.map((section, index) => {
    const body = quality.remapCitations(String(laidTables[index].content || ''), bib.map);
    return {
      title: section.title,
      // 层级一起交出去：一级节是 Heading1，二级节是 Heading2，编号也跟着变成 1.1。
      level: Math.max(1, Math.min(3, Number(section.level) || 1)),
      // Word 导出里 Markdown 标题由 flatHeadings 降为「正文小标题」样式，
      // 这里只做编号行规范化：把「一、xxx」这类模型自写的编号行剥掉编号，
      // 否则它会和模板节标题的编号撞车。
      content: project.templateBound
        ? quality.stripPseudoHeadings(body, { asHeading: true })
        : body,
    };
  });
  // 全文所有图表按出现顺序交给导出层，编号在 globalize* 里已经连好。
  const figures = laid.flatMap((item) => item.figures);
  const tables = laidTables.flatMap((item) => item.tables);
  if (bib.entries.length) {
    sections.push({ title: '参考文献', level: 1, content: bibliographyLines(bib.entries, project.refStyle).join('\n\n') });
  }
  // 模板绑定的文档：标题由模板决定，不要再让模型写的 # 标题进目录（降为正文小标题）。
  const buffer = buildDocx({
    title: project.title,
    // 论文首页不写「学术论文 · 日期」这种文档头——首页要的是作者、单位、关键词
    subtitle: project.docType === 'paper' ? '' : `${type.name} · ${stamp}`,
    brief: project.brief,
    // 投稿首页那一整套：作者、单位、关键词、分类号、基金
    front: frontMatter(project),
    sections,
    figures,
    tables,
    // 排版规格：字体字号行距缩进编号页边距。蒸馏出的版式在这一步才真正落到 docx。
    layout: project.layout,
    // 模板绑定 → 正文里模型自写的 # 标题降为加粗小标题，不进导航窗格/目录。
    flatHeadings: project.templateBound,
    // 模板绑定 → 正文前放一个 Word 目录域。域里的条目直接来自模板的 Heading 层级，
    // 打开就能看到与模板一致的导航结构（而不是让作者自己数标题）。
    toc: project.templateBound,
    footer: project.docType === 'contract'
      ? '本文档由 AI 辅助起草，不构成法律意见；签署前必须经专业人士审核。'
      : '',
  });
  return { filename: `${project.title}.docx`, buffer };
}

// 论文要素（作者/单位/关键词/分类号/基金）：投稿首页上那一行行小字。
function frontMatter(project) {
  const meta = project.meta || {};
  const lines = [];
  if (meta.enTitle) lines.push(meta.enTitle);
  if (meta.authors) lines.push(meta.authors);
  if (meta.affiliation) lines.push(meta.affiliation);
  if (meta.fund) lines.push(`基金项目：${meta.fund}`);
  if (meta.ccode) lines.push(`中图分类号：${meta.ccode}`);
  if (meta.keywords) lines.push(`关键词：${meta.keywords}`);
  return lines;
}

// ---------- 评审 / 润色 / 提问 / 研究（页面上的按钮都走这里） ----------

// 共创里的「评审本节」：只评不改，或者按评审意见改一次。
// rounds > 1 就是「深度打磨」：反复评审+修补，直到没有可修的问题或分数不再提升。
// 每多一轮就多一次评审（+可能一次改写），所以默认只跑一轮，深度打磨由作者显式触发。
async function reviewSectionNow(projectId, idx, { fix = false, rounds = 1 } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const section = project.sections[Number(idx) - 1];
  if (!section) throw new Error('小节不存在');
  if (!String(section.content || '').trim()) throw new Error('这一节还没有正文，先起草再评审');
  const result = await reviewAndFix(project, Number(idx), section.content, {
    threshold: fix ? 70 : 0,
    maxRounds: fix ? Math.max(1, Number(rounds) || 1) : 1,
  });
  if (result.revised) saveSectionContent(projectId, Number(idx), result.content, 'ai-revise');
  return {
    ok: true, review: result.review, revised: result.revised,
    chars: result.content.length, rounds: result.rounds, ended: result.ended,
    history: result.history,
  };
}

// 重新出段落计划（作者觉得骨架不对时用）。
async function regeneratePlan(projectId, idx) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const plan = await ensurePlan(project, Number(idx), { force: true });
  if (!plan) throw new Error('模型没有返回可用的段落计划，请重试');
  return { ok: true, plan };
}

// 视角发现提问（STORM）：把「素材答不出的问题」列出来，按小节存。
async function suggestSectionQuestions(projectId, idx) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const index = Number(idx);
  const section = project.sections[index - 1];
  if (!section) throw new Error('小节不存在');
  const materials = selectMaterialSnippets(projectId, materialQuery(project, section));
  const result = await craft.suggestQuestions({ generate: generateOnce, project, idx: index, materials });
  if (!result) throw new Error('模型没有返回可用的问题，请重试');
  const store = { ...(project.questions || {}) };
  store[String(index)] = result;
  run(`UPDATE doc_projects SET questions_json=?, updated_at=? WHERE id=?`,
    JSON.stringify(store), Date.now(), projectId);
  return result;
}

// 让模型先以专家身份把这些问题答一遍，产出直接存成素材——
// 「提问 → 研究 → 素材 → 引用」闭环，这是 STORM 里最值钱的一步。
async function researchSection(projectId, idx) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const index = Number(idx);
  const stored = (project.questions || {})[String(index)];
  const questions = stored && Array.isArray(stored.perspectives)
    ? stored.perspectives.flatMap((item) => (item.questions || []).map((entry) => entry.q)).filter(Boolean)
    : [];
  if (!questions.length) throw new Error('还没有问题可答，先点「AI 提问」');
  const section = project.sections[index - 1];
  const materials = selectMaterialSnippets(projectId, materialQuery(project, section));
  const text = String(await craft.researchAnswers({
    generate: generateOnce, project, idx: index, questions, materials,
  }) || '').trim();
  if (text.length < 60) throw new Error('模型没有返回可用的研究纪要，请重试');
  const added = addMaterial({
    projectId, kind: 'material',
    title: `第${index}节研究纪要（${new Date().toLocaleDateString('zh-CN')}）`,
    content: text,
  });
  return { ok: true, chars: text.length, materialId: added.id, questions: questions.length };
}

// 全文润色：逐节带前后文重写衔接。这是长任务，走后台任务 + 状态查询，不占 HTTP 请求。
const polishJobs = new Map();

function polishStatus(projectId) {
  const job = polishJobs.get(String(projectId));
  if (!job) return { running: false, done: 0, total: 0, changed: [], error: '', finishedAt: 0 };
  return { ...job, changed: job.changed.slice() };
}

function startPolish(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const key = String(projectId);
  const current = polishJobs.get(key);
  if (current && current.running) throw Object.assign(new Error('已在润色中，等这一轮跑完'), { code: 'POLISH_ACTIVE' });
  const targets = project.sections.filter((section) => String(section.content || '').trim().length >= 80);
  if (!targets.length) throw new Error('还没有可润色的正文');
  const job = { running: true, done: 0, total: targets.length, changed: [], error: '', startedAt: Date.now(), finishedAt: 0 };
  polishJobs.set(key, job);

  const work = async () => {
    try {
      for (const target of targets) {
        const fresh = getProject(projectId);
        const section = fresh.sections[target.idx - 1];
        const before = String(section.content || '');
        if (!before.trim()) { job.done += 1; continue; }
        const context = contextChain(fresh.sections, target.idx);
        const nextPoints = fresh.sections.slice(target.idx)
          .map((item) => item.summary).filter(Boolean).slice(0, 4).join('\n');
        const materials = selectMaterialSnippets(projectId, materialQuery(fresh, section));
        const polished = String(await craft.polishSection({
          generate: generateOnce, project: fresh, idx: target.idx,
          content: before, prevPoints: context.points, nextPoints, materials,
        }) || '').trim();
        // 润色的硬约束：长度在 90%~125% 之间，且不能把一节改成半截。
        const usable = polished.length >= before.length * 0.9
          && polished.length <= before.length * 1.25
          && !sectionGate(polished, sectionMinChars(section));
        if (usable && polished !== before) {
          saveSectionContent(projectId, target.idx, polished, 'ai-polish');
          job.changed.push(target.idx);
        }
        job.done += 1;
      }
    } catch (error) {
      job.error = String((error && error.message) || error);
    } finally {
      job.running = false;
      job.finishedAt = Date.now();
    }
  };
  // 不 await：调用方（页面路由）拿到 { started, total } 就走，进度靠 polishStatus 查。
  work();
  return { started: true, total: targets.length };
}

// ---------- 模板蒸馏与拆解：样例文档 → 可复用模板 + 文档技法技能 ----------

function listDocTemplates() {
  return q(`SELECT * FROM doc_templates ORDER BY updated_at DESC`).map((row) => ({
    id: row.id, name: row.name, docType: row.doc_type,
    sections: (() => { try { return JSON.parse(row.sections_json || '[]') || []; } catch { return []; } })(),
    layout: (() => {
      try { return layout.normalizeLayout(JSON.parse(row.layout_json || '{}')); } catch { return layout.normalizeLayout({}); }
    })(),
    notes: row.notes || '', updatedAt: Number(row.updated_at || 0),
  }));
}

function saveDocTemplate({ id, name, docType = 'custom', sections, notes = '', layout: layoutSpec = null }) {
  const key = String(id || crypto.randomUUID());
  const list = Array.isArray(sections) ? sections : [];
  if (!String(name || '').trim()) throw new Error('模板需要名称');
  if (!list.length) throw new Error('模板至少要有一个小节');
  const layoutJson = JSON.stringify(layout.normalizeLayout(layoutSpec || {}));
  run(`INSERT INTO doc_templates(id,name,doc_type,sections_json,notes,layout_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, doc_type=excluded.doc_type,
      sections_json=excluded.sections_json, notes=excluded.notes,
      layout_json=excluded.layout_json, updated_at=excluded.updated_at`,
  key, String(name).trim().slice(0, 120), String(docType || 'custom'),
  JSON.stringify(list), String(notes || '').slice(0, 4000), layoutJson, Date.now(), Date.now());
  return { ok: true, id: key };
}

function deleteDocTemplate(id) {
  run(`DELETE FROM doc_templates WHERE id=?`, String(id || ''));
  return { ok: true };
}

// 模板 → 可编辑的大纲文本（新建弹窗里选中模板后填进 textarea）。
// 只输出小节本身：以前第一行是「# 模板名（模板）」，粘进大纲后会被解析成第 1 节，
// 于是一份「选模板建的文档」开头永远多出一节叫模板名的正文。
// 标题的 # 数量跟着层级走，粘回去再解析时层级不会丢。
function templateMarkdown(tpl) {
  const parts = [];
  for (const section of tpl.sections) {
    const depth = Math.min(3, Math.max(1, Number(section.level) || 1));
    parts.push(`${'#'.repeat(depth)} ${section.title}`, section.brief || '', '');
  }
  return parts.join('\n').trim() + '\n';
}

// 蒸馏：样例文档 → 结构化拆解（章节目录 + 排版规格 + 文风技法），存为命名模板 + doc 域技能。
//
// 蒸馏要同时回答三个问题，缺一个都不算「可复用的模板」：
// 1. 写什么     → 章节目录（层级、标题、每节要覆盖什么、篇幅）
// 2. 长什么样   → 排版规格（字体字号行距缩进编号规则页边距）
// 3. 怎么写     → 文风技法（语气、句式、论证方式）
//
// 关键分工：1 和 2 只要样例是 .docx，就由 docx-probe 直接「测量」出来，
// 模型只负责补 brief（这一节该写什么）和 styleNotes（文风技法）。
// 让模型猜字体字号是做不到的——纯文本里没有这些信息，猜出来的永远是「常见值」，
// 所以上传 docx 时实测值优先，模型给的 layout 只在没有实测值时兜底。
async function distillDocTemplate({ name = '', docType = 'custom', sample, sampleLayout = null, sampleOutline = null }) {
  const text = String(sample || '').trim();
  if (text.length < 200) throw new Error('样例文档太短（至少 200 字），蒸馏才有依据');
  const chn = llm.activeChannel();
  if (!chn || !chn.baseUrl) throw new Error('未配置模型渠道');
  const type = docTypeOf(docType);
  const measured = sampleLayout ? layout.layoutSummary(sampleLayout) : null;
  const probed = layout.normalizeSections(Array.isArray(sampleOutline) ? sampleOutline : []);
  // 实测目录给模型看的时候带上层级编号，它才不会把二级小节拍平
  const outlineLines = [];
  const outlineCounters = [0, 0, 0];
  for (const section of probed) {
    const level = Math.min(3, Math.max(1, section.level));
    outlineCounters[level - 1] += 1;
    for (let deeper = level; deeper < outlineCounters.length; deeper++) outlineCounters[deeper] = 0;
    outlineLines.push(`${outlineCounters.slice(0, level).join('.')} ${section.title}`);
  }
  const outlineBlock = outlineLines.join('\n');
  const sys = [
    '你是文书结构与版式分析师。分析用户提供的样例文档，提炼出可复用的写作模板、版式规格与技法。',
    `目标用途：${type.name}类文档。`,
    '只输出一个严格 JSON 对象（不要围栏、不要解释）：',
    '{"title":"模板名（12字内）","summary":"该文档的结构与写法要点（100字内）",',
    ' "sections":[{"level":1,"title":"小节标题","brief":"该节写什么、必须覆盖什么、篇幅建议（一句话，具体）","minChars":600}],',
    ' "layout":{"bodyFont":"宋体","bodyFontEn":"Times New Roman","bodySize":12,"lineSpacing":1.5,',
    '   "paraSpacing":0,"firstLineIndent":2,"align":"both","titleFont":"黑体","titleSize":18,',
    '   "headingFont":"黑体","headingSizes":{"1":15,"2":14,"3":12},"headingBold":true,',
    '   "numbering":"chinese","pageSize":"A4","marginTop":2.54,"marginBottom":2.54,',
    '   "marginLeft":3.17,"marginRight":3.17,"captionSize":10.5,"captionAlign":"center","footerText":""},',
    ' "styleNotes":"文风与技法要点：语气、句式、论证方式、可复用的结构技法（150字内）"}',
    probed.length
      ? '规则零（目录）：样例的实际目录已由文档解析器读出（见用户消息里的【实测目录】），'
        + 'sections 必须与它逐条对应：数量、顺序、层级、标题都不许改，你只补 brief 与 minChars。'
      : '规则一（小节）：小节数量与顺序严格跟随样例文档的实际结构（通常 4~12 节）；',
    'level 表示层级，1=一级标题（章），2=二级，3=三级；brief 必须具体到「该节必须覆盖什么」；不发明样例里没有的节。',
    measured
      ? '规则二（版式）：样例的版式已由文档解析器实测（见用户消息里的【实测版式】），'
        + 'layout 必须原样回填这组数值，一个都不要改——模型看不出字体字号，实测值才是真的。'
      : '规则二（版式）：layout 必须从样例文档的实际观感推断，不要填默认值糊弄：'
        + '正文用几号字、行距几倍、首行缩进几个字符、标题比正文大几号、标题用什么字体、编号是「一、」还是「1.1」、'
        + '页边距多少。样例看不出确定值时取最常见的学术/公文规范值（正文宋体小四=12磅、行距1.5、缩进2字符、一级标题黑体三号=15磅）。',
    '  numbering 只能是 chinese / arabic / none；align 只能是 left / center / right / both。',
    '规则三（文风）：styleNotes 要写能直接照着做的技法，不要写「语言流畅」这种空话。',
  ].join('\n');
  const userIntro = [
    probed.length ? `【实测目录】\n${outlineBlock}` : '',
    measured ? `【实测版式】\n${measured.bodyLine}\n${measured.headingLine}\n${measured.titleLine}\n${measured.pageLine}` : '',
    `【样例文档】\n\n${text.slice(0, 12000)}`,
  ].filter(Boolean).join('\n\n');
  let parsed = null;
  let lastRaw = '';
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    let out = '';
    for await (const ev of llm.chatCompletion({
      baseUrl: chn.baseUrl, apiKey: chn.key, model: chn.model || 'deepseek-chat',
      messages: [{ role: 'system', content: sys }, {
        role: 'user',
        content: attempt === 0 ? userIntro : `${userIntro}\n\n上一次输出不是合法 JSON。现在只输出严格 JSON 对象。`,
      }],
      temperature: 0.3, maxTokens: 6144,
    })) {
      if (ev.type === 'delta') out += ev.text;
    }
    lastRaw = out;
    parsed = llm.extractJson(out);
    if (parsed && (!Array.isArray(parsed.sections) || !parsed.sections.length)) parsed = null;
  }
  if (!parsed && !probed.length) {
    throw new Error(`蒸馏失败：模型没有返回可解析的结构（原始输出前 120 字：${lastRaw.slice(0, 120)}）`);
  }
  const modelSections = layout.normalizeSections(parsed && parsed.sections);
  // 目录以实测为准：模型只补 brief / 篇幅。模型多给或少给节，一律以样例的实际目录为准——
  // 「蒸馏出来的目录不是样例的目录」这件事没有第二种合理解释。
  const sections = probed.length
    ? probed.map((section, index) => ({
      ...section,
      brief: String((modelSections[index] && modelSections[index].brief) || '').slice(0, 1200),
      minChars: Math.max(120, Number(modelSections[index] && modelSections[index].minChars) || section.minChars),
    }))
    : modelSections;
  if (!sections.length) throw new Error('蒸馏结果没有有效小节');
  // 版式：实测值优先，模型猜的只在没有实测时兜底
  const layoutSpec = layout.normalizeLayout(sampleLayout || (parsed && parsed.layout));
  const tplName = String(name || '').trim() || String((parsed && parsed.title) || '').trim() || `${type.name}模板`;
  const summary = String((parsed && parsed.summary) || '');
  const styleNotes = String((parsed && parsed.styleNotes) || '');
  const notes = [summary, styleNotes ? `文风技法：${styleNotes}` : ''].filter(Boolean).join('\n');
  const saved = saveDocTemplate({ name: tplName, docType: type.key, sections, notes, layout: layoutSpec });
  // 同时沉淀为 doc 域技能：写作时可作为叠加技能注入文风与技法
  const skill = mis.createSkill({
    name: `文书技法 · ${tplName}`,
    description: summary || `由样例文档蒸馏的${type.name}写法`,
    promptTemplate: `你在撰写${type.name}时须遵循以下从优秀样例中蒸馏的写法：\n${summary}\n${styleNotes ? '文风技法：' + styleNotes : ''}`,
    kind: 'method', usageMode: 'support', domain: 'doc',
  });
  return {
    ok: true, templateId: saved.id, name: tplName, sections,
    layout: layoutSpec,
    summary, styleNotes, skillId: skill.id,
  };
}

// ---------- 数据集与统计分析 ----------
//
// 论文的「结果与分析」必须由数据算出来。模型不会算标准误，也不该算——
// 它只需要读我们算好的系数。所以这里的数字全部来自 lib/doc-stats 的计算，
// 模型最多负责把结论写顺，不能改动任何一个数。

const MAX_DATASET_BYTES = 4 * 1024 * 1024;

function addDataset({ projectId, name = '', content = '' } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const text = String(content || '');
  if (text.length < 10) throw new Error('数据表是空的');
  if (text.length > MAX_DATASET_BYTES) throw new Error('数据表太大（上限 4MB），先抽成分析用的子集');
  const parsed = stats.parseCsv(text);
  if (!parsed.columns.length || !parsed.rows.length) throw new Error('没解析出数据：第一行要是列名，至少一行数据');
  if (parsed.columns.length < 2) throw new Error('至少要两列（一列变量、一列取值）');
  const id = crypto.randomUUID();
  const stamp = Date.now();
  const label = String(name || '').trim().slice(0, 120) || `数据集 ${new Date(stamp).toLocaleString('zh-CN', { hour12: false })}`;
  run(`INSERT INTO doc_datasets(id,project_id,name,content,rows,cols,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
    id, String(projectId), label, text.slice(0, MAX_DATASET_BYTES), parsed.rows.length, parsed.columns.length, stamp, stamp);
  touchProject(projectId);
  return { ok: true, id, name: label, rows: parsed.rows.length, cols: parsed.columns.length };
}

// 数据体检：在跑回归之前先判断「这份数据撑不撑得住这个模型」。
// 结果落库，页面直接显示——作者在动笔前就知道样本量够不够、有没有共线。
function diagnoseDataset({ projectId, datasetId, spec = {} } = {}) {
  const dataset = loadDataset(projectId, datasetId);
  const result = stats.diagnose(dataset, {
    y: String(spec.y || ''),
    x: (Array.isArray(spec.x) ? spec.x : []).filter(Boolean),
  });
  run(`UPDATE doc_datasets SET diagnosis_json=?, updated_at=? WHERE id=? AND project_id=?`,
    JSON.stringify(result), Date.now(), String(datasetId), String(projectId));
  return result;
}

function listDatasets(projectId) {
  return q(`SELECT id, name, rows, cols, created_at, diagnosis_json FROM doc_datasets WHERE project_id=? ORDER BY created_at DESC`,
    String(projectId)).map((row) => {
    const dataset = one(`SELECT content FROM doc_datasets WHERE id=?`, row.id);
    const parsed = stats.parseCsv(dataset ? dataset.content : '');
    return {
      id: row.id,
      name: row.name || '',
      rows: Number(row.rows || 0),
      cols: Number(row.cols || 0),
      truncated: parsed.truncated,
      columns: stats.describeColumns(parsed),
      diagnosis: (() => {
        try {
          const parsedDiag = JSON.parse(row.diagnosis_json || '{}');
          return parsedDiag && Array.isArray(parsedDiag.findings) && parsedDiag.findings.length ? parsedDiag : null;
        } catch { return null; }
      })(),
      createdAt: Number(row.created_at || 0),
    };
  });
}

function removeDataset({ projectId, id } = {}) {
  run(`DELETE FROM doc_datasets WHERE id=? AND project_id=?`, String(id || ''), String(projectId || ''));
  touchProject(projectId);
  return { ok: true };
}

function loadDataset(projectId, datasetId) {
  const row = one(`SELECT id, name, content FROM doc_datasets WHERE id=? AND project_id=?`,
    String(datasetId || ''), String(projectId || ''));
  if (!row) throw new Error('数据集不存在，先上传 CSV');
  const parsed = stats.parseCsv(row.content);
  if (!parsed.rows.length) throw new Error('数据集没有数据行');
  return { id: row.id, name: row.name || '', ...parsed };
}

function fmt(value, digits = 3) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const num = Number(value);
  if (Math.abs(num) >= 10000) return num.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  return num.toFixed(digits).replace(/\.?0+$/, '') || '0';
}

// p 值的写法：<0.001 时不能写成「p=<0.001」
function pText(p) {
  if (!Number.isFinite(p)) return 'p 值不可用';
  return p < 0.001 ? 'p<0.001' : `p=${stats.formatP(p)}`;
}

// 跑一次分析。返回三线表 spec + 结果段文字（数字全部来自计算）。
function runAnalysis({ projectId, datasetId, kind = 'describe', spec = {} } = {}) {
  const dataset = loadDataset(projectId, datasetId);
  const numeric = dataset.columns.filter((column, index) =>
    stats.describeColumns(dataset)[index].type === 'number');
  const requested = Array.isArray(spec.columns) ? spec.columns.filter((name) => dataset.columns.includes(name)) : [];

  if (kind === 'describe') {
    const names = requested.length ? requested : numeric.slice(0, 10);
    if (!names.length) throw new Error('没有可用的数值列，先在数据表里检查列类型');
    const columns = stats.numericColumns(dataset, names);
    if (!columns) throw new Error('选中的列里有非数值数据');
    const rows = names.map((name, index) => {
      const d = stats.describe(columns[index]);
      return [name, String(d.n), fmt(d.mean), fmt(d.sd), fmt(d.min), fmt(d.median), fmt(d.max)];
    });
    const table = {
      title: '变量描述性统计',
      note: `样本量 ${dataset.rows.length} 行；缺失值已按列剔除。`,
      columns: ['变量', 'N', '均值', '标准差', '最小值', '中位数', '最大值'],
      rows,
    };
    const first = rows[0];
    const narrative = `表 N 报告了主要变量的描述性统计。样本共 ${dataset.rows.length} 行观测，`
      + `${names.length} 个数值变量的均值在 ${fmt(Math.min(...columns.map((c) => stats.mean(c))), 2)} 至 `
      + `${fmt(Math.max(...columns.map((c) => stats.mean(c))), 2)} 之间。`
      + `以${first[0]}为例，均值为 ${first[2]}，标准差 ${first[3]}，取值范围从 ${first[4]} 到 ${first[6]}。`;
    return { ok: true, kind, table, narrative, detail: { names } };
  }

  if (kind === 'corr') {
    const names = (requested.length ? requested : numeric).slice(0, 8);
    if (names.length < 2) throw new Error('相关分析至少要选两个数值列');
    const result = stats.correlationMatrix(dataset, names);
    if (!result) throw new Error('选中的列里有非数值数据');
    const rows = names.map((name, i) => [
      name,
      ...names.map((_, j) => (i === j ? '1' : (() => {
        const cell = result.matrix[i][j];
        if (!cell) return '—';
        return `${fmt(cell.r, 3)}${stats.stars(cell.p)}`;
      })())),
    ]);
    const table = {
      title: '主要变量的相关系数',
      note: '*** p<0.001，** p<0.01，* p<0.05；矩阵对称，对角线为 1。',
      columns: ['变量', ...names],
      rows,
      align: ['left', ...names.map(() => 'right')],
    };
    const strong = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const cell = result.matrix[i][j];
        if (cell && Number.isFinite(cell.p) && cell.p < 0.05) {
          strong.push(`${names[i]}与${names[j]}（r=${fmt(cell.r, 3)}）`);
        }
      }
    }
    const narrative = `表 N 报告了主要变量之间的 Pearson 相关系数。`
      + (strong.length
        ? `其中 ${strong.slice(0, 3).join('、')} 的相关性在 5% 水平上显著，需要在回归中进一步控制其他因素。`
        : '各变量之间的相关系数均未通过 5% 水平的显著性检验。')
      + `样本量 ${result.n}。`;
    return { ok: true, kind, table, narrative, detail: { names } };
  }

  if (kind === 'ols') {
    const y = String(spec.y || '');
    const xs = (Array.isArray(spec.x) ? spec.x : []).filter((name) => dataset.columns.includes(name) && name !== y);
    if (!y || !dataset.columns.includes(y)) throw new Error('请选择因变量');
    if (!xs.length) throw new Error('请至少选择一个自变量');
    const columns = stats.numericColumns(dataset, [y, ...xs]);
    if (!columns) throw new Error('因变量或自变量里有非数值数据（分类变量请先转成虚拟变量）');
    const result = stats.ols(columns[0], columns.slice(1), { names: xs, robust: !!spec.robust });
    if (result.error) throw new Error(result.error);
    const rows = result.terms.map((term) => [
      term.name,
      fmt(term.estimate),
      fmt(term.se),
      fmt(term.t, 2),
      stats.formatP(term.p),
      stats.stars(term.p),
    ]);
    const table = {
      title: `以${y}为因变量的回归结果`,
      note: `被解释变量：${y}；${result.robust ? 'HC1 稳健标准误' : '普通标准误'}；`
        + `*** p<0.001，** p<0.01，* p<0.05；N=${result.n}，R²=${fmt(result.r2)}，调整 R²=${fmt(result.adjR2)}`
        + (result.f != null ? `，F=${fmt(result.f, 2)}（${pText(result.fP)}）` : '') + '。',
      columns: ['变量', '系数', '标准误', 't 值', 'p 值', '显著性'],
      rows,
    };
    // 结果段：每个自变量的系数与显著性都说清楚，模型只负责衔接，不能改数
    const parts = result.terms.filter((term) => term.name !== '常数项').map((term) => {
      const level = term.p < 0.001 ? '0.1%' : term.p < 0.01 ? '1%' : term.p < 0.05 ? '5%' : '';
      return level
        ? `${term.name}的系数为 ${fmt(term.estimate)}（标准误 ${fmt(term.se)}），在 ${level} 水平上显著`
        : `${term.name}的系数为 ${fmt(term.estimate)}（标准误 ${fmt(term.se)}，${pText(term.p)}），未通过显著性检验`;
    });
    const narrative = `表 N 报告了以${y}为因变量的 OLS 回归结果（N=${result.n}）。`
      + `${parts.join('；')}。模型 R² 为 ${fmt(result.r2)}，调整 R² 为 ${fmt(result.adjR2)}`
      + (result.f != null ? `，F 统计量 ${fmt(result.f, 2)}（${pText(result.fP)}）` : '')
      + '。';
    return { ok: true, kind, table, narrative, detail: { y, x: xs, robust: !!spec.robust } };
  }

  if (kind === 'ttest') {
    const value = String(spec.value || '');
    const group = String(spec.group || '');
    if (!value || !group) throw new Error('请选择数值列和分组列');
    const result = stats.groupCompare(dataset, value, group);
    if (!result) throw new Error('分组或数值列不存在');
    if (result.groups.length < 2) throw new Error(`分组列「${group}」只有一组取值，无法比较`);
    const rows = result.groups.map((item) => [
      item.name, String(item.n), fmt(item.mean), fmt(item.sd), fmt(item.min), fmt(item.max),
    ]);
    if (result.test) {
      rows.push(['差值（第一组 − 第二组）', '', fmt(result.test.diff), fmt(result.test.se), '', '']);
      rows.push(['t 检验', '', `t=${fmt(result.test.t, 2)}`, `df=${fmt(result.test.df, 1)}`, pText(result.test.p), stats.stars(result.test.p)]);
    }
    const table = {
      title: `${group}分组的${value}比较`,
      note: `Welch t 检验（不假设方差齐性）；*** p<0.001，** p<0.01，* p<0.05。`,
      columns: ['组别', 'N', '均值', '标准差', '最小值', '最大值'],
      rows,
    };
    // 三组及以上不能只报前两组：那会让读者以为只比了两组
    const overview = result.groups.map((item) => `${item.name}组均值 ${fmt(item.mean)}（N=${item.n}）`).join('，');
    const narrative = `表 N 按${group}分组比较了${value}，共 ${result.groups.length} 组：${overview}。`
      + (result.test
        ? `两组差值为 ${fmt(result.test.diff)}，Welch t 检验的 ${pText(result.test.p)}`
          + `${result.test.p < 0.05 ? '，差异在 5% 水平上显著' : '，差异未通过显著性检验'}。`
        : `分组多于两组，未做两两检验；若需要组间差异，应改用方差分析（ANOVA）并做事后多重比较。`);
    return { ok: true, kind, table, narrative, detail: { value, group } };
  }

  throw new Error(`不支持的分析类型：${kind}`);
}

// 把分析结果写进某一节：正文末尾追加「结果段 + 【表N：标题】占位」，表格数据落库。
// 结果段里的数字是算出来的，作者可以改文字，但不该改数字——改了就与表对不上。
function insertAnalysis({ projectId, idx, kind = 'describe', spec = {}, narrative = '', title = '' } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const section = project.sections[Number(idx) - 1];
  if (!section) throw new Error('小节不存在');
  const analysis = runAnalysis({ projectId, datasetId: spec.datasetId, kind, spec });
  // 表号取全文序号（本节之前的表数 + 本节已有的表数 + 1），
  // 结果段里的「表 N」直接替换成这个号——正文写「如表 3 所示」时不会对不上。
  const before = project.sections
    .filter((item) => item.idx < Number(idx))
    .reduce((total, item) => total + (item.tables || []).length, 0);
  const globalNo = before + (section.tables || []).length + 1;
  const tableSpec = {
    ...analysis.table,
    title: String(title || analysis.table.title).slice(0, 60),
    no: globalNo,
  };
  const body = String(narrative || analysis.narrative).trim().replace(/表 N/g, `表 ${globalNo}`);
  const block = `${body}\n\n【表${tableSpec.no}：${tableSpec.title}】`;
  const content = [String(section.content || '').trim(), block].filter(Boolean).join('\n\n');
  saveSectionContent(projectId, Number(idx), content, 'manual');
  run(`UPDATE doc_sections SET tables_json=? WHERE project_id=? AND idx=?`,
    JSON.stringify([...(section.tables || []), tableSpec]), String(projectId), Number(idx));
  return {
    ok: true,
    idx: Number(idx),
    table: tableSpec,
    narrative: body,
    chars: content.length,
  };
}

// ---------- 文献接入：BibTeX / RIS / CSL-JSON 导入 ----------

// 从 Zotero / EndNote / 知网导出的文献文件里批量建素材。
// 这是「文献综述有真实地基」的唯一可靠路径：模型不可能凭记忆给出真文献，那只会编。
function importBibliography({ projectId, text = '', filename = '' } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const parsed = bib.parseBibliography(text, { filename });
  if (!parsed.entries.length) {
    throw new Error('没有解析出文献条目：支持 BibTeX（.bib）、RIS（.ris）、CSL-JSON（.json，Zotero 导出）');
  }
  const added = [];
  for (const entry of parsed.entries.slice(0, 300)) {
    // 摘要是「可读的原文」；太短（或没有）时把题名与出处补进去当上下文，
    // 不要因为摘要短就拒绝导入——作者导入的是文献库，不是摘要库。
    const base = String(entry.content || '').trim();
    const content = base.length >= 20
      ? base
      : `${base}${base ? '\n' : ''}（题名：${entry.title}；${entry.authors || '作者待补'}，${entry.year || '年份待补'}${entry.source ? `，${entry.source}` : ''}）`;
    const result = addMaterial({
      projectId, title: entry.title, content, kind: entry.kind,
      authors: entry.authors, year: entry.year, source: entry.source, doi: entry.doi,
    });
    added.push({ key: result.key, title: entry.title });
  }
  return {
    ok: true,
    format: parsed.format,
    imported: added.length,
    skipped: parsed.skipped,
    total: parsed.total,
    items: added,
  };
}

// 文献矩阵：把每条文献的「方法 / 样本 / 结论 / 局限」抽成一行。
// 模型只做抽取，不做发挥：摘要里没有的写「未提及」，不许推测。
async function buildLiteratureMatrix({ projectId, onUsage = null } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const materials = listMaterials(projectId).filter((item) => item.kind === 'literature' || item.kind === 'data');
  if (!materials.length) throw new Error('还没有文献素材：先导入 .bib / .ris / .json，或手动添加文献');
  const lines = materials.map((item) => {
    const head = `${item.key}｜${item.authors || '未署名'}｜${item.year || '年份待补'}｜${item.title}`;
    const meta = item.source ? `出处：${item.source}` : '';
    const abstract = String(item.text || '').replace(/\s+/g, ' ').slice(0, 700);
    return [head, meta, `摘要：${abstract}`].filter(Boolean).join('\n');
  }).join('\n\n');
  const sys = [
    '你是文献分析助手。任务是从每条文献的题名与摘要里抽出结构化信息，供作者写文献综述。',
    '硬约束：只能依据给出的题名、出处与摘要。摘要没提到的内容一律写「未提及」，绝不推测、绝不补充常识。',
    '只输出 JSON。',
  ].join('\n');
  const user = [
    `【论文主题】${project.title}`,
    `【文献条目】\n${lines}`,
    '请为每条文献抽取四个字段，输出格式：',
    '{"items":[{"key":"M1","method":"研究方法（如：问卷调查 / 双重差分 / 案例研究）",'
      + '"sample":"样本（如：312 家制造业企业，2015—2020 年）","finding":"主要结论（一句话，尽量带数字）",'
      + '"limit":"作者自述的局限；没写就填「未提及」",'
      + '"critique":"你对它方法上的判断：识别策略够不够、样本能不能支撑结论、有没有明显的遗漏变量。'
      + '只依据给出的材料，不要凭印象评价；材料不足以判断就填「无法判断」"}]}',
    '要求：每条不超过 40 字；key 必须与上面的编号一一对应；不要新增条目。',
    'critique 是「你的判断」而不是「作者的表述」——这是综述能写出评述而不是摘要堆砌的关键。'
      + '但同样受限于材料：如果只给了摘要，很多方法细节看不出来，就老实写「摘要未交代识别策略」，不要编。',
  ].join('\n\n');
  const raw = await generateOnce({ sys, user, onUsage });
  const parsed = craft.extractJson(raw);
  const byKey = new Map(materials.map((item) => [item.key, item]));
  const items = (parsed && Array.isArray(parsed.items) ? parsed.items : [])
    .map((item) => {
      const source = byKey.get(String(item && item.key || '').toUpperCase());
      if (!source) return null;
      const text = (value) => String(value == null ? '' : value).trim().slice(0, 60) || '未提及';
      // 依据标注：素材正文短于 400 字基本只可能是摘要。综述里必须让作者知道
      // 「这条结论是从摘要来的」——摘要看不出识别策略的缺陷，这一点不能含糊。
      const basis = String(source.text || '').length >= 400 ? '全文' : '摘要';
      return {
        key: source.key,
        authors: source.authors || '未署名',
        year: source.year || '',
        title: source.title,
        method: text(item.method),
        sample: text(item.sample),
        finding: text(item.finding),
        limit: text(item.limit),
        critique: text(item.critique),
        basis,
      };
    })
    .filter(Boolean);
  if (!items.length) throw new Error('模型没有返回可用的文献矩阵，请重试');
  const result = { items, at: Date.now() };
  run(`UPDATE doc_projects SET lit_json=?, updated_at=? WHERE id=?`,
    JSON.stringify(result), Date.now(), String(projectId));
  return result;
}

function getLiteratureMatrix(projectId) {
  const row = one(`SELECT lit_json FROM doc_projects WHERE id=?`, String(projectId || ''));
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.lit_json || '{}');
    return parsed && Array.isArray(parsed.items) && parsed.items.length ? parsed : null;
  } catch { return null; }
}

// 把文献矩阵插进某一节：三线表 + 表号占位。
function insertLiteratureMatrix({ projectId, idx, title = '文献梳理' } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const matrix = getLiteratureMatrix(projectId);
  if (!matrix) throw new Error('还没有文献矩阵，先生成一次');
  const section = project.sections[Number(idx) - 1];
  if (!section) throw new Error('小节不存在');
  const before = project.sections
    .filter((item) => item.idx < Number(idx))
    .reduce((total, item) => total + (item.tables || []).length, 0);
  const no = before + (section.tables || []).length + 1;
  const tableSpec = {
    no,
    title: String(title).slice(0, 60),
    note: '注：「（摘要）」表示该条只有摘要可用——摘要看不出识别策略的细节，'
      + '所以「方法判断」这一列的可信度相应更低，写综述时要留意。'
      + '「未提及」表示原文没有交代，不代表没有做。',
    columns: ['文献', '方法', '样本', '主要结论', '局限', '方法判断'],
    widths: [0.18, 0.12, 0.14, 0.24, 0.14, 0.18],
    rows: matrix.items.map((item) => [
      // 标注依据：只有摘要的文献，其「方法判断」的可信度天然更低，读者必须知道
      `${item.authors.split(',')[0]}${item.year ? `（${item.year}）` : ''} [${item.key}]`
        + (item.basis === '摘要' ? '（摘要）' : ''),
      item.method, item.sample, item.finding, item.limit, item.critique || '无法判断',
    ]),
    align: ['left', 'left', 'left', 'left', 'left', 'left'],
  };
  const block = `文献的基本情况见表 ${no}。\n\n【表${no}：${tableSpec.title}】`;
  const content = [String(section.content || '').trim(), block].filter(Boolean).join('\n\n');
  saveSectionContent(projectId, Number(idx), content, 'manual');
  run(`UPDATE doc_sections SET tables_json=? WHERE project_id=? AND idx=?`,
    JSON.stringify([...(section.tables || []), tableSpec]), String(projectId), Number(idx));
  return { ok: true, idx: Number(idx), table: tableSpec, count: matrix.items.length };
}

// 文献综述初稿：只依据矩阵归纳，不引新文献。
// 「共同缺口」这一段是综述的价值所在——把 N 篇文献的局限对齐，才能说清本文补了什么。
async function draftLiteratureReview({ projectId, idx = 0, onUsage = null } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const matrix = getLiteratureMatrix(projectId);
  if (!matrix) throw new Error('还没有文献矩阵，先生成一次');
  const lines = matrix.items.map((item) =>
    `${item.key}｜${item.authors}${item.year ? `（${item.year}）` : ''}｜方法：${item.method}｜样本：${item.sample}`
    + `｜结论：${item.finding}｜局限：${item.limit}`).join('\n');
  const sys = [
    '你是论文作者，正在写文献综述。只依据给出的文献矩阵归纳，不要引入任何矩阵外的文献、数据或观点。',
    '综述要写成「有判断的评述」，不是「一篇一段的摘要堆砌」：先按方法或样本分组，再指出共同缺口。',
    '直接输出正文，不要标题、不要代码围栏、不要「以下是」。',
  ].join('\n');
  const user = [
    `【论文题目】${project.title}`,
    project.thesis ? `【本文的核心主张】${project.thesis}` : '',
    `【文献矩阵】\n${lines}`,
    '请写 2~3 段文献综述（合计 500~800 字）：',
    '1. 第一段按研究方法或样本特征分组，概括这批文献大致做了什么、结论是否一致；',
    '2. 第二段指出共同缺口（方法上的、样本上的、或结论互相矛盾之处）；',
    '3. 第三段落到本文的位置：这个缺口本文怎么补，不要夸大。',
    '硬约束：引用只能写成 [M1] 这种编号，编号必须是矩阵里出现过的；不得编造文献、数字或作者观点；',
    '矩阵里写「未提及」的字段，正文里不要替它补内容。',
  ].filter(Boolean).join('\n\n');
  const text = String(await generateOnce({ sys, user, onUsage })).trim();
  if (text.length < 200) throw new Error('生成的综述过短，请重试');
  if (Number(idx) > 0) {
    const section = project.sections[Number(idx) - 1];
    if (section) {
      const content = [String(section.content || '').trim(), text].filter(Boolean).join('\n\n');
      saveSectionContent(projectId, Number(idx), content, 'ai-draft');
    }
  }
  return { ok: true, text, chars: text.length, idx: Number(idx) };
}

// ---------- 方法论审查 ----------

async function reviewMethodology(projectId, { onUsage = null } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const scan = method.scanMethodology(project);
  const review = await method.reviewMethodology({ generate: generateOnce, project, scan, onUsage });
  const result = { scan, review, at: Date.now() };
  run(`UPDATE doc_projects SET method_json=?, updated_at=? WHERE id=?`,
    JSON.stringify(result), Date.now(), String(projectId));
  return result;
}

function getMethodologyReview(projectId) {
  const row = one(`SELECT method_json FROM doc_projects WHERE id=?`, String(projectId || ''));
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.method_json || '{}');
    return parsed && parsed.scan ? parsed : null;
  } catch { return null; }
}

// ---------- 自动分析预设 ----------
//
// 「结果与分析」这一节的价值取决于有没有真跑过统计。手动点一次分析只能解决单次，
// 全托管批量起草时不会自己去点——所以把「哪一节、哪份数据、谁是因变量」提前存成预设，
// 起草到那一节时系统自己跑、自己注入系数、自己把三线表插进去。

function setAnalysisPreset(projectId, preset = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  if (!preset || !preset.datasetId) {
    run(`UPDATE doc_projects SET analysis_json='{}', updated_at=? WHERE id=?`, Date.now(), String(projectId));
    return { ok: true, preset: null };
  }
  const dataset = one(`SELECT id FROM doc_datasets WHERE id=? AND project_id=?`,
    String(preset.datasetId), String(projectId));
  if (!dataset) throw new Error('数据集不存在');
  const next = {
    datasetId: String(preset.datasetId),
    kind: ['describe', 'corr', 'ols', 'ttest'].includes(preset.kind) ? preset.kind : 'ols',
    y: String(preset.y || '').slice(0, 60),
    x: Array.isArray(preset.x) ? preset.x.map((item) => String(item).slice(0, 60)).slice(0, 8) : [],
    group: String(preset.group || '').slice(0, 60),
    robust: !!preset.robust,
    sectionIdx: Math.max(0, Number(preset.sectionIdx) || 0),
  };
  run(`UPDATE doc_projects SET analysis_json=?, updated_at=? WHERE id=?`,
    JSON.stringify(next), Date.now(), String(projectId));
  return { ok: true, preset: next };
}

function getAnalysisPreset(projectId) {
  const row = one(`SELECT analysis_json FROM doc_projects WHERE id=?`, String(projectId || ''));
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.analysis_json || '{}');
    return parsed && parsed.datasetId ? parsed : null;
  } catch { return null; }
}

function presetSpec(preset) {
  return {
    datasetId: preset.datasetId,
    y: preset.y,
    x: preset.x,
    group: preset.group,
    value: preset.kind === 'ttest' ? preset.y : undefined,
    columns: preset.kind === 'describe' || preset.kind === 'corr'
      ? (preset.x.length ? preset.x : (preset.y ? [preset.y] : []))
      : undefined,
    robust: preset.robust,
  };
}

// 把分析结果压成提示词里的一段文字。数字是算出来的，模型只负责组织语言。
function analysisContext(project, section) {
  const preset = getAnalysisPreset(project.id);
  if (!preset || Number(preset.sectionIdx) !== Number(section.idx)) return '';
  let analysis = null;
  try {
    analysis = runAnalysis({ projectId: project.id, datasetId: preset.datasetId, kind: preset.kind, spec: presetSpec(preset) });
  } catch { return ''; }
  // 真实表号：本节之前的表数 + 本节已有的表数 + 1。
  // 早先这里写的是「如表 N 所示」，模型会原样照抄「如表 N 所示」——正文里出现 N 就是坏稿。
  const beforeTables = project.sections
    .filter((item) => item.idx < Number(section.idx))
    .reduce((total, item) => total + (item.tables || []).length, 0);
  const tableNo = beforeTables + (section.tables || []).length + 1;
  const table = analysis.table;
  const head = `| ${table.columns.join(' | ')} |`;
  const divider = `| ${table.columns.map(() => '---').join(' | ')} |`;
  const rows = table.rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return [
    '【本节统计结果（由系统按你提供的数据算出，数字一个都不能改）】',
    [head, divider, rows].join('\n'),
    table.note ? `注：${table.note}` : '',
    `【已算好的结果段（可改写文字，不可改数字）】\n${analysis.narrative}`,
    '要求：正文必须引用上表中的具体系数、标准误与显著性水平；不要自己重算，也不要引入表外数字。'
      + `表格本体由系统插入，表号是「表 ${tableNo}」，正文里写「如表 ${tableNo} 所示」引出即可，`
      + '不要自己画表格，也不要把表号写成 N 或「表 X」。',
  ].filter(Boolean).join('\n\n');
}

// 文献综述类小节：把文献矩阵注入提示词，综述才有「按方法分组、指出共同缺口」的骨架。
function literatureContext(project, section) {
  if (!/文献|综述|研究现状|理论基础|文献回顾/.test(String(section.title || ''))) return '';
  const matrix = getLiteratureMatrix(project.id);
  if (!matrix) return '';
  const lines = matrix.items.map((item) =>
    `${item.key}｜${item.authors}${item.year ? `（${item.year}）` : ''}｜方法：${item.method}｜样本：${item.sample}`
    + `｜结论：${item.finding}｜局限：${item.limit}`).join('\n');
  return `【文献矩阵（从你导入的文献里抽取，只能引用这些编号）】\n${lines}\n\n`
    + '写这一节时：先按研究方法或样本特征分组归纳，再指出共同缺口，最后落到本文的位置。'
    + '引用只能写 [M1] 这种编号，且必须是上表里出现过的；'
    + '矩阵里写「未提及」的字段，不要替它补内容——那等于替原作者编造。';
}

// 只插表、不插结果段：起草时模型已经写过一段（引用的是同一批系数），
// 再追加模板结果段会重复。手动「跑分析」才需要结果段当起点。
function appendAnalysisTable({ projectId, idx, kind = 'ols', spec = {}, title = '' } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const section = project.sections[Number(idx) - 1];
  if (!section) return null;
  const analysis = runAnalysis({ projectId, datasetId: spec.datasetId, kind, spec });
  const before = project.sections
    .filter((item) => item.idx < Number(idx))
    .reduce((total, item) => total + (item.tables || []).length, 0);
  const no = before + (section.tables || []).length + 1;
  const tableSpec = {
    ...analysis.table,
    title: String(title || analysis.table.title).slice(0, 60),
    no,
  };
  const placeholder = `【表${no}：${tableSpec.title}】`;
  const content = String(section.content || '').trim();
  if (content.includes(placeholder)) return tableSpec;
  saveSectionContent(projectId, Number(idx), [content, placeholder].filter(Boolean).join('\n\n'),
    section.source || 'manual');
  run(`UPDATE doc_sections SET tables_json=? WHERE project_id=? AND idx=?`,
    JSON.stringify([...(section.tables || []), tableSpec]), String(projectId), Number(idx));
  return tableSpec;
}

// 起草完成后：如果本节是分析预设指定的那一节，把三线表补进去。
// 模型只负责正文，表格本体由系统插入——这样表里的数字一定和算出来的一致。
function attachPresetTable(projectId, idx) {
  const preset = getAnalysisPreset(projectId);
  if (!preset || Number(preset.sectionIdx) !== Number(idx)) return null;
  try {
    return appendAnalysisTable({
      projectId, idx, kind: preset.kind, spec: presetSpec(preset),
    });
  } catch { return null; }
}

// 选题体检：把「这个选题值不值得做」拆成几条可判断的条件。
// 完全机械化做不到（那是编辑的判断），但可证伪性、文献重叠、数据可得性、
// 贡献有没有说出口——这几条判完，至少一半答案是明确的。
function checkTopicNow(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const result = method.checkTopic(project, {
    matrix: getLiteratureMatrix(projectId),
    datasets: listDatasets(projectId),
  });
  run(`UPDATE doc_projects SET topic_json=?, updated_at=? WHERE id=?`,
    JSON.stringify(result), Date.now(), String(projectId));
  return result;
}

function getTopicCheck(projectId) {
  const row = one(`SELECT topic_json FROM doc_projects WHERE id=?`, String(projectId || ''));
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.topic_json || '{}');
    return parsed && Array.isArray(parsed.findings) ? parsed : null;
  } catch { return null; }
}

// ---------- 文体专项：BP 财务 / 申报书指标 / 合同条款 / 调研样本 ----------
//
// 四类文档的「高质量」标准完全不同，所以约束必须按类型给，不能一套提示词通吃。
// 共同的判断：质量不在写得漂亮，而在「该有的结构有没有」。

const TYPE_RULES = {
  // 论文之前没有专属硬约束，只靠通用的「别编数据、别编文献」兜着。
  // 但论文真正被打回的原因不是编造，是「结论超出证据」「方法与数据不可复现」「只综述不对话」。
  paper: [
    '【论文硬约束】',
    '1. 研究问题必须可证伪：能写清「出现什么结果就说明假设不成立」；写不出否证条件的命题不是研究问题。',
    '2. 每个结论都要挂证据：数据、文献或可复核的推导，三者至少一条；「研究表明」必须能指到具体来源，指不到就写【待补文献】。',
    '3. 方法与数据要交代到可复现：样本量与来源、变量定义与测量方式、模型设定、稳健性检验；缺一项，结果就无法被复核。',
    '4. 必须与已有研究对话：说明本文与哪条结论一致、与哪条冲突、冲突的原因是什么；只综述不对话等于没有贡献。',
    '5. 结论不许超出证据边界：样本外推、因果表述都要写清前提（「在本样本范围内」「在给定识别假设下」）；'
      + '「首次」「填补空白」这类判断必须有检索依据，否则删掉。',
  ].join('\n'),
  bp: [
    '【BP 硬约束】',
    '1. 财务预测必须给假设：客单价、客户数、增长率、成本率、税率，逐项写清依据；只给结果不给假设，投资人会直接判定不可信。',
    '2. 市场规模必须给推算：自下而上（目标客户数 × 客单价 × 渗透率）或自上而下（引用权威口径并注明来源），禁止只写「市场空间巨大」。',
    '3. 竞争壁垒必须具体：技术、数据、渠道、网络效应、切换成本，至少指出一条并说明为什么难以复制。',
    '4. 单位经济要能自洽：LTV、CAC、回本周期，缺数据就写【待补】，不要用「快速回本」这类表述糊过去。',
    '5. 禁用「颠覆」「万亿」「必然」「翻倍」这类形容词，用数字替代。',
  ].join('\n'),
  proposal: [
    '【申报书硬约束】',
    '1. 目标必须可考核：每条目标要有基线值、目标值与验收方式；「显著提升」「明显改善」评审会判为不可考核。',
    '2. 建设内容与目标一一对应：一条目标至少对应一条内容，编号能对上。',
    '3. 预算要有科目、金额与测算依据三要素；只给总额或只给科目不给依据都会被要求补材料。',
    '4. 立项背景要落到具体政策文件（含文号），把文件导入素材后用编号引用。',
  ].join('\n'),
  contract: [
    '【合同硬约束】',
    '1. 条款编号连续（第X条），定义条款一旦给出，全文术语必须与之一致。',
    '2. 禁止单方权利表述：「甲方有权单方面变更」「无需征得乙方同意」这类条款在争议中常被认定为不公平格式条款。',
    '3. 禁止模糊表述：合理、适当、尽快、原则上、必要时——每个模糊词都是争议点，改成可执行的标准（几日内、达到什么指标、由谁认定）。',
    '4. 违约责任与争议解决不能缺；违约责任要给具体比例，争议解决要指定法院或仲裁机构名称。',
    '5. 当事人、金额、日期、账户等字段未给出时一律写【待补】，绝不虚构。',
  ].join('\n'),
  report: [
    '【调研报告硬约束】',
    '1. 必须交代样本：样本量、抽样方式、覆盖范围、回收率；没有这些，结论无法被判断可信度。',
    '2. 必须交代方法：问卷、访谈还是实地观察，不同方法得到的数据性质不同。',
    '3. 必须声明局限：样本偏差、单一地区、回收率偏低，主动写出来反而增加可信度。',
    '4. 对策建议要与问题一一对应，注明责任层级与优先级。',
  ].join('\n'),
  feasibility: [
    '【可研硬约束】',
    '1. 必要性要写「不做会怎样」：缺口有多大、后果是什么；只写「意义重大」在评审环节会被打回。',
    '2. 规模必须由需求推导：需求 → 服务对象数量 → 单位用量 → 建设规模，中间每一步的假设都要写明；直接给规模等于没论证。',
    '3. 财务评价必须给计算假设：折现率、计算期、价格、产能利用率；IRR/NPV/回收期要能由假设复算出来。',
    '4. 必须做敏感性分析：至少对价格、成本、销量三个变量各做 ±10% 的变动，说明结论是否翻转。',
    '5. 投资估算要分科目并给单位造价依据；只给总额的可研不具备评审条件。',
  ].join('\n'),
  bid: [
    '【投标硬约束】',
    '1. 逐条响应：招标文件的每一条技术要求都要有对应的响应条目与结论（完全响应/优于/偏离），不得漏项或合并。',
    '2. 承诺必须可核验：写清「谁做、什么时候做、达到什么标准、怎么验证」；「优质高效」「全力保障」这类承诺不计分。',
    '3. 业绩要可查：项目名称、合同金额、签订时间、甲方名称，缺一项就难以作为有效业绩。',
    '4. 偏离必须显式声明：有偏离却不写，评标时按不响应处理，风险远大于如实说明。',
    '5. 报价构成要能对上：分项之和等于总价，且与工期、人员投入匹配；报价与方案脱节是最常见的废标原因。',
  ].join('\n'),
  summary: [
    '【总结/述职硬约束】',
    '1. 成效必须带数字：完成率、增长率、节约成本、交付数量；「认真完成」「效果良好」等于没写。',
    '2. 问题必须指向自己：写清哪项没做好、原因是什么、造成了什么影响；把问题全归给客观条件会被认为不担责。',
    '3. 计划必须可执行：每项措施写清时间、动作、可衡量的结果；「继续加强学习」不算措施。',
    '4. 不写自我表扬式排比（「兢兢业业、任劳任怨」），用事实替代形容词。',
  ].join('\n'),
  minutes: [
    '【纪要硬约束】',
    '1. 只记结论不记过程：不复述谁说了什么、不记录讨论细节与客套话。',
    '2. 决议必须可执行：每条决议是完整判断句（做什么、到什么程度、什么时候），禁止「原则同意」「酌情处理」这类空决议。',
    '3. 任务必须有责任人和时限：缺一项就等于没有安排；责任人写岗位或姓名，不写「相关部门」。',
    '4. 未定事项单列：本次没定下来的问题要写清卡在哪里、由谁在什么时候给出结论，不能隐去。',
  ].join('\n'),
  notice: [
    '【公文硬约束】',
    '1. 一文一事：一份通知只解决一件事，不夹带其他事项。',
    '2. 标题三要素齐全：发文机关 + 事由 + 文种（通知/通报/公告/函），不得只写「通知」。',
    '3. 依据必须具体：引上级文件要写全称与文号；写「根据有关要求」视为无依据。',
    '4. 事项要能照做：时间、地点、范围、标准、材料、报送方式逐项写清，不留解释空间。',
    '5. 不用口语、比喻、感叹句；成文日期用汉字数字。',
  ].join('\n'),
  policy: [
    '【制度硬约束】',
    '1. 章条体例：章下分条，条文用「应当/不得/可以」，一条一义，不在同一条里塞两件事。',
    '2. 主体必须明确：每条都要能回答「谁来做」；「有关部门」「相关单位」不是责任主体。',
    '3. 禁止模糊表述：及时、适当、原则上、必要时——改为具体时限或判定标准（几工作日内、达到什么条件）。',
    '4. 必须有责任追究章：违规情形与对应处理措施要分级对应，否则制度没有约束力。',
    '5. 附则要写清解释权、施行日期、旧制度废止范围。',
  ].join('\n'),
  prd: [
    '【PRD 硬约束】',
    '1. 每条需求必须可测：谁、在什么场景、做什么、系统怎么响应、怎么算通过；写不出验收条件的需求不算需求。',
    '2. 业务规则要给边界值：最大值/最小值、字符长度、并发上限、超时处理；只写「合理校验」等于没写。',
    '3. 异常流程不能省：失败、超时、并发冲突、权限不足、数据为空，每种都要给系统行为。',
    '4. 明确不做什么：本期排除项要写出来，否则开发会按自己的理解补需求。',
    '5. 禁止「优化体验」「提升效率」这类不可验收的表述，改为具体指标（点击次数、耗时、转化率）。',
  ].join('\n'),
  techdoc: [
    '【技术方案硬约束】',
    '1. 选型必须对比：至少两个候选方案，列出优缺点与适用条件，再给结论；直接给结论视为未论证。',
    '2. 接口要可实施：路径、方法、入参出参、错误码、幂等与超时约定齐全，开发照着能写。',
    '3. 数据设计要落到表结构：字段、类型、索引、分片键、一致性方案。',
    '4. 容量与性能要量化：预估 QPS、存储增长、延迟目标，并说明如何验证（压测方案）。',
    '5. 每个风险都要有兜底：数据迁移失败怎么办、依赖不可用怎么降级、性能不达标怎么回滚。',
  ].join('\n'),
  press: [
    '【新闻稿硬约束】',
    '1. 倒金字塔：最重要的信息在导语，越往后越次要；读者只读第一段也能知道发生了什么。',
    '2. 导语四要素齐全：谁、做了什么、什么时候、意味着什么。',
    '3. 用事实与引语说话：每个判断后面跟数据或原话；不写「意义重大」「里程碑式」这类评价词。',
    '4. 引语必须有信息量：署名+职务，说观点或态度，不能是「我们很高兴」。',
    '5. 标题不超过 25 字，不用问句、不用感叹号、不用「重磅」「炸裂」。',
  ].join('\n'),
  speech: [
    '【演讲稿硬约束】',
    '1. 为耳朵写：句子控制在 25 字内，一段一个意思，允许停顿；不用书面连接词（综上所述、基于上述分析）。',
    '2. 全篇一个核心观点：所有论据都指向它，不旁生枝节。',
    '3. 开场 30 秒内必须给出钩子（反常识事实、具体场景或问题），不用「大家好，我很荣幸」。',
    '4. 每个论据配一个具体细节或故事，抽象论述在台上会失去听众。',
    '5. 结尾给行动号召：做什么、什么时候开始，不要停在「谢谢大家」。',
  ].join('\n'),
};

function typeRules(docType) {
  return TYPE_RULES[String(docType || '')] || '';
}

// 把一组表格 spec 插进某一节（只插占位符，正文由作者或模型写）
function appendTables({ projectId, idx, tables = [], narrative = '' } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const section = project.sections[Number(idx) - 1];
  if (!section) throw new Error('小节不存在');
  if (!tables.length) throw new Error('没有可插入的表格');
  const before = project.sections
    .filter((item) => item.idx < Number(idx))
    .reduce((total, item) => total + (item.tables || []).length, 0);
  let counter = before + (section.tables || []).length;
  const specs = tables.map((table) => {
    counter += 1;
    return { ...table, no: counter };
  });
  const blocks = [];
  if (narrative) blocks.push(String(narrative).trim());
  for (const spec of specs) blocks.push(`【表${spec.no}：${spec.title}】`);
  const content = [String(section.content || '').trim(), blocks.join('\n\n')].filter(Boolean).join('\n\n');
  saveSectionContent(projectId, Number(idx), content, section.source || 'manual');
  run(`UPDATE doc_sections SET tables_json=? WHERE project_id=? AND idx=?`,
    JSON.stringify([...(section.tables || []), ...specs]), String(projectId), Number(idx));
  return { ok: true, idx: Number(idx), tables: specs };
}

// BP 财务模型：把假设存下来、算出三表、插进指定小节。
// 假设存库是有意的——投资人改一个增长率，作者要能一键重算，而不是重写整节。
function buildBusinessModel({ projectId, input = {} } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  if (project.docType !== 'bp') throw new Error('财务模型只用于商业计划书');
  const model = finance.buildModel(input);
  run(`UPDATE doc_projects SET finance_json=?, updated_at=? WHERE id=?`,
    JSON.stringify({ input: model.input, at: Date.now() }), Date.now(), String(projectId));
  return { ok: true, model, tables: finance.allTables(model), narrative: finance.narrative(model) };
}

function getFinanceInput(projectId) {
  const row = one(`SELECT finance_json FROM doc_projects WHERE id=?`, String(projectId || ''));
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.finance_json || '{}');
    return parsed && parsed.input ? parsed.input : null;
  } catch { return null; }
}

// 财务模型一键进正文：假设表 + 收入 + 利润表 + 现金流量表 + 单位经济
function insertBusinessModel({ projectId, idx, input = {} } = {}) {
  const built = buildBusinessModel({ projectId, input: Object.keys(input).length ? input : (getFinanceInput(projectId) || {}) });
  const result = appendTables({
    projectId, idx, tables: built.tables, narrative: built.narrative,
  });
  return { ...result, model: built.model };
}

// 申报书：考核指标表 / 经费预算表
function insertSchemeTables({ projectId, idx, indicators = [], budget = [] } = {}) {
  const tables = [];
  if (indicators.length) tables.push(typekit.indicatorTable(indicators));
  if (budget.length) tables.push(typekit.budgetTable(budget));
  if (!tables.length) throw new Error('没有可插入的表格：先填考核指标或预算科目');
  return appendTables({ projectId, idx, tables });
}

// 合同：必备条款对照表
function insertClauseTable({ projectId, idx, kind = '' } = {}) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  return appendTables({ projectId, idx, tables: [typekit.clauseTable(project, kind)] });
}

// 调研报告：样本构成表（从上传的数据集按列分组算占比）
function insertSampleTables({ projectId, idx, datasetId = '', columns = [] } = {}) {
  const dataset = loadDataset(projectId, datasetId);
  const tables = typekit.sampleTable(dataset, { columns });
  if (!tables || !tables.length) throw new Error('这份数据表没有可分组的列');
  return appendTables({ projectId, idx, tables });
}

// 文体专项检查：按类型分派，结果落库
function runTypeCheck(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error('文档项目不存在');
  const result = typekit.scanByType(project);
  if (!result) return null;
  run(`UPDATE doc_projects SET type_json=?, updated_at=? WHERE id=?`,
    JSON.stringify(result), Date.now(), String(projectId));
  return result;
}

function getTypeCheck(projectId) {
  const row = one(`SELECT type_json FROM doc_projects WHERE id=?`, String(projectId || ''));
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.type_json || '{}');
    return parsed && Array.isArray(parsed.findings) ? parsed : null;
  } catch { return null; }
}

module.exports = {
  DOC_TYPES, docTypeOf, TYPE_GROUPS, parseDocTemplate,
  DEPTH_LEVELS: craft.DEPTH_LEVELS, depthName: (key) => craft.depthOf(key).name,
  createProject, listProjects, getProject, deleteProject, saveSectionContent,
  assembleMarkdown, assembleDocx, buildMessages, draftSection, reviseSection,
  setProjectMode, continueNextSection, setProjectSkills, setProjectDepth, setProjectMeta, sectionChat, setProjectOutline,
  listDocTemplates, saveDocTemplate, deleteDocTemplate, templateMarkdown, distillDocTemplate,
  setProjectLayout, normalizeLayout: layout.normalizeLayout, layoutPrompt: layout.layoutPrompt,
  reapplyTemplateLayout, reapplyTemplateOutline, mergeTemplateSections,
  generateDocProject, resumeDocRun, cancelDocRun, sectionGate, sectionMinChars, activeDocRun,
  DEFAULT_RUN_TOKEN_BUDGET, auditProject,
  listMaterials, addMaterial, removeMaterial, selectMaterialSnippets, contextChain, summarizeSection,
  // 数据集与统计分析（数字由 lib/doc-stats 算出，模型不参与计算）
  addDataset, listDatasets, removeDataset, runAnalysis, insertAnalysis, appendAnalysisTable, diagnoseDataset,
  setAnalysisPreset, getAnalysisPreset, attachPresetTable,
  // 生成算法：定点修补 / 接缝裁剪 / 素材检索 / 单节起草与评审（供测试与外部调用）
  applyPatches, trimSeam, repairCitations, selectMaterialSnippets, writeSection, reviewAndFix,
  // 质量基准（客观检测论证层数、依据密度、论点兑现）
  evaluateSectionQuality, qualityBaseline: benchmark.baselineOf, qualityBenchmark: benchmark,
  // 文档上下文引擎（百万字语料的分层检索；页面与测试都要读它的统计）
  docContext,
  // 文体专项（BP 财务 / 申报书指标 / 合同条款 / 调研样本）
  TYPE_RULES, typeRules, appendTables, buildBusinessModel, insertBusinessModel, getFinanceInput,
  insertSchemeTables, insertClauseTable, insertSampleTables, runTypeCheck, getTypeCheck,
  // 文献接入与方法论审查
  checkTopicNow, getTopicCheck,
  importBibliography, buildLiteratureMatrix, getLiteratureMatrix, insertLiteratureMatrix,
  draftLiteratureReview, reviewMethodology, getMethodologyReview,
  MATERIAL_KINDS,
  // 写作技法（计划 / 评审 / 润色 / 提问 / 研究）与引用
  ensurePlan, regeneratePlan, reviewSectionNow, startPolish, polishStatus,
  suggestSectionQuestions, researchSection,
  bibliography, parseCitations, materialIndex,
};
