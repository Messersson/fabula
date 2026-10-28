'use strict';

// 方法论审查：不是挑文笔，是挑「这篇论文的方法站不站得住」。
//
// 两个层次：
// 1. 规则扫描（不调模型、零成本、可复现）：抽样、变量、识别策略、稳健性、局限、伦理
//    有没有写、有没有自相矛盾（用了因果表述却没有识别策略）。
// 2. 模型审查：按同一份清单逐条给结论与修改建议，但只能依据稿子里写了什么，不许猜。
//
// 为什么单独做这件事：写作 rubric 评的是「论证充分/证据密度/无空话」，
// 那是文笔层面；一篇文笔漂亮但用「导致」却没有识别策略的稿子，写作评审会给高分，
// 审稿人会直接拒。这两件事必须分开。

const CHECKLIST = [
  ['question', '研究问题与假设', '研究问题是否明确到可检验；假设是否指向具体的变量关系，而不是「探讨……的影响因素」这类空壳。'],
  ['sample', '抽样与样本量', '抽样方式（随机/分层/便利）、样本量依据、样本代表性；有没有说明为什么是这个规模。'],
  ['measure', '变量测量', '因变量、自变量、控制变量的定义、来源与测量方式；量表/指标是否可复核。'],
  ['identification', '识别策略', '若要下因果结论，必须有反事实设计（随机对照、工具变量、双重差分、断点、倾向得分）。没有就只能是相关性。'],
  ['robustness', '稳健性检验', '替换变量、缩尾、子样本、安慰剂检验、异质性分析——至少做一种，并说明结果是否稳定。'],
  ['endogeneity', '内生性与遗漏变量', '是否讨论反向因果、遗漏变量、样本选择偏差；讨论不了也要写明「未能处理」。'],
  ['ethics', '伦理与数据可得性', '数据来源是否可追溯；涉及人的研究是否说明知情同意与匿名处理。'],
  ['boundary', '结论边界', '结论是否限定在样本与情境之内；有没有把「条件相关」写成「因果效应」。'],
];

// 关键词命中表：只用来判断「有没有写到」，不判断「写得对不对」
const PATTERNS = {
  sample: /样本量|样本数|共\s*\d+\s*[家份位人个]|问卷|访谈|调研了|抽样|随机抽取|分层抽样|便利抽样|滚雪球|整群/,
  sampleSize: /(\d+)\s*[家份位人个]\s*(企业|公司|样本|受访|问卷|机构)/,
  measure: /变量|指标|测量|量表|题项|代理变量|定义/,
  identification: /工具变量|双重差分|DID|断点回归|倾向得分|PSM|随机对照|准实验|自然实验|对照组|处理组|固定效应/,
  robustness: /稳健性|稳健标准误|安慰剂|缩尾|替换|子样本|异质性检验|敏感性分析/,
  endogeneity: /内生性|反向因果|遗漏变量|选择偏差|自选择|同时性/,
  ethics: /伦理|知情同意|匿名|脱敏|数据可得|数据来源|IRB|审查委员会/,
  boundary: /局限|不足|有待|推广需谨慎|不能推广|样本有限|外部效度/,
  // 因果表述：出现这些词又没有任何识别策略，就是「用因果语言讲相关结论」
  causalClaim: /导致|带来|促使|引起|使得.{0,12}(提升|下降|增加|减少)|显著(提升|提高|降低|改善)/,
};

function collectText(project) {
  return (project.sections || [])
    .map((section) => `${section.title}\n${section.content || ''}`)
    .join('\n\n');
}

// 规则扫描：返回问题清单。level=warn 的是「投稿会被直接指出的硬伤」。
function scanMethodology(project) {
  const text = collectText(project);
  const findings = [];
  const has = (key) => PATTERNS[key].test(text);
  const push = (level, code, title, detail) => findings.push({ level, code, title, detail });

  if (!has('sample')) {
    push('warn', 'sample', '没有报告样本与抽样方式',
      '审稿人第一个会问「你的样本是怎么来的」。补一句抽样方式与样本量依据，比多写一段文献更管用。');
  } else if (!PATTERNS.sampleSize.test(text)) {
    push('info', 'sample-size', '样本量没有具体数字',
      '写了抽样方式但没给样本量。具体到「12 家企业」「312 份问卷」才能让读者判断代表性。');
  }
  if (!has('measure')) {
    push('warn', 'measure', '变量测量没有交代',
      '因变量、自变量、控制变量各自的定义与来源必须写清楚，否则结果无法复核。');
  }
  if (!has('identification') && has('causalClaim')) {
    push('warn', 'identification', '用了因果表述，但没有识别策略',
      '稿子里出现「导致/带来/显著提升」这类因果语言，却看不到工具变量、双重差分、随机对照等设计。'
      + '要么补识别策略，要么把表述改成「与……相关」。这是方法论审查里最容易被一票否决的一条。');
  }
  if (!has('identification') && !has('causalClaim')) {
    push('info', 'identification-none', '没有识别策略',
      '通篇没有因果表述，这是诚实的；但审稿人仍会问「为什么不能做因果」。建议在局限一节明确说明。');
  }
  if (!has('robustness')) {
    push('warn', 'robustness', '没有稳健性检验',
      '至少做一种：替换核心变量的度量、缩尾处理、去掉极端样本重跑、或分样本看结果是否稳定。'
      + '一个系数就下结论，审稿人不会接受。');
  }
  if (!has('endogeneity')) {
    push('info', 'endogeneity', '没有讨论内生性',
      '哪怕无法处理，也应写明「可能存在反向因果与遗漏变量，本文未能识别」。主动说出来比被审稿人指出来好。');
  }
  if (!has('boundary')) {
    push('warn', 'boundary', '没有写研究局限',
      '局限一节不是客套。写清样本、时间、测量三方面的限制，反而会增加可信度。');
  }
  if (!has('ethics')) {
    push('info', 'ethics', '没有交代数据来源与伦理',
      '数据从哪来、能否复核、涉及人的部分是否匿名，一句话就能补齐。');
  }
  return { findings, checked: CHECKLIST.length, at: Date.now() };
}

function reviewPrompt(project, scan) {
  const text = collectText(project).slice(0, 16000);
  const list = CHECKLIST.map(([key, name, desc]) => `- ${key}（${name}）：${desc}`).join('\n');
  const rules = scan.findings.map((item) => `- [${item.level}] ${item.title}`).join('\n') || '（规则扫描没有发现问题）';
  const sys = [
    '你是期刊的方法论审稿人（不是文字编辑）。只判断研究设计是否站得住，不评价文笔。',
    '只依据稿件里写了什么下判断：稿件没写的一律记为「未交代」，绝不替作者假设。',
    '每条结论都要指向稿件的具体位置或缺失项，不要写「建议进一步完善」这类空话。',
    '只输出 JSON。',
  ].join('\n');
  const user = [
    `【论文题目】${project.title}`,
    project.thesis ? `【核心主张】${project.thesis}` : '',
    `【审查清单】\n${list}`,
    `【规则扫描已发现的问题】\n${rules}`,
    `【稿件正文】\n${text}`,
    '请逐条判断，输出格式：',
    '{"items":[{"key":"identification","verdict":"pass|weak|fail|missing",'
      + '"comment":"具体判断，指出稿件哪一句支持这个判断，或指出缺了什么",'
      + '"fix":"作者下一步该做什么（一句话，可执行）"}],'
      + '"fatal":["会让审稿人直接拒稿的问题，最多三条"],'
      + '"verdict":"整体判断：这篇稿子的方法部分现在能不能投"}',
    'verdict 的取值只能是 pass（做到了）、weak（写了但不够）、fail（写了但不成立）、missing（完全没写）。',
  ].filter(Boolean).join('\n\n');
  return { sys, user };
}

async function reviewMethodology({ generate, project, scan, onUsage = null }) {
  const { sys, user } = reviewPrompt(project, scan);
  const raw = await generate({ sys, user, onUsage });
  const parsed = extractJson(raw);
  if (!parsed) return null;
  const allowed = new Set(CHECKLIST.map(([key]) => key));
  const items = (Array.isArray(parsed.items) ? parsed.items : [])
    .filter((item) => item && allowed.has(String(item.key || '')))
    .map((item) => ({
      key: String(item.key),
      name: (CHECKLIST.find(([key]) => key === String(item.key)) || [])[1] || String(item.key),
      verdict: ['pass', 'weak', 'fail', 'missing'].includes(item.verdict) ? item.verdict : 'missing',
      comment: String(item.comment || '').trim().slice(0, 300),
      fix: String(item.fix || '').trim().slice(0, 200),
    }));
  const fatal = (Array.isArray(parsed.fatal) ? parsed.fatal : [])
    .map((item) => String(item || '').trim().slice(0, 200)).filter(Boolean).slice(0, 3);
  return {
    items, fatal,
    verdict: String(parsed.verdict || '').trim().slice(0, 300),
    at: Date.now(),
  };
}

// 极简 JSON 提取（与 doc-craft 同逻辑，但这里不引它，避免循环依赖）
function extractJson(text) {
  const raw = String(text || '');
  const open = raw.indexOf('{');
  const close = raw.lastIndexOf('}');
  if (open >= 0 && close > open) {
    try { return JSON.parse(raw.slice(open, close + 1)); } catch { /* 继续尝试整体解析 */ }
  }
  try { return JSON.parse(raw); } catch { return null; }
}

// ---------- 选题体检 ----------
//
// 「这个选题值不值得研究」是编辑和导师的判断，没法完全机械化。但其中有一半是可以拆成
// 可判断条件的：主张可不可证伪、有没有被别人做过、数据拿不拿得到、边界清不清楚、
// 贡献有没有说出口。这些判完，「值不值得」至少有一半答案，剩下的交给作者自己。
//
// 全部是规则判断，不调模型——所以是零成本、可复现的。

const VAGUE_SCOPE = /(中国|全国|全球|整个行业|所有企业|各行各业|普遍存在)/;
const DIRECTION_WORD = /(影响|作用|关系|决定|导致|带来|提升|提高|降低|减少|抑制|促进|正向|负向|显著)/;
const CONTRIBUTION = /(本文(的)?(贡献|创新|边际贡献)|与已有研究(相比|不同)|不同于既有|本文首次|尚未有研究|补充了)/;
const ALTERNATIVE = /(替代解释|其他解释|竞争性解释|也可能是|另一种可能是|不能排除)/;

// 从文本里抠出「像变量」的短语：2~8 个中文字符、不含虚词
function variablePhrases(text) {
  const clean = String(text || '');
  const out = new Set();
  for (const chunk of clean.split(/[，。；、,.;：:（）()【】\[\]“”"'\s]+/)) {
    const trimmed = chunk.trim();
    if (trimmed.length >= 2 && trimmed.length <= 12) out.add(trimmed);
  }
  return out;
}

function checkTopic(project, { matrix = null, datasets = [] } = {}) {
  const thesis = String(project.thesis || '').trim();
  const brief = String(project.brief || '');
  const allText = (project.sections || []).map((section) => section.content || '').join('\n');
  const findings = [];
  const push = (level, code, title, detail) => findings.push({ level, code, title, detail });

  // 1) 主张是否可证伪
  if (!thesis) {
    push('warn', 'no-thesis', '没有写核心主张',
      '「探讨 X 的影响因素」这类题目不可证伪，写出来必然是综述。'
      + '把主张写成一句可以被数据推翻的话：X 越大，Y 越高 / A 组高于 B 组。');
  } else if (!DIRECTION_WORD.test(thesis)) {
    push('warn', 'not-falsifiable', '核心主张里没有方向性判断',
      `当前主张「${thesis.slice(0, 40)}」看不出预期结果是什么。`
      + '补上方向（正向/负向、高/低、显著/不显著），否则无论数据算出什么都「符合预期」，等于没有假设。');
  } else if (thesis.length > 80) {
    push('info', 'thesis-long', '主张太长，可能塞了多个命题',
      '一句主张只回答一个问题。超过 80 字通常是两三个判断叠在一起，拆开后每个都能单独检验。');
  }

  // 2) 边界是否清楚
  const scopeText = `${thesis} ${brief}`;
  if (VAGUE_SCOPE.test(scopeText)) {
    push('warn', 'scope-vague', '研究边界过大',
      '出现「中国」「全国」「所有企业」这类全域表述，但样本通常只有几十个。'
      + '把边界收到你真正有数据的范围（行业 + 地区 + 时间 + 企业规模）。');
  }
  if (!/(年|年度|期间|20\d{2})/.test(scopeText)) {
    push('info', 'no-period', '没有交代研究期间',
      '时间范围决定结论能不能外推。补一句「基于 20XX—20XX 年的数据」。');
  }

  // 3) 是否已被做过（与文献矩阵对照）
  if (matrix && Array.isArray(matrix.items) && matrix.items.length && thesis) {
    const grams = (text) => {
      const clean = String(text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
      const set = new Set();
      for (let i = 0; i + 2 <= clean.length; i += 1) set.add(clean.slice(i, i + 2));
      return set;
    };
    const mine = grams(thesis);
    const overlaps = [];
    for (const item of matrix.items) {
      const theirs = grams(`${item.finding} ${item.title || ''}`);
      if (!mine.size || !theirs.size) continue;
      let hit = 0;
      for (const gram of mine) if (theirs.has(gram)) hit += 1;
      const score = hit / mine.size;
      if (score >= 0.45) overlaps.push({ key: item.key, score, finding: item.finding });
    }
    if (overlaps.length) {
      const top = overlaps.sort((a, b) => b.score - a.score)[0];
      push('warn', 'already-done', `你的主张与 ${overlaps.length} 条已有文献高度重合（最高 ${Math.round(top.score * 100)}%）`,
        `${top.key} 的结论是「${top.finding.slice(0, 50)}」。`
        + '这不是不能做，但必须说清你与它的差别：换样本、换时期、换识别策略，还是推翻它的结论？'
        + '只说「本文也发现了类似结果」，审稿人会问「那为什么还要再做一遍」。');
    } else if (matrix.items.length >= 3) {
      push('info', 'novel-enough', '与已有文献的结论没有明显重合', '这是好事，但要在引言里把「为什么还没有人做」讲清楚。');
    }
  }

  // 4) 数据能不能支撑
  if (datasets.length) {
    const columnNames = datasets.flatMap((item) => (item.columns || []).map((column) => column.name));
    const phrases = variablePhrases(`${thesis} ${brief}`);
    const matched = columnNames.filter((name) => phrases.has(name) || scopeText.includes(name));
    if (!matched.length) {
      push('warn', 'data-mismatch', '主张里的变量与数据表的列对不上',
        `数据表里有：${columnNames.slice(0, 6).join('、')}${columnNames.length > 6 ? '…' : ''}。`
        + '主张里提到的变量如果不在数据里，写完会发现「想检验的东西没有数据」。'
        + '要么改主张，要么补数据。');
    } else {
      push('info', 'data-match', `主张涉及的变量有 ${matched.length} 个在数据里能找到（${matched.slice(0, 4).join('、')}）`, '');
    }
  } else if ((project.docType === 'paper')) {
    push('info', 'no-data', '还没有上传数据表',
      '实证类论文没有数据就只能写综述。到「📊 数据表」上传 CSV，后面跑回归、出三线表都靠它。');
  }

  // 5) 贡献有没有说出口
  if (allText && !CONTRIBUTION.test(allText)) {
    push('warn', 'no-contribution', '没有明确写出「本文贡献是什么」',
      '审稿人第一个问题就是「这篇比已有研究多做了什么」。'
      + '在引言末尾用两三句话写清：新样本、新识别、新机制，或者推翻了哪个既有结论。');
  }

  // 6) 有没有考虑竞争性解释
  if (allText && !ALTERNATIVE.test(allText)) {
    push('info', 'no-alternative', '没有讨论竞争性解释',
      '「投入增加→产值提升」也可以解释为「本来效益好的企业才投得起」。'
      + '主动列出至少一个替代解释并说明为什么排除不掉/怎么排除，是原创性的常见来源。');
  }

  return { findings, at: Date.now() };
}

const VERDICT_TEXT = { pass: '做到', weak: '偏弱', fail: '不成立', missing: '未交代' };

module.exports = {
  CHECKLIST, PATTERNS, scanMethodology, reviewMethodology, VERDICT_TEXT,
  checkTopic, variablePhrases,
};
