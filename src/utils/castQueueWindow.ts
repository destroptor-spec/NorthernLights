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

/** Played entries kept on the receiver so Previous and device remotes can jump back. */
export const CAST_QUEUE_KEEP_PREVIOUS = 2;

/**
 * How a sender-side edit maps onto the receiver's window, by entry identity.
 * `remaining` is the receiver window from its current entry; `ordered` is the
 * local queue from the same entry. Both start with the current entry.
 */
export type CastWindowEdit =
    | { kind: 'none' }
    | { kind: 'insert'; ids: string[]; before: string | null }
    | { kind: 'remove'; ids: string[] }
    | { kind: 'move'; id: string; before: string | null }
    | { kind: 'reload' };

const isPrefix = (prefix: readonly string[], of: readonly string[]) =>
    prefix.length <= of.length && prefix.every((id, i) => of[i] === id);

/** Classify the difference between the receiver window and the local queue. */
export function planWindowEdit(remaining: readonly string[], ordered: readonly string[]): CastWindowEdit {
    if (!remaining.length || remaining[0] !== ordered[0]) return { kind: 'reload' };
    if (isPrefix(remaining, ordered)) return { kind: 'none' };
    const inWindow = new Set(remaining);
    const inQueue = new Set(ordered);

    // A contiguous block of new entries inside the window (Play Next, Undo of a remove).
    const p = remaining.findIndex((id, i) => ordered[i] !== id);
    if (p > 0 && !inWindow.has(ordered[p])) {
        let end = p;
        while (end < ordered.length && !inWindow.has(ordered[end])) end++;
        if (isPrefix(remaining.slice(p), ordered.slice(end))) {
            return { kind: 'insert', ids: ordered.slice(p, end), before: remaining[p] };
        }
    }

    // Entries deleted from the queue.
    const gone = remaining.filter(id => !inQueue.has(id));
    const kept = remaining.filter(id => inQueue.has(id));
    if (gone.length && isPrefix(kept, ordered)) return { kind: 'remove', ids: gone };
    // One entry relocated within the window.
    if (!gone.length) {
        const target = ordered.slice(0, remaining.length);
        if (target.length === remaining.length && target.every(id => inWindow.has(id))) {
            for (const id of remaining.slice(1)) {
                const a = remaining.filter(other => other !== id);
                const b = target.filter(other => other !== id);
                if (a.every((other, i) => b[i] === other)) {
                    const at = target.indexOf(id);
                    return { kind: 'move', id, before: at + 1 < target.length ? target[at + 1] : null };
                }
            }
        }
    }
    // Otherwise an entry that moved out past the end of a truncated window.
    if (!gone.length) {
        for (const id of remaining.slice(1)) {
            const rest = remaining.filter(other => other !== id);
            if (isPrefix(rest, ordered) && ordered.indexOf(id) >= rest.length) return { kind: 'remove', ids: [id] };
        }
    }
    return { kind: 'reload' };
}

/** Apply a mirrored edit to the window's entry IDs (which mirror the receiver's items). */
export function applyWindowEdit(ids: readonly string[], edit: CastWindowEdit): string[] {
    const insertAt = (list: string[], added: string[], before: string | null) => {
        const at = before === null ? -1 : list.indexOf(before);
        return at < 0 ? [...list, ...added] : [...list.slice(0, at), ...added, ...list.slice(at)];
    };
    switch (edit.kind) {
        case 'insert': return insertAt([...ids], edit.ids, edit.before);
        case 'remove': return ids.filter(id => !edit.ids.includes(id));
        case 'move': return insertAt(ids.filter(id => id !== edit.id), [edit.id], edit.before);
        default: return [...ids];
    }
}

/** What a sender remembers about its window, keyed by Cast session ID. */
export type StoredCastWindow = { sessionId: string; ids: string[] };

/**
 * Decide whether a resumed sender may adopt a stored window. Every condition
 * must hold; a wrong adoption would refill or edit a queue we do not know.
 */
export function adoptableWindow(
    stored: StoredCastWindow | null,
    sessionId: string | null | undefined,
    receiver: { queueEntryId?: string | null; currentItemIndex?: number; queueLength?: number },
    localFromCurrent: readonly string[],
): { ok: true; ids: string[] } | { ok: false; reason: string } {
    if (!stored || !Array.isArray(stored.ids)) return { ok: false, reason: 'none-stored' };
    if (!sessionId || stored.sessionId !== sessionId) return { ok: false, reason: 'other-session' };
    const current = receiver.queueEntryId;
    const offset = current ? stored.ids.indexOf(current) : -1;
    if (offset < 0) return { ok: false, reason: 'current-not-in-window' };
    const { currentItemIndex, queueLength } = receiver;
    if (typeof currentItemIndex !== 'number' || typeof queueLength !== 'number' ||
        queueLength - currentItemIndex !== stored.ids.length - offset) return { ok: false, reason: 'receiver-count-mismatch' };
    if (!isPrefix(stored.ids.slice(offset), localFromCurrent)) return { ok: false, reason: 'local-queue-diverged' };
    return { ok: true, ids: [...stored.ids] };
}
