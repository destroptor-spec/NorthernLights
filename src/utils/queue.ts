import type { TrackInfo } from './fileSystem';
import { createUuid, isUuid } from './uuid';

/**
 * Queue entry IDs are UUIDs, the form the server's playback sessions require,
 * so an entry keeps one ID locally, on the session and on a Cast receiver.
 */
export function createQueueEntryId(): string {
  return createUuid();
}

export function cloneTrackForQueue(track: TrackInfo): TrackInfo {
  return {
    ...track,
    queueEntryId: createQueueEntryId(),
  };
}

export function ensureQueueEntryIds(tracks: TrackInfo[]): { tracks: TrackInfo[]; changed: boolean } {
  let changed = false;
  const normalized = tracks.map((track) => {
    if (track.queueEntryId) return track;
    changed = true;
    return {
      ...track,
      queueEntryId: createQueueEntryId(),
    };
  });
  return { tracks: normalized, changed };
}

/**
 * Gives every entry whose ID predates UUID entry IDs (`queue-<time>-<random>`)
 * a UUID, keeping UUIDs as they are. Only safe when no Cast receiver can still
 * hold the old IDs: the receiver's window is matched by entry ID.
 */
export function rekeyLegacyQueueEntryIds(tracks: TrackInfo[]): { tracks: TrackInfo[]; changed: boolean } {
  let changed = false;
  const rekeyed = tracks.map((track) => {
    if (isUuid(track.queueEntryId)) return track;
    changed = true;
    return { ...track, queueEntryId: createQueueEntryId() };
  });
  return { tracks: changed ? rekeyed : tracks, changed };
}

/**
 * Whether Next leads anywhere. On the last track only repeat-all, shuffle or
 * Infinity continue; otherwise Next is disabled rather than ending playback
 * (which closed the mobile player and popped it up again).
 */
export function hasNextTrack(state: {
  playlist: readonly unknown[]; currentIndex: number | null; shuffle: boolean;
  repeat: 'none' | 'one' | 'all'; isInfinityMode: boolean;
}): boolean {
  if (state.playlist.length === 0) return false;
  if (state.shuffle || state.repeat === 'all' || state.isInfinityMode) return true;
  return state.currentIndex === null || state.currentIndex < state.playlist.length - 1;
}
