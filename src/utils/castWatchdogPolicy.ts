/**
 * Decide whether the sender should stop claiming playback because the remote
 * media is genuinely gone.
 *
 * A missing media session object is not sufficient evidence. Prod on
 * 2026-09-01 09:00-09:09: the RemotePlayer event stream was dead and
 * eventSilenceMs climbed past 530s, but the watchdog was successfully pulling
 * media status every minute and the receiver was PLAYING throughout. The
 * session object then blinked out for one probe window, and playback state was
 * released while the music kept going — the UI showed nothing playing while the
 * speaker played on.
 *
 * So releasing requires two things: the probe window has elapsed *and* nothing
 * has proved the receiver alive for a good while. A dead event stream alone
 * does not qualify, because that is exactly the condition the watchdog exists
 * to paper over.
 */
export function shouldReleaseRemoteMedia(input: {
  probedMs: number;
  graceMs: number;
  msSinceEvidence: number;
  evidenceWindowMs: number;
}): boolean {
  return input.probedMs >= input.graceMs && input.msSinceEvidence >= input.evidenceWindowMs;
}

/**
 * How long the RemotePlayer event stream may stay silent before its snapshot
 * stops being trustworthy.
 *
 * CURRENT_TIME_CHANGED fires about once a second during healthy playback, so
 * three seconds of silence means the stream has stopped rather than that we
 * caught it between ticks.
 */
export const REMOTE_PLAYER_STALE_MS = 3000;

export function isRemotePlayerStreamStale(
  msSinceRemotePlayerEvent: number,
  staleAfterMs: number = REMOTE_PLAYER_STALE_MS,
): boolean {
  return msSinceRemotePlayerEvent > staleAfterMs;
}

function positionValue(value: unknown): number | null {
  return typeof value === 'number' && isFinite(value) && value >= 0 ? value : null;
}

function durationValue(value: unknown): number | null {
  return typeof value === 'number' && isFinite(value) && value > 0 ? value : null;
}

export interface RemotePositionSources {
  playerTime?: unknown;
  playerDuration?: unknown;
  sessionTime?: unknown;
  sessionDuration?: unknown;
  /** Metadata or store duration, used only when nothing better exists. */
  fallbackDuration?: unknown;
  /**
   * The "session" was built locally from RemotePlayer because the SDK had no
   * media session. Its fields are the RemotePlayer's own, so they carry no
   * information from the receiver and must not be treated as if they did.
   */
  sessionIsSynthetic?: boolean;
  msSinceRemotePlayerEvent: number;
  staleAfterMs?: number;
}

export interface RemotePositionChoice {
  /** null means "nothing trustworthy to apply" — leave the current value alone. */
  currentTime: number | null;
  duration: number | null;
  source: 'remote-player' | 'media-session' | 'none';
}

/**
 * Choose the position to publish to the UI from the two things that claim to
 * know it: the local RemotePlayer snapshot and the media session we just
 * pulled from the receiver.
 *
 * RemotePlayer wins while it is alive — it interpolates every second, so it is
 * smoother than a status that can be five seconds old. Once its event stream
 * dies it becomes actively harmful, and the watchdog that pulls a fresh status
 * exists for exactly that case. Preferring the frozen local snapshot there
 * throws away the answer the receiver just gave.
 *
 * Prod 2026-09-02 21:56-21:57: eventSilenceMs climbed past 204s while the
 * receiver played a 334s track at 172s-230s. Every watchdog tick pulled that
 * status successfully and then published the RemotePlayer's frozen
 * `currentTime=0` and `duration=240.7` — a duration belonging to the track
 * that had been playing when the stream died. The aurora-status channel
 * corrected the bar every 5s and this overwrote it ~0.9s later, which is the
 * one-second flash of correct progress the user reported.
 *
 * A stale stream taints every RemotePlayer field, position and duration alike,
 * so neither is consulted once it goes quiet.
 */
export function pickRemotePosition(input: RemotePositionSources): RemotePositionChoice {
  const stale = isRemotePlayerStreamStale(input.msSinceRemotePlayerEvent, input.staleAfterMs);

  const playerTime = positionValue(input.playerTime);
  const playerDuration = durationValue(input.playerDuration);
  // Prod 2026-10-06 12:03: with no SDK media session, the watchdog hydrated
  // from a session synthesised out of the dead RemotePlayer, and #66 read its
  // frozen currentTime=0 and stale 206.22s duration as receiver data — the
  // original bug, labelled source=media-session. A synthetic session is the
  // RemotePlayer, so it is ignored exactly when the RemotePlayer is.
  const syntheticAndStale = input.sessionIsSynthetic === true && stale;
  const sessionTime = syntheticAndStale ? null : positionValue(input.sessionTime);
  const sessionDuration = syntheticAndStale ? null : durationValue(input.sessionDuration);
  const fallbackDuration = syntheticAndStale ? null : durationValue(input.fallbackDuration);

  const duration = stale
    ? sessionDuration ?? fallbackDuration
    : playerDuration ?? sessionDuration ?? fallbackDuration;

  if (!stale && playerTime !== null) {
    return { currentTime: playerTime, duration, source: 'remote-player' };
  }
  if (sessionTime !== null) {
    return { currentTime: sessionTime, duration, source: 'media-session' };
  }
  return { currentTime: null, duration, source: 'none' };
}

export type TransportIntent = 'play' | 'pause' | 'toggle';
export type TransportState = 'playing' | 'paused' | 'stopped';
export type TransportAction = 'play' | 'pause' | 'satisfied';

/**
 * Work out which media-session command to send for a transport intent.
 *
 * Separate from the RemotePlayerController path because that one toggles: it
 * reads the local player's isPaused and flips it. Once the event stream dies
 * that flag freezes, so a toggle can flip the wrong way, or the wrong way
 * twice. Deciding from the receiver's own reported state instead removes the
 * frozen flag from the decision.
 *
 * 'satisfied' means the receiver is already in the requested state and sending
 * the command would be a no-op at best — for a toggle, never satisfied, since
 * the user asked for a change.
 */
export function chooseTransportAction(intent: TransportIntent, state: TransportState): TransportAction {
  if (intent === 'toggle') {
    // A stopped receiver has nothing to pause, so the useful reading of a
    // toggle is "start playing".
    return state === 'playing' ? 'pause' : 'play';
  }
  if (intent === 'pause') {
    return state === 'playing' ? 'pause' : 'satisfied';
  }
  return state === 'playing' ? 'satisfied' : 'play';
}

/**
 * How far the sender may carry the position on its own before giving up.
 *
 * Receiver updates arrive every 5s, so a cap of 12s tolerates two missed ones
 * and then stops. Without it, a session that stops reporting entirely would
 * run the progress bar to the end of the track while the room is silent —
 * confidently wrong, which is worse than visibly stuck.
 */
export const POSITION_EXTRAPOLATION_CAP_MS = 12_000;

/** How often the sender redraws an interpolated position. */
export const POSITION_TICK_MS = 500;

/**
 * Advance a known-good position by wall-clock between receiver updates.
 *
 * While the RemotePlayer stream is alive it emits CURRENT_TIME_CHANGED about
 * once a second and the progress bar moves on its own. Once it dies, #66 made
 * the position correct but left it arriving only with the 5s watchdog
 * hydration and the 5s aurora-status broadcast. Prod 2026-10-06 measured the
 * result precisely: 40 consecutive updates, each +4.98s to +5.01s over a
 * matching wall-clock gap, no backward steps. Correct at every sample and a
 * visible staircase in between.
 *
 * This fills the gaps by arithmetic on the receiver's own value. The dead
 * RemotePlayer is never consulted — an anchor is only ever set from a trusted
 * update, and interpolating must not re-anchor, or the error compounds.
 *
 * Only advances while the receiver says it is playing, so a pause from the TV
 * remote over-runs by at most one 5s cycle before the next real value snaps it
 * back.
 */
export function interpolatePosition(input: {
  anchorPosition: number;
  anchorAtMs: number;
  nowMs: number;
  playing: boolean;
  duration?: number | null;
  maxExtrapolationMs?: number;
}): number {
  const anchor = input.anchorPosition;
  if (typeof anchor !== 'number' || !isFinite(anchor) || anchor < 0) return 0;
  if (!input.playing) return anchor;

  const elapsed = input.nowMs - input.anchorAtMs;
  if (!isFinite(elapsed) || elapsed <= 0) return anchor;

  const cap = input.maxExtrapolationMs ?? POSITION_EXTRAPOLATION_CAP_MS;
  const advanced = anchor + Math.min(elapsed, cap) / 1000;

  const duration = input.duration;
  if (typeof duration === 'number' && isFinite(duration) && duration > 0) {
    return Math.min(advanced, duration);
  }
  return advanced;
}

/**
 * Durations closer than this are the same track measured two ways — the
 * receiver's decoded length against RemotePlayer's or the catalogue's differ
 * by a fraction of a second. Anything wider means one side describes a
 * different track.
 */
export const DURATION_DISAGREEMENT_SEC = 2;

/** A seek this close to the end would finish the track, so it is not sent. */
export const SEEK_END_MARGIN_SEC = 1;

/** How old a receiver status may be and still vouch for the current track. */
export const SEEK_STATUS_FRESH_MS = 12_000;

/**
 * Pick the duration to publish, letting the receiver overrule a value that
 * belongs to a different track.
 *
 * The progress bar is scaled by the last published duration, so a stale one
 * mis-scales every seek. Prod 2026-10-06 11:45: after a queue reload put
 * "Fuck Her Gently" (123s) back on the receiver, RemotePlayer still reported
 * the previous item's 206.22s, and hydration published it because the event
 * stream was alive. The bar was drawn against 206s, a drag to ~70% sent a seek
 * to 144.1s, and the receiver ran off the end of a 123s track.
 *
 * Only a receiver status for the track the store believes is current may
 * overrule — straight after a track change the status can still describe the
 * old one, and then the incoming value is the better guess.
 */
export function reconcileDuration(input: {
  candidate: unknown;
  receiverDuration: unknown;
  receiverIsCurrentTrack: boolean;
  toleranceSec?: number;
}): number | null {
  const candidate = durationValue(input.candidate);
  const receiver = input.receiverIsCurrentTrack ? durationValue(input.receiverDuration) : null;
  if (receiver === null) return candidate;
  if (candidate === null) return receiver;
  const tolerance = input.toleranceSec ?? DURATION_DISAGREEMENT_SEC;
  return Math.abs(candidate - receiver) > tolerance ? receiver : candidate;
}

export type SeekRefusal = 'invalid-target' | 'track-mismatch' | 'beyond-end';

export type SeekDecision =
  | { action: 'seek'; time: number }
  | { action: 'refuse'; reason: SeekRefusal; trackDuration: number | null };

/**
 * Decide whether a seek target is safe to send.
 *
 * Seeking at or past the end makes the receiver finish the track and advance,
 * which is the skip. A correctly scaled bar cannot produce such a target, so
 * one arriving means the bar was drawn against another track's duration.
 * Refusing does nothing audible; sending skips a song the listener wanted. The
 * caller republishes the true duration so the next drag lands right.
 *
 * The track's real length comes from the receiver when a fresh status vouches
 * for the current track, otherwise from the catalogue — never from
 * RemotePlayer, whose duration is the value that went stale.
 *
 * Before #66 a seek while the event stream was dead was silently swallowed, so
 * this desync existed but could not skip anything. #66 made those seeks
 * arrive, and they arrived with the wrong target.
 */
export function decideSeek(input: {
  target: unknown;
  receiverDuration?: unknown;
  receiverIsCurrentTrack: boolean;
  receiverOnDifferentTrack: boolean;
  catalogDuration?: unknown;
  endMarginSec?: number;
}): SeekDecision {
  const receiver = input.receiverIsCurrentTrack ? durationValue(input.receiverDuration) : null;
  const trackDuration = receiver ?? durationValue(input.catalogDuration);

  const target = positionValue(input.target);
  if (target === null) return { action: 'refuse', reason: 'invalid-target', trackDuration };

  // The bar describes one track and the receiver is playing another: any
  // target is relative to the wrong song.
  if (input.receiverOnDifferentTrack) return { action: 'refuse', reason: 'track-mismatch', trackDuration };

  if (trackDuration !== null && target > trackDuration - (input.endMarginSec ?? SEEK_END_MARGIN_SEC)) {
    return { action: 'refuse', reason: 'beyond-end', trackDuration };
  }
  return { action: 'seek', time: target };
}

/** Capability a receiver advertises in aurora-status once it accepts aurora.control. */
export const RECEIVER_CONTROL_CAP = 'control';

/** Capability a receiver advertises once it accepts aurora.queue.insert. */
export const RECEIVER_QUEUE_INSERT_CAP = 'queue-insert';

/**
 * Whether transport can be sent to the receiver over the aurora namespace.
 *
 * Requires a recent status that advertises the capability. A receiver cached
 * from before the channel existed still accepts messages on the namespace —
 * it is registered — but nothing listens, so a command would vanish exactly
 * as silently as the failure it replaces. Without the capability the sender
 * keeps today's behaviour.
 */
export function receiverControlAvailable(input: {
  caps?: unknown;
  statusAgeMs: number;
  freshMs: number;
  /** Which capability is needed; transport by default. */
  capability?: string;
}): boolean {
  if (!(input.statusAgeMs >= 0 && input.statusAgeMs < input.freshMs)) return false;
  return Array.isArray(input.caps) && input.caps.includes(input.capability ?? RECEIVER_CONTROL_CAP);
}

/**
 * Map a receiver-reported player state onto what a transport decision needs.
 * BUFFERING counts as playing: a receiver mid-buffer is on its way to audible,
 * so a pause has real work to do.
 */
export function transportStateFromPlayerState(playerState: unknown): TransportState {
  if (playerState === 'PAUSED') return 'paused';
  if (playerState === 'PLAYING' || playerState === 'BUFFERING') return 'playing';
  return 'stopped';
}

/** Custom-namespace messages are capped at 64 KB; stay well clear of it. */
export const RECEIVER_MESSAGE_MAX_BYTES = 60_000;

/**
 * Turn a sender-built queue item into what the receiver can hand straight to
 * QueueManager.insertItems.
 *
 * The Stage 0 spike (2026-09-02, on the NAD) proved insertItems accepts a
 * plain JSON copy of a queue item with its itemId removed: the SDK assigned a
 * fresh id and placed it where asked. This produces exactly that shape from the
 * item the sender already builds for queueAppendItem — the same contentId,
 * codec, token and segment format that path has always sent, so a track added
 * over the channel plays exactly as one added through the media session would.
 *
 * Returns null for anything without a playable contentId: inserting it would
 * put a dead item in the device queue, which stops playback when reached.
 */
export function toReceiverQueueItem(item: unknown): Record<string, unknown> | null {
  if (!item || typeof item !== 'object') return null;
  let copy: Record<string, unknown>;
  try {
    copy = JSON.parse(JSON.stringify(item));
  } catch {
    return null;
  }
  const media = copy.media as Record<string, unknown> | undefined;
  if (!media || typeof media.contentId !== 'string' || media.contentId === '') return null;

  // The SDK assigns itemId; a stale or null one would collide or be rejected.
  delete copy.itemId;
  stripNulls(copy);
  stripNulls(media);
  return copy;
}

function stripNulls(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (record[key] === null || record[key] === undefined) delete record[key];
  }
}
