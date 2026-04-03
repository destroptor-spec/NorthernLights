export class Semaphore {
  private tasks: Array<() => void> = [];
  private count: number;

  constructor(max: number) {
    this.count = max;
  }

  async acquire() {
    if (this.count > 0) {
      this.count--;
      return;
    }
    await new Promise<void>((resolve) => {
      this.tasks.push(resolve);
    });
  }

  release() {
    if (this.tasks.length > 0) {
      const fn = this.tasks.shift();
      if (fn) fn();
    } else {
      this.count++;
    }
  }

  get pendingCount(): number {
    return this.tasks.length;
  }

  get activeCount(): number {
    return 5 - this.count;
  }
}

export class RateLimiter {
  private providerLimits: Map<string, { count: number; resetTime: number }> = new Map();

  async withLimit(provider: string, semaphore: Semaphore, fn: () => Promise<void>): Promise<void> {
    await semaphore.acquire();
    try {
      await fn();
    } finally {
      semaphore.release();
    }
  }

  isRateLimited(provider: string): boolean {
    const limit = this.providerLimits.get(provider);
    if (!limit) return false;
    return Date.now() < limit.resetTime;
  }

  setRateLimit(provider: string, retryAfterSeconds: number) {
    this.providerLimits.set(provider, {
      count: 0,
      resetTime: Date.now() + retryAfterSeconds * 1000,
    });
  }

  clearRateLimit(provider: string) {
    this.providerLimits.delete(provider);
  }
}

export async function fetchWithRetry(
  url: string,
  options?: RequestInit,
  maxRetries = 1
): Promise<Response> {
  const res = await fetch(url, options);
  if (res.status === 429 && maxRetries > 0) {
    const retryAfter = res.headers.get('Retry-After');
    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
    await new Promise((r) => setTimeout(r, Math.min(delay, 5000)));
    return fetchWithRetry(url, options, maxRetries - 1);
  }
  return res;
}
