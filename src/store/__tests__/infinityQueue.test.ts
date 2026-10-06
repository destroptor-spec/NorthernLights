/**
 * Infinity Mode tops the queue up from `playAtIndex`. While casting, the
 * receiver advances its own queue, so `playAtIndex` never runs — the sender
 * only learns about the change through `onTrackChange`. Before this was wired
 * up, a cast Infinity session played exactly one prefetched track and then
 * stopped dead (prod, 2026-08-30 21:02→21:07). The `onEnded` fallback cannot
 * cover it either: that path needs `idleReason === FINISHED`, and the receiver
 * reported `none` on all 53 observations that session.
 */
// Captured at import time, when the store registers with PlaybackManager —
// a plain jest.fn() would lose it to clearAllMocks() in beforeEach.
let mockCallbacks: { onTrackChange: (index: number) => void };
const appendToQueue = jest.fn();
const isConnected = jest.fn(() => true);

jest.mock('../../utils/PlaybackManager', () => ({
  playbackManager: {
    setCallbacks: (cb: { onTrackChange: (index: number) => void }) => { mockCallbacks = cb; },
    getLocalAudioElement: () => ({ pause: jest.fn() }),
    play: jest.fn(),
    pause: jest.fn(),
    stop: jest.fn(),
    seek: jest.fn(),
    setVolume: jest.fn(),
    loadTrack: jest.fn(),
    prepareNextUrl: jest.fn(),
  },
}));

jest.mock('../../utils/CastManager', () => ({
  castManager: {
    isConnected: () => isConnected(),
    appendToQueue: (t: unknown) => appendToQueue(t),
    setDiagnosticsVerbose: jest.fn(),
    addStateChangeListener: jest.fn(),
    addHealthListener: jest.fn(),
    getHealthStatus: () => ({ phase: 'idle', message: '' }),
    getDeviceName: () => 'Test Device',
    onTrackChange: undefined,
  },
}));

import { usePlayerStore } from '../index';
import type { Track } from '../../../shared/api/v1';

const track = (id: string) => ({ id, path: `/${id}.mp3`, title: id, duration: 100 });
const apiTrack = (id: string): Track => ({
  id, title: id, artist: 'Artist', albumArtist: null, artists: ['Artist'], album: 'Album',
  genre: null, genres: [], durationSeconds: 100, trackNumber: null, discNumber: null, year: null,
  releaseType: null, compilation: false, bitrate: null, format: 'FLAC', lossless: true, fileSize: null,
  mediaEtag: null, artistId: null, albumId: null, genreId: null, loved: false, rating: 0, playCount: 0,
  lastPlayedAt: null, artworkId: null, artworkUrl: null,
  musicBrainz: { recordingId: null, trackId: null, albumId: null, artistId: null, releaseGroupId: null, workId: null },
});

const callbacks = () => mockCallbacks;

describe('Infinity Mode through API v1', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    isConnected.mockReturnValue(true);
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: apiTrack('next'), meta: { requestId: 'test' } }),
    });
    usePlayerStore.setState({
      isInfinityMode: true,
      isFetchingInfinity: false,
      playlist: [track('a'), track('b')],
      currentIndex: 0,
      sessionHistoryTrackIds: [],
      mediaAccessToken: 'media-token',
      streamingQuality: 'auto',
    });
  });

  it('tops the queue up when the receiver advances onto the last track', async () => {
    callbacks().onTrackChange(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).toHaveBeenCalledWith('/api/v1/recommendations/next', expect.anything());
    expect(usePlayerStore.getState().playlist.map((t) => t.id)).toEqual(['a', 'b', 'next']);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.sessionHistoryTrackIds).toEqual(['b']);
    expect(payload.exclude).toEqual(['a', 'b']);
  });

  it('pushes the appended track to the Cast receiver, not just the local queue', async () => {
    callbacks().onTrackChange(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(appendToQueue).toHaveBeenCalledTimes(1);
    expect(appendToQueue.mock.calls[0][0]).toMatchObject({ id: 'next' });
  });

  it('does not fetch while tracks remain ahead in the queue', async () => {
    usePlayerStore.setState({ playlist: [track('a'), track('b'), track('c')], currentIndex: 0 });
    callbacks().onTrackChange(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing when Infinity Mode is off', async () => {
    usePlayerStore.setState({ isInfinityMode: false });
    callbacks().onTrackChange(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().playlist).toHaveLength(2);
  });

  it('still syncs the current index when it does not need to fetch', () => {
    usePlayerStore.setState({ isInfinityMode: false });
    callbacks().onTrackChange(1);
    expect(usePlayerStore.getState().currentIndex).toBe(1);
  });

  it('ignores an out-of-range index from the receiver', async () => {
    callbacks().onTrackChange(99);
    await new Promise((r) => setTimeout(r, 0));

    expect(usePlayerStore.getState().currentIndex).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('browser prefetch seeds from the playing track and excludes tracks already queued', async () => {
    isConnected.mockReturnValue(false);
    usePlayerStore.setState({ currentIndex: 1, sessionHistoryTrackIds: ['a'] });
    await usePlayerStore.getState().fetchNextInfinityTrack(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ sessionHistoryTrackIds: ['a', 'b'], exclude: ['a', 'b'], seedTrackIds: ['a', 'b'] });
    expect(usePlayerStore.getState().playlist.map(t => t.id)).toEqual(['a', 'b', 'next']);
    const next = usePlayerStore.getState().playlist[2];
    expect(next.path).toBe('api-v1:next');
    expect(next.duration).toBe(100);
    expect(next.isInfinity).toBe(true);
    expect(new URL(next.url!).searchParams.get('quality')).toBe('auto');
    expect(new URL(next.rawUrl!).pathname).toBe('/api/v1/media/tracks/next');
    expect(new URL(next.rawUrl!).searchParams.get('token')).toBe('media-token');
  });

  it('seeds from the end of the queue, including Infinity picks, not from play history', async () => {
    isConnected.mockReturnValue(false);
    // Played x and y earlier, then reordered the queue; an earlier Infinity pick sits at the end.
    usePlayerStore.setState({
      playlist: [track('c'), track('a'), track('b'), { ...track('inf'), isInfinity: true }],
      currentIndex: 3,
      sessionHistoryTrackIds: ['x', 'y', 'inf'],
    });
    await usePlayerStore.getState().fetchNextInfinityTrack(true);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.seedTrackIds).toEqual(['c', 'a', 'b', 'inf']);
    expect(payload.sessionHistoryTrackIds).toEqual(['x', 'y', 'inf']);
  });

  it('sends at most the last ten queue tracks as seeds', async () => {
    isConnected.mockReturnValue(false);
    usePlayerStore.setState({ playlist: Array.from({ length: 14 }, (_, i) => track(`t${i}`)), currentIndex: 13 });
    await usePlayerStore.getState().fetchNextInfinityTrack(true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).seedTrackIds).toEqual(Array.from({ length: 10 }, (_, i) => `t${i + 4}`));
  });

  it('refuses a duplicate recommendation response', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: apiTrack('b') }) });
    await usePlayerStore.getState().fetchNextInfinityTrack(true);
    expect(usePlayerStore.getState().playlist.map(t => t.id)).toEqual(['a', 'b']);
    expect(appendToQueue).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().isFetchingInfinity).toBe(false);
  });

  it('rechecks the queue when it changes during a pending recommendation', async () => {
    let resolve!: (response: unknown) => void;
    fetchMock.mockReturnValue(new Promise(done => { resolve = done; }));
    const pending = usePlayerStore.getState().fetchNextInfinityTrack(true);
    usePlayerStore.setState({ playlist: [track('a'), track('b'), track('next')] });
    resolve({ ok: true, json: async () => ({ data: apiTrack('next') }) });
    await pending;
    expect(usePlayerStore.getState().playlist).toHaveLength(3);
    expect(appendToQueue).not.toHaveBeenCalled();
  });

  it('handles v1 exhaustion and releases the in-flight guard', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: null, meta: { requestId: 'test' } }) });
    await usePlayerStore.getState().fetchNextInfinityTrack(true);
    expect(usePlayerStore.getState().playlist.map(t => t.id)).toEqual(['a', 'b']);
    expect(usePlayerStore.getState().isFetchingInfinity).toBe(false);
  });

  it('keeps the queue intact after a v1 error', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: { code: 'INTERNAL_ERROR', message: 'Failed', requestId: 'test' } }) });
      await usePlayerStore.getState().fetchNextInfinityTrack(true);
      expect(usePlayerStore.getState().playlist.map(t => t.id)).toEqual(['a', 'b']);
      expect(usePlayerStore.getState().isFetchingInfinity).toBe(false);
      expect(error).toHaveBeenCalledWith('Failed to fetch infinity track', expect.objectContaining({ code: 'INTERNAL_ERROR' }));
    } finally { error.mockRestore(); }
  });
});
