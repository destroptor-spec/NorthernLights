// Phase 5, PR C (docs/cast-receiver-output.md): a Cast receiver that can play
// the session on its own gets the session and its credential from the sender.
//
// The receiver tells what it can do only in `aurora.status`, which it first
// sends once something is loaded, so the sender cannot know at the first LOAD.
// The LOAD therefore stays exactly as it is, and the credential travels in its
// own acknowledged message on the Aurora channel, which also serves a joined
// or rejoined session and every later refresh.

/** In `aurora.status` caps: this receiver build follows a session itself. */
export const RECEIVER_SESSION_FOLLOW_CAP = 'session-follow';

/** What the receiver needs to follow the session (the token is never logged). */
export interface ReceiverHandover {
  sessionId: string;
  outputId: string;
  generation: number;
  token: string;
  expiresAt: string;
  renewableUntil?: string;
  /** The Cast stream quality the receiver builds its items with (the sender's, resolved for Cast). */
  quality?: string;
}

export interface ReceiverFollowMessage extends ReceiverHandover {
  type: 'aurora.session.follow';
  requestId: number;
}

export interface ReceiverFollowAck {
  type?: string;
  requestId?: unknown;
  ok?: unknown;
  detail?: unknown;
}

const ACK_TIMEOUT_MS = 5_000;
const ATTEMPTS = 3;

/** Waits for the receiver's `aurora.session.follow.ack`, by requestId. */
export class ReceiverFollowAcks {
  private readonly waiting = new Map<number, (ok: boolean) => void>();

  wait(requestId: number, timeoutMs = ACK_TIMEOUT_MS): Promise<boolean | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.waiting.set(requestId, (ok) => {
        clearTimeout(timer);
        this.waiting.delete(requestId);
        resolve(ok);
      });
    });
  }

  acknowledge(ack: ReceiverFollowAck): void {
    const requestId = Number(ack.requestId);
    this.waiting.get(requestId)?.(ack.ok === true);
  }
}

export type HandoverResult = { ok: boolean; attempts: number; outcome: 'acked' | 'refused' | 'unanswered' | 'send-failed' };

/**
 * Sends the handover until the receiver answers, at most three times. A
 * refusal is final; no answer at all after three tries means this receiver
 * does not follow after all.
 */
export async function handOverToReceiver(
  handover: ReceiverHandover,
  deps: {
    send: (message: ReceiverFollowMessage) => Promise<void>;
    acks: ReceiverFollowAcks;
    nextRequestId: () => number;
    timeoutMs?: number;
    attempts?: number;
  },
): Promise<HandoverResult> {
  const attempts = deps.attempts ?? ATTEMPTS;
  let sendFailed = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const requestId = deps.nextRequestId();
    const answer = deps.acks.wait(requestId, deps.timeoutMs);
    try {
      await deps.send({ type: 'aurora.session.follow', requestId, ...handover });
      sendFailed = false;
    } catch {
      sendFailed = true;
    }
    const ok = await answer;
    if (ok === true) return { ok: true, attempts: attempt, outcome: 'acked' };
    if (ok === false) return { ok: false, attempts: attempt, outcome: 'refused' };
  }
  return { ok: false, attempts, outcome: sendFailed ? 'send-failed' : 'unanswered' };
}
