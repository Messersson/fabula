'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { makeZip, parseZip } = require('../lib/zip');

test('ZIP 写入后可完整读取', () => {
  const archive = makeZip([
    { name: '设定/人物库.md', data: '沈舟：主角。' },
    { name: '正文/第1章.md', data: '雨夜抵达旧宅。' },
  ]);
  const files = parseZip(archive);
  assert.equal(files.length, 2);
  assert.equal(files[0].name, '设定/人物库.md');
  assert.equal(files[1].data.toString('utf8'), '雨夜抵达旧宅。');
});

test('ZIP 拒绝目录穿越和超限条目', () => {
  assert.throws(() => makeZip([{ name: '../evil.md', data: 'x' }]), /目录穿越/);
  const archive = makeZip([{ name: '正文/第1章.md', data: 'abcdef' }]);
  assert.throws(() => parseZip(archive, { maxEntryBytes: 3 }), /单条目超过/);
});

test('ZIP 校验 CRC，篡改正文会失败', () => {
  const archive = makeZip([{ name: '正文/第1章.md', data: '完整正文' }]);
  const nameLength = Buffer.byteLength('正文/第1章.md');
  archive[30 + nameLength] ^= 0xff;
  assert.throws(() => parseZip(archive), /CRC 不一致/);
});
