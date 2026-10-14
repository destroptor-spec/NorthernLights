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

export type JoinVerdict =
  /** The SDK sees media on the receiver: take it on, load nothing. */
  | 'adopt'
  /** Nothing is playing there: load this device's queue. */
  | 'fresh'
  /** No evidence yet: ask again shortly. */
  | 'wait'
  /** Our receiver says it plays, but the SDK never showed the media: load nothing. */
  | 'hold';

const ACTIVE_STATES = new Set(['PLAYING', 'PAUSED', 'BUFFERING']);

export function decideJoin(input: {
  sdkHasMedia: boolean;
  /** The latest aurora.status received since the session connected, if any. */
  receiverStatus: { queueEntryId?: string | null; playerState?: string | null } | null;
  elapsedMs: number;
  maxWaitMs?: number;
}): JoinVerdict {
  if (input.sdkHasMedia) return 'adopt';
  const max = input.maxWaitMs ?? JOIN_MEDIA_WAIT_MS;
  const status = input.receiverStatus;
  if (status) {
    const playing = !!status.queueEntryId && ACTIVE_STATES.has(String(status.playerState || ''));
    if (!playing) return 'fresh';
    return input.elapsedMs < max ? 'wait' : 'hold';
  }
  return input.elapsedMs < max ? 'wait' : 'fresh';
}
