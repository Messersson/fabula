'use strict';

// 孤儿任务恢复：进程被 kill 后，数据库里不能永远停在 running。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-recovery-'));
process.env.FABULA_DATA_DIR = tempDir;
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';

const db = require('../lib/db');
db.open(path.join(__dirname, '..', 'data', 'writerx.seed.db'));

const core = require('../lib/handlers-core');
const orch = require('../lib/longform-orchestrator');
const statusPage = require('../lib/status-page');
const { recoverOrphanedRuns } = require('../lib/recovery');

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('启动恢复：运行中的任务改为可续跑，文档项目与评审轮次各自收尾', () => {
  const book = core.createBook({ title: '断电作品', genre: '长篇', pov: '第三人称' });
  const run = orch.createRun({
    bookId: book.id, mode: 'full', fromChapter: 1, toChapter: 3, chapterWords: 2400, maxRetries: 1, options: {},
  });
  const docRun = orch.createRun({
    bookId: 'doc_project_x', mode: 'doc', fromChapter: 1, toChapter: 2, maxRetries: 1, options: {},
  });
  const stamp = Date.now();
  db.run(`INSERT INTO doc_projects(id,title,doc_type,mode,status,created_at,updated_at)
    VALUES('doc_project_x','断电文档','report','auto','running',?,?)`, stamp, stamp);

  // 一条有意见的轮次（可继续汇总）与一条空轮次（只能重开）。
  db.run(`INSERT INTO review_rounds(id,workbench,work_id,round_no,status,created_at) VALUES('rd_keep','doc','doc_project_x',1,'running',?)`, stamp);
  db.run(`INSERT INTO review_rounds(id,workbench,work_id,round_no,status,created_at) VALUES('rd_empty','doc','doc_project_x',1,'running',?)`, stamp);
  db.run(`INSERT INTO review_opinions(id,round_id,reviewer_name,error) VALUES('op_1','rd_keep','甲','')`);

  const result = recoverOrphanedRuns();
  assert.equal(result.runs, 2);
  assert.equal(result.projects, 1);
  assert.equal(result.rounds, 2);

  const fixed = orch.getRun(run.id);
  assert.equal(fixed.status, 'interrupted');
  assert.match(fixed.lastError, /未完成/);
  assert.ok(statusPage.RESUMABLE.has('interrupted'), '中断的任务必须能续跑');
  assert.equal(orch.getRun(docRun.id).status, 'interrupted');

  const project = db.one(`SELECT status, last_error FROM doc_projects WHERE id='doc_project_x'`);
  assert.equal(project.status, 'failed');
  assert.match(project.last_error, /未完成/);

  assert.equal(db.one(`SELECT status FROM review_rounds WHERE id='rd_keep'`).status, 'paused');
  assert.equal(db.one(`SELECT status FROM review_rounds WHERE id='rd_empty'`).status, 'failed');

  // 再跑一次不应产生任何变化（幂等）。
  const again = recoverOrphanedRuns();
  assert.deepEqual(again, { runs: 0, projects: 0, rounds: 0 });
});
