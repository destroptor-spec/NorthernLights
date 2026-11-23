import type { NextFunction, Request, Response } from 'express';
import { getTrustedClientIp } from './clientIp';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix: string;
  message?: string;
  keyGenerator?: (req: Request) => string;
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

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    sweepExpired(now);

    const key = `${options.keyPrefix}:${keyGenerator(req)}`;
    const existing = buckets.get(key);
    const nextEntry: RateLimitEntry = existing && existing.resetAt > now
      ? { count: existing.count + 1, resetAt: existing.resetAt }
      : { count: 1, resetAt: now + options.windowMs };

    buckets.set(key, nextEntry);

    if (nextEntry.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((nextEntry.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message });
    }

    next();
  };
}


interface FailureRateLimitOptions {
  windowMs: number;
  /** Failures a key may have in the window before its requests are refused. */
  max: number;
  keyPrefix: string;
  /** Response statuses that count as a failure (default: 401). */
  failureStatuses?: number[];
  /** Default: the trusted client IP; a failure limiter runs before sign-in, so there is no user yet. */
  keyGenerator?: (req: Request) => string;
  /** Sends the refusal; default `429 { error }`, as createRateLimiter. */
  onLimited?: (req: Request, res: Response, retryAfterSeconds: number) => void;
}

/**
 * Counts only failed requests, and refuses a key once it has `max` failures
 * (and requests still in flight) in the window, before the rest of the chain
 * runs. Successful requests give their count back, so it can sit in front of sign-in: a client with a working
 * credential is never slowed, while one sending bad credentials is stopped
 * before each attempt costs a lookup (#260).
 */
export function createFailureRateLimiter(options: FailureRateLimitOptions) {
  const failureStatuses = new Set(options.failureStatuses ?? [401]);
  const keyGenerator = options.keyGenerator || ((req: Request) => `ip:${getTrustedClientIp(req)}`);

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    sweepExpired(now);
    const key = `${options.keyPrefix}:${keyGenerator(req)}`;
    const existing = buckets.get(key);
    if (existing && existing.resetAt > now && existing.count >= options.max) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      if (options.onLimited) return options.onLimited(req, res, retryAfter);
      return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    }

    // Counted on arrival, so requests still being checked count too: sign-in
    // is async (an app key waits on the database), and a burst sent at once
    // would otherwise all pass before the first failure was counted. A
    // request that turns out not to fail gives its count back.
    const entry: RateLimitEntry = existing && existing.resetAt > now
      ? { count: existing.count + 1, resetAt: existing.resetAt }
      : { count: 1, resetAt: now + options.windowMs };
    buckets.set(key, entry);
    let settled = false;
    const settle = (failed: boolean) => {
      if (settled) return;
      settled = true;
      const current = buckets.get(key);
      // Only from the window it was counted in; a new window started at 0.
      if (!failed && current && current.resetAt === entry.resetAt && current.count > 0) {
        current.count -= 1;
      }
    };
    res.on('finish', () => settle(failureStatuses.has(res.statusCode)));
    res.on('close', () => settle(false)); // the client went away first: not a failure
    next();
  };
}
