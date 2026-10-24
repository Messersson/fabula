'use strict';

// Long-form story memory is deliberately stored in small, queryable rows. A
// million-character manuscript must not require loading every chapter into one
// model request, so this module keeps the latest state of recurring subjects
// plus a rolling digest for each completed volume.
const { q, one, run, transaction } = require('./db');

const DEFAULT_VOLUME_CHAPTERS = 50;
const CHARACTER_LIMIT = 24;
const CHARACTER_RECENT_LIMIT = 20;
const CHARACTER_CORE_LIMIT = 6;
const CHARACTER_CORE_MIN_MENTIONS = 3;
const THREAD_LIMIT = 20;
const FACT_LIMIT = 12;
const FACT_EARLY_LIMIT = 4;

function clip(text, limit) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function compactText(text, limit) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  const head = Math.ceil(limit * 0.55);
  return `${value.slice(0, head)}\n...（中间内容已省略）...\n${value.slice(-(limit - head))}`;
}

function evenlySelected(items, maxItems) {
  const source = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(maxItems) || 1);
  if (source.length <= limit) return source.slice();
  if (limit === 1) return [source[0]];
  const out = [];
  for (let index = 0; index < limit; index++) {
    const sourceIndex = Math.round(index * (source.length - 1) / (limit - 1));
    if (out.at(-1) !== source[sourceIndex]) out.push(source[sourceIndex]);
  }
  return out;
}

function compactDigest(text, { title = '', limit = 1200, maxItems = 7, itemLimit = 180 } = {}) {
  const value = String(text || '').trim();
  const budget = Math.max(200, Number(limit) || 1200);
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = title || lines.find((line) => /^#\s+/.test(line)) || '';
  const contentLines = [];
  for (const line of lines) {
    if (line === heading || /^#\s+/.test(line)) continue;
    if (/^[-*]\s+/.test(line) || !contentLines.length) contentLines.push(line);
    else contentLines[contentLines.length - 1] += ` ${line}`;
  }
  if (!contentLines.length) return clip(heading || value, budget);
  const plain = [heading, ...contentLines].filter(Boolean).join('\n');
  if (plain.length <= budget) return plain;
  const selected = evenlySelected(contentLines, Math.max(3, Number(maxItems) || 7));
  const marker = `...（其余 ${Math.max(0, contentLines.length - selected.length)} 项已按里程碑抽样）...`;
  const overhead = (heading ? heading.length + 1 : 0) + marker.length + selected.length;
  const lineLimit = Math.max(48, Math.min(Number(itemLimit) || 180, Math.floor((budget - overhead) / selected.length)));
  const rendered = [
    heading,
    ...selected.map((line) => clip(line, lineLimit)),
    marker,
  ].filter(Boolean).join('\n');
  return rendered.length <= budget ? rendered : compactText(rendered, budget);
}

function stringList(value, limit = 16, itemLimit = 300) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => clip(item, itemLimit)).filter(Boolean))].slice(0, limit);
}

function stateKey(value, limit = 100) {
  return clip(value, limit).toLowerCase().replace(/\s+/g, '').replace(/[，。；：、,.!?！？;:]+/g, '');
}

// Existing books predate the mention index. Backfill it once per book, then
// recordContinuity keeps it exact when a chapter is regenerated.
function ensureCharacterMentions(bookId) {
  if (!bookId) return;
  const key = `character_mentions_backfilled__${bookId}`;
  if (String(one(`SELECT value FROM settings WHERE key=?`, key)?.value || '') === '1') return;
  const rows = q(`SELECT chapter_num, state_json FROM chapter_continuity WHERE book_id=? ORDER BY chapter_num`, bookId);
  transaction(() => {
    run(`DELETE FROM character_mentions WHERE book_id=?`, bookId);
    for (const row of rows) {
      let continuity = null;
      try { continuity = JSON.parse(row.state_json); } catch {}
      for (const character of Array.isArray(continuity?.characters) ? continuity.characters : []) {
        const characterKey = stateKey(character && character.name);
        if (!characterKey) continue;
        run(`INSERT OR IGNORE INTO character_mentions(book_id, state_key, chapter_num) VALUES(?,?,?)`,
          bookId, characterKey, Number(row.chapter_num));
      }
    }
    run(`INSERT INTO settings(key, value) VALUES(?, '1')
      ON CONFLICT(key) DO UPDATE SET value='1'`, key);
  });
}

function normalizeCharacters(value, scenes) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const item = raw && typeof raw === 'object' ? raw : { name: raw };
    const name = clip(item.name || item.character || item.角色 || '', 80);
    const key = stateKey(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      name,
      status: clip(item.status || item.state || item.状态 || item['当前状态'] || '', 320),
      goal: clip(item.goal || item.目标 || '', 240),
      relations: clip(item.relations || item.relationship || item.关系 || '', 320),
      location: clip(item.location || item.位置 || '', 160),
    });
  };
  if (Array.isArray(value)) value.forEach(add);
  for (const scene of Array.isArray(scenes) ? scenes : []) {
    const names = Array.isArray(scene && scene.characters)
      ? scene.characters
      : String(scene && scene.characters || '').split(/[，,、；;]/);
    names.forEach((name) => add(name));
  }
  return out.slice(0, CHARACTER_LIMIT);
}

function normalizeContinuity(outline, chapterNum) {
  const source = outline && typeof outline.continuity === 'object' && outline.continuity
    ? outline.continuity
    : {};
  const scenes = Array.isArray(outline && outline.scenes) ? outline.scenes : [];
  const sceneLocations = scenes.map((scene) => clip(scene && scene.location, 160)).filter(Boolean);
  return {
    chapterNum: Number(chapterNum) || 0,
    time: clip(source.time || source.timeline || source.时间 || '', 240),
    location: clip(source.location || source.地点 || sceneLocations.at(-1) || '', 240),
    characters: normalizeCharacters(source.characters, scenes),
    facts: stringList(source.facts || source.establishedFacts || source.既定事实, 16, 360),
    openThreads: stringList(source.openThreads || source.threads || source.未回收线索, 20, 360),
    resolvedThreads: stringList(source.resolvedThreads || source.已回收线索, 20, 360),
  };
}

function upsertState(bookId, kind, key, value, chapterNum, timestamp) {
  if (!key) return;
  run(`INSERT INTO story_states(book_id, kind, state_key, value, chapter_num, updated_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(book_id, kind, state_key) DO UPDATE SET
      value=excluded.value, chapter_num=excluded.chapter_num, updated_at=excluded.updated_at
    WHERE excluded.chapter_num >= story_states.chapter_num`,
  bookId, kind, key, JSON.stringify(value), Number(chapterNum), timestamp);
}

function foreshadowLists(outline) {
  const source = outline && typeof outline.foreshadow === 'object' && outline.foreshadow
    ? outline.foreshadow
    : {};
  return {
    planted: stringList(source.planted || source.埋设, 40, 360),
    advanced: stringList(source.advanced || source.推进, 40, 360),
    resolved: stringList(source.resolved || source.回收, 40, 360),
  };
}

function recordThreadEvent(bookId, chapterNum, kind, text, timestamp) {
  const key = stateKey(text, 120);
  if (!key) return;
  run(`INSERT INTO thread_events(book_id, chapter_num, kind, thread_key, text, updated_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(book_id, chapter_num, kind, thread_key) DO UPDATE SET
      text=excluded.text, updated_at=excluded.updated_at`,
  bookId, Number(chapterNum), kind, key, clip(text, 360), timestamp);
}

function threadKeysFromContinuity(continuity) {
  const keys = new Set();
  for (const text of [
    ...(Array.isArray(continuity?.openThreads) ? continuity.openThreads : []),
    ...(Array.isArray(continuity?.resolvedThreads) ? continuity.resolvedThreads : []),
  ]) {
    const key = stateKey(text, 120);
    if (key) keys.add(key);
  }
  return keys;
}

function stateKeysFromContinuity(continuity) {
  const keys = new Map();
  const add = (kind, key) => {
    if (!key) return;
    keys.set(`${kind}\u0000${key}`, { kind, key });
  };
  for (const character of Array.isArray(continuity?.characters) ? continuity.characters : []) {
    add('character', stateKey(character && character.name));
  }
  for (const fact of Array.isArray(continuity?.facts) ? continuity.facts : []) {
    add('fact', stateKey(fact, 120));
  }
  if (continuity?.time) add('timeline', 'current');
  if (continuity?.location) add('location', 'current');
  return keys;
}

function stateValueFromContinuity(continuity, kind, key) {
  if (kind === 'timeline') return continuity.time || null;
  if (kind === 'location') return continuity.location || null;
  if (kind === 'character') {
    return (continuity.characters || []).find((item) => stateKey(item && item.name) === key) || null;
  }
  if (kind === 'fact') {
    const fact = (continuity.facts || []).find((item) => stateKey(item, 120) === key);
    return fact ? { text: fact } : null;
  }
  return null;
}

// story_states only keeps the latest value, so removing a value from a
// regenerated chapter requires replaying chapter_continuity. A later chapter's
// state always wins; only rows owned by this chapter or earlier may fall back.
function rebuildNonThreadStates(bookId, chapterNum, affectedStates, timestamp) {
  const pending = new Map(affectedStates);
  if (!pending.size) return;
  const rows = q(`SELECT chapter_num, state_json FROM chapter_continuity
    WHERE book_id=? AND chapter_num<=? ORDER BY chapter_num DESC`, bookId, chapterNum);
  for (const row of rows) {
    let continuity = null;
    try { continuity = JSON.parse(row.state_json); } catch {}
    if (!continuity) continue;
    for (const [token, state] of pending) {
      const value = stateValueFromContinuity(continuity, state.kind, state.key);
      if (value == null || value === '') continue;
      const current = q(`SELECT chapter_num FROM story_states
        WHERE book_id=? AND kind=? AND state_key=?`, bookId, state.kind, state.key)[0];
      if (current && Number(current.chapter_num) > Number(chapterNum)) {
        pending.delete(token);
        continue;
      }
      run(`INSERT INTO story_states(book_id, kind, state_key, value, chapter_num, updated_at)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(book_id, kind, state_key) DO UPDATE SET
          value=excluded.value, chapter_num=excluded.chapter_num, updated_at=excluded.updated_at`,
      bookId, state.kind, state.key, JSON.stringify(value), Number(row.chapter_num), timestamp);
      pending.delete(token);
    }
    if (!pending.size) break;
  }
  for (const state of pending.values()) {
    const current = q(`SELECT chapter_num FROM story_states
      WHERE book_id=? AND kind=? AND state_key=?`, bookId, state.kind, state.key)[0];
    if (current && Number(current.chapter_num) <= Number(chapterNum)) {
      run(`DELETE FROM story_states WHERE book_id=? AND kind=? AND state_key=?`,
        bookId, state.kind, state.key);
    }
  }
}

function rebuildThreadState(bookId, key, timestamp = Date.now()) {
  if (!bookId || !key) return null;
  const latest = q(`SELECT kind, text, chapter_num FROM thread_events
    WHERE book_id=? AND thread_key=?
    ORDER BY chapter_num DESC, id DESC LIMIT 1`, bookId, key)[0];
  run(`DELETE FROM story_states WHERE book_id=? AND kind='thread' AND state_key=?`, bookId, key);
  if (!latest) return null;
  const value = { text: clip(latest.text, 360), status: latest.kind === 'resolved' ? 'resolved' : 'open' };
  run(`INSERT INTO story_states(book_id, kind, state_key, value, chapter_num, updated_at)
    VALUES(?,?,?,?,?,?)`, bookId, 'thread', key, JSON.stringify(value), Number(latest.chapter_num), timestamp);
  return value;
}

function resolveThread(bookId, text, chapterNum, timestamp) {
  const value = clip(text, 360);
  const targetKey = stateKey(value, 120);
  if (!targetKey) return [];
  const openRows = q(`SELECT state_key, value FROM story_states
    WHERE book_id=? AND kind='thread' AND json_extract(value, '$.status') IS NOT 'resolved'`, bookId);
  const matched = [];
  for (const row of openRows) {
    const item = decodeRow(row);
    const candidate = stateKey(item && item.text, 120);
    if (!candidate) continue;
    const shorter = candidate.length <= targetKey.length ? candidate : targetKey;
    const longer = candidate.length <= targetKey.length ? targetKey : candidate;
    const related = shorter.length >= 6 && longer.includes(shorter) && shorter.length / longer.length >= 0.65;
    if (candidate === targetKey || related) matched.push(row.state_key);
  }
  const keys = new Set(matched.length ? matched : [targetKey]);
  for (const key of keys) {
    upsertState(bookId, 'thread', key, { text: value, status: 'resolved' }, chapterNum, timestamp);
    recordThreadEvent(bookId, chapterNum, 'resolved', value, timestamp);
  }
  if (!keys.has(targetKey)) recordThreadEvent(bookId, chapterNum, 'resolved', value, timestamp);
  return [...keys];
}

function recordContinuity(bookId, chapterNum, outline) {
  if (!bookId || !Number(chapterNum)) return null;
  ensureCharacterMentions(bookId);
  const continuity = normalizeContinuity(outline, chapterNum);
  const foreshadow = foreshadowLists(outline);
  const timestamp = Date.now();
  const chapter = Number(chapterNum);
  const oldContinuityRow = q(`SELECT state_json FROM chapter_continuity WHERE book_id=? AND chapter_num=?`,
    bookId, chapter)[0];
  let oldContinuity = null;
  try { oldContinuity = oldContinuityRow ? JSON.parse(oldContinuityRow.state_json) : null; } catch {}
  const affectedThreads = threadKeysFromContinuity(oldContinuity);
  const affectedStates = stateKeysFromContinuity(oldContinuity);
  for (const row of q(`SELECT kind, state_key FROM story_states
    WHERE book_id=? AND chapter_num=? AND kind IN ('character','fact','timeline','location')`,
  bookId, chapter)) {
    affectedStates.set(`${row.kind}\u0000${row.state_key}`, { kind: row.kind, key: row.state_key });
  }
  for (const row of q(`SELECT thread_key FROM thread_events WHERE book_id=? AND chapter_num=?`, bookId, chapter)) {
    affectedThreads.add(row.thread_key);
  }
  transaction(() => {
    // A regenerated chapter must replace its own event history. Later chapters
    // remain untouched because state rows only move forward by chapter number.
    run(`DELETE FROM thread_events WHERE book_id=? AND chapter_num=?`, bookId, chapter);
    run(`INSERT INTO chapter_continuity(book_id, chapter_num, state_json, updated_at) VALUES(?,?,?,?)
      ON CONFLICT(book_id, chapter_num) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at`,
    bookId, chapter, JSON.stringify(continuity), timestamp);
    run(`DELETE FROM character_mentions WHERE book_id=? AND chapter_num=?`, bookId, chapter);
    for (const character of continuity.characters) {
      const characterKey = stateKey(character.name);
      if (!characterKey) continue;
      run(`INSERT INTO character_mentions(book_id, state_key, chapter_num) VALUES(?,?,?)`,
        bookId, characterKey, chapter);
    }
    if (continuity.time) upsertState(bookId, 'timeline', 'current', continuity.time, chapterNum, timestamp);
    if (continuity.location) upsertState(bookId, 'location', 'current', continuity.location, chapterNum, timestamp);
    for (const character of continuity.characters) {
      upsertState(bookId, 'character', stateKey(character.name), character, chapterNum, timestamp);
    }
    for (const fact of continuity.facts) {
      upsertState(bookId, 'fact', stateKey(fact, 120), { text: fact }, chapterNum, timestamp);
    }
    rebuildNonThreadStates(bookId, chapter, affectedStates, timestamp);
    for (const thread of continuity.openThreads) {
      const key = stateKey(thread, 120);
      if (!key) continue;
      upsertState(bookId, 'thread', key, { text: thread, status: 'open' }, chapterNum, timestamp);
      recordThreadEvent(bookId, chapter, 'opened', thread, timestamp);
      affectedThreads.add(key);
    }
    for (const thread of foreshadow.planted) {
      const key = stateKey(thread, 120);
      upsertState(bookId, 'thread', key, { text: thread, status: 'open' }, chapterNum, timestamp);
      recordThreadEvent(bookId, chapter, 'planted', thread, timestamp);
      affectedThreads.add(key);
    }
    for (const thread of foreshadow.advanced) {
      const key = stateKey(thread, 120);
      upsertState(bookId, 'thread', key, { text: thread, status: 'open' }, chapterNum, timestamp);
      recordThreadEvent(bookId, chapter, 'advanced', thread, timestamp);
      affectedThreads.add(key);
    }
    for (const thread of continuity.resolvedThreads) {
      for (const key of resolveThread(bookId, thread, chapterNum, timestamp)) affectedThreads.add(key);
    }
    for (const thread of foreshadow.resolved) {
      for (const key of resolveThread(bookId, thread, chapterNum, timestamp)) affectedThreads.add(key);
    }
    for (const key of affectedThreads) {
      rebuildThreadState(bookId, key, timestamp);
    }
  });
  return continuity;
}

function decodeRow(row) {
  try { return JSON.parse(row.value); } catch { return { text: row.value }; }
}

// story_states is intentionally latest-only for fast current-chapter reads.
// Replaying chapter_continuity gives an exact view when an earlier chapter is
// regenerated after later chapters have already advanced the same state keys.
function replayNonThreadState(bookId, beforeChapter) {
  const states = new Map();
  const rows = q(`SELECT chapter_num, state_json FROM chapter_continuity
    WHERE book_id=? AND chapter_num<? ORDER BY chapter_num`, bookId, beforeChapter);
  for (const row of rows) {
    let continuity = null;
    try { continuity = JSON.parse(row.state_json); } catch {}
    if (!continuity) continue;
    const chapter = Number(row.chapter_num) || 0;
    for (const character of Array.isArray(continuity.characters) ? continuity.characters : []) {
      const key = stateKey(character && character.name);
      if (key) states.set(`character\u0000${key}`, { state_key: key, value: JSON.stringify(character), chapter_num: chapter });
    }
    for (const fact of Array.isArray(continuity.facts) ? continuity.facts : []) {
      const key = stateKey(fact, 120);
      if (key) states.set(`fact\u0000${key}`, { state_key: key, value: JSON.stringify({ text: fact }), chapter_num: chapter });
    }
    if (continuity.time) states.set('timeline\u0000current', { state_key: 'current', value: JSON.stringify(continuity.time), chapter_num: chapter });
    if (continuity.location) states.set('location\u0000current', { state_key: 'current', value: JSON.stringify(continuity.location), chapter_num: chapter });
  }
  return states;
}

// Threads are event-sourced separately from chapter continuity. Rebuild their
// status as of the target chapter so regenerating an early chapter cannot see
// later advances or resolutions.
function replayThreadState(bookId, beforeChapter) {
  const states = new Map();
  const rows = q(`SELECT chapter_num, kind, thread_key, text FROM thread_events
    WHERE book_id=? AND chapter_num<? ORDER BY chapter_num, id`, bookId, beforeChapter);
  for (const row of rows) {
    if (!row.thread_key) continue;
    states.set(row.thread_key, {
      state_key: row.thread_key,
      value: JSON.stringify({ text: row.text, status: row.kind === 'resolved' ? 'resolved' : 'open' }),
      chapter_num: Number(row.chapter_num) || 0,
    });
  }
  return states;
}

function storyStateContext(bookId, targetChapter, maxChars = 4800) {
  ensureCharacterMentions(bookId);
  const latestContinuity = Number(one(`SELECT MAX(chapter_num) AS latest FROM chapter_continuity
    WHERE book_id=?`, bookId)?.latest || 0);
  // targetChapter 为 null 表示"没有章节锚点"（AI 共创的自由对话）：取最新状态，
  // 而不是回落到第 1 章的历史重放。
  const before = targetChapter == null
    ? latestContinuity + 1
    : Number(targetChapter || 1);
  const historical = before <= latestContinuity;
  let recentCharacters = [];
  let coreCharacters = [];
  let recentFactRows = [];
  let earlyFactRows = [];
  let time = null;
  let location = null;
  let historicalThreads = null;
  if (historical) {
    const replay = replayNonThreadState(bookId, before);
    recentCharacters = [...replay.entries()]
      .filter(([key]) => key.startsWith('character\u0000'))
      .map(([, row]) => row)
      .sort((a, b) => Number(b.chapter_num) - Number(a.chapter_num))
      .slice(0, CHARACTER_RECENT_LIMIT);
    const coreStats = q(`SELECT state_key, COUNT(*) AS mentions, MIN(chapter_num) AS first_chapter
      FROM character_mentions WHERE book_id=? AND chapter_num<?
      GROUP BY state_key HAVING COUNT(*)>=?
      ORDER BY COUNT(*) DESC, MAX(chapter_num) DESC LIMIT ?`,
    bookId, before, CHARACTER_CORE_MIN_MENTIONS, CHARACTER_CORE_LIMIT);
    coreCharacters = coreStats.map((stat) => {
      const row = replay.get(`character\u0000${stat.state_key}`);
      return row ? { ...row, mentions: stat.mentions, first_chapter: stat.first_chapter } : null;
    }).filter(Boolean);
    const facts = [...replay.entries()]
      .filter(([key]) => key.startsWith('fact\u0000'))
      .map(([, row]) => row);
    recentFactRows = facts.slice().sort((a, b) => Number(b.chapter_num) - Number(a.chapter_num)).slice(0, FACT_LIMIT);
    earlyFactRows = facts.slice().sort((a, b) => Number(a.chapter_num) - Number(b.chapter_num)).slice(0, FACT_EARLY_LIMIT);
    time = replay.get('timeline\u0000current') || null;
    location = replay.get('location\u0000current') || null;
    historicalThreads = [...replayThreadState(bookId, before).values()]
      .filter((row) => decodeRow(row).status !== 'resolved');
  } else {
    recentCharacters = q(`SELECT state_key, value, chapter_num FROM story_states
      WHERE book_id=? AND kind='character' AND chapter_num<? ORDER BY chapter_num DESC LIMIT ?`,
    bookId, before, CHARACTER_RECENT_LIMIT);
    coreCharacters = q(`SELECT s.state_key, s.value, s.chapter_num, m.mentions, m.first_chapter
      FROM story_states s JOIN (
        SELECT state_key, COUNT(*) AS mentions, MIN(chapter_num) AS first_chapter
        FROM character_mentions WHERE book_id=? AND chapter_num<?
        GROUP BY state_key HAVING COUNT(*)>=?
      ) m ON m.state_key=s.state_key
      WHERE s.book_id=? AND s.kind='character' AND s.chapter_num<?
      ORDER BY m.mentions DESC, s.chapter_num DESC LIMIT ?`,
    bookId, before, CHARACTER_CORE_MIN_MENTIONS, bookId, before, CHARACTER_CORE_LIMIT);
    recentFactRows = q(`SELECT state_key, value, chapter_num FROM story_states
      WHERE book_id=? AND kind='fact' AND chapter_num<? ORDER BY chapter_num DESC LIMIT ?`,
    bookId, before, FACT_LIMIT);
    earlyFactRows = q(`SELECT state_key, value, chapter_num FROM story_states
      WHERE book_id=? AND kind='fact' AND chapter_num<? ORDER BY chapter_num ASC LIMIT ?`,
    bookId, before, FACT_EARLY_LIMIT);
    time = q(`SELECT value FROM story_states WHERE book_id=? AND kind='timeline' AND chapter_num<? ORDER BY chapter_num DESC LIMIT 1`, bookId, before)[0];
    location = q(`SELECT value FROM story_states WHERE book_id=? AND kind='location' AND chapter_num<? ORDER BY chapter_num DESC LIMIT 1`, bookId, before)[0];
  }
  const characterRows = new Map();
  for (const row of coreCharacters) characterRows.set(row.state_key, { ...row, core: true });
  for (const row of recentCharacters) {
    if (characterRows.size >= CHARACTER_LIMIT) break;
    if (!characterRows.has(row.state_key)) characterRows.set(row.state_key, { ...row, core: false });
  }
  const characters = [...characterRows.values()]
    .map((row) => ({ ...decodeRow(row), stateKey: row.state_key, chapter: Number(row.chapter_num), core: row.core }))
    .filter((item) => item && item.name);
  const threadHalf = Math.ceil(THREAD_LIMIT / 2);
  let oldestThreads;
  let newestThreads;
  if (historicalThreads) {
    const ordered = historicalThreads.slice()
      .sort((a, b) => Number(a.chapter_num) - Number(b.chapter_num));
    oldestThreads = ordered.slice(0, threadHalf);
    newestThreads = ordered.slice(-threadHalf).reverse();
  } else {
    const threadSql = `SELECT state_key, value, chapter_num FROM story_states
      WHERE book_id=? AND kind='thread' AND chapter_num<?
        AND json_extract(value, '$.status') IS NOT 'resolved'
      ORDER BY chapter_num`;
    oldestThreads = q(`${threadSql} ASC LIMIT ?`, bookId, before, threadHalf);
    newestThreads = q(`${threadSql} DESC LIMIT ?`, bookId, before, threadHalf);
  }
  const threadRows = new Map();
  for (const row of oldestThreads.concat(newestThreads)) threadRows.set(row.state_key, row);
  const threads = [...threadRows.values()]
    .sort((a, b) => Number(a.chapter_num) - Number(b.chapter_num))
    .map(decodeRow)
    .filter((item) => item && item.status !== 'resolved');
  const recentFactKeys = new Set(recentFactRows.map((row) => row.state_key));
  const factRows = new Map();
  for (const row of recentFactRows) factRows.set(row.state_key, row);
  for (const row of earlyFactRows) {
    if (!factRows.has(row.state_key)) factRows.set(row.state_key, row);
  }
  const facts = [...factRows.values()]
    .sort((a, b) => Number(a.chapter_num) - Number(b.chapter_num))
    .map((row) => ({ ...decodeRow(row), early: !recentFactKeys.has(row.state_key) }));
  const parts = [];
  if (time || location) {
    const values = [];
    if (time) values.push(`时间：${String(decodeRow(time) || '').trim()}`);
    if (location) values.push(`地点：${String(decodeRow(location) || '').trim()}`);
    if (values.length) parts.push(`## 当前时空\n${values.join('\n')}`);
  }
  if (characters.length) {
    parts.push(`## 人物状态（核心与最近活跃）\n${characters.map((item) => {
      const details = [item.status, item.location ? `位置：${item.location}` : '', item.goal ? `目标：${item.goal}` : '', item.relations ? `关系：${item.relations}` : ''].filter(Boolean);
      return `- ${item.core ? '[核心] ' : ''}${item.name}${details.length ? `：${details.join('｜')}` : ''}`;
    }).join('\n')}`);
  }
  if (threads.length) parts.push(`## 未回收线索\n${threads.map((item) => `- ${item.text || ''}`).join('\n')}`);
  if (facts.length) {
    parts.push(`## 关键既定事实（早期与最近）\n${facts.map((item) => `- ${item.early ? '[早期] ' : ''}${item.text || ''}`).join('\n')}`);
  }
  return parts.length ? compactText(`# 长期连续性状态\n${parts.join('\n\n')}`, maxChars) : '';
}

function foreshadowLedgerMarkdown(bookId) {
  const rows = q(`SELECT state_key, value, chapter_num FROM story_states
    WHERE book_id=? AND kind='thread' ORDER BY chapter_num DESC, state_key`, bookId);
  const open = [];
  const resolved = [];
  let lastChapter = 0;
  for (const row of rows) {
    const item = decodeRow(row);
    const text = clip(item && item.text, 360);
    if (!text) continue;
    const chapter = Number(row.chapter_num) || 0;
    lastChapter = Math.max(lastChapter, chapter);
    if (item.status === 'resolved') resolved.push({ text, chapter });
    else open.push({ text, chapter });
  }
  const advanced = q(`SELECT chapter_num, text FROM thread_events
    WHERE book_id=? AND kind='advanced' ORDER BY chapter_num DESC, id DESC LIMIT 200`, bookId);
  for (const row of advanced) lastChapter = Math.max(lastChapter, Number(row.chapter_num) || 0);
  const pendingLines = open.map((item) => `- [待回收] 第${item.chapter}章：${item.text}`);
  const advancedLines = advanced.map((item) => `- [推进] 第${item.chapter_num}章：${item.text}`);
  const resolvedLines = resolved.map((item) => `- [已回收] 第${item.chapter}章：${item.text}`);
  return [
    '# 伏笔台账',
    '',
    '## 待回收',
    '',
    ...pendingLines,
    '',
    '## 推进记录',
    '',
    ...advancedLines,
    '',
    '## 已回收',
    '',
    ...resolvedLines,
    '',
    `最后更新：${lastChapter ? `第${lastChapter}章` : '尚无记录'}`,
    '',
  ].join('\n');
}

function refreshVolumeSummary(bookId, chapterNum, volumeSize = DEFAULT_VOLUME_CHAPTERS) {
  const endChapter = Number(chapterNum || 0);
  const size = Math.max(1, Number(volumeSize) || DEFAULT_VOLUME_CHAPTERS);
  if (!bookId || !endChapter || endChapter % size !== 0) return null;
  const volumeNum = Math.ceil(endChapter / size);
  const startChapter = endChapter - size + 1;
  const rows = q(`SELECT chapter_num, title, content FROM chapter_summaries
    WHERE book_id=? AND chapter_num BETWEEN ? AND ? ORDER BY chapter_num`,
  bookId, startChapter, endChapter);
  if (!rows.length) return null;
  const lines = rows.map((row) => `- 第${row.chapter_num}章 ${row.title || ''}\n  ${clip(String(row.content || '').replace(/\s+/g, ' '), 360)}`);
  const content = `# 第${volumeNum}卷摘要（第${startChapter}-${endChapter}章）\n\n${lines.join('\n')}`;
  run(`INSERT INTO volume_summaries(book_id, volume_num, start_chapter, end_chapter, content, updated_at)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(book_id, volume_num) DO UPDATE SET start_chapter=excluded.start_chapter,
      end_chapter=excluded.end_chapter, content=excluded.content, updated_at=excluded.updated_at`,
  bookId, volumeNum, startChapter, endChapter, content, Date.now());
  return { volumeNum, startChapter, endChapter };
}

function volumeSummaryContext(bookId, targetChapter, volumeSize = DEFAULT_VOLUME_CHAPTERS, maxChars = 3600) {
  const target = Number(targetChapter || 1);
  const size = Math.max(1, Number(volumeSize) || DEFAULT_VOLUME_CHAPTERS);
  const currentVolume = Math.ceil(target / size);
  const completed = q(`SELECT volume_num, content FROM volume_summaries
    WHERE book_id=? AND volume_num<? ORDER BY volume_num`, bookId, currentVolume);
  const currentStart = (currentVolume - 1) * size + 1;
  const currentRows = q(`SELECT chapter_num, title, content FROM chapter_summaries
    WHERE book_id=? AND chapter_num BETWEEN ? AND ? ORDER BY chapter_num`,
  bookId, currentStart, Math.max(0, target - 1));
  const parts = [];
  const recent = completed.slice(-2);
  const earlier = completed.slice(0, -2);
  if (earlier.length) {
    const lines = earlier.map((row) => {
      const text = String(row.content || '')
        .replace(/^#.*$/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
      return `- 第${row.volume_num}卷：${clip(text, 180)}`;
    });
    const earlierBudget = Math.max(260, Math.min(900, Math.floor(maxChars * 0.18)));
    parts.push(compactDigest(lines.join('\n'), {
      title: '# 更早卷级前情', limit: earlierBudget, maxItems: 8, itemLimit: 140,
    }));
  }
  const recentBudget = Math.max(420, Math.min(1100, Math.floor(maxChars * 0.23)));
  for (const row of recent) {
    parts.push(compactDigest(row.content, {
      limit: recentBudget, maxItems: 7, itemLimit: 180,
    }));
  }
  if (currentRows.length) {
    const visibleRows = currentRows.slice(-12);
    const omitted = currentRows.length - visibleRows.length;
    const lines = visibleRows.map((row) => `- 第${row.chapter_num}章 ${row.title || ''}：${clip(String(row.content || '').replace(/\s+/g, ' '), 180)}`);
    const omittedLine = omitted > 0 ? `\n（本卷更早的 ${omitted} 章已压缩）` : '';
    const currentBudget = Math.max(500, Math.min(1300, Math.floor(maxChars * 0.28)));
    parts.push(compactDigest(`${lines.join('\n')}${omittedLine}`, {
      title: `# 本卷至今（第${currentStart}-${target - 1}章）`,
      limit: currentBudget,
      maxItems: 7,
      itemLimit: 150,
    }));
  }
  return parts.length ? compactText(parts.join('\n\n'), maxChars) : '';
}

// ---------- 世界规则与正典事件 ----------
//
// 与 story_states（"截至第 N 章世界当前是什么状态"）不同，这两张表存的是
// "从头到尾都不许违背"的约束：
// - world_rules：世界观硬规则（灵力边界、科技水平、称谓禁忌），全书有效；
//   ban_terms 附带违禁词，供确定性审计逐字排查。
// - canon_events：已锚定章节的正典事件，后续章节不得矛盾或复现；
//   keywords 附带独特短语，供卷级审计检测远期复现。
// 与章节规划同款双轨：SQLite 是查询缓存，设定/世界规则.md 与 设定/正典事件.md
// 是人可直接编辑的真相源；所有写路径都先写表再物化文件，导入按文件 stamp 判重。

const WORLD_RULES_FILE = '世界规则.md';
const CANON_EVENTS_FILE = '正典事件.md';
const CANON_ECHO_MIN_GAP = 20;
const CANON_KEYWORD_MIN_CHARS = 6;

function worldRuleRow(row) {
  let banTerms = [];
  try { banTerms = JSON.parse(row.ban_terms_json || '[]') || []; } catch {}
  return {
    ruleKey: row.rule_key,
    content: String(row.content || ''),
    banTerms: Array.isArray(banTerms) ? banTerms.map((item) => String(item || '').trim()).filter(Boolean) : [],
    priority: Number(row.priority) || 0,
    enabled: !!Number(row.enabled),
    updatedAt: Number(row.updated_at) || 0,
  };
}

function canonEventRow(row) {
  let keywords = [];
  try { keywords = JSON.parse(row.keywords_json || '[]') || []; } catch {}
  return {
    eventKey: row.event_key,
    chapterNum: Number(row.chapter_num) || 0,
    title: String(row.title || ''),
    detail: String(row.detail || ''),
    keywords: Array.isArray(keywords) ? keywords.map((item) => String(item || '').trim()).filter(Boolean) : [],
    updatedAt: Number(row.updated_at) || 0,
  };
}

function listWorldRules(bookId) {
  importWorldRulesIfChanged(bookId);
  return q(`SELECT rule_key, content, ban_terms_json, priority, enabled, updated_at FROM world_rules
    WHERE book_id=? ORDER BY enabled DESC, priority DESC, id`, String(bookId || '')).map(worldRuleRow);
}

function listCanonEvents(bookId) {
  importCanonEventsIfChanged(bookId);
  return q(`SELECT event_key, chapter_num, title, detail, keywords_json, updated_at FROM canon_events
    WHERE book_id=? ORDER BY chapter_num, id`, String(bookId || '')).map(canonEventRow);
}

function upsertWorldRule(bookId, { ruleKey, content, banTerms, priority, enabled }) {
  const key = String(ruleKey || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const text = String(content || '').trim();
  if (!key) throw new Error('规则需要 ruleKey');
  if (!text) throw new Error('规则正文不能为空');
  run(`INSERT INTO world_rules(book_id, rule_key, content, ban_terms_json, priority, enabled, updated_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(book_id, rule_key) DO UPDATE SET content=excluded.content,
      ban_terms_json=excluded.ban_terms_json, priority=excluded.priority,
      enabled=excluded.enabled, updated_at=excluded.updated_at`,
  String(bookId), key, text, JSON.stringify((Array.isArray(banTerms) ? banTerms : []).map((item) => String(item || '').trim()).filter(Boolean)),
  Math.max(0, Number(priority) || 0), enabled === false ? 0 : 1, Date.now());
}

function deleteWorldRule(bookId, ruleKey) {
  run(`DELETE FROM world_rules WHERE book_id=? AND rule_key=?`, String(bookId), String(ruleKey || '').trim());
}

function upsertCanonEvent(bookId, { eventKey, chapterNum, title, detail, keywords }) {
  const key = String(eventKey || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  const chapter = Number(chapterNum);
  if (!key) throw new Error('正典事件需要 eventKey');
  if (!Number.isFinite(chapter) || chapter <= 0) throw new Error('正典事件需要有效的 chapterNum');
  run(`INSERT INTO canon_events(book_id, event_key, chapter_num, title, detail, keywords_json, updated_at)
    VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(book_id, event_key) DO UPDATE SET chapter_num=excluded.chapter_num,
      title=excluded.title, detail=excluded.detail, keywords_json=excluded.keywords_json,
      updated_at=excluded.updated_at`,
  String(bookId), key, chapter, String(title || '').trim().slice(0, 200), String(detail || '').trim(),
  JSON.stringify((Array.isArray(keywords) ? keywords : []).map((item) => String(item || '').trim()).filter(Boolean)),
  Date.now());
}

function deleteCanonEvent(bookId, eventKey) {
  run(`DELETE FROM canon_events WHERE book_id=? AND event_key=?`, String(bookId), String(eventKey || '').trim());
}

function worldRulesMarkdown(bookId) {
  const lines = ['# 世界规则', ''];
  for (const rule of listWorldRules(bookId)) {
    const marks = [];
    if (rule.banTerms.length) marks.push(`禁词：${rule.banTerms.join('，')}`);
    if (rule.priority) marks.push(`优先级：${rule.priority}`);
    if (!rule.enabled) marks.push('停用：是');
    lines.push(`## ${rule.ruleKey}`, '', rule.content, '');
    if (marks.length) lines.push(marks.join('\n'), '');
  }
  if (lines.length === 2) lines.push('（暂无规则。格式：`## 规则名` + 正文，可选 `禁词：a，b` 与 `优先级：N`。）', '');
  return lines.join('\n');
}

function canonEventsMarkdown(bookId) {
  const lines = ['# 正典事件', ''];
  for (const event of listCanonEvents(bookId)) {
    lines.push(`### 第${event.chapterNum}章 ${event.title || event.eventKey}`, '');
    if (event.detail) lines.push(`经过：${event.detail}`, '');
    if (event.keywords.length) lines.push(`关键词：${event.keywords.join('，')}`, '');
  }
  if (lines.length === 2) lines.push('（暂无事件。格式：`### 第N章 事件标题` + 可选 `经过：` 与 `关键词：` 行。）', '');
  return lines.join('\n');
}

function materializeWorldRules(bookId) {
  const core = require('./handlers-core');
  core.writeFileTo({ bookId, group: '设定', name: WORLD_RULES_FILE, content: worldRulesMarkdown(bookId) });
  core.setSetting(`world_rules_source_stamp__${bookId}`, sourceStamp(bookId, WORLD_RULES_FILE));
}

function materializeCanonEvents(bookId) {
  const core = require('./handlers-core');
  core.writeFileTo({ bookId, group: '设定', name: CANON_EVENTS_FILE, content: canonEventsMarkdown(bookId) });
  core.setSetting(`canon_events_source_stamp__${bookId}`, sourceStamp(bookId, CANON_EVENTS_FILE));
}

function sourceStamp(bookId, name) {
  const core = require('./handlers-core');
  const stat = core.fileStatFrom({ bookId, group: '设定', name });
  return stat ? `${Math.floor(stat.mtimeMs)}:${stat.size}` : '';
}

// 解析 设定/世界规则.md：`## 键` 分节，正文 + 可选 `禁词：` / `优先级：` / `停用：` 行。
function parseWorldRulesMarkdown(content) {
  const rules = [];
  const re = /^##[ \t]+(.+?)[ \t]*$/gm;
  const matches = [...String(content || '').matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const key = matches[i][1].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : String(content || '').length;
    const bodyLines = [];
    let banTerms = [];
    let priority = 0;
    let enabled = true;
    for (const rawLine of String(content || '').slice(start, end).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const ban = line.match(/^禁词[:：]\s*(.+)$/);
      const prio = line.match(/^优先级[:：]\s*(\d+)$/);
      const off = line.match(/^停用[:：]\s*(是|否|true|false)$/i);
      if (ban) banTerms = ban[1].split(/[，,、]/).map((item) => item.trim()).filter(Boolean);
      else if (prio) priority = Number(prio[1]) || 0;
      else if (off) enabled = !/^(是|true)$/i.test(off[1]);
      else bodyLines.push(line);
    }
    const text = bodyLines.join('\n').trim();
    if (key && text) rules.push({ ruleKey: key, content: text, banTerms, priority, enabled });
  }
  return rules;
}

// 解析 设定/正典事件.md：`### 第N章 标题` 分节 + 可选 `经过：` / `关键词：` 行。
function parseCanonEventsMarkdown(content) {
  const events = [];
  const re = /^#{2,4}[ \t]*第\s*(\d+)\s*章[ \t]*(.*)$/gm;
  const matches = [...String(content || '').matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const chapter = Number(matches[i][1]);
    const title = matches[i][2].trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : String(content || '').length;
    const detailLines = [];
    let keywords = [];
    for (const rawLine of String(content || '').slice(start, end).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const kw = line.match(/^关键词[:：]\s*(.+)$/);
      const detail = line.match(/^(?:经过|详情)[:：]\s*(.+)$/);
      if (kw) keywords = keywords.concat(kw[1].split(/[，,、]/).map((item) => item.trim()).filter(Boolean));
      else if (detail) detailLines.push(detail[1].trim());
      else detailLines.push(line);
    }
    if (chapter) {
      events.push({
        eventKey: `第${chapter}章${title || '事件'}`,
        chapterNum: chapter,
        title,
        detail: detailLines.join(' '),
        keywords,
      });
    }
  }
  return events;
}

// 文件是真相源：外部编辑（stamp 变化）后全量替换表；表是查询缓存。
// 所有写路径都先写表再物化文件，所以全量替换不会丢手工数据。
function importWorldRulesIfChanged(bookId) {
  const stampKey = `world_rules_source_stamp__${bookId}`;
  const stamp = sourceStamp(bookId, WORLD_RULES_FILE);
  if (!stamp) return { imported: false };
  if (stamp === sourceStampCached(stampKey)) return { imported: false };
  const core = require('./handlers-core');
  const rules = parseWorldRulesMarkdown(core.readFileFrom({ bookId, group: '设定', name: WORLD_RULES_FILE }) || '');
  transaction(() => {
    run(`DELETE FROM world_rules WHERE book_id=?`, bookId);
    for (const rule of rules) upsertWorldRule(bookId, rule);
  });
  core.setSetting(stampKey, stamp);
  return { imported: true, rules: rules.length };
}

function importCanonEventsIfChanged(bookId) {
  const stampKey = `canon_events_source_stamp__${bookId}`;
  const stamp = sourceStamp(bookId, CANON_EVENTS_FILE);
  if (!stamp) return { imported: false };
  if (stamp === sourceStampCached(stampKey)) return { imported: false };
  const core = require('./handlers-core');
  const events = parseCanonEventsMarkdown(core.readFileFrom({ bookId, group: '设定', name: CANON_EVENTS_FILE }) || '');
  transaction(() => {
    run(`DELETE FROM canon_events WHERE book_id=?`, bookId);
    for (const event of events) upsertCanonEvent(bookId, event);
  });
  core.setSetting(stampKey, stamp);
  return { imported: true, events: events.length };
}

function sourceStampCached(key) {
  return one(`SELECT value FROM settings WHERE key=?`, key)?.value || '';
}

// 提示词注入：全书有效的硬规则，优先级高者在先。
function worldRulesContext(bookId, maxChars = 1600) {
  importWorldRulesIfChanged(bookId);
  const rules = listWorldRules(bookId).filter((rule) => rule.enabled && rule.content);
  if (!rules.length) return '';
  const lines = rules.map((rule) => {
    const ban = rule.banTerms.length ? `（禁用表述：${rule.banTerms.join('、')}）` : '';
    return `- ${rule.content}${ban}`;
  });
  return compactText(`# 世界观规则（任何章节不得违背）\n${lines.join('\n')}`, maxChars);
}

// 提示词注入：目标章之前已锚定的正典事件，早期里程碑 + 最近事件各留一半。
function canonEventsContext(bookId, targetChapter, maxChars = 2200) {
  importCanonEventsIfChanged(bookId);
  const before = Number(targetChapter || 1);
  const events = listCanonEvents(bookId).filter((event) => event.chapterNum > 0 && event.chapterNum < before);
  if (!events.length) return '';
  const half = Math.ceil(events.length / 2) > 8 ? 8 : Math.ceil(events.length / 2);
  const ordered = events.slice().sort((a, b) => a.chapterNum - b.chapterNum);
  const picked = new Map();
  for (const event of ordered.slice(0, half)) picked.set(event.eventKey, event);
  for (const event of ordered.slice(-half)) picked.set(event.eventKey, event);
  const lines = [...picked.values()]
    .sort((a, b) => a.chapterNum - b.chapterNum)
    .map((event) => `- 第${event.chapterNum}章：${event.title || event.eventKey}${event.detail ? `——${event.detail}` : ''}`);
  return compactText(`# 正典事件（已发生，不得矛盾或当作未发生）\n${lines.join('\n')}`, maxChars);
}

// AI 共创路径（自由对话 / 智能写作 / 场景生成）共用的硬约束与连续性上下文。
// 与全托管路径的 bookContextForOutline 同源：规则全书有效，事件按锚点过滤
// （chapterNum 为 null 时视为"站在最新进度"，全部正典可见），状态取当前或回放。
function bookStoryContext(bookId, { chapterNum = null, rulesChars = 1600, eventsChars = 2200, stateChars = 2600 } = {}) {
  if (!bookId) return '';
  const parts = [];
  const rules = worldRulesContext(bookId, rulesChars);
  if (rules) parts.push(rules);
  const events = canonEventsContext(bookId, chapterNum == null ? Number.MAX_SAFE_INTEGER : chapterNum, eventsChars);
  if (events) parts.push(events);
  const state = storyStateContext(bookId, chapterNum == null ? null : chapterNum, stateChars);
  if (state) parts.push(state);
  return parts.join('\n\n');
}

module.exports = {
  DEFAULT_VOLUME_CHAPTERS,
  normalizeContinuity,
  recordContinuity,
  storyStateContext,
  foreshadowLedgerMarkdown,
  refreshVolumeSummary,
  volumeSummaryContext,
  bookStoryContext,
  listWorldRules,
  upsertWorldRule,
  deleteWorldRule,
  listCanonEvents,
  upsertCanonEvent,
  deleteCanonEvent,
  materializeWorldRules,
  materializeCanonEvents,
  importWorldRulesIfChanged,
  importCanonEventsIfChanged,
  parseWorldRulesMarkdown,
  parseCanonEventsMarkdown,
  worldRulesContext,
  canonEventsContext,
  worldRulesMarkdown,
  canonEventsMarkdown,
  WORLD_RULES_FILE,
  CANON_EVENTS_FILE,
  CANON_ECHO_MIN_GAP,
  CANON_KEYWORD_MIN_CHARS,
};
