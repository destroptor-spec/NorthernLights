import { createStore } from 'zustand/vanilla';
import type { PlaybackSession, PlaybackSessionPatch } from '../../../shared/api/v1';
import { AuroraApiError } from '../../api/auroraApi';
import type * as sessionApi from '../../api/playbackSessions';
import { actionWhenReplaced, CAST_KIND_SETTLE_MS, isSameCastDevice, SessionMirror, REPORT_INTERVAL_PAUSED_MS, REPORT_INTERVAL_PLAYING_MS, type MirroredPlayerState } from '../SessionMirror';
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
  infinity: false,
  source: null,
  revision,
  queue: tracks.map((t, position) => ({
    queueEntryId: t.queueEntryId!,
    position,
    track: { id: t.id } as PlaybackSession['queue'][number]['track'],
    addedAt: '2026-10-13T10:00:00.000Z',
    addedBy: (t.isInfinity ? 'infinity' : 'user') as 'infinity' | 'user',
  })),
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T10:00:00.000Z',
  ...extra,
});

const credential = { token: 'output-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), outputId: 'phone', generation: 1 };

function setup(initial: Partial<MirroredPlayerState> = {}, existing: PlaybackSession[] = [], extraOptions: Partial<import('../SessionMirror').SessionMirrorOptions> = {}) {
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
    ...extraOptions,
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

it('names its Cast session in the claim, and claims again when that session changes', async () => {
  const { api, store, mirror } = setup({ castConnected: true }, [], { getCastSessionId: () => castSessionId });
  let castSessionId = '2bc27ebd';
  await play(store);
  expect(api.claimPlaybackOutput).toHaveBeenLastCalledWith(expect.anything(), 'session-1', { kind: 'cast', name: 'Chrome on Android', castSessionId: '2bc27ebd' });
  castSessionId = 'd7ad4a51';
  mirror.noteCastSessionChanged();
  await jest.advanceTimersByTimeAsync(0);
  expect(api.claimPlaybackOutput).toHaveBeenLastCalledWith(expect.anything(), 'session-1', { kind: 'cast', name: 'Chrome on Android', castSessionId: 'd7ad4a51' });
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

it('claims again under the Cast device name when casting starts, once it has settled', async () => {
  const { api, store } = setup();
  await play(store);
  store.setState({ castConnected: true });
  await jest.advanceTimersByTimeAsync(0);
  expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(CAST_KIND_SETTLE_MS);
  expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(2);
  expect(api.claimPlaybackOutput).toHaveBeenLastCalledWith(expect.anything(), 'session-1', expect.objectContaining({ kind: 'cast' }));
});

describe('a Cast connection that blinks off and on (stale-transport recovery)', () => {
  it('does not claim at all when casting comes back within a second', async () => {
    const { api, store } = setup({ castConnected: true });
    await play(store);
    expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(1);
    store.setState({ castConnected: false });
    await jest.advanceTimersByTimeAsync(400);
    store.setState({ castConnected: true });
    await jest.advanceTimersByTimeAsync(CAST_KIND_SETTLE_MS * 2);
    expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(1);
  });

  it('claims as a Cast output again when casting came back while a claim was on its way', async () => {
    // Prod 2026-10-16 08:43:01, Beoplay A9: the claim made in the blink said
    // browser and nothing corrected it.
    const { api, store } = setup({ castConnected: false });
    let answer: (value: unknown) => void = () => undefined;
    api.claimPlaybackOutput.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }) as never);
    store.setState({ playbackState: 'playing' });
    await jest.advanceTimersByTimeAsync(0);
    expect(api.claimPlaybackOutput).toHaveBeenLastCalledWith(expect.anything(), 'session-1', expect.objectContaining({ kind: 'browser' }));
    store.setState({ castConnected: true }); // while the browser claim is still on its way
    answer({ session: sessionOf([], 2), credential });
    await jest.advanceTimersByTimeAsync(CAST_KIND_SETTLE_MS);
    expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(2);
    expect(api.claimPlaybackOutput).toHaveBeenLastCalledWith(expect.anything(), 'session-1', expect.objectContaining({ kind: 'cast' }));
  });
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
    // A receiver playing the session itself is the same Cast device too.
    expect(isSameCastDevice({ kind: 'receiver', name: 'NAD Forstærker' }, true, 'NAD Forstærker')).toBe(true);
    expect(isSameCastDevice({ kind: 'receiver', name: 'Stue TV' }, true, 'NAD Forstærker')).toBe(false);
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

it('tells the server log about claims, being replaced and closing', async () => {
  const diagnostic = jest.fn();
  const { store, mirror } = setup({}, [], { diagnostic });
  await play(store);
  expect(diagnostic).toHaveBeenCalledWith('ok', 'sync-claimed', expect.stringContaining('kind=browser generation=1'));
  window.dispatchEvent(new Event('pagehide'));
  expect(diagnostic).toHaveBeenCalledWith('ok', 'sync-closing', 'state=playing');
  await mirror.noteReplaced('session-1', 5, { kind: 'cast', name: 'NAD Forstærker' });
  expect(diagnostic).toHaveBeenCalledWith('ok', 'sync-replaced', 'by=cast:NAD Forstærker wasPlaying=true');
  mirror.stop();
});

it('does not claim while this device is leaving another device\'s Cast session', async () => {
  const diagnostic = jest.fn();
  const { api, store } = setup({ castConnected: true }, [], { canClaim: () => false, diagnostic });
  await play(store);
  expect(api.claimPlaybackOutput).not.toHaveBeenCalled();
  expect(diagnostic).toHaveBeenCalledWith('ok', 'sync-claim-skipped', 'reason=leaving-joined-cast-session');
});

/**
 * Prod 2026-10-13: the desktop cast to the NAD, the phone took over and played
 * itself. The desktop paused the NAD but stayed connected, so it never
 * followed and kept showing its old queue. Andreas: stop casting, then follow.
 */
describe('actionWhenReplaced', () => {
  const nad = { kind: 'cast', name: 'NAD Forstærker' };
  const phone = { kind: 'browser', name: 'Chrome on Android' };
  it('leaves the music alone when the other device casts to the same Cast device', () => {
    expect(actionWhenReplaced({ replacement: nad, castConnected: true, castDeviceName: 'NAD Forstærker', playing: true })).toBe('none');
  });
  it('stops casting when the other device plays elsewhere, playing or paused', () => {
    expect(actionWhenReplaced({ replacement: phone, castConnected: true, castDeviceName: 'NAD Forstærker', playing: true })).toBe('stop-casting');
    expect(actionWhenReplaced({ replacement: phone, castConnected: true, castDeviceName: 'NAD Forstærker', playing: false })).toBe('stop-casting');
    expect(actionWhenReplaced({ replacement: { kind: 'cast', name: 'Stue TV' }, castConnected: true, castDeviceName: 'NAD Forstærker', playing: true })).toBe('stop-casting');
  });
  it('only pauses while casting when it does not know who took over', () => {
    expect(actionWhenReplaced({ replacement: null, castConnected: true, castDeviceName: 'NAD Forstærker', playing: true })).toBe('pause');
  });
  it('pauses local playback, and does nothing when nothing plays', () => {
    expect(actionWhenReplaced({ replacement: phone, castConnected: false, castDeviceName: '', playing: true })).toBe('pause');
    expect(actionWhenReplaced({ replacement: phone, castConnected: false, castDeviceName: '', playing: false })).toBe('none');
  });
});


describe('a receiver that plays the session on its own (Phase 5)', () => {
  const receiverCredential = {
    token: 'receiver-token', expiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
    renewableUntil: new Date(Date.now() + 24 * 3_600_000).toISOString(), outputId: 'receiver:cast-77', generation: 2,
  };
  const castSetup = (options: { canFollow?: boolean; takes?: boolean } = {}) => {
    let canFollow = options.canFollow ?? true;
    const handOverToReceiver = jest.fn(async () => options.takes ?? true);
    const diagnostic = jest.fn();
    const harness = setup({ castConnected: true }, [], {
      getCastSessionId: () => 'cast-77',
      receiverCanFollow: () => canFollow,
      handOverToReceiver,
      diagnostic,
    });
    let generation = 0;
    harness.api.claimPlaybackOutput.mockImplementation(async (...args: unknown[]) => {
      const claim = args[2] as { kind: string };
      generation += 1;
      return {
        session: sessionOf([], generation + 1),
        credential: claim.kind === 'receiver' ? { ...receiverCredential, generation } : { ...credential, generation },
      };
    });
    return { ...harness, handOverToReceiver, diagnostic, setCanFollow: (value: boolean) => { canFollow = value; } };
  };

  it('claims the output for the receiver, hands it over, and leaves the reporting to it', async () => {
    const { api, store, handOverToReceiver } = castSetup();
    await play(store);
    expect(api.claimPlaybackOutput).toHaveBeenCalledWith(expect.anything(), 'session-1', { kind: 'receiver', name: 'Chrome on Android', castSessionId: 'cast-77' });
    expect(handOverToReceiver).toHaveBeenCalledWith({
      sessionId: 'session-1', outputId: 'receiver:cast-77', generation: 1, token: 'receiver-token',
      expiresAt: receiverCredential.expiresAt, renewableUntil: receiverCredential.renewableUntil,
    }, 'claim');
    // Queue edits still go to the session; reports come from the receiver.
    expect(api.patchPlaybackSession).toHaveBeenCalled();
    store.setState({ playbackState: 'paused', currentIndex: 1 });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(api.reportPlaybackOutput).not.toHaveBeenCalled();
  });

  it('hands over to a receiver that says it can follow once casting has started', async () => {
    const { api, store, mirror, handOverToReceiver, setCanFollow } = castSetup({ canFollow: false });
    await play(store);
    expect(api.claimPlaybackOutput).toHaveBeenLastCalledWith(expect.anything(), 'session-1', expect.objectContaining({ kind: 'cast' }));
    setCanFollow(true);
    mirror.noteReceiverCanFollow();
    await jest.advanceTimersByTimeAsync(0);
    expect(api.claimPlaybackOutput).toHaveBeenLastCalledWith(expect.anything(), 'session-1', expect.objectContaining({ kind: 'receiver', castSessionId: 'cast-77' }));
    expect(handOverToReceiver).toHaveBeenCalledTimes(1);
  });

  it('hands over after its own first claim when the receiver says it can follow during it', async () => {
    // Prod 2026-10-16 19:44:43, phone: the claim was still mirroring the
    // queue when the receiver's status came, and the handover never happened.
    const { api, store, mirror, handOverToReceiver, setCanFollow } = castSetup({ canFollow: false });
    let finishPatch: () => void = () => undefined;
    api.patchPlaybackSession.mockImplementationOnce(() => new Promise((resolve) => {
      finishPatch = () => resolve(sessionOf(store.getState().playlist, 3));
    }) as never);
    store.setState({ playbackState: 'playing' });
    await jest.advanceTimersByTimeAsync(0);
    expect(api.claimPlaybackOutput).toHaveBeenLastCalledWith(expect.anything(), 'session-1', expect.objectContaining({ kind: 'cast' }));
    setCanFollow(true);
    mirror.noteReceiverCanFollow(); // while the first claim is still mirroring
    finishPatch();
    await jest.advanceTimersByTimeAsync(0);
    expect(api.claimPlaybackOutput).toHaveBeenLastCalledWith(expect.anything(), 'session-1', expect.objectContaining({ kind: 'receiver' }));
    expect(handOverToReceiver).toHaveBeenCalledTimes(1);
  });

  it('casts as today when the receiver does not take the session', async () => {
    const { api, store, mirror, handOverToReceiver, diagnostic } = castSetup({ takes: false });
    await play(store);
    await jest.advanceTimersByTimeAsync(0);
    expect(handOverToReceiver).toHaveBeenCalledTimes(1);
    expect(diagnostic).toHaveBeenCalledWith('warn', 'sync-receiver-handover-failed', 'generation=1');
    expect(api.claimPlaybackOutput).toHaveBeenLastCalledWith(expect.anything(), 'session-1', expect.objectContaining({ kind: 'cast' }));
    expect(api.reportPlaybackOutput).toHaveBeenCalled();
    // Not again for this Cast session.
    mirror.noteReceiverCanFollow();
    await jest.advanceTimersByTimeAsync(0);
    expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(2);
    expect(handOverToReceiver).toHaveBeenCalledTimes(1);
  });

  it('hands every renewed credential to the receiver, and renews on waking', async () => {
    const { api, store, mirror, handOverToReceiver } = castSetup();
    await play(store);
    api.refreshOutputCredential.mockResolvedValue({ ...receiverCredential, token: 'renewed', generation: 1 });
    mirror.noteWake();
    await jest.advanceTimersByTimeAsync(0);
    expect(api.refreshOutputCredential).toHaveBeenCalledWith(expect.anything(), 'session-1', { outputId: 'receiver:cast-77', generation: 1 });
    expect(handOverToReceiver).toHaveBeenLastCalledWith(expect.objectContaining({ token: 'renewed' }), 'refresh');
    // At most once a minute.
    mirror.noteWake();
    await jest.advanceTimersByTimeAsync(0);
    expect(api.refreshOutputCredential).toHaveBeenCalledTimes(1);
  });

  it('does not renew on waking while it holds a cast or browser output', async () => {
    const { api, store, mirror } = setup();
    await play(store);
    mirror.noteWake();
    await jest.advanceTimersByTimeAsync(0);
    expect(api.refreshOutputCredential).not.toHaveBeenCalled();
  });

  it('lets the receiver play on when this device leaves, and claims only when it plays itself', async () => {
    const { api, store, mirror } = castSetup();
    await play(store);
    store.setState({ castConnected: false, playbackState: 'paused' });
    await jest.advanceTimersByTimeAsync(CAST_KIND_SETTLE_MS);
    expect(mirror.holdsOutput()).toBe(false);
    expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(1);

    store.setState({ playbackState: 'playing' });
    await jest.advanceTimersByTimeAsync(0);
    expect(api.claimPlaybackOutput).toHaveBeenLastCalledWith(expect.anything(), 'session-1', { kind: 'browser', name: 'Chrome on Android' });
  });

  it('takes the music back here when casting ends into local playback', async () => {
    const { api, store } = castSetup();
    await play(store);
    store.setState({ castConnected: false, playbackState: 'playing' });
    await jest.advanceTimersByTimeAsync(CAST_KIND_SETTLE_MS);
    expect(api.claimPlaybackOutput).toHaveBeenLastCalledWith(expect.anything(), 'session-1', { kind: 'browser', name: 'Chrome on Android' });
  });

  it('keeps the receiver through a Cast connection that blinks off and on', async () => {
    const { api, store, mirror } = castSetup();
    await play(store);
    store.setState({ castConnected: false });
    await jest.advanceTimersByTimeAsync(400);
    store.setState({ castConnected: true });
    await jest.advanceTimersByTimeAsync(CAST_KIND_SETTLE_MS * 2);
    expect(mirror.holdsOutput()).toBe(true);
    expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(1);
  });
});

describe('while the receiver follows the session (Phase 5, PR E)', () => {
  const followingSetup = () => {
    const onReceiverFollowsChanged = jest.fn();
    const adoptSession = jest.fn();
    const handOverToReceiver = jest.fn(async () => true);
    const harness = setup({ castConnected: true }, [], {
      getCastSessionId: () => 'cast-77', receiverCanFollow: () => true, handOverToReceiver, onReceiverFollowsChanged, adoptSession,
    });
    harness.api.claimPlaybackOutput.mockImplementation(async () => ({
      session: sessionOf(harness.store.getState().playlist, 5),
      credential: { token: 'receiver-token', expiresAt: credential.expiresAt, outputId: 'receiver:cast-77', generation: 1 },
    }));
    return { ...harness, onReceiverFollowsChanged, adoptSession };
  };

  it('knows once the receiver took the session, and forgets when the grant goes', async () => {
    const { store, mirror, onReceiverFollowsChanged } = followingSetup();
    await play(store);
    await jest.advanceTimersByTimeAsync(0);
    expect(mirror.receiverFollows()).toBe(true);
    expect(onReceiverFollowsChanged).toHaveBeenLastCalledWith(true);
    store.setState({ castConnected: false, playbackState: 'paused' });
    await jest.advanceTimersByTimeAsync(CAST_KIND_SETTLE_MS);
    expect(mirror.receiverFollows()).toBe(false);
    expect(onReceiverFollowsChanged).toHaveBeenLastCalledWith(false);
  });

  it("takes the session's queue when its own edit can no longer apply, instead of overwriting it", async () => {
    const { api, store, mirror, adoptSession } = followingSetup();
    await play(store);
    await jest.advanceTimersByTimeAsync(0);
    const newer = sessionOf([track(1), track(9)], 9);
    api.patchPlaybackSession.mockRejectedValueOnce(new AuroraApiError('anchor', 409, 'ANCHOR_NOT_FOUND', undefined, { current: newer }));
    store.setState({ playlist: [track(1), track(2)] });
    await jest.advanceTimersByTimeAsync(300);
    expect(adoptSession).toHaveBeenCalledWith(newer);
    // Not planned again from this device's queue.
    const patches = api.patchPlaybackSession.mock.calls.length;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(api.patchPlaybackSession).toHaveBeenCalledTimes(patches);
    expect(mirror.noteSessionChanged(sessionOf([track(1)], 9))).toBe(false); // not newer
  });

  it('takes a newer session only when no edit of its own is on the way', async () => {
    const { store, mirror } = followingSetup();
    await play(store);
    await jest.advanceTimersByTimeAsync(0);
    expect(mirror.noteSessionChanged(sessionOf([track(4)], 20))).toBe(true);
    store.setState({ playlist: [track(4), track(5)] }); // an edit waiting to be sent
    expect(mirror.noteSessionChanged(sessionOf([track(6)], 21))).toBe(false);
    expect(mirror.noteSessionChanged({ ...sessionOf([track(6)], 22), id: 'other' })).toBe(false);
  });

  it('flushes pending edits at once and answers the session that has them', async () => {
    const { api, store, mirror } = followingSetup();
    await play(store);
    await jest.advanceTimersByTimeAsync(0);
    store.setState({ playlist: [...store.getState().playlist, track(8)] });
    const session = await mirror.flushNow();
    expect(api.patchPlaybackSession).toHaveBeenLastCalledWith(expect.anything(), 'session-1', expect.objectContaining({
      operations: [expect.objectContaining({ type: 'insert', entryIds: [uuid(8)] })],
    }));
    expect(session?.queue.map((entry) => entry.queueEntryId)).toContain(uuid(8));
  });

  it('does not follow for a cast or browser output, which still takes in newer sessions (Phase 3)', async () => {
    const { store, mirror } = setup();
    await play(store);
    expect(mirror.receiverFollows()).toBe(false);
    expect(mirror.noteSessionChanged(sessionOf([track(1)], 50))).toBe(true);
  });
});

describe('a receiver that stopped following', () => {
  const receiverCredential = (token: string) => ({
    token, expiresAt: new Date(Date.now() + 12 * 3_600_000).toISOString(),
    renewableUntil: new Date(Date.now() + 24 * 3_600_000).toISOString(), outputId: 'receiver:cast-77', generation: 1,
  });
  const stoppedSetup = () => {
    const handOverToReceiver = jest.fn(async (..._args: unknown[]) => true);
    const diagnostic = jest.fn();
    const harness = setup({ castConnected: true }, [], {
      getCastSessionId: () => 'cast-77', receiverCanFollow: () => true, handOverToReceiver, diagnostic,
    });
    harness.api.claimPlaybackOutput.mockImplementation(async () => ({
      session: sessionOf(harness.store.getState().playlist, 5), credential: receiverCredential('receiver-token'),
    }));
    harness.api.refreshOutputCredential.mockImplementation(async () => receiverCredential('fresh-token'));
    const following = async () => {
      await play(harness.store);
      await jest.advanceTimersByTimeAsync(0);
      expect(harness.mirror.receiverFollows()).toBe(true);
      handOverToReceiver.mockClear();
    };
    return { ...harness, handOverToReceiver, diagnostic, following };
  };

  it('gets a fresh credential from the server, handed over again', async () => {
    const { api, mirror, handOverToReceiver, diagnostic, following } = stoppedSetup();
    await following();
    mirror.noteReceiverFollowState(true);
    expect(api.refreshOutputCredential).not.toHaveBeenCalled();

    mirror.noteReceiverFollowState(false);
    await jest.advanceTimersByTimeAsync(0);
    expect(api.refreshOutputCredential).toHaveBeenCalledWith(expect.anything(), 'session-1', { outputId: 'receiver:cast-77', generation: 1 });
    expect(handOverToReceiver).toHaveBeenCalledWith(expect.objectContaining({ token: 'fresh-token', outputId: 'receiver:cast-77' }), 'refresh');
    expect(diagnostic).toHaveBeenCalledWith('warn', 'sync-receiver-stopped-following', 'generation=1 attempt=1');
  });

  it('at most once a minute, and three times until it follows again', async () => {
    const { api, mirror, diagnostic, following } = stoppedSetup();
    await following();
    for (let status = 0; status < 12; status += 1) {
      mirror.noteReceiverFollowState(false); // a status every 5 s
      await jest.advanceTimersByTimeAsync(5_000);
    }
    expect(api.refreshOutputCredential).toHaveBeenCalledTimes(1);

    for (let minute = 0; minute < 5; minute += 1) {
      mirror.noteReceiverFollowState(false);
      await jest.advanceTimersByTimeAsync(60_000);
    }
    expect(api.refreshOutputCredential).toHaveBeenCalledTimes(3);
    expect(diagnostic.mock.calls.filter(([, marker]) => marker === 'sync-receiver-restart-gave-up')).toHaveLength(1);

    // Following again: a later stop is answered again.
    mirror.noteReceiverFollowState(true);
    mirror.noteReceiverFollowState(false);
    await jest.advanceTimersByTimeAsync(0);
    expect(api.refreshOutputCredential).toHaveBeenCalledTimes(4);
  });

  it('never revives a grant another device replaced', async () => {
    const { api, mirror, handOverToReceiver, onDisplaced, following } = stoppedSetup();
    await following();
    const phone = { id: 'phone-2', kind: 'browser' as const, name: 'Chrome on Android', generation: 2 };
    api.refreshOutputCredential.mockRejectedValueOnce(new AuroraApiError('replaced', 409, 'OUTPUT_GRANT_REPLACED', undefined,
      { current: sessionOf([], 9, { output: phone as unknown as PlaybackSession['output'] }) }));
    mirror.noteReceiverFollowState(false);
    await jest.advanceTimersByTimeAsync(0);
    expect(handOverToReceiver).not.toHaveBeenCalled();
    expect(onDisplaced).toHaveBeenCalled();
    expect(mirror.holdsOutput()).toBe(false);
    expect(api.claimPlaybackOutput).toHaveBeenCalledTimes(1);
  });

  it('asks the server once when a wake and the receiver ask together', async () => {
    const { api, mirror, handOverToReceiver, following } = stoppedSetup();
    await following();
    let answer: (value: ReturnType<typeof receiverCredential>) => void = () => undefined;
    api.refreshOutputCredential.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    mirror.noteReceiverFollowState(false);
    mirror.noteWake();
    answer(receiverCredential('fresh-token'));
    await jest.advanceTimersByTimeAsync(0);
    expect(api.refreshOutputCredential).toHaveBeenCalledTimes(1);
    expect(handOverToReceiver).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a cast or browser output', async () => {
    const { api, store, mirror } = setup();
    await play(store);
    mirror.noteReceiverFollowState(false);
    await jest.advanceTimersByTimeAsync(0);
    expect(api.refreshOutputCredential).not.toHaveBeenCalled();
  });
});

it('mirrors the Infinity toggle into the session with repeat and shuffle (Phase 4)', async () => {
  const { api, store } = setup({ isInfinityMode: false });
  await play(store);
  await jest.advanceTimersByTimeAsync(300);
  api.patchPlaybackSession.mockClear();
  store.setState({ isInfinityMode: true });
  await jest.advanceTimersByTimeAsync(300);
  expect(api.patchPlaybackSession).toHaveBeenCalledWith(expect.anything(), 'session-1', expect.objectContaining({
    operations: [{ type: 'setTransport', repeatMode: 'none', shuffle: false, infinity: true }],
  }));
});

describe("the session's queue counts on every output (Phase 3)", () => {
  it('sends a lost edit again at the newer revision, and shows the merged queue', async () => {
    const adoptSession = jest.fn();
    const { api, store } = setup({}, [], { adoptSession });
    await play(store);
    await jest.advanceTimersByTimeAsync(300);
    const base = api.patchPlaybackSession.mock.calls.length;
    // Another device put 9 at the head meanwhile.
    const newer = sessionOf([track(9), track(1), track(2), track(3)], 9);
    api.patchPlaybackSession.mockRejectedValueOnce(new AuroraApiError('conflict', 409, 'REVISION_CONFLICT', undefined, { current: newer }));
    const merged = sessionOf([track(9), track(1), track(2), track(3), track(4)], 10);
    api.patchPlaybackSession.mockResolvedValueOnce(merged);
    store.setState({ playlist: [track(1), track(2), track(3), track(4)] }); // this device appended 4
    await jest.advanceTimersByTimeAsync(300);
    const sent = api.patchPlaybackSession.mock.calls.slice(base).map(([, , patch]) => patch as any);
    expect(sent).toHaveLength(2);
    expect(sent[1].expectedRevision).toBe(9);
    expect(sent[1].operations).toEqual(sent[0].operations); // the same anchored edit
    expect(sent[1].operations).toEqual([{ type: 'insert', afterEntryId: uuid(3), trackIds: ['track-4'], entryIds: [uuid(4)] }]);
    expect(adoptSession).toHaveBeenCalledWith(merged);
  });

  it("never resends its whole queue over another device's change, and takes the session after repeated losses", async () => {
    const adoptSession = jest.fn();
    const { api, store } = setup({}, [], { adoptSession });
    await play(store);
    await jest.advanceTimersByTimeAsync(300);
    const base = api.patchPlaybackSession.mock.calls.length;
    const newer = sessionOf([track(1), track(3)], 9); // another device removed 2
    for (let i = 0; i < 3; i += 1) {
      api.patchPlaybackSession.mockRejectedValueOnce(new AuroraApiError('conflict', 409, 'REVISION_CONFLICT', undefined, { current: { ...newer, revision: 9 + i } }));
    }
    store.setState({ playlist: [track(1), track(2), track(3), track(4)] });
    await jest.advanceTimersByTimeAsync(300);
    const edits = api.patchPlaybackSession.mock.calls.slice(base).map(([, , patch]) => (patch as any).operations);
    expect(edits).toHaveLength(3); // the edit, then two rebases
    for (const operations of edits) {
      expect(operations).toEqual([{ type: 'insert', afterEntryId: uuid(3), trackIds: ['track-4'], entryIds: [uuid(4)] }]);
    }
    expect(adoptSession).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 11 }));
  });
});
