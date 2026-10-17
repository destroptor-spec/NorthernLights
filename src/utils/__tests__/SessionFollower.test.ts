import { createStore } from 'zustand/vanilla';
import type { PlaybackSession } from '../../../shared/api/v1';
import { AuroraApiError } from '../../api/auroraApi';
import { SessionFollower, type EventSourceLike, type FollowerPlayerState } from '../SessionFollower';
import type { TrackInfo } from '../fileSystem';
import { isFollowedOutputPlaying, type FollowedOutput } from '../sessionFollow';

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
  infinity: false,
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
    patchPlaybackSession: jest.fn(async (_auth: unknown, _id: string, _patch: unknown) => ({ ...latest!, revision: latest!.revision + 1 }) as PlaybackSession),
  };
  const mirror = {
    holdsOutput: jest.fn(() => false),
    currentGrant: jest.fn((): { sessionId: string; outputId: string; generation: number } | null => null),
    noteReplaced: jest.fn(async () => undefined),
    noteSessionChanged: jest.fn((_session: PlaybackSession) => false),
  };
  const adoptCastQueue = jest.fn();
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
  const onPlaybackSyncChanged = jest.fn();
  const onCommand = jest.fn();
  const diagnostic = jest.fn();
  follower.start(store, {
    diagnostic,
    onPlaybackSyncChanged,
    onCommand,
    api,
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    clientId: () => 'laptop',
    mirror,
    adoptCastQueue,
    toTracks: (session) => session.queue.map((entry) => ({ id: entry.track.id, path: entry.track.id, duration: 200, queueEntryId: entry.queueEntryId })),
    setPlaybackTime,
  });
  const source = () => sources[sources.length - 1];
  const connect = async () => {
    source().open();
    await jest.advanceTimersByTimeAsync(0);
  };
  return { api, mirror, store, follower, sources, source, connect, setPlaybackTime, onPlaybackSyncChanged, onCommand, diagnostic, adoptCastQueue };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

describe('the event stream', () => {
  it('connects with the scoped sse token only', () => {
    // The client ID tells the server this device can hear remote commands.
    expect(setup().source().url).toBe('/api/v1/events?token=sse-token&clientId=laptop');
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
    expect(sources[1].url).toBe('/api/v1/events?token=sse-token-2&clientId=laptop');
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

  it('keeps following a silent Cast device, marked so, since it likely plays on', async () => {
    const quiet = sessionOf([1, 2, 3]);
    quiet.output = { ...quiet.output!, kind: 'cast', status: 'unreachable' };
    const { store, source, connect } = setup({}, quiet);
    await connect();
    expect(store.getState().sessionFollow).toMatchObject({ name: 'NAD Forstærker', silent: true });
    expect(isFollowedOutputPlaying(store.getState().sessionFollow)).toBe(false);

    // It is heard from again.
    source().emit('playbackSession.progress', {
      sessionId: 'session-1', revision: 12, outputId: 'phone', generation: 4,
      report: { state: 'playing', queueEntryId: uuid(2), positionMs: 90_000 },
    });
    expect(store.getState().sessionFollow).toMatchObject({ silent: false, state: 'playing' });
  });

  it('keeps following a silent receiver that plays the session itself, marked so', async () => {
    const quiet = sessionOf([1, 2, 3]);
    quiet.output = { ...quiet.output!, id: 'receiver:cast-77', kind: 'receiver', status: 'unreachable' };
    const { store, follower, connect } = setup({}, quiet);
    await connect();
    expect(store.getState().sessionFollow).toMatchObject({ outputId: 'receiver:cast-77', kind: 'receiver', silent: true });
    expect(follower.anotherDevicePlaying()).toBe(true);
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

    source().emit('playbackSession.handedOff', { sessionId: 'session-1', outputId: 'phone', outputKind: 'cast', outputName: 'NAD Forstærker', generation: 5, revision: 13 });
    await jest.advanceTimersByTimeAsync(0);
    expect(mirror.noteReplaced).toHaveBeenCalledWith('session-1', 5, { kind: 'cast', name: 'NAD Forstærker' });
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
    expect(mirror.noteReplaced).toHaveBeenCalledWith('session-1', 6, { kind: 'browser', name: 'NAD Forstærker' });
  });
});

it('passes on whether sync is now on for this account', async () => {
  const { source, connect, onPlaybackSyncChanged } = setup();
  await connect();
  source().emit('playbackSync.changed', { enabled: false });
  expect(onPlaybackSyncChanged).toHaveBeenCalledWith(false);
});

it('takes a refused session read as sync being off', async () => {
  const { api, connect, onPlaybackSyncChanged } = setup();
  api.listPlaybackSessions.mockRejectedValueOnce(new AuroraApiError('off', 403, 'PLAYBACK_SYNC_DISABLED'));
  await connect();
  expect(onPlaybackSyncChanged).toHaveBeenCalledWith(false);
});

describe('remote commands for this device', () => {
  const command = (extra: Record<string, unknown> = {}) => ({
    sessionId: 'session-1', outputId: 'laptop', generation: 7, requestId: 'r1', issuedBy: 'phone', command: { type: 'next' }, ...extra,
  });

  it('passes on a command for the grant this device holds', async () => {
    const { mirror, source, connect, onCommand } = setup({ playbackState: 'playing' });
    mirror.currentGrant.mockReturnValue({ sessionId: 'session-1', outputId: 'laptop', generation: 7 });
    await connect();
    source().emit('playbackSession.command', command());
    expect(onCommand).toHaveBeenCalledWith('session-1', { type: 'next' });
  });

  it('ignores commands for another device, an earlier grant, or when it holds none', async () => {
    const { mirror, source, connect, onCommand } = setup({ playbackState: 'playing' });
    await connect();
    source().emit('playbackSession.command', command());
    mirror.currentGrant.mockReturnValue({ sessionId: 'session-1', outputId: 'laptop', generation: 7 });
    source().emit('playbackSession.command', command({ outputId: 'phone' }));
    source().emit('playbackSession.command', command({ generation: 6 }));
    source().emit('playbackSession.command', command({ sessionId: 'session-2' }));
    expect(onCommand).not.toHaveBeenCalled();
  });
});

it('remembers when it last heard from each playing device', async () => {
  const { follower, source, connect } = setup();
  await connect();
  expect(follower.lastHeardFrom('phone')).toBe(0);
  jest.setSystemTime(NOW + 4_000);
  source().emit('playbackSession.progress', {
    sessionId: 'session-1', revision: 12, outputId: 'phone', generation: 4,
    report: { state: 'paused', queueEntryId: uuid(2), positionMs: 31_000 },
  });
  expect(follower.lastHeardFrom('phone')).toBe(NOW + 4_000);
});

it('knows when another of my devices is casting to the very Cast session this one is in', async () => {
  const casting = sessionOf([1, 2, 3]);
  casting.output = { ...casting.output!, kind: 'cast', castSessionId: '2bc27ebd' };
  const { follower, connect } = setup({}, casting);
  await connect();
  expect(follower.castingElsewhere('NAD Forstærker', '2bc27ebd')).toEqual({ outputId: 'phone' });
  expect(follower.castingElsewhere('Stue TV', '2bc27ebd')).toBeNull();
  // Picking the device started a new session (prod 22:16:20): not a join.
  expect(follower.castingElsewhere('NAD Forstærker', '3da7d650')).toBeNull();
  expect(follower.castingElsewhere('NAD Forstærker', null)).toBeNull();

  const unknown = sessionOf([1, 2, 3]);
  unknown.output = { ...unknown.output!, kind: 'cast', castSessionId: null };
  const restarted = setup({}, unknown);
  await restarted.connect();
  expect(restarted.follower.castingElsewhere('NAD Forstærker', '2bc27ebd')).toBeNull();

  const quiet = sessionOf([1, 2, 3]);
  quiet.output = { ...quiet.output!, kind: 'cast', status: 'unreachable', castSessionId: '2bc27ebd' };
  const gone = setup({}, quiet);
  await gone.connect();
  expect(gone.follower.castingElsewhere('NAD Forstærker', '2bc27ebd')).toBeNull();
});

it('tells the server log which device it follows, and the commands it gets', async () => {
  const { mirror, source, connect, diagnostic } = setup({ playbackState: 'playing' });
  await connect();
  expect(diagnostic).toHaveBeenCalledWith('ok', 'sync-follow', 'output=browser:NAD Forstærker was=none status=active');
  mirror.currentGrant.mockReturnValue({ sessionId: 'session-1', outputId: 'laptop', generation: 7 });
  source().emit('playbackSession.command', { sessionId: 'session-1', outputId: 'laptop', generation: 7, issuedBy: 'phone', command: { type: 'pause' } });
  expect(diagnostic).toHaveBeenCalledWith('ok', 'sync-command-received', 'type=pause from=phone');
});

it('is ready once it has read the session, and knows whether another device plays', async () => {
  const { follower, connect } = setup();
  let ready = false;
  void follower.ready(10_000).then(() => { ready = true; });
  await jest.advanceTimersByTimeAsync(0);
  expect(ready).toBe(false);
  await connect();
  expect(ready).toBe(true);
  expect(follower.anotherDevicePlaying()).toBe(true);

  const nobody = setup({}, null);
  await nobody.connect();
  expect(nobody.follower.anotherDevicePlaying()).toBe(false);
  // Without a stream there is nothing to wait for.
  const off = setup({ syncPlaybackAcrossDevices: false });
  await expect(off.follower.ready(10_000)).resolves.toBeUndefined();
});


it('treats a receiver playing the session itself like a casting device in the Cast dialog', async () => {
  const following = sessionOf([1, 2, 3]);
  following.output = { ...following.output!, id: 'receiver:2bc27ebd', kind: 'receiver', castSessionId: '2bc27ebd' };
  const { follower, connect } = setup({}, following);
  await connect();
  expect(follower.castingElsewhere('NAD Forstærker', '2bc27ebd')).toEqual({ outputId: 'receiver:2bc27ebd' });
  expect(follower.castingElsewhere('NAD Forstærker', '3da7d650')).toBeNull();
});

it("does not take its own receiver output for another device's (rejoining its own Cast session)", async () => {
  const mine = sessionOf([1, 2, 3]);
  mine.output = { ...mine.output!, id: 'receiver:2bc27ebd', kind: 'receiver', castSessionId: '2bc27ebd' };
  mine.ownerClientId = 'laptop';
  const { follower, connect } = setup({}, mine);
  await connect();
  expect(follower.castingElsewhere('NAD Forstærker', '2bc27ebd')).toBeNull();
});

it("hands a casting controller the session's newer queue while its receiver follows it (PR E)", async () => {
  const { mirror, connect, adoptCastQueue, source, api } = setup({ castConnected: true, playbackState: 'playing' });
  await connect();
  expect(adoptCastQueue).not.toHaveBeenCalled(); // the mirror said no

  const newer = sessionOf([1, 2, 3, 4]);
  newer.revision = 30;
  api.getPlaybackSession.mockResolvedValueOnce(newer);
  mirror.noteSessionChanged.mockImplementation((session: PlaybackSession) => session.revision === 30);
  source().emit('playbackSession.updated', { sessionId: 'session-1', revision: 30 });
  await jest.advanceTimersByTimeAsync(0);
  expect(mirror.noteSessionChanged).toHaveBeenLastCalledWith(newer);
  expect(adoptCastQueue).toHaveBeenCalledWith(newer);
});

describe('queue edits on an idle device following a receiver (Phase 5)', () => {
  const receiverSession = () => {
    const session = sessionOf([1, 2, 3]);
    session.output = { ...session.output!, id: 'receiver:cast-77', kind: 'receiver', castSessionId: 'cast-77' };
    return session;
  };
  const track = (n: number): TrackInfo => ({ id: `track-${n}`, path: `track-${n}`, duration: 200, queueEntryId: uuid(n) });

  it('sends Play next, remove and reorder to the session as anchored edits', async () => {
    const { api, store, connect } = setup({}, receiverSession());
    await connect();
    expect(store.getState().playlist.map((t) => t.queueEntryId)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(api.patchPlaybackSession).not.toHaveBeenCalled(); // taking the session's queue is not an edit

    store.setState({ playlist: [track(1), track(2), track(9), track(3)] }); // Play next
    await jest.advanceTimersByTimeAsync(250);
    expect(api.patchPlaybackSession).toHaveBeenCalledWith(expect.anything(), 'session-1', {
      expectedRevision: 12, requestId: expect.any(String),
      operations: [{ type: 'insert', afterEntryId: uuid(2), trackIds: ['track-9'], entryIds: [uuid(9)] }],
    });
  });

  it('sends a quick run of edits as one patch', async () => {
    const { api, store, connect } = setup({}, receiverSession());
    await connect();
    store.setState({ playlist: [track(1), track(3)] });
    await jest.advanceTimersByTimeAsync(100);
    store.setState({ playlist: [track(3), track(1)] });
    await jest.advanceTimersByTimeAsync(250);
    expect(api.patchPlaybackSession).toHaveBeenCalledTimes(1);
  });

  it('sends the same edit again once when a newer change won, and shows the session when it cannot apply', async () => {
    const { api, store, connect } = setup({}, receiverSession());
    await connect();
    const newer = { ...receiverSession(), revision: 15 };
    api.patchPlaybackSession.mockRejectedValueOnce(new AuroraApiError('conflict', 409, 'REVISION_CONFLICT', undefined, { current: newer }));
    store.setState({ playlist: [track(1), track(3)] });
    await jest.advanceTimersByTimeAsync(250);
    expect(api.patchPlaybackSession).toHaveBeenCalledTimes(2);
    expect(api.patchPlaybackSession.mock.calls[1][2]).toMatchObject({ expectedRevision: 15, operations: [{ type: 'remove', queueEntryIds: [uuid(2)] }] });

    const gone = { ...receiverSession(), revision: 20, queue: receiverSession().queue.slice(0, 1) };
    api.patchPlaybackSession.mockRejectedValueOnce(new AuroraApiError('anchor', 409, 'ANCHOR_NOT_FOUND', undefined, { current: gone }));
    store.setState({ playlist: [track(1), track(7)] });
    await jest.advanceTimersByTimeAsync(250);
    expect(store.getState().playlist.map((t) => t.queueEntryId)).toEqual([uuid(1)]);
  });

  it('keeps edits on this device when it follows a browser or Cast output, or casts itself', async () => {
    const browser = setup();
    await browser.connect();
    browser.store.setState({ playlist: [track(1), track(3)] });
    await jest.advanceTimersByTimeAsync(250);
    expect(browser.api.patchPlaybackSession).not.toHaveBeenCalled();

    const casting = setup({ castConnected: true }, receiverSession());
    await casting.connect();
    casting.store.setState({ playlist: [track(1), track(3)] });
    await jest.advanceTimersByTimeAsync(250);
    expect(casting.api.patchPlaybackSession).not.toHaveBeenCalled();
  });

  it('does not stop the receiver by clearing the queue here', async () => {
    const { api, store, connect } = setup({}, receiverSession());
    await connect();
    store.setState({ playlist: [] });
    await jest.advanceTimersByTimeAsync(250);
    expect(api.patchPlaybackSession).not.toHaveBeenCalled();
  });
});
