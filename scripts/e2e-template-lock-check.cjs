'use strict';
// 模板严格沿用的导出验证：生成一份模板绑定文档 → 导出 docx → 用 Word COM 打开，
// 检查目录域是否被 Word 正常解析、标题层级是否与模板一致、字体字号是否随模板。
process.env.FABULA_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'fab-tpl-'));
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';
require('../lib/db').open(require('node:path').join(__dirname, '..', 'data', 'writerx.seed.db'));
const fs = require('node:fs');
const path = require('node:path');
const docEngine = require('../lib/doc-engine');

const saved = docEngine.saveDocTemplate({
  name: '校验模板',
  docType: 'report',
  sections: [
    { level: 1, title: '绪论', brief: '交代研究缘起', minChars: 300 },
    { level: 2, title: '研究背景', brief: '梳理已有研究', minChars: 300 },
    { level: 1, title: '研究方法', brief: '说明方法', minChars: 300 },
  ],
  layout: {
    bodyFont: '仿宋', bodySize: 12, lineSpacing: 1.75, firstLineIndent: 2,
    headingFont: '黑体', titleFont: '黑体', titleSize: 18,
    headingSizes: { 1: 15, 2: 14, 3: 12 }, numbering: 'chinese',
    marginTop: 2.5, marginBottom: 2.5, marginLeft: 3, marginRight: 3,
  },
  notes: '写法：先给判断再给依据。',
});

const project = docEngine.createProject({ title: '模板沿用校验稿', docType: 'report', templateId: saved.id });
docEngine.saveSectionContent(project.id, 1, '一、模型自造标题\n\n本节正文内容，用于占位，需要足够长以便导出时形成完整段落。'.repeat(8), 'manual');
docEngine.saveSectionContent(project.id, 2, '研究背景正文，用于占位，需要足够长以便导出时形成完整段落。'.repeat(8), 'manual');
docEngine.saveSectionContent(project.id, 3, '研究方法正文，用于占位，需要足够长以便导出时形成完整段落。'.repeat(8), 'manual');

const assembled = docEngine.assembleDocx(project.id);
const out = path.join(process.env.FABULA_DATA_DIR, '模板沿用校验稿.docx');
fs.writeFileSync(out, assembled.buffer);
console.log('DOCX=' + out);
console.log('SIZE=' + assembled.buffer.length);
