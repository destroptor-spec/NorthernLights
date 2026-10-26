import { scrobbleTracks as scrobbleLastFmTracks, type LfmTrack } from './lastfm.service';
import { scrobbleTracks as scrobbleListenBrainzTracks, type LbTrack } from './listenbrainz.service';
import { messageWithCause } from './metadata/errors';

/**
 * Scrobbles that hit a network failure are sent again later, from memory.
 *
 * Prod pm2 log, March–October 2026: 114 ListenBrainz scrobbles were lost to
 * `fetch failed` (ETIMEDOUT / ECONNRESET), alongside the same failures for
 * Last.fm and Genius lookups, so the cause is the server's own connection
 * dropping now and then. Both providers take listens with a past timestamp
 * (Last.fm up to 14 days), so a listen sent an hour late still counts.
 *
 * Held in memory only: a restart drops what is still waiting (no schema
 * change on the shared prod DB, by Andreas's choice 2026-10-26).
 */
export type ScrobbleProvider = 'lastfm' | 'listenbrainz';
export type RetryScrobbleTrack = LfmTrack & LbTrack;

/** Waits before each retry: about 52 minutes in all. */
export const SCROBBLE_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 300_000, 900_000, 1_800_000];
/** Bound on held scrobbles, so a long outage cannot grow memory without limit. */
export const SCROBBLE_RETRY_MAX_PENDING = 500;

export interface ScrobbleRetryDeps {
  send(provider: ScrobbleProvider, userId: string, tracks: RetryScrobbleTrack[]): Promise<unknown>;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  nowS(): number;
  log(message: string): void;
}

const defaultDeps: ScrobbleRetryDeps = {
  send: (provider, userId, tracks) => provider === 'lastfm'
    ? scrobbleLastFmTracks(userId, tracks)
    : scrobbleListenBrainzTracks(userId, tracks),
  setTimer: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  nowS: () => Math.floor(Date.now() / 1000),
  log: (message) => console.warn(`[Scrobble] ${message}`),
};

/**
 * Failures worth sending again: the request never got an answer, it timed
 * out, or the provider said it is temporarily down. A rejected scrobble (bad
 * token, invalid data) fails the same way every time and is not retried.
 */
export function isTransientScrobbleError(error: any): boolean {
  if (!error) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const message = String(error.message || error);
  if (/fetch failed/i.test(message)) return true;
  if (/Last\.fm HTTP 5\d\d|ListenBrainz returned 5\d\d/.test(message)) return true;
  // Last.fm 11 "Service Offline", 16 "temporarily unavailable": docs say retry.
  return /Last\.fm error (11|16):/.test(message);
}

interface PendingScrobble {
  provider: ScrobbleProvider;
  userId: string;
  tracks: RetryScrobbleTrack[];
  attempt: number;
  timer: unknown;
}

let pending: PendingScrobble[] = [];

function schedule(item: PendingScrobble, deps: ScrobbleRetryDeps) {
  const delayMs = SCROBBLE_RETRY_DELAYS_MS[item.attempt];
  item.timer = deps.setTimer(() => { void retry(item, deps); }, delayMs);
}

async function retry(item: PendingScrobble, deps: ScrobbleRetryDeps) {
  const label = `provider=${item.provider} count=${item.tracks.length} attempt=${item.attempt + 1}`;
  try {
    await deps.send(item.provider, item.userId, item.tracks);
    pending = pending.filter((entry) => entry !== item);
    deps.log(`scrobble_retry_sent ${label}`);
  } catch (error) {
    item.attempt += 1;
    if (isTransientScrobbleError(error) && item.attempt < SCROBBLE_RETRY_DELAYS_MS.length) {
      schedule(item, deps);
      deps.log(`scrobble_retry_failed ${label} message=${messageWithCause(error).slice(0, 240)}`);
      return;
    }
    pending = pending.filter((entry) => entry !== item);
    deps.log(`scrobble_retry_gave_up ${label} message=${messageWithCause(error).slice(0, 240)}`);
  }
}

/**
 * Submit scrobbles to one provider. A transient failure is held and sent
 * again later instead of thrown, so callers treat it as handled; any other
 * failure is thrown as before. `overrides.log` lets a caller keep the retry
 * lines in its own log (the Subsonic bridge writes to subsonic-api.log).
 */
export async function scrobbleWithRetry(
  provider: ScrobbleProvider,
  userId: string,
  tracks: RetryScrobbleTrack[],
  overrides: Partial<ScrobbleRetryDeps> = {},
): Promise<unknown> {
  const deps: ScrobbleRetryDeps = { ...defaultDeps, ...overrides };
  // A retry must keep the time of the listen, not the time it finally got through.
  const nowS = deps.nowS();
  const stamped = tracks.map((track) => track.timestamp ? track : { ...track, timestamp: nowS });
  try {
    return await deps.send(provider, userId, stamped);
  } catch (error) {
    if (!isTransientScrobbleError(error)) throw error;
    if (pending.length >= SCROBBLE_RETRY_MAX_PENDING) {
      deps.log(`scrobble_retry_dropped provider=${provider} count=${stamped.length} reason=queue-full message=${messageWithCause(error).slice(0, 240)}`);
      throw error;
    }
    const item: PendingScrobble = { provider, userId, tracks: stamped, attempt: 0, timer: null };
    pending.push(item);
    schedule(item, deps);
    deps.log(`scrobble_retry_queued provider=${provider} count=${stamped.length} message=${messageWithCause(error).slice(0, 240)}`);
    return { queued: true };
  }
}

export function pendingScrobbleCount(): number {
  return pending.length;
}

/** Tests only. */
export function resetScrobbleRetries(deps: Pick<ScrobbleRetryDeps, 'clearTimer'> = defaultDeps) {
  for (const item of pending) deps.clearTimer(item.timer);
  pending = [];
}
