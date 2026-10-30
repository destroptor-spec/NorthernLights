/**
 * Volume changes sent to another device (a Cast receiver, or the device that
 * plays the session), without the slider rubberbanding back while it is
 * dragged.
 *
 * A drag sends a volume change on every input event. The other device answers
 * each one, and those answers come back as volume reports — so while the
 * finger is still moving, the slider keeps being set back to a value from a
 * moment ago (Andreas, 2026-10-30, casting).
 *
 * So changes are sent at most every `intervalMs` (the latest one always goes
 * out), and while one of ours is under way the device's reports of other
 * levels are its echoes of earlier steps, not news. Once it reports the level
 * last sent, its reports count again. If it hasn't HOLD_MS after the last
 * send, `onSettled(true)` lets the app take whatever it actually has, which
 * covers a device that won't go where it was asked.
 */
export const SEND_INTERVAL_MS = 150;
export const HOLD_MS = 1500;
const SAME_LEVEL = 0.005;

export class VolumeGate {
  private target: number | null = null;
  private lastSentAt = -Infinity;
  private trailing: ReturnType<typeof setTimeout> | null = null;
  private hold: ReturnType<typeof setTimeout> | null = null;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly send: (level: number) => void,
    /** The change is over: confirmed by the device, or `timedOut` without. */
    private readonly onSettled: (timedOut: boolean) => void,
    options: { intervalMs?: number; now?: () => number } = {},
  ) {
    this.intervalMs = options.intervalMs ?? SEND_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** This device wants the other one at `level`. */
  set(level: number): void {
    this.target = level;
    if (this.trailing) return; // the scheduled send picks up the newest level
    const wait = this.lastSentAt + this.intervalMs - this.now();
    if (wait <= 0) {
      this.sendTarget();
      return;
    }
    this.trailing = setTimeout(() => {
      this.trailing = null;
      this.sendTarget();
    }, wait);
  }

  /**
   * The other device reports `level`. True when the app should take it; false
   * when it is an echo of one of this device's own steps.
   */
  receiverReports(level: number): boolean {
    if (this.target === null) return true;
    if (!this.trailing && Math.abs(level - this.target) < SAME_LEVEL) this.settle(false);
    return false;
  }

  dispose(): void {
    if (this.trailing) clearTimeout(this.trailing);
    if (this.hold) clearTimeout(this.hold);
    this.trailing = null;
    this.hold = null;
    this.target = null;
    this.lastSentAt = -Infinity;
  }

  private sendTarget(): void {
    if (this.target === null) return;
    this.lastSentAt = this.now();
    this.send(this.target);
    if (this.hold) clearTimeout(this.hold);
    this.hold = setTimeout(() => this.settle(true), HOLD_MS);
  }

  private settle(timedOut: boolean): void {
    if (this.hold) clearTimeout(this.hold);
    this.hold = null;
    this.target = null;
    this.onSettled(timedOut);
  }
}
