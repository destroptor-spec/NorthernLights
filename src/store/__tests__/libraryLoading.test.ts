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

const page = (data: unknown[], nextCursor: string | null = null) => ({
  ok: true, json: async () => ({ data, page: { nextCursor } }),
});
const artist = (id: string) => ({ id, name: id, genres: [] });
const album = { id: 'album', title: 'Album', artistName: 'Artist', genres: [] };

describe('progressive library startup', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock.mockReset();
    global.fetch = fetchMock;
    usePlayerStore.setState({
      authToken: 'jwt', artists: [], albums: [], genres: [], playlist: [],
      libraryFolders: [], isLibraryLoading: false, libraryError: null, toasts: [],
    });
  });
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

  function serveArtistPages(count: number) {
    let calls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/artists?')) {
        const n = ++calls;
        return new Promise(resolve => setTimeout(() => resolve(page([artist(`artist-${n}`)], n < count ? `cursor-${n}` : null)), 1000));
      }
      if (url.includes('/albums?')) return Promise.resolve(page([album]));
      if (url.includes('/genres?')) return Promise.resolve(page([]));
      return Promise.resolve({ ok: true, json: async () => ({ directories: [] }) });
    });
  }

  it('publishes artists at 1 second while a 23-page chain is still loading', async () => {
    serveArtistPages(23);
    const pending = usePlayerStore.getState().fetchLibraryFromServer();
    await jest.advanceTimersByTimeAsync(1000);
    const firstPage = usePlayerStore.getState().artists;
    const loadingAfterFirst = usePlayerStore.getState().isLibraryLoading;
    await jest.advanceTimersByTimeAsync(22000);
    await pending;
    expect(firstPage.map(a => a.id)).toEqual(['artist-1']);
    expect(loadingAfterFirst).toBe(true);
    expect(firstPage).toHaveLength(1); // Later pages must not mutate old snapshots.
    expect(usePlayerStore.getState().artists).toHaveLength(23);
    expect(usePlayerStore.getState().isLibraryLoading).toBe(false);
  });

  it('publishes albums independently and deduplicates concurrent callers', async () => {
    serveArtistPages(2);
    const first = usePlayerStore.getState().fetchLibraryFromServer();
    const second = usePlayerStore.getState().fetchLibraryFromServer();
    await jest.advanceTimersByTimeAsync(0);
    const albums = usePlayerStore.getState().albums;
    await jest.advanceTimersByTimeAsync(2000);
    await Promise.all([first, second]);
    expect(albums.map(a => a.id)).toEqual(['album']);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('/artists?'))).toHaveLength(2);
  });

  it('keeps a complete existing list visible until its refresh completes', async () => {
    usePlayerStore.setState({ artists: [{ id: 'existing', name: 'Existing' }] });
    serveArtistPages(2);
    const pending = usePlayerStore.getState().fetchLibraryFromServer();
    await jest.advanceTimersByTimeAsync(1000);
    const duringRefresh = usePlayerStore.getState().artists;
    await jest.advanceTimersByTimeAsync(1000);
    await pending;
    expect(duringRefresh.map(a => a.id)).toEqual(['existing']);
    expect(usePlayerStore.getState().artists.map(a => a.id)).toEqual(['artist-1', 'artist-2']);
  });

  it.each(['expireAuthSession', 'clearAuthToken'] as const)('ignores late responses after %s', async (action) => {
    serveArtistPages(1);
    const pending = usePlayerStore.getState().fetchLibraryFromServer();
    usePlayerStore.getState()[action]();
    await jest.advanceTimersByTimeAsync(1000);
    await pending;
    expect(usePlayerStore.getState().artists).toEqual([]);
    expect(usePlayerStore.getState().albums).toEqual([]);
    expect(usePlayerStore.getState().libraryError).toBeNull();
  });

  it('retains successful lists and waits for other chains after one fails', async () => {
    serveArtistPages(2);
    const serve = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string) => url.includes('/genres?')
      ? Promise.reject(new Error('offline')) : serve(url));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const pending = usePlayerStore.getState().fetchLibraryFromServer();
    await jest.advanceTimersByTimeAsync(0);
    const stillLoading = usePlayerStore.getState().isLibraryLoading;
    await jest.advanceTimersByTimeAsync(2000);
    await pending;
    expect(stillLoading).toBe(true);
    expect(usePlayerStore.getState().artists).toHaveLength(2);
    expect(usePlayerStore.getState().albums).toHaveLength(1);
    expect(usePlayerStore.getState().libraryError).toBeTruthy();
  });

  it('starts queue restoration before the entity chains complete', async () => {
    serveArtistPages(2);
    usePlayerStore.setState({ playlist: [{ id: 'deleted', title: 'Deleted' }] as never });
    const serve = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string) => url.endsWith('/tracks/exists')
      ? Promise.resolve({ ok: true, json: async () => ({ ids: [] }) }) : serve(url));
    const pending = usePlayerStore.getState().fetchLibraryFromServer();
    await jest.advanceTimersByTimeAsync(0);
    const queue = usePlayerStore.getState().playlist;
    await jest.advanceTimersByTimeAsync(2000);
    await pending;
    expect(queue).toEqual([]);
  });

  it('replaces a stale list with an empty successful refresh', async () => {
    usePlayerStore.setState({ artists: [{ id: 'deleted', name: 'Deleted' }] });
    serveArtistPages(1);
    const serve = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string) => url.includes('/artists?')
      ? Promise.resolve(page([])) : serve(url));
    await usePlayerStore.getState().fetchLibraryFromServer();
    expect(usePlayerStore.getState().artists).toEqual([]);
  });

  it('does not let an aborted run clear a newer request deduplication lock', async () => {
    serveArtistPages(4);
    const old = usePlayerStore.getState().fetchLibraryFromServer();
    usePlayerStore.getState().expireAuthSession();
    usePlayerStore.setState({ authToken: 'new-jwt' });
    const current = usePlayerStore.getState().fetchLibraryFromServer();
    await jest.advanceTimersByTimeAsync(1000);
    await old;
    const joined = usePlayerStore.getState().fetchLibraryFromServer();
    await jest.advanceTimersByTimeAsync(3000);
    await Promise.all([current, joined]);
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/v1/artists?limit=200')).toHaveLength(2);
    expect(usePlayerStore.getState().artists.map(a => a.id)).toEqual(['artist-2', 'artist-3', 'artist-4']);
  });
});
