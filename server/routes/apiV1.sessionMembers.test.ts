/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({}));
jest.mock('../services/sessionMembers.service', () => ({
  ...jest.requireActual('../services/sessionMembers.service'),
  setSessionSharing: jest.fn(),
  listNearbyGigs: jest.fn(),
  joinNearbyGig: jest.fn(),
  createSessionInvite: jest.fn(),
  removeSessionMember: jest.fn(),
  previewSessionInvite: jest.fn(),
  joinSessionByInvite: jest.fn(),
  promptSessionInvite: jest.fn(),
}));
import type { Request, Response } from 'express';
import router from './apiV1.routes';
import {
  createSessionInvite,
  joinSessionByInvite,
  previewSessionInvite,
  promptSessionInvite,
  removeSessionMember,
  SessionInviteNotFoundError,
  SessionNotJoinableError,
  SessionSyncOffError,
  setSessionSharing,
  listNearbyGigs,
  joinNearbyGig,
} from '../services/sessionMembers.service';
import { PlaybackSessionNotFoundError as NotFound } from '../services/playbackSession.service';
import { PlaybackSessionOwnerOnlyError } from '../services/playbackSession.service';

/**
 * The Listen together routes (docs/listen-together.md, 6c): what each one
 * accepts, and how the service's refusals reach a client. The flows
 * themselves are tested against Postgres in sessionMembers.pg.test.ts.
 */
const principal = { userId: 'user-1', username: 'andreas', role: 'user', authKind: 'jwt', clientId: 'laptop-5678', clientName: 'Aurora Web' };
const TOKEN = 'a'.repeat(64);

async function call(method: 'get' | 'post' | 'patch' | 'delete', path: string, body: unknown, params: Record<string, string> = {}) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.stack.some((h) => h.method === method))!;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), end: jest.fn(), setHeader: jest.fn() };
  const req = { apiV1: principal, requestId: 'r1', body, params, headers: {}, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
  for (const handler of layer.route!.stack) await handler.handle(req, res as unknown as Response, jest.fn());
  return { status: res.status.mock.calls.at(-1)?.[0] ?? 200, body: res.json.mock.calls.at(-1)?.[0] };
}

beforeEach(() => jest.clearAllMocks());

it('creates a link with all scopes unless told otherwise, and refuses unknown scopes', async () => {
  (createSessionInvite as jest.Mock).mockResolvedValue({ token: TOKEN, path: `/listen/${TOKEN}`, permissions: ['transport'], createdAt: '2026-10-27T12:00:00.000Z' });
  const created = await call('post', '/playback-sessions/:id/invites', { permissions: ['transport'] }, { id: 's-1' });
  expect(created.status).toBe(201);
  expect(created.body.data.path).toBe(`/listen/${TOKEN}`);
  expect(createSessionInvite).toHaveBeenCalledWith('user-1', 's-1', ['transport']);

  await call('post', '/playback-sessions/:id/invites', {}, { id: 's-1' });
  expect(createSessionInvite).toHaveBeenLastCalledWith('user-1', 's-1', undefined);

  const refused = await call('post', '/playback-sessions/:id/invites', { permissions: ['output'] }, { id: 's-1' });
  expect(refused.status).toBe(400);
});

it("takes who may join, the guests' permissions, or both; never neither", async () => {
  (setSessionSharing as jest.Mock).mockResolvedValue({ id: 's-1' });
  await call('patch', '/playback-sessions/:id/sharing', { visibility: 'discoverable' }, { id: 's-1' });
  expect(setSessionSharing).toHaveBeenLastCalledWith('user-1', 's-1', { visibility: 'discoverable' });
  await call('patch', '/playback-sessions/:id/sharing', { permissions: ['queue', 'transport'] }, { id: 's-1' });
  expect(setSessionSharing).toHaveBeenLastCalledWith('user-1', 's-1', { permissions: ['queue', 'transport'] });
  expect((await call('patch', '/playback-sessions/:id/sharing', {}, { id: 's-1' })).status).toBe(400);
  expect((await call('patch', '/playback-sessions/:id/sharing', { permissions: [] }, { id: 's-1' })).status).toBe(400);
  expect((await call('patch', '/playback-sessions/:id/sharing', { visibility: 'public' }, { id: 's-1' })).status).toBe(400);
});

it('lists gigs nearby by the address of the request, and joins one; anything else is not found', async () => {
  (listNearbyGigs as jest.Mock).mockResolvedValue([]);
  await call('get', '/playback-sessions/nearby', undefined);
  expect(listNearbyGigs).toHaveBeenCalledWith('user-1', '127.0.0.1');
  (joinNearbyGig as jest.Mock).mockRejectedValue(new NotFound());
  const refused = await call('post', '/playback-sessions/:id/join', {}, { id: 's-1' });
  expect([refused.status, refused.body.error.code]).toEqual([404, 'PLAYBACK_SESSION_NOT_FOUND']);
  expect(joinNearbyGig).toHaveBeenCalledWith('user-1', 's-1', '127.0.0.1');
});

it("answers the owner's controls with SESSION_OWNER_ONLY for a guest", async () => {
  (removeSessionMember as jest.Mock).mockRejectedValue(new PlaybackSessionOwnerOnlyError());
  const refused = await call('delete', '/playback-sessions/:id/members/:userId', undefined, { id: 's-1', userId: 'user-2' });
  expect([refused.status, refused.body.error.code]).toEqual([403, 'SESSION_OWNER_ONLY']);
});

it('answers a dead link, a private session and sync off with their own codes', async () => {
  (previewSessionInvite as jest.Mock).mockRejectedValue(new SessionInviteNotFoundError());
  const missing = await call('get', '/session-invites/:token', undefined, { token: TOKEN });
  expect([missing.status, missing.body.error.code]).toEqual([404, 'SESSION_INVITE_NOT_FOUND']);

  (joinSessionByInvite as jest.Mock).mockRejectedValue(new SessionNotJoinableError());
  const closed = await call('post', '/session-invites/:token/join', {}, { token: TOKEN });
  expect([closed.status, closed.body.error.code]).toEqual([409, 'SESSION_NOT_JOINABLE']);

  (joinSessionByInvite as jest.Mock).mockRejectedValue(new SessionSyncOffError());
  const off = await call('post', '/session-invites/:token/join', {}, { token: TOKEN });
  expect([off.status, off.body.error.code]).toEqual([403, 'PLAYBACK_SYNC_DISABLED']);
});

it('prompts between 1 and 20 users', async () => {
  (promptSessionInvite as jest.Mock).mockResolvedValue({ prompted: 1 });
  const userId = '22222222-2222-4222-8222-222222222222';
  const sent = await call('post', '/playback-sessions/:id/invites/:token/prompt', { userIds: [userId] }, { id: 's-1', token: TOKEN });
  expect(sent.body.data).toEqual({ prompted: 1 });
  expect(promptSessionInvite).toHaveBeenCalledWith('user-1', 's-1', TOKEN, [userId]);
  expect((await call('post', '/playback-sessions/:id/invites/:token/prompt', { userIds: [] }, { id: 's-1', token: TOKEN })).status).toBe(400);
});
