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
    lastAuroraStatus: AuroraReceiverStatus | null; lastAuroraStatusAt: number;
    queueItemIdByEntryId: Map<string, number>; queueWindow: { ids: string[]; blocked: boolean } | null;
    queueInsertAcks: CastQueueInsertAcks; reconcileQueueWindow(edited?: boolean): Promise<void>;
};
function harness() {
    Object.assign(globalThis, { chrome: { cast: { media: {
        LoadRequest, QueueData: class {}, QueueInsertItemsRequest: ItemsRequest, QueueRemoveItemsRequest: ItemsRequest,
        RepeatMode: { ALL: 'ALL', OFF: 'OFF', SINGLE: 'SINGLE' },
    } } } });
    const media = {
        items: [] as Item[], currentItemId: 1,
        queueRemoveItems: jest.fn((_request, ok) => ok()),
        queueInsertItems: jest.fn((_request, ok) => ok()),
        queueJumpToItem: jest.fn((_id, ok) => ok()), queueRemoveItem: jest.fn((_id, ok) => ok()), stop: jest.fn((_request, ok) => ok()),
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
        queueLoadGeneration: 0, queueWindowBusy: false, queueWindowEdited: false, queueWindow: null,
        queueItemIdByEntryId: new Map(), queueInsertAcks: new CastQueueInsertAcks(), auroraControlRequestId: 0,
        auroraStatusFreshMs: 20000, lastAuroraStatus: null, lastAuroraStatusAt: 0,
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
    return { manager, session, media, report, replaceSession: () => { active = {}; } };
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
    expect(request.queueData.items.map(item => item.media.customData.queueEntryId)).toEqual(['entry-66', 'entry-67']);
    expect(request.queueData.startIndex).toBe(0);
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
    expect(manager.queueWindow?.ids).toHaveLength(4);
    const request = session.sendMessage.mock.calls[0][1];
    expect(request.items).toHaveLength(20);
    manager.queueInsertAcks.acknowledge(session, { requestId: request.requestId, ok: true, inserted: 20 });
    await pending;
    expect(manager.queueWindow?.ids).toEqual(mockState.playlist.slice(26, 50).map(track => track.queueEntryId));
});

test('SDK fallback refills, and repeat-all wraps the local queue without looping a partial window', async () => {
    const { manager, session, report, media } = harness();
    mockState.repeat = 'all';
    await manager.castQueue(mockState.playlist, 60, 'all');
    const request = session.loadMedia.mock.calls[0][0];
    expect(request.queueData.repeatMode).toBe('OFF');
    expect(request.queueData.items[8].media.customData.queueEntryId).toBe('entry-0');
    for (const [i, item] of request.queueData.items.slice(0, 26).entries()) manager.queueItemIdByEntryId.set(item.media.customData.queueEntryId, i + 1);
    report(18, []);
    await manager.reconcileQueueWindow();
    expect(media.queueInsertItems).toHaveBeenCalledTimes(1);
    expect(session.sendMessage).not.toHaveBeenCalled();
});

test('outside edits stay local; inside edits reload at receiver position', async () => {
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
