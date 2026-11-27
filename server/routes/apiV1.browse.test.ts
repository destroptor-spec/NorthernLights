/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({
  initDB: jest.fn(async () => ({})),
  getAlbumCardsByIds: jest.fn(async (ids: string[]) => ids.map(id => ({ id, title: `Album ${id}`, artist_name: 'Someone', track_count: 10 }))),
  getArtistCardsByIds: jest.fn(async (ids: string[]) => ids.map(id => ({ id, name: `Artist ${id}` }))),
  getAlbumById: jest.fn(),
  getArtistById: jest.fn(),
}));
jest.mock('../services/browse.service', () => ({
  ...jest.requireActual('../services/browse.service'),
  listBrowseTrackIds: jest.fn(),
  pickBrowseMix: jest.fn(),
  listBrowseAlbumRows: jest.fn(),
  getBrowseGenre: jest.fn(),
  getAlbumStyleProfile: jest.fn(async () => ({ entries: [] })),
}));
jest.mock('../services/trackRays.service', () => ({ getTrackRays: jest.fn() }));
jest.mock('../services/soundMap.service', () => ({ getSoundMapView: jest.fn() }));
jest.mock('../services/apiV1Dto.service', () => ({
  ...jest.requireActual('../services/apiV1Dto.service'),
  getApiV1TracksByIds: jest.fn(),
  getApiV1TrackById: jest.fn(async (_u: string, id: string) => jest.requireActual('../services/apiV1Dto.service').mapTrackV1({ id, title: id, path: 'secret' })),
}));
import type { Request, Response } from 'express';
import router from './apiV1.routes';
import { getAlbumById } from '../database';
import { getBrowseGenre, listBrowseAlbumRows, listBrowseTrackIds, pickBrowseMix } from '../services/browse.service';
import { getApiV1TracksByIds, mapTrackV1 } from '../services/apiV1Dto.service';
import { getTrackRays } from '../services/trackRays.service';
import { getSoundMapView } from '../services/soundMap.service';

async function get(path: string, query: Record<string, string> = {}, params: Record<string, string> = {}) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.stack.some(h => h.method === 'get'))!;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await layer.route!.stack[0].handle(
    { query, params, apiV1: { userId: 'listener' }, requestId: 'r1' } as unknown as Request, res as unknown as Response, jest.fn());
  return res;
}
const body = (res: { json: jest.Mock }) => res.json.mock.calls[0][0];

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getApiV1TracksByIds).mockImplementation(async (_u, ids) => ids.map(id => mapTrackV1({ id, title: id, path: 'secret' })) as never);
});

describe('GET /browse/tracks', () => {
  it('passes the filter through and pages with an offset cursor, keeping the ranking order', async () => {
    jest.mocked(listBrowseTrackIds).mockResolvedValue({ ids: ['t2', 't1'], hasMore: true });
    const first = await get('/browse/tracks', { genre: 'Rock', noStyle: 'true', decade: '1990', limit: '2' });
    expect(listBrowseTrackIds).toHaveBeenCalledWith({}, expect.objectContaining({ genre: 'Rock', noStyle: true, decade: 1990, unsorted: false }), 0, 2);
    expect(body(first).data.map((t: { id: string }) => t.id)).toEqual(['t2', 't1']);
    expect(JSON.stringify(body(first))).not.toContain('secret');

    jest.mocked(listBrowseTrackIds).mockResolvedValue({ ids: ['t3'], hasMore: false });
    const second = await get('/browse/tracks', { genre: 'Rock', cursor: body(first).page.nextCursor, limit: '2' });
    expect(jest.mocked(listBrowseTrackIds).mock.calls[1][2]).toBe(2);
    expect(body(second).page.nextCursor).toBeNull();
  });

  it('refuses a list without a genre, style or unsorted, and a bad cursor', async () => {
    const missing = await get('/browse/tracks', {});
    expect(missing.status).toHaveBeenCalledWith(400);
    const badCursor = await get('/browse/tracks', { genre: 'Rock', cursor: 'nonsense' });
    expect(badCursor.status).toHaveBeenCalledWith(400);
    const badStyle = await get('/browse/tracks', { style: 'house' });
    expect(badStyle.status).toHaveBeenCalledWith(400);
    expect(listBrowseTrackIds).not.toHaveBeenCalled();
  });

  it('lists unsorted tracks, optionally by tag', async () => {
    jest.mocked(listBrowseTrackIds).mockResolvedValue({ ids: [], hasMore: false });
    await get('/browse/tracks', { unsorted: 'true', tag: 'General Rap' });
    expect(jest.mocked(listBrowseTrackIds).mock.calls[0][1]).toMatchObject({ unsorted: true, tag: 'General Rap' });
  });
});

describe('GET /browse/mix', () => {
  it('returns the mix in the order the server picked it, and needs a genre, style or unsorted', async () => {
    jest.mocked(pickBrowseMix).mockResolvedValue(['t3', 't1', 't2']);
    const res = await get('/browse/mix', { style: '92', decade: '2000', country: 'dk' });
    expect(jest.mocked(pickBrowseMix).mock.calls[0][1]).toMatchObject({ styleId: 92, decade: 2000, country: 'DK' });
    expect(body(res).data.map((t: { id: string }) => t.id)).toEqual(['t3', 't1', 't2']);
    expect((await get('/browse/mix', {})).status).toHaveBeenCalledWith(400);
  });
});

describe('browse albums and genres', () => {
  it('returns album cards with their share, and unsorted is not a filter for albums', async () => {
    jest.mocked(listBrowseAlbumRows).mockResolvedValue({ rows: [{ albumId: 'a1', share: 0.75, tracks: 9 }], hasMore: false });
    const res = await get('/browse/albums', { style: '92' });
    expect(body(res).data).toEqual([expect.objectContaining({ share: 0.75, trackCount: 9, album: expect.objectContaining({ id: 'a1', title: 'Album a1' }) })]);
    const unsorted = await get('/browse/albums', { unsorted: 'true' });
    expect(unsorted.status).toHaveBeenCalledWith(400);
  });

  it('answers 404 for an unknown genre, style or album', async () => {
    jest.mocked(getBrowseGenre).mockResolvedValue(null);
    expect((await get('/browse/genres/:genre', {}, { genre: 'Polka' })).status).toHaveBeenCalledWith(404);
    expect((await get('/browse/styles/:id', {}, { id: 'house' })).status).toHaveBeenCalledWith(404);
    jest.mocked(getAlbumById).mockResolvedValue(null);
    expect((await get('/albums/:id/styles', {}, { id: 'missing' })).status).toHaveBeenCalledWith(404);
  });

  it('refuses an empty style search', async () => {
    expect((await get('/browse/search', { q: '  ' })).status).toHaveBeenCalledWith(400);
  });
});

describe('GET /browse/sound-map', () => {
  it('answers with the map view as the service builds it', async () => {
    const view = { status: 'ready' as const, builtAt: '2026-11-27T12:00:00.000Z', trackCount: 3, points: [[0.1, -0.2]] as Array<[number, number]>, labels: [{ genre: 'Rock', x: 0.1, y: 0, trackCount: 2 }] };
    jest.mocked(getSoundMapView).mockResolvedValue(view);
    const res = await get('/browse/sound-map', {}, {});
    expect(body(res).data).toEqual(view);
  });
});

describe('GET /tracks/:id/rays', () => {
  it('answers with the v1 track and its rays, or 404 for an unknown track', async () => {
    const near = { styles: [{ id: 5, genre: 'Rock', name: 'Grunge', trackCount: 9 }], trackIds: ['n2', 'n1'] };
    jest.mocked(getTrackRays).mockResolvedValue({ credits: [], tags: ['Rock'], styles: [], sound: null, album: null, artist: null, otherArtists: [], soundsCloseTo: near, otherAlbums: [],
      release: { label: null, releaseDate: null, originalDate: null, media: null, catalogNumber: null, barcode: null, releaseStatus: null, copyright: null, discSubtitle: null, isrc: null, links: [] },
      fingerprint: null, soundMap: null });
    const res = await get('/tracks/:id/rays', {}, { id: 't1' });
    expect(body(res).data).toMatchObject({ track: { id: 't1' }, tags: ['Rock'] });
    // Nearby tracks come back as v1 tracks, nearest first, without their paths.
    expect(body(res).data.soundsCloseTo.styles).toEqual(near.styles);
    expect(body(res).data.soundsCloseTo.tracks.map((t: { id: string }) => t.id)).toEqual(['n2', 'n1']);
    expect(body(res).data.soundsCloseTo).not.toHaveProperty('trackIds');
    expect(JSON.stringify(body(res))).not.toContain('secret');

    jest.mocked(getTrackRays).mockResolvedValue(null);
    expect((await get('/tracks/:id/rays', {}, { id: 'gone' })).status).toHaveBeenCalledWith(404);
  });
});
