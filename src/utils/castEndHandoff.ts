// What this device does when its Cast session ends. Stopped from here (the
// "Stop casting" button, or the Cast dialog opened from this device's Cast
// icon), playback continues here if it was playing. Ended anywhere else
// (Google Home, the TV switched off, another phone), the track is loaded at
// the Cast position but stays paused, so the device never starts sound by
// itself and Play continues from there.

/** A Cast dialog opened from this device this recently counts as "stopped from here". */
export const USER_STOP_WINDOW_MS = 2 * 60_000;

export interface CastEndSnapshot {
  index: number;
  positionSeconds: number;
  wasPlaying: boolean;
}

export function shouldContinuePlayingAfterCast(input: {
  userStopRequested: boolean;
  dialogOpenedAt: number;
  now: number;
  wasPlaying: boolean;
}): boolean {
  if (!input.wasPlaying) return false;
  if (input.userStopRequested) return true;
  return input.dialogOpenedAt > 0 && input.now - input.dialogOpenedAt <= USER_STOP_WINDOW_MS;
}

/**
 * Where the Cast device was when the session ended: the last trusted position
 * (anchored to the queue entry it belongs to, and carried forward while
 * playing), else what the store last showed.
 */
export function castEndSnapshot(input: {
  anchor: { position: number; atMs: number; entryId: string } | null;
  now: number;
  playlist: Array<{ queueEntryId?: string; duration?: number }>;
  currentIndex: number | null;
  wasPlaying: boolean;
  storePositionSeconds: number;
}): CastEndSnapshot | null {
  const anchoredIndex = input.anchor ? input.playlist.findIndex((track) => track.queueEntryId === input.anchor!.entryId) : -1;
  const index = anchoredIndex >= 0 ? anchoredIndex : input.currentIndex;
  if (index === null || index < 0 || !input.playlist[index]) return null;

  let positionSeconds = input.storePositionSeconds;
  if (anchoredIndex >= 0 && input.anchor) {
    const elapsed = input.wasPlaying ? Math.max(0, input.now - input.anchor.atMs) / 1000 : 0;
    positionSeconds = input.anchor.position + elapsed;
  }
  const duration = input.playlist[index].duration;
  if (duration && duration > 0) positionSeconds = Math.min(positionSeconds, Math.max(0, duration - 1));
  return { index, positionSeconds: Math.max(0, positionSeconds), wasPlaying: input.wasPlaying };
}
