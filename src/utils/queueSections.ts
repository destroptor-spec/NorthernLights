import type { TrackInfo } from './fileSystem';

/**
 * The play queue in sections, as the desktop sidebar shows it: the track that
 * plays, the tracks you queued by hand ("Next in Queue", `queued` entries),
 * then the rest of what you started ("Next from: …") and Infinity's picks.
 *
 * The queue itself stays one list. Hand-queued tracks are a run right after
 * the current track: Play next puts a track at the top of that run, Add to
 * queue at its end, so they always play before the rest of the album or
 * playlist. Dragging a track into the run queues it; dragging it out unqueues it.
 */

type QueueEntry = Pick<TrackInfo, 'queued' | 'isInfinity'>;

/** Where the hand-queued run starts: after the current track (the top when nothing plays). */
function runStart(currentIndex: number | null): number {
  return currentIndex === null ? 0 : currentIndex + 1;
}

/** The index just past the hand-queued run after the current track. */
export function queuedRunEnd(playlist: readonly QueueEntry[], currentIndex: number | null): number {
  let end = runStart(currentIndex);
  while (end < playlist.length && playlist[end]?.queued) end += 1;
  return end;
}

/** Where Add to queue puts a track: behind the tracks you queued, before the rest. */
export function addToQueueIndex(playlist: readonly QueueEntry[], currentIndex: number | null): number {
  return queuedRunEnd(playlist, currentIndex);
}

export interface QueueSections {
  /** The track that plays, or null. */
  current: number | null;
  /** Tracks queued by hand, in play order. */
  queued: number[];
  /** The rest of what was started (album, playlist, …), in play order. */
  context: number[];
  /** Infinity's picks at the end of the queue. */
  infinity: number[];
}

/** Splits the upcoming queue into sections; played tracks are left out. */
export function queueSections(playlist: readonly QueueEntry[], currentIndex: number | null): QueueSections {
  const current = currentIndex !== null && currentIndex < playlist.length ? currentIndex : null;
  const start = runStart(current);
  const end = queuedRunEnd(playlist, current);
  // Infinity's picks as their own section only when they close the queue, so
  // the sections never show tracks in a different order than they play.
  let infinityStart = playlist.length;
  while (infinityStart > end && playlist[infinityStart - 1]?.isInfinity) infinityStart -= 1;

  const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
  return {
    current,
    queued: range(start, end),
    context: range(end, infinityStart),
    infinity: range(infinityStart, playlist.length),
  };
}

/**
 * Whether the sidebar takes a drag from `fromIndex` to `toIndex`. The track
 * that plays stays where it is, and nothing is dropped onto it or above it:
 * that would put the dragged track among the played ones (hidden there) or
 * push queued tracks into them. Such a drop snaps back.
 */
export function canMoveInSections(fromIndex: number, toIndex: number, currentIndex: number | null): boolean {
  if (currentIndex === null) return true;
  return fromIndex !== currentIndex && toIndex > currentIndex;
}

/**
 * Whether a track moved to `toIndex` is queued by hand afterwards. `playlist`
 * and `currentIndex` are the queue after the move. Inside the run (or at its
 * top) it is; past it, or among the played tracks, it isn't; at the run's
 * lower edge it keeps what it was.
 */
export function queuedAfterMove(
  playlist: readonly QueueEntry[],
  currentIndex: number | null,
  toIndex: number,
  wasQueued: boolean,
): boolean {
  const start = runStart(currentIndex);
  if (toIndex < start) return false;
  // The run, walked as if the moved track were part of it.
  let end = start;
  while (end < playlist.length && (end === toIndex || playlist[end]?.queued)) end += 1;
  if (end <= toIndex) return false; // past the run
  // Queued tracks below it: inside the run. None: its lower edge.
  return toIndex < end - 1 ? true : wasQueued;
}

/**
 * The heading over the rest of what was started: "Next from: <album>",
 * "Next from: <playlist>", "Next from: <artist> radio". Without a named source
 * (a queue started from search, the Hub, another device), the album when all
 * its tracks share one, else "Next up".
 */
export function nextFromLabel(
  source: QueueSourceRef | null,
  tracks: readonly Pick<TrackInfo, 'album'>[],
): string {
  const name = queueSourceName(source, tracks);
  return name ? `Next from: ${name}` : 'Next up';
}

type QueueSourceRef = { kind: 'album' | 'playlist' | 'artist' | 'artist-top' | 'radio'; name?: string };

/**
 * What the queue plays from, by name: the album, the playlist, "<artist>
 * radio", or without a named source the album its tracks share. Null when
 * there is none (a mix of albums from search or the Hub).
 */
export function queueSourceName(source: QueueSourceRef | null, tracks: readonly Pick<TrackInfo, 'album'>[]): string | null {
  const name = source?.name?.trim();
  if (name) return source!.kind === 'radio' ? `${name} radio` : name;
  const album = tracks[0]?.album?.trim();
  if (album && tracks.every((track) => track.album?.trim() === album)) return album;
  return null;
}
