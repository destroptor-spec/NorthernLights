/**
 * Lifecycle reconcile bursts and stale-transport recovery (issue #39).
 *
 * Prod 2026-10-10 16:16Z, "Stue TV": the sender came back from 42 minutes in
 * the background holding a session whose PresentationConnection Chrome had
 * already torn down. Every send threw `InvalidStateError: ... Presentation
 * connection is disconnected`. Over the next 30s:
 *
 * - each lifecycle event (visibilitychange, focus) fired its full burst of
 *   three reconcile attempts against the dead transport, racing the recovery
 *   the first attempt had just started;
 * - `endCurrentSession()` itself threw on the dead transport, so the stale
 *   session never detached, `getCurrentSession()` kept returning it, and the
 *   recovery declared success on its first poll — `stale-transport-recovered`
 *   was logged eight times while the very next send failed every time;
 * - the watchdog restarted that fake recovery every 5s.
 *
 * The pieces here keep the healthy path exactly as it was and only change
 * behaviour once the transport has been proven dead.
 */

/** Staggered attempts after a lifecycle event; see CastManager.attachLifecycleReconcileHandlers. */
export const LIFECYCLE_RECONCILE_DELAYS_MS: readonly number[] = [0, 750, 2500];

export interface BurstTimers {
  set(callback: () => void, delayMs: number): number;
  clear(id: number): void;
}

/**
 * One burst of staggered reconcile attempts that can be cancelled.
 *
 * In a frozen tab the timers coalesce and all three attempts land within
 * milliseconds of each other on resume, so a burst must be able to stand down
 * as soon as one of its attempts hands the session over to stale-transport
 * recovery: the remaining attempts can only send into the same dead transport.
 */
export class ReconcileBurst {
  private pending: number[] = [];
  private active = false;

  constructor(
    private readonly timers: BurstTimers,
    private readonly delaysMs: readonly number[] = LIFECYCLE_RECONCILE_DELAYS_MS,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  /**
   * Schedule the attempts. Returns false when a burst is already running,
   * which is how the five lifecycle listeners collapse into one burst.
   *
   * `shouldStandDown` is checked before every attempt; when it says so, that
   * attempt and every later one are dropped and `onStandDown` runs once.
   */
  start(options: {
    attempt: (delayMs: number) => void;
    shouldStandDown: () => boolean;
    onStandDown?: (delayMs: number) => void;
  }): boolean {
    if (this.active) return false;
    this.active = true;
    const lastDelay = this.delaysMs[this.delaysMs.length - 1];

    for (const delayMs of this.delaysMs) {
      const id = this.timers.set(() => {
        this.pending = this.pending.filter((pendingId) => pendingId !== id);
        if (!this.active) return;
        if (options.shouldStandDown()) {
          this.cancel();
          options.onStandDown?.(delayMs);
          return;
        }
        try {
          options.attempt(delayMs);
        } finally {
          // The reset used to live only inside the last callback, so anything
          // that stopped it running left lifecycle reconciles disabled for the
          // life of the page.
          if (delayMs === lastDelay) this.cancel();
        }
      }, delayMs);
      this.pending.push(id);
    }
    return true;
  }

  /** Drop any attempts not yet run and allow the next burst to start. */
  cancel(): void {
    for (const id of this.pending) this.timers.clear(id);
    this.pending = [];
    this.active = false;
  }
}

export type TransportProbeResult = 'alive' | 'dead' | 'unknown';

/** Same namespace and message the status watchdog already sends every few seconds. */
export const CAST_MEDIA_NAMESPACE = 'urn:x-cast:com.google.cast.media';
export const TRANSPORT_PROBE_TIMEOUT_MS = 1500;

interface ProbeableSession {
  sendMessage?: (namespace: string, message: unknown) => unknown;
}

/**
 * Ask whether a session's transport can carry a message, by sending the
 * GET_STATUS the watchdog already sends routinely.
 *
 * Only a failure that `isDisconnected` recognises counts as `dead` — that is
 * the exact signature of the 2026-10-10 incident. Anything else (a session
 * without sendMessage, another rejection, no answer in time) is `unknown`,
 * and callers treat `unknown` the way they behaved before the probe existed.
 * The Cast docs only promise that sendMessage "returns a Promise", so the
 * probe copes with a synchronous throw, a rejection, and an error code
 * resolved as a value.
 */
export async function probeCastTransport(
  session: ProbeableSession | null | undefined,
  options: {
    requestId: number;
    isDisconnected: (error: unknown) => boolean;
    timeoutMs?: number;
  },
): Promise<TransportProbeResult> {
  if (!session || typeof session.sendMessage !== 'function') return 'unknown';

  const classify = (error: unknown): TransportProbeResult =>
    options.isDisconnected(error) ? 'dead' : 'unknown';

  let sent: unknown;
  try {
    sent = session.sendMessage(CAST_MEDIA_NAMESPACE, {
      type: 'GET_STATUS',
      requestId: options.requestId,
    });
  } catch (error) {
    return classify(error);
  }

  if (!sent || typeof (sent as PromiseLike<unknown>).then !== 'function') return 'alive';

  const timeoutMs = options.timeoutMs ?? TRANSPORT_PROBE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TransportProbeResult>((resolve) => {
    timer = setTimeout(() => resolve('unknown'), timeoutMs);
  });
  const outcome = Promise.resolve(sent as PromiseLike<unknown>).then(
    (value) => (typeof value === 'string' && value ? classify(value) : 'alive' as const),
    (error) => classify(error),
  );

  try {
    return await Promise.race([outcome, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The signature of a torn-down PresentationConnection (prod 2026-10-10). */
const PRESENTATION_DISCONNECT = /PresentationConnection.*disconnected|InvalidStateError/i;

/**
 * Whether a failed media-status refresh should start stale-transport recovery.
 *
 * Prod 2026-10-23 11:52Z, "Beoplay A9": the user picked a new song, and the
 * watchdog's getStatus reached the media session that LOAD was replacing. The
 * A9 answered `session_error`, recovery detached and rejoined a healthy
 * session, and the A9 ended it 5s later. The same sequence had ended A9
 * sessions six times since May.
 *
 * A `session_error` on its own can mean the media session moved on rather
 * than the transport going away, so it is only acted on when a probe does not
 * get through. A disconnected PresentationConnection still recovers at once.
 */
export async function mediaStatusFailureNeedsRecovery(
  session: ProbeableSession | null | undefined,
  detail: string,
  options: {
    requestId: number;
    isDisconnected: (error: unknown) => boolean;
    timeoutMs?: number;
  },
): Promise<boolean> {
  if (!options.isDisconnected(detail)) return false;
  if (PRESENTATION_DISCONNECT.test(detail)) return true;
  return (await probeCastTransport(session, options)) !== 'alive';
}
