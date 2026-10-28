'use strict';

// 素材检索：BM25 + 同义扩展 + 标题加权。
//
// 为什么换掉原来的「裸二元字组计数」：那个算法有三个硬伤，
// 每一个都直接降低成稿质量——
//   1. 没有 IDF：「企业」「进行」「可以」这类高频字组和「回收期」「弹性」权重一样，
//      结果检索出来的总是那些泛泛而谈的段落，真正的数据反而排在后面。
//   2. 没有长度归一：长块天然含更多二元字组，得分虚高，越啰嗦的素材越容易被选中。
//   3. 没有同义扩展：查「回收期」检索不到「投资回报年限」，明明有素材却检索不出来，
//      模型就只能写【待补】——这是「写得空」最主要的成因。
//
// 这里用 BM25（二元字组当词、二值 tf）+ 项目内 IDF + 同义扩展。
// IDF 从当前项目的素材里统计，不需要外部语料；同义词表是内置的领域词表，
// 覆盖学术与公文里的常见替换（回收期/回本、投入/投资、样本/受试者…）。

// ---------- 分词 ----------

// 中文没有空格，二元字组是最实用的近似：够稳、可预期、零依赖。
// 与旧实现的区别：数字也保留（「2023」「128」往往是关键检索词），
// 但会单独降权——纯数字字组的区分度通常不如实词。
function gramsOf(text) {
  const clean = String(text || '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
    .toLowerCase();
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}

function isNumericGram(gram) {
  return /^[0-9]+$/.test(gram);
}

// ---------- 同义扩展 ----------
//
// 不是通用同义词库，只收「检索时经常互相替代」的领域词。
// 每条是一个可互换的词族：查询命中任意一个，整族都作为弱权重候选参与打分。
const SYNONYM_GROUPS = [
  ['回收期', '回本', '投资回收', '回收年限', '回收周期'],
  ['投入', '投资', '支出', '投入产出'],
  ['产值', '产出', '营业收入', '营收', '销售额'],
  ['人均', '人均产值', '劳均'],
  ['样本', '样本量', '受试者', '调查对象', '受访者'],
  ['问卷', '量表', '调查表'],
  ['访谈', '深度访谈', '半结构化访谈'],
  ['回归', '线性回归', '多元回归', '计量'],
  ['显著', '显著性', '统计显著'],
  ['变量', '指标', '测度'],
  ['规模', '体量', '员工数', '人数'],
  ['政策', '文件', '法规', '条例', '办法'],
  ['补贴', '资助', '扶持', '奖补'],
  ['改造', '升级', '转型', '数字化'],
  ['成本', '费用', '开支'],
  ['利润', '净利', '盈利', '毛利'],
  ['现金流', '资金流', '经营现金流'],
  ['融资', '募资', '增资'],
  ['客户', '用户', '客群', '顾客'],
  ['留存', '复购', '续费'],
  ['获客', '拉新', '转化'],
  ['壁垒', '护城河', '竞争优势'],
  ['风险', '不确定性'],
  ['局限', '不足', '缺陷', '边界'],
  ['方法', '研究方法', '研究设计'],
  ['结论', '发现', '结果'],
  ['问题', '痛点', '缺口'],
  ['建议', '对策', '措施'],
  ['预算', '经费', '概算'],
  ['指标', '考核指标', '验收指标'],
  ['违约', '违约责任', '赔偿'],
  ['争议', '纠纷', '仲裁', '诉讼'],
  ['期限', '有效期', '起止'],
];

const SYNONYM_INDEX = (() => {
  const map = new Map();
  for (const group of SYNONYM_GROUPS) {
    for (const word of group) {
      if (!map.has(word)) map.set(word, new Set());
      for (const other of group) map.get(word).add(other);
    }
  }
  return map;
})();

// 把查询扩展成「字组 → 权重」：原查询 1.0，同义扩展 0.45。
// 权重低于 1 是有意的——同义词只是「可能相关」，不能和用户明确写下的词同权。
function expandQuery(queryText) {
  const text = String(queryText || '');
  const weights = new Map();
  const add = (gram, weight) => {
    if (!gram) return;
    weights.set(gram, Math.max(weights.get(gram) || 0, weight));
  };
  for (const gram of gramsOf(text)) add(gram, isNumericGram(gram) ? 0.5 : 1);

  for (const [word, family] of SYNONYM_INDEX) {
    if (!text.includes(word)) continue;
    for (const other of family) {
      for (const gram of gramsOf(other)) {
        if (!weights.has(gram)) add(gram, 0.45);
      }
    }
  }
  return weights;
}

// ---------- IDF ----------
//
// 从当前项目的所有块里统计文档频率。素材只有几条时 IDF 区分度有限，
// 但至少能压掉「企业」「进行」这类在每条素材里都出现的字组——
// 它们正是让检索结果永远泛泛而谈的元凶。
function buildIdf(chunks) {
  const df = new Map();
  for (const chunk of chunks) {
    // 标题字组也要进 IDF：只统计正文时，仅出现在标题里的词（如标题《回收期研究》
    // 而正文没有「回收期」三个字）拿不到 IDF，会被算成 0 分直接漏掉。
    const grams = new Set([...(chunk.grams || []), ...(chunk.titleGrams || [])]);
    for (const gram of grams) df.set(gram, (df.get(gram) || 0) + 1);
  }
  const total = chunks.length || 1;
  const idf = new Map();
  for (const [gram, count] of df) {
    // 平滑 IDF：df 越小权重越高；df 等于总数时仍有下限，不至于完全归零
    idf.set(gram, Math.log(1 + (total - count + 0.5) / (count + 0.5)));
  }
  return idf;
}

// ---------- BM25 ----------

const K1 = 1.2;
const B = 0.75;

// 标题字组与正文字组一起参与打分，标题命中给 1.6 倍权重。
// 早先的写法是「标题只做整体乘数」——但底分为 0 时乘多少还是 0，
// 于是「标题叫《回收期研究》、正文没出现『回收期』三个字」的素材会被完全漏掉。
const TITLE_BOOST = 1.6;

function scoreChunk(chunk, queryWeights, idf, avgLen) {
  let score = 0;
  for (const [gram, weight] of queryWeights) {
    const inBody = chunk.grams.has(gram);
    const inTitle = chunk.titleGrams && chunk.titleGrams.has(gram);
    if (!inBody && !inTitle) continue;
    const gramIdf = idf.get(gram) || 0;
    // 二值 tf 下的 BM25：tf=1 时分子为 (k1+1)，分母含长度归一
    const norm = 1 - B + B * (chunk.length / (avgLen || 1));
    const boost = inTitle ? TITLE_BOOST : 1;
    score += weight * gramIdf * boost * ((K1 + 1) / (1 + K1 * norm));
  }
  return score;
}

// ---------- 主入口 ----------

// chunks: [{ key, materialId, title, text }]
// 返回按相关度排序、已做阈值截断的片段。
function rank(chunks, queryText, { ratio = 0.5, maxChars = 2000, maxItems = 6 } = {}) {
  if (!chunks.length) return [];
  const queryWeights = expandQuery(queryText);
  if (!queryWeights.size) return [];

  const prepared = chunks.map((chunk) => ({
    ...chunk,
    grams: gramsOf(chunk.text),
    titleGrams: gramsOf(chunk.title || ''),
    length: Math.max(1, String(chunk.text).replace(/\s/g, '').length),
  }));
  const avgLen = prepared.reduce((sum, item) => sum + item.length, 0) / prepared.length;
  const idf = buildIdf(prepared);

  const scored = prepared.map((chunk) => ({
    ...chunk,
    score: scoreChunk(chunk, queryWeights, idf, avgLen),
  }));

  const best = scored.reduce((max, item) => Math.max(max, item.score), 0);
  if (best <= 0) return [];
  // 归一化到 0~1 后再按相对比例截断：绝对分数会随查询长度变化，
  // 用比例才在不同小节之间可比。
  for (const item of scored) item.normalized = item.score / best;
  scored.sort((a, b) => b.score - a.score);

  const picked = [];
  let used = 0;
  for (const item of scored) {
    if (item.normalized < ratio) break;
    if (picked.length && used + item.text.length > maxChars) break;
    picked.push(item);
    used += item.text.length;
    if (picked.length >= maxItems) break;
  }
  // 一条都没过阈值（素材与本节确实无关）时，退一步给最高分那一条：
  // 完全不给素材，模型就会开始编；给一条弱相关的，至少能约束术语与口径。
  if (!picked.length) picked.push(scored[0]);
  return picked;
}

module.exports = {
  gramsOf, expandQuery, buildIdf, scoreChunk, rank, TITLE_BOOST,
  SYNONYM_GROUPS, SYNONYM_INDEX, K1, B, isNumericGram,
};
