import { CastManager, AuroraReceiverStatus } from '../CastManager';
import { CastQueueInsertAcks, serializedBytes } from '../castQueueWindow';
import type { TrackInfo } from '../fileSystem';

jest.mock('../PlaybackManager', () => ({ playbackManager: {} }));
const mockState = { playlist: [] as TrackInfo[], currentIndex: 0, repeat: 'none' as 'none' | 'one' | 'all', streamingQuality: '192' };
jest.mock('../../store', () => ({ usePlayerStore: { getState: () => mockState, setState: jest.fn() } }));

type Item = { itemId?: number; media: { contentId: string; customData: { queueEntryId: string; token?: string }; metadata: { title: string } } };
type Request = { media: Item['media']; queueData: { items: Item[]; startIndex: number; repeatMode: string }; currentTime?: number };
class LoadRequest { constructor(public media: Item['media']) {} }
class ItemsRequest { constructor(public items: unknown[]) {} }
type Internals = {
    chooseCurrentPosition(media: unknown): { currentTime: number | null; duration: number | null; source: string };
    publishPosition(position: number): void;
    lastAuroraStatus: AuroraReceiverStatus | null; lastAuroraStatusAt: number;
    queueItemIdByEntryId: Map<string, number>; queueWindow: { ids: string[]; blocked: boolean } | null;
    queueInsertAcks: CastQueueInsertAcks; reconcileQueueWindow(edited?: boolean): Promise<void>;
    maybeAdoptQueueWindow(status: AuroraReceiverStatus): void; recoverStaleTransport: jest.Mock; logCast: jest.Mock;
};
function harness() {
    Object.assign(globalThis, { chrome: { cast: { media: {
        LoadRequest, QueueData: class {}, QueueInsertItemsRequest: ItemsRequest, QueueRemoveItemsRequest: ItemsRequest,
        QueueReorderItemsRequest: ItemsRequest,
        RepeatMode: { ALL: 'ALL', OFF: 'OFF', SINGLE: 'SINGLE' },
    } } } });
    const media = {
        items: [] as Item[], currentItemId: 1,
        queueRemoveItems: jest.fn((_request, ok) => ok()),
        queueInsertItems: jest.fn((_request, ok) => ok()),
        queueJumpToItem: jest.fn((_id, ok) => ok()), queueRemoveItem: jest.fn((_id, ok) => ok()), stop: jest.fn((_request, ok) => ok()),
        queueReorderItems: jest.fn((_request, ok) => ok()), queueSetRepeatMode: jest.fn((_mode, ok) => ok()),
        repeatMode: undefined as string | undefined,
    };
    const session = {
        getMediaSession: () => media, getSessionId: () => 'session',
        loadMedia: jest.fn<Promise<void>, [Request]>().mockResolvedValue(undefined),
        sendMessage: jest.fn().mockResolvedValue(undefined),
    };
    let active: unknown = session;
    const manager = Object.create(CastManager.prototype) as Pick<CastManager, keyof CastManager> & Internals;
    Object.assign(manager, {
        state: 'CONNECTED', castContext: { getCurrentSession: () => active }, currentLoadPromise: Promise.resolve(),
        queueLoadGeneration: 0, queueWindowBusy: false, queueWindowEditSeq: 0, queueWindowEditHandled: 0, queueJumpGeneration: 0, queueWindow: null,
        queueItemIdByEntryId: new Map(), queueInsertAcks: new CastQueueInsertAcks(), auroraControlRequestId: 0,
        auroraStatusFreshMs: 20000, lastAuroraStatus: null, lastAuroraStatusAt: 0, queueWindowAdoptionChecked: null,
        recoverStaleTransport: jest.fn().mockResolvedValue(false),
        logCast: jest.fn(), setHealthStatus: jest.fn(),
        buildQueueItem: (track: TrackInfo) => ({ media: { contentId: track.url, customData: { queueEntryId: track.queueEntryId }, metadata: { title: track.title } } }),
    });
    mockState.playlist = Array.from({ length: 68 }, (_, i) => ({ id: `${i}`, queueEntryId: `entry-${i}`, title: `Track ${i}`, url: `https://music.example/api/stream/${i}/playlist.m3u8?token=test` } as TrackInfo));
    mockState.currentIndex = 0; mockState.repeat = 'none';
    const report = (index: number, caps = ['queue-insert']) => {
        manager.lastAuroraStatus = { queueEntryId: `entry-${index}`, currentTime: 12, itemId: index + 1, caps };
        manager.lastAuroraStatusAt = Date.now();
        mockState.currentIndex = index;
    };
    localStorage.clear();
    const ack = () => {
        const [, message] = session.sendMessage.mock.calls[session.sendMessage.mock.calls.length - 1];
        manager.queueInsertAcks.acknowledge(active, { requestId: message.requestId, ok: true, inserted: message.items.length });
    };
    const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
    return { manager, session, media, report, ack, settle, replaceSession: (next: unknown = {}) => { active = next; } };
}

test('68 entries load a zero-relative window; a skip outside it loads a new window', async () => {
    const { manager, session } = harness();
    await manager.castQueue(mockState.playlist, 0);
    let request = session.loadMedia.mock.calls[0][0];
    expect(request.queueData.items).toHaveLength(30);
    expect(request.queueData.startIndex).toBe(0);
    expect(serializedBytes(request)).toBeLessThanOrEqual(24576);
    await manager.ensureQueuePlayback(mockState.playlist, 66);
    request = session.loadMedia.mock.calls[1][0];
    // Ten played entries ride along so Previous, and Google Home's Previous, jump back.
    expect(request.queueData.items.map(item => item.media.customData.queueEntryId))
        .toEqual(Array.from({ length: 12 }, (_, i) => `entry-${56 + i}`));
    expect(request.queueData.startIndex).toBe(10);
    expect(request.media.customData.queueEntryId).toBe('entry-66');
});

test('invalid_parameter retries smaller queues and retains the local remainder', async () => {
    const { manager, session } = harness();
    session.loadMedia.mockRejectedValueOnce({ code: 'invalid_parameter' }).mockRejectedValueOnce({ code: 'invalid_parameter' });
    await manager.castQueue(mockState.playlist);
    expect(session.loadMedia.mock.calls.map(([request]) => request.queueData.items.length)).toEqual([30, 15, 6]);
    expect(mockState.playlist).toHaveLength(68);
});

test('refill waits for an ack and concurrent ticks never duplicate the insert', async () => {
    const { manager, session, report, media } = harness();
    await manager.castQueue(mockState.playlist);
    for (let i = 0; i < 26; i++) manager.queueItemIdByEntryId.set(`entry-${i}`, i + 1);
    report(26);
    const pending = manager.reconcileQueueWindow();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await manager.reconcileQueueWindow();
    expect(media.queueRemoveItems).toHaveBeenCalledTimes(1);
    expect(session.sendMessage).toHaveBeenCalledTimes(1);
    // Played entries are pruned, keeping the last ten.
    expect(manager.queueWindow?.ids).toHaveLength(14);
    const request = session.sendMessage.mock.calls[0][1];
    expect(request.items).toHaveLength(20);
    manager.queueInsertAcks.acknowledge(session, { requestId: request.requestId, ok: true, inserted: 20 });
    await pending;
    expect(manager.queueWindow?.ids).toEqual(mockState.playlist.slice(16, 50).map(track => track.queueEntryId));
});

test('SDK fallback refills, and repeat-all wraps the local queue without looping a partial window', async () => {
    const { manager, session, report, media } = harness();
    mockState.repeat = 'all';
    await manager.castQueue(mockState.playlist, 60, 'all');
    const request = session.loadMedia.mock.calls[0][0];
    expect(request.queueData.repeatMode).toBe('OFF');
    expect(request.queueData.items).toHaveLength(30); // 10 previous count toward the cap
    expect(request.queueData.items[0].media.customData.queueEntryId).toBe('entry-50');
    expect(request.queueData.items[18].media.customData.queueEntryId).toBe('entry-0');
    for (const [i, item] of request.queueData.items.slice(0, 28).entries()) manager.queueItemIdByEntryId.set(item.media.customData.queueEntryId, i + 1);
    report(9, []);
    await manager.reconcileQueueWindow();
    expect(media.queueInsertItems).toHaveBeenCalledTimes(1);
    expect(session.sendMessage).not.toHaveBeenCalled();
});

test('outside edits stay local; an inside edit without a known item ID reloads at receiver position', async () => {
    const { manager, session, report } = harness();
    await manager.castQueue(mockState.playlist);
    report(0);
    mockState.playlist.splice(55, 1);
    await manager.reconcileQueueWindow(true);
    expect(session.loadMedia).toHaveBeenCalledTimes(1);
    mockState.playlist.splice(2, 1);
    await manager.reconcileQueueWindow(true);
    expect(session.loadMedia).toHaveBeenCalledTimes(2);
    expect(session.loadMedia.mock.calls[1][0].currentTime).toBe(12);
});

test('replacement session fences a late LOAD and prevents automatic refills', async () => {
    const { manager, session, replaceSession } = harness();
    let finish!: () => void;
    session.loadMedia.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = manager.castQueue(mockState.playlist);
    await Promise.resolve();
    replaceSession(); finish(); await pending;
    expect(manager.queueWindow).toBeNull();
    await manager.reconcileQueueWindow();
    expect(session.sendMessage).not.toHaveBeenCalled();
});


test('removing the current item jumps before removing it when IDs are proven', async () => {
    const { manager, session, report, media } = harness();
    await manager.castQueue(mockState.playlist);
    report(0);
    manager.queueItemIdByEntryId.set('entry-0', 1);
    manager.queueItemIdByEntryId.set('entry-1', 2);
    media.items = [{ itemId: 2, media: { contentId: 'next', customData: { queueEntryId: 'entry-1' }, metadata: { title: 'next' } } }];
    mockState.playlist.shift();
    await manager.reconcileQueueWindow(true);
    expect(media.queueJumpToItem.mock.calls[0][0]).toBe(2);
    expect(media.queueRemoveItem.mock.calls[0][0]).toBe(1);
    expect(media.queueJumpToItem.mock.invocationCallOrder[0]).toBeLessThan(media.queueRemoveItem.mock.invocationCallOrder[0]);
    expect(session.loadMedia).toHaveBeenCalledTimes(1);
});

test('removing the final playing item stops, without restarting the preceding track', async () => {
    const { manager, session, report, media } = harness();
    await manager.castQueue(mockState.playlist, 67);
    report(67);
    mockState.playlist.pop();
    await manager.reconcileQueueWindow(true);
    expect(media.stop).toHaveBeenCalledTimes(1);
    expect(session.loadMedia).toHaveBeenCalledTimes(1);
    expect(manager.queueWindow).toBeNull();
});

test('uncertain insert blocks retries until an explicit reload', async () => {
    const { manager, session, report } = harness();
    mockState.playlist = mockState.playlist.slice(0, 3);
    await manager.castQueue(mockState.playlist);
    report(0);
    mockState.playlist.push({ ...mockState.playlist[0], id: 'next', queueEntryId: 'next' });
    session.sendMessage.mockRejectedValueOnce(new Error('transport closed after send'));
    await manager.reconcileQueueWindow(true);
    await manager.reconcileQueueWindow();
    expect(manager.queueWindow?.blocked).toBe(true);
    expect(session.sendMessage).toHaveBeenCalledTimes(1);
});


test('receiver track 8/154 wins over a live but different RemotePlayer at 248/248', () => {
    const { manager, report } = harness();
    report(1);
    Object.assign(manager, {
        player: { currentTime: 248.4, duration: 248.4, mediaInfo: { customData: { queueEntryId: 'entry-0' } } },
        lastRemotePositionEntryId: 'entry-0', lastRemotePositionAt: Date.now(),
    });
    manager.lastAuroraStatus = { queueEntryId: 'entry-1', currentTime: 8, duration: 154 };
    expect(manager.chooseCurrentPosition({ media: { customData: { queueEntryId: 'entry-0' }, duration: 248.4 }, currentTime: 248.4 }))
        .toEqual({ currentTime: 8, duration: 154, source: 'media-session' });
});

test('duplicate URLs without entry identity are rejected and old anchors do not cross tracks', () => {
    const { manager } = harness();
    mockState.playlist[1].url = mockState.playlist[0].url;
    Object.assign(manager, {
        player: { currentTime: 220, duration: 230, mediaInfo: { contentId: mockState.playlist[0].url } },
        lastRemotePositionEntryId: 'entry-0', lastRemotePositionAt: Date.now(),
    });
    expect(manager.chooseCurrentPosition({ media: { contentId: mockState.playlist[0].url }, currentTime: 220 }).source).toBe('none');
    manager.publishPosition(200);
    mockState.currentIndex = 1;
    expect(manager.getCurrentCastTime()).toBe(0);
});

test('Play Next inside the window is mirrored through the receiver channel, without a reload', async () => {
    const { manager, session, report, ack, settle } = harness();
    await manager.castQueue(mockState.playlist);
    report(0);
    mockState.playlist.splice(1, 0, { ...mockState.playlist[40], queueEntryId: 'next' });
    const pending = manager.reconcileQueueWindow(true);
    await settle();
    const message = session.sendMessage.mock.calls[0][1];
    expect(message).toMatchObject({ type: 'aurora.queue.insert', position: 'next' });
    ack();
    await pending;
    expect(session.loadMedia).toHaveBeenCalledTimes(1);
    expect(manager.queueWindow?.ids.slice(0, 3)).toEqual(['entry-0', 'next', 'entry-1']);
});

test('remove and move inside the window use item-ID commands when the IDs are known', async () => {
    const { manager, session, report, media, settle } = harness();
    await manager.castQueue(mockState.playlist);
    report(0);
    for (let i = 0; i < 30; i++) manager.queueItemIdByEntryId.set(`entry-${i}`, i + 1);
    mockState.playlist.splice(3, 1);
    await manager.reconcileQueueWindow(true);
    expect(media.queueRemoveItems.mock.calls[0][0].items).toEqual([4]);
    const [moved] = mockState.playlist.splice(1, 1);
    mockState.playlist.splice(4, 0, moved);
    await manager.reconcileQueueWindow(true);
    await settle();
    const reorder = media.queueReorderItems.mock.calls[0][0];
    expect(reorder.items).toEqual([2]);
    expect(reorder.insertBefore).toBe(7);
    expect(session.loadMedia).toHaveBeenCalledTimes(1);
});

test('toggling repeat sets the receiver mode instead of reloading', async () => {
    const { manager, session, report, media } = harness();
    mockState.playlist = mockState.playlist.slice(0, 10);
    await manager.castQueue(mockState.playlist);
    report(0);
    mockState.repeat = 'one';
    await manager.reconcileQueueWindow(true);
    expect(media.queueSetRepeatMode.mock.calls[0][0]).toBe('SINGLE');
    mockState.repeat = 'all';
    await manager.reconcileQueueWindow(true);
    expect(media.queueSetRepeatMode.mock.calls[1][0]).toBe('ALL'); // the whole queue is on the receiver
    expect(session.loadMedia).toHaveBeenCalledTimes(1);
});

test('a complete window delivers an append at once, as before windowing', async () => {
    const { manager, session, report, ack, settle } = harness();
    mockState.playlist = mockState.playlist.slice(0, 20);
    await manager.castQueue(mockState.playlist);
    report(0); // 19 upcoming, far above the low-water mark
    mockState.playlist.push({ ...mockState.playlist[0], queueEntryId: 'added' });
    const pending = manager.reconcileQueueWindow(true);
    await settle();
    expect(session.sendMessage.mock.calls[0][1]).toMatchObject({ position: 'end', items: [expect.anything()] });
    ack();
    await pending;
    expect(manager.queueWindow?.ids).toContain('added');
});

test('pruning skips unknown item IDs and never reloads', async () => {
    const { manager, session, report, media, ack, settle } = harness();
    await manager.castQueue(mockState.playlist);
    manager.queueItemIdByEntryId.set('entry-3', 4); // the phone slept through the rest
    report(26);
    const pending = manager.reconcileQueueWindow();
    await settle();
    expect(media.queueRemoveItems.mock.calls[0][0].items).toEqual([4]);
    ack();
    await pending;
    expect(session.loadMedia).toHaveBeenCalledTimes(1);
    expect(manager.queueWindow?.ids).not.toContain('entry-3');
    expect(manager.queueWindow?.ids).toContain('entry-2');
});

test('a resumed sender adopts its stored window only on proof, and never reloads', async () => {
    const { manager, session, replaceSession } = harness();
    await manager.castQueue(mockState.playlist);
    const resumed = { ...session, getSessionId: () => 'session' };
    replaceSession(resumed);
    manager.maybeAdoptQueueWindow({ queueEntryId: 'entry-4', itemId: 5, currentItemIndex: 4, queueLength: 30 });
    expect(manager.queueWindow?.ids).toHaveLength(30);
    expect((manager.queueWindow as unknown as { session: unknown }).session).toBe(resumed);

    const other = { ...session, getSessionId: () => 'session' };
    replaceSession(other);
    manager.maybeAdoptQueueWindow({ queueEntryId: 'entry-4', itemId: 5, currentItemIndex: 4, queueLength: 31 });
    expect(manager.queueWindow).toBeNull();
    expect(manager.logCast).toHaveBeenCalledWith('warn', 'queue-window-not-adopted', 'reason=receiver-count-mismatch');
    expect(session.loadMedia).toHaveBeenCalledTimes(1);
});

test('a LOAD into a dead transport recovers and retries on the recovered session', async () => {
    const { manager, session, replaceSession } = harness();
    const dead = Object.assign(new Error('Presentation connection is disconnected.'), { name: 'InvalidStateError' });
    session.loadMedia.mockRejectedValueOnce(dead);
    const recovered = { ...session, getSessionId: () => 'session', loadMedia: jest.fn().mockResolvedValue(undefined) };
    manager.recoverStaleTransport.mockImplementation(async () => { replaceSession(recovered); return true; });
    await manager.castQueue(mockState.playlist);
    expect(manager.recoverStaleTransport).toHaveBeenCalledWith('load-queue', dead);
    expect(recovered.loadMedia).toHaveBeenCalledTimes(1);
    expect((manager.queueWindow as unknown as { session: unknown }).session).toBe(recovered);
});

test('Previous jumps to a kept played entry by its reported item ID', async () => {
    const { manager, session, report, media } = harness();
    await manager.castQueue(mockState.playlist, 10);
    report(10);
    manager.queueItemIdByEntryId.set('entry-9', 2); // reported while it played
    await manager.ensureQueuePlayback(mockState.playlist, 9);
    expect(media.queueJumpToItem.mock.calls[0][0]).toBe(2);
    expect(session.loadMedia).toHaveBeenCalledTimes(1);
});

test('play state from the receiver applies even when its entry is unknown; position does not', () => {
    const { manager } = harness();
    const onPlayStateChange = jest.fn();
    const onTime = jest.fn();
    Object.assign(manager, { onPlayStateChange, onTimeUpdate: onTime, publishPosition: onTime, publishDuration: onTime });
    const apply = (status: AuroraReceiverStatus) => (manager as unknown as { applyAuroraStatus(s: AuroraReceiverStatus): void }).applyAuroraStatus(status);
    apply({ queueEntryId: null, playerState: 'PAUSED', currentTime: 248.4, duration: 248.4 });
    apply({ queueEntryId: 'not-in-the-local-queue', playerState: 'PLAYING', currentTime: 248.4, duration: 248.4 });
    expect(onPlayStateChange.mock.calls).toEqual([[false], [true]]);
    expect(onTime).not.toHaveBeenCalled();
});

describe('receiver item IDs inferred from position (prod 2026-10-12: CAF numbers items consecutively)', () => {
    const apply = (manager: unknown, status: AuroraReceiverStatus) =>
        (manager as { applyAuroraStatus(s: AuroraReceiverStatus): void }).applyAuroraStatus(status);
    const seeded = async () => {
        const h = harness();
        Object.assign(h.manager, { onTrackChange: jest.fn(), onPlayStateChange: jest.fn() });
        await h.manager.castQueue(mockState.playlist, 10); // entries 0..29, start at position 10
        mockState.currentIndex = 10;
        apply(h.manager, { queueEntryId: 'entry-10', itemId: 33, playerState: 'PLAYING', currentTime: 1 });
        return h;
    };

    it('one observed ID gives the whole window, so a skip deep into it jumps instead of reloading', async () => {
        const { manager, session, media } = await seeded();
        expect(manager.queueItemIdByEntryId.get('entry-0')).toBe(23);
        expect(manager.queueItemIdByEntryId.get('entry-29')).toBe(52);
        await manager.ensureQueuePlayback(mockState.playlist, 25);
        expect(media.queueJumpToItem.mock.calls[0][0]).toBe(48);
        expect(session.loadMedia).toHaveBeenCalledTimes(1);
    });

    it('one contradiction turns inference off and falls back to a reload', async () => {
        const { manager, session, media } = await seeded();
        apply(manager, { queueEntryId: 'entry-11', itemId: 99, playerState: 'PLAYING', currentTime: 1 });
        expect(manager.logCast).toHaveBeenCalledWith('warn', 'queue-item-id-inference-mismatch', expect.stringContaining('inferred=34 observed=99'));
        expect(manager.queueItemIdByEntryId.get('entry-25')).toBeUndefined();
        await manager.ensureQueuePlayback(mockState.playlist, 25);
        expect(media.queueJumpToItem).not.toHaveBeenCalled();
        expect(session.loadMedia).toHaveBeenCalledTimes(2);
    });

    it('an SDK-listed item that names another track refutes the inferred ID before jumping', async () => {
        const { manager, session, media } = await seeded();
        media.items = [{ itemId: 48, media: { contentId: 'https://music.example/api/stream/50/playlist.m3u8', customData: {} as never, metadata: { title: 'x' } } }];
        await manager.ensureQueuePlayback(mockState.playlist, 25);
        expect(media.queueJumpToItem).not.toHaveBeenCalled();
        expect(session.loadMedia).toHaveBeenCalledTimes(2);
    });

    it('inserted items continue the numbering', async () => {
        const { manager, report, ack, settle } = await seeded();
        report(10);
        mockState.playlist.splice(11, 0, { ...mockState.playlist[50], queueEntryId: 'next' });
        const pending = manager.reconcileQueueWindow(true);
        await settle();
        ack();
        await pending;
        expect(manager.queueItemIdByEntryId.get('next')).toBe(53);
    });

    it('a reloaded sender adopts the stored IDs and keeps jumping', async () => {
        const { manager, session, media, replaceSession } = await seeded();
        manager.queueItemIdByEntryId.clear(); // the reload lost memory
        replaceSession({ ...session, getSessionId: () => 'session' });
        manager.maybeAdoptQueueWindow({ queueEntryId: 'entry-10', itemId: 33, currentItemIndex: 10, queueLength: 30 });
        expect(manager.queueItemIdByEntryId.get('entry-28')).toBe(51);
        await manager.ensureQueuePlayback(mockState.playlist, 28);
        expect(media.queueJumpToItem.mock.calls[0][0]).toBe(51);
        expect(session.loadMedia).toHaveBeenCalledTimes(1);
    });
});

describe('jumping without an SDK Media object (NAD 2026-10-12: every second Next reloaded)', () => {
    const setup = async () => {
        const h = harness();
        Object.assign(h.media, { mediaSessionId: 7 });
        await h.manager.castQueue(mockState.playlist, 10);
        h.manager.queueItemIdByEntryId.set('entry-12', 35);
        (h.session as { getMediaSession: () => unknown }).getMediaSession = () => null; // the receiver moved on
        return h;
    };
    afterEach(() => jest.useRealTimers());

    it('sends QUEUE_UPDATE on the media channel and accepts it once the receiver reports the entry', async () => {
        const { manager, session } = await setup();
        jest.useFakeTimers();
        const pending = manager.ensureQueuePlayback(mockState.playlist, 12);
        await Promise.resolve(); await Promise.resolve();
        expect(session.sendMessage).toHaveBeenCalledWith('urn:x-cast:com.google.cast.media',
            expect.objectContaining({ type: 'QUEUE_UPDATE', mediaSessionId: 7, currentItemId: 35 }));
        manager.lastAuroraStatus = { queueEntryId: 'entry-12', itemId: 35 };
        manager.lastAuroraStatusAt = Date.now() + 1;
        await jest.advanceTimersByTimeAsync(200);
        await pending;
        expect(session.loadMedia).toHaveBeenCalledTimes(1);
        expect(manager.logCast).toHaveBeenCalledWith('ok', 'Cast queue jump via media channel', expect.stringContaining('itemId=35'));
    });

    it('falls back to a LOAD after 3 s without evidence, and stops trying for the Cast session', async () => {
        const { manager, session } = await setup();
        jest.useFakeTimers();
        const pending = manager.ensureQueuePlayback(mockState.playlist, 12);
        await jest.advanceTimersByTimeAsync(3100);
        await pending;
        expect(session.loadMedia).toHaveBeenCalledTimes(2);
        expect(manager.logCast).toHaveBeenCalledWith('warn', 'Cast queue jump via media channel unconfirmed', expect.any(String));
        // The next window in this Cast session does not pay the wait again.
        manager.queueItemIdByEntryId.set('entry-13', 36);
        (manager.queueWindow as unknown as { mediaSessionId: number }).mediaSessionId = 7;
        session.sendMessage.mockClear();
        await manager.ensureQueuePlayback(mockState.playlist, 13);
        expect(session.sendMessage).not.toHaveBeenCalled();
        expect(session.loadMedia).toHaveBeenCalledTimes(3);
    });
});

describe('a jump that is never acknowledged (NAD 2026-10-12 21:26: stale SDK Media object)', () => {
    afterEach(() => jest.useRealTimers());
    const stale = async () => {
        const h = harness();
        await h.manager.castQueue(mockState.playlist, 10);
        for (let i = 0; i < 30; i++) h.manager.queueItemIdByEntryId.set(`entry-${i}`, 100 + i);
        h.media.queueJumpToItem.mockImplementation(() => {}); // accepts the call, never answers
        jest.useFakeTimers();
        return h;
    };

    it('reloads at the requested track by itself, with no error and no blocked window', async () => {
        const { manager, session } = await stale();
        const pending = manager.ensureQueuePlayback(mockState.playlist, 12);
        await jest.advanceTimersByTimeAsync(3100);
        await pending;
        expect(manager.logCast).toHaveBeenCalledWith('warn', 'Cast queue jump via SDK unconfirmed', expect.stringContaining('itemId=112'));
        expect(session.loadMedia).toHaveBeenCalledTimes(2);
        expect(session.loadMedia.mock.calls[1][0].media.customData.queueEntryId).toBe('entry-12');
        expect((manager as unknown as { setHealthStatus: jest.Mock }).setHealthStatus).not.toHaveBeenCalledWith('error', expect.anything());
        expect(manager.queueWindow?.blocked).toBe(false);
    });

    it('only the latest of several quick presses falls back to a reload', async () => {
        const { manager, session } = await stale();
        const first = manager.ensureQueuePlayback(mockState.playlist, 12);
        await jest.advanceTimersByTimeAsync(500);
        const second = manager.ensureQueuePlayback(mockState.playlist, 13);
        await jest.advanceTimersByTimeAsync(3100);
        await Promise.all([first, second]);
        expect(session.loadMedia).toHaveBeenCalledTimes(2);
        expect(session.loadMedia.mock.calls[1][0].media.customData.queueEntryId).toBe('entry-13');
    });
});
