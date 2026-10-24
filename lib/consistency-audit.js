'use strict';

// 全局一致性审计。
//
// 单章审核看不见长期问题：桥段重复、节奏停滞、人物断层、伏笔越积越多。
// 这里做两档确定性审计（不调用模型，零成本）：
// - 每 10 章：跨章重复桥段、章末钩子缺失、核心人物断层、篇幅漂移。
// - 每卷（默认 50 章）：未回收伏笔的数量与年龄、卷内产出、人物出场覆盖。
//
// 审计只产出报告，不阻断生成。原因很直接：没有"关键伏笔"的判定标准时，
// 任何未回收伏笔都会让硬门禁长鸣，无人值守会直接停死。
const { q, one, run } = require('./db');
const longform = require('./longform-memory');

const WINDOW_SIZE = 10;
const VOLUME_SIZE = 50;
const REPEAT_MIN_CHARS = 80;
const HOOK_WINDOW_CHARS = 120;

function chapterNumFromName(name) {
  const matched = String(name || '').match(/第\s*([0-9]{1,6})\s*章/);
  return matched ? Number(matched[1]) : 0;
}

function chapterBodies(bookId, fromChapter, toChapter) {
  const core = require('./handlers-core');
  const tree = core.scanTree({ bookId });
  const group = tree.find((item) => item.groupDir === '正文') || { files: [] };
  const map = new Map();
  for (const file of group.files) {
    const n = chapterNumFromName(file.name);
    if (!n || n < fromChapter || n > toChapter || file.aiOff) continue;
    map.set(n, {
      chapterNum: n,
      name: file.name,
      content: core.readFileFrom({ bookId, group: '正文', name: file.name }) || '',
    });
  }
  return [...map.values()].sort((a, b) => a.chapterNum - b.chapterNum);
}

function charCount(text) {
  return String(text || '').replace(/^#{1,3}\s+[^\n]+\n*/, '').replace(/\s/g, '').length;
}

function normalize(text) {
  return String(text || '')
    .replace(/[「」『』“”"'‘’]/g, '')
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。！？、；：…—\-.!?,;:()（）\[\]【】]/g, '');
}

function sharedRun(a, b, { anchor = 20, minRun = REPEAT_MIN_CHARS } = {}) {
  const left = normalize(a);
  const right = normalize(b);
  if (left.length < minRun || right.length < minRun) return 0;
  const index = new Set();
  for (let i = 0; i + anchor <= right.length; i++) index.add(right.slice(i, i + anchor));
  for (let i = 0; i + anchor <= left.length; i++) {
    if (!index.has(left.slice(i, i + anchor))) continue;
    let end = i + anchor;
    while (end < left.length && right.includes(left.slice(i, end + 1))) end++;
    if (end - i >= minRun) return end - i;
  }
  return 0;
}

function hasHook(content) {
  const tail = String(content || '').trim().slice(-HOOK_WINDOW_CHARS);
  return /[？?]|[「『“][^」』”]*[」』”]\s*$|…|——|忽然|突然|却|竟然|谁知/.test(tail);
}

function coreCharacters(bookId, limit = 6) {
  return q(`SELECT state_key, COUNT(*) AS mentions FROM character_mentions
    WHERE book_id=? GROUP BY state_key ORDER BY mentions DESC LIMIT ?`, bookId, limit)
    .map((row) => row.state_key);
}

function openThreads(bookId) {
  return q(`SELECT state_key, value, chapter_num FROM story_states WHERE book_id=? AND kind='thread'`, bookId)
    .map((row) => {
      let value = {};
      try { value = JSON.parse(row.value) || {}; } catch { value = {}; }
      return { key: row.state_key, text: String(value.text || row.state_key), status: String(value.status || 'open'), chapter: Number(row.chapter_num) || 0 };
    })
    .filter((item) => item.status !== 'resolved');
}

function auditWindow({ bookId, fromChapter, toChapter } = {}) {
  const from = Math.max(1, Number(fromChapter) || 1);
  const to = Math.max(from, Number(toChapter) || from);
  const chapters = chapterBodies(bookId, from, to);
  const issues = [];
  const metrics = { chapters: chapters.length, fromChapter: from, toChapter: to };

  if (chapters.length >= 2) {
    // 1) 跨章重复桥段：任意两章之间 80 字以上逐字重合。
    let worst = null;
    for (let i = 0; i < chapters.length; i++) {
      for (let j = i + 1; j < chapters.length; j++) {
        const length = sharedRun(chapters[i].content, chapters[j].content);
        if (length >= REPEAT_MIN_CHARS && (!worst || length > worst.length)) {
          worst = { length, a: chapters[i].chapterNum, b: chapters[j].chapterNum };
        }
      }
    }
    if (worst) {
      issues.push({
        code: 'repeat_bridge', severity: 'warn',
        message: `第${worst.a}章与第${worst.b}章有 ${worst.length} 字逐字重合，可能是同一桥段被复用`,
      });
      metrics.repeatChars = worst.length;
    }

    // 2) 章末钩子缺失比例。
    const withoutHook = chapters.filter((item) => !hasHook(item.content)).map((item) => item.chapterNum);
    metrics.hooklessChapters = withoutHook.length;
    if (withoutHook.length / chapters.length >= 0.5) {
      issues.push({
        code: 'hook_missing', severity: 'warn',
        message: `${withoutHook.length}/${chapters.length} 章章末没有钩子（如第${withoutHook.slice(0, 4).join('、')}章）`,
      });
    }

    // 3) 核心人物断层：连续 3 章没有任何核心人物出场。
    const core = coreCharacters(bookId);
    if (core.length) {
      const marks = chapters.map((item) => {
        const rows = q(`SELECT 1 AS present FROM character_mentions WHERE book_id=? AND chapter_num=? AND state_key IN (${core.map(() => '?').join(',')}) LIMIT 1`,
          bookId, item.chapterNum, ...core);
        return { chapterNum: item.chapterNum, present: rows.length > 0 };
      });
      let streak = 0;
      let worstStreak = 0;
      for (const mark of marks) {
        streak = mark.present ? 0 : streak + 1;
        worstStreak = Math.max(worstStreak, streak);
      }
      metrics.coreCharacters = core.length;
      metrics.corelessStreak = worstStreak;
      if (worstStreak >= 3) {
        issues.push({
          code: 'core_character_gap', severity: 'warn',
          message: `连续 ${worstStreak} 章没有核心人物出场，读者可能已经失去追踪对象`,
        });
      }
    }

    // 4) 篇幅漂移。
    const lengths = chapters.map((item) => charCount(item.content)).filter((value) => value > 0);
    if (lengths.length >= 3) {
      const min = Math.min(...lengths);
      const max = Math.max(...lengths);
      metrics.minChars = min;
      metrics.maxChars = max;
      if (min > 0 && max / min > 2.2) {
        issues.push({
          code: 'length_drift', severity: 'warn',
          message: `窗口内章节篇幅差异过大（最短 ${min} 字 / 最长 ${max} 字）`,
        });
      }
    }

    // 5) 世界规则禁词：作者显式声明"本书不得出现"的表述逐字排查。
    const ruleViolations = worldRuleViolations(bookId, chapters);
    metrics.bannedTermHits = ruleViolations.length;
    for (const violation of ruleViolations) {
      issues.push({
        code: 'world_rule_violation', severity: 'warn',
        message: violation.message,
      });
    }
  }

  return {
    scope: 'window',
    bookId,
    fromChapter: from,
    toChapter: to,
    verdict: issues.length ? 'warn' : 'ok',
    issues,
    metrics,
  };
}

// 每条启用规则的禁词在窗口正文里逐字查找；禁词与正文用同一套 normalize，
// 保证"禁词：手机"能命中"他掏出手_机_？"这类被标点打断的写法。
function worldRuleViolations(bookId, chapters) {
  longform.importWorldRulesIfChanged(bookId);
  const rules = longform.listWorldRules(bookId).filter((rule) => rule.enabled && rule.banTerms.length);
  if (!rules.length || !chapters.length) return [];
  const violations = [];
  for (const rule of rules) {
    const terms = [...new Set(rule.banTerms.map((term) => normalize(term)).filter((term) => term.length >= 2))];
    if (!terms.length) continue;
    const hitChapters = [];
    let term = '';
    for (const chapter of chapters) {
      const text = normalize(chapter.content);
      const found = terms.find((candidate) => text.includes(candidate));
      if (found) { hitChapters.push(chapter.chapterNum); term = found; }
    }
    if (hitChapters.length) {
      const preview = hitChapters.slice(0, 4).map((n) => `第${n}章`).join('、');
      violations.push({
        rule: rule.ruleKey,
        chapters: hitChapters,
        message: `规则「${rule.ruleKey}」的禁用表述出现在${preview}${hitChapters.length > 4 ? ' 等' + hitChapters.length + '章' : ''}（命中：${term}）`,
      });
    }
  }
  return violations;
}

function auditVolume({ bookId, volumeNum, volumeSize = VOLUME_SIZE } = {}) {
  const volume = Math.max(1, Number(volumeNum) || 1);
  const size = Math.max(1, Number(volumeSize) || VOLUME_SIZE);
  const from = (volume - 1) * size + 1;
  const to = volume * size;
  const chapters = chapterBodies(bookId, from, to);
  const issues = [];

  const threads = openThreads(bookId);
  const aged = threads
    .map((item) => ({ ...item, age: to - item.chapter }))
    .filter((item) => item.age > 0)
    .sort((a, b) => b.age - a.age);

  if (aged.length > 8) {
    issues.push({
      code: 'thread_backlog', severity: 'warn',
      message: `卷末仍有 ${aged.length} 条伏笔未回收，读者很难记住这么多未兑现的承诺`,
    });
  }
  if (aged.length && aged[0].age > size) {
    issues.push({
      code: 'thread_stale', severity: 'warn',
      message: `最老的未回收伏笔埋在第${aged[0].chapter}章，已过 ${aged[0].age} 章：${aged[0].text.slice(0, 40)}`,
    });
  }

  const words = chapters.reduce((sum, item) => sum + charCount(item.content), 0);
  if (chapters.length && chapters.length < Math.floor(size * 0.8)) {
    issues.push({
      code: 'volume_short', severity: 'warn',
      message: `本卷只完成 ${chapters.length}/${size} 章`,
    });
  }

  // 正典事件复现：距锚定章足够远之后，事件的独特关键词再次整段出现。
  // 只挑长度足够的短语当指纹，避免"刀"这类常见字误报。
  const echoes = canonEventEchoes(bookId, from, chapters);
  for (const echo of echoes) {
    issues.push({
      code: 'canon_event_echo', severity: 'warn',
      message: echo.message,
    });
  }

  return {
    scope: 'volume',
    bookId,
    fromChapter: from,
    toChapter: to,
    verdict: issues.length ? 'warn' : 'ok',
    issues,
    metrics: {
      volume: volume, volumeSize: size, chapters: chapters.length, words,
      openThreads: aged.length, oldestThreadAge: aged.length ? aged[0].age : 0,
      canonEchoes: echoes.length,
    },
  };
}

// 事件的独特关键词（归一化后足够长）在距锚定章 CANON_ECHO_MIN_GAP 章之后的
// 正文里再次出现，多半是同一个桥段被原样复用。
function canonEventEchoes(bookId, volumeStartChapter, chapters) {
  longform.importCanonEventsIfChanged(bookId);
  const events = longform.listCanonEvents(bookId).filter((event) => event.keywords.length);
  if (!events.length || !chapters.length) return [];
  const fingerprints = [];
  for (const event of events) {
    const gap = volumeStartChapter - event.chapterNum;
    if (gap < longform.CANON_ECHO_MIN_GAP) continue;
    const terms = [...new Set(event.keywords.map((term) => normalize(term)))
      .values()].filter((term) => term.length >= longform.CANON_KEYWORD_MIN_CHARS);
    for (const term of terms) fingerprints.push({ event, term });
  }
  if (!fingerprints.length) return [];
  const echoes = [];
  for (const chapter of chapters) {
    const text = normalize(chapter.content);
    const hit = fingerprints.find((item) => text.includes(item.term));
    if (hit) {
      echoes.push({
        message: `第${chapter.chapterNum}章疑似复现第${hit.event.chapterNum}章正典事件「${hit.event.title || hit.event.eventKey}」（命中关键词：${hit.term}）`,
      });
    }
  }
  return echoes;
}

function save(report) {
  if (!report || !report.bookId) return null;
  const result = run(`INSERT INTO consistency_audits(book_id, scope, from_chapter, to_chapter, verdict,
    issues_json, metrics_json, created_at) VALUES(?,?,?,?,?,?,?,?)`,
  String(report.bookId), String(report.scope), Number(report.fromChapter) || 0, Number(report.toChapter) || 0,
  String(report.verdict || 'ok'), JSON.stringify(report.issues || []), JSON.stringify(report.metrics || {}), Date.now());
  return result.lastInsertRowid;
}

function latest({ bookId, scope = 'window' } = {}) {
  const row = one(`SELECT * FROM consistency_audits WHERE book_id=? AND scope=? ORDER BY id DESC LIMIT 1`, bookId, scope);
  if (!row) return null;
  return {
    id: row.id,
    scope: row.scope,
    fromChapter: Number(row.from_chapter),
    toChapter: Number(row.to_chapter),
    verdict: row.verdict,
    issues: JSON.parse(row.issues_json || '[]'),
    metrics: JSON.parse(row.metrics_json || '{}'),
    createdAt: Number(row.created_at),
  };
}

// 审计结果写库没人看得见，等于没做。这里把报告追加成 Markdown，
// 落进 设定/一致性报告.md，跑完直接能读。
function reportMarkdown(report) {
  const stamp = new Date(report.createdAt || Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  const when = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ` +
    `${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`;
  const scopeText = report.scope === 'volume'
    ? `第${report.metrics?.volume || Math.ceil(Number(report.toChapter) / VOLUME_SIZE)}卷（第${report.fromChapter}-${report.toChapter}章）`
    : `第${report.fromChapter}-${report.toChapter}章`;
  const lines = [`## ${when} ${scopeText}`, ''];
  const issues = Array.isArray(report.issues) ? report.issues : [];
  if (!issues.length) {
    lines.push('- 未发现跨章一致性问题');
  } else {
    for (const issue of issues) {
      const where = issue.chapterNum ? `第${issue.chapterNum}章 ` : '';
      lines.push(`- [${issue.kind || 'issue'}] ${where}${issue.message || ''}`);
    }
  }
  const metrics = report.metrics || {};
  const brief = [];
  if (metrics.chapters) brief.push(`${metrics.chapters} 章`);
  if (metrics.openThreads != null) brief.push(`未回收伏笔 ${metrics.openThreads}`);
  if (metrics.oldestThreadAge != null) brief.push(`最老伏笔 ${metrics.oldestThreadAge} 章`);
  if (metrics.hookRatio != null) brief.push(`章末钩子覆盖 ${Math.round(Number(metrics.hookRatio) * 100)}%`);
  if (brief.length) lines.push(`- 指标：${brief.join('，')}`);
  lines.push('');
  return lines.join('\n');
}

function appendReportToFile({ bookId, report } = {}) {
  if (!bookId || !report) return 0;
  try {
    const core = require('./handlers-core');
    const text = reportMarkdown(report);
    core.appendFileTo({ bookId, group: '设定', name: '一致性报告.md', content: text });
    return text.length;
  } catch (error) {
    return 0; // 报告是附加产物，写不进去不能影响生成
  }
}

module.exports = {
  WINDOW_SIZE,
  VOLUME_SIZE,
  auditWindow,
  auditVolume,
  save,
  latest,
  reportMarkdown,
  appendReportToFile,
  sharedRun,
  hasHook,
  openThreads,
  worldRuleViolations,
  canonEventEchoes,
};
