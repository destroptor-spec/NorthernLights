import type { NextFunction, Request, Response } from 'express';
import { getTrustedClientIp } from './clientIp';

interface RateLimitOptions {
  windowMs: number;
  /** Requests (or, with `count: 'failures'`, failures) a key may have in the window. */
  max: number;
  keyPrefix: string;
  message?: string;
  /** Default: the signed-in user, else the trusted client IP. */
  keyGenerator?: (req: Request) => string;
  /**
   * What counts towards `max`:
   * - 'all' (default): every request.
   * - 'failures': only requests that end in one of `failureStatuses`. Each
   *   still counts while in flight and gives its count back if it doesn't
   *   fail, so a burst sent at once can't all slip past before the first
   *   failure is counted. Lets a limiter sit in front of sign-in (#260): a
   *   client with a working credential is never slowed.
   */
  count?: 'all' | 'failures';
  /** With `count: 'failures'`: the statuses that count as a failure (default: 401). */
  failureStatuses?: number[];
  /** Sends the refusal; default `429 { error: message }`. `Retry-After` is already set. */
  onLimited?: (req: Request, res: Response, retryAfterSeconds: number) => void;
}

type RateLimitEntry = { count: number; resetAt: number };

const buckets = new Map<string, RateLimitEntry>();

function defaultKeyGenerator(req: Request): string {
  return req.user?.userId ? `user:${req.user.userId}` : `ip:${getTrustedClientIp(req)}`;
}

function sweepExpired(now: number) {
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}

export function createRateLimiter(options: RateLimitOptions) {
  const message = options.message || 'Too many requests. Try again later.';
  const keyGenerator = options.keyGenerator || defaultKeyGenerator;
  const countFailuresOnly = options.count === 'failures';
  const failureStatuses = new Set(options.failureStatuses ?? [401]);

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    sweepExpired(now);

    const key = `${options.keyPrefix}:${keyGenerator(req)}`;
    const existing = buckets.get(key);
    const entry: RateLimitEntry = existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + options.windowMs };

    if (entry.count >= options.max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      if (options.onLimited) return options.onLimited(req, res, retryAfter);
      return res.status(429).json({ error: message });
    }

    entry.count += 1;
    buckets.set(key, entry);

    if (countFailuresOnly) {
      let settled = false;
      const settle = (failed: boolean) => {
        if (settled) return;
        settled = true;
        // Only from the window it was counted in; a new window started at 0.
        const current = buckets.get(key);
        if (!failed && current === entry && current.count > 0) current.count -= 1;
      };
      res.on('finish', () => settle(failureStatuses.has(res.statusCode)));
      res.on('close', () => settle(false)); // the client went away first: not a failure
    }

    next();
  };
}
