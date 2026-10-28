'use strict';

// 迁移安全：结构版本落后时先快照，再迁移；版本号用于判断下次是否需要备份。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-migrate-'));
process.env.FABULA_DATA_DIR = tempDir;
process.env.FABULA_SQLITE_JOURNAL = 'DELETE';

const db = require('../lib/db');
const dbPath = path.join(tempDir, 'writerx.db');

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('首次打开写入结构版本，且新库不需要备份', () => {
  db.open(db.BUNDLED_SEED);
  assert.equal(Number(db.one('PRAGMA user_version').user_version), 1);
  assert.deepEqual(fs.readdirSync(tempDir).filter((name) => name.startsWith('writerx.backup-')), []);
  db.close();
});

test('版本落后时先 VACUUM INTO 快照，再升级到当前版本', () => {
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA user_version=0');
  raw.close();

  db.open(db.BUNDLED_SEED);
  assert.equal(Number(db.one('PRAGMA user_version').user_version), 1, '迁移后版本号必须前进');
  const backups = fs.readdirSync(tempDir).filter((name) => /^writerx\.backup-v0-\d+\.db$/.test(name));
  assert.equal(backups.length, 1, '版本落后且库已存在时应生成一份快照');
  const snapshot = new DatabaseSync(path.join(tempDir, backups[0]));
  assert.ok(snapshot.prepare(`SELECT COUNT(*) AS n FROM sqlite_master`).get().n > 0, '快照必须是可用的数据库');
  snapshot.close();
  db.close();
});

test('版本已是最新时不再重复备份', () => {
  db.open(db.BUNDLED_SEED);
  db.close();
  const backups = fs.readdirSync(tempDir).filter((name) => name.startsWith('writerx.backup-'));
  assert.equal(backups.length, 1, '结构未变化不应每次启动都生成新快照');
});
