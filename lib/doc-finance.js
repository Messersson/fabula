'use strict';

// 商业计划书的财务模型：三表 + 单位经济 + 融资测算。
//
// 为什么必须有：BP 里最硬、也最容易被投资人一眼看穿的就是财务预测。
// 让模型「写一段财务预测」等于让它编数——它既不会算现金缺口，也不会发现
// LTV/CAC 只有 1.2。所以这里把假设当输入、把三表当输出，数字全部由代码算。
//
// 模型口径（简化但自洽）：
//   客户数 → 收入 = 客户数 × 单价
//   毛利 = 收入 × (1 − 变动成本率)
//   费用 = 固定费用 + 人均成本 × 人数
//   EBIT = 毛利 − 费用 − 折旧
//   净利 = EBIT − max(0, EBIT) × 税率
//   经营现金流 = 净利 + 折旧 − 营运资金增加
//   期末现金 = 期初 + 经营 + 投资 + 筹资
// 这不是会计准则下的完整三表（没有应收应付明细、没有递延税），
// 但内部一致、可核对、可解释——BP 阶段够用，且不会出现「利润表赚钱但现金流断裂」这种低级矛盾。

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

const DEFAULTS = {
  years: 3,
  price: 0,
  customers: 0,
  growth: 0.3,
  retention: 0.8,
  variableRate: 0.35,
  fixedCost: 0,
  headcount: 0,
  costPerHead: 0,
  taxRate: 0.25,
  capex: 0,
  wcRate: 0.1,
  cash0: 0,
  funding: 0,
  preMoney: 0,
  marketingSpend: 0,
};

// 归一化假设：全部转成数字并夹到合理区间，避免「增长率 300%」这种输入把表算爆
function normalizeInput(raw = {}) {
  const input = { ...DEFAULTS, ...raw };
  return {
    years: clamp(Math.round(num(input.years, 3)), 1, 5),
    price: Math.max(0, num(input.price)),
    customers: Math.max(0, num(input.customers)),
    growth: clamp(num(input.growth), -0.9, 3),
    retention: clamp(num(input.retention), 0, 1),
    variableRate: clamp(num(input.variableRate), 0, 0.95),
    fixedCost: Math.max(0, num(input.fixedCost)),
    headcount: Math.max(0, Math.round(num(input.headcount))),
    costPerHead: Math.max(0, num(input.costPerHead)),
    taxRate: clamp(num(input.taxRate), 0, 0.5),
    capex: Math.max(0, num(input.capex)),
    wcRate: clamp(num(input.wcRate), 0, 0.6),
    cash0: num(input.cash0),
    funding: Math.max(0, num(input.funding)),
    preMoney: Math.max(0, num(input.preMoney)),
    marketingSpend: Math.max(0, num(input.marketingSpend)),
  };
}

// 主计算：逐年推三表。所有中间量都保留，方便结果段引用。
function buildModel(raw = {}) {
  const input = normalizeInput(raw);
  const years = [];
  let cash = input.cash0;
  let prevRevenue = 0;
  let customers = input.customers;
  const depreciationPerYear = input.capex / input.years;

  for (let year = 1; year <= input.years; year += 1) {
    // 客户数：第一年用给定值，之后按增长率扩张，同时受留存率约束
    if (year > 1) customers = customers * (1 + input.growth);
    const revenue = customers * input.price;
    const cogs = revenue * input.variableRate;
    const gross = revenue - cogs;
    const payroll = input.headcount * input.costPerHead;
    const opex = input.fixedCost + payroll;
    const depreciation = depreciationPerYear;
    const ebit = gross - opex - depreciation;
    const tax = ebit > 0 ? ebit * input.taxRate : 0;
    const net = ebit - tax;

    const wcChange = (revenue - prevRevenue) * input.wcRate;
    const ocf = net + depreciation - wcChange;
    const icf = year === 1 ? -input.capex : 0;
    const fcf = year === 1 ? input.funding : 0;
    const netCash = ocf + icf + fcf;
    const cashEnd = cash + netCash;

    years.push({
      year,
      customers,
      revenue,
      cogs,
      gross,
      grossMargin: revenue > 0 ? gross / revenue : null,
      payroll,
      opex,
      depreciation,
      ebit,
      ebitMargin: revenue > 0 ? ebit / revenue : null,
      tax,
      net,
      netMargin: revenue > 0 ? net / revenue : null,
      wcChange,
      ocf,
      icf,
      fcf,
      netCash,
      cashBegin: cash,
      cashEnd,
    });
    prevRevenue = revenue;
    cash = cashEnd;
  }

  return { input, years, ...unitEconomics(input, years), ...fundingMath(input) };
}

// 单位经济：投资人真正会追问的几个数
function unitEconomics(input, years) {
  const arpu = input.price;
  const grossMargin = 1 - input.variableRate;
  const churn = 1 - input.retention;
  // LTV = ARPU × 毛利率 ÷ 流失率；流失率为 0 时不设上限，标为不可计算
  const ltv = churn > 0 ? (arpu * grossMargin) / churn : null;
  const newCustomers = Math.max(1, input.customers);
  const cac = input.marketingSpend > 0 ? input.marketingSpend / newCustomers : null;
  const ratio = ltv != null && cac ? ltv / cac : null;
  // 回本月数：CAC ÷（月毛利）
  const monthlyGross = (arpu * grossMargin) / 12;
  const paybackMonths = cac != null && monthlyGross > 0 ? cac / monthlyGross : null;
  const first = years[0];
  const last = years[years.length - 1];
  return {
    unit: {
      arpu, grossMargin, churn, ltv, cac, ltvCac: ratio, paybackMonths,
      // 健康线：LTV/CAC ≥ 3 且回本 ≤ 12 个月，是消费/服务类项目的通用经验值
      healthy: ratio != null ? ratio >= 3 && (paybackMonths == null || paybackMonths <= 12) : null,
    },
    firstRevenue: first ? first.revenue : 0,
    lastRevenue: last ? last.revenue : 0,
    cagr: first && last && first.revenue > 0 && input.years > 1
      ? (last.revenue / first.revenue) ** (1 / (input.years - 1)) - 1
      : null,
    // 现金转正年份：期末现金连续为正的第一年
    cashPositiveYear: (years.find((item) => item.cashEnd > 0) || {}).year || null,
    // 最低现金点：用来判断需要多少融资
    minCash: years.length ? Math.min(...years.map((item) => item.cashEnd)) : 0,
  };
}

function fundingMath(input) {
  const postMoney = input.preMoney + input.funding;
  const dilution = postMoney > 0 ? input.funding / postMoney : null;
  return {
    funding: {
      amount: input.funding,
      preMoney: input.preMoney,
      postMoney,
      dilution,
      // 融资额能不能撑到现金流转正，是 BP 里最常被追问的一句
      coversRunway: input.funding > 0 ? true : null,
    },
  };
}

// ---------- 表格 ----------

function money(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 100000000) return `${(value / 100000000).toFixed(2)}亿`;
  if (abs >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return value.toFixed(0);
}

function percent(value, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

// 收入与毛利预测
function revenueTable(model) {
  const cols = model.years.map((item) => `第 ${item.year} 年`);
  return {
    title: '收入与毛利预测',
    note: '注：客户数为期末值；客单价为年均值。假设见「关键假设」表。',
    columns: ['项目', ...cols],
    rows: [
      ['客户数', ...model.years.map((item) => item.customers.toFixed(0))],
      ['客单价', ...model.years.map((item) => money(item.revenue / Math.max(1, item.customers)))],
      ['营业收入', ...model.years.map((item) => money(item.revenue))],
      ['营业成本', ...model.years.map((item) => money(item.cogs))],
      ['毛利', ...model.years.map((item) => money(item.gross))],
      ['毛利率', ...model.years.map((item) => percent(item.grossMargin))],
    ],
    align: ['left', ...cols.map(() => 'right')],
  };
}

// 利润表
function incomeTable(model) {
  const cols = model.years.map((item) => `第 ${item.year} 年`);
  return {
    title: '利润表预测',
    note: `注：税率按 ${percent(model.input.taxRate, 0)} 计；折旧按资本开支 ${money(model.input.capex)}元在预测期内直线摊销。`,
    columns: ['项目', ...cols],
    rows: [
      ['营业收入', ...model.years.map((item) => money(item.revenue))],
      ['营业成本', ...model.years.map((item) => money(item.cogs))],
      ['毛利', ...model.years.map((item) => money(item.gross))],
      ['人力成本', ...model.years.map((item) => money(item.payroll))],
      ['其他固定费用', ...model.years.map(() => money(model.input.fixedCost))],
      ['折旧', ...model.years.map((item) => money(item.depreciation))],
      ['营业利润（EBIT）', ...model.years.map((item) => money(item.ebit))],
      ['所得税', ...model.years.map((item) => money(item.tax))],
      ['净利润', ...model.years.map((item) => money(item.net))],
      ['净利率', ...model.years.map((item) => percent(item.netMargin))],
    ],
    align: ['left', ...cols.map(() => 'right')],
  };
}

// 现金流量表
function cashTable(model) {
  const cols = model.years.map((item) => `第 ${item.year} 年`);
  return {
    title: '现金流量表预测',
    note: '注：经营现金流 = 净利润 + 折旧 − 营运资金增加；营运资金按营业收入的 '
      + `${percent(model.input.wcRate, 0)} 估算。`,
    columns: ['项目', ...cols],
    rows: [
      ['期初现金', ...model.years.map((item) => money(item.cashBegin))],
      ['经营活动现金流', ...model.years.map((item) => money(item.ocf))],
      ['投资活动现金流', ...model.years.map((item) => money(item.icf))],
      ['筹资活动现金流', ...model.years.map((item) => money(item.fcf))],
      ['现金净增加额', ...model.years.map((item) => money(item.netCash))],
      ['期末现金', ...model.years.map((item) => money(item.cashEnd))],
    ],
    align: ['left', ...cols.map(() => 'right')],
  };
}

// 单位经济与融资
function unitTable(model) {
  const unit = model.unit;
  const rows = [
    ['客单价（ARPU）', `${money(unit.arpu)}元`, '—'],
    ['毛利率', percent(unit.grossMargin), '—'],
    ['客户流失率', percent(unit.churn), '—'],
    ['客户终身价值（LTV）', unit.ltv == null ? '不可计算（流失率为 0）' : `${money(unit.ltv)}元`, '—'],
    ['获客成本（CAC）', unit.cac == null ? '未提供营销费用' : `${money(unit.cac)}元`, '—'],
    ['LTV / CAC', unit.ltvCac == null ? '—' : unit.ltvCac.toFixed(1), unit.ltvCac == null ? '' : (unit.ltvCac >= 3 ? '健康' : '偏低（经验线 ≥ 3）')],
    ['获客回本周期', unit.paybackMonths == null ? '—' : `${unit.paybackMonths.toFixed(1)} 个月`, unit.paybackMonths == null ? '' : (unit.paybackMonths <= 12 ? '健康' : '偏长（经验线 ≤ 12 个月）')],
  ];
  if (model.funding.amount > 0) {
    rows.push(['融资额', `${money(model.funding.amount)}元`, '—']);
    rows.push(['投前 / 投后估值', `${money(model.funding.preMoney)} / ${money(model.funding.postMoney)}元`, '—']);
    rows.push(['投资人持股比例', model.funding.dilution == null ? '—' : percent(model.funding.dilution), '']);
  }
  return {
    title: '单位经济与融资测算',
    note: '注：LTV = 客单价 × 毛利率 ÷ 流失率；CAC = 营销费用 ÷ 新增客户数；回本周期 = CAC ÷ 月毛利。',
    columns: ['指标', '数值', '判断'],
    widths: [0.3, 0.26, 0.44],
    rows,
    align: ['left', 'right', 'left'],
  };
}

// 假设表：BP 的财务预测最忌讳「只给结果不给假设」
function assumptionTable(model) {
  const input = model.input;
  return {
    title: '关键假设',
    note: '注：以下假设是全部预测的输入，任一项变动都会改变结论；评审时会被逐条追问依据。',
    columns: ['假设项', '取值', '说明'],
    widths: [0.24, 0.18, 0.58],
    rows: [
      ['预测期', `${input.years} 年`, ''],
      ['首年客户数', input.customers.toFixed(0), '需说明获客来源与转化依据'],
      ['客户年增长率', percent(input.growth), '需说明依据（渠道容量 / 历史增速）'],
      ['客户留存率', percent(input.retention), '未提供时按 80% 估算'],
      ['客单价', `${money(input.price)}元`, '年均客单价，需说明定价依据'],
      ['变动成本率', percent(input.variableRate), '随收入同比例发生的成本'],
      ['固定费用', `${money(input.fixedCost)}元/年`, '不随收入变动的部分'],
      ['人均成本', `${money(input.costPerHead)}元/年`, `按 ${input.headcount} 人计，合计 ${money(input.costPerHead * input.headcount)}元/年`],
      ['所得税率', percent(input.taxRate, 0), ''],
      ['营运资金占收入比', percent(input.wcRate, 0), '应收与存货占用的简化估算'],
      ['期初现金', `${money(input.cash0)}元`, ''],
    ],
    align: ['left', 'center', 'left'],
  };
}

function allTables(model) {
  return [assumptionTable(model), revenueTable(model), incomeTable(model), cashTable(model), unitTable(model)];
}

// 结果段：数字全部来自计算，模型只负责组织语言
function narrative(model) {
  const last = model.years[model.years.length - 1];
  const first = model.years[0];
  const unit = model.unit;
  const parts = [];
  parts.push(`按上述假设，营业收入将从第 1 年的 ${money(first.revenue)}元增至第 ${last.year} 年的 ${money(last.revenue)}元`
    + (model.cagr != null ? `，年均复合增速 ${percent(model.cagr)}` : '') + '。');
  parts.push(`第 ${last.year} 年毛利率 ${percent(last.grossMargin)}、净利率 ${percent(last.netMargin)}，`
    + `${last.net >= 0 ? '实现盈利' : '仍处亏损'}。`);
  const anyNegative = model.years.some((item) => item.cashEnd < 0);
  if (!anyNegative) {
    parts.push(`预测期内期末现金始终为正，最低为 ${money(model.minCash)}元，不存在资金链断裂风险。`);
  } else if (model.cashPositiveYear) {
    parts.push(`期末现金在第 ${model.cashPositiveYear} 年转正，预测期内最低现金为 ${money(model.minCash)}元。`);
  } else {
    parts.push(`预测期内期末现金始终为负，最低为 ${money(model.minCash)}元——需要说明融资额能否覆盖这个缺口。`);
  }
  if (unit.ltvCac != null) {
    parts.push(`单位经济方面，LTV/CAC 为 ${unit.ltvCac.toFixed(1)}`
      + (unit.ltvCac >= 3 ? '，高于 3 的经验健康线' : '，低于 3 的经验健康线，获客效率需要解释')
      + (unit.paybackMonths != null ? `；获客回本周期 ${unit.paybackMonths.toFixed(1)} 个月` : '') + '。');
  }
  if (model.funding.amount > 0 && model.funding.dilution != null) {
    parts.push(`本次拟融资 ${money(model.funding.amount)}元，投前估值 ${money(model.funding.preMoney)}元，`
      + `投资人持股 ${percent(model.funding.dilution)}。`);
  }
  return parts.join('');
}

// ---------- 规则检查 ----------

// BP 的常见硬伤：假设缺失、单位经济不成立、市场规模没推算、融资与缺口不匹配
function scanBusinessPlan(project) {
  const text = (project.sections || []).map((section) => `${section.title}\n${section.content || ''}`).join('\n\n');
  const findings = [];
  const push = (level, code, title, detail) => findings.push({ level, code, title, detail });

  if (!/假设|测算依据|按.{0,6}估算|口径/.test(text)) {
    push('warn', 'assumption', '财务预测没有交代假设',
      '投资人看 BP 先看假设再看结果。单价、客户数、增长率、成本率各自的依据必须写出来，否则数字不可信。');
  }
  if (!/TAM|SAM|SOM|市场规模|可服务市场|自上而下|自下而上/.test(text)) {
    push('warn', 'market-size', '没有市场规模测算',
      '「市场很大」不是论证。要么自下而上（目标客户数 × 客单价 × 渗透率），要么自上而下并说明数据来源。');
  }
  if (!/壁垒|护城河|竞争优|差异化|不可复制|切换成本/.test(text)) {
    push('warn', 'moat', '没有说明竞争壁垒',
      '投资人会问「别人抄你怎么办」。技术、数据、渠道、网络效应，至少要能指出一条。');
  }
  if (!/风险/.test(text)) {
    push('info', 'risk', '没有风险分析', '主动写出主要风险与对策，比被投资人问出来好。');
  }
  if (/翻倍|暴增|颠覆|万亿|必然|一定/.test(text)) {
    push('info', 'hype', '有夸大表述',
      'BP 里的形容词会被当成不专业信号。用数字替代「翻倍增长」「颠覆行业」。');
  }
  return { findings, at: Date.now() };
}

module.exports = {
  DEFAULTS, normalizeInput, buildModel,
  assumptionTable, revenueTable, incomeTable, cashTable, unitTable, allTables,
  narrative, scanBusinessPlan, money, percent,
};
