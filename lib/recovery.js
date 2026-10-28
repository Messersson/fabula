// 启动时的孤儿任务恢复。
//
// 进程被 kill、容器被重启、机器断电时，数据库里会留下 status='running' 的任务：
// 状态页永远显示「进行中」，续跑按钮也不出现（没跑满也算 running）。这里在启动、
// 开始监听之前把它们改成明确的可续跑/失败状态，让作者一眼看到「上次没跑完」。
'use strict';

const { q, run } = require('./db');

const INTERRUPTED = '进程上次退出时任务未完成，已保留断点；可在状态页从断点续跑';

function recoverOrphanedRuns() {
  const stamp = Date.now();
  const result = { runs: 0, projects: 0, rounds: 0 };

  const runs = q(`SELECT id FROM generation_runs WHERE status IN ('running','retrying')`);
  for (const row of runs) {
    run(`UPDATE generation_runs SET status='interrupted', last_error=?, updated_at=? WHERE id=?`,
      INTERRUPTED, stamp, row.id);
    result.runs += 1;
  }

  // 文档项目的 running 只可能来自文档全托管循环；对应 run 已在上一步标记。
  const projects = q(`SELECT id FROM doc_projects WHERE status='running'`);
  for (const row of projects) {
    run(`UPDATE doc_projects SET status='failed', last_error=?, updated_at=? WHERE id=?`,
      INTERRUPTED, stamp, row.id);
    result.projects += 1;
  }

  // 评审轮次：有可用意见的可以继续汇总，没有意见的只能重开。
  const rounds = q(`SELECT r.id,
      (SELECT COUNT(*) FROM review_opinions o WHERE o.round_id=r.id AND o.error='') AS usable
    FROM review_rounds r WHERE r.status='running'`);
  for (const row of rounds) {
    const usable = Number(row.usable || 0);
    if (usable > 0) {
      run(`UPDATE review_rounds SET status='paused', error=?, paused_at=? WHERE id=?`,
        '进程上次退出时评审未完成；已保留意见，可继续汇总', stamp, row.id);
    } else {
      run(`UPDATE review_rounds SET status='failed', error=?, finished_at=? WHERE id=?`,
        '进程上次退出时评审未完成，且没有已产生的意见；请重新发起评审', stamp, row.id);
    }
    result.rounds += 1;
  }

  return result;
}

module.exports = { recoverOrphanedRuns, INTERRUPTED };
