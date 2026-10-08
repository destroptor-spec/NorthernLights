/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
class InvalidSearchCursorError extends Error {}
jest.mock('../database', () => ({
  searchLibrary: jest.fn(),
  searchLibraryRanked: jest.fn(),
  InvalidSearchCursorError,
}));
jest.mock('../services/apiV1Dto.service', () => ({
  ...jest.requireActual('../services/apiV1Dto.service'),
  getApiV1TracksByIds: jest.fn(),
}));
import type { Request, Response } from 'express';
import router from './apiV1.routes';
import { searchLibrary, searchLibraryRanked } from '../database';
import { getApiV1TracksByIds, mapTrackV1 } from '../services/apiV1Dto.service';

/**
 * The web client's search moved from /api/library/search to v1, which first
 * needed per-type limits (the dropdown asks for 5 artists, 5 albums, 10
 * tracks) and a ranked, cursor-paginated mode (the full results page).
 */
async function get(path: string, query: Record<string, string>) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.stack.some((h) => h.method === 'get'))!;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await layer.route!.stack[0].handle({ query, apiV1: { userId: 'listener' }, requestId: 'r1' } as unknown as Request, res as unknown as Response, jest.fn());
  return res;
}
const data = (res: { json: jest.Mock }) => res.json.mock.calls[0][0].data;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(searchLibrary).mockResolvedValue({ artists: [], albums: [], tracks: [] } as never);
  jest.mocked(getApiV1TracksByIds).mockImplementation(async (_u, ids) => ids.map((id) => mapTrackV1({ id, title: `Track ${id}`, path: 'secret' })) as never);
});

describe('GET /search', () => {
  it('honours per-type limits for the dropdown', async () => {
    await get('/search', { q: 'tove', artistLimit: '5', albumLimit: '5', trackLimit: '10' });
    expect(searchLibrary).toHaveBeenCalledWith('tove', 'listener', { artistLimit: 5, albumLimit: 5, trackLimit: 10 });
  });

  it('falls back to `limit` for any type not given, and to 50 without either', async () => {
    await get('/search', { q: 'tove', limit: '20', trackLimit: '7' });
    expect(searchLibrary).toHaveBeenLastCalledWith('tove', 'listener', { artistLimit: 20, albumLimit: 20, trackLimit: 7 });
    await get('/search', { q: 'tove' });
    expect(searchLibrary).toHaveBeenLastCalledWith('tove', 'listener', { artistLimit: 50, albumLimit: 50, trackLimit: 50 });
  });

  it('clamps every limit to 1–100 and ignores garbage', async () => {
    await get('/search', { q: 'tove', artistLimit: '0', albumLimit: '5000', trackLimit: 'lots' });
    expect(searchLibrary).toHaveBeenCalledWith('tove', 'listener', { artistLimit: 1, albumLimit: 100, trackLimit: 50 });
  });
});

describe('GET /search/ranked', () => {
  const ranked = (results: unknown[], nextCursor: string | null = null) =>
    jest.mocked(searchLibraryRanked).mockResolvedValue({ results, nextCursor } as never);

  it('returns one ordered list of v1 DTOs and passes the cursor through', async () => {
    ranked([
      { type: 'track', relevance: 90, item: { id: 't1', title: 'Habits', path: 'L3NlY3JldA==' } },
      { type: 'artist', relevance: 80, item: { id: 'a1', name: 'Tove Lo', image_url: 'https://img/a1' } },
      { type: 'album', relevance: 70, item: { id: 'b1', title: 'Queen of the Clouds', artist_name: 'Tove Lo', image_url: 'https://img/b1' } },
    ], 'next-page');
    const res = await get('/search/ranked', { q: 'tove', cursor: 'page-2', limit: '30' });
    expect(searchLibraryRanked).toHaveBeenCalledWith('tove', 'listener', { limit: 30, cursor: 'page-2' });
    const body = data(res);
    expect(body.nextCursor).toBe('next-page');
    expect(body.results.map((r: { type: string; item: { id: string } }) => `${r.type}:${r.item.id}`)).toEqual(['track:t1', 'artist:a1', 'album:b1']);
    expect(body.results[1].item).toMatchObject({ name: 'Tove Lo', imageUrl: 'https://img/a1' });
    expect(body.results[2].item).toMatchObject({ title: 'Queen of the Clouds', artistName: 'Tove Lo', imageUrl: 'https://img/b1' });
  });

  it('never exposes a track path, which the ranking query returns', async () => {
    ranked([{ type: 'track', relevance: 90, item: { id: 't1', title: 'Habits', path: 'L3NlY3JldA==' } }]);
    const res = await get('/search/ranked', { q: 'tove' });
    expect(getApiV1TracksByIds).toHaveBeenCalledWith('listener', ['t1']);
    expect(JSON.stringify(data(res))).not.toContain('L3NlY3JldA==');
    expect(data(res).results[0].item).not.toHaveProperty('path');
  });

  it('drops a track hit the v1 lookup no longer finds', async () => {
    ranked([{ type: 'track', relevance: 90, item: { id: 'gone' } }, { type: 'artist', relevance: 80, item: { id: 'a1', name: 'A' } }]);
    jest.mocked(getApiV1TracksByIds).mockResolvedValue([] as never);
    const res = await get('/search/ranked', { q: 'x' });
    expect(data(res).results.map((r: { type: string }) => r.type)).toEqual(['artist']);
  });

  it('defaults to 30 per page and clamps the limit', async () => {
    ranked([]);
    await get('/search/ranked', { q: 'x' });
    expect(searchLibraryRanked).toHaveBeenLastCalledWith('x', 'listener', { limit: 30, cursor: undefined });
    await get('/search/ranked', { q: 'x', limit: '999' });
    expect(searchLibraryRanked).toHaveBeenLastCalledWith('x', 'listener', { limit: 100, cursor: undefined });
  });

  it('answers a stale cursor with 400 INVALID_CURSOR', async () => {
    jest.mocked(searchLibraryRanked).mockRejectedValue(new InvalidSearchCursorError('bad cursor'));
    const res = await get('/search/ranked', { q: 'x', cursor: 'stale' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_CURSOR' }) }));
  });

  it('returns nothing for an empty query without searching', async () => {
    const res = await get('/search/ranked', { q: '   ' });
    expect(data(res)).toEqual({ results: [], nextCursor: null });
    expect(searchLibraryRanked).not.toHaveBeenCalled();
  });
});
