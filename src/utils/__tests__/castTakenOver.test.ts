import { CastManager } from '../CastManager';

const mockContinueLocally = jest.fn();
const mockAddToast = jest.fn();
jest.mock('../PlaybackManager', () => ({ playbackManager: {} }));
jest.mock('../../store', () => ({
  usePlayerStore: {
    getState: () => ({ authToken: 'jwt', continueLocallyAfterCast: mockContinueLocally, addToast: mockAddToast, playbackState: 'paused' }),
    setState: jest.fn(),
  },
}));
jest.mock('../../api/auroraApi', () => ({
  ...jest.requireActual('../../api/auroraApi'),
  getAuroraClientId: () => 'web:phone-a',
}));

/**
 * docs/cast-takeover.md, PR 3 (Andreas, 2026-11-02): someone else casts to
 * the speaker this phone casts to. The phone just goes back to not casting,
 * paused here on its own track, with no toast; also when it wakes later.
 */
type Harness = {
  stepBackIfTakenOver(status: Record<string, unknown>, sessionId: string): boolean;
  afterSessionEnded(snapshot: unknown): void;
  noteUserCastLaunchIntent(reason?: string): void;
  logCast: jest.Mock;
  handOffToLocalAfterSessionEnd(snapshot: unknown, options?: { paused?: boolean }): void;
};

const snapshot = { index: 3, positionSeconds: 61.5, wasPlaying: true };

function harness(options: { userCastIntentAt?: number } = {}) {
  const endCurrentSession = jest.fn();
  const manager = Object.create(CastManager.prototype) as Harness;
  Object.assign(manager, {
    state: 'CONNECTED',
    castContext: { getCurrentSession: () => ({ getSessionId: () => 'f611720b' }), endCurrentSession },
    leftJoinedSession: false,
    takenOverSid: '',
    takenOverAt: 0,
    namedCasterSid: '',
    userCastIntentAt: options.userCastIntentAt ?? 0,
    userSessionRequestPending: false,
    userStopRequested: false,
    userCastDialogAt: 0,
    freshSessionStartedAt: 0,
    preserveSessionOnNextEnd: false,
    stoppedBecauseReplaced: false,
    castEndSnapshotAtStop: null,
    clearUserSessionIntentTimer: jest.fn(),
    resetCastEndIntent: jest.fn(),
    captureCastEndSnapshot: () => snapshot,
    logCast: jest.fn(),
  });
  return { manager, endCurrentSession };
}

const statusFrom = (castingClientId: string | null) => ({ type: 'aurora.status', queueEntryId: 'e1', playerState: 'PLAYING', castingClientId });

beforeEach(() => {
  mockContinueLocally.mockClear();
  mockAddToast.mockClear();
});

it('steps back when the receiver names another device: leaves, never stops, and logs only', () => {
  const { manager, endCurrentSession } = harness();
  expect(manager.stepBackIfTakenOver(statusFrom('web:phone-a'), 'f611720b')).toBe(false);
  expect(manager.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b')).toBe(true);
  expect(endCurrentSession).toHaveBeenCalledWith(false);
  expect(endCurrentSession).not.toHaveBeenCalledWith(true);
  expect(manager.logCast).toHaveBeenCalledWith('ok', 'cast-taken-over', 'sid=f611720b');
  // Later statuses are not taken on, and nothing is done twice.
  expect(manager.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b')).toBe(true);
  expect(endCurrentSession).toHaveBeenCalledTimes(1);
});

it('goes back to playing here, paused where its own cast was, with no toast', () => {
  const { manager } = harness();
  manager.stepBackIfTakenOver(statusFrom('web:phone-a'), 'f611720b');
  manager.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b');
  manager.afterSessionEnded(snapshot);
  expect(mockContinueLocally).toHaveBeenCalledWith(3, 61.5, false);
  expect(mockAddToast).not.toHaveBeenCalled();
  expect(manager.logCast).toHaveBeenCalledWith('ok', 'cast-ended-handoff', expect.stringContaining('reason=taken-over play=false'));
});

it('steps back on waking or reloading too, when the first status it hears names another device', () => {
  // A reload knows nothing of having cast there: no tap, no earlier status.
  const { manager, endCurrentSession } = harness();
  expect(manager.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b')).toBe(true);
  expect(endCurrentSession).toHaveBeenCalledWith(false);
});

it('while joining to cast there itself, takes statuses naming the device it replaces for what they are', () => {
  const { manager, endCurrentSession } = harness({ userCastIntentAt: Date.now() });
  expect(manager.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b')).toBe(false);
  expect(endCurrentSession).not.toHaveBeenCalled();
  // Once the receiver has named this device, another device's LOAD is a takeover again.
  expect(manager.stepBackIfTakenOver(statusFrom('web:phone-a'), 'f611720b')).toBe(false);
  expect(manager.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b')).toBe(true);
});

it('changes nothing for a receiver that names nobody, or a session it already left', () => {
  const { manager, endCurrentSession } = harness();
  expect(manager.stepBackIfTakenOver(statusFrom(null), 'f611720b')).toBe(false);
  expect(manager.stepBackIfTakenOver({ type: 'aurora.status' }, 'f611720b')).toBe(false);
  Object.assign(manager, { leftJoinedSession: true });
  expect(manager.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b')).toBe(false);
  expect(endCurrentSession).not.toHaveBeenCalled();
});

describe('Chrome still holds the tab after a takeover (docs/cast-takeover.md, Known limit)', () => {
  const desktop = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  const phone = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
  const as = (userAgent: string) => jest.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  afterEach(() => jest.restoreAllMocks());

  const needsRefresh = (manager: Harness) => (manager as unknown as CastManager).needsRefreshToCast();

  it('a desktop that cast from this page needs a refresh to cast again', () => {
    as(desktop);
    const { manager } = harness({ userCastIntentAt: Date.now() - 60_000 });
    Object.assign(manager, { castRefreshNeeded: false });
    manager.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b');
    expect(needsRefresh(manager)).toBe(true);
    expect(manager.logCast).toHaveBeenCalledWith('ok', 'cast-taken-over', 'sid=f611720b refresh-needed=1');
  });

  it('not a phone, nor a page that only woke or reloaded into the session', () => {
    as(phone);
    const fromPhone = harness({ userCastIntentAt: Date.now() - 60_000 }).manager;
    Object.assign(fromPhone, { castRefreshNeeded: false });
    fromPhone.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b');
    expect(needsRefresh(fromPhone)).toBe(false);

    as(desktop);
    const reloaded = harness().manager;
    Object.assign(reloaded, { castRefreshNeeded: false });
    reloaded.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b');
    expect(needsRefresh(reloaded)).toBe(false);
  });

  it('a picker refused at once on a page that has cast also says so; a slow cancel by hand does not', async () => {
    const picker = (answerAfterMs: number, castConnectedOnPage: number) => {
      const manager = Object.create(CastManager.prototype) as CastManager;
      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);
      Object.assign(manager, {
        state: 'NOT_CONNECTED', castPickerPendingSince: 0, castRefreshNeeded: false, castConnectedOnPage: castConnectedOnPage > 0,
        castContext: { requestSession: () => { now += answerAfterMs; return Promise.resolve('cancel'); } },
        noteUserCastLaunchIntent: jest.fn(), notifyStateChange: jest.fn(), logCast: jest.fn(),
      });
      return manager;
    };
    const refused = picker(20, 999_000);
    expect(refused.openCastPicker('connect-menu')).toBe('opened');
    await Promise.resolve();
    expect(refused.needsRefreshToCast()).toBe(true);

    const byHand = picker(4000, 999_000);
    byHand.openCastPicker('connect-menu');
    await Promise.resolve();
    expect(byHand.needsRefreshToCast()).toBe(false);

    const neverCast = picker(20, 0);
    neverCast.openCastPicker('connect-menu');
    await Promise.resolve();
    expect(neverCast.needsRefreshToCast()).toBe(false);
  });
});

describe('woken after the takeover, with the connection dead (T2, prod 2026-11-05 21:00)', () => {
  const disconnected = Object.assign(new Error("Failed to execute 'send' on 'PresentationConnection': Presentation connection is disconnected."), { name: 'InvalidStateError' });
  const woken = (options: { leaveThrows: boolean; reconnecting: boolean }) => {
    const { manager } = harness();
    const endSession = jest.fn();
    const endCurrentSession = jest.fn(() => { if (options.leaveThrows) throw disconnected; });
    const setHealthStatus = jest.fn();
    Object.assign(manager, {
      castContext: {
        getCurrentSession: () => ({ getSessionId: () => 'f611720b', endSession, getSessionState: () => 'SESSION_STARTED' }),
        getCastState: () => 'CONNECTED',
        endCurrentSession,
      },
      staleTransportRecoveryPromise: options.reconnecting ? Promise.resolve(true) : null,
      castEndWatch: null,
      endedLocallySid: '',
      rejoinSessionPending: true,
      rejoinHydrationRunId: 0,
      clearRejoinHydrationTimer: jest.fn(),
      suppressRemoteEndedDuringDisconnect: false,
      setHealthStatus,
      notifyStateChange: jest.fn(),
      deadTransportSession: null,
      deadTransportSkipLogged: false,
    });
    return { manager, endSession, endCurrentSession, setHealthStatus };
  };
  const state = (manager: Harness) => (manager as unknown as { state: string }).state;

  it('the leave cannot be sent: ended here, paused on its own track, no toast, the receiver left playing', () => {
    const { manager, endSession } = woken({ leaveThrows: true, reconnecting: true });
    expect(manager.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b')).toBe(true);
    expect(manager.logCast).toHaveBeenCalledWith('warn', 'cast-taken-over-leave-failed', expect.any(String));
    expect(state(manager)).toBe('NOT_CONNECTED');
    expect(endSession).not.toHaveBeenCalled();
    expect(mockContinueLocally).toHaveBeenCalledWith(3, 61.5, false);
    expect(mockAddToast).not.toHaveBeenCalled();
  });

  it('steps back once: a later status in that session, after the handoff, changes nothing', () => {
    const { manager } = woken({ leaveThrows: true, reconnecting: true });
    manager.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b');
    expect(manager.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b')).toBe(true);
    expect(mockContinueLocally).toHaveBeenCalledTimes(1);
    expect(manager.logCast.mock.calls.filter(([, marker]) => marker === 'cast-taken-over')).toHaveLength(1);
  });

  it('a reconnect under way is no reason to wait for an end either', () => {
    const { manager, endSession } = woken({ leaveThrows: false, reconnecting: true });
    manager.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b');
    expect(state(manager)).toBe('NOT_CONNECTED');
    expect(endSession).not.toHaveBeenCalled();
    expect(mockContinueLocally).toHaveBeenCalledWith(3, 61.5, false);
  });

  it('awake, with the leave sent: SESSION_ENDED does the rest, as before', () => {
    const { manager } = woken({ leaveThrows: false, reconnecting: false });
    manager.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b');
    expect(state(manager)).toBe('CONNECTED');
    expect(mockContinueLocally).not.toHaveBeenCalled();
  });

  it('the reconnect that got back in leaves again, quietly, and nothing of the new cast is taken on', async () => {
    const { manager, endCurrentSession, setHealthStatus } = woken({ leaveThrows: true, reconnecting: true });
    manager.stepBackIfTakenOver(statusFrom('web:desktop-b'), 'f611720b');
    endCurrentSession.mockImplementation(() => undefined);
    const internals = manager as unknown as {
      dropRecoveryAfterStepBack(sid: string, reason: string): false;
      hydrateSenderFromRemoteSession(media: unknown, reason: string): Promise<boolean>;
      isSteppedBack(sid: string): boolean;
    };
    expect(internals.isSteppedBack('f611720b')).toBe(true);
    await expect(internals.hydrateSenderFromRemoteSession({ playerState: 'PLAYING' }, 'session-resumed')).resolves.toBe(false);
    expect(internals.dropRecoveryAfterStepBack('f611720b', 'media-status:reconcile')).toBe(false);
    expect(endCurrentSession).toHaveBeenLastCalledWith(false);
    expect(manager.logCast).toHaveBeenCalledWith('ok', 'stale-transport-recovery-dropped', 'sid=f611720b reason=media-status:reconcile cause=taken-over');
    expect(setHealthStatus).toHaveBeenLastCalledWith('idle', '');
  });
});
