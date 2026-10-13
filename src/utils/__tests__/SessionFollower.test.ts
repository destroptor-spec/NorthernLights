import { createStore } from 'zustand/vanilla';
import type { PlaybackSession } from '../../../shared/api/v1';
import { SessionFollower, type EventSourceLike, type FollowerPlayerState } from '../SessionFollower';
import type { TrackInfo } from '../fileSystem';
import type { FollowedOutput } from '../sessionFollow';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-13T20:00:00.000Z');

const sessionOf = (entries: number[], extra: Partial<PlaybackSession> = {}): PlaybackSession => ({
  id: 'session-1',
  name: 'Listening',
  ownerClientId: 'nad-phone',
  output: {
    id: 'phone',
    kind: 'browser',
    name: 'NAD Forstærker',
    generation: 4,
    claimedAt: '2026-10-13T19:50:00.000Z',
    status: 'active',
    report: { seq: 9, state: 'playing', reason: null, queueEntryId: uuid(entries[1]), positionMs: 30_000, reportedAt: new Date(NOW - 2_000).toISOString() },
  },
  currentEntryId: uuid(entries[1]),
  positionMs: 30_000,
  playbackState: 'playing',
  repeatMode: 'none',
  shuffle: false,
  source: null,
  revision: 12,
  queue: entries.map((n, position) => ({
    queueEntryId: uuid(n),
    position,
    track: { id: `track-${n}`, durationMs: 200_000 } as unknown as PlaybackSession['queue'][number]['track'],
    addedAt: '2026-10-13T19:00:00.000Z',
  })),
  createdAt: '2026-10-13T19:00:00.000Z',
  updatedAt: '2026-10-13T19:50:00.000Z',
  ...extra,
});

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, (event: MessageEvent) => void>();
  constructor(public url: string) {}
  addEventListener(type: string, listener: (event: MessageEvent) => void) { this.listeners.set(type, listener); }
  close() { this.closed = true; this.readyState = 2; }
  open() { this.readyState = 1; this.onopen?.(new Event('open')); }
  emit(type: string, data: Record<string, unknown>) {
    this.listeners.get(type)?.({ data: JSON.stringify({ id: 'e', type, data }) } as MessageEvent);
  }
  fail() { this.readyState = 2; this.onerror?.(new Event('error')); }
}

function setup(initial: Partial<FollowerPlayerState> = {}, latest: PlaybackSession | null = sessionOf([1, 2, 3])) {
  const sources: FakeEventSource[] = [];
  const api = {
    listPlaybackSessions: jest.fn(async () => (latest ? [latest] : [])),
    getPlaybackSession: jest.fn(async (_auth: unknown, _id: string) => latest!),
  };
  const mirror = { holdsOutput: jest.fn(() => false), noteReplaced: jest.fn(async () => undefined) };
  const setPlaybackTime = jest.fn();
  const store = createStore<FollowerPlayerState>((set, get) => ({
    syncPlaybackAcrossDevices: true,
    currentUser: { id: 'user-1' },
    authToken: 'session-jwt',
    sseAccessToken: 'sse-token',
    playlist: [{ id: 'track-9', path: 'p9', queueEntryId: uuid(9) }],
    currentIndex: 0,
    playbackState: 'paused',
    castConnected: false,
    sessionFollow: null,
    getAuthHeader: () => ({ Authorization: 'Bearer session-jwt' }),
    adoptSessionQueue: jest.fn((tracks: TrackInfo[] | null, index: number) => {
      set({ ...(tracks ? { playlist: tracks } : {}), currentIndex: index, playbackState: 'paused' });
    }),
    setSessionFollow: (follow: FollowedOutput | null) => { if (get().sessionFollow !== follow) set({ sessionFollow: follow }); },
    ...initial,
  }));
  const follower = new SessionFollower();
  const onSettingsChanged = jest.fn();
  follower.start(store, {
    onSettingsChanged,
    api,
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    clientId: () => 'laptop',
    mirror,
    toTracks: (session) => session.queue.map((entry) => ({ id: entry.track.id, path: entry.track.id, duration: 200, queueEntryId: entry.queueEntryId })),
    setPlaybackTime,
  });
  const source = () => sources[sources.length - 1];
  const connect = async () => {
    source().open();
    await jest.advanceTimersByTimeAsync(0);
  };
  return { api, mirror, store, follower, sources, source, connect, setPlaybackTime, onSettingsChanged };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

describe('the event stream', () => {
  it('connects with the scoped sse token only', () => {
    expect(setup().source().url).toBe('/api/v1/events?token=sse-token');
  });

  it('never puts the full session token in the URL', () => {
    expect(setup({ sseAccessToken: null }).sources).toHaveLength(0);
    // The store falls back to the session token for older streams.
    expect(setup({ sseAccessToken: 'session-jwt' }).sources).toHaveLength(0);
  });

  it('stays off while the setting is off, and lets go when it is turned off', () => {
    expect(setup({ syncPlaybackAcrossDevices: false }).sources).toHaveLength(0);
    const { store, source } = setup();
    store.setState({ syncPlaybackAcrossDevices: false });
    expect(source().closed).toBe(true);
  });

  it('starts over with the new token after the stream closed for good', async () => {
    const { store, sources, source } = setup();
    source().fail();
    store.setState({ sseAccessToken: 'sse-token-2' });
    expect(sources[1].url).toBe('/api/v1/events?token=sse-token-2');
  });

  it('retries a closed stream after a while', async () => {
    const { sources, source } = setup();
    source().fail();
    await jest.advanceTimersByTimeAsync(14_000);
    expect(sources).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(sources).toHaveLength(2);
  });
});

describe('following another device', () => {
  it("replaces an idle device's queue with the session's and shows where the other device is", async () => {
    const { store, connect, setPlaybackTime } = setup();
    await connect();
    const state = store.getState();
    expect(state.playlist.map((t) => t.queueEntryId)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(state.currentIndex).toBe(1);
    expect(state.adoptSessionQueue).toHaveBeenCalledWith(expect.any(Array), 1, 32);
    expect(state.sessionFollow).toMatchObject({ name: 'NAD Forstærker', state: 'playing', entryId: uuid(2), positionMs: 30_000 });
    expect(setPlaybackTime).toHaveBeenLastCalledWith(32, 200);
  });

  it('carries progress forward between heartbeats and takes each heartbeat as it comes', async () => {
    const { source, connect, setPlaybackTime } = setup();
    await connect();
    await jest.advanceTimersByTimeAsync(3_000);
    expect(setPlaybackTime).toHaveBeenLastCalledWith(35, 200);

    source().emit('playbackSession.progress', {
      sessionId: 'session-1', revision: 12, outputId: 'phone', generation: 4,
      report: { state: 'paused', queueEntryId: uuid(2), positionMs: 34_000 },
    });
    expect(setPlaybackTime).toHaveBeenLastCalledWith(34, 200);
    setPlaybackTime.mockClear();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(setPlaybackTime).not.toHaveBeenCalled();
  });

  it('only moves the current track when the queue is the same', async () => {
    const { store, api, source, connect } = setup({
      playlist: [1, 2, 3].map((n) => ({ id: `track-${n}`, path: `p${n}`, queueEntryId: uuid(n) })),
    });
    await connect();
    expect(store.getState().adoptSessionQueue).toHaveBeenLastCalledWith(null, 1, 32);

    api.getPlaybackSession.mockResolvedValueOnce(sessionOf([1, 2, 3], {
      revision: 13,
      currentEntryId: uuid(3),
      output: { ...sessionOf([1, 2, 3]).output!, report: { seq: 10, state: 'playing', reason: null, queueEntryId: uuid(3), positionMs: 0, reportedAt: new Date(NOW).toISOString() } },
    }));
    source().emit('playbackSession.updated', { sessionId: 'session-1', revision: 13 });
    await jest.advanceTimersByTimeAsync(0);
    expect(store.getState().adoptSessionQueue).toHaveBeenLastCalledWith(null, 2, 0);
  });

  it('leaves a playing, casting or output-holding device alone', async () => {
    for (const initial of [{ playbackState: 'playing' as const }, { castConnected: true }]) {
      const { store, connect } = setup(initial);
      await connect();
      expect(store.getState().adoptSessionQueue).not.toHaveBeenCalled();
      expect(store.getState().sessionFollow).toBeNull();
    }
    const { store, mirror, connect } = setup();
    mirror.holdsOutput.mockReturnValue(true);
    await connect();
    expect(store.getState().adoptSessionQueue).not.toHaveBeenCalled();
  });

  it('follows once this device stops playing', async () => {
    const { store, connect } = setup({ playbackState: 'playing' });
    await connect();
    store.setState({ playbackState: 'paused' });
    expect(store.getState().sessionFollow).toMatchObject({ name: 'NAD Forstærker' });
    store.setState({ playbackState: 'playing' });
    expect(store.getState().sessionFollow).toBeNull();
  });

  it('does not follow a device that went quiet or ended', async () => {
    const quiet = sessionOf([1, 2, 3]);
    quiet.output!.status = 'unreachable';
    const { store, connect } = setup({}, quiet);
    await connect();
    expect(store.getState().sessionFollow).toBeNull();
    // The queue is still the session's.
    expect(store.getState().playlist.map((t) => t.queueEntryId)).toEqual([uuid(1), uuid(2), uuid(3)]);
  });

  it('reads the session again when heartbeats stop', async () => {
    const { api, connect } = setup();
    await connect();
    // The last report was 2 s old when it was read.
    await jest.advanceTimersByTimeAsync(62_000);
    expect(api.getPlaybackSession).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(api.getPlaybackSession).toHaveBeenCalledWith(expect.anything(), 'session-1');
  });

  it('forgets a deleted session', async () => {
    const { store, source, connect } = setup();
    await connect();
    source().emit('playbackSession.deleted', { sessionId: 'session-1' });
    expect(store.getState().sessionFollow).toBeNull();
  });
});

describe('another device taking over', () => {
  it('tells the mirror about a newer claim by another device', async () => {
    const { mirror, source, connect } = setup({ playbackState: 'playing' });
    await connect();
    // What was true when this device connected is not a claim against it.
    expect(mirror.noteReplaced).not.toHaveBeenCalled();

    source().emit('playbackSession.handedOff', { sessionId: 'session-1', outputId: 'phone', generation: 4, revision: 12 });
    await jest.advanceTimersByTimeAsync(0);
    expect(mirror.noteReplaced).not.toHaveBeenCalled();

    source().emit('playbackSession.handedOff', { sessionId: 'session-1', outputId: 'phone', generation: 5, revision: 13 });
    await jest.advanceTimersByTimeAsync(0);
    expect(mirror.noteReplaced).toHaveBeenCalledWith('session-1', 5);
  });

  it("ignores this device's own claim", async () => {
    const { mirror, source, connect } = setup({ playbackState: 'playing' });
    await connect();
    source().emit('playbackSession.handedOff', { sessionId: 'session-1', outputId: 'laptop', generation: 9, revision: 20 });
    await jest.advanceTimersByTimeAsync(0);
    expect(mirror.noteReplaced).not.toHaveBeenCalled();
  });

  it('catches a claim it only sees in a fetched session', async () => {
    const { api, mirror, source, connect } = setup({ playbackState: 'playing' });
    await connect();
    const later = sessionOf([1, 2, 3], { revision: 14 });
    later.output!.generation = 6;
    api.getPlaybackSession.mockResolvedValueOnce(later);
    source().emit('playbackSession.updated', { sessionId: 'session-1', revision: 14 });
    await jest.advanceTimersByTimeAsync(0);
    expect(mirror.noteReplaced).toHaveBeenCalledWith('session-1', 6);
  });
});

it('passes settings changes on, so every device re-reads the sync setting', async () => {
  const { source, connect, onSettingsChanged } = setup();
  await connect();
  source().emit('settings.changed', { keys: ['playbackSyncMode'] });
  expect(onSettingsChanged).toHaveBeenCalledWith(['playbackSyncMode']);
});

