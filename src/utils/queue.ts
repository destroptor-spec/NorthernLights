import type { TrackInfo } from './fileSystem';

export function createQueueEntryId(): string {
  return `queue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
