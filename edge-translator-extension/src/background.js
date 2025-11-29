/**
 * Edge AI Translator - MV3 Service Worker (background)
 * Responsibilities:
 * - Orchestrate page/selection translate triggers (action button, commands, contextMenus)
 * - Persist and load user config (API endpoint/key, workflow, target language)
 * - Route translation requests from content scripts to provider
 * - Provide minimal error handling and sane defaults for early testing
 */

'use strict';

import { createScheduler, scheduledFetch, withRetry, AbortError as SchedulerAbortError } from './scheduler.js';
import { LRUCache, makeCacheKey } from './cache.js';
import { composePrompt, splitInputsByBudget, isSkippableSegment } from './prompt.js';

// ---------- Constants ----------

const DEFAULT_CONFIG = {
  provider: {
    name: 'custom',
    type: 'custom',
    endpoint: '',      // e.g. https://your.api/translate
    apiKey: '',
    headers: {},       // extra headers if needed
    model: '',         // optional model name
    limits: { maxConcurrent: 2, rps: 1, burst: 2, jitterMs: [50, 200] },
    retry: { maxRetries: 5, baseDelayMs: 800, maxDelayMs: 20000, jitter: true, retryOn: [429, 500, 502, 503, 504] },
    batching: { enabled: true, mode: 'json-array', maxItems: 20, maxChars: 8000, tokenBudget: 2000 }
  },
  workflow: {
    steps: ['translate'], // placeholder for future pipeline
    sourceLang: 'auto',
    targetLang: 'zh-CN',
    mode: 'single-call',
    promptTemplate: '',
    style: '简洁准确，保留格式与占位符',
    tone: '中性',
    glossary: [],
    protectPlaceholders: true,
    responseFormat: 'auto',
    skipIfSourceEqualsTarget: true,
    minTextLength: 2,
    noise: {
      enabled: false,
      position: 'system', // 'system' | 'user_suffix'
      probability: 0.6,
      minWords: 3,
      maxWords: 8,
      template: '--- NOISE --- {{noise}}',
      dictionary: []
    }
  },
  cache: {
    enabled: true,
    size: 500,
    ttlMs: 12 * 60 * 60 * 1000
  },
  behavior: {
    selectionShowBubble: true
  }
};

const MENU_IDS = {
  TRANSLATE_PAGE: 'edge_ai_translate_page',
  TRANSLATE_SELECTION: 'edge_ai_translate_selection'
};

const COMMANDS = {
  TRANSLATE_PAGE: 'translate_page',
  TRANSLATE_SELECTION: 'translate_selection'
};

const MSG = {
  TRANSLATE_PAGE: 'TRANSLATE_PAGE',
  TRANSLATE_SELECTION: 'TRANSLATE_SELECTION',
  REQUEST_TRANSLATION: 'REQUEST_TRANSLATION',
  CANCEL_TRANSLATION: 'CANCEL_TRANSLATION',
  LOAD_CONFIG: 'LOAD_CONFIG',
  SAVE_CONFIG: 'SAVE_CONFIG'
};

// ---------- Infra: scheduler, cache, job aborts ----------
let schedulerInstance = null;
let cacheInstance = null;
const jobControllers = new Map();

function ensureInfra(cfg) {
 try {
   const limits = cfg?.provider?.limits || {};
   if (!schedulerInstance) {
     schedulerInstance = createScheduler({
       maxConcurrent: limits.maxConcurrent ?? 2,
       rps: limits.rps ?? 1,
       burst: limits.burst ?? 2,
       jitterMs: limits.jitterMs ?? [50, 200]
     });
   } else {
     schedulerInstance.updateConfig({
       maxConcurrent: limits.maxConcurrent ?? 2,
       rps: limits.rps ?? 1,
       burst: limits.burst ?? 2,
       jitterMs: limits.jitterMs ?? [50, 200]
     });
   }
 } catch {}

 try {
   const cacheCfg = cfg?.cache || {};
   if (!cacheInstance) {
     cacheInstance = new LRUCache({
       enabled: cacheCfg.enabled !== false,
       size: cacheCfg.size ?? 500,
       ttlMs: cacheCfg.ttlMs ?? 12 * 60 * 60 * 1000
     });
   } else {
     cacheInstance.updateOptions({
       enabled: cacheCfg.enabled !== false,
       size: cacheCfg.size ?? 500,
       ttlMs: cacheCfg.ttlMs ?? 12 * 60 * 60 * 1000
     });
   }
 } catch {}
}

function registerController(jobId, controller) {
 if (!jobId || !controller) return;
 let arr = jobControllers.get(jobId);
 if (!arr) { arr = []; jobControllers.set(jobId, arr); }
 arr.push(controller);
}

function unregisterController(jobId, controller) {
 if (!jobId || !controller) return;
 const arr = jobControllers.get(jobId);
 if (!arr) return;
 const idx = arr.indexOf(controller);
 if (idx >= 0) arr.splice(idx, 1);
 if (arr.length === 0) jobControllers.delete(jobId);
}

function abortJob(jobId) {
 const arr = jobControllers.get(jobId);
 if (!arr) return;
 while (arr.length) {
   try { arr.pop().abort(); } catch {}
 }
 jobControllers.delete(jobId);
}

// ---------- Utilities ----------

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, source) {
  if (!isObject(target) || !isObject(source)) return source ?? target;
  const out = { ...target };
  for (const k of Object.keys(source)) {
    const sv = source[k];
    const tv = target[k];
    if (isObject(tv) && isObject(sv)) {
      out[k] = deepMerge(tv, sv);
    } else {
      out[k] = sv;
    }
  }
  return out;
}

function eToString(e) {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}

// ---------- Storage (chrome.storage.sync) ----------

async function getConfig() {
  const data = await chrome.storage.sync.get(['config']);
  const stored = data?.config || {};
  return deepMerge(DEFAULT_CONFIG, stored);
}

async function setConfig(partial) {
  const current = await getConfig();
  const next = deepMerge(current, partial || {});
  await chrome.storage.sync.set({ config: next });
  return next;
}

// ---------- Context Menus & Install Events ----------

chrome.runtime.onInstalled.addListener(async () => {
  try {
    // Recreate menus on update/install for idempotency.
    await new Promise((resolve) => chrome.contextMenus.removeAll(resolve));

    chrome.contextMenus.create({
      id: MENU_IDS.TRANSLATE_PAGE,
      title: 'Translate entire page (AI)',
      contexts: ['page']
    });

    chrome.contextMenus.create({
      id: MENU_IDS.TRANSLATE_SELECTION,
      title: 'Translate selection (AI)',
      contexts: ['selection']
    });
  } catch (e) {
    console.warn('[Edge AI Translator] onInstalled error:', eToString(e));
  }
});

// ---------- Context Menu Clicks ----------

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  try {
    if (info.menuItemId === MENU_IDS.TRANSLATE_PAGE) {
      await chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_PAGE });
    } else if (info.menuItemId === MENU_IDS.TRANSLATE_SELECTION) {
      const text = (info.selectionText || '').trim();
      if (text) {
        await chrome.tabs.sendMessage(tab.id, {
          type: MSG.TRANSLATE_SELECTION,
          selectionText: text
        });
      } else {
        // Fallback: ask content script to read current selection
        await chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_SELECTION });
      }
    }
  } catch (e) {
    console.warn('[Edge AI Translator] contextMenus.onClicked error:', eToString(e));
  }
});

// ---------- Toolbar Action Click (browserAction) ----------

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_PAGE });
  } catch (e) {
    console.warn('[Edge AI Translator] action.onClicked error:', eToString(e));
  }
});

// ---------- Keyboard Commands ----------

chrome.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    if (command === COMMANDS.TRANSLATE_PAGE) {
      await chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_PAGE });
    } else if (command === COMMANDS.TRANSLATE_SELECTION) {
      await chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_SELECTION });
    }
  } catch (e) {
    console.warn('[Edge AI Translator] commands.onCommand error:', eToString(e));
  }
});

// ---------- Message Router (Content & Options) ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (!message || typeof message !== 'object') return;

    // Handle translation request from content script
    if (message.type === MSG.REQUEST_TRANSLATION) {
      (async () => {
        try {
          const cfg = await getConfig();
          ensureInfra(cfg);
          const jobId = message.jobId;
          const texts = Array.isArray(message.texts) ? message.texts : [(message.text || '').toString()];
          const outputs = await translateTextsV2(texts, cfg, message.params || {}, jobId);
          sendResponse({ ok: true, outputs });
        } catch (e) {
          sendResponse({ ok: false, error: eToString(e) });
        }
      })();
      return true; // keep channel open for async response
    }

    // Handle cancel translation
    if (message.type === MSG.CANCEL_TRANSLATION) {
      (async () => {
        try {
          const id = message.jobId;
          if (id) abortJob(id);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: eToString(e) });
        }
      })();
      return true;
    }

    // Options page requests
    if (message.type === MSG.LOAD_CONFIG) {
      (async () => {
        const cfg = await getConfig();
        sendResponse({ ok: true, config: cfg });
      })();
      return true;
    }

    if (message.type === MSG.SAVE_CONFIG) {
      (async () => {
        try {
          const saved = await setConfig(message.config || {});
          try { ensureInfra(saved); } catch {}
          sendResponse({ ok: true, config: saved });
        } catch (e) {
          sendResponse({ ok: false, error: eToString(e) });
        }
      })();
      return true;
    }
  } catch (e) {
    console.warn('[Edge AI Translator] onMessage error:', eToString(e));
    // do not throw, just ignore to avoid crashing service worker
  }
});

// ---------- Provider Integration ----------

/**
 * Translate an array of texts using configured provider.
 * Minimal contract:
 * - If provider.endpoint is empty, returns demo outputs for wiring test.
 * - POST { inputs: string[], sourceLang, targetLang, model, workflow } -> { outputs: string[] } or { data: [] }
 */
async function translateTexts(texts, config, params) {
  const providerType = (config?.provider?.type || 'custom').trim().toLowerCase();
  const sourceLang = params?.sourceLang || config?.workflow?.sourceLang || 'auto';
  const targetLang = params?.targetLang || config?.workflow?.targetLang || 'zh-CN';

  if (providerType === 'openai-compatible') {
    return await openAiCompatibleTranslate(texts, config, { sourceLang, targetLang });
  }
  // default: custom
  return await customTranslate(texts, config, { sourceLang, targetLang });

  async function customTranslate(texts, config, { sourceLang, targetLang }) {
    const endpoint = (config?.provider?.endpoint || '').trim();
    const model = (config?.provider?.model || '').trim();

    // Demo mode (no endpoint configured): echo back with marker to verify wiring.
    if (!endpoint) {
      return texts.map((t) => `[demo] ${t}`);
    }

    const baseHeaders = { 'content-type': 'application/json' };
    const extraHeaders = isObject(config?.provider?.headers) ? config.provider.headers : {};
    const authHeader = (config?.provider?.apiKey || '').trim()
      ? { authorization: `Bearer ${config.provider.apiKey.trim()}` }
      : {};
    const headers = { ...baseHeaders, ...extraHeaders, ...authHeader };

    const body = {
      inputs: texts,
      sourceLang,
      targetLang,
      model: model || undefined,
      workflow: Array.isArray(config?.workflow?.steps) ? config.workflow.steps : ['translate']
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`Provider HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await safeReadJson(res);
    const raw = Array.isArray(data?.outputs)
      ? data.outputs
      : Array.isArray(data?.data)
        ? data.data
        : null;

    if (!raw) throw new Error('Invalid provider response format; expected outputs[] or data[]');

    return raw.map((o, i) => {
      if (typeof o === 'string') return o;
      if (isObject(o) && typeof o.text === 'string') return o.text;
      return String(o ?? texts[i] ?? '');
    });
  }

  async function openAiCompatibleTranslate(texts, config, { sourceLang, targetLang }) {
    const endpoint = (config?.provider?.endpoint || 'https://api.openai.com/v1/chat/completions').trim();
    const model = (config?.provider?.model || 'gpt-3.5-turbo').trim();
    const baseHeaders = { 'content-type': 'application/json' };
    const extraHeaders = isObject(config?.provider?.headers) ? config.provider.headers : {};
    const apiKey = (config?.provider?.apiKey || '').trim();
    const authHeader = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const headers = { ...baseHeaders, ...extraHeaders, ...authHeader };

    if (!apiKey) {
      throw new Error('openai-compatible provider requires apiKey');
    }

    const outputs = [];
    for (const t of texts) {
      const body = {
        model: model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `You are a translation engine. Translate from ${sourceLang} to ${targetLang}. Preserve original formatting, punctuation, inline markup, and variables/placeholders. Output only the translated text.`
          },
          { role: 'user', content: String(t ?? '') }
        ]
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const text = await safeReadText(res);
        outputs.push(`[error] HTTP ${res.status}: ${text.slice(0, 200)}`);
        continue;
      }

      const data = await safeReadJson(res);
      const content = data?.choices?.[0]?.message?.content;
      outputs.push(typeof content === 'string' ? content : String(content ?? ''));
    }
    return outputs;
  }
}

async function safeReadText(res) {
  try { return await res.text(); } catch { return ''; }
}

async function safeReadJson(res) {
  try { return await res.json(); } catch { return {}; }
}

// ---------- Translation Orchestrator (v2): caching, batching, scheduler ----------

function langEquals(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

function getRetryOpts(cfg) {
  const r = cfg?.provider?.retry || {};
  const retryOn = Array.isArray(r.retryOn) ? r.retryOn : [429, 500, 502, 503, 504];
  return {
    maxRetries: typeof r.maxRetries === 'number' ? r.maxRetries : 5,
    baseDelayMs: typeof r.baseDelayMs === 'number' ? r.baseDelayMs : 800,
    maxDelayMs: typeof r.maxDelayMs === 'number' ? r.maxDelayMs : 20000,
    jitter: r.jitter !== false,
    retryOn,
    isRetriable: (e) => {
      if (!e) return false;
      if (e.name === 'AbortError' || e.name === 'SchedulerAbortError') return false;
      const status = typeof e.status === 'number' ? e.status : 0;
      return status ? retryOn.includes(status) : true; // network/type errors retriable
    }
  };
}

async function translateTextsV2(texts, config, params = {}, jobId) {
  const providerType = (config?.provider?.type || 'custom').trim().toLowerCase();
  const sourceLang = params?.sourceLang || config?.workflow?.sourceLang || 'auto';
  const targetLang = params?.targetLang || config?.workflow?.targetLang || 'zh-CN';
  const minLen = config?.workflow?.minTextLength ?? 2;

  const outs = new Array(texts.length);
  const pending = [];

  for (let i = 0; i < texts.length; i++) {
    const raw = texts[i];
    const t = String(raw ?? '');
    // skip: too short or same language hint
    if ((config?.workflow?.skipIfSourceEqualsTarget && sourceLang !== 'auto' && langEquals(sourceLang, targetLang)) ||
        isSkippableSegment(t, minLen)) {
      outs[i] = t;
      continue;
    }
    // cache
    const key = makeCacheKey({
      provider: providerType,
      model: String(config?.provider?.model || ''),
      sourceLang, targetLang, text: t
    });
    const cached = cacheInstance?.get(key);
    if (cached !== undefined) {
      outs[i] = cached;
    } else {
      pending.push({ idx: i, text: t, key });
    }
  }

  if (pending.length === 0) return outs;

  const retryOpts = getRetryOpts(config);

  if (providerType === 'openai-compatible') {
    const batching = config?.provider?.batching || {};
    if (batching.enabled !== false) {
      // Batch by budget
      const seq = pending.map(p => p.text);
      const chunks = splitInputsByBudget(seq, {
        maxItems: batching.maxItems ?? 20,
        maxChars: batching.maxChars ?? 8000,
        tokenBudget: batching.tokenBudget ?? 2000
      });
      const flatResults = [];
      for (const chunk of chunks) {
        const part = await openaiBatchTranslateArray(chunk, config, sourceLang, targetLang, jobId, retryOpts);
        flatResults.push(...part);
      }
      // Map back
      for (let k = 0; k < pending.length; k++) {
        const v = flatResults[k] ?? '';
        outs[pending[k].idx] = v;
        try { cacheInstance?.set(pending[k].key, v); } catch {}
      }
      return outs;
    }
    // Fallback per-item
    for (const p of pending) {
      const v = await openaiSingle(p.text, config, sourceLang, targetLang, jobId, retryOpts);
      outs[p.idx] = v;
      try { cacheInstance?.set(p.key, v); } catch {}
    }
    return outs;
  }

  // Default: custom provider supports array inputs
  {
    const seq = pending.map(p => p.text);
    const arr = await customTranslateBatch(seq, config, sourceLang, targetLang, jobId, retryOpts);
    for (let k = 0; k < pending.length; k++) {
      const v = arr[k] ?? '';
      outs[pending[k].idx] = v;
      try { cacheInstance?.set(pending[k].key, v); } catch {}
    }
    return outs;
  }
}

async function customTranslateBatch(texts, config, sourceLang, targetLang, jobId, retryOpts) {
  const endpoint = (config?.provider?.endpoint || '').trim();
  const model = (config?.provider?.model || '').trim();

  if (!endpoint) {
    return texts.map((t) => `[demo] ${t}`);
  }

  const baseHeaders = { 'content-type': 'application/json' };
  const extraHeaders = (config?.provider?.headers && typeof config.provider.headers === 'object') ? config.provider.headers : {};
  const apiKey = (config?.provider?.apiKey || '').trim();
  const authHeader = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const headers = { ...baseHeaders, ...extraHeaders, ...authHeader };

  const body = {
    inputs: texts,
    sourceLang,
    targetLang,
    model: model || undefined,
    workflow: Array.isArray(config?.workflow?.steps) ? config.workflow.steps : ['translate']
  };

  return scheduledFetch(schedulerInstance, async () => {
    const controller = new AbortController();
    registerController(jobId, controller);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!res.ok) {
        const text = await safeReadText(res);
        const err = new Error(`Provider HTTP ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      const data = await safeReadJson(res);
      const raw = Array.isArray(data?.outputs)
        ? data.outputs
        : Array.isArray(data?.data)
          ? data.data
          : null;
      if (!raw) throw new Error('Invalid provider response format; expected outputs[] or data[]');
      return raw.map((o, i) => {
        if (typeof o === 'string') return o;
        if (o && typeof o === 'object' && typeof o.text === 'string') return o.text;
        return String(o ?? texts[i] ?? '');
      });
    } finally {
      unregisterController(jobId, controller);
    }
  }, retryOpts);
}

async function openaiBatchTranslateArray(texts, config, sourceLang, targetLang, jobId, retryOpts) {
  const endpoint = (config?.provider?.endpoint || 'https://api.openai.com/v1/chat/completions').trim();
  const model = (config?.provider?.model || 'gpt-3.5-turbo').trim();

  const baseHeaders = { 'content-type': 'application/json' };
  const extraHeaders = (config?.provider?.headers && typeof config.provider.headers === 'object') ? config.provider.headers : {};
  const apiKey = (config?.provider?.apiKey || '').trim();
  const authHeader = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const headers = { ...baseHeaders, ...extraHeaders, ...authHeader };

  if (!apiKey) {
    throw new Error('openai-compatible provider requires apiKey');
  }

  // Compose system prompt, then conditionally inject randomized noise (anti-pattern detection)
  const noiseCfgRaw = (config?.workflow?.noise) || {};
  const noise = (() => {
    const enabled = !!noiseCfgRaw.enabled;
    const position = String(noiseCfgRaw.position || 'system');
    let probability = Number(noiseCfgRaw.probability);
    if (!Number.isFinite(probability)) probability = 0.6;
    probability = Math.min(Math.max(probability, 0), 1);
    let minWords = Math.max(0, Math.round(Number(noiseCfgRaw.minWords ?? 3)));
    let maxWords = Math.max(minWords, Math.round(Number(noiseCfgRaw.maxWords ?? 8)));
    if (maxWords > 100) maxWords = 100;
    const template = String(noiseCfgRaw.template || '--- NOISE --- {{noise}}');
    const dict = Array.isArray(noiseCfgRaw.dictionary) ? noiseCfgRaw.dictionary.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
    return { enabled, position, probability, minWords, maxWords, template, dict };
  })();

  let system = composePrompt({ sourceLang, targetLang, workflow: config?.workflow || {}, batch: true });

  if (noise.enabled) {
    const guide = "注意：以下以 '--- NOISE ---' 开头的行是随机噪声，请忽略。";
    function rnd() { try { const u = new Uint32Array(1); crypto.getRandomValues(u); return u[0] / 0xFFFFFFFF; } catch { return Math.random(); } }
    function randi(a, b) { const lo = Math.ceil(a), hi = Math.floor(b); return Math.floor(rnd() * (hi - lo + 1)) + lo; }
    function randomToken() { try { const u = new Uint8Array(6); crypto.getRandomValues(u); return Array.from(u).map(v => (v & 0x0f).toString(16)).join(''); } catch { return Math.random().toString(36).slice(2, 8); } }
    function buildNoiseText() {
      const cnt = randi(noise.minWords, noise.maxWords);
      if (noise.dict.length) {
        const arr = [];
        for (let i = 0; i < cnt; i++) arr.push(noise.dict[randi(0, noise.dict.length - 1)]);
        return arr.join(' ');
      }
      const arr = [];
      for (let i = 0; i < cnt; i++) arr.push(randomToken());
      return arr.join(' ');
    }
    function buildNoiseBlock() {
      const t = buildNoiseText();
      return (noise.template || '--- NOISE --- {{noise}}').replace(/\{\{\s*noise\s*\}\}/g, t);
    }
    // Batch mode: keep user JSON intact; always inject into system if we decide to inject
    if (rnd() <= noise.probability) {
      system += '\n\n' + guide + '\n' + buildNoiseBlock();
    }
  }

  const userPayload = { inputs: texts, meta: { sourceLang, targetLang } };

  try {
    const arr = await scheduledFetch(schedulerInstance, async () => {
      const controller = new AbortController();
      registerController(jobId, controller);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: JSON.stringify(userPayload) }
            ]
          }),
          signal: controller.signal
        });
        if (!res.ok) {
          const text = await safeReadText(res);
          const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
          err.status = res.status;
          throw err;
        }
        const data = await safeReadJson(res);
        const content = data?.choices?.[0]?.message?.content ?? '';
        const parsed = parseJsonArrayLike(String(content || ''), texts.length);
        if (!parsed) throw new Error('Invalid JSON array from provider');
        return parsed.map((x, i) => (typeof x === 'string' ? x : String(x ?? texts[i] ?? '')));
      } finally {
        unregisterController(jobId, controller);
      }
    }, retryOpts);
    return arr;
  } catch (e) {
    // If aborted, bubble up
    if (e?.name === 'AbortError' || e?.name === 'SchedulerAbortError') throw e;
    // Fallback to per-item
    const out = [];
    for (const t of texts) {
      const v = await openaiSingle(t, config, sourceLang, targetLang, jobId, retryOpts);
      out.push(v);
    }
    return out;
  }
}

async function openaiSingle(text, config, sourceLang, targetLang, jobId, retryOpts) {
  const endpoint = (config?.provider?.endpoint || 'https://api.openai.com/v1/chat/completions').trim();
  const model = (config?.provider?.model || 'gpt-3.5-turbo').trim();

  const baseHeaders = { 'content-type': 'application/json' };
  const extraHeaders = (config?.provider?.headers && typeof config.provider.headers === 'object') ? config.provider.headers : {};
  const apiKey = (config?.provider?.apiKey || '').trim();
  const authHeader = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const headers = { ...baseHeaders, ...extraHeaders, ...authHeader };

  if (!apiKey) {
    throw new Error('openai-compatible provider requires apiKey');
  }

  let system = composePrompt({ sourceLang, targetLang, workflow: config?.workflow || {}, batch: false });

  // Noise injection (configurable). For 'user_suffix', we append to user text; otherwise inject into system.
  const noiseCfgRaw = (config?.workflow?.noise) || {};
  const noise = (() => {
    const enabled = !!noiseCfgRaw.enabled;
    const position = String(noiseCfgRaw.position || 'system');
    let probability = Number(noiseCfgRaw.probability);
    if (!Number.isFinite(probability)) probability = 0.6;
    probability = Math.min(Math.max(probability, 0), 1);
    let minWords = Math.max(0, Math.round(Number(noiseCfgRaw.minWords ?? 3)));
    let maxWords = Math.max(minWords, Math.round(Number(noiseCfgRaw.maxWords ?? 8)));
    if (maxWords > 100) maxWords = 100;
    const template = String(noiseCfgRaw.template || '--- NOISE --- {{noise}}');
    const dict = Array.isArray(noiseCfgRaw.dictionary) ? noiseCfgRaw.dictionary.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
    return { enabled, position, probability, minWords, maxWords, template, dict };
  })();

  let userText = String(text ?? '');

  if (noise.enabled) {
    const guide = "注意：以下以 '--- NOISE ---' 开头的行是随机噪声，请忽略。";
    function rnd() { try { const u = new Uint32Array(1); crypto.getRandomValues(u); return u[0] / 0xFFFFFFFF; } catch { return Math.random(); } }
    function randi(a, b) { const lo = Math.ceil(a), hi = Math.floor(b); return Math.floor(rnd() * (hi - lo + 1)) + lo; }
    function randomToken() { try { const u = new Uint8Array(6); crypto.getRandomValues(u); return Array.from(u).map(v => (v & 0x0f).toString(16)).join(''); } catch { return Math.random().toString(36).slice(2, 8); } }
    function buildNoiseText() {
      const cnt = randi(noise.minWords, noise.maxWords);
      if (noise.dict.length) {
        const arr = [];
        for (let i = 0; i < cnt; i++) arr.push(noise.dict[randi(0, noise.dict.length - 1)]);
        return arr.join(' ');
      }
      const arr = [];
      for (let i = 0; i < cnt; i++) arr.push(randomToken());
      return arr.join(' ');
    }
    function buildNoiseBlock() {
      const t = buildNoiseText();
      return (noise.template || '--- NOISE --- {{noise}}').replace(/\{\{\s*noise\s*\}\}/g, t);
    }
    if (noise.position === 'user_suffix') {
      if (rnd() <= noise.probability) {
        system += '\n\n' + guide;
        userText = userText + '\n\n' + buildNoiseBlock();
      }
    } else {
      if (rnd() <= noise.probability) {
        system += '\n\n' + guide + '\n' + buildNoiseBlock();
      }
    }
  }

  return scheduledFetch(schedulerInstance, async () => {
    const controller = new AbortController();
    registerController(jobId, controller);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userText }
          ]
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        const textm = await safeReadText(res);
        const err = new Error(`HTTP ${res.status}: ${textm.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      const data = await safeReadJson(res);
      const content = data?.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content : String(content ?? '');
    } finally {
      unregisterController(jobId, controller);
    }
  }, retryOpts);
}

function parseJsonArrayLike(s, expectedLen) {
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v) && (expectedLen ? v.length === expectedLen : true)) return v;
  } catch {}
  // Try to extract bracketed array
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start >= 0 && end > start) {
    const cut = s.slice(start, end + 1);
    try {
      const v2 = JSON.parse(cut);
      if (Array.isArray(v2) && (expectedLen ? v2.length === expectedLen : true)) return v2;
    } catch {}
  }
  return null;
}