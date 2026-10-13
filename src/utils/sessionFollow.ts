import type { PlaybackSession } from '../../shared/api/v1';

// The following side of "Sync playback across devices" (docs/playback_sessions.md,
// Phase 2): what an idle device knows about the device that plays the session.

export interface FollowedOutput {
  sessionId: string;
  outputId: string;
  /** The playing device's name ("NAD Forstærker", "Chrome on Android"). */
  name: string;
  generation: number;
  state: 'playing' | 'paused' | 'buffering' | 'stopped' | 'idle' | 'error';
  entryId: string | null;
  positionMs: number;
  /** Local clock time at which `positionMs` was true. */
  anchorMs: number;
}

/** A report fetched with the session is at most this old when it is anchored. */
const MAX_REPORT_AGE_MS = 60_000;
/**
 * Heartbeats come every ten seconds. Past this, the server is about to call
 * the output unreachable (60 s), so the follower reads the session again
 * instead of counting on.
 */
export const FOLLOW_STALE_MS = 65_000;

/**
 * Anchors a server `reportedAt` on the local clock. Clocks differ between
 * devices, so the age is clamped; the next heartbeat (within ten seconds)
 * corrects it.
 */
export function anchorReportedAt(reportedAt: string, now: number): number {
  const parsed = Date.parse(reportedAt);
  if (Number.isNaN(parsed)) return now;
  return now - Math.min(MAX_REPORT_AGE_MS, Math.max(0, now - parsed));
}

/** The device another device should follow, or null when this one plays or nobody does. */
export function followFromSession(session: PlaybackSession, myClientId: string, now: number): FollowedOutput | null {
  const output = session.output;
  // Ended, or silent for over a minute: nothing is known to play there.
  if (!output || output.id === myClientId || output.status !== 'active') return null;
  const report = output.report;
  return {
    sessionId: session.id,
    outputId: output.id,
    name: output.name || 'another device',
    generation: output.generation,
    state: report?.state ?? (session.playbackState === 'playing' ? 'playing' : 'paused'),
    entryId: report?.queueEntryId ?? session.currentEntryId,
    positionMs: report?.positionMs ?? session.positionMs,
    anchorMs: report ? anchorReportedAt(report.reportedAt, now) : now,
  };
}

export function isFollowedOutputPlaying(follow: FollowedOutput | null): boolean {
  return !!follow && (follow.state === 'playing' || follow.state === 'buffering');
}

/** Where the followed device is now, carried forward while it plays. */
export function followedPositionMs(follow: FollowedOutput, now: number, durationSeconds?: number): number {
  const elapsed = follow.state === 'playing' ? Math.max(0, now - follow.anchorMs) : 0;
  const position = follow.positionMs + elapsed;
  return durationSeconds && durationSeconds > 0 ? Math.min(position, durationSeconds * 1000) : position;
}
