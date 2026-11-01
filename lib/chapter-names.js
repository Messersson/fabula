'use strict';

// 章节文件名里的章号解析：生成、续跑、评审映射都依赖同一个口径。
// 分开实现过一次（评审按文件排序序号取章），结果第 10 章被当成第 1 章评审。

function zhNum(text) {
  const s = String(text || '').trim();
  if (/^\d+$/.test(s)) return Number.parseInt(s, 10);
  const map = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const unit = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let section = 0, number = 0, result = 0;
  for (const ch of s) {
    if (map[ch] != null) {
      number = map[ch];
    } else if (unit[ch]) {
      const u = unit[ch];
      if (u === 10000) {
        result += (section + number) * u;
        section = 0;
      } else {
        section += (number || 1) * u;
      }
      number = 0;
    } else {
      return NaN;
    }
  }
  return result + section + number;
}

function chapterNumberFromName(name) {
  const m = String(name || '').match(/第\s*([0-9零〇一二三四五六七八九十百千万两]+)\s*章/);
  if (!m) return 0;
  const n = zhNum(m[1]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

module.exports = { zhNum, chapterNumberFromName };
