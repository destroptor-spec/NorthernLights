// Is a newly connected Cast session fresh, or did this device join a receiver
// that another of the user's devices is already playing on?
//
// A Cast dialog joins the running receiver app when one exists. The sender
// SDK learns of the media there a moment after connecting: prod 2026-10-13,
// connected 19:53:48.902, media status 19:53:49.926. Deciding "fresh" before
// then loaded this device's own queue over the NAD. So a fresh-looking
// session waits a little for evidence either way.

/** Longest wait before treating a silent session as fresh. */
export const JOIN_MEDIA_WAIT_MS = 1500;

/**
 * Longest wait for any answer at all before calling the session deaf. The
 * sender pings the receiver as it joins (an aurora.control every receiver
 * acknowledges); a healthy one answers within a fraction of a second, the
 * Beoplay A9 within one or two.
 */
export const JOIN_DEAF_AFTER_MS = 5000;

export type JoinVerdict =
  /** The SDK sees media on the receiver: take it on, load nothing. */
  | 'adopt'
  /** Nothing is playing there: load this device's queue. */
  | 'fresh'
  /** No evidence yet: ask again shortly. */
  | 'wait'
  /** Our receiver says it plays, but the SDK never showed the media: load nothing. */
  | 'hold'
  /**
   * Nothing from the receiver at all, not even the ping's acknowledgement:
   * this device sends but never hears (prod 2026-10-27 12:33: the desktop
   * joined the NAD's idle receiver app, loaded, heard nothing, and loaded
   * again). Load nothing; start over in a new Cast session.
   */
  | 'deaf';

const ACTIVE_STATES = new Set(['PLAYING', 'PAUSED', 'BUFFERING']);

export function decideJoin(input: {
  sdkHasMedia: boolean;
  /** The latest aurora.status received since the session connected, if any. */
  receiverStatus: { queueEntryId?: string | null; playerState?: string | null } | null;
  /**
   * Anything from the receiver since the session connected (the ping's
   * acknowledgement, a status). Left out: not known, decided as before.
   */
  heardFromReceiver?: boolean;
  elapsedMs: number;
  maxWaitMs?: number;
  deafAfterMs?: number;
}): JoinVerdict {
  if (input.sdkHasMedia) return 'adopt';
  const max = input.maxWaitMs ?? JOIN_MEDIA_WAIT_MS;
  const status = input.receiverStatus;
  if (status) {
    const playing = !!status.queueEntryId && ACTIVE_STATES.has(String(status.playerState || ''));
    if (!playing) return 'fresh';
    return input.elapsedMs < max ? 'wait' : 'hold';
  }
  if (input.heardFromReceiver === false) {
    return input.elapsedMs < (input.deafAfterMs ?? JOIN_DEAF_AFTER_MS) ? 'wait' : 'deaf';
  }
  return input.elapsedMs < max ? 'wait' : 'fresh';
}

/** A disconnect this soon after leaving another device's session is that leave. */
export const OWN_LEAVE_QUIET_MS = 10_000;

/**
 * This device left a Cast session another of the user's devices casts
 * (cast-join-left) at `leftAt`; the remote player's disconnect that follows
 * is the leave itself, not a failure to report (prod 2026-10-13: "Cast device
 * disconnected" right after picking the NAD).
 */
export function isOwnLeaveDisconnect(leftAt: number, now: number): boolean {
  return leftAt > 0 && now - leftAt >= 0 && now - leftAt < OWN_LEAVE_QUIET_MS;
}
