import { CastManager } from '../CastManager';

jest.mock('../PlaybackManager', () => ({ playbackManager: {} }));
jest.mock('../../store', () => ({ usePlayerStore: { getState: () => ({ authToken: 'jwt' }), setState: jest.fn() } }));

/**
 * Prod 2026-10-26 22:29:44 (phone, a remote for the desktop, casts to the
 * NAD): the new Cast session had no media yet, so the sender fell back to the
 * RemotePlayer, which still held idle "Lonely" from the phone's previous Cast
 * session. It took that for media playing there, hydrated from it, and loaded
 * nothing; the desktop played on.
 */
type Harness = {
  startPlaybackForCurrentSession(reason: string): Promise<void>;
  getHydratableMediaSession(mediaSession?: unknown): unknown;
  noteRemotePlayerMedia(): void;
  remotePlayerDescribesSid: string | null;
  hydrateSenderFromRemoteSession: jest.Mock;
  handleCastConnected: jest.Mock;
  logCast: jest.Mock;
  lastAuroraStatus: unknown;
  lastAuroraStatusAt: number;
};

function harness(describes: string | null) {
  const session = { getSessionId: () => 'new-session', sendMessage: jest.fn().mockResolvedValue(undefined), getMediaSession: () => null };
  const manager = Object.create(CastManager.prototype) as Harness;
  Object.assign(manager, {
    autoCastInProgress: false,
    state: 'CONNECTED',
    castContext: { getCastState: () => 'CONNECTED', getCurrentSession: () => session },
    // What the phone's previous Cast session left in the RemotePlayer.
    player: { isMediaLoaded: true, mediaInfo: { contentId: 'lonely', customData: { queueEntryId: 'e11' }, metadata: { title: 'Lonely' } }, playerState: 'IDLE', currentTime: 0 },
    remotePlayerDescribesSid: describes,
    remotePlayerStaleLoggedSid: '',
    getMediaSession: () => null,
    getCastDeviceName: () => 'NAD Forstærker',
    leaveIfCastingElsewhere: () => false,
    isConnected: () => true,
    userSessionRequestPending: true,
    notifyStateChange: jest.fn(),
    hydrateSenderFromRemoteSession: jest.fn().mockResolvedValue(true),
    handleCastConnected: jest.fn().mockResolvedValue(undefined),
    getOriginCastabilityIssue: () => '',
    applyFreshSessionStartupVolume: jest.fn(),
    logCast: jest.fn(),
    lastAuroraStatus: null,
    lastAuroraStatusAt: 0,
    watchdogMediaRequestId: 0,
  });
  return { manager };
}

beforeAll(() => { (globalThis as unknown as { chrome: unknown }).chrome = { cast: { Image: class {}, media: { PlayerState: { PLAYING: 'PLAYING', PAUSED: 'PAUSED', IDLE: 'IDLE' } } } }; });
beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
afterEach(() => jest.useRealTimers());

it("loads the queue on a new Cast session, not the media of the one that ended", async () => {
  const { manager } = harness('previous-session'); // set at SESSION_ENDED
  const started = manager.startPlaybackForCurrentSession('cast-connected-user-launch');
  await jest.advanceTimersByTimeAsync(200);
  // Our receiver: nothing plays here.
  manager.lastAuroraStatus = { type: 'aurora.status', queueEntryId: null, playerState: 'IDLE' };
  manager.lastAuroraStatusAt = Date.now();
  await jest.advanceTimersByTimeAsync(100);
  await started;
  expect(manager.hydrateSenderFromRemoteSession).not.toHaveBeenCalled();
  expect(manager.handleCastConnected).toHaveBeenCalledTimes(1);
  expect(manager.logCast).toHaveBeenCalledWith('ok', 'remote-player-stale-ignored', 'describes=previous-session');
  expect(manager.logCast.mock.calls.filter(([, marker]) => marker === 'remote-player-stale-ignored')).toHaveLength(1);
});

it("uses the RemotePlayer again once it reports on the new session's media", () => {
  const { manager } = harness('previous-session');
  expect(manager.getHydratableMediaSession(null)).toBeNull();
  manager.noteRemotePlayerMedia(); // e.g. PLAYER_STATE_CHANGED after the new LOAD
  expect(manager.remotePlayerDescribesSid).toBe('new-session');
  expect(manager.getHydratableMediaSession(null)).toEqual(expect.objectContaining({ __source: 'remote-player' }));
});

it('trusts it as before after a page load, and on a recovery into the same Cast session', () => {
  expect(harness(null).manager.getHydratableMediaSession(null)).toEqual(expect.objectContaining({ __source: 'remote-player' }));
  // A stale-transport recovery ends the session and rejoins it by its ID.
  expect(harness('new-session').manager.getHydratableMediaSession(null)).toEqual(expect.objectContaining({ __source: 'remote-player' }));
});
