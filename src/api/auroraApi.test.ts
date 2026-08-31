import { auroraApiRequest, getAuroraClientId, toLegacyPlaylist, toLegacyTrack, type Playlist, type Track } from './auroraApi';

describe('Aurora web API client', () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.restoreAllMocks();
    Object.defineProperty(global, 'fetch', { configurable: true, writable: true, value: jest.fn() });
  });

  it('keeps a stable per-install client ID and sends it with requests', async () => {
    const fetchMock = global.fetch as jest.Mock;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ data: { ok: true }, meta: { requestId: 'r1' } }),
    });
    const first = getAuroraClientId();
    expect(getAuroraClientId()).toBe(first);
    await expect(auroraApiRequest<{ ok: boolean }>('/me', { Authorization: 'Bearer test' })).resolves.toEqual({ ok: true });
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get('X-Aurora-Client-Id')).toBe(first);
    expect(headers.get('Authorization')).toBe('Bearer test');
  });

  it('surfaces the stable error code and request ID', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 409,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ error: { code: 'REVISION_CONFLICT', message: 'Try again', requestId: 'request-7' } }),
    });
    await expect(auroraApiRequest('/playback-sessions/1', {})).rejects.toMatchObject({
      status: 409, code: 'REVISION_CONFLICT', requestId: 'request-7',
    });
  });

  it('adapts path-free tracks without reconstructing a server file path', () => {
    const track = {
      id: 't1', title: 'Track', artist: 'Artist', albumArtist: null, artists: ['Artist'], album: 'Album',
      genre: null, genres: [], durationSeconds: 10, trackNumber: null, discNumber: null, year: null,
      releaseType: null, compilation: false, bitrate: null, format: 'FLAC', lossless: true, fileSize: null,
      mediaEtag: null, artistId: null, albumId: null, genreId: null, loved: false, rating: 0, playCount: 0,
      lastPlayedAt: null, artworkId: null, artworkUrl: null,
      musicBrainz: { recordingId: null, trackId: null, albumId: null, artistId: null, releaseGroupId: null, workId: null },
    } satisfies Track;
    const adapted = toLegacyTrack(track, 'media-token', 'auto');
    expect(adapted.path).toBe('api-v1:t1');
    expect(adapted.rawUrl).toContain('/api/v1/media/tracks/t1');
    expect(new URL(adapted.url!)).toBeInstanceOf(URL);
    expect(new URL(adapted.rawUrl!)).toBeInstanceOf(URL);
  });

  it('preserves playlist timestamps while producing Cast-resolvable media URLs', () => {
    const track = {
      id: 't1', title: 'Track', artist: 'Artist', albumArtist: null, artists: ['Artist'], album: 'Album',
      genre: null, genres: [], durationSeconds: 10, trackNumber: null, discNumber: null, year: null,
      releaseType: null, compilation: false, bitrate: null, format: 'FLAC', lossless: true, fileSize: null,
      mediaEtag: null, artistId: null, albumId: null, genreId: null, loved: false, rating: 0, playCount: 0,
      lastPlayedAt: null, artworkId: 'cover', artworkUrl: '/api/v1/artwork/cover',
      musicBrainz: { recordingId: null, trackId: null, albumId: null, artistId: null, releaseGroupId: null, workId: null },
    } satisfies Track;
    const playlist = {
      id: 'p1', title: 'List', description: null, ownerUsername: 'alice', isOwner: true,
      isSystem: false, isGenerated: false, pinned: false, private: false, readOnly: false,
      createdAt: null, tracks: [{ track, addedAt: '2026-08-30T10:00:00.000Z' }],
    } satisfies Playlist;

    const adapted = toLegacyPlaylist(playlist, 'media-token', 'auto');
    expect(adapted.tracks[0].playlistAddedAt).toBe(Date.parse('2026-08-30T10:00:00.000Z'));
    expect(adapted.tracks[0].url).toMatch(/^https?:\/\//);
    expect(adapted.tracks[0].artUrl).toContain('token=media-token');
  });
});
