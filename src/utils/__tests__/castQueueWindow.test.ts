import { boundedQueueRequest, queueWindowEntries, serializedBytes, CastQueueInsertAcks, castQueueCallback } from '../castQueueWindow';

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
