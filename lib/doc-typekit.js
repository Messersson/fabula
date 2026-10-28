'use strict';

// 三种文体的专项能力：申报书的指标与预算表、合同的条款体系与风险扫描、调研报告的样本构成。
//
// 共同的判断：这三类文档的质量不在「写得漂亮」，而在「该有的结构有没有」。
// 申报书缺一条可考核指标，评审就扣分；合同缺一条违约责任，出事就没依据；
// 调研报告不交代样本构成，读者无法判断结论能不能信。
// 所以这里做的都是「结构化表格 + 必备项检查」，而不是再写一段更好的文字。

// ---------- 通用：从正文里找条款 ----------

function fullText(project) {
  return (project.sections || []).map((section) => `${section.title}\n${section.content || ''}`).join('\n\n');
}

function sectionTitles(project) {
  return (project.sections || []).map((section) => String(section.title || ''));
}

function hit(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

// ======================================================================
// 一、项目申报书
// ======================================================================

// 考核指标表：申报书评审最看这一张表——指标能不能量化、目标值有没有基线、验收方式说不说得清
function indicatorTable(items = []) {
  const rows = items
    .filter((item) => item && (item.name || item.target))
    .slice(0, 30)
    .map((item, index) => [
      String(index + 1),
      String(item.name || '待补').slice(0, 40),
      String(item.baseline || '【待补】').slice(0, 30),
      String(item.target || '【待补】').slice(0, 30),
      String(item.method || '【待补】').slice(0, 40),
    ]);
  const vague = rows.filter((row) => !/\d/.test(row[3])).length;
  return {
    title: '考核指标表',
    note: '注：目标值必须可量化（含具体数字与单位）；基线值指立项前的现状水平；验收方式指用何种材料或测试证明达成。'
      + (vague ? `本表有 ${vague} 项目标值不含数字，评审时会按「不可考核」处理。` : ''),
    columns: ['序号', '考核指标', '基线值', '目标值', '验收方式'],
    widths: [0.08, 0.28, 0.16, 0.16, 0.32],
    rows,
    align: ['center', 'left', 'center', 'center', 'left'],
  };
}

// 经费预算表：科目、金额、占比、测算依据。占比与合计由代码算，不手填。
function budgetTable(items = []) {
  const list = items
    .filter((item) => item && item.item)
    .slice(0, 20)
    .map((item) => ({
      item: String(item.item).slice(0, 30),
      amount: Number(item.amount) || 0,
      basis: String(item.basis || '【待补：测算依据】').slice(0, 50),
    }));
  const total = list.reduce((sum, item) => sum + item.amount, 0);
  const rows = list.map((item) => [
    item.item,
    item.amount.toFixed(2),
    total > 0 ? `${((item.amount / total) * 100).toFixed(1)}%` : '—',
    item.basis,
  ]);
  rows.push(['合计', total.toFixed(2), '100.0%', '—']);
  return {
    title: '经费预算表',
    note: '注：金额单位为万元；占比按合计自动计算。每项都要写测算依据（人月数 × 单价、设备询价、外协合同额等），'
      + '只写「设备费 50 万」而不给依据，是预算评审最常见的扣分点。',
    columns: ['预算科目', '金额（万元）', '占比', '测算依据'],
    widths: [0.22, 0.16, 0.12, 0.5],
    rows,
    align: ['left', 'right', 'right', 'left'],
  };
}

// 申报书专项检查：目标—内容—指标三者是否闭环
function scanScheme(project) {
  const text = fullText(project);
  const findings = [];
  const push = (level, code, title, detail) => findings.push({ level, code, title, detail });

  if (!/考核指标|验收指标|指标值|量化目标/.test(text)) {
    push('warn', 'indicator', '没有可考核的指标',
      '申报书的核心是「承诺什么、怎么验收」。缺考核指标表，评审无法判断项目是否可交付。');
  } else if (!/\d+(\.\d+)?\s*(%|个|项|台|篇|万元|人|项|件)/.test(text)) {
    push('warn', 'indicator-quant', '考核指标没有量化',
      '出现「显著提升」「明显改善」这类表述时，评审会直接判为不可考核。改成「提升 X%」「完成 N 项」。');
  }
  if (!/预算|经费|科目|测算依据/.test(text)) {
    push('warn', 'budget', '没有经费预算说明',
      '预算要有科目、金额与测算依据三要素；只给总额不给结构，会被要求补充材料。');
  }
  if (!/进度|阶段|里程碑|时间节点|实施计划/.test(text)) {
    push('info', 'schedule', '没有进度安排', '分阶段的时间节点与交付物，是评审判断可行性的依据。');
  }
  if (!/政策|依据|文件|规划|指南|通知/.test(text)) {
    push('info', 'policy', '没有引用政策依据',
      '立项背景最好落到具体文件（含文号）。把政策文件作为素材导入，正文用编号引用即可自动生成依据。');
  }
  const titles = sectionTitles(project).join(' ');
  if (/目标/.test(titles) && !/内容/.test(titles)) {
    push('info', 'goal-content', '有目标但缺建设内容',
      '目标要拆成可执行的建设内容，一条目标对应一条内容，评审会逐条核对。');
  }
  return { findings, at: Date.now() };
}

// ======================================================================
// 二、法律合同
// ======================================================================

// 各类合同的必备条款。缺一条就是实质风险，不是文笔问题。
const CONTRACT_KINDS = {
  sale: {
    name: '买卖合同',
    clauses: [
      ['标的物', /标的|货物|产品|设备/, '写清名称、型号、规格、数量'],
      ['质量标准', /质量|标准|技术参数|验收标准/, '约定执行标准与不合格的处理'],
      ['交付与验收', /交付|交货|验收|签收/, '交付时间、地点、方式与验收期限'],
      ['价款与支付', /价款|价格|金额|支付|付款/, '金额、币种、发票、付款节点'],
      ['违约责任', /违约|赔偿|滞纳|罚则/, '逾期交付/逾期付款的违约金比例'],
      ['所有权与风险转移', /所有权|风险转移|毁损|灭失/, '何时转移，直接影响索赔'],
      ['争议解决', /争议|仲裁|诉讼|管辖/, '约定管辖法院或仲裁机构'],
    ],
  },
  service: {
    name: '服务合同',
    clauses: [
      ['服务内容与标准', /服务内容|服务范围|服务标准|服务水平/, '可量化的服务水平（SLA）'],
      ['服务期限', /期限|服务期|起止|有效期/, '起止日期与续约方式'],
      ['费用与结算', /费用|报酬|结算|付款/, '计费方式、结算周期'],
      ['验收与确认', /验收|确认|交付物/, '交付物形式与确认流程'],
      ['保密', /保密|商业秘密|不得披露/, '保密范围、期限、违约后果'],
      ['违约责任', /违约|赔偿|解除/, '单方解除的条件与赔偿'],
      ['争议解决', /争议|仲裁|诉讼|管辖/, '约定管辖'],
    ],
  },
  labor: {
    name: '劳动合同',
    clauses: [
      ['岗位与工作内容', /岗位|职位|工作内容|职责/, '岗位名称、职责范围、工作地点'],
      ['合同期限', /期限|试用期|固定期限|无固定期限/, '期限类型与试用期长度'],
      ['劳动报酬', /工资|报酬|薪酬|发放/, '数额、构成、发放日'],
      ['工作时间与休息', /工时|工作时间|休息|休假/, '工时制类型'],
      ['社会保险', /社会保险|社保|公积金/, '缴纳基数与比例'],
      ['保密与竞业', /保密|竞业|竞业限制/, '范围、期限与补偿'],
      ['解除与终止', /解除|终止|辞职|辞退/, '条件与程序、经济补偿'],
    ],
  },
  lease: {
    name: '租赁合同',
    clauses: [
      ['租赁物', /租赁物|房屋|场地|设备|标的/, '位置、面积、状态、附属设施'],
      ['租赁期限', /租期|期限|起租|到期/, '起止日期与续租'],
      ['租金与押金', /租金|押金|保证金|递增/, '金额、支付周期、递增方式'],
      ['使用与维修', /维修|修缮|使用|装修/, '维修责任划分'],
      ['转租与转让', /转租|转让|分租/, '是否允许及条件'],
      ['解除与违约', /解除|违约|提前终止/, '提前退租的违约金'],
      ['争议解决', /争议|仲裁|诉讼|管辖/, '约定管辖'],
    ],
  },
  cooperation: {
    name: '合作协议',
    clauses: [
      ['合作内容', /合作内容|合作事项|范围/, '做什么、不做什么'],
      ['出资与投入', /出资|投入|出资额|资源投入/, '各方出什么、折价多少'],
      ['分工与决策', /分工|职责|决策|表决/, '谁负责什么、僵局怎么破'],
      ['收益分配', /收益|分配|分成|利润/, '分配比例与时点'],
      ['知识产权', /知识产权|成果归属|专利|著作权/, '成果归谁、能否单独使用'],
      ['退出机制', /退出|回购|清算|散伙/, '怎么退出、怎么算账'],
      ['违约责任', /违约|赔偿/, '违约情形与责任'],
      ['争议解决', /争议|仲裁|诉讼|管辖/, '约定管辖'],
    ],
  },
};

function detectContractKind(project) {
  const text = `${project.title || ''} ${fullText(project)}`;
  if (/劳动|聘用|员工|试用期/.test(text)) return 'labor';
  if (/租赁|出租|承租|租金/.test(text)) return 'lease';
  if (/买卖|购销|供货|采购/.test(text)) return 'sale';
  if (/合作|联合|共同投资|合资/.test(text)) return 'cooperation';
  return 'service';
}

// 条款对照表：哪些必备条款写到了、哪些没有
function clauseTable(project, kind = '') {
  const key = CONTRACT_KINDS[kind] ? kind : detectContractKind(project);
  const meta = CONTRACT_KINDS[key];
  const text = fullText(project);
  const rows = meta.clauses.map(([name, pattern, hint]) => {
    const present = pattern.test(text);
    return [name, present ? '已具备' : '缺失', present ? '' : hint];
  });
  return {
    title: `${meta.name}必备条款对照`,
    note: '注：「缺失」表示全文未出现该条款的实质内容，不是指没写这四个字。'
      + '合同缺必备条款属于实质风险，不是文笔问题。',
    columns: ['必备条款', '状态', '缺失时的风险 / 应写清的内容'],
    widths: [0.22, 0.12, 0.66],
    rows,
    align: ['left', 'center', 'left'],
  };
}

// 合同风险扫描：缺失条款 + 单方权利 + 模糊表述 + 关键信息一致性
function scanContract(project, kind = '') {
  const text = fullText(project);
  const key = CONTRACT_KINDS[kind] ? kind : detectContractKind(project);
  const meta = CONTRACT_KINDS[key];
  const findings = [];
  const push = (level, code, title, detail) => findings.push({ level, code, title, detail });

  const missing = meta.clauses.filter(([, pattern]) => !pattern.test(text)).map(([name]) => name);
  if (missing.length) {
    push('warn', 'clause-missing', `缺少 ${missing.length} 项必备条款：${missing.join('、')}`,
      `${meta.name}缺这些条款，一旦发生争议将没有约定依据。逐条补上，或明确写「双方另行约定」。`);
  }

  // 单方权利：合同里出现「单方面」「无需征得同意」这类表述，必须能对等
  const oneSided = /单方面|单方决定|无需征得.{0,6}同意|有权随时|自行决定/.test(text);
  if (oneSided) {
    push('warn', 'one-sided', '存在单方权利表述',
      '「甲方有权单方面变更/解除」这类条款在争议中常被认定为不公平格式条款。'
      + '要么改成双方协商，要么给对方对应的救济（异议期、补偿）。');
  }

  // 模糊表述：合同里的「合理」「适当」「尽快」等于没有约定
  const vague = (text.match(/合理|适当|尽快|原则上|必要时|一定的/g) || []).length;
  if (vague >= 3) {
    push('warn', 'vague', `有 ${vague} 处模糊表述（合理/适当/尽快/原则上）`,
      '合同里每个模糊词都是争议点。改成可执行的标准：几日内、达到什么指标、由谁认定。');
  }

  // 违约责任与争议解决：缺失时已经在上面的 missing 里报过，这里只检查「写了但没写实」
  if (!missing.includes('违约责任') && !/违约金|赔偿比例|滞纳金|%|倍/.test(text)) {
    push('warn', 'liability-vague', '违约责任写了但没有具体比例',
      '只说「承担违约责任」等于没说。约定违约金比例（如日万分之五）与赔偿范围上限。');
  }
  if (!missing.includes('争议解决') && !/仲裁委员会|人民法院|管辖法院/.test(text)) {
    push('warn', 'dispute-vague', '争议解决写了但没指定机构',
      '「向有管辖权的法院起诉」是空话。写明具体法院或仲裁机构名称。');
  }
  if (!/不可抗力/.test(text)) {
    push('info', 'force-majeure', '没有不可抗力条款', '约定范围、通知义务与后果，避免意外事件被当成违约。');
  }
  if (!/解除|终止/.test(text)) {
    push('info', 'termination', '没有解除/终止条款', '什么情况下可以解除、解除后如何结算，要提前写清。');
  }
  // 金额与日期占位没填
  const placeholders = (text.match(/【待补[^】]*】/g) || []).length;
  if (placeholders) {
    push('info', 'placeholder', `还有 ${placeholders} 处【待补】`,
      '当事人名称、金额、日期、账户这些字段不能留空，签署前必须逐项落实。');
  }
  return { findings, kind: key, kindName: meta.name, at: Date.now() };
}

// ======================================================================
// 三、调研报告
// ======================================================================

// 样本构成表：调研报告的结论能不能信，先看样本是什么样
function sampleTable(dataset, { groupBy = '', columns = [] } = {}) {
  if (!dataset || !dataset.columns || !dataset.rows) return null;
  const targets = (columns.length ? columns : dataset.columns).filter((name) => dataset.columns.includes(name)).slice(0, 4);
  const tables = [];
  for (const name of targets) {
    const index = dataset.columns.indexOf(name);
    const counts = new Map();
    for (const row of dataset.rows) {
      const value = String(row[index] == null ? '' : row[index]).trim() || '（空）';
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    const total = dataset.rows.length;
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    let cumulative = 0;
    const rows = entries.map(([value, count]) => {
      cumulative += count;
      return [value, String(count), `${((count / total) * 100).toFixed(1)}%`, `${((cumulative / total) * 100).toFixed(1)}%`];
    });
    rows.push(['合计', String(total), '100.0%', '—']);
    tables.push({
      title: `样本构成：按${name}分布`,
      note: `注：样本量 ${total}；占比按样本数计算。构成明显偏斜时，需在「调研方法」一节说明抽样偏差及其对结论的影响。`,
      columns: [name, '样本数', '占比', '累计占比'],
      rows,
      align: ['left', 'right', 'right', 'right'],
    });
  }
  return tables;
}

function scanSurvey(project) {
  const text = fullText(project);
  const findings = [];
  const push = (level, code, title, detail) => findings.push({ level, code, title, detail });

  if (!/样本|问卷|访谈|调研对象|受访/.test(text)) {
    push('warn', 'sample', '没有交代样本',
      '调研报告的结论强度完全取决于样本。写清样本量、抽样方式、覆盖范围与回收率。');
  }
  if (!/方法|问卷设计|访谈提纲|抽样|数据采集/.test(text)) {
    push('warn', 'method', '没有交代调研方法',
      '问卷、访谈、实地观察得到的数据性质不同，读者需要知道你是怎么取的。');
  }
  if (!/局限|偏差|代表性|不能推广|样本有限/.test(text)) {
    push('warn', 'limit', '没有声明局限',
      '样本偏差、回收率偏低、单一地区——主动写出来，报告的可信度反而更高。');
  }
  if (!/建议/.test(text)) {
    push('info', 'advice', '没有对策建议', '调研报告的价值在于「所以该怎么办」。建议要与问题一一对应。');
  }
  if (!/数据来源|来源|口径|统计口径/.test(text)) {
    push('info', 'source', '没有说明数据来源与口径', '引用外部数据时要注明来源与统计口径，否则无法核对。');
  }
  return { findings, at: Date.now() };
}

// ======================================================================
// 统一入口
// ======================================================================

const SCANNERS = {
  bp: scanBusinessPlanSafe,
  proposal: scanScheme,
  contract: scanContract,
  report: scanSurvey,
  paper: null,
};

function scanBusinessPlanSafe(project) {
  // 避免循环依赖：BP 的扫描在 doc-finance 里
  return require('./doc-finance').scanBusinessPlan(project);
}

// 按文档类型跑对应的专项检查。论文走 doc-method，这里返回 null。
function scanByType(project) {
  const scanner = SCANNERS[String(project && project.docType)];
  if (!scanner) return null;
  try {
    return scanner(project);
  } catch {
    return null;
  }
}

module.exports = {
  CONTRACT_KINDS, detectContractKind,
  indicatorTable, budgetTable, scanScheme,
  clauseTable, scanContract,
  sampleTable, scanSurvey,
  scanByType, SCANNERS,
};
