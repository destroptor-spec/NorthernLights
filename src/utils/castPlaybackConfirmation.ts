export interface CastPlaybackEvidence {
    entryId?: string | null;
    playerState?: string | null;
    currentTime?: number;
}

interface Start {
    entryId: string;
    isCurrent: () => boolean;
    retry: () => Promise<unknown>;
    confirmed: (attempt: number, elapsedMs: number) => void;
    failed: (attempt: number, elapsedMs: number) => void;
    cancelled: () => void;
}

/** A LOAD acknowledgement is transport success, not evidence of playback. */
export class CastPlaybackConfirmation {
    private active: (Start & { attempt: number; startedAt: number; first: number | null; last: number | null; increases: number; didFail: boolean }) | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;

    get pending(): boolean { return this.active !== null && !this.active.didFail; }
    get unconfirmed(): boolean { return this.active !== null; }
    get entryId(): string | null { return this.active?.entryId ?? null; }

    start(start: Start): void {
        this.cancel();
        this.active = { ...start, attempt: 1, startedAt: Date.now(), first: null, last: null, increases: 0, didFail: false };
        this.arm();
    }

    cancel(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        const active = this.active;
        this.active = null;
        active?.cancelled();
    }

    observe(evidence: CastPlaybackEvidence): void {
        const active = this.active;
        if (!active) return;
        if (!active.isCurrent()) { this.cancel(); return; }
        if (evidence.entryId !== active.entryId || evidence.playerState !== 'PLAYING' ||
            typeof evidence.currentTime !== 'number' || !Number.isFinite(evidence.currentTime) || evidence.currentTime < 0) return;
        const time = evidence.currentTime;
        if (active.first === null || active.last === null || time < active.last) {
            active.first = time; active.last = time; active.increases = 0;
            return;
        }
        if (time > active.last) active.increases++;
        active.last = time;
        if (active.increases < 2 && time - active.first < 1 - 1e-6) return;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.active = null;
        active.confirmed(active.attempt, Date.now() - active.startedAt);
    }

    private arm(): void {
        const active = this.active;
        const dueAt = Date.now() + 15000;
        this.timer = setTimeout(() => {
            this.timer = null;
            if (!active || this.active !== active) return;
            if (!active.isCurrent()) { this.cancel(); return; }
            // Background suspension can delay this callback by minutes. An
            // automatic reload then could restart audible music or seize a
            // receiver whose new owner we have not observed yet.
            if (Date.now() - dueAt > 5000) {
                active.didFail = true;
                active.failed(active.attempt, Date.now() - active.startedAt);
                return;
            }
            if (active.attempt === 1) {
                active.attempt = 2;
                active.first = active.last = null;
                active.increases = 0;
                this.arm();
                // The second deadline owns failure, even if retry hangs/rejects.
                void active.retry().catch(() => undefined);
            } else {
                active.didFail = true;
                active.failed(active.attempt, Date.now() - active.startedAt);
            }
        }, 15000);
    }
}
