// LLM 客户端：OpenAI 兼容 chat/completions（含流式 SSE 解析、reasoning、渠道选择）。
'use strict';
const { one } = require('./db');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function aborted(signal) { try { return !!(signal && signal.aborted); } catch (e) { return false; } }
function envInt(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const CONNECT_TIMEOUT_MS = envInt('FABULA_LLM_CONNECT_TIMEOUT_MS', 30000);
const STREAM_IDLE_TIMEOUT_MS = envInt('FABULA_LLM_STREAM_IDLE_TIMEOUT_MS', 90000);
const RESPONSE_TIMEOUT_MS = envInt('FABULA_LLM_RESPONSE_TIMEOUT_MS', 180000);
const MAX_RESPONSE_BYTES = envInt('FABULA_LLM_MAX_RESPONSE_BYTES', 64 * 1024 * 1024);

function createAbortScope(externalSignal, timeoutMs, message) {
  const controller = new AbortController();
  let timer = null;
  let timedOut = false;
  const onAbort = () => controller.abort(externalSignal && externalSignal.reason);
  if (externalSignal) {
    if (externalSignal.aborted) onAbort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  const arm = (ms = timeoutMs, detail = message) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(detail));
    }, ms);
    if (timer.unref) timer.unref();
  };
  const disarm = () => { if (timer) clearTimeout(timer); timer = null; };
  arm();
  return {
    signal: controller.signal,
    arm,
    disarm,
    get timedOut() { return timedOut; },
    cleanup() {
      disarm();
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
    },
  };
}

async function readResponseText(resp, scope) {
  if (!resp.body) return '';
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  const parts = [];
  let bytes = 0;
  try {
    for (;;) {
      scope.arm(RESPONSE_TIMEOUT_MS, '模型接口响应读取超时');
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error(`模型接口响应超过 ${MAX_RESPONSE_BYTES} 字节上限`);
      parts.push(dec.decode(value, { stream: true }));
    }
    parts.push(dec.decode());
    return parts.join('');
  } finally {
    try { await reader.cancel(); } catch (ignored) {}
  }
}

// ---------- 渠道 ----------
function allSettings() {
  const rows = one(`SELECT value FROM settings WHERE key='channels'`);
  let channels = [];
  try { channels = JSON.parse(rows && rows.value ? rows.value : '[]'); } catch (e) {}
  for (const c of channels) {
    if (!Array.isArray(c.models)) c.models = [];
  }
  const active = one(`SELECT value FROM settings WHERE key='active_channel'`);
  return { channels, activeChannelId: active ? active.value : '' };
}

function channelKey(id) {
  const r = one(`SELECT value FROM settings WHERE key=?`, 'channel_key__' + id);
  return r ? r.value || '' : '';
}

// 当前可用渠道（内置渠道需要 hub，直接视为不可用；用户自配渠道优先）
function activeChannel() {
  const { channels, activeChannelId } = allSettings();
  if (!channels.length) return null;
  let ch = channels.find((c) => c.id === activeChannelId);
  if (!ch) ch = channels.find((c) => !c.builtin) || channels[0];
  if (ch && ch.builtin) {
    // 内置目录已反代为自有渠道模型：走自配渠道，模型跟随用户在面板里选的 default_model
    const direct = channels.find((c) => !c.builtin);
    if (direct) {
      const dm = one(`SELECT value FROM settings WHERE key='default_model'`);
      return { ...direct, key: channelKey(direct.id), model: (dm && dm.value) || direct.model, builtin: false };
    }
    return null;
  }
  return ch ? { ...ch, key: channelKey(ch.id) } : null;
}

function hasAnyKey() {
  const { channels } = allSettings();
  return channels.some((c) => !c.builtin && channelKey(c.id));
}

// ---------- 请求 ----------
function completionsUrl(baseUrl) {
  let u = String(baseUrl || '').trim();
  if (!u) throw new Error('渠道缺少 baseUrl，请在 设置→渠道管理 中配置');
  if (u.endsWith('/chat/completions')) return u;
  return u.replace(/\/+$/, '') + '/chat/completions';
}
function modelsUrl(modelsUrl) {
  let u = String(modelsUrl || '').trim();
  if (!u) throw new Error('渠道缺少 modelsUrl，无法获取模型列表');
  if (u.endsWith('/models')) return u;
  return u.replace(/\/+$/, '') + '/models';
}

// 返回 async generator：[ {type:'delta',text} | {type:'reasoning',text} | {type:'meta',usage,...} ]
async function* chatCompletion({ baseUrl, apiKey, model, messages, temperature = 0.7, maxTokens = 4096, stream = true, signal, noThinking = false }) {
  const url = completionsUrl(baseUrl);
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream,
  };
  // sub2api/通义系推理模型：关闭思考，正文直出（避免推理占满 token 上限）
  if (noThinking) body.enable_thinking = false;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  const requestBody = JSON.stringify(body);
  let resp;
  let scope;
  for (let attempt = 0; attempt < 2; attempt++) {
    scope = createAbortScope(signal, CONNECT_TIMEOUT_MS, '模型接口连接超时');
    try {
      resp = await fetch(url, { method: 'POST', headers, body: requestBody, signal: scope.signal });
    } catch (error) {
      scope.cleanup();
      if (scope.timedOut) throw new Error(`模型接口连接超时（${CONNECT_TIMEOUT_MS}ms），请检查 baseUrl 与网络`);
      throw error;
    }
    if (resp.status >= 500 && resp.status < 600 && attempt === 0 && !aborted(signal)) {
      scope.cleanup();
      await sleep(1200);
      continue;
    }
    break;
  }
  // sub2api 类网关偶发 5xx：自动重试一次
  if (!resp.ok) {
    let detail = '';
    try { detail = await readResponseText(resp, scope); } catch (e) {}
    scope.cleanup();
    let msg = detail;
    try { msg = JSON.parse(detail)?.error?.message || msg; } catch (e) {}
    const friendly = { 401: '密钥无效或已失效（401），请检查渠道的 API Key', 403: '服务拒绝访问（403），检查额度/区域限制', 404: `模型或接口地址不存在（404）——检查模型名与 baseUrl`, 429: '请求太频繁或额度不足（429），稍等再发' };
    throw new Error(friendly[resp.status] + ` [${resp.status}] ${String(msg).slice(0, 160)}`);
  }
  if (!stream) {
    try {
      const raw = await readResponseText(resp, scope);
      const j = JSON.parse(raw);
      const c = j.choices?.[0]?.message?.content || '';
      yield { type: 'delta', text: c };
      yield { type: 'meta', usage: j.usage || null, finishReason: j.choices?.[0]?.finish_reason || null };
    } catch (error) {
      if (scope.timedOut) throw new Error(`模型接口响应超时（${RESPONSE_TIMEOUT_MS}ms）`);
      throw error;
    } finally {
      scope.cleanup();
    }
    return;
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let usage = null;
  let finishReason = null;
  let receivedBytes = 0;
  try {
    for (;;) {
      scope.arm(STREAM_IDLE_TIMEOUT_MS, '模型流式响应空闲超时');
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_RESPONSE_BYTES) throw new Error(`模型接口响应超过 ${MAX_RESPONSE_BYTES} 字节上限`);
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
        let j;
        try { j = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
        const d = j.choices?.[0]?.delta || {};
        if (j.choices?.[0]?.finish_reason) finishReason = j.choices[0].finish_reason;
        if (d.reasoning_content) yield { type: 'reasoning', text: d.reasoning_content };
        if (typeof d.content === 'string' && d.content.length) yield { type: 'delta', text: d.content };
        if (j.usage) usage = j.usage;
      }
    }
  } catch (error) {
    if (scope.timedOut) throw new Error(`模型流式响应空闲超时（${STREAM_IDLE_TIMEOUT_MS}ms），请检查渠道或重试`);
    throw error;
  } finally {
    scope.cleanup();
    try { await reader.cancel(); } catch (ignored) {}
  }
  yield { type: 'meta', usage, finishReason };
}

// 一次性非流式调用（带 JSON 输出帮助）
async function chatOnce({ baseUrl, apiKey, model, messages, temperature, maxTokens, signal, onMeta }) {
  let full = '';
  // 经 module.exports 转发：测试与调用方覆写 chatCompletion 时，chatOnce 必须跟随。
  for await (const ev of module.exports.chatCompletion({ baseUrl, apiKey, model, messages, temperature, maxTokens, stream: false, signal })) {
    if (ev.type === 'delta') full += ev.text;
    // 一次性调用也要能把 usage 交出去记账，否则预算检测对这些调用是盲的。
    if (ev.type === 'meta') onMeta?.(ev);
  }
  return full;
}

// ---------- Embeddings（语义召回） ----------

// OpenAI 兼容 /embeddings 端点。baseUrl 与 chat 同源（SiliconFlow / DeepSeek 等
// 都在同一域名下），允许用户显式覆盖（有些网关把 embeddings 放在别的地址）。
function embeddingsUrl(baseUrl) {
  let u = String(baseUrl || '').trim();
  if (!u) throw new Error('渠道缺少 baseUrl，请在 设置→渠道管理 中配置');
  if (/\/embeddings\/?$/.test(u)) return u;
  return u.replace(/\/+$/, '') + '/embeddings';
}

// 批量取向量。返回 { model, dim, vectors: Float32Array[] }，向量已做 L2 归一化，
// 这样调用方直接点积就是余弦。失败抛错，由调用方决定是否回落到本地引擎。
async function embedTexts(texts, { baseUrl, apiKey, model, signal } = {}) {
  const inputs = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text || ''));
  if (!inputs.length) throw new Error('embedTexts：输入为空');
  if (!model) throw new Error('未配置 embedding 模型');
  const url = embeddingsUrl(baseUrl);
  const scope = createAbortScope(signal, CONNECT_TIMEOUT_MS, 'Embedding 接口连接超时');
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'fabula',
        ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
      },
      body: JSON.stringify({ model, input: inputs }),
      signal: scope.signal,
    });
  } catch (error) {
    scope.cleanup();
    if (scope.timedOut) throw new Error(`Embedding 接口连接超时（${CONNECT_TIMEOUT_MS}ms），请检查 baseUrl 与网络`);
    throw error;
  }
  try {
    if (!resp.ok) {
      const detail = (await readResponseText(resp, scope)).slice(0, 200);
      throw new Error('Embedding 接口返回 ' + resp.status + (detail ? '：' + detail : ''));
    }
    const payload = JSON.parse(await readResponseText(resp, scope));
    const rows = Array.isArray(payload && payload.data) ? payload.data : [];
    if (rows.length !== inputs.length) {
      throw new Error(`Embedding 接口返回 ${rows.length} 条向量，期望 ${inputs.length} 条`);
    }
    const ordered = rows.slice().sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
    let dim = 0;
    const vectors = ordered.map((row) => {
      const raw = Array.isArray(row && row.embedding) ? row.embedding : [];
      if (!dim) dim = raw.length;
      if (!raw.length || raw.length !== dim) throw new Error('Embedding 接口返回的向量维度不一致');
      const vector = Float32Array.from(raw, (value) => Number(value) || 0);
      let sum = 0;
      for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
      const norm = Math.sqrt(sum) || 1;
      for (let i = 0; i < vector.length; i++) vector[i] /= norm;
      return vector;
    });
    if (!dim) throw new Error('Embedding 接口返回空向量');
    return { model, dim, vectors };
  } finally {
    scope.cleanup();
  }
}

// 模型列表（OpenAI 兼容 GET /models，或纯字符串列表）
async function fetchModelList(modelsUrlArg, apiKey) {
  const url = modelsUrl(modelsUrlArg);
  const headers = { 'User-Agent': 'fabula' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  const scope = createAbortScope(null, CONNECT_TIMEOUT_MS, '模型列表连接超时');
  let resp;
  try {
    resp = await fetch(url, { headers, signal: scope.signal });
  } catch (error) {
    scope.cleanup();
    if (scope.timedOut) throw new Error(`获取模型列表连接超时（${CONNECT_TIMEOUT_MS}ms）`);
    throw error;
  }
  if (!resp.ok) {
    scope.cleanup();
    throw new Error('获取模型列表失败 ' + resp.status + ' — modelsUrl 换成 ' + url);
  }
  let j;
  try {
    j = JSON.parse(await readResponseText(resp, scope));
  } catch (error) {
    if (scope.timedOut) throw new Error(`获取模型列表响应超时（${RESPONSE_TIMEOUT_MS}ms）`);
    throw error;
  } finally {
    scope.cleanup();
  }
  const list = Array.isArray(j) ? j : j.data || j.models || [];
  return list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
}

// 从响应文本里提取 JSON（剥掉 markdown 围栏/前后杂文）
function extractJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const m = t.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

module.exports = { allSettings, channelKey, activeChannel, hasAnyKey, completionsUrl, embeddingsUrl, modelsUrl, chatCompletion, chatOnce, embedTexts, fetchModelList, extractJson };
