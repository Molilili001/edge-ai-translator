/**
 * Edge AI Translator - Content Script
 * Handles page translation and selection translation UI.
 */

'use strict';

// Message types must match background
const MSG = {
  TRANSLATE_PAGE: 'TRANSLATE_PAGE',
  TRANSLATE_SELECTION: 'TRANSLATE_SELECTION',
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
// Observer for dynamic content during page translate
let pageObserver = null;
// Track processed text nodes to avoid duplicate translations
let processedNodes = null;
// Current page-translate job id for cancellation
let currentJobId = null;

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
    try {
      await loadConfig();
      const hint = detectLangFromText(srcBox?.textContent || '') || getDefaultSourceLang();
      const target = getTargetLang();
      dstBox.innerHTML = '<span class="edge-ai-loading"></span> 翻译中…';
      const outputs = await requestTranslation([srcBox?.textContent || ''], { sourceLang: hint, targetLang: target });
      dstBox.textContent = outputs[0] || '';
    } catch (e) {
      dstBox.innerHTML = escapeHtml(e?.message || String(e));
    }
  });

  // 拖拽支持：拖动头部可移动窗口
  let dragging = false;
  let offsetX = 0, offsetY = 0;
  header?.addEventListener('mousedown', (ev) => {
    dragging = true;
    const rect = bubbleEl.getBoundingClientRect();
    offsetX = ev.clientX - rect.left;
    offsetY = ev.clientY - rect.top;
    ev.preventDefault();
  });
  window.addEventListener('mousemove', (ev) => {
    if (!dragging || bubbleEl.style.display === 'none') return;
    bubbleEl.style.left = Math.max(4, ev.clientX - offsetX) + 'px';
    bubbleEl.style.top = Math.max(4, ev.clientY - offsetY) + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; });

  return bubbleEl;
}

function showBubbleAt(rect, opts) {
  const el = ensureBubble();
  const srcBox = el.querySelector('.edge-ai-bubble-src');
  const dstBox = el.querySelector('.edge-ai-bubble-dst');

  if (typeof opts === 'string') {
    dstBox.innerHTML = opts;
  } else if (opts && typeof opts === 'object') {
    if (opts.src != null) srcBox.textContent = String(opts.src);
    if (opts.dst != null) dstBox.textContent = String(opts.dst);
    if (opts.dstHtml != null) dstBox.innerHTML = String(opts.dstHtml);
  }

  const padding = 8;
  const x = Math.max(8, (rect?.left ?? (window.innerWidth / 2)));
  const y = Math.max(8, (rect?.bottom ?? (window.innerHeight / 2)) + padding);

  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.display = 'block';
}

function hideBubble() {
  if (!bubbleEl) return;
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
  try {
    await loadConfig();
    const selectionInfo = getSelectionInfo(payload?.selectionText);
    if (!selectionInfo || !selectionInfo.text) {
      showBubbleAt(null, '未检测到选中文本');
      return;
    }

    // Detect sourceLang hint from selection to improve jp->zh translation
    const hint = detectLangFromText(selectionInfo.text) || getDefaultSourceLang();
    const target = getTargetLang();

    showBubbleAt(selectionInfo.rect, { src: selectionInfo.text, dstHtml: '<span class="edge-ai-loading"></span> 翻译中…' });
    const outputs = await requestTranslation([selectionInfo.text], { sourceLang: hint, targetLang: target });
    const translated = outputs[0] || '';
    showBubbleAt(selectionInfo.rect, { dst: translated });
  } catch (e) {
    showBubbleAt(null, `错误：${escapeHtml(e.message || String(e))}`);
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
    const tag = p.tagName;
    if (!isVisible(p)) return NodeFilter.FILTER_REJECT;
    if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
    if (SKIP_TAGS.test(tag)) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  };

  function collectFrom(rootNode) {
    try {
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

// ---------- Message wiring ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (!message || typeof message !== 'object') return;

    // Respond to ping from popup to confirm injection
    if (message.type === MSG.PING) {
      sendResponse({ ok: true });
      return; // no async
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