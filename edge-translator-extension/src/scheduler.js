// Edge AI Translator - Scheduler & Retry Utilities (MV3-friendly, ES module)
// Provides: token bucket rate limiter, concurrency gate, jitter, temporary throttle, and generic retry with backoff.

// Utilities
export const nowMs = () => Date.now();
export const sleep = (ms) => new Promise((res) => setTimeout(res, Math.max(0, ms | 0)));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isArray = (v) => Array.isArray(v);

// Token Bucket rate limiter
class TokenBucket {
  constructor({ rps = 1, burst = 2 } = {}) {
    this.setRate(rps, burst);
    this.tokens = this.capacity;
    this.lastRefill = nowMs();
  }
  setRate(rps = 1, burst = 2) {
    this.rps = Math.max(0.001, rps);
    this.capacity = Math.max(1, Math.floor(burst));
    this.tokens = Math.min(this.tokens ?? this.capacity, this.capacity);
  }
  _refill() {
    const now = nowMs();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = clamp(this.tokens + elapsed * this.rps, 0, this.capacity);
      this.lastRefill = now;
    }
  }
  async take(n = 1) {
    n = Math.max(0.001, n);
    for (;;) {
      this._refill();
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      const deficit = n - this.tokens;
      const waitSec = deficit / this.rps;
      const waitMs = clamp(waitSec * 1000, 10, 2000);
      await sleep(waitMs);
    }
  }
}

export class AbortError extends Error {
  constructor(message = 'Aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

// Backoff helpers
const randBetween = (a, b) => {
  const lo = Math.min(a, b) | 0;
  const hi = Math.max(a, b) | 0;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
};

export function computeBackoffDelay(attempt, baseMs = 800, maxMs = 20000, jitter = true) {
  const expo = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  let d = Math.min(expo, maxMs);
  if (jitter) {
    const jitterPct = randBetween(10, 30); // +/- 10–30%
    const delta = Math.floor((d * jitterPct) / 100);
    d = randBetween(d - delta, d + delta);
  }
  return d;
}

// Default retriable classifier
function extractStatus(e) {
  if (!e) return 0;
  if (typeof e.status === 'number') return e.status;
  const m = (e.message || '').match(/\bHTTP\s+(\d{3})\b/);
  if (m) return Number(m[1]);
  return 0;
}
function isNetworkError(e) {
  return e && (e.name === 'TypeError' || /NetworkError|Failed to fetch|net::ERR/i.test(String(e.message || e)));
}

export async function withRetry(fn, opts = {}) {
  const {
    maxRetries = 5,
    baseDelayMs = 800,
    maxDelayMs = 20000,
    jitter = true,
    retryOn = [429, 500, 502, 503, 504],
    isRetriable,
    onRetry
  } = opts || {};

  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (e) {
      const status = extractStatus(e);
      const retriable = typeof isRetriable === 'function'
        ? !!isRetriable(e, attempt)
        : (isNetworkError(e) || retryOn.includes(status));
      if (!retriable || attempt >= maxRetries) throw e;
      attempt += 1;
      const delay = computeBackoffDelay(attempt, baseDelayMs, maxDelayMs, jitter);
      try { onRetry && onRetry({ attempt, delay, status, error: e }); } catch {}
      await sleep(delay);
    }
  }
}

// Scheduler with rate limit + concurrency + jitter + temporary throttle
export function createScheduler(config = {}) {
  let maxConcurrent = Math.max(1, Number(config.maxConcurrent ?? 2));
  let jitterMs = config.jitterMs;
  let jitterMin = 50, jitterMax = 200;
  if (typeof jitterMs === 'number') { jitterMin = 0; jitterMax = Math.max(0, jitterMs); }
  if (isArray(jitterMs)) {
    jitterMin = Math.max(0, Number(jitterMs[0] ?? 0));
    jitterMax = Math.max(jitterMin, Number(jitterMs[1] ?? jitterMin));
  }

  const limiter = new TokenBucket({ rps: Number(config.rps ?? 1), burst: Number(config.burst ?? 2) });
  let running = 0;
  const q = [];
  let tempThrottleUntil = 0;
  let closed = false;

  function getJitterDelay() {
    if (jitterMax <= 0) return 0;
    return randBetween(jitterMin, jitterMax);
  }

  function updateConfig(next = {}) {
    maxConcurrent = Math.max(1, Number(next.maxConcurrent ?? maxConcurrent));
    const rps = Number(next.rps ?? limiter.rps);
    const burst = Number(next.burst ?? limiter.capacity);
    limiter.setRate(rps, burst);
    const jm = next.jitterMs;
    if (typeof jm === 'number') { jitterMin = 0; jitterMax = Math.max(0, jm); }
    else if (isArray(jm)) {
      jitterMin = Math.max(0, Number(jm[0] ?? jitterMin));
      jitterMax = Math.max(jitterMin, Number(jm[1] ?? jitterMax));
    }
  }

  function throttleTemporarily(ms = 60000) {
    tempThrottleUntil = nowMs() + Math.max(0, ms | 0);
  }

  function stats() {
    return { running, queued: q.length, rps: limiter.rps, burst: limiter.capacity };
  }

  function close() {
    closed = true;
    while (q.length) {
      const item = q.shift();
      item.reject(new Error('Scheduler closed'));
    }
  }

  async function runOne(item) {
    running += 1;
    try {
      const now = nowMs();
      if (tempThrottleUntil > now) {
        const wait = clamp(tempThrottleUntil - now, 50, 2000);
        await sleep(wait);
      }
      const jitter = getJitterDelay();
      if (jitter) await sleep(jitter);
      if (item.signal?.aborted) throw new AbortError();
      await limiter.take(1);
      const result = await item.task();
      item.resolve(result);
    } catch (e) {
      item.reject(e);
    } finally {
      running -= 1;
      pump();
    }
  }

  function pump() {
    if (closed) return;
    while (running < maxConcurrent && q.length) {
      const item = q.shift();
      runOne(item);
    }
  }

  function enqueue(task, opts = {}) {
    if (closed) return Promise.reject(new Error('Scheduler closed'));
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, signal: opts.signal };
      q.push(item);
      pump();
    });
  }

  return { enqueue, updateConfig, throttleTemporarily, stats, close };
}

// Convenience: wrap fetch with retry and optional scheduler
export async function scheduledFetch(scheduler, doFetch, retryOpts = {}, on429ThrottleMs = 60000) {
  return withRetry(async (attempt) => {
    const res = await scheduler.enqueue(doFetch);
    return res;
  }, {
    ...retryOpts,
    onRetry: (info) => {
      // Try temporary throttle on 429/5xx
      const st = info?.status || 0;
      if (st === 429 || (st >= 500 && st <= 504)) {
        try { scheduler.throttleTemporarily(on429ThrottleMs); } catch {}
      }
    }
  });
}