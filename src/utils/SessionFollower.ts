import type { PlaybackCommand, PlaybackSession } from '../../shared/api/v1';
import { AuroraApiError } from '../api/auroraApi';
import * as sessionApi from '../api/playbackSessions';
import { currentSessionFromError } from '../api/playbackSessions';
import type { TrackInfo } from './fileSystem';
import { MAX_SESSION_QUEUE, planQueueOperations } from './sessionQueueDiff';
import { createUuid, isUuid } from './uuid';
import { FOLLOW_STALE_MS, followFromSession, followedPositionMs, isCastOutput, isFollowedOutputPlaying, type FollowedOutput } from './sessionFollow';

// The following side of "Sync playback across devices" (docs/playback_sessions.md,
// Phase 2). While another device plays the user's session, an idle device
// listens to /api/v1/events: it takes over the session's queue silently, shows
// the current track with live progress and "Playing on <device>", and Play
// continues from there. When another device claims the output while this one
// plays, the mirror is told, and this device stops (one device at a time).
//
// A device that plays, holds the output or is casting never follows: its own
// queue is the session's (SessionMirror), and a Cast receiver's queue is never
// replaced from here.
//
// Following a receiver that plays the session itself (Phase 5,
// docs/cast-receiver-output.md), the queue edits made here (Play next, remove,
// reorder) go to the session, where the receiver picks them up. Other outputs
// keep their own queue, so there edits stay on this device.

export interface FollowerPlayerState {
  syncPlaybackAcrossDevices: boolean;
  currentUser: { id: string } | null;
  authToken: string | null;
  sseAccessToken: string | null;
  playlist: TrackInfo[];
  currentIndex: number | null;
  playbackState: 'playing' | 'paused' | 'stopped';
  castConnected: boolean;
  sessionFollow: FollowedOutput | null;
  getAuthHeader: () => Record<string, string>;
  adoptSessionQueue: (tracks: TrackInfo[] | null, index: number, positionSeconds: number) => void;
  setSessionFollow: (follow: FollowedOutput | null) => void;
}

export interface FollowerStore {
  getState: () => FollowerPlayerState;
  subscribe: (listener: (state: FollowerPlayerState, previous: FollowerPlayerState) => void) => () => void;
}

export interface EventSourceLike {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void;
  close: () => void;
}

export interface SessionFollowerOptions {
  api?: Pick<typeof sessionApi, 'listPlaybackSessions' | 'getPlaybackSession' | 'patchPlaybackSession'>;
  createEventSource?: (url: string) => EventSourceLike;
  /** This device's client ID, as the server knows it (X-Aurora-Client-Id). */
  clientId: () => string;
  mirror: {
    holdsOutput: () => boolean;
    currentGrant: () => { sessionId: string; outputId: string; generation: number } | null;
    noteReplaced: (sessionId: string, generation: number, replacement: { kind: string; name: string | null } | null) => Promise<void>;
    /** True when this device, the session's output, should take `session`'s queue. */
    noteSessionChanged?: (session: PlaybackSession) => boolean;
  };
  /**
   * This device is the session's output (it plays, or casts) and the
   * session's queue changed (another device's edit, or a server Infinity
   * append): take it in here, keeping what plays (Phase 3).
   */
  adoptPlayingQueue?: (session: PlaybackSession) => void;
  /** The session's queue as playable tracks, keeping each entry's ID. */
  toTracks: (session: PlaybackSession) => TrackInfo[];
  setPlaybackTime: (currentTime: number, duration: number) => void;
  /**
   * The server says whether the session API works for this account now
   * (`playbackSync.changed`), or refused a call with PLAYBACK_SYNC_DISABLED.
   */
  onPlaybackSyncChanged?: (enabled: boolean) => void;
  /** A remote command for the grant this device holds (`playbackSession.command`). */
  onCommand?: (sessionId: string, command: PlaybackCommand) => void;
  log?: (message: string, detail?: unknown) => void;
  /** Server-side diagnostics (`sync-…` markers in the Cast log). */
  diagnostic?: (level: 'ok' | 'warn' | 'error', marker: string, detail?: string) => void;
}

const EVENTS_PATH = '/api/v1/events';
const RECONNECT_DELAY_MS = 15_000;
/** Edits made in quick succession (a drag) go as one patch. */
const QUEUE_EDIT_DELAY_MS = 250;
const TICK_MS = 1_000;
const EVENT_SOURCE_CLOSED = 2;
const SESSION_EVENTS = [
  'playbackSession.created',
  'playbackSession.updated',
  'playbackSession.handedOff',
  'playbackSession.deleted',
  'playbackSession.progress',
  'playbackSession.command',
  'playbackSync.changed',
  'resync.required',
] as const;

interface ProgressData {
  sessionId: string;
  revision: number;
  outputId: string;
  generation: number;
  report: { state: FollowedOutput['state']; queueEntryId: string | null; positionMs: number };
}

const sameEntries = (playlist: TrackInfo[], session: PlaybackSession) =>
  playlist.length === session.queue.length
  && session.queue.every((entry, index) => playlist[index]?.queueEntryId === entry.queueEntryId);

export class SessionFollower {
  private store: FollowerStore | null = null;
  private options: SessionFollowerOptions | null = null;
  private unsubscribe: (() => void) | null = null;
  private source: EventSourceLike | null = null;
  private connectionKey: string | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;

  private session: PlaybackSession | null = null;
  private follow: FollowedOutput | null = null;
  /** The newest output grant seen per session; an older one is old news. */
  private readonly generations = new Map<string, number>();
  private readonly heardAt = new Map<string, number>();
  /** Settles when the first session read after connecting is done. */
  private firstRead: Promise<void> | null = null;
  private resolveFirstRead: (() => void) | null = null;
  private fetching = false;
  private refetch: string | null = null;
  private rendering = false;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private editing = false;
  private editAgain = false;

  /**
   * Another of the user's devices is casting to the Cast device with this
   * name right now (the session's output). Picking that device in this
   * device's Cast dialog would join its Cast session as a second sender.
   */
  castingElsewhere(castDeviceName: string, castSessionId: string | null): { outputId: string } | null {
    const output = this.session?.output;
    if (!output || !this.options || output.id === this.options.clientId()) return null;
    // A receiver output this device claimed is its own Cast session (a
    // reload or recovery rejoining it), not another device's.
    if (output.kind === 'receiver' && this.session!.ownerClientId === this.options.clientId()) return null;
    if (!isCastOutput(output) || output.status !== 'active' || output.name !== castDeviceName) return null;
    // Only the very Cast session it sends to: picking the device may also
    // start a new session, which ends the other device's (prod 2026-10-13
    // 22:16:20: the phone left a session it had just started).
    if (!castSessionId || output.castSessionId !== castSessionId) return null;
    return { outputId: output.id };
  }

  /**
   * Resolves once the session has been read after connecting, or at once
   * when there is no stream, or after `timeoutMs` at the latest.
   */
  ready(timeoutMs: number): Promise<void> {
    if (!this.source || this.firstRead === null) return Promise.resolve();
    return Promise.race([this.firstRead, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  /** Another of the user's devices plays the session right now (or casts to a silent Cast device). */
  anotherDevicePlaying(): boolean {
    const output = this.session?.output;
    if (!output || !this.options || output.id === this.options.clientId()) return false;
    return output.status === 'active' || (output.status === 'unreachable' && isCastOutput(output));
  }

  /** When this device last heard a report from `outputId` (local clock), or 0. */
  lastHeardFrom(outputId: string): number {
    return this.heardAt.get(outputId) ?? 0;
  }

  /** The session's revision as this device last read it, for a remote queue change. */
  sessionRevision(): number | null {
    return this.session?.revision ?? null;
  }

  start(store: FollowerStore, options: SessionFollowerOptions): void {
    this.stop();
    this.store = store;
    this.options = options;
    this.unsubscribe = store.subscribe((state, previous) => this.onStateChange(state, previous));
    this.syncConnection();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.disconnect();
  }

  private get api() { return this.options?.api ?? sessionApi; }
  private log(message: string, detail?: unknown) { this.options?.log?.(`[SessionFollower] ${message}`, detail); }

  /**
   * The event stream only ever gets the scoped `sse` token. A store that has
   * none falls back to the full session token for older streams; that one is
   * never put in this URL (docs/playback_sessions.md, Security).
   */
  private desiredConnection(state: FollowerPlayerState): string | null {
    if (!state.syncPlaybackAcrossDevices || !state.currentUser) return null;
    const token = state.sseAccessToken;
    if (!token || token === state.authToken) return null;
    return `${state.currentUser.id}\n${token}`;
  }

  private onStateChange(state: FollowerPlayerState, previous: FollowerPlayerState) {
    if (state.syncPlaybackAcrossDevices !== previous.syncPlaybackAcrossDevices
      || state.currentUser?.id !== previous.currentUser?.id
      || state.sseAccessToken !== previous.sseAccessToken
      || state.authToken !== previous.authToken) {
      this.syncConnection();
      return;
    }
    if (state.playbackState !== previous.playbackState || state.castConnected !== previous.castConnected) {
      this.render();
    }
    // An edit made here, not this follower taking the session's queue.
    if (state.playlist !== previous.playlist && !this.rendering && this.editsGoToSession(state)) this.scheduleQueueEdit();
  }

  /** Following a receiver that plays the session itself, from an idle device. */
  private editsGoToSession(state: FollowerPlayerState): boolean {
    return !!this.session && this.follow?.kind === 'receiver' && !this.busy(state);
  }

  private scheduleQueueEdit() {
    if (this.editTimer) clearTimeout(this.editTimer);
    this.editTimer = setTimeout(() => {
      this.editTimer = null;
      void this.sendQueueEdit();
    }, QUEUE_EDIT_DELAY_MS);
  }

  /**
   * Sends this device's queue, as anchored edits on the session it last
   * read. When a newer change won meanwhile, the same edits are sent once
   * more at its revision (anchors still mean the same thing there); an edit
   * that cannot apply any more leaves the session's queue shown here.
   */
  private async sendQueueEdit(): Promise<void> {
    if (this.editing) {
      this.editAgain = true;
      return;
    }
    const state = this.store?.getState();
    const session = this.session;
    if (!state || !session || !this.editsGoToSession(state)) return;
    const local = state.playlist.map((track) => ({ entryId: track.queueEntryId || '', trackId: track.id }));
    // Clearing the queue here does not stop the receiver.
    if (!local.length || local.length > MAX_SESSION_QUEUE || local.some((entry) => !isUuid(entry.entryId))) return;
    const server = session.queue.map((entry) => ({ entryId: entry.queueEntryId, trackId: entry.track.id }));
    const operations = planQueueOperations(server, local, null, session.currentEntryId);
    if (!operations.length) return;
    this.editing = true;
    try {
      let expectedRevision = session.revision;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const updated = await this.api.patchPlaybackSession(state.getAuthHeader(), session.id, {
            expectedRevision, requestId: createUuid(), operations,
          } as Parameters<typeof sessionApi.patchPlaybackSession>[2]);
          this.options!.diagnostic?.('ok', 'sync-queue-edit-sent', `operations=${operations.length} revision=${updated.revision}`);
          if (this.session?.id === updated.id && updated.revision > this.session.revision) this.session = updated;
          return;
        } catch (error) {
          const current = currentSessionFromError(error);
          if (attempt === 0 && current && error instanceof AuroraApiError && error.code === 'REVISION_CONFLICT') {
            expectedRevision = current.revision;
            continue;
          }
          this.options!.diagnostic?.('warn', 'sync-queue-edit-refused', `code=${error instanceof AuroraApiError ? error.code : 'network'}`);
          if (current) await this.apply(current, false);
          else this.fetchSession(session.id);
          return;
        }
      }
    } finally {
      this.editing = false;
      if (this.editAgain) {
        this.editAgain = false;
        this.scheduleQueueEdit();
      }
    }
  }

  private syncConnection() {
    const state = this.store!.getState();
    const key = this.desiredConnection(state);
    if (key === this.connectionKey && (key === null || this.source)) return;
    this.disconnect();
    if (!key) return;
    this.connectionKey = key;
    this.connect(state.sseAccessToken!);
  }

  private disconnect() {
    this.source?.close();
    this.source = null;
    this.connectionKey = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopTicker();
    this.session = null;
    this.follow = null;
    this.generations.clear();
    this.resolveFirstRead?.();
    this.resolveFirstRead = null;
    this.firstRead = null;
    const state = this.store?.getState();
    if (state?.sessionFollow) state.setSessionFollow(null);
  }

  private connect(token: string) {
    const create = this.options!.createEventSource ?? ((url: string) => new EventSource(url) as EventSourceLike);
    // The client ID tells the server this device can hear remote commands.
    this.firstRead = new Promise<void>((resolve) => { this.resolveFirstRead = resolve; });
    const source = create(`${EVENTS_PATH}?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(this.options!.clientId())}`);
    this.source = source;
    let opened = false;
    source.onopen = () => {
      // The browser reconnects by itself and resumes from the last event; the
      // server answers resync.required when it can't. Only the first open
      // reads the session from scratch.
      if (opened) return;
      opened = true;
      void this.refresh(true);
    };
    source.onerror = () => {
      if (this.source !== source || source.readyState !== EVENT_SOURCE_CLOSED) return;
      // Closed for good (a refused or expired token, a server restart): start
      // over a little later, with whatever token the store has by then.
      this.source = null;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connectionKey = null;
        this.syncConnection();
      }, RECONNECT_DELAY_MS);
    };
    for (const type of SESSION_EVENTS) {
      source.addEventListener(type, (event) => {
        if (this.source !== source) return;
        let data: Record<string, unknown> = {};
        try {
          data = (JSON.parse(event.data) as { data?: Record<string, unknown> }).data ?? {};
        } catch {
          return;
        }
        void this.onEvent(type, data);
      });
    }
  }

  private async onEvent(type: typeof SESSION_EVENTS[number], data: Record<string, unknown>) {
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
    const myId = this.options!.clientId();
    switch (type) {
      case 'resync.required':
        await this.refresh(false);
        return;
      case 'playbackSession.command': {
        // Only for this device, and only for the grant it holds now: a
        // command meant for an earlier claim is not acted on.
        const grant = this.options!.mirror.currentGrant();
        const command = data.command as PlaybackCommand | undefined;
        if (!grant || !sessionId || !command || data.outputId !== myId
          || grant.sessionId !== sessionId || grant.generation !== Number(data.generation)) return;
        this.options!.diagnostic?.('ok', 'sync-command-received', `type=${command.type} from=${String(data.issuedBy ?? 'unknown')}`);
        this.options!.onCommand?.(sessionId, command);
        return;
      }
      case 'playbackSync.changed':
        this.options!.onPlaybackSyncChanged?.(data.enabled === true);
        return;
      case 'playbackSession.deleted':
        if (sessionId && this.session?.id === sessionId) {
          this.session = null;
          this.follow = null;
          this.render();
        }
        return;
      case 'playbackSession.handedOff': {
        if (!sessionId) return;
        const generation = Number(data.generation);
        const replacement = typeof data.outputKind === 'string'
          ? { kind: data.outputKind, name: typeof data.outputName === 'string' ? data.outputName : null }
          : null;
        if (data.outputId !== myId) await this.noteClaim(sessionId, generation, replacement);
        this.fetchSession(sessionId);
        return;
      }
      case 'playbackSession.progress':
        this.onProgress(data as unknown as ProgressData, myId);
        return;
      default: {
        // created / updated: read the session when it is news.
        const revision = Number(data.revision);
        if (sessionId && (this.session?.id !== sessionId || !(revision <= this.session.revision))) this.fetchSession(sessionId);
      }
    }
  }

  /** Another device claimed `sessionId`'s output at `generation`. */
  private async noteClaim(sessionId: string, generation: number, replacement: { kind: string; name: string | null } | null) {
    if (!Number.isFinite(generation) || generation <= (this.generations.get(sessionId) ?? 0)) return;
    this.generations.set(sessionId, generation);
    await this.options!.mirror.noteReplaced(sessionId, generation, replacement);
  }

  private onProgress(data: ProgressData, myId: string) {
    if (!data?.sessionId || data.outputId === myId || !data.report) return;
    this.heardAt.set(data.outputId, Date.now());
    const follow = this.follow;
    if (!follow || this.session?.id !== data.sessionId || follow.generation !== data.generation
      || data.revision > (this.session?.revision ?? 0)) {
      // A device or grant we don't know yet, or a session that changed: read it.
      if (data.generation >= (this.generations.get(data.sessionId) ?? 0)) this.fetchSession(data.sessionId);
      return;
    }
    this.follow = {
      ...follow,
      silent: false,
      state: data.report.state,
      entryId: data.report.queueEntryId,
      positionMs: data.report.positionMs,
      anchorMs: Date.now(),
    };
    this.render();
  }

  private async refresh(initial: boolean) {
    try {
      await this.readLatest(initial);
    } finally {
      if (initial) {
        this.resolveFirstRead?.();
        this.resolveFirstRead = null;
      }
    }
  }

  private async readLatest(initial: boolean) {
    const state = this.store?.getState();
    if (!state) return;
    try {
      const [latest] = await this.api.listPlaybackSessions(state.getAuthHeader());
      if (!this.source) return;
      if (!latest) {
        this.session = null;
        this.follow = null;
        this.render();
        return;
      }
      await this.apply(latest, initial);
    } catch (error) {
      this.onError(error);
    }
  }

  private fetchSession(sessionId: string) {
    if (this.fetching) {
      this.refetch = sessionId;
      return;
    }
    this.fetching = true;
    void (async () => {
      try {
        const session = await this.api.getPlaybackSession(this.store!.getState().getAuthHeader(), sessionId);
        if (this.source) await this.apply(session, false);
      } catch (error) {
        this.onError(error);
      } finally {
        this.fetching = false;
        const next = this.refetch;
        this.refetch = null;
        if (next && this.source) this.fetchSession(next);
      }
    })();
  }

  private onError(error: unknown) {
    if (error instanceof AuroraApiError && error.code === 'PLAYBACK_SYNC_DISABLED') {
      this.options!.onPlaybackSyncChanged?.(false);
      return;
    }
    this.log('could not read the playback session', error);
  }

  private async apply(session: PlaybackSession, initial: boolean) {
    const output = session.output;
    if (output && output.id !== this.options!.clientId()) {
      if (initial) {
        // What was already true when this device connected is not a claim
        // against it.
        this.generations.set(session.id, Math.max(this.generations.get(session.id) ?? 0, output.generation));
      } else {
        // A claim whose event this device missed, or read before its event arrived.
        await this.noteClaim(session.id, output.generation, { kind: output.kind, name: output.name });
      }
    }
    this.session = session;
    if (this.options!.mirror.noteSessionChanged?.(session)) {
      this.options!.diagnostic?.('ok', 'sync-queue-adopted', `revision=${session.revision} entries=${session.queue.length}`);
      this.options!.adoptPlayingQueue?.(session);
    }
    const previous = this.follow;
    this.follow = followFromSession(session, this.options!.clientId(), Date.now());
    const describe = (f: FollowedOutput | null) => (f ? `${f.kind}:${f.name}${f.silent ? ':silent' : ''}` : 'none');
    if (describe(previous) !== describe(this.follow)) {
      this.options!.diagnostic?.('ok', 'sync-follow', `output=${describe(this.follow)} was=${describe(previous)} status=${session.output?.status ?? 'none'}`);
    }
    this.render();
  }

  /** This device plays, is paused as the session's output, or is casting. */
  private busy(state: FollowerPlayerState) {
    return state.playbackState === 'playing' || state.castConnected || this.options!.mirror.holdsOutput();
  }

  private render() {
    if (this.rendering || !this.store) return;
    this.rendering = true;
    try {
      const state = this.store.getState();
      const session = this.session;
      if (!session || this.busy(state)) {
        this.stopTicker();
        if (state.sessionFollow) state.setSessionFollow(null);
        return;
      }
      if (session.queue.length) {
        const entryId = this.follow?.entryId ?? session.currentEntryId;
        const index = Math.max(0, session.queue.findIndex((entry) => entry.queueEntryId === entryId));
        const tracks = sameEntries(state.playlist, session) ? null : this.options!.toTracks(session);
        const duration = (tracks ?? state.playlist)[index]?.duration;
        const positionMs = this.follow && this.follow.entryId === session.queue[index].queueEntryId
          ? followedPositionMs(this.follow, Date.now(), duration)
          : session.positionMs;
        state.adoptSessionQueue(tracks, index, positionMs / 1000);
        this.options!.setPlaybackTime(positionMs / 1000, duration || 0);
      }
      this.store.getState().setSessionFollow(this.follow);
      if (isFollowedOutputPlaying(this.follow)) this.startTicker();
      else this.stopTicker();
    } finally {
      this.rendering = false;
    }
  }

  // Live progress on the idle device, carried forward between heartbeats.
  private startTicker() {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      const state = this.store?.getState();
      const follow = this.follow;
      if (!state || !follow || this.busy(state) || !isFollowedOutputPlaying(follow)) {
        this.stopTicker();
        return;
      }
      if (Date.now() - follow.anchorMs > FOLLOW_STALE_MS) {
        // No heartbeat for a while: the device may be gone.
        this.stopTicker();
        this.fetchSession(follow.sessionId);
        return;
      }
      const current = state.currentIndex !== null ? state.playlist[state.currentIndex] : undefined;
      if (!current || current.queueEntryId !== follow.entryId) return;
      this.options!.setPlaybackTime(followedPositionMs(follow, Date.now(), current.duration) / 1000, current.duration || 0);
    }, TICK_MS);
  }

  private stopTicker() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}

export const sessionFollower = new SessionFollower();
