/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({
  getArtistById: jest.fn(),
  getTracksByArtist: jest.fn(),
  getUncreditedTracksOnOwnedAlbums: jest.fn(),
  getAlbumsOwnedByArtistName: jest.fn(),
  getAlbumById: jest.fn(),
  getTracksByAlbum: jest.fn(),
}));
jest.mock('../services/apiV1Dto.service', () => ({
  ...jest.requireActual('../services/apiV1Dto.service'),
  getApiV1TracksByIds: jest.fn(),
}));
import type { Request, Response } from 'express';
import router from './apiV1.routes';
import {
  getAlbumById, getAlbumsOwnedByArtistName, getArtistById, getTracksByAlbum, getTracksByArtist, getUncreditedTracksOnOwnedAlbums,
} from '../database';
import { getApiV1TracksByIds, mapTrackV1 } from '../services/apiV1Dto.service';
import { albumDetailSchema, artistDetailSchema, trackSchema } from '../../shared/api/v1';

/**
 * The web artist page moved from /api/artists/:id to v1, which first needed
 * the legacy page's extras: tracks on DJ mixes the artist owns without a
 * performer credit, and the Various Artists pseudo-artist's albums.
 */
async function get(path: string, id: string) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.stack.some((h) => h.method === 'get'))!;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await layer.route!.stack[0].handle({ params: { id }, query: {}, apiV1: { userId: 'listener' }, requestId: 'r1' } as unknown as Request, res as unknown as Response, jest.fn());
  return res;
}
const data = (res: { json: jest.Mock }) => res.json.mock.calls[0][0].data;
const rows = (...ids: string[]) => ids.map((id) => ({ id, path: `secret-${id}` }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getApiV1TracksByIds).mockImplementation(async (_u, ids) => ids.map((id) => mapTrackV1({ id, title: `Track ${id}`, path: 'secret' })) as never);
  jest.mocked(getTracksByArtist).mockResolvedValue(rows('c1', 'c2') as never);
  jest.mocked(getUncreditedTracksOnOwnedAlbums).mockResolvedValue(rows('u1') as never);
  jest.mocked(getAlbumsOwnedByArtistName).mockResolvedValue([
    { id: 'al1', title: 'Hits 2003', artist_name: 'Various Artists', track_count: 40, art_hash: 'h1', edition_label: 'Deluxe', path: 'secret' },
  ] as never);
});

describe('GET /artists/:id', () => {
  it('appends owned-album tracks after the credited ones for a real artist', async () => {
    jest.mocked(getArtistById).mockResolvedValue({ id: 'a1', name: 'DJ Shadow', is_va_pseudo: false } as never);
    const res = await get('/artists/:id', 'a1');
    expect(getUncreditedTracksOnOwnedAlbums).toHaveBeenCalledWith('a1', 'DJ Shadow', 'listener');
    expect(getAlbumsOwnedByArtistName).not.toHaveBeenCalled();
    expect(getApiV1TracksByIds).toHaveBeenCalledWith('listener', ['c1', 'c2', 'u1']);
    const body = data(res);
    expect(body.tracks.map((t: { id: string }) => t.id)).toEqual(['c1', 'c2', 'u1']);
    expect(body.ownedAlbums).toEqual([]);
    expect(artistDetailSchema.safeParse(body).success).toBe(true);
  });

  it('sends the Various Artists pseudo-artist its albums, not their tracks', async () => {
    jest.mocked(getArtistById).mockResolvedValue({ id: 'va', name: 'Various Artists', is_va_pseudo: true } as never);
    const res = await get('/artists/:id', 'va');
    expect(getUncreditedTracksOnOwnedAlbums).not.toHaveBeenCalled();
    expect(getAlbumsOwnedByArtistName).toHaveBeenCalledWith('Various Artists');
    const body = data(res);
    expect(body.tracks.map((t: { id: string }) => t.id)).toEqual(['c1', 'c2']);
    expect(body.ownedAlbums).toEqual([expect.objectContaining({
      id: 'al1', title: 'Hits 2003', trackCount: 40, artworkId: 'h1', editionLabel: 'Deluxe',
    })]);
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(artistDetailSchema.safeParse(body).success).toBe(true);
  });

  it('lists a track once when it is both credited and on an owned album', async () => {
    jest.mocked(getArtistById).mockResolvedValue({ id: 'a1', name: 'DJ Shadow' } as never);
    jest.mocked(getUncreditedTracksOnOwnedAlbums).mockResolvedValue(rows('c2', 'u1') as never);
    await get('/artists/:id', 'a1');
    expect(getApiV1TracksByIds).toHaveBeenCalledWith('listener', ['c1', 'c2', 'u1']);
  });

  it('404s an unknown artist', async () => {
    jest.mocked(getArtistById).mockResolvedValue(null as never);
    const res = await get('/artists/:id', 'nope');
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('GET /albums/:id', () => {
  it('matches the AlbumDetail schema, edition label included', async () => {
    jest.mocked(getAlbumById).mockResolvedValue({ id: 'al1', title: 'Hits', artist_name: 'X', edition_label: 'Remaster' } as never);
    jest.mocked(getTracksByAlbum).mockResolvedValue(rows('t1') as never);
    const body = data(await get('/albums/:id', 'al1'));
    expect(body.album.editionLabel).toBe('Remaster');
    expect(albumDetailSchema.safeParse(body).success).toBe(true);
  });
});

describe('Track DTO', () => {
  it('carries the album-artist MBID the artist page falls back to', () => {
    const track = mapTrackV1({ id: 't1', mb_artist_id: 'performer', mb_album_artist_id: 'owner' });
    expect(track.musicBrainz).toMatchObject({ artistId: 'performer', albumArtistId: 'owner' });
    expect(trackSchema.safeParse(track).success).toBe(true);
  });
});
