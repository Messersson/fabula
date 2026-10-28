'use strict';

// 文档写作技法层：段落计划、rubric 评审、衔接润色、视角提问、问题研究。
//
// 全部方法都不碰数据库、不自己发请求——模型调用由调用方以 generate({sys,user,onUsage}) 注入。
// 这样 token 记账只有一条路径（doc-engine 的 generateOnce），重试/预算/取消语义也统一，
// 不会出现「评审调用的 token 没算进预算」这种账目漏洞。
//
// 借鉴来源（思路，不是代码）：
// - LongWriter / AgentWrite：长文先拆成「每段写什么、写多少字」，再逐段落笔，避免一段到底写成摘要。
// - AI-Scientist 的 reviewer：按固定 rubric 打分并给出必须修正项，低于阈值就带着 mustFix 重写。
// - AutoSurvey 的 refinement：全文写完后，用前后节信息再做一遍衔接与去重。
// - STORM 的 perspective-guided question asking：先按不同视角问出「素材答不出的问题」，再补研究。

// 模型经常在 JSON 外面套 ```json 或者加一句「好的，以下是计划：」。这里只认最外层对象/数组。
function extractJson(text) {
  const raw = String(text || '')
    .replace(/^[\s\S]*?```(?:json)?\s*/i, (matched) => (matched.includes('```') ? '' : matched))
    .replace(/```[\s\S]*$/, '')
    .trim();
  const candidates = [];
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open >= 0 && close > open) candidates.push(raw.slice(open, close + 1));
  const arrayOpen = raw.indexOf('[');
  const arrayClose = raw.lastIndexOf(']');
  if (arrayOpen >= 0 && arrayClose > arrayOpen) candidates.push(raw.slice(arrayOpen, arrayClose + 1));
  candidates.push(raw);
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* 继续试下一个切片 */ }
  }
  return null;
}

// ---------- 深度档位 ----------
//
// 「深度」不是一个形容词，是四个可执行的量：篇幅下限乘数、段落数、必须回答的子问题数、图表数。
// 只把「请写深入一些」写进提示词是没用的——模型会加形容词，不会加论证。
const DEPTH_LEVELS = {
  brief: {
    key: 'brief', name: '简洁',
    factor: 0.75, paragraphs: [2, 4], questions: [1, 2], figures: 1,
    note: '篇幅收紧，只保留最必要的一层论证：结论 + 关键依据，不展开旁支。',
  },
  standard: {
    key: 'standard', name: '标准',
    factor: 1, paragraphs: [3, 6], questions: [2, 3], figures: 1,
    note: '论证完整：每个判断都要有依据，段与段之间要有推进。',
  },
  deep: {
    key: 'deep', name: '深入',
    factor: 1.4, paragraphs: [5, 8], questions: [3, 4], figures: 2,
    note: '写透而不是写长：给出机制（为什么会这样）、对比或反例（不这样会怎样）、'
      + '边界条件（在什么前提下成立、什么情况下失效）、以及数据支撑。每个论点都要落到可核对的依据上。',
  },
};

function depthOf(depth) {
  return DEPTH_LEVELS[String(depth || '')] || DEPTH_LEVELS.standard;
}

// 「深度」的可执行定义。只写「请写深入一些」等于没写——模型会加形容词，不会加论证。
// 这里把深度拆成五条可检查的动作，并按档位决定要求几条。
// 这五条也是评审阶段的抓手（见 reviewPrompt 里的 depth 检查项），
// 所以「要求」和「验收」用的是同一套标准，不会一边要求机制、一边只按字数打分。
const DEPTH_GUIDE = [
  ['机制', '每个核心判断都要回答「为什么会这样」：给出因果链或作用机制，不能只给结论。'
    + '反例：「数字化转型提升效率。」正例：「数字化转型通过把排产决策从日级压到小时级，减少了在制品等待，从而提升周转率。」'],
  ['依据', '每个主张至少挂一条可核对的依据（数据、文献、政策条文、案例）。没有依据的判断要标明它是推断。'],
  ['对比', '关键结论要给出参照系：与什么相比、不这样做会怎样、同类对象是什么水平。孤立的数字说明不了任何问题。'],
  ['边界', '说明结论在什么前提下成立、在什么条件下失效（样本、时间、地域、规模、假设）。没有边界的结论不可信。'],
  ['推进', '段与段之间是推进关系（提出问题→给依据→作对比或排除→收束），不是并列要点的堆叠；'
    + '每段开头不要用「首先/其次/最后」这类序号词代替逻辑。'],
];

// 按档位取前 N 条。brief 只要求机制与依据，standard 加对比，deep 五条全要。
function depthGuide(depth) {
  const count = { brief: 2, standard: 3, deep: 5 }[depthOf(depth).key] || 3;
  const items = DEPTH_GUIDE.slice(0, count)
    .map(([name, desc], index) => `${index + 1}. 【${name}】${desc}`);
  return `【论证深度要求（逐条对照，缺哪条补哪条）】\n${items.join('\n')}`;
}

// 浅层写法的黑名单：这三种是最常见的「看起来写了、其实没写」。
const SHALLOW_BAN = '【禁止的浅层写法】同义反复（把标题换个说法当结论）；'
  + '名词罗列（一段里堆五个概念但不说它们的关系）；结论复述（段末把段首再说一遍）。'
  + '出现这三种写法，这一节等于没写。';

function clampInt(value, min, max, fallback) {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

// 「这一句是不是论点」的判定。
//
// 论点必须是**可被反驳的判断**：有主语、有倾向、能被证据推翻。
// 「提出本节的核心判断」「分析现状」是动作描述，不是论点——拿它去比对正文，
// 任何正文都「没写到」，于是每节都被判成缺陷。这类假缺陷比不检查更有害：
// 它会触发无谓的补写、把 token 烧在一段本来没问题的正文上。
//
// 所以这里只认两种形态：不以动作动词开头的句子，且长度足够承载一个判断。
const ACTION_HEADS = /^(提出|给出|介绍|说明|分析|阐述|交代|梳理|概括|总结|描述|展开|引入|铺垫|承接|收束|点明|论证|讨论|列出|列举|对比|补充|解释|回顾|展望|界定|明确|交代|呈现|展示|给出|写作|撰写)/;

function looksLikeClaim(text) {
  const raw = String(text || '').trim();
  if (raw.length < 12) return false;
  if (ACTION_HEADS.test(raw)) return false;
  // 「本节将……」「下面介绍……」这类是写作说明，不是论点。
  if (/^(本节|本文|下面|接下来|首先|其次|最后)/.test(raw)) return false;
  return true;
}

function materialLines(materials) {
  if (!materials || !materials.length) return '（本节没有可用素材）';
  return materials.map((item) => `${item.key}｜${item.title}｜${String(item.text || '').slice(0, 120)}`).join('\n');
}

// ---------- 段落计划（AgentWrite） ----------

async function planSection({ generate, project, idx, materials, minChars, depth = 'standard', onUsage = null, maxFigures = null }) {
  const section = project.sections[idx - 1];
  if (!section) throw new Error('小节不存在');
  const level = depthOf(depth);
  const [minPara, maxPara] = level.paragraphs;
  const [minQ, maxQ] = level.questions;
  // 图上限：类型说「这类文档不配图」时直接归零（纪要/通知/制度/新闻稿/演讲稿/合同/总结）。
  const figureLimit = maxFigures == null ? level.figures : Math.max(0, Number(maxFigures) || 0);
  const sys = [
    '你是资深的中文文书写作策划。给定一节的任务与素材，只输出这一节的段落计划。',
    '计划的作用是让写作者知道每一段要完成哪个论证动作、写多少字、用哪条素材——不要写正文。',
    '只输出 JSON，不要任何解释。',
  ].join('\n');
  const user = [
    `【文档】${project.title}（${project.docTypeName || project.docType}）`,
    project.thesis ? `【论题】${project.thesis}` : '',
    (project.points || []).length ? `【论据要点】\n${project.points.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '',
    `【本节】第 ${idx} 节「${section.title}」`,
    section.brief ? `【本节要求】${section.brief}` : '',
    `【篇幅下限】${minChars} 字`,
    `【写作深度】${level.name}——${level.note}`,
    `【可用素材】\n${materialLines(materials)}`,
    '请按下面格式输出：',
    '{"targetChars": 1200, "questions": ["本节必须正面回答的具体问题"], '
      + '"paragraphs": [{"goal": "这一段的论证动作（判断句，不要写正文）", "claim": "这一段要立住的核心论点（写成可被反驳的判断句）", '
      + '"chars": 220, "materials": ["M1"], "evidence": "支撑这个论点的具体依据（素材里的哪句话/哪个数字）"}], '
      + '"figures": [{"type": "bar", "title": "图表标题", "unit": "亿元", "note": "资料来源：M2", '
      + '"xLabel": "年份", "yLabel": "市场规模", '
      + '"categories": ["2021", "2022"], "series": [{"name": "市场规模", "values": [1280, 1580]}]}]}',
    `要求：段落 ${minPara}~${maxPara} 段；每段 chars 在 120~400 之间；各段 chars 之和不少于篇幅下限；`,
    '段落顺序要构成完整论证链（提出问题→给依据→作对比或排除→落到本节结论），不要重复同一层意思；',
    'materials 只填素材编号，没有可用素材就留空数组。',
    // 论点—证据对应：计划阶段就要把「这一段立什么论、用哪条依据」钉死。
    // 原来只在评审阶段看「有没有依据」，已经写完了才知道就晚了——重写一节的代价远高于写对一段。
    'claim 写「这一段要立住的核心论点」：必须是可被反驳的判断句（有主语、有倾向、能被证据推翻），'
      + '不能写「介绍背景」「分析现状」这种动作描述。',
    'evidence 写支撑该论点的具体依据（素材里的哪句话、哪个数字），素材不足以支撑时写「素材不足，需补充」——'
      + '写不出来说明这一段不该这么写。',
    `questions：${minQ}~${maxQ} 个本节必须正面回答的问题。要具体到「谁 / 多少 / 为什么 / 在什么条件下」，`
      + '能被一条素材回答；不要问「如何评价」「有什么意义」这类空问题。',
    `figures：0~${figureLimit} 个图表，只在该节确实需要用数据说明问题时给。`
      + (figureLimit === 0 ? '本文档类型不需要图表，返回空数组 []。' : ''),
    '图表数值必须逐字来自素材里已有的数字（可在 note 里注明来源素材编号），'
      + '素材没有给出数字就不要出图表——返回空数组 []。绝对不允许为了「图文并茂」编造数据。',
    '选图型要看数据长什么样，不要默认一律柱状：',
    '  bar     —— 类目之间比大小（分组对比、构成对比）',
    '  line    —— 随时间变化的趋势（x 是年份/月份等有序量）',
    '  pie     —— 构成占比，且类目不超过 5 个（超过 5 个改用 bar，饼图读不出来）',
    '  scatter —— 两个连续变量的关系（关系、相关、回归），写 {"series":[{"name":"观测","xs":[..],"ys":[..]}]}，'
      + '不用 categories；系统会自动算并画出拟合线、R²、样本量与 95% 置信带',
    '  hist    —— 单个变量的分布（把该变量的多个观测值放进 values，不用 categories）',
    '  errorbar—— 各组的均值对比且有误差（均值放 values，误差幅度放 errors，如标准差/标准误）',
    '可叠加的画法修饰项（写在图表对象里，与 type 并列）：',
    '  "stacked": true  —— 堆叠柱：看构成随时间的此消彼长（多系列且要强调结构变化时用）',
    '  "grouping": "percent" —— 百分比堆叠：各组构成对比，忽略绝对量差异',
    '  "logY": true     —— 纵轴对数刻度（仅 line）：数据跨 2 个数量级以上时用，否则小值会被压成一条直线',
    '  "band": [..]     —— 折线置信带（仅 line）：每个类目一个 ± 值，画成阴影带',
    '不同文体的配图重点不同：',
    '  论文 —— 结果部分必须有「数据图」：变量分布（hist）、变量关系（scatter+拟合）、组间差异（errorbar）；'
      + '每张图都要能回答一个研究问题，图注写清样本量 n 与数据来源；',
    '  商业计划/可研 —— 市场规模用 bar 或 line、结构占比用 pie、增速对比用 bar；',
    '  工作报告 —— 完成情况用 bar、进度用 line、构成用 pie 或百分比堆叠。',
    '每张图都要写 xLabel 与 yLabel（坐标轴名称，含单位）；categories 不超过 8 项，series 不超过 3 条'
      + '且每条 values 与 categories 等长。',
  ].filter(Boolean).join('\n\n');
  const raw = await generate({ sys, user, onUsage });
  const parsed = extractJson(raw);
  if (!parsed || !Array.isArray(parsed.paragraphs) || !parsed.paragraphs.length) {
    return null; // 计划失败不影响写作，退回单段直写
  }
  const paragraphs = parsed.paragraphs.slice(0, 8).map((item) => ({
    goal: String(item && item.goal || '').trim().slice(0, 200),
    // 论点：可被反驳的判断句。它是「论点—证据对应」这条链的左端，
    // 评审与体检都靠它定位「这一节到底立了什么论、兑现了没有」。
    claim: String(item && item.claim || '').trim().slice(0, 200),
    // 依据说明：素材里的哪句话/哪个数字支撑这个论点。
    evidence: String(item && item.evidence || '').trim().slice(0, 200),
    chars: clampInt(item && item.chars, 80, 600, 200),
    materials: Array.isArray(item && item.materials)
      ? item.materials.map((key) => String(key).toUpperCase().replace(/[^M0-9]/g, '')).filter(Boolean).slice(0, 4)
      : [],
  })).filter((item) => item.goal);
  if (!paragraphs.length) return null;
  // 论点清单：只收「像论点」的句子。
  //
  // 不能把每个 goal 都当论点：goal 常常是动作描述（「提出本节的核心判断」「给出依据并收束」），
  // 拿它去比对正文必然「找不到」，于是每一节都会被判成「论点未兑现」并触发无谓的补写。
  // 只认有实质判断的句子，没有就留空——宁可这条链不启用，也不要给假缺陷。
  const claims = paragraphs
    .filter((item) => looksLikeClaim(item.claim))
    .map((item) => ({
      goal: item.claim,
      evidence: item.evidence,
      materials: item.materials,
    }));
  const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
    .map((item) => String(item || '').trim().slice(0, 160)).filter(Boolean).slice(0, 4);
  const sum = paragraphs.reduce((total, item) => total + item.chars, 0);
  return {
    // 目标字数不得低于篇幅下限。
    // 模型常给一个「看起来合理」的 targetChars（1200），而深度档位算出的下限是 2240，
    // 两个数字同时出现在提示词里就是自相矛盾的指令——模型只会挑小的那个执行。
    targetChars: Math.max(minChars, clampInt(parsed.targetChars, 200, 6000, Math.max(minChars, sum))),
    paragraphs,
    claims,
    questions,
    // 图表在这里只做形状校验（编号、条数、数值夹紧），渲染细节交给 doc-figure。
    figures: figuresOf(parsed.figures, figureLimit),
    depth: level.key,
    at: Date.now(),
  };
}

// 计划里的图表只保留「能用」的：数值全空、类目为空的一律丢掉。
// 宁可这一节没有图，也不要出一个全是 0 的柱状图——那比没图更像糊弄。
//
// 新图型（scatter / hist / errorbar）的数据形状与柱线饼不同：
//  - scatter 用 xs + ys 成对，没有 categories
//  - hist 只有一个 values 数组，没有 categories
//  - errorbar 在柱状基础上多一个 errors 数组
// 校验逻辑必须按图型分开，否则会把 scatter 的数据判成「没有类目」而丢掉。
function figuresOf(rawList, limit) {
  if (!Array.isArray(rawList) || !limit) return [];
  const list = [];
  const num = (value) => {
    // 空值必须留成 null，不能落成 0：Number('') === 0 会让「全是空值」的图表
    // 通过「有数值」的校验，最后画出一张全是 0 的柱状图。
    const text = String(value == null ? '' : value).replace(/[,，\s%]/g, '');
    if (!text) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  };
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const type = ['bar', 'line', 'pie', 'scatter', 'hist', 'errorbar'].includes(item.type) ? item.type : 'bar';
    // 修饰项原样带下去，归一化在 doc-figure 里统一做（那里才知道画法）
    const grouping = String(item.grouping || item.stack || '').toLowerCase();
    const base = {
      no: list.length + 1,
      type,
      stacked: item.stacked === true || grouping === 'stacked' || grouping === 'stacked100' || grouping === 'percent',
      percent: grouping === 'stacked100' || grouping === 'percent' || item.percent === true,
      logY: item.logY === true || item.logAxis === true,
      title: String(item.title || '').trim().slice(0, 60) || `图 ${list.length + 1}`,
      unit: String(item.unit || '').trim().slice(0, 12),
      note: String(item.note || '').trim().slice(0, 120),
      xLabel: String(item.xLabel || '').trim().slice(0, 30),
      yLabel: String(item.yLabel || '').trim().slice(0, 30),
    };
    const rawSeries = Array.isArray(item.series) ? item.series : [];

    if (type === 'scatter') {
      const series = rawSeries.slice(0, 3).map((entry, order) => {
        // y 值两种写法都认：ys（散点专用）或 values（柱线图沿用的字段名）
        const ys = Array.isArray(entry && entry.ys) ? entry.ys
          : (Array.isArray(entry && entry.values) ? entry.values : []);
        return {
          name: String(entry && entry.name || '').trim().slice(0, 30) || `系列 ${order + 1}`,
          xs: (Array.isArray(entry && entry.xs) ? entry.xs : []).map(num),
          values: ys.map(num),
        };
      }).filter((entry) => entry.xs.some((v) => v != null) && entry.values.some((v) => v != null));
      if (!series.length) continue;
      for (const entry of series) {
        const len = Math.min(entry.xs.length, entry.values.length);
        entry.xs = entry.xs.slice(0, len);
        entry.values = entry.values.slice(0, len);
      }
      list.push({ ...base, series });
      if (list.length >= limit) break;
      continue;
    }

    if (type === 'hist') {
      const values = rawSeries.flatMap((entry) => (Array.isArray(entry && entry.values) ? entry.values : []).map(num))
        .filter((value) => value != null);
      if (values.length < 3) continue;
      list.push({ ...base, categories: [], series: [{ name: '频数', values }] });
      if (list.length >= limit) break;
      continue;
    }

    const categories = (Array.isArray(item.categories) ? item.categories : [])
      .map((entry) => String(entry == null ? '' : entry).trim().slice(0, 24)).filter(Boolean).slice(0, 8);
    const series = rawSeries.slice(0, 3).map((entry, order) => ({
      name: String(entry && entry.name || '').trim().slice(0, 30) || `系列 ${order + 1}`,
      values: (Array.isArray(entry && entry.values) ? entry.values : []).map(num),
    })).filter((entry) => entry.values.some((value) => value != null));
    if (!series.length || !categories.length) continue;
    for (const entry of series) {
      while (entry.values.length < categories.length) entry.values.push(0);
      entry.values = entry.values.slice(0, categories.length);
    }
    const spec = { ...base, categories, series: type === 'pie' ? [series[0]] : series };
    if (type === 'errorbar') {
      const errors = (Array.isArray(item.errors) ? item.errors : []).map(num)
        .slice(0, categories.length);
      while (errors.length < categories.length) errors.push(0);
      spec.errors = errors;
    }
    // 折线的置信带：和误差线同形状（每个类目一个 ± 值），画成阴影带
    if (type === 'line' && Array.isArray(item.band)) {
      const band = item.band.map(num).slice(0, categories.length);
      if (band.some((value) => value != null && value > 0)) spec.band = band;
    }
    // 百分比堆叠的数值就是占比，不需要再按绝对量校验
    if (spec.percent && spec.stacked) spec.percent = true;
    list.push(spec);
    if (list.length >= limit) break;
  }
  return list;
}

function planBlock(plan) {
  if (!plan || !plan.paragraphs || !plan.paragraphs.length) return '';
  const lines = plan.paragraphs.map((item, index) => {
    const uses = item.materials.length ? `（用 ${item.materials.join('、')}）` : '';
    return `第 ${index + 1} 段｜约 ${item.chars} 字｜${item.goal}${uses}`;
  });
  const parts = [`【段落计划（按此顺序写，不要写成摘要）】\n${lines.join('\n')}\n全节不少于 ${plan.targetChars} 字。`];
  // 论点—证据对照表：把「这一段立什么论、用哪条依据」摆在写作者眼前。
  // 没有这张表，模型只知道「写五段」，不知道「这五段分别要证明什么」——
  // 结果是五段都在复述标题。
  const claims = (Array.isArray(plan.claims) && plan.claims.length)
    ? plan.claims
    : plan.paragraphs.map((item) => ({ goal: item.goal, evidence: item.evidence, materials: item.materials }));
  if (claims.length && claims.some((item) => item && (item.goal || item.evidence))) {
    const rows = claims.map((item, index) => {
      const claim = String(item.goal || '').trim() || '（未给论点）';
      const ev = String(item.evidence || '').trim();
      const mats = Array.isArray(item.materials) && item.materials.length ? item.materials.join('、') : '';
      return `${index + 1}. 论点：${claim}`
        + (ev ? `\n   依据：${ev}` : '')
        + (mats ? `\n   引用素材：${mats}（在句末标 [${mats.split('、')[0]}] 等编号）` : '');
    });
    parts.push('【论点—证据对照表（每一段都必须把对应的论点写出来，并落实依据）】\n'
      + rows.join('\n')
      + '\n写完检查一遍：表里每条论点都要在正文里被明确讲出来（能被读者复述），'
      + '不能只写现象不给判断，也不能把论点换个说法绕过去。');
  }
  // 子问题是「深度」最直接的抓手：不给具体问题，模型只会写三段泛泛而谈的结论。
  if (plan.questions && plan.questions.length) {
    parts.push('【本节必须正面回答的问题（每个都要在本节内给出明确结论；'
      + '素材不足以回答的，写明结论的依据边界并标【待核实】，不许绕开不提）】\n'
      + plan.questions.map((item, index) => `${index + 1}. ${item}`).join('\n'));
  }
  // 图表：数字在计划阶段就定了，正文只负责放占位符。这样「图文并茂」不会变成「模型现场编数据」。
  if (plan.figures && plan.figures.length) {
    parts.push('【图表】本节含 ' + plan.figures.length + ' 张图，数据已经定好，你不需要重算或另写表格。'
      + '在论述到该组数据的段落之后，单独一行原样写出占位符（编号与标题一字不改）：\n'
      + plan.figures.map((item) => `【图${item.no}：${item.title}】`).join('\n')
      + '\n另外，在正文里要用「如图 ' + plan.figures[0].no + ' 所示」这类句子把它引出来，并说明这张图支持了哪个判断——'
      + '只放图不提，读者不知道往哪看，审稿也会记一条。');
  }
  return parts.join('\n\n');
}

// ---------- rubric 评审（AI-Scientist reviewer） ----------

const REVIEW_RUBRIC = [
  ['argument', '论证充分性', '每段有明确判断并给出依据，不是名词罗列或同义反复'],
  ['evidence', '证据密度', '数字、案例、文献、政策条文具体到可核对；没有「很多」「显著」这类无依据的形容词'],
  ['structure', '结构与衔接', '开头承接前文、段间有推进、结尾收束本节；没有与相邻小节重复的内容'],
  ['terminology', '术语一致', '同一概念全文同一叫法，没有中英混用或同义词漂移'],
  ['substance', '无空话', '没有「随着…的发展」「具有重要意义」这类可删的句子'],
  ['citation', '引用合规', '只引用素材里给出的编号，没有编造文献、数据或政策'],
];

// 论证层的措辞与基准模块保持同一套说法（见 lib/doc-benchmark.js）。
// 评审提示词里不重复定义判据——两处定义一旦漂移，「要求」和「验收」就对不上了。
function reviewPrompt(project, idx, content, materials, benchmark = null) {
  const section = project.sections[idx - 1];
  const questions = (section.plan && Array.isArray(section.plan.questions)) ? section.plan.questions : [];
  const claims = (section.plan && Array.isArray(section.plan.claims) && section.plan.claims.length)
    ? section.plan.claims
    : (section.plan && Array.isArray(section.plan.paragraphs)
      ? section.plan.paragraphs.map((item) => ({ goal: item.goal, evidence: item.evidence, materials: item.materials }))
      : []);
  const sys = [
    '你是严格的期刊审稿人 / 评审专家。只按 rubric 打分并指出必须修正的地方，不要重写正文。',
    '宁可严格：一份能直接交出去的稿子应当在 80 分以上；空话多、没有证据的稿子不应超过 60 分。',
    '【打分锚点，必须遵守】只要列出了 mustFix，总分不得高于 85；只要有必答问题被绕开，总分不得高于 75；',
    '两者都有时取更低者。自评偏高会让后续修订被跳过，等于把缺陷留给读者。',
    '只输出 JSON。',
  ].join('\n');
  const rubric = REVIEW_RUBRIC.map(([key, name, desc]) => `- ${key}（${name}，0~20 分）：${desc}`).join('\n');
  const user = [
    `【文档】${project.title}（${project.docTypeName || project.docType}）`,
    `【本节】第 ${idx} 节「${section.title}」`,
    section.brief ? `【本节要求】${section.brief}` : '',
    questions.length
      ? `【本节必须回答的问题】\n${questions.map((item, index) => `${index + 1}. ${item}`).join('\n')}\n`
        + '逐条检查正文是否正面回答了：只给结论不给依据、或者用「有待观察」「具有重要意义」绕开的，算未回答。'
      : '',
    // 论点—证据对应：把段落计划里定好的论点摆出来，让评审逐条核对有没有兑现。
    // 之前评审只看「这一段有没有依据」，看不出「这一节本来要证明什么、证明了吗」。
    claims.length
      ? `【本节必须兑现的论点（逐条核对正文有没有把它讲出来，并落实了依据）】\n`
        + claims.map((item, index) => {
          const ev = String(item.evidence || '').trim();
          const mats = Array.isArray(item.materials) && item.materials.length ? `（素材 ${item.materials.join('、')}）` : '';
          return `${index + 1}. ${String(item.goal || '').trim()}${mats}${ev ? `\n   计划依据：${ev}` : ''}`;
        }).join('\n')
        + '\n只写了现象、绕开了论点、或把论点换成一句空话的，都要写进 mustFix，并放进 unsupported 数组。'
      : '',
    `【评审维度】\n${rubric}`,
    // 深度检查单独列出来，并且明确「缺哪条就写进 mustFix」。
    // 只放在打分维度里是不够的：分数可以靠结构和术语拉高，深度照样是空的。
    '【深度检查（下面每一条都要判「有 / 没有」；判「没有」的必须写进 mustFix，'
      + '写清在哪一段缺、缺的是什么）】\n'
      + DEPTH_GUIDE.map(([name, desc], index) => `${index + 1}. 【${name}】${desc.split('。')[0]}。`).join('\n'),
    '【空话检查】同义反复、名词罗列、段末复述段首——出现任何一种都要写进 mustFix。',
    // 客观基准：把系统检测到的缺口交给评审，避免「模型说写得好就当写得好」。
    benchmark && benchmark.gaps && benchmark.gaps.length
      ? `【系统检测到的质量缺口（这些是客观检测的结果，不是你的主观印象；必须逐条核对正文是否真的缺，'
        + '确实缺的要写进 mustFix）】\n${benchmark.gaps.map((gap) => `- ${gap.text}`).join('\n')}`
      : '',
    `【可用素材编号】${materials && materials.length ? materials.map((item) => item.key).join('、') : '（无）'}`,
    `【待评审正文】\n${String(content).slice(0, 12000)}`,
    '输出格式：',
    '{"scores":{"argument":16,"evidence":12,"structure":17,"terminology":18,"substance":15,"citation":20},'
      + '"total":98,"issues":["具体问题，指出在哪一段"],"mustFix":["必须改的点，最多三条"],'
      + '"patches":[{"quote":"从正文里逐字摘录的问题句（10~60 字）","issue":"这句的问题是什么",'
      + '"replacement":"改写后的这一句"}],'
      + '"unanswered":["没有正面回答的问题，说明它被怎么绕开的"],'
      + '"unsupported":["没有兑现或没有依据支撑的论点"]}',
    'patches 用于定点修补：quote 必须是正文里**一字不差**的连续片段（不许改写、不许加省略号），'
      + 'replacement 是替换后的同长度句子。只给确实需要改的句子，最多五条；没把握定位就给空数组。',
    'issues 与 mustFix 都要具体到可执行（例如「第二段只说『效果显著』但没有给出任何数据」），不要写「可以更深入」这类空评语。',
    '没有给出必须回答的问题时，unanswered 返回空数组；没有给出论点时，unsupported 返回空数组。',
  ].filter(Boolean).join('\n\n');
  return { sys, user };
}

async function reviewSection({ generate, project, idx, content, materials, onUsage = null, benchmark = null }) {
  const { sys, user } = reviewPrompt(project, idx, content, materials, benchmark);
  const raw = await generate({ sys, user, onUsage });
  const parsed = extractJson(raw);
  if (!parsed) return null;
  const scores = {};
  let total = 0;
  for (const [key] of REVIEW_RUBRIC) {
    const value = clampInt(parsed.scores && parsed.scores[key], 0, 20, 0);
    scores[key] = value;
    total += value;
  }
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues.map((item) => String(item).trim().slice(0, 160)).filter(Boolean).slice(0, 6) : [];
  const mustFix = Array.isArray(parsed.mustFix)
    ? parsed.mustFix.map((item) => String(item).trim().slice(0, 160)).filter(Boolean).slice(0, 3) : [];
  const unanswered = Array.isArray(parsed.unanswered)
    ? parsed.unanswered.map((item) => String(item).trim().slice(0, 160)).filter(Boolean).slice(0, 4) : [];
  // 论点未兑现 / 未挂依据：单列出来。它和「问题被绕开」是两类缺陷，
  // 前者是「该证明的没证明」，后者是「该回答的没回答」，混在一起会漏判。
  const unsupported = Array.isArray(parsed.unsupported)
    ? parsed.unsupported.map((item) => String(item).trim().slice(0, 160)).filter(Boolean).slice(0, 4) : [];
  const patches = (Array.isArray(parsed.patches) ? parsed.patches : [])
    .map((item) => ({
      quote: String((item && item.quote) || '').trim(),
      issue: String((item && item.issue) || '').trim().slice(0, 120),
      replacement: String((item && item.replacement) || '').trim(),
    }))
    .filter((item) => item.quote.length >= 6 && item.replacement && item.replacement !== item.quote)
    .slice(0, 5);
  const reported = clampInt(parsed.total, 0, 120, total);
  return {
    // 以分项之和为准：模型经常把 total 写成一个和分项对不上的整数。
    total: Math.min(120, total || reported),
    scores, issues, mustFix, patches, unanswered, unsupported, at: Date.now(),
  };
}

// 带着 mustFix 重写整节。刻意不再二次评审：那会变成无限打磨，成本不可控。
function reviseBlock(review) {
  if (!review || !review.mustFix || !review.mustFix.length) return '';
  const unanswered = (review.unanswered && review.unanswered.length)
    ? `\n【没有正面回答的问题（这次必须回答，给不出依据就写明依据边界并标【待核实】）】\n`
      + review.unanswered.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : '';
  const unsupported = (review.unsupported && review.unsupported.length)
    ? `\n【没有兑现的论点（这次必须把论点明确写出来，并落实依据；素材不足就写【待核实】）】\n`
      + review.unsupported.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : '';
  return `【评审必须修正】\n${review.mustFix.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
    + unanswered
    + unsupported
    + (review.issues && review.issues.length
      ? `\n【其它问题（能改则改）】\n${review.issues.map((item) => `- ${item}`).join('\n')}`
      : '');
}

// ---------- 衔接润色（AutoSurvey refinement） ----------

async function polishSection({ generate, project, idx, content, prevPoints = '', nextPoints = '', materials, onUsage = null }) {
  const section = project.sections[idx - 1];
  const sys = [
    '你是资深编辑，负责把一份多人分工写成的稿子改成「一个人写的」。只做衔接、去重、术语统一与收束，不改事实。',
    '硬约束：不得新增或修改任何数据、文献、政策条文、引用编号；不得改变小节的论点；不得扩写成另一篇。',
    '硬约束：正文中形如「【图1：标题】」的整行是图表占位，必须原样保留在原位置，不得删除、合并或改写其中的编号与标题。',
    '硬约束：$...$ 与 $$...$$ 里的公式原样保留，不得改写符号、上下标或数值；只允许在公式前后的文字上做衔接。',
    '直接输出润色后的完整本节正文，不要解释、不要代码围栏、不要加「以下是」之类的话。',
  ].join('\n');
  const user = [
    `【文档】${project.title}（${project.docTypeName || project.docType}）`,
    project.thesis ? `【论题】${project.thesis}` : '',
    `【本节】第 ${idx} 节「${section.title}」`,
    prevPoints ? `【前文要点（开头要承接，但不要重复论述）】\n${prevPoints}` : '（本节是第一节，开头直接切入）',
    nextPoints ? `【后文要点（结尾不要抢它的内容）】\n${nextPoints}` : '',
    `【可用素材编号】${materials && materials.length ? materials.map((item) => item.key).join('、') : '（无）'}`,
    `【待润色正文】\n${String(content).slice(0, 14000)}`,
    '润色要求：',
    '1. 删掉与前文重复的句子（同一判断只保留一次，位置放在论证最需要的地方）；',
    '2. 每段之间补一句承接，让论证有推进感；',
    '3. 同一概念统一叫法，首次出现时给出全称；',
    '4. 删掉可删的空话（「随着…的发展」「具有重要意义」），换成具体判断；',
    '5. 篇幅不得少于原文的 90%，不得多于原文的 125%。',
  ].filter(Boolean).join('\n\n');
  return generate({ sys, user, onUsage });
}

// ---------- 视角发现与提问（STORM） ----------

const PERSPECTIVE_HINTS = '政策与合规、技术与方法、市场与竞争、成本与收益、风险与失败案例、利益相关方（用户/员工/监管）';

async function suggestQuestions({ generate, project, idx, materials, onUsage = null }) {
  const section = project.sections[idx - 1];
  const sys = [
    '你是资深选题策划。像审稿人一样，从不同视角提出「这份稿子目前答不出来、但读者一定会问」的问题。',
    '只问能落到事实的问题（数字、时间、主体、机制、边界条件），不要问「如何评价」这类空问题。',
    '只输出 JSON。',
  ].join('\n');
  const user = [
    `【文档】${project.title}（${project.docTypeName || project.docType}）`,
    project.thesis ? `【论题】${project.thesis}` : '',
    `【本节】第 ${idx} 节「${section.title}」${section.brief ? `——${section.brief}` : ''}`,
    `【现有素材】\n${materialLines(materials)}`,
    `【可选视角】${PERSPECTIVE_HINTS}`,
    '请挑 3 个最切题的视角，每个视角提 1~2 个问题，并指出需要补什么素材才能回答。输出格式：',
    '{"perspectives":[{"name":"成本与收益","questions":[{"q":"问题原文","need":"需要补的素材，如：同行改造投入的公开数据"}]}]}',
    '问题要具体到「谁、在什么条件下、多少」，能被一条素材回答；不要问开放式的宏大问题。',
  ].filter(Boolean).join('\n\n');
  const raw = await generate({ sys, user, onUsage });
  const parsed = extractJson(raw);
  if (!parsed || !Array.isArray(parsed.perspectives)) return null;
  const perspectives = parsed.perspectives.slice(0, 5).map((item) => ({
    name: String(item && item.name || '其他').trim().slice(0, 24),
    questions: (Array.isArray(item && item.questions) ? item.questions : []).slice(0, 3).map((entry) => {
      if (typeof entry === 'string') return { q: entry.trim().slice(0, 200), need: '' };
      return {
        q: String(entry && entry.q || '').trim().slice(0, 200),
        need: String(entry && entry.need || '').trim().slice(0, 120),
      };
    }).filter((entry) => entry.q),
  })).filter((item) => item.questions.length);
  if (!perspectives.length) return null;
  return { perspectives, at: Date.now() };
}

// 让模型先以专家身份把这些问题答一遍（STORM 的模拟对话）：能答的给出依据，答不了的明确标出来。
// 产出直接存成一条素材，下一步起草就能引用——「提问 → 研究 → 素材 → 写作」闭环。
async function researchAnswers({ generate, project, idx, questions, materials, onUsage = null }) {
  const section = project.sections[idx - 1];
  const sys = [
    '你是该领域的资深专家，正在为写作团队做一次研究简报。',
    '只依据给出的素材与公认的方法论常识作答；素材没有覆盖的数字、文献、政策条文一律写【待核实】，绝不编造。',
    '直接输出中文正文，不要 JSON、不要标题层级、不要「以下是」。',
  ].join('\n');
  const list = (questions || []).map((item, index) => `${index + 1}. ${item}`).join('\n');
  const user = [
    `【文档】${project.title}（${project.docTypeName || project.docType}）`,
    `【本节】第 ${idx} 节「${section.title}」`,
    `【素材】\n${materialLines(materials)}`,
    `【需要回答的问题】\n${list}`,
    '写成 300~600 字的研究纪要：逐条回答问题，能答的给出依据（引素材编号），答不了的写明「【待核实】+ 需要什么资料」。',
    '最后用一行列出「下一步最该补的三样材料」。',
  ].filter(Boolean).join('\n\n');
  return generate({ sys, user, onUsage });
}

module.exports = {
  extractJson, planSection, planBlock, figuresOf, reviewSection, reviseBlock, polishSection,
  suggestQuestions, researchAnswers, REVIEW_RUBRIC, DEPTH_LEVELS, depthOf,
  DEPTH_GUIDE, depthGuide, SHALLOW_BAN, looksLikeClaim,
};
