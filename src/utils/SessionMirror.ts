import type { PlaybackOutputCredential, PlaybackOutputReport, PlaybackSession, PlaybackSessionPatch } from '../../shared/api/v1';
import { AuroraApiError } from '../api/auroraApi';
import * as sessionApi from '../api/playbackSessions';
import { currentSessionFromError } from '../api/playbackSessions';
import type { TrackInfo } from './fileSystem';
import { planSessionPatch, MAX_SESSION_QUEUE, type QueueEntryRef } from './sessionQueueDiff';
import { createUuid, isUuid } from './uuid';

// The playing side of "Sync playback across devices" (docs/playback_sessions.md,
// Phase 2). While this device plays, it holds the session's output: it mirrors
// its queue, repeat and shuffle into the user's one playback session, and
// reports what it plays. Its local queue is authoritative, so a conflict is
// answered by planning again from the session the server sent back.
//
// Following another device (adopting its queue, "Playing on …") is
// SessionFollower's job.

export interface MirroredPlayerState {
  syncPlaybackAcrossDevices: boolean;
  currentUser: { id: string } | null;
  playlist: TrackInfo[];
  currentIndex: number | null;
  repeat: PlaybackSession['repeatMode'];
  shuffle: boolean;
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
  log?: (message: string, detail?: unknown) => void;
  /**
   * Another device plays the session now: stop playing here (one device at a
   * time). `replacement` is the new output, when known, so a device that took
   * over the same Cast device this one casts to can be told apart.
   */
  onDisplaced?: (replacement: ReplacingOutput | null) => void;
  /** The server refused with PLAYBACK_SYNC_DISABLED: sync is off for this account. */
  onSyncDisabled?: () => void;
}

const SESSION_NAME = 'Listening';
export const REPORT_INTERVAL_PLAYING_MS = 10_000;
export const REPORT_INTERVAL_PAUSED_MS = 30_000;
const FLUSH_DELAY_MS = 250;
const REPORT_SOON_MS = 300;
const RETRY_DELAY_MS = 5_000;
const CLAIM_RETRY_DELAY_MS = 30_000;
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;
const MAX_CONFLICT_RETRIES = 3;
const CONFLICT_CODES = new Set(['REVISION_CONFLICT', 'ANCHOR_NOT_FOUND', 'ENTRY_ID_CONFLICT']);

interface Grant { sessionId: string; credential: PlaybackOutputCredential; seq: number }

/** The output that replaced this device: what kind of device, and its name. */
export interface ReplacingOutput { kind: string; name: string | null }

const entriesOf = (playlist: TrackInfo[]): QueueEntryRef[] =>
  playlist.map((track) => ({ entryId: track.queueEntryId || '', trackId: track.id }));

/**
 * Another device took over by casting to the very Cast device this one casts
 * to (both joined one Cast session, prod 2026-10-13 19:50). The music never
 * moved, so nothing stops here: pausing would pause the speaker for both.
 * Matched by the Cast device's name, which is what the claim carries.
 */
export function isSameCastDevice(replacement: ReplacingOutput | null, castConnected: boolean, castDeviceName: string | null | undefined): boolean {
  return !!replacement && castConnected && replacement.kind === 'cast'
    && !!replacement.name && !!castDeviceName && replacement.name === castDeviceName;
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
  private conflicts = 0;
  private failedPatch: { requestId: string; body: string } | null = null;
  private readonly blockedTrackIds = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private reportTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private claimRetryTimer: ReturnType<typeof setTimeout> | null = null;

  start(store: MirroredStore, options: SessionMirrorOptions): void {
    this.stop();
    this.store = store;
    this.options = options;
    this.unsubscribe = store.subscribe((state, previous) => this.onStateChange(state, previous));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
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

  /** This device is the session's output (playing or paused). */
  holdsOutput(): boolean {
    return !!this.grant;
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
      // under the new name.
      void this.claim();
      return;
    }
    if (state.playlist !== previous.playlist || state.repeat !== previous.repeat || state.shuffle !== previous.shuffle) {
      this.scheduleFlush(FLUSH_DELAY_MS);
    }
    if (state.playbackState !== previous.playbackState || state.isBuffering !== previous.isBuffering || state.currentIndex !== previous.currentIndex) {
      this.reportSoon();
    }
  }

  private release() {
    for (const timer of [this.flushTimer, this.reportTimer, this.refreshTimer]) if (timer) clearTimeout(timer);
    this.flushTimer = this.reportTimer = this.refreshTimer = null;
    this.grant = null;
    this.session = null;
    this.dirty = false;
    this.conflicts = 0;
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
    this.release();
    this.sessionId = null;
    this.options?.onSyncDisabled?.();
    return true;
  }

  private onDisplaced(replacement: ReplacingOutput | null = null) {
    this.log('another device is playing this session now');
    this.release();
    this.displaced = true;
    if (this.claimRetryTimer) clearTimeout(this.claimRetryTimer);
    this.claimRetryTimer = null;
    this.options?.onDisplaced?.(replacement);
  }

  private claim(): Promise<void> {
    if (this.claiming) return this.claiming;
    this.claiming = (async () => {
      const state = this.store!.getState();
      const auth = state.getAuthHeader();
      try {
        let sessionId = this.sessionId;
        if (!sessionId) {
          const [latest] = await this.api.listPlaybackSessions(auth);
          sessionId = latest?.id ?? (await this.api.createPlaybackSession(auth, SESSION_NAME)).id;
        }
        const { session, credential } = await this.api.claimPlaybackOutput(auth, sessionId, {
          kind: state.castConnected ? 'cast' : 'browser',
          name: this.options!.getOutputName().slice(0, 120) || undefined,
        });
        // Settings may have changed while the claim was on its way.
        if (!this.enabled(this.store!.getState())) return;
        this.release();
        this.sessionId = sessionId;
        this.grant = { sessionId, credential, seq: 0 };
        this.session = session;
        this.displaced = false;
        this.scheduleRefresh();
        await this.flush();
        await this.report();
      } catch (error) {
        if (this.syncDisabled(error)) return;
        if (error instanceof AuroraApiError && error.code === 'PLAYBACK_SESSION_NOT_FOUND') this.sessionId = null;
        this.log('claim failed', error);
        this.retryClaimLater();
      }
    })().finally(() => { this.claiming = null; });
    return this.claiming;
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

    const operations = planSessionPatch(this.session, local, state.currentIndex, { repeatMode: state.repeat, shuffle: state.shuffle });
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
      const session = await this.api.patchPlaybackSession(state.getAuthHeader(), sessionId, { ...patch, requestId } as PlaybackSessionPatch);
      if (this.grant?.credential.generation !== generation) return;
      this.session = session;
      this.failedPatch = null;
      this.conflicts = 0;
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
    if (CONFLICT_CODES.has(error.code) && current) {
      this.session = current;
      this.conflicts += 1;
      if (this.conflicts <= MAX_CONFLICT_RETRIES) this.dirty = true;
      else this.log('giving up on this change after repeated conflicts', error.code);
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
    if (!this.grant) return;
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => void this.report(), REPORT_SOON_MS);
  }

  /** Tells the server what this output plays, and schedules the next heartbeat. */
  async report(): Promise<void> {
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = null;
    const grant = this.grant;
    if (!grant || !this.store) return;
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
