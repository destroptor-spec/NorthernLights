import type { PlaybackSession, PlaybackSessionPatch } from '../../shared/api/v1';

// Turns "the session has queue A, this device has queue B" into the patch
// operations that make the session's queue B, anchored on entry IDs so they
// still mean the same thing after other edits (docs/playback_sessions.md,
// Phase 2). Most edits come out as one or two small operations; when the
// queues share little, or the edit would take many operations, it is one
// replaceQueue instead.

export type SessionOperation = PlaybackSessionPatch['operations'][number];
export interface QueueEntryRef { entryId: string; trackId: string }
export interface MirroredTransport { repeatMode: PlaybackSession['repeatMode']; shuffle: boolean; infinity?: boolean }

// Server limits (shared/api/v1.ts).
export const MAX_PATCH_OPERATIONS = 50;
export const MAX_SESSION_QUEUE = 2000;
const MAX_INSERT_TRACKS = 200;
const MAX_REMOVE_ENTRIES = 200;

/** Indices into `values` of one longest strictly increasing subsequence. */
function longestIncreasingRun(values: number[]): number[] {
  const tails: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);
  values.forEach((value, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (values[tails[mid]] < value) low = mid + 1;
      else high = mid;
    }
    if (low > 0) previous[index] = tails[low - 1];
    tails[low] = index;
  });
  const run: number[] = [];
  for (let index = tails.length ? tails[tails.length - 1] : -1; index >= 0; index = previous[index]) run.push(index);
  return run.reverse();
}

export function planQueueOperations(server: QueueEntryRef[], local: QueueEntryRef[], currentIndex: number | null): SessionOperation[] {
  const replace = (): SessionOperation[] => [{
    type: 'replaceQueue',
    trackIds: local.map((entry) => entry.trackId),
    entryIds: local.map((entry) => entry.entryId),
    ...(currentIndex !== null && local[currentIndex] ? { currentIndex } : {}),
  }];

  const serverTrack = new Map(server.map((entry) => [entry.entryId, entry.trackId]));
  // An entry ID that now names another track cannot be patched in place.
  if (local.some((entry) => serverTrack.has(entry.entryId) && serverTrack.get(entry.entryId) !== entry.trackId)) return replace();

  const localPosition = new Map(local.map((entry, index) => [entry.entryId, index]));
  const kept = server.filter((entry) => localPosition.has(entry.entryId));
  // Mostly new (a new album, or a session that never saw this queue).
  if (local.length > 0 && kept.length * 2 < local.length) return replace();

  const operations: SessionOperation[] = [];
  const removed = server.filter((entry) => !localPosition.has(entry.entryId)).map((entry) => entry.entryId);
  for (let at = 0; at < removed.length; at += MAX_REMOVE_ENTRIES) {
    operations.push({ type: 'remove', queueEntryIds: removed.slice(at, at + MAX_REMOVE_ENTRIES) });
  }

  // Kept entries already in the right order relative to each other stay put;
  // the rest move. Walking the local queue front to back, every entry is
  // placed straight after its local predecessor, which is already in place.
  const staying = new Set(longestIncreasingRun(kept.map((entry) => localPosition.get(entry.entryId)!)).map((index) => kept[index].entryId));
  let run: QueueEntryRef[] = [];
  let runAnchor: string | null = null;
  const flushRun = () => {
    if (!run.length) return;
    operations.push({
      type: 'insert',
      afterEntryId: runAnchor,
      trackIds: run.map((entry) => entry.trackId),
      entryIds: run.map((entry) => entry.entryId),
    });
    runAnchor = run[run.length - 1].entryId;
    run = [];
  };
  local.forEach((entry, index) => {
    const anchor = index === 0 ? null : local[index - 1].entryId;
    if (!serverTrack.has(entry.entryId)) {
      if (!run.length) runAnchor = anchor;
      run.push(entry);
      if (run.length === MAX_INSERT_TRACKS) flushRun();
      return;
    }
    flushRun();
    if (!staying.has(entry.entryId)) operations.push({ type: 'move', queueEntryId: entry.entryId, afterEntryId: anchor });
  });
  flushRun();

  // One extra slot is kept for the transport operation.
  return operations.length >= MAX_PATCH_OPERATIONS ? replace() : operations;
}

/** Everything the device holding the output owns in the session, except what its reports carry. */
export function planSessionPatch(
  session: Pick<PlaybackSession, 'queue' | 'repeatMode' | 'shuffle'> & { infinity?: boolean },
  local: QueueEntryRef[],
  currentIndex: number | null,
  transport: MirroredTransport,
): SessionOperation[] {
  const server = session.queue.map((entry) => ({ entryId: entry.queueEntryId, trackId: entry.track.id }));
  const operations = planQueueOperations(server, local, currentIndex);
  const infinityChanged = transport.infinity !== undefined && transport.infinity !== (session.infinity ?? false);
  if (transport.repeatMode !== session.repeatMode || transport.shuffle !== session.shuffle || infinityChanged) {
    operations.push({
      type: 'setTransport', repeatMode: transport.repeatMode, shuffle: transport.shuffle,
      ...(transport.infinity !== undefined ? { infinity: transport.infinity } : {}),
    });
  }
  return operations;
}
