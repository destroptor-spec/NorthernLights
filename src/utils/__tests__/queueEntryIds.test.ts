import { cloneTrackForQueue, createQueueEntryId, ensureQueueEntryIds, rekeyLegacyQueueEntryIds } from '../queue';
import { isUuid } from '../uuid';

const track = (id: string, queueEntryId?: string) => ({ id, path: `/${id}.flac`, title: id, queueEntryId }) as never;

describe('queue entry IDs', () => {
  it('are UUIDs, the form playback sessions accept', () => {
    expect(isUuid(createQueueEntryId())).toBe(true);
    expect(isUuid(cloneTrackForQueue(track('a')).queueEntryId)).toBe(true);
    expect(isUuid('queue-lx2k9a-abc12345')).toBe(false);
  });

  it('re-keys only entries from before UUIDs, keeping order and every UUID', () => {
    const kept = createQueueEntryId();
    const { tracks, changed } = rekeyLegacyQueueEntryIds([
      track('a', 'queue-lx2k9a-abc12345'), track('b', kept), track('c'),
    ]);
    expect(changed).toBe(true);
    expect(tracks.map((t: { id: string }) => t.id)).toEqual(['a', 'b', 'c']);
    expect(tracks[1].queueEntryId).toBe(kept);
    expect(tracks.every((t: { queueEntryId?: string }) => isUuid(t.queueEntryId))).toBe(true);
    expect(new Set(tracks.map((t: { queueEntryId?: string }) => t.queueEntryId)).size).toBe(3);
  });

  it('returns the same array when nothing needs a new ID', () => {
    const queue = [cloneTrackForQueue(track('a')), cloneTrackForQueue(track('b'))];
    const result = rekeyLegacyQueueEntryIds(queue);
    expect(result).toEqual({ tracks: queue, changed: false });
    expect(result.tracks).toBe(queue);
  });

  it('still leaves existing legacy IDs alone when only filling in missing ones', () => {
    // Used while casting, where the receiver may still know the old IDs.
    const { tracks } = ensureQueueEntryIds([track('a', 'queue-lx2k9a-abc12345'), track('b')]);
    expect(tracks[0].queueEntryId).toBe('queue-lx2k9a-abc12345');
    expect(isUuid(tracks[1].queueEntryId)).toBe(true);
  });
});
