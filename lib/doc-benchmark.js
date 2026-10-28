'use strict';

// 质量基准：把「写得好不好」从形容词变成可测的量。
//
// 背景：这一层之前只有两种把关方式——提示词里写「要深入」，以及模型自评打分。
// 前者模型接不住（它只会加形容词，不会加论证），后者模型自评天然偏高。
// 于是「每节都写了、但每节都停在结论层」这种稿子能一路放行到导出。
//
// 这里做的是第三种：用**正文里客观可查的特征**判断一节写到了什么深度。
// 每个基准项都能在正文里定位到具体缺什么（缺机制/缺对比/缺边界/依据太稀/空话太多），
// 既能进写作提示词当要求（写作前先知道标准），也能进评审当判据（写完对照验收），
// 还能进体检报告当提示（作者看到的是缺哪一项，而不是笼统的「建议加强」）。
//
// 全部是纯函数：不吃数据库、不发请求，可单测。

const { bigrams } = require('./doc-quality');

// ---------- 深度档位对应的论证层数要求 ----------
//
// 「深入」不是篇幅，是论证层数。一节至少要有几层不同的论证动作，
// 少一层就说明这个判断只停在了结论或只停在了现象。
const LAYER_REQUIREMENT = { brief: 1, standard: 2, deep: 3 };

// 论证层名的顺序即检查顺序，从最常缺失的排前面。
const LAYER_NAMES = ['机制', '对比', '边界', '推进'];

// ---------- 信号词表 ----------
//
// 每一层都对应一组「论文里真的会出现」的措辞。宁可漏判也不能误判：
// 误判会把写得对的稿子判成缺项，作者去补一堆没用的内容，比不检查更糟。
// 所以这里的词表只用强信号——出现即基本成立，不出现才提示「可能缺」。
const LAYER_SIGNALS = {
  // 机制：给出了因果链，而不是只给结论。
  机制: [
    /原因(?:在于|是|在于)/,
    /根源(?:在于|是)/,
    /机制(?:是|为|在于|上)/,
    /(?:通过|经由|借助)[^。；]{2,40}(?:从而|进而|以此|使得|实现|降低|提升|减少|缩短)/,
    /(?:导致|带来|引起|促使|推动|驱动|决定了|形成了)[^。；]{0,30}/,
    /(?:之所以)[^。；]{2,40}(?:是|在于|因为)/,
    /传导(?:路径|机制|过程)/,
    /(?:因为|由于)[^。；]{4,60}(?:所以|因此|从而|进而)/,
  ],
  // 对比：给参照系，孤立的数字说明不了问题。
  对比: [
    /相比(?:之下|前|后|同类|同行)?/,
    /相较(?:于|之下)?/,
    /(?:与之|与此|和|与)相比/,
    /(?:而|却|反而)[^。；]{2,20}(?:更|仍|并|不|远)/,
    /(?:高于|低于|快于|慢于|优于|不及|落后于|相当于)[^。；]{0,20}/,
    /(?:差距|差值|倍数|占比|基线|基准值|均值|中位数|行业平均|平均水平)/,
    /(?:同类|同行|可比对象|对照组)/,
  ],
  // 边界：说明在什么前提下成立、什么条件下失效。
  边界: [
    /(?:前提|前提是|条件是|假设|前提条件)/,
    /(?:仅|只)(?:适用于|在|当|限)/,
    /(?:在|于)[^。；]{0,24}(?:条件下?|前提下?|情况下?|范围内|之内)[^。；]{0,20}(?:成立|有效|失效|不适用|才|时|而言)/,
    /(?:局限|限制|不适用于|存在边界|适用范围)/,
    /(?:样本(?:为|量|来源|口径)|时间范围|数据口径|统计口径)/,
    /(?:失效|不成立|例外情况|特殊情况)/,
  ],
  // 推进：段与段之间是论证关系，不是并列要点。
  推进: [
    /(?:因此|因而|由此(?:可见|可知|说明))/,
    /(?:进一步|更深一层|接下来|在此基础上|基于(?:上述|这一|前面))/,
    /(?:换言之|也就是说|反过来说|反过来)/,
    /(?:这(?:表明|说明|意味着|恰恰)|说明(?:了)?)/,
    /(?:可见|由此可见|综上)/,
  ],
};

// 空话：出现即扣分。这类句子删掉不影响论证，保留只会稀释密度。
const FILLER_PATTERNS = [
  /随着[^。；]{0,24}(?:的)?(?:发展|进步|深化|推进|普及|成熟)/,
  /具有(?:重要|重大|广阔|良好|积极)(?:的)?(?:意义|价值|影响|作用|前景)/,
  /(?:意义重大|影响深远|前景广阔|效果显著|成效显著|成绩斐然|再上新台阶)/,
  /(?:众所周知|不言而喻|显而易见|毋庸置疑)/,
  /(?:在)?(?:新?(?:时代|背景|形势)下[，,]?)/,
  /(?:大力|深入|全面)(?:推进|加强|开展)[^。；]{0,20}(?:工作|建设|发展)/,
  /(?:本文|本报告|本研究)(?:将|主要)?(?:首先|首先介绍)?[^。；]{0,10}(?:对|针对)[^。；]{0,20}(?:进行分析|进行探讨|展开讨论)/,
  /(?:综上所述|总而言之)[^。；]{0,10}(?:所述|如前)/,
];

// ---------- 基准（按文档类型） ----------
//
// 依据密度要求因文体而异：论文必须逐条有引文，演讲稿与通知根本不需要引用编号。
// 所以门槛按类型给，而不是全局一刀切。
const BASELINES = {
  paper: { minEvidencePerKilo: 1.0, minLayers: 3, allowFiller: 0, requireFigureMention: true },
  bp: { minEvidencePerKilo: 0.8, minLayers: 2, allowFiller: 0, requireFigureMention: false },
  feasibility: { minEvidencePerKilo: 0.8, minLayers: 2, allowFiller: 0, requireFigureMention: false },
  proposal: { minEvidencePerKilo: 0.6, minLayers: 2, allowFiller: 0, requireFigureMention: false },
  bid: { minEvidencePerKilo: 0.4, minLayers: 1, allowFiller: 0, requireFigureMention: false },
  report: { minEvidencePerKilo: 1.0, minLayers: 2, allowFiller: 0, requireFigureMention: false },
  summary: { minEvidencePerKilo: 0.5, minLayers: 1, allowFiller: 0, requireFigureMention: false },
  techdoc: { minEvidencePerKilo: 0.4, minLayers: 2, allowFiller: 0, requireFigureMention: false },
  prd: { minEvidencePerKilo: 0.3, minLayers: 1, allowFiller: 0, requireFigureMention: false },
  policy: { minEvidencePerKilo: 0.0, minLayers: 1, allowFiller: 0, requireFigureMention: false },
  notice: { minEvidencePerKilo: 0.0, minLayers: 1, allowFiller: 0, requireFigureMention: false },
  minutes: { minEvidencePerKilo: 0.0, minLayers: 1, allowFiller: 0, requireFigureMention: false },
  press: { minEvidencePerKilo: 0.3, minLayers: 1, allowFiller: 0, requireFigureMention: false },
  speech: { minEvidencePerKilo: 0.2, minLayers: 1, allowFiller: 1, requireFigureMention: false },
  contract: { minEvidencePerKilo: 0.0, minLayers: 1, allowFiller: 0, requireFigureMention: false },
  custom: { minEvidencePerKilo: 0.3, minLayers: 1, allowFiller: 0, requireFigureMention: false },
};

function baselineOf(docType, depth = 'standard') {
  const base = BASELINES[String(docType || 'custom')] || BASELINES.custom;
  const layerNeed = LAYER_REQUIREMENT[String(depth || 'standard')] || LAYER_REQUIREMENT.standard;
  return {
    ...base,
    // 深度档位对层数的要求可以高于类型默认（论文默认就 3 层，深入档也是 3 层，
    // 但自定义类型可以靠深度档位提高要求）。
    minLayers: Math.max(base.minLayers, layerNeed),
  };
}

// ---------- 检测 ----------
//
// 每项检测都返回 {hit, evidence}：evidence 是正文里触发判断的原句片段。
// 有了片段，作者才能知道「缺的是哪一句」，评审才能指出「第几段缺什么」。

function findLayer(text, layer) {
  const patterns = LAYER_SIGNALS[layer] || [];
  for (const pattern of patterns) {
    const matched = pattern.exec(text);
    if (matched) {
      const at = Math.max(0, matched.index);
      return { hit: true, evidence: text.slice(at, at + 60).trim() };
    }
  }
  return { hit: false, evidence: '' };
}

function countFiller(text) {
  const hits = [];
  for (const pattern of FILLER_PATTERNS) {
    const matched = pattern.exec(text);
    if (matched) hits.push(matched[0].trim());
  }
  return hits;
}

// 引用编号个数（[M1] 形式；不区分大小写）。
function countCitations(text) {
  const matched = String(text || '').match(/\[M\d{1,3}\]/gi);
  return matched ? matched.length : 0;
}

// 段落推进度：相邻两段之间有没有衔接信号。
// 只看段首 40 字与段尾 30 字——衔接词通常在这两个位置。
function countProgressSignals(text) {
  const paragraphs = String(text || '')
    .split(/\n{2,}/)
    .map((item) => String(item).trim())
    .filter((item) => item.length >= 40);
  if (paragraphs.length < 2) return 0;
  let hits = 0;
  for (let i = 1; i < paragraphs.length; i += 1) {
    const head = paragraphs[i].slice(0, 40);
    const tail = paragraphs[i - 1].slice(-30);
    const merged = `${tail}${head}`;
    if (findLayer(merged, '推进').hit) hits += 1;
  }
  return hits;
}

// 论点—证据对应：计划里每个论点（claim）是否在正文里被讲到、并且挂上了依据。
//
// 关键在于「对应」：只看正文有没有出现论点的字面词不够——模型可能把论点换个说法
// 一带而过。这里用二元字组覆盖率判断「这一段确实在讲这个论点」，
// 再看这一段附近有没有引用该论点所依赖的素材编号。
//
// 计划里没有论点（老数据或计划失败）时全部按通过处理，不给假缺陷。
function evaluateClaims(content, plan) {
  // 只认计划里明确声明的 claims。
  //
  // 不用 paragraphs.goal 兜底：goal 往往是「提出本节的核心判断」这类动作描述，
  // 拿它比对正文必然判「没写」，于是每节都被标成缺陷并触发无谓补写。
  // 宁可这条链对老数据不启用，也不要产出假缺陷——假缺陷会让作者去改本来没问题的段落。
  const claims = (Array.isArray(plan && plan.claims) ? plan.claims : [])
    .map((item) => ({
      goal: String(item && item.goal || '').trim(),
      // 素材编号在 materials 里；evidence 是依据的文字说明，不参与编号匹配。
      keys: (Array.isArray(item && item.materials) ? item.materials : [])
        .map((key) => String(key).toUpperCase()),
    }))
    .filter((item) => item.goal);
  if (!claims.length) return { total: 0, covered: 0, missing: [], unlinked: [], ratio: 1 };
  const text = String(content || '');
  const paragraphs = text.split(/\n{2,}/).map((item) => String(item).trim()).filter(Boolean);
  const missing = [];
  const unlinked = [];
  let covered = 0;
  for (const claim of claims) {
    const goal = String(claim && claim.goal || '').trim();
    if (!goal) continue;
    const grams = [...bigrams(goal)];
    if (!grams.length) continue;
    // 找出与该论点最匹配的正文段
    let bestAt = -1;
    let bestScore = 0;
    for (let i = 0; i < paragraphs.length; i += 1) {
      const pg = bigrams(paragraphs[i]);
      const hit = grams.filter((gram) => pg.has(gram)).length;
      const score = hit / grams.length;
      if (score > bestScore) { bestScore = score; bestAt = i; }
    }
    const threshold = Math.max(0.22, Math.min(0.45, grams.length >= 12 ? 0.28 : 0.4));
    if (bestScore < threshold || bestAt < 0) {
      missing.push(goal);
      continue;
    }
    covered += 1;
    // 依据挂载：这一段（或紧邻段）里要出现该论点声明的素材编号
    const keys = Array.isArray(claim.keys) ? claim.keys : [];
    if (!keys.length) continue;
    const window = [bestAt - 1, bestAt, bestAt + 1]
      .filter((i) => i >= 0 && i < paragraphs.length)
      .map((i) => paragraphs[i])
      .join('\n');
    const linked = keys.some((key) => window.toUpperCase().includes(`[${key}]`));
    if (!linked) unlinked.push(goal);
  }
  return {
    total: claims.length,
    covered,
    missing,
    unlinked,
    ratio: claims.length ? covered / claims.length : 1,
  };
}

// 评估一节的质量，给出缺口清单。
//
// 返回结构：
//   score      0~100 的综合分（不是模型自评，是按各基准项算出来的）
//   layers     各论证层的命中情况
//   metrics    客观计数（字数、引用数、每千字依据密度、图表呼应、空话数、论点覆盖）
//   gaps       缺口清单（每条都能落到「缺什么、在哪」）
//   pass       是否达到最低门槛
function evaluateSection(content, { plan = null, docType = 'custom', depth = 'standard',
  hasMaterials = false, figureNos = [], baseline = null } = {}) {
  const text = String(content || '');
  const spec = baseline || baselineOf(docType, depth);
  const chars = text.replace(/\s/g, '').length;
  const kilo = Math.max(1, chars / 1000);

  const layers = {};
  for (const name of LAYER_NAMES) {
    layers[name] = findLayer(text, name);
  }
  const hitLayers = LAYER_NAMES.filter((name) => layers[name].hit);
  const citations = countCitations(text);
  const filler = countFiller(text);
  const progress = countProgressSignals(text);
  const claims = evaluateClaims(text, plan);

  // 图表呼应：正文里提到了几张图。
  let figureMention = 0;
  for (const no of figureNos || []) {
    if (new RegExp(`图\\s*${no}(?!\\d)`).test(text)) figureMention += 1;
  }

  const gaps = [];
  // 论证层数
  if (hitLayers.length < spec.minLayers) {
    const missing = LAYER_NAMES.filter((name) => !layers[name].hit);
    gaps.push({
      code: 'layers',
      level: 'warn',
      // 层数是启发式判断（靠措辞识别），不够硬：它进体检、进评审参考，
      // 但不单独触发重写——误判一次就是一次无谓的整节重写，代价比漏判高。
      force: false,
      text: `论证层数不足（${hitLayers.length}/${spec.minLayers}）：缺 ${missing.slice(0, spec.minLayers - hitLayers.length).join('、')}——`
        + `「${missing[0] || ''}」这一层没有对应的论证动作（机制=说明为什么会这样、对比=给出参照系、边界=说明在什么前提下成立）`,
      detail: missing,
    });
  }
  // 依据密度
  if (hasMaterials && spec.minEvidencePerKilo > 0) {
    const density = citations / kilo;
    if (density < spec.minEvidencePerKilo) {
      gaps.push({
        code: 'evidence-density',
        level: 'warn',
        // 这条是硬信号：素材明明给了，正文一处编号都没有，等于没用手上的依据。
        // 这不是文风问题，是「稿子里的结论没有出处」，值得重写。
        force: true,
        text: `依据密度不足（每千字 ${density.toFixed(2)} 条引用，基准 ${spec.minEvidencePerKilo}）：`
          + '有素材但正文没有把依据标出来——用到哪条素材，就在句末标 [M编号]',
        detail: { density: Number(density.toFixed(2)), need: spec.minEvidencePerKilo },
      });
    }
  }
  // 空话
  if (filler.length > spec.allowFiller) {
    gaps.push({
      code: 'filler',
      level: 'warn',
      // 一处空话不值得重写（可能是引文里的），三处以上就是通篇靠空话撑篇幅。
      force: filler.length >= 3,
      text: `有 ${filler.length} 处空话套话（如「${filler.slice(0, 2).join('」「')}」）——删掉它们不会损失任何论证`,
      detail: filler,
    });
  }
  // 论点—证据对应
  if (claims.total) {
    if (claims.missing.length) {
      gaps.push({
        code: 'claim-missing',
        level: 'warn',
        // 硬信号：段落计划里定好的论点，正文里根本没写。这是「写偏了」，必须重写。
        force: true,
        text: `有 ${claims.missing.length} 个计划论点没有在正文里出现：${claims.missing.slice(0, 2).map((item) => `「${item.slice(0, 24)}」`).join('、')}`
          + '——段落计划里说好的论证动作，正文里没有兑现',
        detail: claims.missing,
      });
    }
    if (claims.unlinked.length) {
      gaps.push({
        code: 'claim-unlinked',
        level: 'info',
        force: false,
        text: `有 ${claims.unlinked.length} 个论点提到了，但没有标出对应的素材编号：`
          + claims.unlinked.slice(0, 2).map((item) => `「${item.slice(0, 24)}」`).join('、')
          + '——结论有依据但读者无法核对',
        detail: claims.unlinked,
      });
    }
  }
  // 图表呼应
  if (spec.requireFigureMention && (figureNos || []).length && figureMention < figureNos.length) {
    gaps.push({
      code: 'figure-mention',
      level: 'info',
      force: false,
      text: `有 ${figureNos.length - figureMention} 张图正文没有提到——投稿要求正文逐一提及图表（如「如图 1 所示」）`,
      detail: { figures: figureNos.length, mentioned: figureMention },
    });
  }

  // 综合分：层数占比 40% + 论点覆盖 25% + 依据密度 20% + 空话惩罚 15%。
  const layerScore = spec.minLayers > 0 ? Math.min(1, hitLayers.length / spec.minLayers) : 1;
  const claimScore = claims.total ? claims.ratio : 1;
  const evidenceScore = spec.minEvidencePerKilo > 0 && hasMaterials
    ? Math.min(1, (citations / kilo) / spec.minEvidencePerKilo)
    : 1;
  const fillerScore = Math.max(0, 1 - filler.length / Math.max(1, Math.max(3, chars / 400)));
  let score = Math.round((layerScore * 0.4 + claimScore * 0.25 + evidenceScore * 0.2 + fillerScore * 0.15) * 100);
  if (score > 100) score = 100;

  return {
    score,
    pass: gaps.filter((gap) => gap.level === 'warn').length === 0,
    // forceGaps：只有高置信缺口才驱动重写（缺依据、缺论点、通篇空话）。
    // 论证层数这类启发式判断只作为提示，不单独触发整节重写——
    // 误判一次就是一次白花钱的整节重写，比漏判更贵。
    forceGaps: gaps.filter((gap) => gap.force),
    layers,
    metrics: {
      chars,
      citations,
      evidenceDensity: Number((citations / kilo).toFixed(2)),
      layerCount: hitLayers.length,
      layerNeed: spec.minLayers,
      filler: filler.length,
      progress,
      figureMention,
      figureTotal: (figureNos || []).length,
      claimTotal: claims.total,
      claimCovered: claims.covered,
    },
    gaps,
  };
}

// 基准文字：写进提示词，作为「写之前就知道要满足什么」。
// 只给可达成的部分——把门槛写成硬指标模型会崩，给出可执行的动作清单才有意义。
function baselineGuide(docType, depth) {
  const spec = baselineOf(docType, depth);
  const need = LAYER_NAMES.slice(0, spec.minLayers);
  const lines = [`【本节质量基准（写完会逐项对照）】`];
  lines.push(`1. 论证层数不少于 ${spec.minLayers} 层，至少覆盖：${need.join('、')}。`
    + '机制=说明为什么会这样（因果链）；对比=给出参照系（与谁比、比什么）；边界=说明在什么前提下成立、什么条件下失效。');
  if (spec.minEvidencePerKilo > 0) {
    lines.push(`2. 依据密度：每千字至少 ${spec.minEvidencePerKilo} 条带编号的依据（形如 [M2]）；`
      + '用到素材里的数据、文献、政策条文，就在句末标出编号，让读者能核对。');
  }
  lines.push(`${spec.minEvidencePerKilo > 0 ? 3 : 2}. 不写空话：「随着…的发展」「具有重要意义」「众所周知」这类句子删掉不损失任何论证。`);
  lines.push('每一条判断都要能被追问「凭什么」——正文里必须给出可核对的依据，或者明确写出依据的边界。');
  return lines.join('\n');
}

// 缺口文字：写进评审提示词与修订提示词，作为「这一稿具体缺什么」。
function gapGuide(evaluation) {
  if (!evaluation || !evaluation.gaps || !evaluation.gaps.length) return '';
  const lines = ['【本次检测到的质量缺口（逐条补上）】'];
  for (const gap of evaluation.gaps) lines.push(`- ${gap.text}`);
  return lines.join('\n');
}

module.exports = {
  BASELINES, LAYER_NAMES, LAYER_REQUIREMENT, LAYER_SIGNALS,
  baselineOf, evaluateSection, evaluateClaims, baselineGuide, gapGuide,
  findLayer, countFiller, countCitations, countProgressSignals,
};
