'use strict';

// 统计分析内核：CSV 解析 → 描述统计 / 相关 / OLS 回归 / t 检验。
//
// 为什么自己写：论文的「结果与分析」必须由数据算出来，不能由模型描述出来。
// 模型不会算标准误，也不该算——它只需要读我们算好的系数。所以这里做成纯函数库，
// 输出可直接落库、可复现、可核对，不依赖 SPSS/R，也不引第三方包。
//
// 数值方法：正规方程 + 高斯-约当求逆（带部分主元），p 值走不完全 Beta 函数
// （t 分布、F 分布都能由它得到）。样本量几百到几千、自变量十几个，这个精度足够。

// ---------- CSV ----------

function detectDelimiter(sample) {
  const head = String(sample || '').split(/\r?\n/)[0] || '';
  const counts = [[',', (head.match(/,/g) || []).length], [';', (head.match(/;/g) || []).length], ['\t', (head.match(/\t/g) || []).length]];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

// 逐字符扫描：引号内的分隔符不算分隔符，" 转义成 "
function splitRow(line, delimiter) {
  const cells = [];
  let buffer = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { buffer += '"'; i += 1; } else { quoted = false; }
      } else {
        buffer += ch;
      }
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { cells.push(buffer); buffer = ''; continue; }
    buffer += ch;
  }
  cells.push(buffer);
  return cells.map((cell) => cell.trim());
}

function parseCsv(text, { maxRows = 20000 } = {}) {
  const clean = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = clean.split('\n').filter((line) => line.trim());
  if (!lines.length) return { columns: [], rows: [], truncated: false };
  const delimiter = detectDelimiter(clean);
  const columns = splitRow(lines[0], delimiter).map((name, index) => name || `列${index + 1}`);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (rows.length >= maxRows) return { columns, rows, truncated: true };
    const cells = splitRow(lines[i], delimiter);
    if (cells.every((cell) => !cell)) continue;
    rows.push(cells);
  }
  return { columns, rows, truncated: lines.length - 1 > rows.length };
}

// ---------- 列类型 ----------

const MISSING = new Set(['', 'na', 'n/a', 'null', 'none', '-', '—', '.', 'nan']);

function isMissing(value) {
  return MISSING.has(String(value == null ? '' : value).trim().toLowerCase());
}

// 数值化：容忍千分位逗号、百分号、全角负号
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const raw = String(value == null ? '' : value).trim();
  if (isMissing(raw)) return null;
  const cleaned = raw
    .replace(/[,\s]/g, '')
    .replace(/[%％]$/, '')
    .replace(/[−–—]/g, '-');
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

// 推断每列类型：数值列要求「非缺失值里有九成以上能转成数」
function describeColumns(table) {
  return table.columns.map((name, index) => {
    const raw = table.rows.map((row) => row[index]);
    const present = raw.filter((value) => !isMissing(value));
    const numeric = present.filter((value) => toNumber(value) != null).length;
    const ratio = present.length ? numeric / present.length : 0;
    const values = raw.map(toNumber).filter((value) => value != null);
    return {
      name,
      index,
      type: present.length && ratio >= 0.9 ? 'number' : 'category',
      missing: raw.length - present.length,
      unique: new Set(present.map((value) => String(value).trim())).size,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
    };
  });
}

// 取一列的数值数组（缺失行整行剔除，保证多列对齐）
function numericColumns(table, names) {
  const indexes = names.map((name) => table.columns.indexOf(name));
  if (indexes.some((index) => index < 0)) return null;
  const out = names.map(() => []);
  for (const row of table.rows) {
    const values = indexes.map((index) => toNumber(row[index]));
    if (values.some((value) => value == null)) continue;
    values.forEach((value, i) => out[i].push(value));
  }
  return out;
}

// ---------- 基础统计 ----------

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values) {
  return values.length ? sum(values) / values.length : null;
}

function variance(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  return sum(values.map((value) => (value - m) ** 2)) / (values.length - 1);
}

function sd(values) {
  const v = variance(values);
  return v == null ? null : Math.sqrt(v);
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] == null) return sorted[base];
  return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function describe(values) {
  return {
    n: values.length,
    mean: mean(values),
    sd: sd(values),
    min: values.length ? Math.min(...values) : null,
    p25: quantile(values, 0.25),
    median: quantile(values, 0.5),
    p75: quantile(values, 0.75),
    max: values.length ? Math.max(...values) : null,
  };
}

// ---------- 分布函数 ----------

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012,
  9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i] / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

// 不完全 Beta 的连分式（Numerical Recipes 的 betacf）
function betaContinuedFraction(a, b, x) {
  const TINY = 1e-30;
  const EPS = 1e-12;
  const MAX_ITER = 200;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

function betaIncomplete(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
  return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

// t 分布的 CDF：P(T ≤ t)
function tCdf(t, df) {
  if (!Number.isFinite(t) || df <= 0) return NaN;
  const x = df / (df + t * t);
  const tail = 0.5 * betaIncomplete(df / 2, 0.5, x);
  return t > 0 ? 1 - tail : tail;
}

// 双侧 p 值
function tPValue(t, df) {
  if (!Number.isFinite(t) || df <= 0) return NaN;
  return Math.min(1, 2 * (1 - tCdf(Math.abs(t), df)));
}

function fPValue(f, df1, df2) {
  if (!Number.isFinite(f) || f <= 0 || df1 <= 0 || df2 <= 0) return NaN;
  return 1 - betaIncomplete(df1 / 2, df2 / 2, (df1 * f) / (df1 * f + df2));
}

// ---------- 相关 ----------

function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  const df = n - 2;
  const t = r * Math.sqrt(df / Math.max(1e-12, 1 - r * r));
  return { r, n, df, t, p: tPValue(t, df) };
}

function correlationMatrix(table, names) {
  const columns = numericColumns(table, names);
  if (!columns) return null;
  const matrix = [];
  for (let i = 0; i < names.length; i++) {
    const row = [];
    for (let j = 0; j < names.length; j++) {
      row.push(i === j ? { r: 1, p: 0, n: columns[i].length } : pearson(columns[i], columns[j]));
    }
    matrix.push(row);
  }
  return { names, matrix, n: columns[0].length };
}

// ---------- 线性代数 ----------

// 高斯-约当求逆（带部分主元）。矩阵奇异时返回 null，由调用方给出人话错误。
function invert(matrix) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    if (pivot !== col) { const tmp = a[pivot]; a[pivot] = a[col]; a[col] = tmp; }
    const div = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      if (!factor) continue;
      for (let j = 0; j < 2 * n; j++) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

// ---------- OLS ----------

// 普通最小二乘 + 可选 HC1 稳健标准误。
// 设计矩阵自动加截距列；系数名与自变量一一对应。
function ols(y, xColumns, { names = [], robust = false } = {}) {
  const n = y.length;
  if (!n || xColumns.some((column) => column.length !== n)) return { error: '样本行数不一致' };
  const k = xColumns.length + 1;
  if (n <= k + 1) return { error: `样本量不足：需要多于 ${k + 1} 行，当前 ${n} 行` };
  const X = y.map((_, i) => [1, ...xColumns.map((column) => column[i])]);
  const XtX = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => sum(X.map((row) => row[i] * row[j]))));
  const XtXInv = invert(XtX);
  if (!XtXInv) return { error: '自变量之间存在完全共线性，无法估计' };
  const Xty = Array.from({ length: k }, (_, i) => sum(X.map((row, r) => row[i] * y[r])));
  const beta = XtXInv.map((row) => sum(row.map((value, j) => value * Xty[j])));
  const fitted = X.map((row) => sum(row.map((value, j) => value * beta[j])));
  const residuals = y.map((value, i) => value - fitted[i]);
  const sse = sum(residuals.map((value) => value * value));
  const my = mean(y);
  const sst = sum(y.map((value) => (value - my) ** 2));
  const df = n - k;
  const sigma2 = sse / df;

  // 协方差矩阵：默认同方差假设；robust 时用 HC1（White 异方差稳健）
  let cov;
  if (robust) {
    const meat = Array.from({ length: k }, () => Array.from({ length: k }, () => 0));
    for (let r = 0; r < n; r++) {
      const w = residuals[r] ** 2;
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k; j++) meat[i][j] += w * X[r][i] * X[r][j];
      }
    }
    const middle = Array.from({ length: k }, (_, i) =>
      Array.from({ length: k }, (_, j) => sum(Array.from({ length: k }, (_, m) => XtXInv[i][m] * meat[m][j]))));
    const scale = n / (n - k);
    cov = Array.from({ length: k }, (_, i) =>
      Array.from({ length: k }, (_, j) => sum(Array.from({ length: k }, (_, m) => middle[i][m] * XtXInv[m][j])) * scale));
  } else {
    cov = XtXInv.map((row) => row.map((value) => value * sigma2));
  }

  const terms = beta.map((estimate, index) => {
    const se = Math.sqrt(Math.max(0, cov[index][index]));
    const t = se > 0 ? estimate / se : NaN;
    return {
      name: index === 0 ? '常数项' : (names[index - 1] || `X${index}`),
      estimate, se, t, p: tPValue(t, df),
      // 标准化系数（常数项不适用）
      beta: index === 0 ? null : estimate * (sd(xColumns[index - 1]) / sd(y)),
    };
  });

  const r2 = sst > 0 ? 1 - sse / sst : null;
  const adjR2 = r2 == null ? null : 1 - (1 - r2) * (n - 1) / df;
  const f = r2 == null || k <= 1 ? null : (r2 / (k - 1)) / ((1 - r2) / df);
  return {
    n, k, df,
    terms,
    r2, adjR2,
    f, fP: f == null ? null : fPValue(f, k - 1, df),
    sse, sst, rmse: Math.sqrt(sigma2),
    robust: !!robust,
    // 回归表要用的因变量名由调用方补
  };
}

// ---------- 两组比较 ----------

// Welch t 检验（不假设方差齐性），返回差值、t、df、p 与 Cohen's d
function tTest(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const ma = mean(a);
  const mb = mean(b);
  const va = variance(a);
  const vb = variance(b);
  const na = a.length;
  const nb = b.length;
  const se = Math.sqrt(va / na + vb / nb);
  if (!(se > 0)) return null;
  const t = (ma - mb) / se;
  const df = ((va / na + vb / nb) ** 2)
    / (((va / na) ** 2) / (na - 1) + ((vb / nb) ** 2) / (nb - 1));
  const pooled = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
  return {
    meanA: ma, meanB: mb, diff: ma - mb,
    se, t, df, p: tPValue(t, df),
    d: pooled > 0 ? (ma - mb) / pooled : null,
    nA: na, nB: nb,
  };
}

// 分组比较：按分组列切分数值列
function groupCompare(table, valueName, groupName) {
  const vi = table.columns.indexOf(valueName);
  const gi = table.columns.indexOf(groupName);
  if (vi < 0 || gi < 0) return null;
  const groups = new Map();
  for (const row of table.rows) {
    const value = toNumber(row[vi]);
    if (value == null) continue;
    const key = String(row[gi] == null ? '' : row[gi]).trim() || '（空）';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  const list = [...groups.entries()]
    .map(([name, values]) => ({ name, values, ...describe(values) }))
    .sort((a, b) => b.n - a.n);
  const test = list.length === 2 ? tTest(list[0].values, list[1].values) : null;
  return { groups: list, test };
}

// ---------- 数据体检 ----------
//
// 目的不是「算结果」，而是「在跑回归之前告诉你这份数据撑不撑得住」。
// 没有好数据，再精确的算法也只能算出平庸的结果——但至少可以让作者在动笔前知道
// 「样本量不够」「两个自变量几乎共线」「缺失太多」，而不是等写完一节才发现结论站不住。

// 偏度：正态分布约为 0，|skew| > 2 通常建议取对数
function skewness(values) {
  const n = values.length;
  if (n < 3) return null;
  const m = mean(values);
  const s = sd(values);
  if (!s) return null;
  const m3 = sum(values.map((v) => ((v - m) / s) ** 3));
  return (n / ((n - 1) * (n - 2))) * m3;
}

// IQR 异常值计数
function outlierCount(values) {
  if (values.length < 4) return { count: 0, ratio: 0, low: null, high: null };
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const iqr = q3 - q1;
  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;
  const count = values.filter((v) => v < low || v > high).length;
  return { count, ratio: count / values.length, low, high };
}

// 方差膨胀因子：把第 i 个自变量对其余自变量回归，VIF = 1/(1-R²)。
// VIF > 10 表示共线严重（系数不稳定、标准误虚高），> 5 需要留意。
function vif(xColumns) {
  const k = xColumns.length;
  if (k < 2) return [];
  return xColumns.map((column, i) => {
    const others = xColumns.filter((_, j) => j !== i);
    const fit = ols(column, others, { names: others.map((_, j) => `x${j}`) });
    if (fit.error) return { index: i, vif: Infinity, note: fit.error };
    const r2 = Number.isFinite(fit.r2) ? fit.r2 : 0;
    const value = r2 >= 1 ? Infinity : 1 / Math.max(1e-9, 1 - r2);
    return { index: i, vif: value, r2 };
  });
}

// 主入口：对一份数据表 + 一个模型设定做体检，返回人话结论
function diagnose(table, { y = '', x = [] } = {}) {
  const findings = [];
  const push = (level, code, title, detail) => findings.push({ level, code, title, detail });
  const n = table.rows.length;
  const numeric = table.columns.filter((column, index) => describeColumns(table)[index].type === 'number');

  // 1) 样本量 vs 变量数
  const k = x.length + 1;
  if (y && x.length) {
    if (n < 10 * k) {
      push('warn', 'sample-size', `样本量 ${n} 撑不住 ${k} 个参数`,
        `经验线是每个自变量至少 10 个观测（这里需要 ≥ ${10 * k}）。样本太少时系数会很不稳定，`
        + '换一个样本就可能翻号——结论只能当方向性参考，不能当估计值。');
    } else if (n < 20 * k) {
      push('info', 'sample-size-ok', `样本量 ${n} 对 ${k} 个参数偏紧`,
        '勉强够用，但标准误会偏大；建议在局限一节写明这一点。');
    }
  }

  // 2) 缺失率
  const columns = describeColumns(table);
  const worst = columns
    .map((column) => ({ name: column.name, missing: column.missing }))
    .filter((item) => item.missing > 0)
    .sort((a, b) => b.missing - a.missing);
  if (worst.length) {
    const top = worst[0];
    const ratio = top.missing / Math.max(1, n + top.missing);
    if (ratio > 0.2) {
      push('warn', 'missing', `「${top.name}」缺失 ${top.missing} 行（${(ratio * 100).toFixed(0)}%）`,
        '缺失超过两成时，删掉缺失行会改变样本结构（不是随机缺失就会引入偏差）。'
        + '要么补数据，要么在方法一节说明缺失处理方式。');
    } else {
      push('info', 'missing-minor', `${worst.length} 列有缺失，最多 ${top.missing} 行`,
        '当前按列剔除，影响不大；写方法一节时交代一句即可。');
    }
  }

  // 3) 共线性
  if (y && x.length >= 2) {
    const cols = numericColumns(table, x);
    if (cols) {
      const vifs = vif(cols);
      const bad = vifs.filter((item) => item.vif > 10);
      const warn = vifs.filter((item) => item.vif > 5 && item.vif <= 10);
      if (bad.length) {
        push('warn', 'collinearity', `${bad.length} 个自变量严重共线（VIF > 10）`,
          `${bad.map((item) => `${x[item.index]}（VIF ${item.vif.toFixed(1)}）`).join('、')}`
          + '——系数会不稳定、标准误虚高，严重时符号会反。删掉其中一个，或改用主成分/合并指标。');
      } else if (warn.length) {
        push('info', 'collinearity-soft', `${warn.length} 个自变量存在中等共线（VIF > 5）`,
          `${warn.map((item) => `${x[item.index]}（VIF ${item.vif.toFixed(1)}）`).join('、')}`
          + '——暂时可接受，但解释单个系数时要谨慎。');
      }
    }
  }

  // 4) 异常值与偏斜（针对因变量与自变量）
  for (const name of [y, ...x].filter(Boolean)) {
    const column = numericColumns(table, [name]);
    if (!column) continue;
    const values = column[0];
    const out = outlierCount(values);
    if (out.ratio > 0.05) {
      push('info', 'outlier', `「${name}」有 ${out.count} 个异常值（IQR 法，占 ${(out.ratio * 100).toFixed(0)}%）`,
        '异常值会显著拉动 OLS 系数。建议做一次缩尾（1%/99%）并比较结果是否稳定。');
    }
    const skew = skewness(values);
    if (skew != null && Math.abs(skew) > 2) {
      push('info', 'skew', `「${name}」分布偏斜（偏度 ${skew.toFixed(1)}）`,
        '右偏严重的变量建议取对数后再回归，否则系数会被少数大值主导。');
    }
  }

  // 5) 常数列 / 区分度不足
  for (const column of columns) {
    if (column.type === 'number' && column.min != null && column.min === column.max) {
      push('warn', 'constant', `「${column.name}」是常数列`, '所有取值相同，放进回归会被自动剔除或导致奇异矩阵。');
    }
    if (column.type === 'number' && column.unique <= 2 && column.name !== y) {
      push('info', 'low-variance', `「${column.name}」只有 ${column.unique} 个不同取值`,
        '取值太少时它更像分类变量；若当连续变量用，系数的解释要谨慎。');
    }
  }

  return { findings, n, k, at: Date.now() };
}

// ---------- 显著性星号（学术惯例） ----------

function stars(p) {
  if (!Number.isFinite(p)) return '';
  if (p < 0.001) return '***';
  if (p < 0.01) return '**';
  if (p < 0.05) return '*';
  return '';
}

function formatP(p) {
  if (!Number.isFinite(p)) return '—';
  if (p < 0.001) return '<0.001';
  return p.toFixed(3);
}

module.exports = {
  parseCsv, describeColumns, numericColumns, toNumber, isMissing,
  sum, mean, variance, sd, quantile, describe,
  logGamma, betaIncomplete, tCdf, tPValue, fPValue,
  pearson, correlationMatrix, invert, ols, tTest, groupCompare,
  skewness, outlierCount, vif, diagnose,
  stars, formatP,
};
