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

export function createRateLimiter(options: RateLimitOptions) {
  const message = options.message || 'Too many requests. Try again later.';
  const keyGenerator = options.keyGenerator || defaultKeyGenerator;

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();

    for (const [key, entry] of buckets) {
      if (entry.resetAt <= now) buckets.delete(key);
    }

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

