jest.mock('../services/auth.service', () => ({ verifyToken: jest.fn() }));
jest.mock('../services/auroraAppAuth.service', () => ({ verifyAuroraAppKey: jest.fn() }));
jest.mock('../services/scopedToken.service', () => ({ verifyScopedToken: jest.fn() }));

import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../services/auth.service';
import { verifyScopedToken } from '../services/scopedToken.service';
import { requireApiV1Auth, requireApiV1WebSession } from './apiV1Auth';

function responseMock() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

describe('Aurora API v1 authentication boundaries', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects a valid scoped bearer token on web-session endpoints', async () => {
    (verifyToken as jest.MockedFunction<typeof verifyToken>).mockResolvedValue({
      userId: 'user-1', username: 'alice', role: 'user', scope: 'media',
    } as any);
    const req = {
      headers: { authorization: 'Bearer scoped-token' },
      path: '/app-keys',
      query: {},
      requestId: 'request-1',
    } as unknown as Request;
    const res = responseMock();
    const next = jest.fn() as NextFunction;

    await requireApiV1Auth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'SCOPED_TOKEN_NOT_ALLOWED' }),
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('keeps an allowed scoped bearer token scoped after authentication', async () => {
    const scoped = { userId: 'user-1', username: 'alice', role: 'user', scope: 'media' as const };
    (verifyToken as jest.MockedFunction<typeof verifyToken>).mockResolvedValue(scoped as any);
    (verifyScopedToken as jest.MockedFunction<typeof verifyScopedToken>).mockResolvedValue(scoped);
    const req = {
      headers: { authorization: 'Bearer scoped-token' },
      path: '/artwork/cover',
      query: {},
    } as unknown as Request;
    const res = responseMock();
    const next = jest.fn() as NextFunction;

    await requireApiV1Auth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.apiV1).toMatchObject({ authKind: 'scoped', scope: 'media' });

    const webNext = jest.fn();
    requireApiV1WebSession(req, res, webNext);
    expect(res.status).toHaveBeenLastCalledWith(403);
    expect(webNext).not.toHaveBeenCalled();
  });
});

/**
 * Scoped tokens are narrow capabilities, so the allowlist is per scope. These
 * deny cases ARE the security guarantee — the `receiver` scope is handed to a
 * Cast device that keeps its own queue fed with no sender attached, so it must
 * reach exactly four endpoints and nothing else.
 */
describe('scoped token endpoint allowlist', () => {
  beforeEach(() => jest.clearAllMocks());

  const attempt = async (scope: string, method: string, path: string) => {
    (verifyToken as jest.MockedFunction<typeof verifyToken>).mockResolvedValue({
      userId: 'user-1', username: 'alice', role: 'user', scope,
    } as never);
    (verifyScopedToken as jest.MockedFunction<typeof verifyScopedToken>).mockResolvedValue({
      userId: 'user-1', username: 'alice', role: 'user', scope,
    } as never);
    const req = {
      headers: { authorization: 'Bearer scoped-token' },
      method, path, query: {}, requestId: 'r1',
    } as unknown as Request;
    const res = responseMock();
    const next = jest.fn() as unknown as NextFunction;
    await requireApiV1Auth(req, res, next);
    return {
      allowed: (next as jest.Mock).mock.calls.length > 0,
      status: res.status.mock.calls[0]?.[0],
      code: res.json.mock.calls[0]?.[0]?.error?.code,
      principal: (req as Request & { apiV1?: { scope?: string; clientName?: string } }).apiV1,
    };
  };

  describe('allowed', () => {
    it.each([
      ['media', 'GET', '/artwork/abc'],
      ['sse', 'GET', '/events'],
      ['receiver', 'POST', '/recommendations/next'],
      ['receiver', 'POST', '/tracks/track-1/playback'],
      ['receiver', 'POST', '/playback/reports'],
      ['receiver', 'GET', '/preferences'],
    ])('%s may %s %s', async (scope, method, path) => {
      const { allowed, principal } = await attempt(scope, method, path);
      expect(allowed).toBe(true);
      expect(principal?.scope).toBe(scope);
    });

    it('names the receiver principal so logs and audits are readable', async () => {
      const { principal } = await attempt('receiver', 'POST', '/recommendations/next');
      expect(principal?.clientName).toBe('Aurora Cast receiver');
    });
  });

  describe('refused', () => {
    it.each([
      // The receiver must not be able to mutate anything or manage access.
      ['receiver', 'PATCH', '/preferences'],
      ['receiver', 'GET', '/app-keys'],
      ['receiver', 'POST', '/app-keys'],
      ['receiver', 'GET', '/playlists'],
      ['receiver', 'PUT', '/tracks/track-1/loved'],
      ['receiver', 'PUT', '/tracks/track-1/rating'],
      ['receiver', 'GET', '/artwork/abc'],
      ['receiver', 'GET', '/events'],
      // Method matters, not just the path.
      ['receiver', 'GET', '/recommendations/next'],
      ['receiver', 'GET', '/playback/reports'],
      // Existing scopes must not have widened.
      ['media', 'POST', '/recommendations/next'],
      ['media', 'GET', '/preferences'],
      ['media', 'GET', '/events'],
      ['sse', 'GET', '/artwork/abc'],
      ['sse', 'POST', '/recommendations/next'],
      // An unrecognised scope claim is not a free pass.
      ['listener', 'POST', '/recommendations/next'],
      ['', 'POST', '/recommendations/next'],
    ])('%s may not %s %s', async (scope, method, path) => {
      const { allowed, status, code } = await attempt(scope, method, path);
      expect(allowed).toBe(false);
      expect(status).toBe(403);
      expect(code).toBe('SCOPED_TOKEN_NOT_ALLOWED');
    });

    it('does not let a path prefix smuggle a receiver token past the matcher', async () => {
      for (const path of ['/tracks/track-1/playback/extra', '/recommendations/next/foo', '/preferences/secret']) {
        expect((await attempt('receiver', 'POST', path)).allowed).toBe(false);
      }
    });
  });
});
