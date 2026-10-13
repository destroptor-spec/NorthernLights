import { CastManager } from '../CastManager';
import { CastPlaybackConfirmation } from '../castPlaybackConfirmation';

const pauseLocal = jest.fn();
jest.mock('../PlaybackManager', () => ({ playbackManager: { getLocalAudioElement: () => ({ pause: pauseLocal }) } }));
jest.mock('../../store', () => ({ usePlayerStore: { getState: () => ({ playlist: [], currentIndex: 0 }), setState: jest.fn() } }));

type Internals = {
    hydrateSenderFromRemoteSession(mediaSession: unknown, reason: string): Promise<boolean>;
    logCast: jest.Mock;
    syncCurrentTrackFromSession: jest.Mock;
    publishPlayState: jest.Mock;
};

/**
 * Prod 2026-10-13 18:27:59: 13 ms after cast-ended-handoff started the track
 * on the phone, IS_MEDIA_LOADED_CHANGED hydrated from the remote player of the
 * session that had just ended (sid=none) and paused the local player. The
 * HLS load happened to be slower; a prepared or cached track would have been
 * silenced while the app showed it playing.
 */
function harness(session: unknown) {
    Object.assign(globalThis, { chrome: { cast: { media: { PlayerState: { PLAYING: 'PLAYING', PAUSED: 'PAUSED' } } } } });
    const manager = Object.create(CastManager.prototype) as Internals;
    Object.assign(manager, {
        castContext: { getCurrentSession: () => session },
        player: null,
        playbackConfirmation: new CastPlaybackConfirmation(),
        confirmationLoadAccepted: false,
        logCast: jest.fn(),
        syncCurrentTrackFromSession: jest.fn(() => true),
        chooseCurrentPosition: jest.fn(() => ({ currentTime: 38.8, duration: 205, source: 'remote' })),
        publishDuration: jest.fn(),
        publishPosition: jest.fn(),
        publishPlayState: jest.fn(),
        syncBrowserMediaSessionFromCast: jest.fn(),
        msSinceRemotePlayerEvent: () => 0,
    });
    return manager;
}

const remoteMedia = { media: { contentId: 'x', customData: { queueEntryId: 'e' } }, playerState: 'PLAYING' };

beforeEach(() => pauseLocal.mockClear());

it('does not touch the local player once the Cast session has ended', async () => {
    const manager = harness(null);
    expect(await manager.hydrateSenderFromRemoteSession(remoteMedia, 'remote-media-loaded-changed')).toBe(false);
    expect(pauseLocal).not.toHaveBeenCalled();
    expect(manager.syncCurrentTrackFromSession).not.toHaveBeenCalled();
    expect(manager.publishPlayState).not.toHaveBeenCalled();
    expect(manager.logCast).toHaveBeenCalledWith('ok', 'hydrate-skipped-no-session', 'reason=remote-media-loaded-changed');
});

it('still hydrates while a session exists', async () => {
    const manager = harness({ getSessionId: () => 'c0a7abfb' });
    expect(await manager.hydrateSenderFromRemoteSession(remoteMedia, 'remote-media-loaded-changed')).toBe(true);
    expect(pauseLocal).toHaveBeenCalledTimes(1);
    expect(manager.publishPlayState).toHaveBeenCalledWith(true);
});
