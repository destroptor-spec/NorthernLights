/**
 * Volume changes from this sender to a Cast receiver, without the slider
 * rubberbanding back while it is dragged.
 *
 * A drag sends a volume change on every input event. The receiver answers each
 * one with a status, and the RemotePlayer reports those statuses as
 * VOLUME_LEVEL_CHANGED — so while the finger is still moving, the slider keeps
 * being set back to a value from a moment ago (Andreas, 2026-10-30).
 *
 * So changes are sent at most every SEND_INTERVAL_MS (the latest one always
 * goes out), and while one of ours is under way the receiver's reports of
 * other levels are its echoes of earlier steps, not news. Once the receiver
 * reports the level last sent, its reports count again. If it hasn't HOLD_MS
 * after the last send, `onSettled` hands over whatever it actually has, which
 * covers a receiver that won't go where it was asked.
 */
export const SEND_INTERVAL_MS = 150;
export const HOLD_MS = 1500;
const SAME_LEVEL = 0.005;

export class CastVolumeGate {
  private target: number | null = null;
  private lastSentAt = -Infinity;
  private trailing: ReturnType<typeof setTimeout> | null = null;
  private hold: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (level: number) => void,
    private readonly onSettled: () => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** This sender wants the receiver at `level`. */
  set(level: number): void {
    this.target = level;
    if (this.trailing) return; // the scheduled send picks up the newest level
    const wait = this.lastSentAt + SEND_INTERVAL_MS - this.now();
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
   * The receiver reports `level`. True when the app should take it; false when
   * it is an echo of one of this sender's own steps.
   */
  receiverReports(level: number): boolean {
    if (this.target === null) return true;
    if (!this.trailing && Math.abs(level - this.target) < SAME_LEVEL) {
      this.settle(false);
      return false; // already showing it
    }
    return false;
  }

  dispose(): void {
    if (this.trailing) clearTimeout(this.trailing);
    if (this.hold) clearTimeout(this.hold);
    this.trailing = null;
    this.hold = null;
    this.target = null;
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
    if (timedOut) this.onSettled();
  }
}
