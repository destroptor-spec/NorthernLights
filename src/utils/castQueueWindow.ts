/** Transport budgets, deliberately below the smallest observed failing LOAD. */
export const CAST_QUEUE_MAX_ITEMS = 30;
export const CAST_QUEUE_MAX_BYTES = 24 * 1024;
export const CAST_QUEUE_INSERT_MAX_ITEMS = 20;
export const CAST_QUEUE_LOW_WATER = 5;

export function serializedBytes(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** One occurrence of each entry, starting at the selected entry. */
export function queueWindowEntries<T>(entries: readonly T[], start: number, wrap: boolean): T[] {
    if (!Number.isInteger(start) || start < 0 || start >= entries.length) return [];
    return wrap ? [...entries.slice(start), ...entries.slice(0, start)] : entries.slice(start);
}

/** Measure the complete request, including duplicated start media and auth. */
export function boundedQueueRequest<T, R>(
    entries: readonly T[], build: (entries: T[]) => R, maxItems = CAST_QUEUE_MAX_ITEMS,
): { request: R; entries: T[]; bytes: number } {
    for (let count = Math.min(maxItems, entries.length); count > 0; count--) {
        const selected = entries.slice(0, count);
        const request = build(selected);
        const bytes = serializedBytes(request);
        if (bytes <= CAST_QUEUE_MAX_BYTES) return { request, entries: selected, bytes };
    }
    throw new Error('Cast queue entry exceeds the request byte budget');
}

/** SDK queue methods return void: only the callback acknowledges a command. */
export function castQueueCallback(send: (ok: () => void, fail: (error: unknown) => void) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Cast queue acknowledgement timed out')), 10000);
        const finish = (error?: unknown) => {
            clearTimeout(timer);
            if (error !== undefined) reject(error); else resolve();
        };
        try { send(() => finish(), error => finish(error ?? new Error('Cast queue command failed'))); }
        catch (error) { finish(error); }
    });
}

/** An uncertain insert must never be resent: the first may already be playing. */
export class CastQueueInsertAcks {
    private pending = new Map<number, { session: unknown; count: number; finish: (error?: unknown) => void }>();

    wait(session: unknown, id: number, count: number, send: () => Promise<unknown>): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error('Cast queue insert acknowledgement timed out')), 10000);
            const finish = (error?: unknown) => {
                if (!this.pending.delete(id)) return;
                clearTimeout(timer);
                if (error !== undefined) reject(error); else resolve();
            };
            this.pending.set(id, { session, count, finish });
            try { void send().catch(finish); } catch (error) { finish(error); }
        });
    }

    acknowledge(session: unknown, ack: { requestId?: number; ok?: boolean; inserted?: number }): void {
        if (ack.requestId === undefined) return;
        const pending = this.pending.get(ack.requestId);
        if (!pending || pending.session !== session) return;
        pending.finish(ack.ok && ack.inserted === pending.count ? undefined : new Error('Cast queue insert was rejected'));
    }
}
