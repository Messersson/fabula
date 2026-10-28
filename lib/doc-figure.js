'use strict';

// 图表：论文/BP/申报书要「图文并茂」，纯文字稿交不出去。
//
// 三条输出路径，同一份 spec：
// - 页面：内联 SVG（矢量、可缩放、不依赖任何图片服务）
// - Word：原生 DrawingML 图表（矢量、可编辑、不用图片、不引第三方库）
// - Markdown：降级为表格 + 题注（MD 本身没有图表语法，硬塞图片反而更难改）
//
// 图型（比「柱/线/饼」三选一更贴论文实际需要）：
//   bar     类目对比（可分组可堆叠）
//   line    趋势（可多条、可加误差带）
//   pie     构成占比
//   scatter 散点（两列数值 + 可选回归线）——论文里最常用的一张图
//   hist    分布直方图（单列数值的频数分布）
//   errorbar 带误差线的类目对比（均值 ± 标准误/标准差）
//
// 质量要求（这几条是「图表像论文图表」与「像玩具图表」的分界）：
//   1. 坐标轴要有名称与单位，否则读者不知道横轴是什么
//   2. 数值标签要能读，但不能糊满图
//   3. 配色要色盲友好且成体系（同一份稿子里所有图共用一套）
//   4. 纵轴柱状图必须从 0 起；折线/散点允许截断但要标注
//   5. 图要有题注、单位与资料来源

const MAX_CATEGORIES = 12;
const MAX_SERIES = 4;

// 色盲友好配色（Okabe-Ito）：蓝、橙、青、红、绿、紫、黄、灰。
// 之前用的是网页蓝橙红紫，红绿对色觉障碍读者不可分。
const PALETTE = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#F0E442', '#7F7F7F'];

const SVG_W = 640;
const SVG_H = 360;
const PAD = { top: 46, right: 24, bottom: 56, left: 64 };

// 各图型能画多少个类目：散点/直方图不受类目数限制
function maxCategoriesFor(type) {
  return type === 'scatter' || type === 'hist' ? 500 : MAX_CATEGORIES;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value == null ? '' : value).replace(/[,，\s%]/g, '');
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function shortText(value, max = 40) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

const FIGURE_TYPES = ['bar', 'line', 'pie', 'scatter', 'hist', 'errorbar'];

// 图表修饰项：不改变图型，只改变画法。
//   stacked  堆叠（构成随时间怎么变）
//   percent  百分比堆叠（各组构成对比，忽略绝对量差异）
//   logY     纵轴取对数（数量级差很多时，线性轴会把小值全压成一条线）
// 这三项在论文里出现频率很高，但之前只能靠「柱/线」硬凑。
function modifiersOf(raw) {
  const grouping = String(raw.grouping || raw.stack || '').toLowerCase();
  const percent = grouping === 'stacked100' || grouping === 'percent' || raw.percent === true;
  const stacked = percent || raw.stacked === true || grouping === 'stacked';
  return {
    stacked,
    percent,
    logY: raw.logY === true || raw.logAxis === true || raw.yLog === true,
  };
}

// 线性回归的完整统计量：斜率、截距、R²、残差标准误、均值响应置信带。
// 论文里的散点图必须给出 R² 与样本量——只有一条拟合线读者无法判断这个关系可不可信。
function regressionStats(points) {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (const point of points) { sx += point.x; sy += point.y; }
  const meanX = sx / n;
  const meanY = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (!sxx) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = syy ? (sxy * sxy) / (sxx * syy) : 0;
  // 残差标准误（回归的标准误）：分母 n-2 是无偏估计
  let sse = 0;
  for (const point of points) {
    const predicted = intercept + slope * point.x;
    sse += (point.y - predicted) ** 2;
  }
  const se = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
  // t 临界值：n>30 时用 1.96 足够；小样本用近似表，避免为一个数引统计库
  const tTable = { 3: 12.71, 4: 4.30, 5: 3.18, 6: 2.78, 7: 2.57, 8: 2.45, 9: 2.36, 10: 2.26, 12: 2.20, 15: 2.13, 20: 2.09, 25: 2.06, 30: 2.04 };
  const t = n > 30 ? 1.96 : (tTable[n] || 2.0);
  return { n, slope, intercept, r2, se, sxx, meanX, t };
}

// 均值响应的 95% 置信带半宽：se * t * sqrt(1/n + (x-x̄)²/Sxx)
function ciHalfWidth(stats, x) {
  if (!stats || !(stats.se > 0)) return 0;
  return stats.t * stats.se * Math.sqrt(1 / stats.n + ((x - stats.meanX) ** 2) / stats.sxx);
}


// 校验并归一化。模型给的东西不能直接信：类型、条数、数值都要夹一遍。
function normalizeFigure(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const type = FIGURE_TYPES.includes(raw.type) ? raw.type : 'bar';
  const mods = modifiersOf(raw);
  const maxCat = maxCategoriesFor(type);
  const categories = (Array.isArray(raw.categories) ? raw.categories : [])
    .map((item) => shortText(item, 24)).filter(Boolean).slice(0, maxCat);
  // 散点图的 y 允许写成 ys 或 values；两者都要认，否则 series 会在下面的
  // 「有没有数值」过滤里被整条丢掉，散点图直接变成 null。
  const series = (Array.isArray(raw.series) ? raw.series : []).slice(0, MAX_SERIES).map((item, order) => {
    const ys = Array.isArray(item && item.ys) ? item.ys
      : (Array.isArray(item && item.values) ? item.values : []);
    return {
      name: shortText(item && item.name, 30) || `系列 ${order + 1}`,
      values: ys.map(toNumber),
      xs: (Array.isArray(item && item.xs) ? item.xs : []).map(toNumber),
    };
  }).filter((item) => item.values.some((value) => value != null) || item.xs.some((value) => value != null));
  if (!series.length && !(type === 'scatter' && Array.isArray(raw.points) && raw.points.length)) return null;

  // 散点图：x 与 y 成对。允许两种写法：
  //   series:[{name,xs:[...],ys:[...]}]
  //   categories 是 x 标签、values 是 y
  if (type === 'scatter') {
    // 已经归一化过的 spec 会被 figureSvg 再归一化一次：这时 series 只剩 values，
    // xs 已经并进 points。不认 points 的话，页面上的散点图会渲染成空白。
    const points = [];
    if (Array.isArray(raw.points) && raw.points.length) {
      for (const point of raw.points) {
        const x = toNumber(point && point.x);
        const y = toNumber(point && point.y);
        if (x == null || y == null) continue;
        points.push({ x, y, series: Number(point && point.series) || 0 });
      }
    } else {
      series.forEach((item, si) => {
        const xs = Array.isArray(item.xs) ? item.xs.map(toNumber) : [];
        const ys = item.values;
        const len = Math.min(xs.length, ys.length);
        for (let i = 0; i < len; i++) {
          if (xs[i] == null || ys[i] == null) continue;
          points.push({ x: xs[i], y: ys[i], series: si });
        }
      });
    }
    if (!points.length) return null;
    return {
      no: Number(index) + 1,
      type,
      ...mods,
      title: shortText(raw.title, 60) || `图 ${Number(index) + 1}`,
      unit: shortText(raw.unit, 12),
      note: shortText(raw.note, 120),
      xLabel: shortText(raw.xLabel, 30),
      yLabel: shortText(raw.yLabel, 30),
      // 拟合线：论文里散点图不带回归线等于半张图
      fit: raw.fit === false ? null : (raw.fit || {}),
      // R²、样本量、残差标准误：由代码算，不信模型给的数
      stats: regressionStats(points),
      points,
      series: series.map((item, si) => ({
        name: item.name,
        values: points.filter((p) => p.series === si).map((p) => p.y),
      })),
      categories: [],
    };
  }

  // 直方图：单列数值 → 自动分箱
  if (type === 'hist') {
    const values = series.flatMap((item) => item.values).filter((value) => value != null);
    if (values.length < 3) return null;
    const bins = Math.max(4, Math.min(15, Math.round(Math.sqrt(values.length))));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const width = max - min || 1;
    const counts = new Array(bins).fill(0);
    for (const value of values) {
      const pos = Math.min(bins - 1, Math.floor(((value - min) / width) * bins));
      counts[pos] += 1;
    }
    const step = width / bins;
    const cats = counts.map((count, i) => {
      const lo = min + step * i;
      const hi = lo + step;
      return `${formatTick(lo)}~${formatTick(hi)}`;
    });
    return {
      no: Number(index) + 1,
      type,
      ...mods,
      title: shortText(raw.title, 60) || `图 ${Number(index) + 1}`,
      unit: shortText(raw.unit, 12),
      note: shortText(raw.note, 120),
      xLabel: shortText(raw.xLabel, 30),
      yLabel: shortText(raw.yLabel, 30) || '频数',
      categories: cats,
      series: [{ name: series[0].name || '频数', values: counts }],
    };
  }

  // 饼图只取第一个系列；柱/线要求每个系列与类目对齐（缺的补 0）
  const width = categories.length || Math.max(...series.map((item) => item.values.length));
  if (!width) return null;
  if (!categories.length) for (let i = 0; i < width; i++) categories.push(`第${i + 1}项`);
  for (const item of series) {
    while (item.values.length < categories.length) item.values.push(0);
    item.values = item.values.slice(0, categories.length);
  }
  const list = type === 'pie' ? [series[0]] : series;
  return {
    no: Number(index) + 1,
    type,
    ...mods,
    title: shortText(raw.title, 60) || `图 ${Number(index) + 1}`,
    unit: shortText(raw.unit, 12),
    note: shortText(raw.note, 120),
    xLabel: shortText(raw.xLabel, 30),
    yLabel: shortText(raw.yLabel, 30),
    // 误差线：errorbar 专用，每个类目一个 ± 值
    errors: Array.isArray(raw.errors) ? raw.errors.map(toNumber) : null,
    // 置信带：折线图专用，每个类目一个 ± 值（画成阴影带）
    band: Array.isArray(raw.band) ? raw.band.map(toNumber) : null,
    categories,
    series: list,
  };
}

function normalizeFigures(rawList) {
  if (!Array.isArray(rawList)) return [];
  // 每节最多两张由计划阶段控制，这里只挡住「一篇文章几百张图」这种失控输入。
  return rawList.map((item, index) => normalizeFigure(item, index)).filter(Boolean).slice(0, 12);
}

// ---------- 数值刻度 ----------

// 刻度值取整到好读的数（0.35 → 0.4 之类）
function formatTick(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  const abs = Math.abs(num);
  if (abs >= 10000) return `${Math.round(num / 100) / 100}k`;
  if (abs >= 100) return String(Math.round(num));
  if (abs >= 10) return String(Math.round(num * 10) / 10);
  if (abs >= 1) return String(Math.round(num * 100) / 100);
  return String(Math.round(num * 1000) / 1000);
}

function ticks(max, count = 4) {
  const step = max / count;
  return Array.from({ length: count + 1 }, (_, i) => Math.round(step * i * 100) / 100);
}

// 纵轴刻度：先定「好读的步长」，再把上界向上取整到步长的整数倍。
// 直接按 max/4 等分会出现 625、1875 这种刻度，读者要在脑子里做除法。
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const exponent = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exponent);
  const scaled = raw / base;
  const step = NICE_STEPS.find((candidate) => scaled <= candidate) || 10;
  return step * base;
}

function axisScale(rawMax, count = 4) {
  const step = niceStep(Math.max(rawMax, 1) / count);
  const upper = Math.ceil(Math.max(rawMax, 1) / step) * step;
  const values = [];
  for (let value = 0; value <= upper + step * 1e-6; value += step) {
    values.push(Math.round(value * 1e6) / 1e6);
  }
  return { upper, values };
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '';
  if (Math.abs(value) >= 10000) return `${Math.round(value / 1000) / 10}k`;
  return String(Math.round(value * 100) / 100);
}

function esc(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- 页面：SVG ----------

// 坐标轴名称（横轴在下方、纵轴在左侧旋转 90°）。没有轴名的图读者看不懂。
function axisLabels(spec, pad) {
  const parts = [];
  if (spec.xLabel) {
    parts.push(`<text x="${(SVG_W / 2).toFixed(1)}" y="${SVG_H - 8}" text-anchor="middle" font-size="11.5" fill="#5f6672">${esc(spec.xLabel)}</text>`);
  }
  if (spec.yLabel) {
    parts.push(`<text transform="translate(13, ${(pad.top + (SVG_H - pad.top - pad.bottom) / 2).toFixed(1)}) rotate(-90)" text-anchor="middle" font-size="11.5" fill="#5f6672">${esc(spec.yLabel)}</text>`);
  }
  return parts.join('');
}

function svgBarOrLine(spec, pad) {
  const plotW = SVG_W - pad.left - pad.right;
  const plotH = SVG_H - pad.top - pad.bottom;
  const cats = spec.categories;
  const count = cats.length;
  const useStack = !!spec.stacked;
  const isPercent = !!spec.percent;
  const series = spec.series;
  const errors = spec.errors || [];

  // 百分比堆叠：先把每个类目归一到 100，再按普通堆叠画。
  // 直接画原始值的话，「占比结构」这个诉求根本表达不出来。
  let values = series.map((item) => item.values.map((v) => (v == null ? 0 : Number(v))));
  if (isPercent) {
    values = series.map(() => new Array(count).fill(0));
    for (let ci = 0; ci < count; ci++) {
      const total = series.reduce((sum, item) => sum + Math.max(0, Number(item.values[ci]) || 0), 0);
      series.forEach((item, si) => {
        values[si][ci] = total ? (Math.max(0, Number(item.values[ci]) || 0) / total) * 100 : 0;
      });
    }
  }

  // 纵轴上界：堆叠看「每列之和」，分组看「最大单值」。
  // 之前一律按最大单值算，堆叠柱会直接冲出画布。
  const columnTop = Array.from({ length: count }, (_, ci) => (useStack
    ? values.reduce((sum, arr) => sum + Math.max(0, arr[ci] || 0), 0)
    : Math.max(...values.map((arr) => Math.max(0, arr[ci] || 0)), 0)));
  const rawMax = Math.max(...columnTop, isPercent ? 100 : 0, 1);

  // 对数轴：只有折线能安全用（柱状从 0 起，log(0) 无定义）。
  // 数量级差 2 个以上时，线性轴会把小值压成贴地的一条线，看不出趋势。
  const useLog = !!spec.logY && spec.type === 'line';
  const positives = values.flat().filter((v) => v > 0);
  const logLo = useLog && positives.length ? Math.min(...positives) : 1;
  const logHi = useLog && positives.length ? Math.max(...positives) : 10;

  const hasError = !useStack && errors.some((value) => value != null && value > 0);
  const scaleTarget = hasError
    ? Math.max(...values.map((arr) => Math.max(...arr.map((value, ci) => Math.max(0, value) + (errors[ci] || 0)))), 1)
    : (isPercent ? 100 : rawMax);
  const scale = axisScale(scaleTarget, 4);
  const upper = scale.upper;

  const toY = (value) => {
    if (useLog) {
      const lo = Math.log10(logLo) - 0.12;
      const hi = Math.log10(logHi) + 0.12;
      return pad.top + plotH - ((Math.log10(Math.max(value, logLo * 0.5)) - lo) / (hi - lo)) * plotH;
    }
    return pad.top + plotH - (value / upper) * plotH;
  };

  // 网格与刻度
  let gridValues;
  if (useLog) {
    gridValues = [];
    for (let e = Math.floor(Math.log10(logLo)); e <= Math.ceil(Math.log10(logHi)); e++) {
      for (const m of [1, 2, 5]) {
        const value = m * Math.pow(10, e);
        if (value >= logLo * 0.9 && value <= logHi * 1.1) gridValues.push(value);
      }
    }
  } else {
    gridValues = scale.values;
  }
  const gridLines = gridValues.map((value) => {
    const y = toY(value);
    return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${pad.left + plotW}" y2="${y.toFixed(1)}" stroke="#eceef2" stroke-width="1"/>`
      + `<text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#70757d">${esc(isPercent ? `${formatTick(value)}%` : formatTick(value))}</text>`;
  }).join('');

  const band = plotW / count;
  // 堆叠时一根柱子占满整条带；分组时按系列数平分
  const barW = useStack
    ? Math.max(6, Math.min(46, band * 0.62))
    : Math.max(6, Math.min(34, (band * 0.62) / series.length));
  const cxOf = (ci) => pad.left + band * ci + band / 2;

  // 标签只在点数不多时画：12 个以上数字会糊满图，反而看不出趋势
  const showLabels = count * series.length <= 12 && !isPercent;

  const bars = [];
  if (spec.type === 'bar' || spec.type === 'errorbar' || spec.type === 'hist') {
    const zeroY = toY(0);
    for (let si = 0; si < series.length; si++) {
      const color = PALETTE[si % PALETTE.length];
      for (let ci = 0; ci < count; ci++) {
        const value = Math.max(0, values[si][ci]);
        if (!value) continue;
        let yTop;
        let yBottom;
        let x;
        if (useStack) {
          const base = values.slice(0, si).reduce((sum, arr) => sum + Math.max(0, arr[ci] || 0), 0);
          yTop = toY(base + value);
          yBottom = toY(base);
          x = cxOf(ci) - barW / 2;
        } else {
          yTop = toY(value);
          yBottom = zeroY;
          x = cxOf(ci) - (barW * series.length) / 2 + si * barW;
        }
        const height = Math.max(1, yBottom - yTop);
        bars.push(`<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${height.toFixed(1)}"`
          + ` fill="${color}" rx="1.5"/>`);
        // 误差线只在非堆叠时有意义（堆叠的误差不是简单相加）
        const err = errors[ci];
        if (!useStack && spec.type === 'errorbar' && err != null && err > 0) {
          const top = toY(value + err);
          const bottom = toY(Math.max(0, value - err));
          const mx = x + barW / 2;
          bars.push(`<line x1="${mx.toFixed(1)}" y1="${top.toFixed(1)}" x2="${mx.toFixed(1)}" y2="${bottom.toFixed(1)}" stroke="#3c4043" stroke-width="1.2"/>`
            + `<line x1="${(mx - 4).toFixed(1)}" y1="${top.toFixed(1)}" x2="${(mx + 4).toFixed(1)}" y2="${top.toFixed(1)}" stroke="#3c4043" stroke-width="1.2"/>`
            + `<line x1="${(mx - 4).toFixed(1)}" y1="${bottom.toFixed(1)}" x2="${(mx + 4).toFixed(1)}" y2="${bottom.toFixed(1)}" stroke="#3c4043" stroke-width="1.2"/>`);
        }
        if (showLabels) {
          // 堆叠里的小段放不下数字，放进去只会压线
          const inside = useStack && height > 16;
          const labelY = inside ? yTop + 13 : yTop - 5;
          bars.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-size="10"`
            + ` fill="${inside ? '#ffffff' : '#3c4043'}">${esc(formatNumber(value))}</text>`);
        }
      }
    }
  }

  // 折线：可带置信带（band），带子先画在线的下面。
  // 只给 line 画连线——errorbar 是「各组均值对比」，连成折线会暗示一个不存在的趋势。
  const lines = [];
  if (spec.type === 'line') {
    for (let si = 0; si < series.length; si++) {
      const color = PALETTE[si % PALETTE.length];
      const pts = values[si].map((value, ci) => [cxOf(ci), toY(Math.max(0, value))]);
      const bandValues = spec.band || null;
      if (bandValues && bandValues.some((v) => v != null && v > 0)) {
        const upperPts = values[si].map((value, ci) => `${cxOf(ci).toFixed(1)} ${toY(Math.max(0, value) + (bandValues[ci] || 0)).toFixed(1)}`);
        const lowerPts = values[si].map((value, ci) => `${cxOf(ci).toFixed(1)} ${toY(Math.max(0, value) - (bandValues[ci] || 0)).toFixed(1)}`).reverse();
        lines.push(`<path d="M${upperPts.join(' L')} L${lowerPts.join(' L')} Z" fill="${color}" fill-opacity="0.16" stroke="none"/>`);
      }
      const path = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
      lines.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="2.1" stroke-linejoin="round" stroke-linecap="round"/>`
        + pts.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#fff" stroke="${color}" stroke-width="1.9"/>`).join(''));
    }
  }

  // 类目标签：长标签要旋转，否则互相压字
  const labels = cats.map((name, ci) => {
    const x = cxOf(ci);
    const text = shortText(name, 10);
    const long = text.length > 5 || count > 8;
    return long
      ? `<text transform="translate(${x.toFixed(1)}, ${(SVG_H - pad.bottom + 18).toFixed(1)}) rotate(-35)" text-anchor="end" font-size="10.5" fill="#3c4043">${esc(text)}</text>`
      : `<text x="${x.toFixed(1)}" y="${SVG_H - pad.bottom + 20}" text-anchor="middle" font-size="11" fill="#3c4043">${esc(text)}</text>`;
  }).join('');

  const legend = series.length > 1
    ? `<g>${series.map((item, si) => `<g transform="translate(${pad.left + si * 118}, 22)"><rect width="10" height="10" rx="2" fill="${PALETTE[si % PALETTE.length]}"/><text x="15" y="9" font-size="11" fill="#3c4043">${esc(shortText(item.name, 9))}</text></g>`).join('')}</g>`
    : '';
  // 轴：加短刻度线，图看起来才像论文插图而不是网页组件
  const tickMarks = gridValues.map((value) => {
    const y = toY(value);
    return `<line x1="${pad.left - 4}" y1="${y.toFixed(1)}" x2="${pad.left}" y2="${y.toFixed(1)}" stroke="#c8cdd4"/>`;
  }).join('');
  const axis = `<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" stroke="#9aa1a9" stroke-width="1.1"/>`
    + `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#9aa1a9" stroke-width="1.1"/>`;
  const stackNote = useStack
    ? `<text x="${pad.left + plotW}" y="${pad.top - 8}" text-anchor="end" font-size="10" fill="#9aa1a9">${isPercent ? '百分比堆叠' : '堆叠'}</text>`
    : '';
  const logNote = useLog
    ? `<text x="${pad.left + plotW}" y="${pad.top - 8}" text-anchor="end" font-size="10" fill="#9aa1a9">纵轴对数刻度</text>`
    : '';
  return gridLines + tickMarks + axis + bars.join('') + lines.join('') + labels + legend + stackNote + logNote + axisLabels(spec, pad);
}

// 散点图 + 最小二乘拟合线。
// 论文里的散点图不带回归线等于半张图：读者要自己判断有没有相关性。
function svgScatter(spec, pad) {
  const plotW = SVG_W - pad.left - pad.right;
  const plotH = SVG_H - pad.top - pad.bottom;
  const points = spec.points || [];
  if (!points.length) return '';
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const padX = (maxX - minX || 1) * 0.08;
  const padY = (maxY - minY || 1) * 0.12;
  const loX = minX - padX;
  const hiX = maxX + padX;
  const loY = minY - padY;
  const hiY = maxY + padY;
  const sx = (value) => pad.left + ((value - loX) / (hiX - loX || 1)) * plotW;
  const sy = (value) => pad.top + plotH - ((value - loY) / (hiY - loY || 1)) * plotH;
  const gridLines = ticks(hiY - loY, 4).map((offset) => {
    const value = loY + offset;
    const y = sy(value);
    return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${pad.left + plotW}" y2="${y.toFixed(1)}" stroke="#e8eaee"/>`
      + `<text x="${pad.left - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#70757d">${esc(formatTick(value))}</text>`;
  }).join('');
  // 最小二乘（复用回归统计量，R² 与置信带都用同一份结果，不会互相矛盾）
  const stats = spec.stats || regressionStats(points);
  const fitLine = stats
    ? `<line x1="${sx(loX).toFixed(1)}" y1="${sy(stats.intercept + stats.slope * loX).toFixed(1)}" x2="${sx(hiX).toFixed(1)}" y2="${sy(stats.intercept + stats.slope * hiX).toFixed(1)}" stroke="#D55E00" stroke-width="1.6" stroke-dasharray="6 4"/>`
    : '';
  // 95% 置信带：只有一条拟合线、没有不确定性范围的散点图，读者无法判断这个关系稳不稳。
  const bandPath = (() => {
    if (!stats || !(stats.se > 0)) return '';
    const steps = 24;
    const top = [];
    const bottom = [];
    for (let i = 0; i <= steps; i++) {
      const x = loX + ((hiX - loX) * i) / steps;
      const y = stats.intercept + stats.slope * x;
      const half = ciHalfWidth(stats, x);
      top.push(`${sx(x).toFixed(1)} ${sy(y + half).toFixed(1)}`);
      bottom.push(`${sx(x).toFixed(1)} ${sy(y - half).toFixed(1)}`);
    }
    return `<path d="M${top.join(' L')} L${bottom.reverse().join(' L')} Z" fill="#D55E00" fill-opacity="0.13" stroke="none"/>`;
  })();
  const dots = points.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3.2" fill="${PALETTE[p.series % PALETTE.length]}" fill-opacity="0.7" stroke="#fff" stroke-width="0.7"/>`).join('');
  const axis = `<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" stroke="#9aa1a9" stroke-width="1.1"/>`
    + `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#9aa1a9" stroke-width="1.1"/>`;
  const legend = spec.series.length > 1
    ? `<g>${spec.series.map((item, si) => `<g transform="translate(${pad.left + si * 118}, 22)"><rect width="10" height="10" rx="2" fill="${PALETTE[si % PALETTE.length]}"/><text x="15" y="9" font-size="11" fill="#3c4043">${esc(shortText(item.name, 9))}</text></g>`).join('')}</g>`
    : `<g transform="translate(${pad.left}, 22)"><line x1="0" y1="5" x2="16" y2="5" stroke="#D55E00" stroke-width="1.6" stroke-dasharray="6 4"/><text x="21" y="9" font-size="11" fill="#3c4043">拟合线（95% 置信带）</text></g>`;
  // 回归方程 + R² + n：审稿人看散点图第一眼找的就是这三个数
  const equation = stats
    ? `<text x="${pad.left + plotW}" y="${pad.top + 14}" text-anchor="end" font-size="10.5" fill="#4a5058">`
      + `y = ${esc(formatTick(stats.slope))}x ${stats.intercept >= 0 ? '+' : '−'} ${esc(formatTick(Math.abs(stats.intercept)))}`
      + `　R² = ${esc(stats.r2.toFixed(3))}　n = ${stats.n}</text>`
    : '';
  return gridLines + axis + bandPath + fitLine + dots + legend + equation + axisLabels(spec, pad);
}

function svgPie(spec, pad) {
  const series = spec.series[0];
  const total = series.values.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  const cx = 200;
  const cy = pad.top + (SVG_H - pad.top - pad.bottom) / 2;
  const r = Math.min(118, (SVG_H - pad.top - pad.bottom) / 2 - 6);
  let angle = -Math.PI / 2;
  const slices = series.values.map((value, index) => {
    const sweep = (Math.max(0, value) / total) * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    angle += sweep;
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    const mid = angle - sweep / 2;
    const lx = cx + (r * 0.66) * Math.cos(mid);
    const ly = cy + (r * 0.66) * Math.sin(mid);
    const percent = Math.round((value / total) * 100);
    return `<path d="M${cx} ${cy} L${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} Z"`
      + ` fill="${PALETTE[index % PALETTE.length]}" stroke="#fff" stroke-width="1.5"/>`
      + (percent >= 6 ? `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle" font-size="11" fill="#fff">${percent}%</text>` : '');
  }).join('');
  const legend = spec.categories.map((name, index) => {
    const y = pad.top + 18 + index * 24;
    return `<g transform="translate(392, ${y})"><rect width="10" height="10" rx="2" fill="${PALETTE[index % PALETTE.length]}"/>`
      + `<text x="16" y="9" font-size="11.5" fill="#3c4043">${esc(shortText(name, 12))}　${esc(formatNumber(series.values[index]))}（${Math.round((series.values[index] / total) * 100)}%）</text></g>`;
  }).join('');
  return slices + legend;
}

// 页面上图表下面还有 HTML 题注（图 1　标题 + 资料来源），所以 SVG 里默认不再重复画标题。
function figureSvg(rawSpec, options = {}) {
  const spec = normalizeFigure(rawSpec, 0);
  if (!spec) return '';
  const showTitle = options.showTitle !== false;
  const pad = showTitle ? PAD : { ...PAD, top: 18 };
  let inner = '';
  if (spec.type === 'pie') inner = svgPie(spec, pad);
  else if (spec.type === 'scatter') inner = svgScatter(spec, pad);
  else inner = svgBarOrLine(spec, pad);
  const unit = spec.unit
    ? `<text x="${SVG_W - pad.right}" y="${showTitle ? 22 : 14}" text-anchor="end" font-size="10.5" fill="#9aa1a9">单位：${esc(spec.unit)}</text>`
    : '';
  const title = showTitle
    ? `<text x="${pad.left}" y="22" font-size="13" font-weight="700" fill="#202124">${esc(spec.title)}</text>`
    : '';
  return `<svg viewBox="0 0 ${SVG_W} ${SVG_H}" width="100%" role="img" aria-label="${esc(spec.title)}" style="max-width:${SVG_W}px;height:auto;display:block">`
    + `${title}${unit}${inner}</svg>`;
}

// ---------- Markdown：表格 + 题注 ----------

function figureMarkdown(spec) {
  const head = `| ${['类目', ...spec.series.map((item) => item.name)].join(' | ')} |`;
  const divider = `| ${['---', ...spec.series.map(() => '---')].join(' | ')} |`;
  const rows = spec.categories.map((name, ci) =>
    `| ${[name, ...spec.series.map((item) => formatNumber(item.values[ci]))].join(' | ')} |`);
  const caption = `**图${spec.no}　${spec.title}**${spec.unit ? `（单位：${spec.unit}）` : ''}`;
  const note = spec.note ? `\n> 资料来源：${spec.note}` : '';
  return [caption, '', head, divider, ...rows].join('\n') + note;
}

// ---------- Word：原生 DrawingML 图表 ----------

function chartCache(values, numeric) {
  const points = values.map((value, index) => numeric
    ? `<c:pt idx="${index}"><c:v>${Number(value) || 0}</c:v></c:pt>`
    : `<c:pt idx="${index}"><c:v>${esc(value)}</c:v></c:pt>`).join('');
  const cache = numeric
    ? `<c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${points}`
    : `<c:ptCount val="${values.length}"/>${points}`;
  return { points: cache };
}

function seriesXml(item, index, spec, { perPoint = false, percent = false, showValue = false, errorBars = null } = {}) {
  const catRef = `Sheet1!$A$2:$A$${spec.categories.length + 1}`;
  const valRef = `Sheet1!$${String.fromCharCode(66 + index)}$2:$${String.fromCharCode(66 + index)}$${spec.categories.length + 1}`;
  const cat = chartCache(spec.categories, false).points;
  const val = chartCache(item.values, true).points;
  const color = (i) => PALETTE[i % PALETTE.length].replace('#', '').toUpperCase();
  // 饼图的扇区要逐点上色（c:dPt）。如果只给系列一个 solidFill，varyColors 会被盖掉，
  // 整张饼图会渲染成一个纯色圆——所有扇区同色，等于没有信息量。
  const shape = perPoint
    ? spec.categories.map((_, ci) => `<c:dPt><c:idx val="${ci}"/><c:invertIfNegative val="0"/><c:bubble3D val="0"/>`
      + `<c:spPr><a:solidFill><a:srgbClr val="${color(ci)}"/></a:solidFill></c:spPr></c:dPt>`).join('')
    : `<c:spPr><a:solidFill><a:srgbClr val="${color(index)}"/></a:solidFill></c:spPr>`;
  const labels = percent
    ? '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/>'
      + '<c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="1"/></c:dLbls>'
    : (showValue
      ? '<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/>'
        + '<c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>'
      : '');
  // 误差线：c:errBars 要在 c:spPr 之后、c:cat 之前（schema 顺序）
  const errXml = errorBars
    ? `<c:errBars><c:errBarType val="both"/><c:errValType val="cust"/>`
      + `<c:noEndCap val="0"/>`
      + `<c:plus><c:numRef><c:f>Sheet1!$E$2:$E$${errorBars.length + 1}</c:f>`
      + `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${errorBars.length}"/>`
      + errorBars.map((value, i) => `<c:pt idx="${i}"><c:v>${Number(value) || 0}</c:v></c:pt>`).join('')
      + '</c:numCache></c:numRef></c:plus>'
      + `<c:minus><c:numRef><c:f>Sheet1!$F$2:$F$${errorBars.length + 1}</c:f>`
      + `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${errorBars.length}"/>`
      + errorBars.map((value, i) => `<c:pt idx="${i}"><c:v>${Number(value) || 0}</c:v></c:pt>`).join('')
      + '</c:numCache></c:numRef></c:minus>'
      + '</c:errBars>'
    : '';
  // 元素顺序是 schema 强制的：idx → order → tx → spPr → dLbls → trendline → errBars → cat → val。
  // 把 errBars 写在 dLbls 前面，Word 不会报错，只是把整张图丢掉（或渲染成一张空白图片）。
  return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>`
    + `<c:tx><c:strRef><c:f>Sheet1!$${String.fromCharCode(66 + index)}$1</c:f>`
    + `<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(item.name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>`
    + `${shape}${labels}${errXml}`
    + `<c:cat><c:strRef><c:f>${catRef}</c:f><c:strCache>${cat}</c:strCache></c:strRef></c:cat>`
    + `<c:val><c:numRef><c:f>${valRef}</c:f><c:numCache>${val}</c:numCache></c:numRef></c:val>`
    + '</c:ser>';
}

// 坐标轴标题。Word 里轴标题是 c:title 放在轴内部（c:catAx / c:valAx 的子元素）。
// 没有轴名时必须整块省略：输出一个空的 <c:title></c:title> 会在图上留一个空白标题框，
// 也会让部分 Word 版本把整张图判为结构异常。
function axisTitleXml(text) {
  if (!text) return '';
  return '<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr>'
    + `<a:r><a:rPr lang="zh-CN" sz="900"/><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx>`
    + '<c:overlay val="0"/></c:title>';
}

// 一个图表 = 一个 chart part。不写 externalData（不引 xlsx）：Word 用缓存渲染，
// 双击编辑数据时会提示没有数据表，但打开、打印、转 PDF 都正常。
function chartPartXml(spec) {
  const axis1 = 50000000 + spec.no * 2;
  const axis2 = axis1 + 1;
  const stats = spec.stats || null;
  // 散点图的标题下再挂一行回归统计：Word 里的趋势线本身能显示方程与 R²，
  // 但样本量 n 它不显示，而论文必须交代样本量。
  const statsLine = spec.type === 'scatter' && stats
    ? `<a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:r><a:rPr lang="zh-CN" sz="900" i="1"/>`
      + `<a:t>R² = ${esc(stats.r2.toFixed(3))}　n = ${stats.n}</a:t></a:r></a:p>`
    : '';
  const title = `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr>`
    + `<a:r><a:rPr lang="zh-CN" sz="1200" b="1"/><a:t>${esc(spec.title)}</a:t></a:r></a:p>${statsLine}</c:rich></c:tx>`
    + `<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`;
  const legend = `<c:legend><c:legendPos val="${spec.type === 'pie' ? 'r' : 'b'}"/><c:overlay val="0"/></c:legend>`;
  const textProps = '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:endParaRPr lang="zh-CN"/></a:p></c:txPr>';
  let plot;
  if (spec.type === 'pie') {
    plot = `<c:pieChart><c:varyColors val="1"/>${seriesXml(spec.series[0], 0, spec, { perPoint: true, percent: true })}<c:firstSliceAng val="0"/></c:pieChart>`;
  } else if (spec.type === 'scatter') {
    // 散点图：x 轴是数值轴（c:valAx），不能用类目轴
    const scatters = spec.series.map((item, index) => {
      const xs = spec.points.filter((p) => p.series === index).map((p) => p.x);
      const ys = spec.points.filter((p) => p.series === index).map((p) => p.y);
      const xPts = xs.map((value, i) => `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>`).join('');
      const yPts = ys.map((value, i) => `<c:pt idx="${i}"><c:v>${value}</c:v></c:pt>`).join('');
      const color = PALETTE[index % PALETTE.length].replace('#', '').toUpperCase();
      return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/>`
        + `<c:tx><c:v>${esc(item.name)}</c:v></c:tx>`
        + `<c:spPr><a:ln w="19050"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:ln></c:spPr>`
        + '<c:marker><c:symbol val="circle"/><c:size val="6"/>'
        + `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`
        + '<a:ln w="9525"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:marker>'
        // 趋势线：Word 原生对象，双击可改类型；方程与 R² 由 Word 自己算，不是我们写死的文本。
        // 只在第一条系列上挂（多条系列各画一条趋势线会互相压住，也读不出来）。
        + (index === 0 && spec.fit !== null
          ? '<c:trendline><c:trendlineType val="linear"/><c:dispRSqr val="1"/><c:dispEq val="1"/>'
            + '<c:trendlineLbl><c:numFmt formatCode="General" sourceLinked="0"/></c:trendlineLbl></c:trendline>'
          : '')
        + `<c:xVal><c:numRef><c:f>Sheet1!$X$${index + 1}$2:$X$${index + 1}$${xs.length + 1}</c:f>`
        + `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${xs.length}"/>${xPts}</c:numCache></c:numRef></c:xVal>`
        + `<c:yVal><c:numRef><c:f>Sheet1!$Y$${index + 1}$2:$Y$${index + 1}$${ys.length + 1}</c:f>`
        + `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${ys.length}"/>${yPts}</c:numCache></c:numRef></c:yVal>`
        + '</c:ser>';
    }).join('');
    plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/>${scatters}`
      + `<c:axId val="${axis1}"/><c:axId val="${axis2}"/></c:scatterChart>`
      + `<c:valAx><c:axId val="${axis1}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>`
      + `<c:majorGridlines/>${axisTitleXml(spec.xLabel)}`
      + '<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/>'
      + `<c:tickLblPos val="nextTo"/><c:crossAx val="${axis2}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`
      + `<c:valAx><c:axId val="${axis2}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>`
      + `<c:majorGridlines/>${axisTitleXml(spec.yLabel)}`
      + '<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/>'
      + `<c:tickLblPos val="nextTo"/><c:crossAx val="${axis1}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`;
  } else {
    // c:axId 是图表组的必填项（指向下面两个坐标轴）。漏掉它 schema 就不合法，
    // Word 不会报错，而是把整张图渲染成空白——只剩题注和一块留白。
    const axIds = `<c:axId val="${axis1}"/><c:axId val="${axis2}"/>`;
    // 数据标签只在点数少时开：8 类目 × 3 系列 = 24 个数字会把图糊满，
    // 反而看不出趋势。这是「像论文插图」和「像演示文稿」的分界之一。
    const showValue = spec.type !== 'line' && spec.categories.length * spec.series.length <= 12;
    const errBars = spec.type === 'errorbar' && Array.isArray(spec.errors) ? spec.errors : null;
    const grouping = spec.percent ? 'percentStacked' : (spec.stacked ? 'stacked' : 'clustered');
    const overlap = spec.stacked ? '<c:overlap val="100"/>' : '<c:overlap val="-10"/>';
    const kind = spec.type === 'line'
      ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${spec.series.map((item, index) => seriesXml(item, index, spec)).join('')}<c:marker val="1"/>${axIds}</c:lineChart>`
      : `<c:barChart><c:barDir val="col"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${spec.series.map((item, index) => seriesXml(item, index, spec, { showValue, errorBars: index === 0 ? errBars : null })).join('')}<c:gapWidth val="80"/>${overlap}${axIds}</c:barChart>`;
    // 柱状图的纵轴必须从 0 起：截断的柱状图会把差异放大好几倍，是图表伦理问题。
    // 折线图允许截断（趋势图看的是变化方向），所以只对 bar 强制 min=0。
    // 对数轴时不能写 min=0（log(0) 无定义），Word 会直接忽略整条轴。
    const logBase = spec.logY && spec.type === 'line' ? '<c:logBase val="10"/>' : '';
    const valScale = spec.type === 'bar' || spec.type === 'errorbar' || spec.type === 'hist'
      ? `<c:scaling>${logBase}<c:orientation val="minMax"/><c:min val="0"/></c:scaling>`
      : `<c:scaling>${logBase}<c:orientation val="minMax"/></c:scaling>`;
    const valFmt = spec.percent
      ? '<c:numFmt formatCode="0%" sourceLinked="0"/>'
      : '<c:numFmt formatCode="General" sourceLinked="1"/>';
    plot = `${kind}<c:catAx><c:axId val="${axis1}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>`
      + `${axisTitleXml(spec.xLabel)}`
      // 注意这里必须是模板字符串：写成单引号时 ${axis2} 不会被替换，
      // crossAx 会拿到字面量 "${axis2}"，schema 校验失败 → Word 直接丢弃整张图。
      + `<c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${axis2}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
      + `<c:valAx><c:axId val="${axis2}"/>${valScale}<c:delete val="0"/><c:axPos val="l"/>`
      + `<c:majorGridlines/>${axisTitleXml(spec.yLabel)}${valFmt}`
      + `<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="${axis1}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  }
  // 注意：c:legend 必须是 c:plotArea 的兄弟节点，不能放进 plotArea 里。
  // 放错位置时 Word 不报错，只是把整张图渲染成空白——只剩题注和一块留白，很难看出是这里的问题。
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:chart>${title}<c:plotArea><c:layout/>${plot}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>${textProps}</c:chartSpace>`;
}

// 正文里的一行「【图1：标题】」→ 真正的图表。返回 null 表示这行不是图表占位。
const FIGURE_LINE = /^【图\s*(\d{1,2})\s*[：:]\s*([^】]*)】$/;

function parseFigureLine(line) {
  const matched = String(line || '').trim().match(FIGURE_LINE);
  if (!matched) return null;
  return { no: Number(matched[1]), title: String(matched[2] || '').trim() };
}

// 把正文切成「文字块 / 图表块」。图表块按编号对 spec；对不上的保留原占位符，
// 宁可让作者看到【图3：…】没渲染，也不要静默吞掉一行。
function splitFigureBlocks(content, figures) {
  const map = new Map((figures || []).map((item) => [Number(item.no), item]));
  const blocks = [];
  let buffer = [];
  const flush = () => {
    if (buffer.length) { blocks.push({ type: 'text', text: buffer.join('\n') }); buffer = []; }
  };
  for (const line of String(content || '').split(/\r?\n/)) {
    const parsed = parseFigureLine(line);
    if (parsed) {
      const spec = map.get(parsed.no);
      if (spec) { flush(); blocks.push({ type: 'figure', spec }); continue; }
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

// 全文连续编号。每节的图表在计划阶段是从「图1」开始编的（一节之内自洽），
// 但交出去的稿子必须是「图1、图2、图3…」跨节连号，否则读者会看到三个「图1」。
//
// 正文里的占位符跟着改号，必须一次扫描完成：先 图1→图2 再 图2→图3 会把刚改好的那张再改一遍。
function globalizeFigures(sections) {
  let counter = 0;
  return (sections || []).map((section) => {
    const figures = Array.isArray(section.figures) ? section.figures : [];
    const renumber = new Map();
    const mapped = figures.map((spec) => {
      counter += 1;
      renumber.set(Number(spec.no), counter);
      return { ...spec, no: counter };
    });
    const content = renumber.size
      ? String(section.content || '').replace(/【图\s*(\d{1,2})\s*([：:])/g, (whole, num, colon) => {
        const globalNo = renumber.get(Number(num));
        return globalNo ? `【图${globalNo}${colon}` : whole;
      })
      : String(section.content || '');
    return { content, figures: mapped };
  });
}

module.exports = {
  normalizeFigure, normalizeFigures, figureSvg, figureMarkdown, chartPartXml,
  splitFigureBlocks, parseFigureLine, globalizeFigures, FIGURE_LINE, PALETTE,
  FIGURE_TYPES, formatTick,
};
