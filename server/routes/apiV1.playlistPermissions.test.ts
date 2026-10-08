/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({
  getPlaylistByIdForUser: jest.fn(),
  getPlaylistByIdReadable: jest.fn(async () => ({ id: 'p1' })),
  getPlaylistTracks: jest.fn(async () => []),
  updatePlaylistMeta: jest.fn(),
  togglePlaylistPin: jest.fn(),
  togglePlaylistPrivacy: jest.fn(),
  addTracksToPlaylist: jest.fn(),
  setPlaylistShare: jest.fn(async () => ({ isPublic: true, shareToken: 'tok' })),
  deletePlaylist: jest.fn(),
}));
jest.mock('../services/apiV1Events.service', () => ({ publishApiV1Event: jest.fn(), publishApiV1LibraryRevision: jest.fn() }));
jest.mock('../services/apiV1Dto.service', () => ({
  ...jest.requireActual('../services/apiV1Dto.service'),
  mapPlaylistV1: jest.fn(async () => ({ id: 'p1' })),
}));
import type { Request, Response } from 'express';
import router from './apiV1.routes';
import * as db from '../database';

/**
 * Each v1 playlist route must ask the shared rule (shared/playlistPermissions.ts)
 * for the action it actually performs. Before, all of them refused any system
 * or AI-generated playlist, while the web UI offered those actions — so the
 * controls failed as "read-only" once the web client moved onto v1.
 */
type Kind = 'manual' | 'custom' | 'hub' | 'system';
const meta: Record<Kind, Record<string, unknown>> = {
  manual: { id: 'p1', isSystem: false, isLlmGenerated: false, generationSource: 'manual' },
  custom: { id: 'p1', isSystem: false, isLlmGenerated: true, generationSource: 'custom' },
  hub: { id: 'p1', isSystem: false, isLlmGenerated: true, generationSource: 'hub' },
  system: { id: 'p1', isSystem: true, isLlmGenerated: false, generationSource: 'daylist' },
};

const actions = {
  rename: { method: 'patch', path: '/playlists/:id', body: { title: 'New name' }, effect: () => db.updatePlaylistMeta },
  editTracks: { method: 'put', path: '/playlists/:id/tracks', body: { trackIds: ['t1'] }, effect: () => db.addTracksToPlaylist },
  share: { method: 'post', path: '/playlists/:id/share', body: { enabled: true }, effect: () => db.setPlaylistShare },
  pin: { method: 'patch', path: '/playlists/:id/state', body: { pinned: true }, effect: () => db.togglePlaylistPin },
  privacy: { method: 'patch', path: '/playlists/:id/state', body: { private: true }, effect: () => db.togglePlaylistPrivacy },
  delete: { method: 'delete', path: '/playlists/:id', body: undefined, effect: () => db.deletePlaylist },
} as const;
type Action = keyof typeof actions;

// The agreed table.
const allowed: Record<Kind, Action[]> = {
  manual: ['rename', 'editTracks', 'share', 'pin', 'privacy', 'delete'],
  custom: ['rename', 'editTracks', 'share', 'pin', 'privacy', 'delete'],
  hub: ['share', 'pin', 'privacy', 'delete'],
  system: ['pin'],
};

async function call(action: Action) {
  const { method, path, body } = actions[action];
  const layer = router.stack.find((l) => l.route?.path === path && l.route.stack.some((h) => h.method === method))!;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), end: jest.fn() };
  await layer.route!.stack[0].handle(
    { body, params: { id: 'p1' }, apiV1: { userId: 'listener' }, requestId: 'r1' } as unknown as Request,
    res as unknown as Response,
    jest.fn(),
  );
  return res;
}

beforeEach(() => jest.clearAllMocks());

const cases = (Object.keys(meta) as Kind[]).flatMap((kind) =>
  (Object.keys(actions) as Action[]).map((action) => [kind, action, allowed[kind].includes(action)] as const));

test.each(cases)('%s playlist, %s → allowed: %s', async (kind, action, isAllowed) => {
  jest.mocked(db.getPlaylistByIdForUser).mockResolvedValue(meta[kind] as never);
  const res = await call(action);
  if (isAllowed) {
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(actions[action].effect()).toHaveBeenCalled();
  } else {
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'PLAYLIST_READ_ONLY' }) }));
    expect(actions[action].effect()).not.toHaveBeenCalled();
  }
});

test('a state change asking for pin and privacy together needs both', async () => {
  jest.mocked(db.getPlaylistByIdForUser).mockResolvedValue(meta.system as never);
  const layer = router.stack.find((l) => l.route?.path === '/playlists/:id/state')!;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), end: jest.fn() };
  await layer.route!.stack[0].handle(
    { body: { pinned: true, private: true }, params: { id: 'p1' }, apiV1: { userId: 'listener' }, requestId: 'r1' } as unknown as Request,
    res as unknown as Response,
    jest.fn(),
  );
  expect(res.status).toHaveBeenCalledWith(403);
  expect(db.togglePlaylistPin).not.toHaveBeenCalled();
});

test("someone else's playlist is not found, whatever the action", async () => {
  jest.mocked(db.getPlaylistByIdForUser).mockResolvedValue(null);
  for (const action of Object.keys(actions) as Action[]) {
    const res = await call(action);
    expect(res.status).toHaveBeenCalledWith(404);
  }
  for (const action of Object.keys(actions) as Action[]) expect(actions[action].effect()).not.toHaveBeenCalled();
});
