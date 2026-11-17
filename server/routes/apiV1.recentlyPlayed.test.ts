/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({}));
jest.mock('../services/recentlyPlayed.service', () => ({ getRecentlyPlayedPage: jest.fn() }));
jest.mock('../services/apiV1Dto.service', () => ({
  ...jest.requireActual('../services/apiV1Dto.service'),
  getApiV1TracksByIds: jest.fn(async (_userId: string, ids: string[]) => ids.map((id) => ({ id }))),
}));
import type { Request, Response } from 'express';
import router from './apiV1.routes';
import { getRecentlyPlayedPage } from '../services/recentlyPlayed.service';

const page = getRecentlyPlayedPage as jest.MockedFunction<typeof getRecentlyPlayedPage>;

async function recentlyPlayed(query: Record<string, string>) {
  const layer = router.stack.find((l) => l.route?.path === '/me/recently-played')!;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await layer.route!.stack[0].handle(
    { apiV1: { userId: 'u1' }, requestId: 'r1', query } as unknown as Request,
    res as unknown as Response,
    jest.fn(),
  );
  return { status: res.status.mock.calls[0]?.[0] ?? 200, body: res.json.mock.calls[0][0] };
}

beforeEach(() => page.mockReset());

it('returns a page of tracks newest first, and a cursor that continues after the last one', async () => {
  page.mockResolvedValueOnce([
    { trackId: 't3', playedKey: '2026-11-18 10:00:03.123456+00' },
    { trackId: 't2', playedKey: '2026-11-18 10:00:02.5+00' },
    { trackId: 't1', playedKey: '2026-11-18 10:00:01+00' },
  ]);
  const first = await recentlyPlayed({ limit: '2' });
  expect(page).toHaveBeenCalledWith('u1', { limit: 3, after: null });
  expect(first.body.data.map((track: { id: string }) => track.id)).toEqual(['t3', 't2']);
  expect(first.body.page.nextCursor).toEqual(expect.any(String));

  page.mockResolvedValueOnce([{ trackId: 't1', playedKey: '2026-11-18 10:00:01+00' }]);
  const second = await recentlyPlayed({ limit: '2', cursor: first.body.page.nextCursor });
  // The timestamp at full precision, so no row is skipped or repeated.
  expect(page).toHaveBeenLastCalledWith('u1', { limit: 3, after: { playedAt: '2026-11-18 10:00:02.5+00', trackId: 't2' } });
  expect(second.body.data.map((track: { id: string }) => track.id)).toEqual(['t1']);
  expect(second.body.page.nextCursor).toBeNull();
});

it('turns down a cursor it cannot read', async () => {
  expect((await recentlyPlayed({ cursor: 'not-a-cursor' })).status).toBe(400);
  page.mockRejectedValueOnce(new Error('invalid input syntax for type timestamp with time zone'));
  const bad = Buffer.from(JSON.stringify({ sort: 'yesterday-ish', id: 't1' })).toString('base64url');
  expect((await recentlyPlayed({ cursor: bad })).status).toBe(400);
});
