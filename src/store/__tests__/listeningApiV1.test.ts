jest.mock('../../utils/PlaybackManager', () => ({
  playbackManager: {
    setCallbacks: jest.fn(),
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
    isConnected: () => false,
    appendToQueue: jest.fn(),
    setDiagnosticsVerbose: jest.fn(),
    addStateChangeListener: jest.fn(),
    addHealthListener: jest.fn(),
    getHealthStatus: () => ({ phase: 'idle', message: '' }),
    getDeviceName: () => 'Test Device',
    onTrackChange: undefined,
  },
}));

import { usePlayerStore } from '../index';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Plays, skips and loves now go through API v1 — the path any other client
 * uses — instead of the legacy /api/playback/record, /skip and /library/love.
 */
describe('listening writes through API v1', () => {
  const fetchMock = jest.fn();
  const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: { requestId: 'r' } }), headers: { get: () => null } });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const lastCall = () => fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    usePlayerStore.setState({ authToken: 'jwt', toasts: [], lovedOverlay: {} } as never);
  });

  describe('play and skip reports', () => {
    beforeEach(() => fetchMock.mockResolvedValue(ok({ status: 'recorded' })));

    it('reports a play to /playback/reports with a fresh UUID eventId', async () => {
      usePlayerStore.getState().recordPlay('track-1');
      await flush();
      const [url, init] = lastCall();
      expect(url).toBe('/api/v1/playback/reports');
      expect(init.method).toBe('POST');
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({ eventId: expect.stringMatching(UUID_V4), trackId: 'track-1', kind: 'played' });
    });

    it('reports a skip the same way', async () => {
      usePlayerStore.getState().recordSkip('track-2');
      await flush();
      expect(JSON.parse(String(lastCall()[1].body))).toMatchObject({ trackId: 'track-2', kind: 'skipped' });
    });

    it('leaves the timestamp to the server, as the legacy route did', async () => {
      // A skewed client clock must not be able to misplace plays in history.
      usePlayerStore.getState().recordPlay('track-1');
      await flush();
      expect(JSON.parse(String(lastCall()[1].body))).not.toHaveProperty('occurredAt');
    });

    it('gives every report its own eventId, so two plays are two plays', async () => {
      usePlayerStore.getState().recordPlay('track-1');
      usePlayerStore.getState().recordPlay('track-1');
      await flush();
      const ids = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).eventId);
      expect(new Set(ids).size).toBe(2);
    });

    it('authenticates with the session and never throws into playback', async () => {
      fetchMock.mockRejectedValue(new Error('offline'));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => usePlayerStore.getState().recordPlay('track-1')).not.toThrow();
      await flush();
      expect((lastCall()[1].headers as Record<string, string>).Authorization).toBe('Bearer jwt');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('no longer calls the legacy routes', async () => {
      usePlayerStore.getState().recordPlay('a');
      usePlayerStore.getState().recordSkip('b');
      await flush();
      for (const [url] of fetchMock.mock.calls) expect(String(url)).not.toMatch(/\/api\/playback\//);
    });
  });

  describe('loving a track', () => {
    const track = { id: 'track id/1', title: 'Habits', artist: 'Tove Lo', isLoved: false } as never;

    it('sends PUT /tracks/:id/loved with the id in the path', async () => {
      fetchMock.mockResolvedValue(ok({ trackId: 'track id/1', loved: true, providers: [] }));
      await usePlayerStore.getState().toggleTrackLove(track);
      const [url, init] = lastCall();
      expect(url).toBe('/api/v1/tracks/track%20id%2F1/loved');
      expect(init.method).toBe('PUT');
      expect(JSON.parse(String(init.body))).toEqual({ loved: true });
      expect(usePlayerStore.getState().lovedOverlay['track id/1']).toBe(true);
    });

    it('tells the listener when a provider sync failed but keeps the love', async () => {
      fetchMock.mockResolvedValue(ok({ trackId: 'track id/1', loved: true, providers: [{ provider: 'lastfm', status: 'failed', error: '503' }] }));
      await usePlayerStore.getState().toggleTrackLove(track);
      expect(usePlayerStore.getState().lovedOverlay['track id/1']).toBe(true);
      expect(usePlayerStore.getState().toasts.map((t) => t.message)).toContain('Saved locally; one provider sync failed');
    });

    it('reverts and reports when the server refuses', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: { message: 'boom', code: 'X' } }), headers: { get: () => null } });
      const error = jest.spyOn(console, 'error').mockImplementation(() => {});
      await expect(usePlayerStore.getState().toggleTrackLove(track)).rejects.toThrow();
      expect(usePlayerStore.getState().lovedOverlay['track id/1']).toBe(false);
      expect(usePlayerStore.getState().toasts.map((t) => t.message)).toContain('Failed to update like');
      error.mockRestore();
    });
  });
});
