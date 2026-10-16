import { CastManager } from '../CastManager';

jest.mock('../PlaybackManager', () => ({ playbackManager: {} }));
jest.mock('../../store', () => ({ usePlayerStore: { getState: () => ({ playlist: [], currentIndex: 0 }), setState: jest.fn() } }));

type Internals = {
    attachMediaSessionListener(session: unknown): void;
    attachAuroraStatusListener: jest.Mock;
    hydrateSenderFromRemoteSession: jest.Mock;
    logCast: jest.Mock;
};

/**
 * Prod 2026-10-16 08:43:01 (Beoplay A9): a stale-transport recovery rejoined
 * the same Cast session ID through a new session object. The listeners were
 * keyed by ID, so they stayed on the dead object: the receiver kept sending
 * its status, the sender heard nothing for seven minutes, called the music
 * gone while it played, and reloaded the queue twice for a song already
 * playing until the listener reconnected by hand.
 */
function harness() {
    Object.assign(globalThis, { cast: { framework: { SessionEventType: { MEDIA_SESSION: 'mediasession' } } } });
    let current: unknown = null;
    const manager = Object.create(CastManager.prototype) as Internals;
    Object.assign(manager, {
        castContext: { getCurrentSession: () => current },
        mediaSessionListenerSession: null,
        queueWindow: null,
        logCast: jest.fn(),
        attachAuroraStatusListener: jest.fn(),
        hydrateSenderFromRemoteSession: jest.fn(async () => true),
        noteSdkMedia: jest.fn(),
        describeMediaSession: () => '',
        getMediaSession: () => null,
    });
    const sessionObject = (id: string) => {
        const handlers: Array<(event: unknown) => void> = [];
        return {
            getSessionId: () => id,
            addEventListener: jest.fn((_type: string, handler: (event: unknown) => void) => handlers.push(handler)),
            fire: () => handlers.forEach((handler) => handler({ mediaSession: { media: {} } })),
        };
    };
    return { manager, sessionObject, setCurrent: (session: unknown) => { current = session; } };
}

it('attaches once per session object, however often it is asked', () => {
    const { manager, sessionObject, setCurrent } = harness();
    const session = sessionObject('f5fd060a');
    setCurrent(session);
    manager.attachMediaSessionListener(session);
    manager.attachMediaSessionListener(session);
    expect(session.addEventListener).toHaveBeenCalledTimes(1);
    expect(manager.attachAuroraStatusListener).toHaveBeenCalledTimes(1);
});

it('attaches again to the new object a recovery rejoins the same Cast session with', () => {
    const { manager, sessionObject, setCurrent } = harness();
    const before = sessionObject('f5fd060a');
    setCurrent(before);
    manager.attachMediaSessionListener(before);

    const after = sessionObject('f5fd060a');
    setCurrent(after);
    manager.attachMediaSessionListener(after);
    expect(after.addEventListener).toHaveBeenCalledTimes(1);
    expect(manager.attachAuroraStatusListener).toHaveBeenLastCalledWith(after, 'f5fd060a');
    expect(manager.logCast).toHaveBeenLastCalledWith('ok', 'Attached MEDIA_SESSION listener', 'sid=f5fd060a rebound=true');
});

it('hears new media only through the current session object', () => {
    const { manager, sessionObject, setCurrent } = harness();
    const before = sessionObject('f5fd060a');
    setCurrent(before);
    manager.attachMediaSessionListener(before);
    const after = sessionObject('f5fd060a');
    setCurrent(after);
    manager.attachMediaSessionListener(after);

    before.fire();
    expect(manager.hydrateSenderFromRemoteSession).not.toHaveBeenCalled();
    after.fire();
    expect(manager.hydrateSenderFromRemoteSession).toHaveBeenCalledTimes(1);
});
