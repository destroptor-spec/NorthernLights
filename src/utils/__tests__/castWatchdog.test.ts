import { shouldReleaseRemoteMedia } from '../castWatchdogPolicy';

/**
 * Regression guard for prod 2026-09-01 09:00-09:09. The RemotePlayer event
 * stream was dead (eventSilenceMs past 530s) while the receiver played
 * continuously and the watchdog pulled media status successfully every minute.
 * The media session object then blinked out for one probe window and playback
 * state was released — the UI showed nothing playing while the speaker played
 * on. A missing session object is not proof the media is gone.
 */
describe('shouldReleaseRemoteMedia', () => {
  const base = { graceMs: 20_000, evidenceWindowMs: 60_000 };

  it('holds when the receiver proved itself alive recently', () => {
    // The exact shape of the incident: probe window elapsed, but a status
    // refresh succeeded ~60s earlier.
    expect(shouldReleaseRemoteMedia({ ...base, probedMs: 25_000, msSinceEvidence: 25_000 })).toBe(false);
  });

  it('holds while still inside the probe window', () => {
    expect(shouldReleaseRemoteMedia({ ...base, probedMs: 5_000, msSinceEvidence: 300_000 })).toBe(false);
  });

  it('releases only when the probe window has elapsed and nothing proves life', () => {
    expect(shouldReleaseRemoteMedia({ ...base, probedMs: 25_000, msSinceEvidence: 65_000 })).toBe(true);
  });

  it('treats a dead event stream alone as insufficient', () => {
    // 530s of RemotePlayer silence, but evidence 10s old: the watchdog is
    // papering over a dead event stream, which is its whole purpose.
    expect(shouldReleaseRemoteMedia({ ...base, probedMs: 60_000, msSinceEvidence: 10_000 })).toBe(false);
  });

  it('is exact at both boundaries', () => {
    expect(shouldReleaseRemoteMedia({ ...base, probedMs: 20_000, msSinceEvidence: 60_000 })).toBe(true);
    expect(shouldReleaseRemoteMedia({ ...base, probedMs: 19_999, msSinceEvidence: 60_000 })).toBe(false);
    expect(shouldReleaseRemoteMedia({ ...base, probedMs: 20_000, msSinceEvidence: 59_999 })).toBe(false);
  });

  it('still releases a genuinely finished queue', () => {
    // Receiver went IDLE: no events, no status, nothing for minutes.
    expect(shouldReleaseRemoteMedia({ ...base, probedMs: 120_000, msSinceEvidence: 120_000 })).toBe(true);
  });
});
