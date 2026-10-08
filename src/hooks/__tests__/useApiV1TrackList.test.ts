import { renderHook, waitFor } from '@testing-library/react';
import { useApiV1TrackList } from '../useApiV1TrackList';
import { usePlayerStore } from '../../store';

import type { Track } from '../../api/auroraApi';

// A complete v1 Track, as the server sends it.
const apiTrack = (id: string): Track => ({
  id, title: id, artist: 'Artist', albumArtist: null, artists: ['Artist'], album: 'Album',
  genre: null, genres: [], durationSeconds: 100, trackNumber: null, discNumber: null, year: null,
  releaseType: null, compilation: false, bitrate: null, format: 'FLAC', lossless: true, fileSize: null,
  mediaEtag: null, artistId: null, albumId: null, genreId: null, loved: false, rating: 0, playCount: 0,
  lastPlayedAt: null, artworkId: null, artworkUrl: null,
  musicBrainz: { recordingId: null, trackId: null, albumId: null, artistId: null, albumArtistId: null, releaseGroupId: null, workId: null },
});

describe('useApiV1TrackList', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as never;
    usePlayerStore.setState({ authToken: 'jwt', mediaAccessToken: 'media', lovedOverlay: {} } as never);
  });

  it('fetches under /api/v1 and returns playable tracks', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [apiTrack('a'), apiTrack('b')] }), headers: { get: () => null } });
    const { result } = renderHook(() => useApiV1TrackList('/playlists/p1/suggestions'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/playlists/p1/suggestions');
    expect(result.current.tracks.map((t) => t.id)).toEqual(['a', 'b']);
    expect(result.current.tracks[0].url).toContain('media');
  });

  it('fetches nothing for a null path', () => {
    const { result } = renderHook(() => useApiV1TrackList(null));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toEqual({ tracks: [], loading: false });
  });

  it('settles empty on a failed request', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: { message: 'x' } }), headers: { get: () => null } });
    const { result } = renderHook(() => useApiV1TrackList('/playlists/p1/suggestions'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.tracks).toEqual([]);
  });

  it('reflects a love made after the fetch', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [apiTrack('a')] }), headers: { get: () => null } });
    const { result } = renderHook(() => useApiV1TrackList('/playlists/p1/suggestions'));
    await waitFor(() => expect(result.current.tracks).toHaveLength(1));
    usePlayerStore.setState({ lovedOverlay: { a: true } } as never);
    await waitFor(() => expect(result.current.tracks[0].isLoved).toBe(true));
  });
});
