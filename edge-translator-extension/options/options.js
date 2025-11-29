/* Edge AI Translator - Options Page Script (MV3-compliant, external module) */
const MSG = {
  LOAD_CONFIG: 'LOAD_CONFIG',
  SAVE_CONFIG: 'SAVE_CONFIG',
  REQUEST_TRANSLATION: 'REQUEST_TRANSLATION'
};

const DEFAULT_CONFIG = {
  provider: {
    name: 'custom',
    type: 'custom',
    endpoint: '',
    apiKey: '',
    headers: {},
    model: '',
    limits: { maxConcurrent: 2, rps: 1, burst: 2, jitterMs: [50, 200] },
    retry: { maxRetries: 5, baseDelayMs: 800, maxDelayMs: 20000, jitter: true, retryOn: [429, 500, 502, 503, 504] },
    batching: { enabled: true, mode: 'json-array', maxItems: 20, maxChars: 8000, tokenBudget: 2000 }
  },
  workflow: {
    steps: ['translate'],
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
    selectionShowBubble: true,
    dynamicFlushMaxItems: 40,
    dynamicFlushWindowMs: 300,
    pageInitialBatchSize: 40,
    dynamicObserveMs: 10000
  }
};

function $(id){ return document.getElementById(id); }
function setStatus(msg, ok=true){
  const el = $('status'); if (!el) return;
  el.textContent = msg || '';
  el.style.color = ok ? 'var(--muted)' : 'var(--danger)';
}
function jsonParseSafe(text, fallback){
  if (!text || !text.trim()) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
function jsonStringify(obj){
  try { return JSON.stringify(obj, null, 2); } catch { return ''; }
}

// ----- Helpers for parsing/formatting advanced fields -----
function parseNumber(value, fallback){
  const n = Number((value ?? '').toString().trim());
  return Number.isFinite(n) ? n : fallback;
}

function parseRetryOn(text, fallback = [429,500,502,503,504]){
  const s = (text ?? '').trim();
  if (!s) return [...fallback];
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) {
      const arr = v.map(x => Number(x)).filter(n => Number.isFinite(n));
      return arr.length ? arr : [...fallback];
    }
  } catch {}
  const arr = s.split(/[,\s]+/).map(x => Number(x)).filter(n => Number.isFinite(n));
  return arr.length ? arr : [...fallback];
}

function formatJitterMs(jm){
  if (Array.isArray(jm)) return jm.join(',');
  if (typeof jm === 'number') return String(jm);
  return '';
}

function parseJitterMs(text, fallback){
  const s = (text ?? '').trim();
  if (!s) return fallback;
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && arr.length >= 1) {
        const a = Number(arr[0]); const b = Number(arr[1] ?? arr[0]);
        if (Number.isFinite(a) && Number.isFinite(b)) return [Math.min(a,b), Math.max(a,b)];
      }
    } catch {}
    return fallback;
  }
  if (s.includes(',')) {
    const parts = s.split(/[,\s]+/).map(x => Number(x)).filter(n => Number.isFinite(n));
    if (parts.length) {
      const a = parts[0]; const b = parts[1] ?? parts[0];
      return [Math.min(a,b), Math.max(a,b)];
    }
    return fallback;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonArray(text, fallback = []){
  const v = jsonParseSafe(text, fallback);
  return Array.isArray(v) ? v : fallback;
}

// ---- Safety helpers ----
function clamp(n, min, max){
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(Math.max(x, min), max);
}
function clampInt(n, min, max){
  return Math.round(clamp(n, min, max));
}
function sanitizeJitterMs(jm){
  if (Array.isArray(jm)) {
    const a = clamp(jm[0] ?? 0, 0, 2000);
    const b = clamp(jm[1] ?? jm[0] ?? 0, 0, 2000);
    return [Math.min(a,b), Math.max(a,b)];
  }
  const n = clamp(jm, 0, 2000);
  return [n, n];
}

async function loadConfigUI(){
  try {
    const resp = await chrome.runtime.sendMessage({ type: MSG.LOAD_CONFIG });
    if (!resp?.ok) throw new Error(resp?.error || '加载失败');
    const cfg = resp.config || DEFAULT_CONFIG;

    // Provider basics
    if ($('endpoint')) $('endpoint').value = cfg?.provider?.endpoint || '';
    if ($('apiKey')) $('apiKey').value = cfg?.provider?.apiKey || '';
    if ($('headers')) $('headers').value = jsonStringify(cfg?.provider?.headers || {});
    if ($('model')) $('model').value = cfg?.provider?.model || '';
    if ($('providerType')) $('providerType').value = (cfg?.provider?.type || 'custom');

    // Limits
    const lim = cfg?.provider?.limits || {};
    if ($('providerLimitsMaxConcurrent')) $('providerLimitsMaxConcurrent').value = String(lim.maxConcurrent ?? 2);
    if ($('providerLimitsRps')) $('providerLimitsRps').value = String(lim.rps ?? 1);
    if ($('providerLimitsBurst')) $('providerLimitsBurst').value = String(lim.burst ?? 2);
    if ($('providerLimitsJitterMs')) $('providerLimitsJitterMs').value = formatJitterMs(lim.jitterMs ?? [50,200]);

    // Retry
    const r = cfg?.provider?.retry || {};
    if ($('providerRetryMaxRetries')) $('providerRetryMaxRetries').value = String(r.maxRetries ?? 5);
    if ($('providerRetryBaseDelayMs')) $('providerRetryBaseDelayMs').value = String(r.baseDelayMs ?? 800);
    if ($('providerRetryMaxDelayMs')) $('providerRetryMaxDelayMs').value = String(r.maxDelayMs ?? 20000);
    if ($('providerRetryRetryOn')) $('providerRetryRetryOn').value = Array.isArray(r.retryOn) ? r.retryOn.join(',') : '';
    if ($('providerRetryJitter')) $('providerRetryJitter').checked = (r.jitter !== false);

    // Batching
    const b = cfg?.provider?.batching || {};
    if ($('providerBatchingEnabled')) $('providerBatchingEnabled').checked = (b.enabled !== false);
    if ($('providerBatchingMode')) $('providerBatchingMode').value = (b.mode || 'json-array');
    if ($('providerBatchingMaxItems')) $('providerBatchingMaxItems').value = String(b.maxItems ?? 20);
    if ($('providerBatchingMaxChars')) $('providerBatchingMaxChars').value = String(b.maxChars ?? 8000);
    if ($('providerBatchingTokenBudget')) $('providerBatchingTokenBudget').value = String(b.tokenBudget ?? 2000);

    // Cache
    const cc = cfg?.cache || {};
    if ($('cacheEnabled')) $('cacheEnabled').checked = (cc.enabled !== false);
    if ($('cacheSize')) $('cacheSize').value = String(cc.size ?? 500);
    if ($('cacheTtlMs')) $('cacheTtlMs').value = String(cc.ttlMs ?? (12*60*60*1000));

    // Workflow basics
    if ($('sourceLang')) $('sourceLang').value = (cfg?.workflow?.sourceLang || 'auto');
    if ($('targetLang')) $('targetLang').value = cfg?.workflow?.targetLang || 'zh-CN';
    if ($('steps')) $('steps').value = jsonStringify(Array.isArray(cfg?.workflow?.steps) ? cfg.workflow.steps : ['translate']);

    // Workflow advanced
    if ($('workflowMode')) $('workflowMode').value = (cfg?.workflow?.mode || 'single-call');
    if ($('responseFormat')) $('responseFormat').value = (cfg?.workflow?.responseFormat || 'auto');
    if ($('style')) $('style').value = (cfg?.workflow?.style || '简洁准确，保留格式与占位符');
    if ($('tone')) $('tone').value = (cfg?.workflow?.tone || '中性');
    if ($('promptTemplate')) $('promptTemplate').value = (cfg?.workflow?.promptTemplate || '');
    if ($('glossary')) $('glossary').value = jsonStringify(Array.isArray(cfg?.workflow?.glossary) ? cfg.workflow.glossary : []);
    if ($('protectPlaceholders')) $('protectPlaceholders').checked = !!(cfg?.workflow?.protectPlaceholders ?? true);
    if ($('skipIfSourceEqualsTarget')) $('skipIfSourceEqualsTarget').checked = !!(cfg?.workflow?.skipIfSourceEqualsTarget ?? true);
    if ($('minTextLength')) $('minTextLength').value = String(cfg?.workflow?.minTextLength ?? 2);

    // Workflow noise
    const noise = cfg?.workflow?.noise || {};
    if ($('workflowNoiseEnabled')) $('workflowNoiseEnabled').checked = !!(noise.enabled ?? false);
    if ($('workflowNoisePosition')) $('workflowNoisePosition').value = (noise.position || 'system');
    if ($('workflowNoiseProbability')) $('workflowNoiseProbability').value = String(Number.isFinite(noise.probability) ? noise.probability : 0.6);
    if ($('workflowNoiseMinWords')) $('workflowNoiseMinWords').value = String(noise.minWords ?? 3);
    if ($('workflowNoiseMaxWords')) $('workflowNoiseMaxWords').value = String(noise.maxWords ?? 8);
    if ($('workflowNoiseTemplate')) $('workflowNoiseTemplate').value = (noise.template || '--- NOISE --- {{noise}}');
    if ($('workflowNoiseDictionary')) $('workflowNoiseDictionary').value = jsonStringify(Array.isArray(noise.dictionary) ? noise.dictionary : []);

    // Behavior
    if ($('selectionShowBubble')) $('selectionShowBubble').checked = !!(cfg?.behavior?.selectionShowBubble ?? true);
    if ($('behaviorDynamicFlushMaxItems')) $('behaviorDynamicFlushMaxItems').value = String((cfg?.behavior?.dynamicFlushMaxItems ?? 40));
    if ($('behaviorDynamicFlushWindowMs')) $('behaviorDynamicFlushWindowMs').value = String((cfg?.behavior?.dynamicFlushWindowMs ?? 300));
    if ($('behaviorPageInitialBatchSize')) $('behaviorPageInitialBatchSize').value = String((cfg?.behavior?.pageInitialBatchSize ?? 40));
    if ($('behaviorDynamicObserveMs')) $('behaviorDynamicObserveMs').value = String((cfg?.behavior?.dynamicObserveMs ?? 10000));

    setStatus('配置已加载');
    console.log('[Options] 配置已加载', cfg);
  } catch (e) {
    setStatus(e.message || String(e), false);
    console.error('[Options] 加载失败', e);
  }
}

async function saveConfigUI(){
  try {
    const headers = jsonParseSafe($('headers')?.value, {});
    const steps = jsonParseSafe($('steps')?.value, ['translate']);
    if (!Array.isArray(steps)) throw new Error('步骤应为 JSON 数组');

    // Limits
    const lim = {
      maxConcurrent: parseNumber($('providerLimitsMaxConcurrent')?.value, 2),
      rps: parseNumber($('providerLimitsRps')?.value, 1),
      burst: parseNumber($('providerLimitsBurst')?.value, 2),
      jitterMs: parseJitterMs($('providerLimitsJitterMs')?.value, [50,200])
    };

    // Retry
    const retry = {
      maxRetries: parseNumber($('providerRetryMaxRetries')?.value, 5),
      baseDelayMs: parseNumber($('providerRetryBaseDelayMs')?.value, 800),
      maxDelayMs: parseNumber($('providerRetryMaxDelayMs')?.value, 20000),
      jitter: !!$('providerRetryJitter')?.checked,
      retryOn: parseRetryOn($('providerRetryRetryOn')?.value, [429,500,502,503,504])
    };

    // Batching
    const batchingMode = ($('providerBatchingMode')?.value || 'json-array');
    const batchingEnabled = !!$('providerBatchingEnabled')?.checked && batchingMode !== 'off';
    const batching = {
      enabled: batchingEnabled,
      mode: batchingMode,
      maxItems: parseNumber($('providerBatchingMaxItems')?.value, 20),
      maxChars: parseNumber($('providerBatchingMaxChars')?.value, 8000),
      tokenBudget: parseNumber($('providerBatchingTokenBudget')?.value, 2000)
    };

    // ---- Safety clamps (防误配置边界保护) ----
    // Limits
    lim.maxConcurrent = clampInt(lim.maxConcurrent ?? 2, 1, 4);
    lim.rps = clamp(lim.rps ?? 1, 0.2, 3);
    lim.burst = clampInt(lim.burst ?? 2, 1, 5);
    lim.jitterMs = sanitizeJitterMs(lim.jitterMs ?? [50, 200]);

    // Retry
    retry.maxRetries = clampInt(retry.maxRetries ?? 5, 0, 8);
    retry.baseDelayMs = clampInt(retry.baseDelayMs ?? 800, 200, 5000);
    retry.maxDelayMs = clampInt(Math.max(retry.maxDelayMs ?? 20000, retry.baseDelayMs ?? 800), 2000, 120000);
    if (retry.maxDelayMs < retry.baseDelayMs) retry.maxDelayMs = retry.baseDelayMs;

    // Batching
    batching.maxItems = clampInt(batching.maxItems ?? 20, 1, 50);
    batching.maxChars = clampInt(batching.maxChars ?? 8000, 500, 20000);
    batching.tokenBudget = clampInt(batching.tokenBudget ?? 2000, 200, 8000);

    // Cache
    const cache = {
      enabled: !!$('cacheEnabled')?.checked,
      size: parseNumber($('cacheSize')?.value, 500),
      ttlMs: parseNumber($('cacheTtlMs')?.value, 12*60*60*1000)
    };
    // Cache clamps
    cache.size = clampInt(cache.size ?? 500, 50, 5000);
    cache.ttlMs = clampInt(cache.ttlMs ?? (12*60*60*1000), 5*60*1000, 24*60*60*1000);

    // Workflow min length
    const minTL = clampInt(parseNumber($('minTextLength')?.value, 2), 1, 20);

    // Workflow advanced
    const glossary = parseJsonArray($('glossary')?.value, []);
    // Workflow noise (parse + clamps)
    const noiseEnabled = !!$('workflowNoiseEnabled')?.checked;
    const noisePosition = ($('workflowNoisePosition')?.value || 'system');
    let noiseProbability = parseNumber($('workflowNoiseProbability')?.value, 0.6);
    noiseProbability = clamp(noiseProbability, 0, 1);
    let noiseMinWords = clampInt(parseNumber($('workflowNoiseMinWords')?.value, 3), 0, 100);
    let noiseMaxWords = clampInt(parseNumber($('workflowNoiseMaxWords')?.value, 8), 0, 100);
    if (noiseMaxWords < noiseMinWords) noiseMaxWords = noiseMinWords;
    let noiseTemplate = ($('workflowNoiseTemplate')?.value || '--- NOISE --- {{noise}}').toString();
    if (noiseTemplate.length > 256) noiseTemplate = noiseTemplate.slice(0, 256);
    let noiseDictionary = parseJsonArray($('workflowNoiseDictionary')?.value, []);
    if (!Array.isArray(noiseDictionary)) noiseDictionary = [];
    noiseDictionary = noiseDictionary.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
    if (noiseDictionary.length > 200) noiseDictionary = noiseDictionary.slice(0, 200);
    // Behavior dynamic + clamps
    const behavior = {
      selectionShowBubble: !!$('selectionShowBubble')?.checked,
      dynamicFlushMaxItems: clampInt(parseNumber($('behaviorDynamicFlushMaxItems')?.value, 40), 5, 80),
      dynamicFlushWindowMs: clampInt(parseNumber($('behaviorDynamicFlushWindowMs')?.value, 300), 100, 2000),
      pageInitialBatchSize: clampInt(parseNumber($('behaviorPageInitialBatchSize')?.value, 40), 10, 80),
      dynamicObserveMs: clampInt(parseNumber($('behaviorDynamicObserveMs')?.value, 10000), 2000, 60000)
    };
    const config = {
      provider: {
        name: 'custom',
        type: ($('providerType')?.value || 'custom'),
        endpoint: $('endpoint')?.value?.trim() || '',
        apiKey: $('apiKey')?.value?.trim() || '',
        headers,
        model: $('model')?.value?.trim() || '',
        limits: lim,
        retry,
        batching
      },
      workflow: {
        steps,
        sourceLang: $('sourceLang')?.value || 'auto',
        targetLang: $('targetLang')?.value || 'zh-CN',
        mode: $('workflowMode')?.value || 'single-call',
        promptTemplate: $('promptTemplate')?.value || '',
        style: $('style')?.value || '简洁准确，保留格式与占位符',
        tone: $('tone')?.value || '中性',
        glossary: Array.isArray(glossary) ? glossary : [],
        protectPlaceholders: !!$('protectPlaceholders')?.checked,
        responseFormat: $('responseFormat')?.value || 'auto',
        skipIfSourceEqualsTarget: !!$('skipIfSourceEqualsTarget')?.checked,
        minTextLength: minTL,
        noise: {
          enabled: noiseEnabled,
          position: noisePosition,
          probability: noiseProbability,
          minWords: noiseMinWords,
          maxWords: noiseMaxWords,
          template: noiseTemplate,
          dictionary: noiseDictionary
        }
      },
      cache,
      behavior
    };

    const resp = await chrome.runtime.sendMessage({ type: MSG.SAVE_CONFIG, config });
    if (!resp?.ok) throw new Error(resp?.error || '保存失败');
    setStatus('已保存');
    console.log('[Options] 已保存', config);
  } catch (e) {
    setStatus(e.message || String(e), false);
    console.error('[Options] 保存失败', e);
  }
}

async function resetDefaults(){
  if (!confirm('确定恢复默认配置？')) return;
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    const resp = await chrome.runtime.sendMessage({ type: MSG.SAVE_CONFIG, config });
    if (!resp?.ok) throw new Error(resp?.error || '恢复失败');
    await loadConfigUI();
    setStatus('已恢复默认配置');
  } catch (e) {
    setStatus(e.message || String(e), false);
    console.error('[Options] 恢复失败', e);
  }
}

async function testTranslation(){
  try {
    const text = $('testInput')?.value?.trim() || '';
    if (!text) { setStatus('请输入要测试的文本'); return; }
    setStatus('测试中…');

    const params = {
      sourceLang: $('sourceLang')?.value || 'auto',
      targetLang: $('targetLang')?.value || 'zh-CN'
    };

    const resp = await chrome.runtime.sendMessage({ type: MSG.REQUEST_TRANSLATION, texts: [text], params });
    if (!resp?.ok) throw new Error(resp?.error || '测试失败');
    const out = Array.isArray(resp.outputs) ? resp.outputs[0] : '';
    if ($('testOut')) $('testOut').textContent = out ?? '';
    setStatus('测试完成');
    console.log('[Options] 测试完成', { input: text, output: out });
  } catch (e) {
    setStatus(e.message || String(e), false);
    console.error('[Options] 测试失败', e);
  }
}

function bindEvents(){
  $('saveBtn')?.addEventListener('click', saveConfigUI);
  $('resetBtn')?.addEventListener('click', resetDefaults);
  $('testBtn')?.addEventListener('click', testTranslation);
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadConfigUI();
});

// 兜底：部分场景脚本加载快于 DOM
bindEvents();
loadConfigUI();