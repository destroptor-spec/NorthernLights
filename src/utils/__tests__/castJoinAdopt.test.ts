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
  hydrateSenderFromRemoteSession: jest.Mock;
  handleCastConnected: jest.Mock;
  logCast: jest.Mock;
  lastAuroraStatus: unknown;
  lastAuroraStatusAt: number;
};

function harness() {
  const session = { getSessionId: () => '1ecdcfad', sendMessage: jest.fn().mockResolvedValue(undefined) };
  let media: unknown = null;
  const manager = Object.create(CastManager.prototype) as Harness;
  Object.assign(manager, {
    autoCastInProgress: false,
    state: 'CONNECTED',
    castContext: { getCastState: () => 'CONNECTED', getCurrentSession: () => session },
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
  return { manager, session, setMedia: (next: unknown) => { media = next; } };
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
