import { playbackSessionPatchSchema } from '../../../shared/api/v1';
import { planQueueOperations, planSessionPatch, MAX_PATCH_OPERATIONS, type QueueEntryRef, type SessionOperation } from '../sessionQueueDiff';

// Applies operations the way server/services/playbackSession.service.ts does.
function apply(queue: QueueEntryRef[], operations: SessionOperation[]): QueueEntryRef[] {
  let entries = [...queue];
  const slotAfter = (anchor: string | null) => {
    if (anchor === null) return 0;
    const at = entries.findIndex((entry) => entry.entryId === anchor);
    if (at < 0) throw new Error(`anchor ${anchor} not found`);
    return at + 1;
  };
  for (const operation of operations) {
    switch (operation.type) {
      case 'replaceQueue':
        entries = operation.trackIds.map((trackId, index) => ({ entryId: operation.entryIds![index], trackId }));
        break;
      case 'insert': {
        const ids = new Set(entries.map((entry) => entry.entryId));
        if (operation.entryIds!.some((id) => ids.has(id))) throw new Error('entry ID conflict');
        entries.splice(slotAfter(operation.afterEntryId!), 0, ...operation.trackIds.map((trackId, index) => ({ entryId: operation.entryIds![index], trackId })));
        break;
      }
      case 'remove':
        entries = entries.filter((entry) => !operation.queueEntryIds.includes(entry.entryId));
        break;
      case 'move': {
        const from = entries.findIndex((entry) => entry.entryId === operation.queueEntryId);
        const [entry] = entries.splice(from, 1);
        entries.splice(slotAfter(operation.afterEntryId!), 0, entry);
        break;
      }
      default:
        break;
    }
  }
  return entries;
}

const entry = (n: number): QueueEntryRef => ({ entryId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, trackId: `track-${n}` });
const queue = (...numbers: number[]) => numbers.map(entry);

it('sends nothing when the queues already match', () => {
  expect(planQueueOperations(queue(1, 2, 3), queue(1, 2, 3), 0)).toEqual([]);
});

it('sends an append as one anchored insert', () => {
  expect(planQueueOperations(queue(1, 2, 3), queue(1, 2, 3, 4), 0)).toEqual([
    { type: 'insert', afterEntryId: entry(3).entryId, trackIds: ['track-4'], entryIds: [entry(4).entryId] },
  ]);
});

it('sends Play Next as an insert after the current entry', () => {
  expect(planQueueOperations(queue(1, 2, 3), queue(1, 9, 2, 3), 0)).toEqual([
    { type: 'insert', afterEntryId: entry(1).entryId, trackIds: ['track-9'], entryIds: [entry(9).entryId] },
  ]);
});

it('sends a removal and a single reorder as one operation each', () => {
  expect(planQueueOperations(queue(1, 2, 3, 4), queue(1, 3, 4), 0)).toEqual([{ type: 'remove', queueEntryIds: [entry(2).entryId] }]);
  expect(planQueueOperations(queue(1, 2, 3, 4), queue(1, 3, 4, 2), 0)).toEqual([{ type: 'move', queueEntryId: entry(2).entryId, afterEntryId: entry(4).entryId }]);
});

it('replaces a queue that has little in common with the session', () => {
  expect(planQueueOperations([], queue(1, 2), 1)).toEqual([
    { type: 'replaceQueue', trackIds: ['track-1', 'track-2'], entryIds: [entry(1).entryId, entry(2).entryId], currentIndex: 1 },
  ]);
  expect(planQueueOperations(queue(1, 2), queue(5, 6, 7, 1), null)[0].type).toBe('replaceQueue');
});

it('replaces when an entry ID now names another track', () => {
  const local = [{ ...entry(2), trackId: 'track-99' }, entry(3)];
  expect(planQueueOperations(queue(2, 3), local, 0)[0].type).toBe('replaceQueue');
});

it('splits a long run of new entries into inserts the server accepts', () => {
  const server = queue(...Array.from({ length: 300 }, (_, i) => i));
  const local = queue(...Array.from({ length: 550 }, (_, i) => i));
  const operations = planQueueOperations(server, local, 0);
  expect(operations.map((operation) => operation.type === 'insert' && operation.trackIds.length)).toEqual([200, 50]);
  expect(playbackSessionPatchSchema.safeParse({ expectedRevision: 1, operations }).success).toBe(true);
  expect(apply(server, operations)).toEqual(local);
});

it('stays under the operation limit by replacing', () => {
  const server = queue(...Array.from({ length: 200 }, (_, i) => i));
  const local = [...server].reverse();
  const operations = planQueueOperations(server, local, 0);
  expect(operations).toHaveLength(1);
  expect(operations[0].type).toBe('replaceQueue');
});

it('turns any edit into operations that rebuild the local queue', () => {
  let seed = 7;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  let next = 1000;
  for (let round = 0; round < 500; round += 1) {
    const server = queue(...Array.from({ length: Math.floor(random() * 30) }, (_, i) => i));
    const local = server.filter(() => random() > 0.2);
    for (let i = 0; i < 6; i += 1) {
      if (random() < 0.5 && local.length) {
        const [moved] = local.splice(Math.floor(random() * local.length), 1);
        local.splice(Math.floor(random() * (local.length + 1)), 0, moved);
      } else {
        local.splice(Math.floor(random() * (local.length + 1)), 0, entry(next++));
      }
    }
    const operations = planQueueOperations(server, local, local.length ? 0 : null);
    expect(operations.length).toBeLessThan(MAX_PATCH_OPERATIONS);
    expect(apply(server, operations)).toEqual(local);
    if (operations.length) {
      expect(playbackSessionPatchSchema.safeParse({ expectedRevision: 1, operations }).success).toBe(true);
    }
  }
});

it('adds repeat and shuffle when they differ from the session', () => {
  const session = { queue: [], repeatMode: 'none' as const, shuffle: false };
  expect(planSessionPatch(session, [], null, { repeatMode: 'none', shuffle: false })).toEqual([]);
  expect(planSessionPatch(session, [], null, { repeatMode: 'all', shuffle: false })).toEqual([
    { type: 'setTransport', repeatMode: 'all', shuffle: false },
  ]);
});
