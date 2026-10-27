import { CAST_END_CONFIRM_MS, CastManager } from '../CastManager';

const mockStore = { playbackState: 'playing', continueLocallyAfterCast: jest.fn(async () => undefined) };
jest.mock('../PlaybackManager', () => ({ playbackManager: {} }));
jest.mock('../../store', () => ({ usePlayerStore: { getState: () => mockStore, setState: jest.fn((patch: object) => Object.assign(mockStore, patch)) } }));

/**
 * Prod 2026-10-27 12:35 and 12:39 (desktop Chrome): another device took over,
 * the desktop called endCurrentSession(true), and SESSION_ENDED never came.
 * It kept showing the cast; Stop casting, Play here and Play there did nothing
 * until a reload. Now it ends the session itself when Chrome stays silent.
 */
type Internals = {
  stopCastingBecauseReplaced(by: string): boolean;
  disconnect(): Promise<void>;
  reconcileActiveSession(reason?: string): Promise<boolean>;
  hydrateSenderFromRemoteSession(media?: unknown, reason?: string): Promise<boolean>;
  isConnected(): boolean;
  state: string;
  logCast: jest.Mock;
  notifyStateChange: jest.Mock;
};

function harness() {
  let sid = 'cast-77';
  const session = { getSessionId: () => sid, getSessionState: () => 'SESSION_STARTED', endSession: jest.fn(() => Promise.resolve()) };
  const endCurrentSession = jest.fn(); // Chrome stays silent
  const m = Object.create(CastManager.prototype) as Internals;
  Object.assign(m, {
    state: 'CONNECTED',
    castContext: { getCurrentSession: () => session, getCastState: () => 'CONNECTED', endCurrentSession },
    logCast: jest.fn(), notifyStateChange: jest.fn(), setHealthStatus: jest.fn(), stop: jest.fn(),
    captureCastEndSnapshot: () => ({ index: 3, positionSeconds: 61, wasPlaying: true }),
    clearUserSessionIntentTimer: jest.fn(), clearRejoinHydrationTimer: jest.fn(),
    rejoinHydrationRunId: 0, castEndWatch: null, endedLocallySid: '', reconnectInProgress: false,
  });
  const markers = () => m.logCast.mock.calls.map(([, marker]) => marker);
  return { m, session, endCurrentSession, markers, endSessionHere: () => { sid = ''; } };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockStore.playbackState = 'playing';
  mockStore.continueLocallyAfterCast.mockClear();
});
afterEach(() => jest.useRealTimers());

it('another device took over: if Chrome never ends the session, it ends here, with no handoff', async () => {
  const { m, session, endCurrentSession, markers } = harness();
  expect(m.stopCastingBecauseReplaced('browser:Chrome on Android')).toBe(true);
  expect(endCurrentSession).toHaveBeenCalledWith(true);
  expect(m.isConnected()).toBe(true);

  jest.advanceTimersByTime(CAST_END_CONFIRM_MS);
  expect(markers()).toEqual(expect.arrayContaining(['cast-end-requested', 'cast-end-unconfirmed', 'cast-ended-handoff skipped']));
  expect(session.endSession).toHaveBeenCalledWith(true); // tried once more
  expect(m.isConnected()).toBe(false);
  expect(m.notifyStateChange).toHaveBeenCalled();
  expect(mockStore.continueLocallyAfterCast).not.toHaveBeenCalled(); // the other device plays
  expect(mockStore.playbackState).toBe('paused');

  // Chrome's lingering session is neither reconciled nor hydrated again.
  await expect(m.reconcileActiveSession('window-focus')).resolves.toBe(false);
  await expect(m.hydrateSenderFromRemoteSession({ media: { contentId: 'x' } }, 'remote-player-state-changed')).resolves.toBe(false);
});

it('Stop casting: if Chrome never ends the session, the music continues here anyway', async () => {
  const { m, markers } = harness();
  await m.disconnect();
  jest.advanceTimersByTime(CAST_END_CONFIRM_MS);
  expect(markers()).toContain('cast-end-unconfirmed');
  expect(m.isConnected()).toBe(false);
  expect(mockStore.continueLocallyAfterCast).toHaveBeenCalledWith(3, 61, expect.any(Boolean));
});

it('does nothing once the session has ended', () => {
  const { m, markers, endSessionHere } = harness();
  m.stopCastingBecauseReplaced('browser:Chrome on Android');
  endSessionHere();
  jest.advanceTimersByTime(CAST_END_CONFIRM_MS);
  expect(markers()).not.toContain('cast-end-unconfirmed');
});
