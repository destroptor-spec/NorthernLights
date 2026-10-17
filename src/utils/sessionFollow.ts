import type { PlaybackOutput, PlaybackSession } from '../../shared/api/v1';
import type { PlaybackState } from './PlaybackManager';

// The following side of "Sync playback across devices" (docs/playback_sessions.md,
// Phase 2): what an idle device knows about the device that plays the session.

export interface FollowedOutput {
  sessionId: string;
  outputId: string;
  /** The playing device's name ("NAD Forstærker", "Chrome on Android"). */
  name: string;
  /** `cast`: that device plays through a Cast device, which `name` names. `receiver`: the Cast device plays the session itself. */
  kind: PlaybackOutput['kind'];
  generation: number;
  state: 'playing' | 'paused' | 'buffering' | 'stopped' | 'idle' | 'error';
  entryId: string | null;
  positionMs: number;
  /** Local clock time at which `positionMs` was true. */
  anchorMs: number;
  /**
   * A Cast output that has not reported for over a minute (the server calls
   * it unreachable): the device casting to it is probably asleep, while the
   * Cast device itself likely plays on. Nothing can be sent to it, but this
   * device still asks before playing alongside it.
   */
  silent?: boolean;
}

/** A report fetched with the session is at most this old when it is anchored. */
const MAX_REPORT_AGE_MS = 60_000;
/**
 * Heartbeats come every ten seconds. Past this, the server is about to call
 * the output unreachable (60 s), so the follower reads the session again
 * instead of counting on.
 */
export const FOLLOW_STALE_MS = 65_000;

/** A Cast device plays there: silence may mean only that nobody relays for it. */
export function isCastOutput(output: Pick<PlaybackOutput, 'kind'>): boolean {
  return output.kind === 'cast' || output.kind === 'receiver';
}

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
  if (!output || output.id === myClientId) return null;
  // Ended: nothing plays there. Silent for over a minute: a browser has
  // stopped with it; a Cast device most likely plays on with nobody relaying
  // (prod 2026-10-14: the locked phone went quiet, the desktop played
  // alongside the NAD), so it stays followed, marked silent.
  const silent = output.status === 'unreachable' && isCastOutput(output);
  if (output.status !== 'active' && !silent) return null;
  const report = output.report;
  return {
    sessionId: session.id,
    outputId: output.id,
    name: output.name || 'another device',
    kind: output.kind,
    generation: output.generation,
    state: report?.state ?? (session.playbackState === 'playing' ? 'playing' : 'paused'),
    entryId: report?.queueEntryId ?? session.currentEntryId,
    positionMs: report?.positionMs ?? session.positionMs,
    anchorMs: report ? anchorReportedAt(report.reportedAt, now) : now,
    ...(silent ? { silent: true } : {}),
  };
}

export function isFollowedOutputPlaying(follow: FollowedOutput | null): boolean {
  return !!follow && !follow.silent && (follow.state === 'playing' || follow.state === 'buffering');
}

/** Where the followed device is now, carried forward while it plays. */
export function followedPositionMs(follow: FollowedOutput, now: number, durationSeconds?: number): number {
  const elapsed = follow.state === 'playing' ? Math.max(0, now - follow.anchorMs) : 0;
  const position = follow.positionMs + elapsed;
  return durationSeconds && durationSeconds > 0 ? Math.min(position, durationSeconds * 1000) : position;
}

/**
 * The device this idle one controls (docs/playback_sessions.md, "Device
 * choice and remote control"): the followed device, once chosen in "Play
 * where?", while this one neither plays nor casts.
 */
export function selectRemoteTarget(state: {
  sessionFollow: FollowedOutput | null;
  remoteControlOutputId: string | null;
  playbackState: string;
  castConnected: boolean;
}): FollowedOutput | null {
  const follow = state.sessionFollow;
  if (!follow || state.remoteControlOutputId !== follow.outputId) return null;
  if (state.playbackState === 'playing' || state.castConnected) return null;
  return follow;
}

/** What the Play/Pause button shows: the controlled device's state, else this one's. */
export function selectDisplayedPlaying(state: Parameters<typeof selectRemoteTarget>[0]): boolean {
  const remote = selectRemoteTarget(state);
  return remote ? isFollowedOutputPlaying(remote) : state.playbackState === 'playing';
}

/**
 * What now-playing indicators (bars, badges, detail-view headers) show: the
 * controlled device's state, else this one's — the same rule as the
 * Play/Pause button, so the two never disagree.
 */
export function selectDisplayedPlaybackState(state: Parameters<typeof selectRemoteTarget>[0] & { playbackState: PlaybackState }): PlaybackState {
  const remote = selectRemoteTarget(state);
  if (remote) return isFollowedOutputPlaying(remote) ? 'playing' : 'paused';
  return state.playbackState;
}
