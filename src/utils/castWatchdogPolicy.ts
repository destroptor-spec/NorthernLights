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
  const sessionTime = positionValue(input.sessionTime);
  const sessionDuration = durationValue(input.sessionDuration);
  const fallbackDuration = durationValue(input.fallbackDuration);

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
