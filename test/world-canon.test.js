'use strict';

// 世界规则与正典事件：存取、Markdown 镜像回写、提示词注入、确定性审计。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-canon-'));
process.env.FABULA_DATA_DIR = tempDir;
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';

const db = require('../lib/db');
db.open(path.join(__dirname, '..', 'data', 'writerx.seed.db'));

const audit = require('../lib/consistency-audit');
const core = require('../lib/handlers-core');
const llm = require('../lib/llm');
const longform = require('../lib/longform-memory');
const misc = require('../lib/handlers-misc');

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('规则 CRUD：落库、按优先级排序、物化成 Markdown、删除同步', () => {
  const bookId = core.createBook({ title: '规则-CRUD', genre: '长篇', pov: '第三人称' }).id;

  misc.saveWorldRule({
    bookId, ruleKey: 'R-灵力', content: '灵力不能起死回生，也不能逆流时间。',
    banTerms: ['起死回生', '时光倒流'], priority: 5,
  });
  misc.saveWorldRule({ bookId, ruleKey: 'R-称谓', content: '皇族自称朕，臣子称陛下。', priority: 1 });
  misc.saveWorldRule({ bookId, ruleKey: 'R-弃案', content: '旧案草稿。', enabled: false });

  const rules = misc.getWorldRules({ bookId }).rules;
  assert.equal(rules.length, 3);
  assert.deepEqual(rules.map((rule) => rule.ruleKey), ['R-灵力', 'R-称谓', 'R-弃案'], '启用的按优先级降序，停用的垫底');
  assert.deepEqual(rules[0].banTerms, ['起死回生', '时光倒流']);

  const file = core.readFileFrom({ bookId, group: '设定', name: '世界规则.md' }) || '';
  assert.match(file, /## R-灵力/);
  assert.match(file, /灵力不能起死回生/);
  assert.match(file, /禁词：起死回生，时光倒流/);
  assert.match(file, /停用：是/);

  misc.deleteWorldRule({ bookId, ruleKey: 'R-称谓' });
  const afterDelete = misc.getWorldRules({ bookId }).rules;
  assert.deepEqual(afterDelete.map((rule) => rule.ruleKey), ['R-灵力', 'R-弃案']);
  const fileAfter = core.readFileFrom({ bookId, group: '设定', name: '世界规则.md' }) || '';
  assert.ok(!fileAfter.includes('R-称谓'), '物化文件必须同步删除');
});

test('正典事件 CRUD：锚定章节、物化 Markdown、按章排序', () => {
  const bookId = core.createBook({ title: '正典-CRUD', genre: '长篇', pov: '第三人称' }).id;

  misc.saveCanonEvent({
    bookId, eventKey: '第37章取刀', chapterNum: 37, title: '沈砚取得断雁刀',
    detail: '沈砚在铁匠铺以三枚银币买下断雁刀。', keywords: ['断雁刀', '铁匠铺掌柜'],
  });
  misc.saveCanonEvent({
    bookId, eventKey: '第12章进城', chapterNum: 12, title: '沈砚初入京城', detail: '沈砚随商队入京。',
  });

  const events = misc.getCanonEvents({ bookId }).events;
  assert.deepEqual(events.map((event) => event.chapterNum), [12, 37]);
  assert.equal(events[1].keywords.join(','), '断雁刀,铁匠铺掌柜');

  const file = core.readFileFrom({ bookId, group: '设定', name: '正典事件.md' }) || '';
  assert.match(file, /### 第12章 沈砚初入京城/);
  assert.match(file, /### 第37章 沈砚取得断雁刀/);
  assert.match(file, /经过：沈砚在铁匠铺以三枚银币买下断雁刀。/);
  assert.match(file, /关键词：断雁刀，铁匠铺掌柜/);
});

test('外部编辑 Markdown 后读路径自动回导，不残留旧行', () => {
  const bookId = core.createBook({ title: '规则-回导', genre: '长篇', pov: '第三人称' }).id;
  misc.saveWorldRule({ bookId, ruleKey: 'R-旧', content: '旧规则。' });

  // 模拟用户直接在文件树里改 设定/世界规则.md。
  core.writeFileTo({
    bookId, group: '设定', name: '世界规则.md',
    content: [
      '# 世界规则', '',
      '## R-新', '',
      '大陆没有海，所有水域都是湖。', '',
      '禁词：大海，海洋', '',
    ].join('\n'),
  });

  const rules = misc.getWorldRules({ bookId }).rules;
  assert.equal(rules.length, 1, '外部编辑必须全量替换，不能残留旧行');
  assert.equal(rules[0].ruleKey, 'R-新');
  assert.equal(rules[0].content, '大陆没有海，所有水域都是湖。');
  assert.deepEqual(rules[0].banTerms, ['大海', '海洋']);
});

test('解析器容忍空行、全半角冒号与停用标记', () => {
  const rules = longform.parseWorldRulesMarkdown([
    '# 世界规则', '',
    '## R1 灵力', '',
    '灵力有代价。', '',
    '优先级：7', '',
    '禁词：免费灵力、 无限', '',
    '停用：是', '',
  ].join('\n'));
  assert.equal(rules.length, 1);
  assert.equal(rules[0].ruleKey, 'R1 灵力');
  assert.equal(rules[0].content, '灵力有代价。');
  assert.deepEqual(rules[0].banTerms, ['免费灵力', '无限']);
  assert.equal(rules[0].priority, 7);
  assert.equal(rules[0].enabled, false);

  const events = longform.parseCanonEventsMarkdown([
    '# 正典事件', '',
    '### 第3章 拜师', '',
    '经过：沈砚拜入云山门下。', '',
    '后续细节也并入经过。', '',
    '关键词：云山, 拜师', '',
  ].join('\n'));
  assert.equal(events.length, 1);
  assert.equal(events[0].chapterNum, 3);
  assert.equal(events[0].title, '拜师');
  assert.equal(events[0].detail, '沈砚拜入云山门下。 后续细节也并入经过。');
  assert.deepEqual(events[0].keywords, ['云山', '拜师']);
});

test('提示词注入：规则全书带上，事件只取目标章之前的部分', () => {
  const bookId = core.createBook({ title: '规则-注入', genre: '长篇', pov: '第三人称' }).id;
  misc.saveWorldRule({ bookId, ruleKey: 'R1', content: '灵力有代价。', banTerms: ['免费灵力'], priority: 3 });
  misc.saveWorldRule({ bookId, ruleKey: 'R2', content: '旧案草稿。', enabled: false });
  misc.saveCanonEvent({ bookId, eventKey: 'e3', chapterNum: 3, title: '拜师', detail: '沈砚拜入云山。' });
  misc.saveCanonEvent({ bookId, eventKey: 'e9', chapterNum: 9, title: '夺刀', detail: '沈砚夺得断雁刀。' });

  const rulesContext = longform.worldRulesContext(bookId);
  assert.match(rulesContext, /世界观规则/);
  assert.match(rulesContext, /灵力有代价。/);
  assert.match(rulesContext, /禁用表述：免费灵力/);
  assert.ok(!rulesContext.includes('旧案草稿'), '停用规则不进提示词');

  const before = longform.canonEventsContext(bookId, 5);
  assert.match(before, /第3章：拜师/);
  assert.ok(!before.includes('夺刀'), '目标章之后的正典事件不得提前泄漏');
  const after = longform.canonEventsContext(bookId, 10);
  assert.match(after, /第3章：拜师/);
  assert.match(after, /第9章：夺刀/);
  assert.equal(longform.canonEventsContext(bookId, 3), '', '目标章之前没有事件时返回空');
});

test('审计：窗口级禁词命中与干净书对照', () => {
  const bookId = core.createBook({ title: '规则-审计', genre: '长篇', pov: '第三人称' }).id;
  misc.saveWorldRule({ bookId, ruleKey: 'R-朝代', content: '背景为古代，禁止现代器物。', banTerms: ['手机', '地铁'] });

  core.writeFileTo({ bookId, group: '正文', name: '第1章.md', content: '第1章 他沿着长廊走了很久。\n远处的钟楼报过五更。' });
  core.writeFileTo({ bookId, group: '正文', name: '第2章.md', content: '第2章 有人低头看手机，队伍排得像地铁闸机。' });

  const report = audit.auditWindow({ bookId, fromChapter: 1, toChapter: 2 });
  const violations = report.issues.filter((issue) => issue.code === 'world_rule_violation');
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /R-朝代/);
  assert.match(violations[0].message, /第2章/);
  assert.ok(!violations[0].message.includes('第1章'), '第1章没有命中，不得误报');

  const cleanBook = core.createBook({ title: '规则-审计干净', genre: '长篇', pov: '第三人称' }).id;
  core.writeFileTo({ bookId: cleanBook, group: '正文', name: '第1章.md', content: '第1章 他沿着长廊走了很久，直到灯油燃尽。' });
  const clean = audit.auditWindow({ cleanBook, fromChapter: 1, toChapter: 1 });
  assert.equal(clean.issues.filter((issue) => issue.code === 'world_rule_violation').length, 0);
});

test('审计：卷级正典事件复现，且受间隔与关键词长度双阈值保护', () => {
  const bookId = core.createBook({ title: '正典-审计', genre: '长篇', pov: '第三人称' }).id;
  misc.saveCanonEvent({
    bookId, eventKey: '第5章断雁刀', chapterNum: 5, title: '沈砚取得断雁刀',
    keywords: ['断雁刀在鞘中嗡鸣', '短刀'],
  });

  // 第 55 章距锚定章 50 章（≥ 20）：长指纹命中 → 复现告警。
  core.writeFileTo({ bookId, group: '正文', name: '第55章.md', content: '第55章 他握紧断雁刀在鞘中嗡鸣的旧物，站在井台边。' });
  const far = audit.auditVolume({ bookId, volumeNum: 2 });
  const echoes = far.issues.filter((issue) => issue.code === 'canon_event_echo');
  assert.equal(echoes.length, 1);
  assert.match(echoes[0].message, /第55章/);
  assert.match(echoes[0].message, /断雁刀在鞘中嗡鸣/);
  assert.ok(!echoes[0].message.includes('短刀'), '短于 6 字的关键词不作为指纹');

  // 第 12 章距锚定章 7 章（< 20）：不告警。
  core.writeFileTo({ bookId, group: '正文', name: '第12章.md', content: '第12章 他又听见了断雁刀在鞘中嗡鸣的回响。' });
  const near = audit.auditVolume({ bookId, volumeNum: 1 });
  assert.equal(near.issues.filter((issue) => issue.code === 'canon_event_echo').length, 0,
    '间隔不足的正典事件不算复现');
});

test('AI 共创：gen_chapter_outline 的提示词同样带上规则与正典事件', async () => {
  const bookId = core.createBook({ title: '规则-共创细纲', genre: '长篇', pov: '第三人称' }).id;
  misc.saveWorldRule({ bookId, ruleKey: 'R1', content: '大陆没有海。', banTerms: ['大海'] });
  misc.saveCanonEvent({ bookId, eventKey: '第1章入城', chapterNum: 1, title: '入城', detail: '沈砚进入青州城。' });

  const seen = [];
  llm.activeChannel = () => ({ baseUrl: 'http://stub.local', key: 'stub', model: 'stub-model', noThinking: true });
  llm.chatCompletion = async function* (options) {
    seen.push(options.messages.map((message) => String(message.content || '')).join('\n'));
    yield { type: 'delta', text: JSON.stringify({
      title: '第2章 试炼', goal: '推进目标', conflict: '僵持', hook: '钩子',
      scenes: [{ title: '试探', location: '长廊', summary: '试探' }, { title: '交锋', location: '石门', summary: '冲突' }],
      continuity: {
        time: '第2日', location: '长廊',
        characters: [{ name: '沈砚', status: '清醒', goal: '进城', relations: '独行', location: '长廊' }],
        facts: [], openThreads: [], resolvedThreads: [],
      },
      foreshadow: { planted: [], advanced: [], resolved: [] },
    }) };
    yield { type: 'meta', usage: { prompt_tokens: 5, completion_tokens: 6 }, finishReason: 'stop' };
  };

  // 第 2 章：第 1 章锚定的事件已经发生，必须出现在提示词里。
  await misc.genChapterOutline({ bookId, chapterNum: 2 });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /# 世界观规则（任何章节不得违背）/, '智能写作的系统提示词必须带规则');
  assert.match(seen[0], /大陆没有海。（禁用表述：大海）/);
  assert.match(seen[0], /第1章：入城——沈砚进入青州城。/);

  // 第 1 章：事件锚定在自身，属于未来，不得泄漏。
  seen.length = 0;
  await misc.genChapterOutline({ bookId, chapterNum: 1 });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /# 世界观规则（任何章节不得违背）/);
  assert.ok(!seen[0].includes('不得矛盾或当作未发生'), '生成第1章时不得提前泄漏第1章锚定的事件');
});

test('AI 共创：自由对话视角（无章节锚点）可见全部正典事件', () => {
  const bookId = core.createBook({ title: '规则-共创对话', genre: '长篇', pov: '第三人称' }).id;
  misc.saveWorldRule({ bookId, ruleKey: 'R1', content: '大陆没有海。' });
  misc.saveCanonEvent({ bookId, eventKey: 'e1', chapterNum: 1, title: '入城', detail: '沈砚进入青州城。' });
  misc.saveCanonEvent({ bookId, eventKey: 'e9', chapterNum: 9, title: '夺刀', detail: '沈砚夺得断雁刀。' });

  const context = longform.bookStoryContext(bookId);
  assert.match(context, /# 世界观规则/);
  assert.match(context, /第1章：入城/);
  assert.match(context, /第9章：夺刀/, '自由对话没有章节锚点，全部正典事件对模型可见');
  assert.equal(longform.bookStoryContext(null), '', '无 bookId 时返回空，不注入');
});

test('AI 共创：交互保存正文后自动补齐长期记忆', () => {
  const bookId = core.createBook({ title: '规则-共创保存', genre: '长篇', pov: '第三人称' }).id;
  const outline = JSON.stringify({
    title: '第1章 试炼', goal: '推进目标', conflict: '僵持', hook: '钩子',
    scenes: [{ title: '试探', location: '长廊', summary: '试探' }, { title: '交锋', location: '石门', summary: '冲突' }],
    continuity: {
      time: '第1日', location: '长廊',
      characters: [{ name: '沈砚', status: '清醒', goal: '进城', relations: '独行', location: '长廊' }],
      facts: ['石门未开启'], openThreads: [], resolvedThreads: [],
    },
    foreshadow: { planted: ['陌生名字'], advanced: [], resolved: [] },
  });
  core.writeFileTo({ bookId, group: '细纲', name: '细纲_第1章.md', content: outline });
  core.writeFileTo({ bookId, group: '正文', name: '第1章.md', content: '第1章 他沿着长廊走到尽头，推开了石门。\n门外传来第三个人的脚步声。' });

  const first = misc.repairAfterBodySave({ bookId, group: '正文', name: '第1章.md' });
  assert.equal(first.repaired, 'summary', '有完整细纲的章节走与批量跳过路径相同的补齐');
  const summary = db.one(`SELECT title, content FROM chapter_summaries WHERE book_id=? AND chapter_num=?`, bookId, 1);
  assert.ok(summary, '章节摘要已入库');
  assert.match(summary.title, /第1章/);
  assert.ok(db.one(`SELECT 1 AS present FROM chapter_continuity WHERE book_id=? AND chapter_num=?`, bookId, 1),
    '连续性状态已入库');

  // 幂等：再次保存不重复补齐。
  const second = misc.repairAfterBodySave({ bookId, group: '正文', name: '第1章.md' });
  assert.equal(second, null);

  // 没有细纲的交互章节退化为最小摘要。
  const bareBook = core.createBook({ title: '规则-共创裸章', genre: '长篇', pov: '第三人称' }).id;
  core.writeFileTo({ bookId: bareBook, group: '正文', name: '第2章.md', content: '第2章 他在井台边停下脚步。\n远处传来打更声。' });
  const minimal = misc.repairAfterBodySave({ bookId: bareBook, group: '正文', name: '第2章.md' });
  assert.equal(minimal.repaired, 'summary-minimal', '无细纲时记最小摘要，不断档');
  const bareSummary = db.one(`SELECT title FROM chapter_summaries WHERE book_id=? AND chapter_num=?`, bareBook, 2);
  assert.match(bareSummary.title, /第2章/);

  // 非正文组与无法识别章号的文件不动。
  assert.equal(misc.repairAfterBodySave({ bookId, group: '设定', name: '世界规则.md' }), null);
  assert.equal(misc.repairAfterBodySave({ bookId, group: '正文', name: '片段.md' }), null);
});

test('批量生成真实带上规则：桩收到的细纲与正文系统提示词都含规则与正典事件', async () => {
  const bookId = core.createBook({ title: '规则-批量', genre: '长篇', pov: '第三人称' }).id;
  core.setBookPlanSettings({ bookId, totalChapters: 2, chapterWords: 400 });
  misc.saveWorldRule({ bookId, ruleKey: 'R1', content: '大陆没有海。', banTerms: ['大海'] });
  misc.saveCanonEvent({ bookId, eventKey: '第1章入城', chapterNum: 1, title: '入城', detail: '沈砚进入青州城。' });

  // 8 句/章、两章各取池中不相交的 8 句：相邻章零共享，不会触发逐字重合门禁；
  // 篇幅约 420 字，高于 85% 下限（340）且低于 1.25 倍上限（500）。
  const SENTENCE_POOL = [
    '铜灯的火苗被穿堂风压低，他把袖口拢紧，沿着潮湿的石阶一级一级往上走，鞋底在苔痕上打滑。',
    '墙上的刻痕比昨夜多了一道，刀口很新，边角还挂着细碎的白屑，说明刻的人走得很急。',
    '门后传来木轴转动的声响，随即又归于沉寂，像有人只是试了试把手，最终没有推开。',
    '她在窗棂上敲了三下，停顿，再敲一下，那是旧年约定的暗号，只有两个人知道。',
    '案上的茶已经凉透，杯沿留着一圈淡淡的盐渍，说明来客曾把杯子端到唇边又放下。',
    '廊柱的影子斜斜切过地面，正好落在门槛的第三块青砖上，砖缝里嵌着半枚铜钱。',
    '他把信纸对折两次，塞进内衬的夹层，指尖压了很久才松开，掌心的汗把纸角洇软了。',
    '远处的钟楼报过五更，城里却还没有一户点灯，连更夫都缩在檐下没有出声。',
    '雨水顺着瓦当连成线，砸在石臼里，溅起的水花打湿了半截裤脚，凉意一直往上爬。',
    '有人在低声争执，语速很快，隔着两重木门只剩模糊的音节，听不出是几个人。',
    '账册翻到最后一页，墨迹在这里断掉，剩下的空白被人用指甲划过，留下几道浅痕。',
    '她摘下兜帽，露出被风吹乱的一缕头发，眼神却始终落在门缝上，没有看他。',
    '巷口的灯笼晃了两下，火苗歪向内侧，随即被一只手扶正，那只手很快又缩回暗处。',
    '井台边积着薄冰，踩上去会先发出一声脆响，然后才碎，碎声在院子里荡开很久。',
    '药炉上的白气散得很慢，屋里弥漫着一股微苦的焦味，混着陈年木头的气息。',
    '他数着脚下的砖缝，数到第七块时停下，蹲下去摸那道凹槽，指尖沾了一层细灰。',
  ];
  const seenPrompts = [];
  llm.activeChannel = () => ({ baseUrl: 'http://stub.local', key: 'stub', model: 'stub-model', noThinking: true });
  llm.chatCompletion = async function* (options) {
    // 规则与正典事件经 bookContextForOutline 进 user 提示词，断言要覆盖 system+user 全文。
    const fullPrompt = options.messages.map((message) => String(message.content || '')).join('\n');
    const system = String(options.messages?.[0]?.content || '');
    seenPrompts.push({ fullPrompt, system });
    const matched = system.match(/本轮只生成第(\d+)章/);
    const n = matched ? Number(matched[1]) : 1;
    if (system.includes('本次规划范围')) {
      const chapters = [];
      for (let i = 1; i <= 2; i++) chapters.push({ n: i, title: `第${i}章`, summary: `第${i}章梗概` });
      yield { type: 'delta', text: JSON.stringify({ arcPlan: { chapters } }) };
    } else if (system.includes('自动细纲模式')) {
      yield { type: 'delta', text: JSON.stringify({
        title: `第${n}章 试炼`, goal: `推进第${n}章的目标`, conflict: '僵持', hook: '门外脚步声',
        scenes: [{ title: '试探', location: '长廊', summary: '试探底线' }, { title: '交锋', location: '石门', summary: '冲突升级' }],
        continuity: {
          time: `第${n}日`, location: '长廊',
          characters: [{ name: '沈砚', status: '清醒', goal: '进城', relations: '独行', location: '长廊' }],
          facts: [`第${n}章的石门未开启`], openThreads: [], resolvedThreads: [],
        },
        foreshadow: { planted: [`第${n}章的陌生名字`], advanced: [], resolved: [] },
      }) };
    } else {
      const offset = (n - 1) * 8;
      yield { type: 'delta', text: SENTENCE_POOL.slice(offset, offset + 8).map((s, i) => `第${n}章第${i + 1}景，${s}`).join('') + '门外为什么又响起了第三个人的脚步声？' };
    }
    yield { type: 'meta', usage: { prompt_tokens: 11, completion_tokens: 22 }, finishReason: 'stop' };
  };

  const result = await misc.batchGenerateBodies({
    bookId, fromChapter: 1, toChapter: 2, chapterWords: 400, maxRetries: 2, retryBaseDelayMs: 1,
  });
  assert.deepEqual(result.created.map((item) => item.n), [1, 2]);

  const outlineCalls = seenPrompts.filter((prompt) => prompt.system.includes('自动细纲模式'));
  assert.ok(outlineCalls.length >= 2);
  const bodyCalls = seenPrompts.filter((prompt) => prompt.system.includes('自动正文模式'));
  assert.ok(bodyCalls.length >= 2);
  for (const prompt of [...outlineCalls, ...bodyCalls]) {
    assert.match(prompt.fullPrompt, /# 世界观规则（任何章节不得违背）/, '细纲与正文提示词都必须带规则');
    assert.match(prompt.fullPrompt, /大陆没有海。/);
  }
  // 事件锚定在第 1 章：写第 1 章时它属于未来，不得提前泄漏；写第 2 章起必须带上。
  const chapter1Calls = [...outlineCalls, ...bodyCalls].filter((prompt) => prompt.system.includes('本轮只生成第1章'));
  const chapter2Calls = [...outlineCalls, ...bodyCalls].filter((prompt) => prompt.system.includes('本轮只生成第2章'));
  assert.ok(chapter1Calls.length >= 1 && chapter2Calls.length >= 1);
  for (const prompt of chapter1Calls) {
    assert.ok(!prompt.fullPrompt.includes('不得矛盾或当作未发生'), '第1章自身锚定的事件不进本章提示词');
  }
  for (const prompt of chapter2Calls) {
    assert.match(prompt.fullPrompt, /# 正典事件（已发生，不得矛盾或当作未发生）/, '第2章提示词必须带已发生的正典事件');
    assert.match(prompt.fullPrompt, /第1章：入城——沈砚进入青州城。/);
  }
});
