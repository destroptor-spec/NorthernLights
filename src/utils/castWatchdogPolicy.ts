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
