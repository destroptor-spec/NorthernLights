import { CastManager } from '../CastManager';

jest.mock('../PlaybackManager', () => ({ playbackManager: {} }));
const mockAddToast = jest.fn();
jest.mock('../../store', () => ({ usePlayerStore: { getState: () => ({ authToken: 'jwt', addToast: mockAddToast }), setState: jest.fn() } }));

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
  stopCastingBecauseReplaced(by: string): boolean;
  stop: jest.Mock;
  hydrateSenderFromRemoteSession: jest.Mock;
  handleCastConnected: jest.Mock;
  logCast: jest.Mock;
  lastAuroraStatus: unknown;
  lastAuroraStatusAt: number;
  lastReceiverAnswerAt: number;
};

/** `deaf`: the receiver never answers this device (one-way join); otherwise it acknowledges the join's ping. */
function harness(options: { deaf?: boolean } = {}) {
  const session = {
    getSessionId: () => '1ecdcfad',
    sendMessage: jest.fn((_ns: string, message: { type?: string; action?: string }) => {
      if (!options.deaf && message?.type === 'aurora.control' && message.action === 'ping') manager.lastReceiverAnswerAt = Date.now();
      return Promise.resolve(undefined);
    }),
  };
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
    isConnected: () => true,
    stop: jest.fn(),
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
    lastReceiverAnswerAt: 0,
    watchdogMediaRequestId: 0,
    auroraControlRequestId: 0,
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

/**
 * Prod 2026-10-27 12:33: the desktop joined the NAD's idle receiver app (the
 * phone had stopped casting), heard nothing back, loaded its queue, and
 * loaded it again 15 s later over its own track ("playback-unconfirmed").
 * Picking the NAD again by hand started a new session, which worked.
 */
describe('a joined session that never answers', () => {
  it('pings, waits for a slow receiver, then stops that receiver app instead of loading, and leaves it', async () => {
    mockAddToast.mockClear();
    const { manager, session, endCurrentSession } = harness({ deaf: true });
    const pings = () => session.sendMessage.mock.calls.filter(([, message]) => (message as { action?: string })?.action === 'ping');
    const started = manager.startPlaybackForCurrentSession('session-started');
    expect(pings()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(2600);
    expect(pings()).toHaveLength(2); // once more, in case the first was lost
    expect(manager.handleCastConnected).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2500);
    await started;
    expect(manager.handleCastConnected).not.toHaveBeenCalled();
    // The stop first: the other senders there hear the end (prod 2026-10-30 21:03:27).
    expect(endCurrentSession).toHaveBeenCalledWith(true);
    expect(endCurrentSession).not.toHaveBeenCalledWith(false);
    expect(manager.logCast).toHaveBeenCalledWith('warn', 'cast-join-deaf', expect.stringMatching(/^reason=session-started waitedMs=5\d\d\d$/));
    expect(manager.userSessionRequestPending).toBe(false);
    // Then let go of it here: Chrome may never confirm a stop it can't hear (21:03:30).
    await jest.advanceTimersByTimeAsync(1000);
    expect(endCurrentSession).toHaveBeenLastCalledWith(false);
  });

  it('once ended, hands nothing back here and opens the picker for the new cast; Cast again if Chrome refuses it', () => {
    mockAddToast.mockClear();
    const { manager } = harness({ deaf: true });
    const openCastPicker = jest.fn((_reason: string, _onAnswer?: (outcome: string, ms: number) => void) => 'opened');
    Object.assign(manager, { openCastPicker, stoppedDeafDevice: 'NAD Forstærker' });
    manager.afterSessionEnded({ index: 1, positionSeconds: 12, wasPlaying: false });
    expect(manager.handOffToLocalAfterSessionEnd).not.toHaveBeenCalled();
    expect(openCastPicker).toHaveBeenCalledWith('deaf-join-restart', expect.any(Function));

    // The listener closing the picker: nothing more.
    openCastPicker.mock.calls[0][1]!('error-cancel', 3000);
    expect(mockAddToast).not.toHaveBeenCalled();
    // Chrome refusing it at once (21:03:35, 6 ms): Cast again, a tap that opens it.
    openCastPicker.mock.calls[0][1]!('error-cancel', 6);
    expect(mockAddToast).toHaveBeenCalledWith("NAD Forstærker didn't answer.", 'error', expect.objectContaining({ actionLabel: 'Cast again' }));
    mockAddToast.mock.calls[0][2].onAction();
    expect(openCastPicker).toHaveBeenLastCalledWith('deaf-join-retry');

    // A later end is an ordinary one again.
    manager.afterSessionEnded({ index: 1, positionSeconds: 12, wasPlaying: true });
    expect(manager.handOffToLocalAfterSessionEnd).toHaveBeenCalledTimes(1);
  });

  it('a receiver that answers the ping is not deaf, however slowly its media shows', async () => {
    const { manager, endCurrentSession } = harness();
    const started = manager.startPlaybackForCurrentSession('session-started');
    await jest.advanceTimersByTimeAsync(1600);
    await started;
    expect(manager.handleCastConnected).toHaveBeenCalledTimes(1);
    expect(endCurrentSession).not.toHaveBeenCalled();
  });
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

it("takes on none of the receiver's state while leaving (it is the other device's)", async () => {
  const { manager, setMedia } = harness();
  setMedia(nadMedia);
  manager.setCastingElsewhereCheck(() => true);
  await manager.startPlaybackForCurrentSession('cast-connected');
  const realHydrate = (CastManager.prototype as unknown as { hydrateSenderFromRemoteSession: Harness['hydrateSenderFromRemoteSession'] }).hydrateSenderFromRemoteSession;
  const sync = jest.fn();
  Object.assign(manager, { syncCurrentTrackFromSession: sync });
  expect(await realHydrate.call(manager, nadMedia, 'remote-player-state-changed')).toBe(false);
  expect(sync).not.toHaveBeenCalled();
});

it('stops casting when another device took over elsewhere, and hands nothing back to this device', () => {
  const { manager, endCurrentSession } = harness();
  expect(manager.stopCastingBecauseReplaced('browser:Chrome on Android')).toBe(true);
  expect(manager.stop).toHaveBeenCalled();
  expect(endCurrentSession).toHaveBeenCalledWith(true);
  expect(manager.logCast).toHaveBeenCalledWith('ok', 'cast-stopped-replaced', 'by=browser:Chrome on Android');
  manager.afterSessionEnded({ index: 1, positionSeconds: 30, wasPlaying: true });
  expect(manager.handOffToLocalAfterSessionEnd).not.toHaveBeenCalled();
  expect(manager.logCast).toHaveBeenCalledWith('ok', 'cast-ended-handoff skipped', 'reason=replaced');
  // A later, ordinary end hands back as usual.
  manager.afterSessionEnded({ index: 1, positionSeconds: 30, wasPlaying: true });
  expect(manager.handOffToLocalAfterSessionEnd).toHaveBeenCalledTimes(1);
});

