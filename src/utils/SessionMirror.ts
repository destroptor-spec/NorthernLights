import type { PlaybackOutputCredential, PlaybackOutputReport, PlaybackSession, PlaybackSessionPatch } from '../../shared/api/v1';
import { AuroraApiError } from '../api/auroraApi';
import * as sessionApi from '../api/playbackSessions';
import { currentSessionFromError } from '../api/playbackSessions';
import type { TrackInfo } from './fileSystem';
import { planSessionPatch, MAX_SESSION_QUEUE, type QueueEntryRef } from './sessionQueueDiff';
import type { ReceiverHandover } from './receiverSessionFollow';
import { createUuid, isUuid } from './uuid';

// The playing side of "Sync playback across devices" (docs/playback_sessions.md,
// Phase 2). While this device plays, it holds the session's output: it mirrors
// its queue, repeat and shuffle into the user's one playback session, and
// reports what it plays. The session's queue is the one that counts (Phase
// 3): another device's edit is taken in here, and an edit of this device's
// that lost to a newer change is sent again at the newer revision (its
// anchors still mean the same thing), or dropped when it cannot apply any more.
//
// Following another device (adopting its queue, "Playing on …") is
// SessionFollower's job.
//
// Casting to a receiver that plays the session on its own (Phase 5,
// docs/cast-receiver-output.md), this device claims the output for the
// receiver and hands it the credential; the receiver reports from then on,
// and this device only mirrors queue edits and renews the credential.

export interface MirroredPlayerState {
  syncPlaybackAcrossDevices: boolean;
  currentUser: { id: string } | null;
  playlist: TrackInfo[];
  currentIndex: number | null;
  repeat: PlaybackSession['repeatMode'];
  shuffle: boolean;
  /** Infinity on this device; the server keeps it for a receiver that follows the session (Phase 4). */
  isInfinityMode?: boolean;
  playbackState: 'playing' | 'paused' | 'stopped';
  isBuffering: boolean;
  castConnected: boolean;
  getAuthHeader: () => Record<string, string>;
}

export interface MirroredStore {
  getState: () => MirroredPlayerState;
  subscribe: (listener: (state: MirroredPlayerState, previous: MirroredPlayerState) => void) => () => void;
}

export interface SessionMirrorOptions {
  api?: typeof sessionApi;
  /** Playback position of the current track, in seconds (Cast or local). */
  getPositionSeconds: () => number;
  /** Name shown for this output: the Cast device while casting, else this browser. */
  getOutputName: () => string;
  /** While casting: the Cast session this device sends to (told to the server with the claim). */
  getCastSessionId?: () => string | null;
  log?: (message: string, detail?: unknown) => void;
  /** False while this device must not claim (it is leaving another device's Cast session). */
  canClaim?: () => boolean;
  /** Server-side diagnostics (`sync-…` markers in the Cast log). */
  diagnostic?: (level: 'ok' | 'warn' | 'error', marker: string, detail?: string) => void;
  /**
   * Another device plays the session now: stop playing here (one device at a
   * time). `replacement` is the new output, when known, so a device that took
   * over the same Cast device this one casts to can be told apart.
   */
  onDisplaced?: (replacement: ReplacingOutput | null) => void;
  /** The server refused with PLAYBACK_SYNC_DISABLED: sync is off for this account. */
  onSyncDisabled?: () => void;
  /** While casting: the receiver plays the session on its own when given one. */
  receiverCanFollow?: () => boolean;
  /** Gives the receiver the session and its credential; true once it took them. */
  handOverToReceiver?: (handover: ReceiverHandover, reason: 'claim' | 'refresh') => Promise<boolean>;
  /** The receiver took the session, or this device no longer holds it for the receiver. */
  onReceiverFollowsChanged?: (following: boolean) => void;
  /**
   * The session's queue is the one that counts (Phase 3): take it in here,
   * after an edit of this device's was merged with another device's, or was
   * dropped because it could no longer apply.
   */
  adoptSession?: (session: PlaybackSession) => void;
}

const SESSION_NAME = 'Listening';
export const REPORT_INTERVAL_PLAYING_MS = 10_000;
export const REPORT_INTERVAL_PAUSED_MS = 30_000;
const FLUSH_DELAY_MS = 250;
const REPORT_SOON_MS = 300;
const RETRY_DELAY_MS = 5_000;
const CLAIM_RETRY_DELAY_MS = 30_000;
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;
/** A lost edit is sent again at the newer revision at most this often. */
const MAX_REBASES = 2;
/** A wake renews a receiver's credential (and so its 24-hour cap) at most this often. */
const WAKE_REFRESH_MIN_INTERVAL_MS = 60_000;
/**
 * Casting starting or stopping changes the output's kind, but a recovered Cast
 * connection blinks off and on within a second (prod 2026-10-16 08:43:01,
 * Beoplay A9). The kind is claimed once that has settled.
 */
export const CAST_KIND_SETTLE_MS = 1_000;
/** The edit cannot apply to the newer session: take the session's queue instead. */
const UNAPPLIABLE_CODES = new Set(['ANCHOR_NOT_FOUND', 'ENTRY_ID_CONFLICT', 'CURRENT_ENTRY_PLAYING']);

type OutputKind = 'browser' | 'cast' | 'receiver';

interface Grant { sessionId: string; credential: PlaybackOutputCredential; seq: number; kind: OutputKind }

/** The output that replaced this device: what kind of device, and its name. */
export interface ReplacingOutput { kind: string; name: string | null }

const entriesOf = (playlist: TrackInfo[]): QueueEntryRef[] =>
  playlist.map((track) => ({ entryId: track.queueEntryId || '', trackId: track.id, ...(track.isInfinity ? { infinity: true } : {}) }));

/**
 * Another device took over by casting to the very Cast device this one casts
 * to (both joined one Cast session, prod 2026-10-13 19:50). The music never
 * moved, so nothing stops here: pausing would pause the speaker for both.
 * Matched by the Cast device's name, which is what the claim carries.
 */
export function isSameCastDevice(replacement: ReplacingOutput | null, castConnected: boolean, castDeviceName: string | null | undefined): boolean {
  return !!replacement && castConnected && (replacement.kind === 'cast' || replacement.kind === 'receiver')
    && !!replacement.name && !!castDeviceName && replacement.name === castDeviceName;
}

/**
 * What this device does when another device takes the session over:
 * - `none`: the other device casts to the same Cast device (the music never
 *   moved), or nothing plays here;
 * - `stop-casting`: this device casts elsewhere; it stops casting and then
 *   follows the new device (a casting device never follows, so pausing alone
 *   left it showing its old queue; prod 2026-10-13, Andreas chose this);
 * - `pause`: it plays itself.
 * With the replacing output unknown, a casting device only pauses: stopping
 * the receiver could stop music another device still casts there.
 */
export function actionWhenReplaced(input: {
  replacement: ReplacingOutput | null;
  castConnected: boolean;
  castDeviceName: string | null | undefined;
  playing: boolean;
}): 'none' | 'pause' | 'stop-casting' {
  if (isSameCastDevice(input.replacement, input.castConnected, input.castDeviceName)) return 'none';
  if (input.castConnected && input.replacement) return 'stop-casting';
  return input.playing ? 'pause' : 'none';
}

export class SessionMirror {
  private store: MirroredStore | null = null;
  private options: SessionMirrorOptions | null = null;
  private unsubscribe: (() => void) | null = null;

  private sessionId: string | null = null;
  private grant: Grant | null = null;
  /** The session as the server last confirmed it; patches are planned from it. */
  private session: PlaybackSession | null = null;
  /** Another device claimed the output; only an explicit Play here claims it back. */
  private displaced = false;
  private claiming: Promise<void> | null = null;
  private patching = false;
  private dirty = false;
  private failedPatch: { requestId: string; body: string } | null = null;
  private readonly blockedTrackIds = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reportTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private claimRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The Cast session whose receiver did not take the session: claim as `cast` there. */
  private receiverRefusedCastSession: string | null = null;
  /** The receiver took the session for this device's current grant. */
  private receiverFollowing = false;
  private wakeRefreshAt = 0;
  private kindTimer: ReturnType<typeof setTimeout> | null = null;

  start(store: MirroredStore, options: SessionMirrorOptions): void {
    this.stop();
    this.store = store;
    this.options = options;
    this.unsubscribe = store.subscribe((state, previous) => this.onStateChange(state, previous));
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
    if (this.claimRetryTimer) clearTimeout(this.claimRetryTimer);
    this.claimRetryTimer = null;
    this.release();
    this.sessionId = null;
    this.displaced = false;
  }

  /** The user pressed Play (or started something) on this device. */
  notePlayIntent(): void {
    this.displaced = false;
    const state = this.store?.getState();
    if (state && this.enabled(state) && !this.grant && state.playbackState === 'playing') void this.claim();
  }

  /**
   * The page is closing while this device plays the session. Playback here
   * ends with it, so say so: other devices stop showing it and stop sending
   * it commands at once, not after a minute of silence. While casting the
   * Cast device plays on, so nothing is reported.
   */
  private readonly onPageHide = () => {
    const grant = this.grant;
    const state = this.store?.getState();
    if (!grant || !state || state.castConnected) return;
    const entryId = state.currentIndex !== null ? state.playlist[state.currentIndex]?.queueEntryId : undefined;
    this.options?.diagnostic?.('ok', 'sync-closing', `state=${state.playbackState}`);
    void this.api.reportPlaybackOutput(grant.credential, grant.sessionId, {
      seq: ++grant.seq,
      state: 'stopped',
      reason: 'closed',
      queueEntryId: entryId && isUuid(entryId) ? entryId : null,
      positionMs: Math.max(0, Math.round((this.options!.getPositionSeconds() || 0) * 1000)),
    }, { keepalive: true }).catch(() => undefined);
  };

  /**
   * Report at once, after carrying out a remote command, so the sender sees
   * it took. Not via a timer: Android stretches timers in a background tab
   * (prod 2026-10-14: the skip happened, the desktop said "isn't responding").
   */
  reportNow(): void {
    void this.report();
  }

  /**
   * This device casts to a different Cast session than it told the server
   * (a reconnect after a stale transport starts a new one): claim again, so
   * another device can tell joining it from starting a new one.
   */
  noteCastSessionChanged(): void {
    if (this.grant && this.store?.getState().castConnected) void this.claim();
  }

  /**
   * The receiver of this device's Cast session can follow the session on its
   * own: hand the output over to it.
   */
  noteReceiverCanFollow(): void {
    // Its status can come while this device's own first claim is still on
    // its way (mirroring the queue, the first report): look again after it
    // (prod 2026-10-16 19:44:43, phone: the handover never happened).
    if (this.claiming) {
      void this.claiming.catch(() => undefined).then(() => this.noteReceiverCanFollow());
      return;
    }
    const state = this.store?.getState();
    if (this.grant?.kind !== 'cast' || !state?.castConnected || !this.enabled(state)) return;
    if (this.claimsForReceiver(this.options?.getCastSessionId?.() || undefined)) void this.claim();
  }

  /**
   * The page came back to the foreground. A receiver playing the session
   * gets a fresh credential, which also renews its 24-hour cap.
   */
  noteWake(): void {
    if (this.grant?.kind !== 'receiver' || Date.now() - this.wakeRefreshAt < WAKE_REFRESH_MIN_INTERVAL_MS) return;
    this.wakeRefreshAt = Date.now();
    void this.refresh();
  }

  /**
   * The receiver this device casts to plays the session itself: this device
   * is only a controller of it (docs/cast-receiver-output.md, PR E).
   */
  receiverFollows(): boolean {
    return this.receiverFollowing;
  }

  /**
   * SessionFollower read a newer session while this device holds the output.
   * True when this device should take its queue: nothing of its own is on
   * the way (an edit in flight answers with the newer session anyway).
   */
  noteSessionChanged(session: PlaybackSession): boolean {
    if (!this.grant || session.id !== this.grant.sessionId) return false;
    if (this.session && session.revision <= this.session.revision) return false;
    if (this.patching || this.dirty || this.flushTimer) return false;
    this.session = session;
    return true;
  }

  /**
   * Sends this device's pending queue edits now, and answers the session as
   * the server confirmed it (for a `load` command), or null.
   */
  async flushNow(): Promise<PlaybackSession | null> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (let attempt = 0; attempt < 3 && this.patching; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.flush();
    return this.session;
  }

  /** This device is the session's output (playing or paused), or casts to the receiver that is. */
  holdsOutput(): boolean {
    return !!this.grant;
  }

  /** The grant this device holds, to tell which remote commands are for it. */
  currentGrant(): { sessionId: string; outputId: string; generation: number } | null {
    return this.grant
      ? { sessionId: this.grant.sessionId, outputId: this.grant.credential.outputId, generation: this.grant.credential.generation }
      : null;
  }

  /**
   * Another device claimed a session's output (`playbackSession.handedOff`).
   * A claim this device made later wins; anything else means the other
   * device plays now, so this one stops, even when its own claim never got
   * through.
   */
  async noteReplaced(sessionId: string, generation: number, replacement: ReplacingOutput | null = null): Promise<void> {
    if (this.claiming) await this.claiming.catch(() => undefined);
    const state = this.store?.getState();
    if (!state || !this.enabled(state)) return;
    if (this.grant) {
      if (this.grant.sessionId === sessionId && this.grant.credential.generation >= generation) return;
      this.onDisplaced(replacement);
      return;
    }
    if (state.playbackState === 'playing') this.onDisplaced(replacement);
  }

  private get api() { return this.options?.api ?? sessionApi; }
  private log(message: string, detail?: unknown) { this.options?.log?.(`[SessionMirror] ${message}`, detail); }
  private enabled(state: MirroredPlayerState) { return state.syncPlaybackAcrossDevices && !!state.currentUser; }

  private onStateChange(state: MirroredPlayerState, previous: MirroredPlayerState) {
    if (!this.enabled(state) || state.currentUser?.id !== previous.currentUser?.id) {
      // Off, or signed out or in as someone else: let go of everything.
      if (this.grant || this.sessionId) this.release();
      this.sessionId = null;
      this.displaced = false;
      if (!this.enabled(state)) return;
    }
    if (!this.grant) {
      const startedPlaying = state.playbackState === 'playing' && previous.playbackState !== 'playing';
      const switchedOn = !previous.syncPlaybackAcrossDevices && state.playbackState === 'playing';
      if ((startedPlaying || switchedOn) && !this.displaced) void this.claim();
      return;
    }
    if (state.castConnected !== previous.castConnected) {
      // The output moved between this browser and a Cast device: claim again
      // under the new kind and name (or let a receiver go), once casting has
      // settled.
      this.scheduleKindCheck();
      return;
    }
    if (state.playlist !== previous.playlist || state.repeat !== previous.repeat || state.shuffle !== previous.shuffle
      || state.isInfinityMode !== previous.isInfinityMode) {
      this.scheduleFlush(FLUSH_DELAY_MS);
    }
    if (state.playbackState !== previous.playbackState || state.isBuffering !== previous.isBuffering || state.currentIndex !== previous.currentIndex) {
      this.reportSoon();
    }
  }

  private release() {
    for (const timer of [this.flushTimer, this.reportTimer, this.refreshTimer, this.kindTimer]) if (timer) clearTimeout(timer);
    this.flushTimer = this.reportTimer = this.refreshTimer = this.kindTimer = null;
    this.setReceiverFollowing(false);
    this.grant = null;
    this.session = null;
    this.dirty = false;
    this.failedPatch = null;
  }

  /**
   * Sync was turned off on the server (by the admin, or by this user on
   * another device) before this device heard: stop, and let the store
   * re-read the setting instead of retrying.
   */
  private syncDisabled(error: unknown): boolean {
    if (!(error instanceof AuroraApiError) || error.code !== 'PLAYBACK_SYNC_DISABLED') return false;
    this.log('playback sync is off for this account');
    this.options?.diagnostic?.('warn', 'sync-disabled-by-server');
    this.release();
    this.sessionId = null;
    this.options?.onSyncDisabled?.();
    return true;
  }

  private onDisplaced(replacement: ReplacingOutput | null = null) {
    this.log('another device is playing this session now');
    this.options?.diagnostic?.('ok', 'sync-replaced',
      `by=${replacement ? `${replacement.kind}:${replacement.name ?? 'unnamed'}` : 'unknown'} wasPlaying=${this.store?.getState().playbackState === 'playing'}`);
    this.release();
    this.displaced = true;
    if (this.claimRetryTimer) clearTimeout(this.claimRetryTimer);
    this.claimRetryTimer = null;
    this.options?.onDisplaced?.(replacement);
  }

  private claim(): Promise<void> {
    if (this.claiming) return this.claiming;
    if (this.options?.canClaim && !this.options.canClaim()) {
      this.options.diagnostic?.('ok', 'sync-claim-skipped', 'reason=leaving-joined-cast-session');
      return Promise.resolve();
    }
    this.claiming = (async () => {
      const state = this.store!.getState();
      const auth = state.getAuthHeader();
      try {
        let sessionId = this.sessionId;
        if (!sessionId) {
          const [latest] = await this.api.listPlaybackSessions(auth);
          sessionId = latest?.id ?? (await this.api.createPlaybackSession(auth, SESSION_NAME)).id;
        }
        const castSessionId = state.castConnected ? this.options!.getCastSessionId?.() || undefined : undefined;
        const kind: OutputKind = !state.castConnected ? 'browser' : this.claimsForReceiver(castSessionId) ? 'receiver' : 'cast';
        const { session, credential } = await this.api.claimPlaybackOutput(auth, sessionId, {
          kind,
          name: this.options!.getOutputName().slice(0, 120) || undefined,
          ...(castSessionId ? { castSessionId } : {}),
        });
        // Settings may have changed while the claim was on its way.
        if (!this.enabled(this.store!.getState())) return;
        this.release();
        this.options?.diagnostic?.('ok', 'sync-claimed',
          `kind=${kind} generation=${credential.generation} castSession=${castSessionId || 'none'} state=${this.store!.getState().playbackState}`);
        this.sessionId = sessionId;
        this.grant = { sessionId, credential, seq: 0, kind };
        // Casting started or stopped while the claim was on its way.
        if (!this.kindMatchesCasting(kind)) this.scheduleKindCheck();
        this.session = session;
        this.displaced = false;
        this.scheduleRefresh();
        // Not awaited: the receiver's answer may take seconds, and a failed
        // handover claims again, which must wait for this claim to end.
        if (kind === 'receiver') void this.handOver('claim', castSessionId!);
        await this.flush();
        await this.report();
      } catch (error) {
        if (this.syncDisabled(error)) return;
        if (error instanceof AuroraApiError && error.code === 'PLAYBACK_SESSION_NOT_FOUND') this.sessionId = null;
        this.log('claim failed', error);
        this.options?.diagnostic?.('warn', 'sync-claim-failed', error instanceof AuroraApiError ? `code=${error.code}` : 'network');
        this.retryClaimLater();
      }
    })().finally(() => { this.claiming = null; });
    return this.claiming;
  }

  private setReceiverFollowing(following: boolean) {
    if (this.receiverFollowing === following) return;
    this.receiverFollowing = following;
    this.options?.diagnostic?.('ok', 'sync-receiver-follows', `following=${following}`);
    this.options?.onReceiverFollowsChanged?.(following);
  }

  private claimsForReceiver(castSessionId: string | undefined): boolean {
    return !!castSessionId && !!this.options?.handOverToReceiver && !!this.options.receiverCanFollow?.()
      && castSessionId !== this.receiverRefusedCastSession;
  }

  /**
   * Gives the receiver the session and its current credential. A receiver
   * that does not take it right after the claim is left as it is today: this
   * device claims again as a `cast` output, and keeps reporting for it.
   */
  private async handOver(reason: 'claim' | 'refresh', castSessionId?: string): Promise<void> {
    if (this.claiming) await this.claiming.catch(() => undefined);
    const grant = this.grant;
    if (!grant || grant.kind !== 'receiver' || !this.options?.handOverToReceiver) return;
    const { credential } = grant;
    const taken = await this.options.handOverToReceiver({
      sessionId: grant.sessionId,
      outputId: credential.outputId,
      generation: credential.generation,
      token: credential.token,
      expiresAt: credential.expiresAt,
      ...(credential.renewableUntil ? { renewableUntil: credential.renewableUntil } : {}),
    }, reason).catch(() => false);
    if (taken && this.grant === grant) this.setReceiverFollowing(true);
    if (taken || this.grant !== grant || reason !== 'claim') return;
    this.options.diagnostic?.('warn', 'sync-receiver-handover-failed', `generation=${credential.generation}`);
    this.receiverRefusedCastSession = castSessionId ?? null;
    if (this.store?.getState().castConnected) void this.claim();
  }

  /** A `cast` or `receiver` output while casting, a `browser` one otherwise. */
  private kindMatchesCasting(kind: OutputKind): boolean {
    return this.store?.getState().castConnected ? kind !== 'browser' : kind === 'browser';
  }

  /**
   * Once casting has settled, claims again if the grant names the wrong kind
   * by then; a receiver output this device stopped casting to is let go.
   */
  private scheduleKindCheck() {
    if (this.kindTimer) clearTimeout(this.kindTimer);
    this.kindTimer = setTimeout(() => {
      this.kindTimer = null;
      const state = this.store?.getState();
      if (!state || !this.enabled(state) || !this.grant || this.kindMatchesCasting(this.grant.kind)) return;
      if (this.grant.kind === 'receiver') {
        // The receiver plays on by itself (this device left), or stopped with
        // its Cast session. Either way it is not this device's to report:
        // only playing here makes this device the output again.
        this.options?.diagnostic?.('ok', 'sync-receiver-left', `state=${state.playbackState}`);
        this.release();
        if (state.playbackState === 'playing') void this.claim();
        return;
      }
      void this.claim();
    }, CAST_KIND_SETTLE_MS);
  }

  // Still playing here after a failed claim (offline for a moment): try again.
  private retryClaimLater() {
    if (this.claimRetryTimer) clearTimeout(this.claimRetryTimer);
    this.claimRetryTimer = setTimeout(() => {
      this.claimRetryTimer = null;
      const state = this.store?.getState();
      if (state && this.enabled(state) && !this.grant && !this.displaced && state.playbackState === 'playing') void this.claim();
    }, CLAIM_RETRY_DELAY_MS);
  }

  private scheduleFlush(delayMs: number) {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delayMs);
  }

  /** Brings the session's queue, repeat and shuffle in line with this device. */
  async flush(): Promise<void> {
    if (!this.grant || !this.session || !this.store) return;
    if (this.patching) {
      this.dirty = true;
      return;
    }
    const state = this.store.getState();
    const local = entriesOf(state.playlist);
    // A queue still keyed for a rejoinable Cast session, too long for a
    // session, or holding a track the server does not have, is not mirrored
    // until it changes.
    if (local.some((entry) => !isUuid(entry.entryId))) return;
    if (local.length > MAX_SESSION_QUEUE) return;
    if (local.some((entry) => this.blockedTrackIds.has(entry.trackId))) return;

    const operations = planSessionPatch(this.session, local, state.currentIndex, {
      repeatMode: state.repeat, shuffle: state.shuffle,
      ...(state.isInfinityMode !== undefined ? { infinity: state.isInfinityMode } : {}),
    });
    if (!operations.length) return;
    const patch = { expectedRevision: this.session.revision, operations };
    const body = JSON.stringify(patch);
    // A retry of a patch whose answer never arrived keeps its requestId, so
    // the server answers with the original result instead of a conflict.
    const requestId = this.failedPatch?.body === body ? this.failedPatch.requestId : createUuid();
    const { sessionId } = this.grant;
    const generation = this.grant.credential.generation;

    this.patching = true;
    try {
      let attempt: { expectedRevision: number; requestId: string } = { expectedRevision: patch.expectedRevision, requestId };
      let session: PlaybackSession;
      for (let rebase = 0; ; rebase += 1) {
        try {
          session = await this.api.patchPlaybackSession(state.getAuthHeader(), sessionId, { ...patch, ...attempt } as PlaybackSessionPatch);
          break;
        } catch (error) {
          // A newer change won: send the same edit again at its revision.
          const newer = currentSessionFromError(error);
          if (rebase < MAX_REBASES && newer && error instanceof AuroraApiError && error.code === 'REVISION_CONFLICT'
            && this.grant?.credential.generation === generation) {
            this.options?.diagnostic?.('ok', 'sync-edit-rebased', `revision=${newer.revision}`);
            attempt = { expectedRevision: newer.revision, requestId: createUuid() };
            continue;
          }
          throw error;
        }
      }
      if (this.grant?.credential.generation !== generation) return;
      this.session = session;
      this.failedPatch = null;
      // Rebased onto another device's change: show the merged queue here.
      const merged = session.queue.map((entry) => entry.queueEntryId).join(',');
      if (merged !== entriesOf(this.store.getState().playlist).map((entry) => entry.entryId).join(',')) {
        this.options?.adoptSession?.(session);
      }
      // A report may have named an entry the session did not have yet.
      const current = state.currentIndex !== null ? state.playlist[state.currentIndex]?.queueEntryId : null;
      if (current && session.currentEntryId !== current) this.reportSoon();
    } catch (error) {
      if (this.grant?.credential.generation !== generation) return;
      this.onPatchError(error, requestId, body);
    } finally {
      this.patching = false;
      if (this.dirty && this.grant) {
        this.dirty = false;
        this.scheduleFlush(0);
      }
    }
  }

  private onPatchError(error: unknown, requestId: string, body: string) {
    if (!(error instanceof AuroraApiError) || error.status >= 500) {
      this.failedPatch = { requestId, body };
      this.scheduleFlush(RETRY_DELAY_MS);
      return;
    }
    this.failedPatch = null;
    if (this.syncDisabled(error)) return;
    const current = currentSessionFromError(error);
    if ((UNAPPLIABLE_CODES.has(error.code) || error.code === 'REVISION_CONFLICT') && current) {
      // The session's queue counts: an edit that cannot apply to the newer
      // session (or kept losing to newer changes) is dropped, and the
      // session's queue is taken instead.
      this.log('a newer session change won over this edit; taking the session', error.code);
      this.options?.diagnostic?.('warn', 'sync-edit-dropped', `code=${error.code} revision=${current.revision}`);
      this.session = current;
      this.dirty = false;
      this.options?.adoptSession?.(current);
      return;
    }
    if (error.code === 'TRACKS_UNAVAILABLE') {
      const missing = (error.details as { missingIds?: string[] } | undefined)?.missingIds ?? [];
      missing.forEach((id) => this.blockedTrackIds.add(id));
      this.log('the queue has tracks the server does not know; not mirroring it', missing);
      return;
    }
    if (error.code === 'PLAYBACK_SESSION_NOT_FOUND') {
      // Deleted elsewhere. The next Play starts a new one.
      this.release();
      this.sessionId = null;
      return;
    }
    if (error.code === 'IDEMPOTENCY_KEY_REUSED') {
      this.dirty = true;
      return;
    }
    this.log('patch refused', error);
  }

  private reportSoon() {
    if (!this.grant || this.grant.kind === 'receiver') return;
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => void this.report(), REPORT_SOON_MS);
  }

  /** Tells the server what this output plays, and schedules the next heartbeat. */
  async report(): Promise<void> {
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = null;
    const grant = this.grant;
    // A receiver output reports for itself.
    if (!grant || grant.kind === 'receiver' || !this.store) return;
    const state = this.store.getState();
    const entryId = state.currentIndex !== null ? state.playlist[state.currentIndex]?.queueEntryId : undefined;
    const report: PlaybackOutputReport = {
      seq: ++grant.seq,
      state: state.isBuffering && state.playbackState !== 'stopped' ? 'buffering' : state.playbackState,
      queueEntryId: entryId && isUuid(entryId) ? entryId : null,
      positionMs: Math.max(0, Math.round((this.options!.getPositionSeconds() || 0) * 1000)),
    };
    try {
      await this.api.reportPlaybackOutput(grant.credential, grant.sessionId, report);
    } catch (error) {
      if (this.grant !== grant) return;
      if (error instanceof AuroraApiError && error.code === 'OUTPUT_GRANT_REPLACED') {
        this.onDisplaced(currentSessionFromError(error)?.output ?? null);
        return;
      }
      if (this.syncDisabled(error)) return;
      // An expired credential (a laptop that slept): renew it now.
      if (error instanceof AuroraApiError && error.status === 401) void this.refresh();
    }
    if (this.grant !== grant) return;
    const interval = report.state === 'stopped' ? null
      : report.state === 'paused' ? REPORT_INTERVAL_PAUSED_MS : REPORT_INTERVAL_PLAYING_MS;
    if (interval !== null && !this.reportTimer) this.reportTimer = setTimeout(() => void this.report(), interval);
  }

  private scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const grant = this.grant;
    if (!grant) return;
    const delay = Math.max(0, Date.parse(grant.credential.expiresAt) - Date.now() - REFRESH_BEFORE_EXPIRY_MS);
    this.refreshTimer = setTimeout(() => void this.refresh(), delay);
  }

  private async refresh(): Promise<void> {
    const grant = this.grant;
    if (!grant || !this.store) return;
    try {
      const credential = await this.api.refreshOutputCredential(this.store.getState().getAuthHeader(), grant.sessionId, {
        outputId: grant.credential.outputId,
        generation: grant.credential.generation,
      });
      if (this.grant !== grant) return;
      grant.credential = credential;
      this.scheduleRefresh();
      if (grant.kind === 'receiver') void this.handOver('refresh');
    } catch (error) {
      if (this.grant !== grant) return;
      if (error instanceof AuroraApiError && error.code === 'OUTPUT_GRANT_REPLACED') {
        this.onDisplaced(currentSessionFromError(error)?.output ?? null);
        return;
      }
      this.refreshTimer = setTimeout(() => void this.refresh(), 60_000);
    }
  }
}

export const sessionMirror = new SessionMirror();
