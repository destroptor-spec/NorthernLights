/** @jest-environment node */
import { EventEmitter } from 'events';
import type { NextFunction, Request, Response } from 'express';
import { createFailureRateLimiter } from './rateLimit';

function request(ip = '203.0.113.7') {
  return { headers: {}, socket: { remoteAddress: ip } } as unknown as Request;
}

/** A response that finishes with `status` once the chain calls next(). */
function response() {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  });
  return res;
}

/** Runs one request through the limiter; the rest of the chain answers `status`. */
function send(limiter: ReturnType<typeof createFailureRateLimiter>, status: number, ip?: string) {
  const res = response();
  let reached = false;
  const next: NextFunction = () => {
    reached = true;
    res.statusCode = status;
    res.emit('finish');
  };
  limiter(request(ip), res as unknown as Response, next);
  return { reached, status: res.statusCode, retryAfter: res.headers['Retry-After'] };
}

let prefix = 0;
const limiter = (max = 3) => createFailureRateLimiter({ keyPrefix: `test-${prefix++}`, windowMs: 60_000, max });

describe('createFailureRateLimiter (#260)', () => {
  it('lets failures through up to the limit, then refuses before the chain runs', () => {
    const limit = limiter(3);
    expect([1, 2, 3].map(() => send(limit, 401).reached)).toEqual([true, true, true]);
    const refused = send(limit, 401);
    expect(refused).toMatchObject({ reached: false, status: 429 });
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
  });

  it('never counts requests that succeed', () => {
    const limit = limiter(3);
    for (let i = 0; i < 50; i += 1) expect(send(limit, 200).reached).toBe(true);
    expect(send(limit, 401).reached).toBe(true);
  });

  it('counts only the failure statuses (403 is a valid credential used wrongly)', () => {
    const limit = limiter(1);
    send(limit, 403);
    send(limit, 404);
    expect(send(limit, 401).reached).toBe(true);
    expect(send(limit, 401).reached).toBe(false);
  });

  it('keeps each client IP apart', () => {
    const limit = limiter(1);
    send(limit, 401, '198.51.100.1');
    expect(send(limit, 401, '198.51.100.1').reached).toBe(false);
    expect(send(limit, 401, '198.51.100.2').reached).toBe(true);
  });

  it('starts over after the window', () => {
    jest.useFakeTimers();
    try {
      const limit = limiter(1);
      send(limit, 401);
      expect(send(limit, 401).reached).toBe(false);
      jest.advanceTimersByTime(60_001);
      expect(send(limit, 401).reached).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
