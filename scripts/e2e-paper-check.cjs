'use strict';
// 结构性端到端验证：图文并茂协议形态的桩产出 → 组装/引用重编号/参考文献/Word 导出全链路。
process.env.FABULA_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'fab-e2e-'));
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';
require('../lib/db').open(require('node:path').join(__dirname, '..', 'data', 'writerx.seed.db'));
const docEngine = require('../lib/doc-engine');
const llm = require('../lib/llm');
const mis = require('../lib/handlers-misc');

llm.activeChannel = () => ({ baseUrl: 'http://stub', key: 'k', model: 'stub' });
llm.chatCompletion = async function* (options) {
  const sys = options.messages[0].content;
  const n = (sys.match(/第 (\d+) 节/) || [])[1] || '1';
  const bodies = {
    '5': [
      '### 5.1 回收期分析',
      '样本企业回收期中位数为 2.1 年[M1]，分阶段改造组显著更优。',
      '表 1：两类改造路径的回收期对比',
      '',
      '| 路径 | 样本量 | 回收期中位数 | 标准差 |',
      '| --- | --- | --- | --- |',
      '| 先流程后系统 | 41 | 1.6 年 | 0.4 |',
      '| 一步到位 | 46 | 2.7 年 | 0.9 |',
      '',
      '资料来源：素材 M1 整理。',
      '',
      '改造决策流程如图 1 所示。',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[流程成熟度评估] --> B{达标?}',
      '  B -- 是 --> C[系统改造]',
      '  B -- 否 --> D[流程再造]',
      '  D --> C',
      '```',
      '',
      '图 1：先流程后系统的分阶段改造决策路线',
      '',
      '### 5.2 调节效应',
      '组织能力起调节作用[M1]；补贴覆盖比例【待补：数据来源】。',
    ].join('\n'),
  };
  yield { type: 'delta', text: bodies[n] || ('第 ' + n + ' 节正文：本节围绕论题展开论证[M1]，结合前文数据推进分析，保持术语一致并给出可核验的判断。'.repeat(6)) };
  yield { type: 'meta', usage: { prompt_tokens: 100, completion_tokens: 200 }, finishReason: 'stop' };
};

const rich = mis.createSkill({
  name: '论文E2E技能', description: 'x',
  promptTemplate: '按图文并茂协议：Mermaid 图+数据表+规范图注，图表编号并在正文引用。', kind: 'method', usageMode: 'support', domain: 'doc',
});
const p = docEngine.createProject({
  title: '数字化改造投入产出研究', docType: 'paper', mode: 'co',
  thesis: '先流程后系统的分阶段改造在经济上更优。',
  points: ['回收期中位数 2.1 年', '分阶段比一步到位短 40%'],
  skillIds: [rich.id],
});
docEngine.addMaterial({
  projectId: p.id, title: '张三(2023) 制造业数字化转型跟踪研究', authors: '张三', year: '2023', source: '管理世界',
  content: '张三（2023）对 87 家中小制造企业跟踪发现回收期中位数 2.1 年，组织能力是调节变量。',
});

(async () => {
  await docEngine.draftSection(p.id, 5);
  const md = docEngine.assembleMarkdown(p.id).markdown;
  const checks = {
    'GFM 数据表': /\| 路径 \| 样本量 \|/.test(md),
    'Mermaid 图代码': md.includes('```mermaid'),
    '图 1 图注': /图 1：先流程后系统/.test(md),
    '引用重编号 [M1]→[1] 且无残留工单号': /\[1\]/.test(md) && !/\[M1\]/.test(md),
    'GB/T 参考文献页（含作者/出处/年份）': /## 参考文献/.test(md) && /张三/.test(md) && /管理世界/.test(md) && /2023/.test(md),
    '【待补】占位保留': /【待补：数据来源】/.test(md),
    '正文引用编号与文献页对应': /\[1\] 张三/.test(md) || /\[1\].*张三/.test(md.replace(/\n/g, ' ')),
  };
  console.log('=== 结构性端到端检查 ===');
  let pass = 0;
  for (const [k, v] of Object.entries(checks)) { console.log((v ? 'PASS' : 'FAIL'), k); if (v) pass++; }
  const bib = docEngine.bibliography(p.id);
  console.log('引用账本 entries:', JSON.stringify(bib.entries.map((e) => e.key + '->[' + e.no + '] ' + e.title)), '| ghosts:', JSON.stringify(bib.ghosts));
  try {
    const docx = docEngine.assembleDocx(p.id);
    console.log('PASS Word 导出:', docx.buffer.length, 'bytes');
  } catch (e) { console.log('FAIL Word 导出:', e.message); }
  console.log('通过', pass + '/7');
  process.exit(pass === 7 ? 0 : 1);
})();
