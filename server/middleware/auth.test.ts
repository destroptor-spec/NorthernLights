jest.mock('../services/auth.service', () => ({ verifyToken: jest.fn() }));
jest.mock('../database', () => ({ hasUsers: jest.fn(async () => true) }));

import type { Request, Response, NextFunction } from 'express';
import { requireAuth, requireAdmin } from './auth';
import { verifyToken } from '../services/auth.service';

const verifyTokenMock = verifyToken as jest.MockedFunction<typeof verifyToken>;

const run = async (path: string, payload: Record<string, unknown> | null) => {
  verifyTokenMock.mockResolvedValue(payload as never);
  const req = { path, headers: { authorization: 'Bearer t' }, query: {} } as unknown as Request;
  const json = jest.fn();
  const res = { status: jest.fn(() => ({ json })) } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  await requireAuth(req, res, next);
  const status = (res.status as jest.Mock).mock.calls[0]?.[0];
  return { allowed: (next as jest.Mock).mock.calls.length > 0, status, req };
};

const session = { userId: 'u1', username: 'a', role: 'user' };
const media = { ...session, scope: 'media' };
const sse = { ...session, scope: 'sse' };

/**
 * A scoped token is a transport capability, not a session. `verifyToken` is
 * scope-blind by design — it validates full sessions too — and scoped tokens
 * are signed with the same secret, so without an explicit check a `media`
 * token satisfied every authenticated route. Those tokens travel in every
 * stream and artwork URL and live 30 days with "remember me".
 */
describe('requireAuth scope enforcement', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('full sessions are unaffected', () => {
    it.each([
      '/api/stream/abc/playlist.m3u8', '/api/art', '/api/cast/log',
      '/api/recommend', '/api/settings', '/api/library/scan/status',
    ])('a session token is accepted on %s', async (path) => {
      const { allowed } = await run(path, session);
      expect(allowed).toBe(true);
    });
  });

  describe('scoped tokens keep working on the transports they were minted for', () => {
    it.each([
      ['/api/stream/abc/playlist.m3u8', media],
      ['/api/stream/abc/segment000.ts', media],
      ['/api/art', media],
      ['/api/cast/log', media],
      ['/api/library/scan/status', sse],
      ['/api/admin/mbdb/status', sse],
      ['/api/settings/models/progress', sse],
    ])('%s accepts its own scope', async (path, payload) => {
      const { allowed } = await run(path, payload);
      expect(allowed).toBe(true);
    });
  });

  // The guarantee. Each of these was previously allowed.
  describe('scoped tokens are refused everywhere else', () => {
    it.each([
      '/api/recommend', '/api/settings', '/api/playlists', '/api/library/scan',
      '/api/admin/users', '/api/auth/me', '/api/playback/record',
    ])('a media token is refused on %s', async (path) => {
      const { allowed, status } = await run(path, media);
      expect(allowed).toBe(false);
      expect(status).toBe(403);
    });

    it('refuses a media token on an sse endpoint and vice versa', async () => {
      expect((await run('/api/library/scan/status', media)).allowed).toBe(false);
      expect((await run('/api/art', sse)).allowed).toBe(false);
    });

    it('refuses an unknown scope even on a mapped path', async () => {
      const { allowed } = await run('/api/art', { ...session, scope: 'something-else' });
      expect(allowed).toBe(false);
    });
  });

  it('still rejects an unverifiable token as 401', async () => {
    const { allowed, status } = await run('/api/settings', null);
    expect(allowed).toBe(false);
    expect(status).toBe(401);
  });

  // requireAdmin only inspects role, so a scoped admin token used to reach
  // admin routes. It is requireAuth that has to stop it.
  it('closes the admin path for a scoped token belonging to an admin', async () => {
    const adminMedia = { userId: 'u1', username: 'a', role: 'admin', scope: 'media' };
    const { allowed, req } = await run('/api/admin/users', adminMedia);
    expect(allowed).toBe(false);
    expect(req.user).toBeUndefined();

    // Demonstrates why: requireAdmin would have let it through.
    const adminReq = { user: adminMedia } as unknown as Request;
    const adminNext = jest.fn() as unknown as NextFunction;
    requireAdmin(adminReq, { status: jest.fn(() => ({ json: jest.fn() })) } as unknown as Response, adminNext);
    expect((adminNext as jest.Mock).mock.calls.length).toBe(1);
  });
});
