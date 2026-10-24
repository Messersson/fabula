'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-longform-'));
process.env.FABULA_DATA_DIR = tempDir;
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';

const db = require('../lib/db');
db.open(path.join(__dirname, '..', 'data', 'writerx.seed.db'));

const core = require('../lib/handlers-core');
const longform = require('../lib/longform-memory');
const misc = require('../lib/handlers-misc');
const knowledge = require('../lib/vector-store');

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createBook(title) {
  return core.createBook({ title, genre: '长篇', pov: '第三人称' }).id;
}

function characterState(bookId, name) {
  const row = db.one(`SELECT value, chapter_num FROM story_states
    WHERE book_id=? AND kind='character' AND state_key=?`, bookId, name);
  return row ? { value: JSON.parse(row.value), chapter: Number(row.chapter_num) } : null;
}

function storyState(bookId, kind, key) {
  const row = db.one(`SELECT value, chapter_num FROM story_states
    WHERE book_id=? AND kind=? AND state_key=?`, bookId, kind, key);
  return row ? { value: JSON.parse(row.value), chapter: Number(row.chapter_num) } : null;
}

function threadState(bookId, text) {
  const key = String(text).toLowerCase().replace(/\s+/g, '');
  const row = db.one(`SELECT value, chapter_num FROM story_states
    WHERE book_id=? AND kind='thread' AND state_key=?`, bookId, key);
  return row ? { value: JSON.parse(row.value), chapter: Number(row.chapter_num) } : null;
}

test('旧章节重跑不会覆盖后续章节的人物状态，同章重跑仍可更新', () => {
  const bookId = createBook('状态单调推进');
  longform.recordContinuity(bookId, 5, {
    continuity: { characters: [{ name: '林默', status: '初入城' }] },
  });
  longform.recordContinuity(bookId, 50, {
    continuity: { characters: [{ name: '林默', status: '断臂后昏迷' }] },
  });
  longform.recordContinuity(bookId, 5, {
    continuity: { characters: [{ name: '林默', status: '误写为恢复' }] },
  });

  assert.deepEqual(characterState(bookId, '林默'), {
    value: { name: '林默', status: '断臂后昏迷', goal: '', relations: '', location: '' },
    chapter: 50,
  });

  longform.recordContinuity(bookId, 50, {
    continuity: { characters: [{ name: '林默', status: '苏醒并失去左臂' }] },
  });
  assert.equal(characterState(bookId, '林默').value.status, '苏醒并失去左臂');
  assert.equal(characterState(bookId, '林默').chapter, 50);
});

test('重写旧章节时按目标章重放状态，不泄漏未来剧情', () => {
  const bookId = createBook('历史状态重放');
  longform.recordContinuity(bookId, 1, { foreshadow: { planted: ['铜钥匙'] } });
  longform.recordContinuity(bookId, 5, {
    continuity: {
      time: '第五日',
      location: '渡口',
      characters: [{ name: '沈舟', status: '初入城' }],
      facts: ['沈舟尚未见过城主'],
    },
  });
  longform.recordContinuity(bookId, 20, {
    continuity: {
      time: '第二十日',
      location: '王城',
      characters: [{ name: '顾晚', status: '首次登场' }],
      facts: ['顾晚持有密信'],
    },
  });
  longform.recordContinuity(bookId, 50, {
    continuity: {
      time: '第五十日',
      location: '北境',
      characters: [{ name: '沈舟', status: '断臂' }],
      facts: ['城主已经死亡'],
    },
    foreshadow: { resolved: ['铜钥匙'] },
  });

  const historical = longform.storyStateContext(bookId, 6, 20000);
  assert.match(historical, /沈舟：初入城/);
  assert.match(historical, /时间：第五日/);
  assert.match(historical, /地点：渡口/);
  assert.match(historical, /沈舟尚未见过城主/);
  assert.match(historical, /铜钥匙/);
  assert.doesNotMatch(historical, /断臂|顾晚|城主已经死亡|北境/);

  const current = longform.storyStateContext(bookId, 51, 20000);
  assert.match(current, /沈舟：断臂/);
  assert.match(current, /顾晚：首次登场/);
  assert.match(current, /时间：第五十日/);
  assert.match(current, /地点：北境/);
  assert.match(current, /城主已经死亡/);
  assert.doesNotMatch(current, /时间："|地点："/);
  assert.doesNotMatch(current, /铜钥匙/);
});

test('伏笔按埋设、推进、回收更新，回收后不再进入未回收上下文', () => {
  const bookId = createBook('伏笔生命周期');
  longform.recordContinuity(bookId, 1, { foreshadow: { planted: ['铜钥匙'] } });
  assert.equal(threadState(bookId, '铜钥匙').value.status, 'open');

  longform.recordContinuity(bookId, 2, { foreshadow: { advanced: ['铜钥匙'] } });
  assert.equal(threadState(bookId, '铜钥匙').value.status, 'open');
  assert.equal(threadState(bookId, '铜钥匙').chapter, 2);

  longform.recordContinuity(bookId, 3, { foreshadow: { resolved: ['铜钥匙'] } });
  assert.equal(threadState(bookId, '铜钥匙').value.status, 'resolved');
  assert.equal(threadState(bookId, '铜钥匙').chapter, 3);
  assert.doesNotMatch(longform.storyStateContext(bookId, 4), /铜钥匙/);
  assert.match(longform.foreshadowLedgerMarkdown(bookId), /\[已回收\].*铜钥匙/);
});

test('同章重跑移除回收事件后，伏笔状态从剩余事件重放', () => {
  const bookId = createBook('伏笔重跑');
  longform.recordContinuity(bookId, 1, { foreshadow: { planted: ['密道地图'] } });
  longform.recordContinuity(bookId, 2, { foreshadow: { resolved: ['密道地图'] } });
  assert.equal(threadState(bookId, '密道地图').value.status, 'resolved');

  longform.recordContinuity(bookId, 2, { foreshadow: { advanced: ['密道地图'] } });
  assert.equal(threadState(bookId, '密道地图').value.status, 'open');
  assert.equal(threadState(bookId, '密道地图').chapter, 2);
  const resolvedEvents = db.q(`SELECT id FROM thread_events
    WHERE book_id=? AND chapter_num=2 AND kind='resolved'`, bookId);
  assert.equal(resolvedEvents.length, 0);
});

test('同章重跑删除人物、事实和时空状态后回退到更早有效记录', () => {
  const bookId = createBook('状态回退');
  longform.recordContinuity(bookId, 2, {
    continuity: {
      time: '第一日清晨',
      location: '旧宅门厅',
      characters: [{ name: '林默', status: '尚未进城' }],
      facts: ['铜钥匙来自旧宅'],
    },
  });
  longform.recordContinuity(bookId, 5, {
    continuity: {
      time: '第三日雨夜',
      location: '城北商会',
      characters: [{ name: '林默', status: '已进城' }],
      facts: ['商会已经封锁'],
    },
  });

  longform.recordContinuity(bookId, 5, {
    continuity: { time: '', location: '', characters: [], facts: [] },
  });

  assert.equal(characterState(bookId, '林默').value.status, '尚未进城');
  assert.equal(characterState(bookId, '林默').chapter, 2);
  assert.deepEqual(storyState(bookId, 'fact', '铜钥匙来自旧宅'), {
    value: { text: '铜钥匙来自旧宅' }, chapter: 2,
  });
  assert.equal(storyState(bookId, 'fact', '商会已经封锁'), null);
  assert.deepEqual(storyState(bookId, 'timeline', 'current'), { value: '第一日清晨', chapter: 2 });
  assert.deepEqual(storyState(bookId, 'location', 'current'), { value: '旧宅门厅', chapter: 2 });
});

test('重跑旧章删除状态时不会清除后续章节已更新的状态', () => {
  const bookId = createBook('后续状态保护');
  longform.recordContinuity(bookId, 5, {
    continuity: {
      time: '第五日',
      location: '渡口',
      characters: [{ name: '林默', status: '旧状态' }],
      facts: ['旧事实'],
    },
  });
  longform.recordContinuity(bookId, 50, {
    continuity: {
      time: '第五十日',
      location: '王城',
      characters: [{ name: '林默', status: '断臂后昏迷' }],
      facts: ['旧事实'],
    },
  });

  longform.recordContinuity(bookId, 5, {
    continuity: { time: '', location: '', characters: [], facts: [] },
  });

  assert.equal(characterState(bookId, '林默').value.status, '断臂后昏迷');
  assert.equal(characterState(bookId, '林默').chapter, 50);
  assert.deepEqual(storyState(bookId, 'fact', '旧事实'), { value: { text: '旧事实' }, chapter: 50 });
  assert.deepEqual(storyState(bookId, 'timeline', 'current'), { value: '第五十日', chapter: 50 });
  assert.deepEqual(storyState(bookId, 'location', 'current'), { value: '王城', chapter: 50 });
});

test('每 50 章生成卷摘要，第 51 章可读取上一卷摘要', () => {
  const bookId = createBook('卷摘要');
  const timestamp = Date.now();
  for (let chapter = 1; chapter <= 50; chapter++) {
    db.run(`INSERT INTO chapter_summaries(book_id, chapter_num, title, content, updated_at)
      VALUES(?,?,?,?,?)`, bookId, chapter, `第${chapter}章`, `第${chapter}章推进了主线。`, timestamp);
  }

  const created = longform.refreshVolumeSummary(bookId, 50);
  assert.deepEqual(created, { volumeNum: 1, startChapter: 1, endChapter: 50 });
  const context = longform.volumeSummaryContext(bookId, 51);
  assert.match(context, /第1卷摘要（第1-50章）/);
  assert.match(context, /第50章推进了主线/);
});

test('进入第四卷后仍保留第一卷的压缩前情', () => {
  const bookId = createBook('早期卷前情');
  const timestamp = Date.now();
  for (let volume = 1; volume <= 3; volume++) {
    db.run(`INSERT INTO volume_summaries(book_id, volume_num, start_chapter, end_chapter, content, updated_at)
      VALUES(?,?,?,?,?,?)`, bookId, volume, (volume - 1) * 50 + 1, volume * 50,
    `# 第${volume}卷摘要\n\n第${volume}卷独有前情：主角获得了第${volume}件关键物品。`, timestamp);
  }

  const context = longform.volumeSummaryContext(bookId, 151, 50, 2200);
  assert.match(context, /更早卷级前情/);
  assert.match(context, /第1卷独有前情/);
  assert.match(context, /第2卷摘要/);
  assert.ok(context.length <= 2240, `卷摘要上下文应受预算约束，实际 ${context.length}`);
});

test('长卷压缩会均匀保留开头、中段和结尾章节', () => {
  const bookId = createBook('卷中段抽样');
  const timestamp = Date.now();
  for (let chapter = 1; chapter <= 50; chapter++) {
    db.run(`INSERT INTO chapter_summaries(book_id, chapter_num, title, content, updated_at)
      VALUES(?,?,?,?,?)`, bookId, chapter, `第${chapter}章`, `第${chapter}章节点：事件${chapter}。`, timestamp);
  }
  longform.refreshVolumeSummary(bookId, 50);

  const context = longform.volumeSummaryContext(bookId, 51, 50, 1600);
  assert.match(context, /第1章节点/);
  assert.match(context, /第2[56]章节点/);
  assert.match(context, /第50章节点/);
  assert.ok(context.length <= 1600, `卷摘要上下文应受预算约束，实际 ${context.length}`);
});

test('较早卷级前情按里程碑抽样，不只保留首尾两卷', () => {
  const bookId = createBook('早期卷中段');
  const timestamp = Date.now();
  for (let volume = 1; volume <= 12; volume++) {
    db.run(`INSERT INTO volume_summaries(book_id, volume_num, start_chapter, end_chapter, content, updated_at)
      VALUES(?,?,?,?,?,?)`, bookId, volume, (volume - 1) * 50 + 1, volume * 50,
    `# 第${volume}卷摘要\n\n- 第${volume}卷独有里程碑。`, timestamp);
  }

  const context = longform.volumeSummaryContext(bookId, 601, 50, 2400);
  assert.match(context, /第1卷独有里程碑/);
  assert.match(context, /第6卷独有里程碑/);
  assert.match(context, /第12卷独有里程碑/);
  assert.ok(context.length <= 2400, `卷摘要上下文应受预算约束，实际 ${context.length}`);
});

test('正文动态上下文受统一预算约束并保留高优先级内容', () => {
  const filler = '长'.repeat(40000);
  const prompt = misc.__test.composeBodyPromptContext({
    bookTitle: '百万字测试',
    n: 88,
    direction: `方向开头${filler}方向结尾`,
    planText: `本章规划${filler}`,
    outlineText: `当前细纲开头${filler}当前细纲结尾`,
    nextOutlineText: `下一章钩子${filler}`,
    nextPlanText: `下一章规划${filler}`,
    context: `资料上下文${filler}`,
    previousContext: `上一章开头${filler}上一章最后一句。`,
    recalledContext: `知识召回关键词${filler}`,
    targetWords: 3000,
    minimumWords: 2550,
  });

  assert.ok(prompt.length <= misc.__test.BODY_PROMPT_CONTEXT_CHARS,
    `正文上下文超过预算：${prompt.length}`);
  assert.match(prompt, /当前细纲开头/);
  assert.match(prompt, /当前细纲结尾/);
  assert.match(prompt, /上一章最后一句/);
  assert.match(prompt, /知识召回关键词/);
  assert.match(prompt, /至少完成约 2550 字/);
});

test('章节摘要保留目标、冲突、关系变化、事实、伏笔和实际章末承接', () => {
  const bookId = createBook('结构化章节摘要');
  const body = `${'开篇铺垫。'.repeat(1800)}沈舟扣住徽章，门外传来第二声敲门。`;
  misc.__test.upsertChapterSummary(bookId, 3, {
    title: '第3章 夜探商会',
    goal: '潜入商会寻找失踪账册',
    conflict: '沈舟必须在巡夜人返回前拿到账册，但商会管事认出了他',
    hook: '账册最后一页写着沈舟自己的名字',
    scenes: [
      { title: '翻墙', event: '沈舟从后巷翻入商会' },
      { title: '对峙', event: '管事以旧徽章逼问沈舟来意' },
    ],
    foreshadow: { planted: ['管事的旧伤'], advanced: ['铜钥匙'], resolved: [] },
    continuity: {
      time: '第三日夜',
      location: '城北商会',
      characters: [{ name: '沈舟', status: '左肩受伤', relations: '与管事由旧识转为敌对', goal: '取走账册' }],
      facts: ['商会地下有密道', '管事认识旧徽章'],
      openThreads: ['账册最后一页的署名'],
      resolvedThreads: ['铜钥匙的用途'],
    },
  }, body);

  const row = db.one(`SELECT content FROM chapter_summaries WHERE book_id=? AND chapter_num=3`, bookId);
  assert.ok(row.content.length <= misc.__test.CHAPTER_SUMMARY_CHARS);
  assert.match(row.content, /本章目标：潜入商会/);
  assert.match(row.content, /关键冲突与推进：沈舟必须在巡夜人返回前/);
  assert.match(row.content, /人物与关系变化：沈舟（左肩受伤；关系：与管事由旧识转为敌对/);
  assert.match(row.content, /关键既定事实：商会地下有密道/);
  assert.match(row.content, /伏笔变化：.*管事的旧伤/);
  assert.match(row.content, /章末钩子：账册最后一页写着沈舟自己的名字/);
  assert.match(row.content, /章末承接：.*第二声敲门/);
});

test('续写请求只携带正文尾部锚点，长稿多次续写不会重复回传全文', () => {
  const raw = `正文开头标记${'中间正文。'.repeat(30000)}正文最后一句。`;
  const messages = misc.__test.composeContinuationMessages({
    system: '系统规则',
    user: `本章上下文${'长'.repeat(30000)}`,
    raw,
    currentWords: 4200,
    targetWords: 5000,
    minimumWords: 4250,
  });

  assert.equal(messages[2].role, 'assistant');
  assert.ok(messages[2].content.length <= misc.__test.CONTINUATION_ANCHOR_CHARS + 40);
  assert.match(messages[2].content, /正文最后一句/);
  assert.doesNotMatch(messages[2].content, /正文开头标记/);
  const dynamicLength = messages[1].content.length + messages[2].content.length + messages[3].content.length;
  assert.ok(dynamicLength <= misc.__test.BODY_PROMPT_CONTEXT_CHARS + misc.__test.CONTINUATION_ANCHOR_CHARS + 800,
    `续写动态上下文超限：${dynamicLength}`);
});

test('长期状态同时保留最早关键事实与最近事实', () => {
  const bookId = createBook('早期事实保留');
  longform.recordContinuity(bookId, 1, {
    continuity: { facts: ['旧宅位于城西', '铜钥匙不能接触海水'] },
  });
  for (let chapter = 2; chapter <= 30; chapter++) {
    longform.recordContinuity(bookId, chapter, {
      continuity: { facts: [`第${chapter}章确立事实`] },
    });
  }

  const context = longform.storyStateContext(bookId, 31, 20000);
  assert.match(context, /旧宅位于城西/);
  assert.match(context, /\[早期\].*旧宅位于城西/);
  assert.match(context, /第30章确立事实/);
});

test('三十章后仍保留早期高频核心人物，人物上下文不超过 24 人', () => {
  const bookId = createBook('核心人物长期记忆');
  longform.recordContinuity(bookId, 1, {
    continuity: { characters: [{ name: '沈舟', status: '主角' }, { name: '过客甲', status: '问路' }] },
  });
  for (let chapter = 2; chapter <= 5; chapter++) {
    longform.recordContinuity(bookId, chapter, {
      continuity: { characters: [{ name: '沈舟', status: `第${chapter}章状态` }] },
    });
  }

  const recurring = Array.from({ length: 8 }, (_, index) => `核心配角${index + 1}`);
  for (let chapter = 20; chapter <= 22; chapter++) {
    longform.recordContinuity(bookId, chapter, {
      continuity: { characters: recurring.map((name) => ({ name, status: `第${chapter}章在场` })) },
    });
  }
  for (let index = 0; index < 20; index++) {
    longform.recordContinuity(bookId, 30 + index, {
      continuity: { characters: [{ name: `临时人物${index + 1}`, status: '只出现一次' }] },
    });
  }

  longform.recordContinuity(bookId, 5, {
    continuity: { characters: [{ name: '沈舟', status: '重写后的第五章状态' }] },
  });
  const mentions = db.one(`SELECT COUNT(*) AS count FROM character_mentions
    WHERE book_id=? AND state_key=?`, bookId, '沈舟');
  assert.equal(mentions.count, 5, '同章重跑不应重复累计人物出场次数');

  const context = longform.storyStateContext(bookId, 50, 30000);
  const section = context.match(/## 人物状态[^\n]*\n([\s\S]*?)(?=\n## |$)/)?.[1] || '';
  const lines = section.split('\n').filter((line) => line.startsWith('- '));
  assert.ok(lines.length <= 24, `人物上下文超过 24 人：${lines.length}`);
  assert.match(section, /\[核心\] 沈舟/);
  assert.doesNotMatch(section, /过客甲/, '只出现一次且已离开近期窗口的路人不应占用长期上下文');
});

test('任何非空已有正文都默认保留，并可补齐缺失摘要与连续性', () => {
  const bookId = createBook('已有正文修复');
  const outlineName = '细纲_第1章.md';
  const outline = {
    title: '第1章 雨夜来客',
    goal: '确认来客身份',
    hook: '来客拿出一枚旧徽章',
    scenes: [
      { title: '敲门', event: '来客在雨夜敲门' },
      { title: '相认', event: '旧徽章暴露身份' },
    ],
    continuity: {
      time: '雨夜',
      location: '旧宅',
      characters: [{ name: '沈舟', status: '警觉', location: '门厅' }],
      facts: ['旧宅位于城西'],
      openThreads: ['旧徽章的来历'],
    },
  };
  core.writeFileTo({ bookId, group: '细纲', name: outlineName, content: JSON.stringify(outline, null, 2) });
  core.writeFileTo({ bookId, group: '正文', name: '第1章.md', content: '短稿。' });

  assert.equal(misc.__test.existingBodyLooksUsable('短稿。'), true);
  assert.equal(misc.__test.existingBodyLooksUsable('  \n  '), false);
  assert.equal(misc.__test.existingBodyLooksUsable('<|eos|>'), false);
  core.setFileAiFlag({ bookId, group: '正文', name: '第1章.md', flag: 'aiOff', value: true });
  const protectedBody = misc.__test.chapterFileIndexes(bookId).bodies.get(1);
  assert.equal(protectedBody.aiOff, true);
  assert.equal(misc.__test.shouldSkipExistingBody(protectedBody, '', true), true);

  assert.equal(misc.__test.repairChapterMemory(bookId, 1, outlineName, '短稿。'), 'summary');
  assert.ok(db.one(`SELECT 1 AS present FROM chapter_summaries WHERE book_id=? AND chapter_num=1`, bookId));
  assert.ok(db.one(`SELECT 1 AS present FROM chapter_continuity WHERE book_id=? AND chapter_num=1`, bookId));
  assert.equal(misc.__test.repairChapterMemory(bookId, 1, outlineName, '短稿。'), '');
});

test('第五十章已有正文缺失记忆时，可一次补齐摘要、连续性和卷摘要', () => {
  const bookId = createBook('断点恢复五十章');
  const outlineName = '细纲_第50章.md';
  const outline = {
    title: '第50章 卷末转折',
    goal: '完成第一卷收束',
    hook: '城门外出现第二支军队',
    scenes: [
      { title: '会盟', event: '沈舟与旧敌暂时结盟' },
      { title: '变局', event: '盟约达成时城外传来战鼓' },
    ],
    continuity: {
      time: '第一卷第50日',
      location: '王城北门',
      characters: [{ name: '沈舟', status: '成为盟约见证人' }],
      facts: ['第二支军队打着失踪王子的旗号'],
      openThreads: ['失踪王子的真实身份'],
    },
  };
  core.writeFileTo({ bookId, group: '细纲', name: outlineName, content: JSON.stringify(outline, null, 2) });

  assert.equal(misc.__test.repairChapterMemory(bookId, 50, outlineName, '卷末正文。'), 'summary');
  assert.ok(db.one(`SELECT 1 AS present FROM chapter_summaries WHERE book_id=? AND chapter_num=50`, bookId));
  assert.ok(db.one(`SELECT 1 AS present FROM chapter_continuity WHERE book_id=? AND chapter_num=50`, bookId));
  assert.ok(db.one(`SELECT 1 AS present FROM volume_summaries WHERE book_id=? AND volume_num=1`, bookId));
  assert.equal(misc.__test.repairChapterMemory(bookId, 50, outlineName, '卷末正文。'), '');
});

test('章节规划与摘要 Markdown 可导入 SQLite 并可重新物化', () => {
  const bookId = createBook('Markdown 同步');
  const planMarkdown = `# 章节规划

## 第1-2章

### 第1章
雨夜抵达旧宅。

### 第2章
发现徽章背后的名单。
`;
  core.writeFileTo({ bookId, group: '设定', name: '章节规划.md', content: planMarkdown });
  misc.__test.ensureChapterPlansImported(bookId);
  const plans = misc.__test.chapterPlanEntries(bookId);
  assert.equal(plans.size, 2);
  assert.match(plans.get(2), /名单/);

  misc.__test.materializeChapterPlan(bookId);
  assert.match(core.readFileFrom({ bookId, group: '设定', name: '章节规划.md' }), /第1-2章/);

  const summaryMarkdown = `# 章节摘要

## 第1章 雨夜抵达
沈舟在旧宅发现一枚徽章。

## 第2章 名单
名单指向城北商会。
`;
  core.writeFileTo({ bookId, group: '设定', name: '章节摘要.md', content: summaryMarkdown });
  misc.__test.ensureChapterSummariesImported(bookId);
  assert.equal(db.one(`SELECT COUNT(*) AS count FROM chapter_summaries WHERE book_id=?`, bookId).count, 2);

  misc.__test.materializeChapterSummaries(bookId);
  const materialized = core.readFileFrom({ bookId, group: '设定', name: '章节摘要.md' });
  assert.match(materialized, /第2章 名单/);
  assert.match(materialized, /城北商会/);
});

test('章节摘要增量物化不重复，追加内容可检索，旧章修改会全量重建', () => {
  const bookId = createBook('摘要增量索引');
  const timestamp = Date.now();
  for (let chapter = 1; chapter <= 3; chapter++) {
    db.run(`INSERT INTO chapter_summaries(book_id, chapter_num, title, content, updated_at)
      VALUES(?,?,?,?,?)`, bookId, chapter, `第${chapter}章`, `第${chapter}章普通记录。`, timestamp);
  }
  assert.equal(misc.__test.materializeChapterSummaries(bookId, { force: true }).mode, 'rewrite');

  db.run(`INSERT INTO chapter_summaries(book_id, chapter_num, title, content, updated_at)
    VALUES(?,?,?,?,?)`, bookId, 4, '第4章 星图', '星图密钥藏在钟楼第三层的铜匣中。', timestamp + 1);
  assert.equal(misc.__test.materializeChapterSummaries(bookId).mode, 'append');
  let markdown = core.readFileFrom({ bookId, group: '设定', name: '章节摘要.md' });
  assert.equal((markdown.match(/## 第1章/g) || []).length, 1);
  assert.equal((markdown.match(/## 第4章/g) || []).length, 1);
  assert.match(knowledge.retrieve({ bookId, query: '星图密钥藏在何处', limit: 3 }).map((item) => item.content).join('\n'), /星图密钥/);

  db.run(`UPDATE chapter_summaries SET content=? WHERE book_id=? AND chapter_num=2`, '修订后的第二章揭示了内奸身份。', bookId);
  assert.equal(misc.__test.materializeChapterSummaries(bookId, { changedChapter: 2 }).mode, 'rewrite');
  markdown = core.readFileFrom({ bookId, group: '设定', name: '章节摘要.md' });
  assert.match(markdown, /修订后的第二章/);
  assert.doesNotMatch(markdown, /第2章普通记录/);
  assert.equal((markdown.match(/## 第2章/g) || []).length, 1);
});

test('摘要追加中断后回滚到旧长度，重启不会留下重复章节', () => {
  const bookId = createBook('摘要追加崩溃恢复');
  const timestamp = Date.now();
  for (let chapter = 1; chapter <= 3; chapter++) {
    db.run(`INSERT INTO chapter_summaries(book_id, chapter_num, title, content, updated_at)
      VALUES(?,?,?,?,?)`, bookId, chapter, `第${chapter}章`, `第${chapter}章稳定记录。`, timestamp);
  }
  misc.__test.materializeChapterSummaries(bookId, { force: true });
  db.run(`INSERT INTO chapter_summaries(book_id, chapter_num, title, content, updated_at)
    VALUES(?,?,?,?,?)`, bookId, 4, '第4章 钟楼', '第四章由数据库保存的正式内容。', timestamp + 1);

  const beforeAppend = core.fileStatFrom({ bookId, group: '设定', name: '章节摘要.md' }).size;
  core.setSetting(`chapter_summary_append_pending__${bookId}`, JSON.stringify({
    offset: beforeAppend, marker: 3, until: 4, startedAt: timestamp,
  }));
  core.appendFileTo({
    bookId,
    group: '设定',
    name: '章节摘要.md',
    content: '## 第4章 钟楼\n这是进程中断前留下的重复片段。\n\n',
  });

  assert.equal(misc.__test.materializeChapterSummaries(bookId).mode, 'append');
  const markdown = core.readFileFrom({ bookId, group: '设定', name: '章节摘要.md' });
  assert.equal((markdown.match(/## 第4章/g) || []).length, 1);
  assert.doesNotMatch(markdown, /重复片段/);
  assert.match(markdown, /数据库保存的正式内容/);
  assert.equal(db.one(`SELECT value FROM settings WHERE key=?`, `chapter_summary_append_pending__${bookId}`), undefined);

  const indexed = db.one(`SELECT chunk_count FROM kb_files
    WHERE book_id=? AND group_name='设定' AND file_name='章节摘要.md'`, bookId);
  const chunks = db.q(`SELECT content, chapter_num FROM kb_chunks
    WHERE book_id=? AND group_name='设定' AND file_name='章节摘要.md' ORDER BY chunk_index`, bookId);
  // 摘要按"## 第N章"逐章切片，每片带自己的章号，才能按目标章做时间过滤。
  assert.equal(chunks.length, indexed.chunk_count);
  assert.equal(chunks.length, 4);
  assert.deepEqual(chunks.map((row) => Number(row.chapter_num)), [1, 2, 3, 4]);
  assert.equal(chunks.filter((row) => row.content.includes('## 第4章')).length, 1);
  assert.doesNotMatch(chunks.map((row) => row.content).join('\n'), /重复片段/);
});

test('片段索引不完整时追加会回退为全量重建', () => {
  const bookId = createBook('索引自愈');
  const initial = `# 资料\n\n${'旧城档案记录着潮汐和商会往来。'.repeat(120)}`;
  core.writeFileTo({ bookId, group: '参考', name: '档案.md', content: initial });
  const before = db.one(`SELECT chunk_count FROM kb_files
    WHERE book_id=? AND group_name='参考' AND file_name='档案.md'`, bookId);
  assert.ok(before.chunk_count > 1);

  db.run(`DELETE FROM kb_chunks WHERE book_id=? AND group_name='参考' AND file_name='档案.md'
    AND chunk_index=0`, bookId);
  core.appendFileTo({ bookId, group: '参考', name: '档案.md', content: '\n北塔地下的旧井保存着赤铜密钥。\n' });

  const metadata = db.one(`SELECT chunk_count FROM kb_files
    WHERE book_id=? AND group_name='参考' AND file_name='档案.md'`, bookId);
  const chunks = db.q(`SELECT chunk_index,content FROM kb_chunks
    WHERE book_id=? AND group_name='参考' AND file_name='档案.md' ORDER BY chunk_index`, bookId);
  assert.equal(metadata.chunk_count, chunks.length);
  assert.deepEqual(chunks.map((row) => row.chunk_index), chunks.map((_, index) => index));
  assert.match(chunks.map((row) => row.content).join('\n'), /赤铜密钥/);
});

test('中文长查询会拆分检索词并召回长期资料', () => {
  const bookId = createBook('中文长查询检索');
  core.writeFileTo({
    bookId,
    group: '设定',
    name: '旧宅线索.md',
    content: '沈舟在旧宅发现铜钥匙和密道地图。地图背面写着城北商会的旧称。',
  });

  const query = '沈舟在旧宅发现铜钥匙和密道地图后决定去哪里';
  const terms = knowledge.searchTerms(query);
  assert.ok(terms.length > 1, '长中文查询应拆成多个三字检索词');
  assert.ok(terms.length <= 16, '检索词数量应受上限约束');
  assert.ok(terms.some((term) => term === '沈舟在' || term === '铜钥匙' || term === '密道地'));

  const matches = knowledge.retrieve({ bookId, query, limit: 3 });
  assert.ok(matches.length > 0, '应召回包含旧宅线索的资料');
  assert.match(matches.map((item) => item.content).join('\n'), /铜钥匙/);
});

test('全文检索精确命中不会被低分哈希向量过滤', () => {
  const bookId = createBook('全文检索混合召回');
  const marker = '赤铜密钥藏在北塔地下的旧井里，井壁刻着潮汐图。';
  const filler = '沈舟观察四周，顾晚核对名单，两人决定在日落前继续追查。';
  let content = '# 长篇资料\n\n';
  for (let chapter = 1; chapter <= 100; chapter++) {
    const lead = chapter === 73 ? marker : `第${chapter}章人物沿着旧城街巷调查线索。`;
    content += `## 第${chapter}章 事件${chapter}\n${(lead + filler.repeat(150)).slice(0, 3900)}\n\n`;
  }
  core.writeFileTo({ bookId, group: '参考', name: '长篇资料.md', content });

  const query = '赤铜密钥藏在什么地方';
  const target = knowledge.splitChunks(content).find((chunk) => chunk.includes(marker));
  const queryVector = knowledge.vectorFor(query);
  const targetVector = knowledge.vectorFor(target);
  let dot = 0;
  for (let index = 0; index < queryVector.length; index++) dot += queryVector[index] * targetVector[index];
  assert.ok(dot < 0.015, '回归数据需要覆盖向量分数不足、只能依靠全文检索的情况');

  const matches = knowledge.retrieve({ bookId, query, limit: 8, maxChars: 8000 });
  assert.match(matches.map((item) => item.content).join('\n'), /赤铜密钥/);
});

test('五千章批处理节拍会周期性让出事件循环', async () => {
  let timerFired = false;
  setTimeout(() => { timerFired = true; }, 0);
  for (let chapter = 1; chapter <= 5000; chapter++) {
    if (chapter % 25 === 0) await misc.__test.yieldBatch();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timerFired, true);
});
