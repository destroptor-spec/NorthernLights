import { CastManager } from '../CastManager';

jest.mock('../PlaybackManager', () => ({ playbackManager: {} }));
jest.mock('../../store', () => ({ usePlayerStore: { getState: () => ({ authToken: 'jwt', addToast: jest.fn() }), setState: jest.fn() } }));
jest.mock('../../api/auroraApi', () => ({
  ...jest.requireActual('../../api/auroraApi'),
  getAuroraClientId: () => 'web:desktop-b',
}));

/**
 * docs/cast-takeover.md, PR 4 (Andreas, 2026-11-02): picking a speaker that
 * plays someone else's cast is one press, like casting over any other app.
 * Prod 2026-10-30 21:03 and 2026-11-02 21:47: a phone on another account cast
 * to the NAD, the desktop picked it, and its Cast connection was one-way.
 */
type Harness = {
  startPlaybackForCurrentSession(reason: string): Promise<void>;
  receiveRelayedStatus(castSessionId: unknown, status: unknown): void;
  setCastingElsewhereCheck(check: ((name: string, options?: Record<string, unknown>) => boolean) | null): void;
  hydrateSenderFromRemoteSession: jest.Mock;
  handleCastConnected: jest.Mock;
  applyFreshSessionStartupVolume: jest.Mock;
  applyAuroraStatus: jest.Mock;
  logCast: jest.Mock;
  lastAuroraStatus: unknown;
  lastAuroraStatusAt: number;
  lastReceiverAnswerAt: number;
};

const SID = '56399d73-9d3e-4a95-8d71-977d51a831ec';

/** `answers`: the receiver's status when asked (aurora.diagnostics); none for a deaf join. */
function harness(answers: Record<string, unknown> | null) {
  const session = {
    getSessionId: () => SID,
    sendMessage: jest.fn((_ns: string, message: { type?: string; action?: string }) => {
      if (answers && (message?.type === 'aurora.diagnostics' || message?.action === 'ping')) {
        manager.lastReceiverAnswerAt = Date.now();
        if (message.type === 'aurora.diagnostics') {
          manager.lastAuroraStatus = { type: 'aurora.status', ts: Date.now(), ...answers };
          manager.lastAuroraStatusAt = Date.now();
        }
      }
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
    resetCastEndIntent: jest.fn(),
    clearUserSessionIntentTimer: jest.fn(),
    isConnected: () => true,
    notifyStateChange: jest.fn(),
    getHydratableMediaSession: () => media,
    hydrateSenderFromRemoteSession: jest.fn().mockResolvedValue(true),
    handleCastConnected: jest.fn().mockResolvedValue(undefined),
    getOriginCastabilityIssue: () => '',
    applyFreshSessionStartupVolume: jest.fn(),
    applyAuroraStatus: jest.fn(),
    syncReceiverDiagnostics: jest.fn(),
    logCast: jest.fn(),
    lastAuroraStatus: null,
    lastAuroraStatusAt: 0,
    lastReceiverAnswerAt: 0,
    watchdogMediaRequestId: 0,
    auroraControlRequestId: 0,
    userCastIntentAt: Date.now(),
    userSessionRequestPending: true,
    namedCasterSid: '',
    takenOverSid: '',
    leftJoinedSession: false,
    receiverFollowListeners: [],
    receiverFollowStateListeners: [],
    recoverStaleTransport: jest.fn().mockResolvedValue(true),
  });
  return { manager, session, endCurrentSession, setMedia: (next: unknown) => { media = next; } };
}

const phoneMedia = { media: { contentId: 'slidin', customData: { queueEntryId: 'e10' } }, playerState: 'PLAYING' };

beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
afterEach(() => jest.useRealTimers());

it("replaces another device's cast with this device's queue, keeping the speaker's volume", async () => {
  const { manager, setMedia } = harness({ castingClientId: 'web:phone-a', playerState: 'PLAYING', queueEntryId: 'e10' });
  setMedia(phoneMedia);
  const started = manager.startPlaybackForCurrentSession('session-started');
  await jest.advanceTimersByTimeAsync(200);
  await started;
  expect(manager.handleCastConnected).toHaveBeenCalledTimes(1);
  expect(manager.hydrateSenderFromRemoteSession).not.toHaveBeenCalled();
  expect(manager.applyFreshSessionStartupVolume).not.toHaveBeenCalled();
  expect(manager.logCast).toHaveBeenCalledWith('ok', 'cast-takeover', expect.stringContaining('casting=other active=true'));
  // Nothing of the cast it replaces was taken on here.
  expect(manager.applyAuroraStatus).not.toHaveBeenCalled();
});

it('casts at once to an idle receiver, with the startup volume, as a fresh cast', async () => {
  const { manager } = harness({ castingClientId: null, playerState: 'IDLE', queueEntryId: null });
  const started = manager.startPlaybackForCurrentSession('session-started');
  await jest.advanceTimersByTimeAsync(200);
  await started;
  expect(manager.handleCastConnected).toHaveBeenCalledTimes(1);
  expect(manager.applyFreshSessionStartupVolume).toHaveBeenCalled();
});

it('takes on its own cast (a reload picking the speaker it casts to)', async () => {
  const { manager, setMedia } = harness({ castingClientId: 'web:desktop-b', playerState: 'PLAYING' });
  setMedia(phoneMedia);
  const started = manager.startPlaybackForCurrentSession('session-started');
  await jest.advanceTimersByTimeAsync(200);
  await started;
  expect(manager.hydrateSenderFromRemoteSession).toHaveBeenCalledWith(phoneMedia, 'session-started:joined');
  expect(manager.handleCastConnected).not.toHaveBeenCalled();
});

it('never takes over another of my own devices: leaves and becomes its remote', async () => {
  const { manager, endCurrentSession } = harness({ castingClientId: 'web:phone-a', playerState: 'PLAYING' });
  const check = jest.fn((_name: string, options?: Record<string, unknown>) => options?.castingClientId === 'web:phone-a');
  manager.setCastingElsewhereCheck(check);
  const started = manager.startPlaybackForCurrentSession('session-started');
  await jest.advanceTimersByTimeAsync(200);
  await started;
  expect(endCurrentSession).toHaveBeenCalledWith(false);
  expect(manager.handleCastConnected).not.toHaveBeenCalled();
  expect(manager.logCast).toHaveBeenCalledWith('ok', 'cast-join-left', 'reason=session-started:own-device device=NAD Forstærker');
});

describe('a deaf join', () => {
  it('loads anyway after a short wait and hears the receiver through the relay; no stop', async () => {
    const { manager, endCurrentSession } = harness(null);
    const started = manager.startPlaybackForCurrentSession('session-started');
    await jest.advanceTimersByTimeAsync(1600);
    expect(manager.handleCastConnected).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1600);
    await started;
    expect(manager.handleCastConnected).toHaveBeenCalledTimes(1);
    expect(manager.logCast).toHaveBeenCalledWith('ok', 'cast-takeover', expect.stringContaining('deaf=true'));
    expect(manager.applyFreshSessionStartupVolume).not.toHaveBeenCalled();

    // The relay brings the receiver's status, now naming this device.
    manager.receiveRelayedStatus(SID, { type: 'aurora.status', castingClientId: 'web:desktop-b', playerState: 'PLAYING', ts: Date.now() });
    expect(manager.applyAuroraStatus).toHaveBeenCalledTimes(1);
    expect(manager.logCast).toHaveBeenCalledWith('ok', 'cast-status-relayed', `sid=${SID}`);
    // Its LOAD has landed: reconnect by id, as a reload does (prod 2026-11-03 10:09:20), once.
    await jest.advanceTimersByTimeAsync(0);
    const recover = (manager as unknown as { recoverStaleTransport: jest.Mock }).recoverStaleTransport;
    expect(recover).toHaveBeenCalledWith('deaf-takeover');
    manager.receiveRelayedStatus(SID, { type: 'aurora.status', castingClientId: 'web:desktop-b', playerState: 'PLAYING', ts: Date.now() + 1 });
    await jest.advanceTimersByTimeAsync(0);
    expect(recover).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(13_000);
    expect(endCurrentSession).not.toHaveBeenCalled();
  });

  // Its LOAD, as the queue load sends it (handleCastConnected is mocked here).
  const load = (manager: Harness) => (manager as unknown as { watchRelayAfterDeafTakeover(): void }).watchRelayAfterDeafTakeover();

  it("falls back to #211's stop and Cast again when nothing at all is heard after its LOAD, not even relayed", async () => {
    const { manager, endCurrentSession } = harness(null);
    const started = manager.startPlaybackForCurrentSession('session-started');
    await jest.advanceTimersByTimeAsync(3200);
    await started;
    load(manager);
    load(manager); // a retry of the same LOAD restarts nothing
    await jest.advanceTimersByTimeAsync(11_900);
    expect(endCurrentSession).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(200);
    expect(manager.logCast).toHaveBeenCalledWith('warn', 'cast-takeover-unheard', expect.stringContaining(`sid=${SID}`));
    expect(endCurrentSession).toHaveBeenCalledTimes(1);
    expect(endCurrentSession).toHaveBeenCalledWith(true);
  });

  it('waits from its LOAD, not from joining: nothing playing here, a song picked later (prod 2026-11-05 10:36, T5)', async () => {
    const { manager, endCurrentSession } = harness(null);
    const started = manager.startPlaybackForCurrentSession('session-started');
    await jest.advanceTimersByTimeAsync(3200);
    await started;
    // Nothing to cast yet: no LOAD, so no wait and no stop.
    await jest.advanceTimersByTimeAsync(11_000);
    load(manager);
    await jest.advanceTimersByTimeAsync(1100);
    manager.receiveRelayedStatus(SID, { type: 'aurora.status', castingClientId: 'web:desktop-b', playerState: 'BUFFERING', ts: Date.now() });
    await jest.advanceTimersByTimeAsync(13_000);
    expect(manager.logCast).not.toHaveBeenCalledWith('warn', 'cast-takeover-unheard', expect.anything());
    expect(endCurrentSession).not.toHaveBeenCalled();
    expect((manager as unknown as { recoverStaleTransport: jest.Mock }).recoverStaleTransport).toHaveBeenCalledWith('deaf-takeover');
  });

  it("still leaves another of my own devices' cast, known by name (#211)", async () => {
    const { manager, endCurrentSession } = harness(null);
    manager.setCastingElsewhereCheck((_name, options) => options?.joinedRunningSession === true);
    const started = manager.startPlaybackForCurrentSession('session-started');
    await jest.advanceTimersByTimeAsync(3200);
    await started;
    expect(endCurrentSession).toHaveBeenCalledWith(false);
    expect(manager.handleCastConnected).not.toHaveBeenCalled();
  });
});

it('takes a relayed status only for its own Cast session, and once when heard both ways', () => {
  const { manager } = harness(null);
  manager.receiveRelayedStatus('another-session', { type: 'aurora.status', ts: 5 });
  manager.receiveRelayedStatus(SID, { type: 'aurora.control.ack' });
  expect(manager.applyAuroraStatus).not.toHaveBeenCalled();
  manager.lastAuroraStatus = { type: 'aurora.status', ts: 10 };
  manager.receiveRelayedStatus(SID, { type: 'aurora.status', ts: 10 });
  expect(manager.applyAuroraStatus).not.toHaveBeenCalled();
  manager.receiveRelayedStatus(SID, { type: 'aurora.status', ts: 11 });
  expect(manager.applyAuroraStatus).toHaveBeenCalledTimes(1);
});

it('while joining to take over, a status of the cast it replaces says whose it is and nothing more', () => {
  const { manager } = harness(null);
  manager.receiveRelayedStatus(SID, { type: 'aurora.status', castingClientId: 'web:phone-a', playerState: 'PLAYING', queueEntryId: 'e10', ts: 20 });
  expect(manager.applyAuroraStatus).not.toHaveBeenCalled();
  expect(manager.lastAuroraStatus).toMatchObject({ castingClientId: 'web:phone-a' });
});

it("names this device in every LOAD request, next to the media token", () => {
  const manager = Object.create(CastManager.prototype) as unknown as {
    loadRequestCustomData(url: string): Record<string, string>;
  };
  Object.assign(manager, { customAppId: 'APP', castTokenFor: () => 'media-token' });
  expect(manager.loadRequestCustomData('/api/stream/t/playlist.m3u8')).toEqual({ token: 'media-token', castingClientId: 'web:desktop-b' });
  // Google's default receiver takes none of it.
  Object.assign(manager, { customAppId: '' });
  expect(manager.loadRequestCustomData('/api/stream/t/playlist.m3u8')).toBeUndefined();
});
