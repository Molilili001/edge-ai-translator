// Edge AI Translator - In-memory LRU cache with TTL (MV3-safe, ES module)
//
// Exports:
// - LRUCache: simple Map-based LRU with TTL
// - fnv1a32: small 32-bit hash for strings
// - makeCacheKey: stable key builder for translation results
//
// Notes:
// - Memory-only cache: service worker may be suspended; this is best-effort.
// - TTL is applied per entry; expired entries are lazily evicted on access.
// - Size-based eviction removes the oldest (least-recently-used) entry.

export class LRUCache {
  /**
   * @param {Object} opts
   * @param {number} [opts.size=500] - max entries before evicting LRU
   * @param {number} [opts.ttlMs=43200000] - default TTL in ms (12h)
   * @param {boolean} [opts.enabled=true] - switch to disable cache quickly
   */
  constructor(opts = {}) {
    const { size = 500, ttlMs = 12 * 60 * 60 * 1000, enabled = true } = opts || {};
    this.size = Math.max(1, Number(size) || 500);
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.enabled = !!enabled;
    this.map = new Map(); // key -> { v:any, exp:number }
  }

  _now() {
    return Date.now();
  }

  _isExpired(entry) {
    if (!entry) return true;
    if (!entry.exp || entry.exp <= 0) return false; // 0/<=0 means no expiration
    return this._now() > entry.exp;
  }

  _touch(key, entry) {
    // Move to the end (most recently used)
    try {
      this.map.delete(key);
      this.map.set(key, entry);
    } catch {}
  }

  _evictIfNeeded() {
    try {
      while (this.map.size > this.size) {
        // delete the first (least-recently-used)
        const firstKey = this.map.keys().next().value;
        if (firstKey === undefined) break;
        this.map.delete(firstKey);
      }
    } catch {}
  }

  /**
   * Get an item; if expired, remove it and return undefined.
   */
  get(key) {
    if (!this.enabled) return undefined;
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (this._isExpired(entry)) {
      try { this.map.delete(key); } catch {}
      return undefined;
    }
    this._touch(key, entry);
    return entry.v;
  }

  /**
   * Set an item with optional per-entry TTL (ms). 0/<=0 TTL means no expiration.
   */
  set(key, value, ttlMs) {
    if (!this.enabled) return;
    const ttl = Number(ttlMs ?? this.ttlMs) || 0;
    const exp = ttl > 0 ? (this._now() + ttl) : 0;
    const entry = { v: value, exp };
    try {
      this.map.set(key, entry);
      this._touch(key, entry);
      this._evictIfNeeded();
    } catch {}
  }

  /**
   * Whether an item exists and is not expired.
   */
  has(key) {
    return this.get(key) !== undefined;
  }

  delete(key) {
    try { this.map.delete(key); } catch {}
  }

  clear() {
    try { this.map.clear(); } catch {}
  }

  /**
   * Update cache runtime options on-the-fly.
   */
  updateOptions({ size, ttlMs, enabled } = {}) {
    if (typeof size === 'number' && size > 0) this.size = Math.floor(size);
    if (typeof ttlMs === 'number' && ttlMs >= 0) this.ttlMs = Math.floor(ttlMs);
    if (typeof enabled === 'boolean') this.enabled = enabled;
    this._evictIfNeeded();
  }
}

/**
 * Lightweight 32-bit FNV-1a hash for strings.
 * @param {string} str
 * @returns {string} 8-hex lower-case
 */
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
    h >>>= 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Build a stable cache key for translation results.
 * @param {Object} p
 * @param {string} p.provider
 * @param {string} p.model
 * @param {string} p.sourceLang
 * @param {string} p.targetLang
 * @param {string} p.text
 */
export function makeCacheKey(p = {}) {
  const provider = String(p.provider ?? 'custom').trim().toLowerCase();
  const model = String(p.model ?? '').trim();
  const sourceLang = String(p.sourceLang ?? 'auto').trim();
  const targetLang = String(p.targetLang ?? 'zh-CN').trim();
  const text = String(p.text ?? '');
  const hash = fnv1a32(text);
  return `v1|${provider}|${model}|${sourceLang}|${targetLang}|${hash}`;
}