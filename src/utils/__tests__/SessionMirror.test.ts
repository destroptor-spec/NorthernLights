import { createStore } from 'zustand/vanilla';
import type { PlaybackSession, PlaybackSessionPatch } from '../../../shared/api/v1';
import { AuroraApiError } from '../../api/auroraApi';
import type * as sessionApi from '../../api/playbackSessions';
import { isSameCastDevice, SessionMirror, REPORT_INTERVAL_PAUSED_MS, REPORT_INTERVAL_PLAYING_MS, type MirroredPlayerState } from '../SessionMirror';
import type { TrackInfo } from '../fileSystem';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const track = (n: number, entryId: string = uuid(n)): TrackInfo => ({ id: `track-${n}`, path: `p${n}`, queueEntryId: entryId });

const sessionOf = (tracks: TrackInfo[], revision: number, extra: Partial<PlaybackSession> = {}): PlaybackSession => ({
  id: 'session-1',
  name: 'Listening',
  ownerClientId: 'phone',
  output: null,
  currentEntryId: tracks[0]?.queueEntryId ?? null,
  positionMs: 0,
  playbackState: 'paused',
  repeatMode: 'none',
  shuffle: false,
  source: null,
  revision,
  queue: tracks.map((t, position) => ({
    queueEntryId: t.queueEntryId!,
    position,
    track: { id: t.id } as PlaybackSession['queue'][number]['track'],
    addedAt: '2026-10-13T10:00:00.000Z',
  })),
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T10:00:00.000Z',
  ...extra,
});

const credential = { token: 'output-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), outputId: 'phone', generation: 1 };

function setup(initial: Partial<MirroredPlayerState> = {}, existing: PlaybackSession[] = []) {
  let revision = 1;
  const api = {
    listPlaybackSessions: jest.fn(async () => existing),
    createPlaybackSession: jest.fn(async () => sessionOf([], revision)),
    claimPlaybackOutput: jest.fn(async (..._args: unknown[]) => ({ session: sessionOf([], ++revision), credential })),
    patchPlaybackSession: jest.fn(async (_auth: unknown, _sessionId: string, _patch: PlaybackSessionPatch) => sessionOf(store.getState().playlist, ++revision)),
    refreshOutputCredential: jest.fn(async () => credential),
    reportPlaybackOutput: jest.fn(async () => ({ accepted: true, revision })),
  };
  const store = createStore<MirroredPlayerState>(() => ({
    syncPlaybackAcrossDevices: true,
    currentUser: { id: 'user-1' },
    playlist: [track(1), track(2), track(3)],
    currentIndex: 0,
    repeat: 'none',
    shuffle: false,
    playbackState: 'paused',
    isBuffering: false,
    castConnected: false,
    getAuthHeader: () => ({ Authorization: 'Bearer user-token' }),
    ...initial,
  }));
  const mirror = new SessionMirror();
  let position = 41;
  const onDisplaced = jest.fn();
  const onSyncDisabled = jest.fn();
  mirror.start(store, {
    onSyncDisabled,
    api: api as unknown as typeof sessionApi,
    getPositionSeconds: () => position,
    getOutputName: () => 'Chrome on Android',
    onDisplaced,
  });
  return { api, store, mirror, onDisplaced, onSyncDisabled, setPosition: (seconds: number) => { position = seconds; } };
}

const play = async (store: ReturnType<typeof setup>['store']) => {
  store.setState({ playbackState: 'playing' });
  await jest.advanceTimersByTimeAsync(0);
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('does nothing while the setting is off', async () => {
  const { api, store } = setup({ syncPlaybackAcrossDevices: false });
  await play(store);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(Object.values(api).every((fn) => fn.mock.calls.length === 0)).toBe(true);
});

it('on play, creates the session, claims the output, mirrors the queue and reports', async () => {
  const { api, store } = setup();
  await play(store);
  expect(api.createPlaybackSession).toHaveBeenCalledTimes(1);
  expect(api.claimPlaybackOutput).toHaveBeenCalledWith(expect.anything(), 'session-1', { kind: 'browser', name: 'Chrome on Android' });
  expect(api.patchPlaybackSession).toHaveBeenCalledWith(expect.anything(), 'session-1', expect.objectContaining({
    expectedRevision: 2,
    requestId: expect.any(String),
    operations: [{ type: 'replaceQueue', trackIds: ['track-1', 'track-2', 'track-3'], entryIds: [uuid(1), uuid(2), uuid(3)], currentIndex: 0 }],
  }));
  expect(api.reportPlaybackOutput).toHaveBeenCalledWith(credential, 'session-1', { seq: 1, state: 'playing', queueEntryId: uuid(1), positionMs: 41000 });
});

it('claims as a Cast output while casting, under the Cast device name', async () => {
  const { api, store } = setup({ castConnected: true });
  await play(store);
  expect(api.claimPlaybackOutput).toHaveBeenCalledWith(expect.anything(), 'session-1', { kind: 'cast', name: 'Chrome on Android' });
});

it("reuses the user's latest session instead of creating one", async () => {
  const { api, store } = setup({}, [sessionOf([], 7, { id: 'latest' })]);
  await play(store);
  expect(api.createPlaybackSession).not.toHaveBeenCalled();
  expect(api.claimPlaybackOutput).toHaveBeenCalledWith(expect.anything(), 'latest', expect.anything());
});

it('sends later queue edits as one anchored patch per burst', async () => {
  const { api, store } = setup();
  await play(store);
  api.patchPlaybackSession.mockClear();
  store.setState((state) => ({ playlist: [...state.playlist, track(4)] }));
  store.setState((state) => ({ playlist: [...state.playlist, track(5)] }));
  await jest.advanceTimersByTimeAsync(300);
  expect(api.patchPlaybackSession).toHaveBeenCalledTimes(1);
  expect(api.patchPlaybackSession.mock.calls[0][2]).toMatchObject({
    expectedRevision: 3,
    operations: [{ type: 'insert', afterEntryId: uuid(3), trackIds: ['track-4', 'track-5'], entryIds: [uuid(4), uuid(5)] }],
  });
});

it('mirrors repeat and shuffle', async () => {
  const { api, store } = setup();
  await play(store);
  api.patchPlaybackSession.mockClear();
  store.setState({ repeat: 'all' });
  await jest.advanceTimersByTimeAsync(300);
  expect(api.patchPlaybackSession.mock.calls[0][2].operations).toEqual([{ type: 'setTransport', repeatMode: 'all', shuffle: false }]);
});

it('on a conflict, plans again from the session the server sent back', async () => {
  const { api, store } = setup();
  await play(store);
  const current = sessionOf([track(1), track(2), track(3)], 9);
  api.patchPlaybackSession.mockClear();
  api.patchPlaybackSession.mockRejectedValueOnce(new AuroraApiError('changed', 409, 'REVISION_CONFLICT', 'r', { current }));
  store.setState((state) => ({ playlist: [...state.playlist, track(4)] }));
  await jest.advanceTimersByTimeAsync(300);
  expect(api.patchPlaybackSession).toHaveBeenCalledTimes(2);
  expect(api.patchPlaybackSession.mock.calls[1][2]).toMatchObject({
    expectedRevision: 9,
    operations: [{ type: 'insert', afterEntryId: uuid(3), trackIds: ['track-4'] }],
  });
});

it('retries a patch whose answer was lost with the same requestId', async () => {
  const { api, store } = setup();
  await play(store);
  api.patchPlaybackSession.mockClear();
  api.patchPlaybackSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  store.setState((state) => ({ playlist: [...state.playlist, track(4)] }));
  await jest.advanceTimersByTimeAsync(300);
  await jest.advanceTimersByTimeAsync(5_000);
  expect(api.patchPlaybackSession).toHaveBeenCalledTimes(2);
  expect(api.patchPlaybackSession.mock.calls[1][2].requestId).toBe(api.patchPlaybackSession.mock.calls[0][2].requestId);
});

it('reports every 10 s while playing and every 30 s while paused', async () => {
  const { api, store, setPosition } = setup();
  await play(store);
  api.reportPlaybackOutput.mockClear();
  setPosition(51);
  await jest.advanceTimersByTimeAsync(REPORT_INTERVAL_PLAYING_MS);
  expect(api.reportPlaybackOutput).toHaveBeenLastCalledWith(credential, 'session-1', { seq: 2, state: 'playing', queueEntryId: uuid(1), positionMs: 51000 });

  store.setState({ playbackState: 'paused' });
  await jest.advanceTimersByTimeAsync(300);
  expect(api.reportPlaybackOutput).toHaveBeenLastCalledWith(credential, 'session-1', expect.objectContaining({ seq: 3, state: 'paused' }));
  await jest.advanceTimersByTimeAsync(REPORT_INTERVAL_PLAYING_MS);
  expect(api.reportPlaybackOutput).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(REPORT_INTERVAL_PAUSED_MS - REPORT_INTERVAL_PLAYING_MS);
  expect(api.reportPlaybackOutput).toHaveBeenCalledTimes(3);
});

it('reports a track change straight away', async () => {
  const { api, store } = setup();
  await play(store);
  api.reportPlaybackOutput.mockClear();
  store.setState({ currentIndex: 1 });
  await jest.advanceTimersByTimeAsync(300);
  expect(api.reportPlaybackOutput).toHaveBeenCalledWith(credential, 'session-1', expect.objectContaining({ queueEntryId: uuid(2) }));
});

it('stops when another device takes the output, until Play is pressed here', async () => {
  const { api, store, mirror } = setup();
  await play(store);
  api.reportPlaybackOutput.mockRejectedValueOnce(new AuroraApiError('replaced', 409, 'OUTPUT_GRANT_REPLACED'));
  await jest.advanceTimersByTimeAsync(REPORT_INTERVAL_PLAYING_MS);
  api.reportPlaybackOutput.mockClear();
  api.patchPlaybackSession.mockClear();
  api.claimPlaybackOutput.mockClear();

  store.setState((state) => ({ playlist: [...state.playlist, track(4)] }));
  store.setState({ playbackState: 'paused' });
  store.setState({ playbackState: 'playing' });
  await jest.advanceTimersByTimeAsync(60_000);
  expect(api.claimPlaybackOutput).not.toHaveBeenCalled();
  expect(api.patchPlaybackSession).not.toHaveBeenCalled();
  expect(api.reportPlaybackOutput).not.toHaveBeenCalled();

  mirror.notePlayIntent();
  await jest.advanceTimersByTimeAsync(0);
  expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(1);
});

it('claims again under the Cast device name when casting starts', async () => {
  const { api, store } = setup();
  await play(store);
  store.setState({ castConnected: true });
  await jest.advanceTimersByTimeAsync(0);
  expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(2);
});

it('does not mirror a queue still keyed for a rejoinable Cast session', async () => {
  const { api, store } = setup({ playlist: [track(1, 'queue-1-abc'), track(2)] });
  await play(store);
  expect(api.claimPlaybackOutput).toHaveBeenCalled();
  expect(api.patchPlaybackSession).not.toHaveBeenCalled();
  expect(api.reportPlaybackOutput).toHaveBeenCalledWith(credential, 'session-1', expect.objectContaining({ queueEntryId: null }));
});

it('stops mirroring a queue with a track the server does not have', async () => {
  const { api, store } = setup();
  api.patchPlaybackSession.mockRejectedValueOnce(new AuroraApiError('missing', 409, 'TRACKS_UNAVAILABLE', 'r', { missingIds: ['track-2'] }));
  await play(store);
  api.patchPlaybackSession.mockClear();
  store.setState((state) => ({ playlist: [...state.playlist, track(4)] }));
  await jest.advanceTimersByTimeAsync(300);
  expect(api.patchPlaybackSession).not.toHaveBeenCalled();

  store.setState({ playlist: [track(1), track(3), track(4)] });
  await jest.advanceTimersByTimeAsync(300);
  expect(api.patchPlaybackSession).toHaveBeenCalledTimes(1);
});

it('lets go when the setting is turned off or the user signs out', async () => {
  const { api, store } = setup();
  await play(store);
  store.setState({ syncPlaybackAcrossDevices: false });
  api.reportPlaybackOutput.mockClear();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(api.reportPlaybackOutput).not.toHaveBeenCalled();

  store.setState({ syncPlaybackAcrossDevices: true });
  await jest.advanceTimersByTimeAsync(0);
  expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(2);
  store.setState({ currentUser: null });
  api.reportPlaybackOutput.mockClear();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(api.reportPlaybackOutput).not.toHaveBeenCalled();
});

it('tries the claim again while still playing after it failed', async () => {
  const { api, store } = setup();
  api.listPlaybackSessions.mockRejectedValueOnce(new TypeError('Failed to fetch'));
  await play(store);
  expect(api.claimPlaybackOutput).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(30_000);
  expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(1);
});

describe('another device claiming the output', () => {
  it('stops this device when the claim is newer than its own', async () => {
    const { api, store, mirror, onDisplaced } = setup();
    await play(store);
    expect(mirror.holdsOutput()).toBe(true);

    await mirror.noteReplaced('session-1', credential.generation);
    expect(onDisplaced).not.toHaveBeenCalled();

    await mirror.noteReplaced('session-1', credential.generation + 1);
    expect(onDisplaced).toHaveBeenCalledTimes(1);
    expect(mirror.holdsOutput()).toBe(false);
    api.reportPlaybackOutput.mockClear();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(api.reportPlaybackOutput).not.toHaveBeenCalled();
  });

  it('waits for its own claim in flight before deciding', async () => {
    const { api, store, mirror, onDisplaced } = setup();
    let finishClaim: () => void = () => undefined;
    api.claimPlaybackOutput.mockImplementationOnce(() => new Promise((resolve) => {
      finishClaim = () => resolve({ session: sessionOf([], 5), credential: { ...credential, generation: 4 } });
    }));
    await play(store);
    const decided = mirror.noteReplaced('session-1', 3);
    finishClaim();
    await decided;
    expect(onDisplaced).not.toHaveBeenCalled();
    expect(mirror.holdsOutput()).toBe(true);
  });

  it('stops a device that plays without a grant (its claim failed) and does not claim again by itself', async () => {
    const { api, store, mirror, onDisplaced } = setup();
    api.claimPlaybackOutput.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await play(store);
    await mirror.noteReplaced('session-1', 9);
    expect(onDisplaced).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(1);
  });

  it('leaves an idle device alone', async () => {
    const { mirror, onDisplaced } = setup();
    await mirror.noteReplaced('session-1', 9);
    expect(onDisplaced).not.toHaveBeenCalled();
  });
});

it('stops at once, without retrying, when the server says sync is off for the account', async () => {
  const { api, store, mirror, onSyncDisabled } = setup();
  api.claimPlaybackOutput.mockRejectedValueOnce(new AuroraApiError('off', 403, 'PLAYBACK_SYNC_DISABLED'));
  await play(store);
  expect(onSyncDisabled).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(120_000);
  expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(1);

  // Turned off while this device held the output: the next report stops it.
  api.claimPlaybackOutput.mockClear();
  mirror.notePlayIntent();
  await jest.advanceTimersByTimeAsync(0);
  expect(mirror.holdsOutput()).toBe(true);
  api.reportPlaybackOutput.mockRejectedValueOnce(new AuroraApiError('off', 403, 'PLAYBACK_SYNC_DISABLED'));
  await jest.advanceTimersByTimeAsync(REPORT_INTERVAL_PLAYING_MS);
  expect(mirror.holdsOutput()).toBe(false);
  expect(onSyncDisabled).toHaveBeenCalledTimes(2);
});

/**
 * Prod 2026-10-13 19:50: the phone cast to the NAD, then the desktop joined
 * the same Cast session and, playing, claimed the output. The music never
 * moved, so the phone must not pause the NAD.
 */
describe('a take-over on the same Cast device', () => {
  it('is told apart by kind and Cast device name', () => {
    const nad = { kind: 'cast', name: 'NAD Forstærker' };
    expect(isSameCastDevice(nad, true, 'NAD Forstærker')).toBe(true);
    expect(isSameCastDevice(nad, false, 'NAD Forstærker')).toBe(false);
    expect(isSameCastDevice(nad, true, 'Stue TV')).toBe(false);
    expect(isSameCastDevice({ kind: 'browser', name: 'NAD Forstærker' }, true, 'NAD Forstærker')).toBe(false);
    expect(isSameCastDevice(null, true, 'NAD Forstærker')).toBe(false);
    expect(isSameCastDevice({ kind: 'cast', name: null }, true, '')).toBe(false);
  });

  it('passes the replacing output on from the event and from a refused report', async () => {
    const { api, store, mirror, onDisplaced } = setup();
    await play(store);
    await mirror.noteReplaced('session-1', credential.generation + 1, { kind: 'cast', name: 'NAD Forstærker' });
    expect(onDisplaced).toHaveBeenCalledWith({ kind: 'cast', name: 'NAD Forstærker' });

    mirror.notePlayIntent();
    await jest.advanceTimersByTimeAsync(0);
    const current = sessionOf([], 9, { output: { id: 'desktop', kind: 'cast', name: 'NAD Forstærker', generation: 7, claimedAt: '2026-10-13T19:50:38.000Z', status: 'active', report: null } });
    api.reportPlaybackOutput.mockRejectedValueOnce(new AuroraApiError('replaced', 409, 'OUTPUT_GRANT_REPLACED', undefined, { current }));
    await jest.advanceTimersByTimeAsync(REPORT_INTERVAL_PLAYING_MS);
    expect(onDisplaced).toHaveBeenLastCalledWith(current.output);
  });
});

it('names the grant it holds, for remote commands', async () => {
  const { store, mirror } = setup();
  expect(mirror.currentGrant()).toBeNull();
  await play(store);
  expect(mirror.currentGrant()).toEqual({ sessionId: 'session-1', outputId: 'phone', generation: 1 });
});

/**
 * Prod 2026-10-13: the desktop controlled the phone; the phone was paused and
 * its app closed. The desktop went on sending commands into the void until
 * the server called the phone unreachable a minute later.
 */
describe('closing the page', () => {
  it('reports "stopped" with keepalive while this device plays the session', async () => {
    const { api, store } = setup();
    await play(store);
    api.reportPlaybackOutput.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    expect(api.reportPlaybackOutput).toHaveBeenCalledWith(credential, 'session-1',
      expect.objectContaining({ state: 'stopped', reason: 'closed', queueEntryId: uuid(1) }), { keepalive: true });
  });

  it('reports nothing while casting (the Cast device plays on) or without the output', async () => {
    const idle = setup();
    window.dispatchEvent(new Event('pagehide'));
    expect(idle.api.reportPlaybackOutput).not.toHaveBeenCalled();
    idle.mirror.stop();

    const casting = setup({ castConnected: true });
    await play(casting.store);
    casting.api.reportPlaybackOutput.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    expect(casting.api.reportPlaybackOutput).not.toHaveBeenCalled();
    casting.mirror.stop();
  });
});

it('reports right after a remote command, even when nothing visible changed', async () => {
  const { api, store, mirror } = setup();
  await play(store);
  api.reportPlaybackOutput.mockClear();
  mirror.reportNow();
  // At once: a background tab's timers may be stretched far beyond 300 ms.
  expect(api.reportPlaybackOutput).toHaveBeenCalledTimes(1);
});

