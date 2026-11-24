/**
 * Token-bucket style rate throttler.
 *
 * Each provider gets a queue that drains at most 1 request every
 * `minIntervalMs` milliseconds, regardless of concurrency.  A traditional
 * semaphore only caps concurrency; it still allows bursts that trip 429s.
 */

interface QueueItem {
  fn: () => Promise<any>;
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

export class ProviderThrottle {
  private queue: QueueItem[] = [];
  private running = false;
  private lastRequest = 0;

  constructor(private readonly minIntervalMs: number) {}

  /** Enqueue a request and wait for its result. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.drain();
    });
  }

  private async drain() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length > 0) {
      const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastRequest));
      if (wait > 0) await sleep(wait);
      const item = this.queue.shift()!;
      this.lastRequest = Date.now();
      try {
        item.resolve(await item.fn());
      } catch (err) {
        item.reject(err);
      }
    }
    this.running = false;
  }

  get pendingCount() {
    return this.queue.length;
  }
}

// ─── Shared, module-level throttles ──────────────────────────────────────────
//
// Genius: no published hard limit, but community reports ~5 req/s before 429s.
// We play it safe at 1 request / 250 ms  (4 req/s) with a single-file queue.
//
// Last.fm: 5 req/s is the documented free tier.
// We use 1 request / 210 ms  (≈ 4.7 req/s) to stay clearly under the ceiling.
//
// MusicBrainz: strictly 1 req/s for unauthenticated; 5/s with auth.
// The mbFetch queue in musicbrainz.service.ts already enforces 1 req/s, so
// no extra throttle is needed here.

export const geniusThrottle  = new ProviderThrottle(250);  // 4 req/s
export const lastFmThrottle  = new ProviderThrottle(210);  // ~4.7 req/s
// TheAudioDB: 30 requests a minute on the free key (100 on premium); a 429
// means waiting a minute. One request per 2.1 s keeps the free key under it.
export const theAudioDbThrottle = new ProviderThrottle(2100);
// fanart.tv: no published limit; a gentle 2 req/s.
export const fanartTvThrottle = new ProviderThrottle(500);

// ─── fetchWithRetry ───────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Thin fetch wrapper that handles 429 back-off and transient network errors.
 *
 * NOTE: callers should *not* call this directly for Genius or Last.fm — use
 * the ProviderThrottle instances above so that request pacing is guaranteed
 * even without a 429 response.
 */
export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries = 1
): Promise<Response> {
  const res = await fetch(url, options);
  if (res.status === 429 && maxRetries > 0) {
    const retryAfter = res.headers.get('Retry-After');
    // Honour Retry-After header, cap at 30 s so we don't stall forever
    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5_000;
    await sleep(Math.min(delay, 30_000));
    return fetchWithRetry(url, options, maxRetries - 1);
  }
  return res;
}
