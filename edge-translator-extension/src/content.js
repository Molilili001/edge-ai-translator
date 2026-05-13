/**
 * Edge AI Translator - Content Script
 * Handles page translation and selection translation UI.
 */

'use strict';

// Message types must match background
const MSG = {
  TRANSLATE_PAGE: 'TRANSLATE_PAGE',
  TRANSLATE_SELECTION: 'TRANSLATE_SELECTION',
  START_IMMERSIVE_TRANSLATION: 'START_IMMERSIVE_TRANSLATION',
  STOP_IMMERSIVE_TRANSLATION: 'STOP_IMMERSIVE_TRANSLATION',
  GET_IMMERSIVE_STATUS: 'GET_IMMERSIVE_STATUS',
  REQUEST_TRANSLATION: 'REQUEST_TRANSLATION',
  CANCEL_TRANSLATION: 'CANCEL_TRANSLATION',
  LOAD_CONFIG: 'LOAD_CONFIG',
  PING: '__PING__'
};

// ---------- State ----------
let bubbleEl = null;
let bannerEl = null;
let translatingPage = false;
let currentConfig = null;
// Selection bubble runtime state
let bubbleManuallyMoved = false;
let bubbleRequestSeq = 0;
// Observer for dynamic content during page translate
let pageObserver = null;
// Track processed text nodes to avoid duplicate translations
let processedNodes = null;
// Current page-translate job id for cancellation
let currentJobId = null;

// Immersive translation runtime state (continuous translation)
let immersiveActive = false;
let immersiveObserver = null;
let immersiveProcessedNodes = null;
let immersiveScheduledNodes = null;
let immersivePending = [];
let immersiveFlushTimer = null;
let immersiveFlushing = false;
let immersivePriorityPending = false;
let immersiveJobId = null;
let immersiveSourceHint = null;
let immersiveTargetLang = null;
let immersiveMaxBatch = 40;
let immersiveFlushWindowMs = 300;
let immersiveInitialBatchSize = 40;
let immersiveIndicatorEl = null;
let immersiveInitializing = false;
let immersiveIndicatorTimer = null;
let immersiveErrorStreak = 0;
let immersiveBlockMarkers = null;
let immersiveMarkerRaf = null;
let immersiveRegionOverlayEl = null;
let immersiveRegionBoxEl = null;
let immersiveRegionActive = false;
let immersiveRegionStart = null;
let immersiveRegionKeyHandler = null;

// ---------- Config ----------
async function loadConfig() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: MSG.LOAD_CONFIG });
    if (resp?.ok) {
      currentConfig = resp.config || null;
      return currentConfig;
    }
  } catch {}
  return currentConfig;
}

function getTargetLang() {
  return currentConfig?.workflow?.targetLang || 'zh-CN';
}

function getDefaultSourceLang() {
  return currentConfig?.workflow?.sourceLang || 'auto';
}

// ---------- Language detection ----------
function detectLangFromDoc() {
  const langAttr = (document.documentElement.getAttribute('lang') || '').toLowerCase();
  if (langAttr.startsWith('ja')) return 'ja';
  if (langAttr.startsWith('zh')) return 'zh';
  if (langAttr.startsWith('ko')) return 'ko';
  if (langAttr.startsWith('en')) return 'en';
  return null;
}

function detectLangFromText(text) {
  if (!text) return null;
  // Japanese: Hiragana/Katakana ranges
  const hasKana = /[\u3040-\u30ff]/.test(text);
  if (hasKana) return 'ja';
  // Korean: Hangul
  const hasHangul = /[\u3130-\u318F\uAC00-\uD7AF]/.test(text);
  if (hasHangul) return 'ko';
  // Chinese/Japanese Kanji: CJK Unified Ideographs
  const hasCJK = /[\u4E00-\u9FFF]/.test(text);
  if (hasCJK) {
    // If kana not present, prefer zh as hint (could be jp/zh), otherwise ja handled above
    return 'zh';
  }
  // Latin letters dominance heuristic for English
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const nonLatin = (text.match(/[^A-Za-z\s]/g) || []).length;
  if (latin > 8 && latin >= nonLatin) return 'en';
  return null;
}

function detectPageSourceLang(sampleTexts) {
  // Priority: document lang -> text heuristics -> default
  const byDoc = detectLangFromDoc();
  if (byDoc) return byDoc;
  for (const t of sampleTexts || []) {
    const h = detectLangFromText(t);
    if (h) return h;
  }
  return getDefaultSourceLang();
}

// ---------- UI: Bubble for selection ----------
function ensureBubble() {
  if (bubbleEl && document.body.contains(bubbleEl)) return bubbleEl;
  bubbleEl = document.createElement('div');
  bubbleEl.className = 'edge-ai-translator-bubble';
  bubbleEl.style.display = 'none';
  bubbleEl.style.position = 'fixed';
  bubbleEl.innerHTML = `
    <div class="edge-ai-bubble-header">
      <span class="edge-ai-title">AI 翻译</span>
      <button class="edge-ai-close" title="关闭">×</button>
    </div>
    <div class="edge-ai-bubble-body">
      <div class="edge-ai-bubble-src" contenteditable="true" spellcheck="false"></div>
      <div class="edge-ai-bubble-sep"></div>
      <div class="edge-ai-bubble-dst"></div>
    </div>
    <div class="edge-ai-bubble-actions">
      <button class="edge-ai-translate-again">再次翻译</button>
      <button class="edge-ai-copy">复制译文</button>
    </div>
  `;
  bubbleEl.addEventListener('click', (e) => e.stopPropagation());
  // 仅通过“×”关闭，不再用全局点击关闭
  document.body.appendChild(bubbleEl);

  const closeBtn = bubbleEl.querySelector('.edge-ai-close');
  const copyBtn = bubbleEl.querySelector('.edge-ai-copy');
  const translateBtn = bubbleEl.querySelector('.edge-ai-translate-again');
  const srcBox = bubbleEl.querySelector('.edge-ai-bubble-src');
  const dstBox = bubbleEl.querySelector('.edge-ai-bubble-dst');
  const header = bubbleEl.querySelector('.edge-ai-bubble-header');

  closeBtn?.addEventListener('click', hideBubble);
  copyBtn?.addEventListener('click', () => {
    const text = dstBox?.textContent || '';
    navigator.clipboard?.writeText(text).catch(() => {});
  });
  translateBtn?.addEventListener('click', async () => {
    const mySeq = ++bubbleRequestSeq;
    try {
      await loadConfig();
      const hint = detectLangFromText(srcBox?.textContent || '') || getDefaultSourceLang();
      const target = getTargetLang();
      dstBox.innerHTML = '<span class="edge-ai-loading"></span> 翻译中…';
      const outputs = await requestTranslation([srcBox?.textContent || ''], { sourceLang: hint, targetLang: target });
      if (mySeq !== bubbleRequestSeq) return;
      if (bubbleEl?.style?.display === 'none') return;
      dstBox.textContent = outputs[0] || '';
    } catch (e) {
      if (mySeq !== bubbleRequestSeq) return;
      if (bubbleEl?.style?.display === 'none') return;
      dstBox.innerHTML = escapeHtml(e?.message || String(e));
    }
  });

  // 拖拽支持：拖动头部可移动窗口
  let dragging = false;
  let moved = false;
  let offsetX = 0, offsetY = 0;
  header?.addEventListener('mousedown', (ev) => {
    if (bubbleEl.style.display === 'none') return;
    dragging = true;
    moved = false;
    const rect = bubbleEl.getBoundingClientRect();
    offsetX = ev.clientX - rect.left;
    offsetY = ev.clientY - rect.top;
    ev.preventDefault();
  });
  window.addEventListener('mousemove', (ev) => {
    if (!dragging || bubbleEl.style.display === 'none') return;
    moved = true;
    bubbleEl.style.left = Math.max(4, ev.clientX - offsetX) + 'px';
    bubbleEl.style.top = Math.max(4, ev.clientY - offsetY) + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (dragging && moved) bubbleManuallyMoved = true;
    dragging = false;
    moved = false;
  });

  return bubbleEl;
}

function updateBubbleContent(opts) {
  const el = ensureBubble();
  const srcBox = el.querySelector('.edge-ai-bubble-src');
  const dstBox = el.querySelector('.edge-ai-bubble-dst');

  if (typeof opts === 'string') {
    dstBox.innerHTML = opts;
    return;
  }
  if (opts && typeof opts === 'object') {
    if (opts.src != null) srcBox.textContent = String(opts.src);
    if (opts.dst != null) dstBox.textContent = String(opts.dst);
    if (opts.dstHtml != null) dstBox.innerHTML = String(opts.dstHtml);
  }
}

function positionBubble(rect, { force = false } = {}) {
  const el = ensureBubble();
  if (!force && bubbleManuallyMoved) return;

  const padding = 8;
  const x = Math.max(8, (rect?.left ?? (window.innerWidth / 2)));
  const y = Math.max(8, (rect?.bottom ?? (window.innerHeight / 2)) + padding);

  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function showBubble(rect, opts, { reposition = true } = {}) {
  const el = ensureBubble();
  updateBubbleContent(opts);
  if (reposition) {
    bubbleManuallyMoved = false;
    positionBubble(rect, { force: true });
  }
  el.style.display = 'block';
}

function hideBubble() {
  if (!bubbleEl) return;
  // invalidate in-flight selection translation requests
  try { bubbleRequestSeq++; } catch {}
  bubbleManuallyMoved = false;
  bubbleEl.style.display = 'none';
  hideQuickButton();
}

// --------- Quick translate button near selection ---------
let quickBtnEl = null;

function ensureQuickButton() {
  if (quickBtnEl && document.body.contains(quickBtnEl)) return quickBtnEl;
  quickBtnEl = document.createElement('button');
  quickBtnEl.className = 'edge-ai-quick-btn';
  quickBtnEl.type = 'button';
  quickBtnEl.textContent = '翻译';
  quickBtnEl.style.display = 'none';
  quickBtnEl.style.position = 'fixed';
  quickBtnEl.addEventListener('click', () => {
    handleTranslateSelection();
  });
  document.body.appendChild(quickBtnEl);
  return quickBtnEl;
}

function showQuickButtonAt(rect) {
  const btn = ensureQuickButton();
  const x = Math.max(4, (rect?.right ?? (window.innerWidth / 2)));
  const y = Math.max(4, (rect?.bottom ?? (window.innerHeight / 2)));
  btn.style.left = `${x}px`;
  btn.style.top = `${y}px`;
  btn.style.display = 'block';
}

function hideQuickButton() {
  if (!quickBtnEl) return;
  quickBtnEl.style.display = 'none';
}

// 监听选择变化与交互事件，提升触发率
let quickBtnTimer = null;
function scheduleQuickButtonUpdate(delay = 0) {
  try { if (quickBtnTimer) clearTimeout(quickBtnTimer); } catch {}
  quickBtnTimer = setTimeout(updateQuickButton, delay);
}
function updateQuickButton() {
  try {
    const info = getSelectionInfo();
    if (info && info.text) {
      showQuickButtonAt(info.rect);
    } else {
      hideQuickButton();
    }
  } catch {
    hideQuickButton();
  }
}
document.addEventListener('selectionchange', () => scheduleQuickButtonUpdate(50));
document.addEventListener('mouseup', () => scheduleQuickButtonUpdate(0));
document.addEventListener('keyup', () => scheduleQuickButtonUpdate(0));
document.addEventListener('pointerup', () => scheduleQuickButtonUpdate(0));

// ---------- UI: Banner for page translating ----------
function ensureBanner() {
  if (bannerEl && document.body.contains(bannerEl)) return bannerEl;
  bannerEl = document.createElement('div');
  bannerEl.className = 'edge-ai-translator-banner';
  bannerEl.innerHTML = `
    <span class="edge-ai-banner-text">翻译中…</span>
    <button class="edge-ai-banner-cancel" title="取消翻译">取消</button>
  `;
  document.body.appendChild(bannerEl);
  bannerEl.querySelector('.edge-ai-banner-cancel')?.addEventListener('click', () => {
    translatingPage = false;
    try {
      if (currentJobId) {
        chrome.runtime.sendMessage({ type: MSG.CANCEL_TRANSLATION, jobId: currentJobId });
      }
    } catch {}
    currentJobId = null;
    removeBanner();
  });
  return bannerEl;
}

function setBannerText(text) {
  ensureBanner().querySelector('.edge-ai-banner-text').textContent = text;
}

function removeBanner() {
  if (bannerEl && bannerEl.parentNode) {
    bannerEl.parentNode.removeChild(bannerEl);
  }
  bannerEl = null;
  // clean up observer & state
  try { pageObserver?.disconnect(); } catch {}
  pageObserver = null;
  processedNodes = null;
}

// ---------- Messaging with background ----------
function requestTranslation(texts, params = {}, jobId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: MSG.REQUEST_TRANSLATION, texts, params, jobId },
      (resp) => {
        if (!resp) {
          reject(new Error('No response from background'));
        } else if (resp.ok) {
          resolve(resp.outputs || []);
        } else {
          reject(new Error(resp.error || 'Translation failed'));
        }
      }
    );
  });
}

// ---------- Selection translation ----------
async function handleTranslateSelection(payload) {
  const mySeq = ++bubbleRequestSeq;
  const selectionInfo = getSelectionInfo(payload?.selectionText);
  if (!selectionInfo || !selectionInfo.text) {
    showBubble(null, '未检测到选中文本');
    return;
  }

  // 先展示气泡（避免 loadConfig/网络失败时完全无反馈）
  showBubble(selectionInfo.rect, { src: selectionInfo.text, dstHtml: '<span class="edge-ai-loading"></span> 翻译中…' }, { reposition: true });

  try {
    await loadConfig();
    // Detect sourceLang hint from selection to improve jp->zh translation
    const cfgSource = getDefaultSourceLang();
    const target = getTargetLang();
    let hint = (cfgSource && cfgSource !== 'auto') ? cfgSource : (detectLangFromText(selectionInfo.text) || 'auto');
    // 避免“源语言提示=目标语言”触发后台 skipIfSourceEqualsTarget，导致中英混合等场景不翻译
    if ((cfgSource === 'auto' || !cfgSource) && hint !== 'auto' && langEqualsLoose(hint, target)) {
      hint = 'auto';
    }

    const outputs = await requestTranslation([selectionInfo.text], { sourceLang: hint, targetLang: target });
    if (mySeq !== bubbleRequestSeq) return;
    if (bubbleEl?.style?.display === 'none') return;
    const translated = outputs[0] || '';
    showBubble(selectionInfo.rect, { dst: translated }, { reposition: false });
  } catch (e) {
    if (mySeq !== bubbleRequestSeq) return;
    if (bubbleEl?.style?.display === 'none') return;
    showBubble(selectionInfo.rect, `错误：${escapeHtml(e?.message || String(e))}`, { reposition: false });
  }
}

function getSelectionInfo(externalText) {
  try {
    const sel = window.getSelection();
    const text = (externalText ?? (sel ? sel.toString() : '')).trim();
    let rect = null;

    if (!externalText && sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      try {
        rect = range.getBoundingClientRect();
      } catch {}
      // Fallback: 选区由多段组成时，取最后一段的矩形
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        try {
          const rects = Array.from(range.getClientRects());
          if (rects.length) rect = rects[rects.length - 1];
        } catch {}
      }
      // Fallback: 退化到 anchor/focus 的元素矩形
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        const elA = sel.anchorNode && sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
        const elF = sel.focusNode && sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode?.parentElement;
        try {
          const rA = elA?.getBoundingClientRect?.();
          const rF = elF?.getBoundingClientRect?.();
          rect = rF || rA || rect;
        } catch {}
      }
    }
    return { text, rect };
  } catch {
    return { text: (externalText || '').trim(), rect: null };
  }
}

// ---------- Page translation ----------
async function handleTranslatePage() {
  if (translatingPage) return;
  translatingPage = true;
  try {
    await loadConfig();

    ensureBanner();
    setBannerText('扫描页面文本…');

    // track already processed nodes
    processedNodes = new WeakSet();
    // assign job id for this page translation
    currentJobId = genJobId();

    const nodes = collectTranslatableTextNodes(document.body);
    console.debug('[EdgeAI] Page translate: nodes=', nodes.length);
    if (nodes.length === 0) {
      setBannerText('未发现可翻译文本');
      setTimeout(removeBanner, 1200);
      translatingPage = false;
      currentJobId = null;
      return;
    }

    // Make a small sample for detection
    const sample = nodes.slice(0, Math.min(20, nodes.length)).map(n => n.text).filter(Boolean);
    const srcHint = detectPageSourceLang(sample);
    const tgt = getTargetLang();

    // Behavior-based throttles for dynamic flush & initial batching
    const behavior = (currentConfig && currentConfig.behavior) || {};
    const dynamicMaxBatch = Math.max(5, Math.min(80, Number(behavior.dynamicFlushMaxItems ?? 40)));
    const flushWindow = Math.max(100, Math.min(2000, Number(behavior.dynamicFlushWindowMs ?? 300)));
    const initialBatchSize = Math.max(10, Math.min(80, Number(behavior.pageInitialBatchSize ?? dynamicMaxBatch)));
    const observeMs = Math.max(2000, Math.min(60000, Number(behavior.dynamicObserveMs ?? 10000)));

    // Dedup texts: text -> indices[]
    const textToIdxs = new Map();
    const uniqueTexts = [];
    for (let i = 0; i < nodes.length; i++) {
      const t = nodes[i].text;
      if (!textToIdxs.has(t)) {
        textToIdxs.set(t, [i]);
        uniqueTexts.push(t);
      } else {
        textToIdxs.get(t).push(i);
      }
    }

    setBannerText(`翻译中（独立段 ${uniqueTexts.length}，总节点 ${nodes.length}，源：${srcHint} → 目标：${tgt}）…`);

    const batchSize = initialBatchSize;
    let translatedUnique = 0;

    for (let i = 0; i < uniqueTexts.length && translatingPage; i += batchSize) {
      const chunk = uniqueTexts.slice(i, i + batchSize);
      // eslint-disable-next-line no-await-in-loop
      const outputs = await requestTranslation(chunk, { sourceLang: srcHint, targetLang: tgt }, currentJobId);
      outputs.forEach((out, idx) => {
        const txt = chunk[idx];
        const arr = textToIdxs.get(txt) || [];
        for (const nodeIdx of arr) {
          const item = nodes[nodeIdx];
          if (item && item.node && typeof out === 'string') {
            item.node.textContent = out;
            try { processedNodes?.add(item.node); } catch {}
          }
        }
      });
      translatedUnique += chunk.length;
      setBannerText(`翻译中… ${translatedUnique}/${uniqueTexts.length}`);
    }

    // Short-lived observer to catch dynamically loaded content (e.g., lazy lists)
    // observeMs is derived from behavior.dynamicObserveMs
    let pending = [];
    let flushTimer = null;

    function queueNodes(newNodes) {
      for (const it of newNodes) {
        try {
          if (processedNodes && !processedNodes.has(it.node)) pending.push(it);
        } catch {}
      }
      if (!flushTimer) {
        flushTimer = setTimeout(flush, flushWindow);
      }
    }

    async function flush() {
      const batch = pending.splice(0, pending.length);
      flushTimer = null;
      if (!translatingPage || batch.length === 0) return;
      try {
        // de-duplicate by text within this batch
        const map = new Map();
        for (const it of batch) {
          if (!processedNodes || !processedNodes.has(it.node)) {
            const arr = map.get(it.text);
            if (arr) arr.push(it);
            else map.set(it.text, [it]);
          }
        }
        const texts2 = Array.from(map.keys());
        if (texts2.length === 0) return;
        // Respect dynamicMaxBatch to reduce burst size
        for (let i = 0; i < texts2.length; i += dynamicMaxBatch) {
          const chunk2 = texts2.slice(i, i + dynamicMaxBatch);
          // eslint-disable-next-line no-await-in-loop
          const outs2 = await requestTranslation(chunk2, { sourceLang: srcHint, targetLang: tgt }, currentJobId);
          outs2.forEach((out, idx) => {
            const txt = chunk2[idx];
            const items = map.get(txt) || [];
            for (const item of items) {
              if (item && item.node && typeof out === 'string') {
                item.node.textContent = out;
                try { processedNodes?.add(item.node); } catch {}
              }
            }
          });
        }
      } catch {
        // ignore transient errors
      }
    }

    try { pageObserver?.disconnect(); } catch {}
    pageObserver = new MutationObserver((mutations) => {
      if (!translatingPage) return;
      for (const m of mutations) {
        for (const added of m.addedNodes) {
          const nn = collectTranslatableTextNodes(added);
          if (nn && nn.length) queueNodes(nn);
        }
      }
    });
    try { pageObserver.observe(document.body, { childList: true, subtree: true }); } catch {}

    setBannerText(`完成（监听新内容 ${Math.round(observeMs/1000)}秒）`);
    setTimeout(() => {
      if (!translatingPage) return;
      translatingPage = false;
      try { pageObserver?.disconnect(); } catch {}
      pageObserver = null;
      setBannerText('完成');
      setTimeout(removeBanner, 500);
      currentJobId = null;
    }, observeMs);

  } catch (e) {
    setBannerText(`错误：${e.message || String(e)}`);
    setTimeout(removeBanner, 2000);
  } finally {
    if (!translatingPage) {
      try { pageObserver?.disconnect(); } catch {}
      pageObserver = null;
      processedNodes = null;
    }
  }
}

function collectTranslatableTextNodes(root) {
  const nodes = [];
  const SKIP_TAGS = /(SCRIPT|STYLE|NOSCRIPT|IFRAME|OBJECT|EMBED|CANVAS|SVG|CODE|PRE|TEXTAREA|INPUT|SELECT|OPTION)/;

  const acceptNode = (node) => {
    if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
    const p = node.parentElement;
    if (!p) return NodeFilter.FILTER_REJECT;
    // 不翻译扩展自身的 UI
    if (p.closest('.edge-ai-translator-bubble')) return NodeFilter.FILTER_REJECT;
    if (p.closest('.edge-ai-translator-banner')) return NodeFilter.FILTER_REJECT;
    if (p.closest('.edge-ai-quick-btn')) return NodeFilter.FILTER_REJECT;
    if (p.closest('.edge-ai-immersive-indicator')) return NodeFilter.FILTER_REJECT;
    if (p.closest('.edge-ai-immersive-block-marker')) return NodeFilter.FILTER_REJECT;
    if (p.closest('.edge-ai-immersive-region-overlay')) return NodeFilter.FILTER_REJECT;
    const tag = p.tagName;
    if (!isVisible(p)) return NodeFilter.FILTER_REJECT;
    if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
    if (SKIP_TAGS.test(tag)) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  };

  function collectFrom(rootNode) {
    try {
      if (rootNode && rootNode.nodeType === Node.TEXT_NODE) {
        // TreeWalker 不会自动包含根节点自身；对 Text 节点 root 做一次手动收集
        try {
          if (acceptNode(rootNode) === NodeFilter.FILTER_ACCEPT) {
            const t0 = (rootNode.nodeValue || '').trim();
            if (t0) nodes.push({ node: rootNode, text: t0 });
          }
        } catch {}
        return;
      }
      const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, { acceptNode });
      let current;
      while ((current = walker.nextNode())) {
        const t = current.nodeValue.trim();
        if (t) nodes.push({ node: current, text: t });
      }
      // 遍历 Shadow DOM（很多站点把正文挂在 web components 的 shadowRoot 内）
      const els = rootNode.querySelectorAll ? rootNode.querySelectorAll('*') : [];
      for (const el of els) {
        const sr = el.shadowRoot;
        if (sr) collectFrom(sr);
      }
    } catch {
      // 某些根可能不支持 querySelectorAll / TreeWalker；忽略即可
    }
  }

  collectFrom(root);
  return nodes;
}

function isVisible(el) {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// ---------- Helpers ----------
function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s ?? '');
  return div.innerHTML;
}

function genJobId() {
  try {
    return 'job_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  } catch {
    return 'job_' + Date.now();
  }
}

// ---------- UI: Immersive indicator ----------
function ensureImmersiveIndicator() {
  try {
    if (immersiveIndicatorEl && document.body.contains(immersiveIndicatorEl)) return immersiveIndicatorEl;
    immersiveIndicatorEl = document.createElement('div');
    immersiveIndicatorEl.className = 'edge-ai-immersive-indicator';
    immersiveIndicatorEl.style.display = 'none';
    immersiveIndicatorEl.innerHTML = `
      <span class="edge-ai-immersive-text">沉浸翻译：开启</span>
      <button class="edge-ai-immersive-priority" type="button" title="框选优先翻译">框选</button>
      <button class="edge-ai-immersive-stop" type="button" title="停止沉浸式翻译">停止</button>
    `;
    immersiveIndicatorEl.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(immersiveIndicatorEl);
    immersiveIndicatorEl.querySelector('.edge-ai-immersive-stop')?.addEventListener('click', () => {
      stopImmersiveTranslation('user');
    });
    immersiveIndicatorEl.querySelector('.edge-ai-immersive-priority')?.addEventListener('click', () => {
      startImmersiveRegionSelection();
    });
    return immersiveIndicatorEl;
  } catch {
    return null;
  }
}

function setImmersiveIndicator(text, { autoHideMs = 0 } = {}) {
  const el = ensureImmersiveIndicator();
  if (!el) return;
  const nextText = String(text ?? '');
  try {
    const t = el.querySelector('.edge-ai-immersive-text');
    if (t) t.textContent = nextText;
  } catch {}
  el.style.display = 'block';
  if (immersiveIndicatorTimer) {
    try { clearTimeout(immersiveIndicatorTimer); } catch {}
    immersiveIndicatorTimer = null;
  }
  if (autoHideMs > 0) {
    immersiveIndicatorTimer = setTimeout(() => {
      const t = immersiveIndicatorEl?.querySelector?.('.edge-ai-immersive-text');
      if (t && t.textContent !== nextText) return;
      if (immersiveActive) {
        if (t) t.textContent = '沉浸翻译：开启';
      } else {
        hideImmersiveIndicator();
      }
    }, autoHideMs);
  }
}

function hideImmersiveIndicator() {
  if (immersiveIndicatorTimer) {
    try { clearTimeout(immersiveIndicatorTimer); } catch {}
    immersiveIndicatorTimer = null;
  }
  if (!immersiveIndicatorEl) return;
  try { immersiveIndicatorEl.style.display = 'none'; } catch {}
}

// ---------- Immersive translation (continuous) ----------
function isTopFrame() {
  try { return window.top === window; } catch { return true; }
}

function langEqualsLoose(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

function isTextMostlyTargetLang(text, targetLang) {
  // Heuristic: if detectLangFromText returns zh/en/ja/ko and equals target (prefix match), treat as already-target.
  const hint = detectLangFromText(text);
  if (!hint) return false;
  return langEqualsLoose(hint, targetLang);
}

function getTextNodeTrimmedText(node) {
  try {
    if (!node || node.nodeType !== Node.TEXT_NODE) return '';
    return (node.nodeValue || '').trim();
  } catch {
    return '';
  }
}

function getImmersiveProcessedText(node) {
  try {
    return immersiveProcessedNodes?.get(node) || '';
  } catch {
    return '';
  }
}

function markImmersiveProcessed(node, text) {
  const t = String(text ?? '').trim();
  if (!node || !t) return;
  if (!immersiveProcessedNodes) immersiveProcessedNodes = new WeakMap();
  try { immersiveProcessedNodes.set(node, t); } catch {}
}

function clearImmersiveScheduled(node) {
  try { immersiveScheduledNodes?.delete(node); } catch {}
}

function scheduleImmersiveFlush(delayMs = immersiveFlushWindowMs) {
  if (!immersiveActive || immersivePending.length === 0) return;
  if (immersiveFlushing) return;
  const delay = Math.max(0, Number(delayMs) || 0);
  if (immersiveFlushTimer) {
    if (delay === 0) {
      try { clearTimeout(immersiveFlushTimer); } catch {}
      immersiveFlushTimer = setTimeout(immersiveFlush, 0);
    }
    return;
  }
  immersiveFlushTimer = setTimeout(immersiveFlush, delay);
}

function removePendingImmersiveItem(node, text) {
  if (!node || immersivePending.length === 0) return false;
  let removed = false;
  immersivePending = immersivePending.filter((it) => {
    if (it && it.node === node && (!text || it.text === text)) {
      removed = true;
      return false;
    }
    return true;
  });
  return removed;
}

const IMMERSIVE_BLOCK_TAGS = /^(P|LI|H1|H2|H3|H4|H5|H6|ARTICLE|SECTION|BLOCKQUOTE|FIGCAPTION|CAPTION|TD|TH|DD|DT)$/;

function getImmersiveBlockElement(node) {
  try {
    let el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node?.parentElement || node;
    let fallback = null;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.closest?.('.edge-ai-translator-bubble, .edge-ai-translator-banner, .edge-ai-quick-btn, .edge-ai-immersive-indicator, .edge-ai-immersive-block-marker, .edge-ai-immersive-region-overlay')) {
        return null;
      }
      const rect = el.getBoundingClientRect?.();
      if (rect && rect.width > 0 && rect.height > 0 && !fallback) fallback = el;
      const style = window.getComputedStyle(el);
      const display = style.display || '';
      const isBlockLike = IMMERSIVE_BLOCK_TAGS.test(el.tagName) || /^(block|list-item|table-cell|flex|grid)$/i.test(display);
      if (isBlockLike && rect && rect.width > 0 && rect.height > 0) return el;
      el = el.parentElement;
    }
    return fallback;
  } catch {
    return null;
  }
}

function positionImmersiveBlockMarker(block, marker) {
  try {
    const rect = block.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    if (!visible) {
      marker.style.display = 'none';
      return;
    }
    marker.style.display = 'grid';
    marker.style.left = `${Math.max(2, Math.min(window.innerWidth - 18, rect.right - 8))}px`;
    marker.style.top = `${Math.max(2, Math.min(window.innerHeight - 18, rect.top - 8))}px`;
  } catch {
    marker.style.display = 'none';
  }
}

function updateImmersiveBlockMarkers() {
  immersiveMarkerRaf = null;
  if (!immersiveBlockMarkers) return;
  for (const [block, entry] of immersiveBlockMarkers.entries()) {
    if (!entry?.el || !document.body.contains(entry.el) || !document.documentElement.contains(block)) {
      try { entry?.el?.remove(); } catch {}
      immersiveBlockMarkers.delete(block);
      continue;
    }
    positionImmersiveBlockMarker(block, entry.el);
  }
}

function scheduleImmersiveMarkerUpdate() {
  if (immersiveMarkerRaf) return;
  try {
    immersiveMarkerRaf = requestAnimationFrame(updateImmersiveBlockMarkers);
  } catch {
    updateImmersiveBlockMarkers();
  }
}

function showImmersiveTranslatingMarkers(items) {
  const tokens = [];
  if (!Array.isArray(items) || items.length === 0) return tokens;
  if (!immersiveBlockMarkers) immersiveBlockMarkers = new Map();
  for (const item of items) {
    const block = getImmersiveBlockElement(item?.node);
    if (!block) continue;
    let entry = immersiveBlockMarkers.get(block);
    if (!entry) {
      const marker = document.createElement('div');
      marker.className = 'edge-ai-immersive-block-marker';
      marker.setAttribute('aria-hidden', 'true');
      document.body.appendChild(marker);
      entry = { el: marker, count: 0 };
      immersiveBlockMarkers.set(block, entry);
      positionImmersiveBlockMarker(block, marker);
    }
    entry.count++;
    tokens.push(block);
  }
  scheduleImmersiveMarkerUpdate();
  return tokens;
}

function hideImmersiveTranslatingMarkers(tokens) {
  if (!immersiveBlockMarkers || !Array.isArray(tokens)) return;
  for (const block of tokens) {
    const entry = immersiveBlockMarkers.get(block);
    if (!entry) continue;
    entry.count--;
    if (entry.count <= 0) {
      try { entry.el?.remove(); } catch {}
      immersiveBlockMarkers.delete(block);
    }
  }
}

function clearImmersiveTranslatingMarkers() {
  if (immersiveMarkerRaf) {
    try { cancelAnimationFrame(immersiveMarkerRaf); } catch {}
    immersiveMarkerRaf = null;
  }
  if (immersiveBlockMarkers) {
    for (const entry of immersiveBlockMarkers.values()) {
      try { entry?.el?.remove(); } catch {}
    }
  }
  immersiveBlockMarkers = null;
}

function rectsIntersect(a, b) {
  return !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function getTextNodeClientRects(node) {
  const rects = [];
  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of Array.from(range.getClientRects())) {
      if (r.width > 0 && r.height > 0) rects.push(r);
    }
    range.detach?.();
  } catch {}
  return rects;
}

function collectTranslatableTextNodesInViewportRect(viewportRect) {
  const all = collectTranslatableTextNodes(document.body);
  const picked = [];
  for (const item of all) {
    const rects = getTextNodeClientRects(item.node);
    if (rects.some((r) => rectsIntersect(r, viewportRect))) picked.push(item);
  }
  return picked;
}

function normalizeViewportRect(a, b) {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  };
}

function updateImmersiveRegionBox(rect) {
  if (!immersiveRegionBoxEl || !rect) return;
  immersiveRegionBoxEl.style.left = `${rect.left}px`;
  immersiveRegionBoxEl.style.top = `${rect.top}px`;
  immersiveRegionBoxEl.style.width = `${rect.width}px`;
  immersiveRegionBoxEl.style.height = `${rect.height}px`;
}

function stopImmersiveRegionSelection() {
  immersiveRegionActive = false;
  immersiveRegionStart = null;
  if (immersiveRegionKeyHandler) {
    try { document.removeEventListener('keydown', immersiveRegionKeyHandler, true); } catch {}
    immersiveRegionKeyHandler = null;
  }
  try { immersiveRegionOverlayEl?.remove(); } catch {}
  immersiveRegionOverlayEl = null;
  immersiveRegionBoxEl = null;
}

function prioritizeImmersiveRect(viewportRect) {
  if (!immersiveActive || !viewportRect || viewportRect.width < 6 || viewportRect.height < 6) return 0;
  const nodes = collectTranslatableTextNodesInViewportRect(viewportRect);
  const queued = nodes.length > 0 ? immersiveQueueNodes(nodes, { priority: true }) : 0;
  if (queued > 0) {
    setImmersiveIndicator(`沉浸翻译：已优先加入 ${queued} 段`, { autoHideMs: 1800 });
  } else {
    setImmersiveIndicator('沉浸翻译：框选区域无可翻译文本', { autoHideMs: 1800 });
  }
  return queued;
}

function startImmersiveRegionSelection() {
  if (!immersiveActive) {
    setImmersiveIndicator('沉浸翻译：请先开启', { autoHideMs: 1600 });
    return;
  }
  if (immersiveRegionActive) {
    stopImmersiveRegionSelection();
    setImmersiveIndicator('沉浸翻译：开启');
    return;
  }

  stopImmersiveRegionSelection();
  immersiveRegionActive = true;
  immersiveRegionOverlayEl = document.createElement('div');
  immersiveRegionOverlayEl.className = 'edge-ai-immersive-region-overlay';
  immersiveRegionBoxEl = document.createElement('div');
  immersiveRegionBoxEl.className = 'edge-ai-immersive-region-box';
  immersiveRegionOverlayEl.appendChild(immersiveRegionBoxEl);
  document.body.appendChild(immersiveRegionOverlayEl);
  setImmersiveIndicator('沉浸翻译：框选优先区域');

  immersiveRegionKeyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      stopImmersiveRegionSelection();
      setImmersiveIndicator('沉浸翻译：开启');
    }
  };
  try { document.addEventListener('keydown', immersiveRegionKeyHandler, true); } catch {}

  immersiveRegionOverlayEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    immersiveRegionStart = { x: e.clientX, y: e.clientY };
    updateImmersiveRegionBox({ left: e.clientX, top: e.clientY, right: e.clientX, bottom: e.clientY, width: 0, height: 0 });
  });

  immersiveRegionOverlayEl.addEventListener('mousemove', (e) => {
    if (!immersiveRegionStart) return;
    e.preventDefault();
    updateImmersiveRegionBox(normalizeViewportRect(immersiveRegionStart, { x: e.clientX, y: e.clientY }));
  });

  immersiveRegionOverlayEl.addEventListener('mouseup', (e) => {
    if (!immersiveRegionStart) return;
    e.preventDefault();
    const rect = normalizeViewportRect(immersiveRegionStart, { x: e.clientX, y: e.clientY });
    stopImmersiveRegionSelection();
    prioritizeImmersiveRect(rect);
  });
}

try {
  window.addEventListener('scroll', scheduleImmersiveMarkerUpdate, true);
  window.addEventListener('resize', scheduleImmersiveMarkerUpdate, { passive: true });
} catch {}

function immersiveQueueNodes(newNodes, options = {}) {
  if (!immersiveActive) return 0;
  if (!Array.isArray(newNodes) || newNodes.length === 0) return 0;
  if (!immersiveProcessedNodes) immersiveProcessedNodes = new WeakMap();
  if (!immersiveScheduledNodes) immersiveScheduledNodes = new WeakMap();

  const priority = !!options.priority;
  let queued = false;
  let queuedCount = 0;
  for (const it of newNodes) {
    if (!it || !it.node) continue;
    const text = getTextNodeTrimmedText(it.node) || String(it.text ?? '').trim();
    if (!text) continue;

    try {
      if (immersiveProcessedNodes.get(it.node) === text) continue;
      if (immersiveScheduledNodes.get(it.node) === text) {
        if (!priority || !removePendingImmersiveItem(it.node, text)) continue;
      }
    } catch {}

    // Skip likely already-target language segments to reduce cost
    try {
      if (immersiveTargetLang && isTextMostlyTargetLang(text, immersiveTargetLang)) {
        markImmersiveProcessed(it.node, text);
        clearImmersiveScheduled(it.node);
        continue;
      }
    } catch {}

    if (priority) immersivePending.unshift({ node: it.node, text });
    else immersivePending.push({ node: it.node, text });
    try { immersiveScheduledNodes.set(it.node, text); } catch {}
    queued = true;
    queuedCount++;
  }

  if (queued) {
    if (priority) immersivePriorityPending = true;
    scheduleImmersiveFlush(priority ? 0 : immersiveFlushWindowMs);
  }
  return queuedCount;
}

async function immersiveFlush() {
  immersiveFlushTimer = null;
  if (immersiveFlushing) return;
  const batch = immersivePending.splice(0, immersivePending.length);
  if (!immersiveActive || batch.length === 0) return;
  immersiveFlushing = true;
  immersivePriorityPending = false;

  try {
    try {
      await loadConfig();
    } catch {}

    // Keep config-derived params up-to-date
    const behavior = (currentConfig && currentConfig.behavior) || {};
    immersiveMaxBatch = Math.max(5, Math.min(80, Number(behavior.dynamicFlushMaxItems ?? immersiveMaxBatch)));
    immersiveFlushWindowMs = Math.max(100, Math.min(2000, Number(behavior.dynamicFlushWindowMs ?? immersiveFlushWindowMs)));

    const cfgSource = getDefaultSourceLang();
    const tgt = immersiveTargetLang || getTargetLang();
    let srcHint = (cfgSource && cfgSource !== 'auto') ? cfgSource : (immersiveSourceHint || 'auto');
    // 避免页面语言/采样误判为目标语言，触发后台 skipIfSourceEqualsTarget 导致“看起来没翻译”
    if ((cfgSource === 'auto' || !cfgSource) && srcHint !== 'auto' && langEqualsLoose(srcHint, tgt)) {
      srcHint = 'auto';
    }

    // de-duplicate by text within this flush
    const map = new Map();
    const seenNodes = new WeakSet();
    for (const it of batch) {
      if (!it || !it.node) continue;
      try {
        if (seenNodes.has(it.node)) continue;
        seenNodes.add(it.node);
      } catch {}

      const currentText = getTextNodeTrimmedText(it.node);
      if (!currentText) {
        clearImmersiveScheduled(it.node);
        continue;
      }

      try {
        if (getImmersiveProcessedText(it.node) === currentText) {
          clearImmersiveScheduled(it.node);
          continue;
        }
      } catch {}

      try {
        if (immersiveTargetLang && isTextMostlyTargetLang(currentText, immersiveTargetLang)) {
          markImmersiveProcessed(it.node, currentText);
          clearImmersiveScheduled(it.node);
          continue;
        }
      } catch {}

      const key = currentText;
      if (!key) continue;
      const arr = map.get(key);
      const item = { node: it.node, text: key };
      if (arr) arr.push(item);
      else map.set(key, [item]);
    }
    const texts = Array.from(map.keys());
    if (texts.length === 0) return;

    // Translate in chunks
    for (let i = 0; i < texts.length && immersiveActive; i += immersiveMaxBatch) {
      const chunk = texts.slice(i, i + immersiveMaxBatch);
      const chunkItems = chunk.flatMap((txt) => map.get(txt) || []);
      const markerTokens = showImmersiveTranslatingMarkers(chunkItems);
      let outs = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        outs = await requestTranslation(chunk, { sourceLang: srcHint, targetLang: tgt }, immersiveJobId);
      } finally {
        hideImmersiveTranslatingMarkers(markerTokens);
      }
      if (!immersiveActive) return;

      outs.forEach((out, idx) => {
        const txt = chunk[idx];
        const items = map.get(txt) || [];
        for (const item of items) {
          if (!immersiveActive) return;
          if (item && item.node && typeof out === 'string') {
            const latestText = getTextNodeTrimmedText(item.node);
            if (latestText !== txt) {
              clearImmersiveScheduled(item.node);
              if (latestText) immersiveQueueNodes([{ node: item.node, text: latestText }]);
              continue;
            }
            item.node.textContent = out;
            try {
              markImmersiveProcessed(item.node, getTextNodeTrimmedText(item.node) || out);
              clearImmersiveScheduled(item.node);
            } catch {}
          }
        }
      });
    }
    immersiveErrorStreak = 0;
  } catch (e) {
    for (const it of batch) {
      if (it?.node) clearImmersiveScheduled(it.node);
    }
    immersiveErrorStreak++;
    setImmersiveIndicator(`沉浸翻译：翻译失败（${String(e?.message || e)}）`, { autoHideMs: 2500 });
    // 连续错误过多则自动停止，避免持续刷屏
    if (immersiveErrorStreak >= 3) {
      stopImmersiveTranslation('error', e?.message || String(e));
    }
  } finally {
    immersiveFlushing = false;
    if (immersiveActive && immersivePending.length > 0) {
      scheduleImmersiveFlush(immersivePriorityPending ? 0 : immersiveFlushWindowMs);
    }
  }
} 

function handleImmersiveMutations(mutations) {
  if (!immersiveActive) return;
  for (const m of mutations) {
    if (m.type === 'childList') {
      for (const added of m.addedNodes) {
        const nn = collectTranslatableTextNodes(added);
        if (nn && nn.length) immersiveQueueNodes(nn);
      }
      continue;
    }

    if (m.type === 'characterData') {
      const nn = collectTranslatableTextNodes(m.target);
      if (nn && nn.length) immersiveQueueNodes(nn);
      continue;
    }

    if (m.type === 'attributes') {
      const target = m.target;
      if (!target || target === document.body || target === document.documentElement) continue;
      const nn = collectTranslatableTextNodes(target);
      if (nn && nn.length) immersiveQueueNodes(nn);
    }
  }
}

function startImmersiveObserver() {
  try { immersiveObserver?.disconnect(); } catch {}
  immersiveObserver = new MutationObserver(handleImmersiveMutations);
  try {
    immersiveObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
    });
  } catch {}
}

async function startImmersiveTranslation(reason = 'manual') {
  if (immersiveActive || immersiveInitializing) return { ok: true, active: immersiveActive };
  if (!isTopFrame()) return { ok: true, active: false, skipped: 'not_top_frame' };

  immersiveInitializing = true;
  try {
    immersiveActive = true;
    immersiveErrorStreak = 0;
    immersiveProcessedNodes = new WeakMap();
    immersiveScheduledNodes = new WeakMap();
    immersivePending = [];
    immersiveJobId = genJobId();

    await loadConfig();
    immersiveTargetLang = getTargetLang();

    const behavior = (currentConfig && currentConfig.behavior) || {};
    immersiveMaxBatch = Math.max(5, Math.min(80, Number(behavior.dynamicFlushMaxItems ?? 40)));
    immersiveFlushWindowMs = Math.max(100, Math.min(2000, Number(behavior.dynamicFlushWindowMs ?? 300)));
    immersiveInitialBatchSize = Math.max(10, Math.min(80, Number(behavior.pageInitialBatchSize ?? immersiveMaxBatch)));

    setImmersiveIndicator('沉浸翻译：扫描中…');
    startImmersiveObserver();

    // Initial scan
    const nodes = collectTranslatableTextNodes(document.body);
    console.debug('[EdgeAI] Immersive initial nodes=', nodes.length);
    const sample = nodes.slice(0, Math.min(20, nodes.length)).map(n => n.text).filter(Boolean);
    immersiveSourceHint = detectPageSourceLang(sample);

    // Filter out already-target segments early
    const filtered = [];
    for (const it of nodes) {
      if (!it || !it.node) continue;
      try {
        if (immersiveTargetLang && isTextMostlyTargetLang(it.text, immersiveTargetLang)) {
          markImmersiveProcessed(it.node, getTextNodeTrimmedText(it.node) || it.text);
          continue;
        }
      } catch {}
      filtered.push(it);
    }

    // Dedup by text
    const textToItems = new Map();
    const uniqueTexts = [];
    for (const it of filtered) {
      const t = it.text;
      if (!textToItems.has(t)) {
        textToItems.set(t, [it]);
        uniqueTexts.push(t);
      } else {
        textToItems.get(t).push(it);
      }
    }

    const cfgSource = getDefaultSourceLang();
    const tgt = immersiveTargetLang || getTargetLang();
    let srcHint = (cfgSource && cfgSource !== 'auto') ? cfgSource : (immersiveSourceHint || 'auto');
    // 避免页面语言/采样误判为目标语言，触发后台 skipIfSourceEqualsTarget 导致“看起来没翻译”
    if ((cfgSource === 'auto' || !cfgSource) && srcHint !== 'auto' && langEqualsLoose(srcHint, tgt)) {
      srcHint = 'auto';
    }

    console.debug('[EdgeAI] Immersive lang params:', { cfgSource, srcHint, target: tgt, immersiveSourceHint });
    console.debug('[EdgeAI] Immersive unique texts=', uniqueTexts.length);

    if (uniqueTexts.length === 0) {
      setImmersiveIndicator('沉浸翻译：未发现可翻译文本（已开启监听）', { autoHideMs: 2000 });
    }

    // Initial translate in batches
    for (let i = 0; i < uniqueTexts.length && immersiveActive; i += immersiveInitialBatchSize) {
      const chunk = uniqueTexts.slice(i, i + immersiveInitialBatchSize);
      setImmersiveIndicator(`沉浸翻译：翻译中… ${Math.min(i + chunk.length, uniqueTexts.length)}/${uniqueTexts.length}`);
      const chunkItems = chunk.flatMap((txt) => textToItems.get(txt) || []);
      const markerTokens = showImmersiveTranslatingMarkers(chunkItems);
      let outs = [];
      try {
        // eslint-disable-next-line no-await-in-loop
        outs = await requestTranslation(chunk, { sourceLang: srcHint, targetLang: tgt }, immersiveJobId);
      } finally {
        hideImmersiveTranslatingMarkers(markerTokens);
      }
      if (!immersiveActive) return { ok: true, active: false };
      outs.forEach((out, idx) => {
        const txt = chunk[idx];
        const items = textToItems.get(txt) || [];
        for (const item of items) {
          if (!immersiveActive) return;
          if (item && item.node && typeof out === 'string') {
            const latestText = getTextNodeTrimmedText(item.node);
            if (latestText !== txt) {
              if (latestText) immersiveQueueNodes([{ node: item.node, text: latestText }]);
              continue;
            }
            item.node.textContent = out;
            try { markImmersiveProcessed(item.node, getTextNodeTrimmedText(item.node) || out); } catch {}
          }
        }
      });
    }

    setImmersiveIndicator('沉浸翻译：开启');
    return { ok: true, active: true };
  } catch (e) {
    immersiveErrorStreak++;
    const msg = e?.message || String(e);
    stopImmersiveTranslation('error', msg);
    return { ok: false, active: false, error: msg };
  } finally {
    immersiveInitializing = false;
  }
}

function stopImmersiveTranslation(reason = 'manual', detail) {
  if (!immersiveActive && !immersiveInitializing) {
    hideImmersiveIndicator();
    return { ok: true, active: false };
  }
  immersiveActive = false;
  immersiveInitializing = false;
  try { immersiveObserver?.disconnect(); } catch {}
  immersiveObserver = null;
  stopImmersiveRegionSelection();
  clearImmersiveTranslatingMarkers();
  if (immersiveFlushTimer) {
    try { clearTimeout(immersiveFlushTimer); } catch {}
    immersiveFlushTimer = null;
  }
  immersiveFlushing = false;
  immersivePriorityPending = false;
  immersivePending = [];
  immersiveScheduledNodes = null;
  immersiveProcessedNodes = null;
  immersiveSourceHint = null;
  immersiveTargetLang = null;

  // cancel in-flight translation job
  try {
    if (immersiveJobId) chrome.runtime.sendMessage({ type: MSG.CANCEL_TRANSLATION, jobId: immersiveJobId });
  } catch {}
  immersiveJobId = null;

  // keep indicator briefly for user feedback
  if (reason === 'user') {
    setImmersiveIndicator('沉浸翻译：已停止', { autoHideMs: 1200 });
  } else if (reason === 'error') {
    setImmersiveIndicator(`沉浸翻译：错误，已停止（${String(detail || 'unknown')}）`, { autoHideMs: 4500 });
  } else {
    hideImmersiveIndicator();
  }
  return { ok: true, active: false };
}

// ---------- Message wiring ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (!message || typeof message !== 'object') return;

    // Respond to ping from popup to confirm injection
    if (message.type === MSG.PING) {
      sendResponse({ ok: true });
      return; // no async
    }

    if (message.type === MSG.GET_IMMERSIVE_STATUS) {
      sendResponse({ ok: true, active: !!immersiveActive, initializing: !!immersiveInitializing });
      return; // no async
    }

    if (message.type === MSG.START_IMMERSIVE_TRANSLATION) {
      (async () => {
        try {
          const r = await startImmersiveTranslation('message');
          sendResponse({ ok: r?.ok !== false, ...r });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (message.type === MSG.STOP_IMMERSIVE_TRANSLATION) {
      (async () => {
        try {
          const r = stopImmersiveTranslation('user');
          sendResponse({ ok: r?.ok !== false, ...r });
        } catch (e) {
          sendResponse({ ok: false, error: e?.message || String(e) });
        }
      })();
      return true;
    }

    if (message.type === MSG.TRANSLATE_SELECTION) {
      (async () => {
        try { await handleTranslateSelection(message); sendResponse({ ok: true }); }
        catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
      })();
      return true; // async
    } else if (message.type === MSG.TRANSLATE_PAGE) {
      (async () => {
        try { await handleTranslatePage(); sendResponse({ ok: true }); }
        catch (e) { sendResponse({ ok: false, error: e?.message || String(e) }); }
      })();
      return true; // async
    }
  } catch (e) {
    // swallow
  }
});

// Auto-start immersive translation if enabled in config (top frame only)
(async () => {
  try {
    await loadConfig();
    const enabled = !!(currentConfig && currentConfig.behavior && currentConfig.behavior.immersiveEnabled);
    if (enabled) {
      startImmersiveTranslation('auto');
    }
  } catch {
    // ignore
  }
})();
