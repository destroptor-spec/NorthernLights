// Where a fresh Cast session starts the current track. A device that plays
// itself starts the Cast device where it is. An idle device that follows the
// session's output on that same track starts where the output is: its own
// audio element sits at 0, and starting there restarted the song (prod
// 2026-10-22 13:47:27: the phone's Cast tap started a new Cast session on
// Stue TV, which ended the one playing "Fix You" at 0:43, and loaded it at 0:00).

import { followedPositionMs, type FollowedOutput } from './sessionFollow';

/** The output as followed when the Cast launch was asked for. */
export interface FollowAtLaunch {
  follow: FollowedOutput;
  /** Local clock time of the launch request. */
  at: number;
}

/**
 * A launch older than this is not the one now connecting (a dismissed dialog
 * long ago); the output is read as it is now instead.
 */
export const FOLLOW_AT_LAUNCH_MAX_AGE_MS = 60_000;

export function castStartPosition(input: {
  /** This device's own playback position, in seconds. */
  localSeconds: number;
  /** This device plays the session itself. */
  localPlaying: boolean;
  /** The current track's queue entry. */
  entryId: string | undefined;
  durationSeconds?: number;
  /** The output followed now. */
  follow: FollowedOutput | null;
  /** The output followed when the launch was asked for, if this device asked. */
  atLaunch: FollowAtLaunch | null;
  now: number;
}): { seconds: number; source: 'local' | 'followed' } {
  const local = { seconds: input.localSeconds, source: 'local' as const };
  if (input.localPlaying || !input.entryId) return local;
  // Picking the Cast device can start a new Cast session that stops the
  // output being followed, so its position is taken at the request: it may
  // replay the moment the dialog was open rather than skip past it.
  const launch = input.atLaunch && input.now - input.atLaunch.at < FOLLOW_AT_LAUNCH_MAX_AGE_MS ? input.atLaunch : null;
  const follow = launch?.follow ?? input.follow;
  // A silent output's position is a guess that keeps counting.
  if (!follow || follow.silent || follow.entryId !== input.entryId) return local;
  const positionMs = followedPositionMs(follow, launch?.at ?? input.now, input.durationSeconds);
  return { seconds: positionMs / 1000, source: 'followed' };
}
