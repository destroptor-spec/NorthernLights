import { CastManager } from '../CastManager';

const mockPlayAtIndex = jest.fn(async () => undefined);
const mockSetState = jest.fn();
jest.mock('../PlaybackManager', () => ({ playbackManager: {} }));
jest.mock('../../store', () => ({
  usePlayerStore: {
    getState: () => ({ authToken: 'jwt', addToast: jest.fn(), currentIndex: 0, playlist: [{ queueEntryId: 'e1' }], playAtIndex: mockPlayAtIndex }),
    setState: (...args: unknown[]) => mockSetState(...args),
  },
}));

/**
 * Prod 2026-11-05 11:15 (phone, a single cast to the NAD, asleep while it
 * played, woken as it ended): still connected, but the SDK held the old
 * media, every Play/Pause on it answered session_error, and song taps went to
 * a receiver no longer following. Andreas: stay connected and idle, Play
 * casts again; the receiver closes its app after 5 minutes of nothing.
 */
type Harness = {
  applyAuroraStatus(status: Record<string, unknown>): void;
  receiverFollowsSession(): boolean;
  resume(): void;
  pause(): void;
  logCast: jest.Mock;
  onPlayStateChange: jest.Mock;
  requestReceiverStatus: jest.Mock;
};

const SID = '4fd1e1aa-8b70-41ea-b93f-e719cd6e8b8f';
const playing = { type: 'aurora.status', queueEntryId: 'e1', playerState: 'PLAYING' };
const idle = { type: 'aurora.status', queueEntryId: null, playerState: 'IDLE', queueLength: 0 };

function harness(options: { loadedAgoMs?: number } = {}) {
  const mediaSession = { play: jest.fn(), pause: jest.fn(), playerState: 'PLAYING', media: { contentId: 'x' } };
  const session = { getSessionId: () => SID, getMediaSession: () => mediaSession };
  const manager = Object.create(CastManager.prototype) as Harness;
  Object.assign(manager, {
    state: 'CONNECTED',
    castContext: { getCurrentSession: () => session },
    receiverFollowingSid: SID,
    mediaEndedSid: '',
    mediaSeenSid: '',
    receiverIdleSince: 0,
    receiverIdleRecheck: null,
    lastQueueLoadStartedAt: options.loadedAgoMs === undefined ? 0 : Date.now() - options.loadedAgoMs,
    queueLoadingSession: null,
    playbackConfirmation: { cancel: jest.fn(), unconfirmed: false, observe: jest.fn(), pending: false },
    playbackRetry: null,
    onPlayStateChange: jest.fn(),
    logCast: jest.fn(),
    requestReceiverStatus: jest.fn(),
    // Everything else applyAuroraStatus does is not what this is about.
    queueWindow: null,
    confirmationLoadAccepted: false,
    maybeAdoptQueueWindow: jest.fn(),
    lastRemotePlayerEventAt: Date.now(),
  });
  return { manager, mediaSession };
}

/** Only the part of applyAuroraStatus under test: what the receiver says plays. */
const hear = (manager: Harness, status: Record<string, unknown>) =>
  (manager as unknown as { noteReceiverPlayback(s: Record<string, unknown>): void }).noteReceiverPlayback(status);

beforeEach(() => {
  jest.useFakeTimers();
  mockPlayAtIndex.mockClear();
  mockSetState.mockClear();
});
afterEach(() => jest.useRealTimers());

it('counts the receiver idle with nothing loaded, for 2 s after media played, as the queue ending', () => {
  const { manager } = harness();
  hear(manager, playing);
  hear(manager, idle);
  expect(manager.logCast).not.toHaveBeenCalledWith('ok', 'cast-media-ended', expect.anything());
  // It asks again once a track change would be over.
  jest.advanceTimersByTime(2100);
  expect(manager.requestReceiverStatus).toHaveBeenCalledTimes(1);
  hear(manager, idle);
  expect(manager.logCast).toHaveBeenCalledWith('ok', 'cast-media-ended', `reason=receiver-idle sid=${SID}`);
  expect(manager.onPlayStateChange).toHaveBeenCalledWith(false);
  expect(manager.receiverFollowsSession()).toBe(false);
});

it('not the moment of idle between two tracks', () => {
  const { manager } = harness();
  hear(manager, playing);
  hear(manager, idle);
  jest.advanceTimersByTime(230);
  hear(manager, { ...playing, queueEntryId: 'e2' });
  jest.advanceTimersByTime(5000);
  hear(manager, idle);
  expect(manager.logCast).not.toHaveBeenCalledWith('ok', 'cast-media-ended', expect.anything());
  expect(manager.receiverFollowsSession()).toBe(true);
});

it('not on joining an idle receiver, nor just after its own LOAD', () => {
  const fresh = harness().manager;
  hear(fresh, idle);
  jest.advanceTimersByTime(3000);
  hear(fresh, idle);
  expect(fresh.logCast).not.toHaveBeenCalledWith('ok', 'cast-media-ended', expect.anything());

  const loading = harness({ loadedAgoMs: 1000 }).manager;
  Object.assign(loading, { mediaSeenSid: SID });
  hear(loading, idle);
  jest.advanceTimersByTime(3000);
  hear(loading, idle);
  expect(loading.logCast).not.toHaveBeenCalledWith('ok', 'cast-media-ended', expect.anything());
});

it('after the end: Pause just shows paused, Play casts the queue again, never the old media', () => {
  const { manager, mediaSession } = harness();
  hear(manager, playing);
  hear(manager, idle);
  jest.advanceTimersByTime(2100);
  hear(manager, idle);

  manager.pause();
  expect(mediaSession.pause).not.toHaveBeenCalled();
  expect(manager.onPlayStateChange).toHaveBeenLastCalledWith(false);

  manager.resume();
  expect(mediaSession.play).not.toHaveBeenCalled();
  expect(mockPlayAtIndex).toHaveBeenCalledWith(0);
  expect(manager.logCast).toHaveBeenCalledWith('ok', 'cast-media-ended-replay', 'via=resume index=0');
});

it('new media there (its LOAD or another sender\'s) ends it', () => {
  const { manager } = harness();
  hear(manager, playing);
  hear(manager, idle);
  jest.advanceTimersByTime(2100);
  hear(manager, idle);
  expect(manager.receiverFollowsSession()).toBe(false);
  hear(manager, { ...playing, queueEntryId: 'e7' });
  expect(manager.logCast).toHaveBeenCalledWith('ok', 'cast-media-ended-cleared', `reason=receiver-playing sid=${SID}`);
  expect(manager.receiverFollowsSession()).toBe(true);
});
