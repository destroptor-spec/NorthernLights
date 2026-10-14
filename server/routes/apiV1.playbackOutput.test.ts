/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({}));
jest.mock('../services/playbackSession.service', () => ({
  ...jest.requireActual('../services/playbackSession.service'),
  claimPlaybackOutput: jest.fn(),
  getCurrentOutputGrant: jest.fn(),
}));
jest.mock('../services/scopedToken.service', () => ({
  ...jest.requireActual('../services/scopedToken.service'),
  generateOutputCredential: jest.fn(async () => ({ token: 'output-token', expiresAt: '2026-10-13T12:00:00.000Z' })),
  generateEphemeralScopedToken: jest.fn(async () => 'scoped-token'),
}));
import type { Request, Response } from 'express';
import router from './apiV1.routes';
import { playbackOutputClaimResultSchema, playbackOutputCredentialSchema, type PlaybackSession } from '../../shared/api/v1';
import {
  claimPlaybackOutput,
  getCurrentOutputGrant,
  PlaybackOutputGrantReplacedError,
} from '../services/playbackSession.service';
import { generateEphemeralScopedToken, generateOutputCredential } from '../services/scopedToken.service';

const principal = { userId: 'user-1', username: 'andreas', role: 'admin', authKind: 'jwt', clientId: 'laptop-5678', clientName: 'Aurora Web' };

async function call(method: 'post', path: string, body: unknown, params: Record<string, string> = {}) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.stack.some((h) => h.method === method))!;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), end: jest.fn() };
  const req = { apiV1: principal, requestId: 'r1', body, params, headers: {} } as unknown as Request;
  for (const handler of layer.route!.stack) await handler.handle(req, res as unknown as Response, jest.fn());
  return { status: res.status.mock.calls.at(-1)?.[0] ?? 200, body: res.json.mock.calls.at(-1)?.[0] };
}

const session = (output: PlaybackSession['output']): PlaybackSession => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Listening',
  ownerClientId: 'laptop-5678',
  output,
  currentEntryId: null,
  positionMs: 0,
  playbackState: 'paused',
  repeatMode: 'none',
  shuffle: false,
  source: null,
  revision: 4,
  queue: [],
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T11:00:00.000Z',
});
const output = { id: 'laptop-5678', kind: 'browser' as const, name: 'Aurora Web', generation: 2, claimedAt: '2026-10-13T11:00:00.000Z' };

beforeEach(() => jest.clearAllMocks());

it('claims the output for the calling device and returns its grant credential', async () => {
  (claimPlaybackOutput as jest.Mock).mockResolvedValue(session(output));
  const { status, body } = await call('post', '/playback-sessions/:id/output', { kind: 'browser', name: 'Aurora Web' }, { id: 's-1' });
  expect(status).toBe(200);
  expect(claimPlaybackOutput).toHaveBeenCalledWith({
    userId: 'user-1', clientId: 'laptop-5678', sessionId: 's-1', output: { kind: 'browser', name: 'Aurora Web' },
  });
  expect(generateOutputCredential).toHaveBeenCalledWith(principal, {
    sid: '11111111-1111-4111-8111-111111111111', oid: 'laptop-5678', gen: 2,
  });
  expect(playbackOutputClaimResultSchema.safeParse(body.data).success).toBe(true);
  expect(body.data.credential).toMatchObject({ token: 'output-token', outputId: 'laptop-5678', generation: 2 });
});

it('refuses an unknown output kind', async () => {
  const { status } = await call('post', '/playback-sessions/:id/output', { kind: 'cast' }, { id: 's-1' });
  expect(status).toBe(400);
  expect(claimPlaybackOutput).not.toHaveBeenCalled();
});

it('refreshes the credential for the current grant only', async () => {
  (getCurrentOutputGrant as jest.Mock).mockResolvedValueOnce({ sid: 's-1', oid: 'laptop-5678', gen: 2 });
  const fresh = await call('post', '/playback-sessions/:id/output/refresh', { outputId: 'laptop-5678', generation: 2 }, { id: 's-1' });
  expect(fresh.status).toBe(200);
  expect(playbackOutputCredentialSchema.safeParse(fresh.body.data).success).toBe(true);

  (getCurrentOutputGrant as jest.Mock).mockRejectedValueOnce(new PlaybackOutputGrantReplacedError(session({ ...output, id: 'phone-1234', generation: 3 })));
  const stale = await call('post', '/playback-sessions/:id/output/refresh', { outputId: 'laptop-5678', generation: 2 }, { id: 's-1' });
  expect(stale.status).toBe(409);
  expect(stale.body.error.code).toBe('OUTPUT_GRANT_REPLACED');
  expect(stale.body.error.details.current.output.id).toBe('phone-1234');
  expect(generateOutputCredential).toHaveBeenCalledTimes(1);
});

it('never mints an output credential from the generic scoped-token endpoint', async () => {
  const { status } = await call('post', '/auth/scoped-token', { scope: 'output' });
  expect(status).toBe(400);
  expect(generateEphemeralScopedToken).not.toHaveBeenCalled();
  expect(generateOutputCredential).not.toHaveBeenCalled();
});
