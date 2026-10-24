'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('./db');

function resolved(value) {
  return path.resolve(String(value || ''));
}

function isInside(parent, child) {
  const root = resolved(parent);
  const target = resolved(child);
  const rel = path.relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertInside(parent, child, label = '路径') {
  if (!isInside(parent, child)) {
    throw Object.assign(new Error(`${label}超出允许目录`), { code: 'PATH_OUTSIDE_ROOT' });
  }
  return resolved(child);
}

function safeFileName(value, fallback = 'untitled') {
  let name = String(value == null ? '' : value)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/^\.+$/, '_')
    .trim();
  if (!name || name === '.' || name === '..') name = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name.slice(0, 180);
}

function atomicWriteFileSync(filePath, data, options = {}) {
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', options.mode || 0o600);
    fs.writeFileSync(fd, data, options.encoding || undefined);
    try { fs.fsyncSync(fd); } catch (ignored) {}
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    return target;
  } catch (error) {
    try { if (fd !== undefined) fs.closeSync(fd); } catch (ignored) {}
    try { fs.rmSync(temp, { force: true }); } catch (ignored) {}
    throw error;
  }
}

function allowedIoRoots() {
  const roots = [
    path.join(DATA_DIR, 'imports'),
    path.join(DATA_DIR, 'exports'),
  ];
  const extra = String(process.env.FABULA_ALLOWED_IO_DIRS || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set([...roots, ...extra].map(resolved))];
}

function ensureAllowedPath(candidate, label = '文件路径') {
  const target = resolved(candidate);
  if (!allowedIoRoots().some((root) => isInside(root, target))) {
    throw Object.assign(new Error(`${label}不在 FABULA_ALLOWED_IO_DIRS 白名单内`), { code: 'PATH_NOT_ALLOWED' });
  }
  return target;
}

function resolveAllowedPath(input, { defaultDir, mode = 'read', label = '文件路径' } = {}) {
  const target = input ? resolved(input) : path.resolve(defaultDir || allowedIoRoots()[0]);
  ensureAllowedPath(target, label);
  if (mode === 'write') fs.mkdirSync(path.dirname(target), { recursive: true });
  return target;
}

function safeZipEntryName(name) {
  const raw = String(name || '').replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    throw new Error(`ZIP 条目路径非法: ${raw}`);
  }
  const parts = raw.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) {
    throw new Error(`ZIP 条目包含目录穿越: ${raw}`);
  }
  return parts.map((part) => safeFileName(part)).join('/');
}

module.exports = {
  isInside,
  assertInside,
  safeFileName,
  atomicWriteFileSync,
  allowedIoRoots,
  ensureAllowedPath,
  resolveAllowedPath,
  safeZipEntryName,
};
