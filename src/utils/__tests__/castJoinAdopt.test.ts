import { CastManager } from '../CastManager';

jest.mock('../PlaybackManager', () => ({ playbackManager: {} }));
jest.mock('../../store', () => ({ usePlayerStore: { getState: () => ({ authToken: 'jwt' }), setState: jest.fn() } }));

/**
 * Prod 2026-10-13 19:53:48–49 (desktop joins the NAD, paused on "Slidin'"
 * from the phone): the SDK reported the media 1,024 ms after connecting, but
 * the fresh-session path had already loaded the desktop's queue over it.
 */
type Harness = {
  startPlaybackForCurrentSession(reason: string): Promise<void>;
  afterSessionEnded(snapshot: unknown): void;
  recoverStaleTransport(reason: string): Promise<boolean>;
  userSessionRequestPending: boolean;
  clearUserSessionIntentTimer: jest.Mock;
  handOffToLocalAfterSessionEnd: jest.Mock;
  setCastingElsewhereCheck(check: ((name: string) => boolean) | null): void;
  hydrateSenderFromRemoteSession: jest.Mock;
  handleCastConnected: jest.Mock;
  logCast: jest.Mock;
  lastAuroraStatus: unknown;
  lastAuroraStatusAt: number;
};

function harness() {
  const session = { getSessionId: () => '1ecdcfad', sendMessage: jest.fn().mockResolvedValue(undefined) };
  const endCurrentSession = jest.fn();
  let media: unknown = null;
  const manager = Object.create(CastManager.prototype) as Harness;
  Object.assign(manager, {
    autoCastInProgress: false,
    state: 'CONNECTED',
    castContext: { getCastState: () => 'CONNECTED', getCurrentSession: () => session, endCurrentSession },
    getCastDeviceName: () => 'NAD Forstærker',
    handOffToLocalAfterSessionEnd: jest.fn(),
    resetCastEndIntent: jest.fn(),
    clearUserSessionIntentTimer: jest.fn(),
    staleTransportRecoveryPromise: null,
    userSessionRequestPending: true,
    notifyStateChange: jest.fn(),
    getHydratableMediaSession: () => media,
    hydrateSenderFromRemoteSession: jest.fn().mockResolvedValue(true),
    handleCastConnected: jest.fn().mockResolvedValue(undefined),
    getOriginCastabilityIssue: () => '',
    applyFreshSessionStartupVolume: jest.fn(),
    logCast: jest.fn(),
    lastAuroraStatus: null,
    lastAuroraStatusAt: 0,
    watchdogMediaRequestId: 0,
  });
  return { manager, session, endCurrentSession, setMedia: (next: unknown) => { media = next; } };
}

const nadMedia = { media: { contentId: 'slidin', customData: { queueEntryId: 'e10' } }, playerState: 'PAUSED' };

beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
afterEach(() => jest.useRealTimers());

it('takes on the media that turns up a second after joining, and loads nothing', async () => {
  const { manager, session, setMedia } = harness();
  const started = manager.startPlaybackForCurrentSession('cast-connected-user-launch');
  expect(session.sendMessage).toHaveBeenCalledWith('urn:x-cast:com.google.cast.media', expect.objectContaining({ type: 'GET_STATUS' }));
  await jest.advanceTimersByTimeAsync(1000);
  setMedia(nadMedia);
  await jest.advanceTimersByTimeAsync(200);
  await started;
  expect(manager.hydrateSenderFromRemoteSession).toHaveBeenCalledWith(nadMedia, 'cast-connected-user-launch:joined');
  expect(manager.handleCastConnected).not.toHaveBeenCalled();
  expect(manager.logCast).toHaveBeenCalledWith('ok', 'cast-join-adopted', expect.stringMatching(/waitedMs=1[01]\d\d/));
});

it('loads at once when our receiver says nothing plays there', async () => {
  const { manager } = harness();
  const started = manager.startPlaybackForCurrentSession('cast-connected-user-launch');
  await jest.advanceTimersByTimeAsync(200);
  manager.lastAuroraStatus = { type: 'aurora.status', queueEntryId: null, playerState: 'IDLE' };
  manager.lastAuroraStatusAt = Date.now();
  await jest.advanceTimersByTimeAsync(100);
  await started;
  expect(manager.handleCastConnected).toHaveBeenCalledTimes(1);
  expect(Date.now() - 1_000_000).toBeLessThan(500);
});

it('loads after the wait when the receiver stays silent, as before', async () => {
  const { manager } = harness();
  const started = manager.startPlaybackForCurrentSession('cast-connected');
  await jest.advanceTimersByTimeAsync(1400);
  expect(manager.handleCastConnected).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(200);
  await started;
  expect(manager.handleCastConnected).toHaveBeenCalledTimes(1);
});

it('loads nothing over a receiver that says it plays, even if the SDK never shows the media', async () => {
  const { manager } = harness();
  manager.lastAuroraStatus = { type: 'aurora.status', queueEntryId: 'e10', playerState: 'PAUSED' };
  manager.lastAuroraStatusAt = Date.now() + 50;
  const started = manager.startPlaybackForCurrentSession('cast-connected-user-launch');
  await jest.advanceTimersByTimeAsync(2000);
  await started;
  expect(manager.handleCastConnected).not.toHaveBeenCalled();
  expect(manager.hydrateSenderFromRemoteSession).not.toHaveBeenCalled();
  expect(manager.logCast).toHaveBeenCalledWith('warn', 'cast-join-media-unseen', expect.stringContaining('entryId=e10'));
});

it('ignores a status left over from before this session', async () => {
  const { manager } = harness();
  manager.lastAuroraStatus = { type: 'aurora.status', queueEntryId: null, playerState: 'IDLE' };
  manager.lastAuroraStatusAt = Date.now() - 10_000;
  const started = manager.startPlaybackForCurrentSession('cast-connected-user-launch');
  await jest.advanceTimersByTimeAsync(300);
  expect(manager.handleCastConnected).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1300);
  await started;
  expect(manager.handleCastConnected).toHaveBeenCalledTimes(1);
});

/**
 * Prod 2026-10-13 21:47:36: the desktop joined the phone's Cast session as a
 * second sender and heard nothing back, so it loaded its own queue and kept
 * re-sending it. With sync telling us another device casts there, this
 * device leaves the Cast session again and controls it remotely.
 */
describe('a Cast device another of my devices is casting to', () => {
  it('leaves the Cast session without stopping the receiver, and loads nothing', async () => {
    const { manager, endCurrentSession, setMedia } = harness();
    setMedia(nadMedia);
    const check = jest.fn(() => true);
    manager.setCastingElsewhereCheck(check);
    await manager.startPlaybackForCurrentSession('cast-connected-user-launch');
    expect(check).toHaveBeenCalledWith('NAD Forstærker');
    expect(endCurrentSession).toHaveBeenCalledWith(false);
    expect(manager.hydrateSenderFromRemoteSession).not.toHaveBeenCalled();
    expect(manager.handleCastConnected).not.toHaveBeenCalled();
    expect(manager.logCast).toHaveBeenCalledWith('ok', 'cast-join-left', 'reason=cast-connected-user-launch device=NAD Forstærker');

    // Its own SESSION_ENDED is not a stop to take over from.
    manager.afterSessionEnded({ index: 1, positionSeconds: 12, wasPlaying: true });
    expect(manager.handOffToLocalAfterSessionEnd).not.toHaveBeenCalled();
    manager.afterSessionEnded({ index: 1, positionSeconds: 12, wasPlaying: true });
    expect(manager.handOffToLocalAfterSessionEnd).toHaveBeenCalledTimes(1);
  });

  it('casts as before when nobody else casts there', async () => {
    const { manager, endCurrentSession, setMedia } = harness();
    setMedia(nadMedia);
    manager.setCastingElsewhereCheck(() => false);
    await manager.startPlaybackForCurrentSession('cast-connected-user-launch');
    expect(endCurrentSession).not.toHaveBeenCalled();
    expect(manager.hydrateSenderFromRemoteSession).toHaveBeenCalled();
  });
});

/**
 * Prod 2026-10-13 22:45:58: the phone joined the desktop's Cast session and
 * left it, then the launcher tap's follow-up check found the closed
 * connection, took it for a stale one and rejoined (SESSION_RESUMED 0.3 s
 * later). The phone ended up a second sender after all.
 */
it('after leaving, neither leaves twice nor lets anything rejoin the session it left', async () => {
  const { manager, endCurrentSession, setMedia } = harness();
  setMedia(nadMedia);
  manager.setCastingElsewhereCheck(() => true);
  localStorage.setItem('cast_session_id', '1ecdcfad');
  await manager.startPlaybackForCurrentSession('cast-connected');
  await manager.startPlaybackForCurrentSession('session-started');
  expect(endCurrentSession).toHaveBeenCalledTimes(1);
  expect(manager.userSessionRequestPending).toBe(false);
  expect(manager.clearUserSessionIntentTimer).toHaveBeenCalled();

  expect(await manager.recoverStaleTransport('media-status:reconcile:user-launch-intent+2000ms')).toBe(false);
  expect(endCurrentSession).toHaveBeenCalledTimes(1);
  expect(manager.logCast).toHaveBeenCalledWith('ok', 'Skipped Cast transport recovery: media-status:reconcile:user-launch-intent+2000ms', 'reason=left-joined-session');

  // Still refused once its own SESSION_ENDED has been handled.
  manager.afterSessionEnded(null);
  expect(await manager.recoverStaleTransport('visibility')).toBe(false);
});

it('recovers a session it left once it connects to it again to stay', async () => {
  const { manager, setMedia } = harness();
  setMedia(nadMedia);
  let elsewhere = true;
  manager.setCastingElsewhereCheck(() => elsewhere);
  await manager.startPlaybackForCurrentSession('cast-connected');
  manager.afterSessionEnded(null);
  const internals = manager as unknown as { leftJoinedSessionId: string };
  expect(internals.leftJoinedSessionId).toBe('1ecdcfad');
  // The other device has stopped casting there; this one connects to stay.
  elsewhere = false;
  await manager.startPlaybackForCurrentSession('cast-connected');
  expect(internals.leftJoinedSessionId).toBe('');
});
