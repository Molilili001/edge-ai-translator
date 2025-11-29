export function composePrompt({ sourceLang = 'auto', targetLang = 'zh-CN', workflow = {}, batch = false } = {}) {
  const {
    promptTemplate,
    style = '简洁准确，保留格式与占位符',
    tone = '中性',
    glossary = [],
    protectPlaceholders = true,
    responseFormat = 'auto'
  } = workflow || {};

  const glossaryText = Array.isArray(glossary) && glossary.length ? formatGlossary(glossary) : '';
  const protectText = protectPlaceholders
    ? '严格保持占位符与标记不变，例如：{{...}}、{0}、%s、:variable、&nbsp;、HTML/XML 标签（如 <b>...</b>）、Markdown 语法与链接、内联公式或代码片段。'
    : '';

  // 当 batch 模式或需要 JSON 返回时，要求严格 JSON 数组输出
  const wantJsonArray = batch || String(responseFormat).toLowerCase() === 'json';
  const jsonConstraint = wantJsonArray
    ? '必须严格输出一个 JSON 数组，长度与输入数组一致，每一项仅为“译文字符串”。不得包含多余文本、注释或解释。'
    : '仅输出译文文本，不要添加多余解释。';

  // 若用户提供自定义模板则优先
  if (typeof promptTemplate === 'string' && promptTemplate.trim()) {
    return promptTemplate
      .replace(/\{\{\s*sourceLang\s*\}\}/g, String(sourceLang))
      .replace(/\{\{\s*targetLang\s*\}\}/g, String(targetLang))
      .replace(/\{\{\s*style\s*\}\}/g, style)
      .replace(/\{\{\s*tone\s*\}\}/g, tone)
      .replace(/\{\{\s*glossary\s*\}\}/g, glossaryText)
      .replace(/\{\{\s*protectPlaceholders\s*\}\}/g, protectPlaceholders ? 'true' : 'false')
      .replace(/\{\{\s*jsonConstraint\s*\}\}/g, jsonConstraint);
  }

  // 默认系统指令
  return [
    `你是专业的翻译引擎。将文本从 ${sourceLang} 翻译为 ${targetLang}。`,
    `要求：${style}，语气：${tone}。`,
    glossaryText ? `术语表（严格遵守）：\n${glossaryText}` : '',
    protectText,
    jsonConstraint,
    '保留原有的换行、空白、标点与内联结构。'
  ].filter(Boolean).join('\n');
}

// 简易 token 估算：CJK≈1/字；其他≈1/4 字符
export function estimateTokens(s = '') {
  const str = String(s || '');
  let cjk = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    if (
      (ch >= 0x4E00 && ch <= 0x9FFF) || // CJK
      (ch >= 0x3040 && ch <= 0x30FF) || // 日文假名
      (ch >= 0xAC00 && ch <= 0xD7AF)    // 韩文
    ) cjk++;
  }
  const nonCjk = Math.max(0, str.length - cjk);
  return cjk + Math.ceil(nonCjk / 4);
}

export function estimateBatchTokens(inputs = []) {
  const base = 30; // prompt 与结构开销的保守常数
  return inputs.reduce((sum, t) => sum + estimateTokens(t), base);
}

/**
 * 根据预算切分输入，避免单批过大
 * @param {string[]} inputs
 * @param {object} opts
 * @param {number} opts.maxItems
 * @param {number} opts.maxChars
 * @param {number} opts.tokenBudget
 * @returns {string[][]}
 */
export function splitInputsByBudget(inputs = [], { maxItems = 20, maxChars = 8000, tokenBudget = 2000 } = {}) {
  const out = [];
  let cur = [];
  let curChars = 0;
  let curTokens = 0;

  function flush() {
    if (cur.length) out.push(cur);
    cur = []; curChars = 0; curTokens = 0;
  }

  for (const t of inputs) {
    const txt = String(t ?? '');
    const tChars = txt.length;
    const tTokens = estimateTokens(txt);

    const wouldItems = cur.length + 1;
    const wouldChars = curChars + tChars;
    const wouldTokens = curTokens + tTokens;

    if (
      cur.length > 0 && (
        wouldItems > maxItems ||
        wouldChars > maxChars ||
        wouldTokens > tokenBudget
      )
    ) {
      flush();
    }
    cur.push(txt);
    curChars += tChars;
    curTokens += tTokens;

    if (cur.length >= maxItems || curChars >= maxChars || curTokens >= tokenBudget) {
      flush();
    }
  }
  flush();
  return out;
}

/**
 * 判断是否跳过翻译：过短或几乎全是符号
 */
export function isSkippableSegment(text, minLen = 2) {
  const s = String(text || '').trim();
  if (s.length < Math.max(0, minLen | 0)) return true;
  // 如果字母数字/CJK比例很低，则视为符号噪声
  const letters = (s.match(/[A-Za-z0-9\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
  return letters <= 0;
}

/**
 * 将术语表数组格式化为易读且稳定的指令文本
 * glossary: [{ src: 'Neural Network', dst: '神经网络' }]
 */
export function formatGlossary(glossary = []) {
  if (!Array.isArray(glossary) || !glossary.length) return '';
  const lines = [];
  for (const g of glossary) {
    const src = String(g?.src ?? '').trim();
    const dst = String(g?.dst ?? '').trim();
    if (!src || !dst) continue;
    lines.push(`- ${src} → ${dst}`);
  }
  return lines.join('\n');
}