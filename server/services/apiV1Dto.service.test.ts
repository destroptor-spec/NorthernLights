jest.mock('../database', () => ({ initDB: jest.fn() }));

import { mapAlbumSummaryV1, mapPlaylistV1, mapTrackV1, mediaEtagForTrack } from './apiV1Dto.service';
import { playlistSchema, trackSchema } from '../../shared/api/v1';

describe('Aurora API v1 DTO mapping', () => {
  it('maps a database track through an explicit path-free contract', () => {
    const mapped = mapTrackV1({
      id: 'track-1',
      path: Buffer.from('/srv/music/private.flac').toString('base64'),
      title: 'Private Track',
      artist: 'Artist',
      album: 'Album',
      artists: ['Artist'],
      genres: ['Rock'],
      duration: '123.4',
      file_mtime: 100,
      file_size: 200,
      art_hash: 'cover-hash',
      is_loved: true,
      user_rating: 4,
    });

    expect(trackSchema.safeParse(mapped).success).toBe(true);
    expect(mapped).not.toHaveProperty('path');
    expect(JSON.stringify(mapped)).not.toContain('private.flac');
    expect(mapped.artworkUrl).toBe('/api/v1/artwork/cover-hash');
    expect(mapped.rating).toBe(4);
  });

  it('changes media ETags when the file signature changes', () => {
    expect(mediaEtagForTrack({ id: '1', file_mtime: 1, file_size: 2 }))
      .not.toBe(mediaEtagForTrack({ id: '1', file_mtime: 2, file_size: 2 }));
  });

  it('normalizes fractional filesystem mtimes to the scanner representation', () => {
    expect(mediaEtagForTrack({ id: '1', file_mtime: 1234.75, file_size: 2 }))
      .toBe(mediaEtagForTrack({ id: '1', file_mtime: 1234, file_size: 2 }));
  });

  it('normalizes album summaries without leaking raw database fields', () => {
    expect(mapAlbumSummaryV1({
      id: 'album-1', title: 'North', artist_name: 'Aurora', derived_year: '2026',
      derived_genres: ['Electronic'], track_count: '9', path: '/private',
    })).toEqual(expect.objectContaining({ id: 'album-1', artistName: 'Aurora', year: 2026, trackCount: 9 }));
  });

  it('keeps embedded artwork protected instead of exposing it as an unauthenticated image URL', () => {
    expect(mapAlbumSummaryV1({ id: 'album-1', title: 'North', art_hash: 'cover-hash' }))
      .toMatchObject({ artworkId: 'cover-hash', imageUrl: null });
  });

  it('preserves each playlist entry added timestamp', async () => {
    const track = mapTrackV1({ id: 'track-1', title: 'Track', artist: 'Artist', album: 'Album' });
    const playlist = await mapPlaylistV1({
      id: 'playlist-1', title: 'List', userId: 'user-1',
      tracks: [{ id: 'track-1', playlistAddedAt: Date.parse('2026-08-30T10:00:00.000Z') }],
    }, 'user-1', new Map([[track.id, track]]));

    expect(playlistSchema.safeParse(playlist).success).toBe(true);
    expect(playlist.tracks[0]).toEqual({ track, addedAt: '2026-08-30T10:00:00.000Z' });
  });
});
