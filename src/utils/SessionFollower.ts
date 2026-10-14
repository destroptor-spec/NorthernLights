import type { PlaybackSession } from '../../shared/api/v1';
import * as sessionApi from '../api/playbackSessions';
import type { TrackInfo } from './fileSystem';
import { FOLLOW_STALE_MS, followFromSession, followedPositionMs, isFollowedOutputPlaying, type FollowedOutput } from './sessionFollow';

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
  api?: Pick<typeof sessionApi, 'listPlaybackSessions' | 'getPlaybackSession'>;
  createEventSource?: (url: string) => EventSourceLike;
  /** This device's client ID, as the server knows it (X-Aurora-Client-Id). */
  clientId: () => string;
  mirror: { holdsOutput: () => boolean; noteReplaced: (sessionId: string, generation: number) => Promise<void> };
  /** The session's queue as playable tracks, keeping each entry's ID. */
  toTracks: (session: PlaybackSession) => TrackInfo[];
  setPlaybackTime: (currentTime: number, duration: number) => void;
  log?: (message: string, detail?: unknown) => void;
}

const EVENTS_PATH = '/api/v1/events';
const RECONNECT_DELAY_MS = 15_000;
const TICK_MS = 1_000;
const EVENT_SOURCE_CLOSED = 2;
const SESSION_EVENTS = [
  'playbackSession.created',
  'playbackSession.updated',
  'playbackSession.handedOff',
  'playbackSession.deleted',
  'playbackSession.progress',
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
  private fetching = false;
  private refetch: string | null = null;
  private rendering = false;

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
    const state = this.store?.getState();
    if (state?.sessionFollow) state.setSessionFollow(null);
  }

  private connect(token: string) {
    const create = this.options!.createEventSource ?? ((url: string) => new EventSource(url) as EventSourceLike);
    const source = create(`${EVENTS_PATH}?token=${encodeURIComponent(token)}`);
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
        if (data.outputId !== myId) await this.noteClaim(sessionId, generation);
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
  private async noteClaim(sessionId: string, generation: number) {
    if (!Number.isFinite(generation) || generation <= (this.generations.get(sessionId) ?? 0)) return;
    this.generations.set(sessionId, generation);
    await this.options!.mirror.noteReplaced(sessionId, generation);
  }

  private onProgress(data: ProgressData, myId: string) {
    if (!data?.sessionId || data.outputId === myId || !data.report) return;
    const follow = this.follow;
    if (!follow || this.session?.id !== data.sessionId || follow.generation !== data.generation
      || data.revision > (this.session?.revision ?? 0)) {
      // A device or grant we don't know yet, or a session that changed: read it.
      if (data.generation >= (this.generations.get(data.sessionId) ?? 0)) this.fetchSession(data.sessionId);
      return;
    }
    this.follow = {
      ...follow,
      state: data.report.state,
      entryId: data.report.queueEntryId,
      positionMs: data.report.positionMs,
      anchorMs: Date.now(),
    };
    this.render();
  }

  private async refresh(initial: boolean) {
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
      this.log('could not read the playback session', error);
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
        this.log('could not read the playback session', error);
      } finally {
        this.fetching = false;
        const next = this.refetch;
        this.refetch = null;
        if (next && this.source) this.fetchSession(next);
      }
    })();
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
        await this.noteClaim(session.id, output.generation);
      }
    }
    this.session = session;
    this.follow = followFromSession(session, this.options!.clientId(), Date.now());
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
