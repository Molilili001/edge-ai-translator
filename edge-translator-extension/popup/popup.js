/* Edge AI Translator - Popup quick settings (robust injection) */
const MSG = {
  TRANSLATE_PAGE: 'TRANSLATE_PAGE',
  TRANSLATE_SELECTION: 'TRANSLATE_SELECTION',
  START_IMMERSIVE_TRANSLATION: 'START_IMMERSIVE_TRANSLATION',
  STOP_IMMERSIVE_TRANSLATION: 'STOP_IMMERSIVE_TRANSLATION',
  GET_IMMERSIVE_STATUS: 'GET_IMMERSIVE_STATUS',
  LOAD_CONFIG: 'LOAD_CONFIG',
  SAVE_CONFIG: 'SAVE_CONFIG'
};

function $(id) { return document.getElementById(id); }
function setStatus(msg, ok = true) {
  const el = $('status'); if (!el) return;
  el.textContent = msg || '';
  el.style.color = ok ? 'var(--muted)' : 'var(--danger)';
}

async function loadConfig() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: MSG.LOAD_CONFIG });
    if (!resp?.ok) throw new Error(resp?.error || '加载配置失败');
    const cfg = resp.config || {};
    $('sourceLang').value = (cfg?.workflow?.sourceLang || 'auto');
    $('targetLang').value = (cfg?.workflow?.targetLang || 'zh-CN');
    $('providerType').value = (cfg?.provider?.type || 'custom');
    setStatus('配置已加载');
  } catch (e) {
    setStatus(e.message || String(e), false);
  }
}

async function saveConfig() {
  try {
    const cfg = {
      provider: { type: $('providerType').value || 'custom' },
      workflow: {
        sourceLang: $('sourceLang').value || 'auto',
        targetLang: $('targetLang').value || 'zh-CN'
      }
    };
    const resp = await chrome.runtime.sendMessage({ type: MSG.SAVE_CONFIG, config: cfg });
    if (!resp?.ok) throw new Error(resp?.error || '保存失败');
    setStatus('已保存');
  } catch (e) {
    setStatus(e.message || String(e), false);
  }
}

async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  } catch (e) {
    console.warn('[Popup] tabs.query failed:', e);
    return null;
  }
}

function canInject(url) {
  if (!url) return false;
  // 允许 http/https/file/about:blank；拒绝 chrome://、edge://、微软商店等受限页面
  if (/^https?:/i.test(url)) return true;
  if (/^file:/i.test(url)) return true;
  if (/^about:blank$/i.test(url)) return true;
  return false;
}

let immersiveActive = false;

function setImmersiveButtonState(active, initializing = false) {
  immersiveActive = !!active;
  const btn = $('toggleImmersiveBtn');
  if (!btn) return;
  if (initializing) {
    btn.textContent = '沉浸翻译启动中…';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  btn.textContent = immersiveActive ? '关闭沉浸翻译' : '开启沉浸翻译';
}

async function pingContent(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: '__PING__' });
    return !!resp;
  } catch {
    return false;
  }
}

async function ensureInjected(tab) {
  if (!tab?.id) throw new Error('未找到活动标签页');
  if (!canInject(tab.url || '')) throw new Error('当前页面不允许注入（如系统页或扩展商店），请在普通网页上使用');

  const injected = await pingContent(tab.id);
  if (injected) return; // 已存在内容脚本

  // 注入内容脚本与样式（MV3）
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['src/content.js']
    });
    try {
      await chrome.scripting.insertCSS({
        target: { tabId: tab.id, allFrames: true },
        files: ['src/overlay.css']
      });
    } catch (cssErr) {
      console.warn('[Popup] insertCSS failed:', cssErr);
    }
    // 等待内容脚本初始化
    await new Promise((r) => setTimeout(r, 200));
  } catch (e) {
    console.error('[Popup] executeScript failed:', e);
    throw new Error('注入内容脚本失败，请刷新页面后重试');
  }
}

async function triggerTranslatePage() {
  const tab = await getActiveTab();
  try {
    await ensureInjected(tab);
    await chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_PAGE });
    setStatus('已触发整页翻译');
  } catch (e) {
    setStatus(e.message || '整页翻译触发失败', false);
  }
}

async function triggerTranslateSelection() {
  const tab = await getActiveTab();
  try {
    await ensureInjected(tab);
    await chrome.tabs.sendMessage(tab.id, { type: MSG.TRANSLATE_SELECTION });
    setStatus('已触发划词翻译（请先选中文本）');
  } catch (e) {
    setStatus(e.message || '划词翻译触发失败', false);
  }
}

async function getImmersiveStatus(tab) {
  if (!tab?.id) return { ok: false };
  try {
    // Target top frame to avoid iframe responses
    const resp = await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_IMMERSIVE_STATUS }, { frameId: 0 });
    if (resp?.ok) return resp;
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

async function refreshImmersiveStatus() {
  const tab = await getActiveTab();
  try {
    await ensureInjected(tab);
    const resp = await getImmersiveStatus(tab);
    if (!resp?.ok) {
      setImmersiveButtonState(false, false);
      return;
    }
    setImmersiveButtonState(!!resp.active, !!resp.initializing);
  } catch (e) {
    setImmersiveButtonState(false, false);
    // do not spam errors here
  }
}

async function toggleImmersive() {
  const tab = await getActiveTab();
  try {
    await ensureInjected(tab);
    const status = await getImmersiveStatus(tab);
    const active = !!status?.active;
    if (status?.initializing) {
      setStatus('沉浸翻译正在启动中…', true);
      return;
    }
    setImmersiveButtonState(active, true);
    if (active) {
      await chrome.tabs.sendMessage(tab.id, { type: MSG.STOP_IMMERSIVE_TRANSLATION }, { frameId: 0 });
      setStatus('已停止沉浸式翻译');
    } else {
      await chrome.tabs.sendMessage(tab.id, { type: MSG.START_IMMERSIVE_TRANSLATION }, { frameId: 0 });
      setStatus('已开启沉浸式翻译（将持续翻译新增内容）');
    }
  } catch (e) {
    setStatus(e.message || '沉浸翻译切换失败', false);
  } finally {
    await refreshImmersiveStatus();
  }
}

function openOptions() {
  try {
    chrome.runtime.openOptionsPage();
    setStatus('已打开完整选项页');
  } catch (e) {
    setStatus('打开选项页失败', false);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('translatePageBtn')?.addEventListener('click', triggerTranslatePage);
  $('translateSelBtn')?.addEventListener('click', triggerTranslateSelection);
  $('toggleImmersiveBtn')?.addEventListener('click', toggleImmersive);
  $('saveBtn')?.addEventListener('click', saveConfig);
  $('openOptionsBtn')?.addEventListener('click', openOptions);
  loadConfig();
  refreshImmersiveStatus();
});