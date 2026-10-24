'use strict';

const zlib = require('node:zlib');
const { safeZipEntryName } = require('./fs-safe');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) {
    value = CRC_TABLE[(value ^ buffer[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 20000,
  maxCompressedBytes: 256 * 1024 * 1024,
  maxUncompressedBytes: 512 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 200,
});

function fail(message) {
  throw Object.assign(new Error(`ZIP 校验失败: ${message}`), { code: 'INVALID_ZIP' });
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= min; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  fail('找不到中央目录结束记录');
}

function parseZip(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) fail('输入不是 Buffer');
  const limits = { ...DEFAULT_LIMITS, ...options };
  if (!buffer.length || buffer.length > limits.maxCompressedBytes) fail('压缩包为空或超过大小上限');

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd + 22 > buffer.length) fail('EOCD 越界');
  const disk = buffer.readUInt16LE(eocd + 4);
  const centralDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);

  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) fail('不支持分卷 ZIP');
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail('不支持 ZIP64');
  if (!entryCount || entryCount > limits.maxEntries) fail(`条目数非法或超过 ${limits.maxEntries}`);
  if (eocd + 22 + commentLength > buffer.length) fail('ZIP 注释越界');
  if (centralOffset + centralSize > eocd) fail('中央目录越界');

  const files = [];
  const names = new Set();
  let cursor = centralOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > centralOffset + centralSize) fail('中央目录条目越界');
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) fail('中央目录签名错误');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLen;
    if (next > centralOffset + centralSize) fail('中央目录变长字段越界');
    if (flags & 0x0001) fail('不支持加密条目');
    if (![0, 8].includes(method)) fail(`不支持的压缩算法 ${method}`);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) fail('不支持 ZIP64 条目');
    if (uncompressedSize > limits.maxEntryBytes) fail(`单条目超过 ${limits.maxEntryBytes} 字节`);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > limits.maxUncompressedBytes) fail('解压后总大小超过上限');
    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) fail('压缩比异常');

    const nameBuffer = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const rawName = nameBuffer.toString('utf8');
    const name = safeZipEntryName(rawName);
    if (names.has(name)) fail(`重复条目 ${name}`);
    names.add(name);

    if (localOffset + 30 > centralOffset) fail('本地文件头越界');
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) fail(`本地文件头签名错误 ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > centralOffset) fail(`条目数据越界 ${name}`);

    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let data;
    if (method === 0) {
      data = Buffer.from(compressed);
    } else {
      try {
        data = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, uncompressedSize) });
      } catch (error) {
        fail(`解压失败 ${name}: ${error.message}`);
      }
    }
    if (data.length !== uncompressedSize) fail(`解压大小不一致 ${name}`);
    if (crc32(data) !== crc) fail(`CRC 不一致 ${name}`);
    files.push({ name, data, compressedSize, uncompressedSize });
    cursor = next;
  }
  return files;
}

function makeZip(files) {
  if (!Array.isArray(files)) throw new Error('ZIP 文件列表必须是数组');
  if (files.length > 0xffff) throw new Error('ZIP 条目数超过 65535');
  const parts = [];
  const central = [];
  const names = new Set();
  let offset = 0;

  for (const file of files) {
    const name = safeZipEntryName(file && file.name);
    if (names.has(name)) throw new Error(`ZIP 条目重复: ${name}`);
    names.add(name);
    const nameBuffer = Buffer.from(name, 'utf-8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data ?? ''), 'utf-8');
    if (data.length > 0xffffffff) throw new Error(`ZIP 条目过大: ${name}`);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    const header = Buffer.concat([local, nameBuffer]);
    parts.push(header, data);
    central.push({ nameBuffer, checksum, size: data.length, offset });
    offset += header.length + data.length;
  }

  let centralSize = 0;
  const centralParts = [];
  for (const entry of central) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0, 14);
    header.writeUInt32LE(entry.checksum, 16);
    header.writeUInt32LE(entry.size, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.nameBuffer.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(entry.offset, 42);
    centralParts.push(header, entry.nameBuffer);
    centralSize += header.length + entry.nameBuffer.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, ...centralParts, end]);
}

module.exports = { parseZip, makeZip, crc32, DEFAULT_LIMITS };
