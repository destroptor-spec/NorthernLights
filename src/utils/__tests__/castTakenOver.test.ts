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
