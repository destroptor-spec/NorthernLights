jest.mock('../services/auth.service', () => ({ verifyToken: jest.fn() }));
jest.mock('../services/auroraAppAuth.service', () => ({ verifyAuroraAppKey: jest.fn() }));
jest.mock('../services/scopedToken.service', () => ({
  verifyScopedToken: jest.fn(),
  verifyOutputCredential: jest.fn(),
  verifyReceiverCredential: jest.fn(),
}));

import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../services/auth.service';
import { verifyOutputCredential, verifyReceiverCredential, verifyScopedToken } from '../services/scopedToken.service';
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

const RECEIVER_CREDENTIAL = {
  userId: 'user-1', username: 'alice', role: 'user', scope: 'receiver',
  sid: 's-1', oid: 'receiver:cast-77', gen: 3, cap: 1_900_000_000, jti: 'j',
};

/**
 * Scoped tokens are narrow capabilities, so the allowlist is per scope. These
 * deny cases ARE the security guarantee — a `receiver` credential is handed to
 * a Cast device that plays one session on its own, so it must reach that
 * session and the few endpoints playing needs, and nothing else.
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
    (verifyReceiverCredential as jest.MockedFunction<typeof verifyReceiverCredential>).mockResolvedValue(
      scope === 'receiver' ? RECEIVER_CREDENTIAL as never : null,
    );
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
      // Its own session (s-1): follow it, report, renew its credential.
      ['receiver', 'GET', '/events'],
      ['receiver', 'GET', '/playback-sessions/s-1'],
      ['receiver', 'POST', '/playback-sessions/s-1/reports'],
      ['receiver', 'POST', '/playback-sessions/s-1/output/renew'],
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
      // It follows its own session but never changes it, claims it or reads others.
      ['receiver', 'GET', '/playback-sessions'],
      ['receiver', 'POST', '/playback-sessions'],
      ['receiver', 'PATCH', '/playback-sessions/s-1'],
      ['receiver', 'DELETE', '/playback-sessions/s-1'],
      ['receiver', 'POST', '/playback-sessions/s-1/output'],
      ['receiver', 'POST', '/playback-sessions/s-1/output/refresh'],
      ['receiver', 'POST', '/playback-sessions/s-1/handoff'],
      ['receiver', 'GET', '/playback-sessions/s-1/reports'],
      ['receiver', 'GET', '/playback-sessions/s-2'],
      ['receiver', 'POST', '/playback-sessions/s-2/reports'],
      ['receiver', 'POST', '/playback-sessions/s-2/output/renew'],
      ['receiver', 'GET', '/playback-sessions/s-1%2Fx'],
      ['receiver', 'POST', '/auth/scoped-token'],
      // Method matters, not just the path.
      ['receiver', 'GET', '/recommendations/next'],
      ['receiver', 'GET', '/playback/reports'],
      // Existing scopes must not have widened.
      ['media', 'POST', '/recommendations/next'],
      ['media', 'GET', '/preferences'],
      ['media', 'GET', '/events'],
      ['sse', 'GET', '/artwork/abc'],
      ['sse', 'POST', '/recommendations/next'],
      // An output credential reports for its own session and does nothing else.
      ['output', 'POST', '/playback/reports'],
      ['output', 'GET', '/playback-sessions/s-1'],
      ['output', 'PATCH', '/playback-sessions/s-1'],
      ['output', 'GET', '/playback-sessions/s-1/reports'],
      ['output', 'POST', '/playback-sessions/s-1/reports/extra'],
      ['output', 'POST', '/playback-sessions/s-1/output'],
      ['output', 'POST', '/playback-sessions/s-1/output/refresh'],
      ['output', 'POST', '/playback-sessions/s-1/output/renew'],
      // Remote control comes from the user's devices, never from an output.
      ['output', 'POST', '/playback-sessions/s-1/commands'],
      ['receiver', 'POST', '/playback-sessions/s-1/commands'],
      ['output', 'GET', '/events'],
      ['output', 'POST', '/auth/scoped-token'],
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
      for (const path of [
        '/tracks/track-1/playback/extra', '/recommendations/next/foo', '/preferences/secret',
        '/playback-sessions/s-1/reports/extra', '/playback-sessions/s-1/output/renew/x',
      ]) {
        expect((await attempt('receiver', 'POST', path)).allowed).toBe(false);
      }
    });
  });
});

/**
 * An output credential proves one grant on one session. The middleware binds
 * it to that session; whether the grant is still current is the report's job.
 */
describe('output credentials', () => {
  beforeEach(() => jest.clearAllMocks());

  const report = async (path: string) => {
    (verifyToken as jest.MockedFunction<typeof verifyToken>).mockResolvedValue({
      userId: 'user-1', username: 'alice', role: 'user', scope: 'output',
    } as never);
    (verifyOutputCredential as jest.MockedFunction<typeof verifyOutputCredential>).mockResolvedValue({
      userId: 'user-1', username: 'alice', role: 'user', scope: 'output', sid: 's-1', oid: 'laptop-5678', gen: 4, jti: 'j',
    } as never);
    const req = { headers: { authorization: 'Bearer output-token' }, method: 'POST', path, query: {}, requestId: 'r1' } as unknown as Request;
    const res = responseMock();
    const next = jest.fn() as unknown as NextFunction;
    await requireApiV1Auth(req, res, next);
    return {
      allowed: (next as jest.Mock).mock.calls.length > 0,
      code: res.json.mock.calls[0]?.[0]?.error?.code,
      principal: (req as Request & { apiV1?: Record<string, unknown> }).apiV1,
    };
  };

  it("reports for its own session, as the grant's device", async () => {
    const { allowed, principal } = await report('/playback-sessions/s-1/reports');
    expect(allowed).toBe(true);
    expect(principal).toMatchObject({ scope: 'output', clientId: 'laptop-5678', outputGrant: { sid: 's-1', oid: 'laptop-5678', gen: 4 } });
  });

  it("is refused on any other session's reports", async () => {
    const { allowed, code } = await report('/playback-sessions/s-2/reports');
    expect(allowed).toBe(false);
    expect(code).toBe('SCOPED_TOKEN_NOT_ALLOWED');
  });

  it('is refused when it does not verify as an output credential', async () => {
    (verifyToken as jest.MockedFunction<typeof verifyToken>).mockResolvedValue({ userId: 'user-1', username: 'alice', role: 'user', scope: 'output' } as never);
    (verifyOutputCredential as jest.MockedFunction<typeof verifyOutputCredential>).mockResolvedValue(null);
    const req = { headers: { authorization: 'Bearer forged' }, method: 'POST', path: '/playback-sessions/s-1/reports', query: {}, requestId: 'r1' } as unknown as Request;
    const res = responseMock();
    const next = jest.fn() as unknown as NextFunction;
    await requireApiV1Auth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

/**
 * A receiver credential proves one grant on one session, like an output
 * credential, and also follows that session's events. Whether the grant is
 * still current is the routes' job.
 */
describe('receiver credentials', () => {
  beforeEach(() => jest.clearAllMocks());

  const call = async (method: string, path: string, options: { query?: Record<string, string>; bearer?: boolean } = {}) => {
    (verifyToken as jest.MockedFunction<typeof verifyToken>).mockResolvedValue({
      userId: 'user-1', username: 'alice', role: 'user', scope: 'receiver',
    } as never);
    const req = {
      headers: options.bearer === false ? {} : { authorization: 'Bearer receiver-token' },
      method, path, query: options.query ?? {}, requestId: 'r1',
    } as unknown as Request;
    const res = responseMock();
    const next = jest.fn() as unknown as NextFunction;
    await requireApiV1Auth(req, res, next);
    return {
      allowed: (next as jest.Mock).mock.calls.length > 0,
      status: res.status.mock.calls[0]?.[0],
      code: res.json.mock.calls[0]?.[0]?.error?.code,
      principal: (req as Request & { apiV1?: Record<string, unknown> }).apiV1,
    };
  };

  it("acts as the receiver's own output, with its grant and renewal cap", async () => {
    (verifyReceiverCredential as jest.MockedFunction<typeof verifyReceiverCredential>).mockResolvedValue(RECEIVER_CREDENTIAL as never);
    const { allowed, principal } = await call('POST', '/playback-sessions/s-1/reports');
    expect(allowed).toBe(true);
    expect(principal).toMatchObject({
      scope: 'receiver',
      clientId: 'receiver:cast-77',
      clientName: 'Aurora Cast receiver',
      outputGrant: { sid: 's-1', oid: 'receiver:cast-77', gen: 3 },
      receiverCap: 1_900_000_000,
    });
  });

  it('refuses an unbound receiver token (once minted by /auth/scoped-token)', async () => {
    (verifyReceiverCredential as jest.MockedFunction<typeof verifyReceiverCredential>).mockResolvedValue(null);
    for (const path of ['/recommendations/next', '/playback/reports']) {
      const { allowed, status, code } = await call('POST', path);
      expect(allowed).toBe(false);
      expect(status).toBe(401);
      expect(code).toBe('INVALID_SCOPED_TOKEN');
    }
  });

  it('opens its event stream with the credential in the query, as its own output', async () => {
    (verifyReceiverCredential as jest.MockedFunction<typeof verifyReceiverCredential>).mockResolvedValue(RECEIVER_CREDENTIAL as never);
    const { allowed, principal } = await call('GET', '/events', { bearer: false, query: { token: 'receiver-token' } });
    expect(allowed).toBe(true);
    expect(principal).toMatchObject({ scope: 'receiver', clientId: 'receiver:cast-77', outputGrant: { sid: 's-1' } });
    expect(verifyScopedToken).not.toHaveBeenCalled();
  });

  it('still takes an sse token in the event query', async () => {
    (verifyReceiverCredential as jest.MockedFunction<typeof verifyReceiverCredential>).mockResolvedValue(null);
    (verifyScopedToken as jest.MockedFunction<typeof verifyScopedToken>).mockResolvedValue({
      userId: 'user-1', username: 'alice', role: 'user', scope: 'sse',
    } as never);
    const { allowed, principal } = await call('GET', '/events', { bearer: false, query: { token: 'sse-token' } });
    expect(allowed).toBe(true);
    expect(principal).toMatchObject({ scope: 'sse' });
    expect(verifyScopedToken).toHaveBeenCalledWith('sse-token', 'sse');
  });

  it('is not accepted in the query anywhere but the event stream', async () => {
    (verifyReceiverCredential as jest.MockedFunction<typeof verifyReceiverCredential>).mockResolvedValue(RECEIVER_CREDENTIAL as never);
    const { allowed, status } = await call('GET', '/playback-sessions/s-1', { bearer: false, query: { token: 'receiver-token' } });
    expect(allowed).toBe(false);
    expect(status).toBe(401);
  });
});
