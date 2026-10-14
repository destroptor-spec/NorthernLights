import { CastManager } from '../CastManager';
import { ReceiverFollowAcks } from '../receiverSessionFollow';

jest.mock('../PlaybackManager', () => ({ playbackManager: {} }));
jest.mock('../../store', () => ({ usePlayerStore: { getState: () => ({ playlist: [], currentIndex: 0 }), setState: jest.fn() } }));

type Internals = {
    attachAuroraStatusListener(session: unknown, sessionId: string): void;
    receiverCanFollowSession(): boolean;
    addReceiverCanFollowListener(listener: () => void): () => void;
    handOverSessionToReceiver(handover: Record<string, unknown>, reason: string): Promise<boolean>;
    runReceiverProbe(sseToken: string): Promise<string>;
    logCast: jest.Mock;
};

const NS = 'urn:x-cast:aurora.status';
const handover = {
    sessionId: 'session-1', outputId: 'receiver:cast-77', generation: 3,
    token: 'receiver-secret-token', expiresAt: '2026-10-15T10:00:00.000Z',
};

/**
 * Phase 5, PR C: the receiver says it can follow a playback session in its
 * aurora.status caps, and takes the session and credential in an
 * acknowledged aurora.session.follow message.
 */
function harness(options: { answer?: (message: { requestId: number }) => unknown } = {}) {
    let onMessage: (ns: string, message: string) => void = () => undefined;
    const sent: Array<{ ns: string; message: Record<string, unknown> }> = [];
    const session = {
        getSessionId: () => 'cast-77',
        addMessageListener: (_ns: string, listener: typeof onMessage) => { onMessage = listener; },
        sendMessage: jest.fn(async (ns: string, message: { requestId: number }) => {
            sent.push({ ns, message: message as unknown as Record<string, unknown> });
            const reply = options.answer?.(message);
            if (reply) queueMicrotask(() => onMessage(NS, JSON.stringify(reply)));
        }),
    };
    let connected = true;
    const manager = Object.create(CastManager.prototype) as Internals;
    Object.assign(manager, {
        castContext: { getCurrentSession: () => (connected ? session : null) },
        auroraControlRequestId: 0,
        auroraControlCapLoggedSid: null,
        sessionFollowCapSid: '',
        receiverFollowListeners: new Set(),
        receiverFollowAcks: new ReceiverFollowAcks(),
        probeAcks: new Map(),
        logCast: jest.fn(),
        applyAuroraStatus: jest.fn(),
        syncReceiverDiagnostics: jest.fn(),
        isConnected: () => connected,
    });
    manager.attachAuroraStatusListener(session, 'cast-77');
    const status = (caps: string[]) => onMessage(NS, JSON.stringify({ type: 'aurora.status', caps }));
    return { manager, session, sent, status, disconnect: () => { connected = false; } };
}

it('knows a receiver can follow only once its status says so, and tells listeners once per Cast session', () => {
    const { manager, status } = harness();
    const listener = jest.fn();
    manager.addReceiverCanFollowListener(listener);
    status(['control', 'queue-insert', 'diagnostics']);
    expect(manager.receiverCanFollowSession()).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    status(['control', 'queue-insert', 'diagnostics', 'session-follow']);
    status(['control', 'queue-insert', 'diagnostics', 'session-follow']);
    expect(manager.receiverCanFollowSession()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(manager.logCast).toHaveBeenCalledWith('ok', 'receiver-can-follow', 'sid=cast-77');
});

it('hands the session over and settles on the receiver ack, never logging the token', async () => {
    const { manager, sent, status } = harness({ answer: (message) => ({ type: 'aurora.session.follow.ack', requestId: message.requestId, ok: true }) });
    status(['session-follow']);
    await expect(manager.handOverSessionToReceiver(handover, 'claim')).resolves.toBe(true);
    expect(sent).toEqual([{ ns: NS, message: { type: 'aurora.session.follow', requestId: 1, ...handover } }]);
    expect(manager.logCast).toHaveBeenLastCalledWith('ok', 'receiver-session-handover', 'sid=cast-77 reason=claim generation=3 result=acked attempts=1');
    expect(JSON.stringify(manager.logCast.mock.calls)).not.toContain('receiver-secret-token');
});

it('sends nothing to a receiver that has not said it can follow, or once disconnected', async () => {
    const plain = harness();
    plain.status(['control']);
    await expect(plain.manager.handOverSessionToReceiver(handover, 'claim')).resolves.toBe(false);
    expect(plain.session.sendMessage).not.toHaveBeenCalled();

    const gone = harness();
    gone.status(['session-follow']);
    gone.disconnect();
    await expect(gone.manager.handOverSessionToReceiver(handover, 'refresh')).resolves.toBe(false);
    expect(gone.session.sendMessage).not.toHaveBeenCalled();
});

it('reports a refusal', async () => {
    const { manager, status } = harness({ answer: (message) => ({ type: 'aurora.session.follow.ack', requestId: message.requestId, ok: false }) });
    status(['session-follow']);
    await expect(manager.handOverSessionToReceiver(handover, 'claim')).resolves.toBe(false);
    expect(manager.logCast).toHaveBeenLastCalledWith('warn', 'receiver-session-handover', 'sid=cast-77 reason=claim generation=3 result=refused attempts=1');
});

describe('the receiver probe', () => {
    it('asks the receiver to run it and says whether it started', async () => {
        const { manager, sent } = harness({ answer: (message) => ({ type: 'aurora.probe.ack', requestId: message.requestId, accepted: true }) });
        await expect(manager.runReceiverProbe('sse-15m')).resolves.toBe('started');
        expect(sent).toEqual([{ ns: NS, message: { type: 'aurora.probe', requestId: 1, sseToken: 'sse-15m' } }]);
        expect(manager.logCast).toHaveBeenLastCalledWith('ok', 'receiver-probe-sent', 'sid=cast-77 result=started');
        expect(JSON.stringify(manager.logCast.mock.calls)).not.toContain('sse-15m');
    });

    it('tells a busy receiver from one without the probe', async () => {
        const busy = harness({ answer: (message) => ({ type: 'aurora.probe.ack', requestId: message.requestId, accepted: false }) });
        await expect(busy.manager.runReceiverProbe('sse-15m')).resolves.toBe('busy');

        jest.useFakeTimers();
        try {
            const old = harness();
            const result = old.manager.runReceiverProbe('sse-15m');
            await jest.advanceTimersByTimeAsync(5_000);
            await expect(result).resolves.toBe('unanswered');
        } finally {
            jest.useRealTimers();
        }
    });

    it('does nothing when not casting', async () => {
        const { manager, session, disconnect } = harness();
        disconnect();
        await expect(manager.runReceiverProbe('sse-15m')).resolves.toBe('not-connected');
        expect(session.sendMessage).not.toHaveBeenCalled();
    });
});
