import {
    boundedQueueRequest, queueWindowEntries, serializedBytes, CastQueueInsertAcks, castQueueCallback,
    planWindowEdit, applyWindowEdit, adoptableWindow,
} from '../castQueueWindow';

test('budgets the entire UTF-8 request, including duplicate start media', () => {
    const entries = Array.from({ length: 68 }, (_, i) => ({ id: i, title: '🎵'.repeat(300) }));
    const result = boundedQueueRequest(entries, items => ({ media: items[0], items }));
    expect(result.entries.length).toBeLessThan(30);
    expect(result.bytes).toBeLessThanOrEqual(24 * 1024);
    expect(serializedBytes({ media: entries[0], items: entries.slice(0, result.entries.length + 1) })).toBeGreaterThan(24 * 1024);
    expect(boundedQueueRequest(Array.from({ length: 68 }, (_, i) => i), items => ({ items })).entries).toHaveLength(30);
    expect(() => boundedQueueRequest(['x'.repeat(25000)], items => ({ items }))).toThrow('byte budget');
});

test('repeat wraps once by entry identity; normal queues stop at their end', () => {
    expect(queueWindowEntries(['a', 'b', 'c'], 2, true)).toEqual(['c', 'a', 'b']);
    expect(queueWindowEntries(['a', 'b', 'c'], 2, false)).toEqual(['c']);
});

test('an insert requires the matching session, request and count, not send success', async () => {
    const acks = new CastQueueInsertAcks();
    const session = {};
    let done = false;
    const pending = acks.wait(session, 1, 3, async () => undefined).then(() => { done = true; });
    acks.acknowledge({}, { requestId: 1, ok: true, inserted: 3 });
    acks.acknowledge(session, { requestId: 2, ok: true, inserted: 3 });
    await Promise.resolve();
    expect(done).toBe(false);
    acks.acknowledge(session, { requestId: 1, ok: true, inserted: 3 });
    await pending;
    expect(done).toBe(true);
});

test('missing and negative acknowledgements fail without resending', async () => {
    jest.useFakeTimers();
    const acks = new CastQueueInsertAcks();
    const session = {};
    const send = jest.fn().mockResolvedValue(undefined);
    const pending = acks.wait(session, 1, 2, send);
    const rejection = expect(pending).rejects.toThrow('timed out');
    jest.advanceTimersByTime(10000);
    await rejection;
    expect(send).toHaveBeenCalledTimes(1);
    const rejected = acks.wait(session, 2, 2, send);
    acks.acknowledge(session, { requestId: 2, ok: true, inserted: 1 });
    await expect(rejected).rejects.toThrow('rejected');
    jest.useRealTimers();
});

test('SDK queue methods await callbacks, not their void return', async () => {
    let acknowledge!: () => void;
    let done = false;
    const pending = castQueueCallback(ok => { acknowledge = ok; }).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    acknowledge();
    await pending;
    expect(done).toBe(true);
});

describe('planWindowEdit maps queue edits onto the receiver window by identity', () => {
    const w = ['c', 'd', 'e', 'f'];
    it('appends beyond the window are not window edits', () => {
        expect(planWindowEdit(w, ['c', 'd', 'e', 'f', 'g'])).toEqual({ kind: 'none' });
    });
    it('Play Next is an insert before the next entry', () => {
        expect(planWindowEdit(w, ['c', 'x', 'd', 'e', 'f'])).toEqual({ kind: 'insert', ids: ['x'], before: 'd' });
    });
    it('an Undo restoring an entry mid-window is an insert at its place', () => {
        expect(planWindowEdit(w, ['c', 'd', 'x', 'y', 'e', 'f', 'g'])).toEqual({ kind: 'insert', ids: ['x', 'y'], before: 'e' });
    });
    it('removals inside the window, including a truncated tail', () => {
        expect(planWindowEdit(w, ['c', 'd', 'f', 'g'])).toEqual({ kind: 'remove', ids: ['e'] });
        expect(planWindowEdit(w, ['c', 'f'])).toEqual({ kind: 'remove', ids: ['d', 'e'] });
    });
    it('moving an entry out past the end of a truncated window removes it from the receiver', () => {
        expect(planWindowEdit(w, ['c', 'e', 'f', 'g', 'd'])).toEqual({ kind: 'remove', ids: ['d'] });
    });
    it('moves within the window name the new successor', () => {
        expect(planWindowEdit(w, ['c', 'e', 'd', 'f'])).toEqual({ kind: 'move', id: 'd', before: 'f' });
        expect(planWindowEdit(w, ['c', 'f', 'd', 'e'])).toEqual({ kind: 'move', id: 'f', before: 'd' });
        expect(planWindowEdit(w, ['c', 'e', 'f', 'd'])).toEqual({ kind: 'move', id: 'd', before: null });
    });
    it('anything else, or a different current entry, reloads', () => {
        expect(planWindowEdit(w, ['c', 'f', 'e', 'd'])).toEqual({ kind: 'reload' });
        expect(planWindowEdit(w, ['d', 'e', 'f'])).toEqual({ kind: 'reload' });
    });
    it('applies each edit to the window IDs, keeping played entries', () => {
        const ids = ['a', 'b', ...w];
        expect(applyWindowEdit(ids, { kind: 'insert', ids: ['x'], before: 'd' })).toEqual(['a', 'b', 'c', 'x', 'd', 'e', 'f']);
        expect(applyWindowEdit(ids, { kind: 'remove', ids: ['e'] })).toEqual(['a', 'b', 'c', 'd', 'f']);
        expect(applyWindowEdit(ids, { kind: 'move', id: 'd', before: null })).toEqual(['a', 'b', 'c', 'e', 'f', 'd']);
    });
});

describe('adoptableWindow rebuilds a window after a reload or rejoin only on proof', () => {
    const stored = { sessionId: 's1', ids: ['a', 'b', 'c', 'd', 'e'] };
    const receiver = { queueEntryId: 'c', currentItemIndex: 2, queueLength: 5 };
    it('adopts when the session, receiver counts and local order all agree', () => {
        expect(adoptableWindow(stored, 's1', receiver, ['c', 'd', 'e', 'f'])).toEqual({ ok: true, ids: stored.ids });
    });
    it.each([
        ['none-stored', null, 's1', receiver, ['c']],
        ['other-session', stored, 's2', receiver, ['c', 'd', 'e']],
        ['current-not-in-window', stored, 's1', { ...receiver, queueEntryId: 'z' }, ['z']],
        ['receiver-count-mismatch', stored, 's1', { ...receiver, queueLength: 7 }, ['c', 'd', 'e']],
        ['receiver-count-mismatch', stored, 's1', { queueEntryId: 'c' }, ['c', 'd', 'e']],
        ['local-queue-diverged', stored, 's1', receiver, ['c', 'e', 'd']],
    ] as const)('refuses: %s', (reason, s, id, r, local) => {
        expect(adoptableWindow(s as never, id, r, local)).toEqual({ ok: false, reason });
    });
});
