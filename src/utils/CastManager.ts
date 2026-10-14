import { CastPlaybackConfirmation } from './castPlaybackConfirmation';
import {
    boundedQueueRequest, queueWindowEntries, castQueueCallback, CastQueueInsertAcks, planWindowEdit, applyWindowEdit, adoptableWindow,
    CAST_QUEUE_MAX_ITEMS, CAST_QUEUE_INSERT_MAX_ITEMS, CAST_QUEUE_LOW_WATER, CAST_QUEUE_KEEP_PREVIOUS,
    seedItemIds, streamKey, type CastWindowEdit, type StoredCastWindow,
} from './castQueueWindow';
import { getAuroraStatusNamespace } from './castNamespace';
import { CastDiagnosticsSync } from './castDiagnostics';
import { playbackManager } from './PlaybackManager';
import { usePlayerStore } from '../store';
import { getAuroraClientId } from '../api/auroraApi';
import { describeThisDevice } from './deviceName';
import { decideJoin, isOwnLeaveDisconnect } from './castJoinPolicy';
import {
    POSITION_TICK_MS,
    RECEIVER_MESSAGE_MAX_BYTES,
    RECEIVER_QUEUE_INSERT_CAP,
    REMOTE_PLAYER_STALE_MS,
    SEEK_STATUS_FRESH_MS,
    chooseTransportAction,
    decideSeek,
    interpolatePosition,
    isRemotePlayerStreamStale,
    pickRemotePosition,
    receiverControlAvailable,
    reconcileDuration,
    shouldReleaseRemoteMedia,
    toReceiverQueueItem,
    transportStateFromPlayerState,
} from './castWatchdogPolicy';
import { CAST_MEDIA_NAMESPACE, ReconcileBurst, probeCastTransport } from './castTransportRecovery';
import { applyCastStreamingQualityToHlsUrl, applyStreamingQualityToHlsUrl } from './streaming';
import { createQueueEntryId, ensureQueueEntryIds } from './queue';
import type { TrackInfo } from './fileSystem';
import { castEndSnapshot, shouldContinuePlayingAfterCast, type CastEndSnapshot } from './castEndHandoff';
import { getPlaybackTimeSnapshot } from '../store/playbackTime';
declare const chrome: any;
declare const cast: any;

const toast = {
    success: (msg: string) => usePlayerStore.getState().addToast(msg, 'success'),
    error: (msg: string) => usePlayerStore.getState().addToast(msg, 'error'),
    info: (msg: string) => usePlayerStore.getState().addToast(msg, 'info'),
};

export type CastState = 'NO_DEVICES_AVAILABLE' | 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED';

/**
 * Status the receiver pushes on `urn:x-cast:aurora.status`.
 *
 * The SDK's MEDIA_STATUS relay drops queue-item `customData`, so the sender
 * cannot see the `queueEntryId` it assigned and has to infer identity from a
 * URL. This channel carries it verbatim.
 */
export interface AuroraReceiverStatus {
  diagnosticsVerbose?: boolean;
  type?: string;
  reason?: string;
  queueEntryId?: string | null;
  contentId?: string | null;
  itemId?: number | null;
  currentItemIndex?: number;
  queueLength?: number;
  playerState?: string | null;
  currentTime?: number;
  duration?: number;
  /** Capabilities of the receiver build; 'control' means it accepts aurora.control. */
  caps?: string[];
  ts?: number;
}

export type CastHealthPhase = 'idle' | 'connected' | 'rejoining' | 'recovering' | 'recovered' | 'warning' | 'error';

export interface CastHealthStatus {
    phase: CastHealthPhase;
    message: string;
    detail?: string;
    updatedAt: number;
}

const SESSION_STORAGE_KEY = 'cast_session_id';
// The window's entry IDs, so a reloaded or recovered sender can adopt it.
const QUEUE_WINDOW_STORAGE_KEY = 'aurora-cast-queue-window-v1';
// A LOAD not acknowledged by then is treated as sent, never resent blindly.
const CAST_LOAD_ACK_TIMEOUT_MS = 12000;
// How long a media-channel jump may take to show up in aurora.status.
const CAST_MEDIA_CHANNEL_JUMP_TIMEOUT_MS = 3000;
// A live SDK answers a queue jump in well under a second.
const CAST_QUEUE_JUMP_ACK_TIMEOUT_MS = 3000;
// Receiver volume applied once when a FRESH session hands playback over (some
// receivers power on reporting 100% and would blast the first track). Never
// applied when joining or rejoining an ongoing session.
const FRESH_SESSION_STARTUP_VOLUME = 0.3;
const CUSTOM_RECEIVER_HLS_CODEC = 'aac';
type CastQueueTrack = Pick<TrackInfo, 'queueEntryId' | 'url' | 'rawUrl' | 'title' | 'artist' | 'artUrl' | 'album' | 'format' | 'duration'>;
type CastRepeat = 'none' | 'one' | 'all';
/**
 * The receiver's queue as this sender loaded it: `ids` mirrors the receiver's
 * items in order, including up to CAST_QUEUE_KEEP_PREVIOUS played entries.
 * `complete` means it reaches the end of the local queue, so appends are
 * delivered at once; `cafRepeat` is the repeat mode the receiver was given.
 */
type CastQueueWindow = {
    session: unknown; ids: string[]; repeat: CastRepeat; blocked: boolean; complete: boolean; cafRepeat: CastRepeat;
    /** Item IDs inferred from position (seedItemIds) and not yet confirmed by the receiver. */
    inferred: Set<string>;
    /** The ID CAF will give the next inserted item, once seeded; null until then. */
    nextItemId: number | null;
    /** Positional seeding is only valid until the window's order first changes. */
    seedable: boolean;
    /** Set after one contradiction; this window then uses observed IDs only. */
    inferenceOff: boolean;
    /** The media session ID of this window's LOAD, for QUEUE_UPDATE without an SDK Media object. */
    mediaSessionId?: number | null;
};

type CastLogLevel = 'ok' | 'warn' | 'error';

// Maps audio format strings (from music-metadata and file extensions) to MIME types.
// Keys must be lowercase. Covers: MPEG, FLAC, OGG, MP4/M4A, WAV/WAVE, WMA, AAC.
const FORMAT_MIME_MAP = new Map<string, string>([
    ['mp3', 'audio/mpeg'],
    ['mpeg', 'audio/mpeg'],
    ['flac', 'audio/flac'],
    ['ogg', 'audio/ogg'],
    ['m4a', 'audio/mp4'],
    ['mp4', 'audio/mp4'],
    ['mp4/m4a', 'audio/mp4'],  // music-metadata compound format
    ['aac', 'audio/aac'],
    ['wav', 'audio/wav'],
    ['wave', 'audio/wav'],  // music-metadata sometimes returns 'WAVE'
    ['wma', 'audio/x-ms-wma'],
    ['adts', 'audio/aac'],
    ['m3u8', 'application/vnd.apple.mpegurl'],
]);

function inferContentType(url: string, format?: string): string {
    // 1. Try the format string from music-metadata (e.g. 'MPEG', 'FLAC', 'MP4/M4A')
    if (format) {
        const mime = FORMAT_MIME_MAP.get(format.toLowerCase());
        if (mime) return mime;
    }
    // 2. Try extracting extension from the URL path (before query params)
    try {
        const pathname = new URL(url).pathname;
        const ext = pathname.split('.').pop()?.toLowerCase();
        if (ext) {
            const mime = FORMAT_MIME_MAP.get(ext);
            if (mime) return mime;
        }
    } catch { /* ignore */ }
    return 'audio/mpeg';
}

function stripQueryParam(url: string, key: string): string {
    if (!url) return url;
    try {
        const parsed = new URL(url);
        parsed.searchParams.delete(key);
        return parsed.toString();
    } catch {
        return url;
    }
}

/**
 * Which of the user's devices wrote a sender log line ("Chrome-on-Android/1a2b":
 * this browser, plus the end of its client ID). Several devices can be
 * attached to one Cast session at once (prod 2026-10-13 19:50), and without
 * this their lines cannot be told apart.
 */
let senderTag: string | null = null;
export function castLogSenderTag(): string {
    if (senderTag) return senderTag;
    try {
        senderTag = `${describeThisDevice().replace(/\s+/g, '-')}/${getAuroraClientId().slice(-4)}`;
    } catch {
        senderTag = describeThisDevice().replace(/\s+/g, '-');
    }
    return senderTag;
}

export class CastManager {
    private static instance: CastManager;
    private castContext: any = null;
    private player: any = null;
    private playerController: any = null;
    private state: CastState = 'NO_DEVICES_AVAILABLE';

    // Custom receiver app ID. Prefer runtime server config because HTML injection
    // is bypassed by service worker navigation caching and Vite dev HTML.
    private customAppId: string = (window as any).__CAST_APP_ID || '';
    private runtimeConfigPromise: Promise<void> | null = null;
    private initializePromise: Promise<void> | null = null;

    // Tracks whether this manager initiated the cast session (vs joining an existing one)
    private autoCastInProgress = false;
    private userSessionRequestPending = false;
    private rejoinSessionPending = false;
    private rejoinHydrationTimer: ReturnType<typeof setTimeout> | null = null;
    private rejoinHydrationRunId = 0;
    private rejoinHydrationAttempts = 0;
    private readonly maxRejoinHydrationAttempts = 12;
    private readonly rejoinHydrationDelayMs = 250;
    private reconnectInProgress = false;
    private lastUnmappedSessionLogAt = 0;
    // Watchdog for dead RemotePlayer event streams: after a queue replacement
    // the sender can stay bound to the OLD media session; when that session's
    // terminal IDLE arrives, RemotePlayer events stop entirely while the
    // receiver keeps playing (observed 2026-07-14 16:31→17:00 — zero sender
    // events for 29 minutes). CURRENT_TIME_CHANGED fires every second during
    // healthy playback, so a silent-while-playing stream is detectably dead.
    private statusWatchdogTimer: ReturnType<typeof setInterval> | null = null;
    // Carries the progress bar between receiver updates once the RemotePlayer
    // event stream dies; see runPositionTick().
    private positionTickTimer: ReturnType<typeof setInterval> | null = null;
    private positionAnchor: { position: number; atMs: number; entryId: string } | null = null;
    private lastKnownDuration = 0;
    private lastDurationCorrectionLogAt = 0;
    private auroraControlRequestId = 0;
    private auroraControlCapLoggedSid: string | null = null;
    private lastRemotePlayerEventAt = 0;
    private lastRemotePositionAt = 0;
    private lastRemotePositionEntryId: string | null = null;
    private lastCastStateChangeAt = 0;
    private lastWatchdogRecoveryLogAt = 0;
    private watchdogMediaRequestId = 0;
    // When the SDK loses the media session entirely we prod the receiver with
    // GET_STATUS, but an IDLE receiver (queue finished, nothing loaded) has no
    // media to answer with — the session never returns, so the store would sit
    // on playbackState 'playing' forever. Observed in prod 2026-08-30
    // 11:28→11:35: eventSilenceMs climbed 10s→205s while the app still claimed
    // to be playing. Bound the probing window, then release the playing state.
    private mediaSessionProbeStartedAt = 0;
    private remoteMediaConcludedGone = false;
    private readonly mediaSessionProbeGraceMs = 20000;
    // Any proof the receiver is alive — a RemotePlayer event, or a media status
    // we successfully pulled. Distinct from lastRemotePlayerEventAt, which
    // tracks only the event stream: that stream can die while the receiver
    // plays on perfectly well, and status refreshes keep succeeding.
    private lastRemoteEvidenceAt = 0;
    // Session we have already attached the MEDIA_SESSION listener to, so
    // repeated SESSION_STARTED/RESUMED/reconcile passes don't stack handlers.
    private mediaSessionListenerSessionId = '';
    // Latest status the receiver pushed on its own namespace. This is the
    // authoritative view: the receiver reported an exact index, queue length,
    // position and queueEntryId across 327 broadcasts with zero errors, while
    // the sender was reconstructing the same facts by URL-matching a contentId
    // the SDK relay had already staled. See #56.
    private lastAuroraStatus: AuroraReceiverStatus | null = null;
    private lastAuroraStatusAt = 0;
    private readonly auroraStatusFreshMs = 20000;
    private readonly remoteEvidenceWindowMs = 60000;
    private freshSessionStartedAt = 0;
    private readonly freshSessionWindowMs = 5000;
    private freshSessionPlaybackPromise: Promise<void> | null = null;
    // Session id that already received the fresh-session startup volume, so
    // reconcile retries can't re-clamp after the user adjusts the volume.
    private startupVolumeSessionId: string | null = null;
    private userSessionIntentTimer: ReturnType<typeof setTimeout> | null = null;
    private staleTransportRecoveryPromise: Promise<boolean> | null = null;
    private mediaStatusRefreshPromise: Promise<any | null> | null = null;
    private preserveSessionOnNextEnd = false;
    private readonly lifecycleReconcileBurst = new ReconcileBurst({
        set: (callback, delayMs) => window.setTimeout(callback, delayMs),
        clear: (id) => window.clearTimeout(id),
    });
    // The session object a stale-transport recovery could not bring back.
    // Automatic recovery and lifecycle reconciles leave it alone until the SDK
    // replaces it, a send gets through, or the user presses Retry (#39).
    private deadTransportSession: unknown = null;
    private deadTransportSkipLogged = false;
    private diagnosticsVerbose = false;
    private readonly diagnosticsSync = new CastDiagnosticsSync();
    private diagnosticsStatusSession: unknown = null;
    private suppressRemoteEndedDuringDisconnect = false;
    // Stopping from this device (castEndHandoff.ts): the "Stop casting"
    // button, or the Cast dialog opened from this device's Cast icon.
    private userStopRequested = false;
    private userCastDialogAt = 0;
    private castEndSnapshotAtStop: CastEndSnapshot | null = null;
    private lastCastButtonStateKey = '';
    private lastRemotePlayerStateKey = '';
    private lastRemoteMediaStatusKey = '';

    // Serializes concurrent loadMedia calls to prevent session_error on rapid clicks
    private currentLoadPromise: Promise<void> = Promise.resolve();

    private queueWindow: CastQueueWindow | null = null;
    private queueWindowBusy = false;
    private queueLoadingSession: unknown = null;
    private pauseAfterLoadGeneration: number | null = null;
    // Edits are counted, not flagged: a reconcile handles exactly the edits
    // that committed before it read the queue, and leaves later ones pending.
    private queueWindowEditSeq = 0;
    private queueWindowEditHandled = 0;
    private queueWindowAdoptionChecked: unknown = null;
    private readonly playbackConfirmation = new CastPlaybackConfirmation();
    private playbackRetry: { session: unknown; entryId: string; time: number } | null = null;
    private confirmationLoadAccepted = false;
    private previousPlaybackEntryId: string | null = null;
    private mediaChannelJumpFailedFor: unknown = null;
    private pendingSkip: { tracks: CastQueueTrack[]; startIndex: number; repeat: CastRepeat } | null = null;
    private skipRunner: Promise<void> | null = null;
    private skipRequestSeq = 0;
    private staleSdkMedia: unknown = null;
    private queueLoadRetry: { session: unknown; entryId: string; time: number } | null = null;
    private queueLoadGeneration = 0;
    private readonly queueInsertAcks = new CastQueueInsertAcks();

    // Listener pattern for state changes (multiple subscribers)
    private stateChangeListeners: Set<(state: CastState) => void> = new Set();
    private healthChangeListeners: Set<(status: CastHealthStatus) => void> = new Set();
    private healthStatus: CastHealthStatus = {
        phase: 'idle',
        message: '',
        updatedAt: Date.now(),
    };

    // Proxies for the player events so PlaybackManager can route them
    public onTimeUpdate?: (time: number) => void;
    public onDuration?: (duration: number) => void;
    public onPlayStateChange?: (isPlaying: boolean) => void;
    public onEnded?: () => void;
    public onVolumeChange?: (volume: number) => void;
    public onMuteChange?: (muted: boolean) => void;
    public onTrackChange?: (index: number) => void;
    private readonly queueItemIdByEntryId = new Map<string, number>();

    private constructor() {
        // The Cast API is loaded asynchronously via the script tag in index.html
        // It dispatches 'castApiAvailable' when ready.
        window.addEventListener('castApiAvailable', this.initializeCastApi.bind(this));

        // If it's already available
        if (typeof cast !== 'undefined' && cast.framework) {
            this.initializeCastApi();
        }

        this.attachLifecycleReconcileHandlers();
    }

    public static getInstance(): CastManager {
        if (!CastManager.instance) {
            CastManager.instance = new CastManager();
        }
        return CastManager.instance;
    }

    // --- State change listener management ---
    public addStateChangeListener(listener: (state: CastState) => void): () => void {
        this.stateChangeListeners.add(listener);
        // Immediately fire with current state
        listener(this.state);
        // Return unsubscribe function
        return () => this.stateChangeListeners.delete(listener);
    }

    public removeStateChangeListener(listener: (state: CastState) => void) {
        this.stateChangeListeners.delete(listener);
    }

    public addHealthChangeListener(listener: (status: CastHealthStatus) => void): () => void {
        this.healthChangeListeners.add(listener);
        listener(this.healthStatus);
        return () => this.healthChangeListeners.delete(listener);
    }

    public getHealthStatus(): CastHealthStatus {
        return this.healthStatus;
    }

    // Keep the old single-callback property as a setter that adds to the set
    set onStateChange(listener: ((state: CastState) => void) | undefined) {
        // Remove the old one if it was set via this setter
        if (this._onStateChangeCallback) {
            this.stateChangeListeners.delete(this._onStateChangeCallback);
        }
        this._onStateChangeCallback = listener;
        if (listener) {
            this.stateChangeListeners.add(listener);
        }
    }
    private _onStateChangeCallback?: (state: CastState) => void;

    private notifyStateChange() {
        if (!this.isConnected()) {
            this.playbackConfirmation.cancel();
            this.playbackRetry = null;
        }
        if (this.state === 'CONNECTED') {
            this.startStatusWatchdog();
        } else {
            this.stopStatusWatchdog();
        }
        for (const listener of this.stateChangeListeners) {
            try {
                listener(this.state);
            } catch (e) {
                console.error('[Cast] State change listener error:', e);
            }
        }
    }

    private startStatusWatchdog() {
        if (this.statusWatchdogTimer !== null) return;
        this.lastRemotePlayerEventAt = Date.now();
        this.lastRemoteEvidenceAt = Date.now();
        this.mediaSessionProbeStartedAt = 0;
        this.remoteMediaConcludedGone = false;
        this.statusWatchdogTimer = setInterval(() => {
            void this.runStatusWatchdogTick();
        }, 5000);
        if (this.positionTickTimer === null) {
            this.positionTickTimer = setInterval(() => this.runPositionTick(), POSITION_TICK_MS);
        }
    }

    /**
     * Publish a position from a trusted source and anchor the interpolator on
     * it. Interpolated ticks deliberately do not come through here:
     * re-anchoring on our own extrapolation would compound its error.
     */
    private publishPosition(position: number, atMs: number = Date.now()) {
        if (this.playbackConfirmation.unconfirmed) return;
        const entryId = this.currentEntryId();
        if (!entryId || !Number.isFinite(position) || position < 0) return;
        this.positionAnchor = { position, atMs, entryId };
        this.onTimeUpdate?.(position);
    }

    /**
     * Drop the anchor when the track changes. Extrapolating the old track's
     * position into the new one would march the bar forward and then snap it
     * backwards when the next real value lands — worse than holding still for
     * the up-to-5s until that value arrives.
     */
    private invalidatePositionAnchor() {
        this.positionAnchor = null;
        this.lastKnownDuration = 0;
    }

    private publishDuration(duration: number) {
        const view = this.getReceiverTrackView();
        const resolved = reconcileDuration({
            candidate: duration,
            receiverDuration: view.duration,
            receiverIsCurrentTrack: view.isCurrentTrack,
        });
        if (resolved === null) return;
        if (resolved !== duration && typeof duration === 'number' && isFinite(duration) && duration > 0) {
            const now = Date.now();
            if (now - this.lastDurationCorrectionLogAt > 10000) {
                this.lastDurationCorrectionLogAt = now;
                this.logCast('warn', 'Corrected stale Cast duration from receiver', `published=${resolved.toFixed(2)} rejected=${Number(duration).toFixed(2)}`);
            }
        }
        this.lastKnownDuration = resolved;
        this.onDuration?.(resolved);
    }

    /**
     * What a recent receiver status says about the track the store believes is
     * current. The status carries the receiver's own decoded duration and the
     * queue entry it is actually playing, so it can vouch for — or contradict —
     * the sender's view without going through RemotePlayer.
     */
    private getReceiverTrackView(): { duration: number | undefined; isCurrentTrack: boolean; isDifferentTrack: boolean } {
        const status = this.lastAuroraStatus;
        const fresh = !!status && Date.now() - this.lastAuroraStatusAt < SEEK_STATUS_FRESH_MS;
        const state = usePlayerStore.getState();
        const currentEntry = state.currentIndex !== null ? state.playlist[state.currentIndex]?.queueEntryId || null : null;
        const receiverEntry = fresh ? status?.queueEntryId || null : null;
        return {
            duration: fresh ? status?.duration : undefined,
            isCurrentTrack: !!receiverEntry && receiverEntry === currentEntry,
            isDifferentTrack: !!receiverEntry && !!currentEntry && receiverEntry !== currentEntry,
        };
    }

    /**
     * Fill the gaps between receiver updates while the RemotePlayer stream is
     * dead.
     *
     * #66 made the position correct in that state but left it arriving only
     * with the 5s watchdog hydration and the 5s aurora-status broadcast. Prod
     * 2026-10-06 measured 40 consecutive updates at +4.98s to +5.01s over
     * matching wall-clock gaps with no backward steps — correct at every
     * sample, a visible staircase in between.
     *
     * A live RemotePlayer already drives this once a second, so this stays out
     * of its way entirely and the two never fight.
     */
    private runPositionTick() {
        if (!this.isConnected() || this.playbackConfirmation.unconfirmed) return;
        const anchor = this.positionAnchor;
        if (!anchor || anchor.entryId !== this.currentEntryId()) return;
        if (this.remotePositionMatchesTrack() && !isRemotePlayerStreamStale(Date.now() - this.lastRemotePositionAt)) return;
        if (usePlayerStore.getState().playbackState !== 'playing') return;

        this.onTimeUpdate?.(interpolatePosition({
            anchorPosition: anchor.position,
            anchorAtMs: anchor.atMs,
            nowMs: Date.now(),
            playing: true,
            duration: this.lastKnownDuration || null,
        }));
    }

    private stopStatusWatchdog() {
        if (this.statusWatchdogTimer !== null) {
            clearInterval(this.statusWatchdogTimer);
            this.statusWatchdogTimer = null;
        }
        if (this.positionTickTimer !== null) {
            clearInterval(this.positionTickTimer);
            this.positionTickTimer = null;
        }
        this.positionAnchor = null;
    }

    /**
     * Self-heal when the RemotePlayer event stream dies or the synced track
     * drifts from the receiver. Healthy playback delivers CURRENT_TIME_CHANGED
     * every second, so "store says playing but no events for >7s" means the
     * stream is dead — re-pull the media status and re-hydrate. If the SDK
     * lost the media session entirely, prod the receiver with a low-level
     * GET_STATUS so it emits a fresh status the SDK can re-bind from.
     */
    private async runStatusWatchdogTick() {
        if (!this.isConnected()) return;
        void this.reconcileQueueWindow();
        try {
            // A live media session means any earlier "remote media gone"
            // verdict is stale — allow probing again on the next loss.
            if (this.getMediaSession()) {
                this.mediaSessionProbeStartedAt = 0;
                this.remoteMediaConcludedGone = false;
            }

            const storeState = usePlayerStore.getState();
            const eventSilenceMs = Date.now() - this.lastRemotePlayerEventAt;
            const streamLooksDead = storeState.playbackState === 'playing' && eventSilenceMs > 7000;
            if (!streamLooksDead && this.doesSessionTrackMatchStore()) return;

            if (!this.getMediaSession()) {
                // The SDK's Media object is gone, but RemotePlayer often still
                // describes the current item well enough to resolve it — that
                // synthetic session is what doesSessionTrackMatchStore() reads,
                // and it resolves fine. Hydration was gated on the real Media,
                // so a resolved track change was worked out and then discarded.
                // Prod 2026-09-01 20:30: resolution reported a changed index
                // 100 times across four tracks while exactly one sync applied,
                // leaving the queue highlight frozen on the first track.
                //
                // Deliberately not treated as evidence of life: this is local
                // state, not a reply from the receiver, so it must not keep the
                // watchdog's release timer alive.
                const remotePlayerSession = this.getHydratableMediaSession(null);
                if (remotePlayerSession && this.hasActiveRemoteMediaSession(remotePlayerSession)) {
                    await this.hydrateSenderFromRemoteSession(remotePlayerSession, 'watchdog-remote-player');
                }

                if (this.remoteMediaConcludedGone) return;
                const now = Date.now();
                if (this.mediaSessionProbeStartedAt === 0) this.mediaSessionProbeStartedAt = now;
                const probedMs = now - this.mediaSessionProbeStartedAt;
                if (shouldReleaseRemoteMedia({
                    probedMs,
                    graceMs: this.mediaSessionProbeGraceMs,
                    msSinceEvidence: now - this.lastRemoteEvidenceAt,
                    evidenceWindowMs: this.remoteEvidenceWindowMs,
                })) {
                    this.concludeRemoteMediaGone(eventSilenceMs, probedMs);
                    return;
                }
                this.requestMediaStatusBroadcast(eventSilenceMs);
                return;
            }

            const refreshed = await this.refreshMediaSessionStatus('status-watchdog');
            if (refreshed && this.hasActiveRemoteMediaSession(refreshed)) {
                // The receiver answered with live media: that is proof of life,
                // whatever the RemotePlayer event stream is doing.
                this.lastRemoteEvidenceAt = Date.now();
                const now = Date.now();
                if (now - this.lastWatchdogRecoveryLogAt > 30000) {
                    this.lastWatchdogRecoveryLogAt = now;
                    this.logCast('warn', 'Cast status watchdog re-hydrating', `eventSilenceMs=${eventSilenceMs} trackMatch=${this.doesSessionTrackMatchStore()}`);
                }
                await this.hydrateSenderFromRemoteSession(refreshed, 'status-watchdog');
            }
        } catch { /* ignore */ }
    }

    /**
     * Low-level GET_STATUS on the media namespace. Used when the sender SDK
     * has no media session object at all (so media.getStatus() is impossible):
     * the receiver answers with a MEDIA_STATUS the SDK ingests to rebuild it.
     */
    private sendMediaGetStatus(session: any) {
        if (!session || typeof session.sendMessage !== 'function') return;
        this.watchdogMediaRequestId = (this.watchdogMediaRequestId % 100000) + 1;
        try {
            void Promise.resolve(session.sendMessage('urn:x-cast:com.google.cast.media', {
                type: 'GET_STATUS',
                requestId: this.watchdogMediaRequestId,
            })).catch(() => { /* callers fall back to their own deadline */ });
        } catch { /* likewise */ }
    }

    private requestMediaStatusBroadcast(eventSilenceMs: number) {
        try {
            const session = this.castContext?.getCurrentSession?.();
            if (!session || typeof session.sendMessage !== 'function') return;
            this.sendMediaGetStatus(session);
            const now = Date.now();
            if (now - this.lastWatchdogRecoveryLogAt > 30000) {
                this.lastWatchdogRecoveryLogAt = now;
                this.logCast('warn', 'Cast status watchdog requested media status', `eventSilenceMs=${eventSilenceMs} mediaSession=none`);
            }
        } catch { /* ignore */ }
    }

    /**
     * The receiver has taken a full `mediaSessionProbeGraceMs` of GET_STATUS
     * prods and still reports no media session — the remote media is genuinely
     * gone (queue finished, or another sender took the receiver over) — not
     * merely unreachable, which `shouldReleaseRemoteMedia` distinguishes.
     * Release the local playing state so the watchdog's `streamLooksDead` guard goes
     * quiet and the UI stops showing a track that isn't playing. The Cast
     * session itself is left alone: the user is still connected and may queue
     * something next. Deliberately not `onEnded` — that would auto-advance a
     * queue whose remote state we've just admitted we can't see.
     */
    private concludeRemoteMediaGone(eventSilenceMs: number, probedMs: number) {
        this.remoteMediaConcludedGone = true;
        this.mediaSessionProbeStartedAt = 0;
        this.logCast('warn', 'Cast remote media gone; releasing local playing state', `eventSilenceMs=${eventSilenceMs} probedMs=${probedMs} msSinceEvidence=${Date.now() - this.lastRemoteEvidenceAt}`);
        try {
            this.publishPlayState(false);
        } catch { /* ignore */ }
    }

    private setHealthStatus(phase: CastHealthPhase, message: string, detail?: string) {
        this.healthStatus = {
            phase,
            message,
            detail,
            updatedAt: Date.now(),
        };

        for (const listener of this.healthChangeListeners) {
            try {
                listener(this.healthStatus);
            } catch (e) {
                console.error('[Cast] Health listener error:', e);
            }
        }
    }

    private clearRejoinHydrationTimer() {
        if (this.rejoinHydrationTimer) {
            clearTimeout(this.rejoinHydrationTimer);
            this.rejoinHydrationTimer = null;
        }
    }

    private getCurrentSessionId(): string {
        try {
            return this.castContext?.getCurrentSession?.()?.getSessionId?.() || '';
        } catch {
            return '';
        }
    }

    private getSessionId(session: any | null): string {
        try {
            return session?.getSessionId?.() || '';
        } catch {
            return '';
        }
    }

    private getSafeDeviceName(): string {
        try {
            return this.getCastDeviceName() || 'unknown-device';
        } catch {
            return 'unknown-device';
        }
    }

    private describeError(error: unknown): string {
        if (!error) return '';
        if (error instanceof Error) {
            return `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
        }
        try {
            return JSON.stringify(error);
        } catch {
            return String(error);
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }

    private isDisconnectedPresentationError(error: unknown): boolean {
        const detail = this.describeError(error);
        return /PresentationConnection.*disconnected/i.test(detail)
            || /InvalidStateError/i.test(detail)
            || /session_error/i.test(detail);
    }

    private sanitizeLogDetail(value: string): string {
        return value
            .replace(/[\r\n]+/g, ' ')
            .replace(/([?&]token=)[^&\s]+/g, '$1[redacted]')
            .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
            .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt-redacted]');
    }

    private logCast(level: CastLogLevel, message: string, detail?: string) {
        const authToken = usePlayerStore.getState().authToken;
        if (!authToken) return;
        const safeDetail = detail ? this.sanitizeLogDetail(detail) : '';
        try {
            fetch('/api/cast/log', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${authToken}`,
                },
                body: JSON.stringify({
                    source: 'cast-sender',
                    session: this.getSafeDeviceName(),
                    level,
                    message,
                    detail: [
                        `state=${this.state}`,
                        `sid=${this.getCurrentSessionId() || 'none'}`,
                        `sender=${castLogSenderTag()}`,
                        safeDetail,
                    ].filter(Boolean).join(' '),
                }),
                keepalive: true,
            }).catch(() => {});
        } catch {
            // Diagnostics must never affect playback.
        }
    }

    public setDiagnosticsVerbose(enabled: boolean) {
        if (this.diagnosticsVerbose === enabled) return;
        this.diagnosticsVerbose = enabled;
        this.logCast('ok', 'cast-diagnostics-verbosity', `enabled=${enabled}`);
        this.diagnosticsSync.reset();
        this.syncReceiverDiagnostics(true);
    }

    private syncReceiverDiagnostics(force = false) {
        const session = this.castContext?.getCurrentSession?.();
        if (!session || session !== this.diagnosticsStatusSession || !this.lastAuroraStatus
            || Date.now() - this.lastAuroraStatusAt >= this.auroraStatusFreshMs) return;
        this.diagnosticsSync.sync(session, this.diagnosticsVerbose,
            force ? { ...this.lastAuroraStatus, diagnosticsVerbose: undefined } : this.lastAuroraStatus,
            (level, message) => this.logCast(level, message));
    }

    public isDiagnosticsVerbose(): boolean {
        return this.diagnosticsVerbose;
    }

    public logCastButtonState(detail: string) {
        if (this.lastCastButtonStateKey === detail) return;
        this.lastCastButtonStateKey = detail;
        this.logCast('ok', 'cast-button-state', detail);
    }

    private isRecentFreshSessionStart(): boolean {
        return this.freshSessionStartedAt > 0 && Date.now() - this.freshSessionStartedAt < this.freshSessionWindowMs;
    }

    private getStoredSessionId(): string {
        try {
            return localStorage.getItem(SESSION_STORAGE_KEY) || '';
        } catch {
            return '';
        }
    }

    private shouldHydrateConnectedSessionAsRejoin(): boolean {
        if (this.rejoinSessionPending) return true;
        if (this.isRecentFreshSessionStart()) return false;

        const storedId = this.getStoredSessionId();
        if (!storedId) return false;

        const currentSessionId = this.getCurrentSessionId();
        return !currentSessionId || currentSessionId === storedId;
    }

    private scheduleFreshSessionPlayback(reason: string, delayMs: number = 0) {
        if (this.freshSessionPlaybackPromise) {
            this.logCast('ok', `Fresh Cast playback already scheduled: ${reason}`);
            return;
        }
        this.freshSessionPlaybackPromise = (async () => {
            if (delayMs > 0) {
                await this.delay(delayMs);
            }
            await this.startPlaybackForCurrentSession(reason);
        })().finally(() => {
            this.freshSessionPlaybackPromise = null;
            this.userSessionRequestPending = false;
            this.clearUserSessionIntentTimer();
        });
    }

    private clearUserSessionIntentTimer() {
        if (this.userSessionIntentTimer) {
            clearTimeout(this.userSessionIntentTimer);
            this.userSessionIntentTimer = null;
        }
    }

    /** The Cast icon was tapped while casting: its dialog can stop the session from here. */
    /**
     * "Sync playback across devices" events (claims, take-overs, following,
     * remote commands, page close and restore), in the same log and with the
     * same sender tag as Cast, so a multi-device test reads as one story.
     */
    public logSyncEvent(level: CastLogLevel, message: string, detail?: string) {
        this.logCast(level, message, detail);
    }

    /** Remote control relayed through this sender (sessionCommands.ts), for the Cast log. */
    public logSessionCommand(type: string, applied: boolean) {
        if (!this.isConnected()) return;
        this.logCast(applied ? 'ok' : 'warn', 'session-command', `type=${type} applied=${applied}`);
    }

    public noteUserCastDialogOpened(reason: string = 'launcher') {
        if (!this.isConnected()) return;
        this.userCastDialogAt = Date.now();
        this.logCast('ok', 'User opened Cast dialog while connected', `reason=${reason}`);
    }

    private captureCastEndSnapshot(): CastEndSnapshot | null {
        const state = usePlayerStore.getState();
        return castEndSnapshot({
            anchor: this.positionAnchor,
            now: Date.now(),
            playlist: state.playlist,
            currentIndex: state.currentIndex,
            wasPlaying: state.playbackState === 'playing',
            storePositionSeconds: getPlaybackTimeSnapshot().currentTime,
        });
    }

    private resetCastEndIntent() {
        this.userStopRequested = false;
        this.userCastDialogAt = 0;
        this.castEndSnapshotAtStop = null;
    }

    /**
     * Tells whether another of the user's devices is casting to the named
     * Cast device right now (from the playback session; main.tsx). A Cast
     * dialog then joins that session as a second sender, and Chrome on the
     * desktop gets a one-way connection there: it sends but hears nothing
     * (prod 2026-10-13 21:47:36), so it reloaded its own queue over the
     * other device's and kept re-sending it. Such a device leaves the Cast
     * session again (the receiver plays on) and controls it remotely.
     */
    /** The Cast session this device is connected to, or '' (for the playback session's claim). */
    public getCastSessionId(): string {
        return this.getCurrentSessionId();
    }

    public setCastingElsewhereCheck(check: ((castDeviceName: string) => boolean) | null) {
        this.castingElsewhereCheck = check;
    }

    private castingElsewhereCheck: ((castDeviceName: string) => boolean) | null = null;
    /** This sender left a session another device casts, on purpose: no handoff. */
    private leftJoinedSession = false;
    /** When it left, so the disconnect that follows is not reported as a failure. */
    private leftJoinedSessionAt = 0;
    /** The Cast session it left: never recovered or rejoined as "stale". */
    private leftJoinedSessionId = '';

    private leaveIfCastingElsewhere(reason: string): boolean {
        // Already leaving (the connect and the session-start paths both ask).
        if (this.leftJoinedSession) return true;
        const name = this.getCastDeviceName();
        if (!name || !this.castContext?.getCurrentSession?.() || !this.castingElsewhereCheck?.(name)) {
            // Staying connected, possibly to a session left earlier (the other
            // device has stopped casting there since): recover it as usual.
            if (this.isLeftJoinedSession(this.getCurrentSessionId())) this.leftJoinedSessionId = '';
            return false;
        }
        this.leftJoinedSession = true;
        this.leftJoinedSessionAt = Date.now();
        this.leftJoinedSessionId = this.getCurrentSessionId();
        // The launcher tap's follow-up checks would find the closed connection
        // and "recover" it, rejoining the session just left (prod 2026-10-13
        // 22:45:59: the phone left, then SESSION_RESUMED 0.3 s later).
        this.userSessionRequestPending = false;
        this.clearUserSessionIntentTimer();
        this.freshSessionStartedAt = 0;
        this.preserveSessionOnNextEnd = false;
        localStorage.removeItem(SESSION_STORAGE_KEY);
        this.logCast('ok', 'cast-join-left', `reason=${reason} device=${name}`);
        try {
            // false: leave the session, do not stop the receiver.
            this.castContext.endCurrentSession(false);
        } catch (error) {
            this.logCast('warn', 'cast-join-leave-failed', this.describeError(error));
        }
        return true;
    }

    /** This device is leaving a Cast session another device casts (cast-join-left). */
    public isLeavingJoinedSession(): boolean {
        return this.leftJoinedSession;
    }

    private afterSessionEnded(snapshot: CastEndSnapshot | null) {
        if (this.stoppedBecauseReplaced) {
            this.stoppedBecauseReplaced = false;
            this.resetCastEndIntent();
            this.logCast('ok', 'cast-ended-handoff skipped', 'reason=replaced');
            if (usePlayerStore.getState().playbackState === 'playing') {
                usePlayerStore.setState({ playbackState: 'paused', isBuffering: false });
            }
            return;
        }
        if (this.leftJoinedSession) {
            this.leftJoinedSession = false;
            this.resetCastEndIntent();
            // Nothing plays here: never leave the store saying otherwise.
            if (usePlayerStore.getState().playbackState === 'playing') {
                usePlayerStore.setState({ playbackState: 'paused', isBuffering: false });
            }
            this.logCast('ok', 'cast-ended-handoff skipped', 'reason=left-joined-session');
            return;
        }
        this.handOffToLocalAfterSessionEnd(snapshot);
    }

    /** Hands playback back to this device after its Cast session ended for good. */
    private handOffToLocalAfterSessionEnd(snapshot: CastEndSnapshot | null) {
        const userStopRequested = this.userStopRequested;
        const dialogOpenedAt = this.userCastDialogAt;
        this.resetCastEndIntent();
        if (!snapshot) {
            this.logCast('warn', 'cast-ended-handoff skipped', 'reason=no-current-track');
            return;
        }
        const now = Date.now();
        const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
        const play = shouldContinuePlayingAfterCast({ userStopRequested, dialogOpenedAt, now, wasPlaying: snapshot.wasPlaying, visible });
        this.logCast('ok', 'cast-ended-handoff', `play=${play} wasPlaying=${snapshot.wasPlaying} userStop=${userStopRequested} dialog=${dialogOpenedAt ? 'recent' : 'none'} dialogAgoMs=${dialogOpenedAt ? now - dialogOpenedAt : 'none'} visible=${visible} index=${snapshot.index} position=${snapshot.positionSeconds.toFixed(1)}`);
        void usePlayerStore.getState().continueLocallyAfterCast(snapshot.index, snapshot.positionSeconds, play);
    }

    public noteUserCastLaunchIntent(reason: string = 'launcher') {
        if (this.isConnected()) return;

        // Warn immediately on click; the native launcher opens its own device
        // picker that we can't cancel, so the hard stop lives in the fresh
        // handover path (startPlaybackForCurrentSession).
        const originIssue = this.getOriginCastabilityIssue();
        if (originIssue) {
            this.logCast('warn', 'Cast launch from non-castable origin', originIssue);
            toast.error(`Casting won't work from ${window.location.host} — the Cast device can't reach this origin. Use the HTTPS app.`);
        }

        this.userSessionRequestPending = true;
        this.freshSessionStartedAt = Date.now();
        this.rejoinSessionPending = false;
        this.rejoinHydrationRunId += 1;
        this.clearRejoinHydrationTimer();
        this.clearUserSessionIntentTimer();
        this.setHealthStatus('rejoining', 'Connecting to Cast device...', reason);
        this.logCast('ok', 'User initiated Cast launcher session', `reason=${reason}`);

        [2000, 5000, 9000].forEach((delay) => {
            window.setTimeout(() => {
                if (!this.userSessionRequestPending) return;
                void this.reconcileActiveSession(`user-launch-intent+${delay}ms`);
            }, delay);
        });

        this.userSessionIntentTimer = setTimeout(() => {
            if (!this.userSessionRequestPending) return;
            this.userSessionRequestPending = false;
            this.freshSessionStartedAt = 0;
            this.logCast('warn', 'User Cast launcher intent timed out', `reason=${reason}`);
            if (!this.isConnected()) {
                this.setHealthStatus('idle', '', reason);
            }
        }, 15000);
    }

    private resetSessionAttemptState(reason: string, options: { clearStoredSession?: boolean; healthPhase?: CastHealthPhase; healthMessage?: string } = {}) {
        this.playbackConfirmation.cancel();
        this.playbackRetry = null;
        this.mediaSessionListenerSessionId = '';
        this.userSessionRequestPending = false;
        this.rejoinSessionPending = false;
        this.freshSessionStartedAt = 0;
        this.rejoinHydrationRunId += 1;
        this.clearRejoinHydrationTimer();
        this.clearUserSessionIntentTimer();
        if (options.clearStoredSession) {
            localStorage.removeItem(SESSION_STORAGE_KEY);
        }
        this.state = this.castContext?.getCastState?.() || 'NOT_CONNECTED';
        this.notifyStateChange();
        this.setHealthStatus(options.healthPhase || 'idle', options.healthMessage || '', reason);
    }

    private attachLifecycleReconcileHandlers() {
        const schedule = (reason: string) => this.scheduleSessionReconcile(reason);

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') schedule('visibility-visible');
        });
        window.addEventListener('pageshow', () => schedule('pageshow'));
        window.addEventListener('focus', () => schedule('window-focus'));
        window.addEventListener('online', () => schedule('network-online'));
        document.addEventListener('resume', () => schedule('document-resume'));
    }

    private scheduleSessionReconcile(reason: string) {
        this.lifecycleReconcileBurst.start({
            attempt: (delay) => {
                void this.reconcileActiveSession(`${reason}+${delay}ms`);
            },
            // Once recovery owns the session, or it has been proven dead, more
            // attempts can only send into the same dead transport (#39).
            shouldStandDown: () => this.staleTransportRecoveryPromise !== null || this.isKnownDeadTransport(),
            onStandDown: (delay) => {
                this.logCast(
                    'ok',
                    `Cast reconcile burst stood down: ${reason}+${delay}ms`,
                    this.staleTransportRecoveryPromise ? 'recovery=in-flight' : 'transport=dead',
                );
            },
        });
    }

    private nextMediaRequestId(): number {
        this.watchdogMediaRequestId = (this.watchdogMediaRequestId % 100000) + 1;
        return this.watchdogMediaRequestId;
    }

    /** True while the current session is the one recovery already failed to bring back. */
    private isKnownDeadTransport(): boolean {
        if (!this.deadTransportSession) return false;
        const current = this.castContext?.getCurrentSession?.() || null;
        if (current && current === this.deadTransportSession) return true;
        this.clearDeadTransport();
        return false;
    }

    private clearDeadTransport() {
        this.deadTransportSession = null;
        this.deadTransportSkipLogged = false;
    }

    /**
     * Recovery triggered by background status traffic (watchdog, reconcile).
     * After a failed recovery the watchdog would otherwise restart it every 5s
     * against the same dead session, flashing an error toast each round.
     */
    private isLeftJoinedSession(sessionId: string): boolean {
        return !!sessionId && sessionId === this.leftJoinedSessionId;
    }

    private recoverStaleTransportAutomatically(reason: string, error: unknown) {
        if (this.isKnownDeadTransport()) {
            if (!this.deadTransportSkipLogged) {
                this.deadTransportSkipLogged = true;
                this.logCast('warn', `Skipped automatic Cast transport recovery: ${reason}`, 'transport=dead');
            }
            return;
        }
        void this.recoverStaleTransport(reason, error);
    }

    private async recoverStaleTransport(reason: string, error?: unknown): Promise<boolean> {
        if (this.staleTransportRecoveryPromise) return this.staleTransportRecoveryPromise;

        const leaving = this.getCurrentSessionId() || localStorage.getItem(SESSION_STORAGE_KEY) || '';
        if (this.leftJoinedSession || this.isLeftJoinedSession(leaving)) {
            this.logCast('ok', `Skipped Cast transport recovery: ${reason}`, 'reason=left-joined-session');
            return false;
        }

        this.staleTransportRecoveryPromise = (async () => {
            const sessionId = this.getCurrentSessionId() || localStorage.getItem(SESSION_STORAGE_KEY) || '';
            if (!sessionId) {
                this.logCast('error', `Cannot recover stale Cast transport: ${reason}`, 'missing-session-id');
                this.setHealthStatus('error', 'Cast control needs reconnecting.', 'Missing session id');
                this.state = this.castContext?.getCastState?.() || 'NOT_CONNECTED';
                this.notifyStateChange();
                return false;
            }

            this.logCast('warn', `Recovering stale Cast transport: ${reason}`, this.describeError(error));
            this.setHealthStatus('recovering', 'Reconnecting Cast control...', reason);
            localStorage.setItem(SESSION_STORAGE_KEY, sessionId);

            try {
                this.preserveSessionOnNextEnd = true;
                this.castContext?.endCurrentSession?.(false);
            } catch (endError) {
                // endCurrentSession() sends on the same dead transport and can
                // throw before ending anything. No SESSION_ENDED is coming from
                // this detach, so don't let the flag claim an unrelated later
                // end (prod 2026-10-10: it relabelled a different device's end
                // 40s later as a preserved detach).
                this.preserveSessionOnNextEnd = false;
                this.logCast('warn', `Failed to detach stale Cast session: ${reason}`, this.describeError(endError));
            } finally {
                localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
            }

            await this.delay(350);

            try {
                this.rejoinSessionPending = true;
                chrome.cast.requestSessionById(sessionId);
            } catch (rejoinError) {
                this.rejoinSessionPending = false;
                this.logCast('error', `Stale Cast transport rejoin failed: ${reason}`, this.describeError(rejoinError));
                this.setHealthStatus('error', 'Could not reconnect Cast control.', this.describeError(rejoinError));
                return false;
            }

            let transportStillDead = false;
            for (let attempt = 0; attempt < 16; attempt += 1) {
                await this.delay(250);
                const session = this.castContext?.getCurrentSession?.() || null;
                if (!session) {
                    transportStillDead = false;
                    continue;
                }

                // A session being present is not proof of recovery: when the
                // detach above throws, it is still the old one, and its sends
                // still fail. Only the disconnected-transport signature counts
                // as dead; any other probe outcome keeps the previous behaviour.
                const probe = await probeCastTransport(session, {
                    requestId: this.nextMediaRequestId(),
                    isDisconnected: (probeError) => this.isDisconnectedPresentationError(probeError),
                });
                if (probe === 'dead') {
                    transportStillDead = true;
                    continue;
                }
                transportStillDead = false;
                this.clearDeadTransport();

                this.rejoinSessionPending = false;
                this.state = 'CONNECTED';
                this.notifyStateChange();
                localStorage.setItem(SESSION_STORAGE_KEY, sessionId);

                const mediaSession = this.getHydratableMediaSession(session.getMediaSession?.() || null);
                if (this.hasActiveRemoteMediaSession(mediaSession)) {
                    await this.hydrateSenderFromRemoteSession(mediaSession, `stale-transport:${reason}`);
                } else {
                    this.logCast('warn', `Rejoined Cast session without active media: ${reason}`, this.describeRemotePlayer());
                }
                this.logCast('ok', `Recovered stale Cast transport: ${reason}`);
                this.logCast('ok', 'stale-transport-recovered', `reason=${reason}`);
                this.setHealthStatus('recovered', 'Cast control reconnected.', this.getCastDeviceName());
                return true;
            }

            if (transportStillDead) {
                // rejoinSessionPending stays set, as on the timeout path below:
                // if requestSessionById() does deliver later, it must hydrate
                // as a rejoin rather than auto-cast the local queue over it.
                this.deadTransportSession = this.castContext?.getCurrentSession?.() || null;
                this.deadTransportSkipLogged = false;
                this.logCast('error', `Stale Cast transport still dead after rejoin: ${reason}`);
                this.logCast('error', 'stale-transport-dead', `reason=${reason}`);
                this.setHealthStatus('error', 'Lost connection to the Cast device.', reason);
                return false;
            }

            this.logCast('error', `Timed out recovering stale Cast transport: ${reason}`);
            this.setHealthStatus('error', 'Cast control timed out while reconnecting.', reason);
            return false;
        })().finally(() => {
            this.staleTransportRecoveryPromise = null;
        });

        return this.staleTransportRecoveryPromise;
    }

    private async runCastCommand<T>(label: string, command: () => Promise<T>): Promise<T> {
        try {
            return await command();
        } catch (error) {
            if (!this.isDisconnectedPresentationError(error)) {
                throw error;
            }

            const recovered = await this.recoverStaleTransport(label, error);
            if (!recovered) throw error;

            this.logCast('ok', `Retrying Cast command after transport recovery: ${label}`);
            return await command();
        }
    }

    private handleControlError(label: string, error: unknown) {
        console.error(`[Cast] ${label} failed:`, error);
        this.logCast('error', `${label} failed`, this.describeError(error));
        if (this.isDisconnectedPresentationError(error)) {
            void this.recoverStaleTransport(label, error);
        }
    }

    public hasStoredSession(): boolean {
        try {
            return !!window.localStorage.getItem(SESSION_STORAGE_KEY);
        } catch {
            return false;
        }
    }

    /**
     * Follow the receiver onto each new piece of media.
     *
     * RemotePlayerController's events are bound to whichever `Media` object the
     * SDK held when they were wired up. When the receiver advances its own
     * queue the SDK builds a *new* `chrome.cast.media.Media`, and a sender that
     * only listens to RemotePlayer keeps talking to the old one — its events
     * stop, its `playerState` freezes, and nothing ever re-binds.
     *
     * Prod 2026-09-01: RemotePlayer went silent at 08:59:10 and stayed silent
     * for 26 minutes while the receiver played five more tracks. The sender sat
     * on a stale media object (`playerState=IDLE time=0 duration=185.626`)
     * against a 457s track, so progress froze and every attempt to map the
     * session item to the playlist failed. A page reload did not help either:
     * on resume the media already exists, so no RemotePlayer event is coming
     * and `Cast session exists without active media` repeated.
     *
     * `SessionEventType.MEDIA_SESSION` is the SDK's signal that a new Media was
     * created — the intended way to learn about media the sender did not load
     * itself. This supplements RemotePlayer rather than replacing it.
     */
    private attachMediaSessionListener(session: any | null = this.castContext?.getCurrentSession?.()) {
        if (!session || typeof session.addEventListener !== 'function') return;
        const sessionId = session.getSessionId?.() || '';
        if (sessionId && sessionId === this.mediaSessionListenerSessionId) return;
        this.mediaSessionListenerSessionId = sessionId;

        try {
            session.addEventListener(cast.framework.SessionEventType.MEDIA_SESSION, (event: any) => {
                // The event carries the new Media on CAF; fall back to reading
                // it off the session in case a build does not populate it.
                const mediaSession = event?.mediaSession || this.getMediaSession();
                const now = Date.now();
                this.lastRemoteEvidenceAt = now;
                this.lastRemotePlayerEventAt = now;
                this.mediaSessionProbeStartedAt = 0;
                this.remoteMediaConcludedGone = false;
                this.logCast('ok', 'MEDIA_SESSION: rebinding to new remote media', this.describeMediaSession(mediaSession));
                this.noteSdkMedia(this.queueWindow, mediaSession);
                void this.hydrateSenderFromRemoteSession(mediaSession, 'media-session-event');
            });
            this.logCast('ok', 'Attached MEDIA_SESSION listener', `sid=${sessionId || 'unknown'}`);
            this.attachAuroraStatusListener(session, sessionId);
        } catch (error) {
            this.mediaSessionListenerSessionId = '';
            this.logCast('warn', 'Failed to attach MEDIA_SESSION listener', this.describeError(error));
        }
    }

    /**
     * Listen for the receiver's own status broadcasts.
     *
     * Registered on the same sessions as the MEDIA_SESSION listener and guarded
     * by the same session id, so it cannot stack handlers. Purely additive: if
     * the receiver predates the namespace, nothing arrives and every existing
     * path behaves as before.
     */
    private attachAuroraStatusListener(session: any, sessionId: string) {
        if (!session || typeof session.addMessageListener !== 'function') return;
        try {
            // The sender receives a raw string on custom namespaces, not an object.
            session.addMessageListener(getAuroraStatusNamespace(session), (_ns: string, message: string) => {
                let status: AuroraReceiverStatus | null = null;
                try {
                    status = typeof message === 'string' ? JSON.parse(message) : message;
                } catch {
                    return; // malformed payload — ignore rather than throw in a listener
                }
                if (status && status.type === 'aurora.status') {
                    if (session !== this.castContext?.getCurrentSession?.()) return;
                    this.diagnosticsStatusSession = session;
                    if (status.caps?.includes('control') && this.auroraControlCapLoggedSid !== sessionId) {
                        this.auroraControlCapLoggedSid = sessionId;
                        this.logCast('ok', 'Receiver accepts aurora-control', `sid=${sessionId || 'unknown'} caps=${status.caps.join(',')}`);
                    }
                    this.applyAuroraStatus(status);
                    this.syncReceiverDiagnostics();
                } else if (status && status.type === 'aurora.diagnostics.ack') {
                    const ack = status as unknown as { requestId?: unknown; enabled?: unknown };
                    this.diagnosticsSync.acknowledge(session, ack.requestId, ack.enabled,
                        (level, message) => this.logCast(level, message));
                } else if (status && (status as { type?: string }).type === 'aurora.queue.insert.ack') {
                    const ack = status as unknown as { ok?: boolean; inserted?: number; detail?: string; requestId?: number };
                    this.queueInsertAcks.acknowledge(session, ack);
                    this.logCast(
                        ack.ok ? 'ok' : 'error',
                        'Cast queue insert acknowledged by receiver',
                        `ok=${Boolean(ack.ok)} inserted=${ack.inserted ?? 0} requestId=${ack.requestId ?? 'none'}${ack.detail ? ` ${ack.detail}` : ''}`,
                    );
                } else if (status && (status as { type?: string }).type === 'aurora.control.ack') {
                    const ack = status as unknown as { action?: string; ok?: boolean; detail?: string; requestId?: number };
                    this.logCast(
                        ack.ok ? 'ok' : 'warn',
                        `Cast ${ack.action || 'control'} acknowledged by receiver`,
                        `ok=${Boolean(ack.ok)} requestId=${ack.requestId ?? 'none'}${ack.detail ? ` ${ack.detail}` : ''}`,
                    );
                }
            });
            this.logCast('ok', 'Attached aurora-status listener', `sid=${sessionId || 'unknown'}`);
        } catch (error) {
            this.logCast('warn', 'Failed to attach aurora-status listener', this.describeError(error));
        }
    }

    /**
     * Apply a receiver-pushed status.
     *
     * This is a reply from the receiver, so it counts as evidence of life for
     * the release timer added in #51 — unlike the synthetic RemotePlayer
     * snapshot, which is local state.
     */
    private applyAuroraStatus(status: AuroraReceiverStatus) {
        if (this.playbackConfirmation.unconfirmed && !this.confirmationLoadAccepted && status.queueEntryId !== this.playbackConfirmation.entryId) return;
        if (this.playbackConfirmation.unconfirmed && status.queueEntryId && status.queueEntryId !== this.playbackConfirmation.entryId) {
            // Ignore the preceding item's late status; a different selection is
            // evidence of takeover/advance, which cancels our pending retry.
            if (status.queueEntryId === this.previousPlaybackEntryId) return;
            this.playbackConfirmation.cancel();
            this.playbackRetry = null;
        }
        if (this.confirmationLoadAccepted) this.playbackConfirmation.observe({ entryId: status.queueEntryId, playerState: status.playerState, currentTime: status.currentTime });
        const now = Date.now();
        this.lastAuroraStatus = status;
        const statusWindow = this.queueWindow;
        if (statusWindow && status.queueEntryId && typeof status.itemId === 'number' && statusWindow.session === this.castContext?.getCurrentSession?.()) {
            this.observeItemId(statusWindow, status.queueEntryId, status.itemId);
        }
        this.lastAuroraStatusAt = now;
        this.maybeAdoptQueueWindow(status);
        this.lastRemoteEvidenceAt = now;
        this.mediaSessionProbeStartedAt = 0;
        this.remoteMediaConcludedGone = false;

        const state = usePlayerStore.getState();

        // Identity first: an exact id beats matching a URL that has to survive
        // token, codec and quality rewriting.
        if (status.queueEntryId) {
            const index = state.playlist.findIndex((track) => track.queueEntryId === status.queueEntryId);
            if (index >= 0 && index !== state.currentIndex) {
                this.logCast('ok', 'aurora-status: syncing track index', `from=${state.currentIndex} to=${index} entryId=${status.queueEntryId}`);
                this.invalidatePositionAnchor();
                this.onTrackChange?.(index);
            }
        }

        // Position is the only continuous value on this channel. RemotePlayer
        // emits CURRENT_TIME_CHANGED every second while it is alive, so applying
        // a status up to five seconds old on top of that drags the progress bar
        // backwards and then forwards again — visible as a flash every five
        // seconds. Defer to RemotePlayer whenever it is talking, and drive
        // position from the receiver only once that stream has gone quiet, which
        // is the case this channel exists to cover.
        //
        // Track identity and play state are discrete and authoritative, so they
        // still apply unconditionally below. Position and duration apply only
        // to the entry the sender shows as current.
        const forCurrentEntry = status.queueEntryId === this.currentEntryId();
        if (!forCurrentEntry) {
            // Neither value belongs to the track on screen.
        } else if (!this.remotePositionMatchesTrack() || isRemotePlayerStreamStale(now - this.lastRemotePositionAt)) {
            if (typeof status.duration === 'number' && isFinite(status.duration) && status.duration > 0) {
                this.publishDuration(status.duration);
            }
            if (typeof status.currentTime === 'number' && isFinite(status.currentTime) && status.currentTime >= 0) {
                this.publishPosition(status.currentTime);
            }
        } else if (this.lastKnownDuration > 0) {
            // Duration is discrete, so unlike position it cannot drag the bar
            // back and forth — and a live RemotePlayer can still be reporting
            // the previous item's length after a queue reload (prod 2026-10-06
            // 11:45: 206.22s published for a 123s track). Correct it only when
            // the receiver disagrees materially, so a healthy session sees no
            // extra publishes at all.
            const view = this.getReceiverTrackView();
            const resolved = reconcileDuration({
                candidate: this.lastKnownDuration,
                receiverDuration: view.duration,
                receiverIsCurrentTrack: view.isCurrentTrack,
            });
            if (resolved !== null && resolved !== this.lastKnownDuration) this.publishDuration(resolved);
        }
        if (status.playerState === 'PLAYING') {
            this.publishPlayState(true);
        } else if (status.playerState === 'PAUSED') {
            this.publishPlayState(false);
        }
    }

    private hasActiveRemoteMediaSession(mediaSession: any | null = this.getMediaSession()): boolean {
        if (!mediaSession) return false;
        return !!mediaSession.media || (Array.isArray(mediaSession.items) && mediaSession.items.length > 0);
    }

    private getRemotePlayerMediaSession(): any | null {
        if (!this.player) return null;

        const mediaInfo = this.player.mediaInfo || null;
        const queueData = this.player.queueData || null;
        const queueItems = Array.isArray(queueData?.items) ? queueData.items : [];
        const isLoaded = Boolean(this.player.isMediaLoaded || mediaInfo || queueItems.length || this.player.title);
        if (!isLoaded) return null;

        // Track identity (currentItemId / customData / currentItemIndex) must
        // come from player.mediaInfo or not at all. queueData.startIndex is
        // frozen at queue-load time — after the receiver auto-advances it still
        // points at the track the load STARTED on, so deriving identity from
        // items[startIndex] drags the sender UI back to that track whenever the
        // real media session is transiently null (observed as from=0 to=1
        // followed by from=1 to=0 sync ping-pong).
        const sourceMedia = mediaInfo || null;
        const metadata = {
            ...(sourceMedia?.metadata || {}),
        };
        if (!metadata.title && this.player.title) metadata.title = this.player.title;
        if (!metadata.images && this.player.imageUrl) metadata.images = [new chrome.cast.Image(this.player.imageUrl)];
        if (!metadata.duration && typeof this.player.duration === 'number' && isFinite(this.player.duration) && this.player.duration > 0) {
            metadata.duration = this.player.duration;
        }

        const media = sourceMedia
            ? { ...sourceMedia, metadata }
            : {
                contentId: '',
                contentType: '',
                customData: undefined,
                metadata,
            };

        return {
            media,
            items: queueItems,
            currentTime: this.player.currentTime,
            playerState: this.player.playerState || (this.player.isPaused ? chrome.cast.media.PlayerState.PAUSED : chrome.cast.media.PlayerState.PLAYING),
            repeatMode: queueData?.repeatMode,
            __source: 'remote-player',
        };
    }

    private getHydratableMediaSession(mediaSession: any | null = this.getMediaSession()): any | null {
        return mediaSession || this.getRemotePlayerMediaSession();
    }

    private msSinceRemotePlayerEvent(): number {
        return Date.now() - this.lastRemotePlayerEventAt;
    }

    /**
     * BUFFERING counts as playing here: a receiver mid-buffer is on its way to
     * audible, so a pause has real work to do. mapCastPlayerState() folds it
     * into 'stopped', which is right for UI labelling and wrong for transport.
     */
    private normalizeTransportState(playerState: unknown): 'playing' | 'paused' | 'stopped' {
        if (playerState === chrome.cast.media.PlayerState.PAUSED) return 'paused';
        if (playerState === chrome.cast.media.PlayerState.PLAYING
            || playerState === chrome.cast.media.PlayerState.BUFFERING) return 'playing';
        return 'stopped';
    }

    /**
     * Route a transport command through the media session rather than the
     * RemotePlayer controller.
     *
     * RemotePlayerController acts on the local RemotePlayer, so once that event
     * stream dies its commands go nowhere — silently, without throwing. Prod
     * 2026-09-02 21:56: play/pause did nothing for minutes while the watchdog
     * pulled media status successfully every 5s, and the receiver logged no
     * PAUSE at all. The live media session sitting right next to the dead
     * player is the thing that still works.
     *
     * Returns false when the caller should fall back to the controller, which
     * stays the path for a healthy stream: it is the SDK's own, and it keeps
     * RemotePlayer's local state coherent.
     */
    private tryTransportViaMediaSession(label: string, intent: 'play' | 'pause' | 'toggle'): boolean {
        const mediaSession = this.getMediaSession();
        const hasMediaSession = !!mediaSession && typeof mediaSession.play === 'function' && typeof mediaSession.pause === 'function';
        // With no media session the controller has nothing to act on either,
        // whatever the RemotePlayer stream is doing — so this check comes
        // before the staleness gate, not after it.
        if (!hasMediaSession && this.tryTransportViaReceiverChannel(label, intent)) return true;
        if (!isRemotePlayerStreamStale(this.msSinceRemotePlayerEvent())) return false;

        if (!hasMediaSession) {
            this.logCast(
                'warn',
                `Cast ${label} cannot reach the receiver`,
                `playerSilentMs=${this.msSinceRemotePlayerEvent()} staleAfterMs=${REMOTE_PLAYER_STALE_MS} mediaSession=${mediaSession ? 'present' : 'none'}`,
            );
            return false;
        }

        const playerState = mediaSession.playerState;
        const action = chooseTransportAction(intent, this.normalizeTransportState(playerState));
        if (action === 'satisfied') {
            this.logCast('ok', `Cast ${label} already satisfied`, `playerState=${playerState || 'unknown'}`);
            return true;
        }

        try {
            const request = action === 'pause'
                ? (chrome.cast?.media?.PauseRequest ? new chrome.cast.media.PauseRequest() : null)
                : (chrome.cast?.media?.PlayRequest ? new chrome.cast.media.PlayRequest() : null);
            mediaSession[action](
                request,
                () => this.logCast('ok', `Cast ${label} via media session`, `action=${action}`),
                (error: unknown) => this.handleControlError(`${label} via media session`, error),
            );
            return true;
        } catch (error) {
            this.handleControlError(`${label} via media session`, error);
            return false;
        }
    }

    /**
     * Transport for when the SDK has no media session at all.
     *
     * #66 routed transport through the media session once RemotePlayer died,
     * which works while that object exists. Prod 2026-10-06 11:45 showed it
     * can vanish for ~18s with the receiver playing throughout: seven presses,
     * every one mediaSession=none. The SDK documents no way to re-acquire it —
     * the watchdog's GET_STATUS probe ran 53 times that day without bringing
     * it back, and it returned only when a new track loaded. The aurora
     * namespace stays up in exactly that state, so commands go over it.
     *
     * The action is decided here from the receiver's last reported state, with
     * the same policy as the media-session path.
     */
    private tryTransportViaReceiverChannel(label: string, intent: 'play' | 'pause' | 'toggle'): boolean {
        if (!this.isReceiverControlAvailable()) return false;
        const playerState = this.lastAuroraStatus?.playerState;
        const action = chooseTransportAction(intent, transportStateFromPlayerState(playerState));
        if (action === 'satisfied') {
            this.logCast('ok', `Cast ${label} already satisfied`, `playerState=${playerState || 'unknown'} via=receiver-channel`);
            return true;
        }
        return this.sendReceiverControl(action);
    }

    private isReceiverControlAvailable(): boolean {
        return receiverControlAvailable({
            caps: this.lastAuroraStatus?.caps,
            statusAgeMs: Date.now() - this.lastAuroraStatusAt,
            freshMs: this.auroraStatusFreshMs,
        });
    }

    private sendReceiverControl(action: 'play' | 'pause' | 'seek', extra: { time?: number } = {}): boolean {
        if (!this.isReceiverControlAvailable()) return false;
        const session = this.castContext?.getCurrentSession?.() || null;
        if (!session || typeof session.sendMessage !== 'function') return false;

        const requestId = ++this.auroraControlRequestId;
        const detail = `action=${action} requestId=${requestId}${typeof extra.time === 'number' ? ` time=${extra.time.toFixed(1)}` : ''}`;
        try {
            session.sendMessage(getAuroraStatusNamespace(session), { type: 'aurora.control', action, requestId, ...extra })
                .then(() => this.logCast('ok', `Cast ${action} via receiver channel`, detail))
                .catch((error: unknown) => this.handleControlError(`${action} via receiver channel`, error));
            return true;
        } catch (error) {
            this.handleControlError(`${action} via receiver channel`, error);
            return false;
        }
    }

    /**
     * Ask the receiver to insert a queue item itself, for when there is no
     * media session to call queueAppendItem / queueInsertItems on.
     *
     * Prod 2026-09-08 to 09-10: 21 appends found no media session and 6 failed
     * outright. The receiver resolves `next` against its real queue — this side
     * only ever sees a two-item window of it. Only offered when a fresh status
     * advertises queue-insert, so a receiver from #70 or earlier keeps today's
     * behaviour.
     */
    private sendReceiverQueueInsert(item: unknown, position: 'next' | 'end', title?: string): boolean {
        if (!receiverControlAvailable({
            caps: this.lastAuroraStatus?.caps,
            statusAgeMs: Date.now() - this.lastAuroraStatusAt,
            freshMs: this.auroraStatusFreshMs,
            capability: RECEIVER_QUEUE_INSERT_CAP,
        })) return false;
        const session = this.castContext?.getCurrentSession?.() || null;
        if (!session || typeof session.sendMessage !== 'function') return false;

        const label = `title=${title || 'unknown'}`;
        const receiverItem = toReceiverQueueItem(item);
        if (!receiverItem) {
            this.logCast('error', 'Cast queue insert refused: item has no playable URL', label);
            return false;
        }
        const requestId = ++this.auroraControlRequestId;
        const message = { type: 'aurora.queue.insert', requestId, position, items: [receiverItem] };
        if (JSON.stringify(message).length > RECEIVER_MESSAGE_MAX_BYTES) {
            this.logCast('error', 'Cast queue insert refused: message too large', label);
            return false;
        }

        // The contentId carries the media token, so it is never logged.
        const detail = `position=${position} requestId=${requestId} ${label}`;
        try {
            session.sendMessage(getAuroraStatusNamespace(session), message)
                .then(() => this.logCast('ok', 'Cast queue insert via receiver channel', detail))
                .catch((error: unknown) => this.logCast('error', 'Cast queue insert via receiver channel failed', `${detail} ${this.describeError(error)}`));
            return true;
        } catch (error) {
            this.logCast('error', 'Cast queue insert via receiver channel failed', `${detail} ${this.describeError(error)}`);
            return false;
        }
    }

    private trySeekViaMediaSession(time: number): boolean {
        const mediaSession = this.getMediaSession();
        const hasMediaSession = !!mediaSession && typeof mediaSession.seek === 'function';
        if (!hasMediaSession && this.sendReceiverControl('seek', { time })) return true;
        if (!isRemotePlayerStreamStale(this.msSinceRemotePlayerEvent())) return false;

        if (!hasMediaSession) {
            this.logCast('warn', 'Cast seek cannot reach the receiver', `playerSilentMs=${this.msSinceRemotePlayerEvent()} mediaSession=none`);
            return false;
        }
        const request = chrome.cast?.media?.SeekRequest ? new chrome.cast.media.SeekRequest() : null;
        if (!request) return false;

        try {
            request.currentTime = time;
            mediaSession.seek(
                request,
                () => this.logCast('ok', 'Cast seek via media session', `time=${time.toFixed(1)}`),
                (error: unknown) => this.handleControlError('seek via media session', error),
            );
            return true;
        } catch (error) {
            this.handleControlError('seek via media session', error);
            return false;
        }
    }

    private schedulePreservedSessionRejoin(sessionId: string, reason: string) {
        if (!sessionId) return;

        localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
        this.rejoinSessionPending = true;
        this.state = 'CONNECTING';
        this.notifyStateChange();
        this.setHealthStatus('recovering', 'Reconnecting Cast control...', reason);
        this.logCast('warn', 'Preserving Cast session after transport detach', `reason=${reason} stored=${sessionId}`);

        window.setTimeout(() => {
            if (this.castContext?.getCurrentSession?.()) return;

            try {
                chrome.cast.requestSessionById(sessionId);
                this.beginRejoinHydration(reason);
            } catch (error) {
                this.rejoinSessionPending = false;
                this.rejoinHydrationRunId += 1;
                localStorage.removeItem(SESSION_STORAGE_KEY);
                this.state = this.castContext?.getCastState?.() || 'NOT_CONNECTED';
                this.notifyStateChange();
                this.setHealthStatus('error', 'Could not reconnect Cast control.', this.describeError(error));
                this.logCast('error', `Preserved Cast session rejoin failed: ${reason}`, this.describeError(error));
            }
        }, 350);
    }

    private describeRemotePlayer(): string {
        if (!this.player) return 'remotePlayer=none';
        const queueItems = Array.isArray(this.player.queueData?.items) ? this.player.queueData.items.length : 0;
        return [
            `remoteConnected=${Boolean(this.player.isConnected)}`,
            `remoteLoaded=${Boolean(this.player.isMediaLoaded)}`,
            `remoteState=${this.player.playerState || 'unknown'}`,
            `remoteTitle=${this.player.title || 'unknown'}`,
            `remoteMediaInfo=${this.player.mediaInfo ? 'yes' : 'no'}`,
            `remoteQueueItems=${queueItems}`,
            `remoteTime=${typeof this.player.currentTime === 'number' ? this.player.currentTime.toFixed(1) : 'unknown'}`,
            `remoteDuration=${typeof this.player.duration === 'number' ? this.player.duration.toFixed(1) : 'unknown'}`,
        ].join(' ');
    }

    private async refreshMediaSessionStatus(reason: string): Promise<any | null> {
        const session = this.castContext?.getCurrentSession?.() || null;
        if (!session) return null;

        const sessionId = this.getSessionId(session);
        const mediaSession = session?.getMediaSession?.() || null;
        if (!mediaSession || typeof mediaSession.getStatus !== 'function') return this.getHydratableMediaSession(mediaSession);
        if (this.mediaStatusRefreshPromise) return this.mediaStatusRefreshPromise;

        this.mediaStatusRefreshPromise = new Promise<any | null>((resolve) => {
            let settled = false;
            let timeout: number | undefined;
            const finish = (nextMediaSession: any | null) => {
                if (settled) return;
                settled = true;
                if (timeout !== undefined) window.clearTimeout(timeout);
                const currentSession = this.castContext?.getCurrentSession?.() || null;
                const currentSessionId = this.getSessionId(currentSession);
                if (!currentSession || (sessionId && currentSessionId && currentSessionId !== sessionId)) {
                    this.logCast('warn', `Discarded stale Cast media status: ${reason}`, `expected=${sessionId || 'unknown'} current=${currentSessionId || 'none'}`);
                    resolve(null);
                    return;
                }

                resolve(this.getHydratableMediaSession(nextMediaSession || currentSession.getMediaSession?.() || mediaSession));
            };
            timeout = window.setTimeout(() => {
                this.logCast('warn', `Timed out refreshing Cast media status: ${reason}`);
                finish(session?.getMediaSession?.() || mediaSession);
            }, 2500);

            try {
                const request = chrome.cast?.media?.GetStatusRequest
                    ? new chrome.cast.media.GetStatusRequest()
                    : null;
                mediaSession.getStatus(
                    request,
                    () => {
                        this.logCast('ok', `Refreshed Cast media status: ${reason}`);
                        // A round trip got through, so the transport is not dead.
                        this.clearDeadTransport();
                        finish(session?.getMediaSession?.() || mediaSession);
                    },
                    (error: unknown) => {
                        this.logCast('warn', `Failed to refresh Cast media status: ${reason}`, this.describeError(error));
                        if (this.isDisconnectedPresentationError(error)) {
                            this.recoverStaleTransportAutomatically(`media-status:${reason}`, error);
                        }
                        finish(session?.getMediaSession?.() || mediaSession);
                    }
                );
            } catch (error) {
                this.logCast('warn', `Cast media status refresh threw: ${reason}`, this.describeError(error));
                if (this.isDisconnectedPresentationError(error)) {
                    this.recoverStaleTransportAutomatically(`media-status:${reason}`, error);
                }
                finish(session?.getMediaSession?.() || mediaSession);
            }
        }).finally(() => {
            this.mediaStatusRefreshPromise = null;
        });

        return this.mediaStatusRefreshPromise;
    }

    private beginRejoinHydration(reason: string) {
        this.rejoinSessionPending = true;
        const runId = this.rejoinHydrationRunId + 1;
        this.rejoinHydrationRunId = runId;
        this.rejoinHydrationAttempts = 0;
        this.clearRejoinHydrationTimer();
        this.logCast('ok', `Begin Cast hydration: ${reason}`);
        this.setHealthStatus('rejoining', 'Syncing with Cast session...', reason);
        void this.waitForRemoteSessionHydration(reason, runId);
    }

    private async waitForRemoteSessionHydration(reason: string, runId: number): Promise<void> {
        if (!this.rejoinSessionPending || runId !== this.rejoinHydrationRunId) return;

        const refreshedMediaSession = await this.refreshMediaSessionStatus(`hydration:${reason}`);
        const currentSession = this.castContext?.getCurrentSession?.() || null;
        if (!this.rejoinSessionPending || runId !== this.rejoinHydrationRunId) {
            this.logCast('warn', `Discarded stale Cast hydration: ${reason}`, `run=${runId} active=${this.rejoinHydrationRunId} hasSession=${Boolean(currentSession)}`);
            return;
        }

        const mediaSession =
            (currentSession
                ? refreshedMediaSession || this.getHydratableMediaSession(currentSession.getMediaSession?.() || null)
                : null)
            || null;
        if (this.hasActiveRemoteMediaSession(mediaSession)) {
            this.rejoinSessionPending = false;
            this.clearRejoinHydrationTimer();
            this.logCast('ok', `Remote media available during hydration: ${reason}`);
            await this.hydrateSenderFromRemoteSession(mediaSession, reason);
            this.setHealthStatus('recovered', 'Synced with Cast session.', this.getCastDeviceName());
            return;
        }

        if (this.rejoinHydrationAttempts >= this.maxRejoinHydrationAttempts) {
            this.rejoinSessionPending = false;
            this.clearRejoinHydrationTimer();
            const hasSession = !!this.castContext?.getCurrentSession?.();
            this.logCast('warn', `Remote session hydration timed out: ${reason}`, `hasSession=${hasSession}`);
            console.warn('[Cast] Remote session hydration timed out; not auto-casting stale local state');
            if (!hasSession) {
                localStorage.removeItem(SESSION_STORAGE_KEY);
                this.logCast('warn', `Cleared unreachable stored Cast session: ${reason}`);
                this.setHealthStatus('error', 'Cast session is no longer reachable.', reason);
                this.state = this.castContext?.getCastState?.() || 'NOT_CONNECTED';
                this.notifyStateChange();
            } else {
                this.setHealthStatus('warning', 'Cast session connected without active media.', reason);
            }
            return;
        }

        this.rejoinHydrationAttempts += 1;
        this.rejoinHydrationTimer = setTimeout(() => {
            void this.waitForRemoteSessionHydration(reason, runId);
        }, this.rejoinHydrationDelayMs);
    }

    public async reconcileActiveSession(reason: string = 'manual'): Promise<boolean> {
        if (!this.castContext || this.reconnectInProgress) return false;

        this.reconnectInProgress = true;
        try {
            const sdkState = this.castContext.getCastState?.();
            const startingSession = this.castContext.getCurrentSession?.() || null;
            // A page can come up already holding a session without any
            // SESSION_STATE_CHANGED firing — the reload case, where the media
            // already exists and no RemotePlayer event is coming. The listener
            // is idempotent per session id.
            if (startingSession) this.attachMediaSessionListener(startingSession);
            const refreshedMediaSession = startingSession
                ? await this.refreshMediaSessionStatus(`reconcile:${reason}`)
                : null;
            const session = startingSession ? this.castContext.getCurrentSession?.() || null : null;

            // The refresh found the transport dead and handed the session to
            // recovery. Carrying on would hydrate from the cached media object
            // and report "Reconciled active Cast session" over a dead
            // transport (prod 2026-10-10 16:16Z), so the answer is whatever
            // recovery concludes.
            if (startingSession && this.staleTransportRecoveryPromise) {
                this.logCast('warn', `Cast reconcile deferred to stale transport recovery: ${reason}`);
                return await this.staleTransportRecoveryPromise;
            }
            if (startingSession && this.isKnownDeadTransport()) {
                this.logCast('warn', `Skipped Cast reconcile on dead transport: ${reason}`);
                return false;
            }

            if (startingSession && !session) {
                this.logCast('warn', `Skipped stale Cast reconcile after session ended: ${reason}`);
                this.state = this.castContext?.getCastState?.() || 'NOT_CONNECTED';
                this.notifyStateChange();
                return false;
            }

            if (session) {
                const mediaSession = refreshedMediaSession || this.getHydratableMediaSession(session.getMediaSession?.() || null);
                const sessionId = session.getSessionId?.();
                if (sessionId) localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
                this.state = 'CONNECTED';
                this.notifyStateChange();
                this.setHealthStatus('connected', `Casting to ${this.getCastDeviceName() || 'device'}.`, reason);

                if (this.hasActiveRemoteMediaSession(mediaSession)) {
                    this.logCast('ok', `Reconciled active Cast session: ${reason}`);
                    this.userSessionRequestPending = false;
                    this.clearUserSessionIntentTimer();
                    await this.hydrateSenderFromRemoteSession(mediaSession, reason);
                    return true;
                }

                if (this.userSessionRequestPending) {
                    this.logCast('ok', `Reconciled fresh user Cast session without media: ${reason}`);
                    this.scheduleFreshSessionPlayback(`reconcile-user-launch:${reason}`);
                    return true;
                }

                this.logCast('warn', `Cast session exists without active media: ${reason}`, this.describeRemotePlayer());
                this.setHealthStatus('warning', 'Cast session connected without active media.', reason);
                return false;
            }

            // A stored session id used to drive chrome.cast.requestSessionById()
            // from here. Across 39 attempts in production it never once produced
            // a session — every one timed out and cleared the stored id — while
            // the SDK's own `resumeSavedSession` + ORIGIN_SCOPED auto-join
            // delivered SESSION_RESUMED 59 times over the same log. The manual
            // call is worse than useless: requestSessionById leaves a session
            // request pending inside the SDK long after our 3s budget gives up,
            // and a launcher tap landing on top of that is a candidate for the
            // INVALID_PARAMETER rejections seen at launch. Rely on auto-join;
            // the stored id is still used by the stale-transport recovery path,
            // which does work.

            if (sdkState && sdkState !== this.state) {
                this.state = sdkState;
                this.notifyStateChange();
            }
            return false;
        } finally {
            this.reconnectInProgress = false;
        }
    }

    private initializeCastApi() {
        if (this.castContext) return;
        if (!this.initializePromise) {
            this.initializePromise = this.initializeCastApiInternal().finally(() => {
                if (!this.castContext) {
                    this.initializePromise = null;
                }
            });
        }
    }

    private async ensureRuntimeConfigLoaded() {
        if (this.customAppId) return;
        if (!this.runtimeConfigPromise) {
            this.runtimeConfigPromise = fetch('/api/client-config')
                .then(async (response) => {
                    if (!response.ok) {
                        throw new Error(`client-config ${response.status}`);
                    }
                    return response.json() as Promise<{ castReceiverAppId?: string }>;
                })
                .then((data) => {
                    this.customAppId = (data.castReceiverAppId || '').trim();
                    if (this.customAppId) {
                        console.log('[Cast] Loaded runtime custom receiver app ID');
                    } else {
                        console.warn('[Cast] Runtime client config has no custom receiver app ID; falling back to Default Media Receiver');
                    }
                })
                .catch((error) => {
                    console.warn('[Cast] Failed to load runtime client config:', error);
                });
        }
        await this.runtimeConfigPromise;
    }

    private async initializeCastApiInternal() {
        if (this.castContext) return;

        await this.ensureRuntimeConfigLoaded();

        try {
            const receiverApplicationId = this.customAppId || chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID;
            console.log(`[Cast] Initializing sender with ${this.customAppId ? 'custom' : 'default'} receiver app ID: ${receiverApplicationId}`);
            cast.framework.CastContext.getInstance().setOptions({
                receiverApplicationId,
                autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
                resumeSavedSession: true,
                androidReceiverCompatible: true,
                language: navigator.language,
            });

            this.castContext = cast.framework.CastContext.getInstance();
            this.player = new cast.framework.RemotePlayer();
            this.playerController = new cast.framework.RemotePlayerController(this.player);

            // --- Cast state changes (device discovery) ---
            this.castContext.addEventListener(
                cast.framework.CastContextEventType.CAST_STATE_CHANGED,
                (event: any) => {
                    const prevState = this.state;
                    this.state = event.castState;
                    this.notifyStateChange();
                    this.lastCastStateChangeAt = Date.now();
                    this.logCast('ok', `CAST_STATE_CHANGED: ${prevState} -> ${this.state}`);
                    if (this.state === 'CONNECTED') {
                        this.setHealthStatus('connected', `Casting to ${this.getCastDeviceName() || 'device'}.`);
                    } else if (this.state === 'CONNECTING') {
                        this.setHealthStatus('rejoining', 'Connecting to Cast device...');
                    } else if (this.state === 'NOT_CONNECTED') {
                        this.setHealthStatus('idle', '');
                    }

                    // Fresh connection with no existing remote media: auto-cast local playback.
                    // Existing/resumed remote media must win over stale local sender state.
                    if (prevState !== 'CONNECTED' && this.state === 'CONNECTED' && !this.autoCastInProgress
                        && !this.leaveIfCastingElsewhere('cast-connected')) {
                        const mediaSession = this.getHydratableMediaSession(this.castContext.getCurrentSession?.()?.getMediaSession?.() || null);
                        if (this.hasActiveRemoteMediaSession(mediaSession)) {
                            this.userSessionRequestPending = false;
                            this.clearUserSessionIntentTimer();
                            void this.hydrateSenderFromRemoteSession(mediaSession, 'cast-connected');
                        } else if (this.userSessionRequestPending) {
                            this.scheduleFreshSessionPlayback('cast-connected-user-launch', 250);
                        } else if (this.shouldHydrateConnectedSessionAsRejoin()) {
                            this.beginRejoinHydration('cast-connected');
                        } else {
                            this.scheduleFreshSessionPlayback('cast-connected');
                        }
                    }
                }
            );

            // --- Session state changes (session lifecycle — per Google Cast docs) ---
            this.castContext.addEventListener(
                cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
                (event: any) => {
                    this.logCast('ok', 'SESSION_STATE_CHANGED', `sessionState=${event.sessionState || 'unknown'} errorCode=${event.errorCode || 'none'} reason=${event.reason || 'none'}`);
                    // Any new session or end supersedes a dead-transport verdict,
                    // even if the SDK were to hand back the same object.
                    if (
                        event.sessionState === cast.framework.SessionState.SESSION_STARTED
                        || event.sessionState === cast.framework.SessionState.SESSION_RESUMED
                        || event.sessionState === cast.framework.SessionState.SESSION_ENDED
                    ) {
                        this.clearDeadTransport();
                    }
                    switch (event.sessionState) {
                        case cast.framework.SessionState.SESSION_STARTING:
                            if (!this.rejoinSessionPending) {
                                this.freshSessionStartedAt = Date.now();
                            }
                            this.setHealthStatus('rejoining', 'Connecting to Cast device...');
                            break;

                        case cast.framework.SessionState.SESSION_STARTED:
                            this.resetCastEndIntent();
                            const storedSessionBeforeStart = this.getStoredSessionId();
                            const startedSession = this.castContext.getCurrentSession();
                            const startedSessionId = startedSession?.getSessionId?.() || '';
                            const treatStartedSessionAsRejoin =
                                this.rejoinSessionPending
                                && !this.userSessionRequestPending
                                && !this.isRecentFreshSessionStart()
                                && (!startedSessionId || !storedSessionBeforeStart || startedSessionId === storedSessionBeforeStart);

                            if (!treatStartedSessionAsRejoin) {
                                this.rejoinSessionPending = false;
                                this.freshSessionStartedAt = Date.now();
                            }
                            this.setHealthStatus('connected', `Casting to ${this.getCastDeviceName() || 'device'}.`);
                            // Store session ID for rejoin
                            const session = startedSession || this.castContext.getCurrentSession();
                            if (session) {
                                const sid = session.getSessionId();
                                if (sid) {
                                    localStorage.setItem(SESSION_STORAGE_KEY, sid);
                                    console.log('[Cast] Session started, stored ID:', sid);
                                    this.logCast('ok', 'SESSION_STARTED', `sid=${sid}`);
                                }
                            }
                            this.attachMediaSessionListener(session);
                            if (treatStartedSessionAsRejoin) {
                                this.beginRejoinHydration('session-started');
                            } else if (this.userSessionRequestPending) {
                                this.scheduleFreshSessionPlayback('session-started', 250);
                            } else {
                                this.scheduleFreshSessionPlayback('session-started', 250);
                            }
                            break;

                        case cast.framework.SessionState.SESSION_RESUMED:
                            this.resetCastEndIntent();
                            this.state = this.castContext.getCastState();
                            this.notifyStateChange();
                            this.logCast('ok', 'SESSION_RESUMED');
                            this.setHealthStatus('rejoining', 'Resuming Cast session...');
                            // Re-store the session ID
                            const resumedSession = this.castContext.getCurrentSession();
                            if (resumedSession) {
                                const sid = resumedSession.getSessionId();
                                if (sid) localStorage.setItem(SESSION_STORAGE_KEY, sid);
                            }
                            this.attachMediaSessionListener(resumedSession);
                            this.beginRejoinHydration('session-resumed');
                            break;

                        case cast.framework.SessionState.SESSION_START_FAILED:
                            // chrome.cast.Error carries code/description/details, but this
                            // event exposes only the code — prod logged `reason=unknown` on
                            // every occurrence. Record the surrounding state instead, so the
                            // next failure shows whether it landed during device-discovery
                            // churn or on top of an in-flight rejoin.
                            this.logCast(
                                'warn',
                                'SESSION_START_FAILED',
                                `errorCode=${event.errorCode || 'unknown'} reason=${event.reason || 'unknown'}`
                                + ` castState=${this.castContext?.getCastState?.() || 'unknown'}`
                                + ` msSinceCastStateChange=${this.lastCastStateChangeAt ? Date.now() - this.lastCastStateChangeAt : -1}`
                                + ` userIntentPending=${this.userSessionRequestPending} rejoinPending=${this.rejoinSessionPending}`,
                            );
                            this.clearUserSessionIntentTimer();
                            // Dismissing the device picker reports errorCode CANCEL — benign, stay
                            // silent. Surface a concise recovery message only for real failures, and
                            // only when the programmatic requestSession() path isn't already going to
                            // toast (it owns the message while userSessionRequestPending is set).
                            if (event.errorCode && event.errorCode !== chrome.cast.ErrorCode.CANCEL && !this.userSessionRequestPending) {
                                toast.error('Couldn’t start casting. Check the device is on and on the same network, then try again.');
                            }
                            this.resetSessionAttemptState('session-start-failed', {
                                healthPhase: 'idle',
                                healthMessage: '',
                            });
                            break;

                        case cast.framework.SessionState.SESSION_RESUME_FAILED:
                            this.logCast('warn', 'SESSION_RESUME_FAILED', `errorCode=${event.errorCode || 'unknown'} reason=${event.reason || 'unknown'}`);
                            this.clearUserSessionIntentTimer();
                            this.resetSessionAttemptState('session-resume-failed', {
                                clearStoredSession: true,
                                healthPhase: 'warning',
                                healthMessage: 'Previous Cast session is no longer reachable.',
                            });
                            break;

                        case cast.framework.SessionState.SESSION_ENDING:
                            this.logCast('ok', 'SESSION_ENDING');
                            this.setHealthStatus('rejoining', 'Stopping Cast session...');
                            break;
                        case cast.framework.SessionState.SESSION_ENDED: {
                            console.log('[Cast] Session ended');
                            this.logCast('ok', 'SESSION_ENDED');
                            // Where the Cast device was, taken before the
                            // state change below drops the position anchor.
                            const endSnapshot = this.castEndSnapshotAtStop ?? this.captureCastEndSnapshot();
                            if (this.preserveSessionOnNextEnd) {
                                this.preserveSessionOnNextEnd = false;
                                const preservedSessionId =
                                    this.getSessionId(event.session || null)
                                    || this.getCurrentSessionId()
                                    || this.getStoredSessionId();
                                this.freshSessionStartedAt = 0;
                                this.suppressRemoteEndedDuringDisconnect = false;

                                if (!preservedSessionId) {
                                    this.logCast('warn', 'Could not preserve ended Cast session because no session id was available');
                                    localStorage.removeItem(SESSION_STORAGE_KEY);
                                    this.rejoinSessionPending = false;
                                    this.rejoinHydrationRunId += 1;
                                    this.clearRejoinHydrationTimer();
                                    this.state = 'NOT_CONNECTED';
                                    this.setHealthStatus('idle', '');
                                    this.notifyStateChange();
                                    break;
                                }

                                localStorage.setItem(SESSION_STORAGE_KEY, preservedSessionId);

                                if (this.staleTransportRecoveryPromise || this.rejoinSessionPending) {
                                    this.state = 'CONNECTING';
                                    this.setHealthStatus('recovering', 'Reconnecting Cast control...', 'stale-transport-detach-ended');
                                    this.notifyStateChange();
                                    this.logCast('warn', 'SESSION_ENDED preserved during stale transport recovery', `stored=${preservedSessionId || 'none'}`);
                                    break;
                                }

                                this.schedulePreservedSessionRejoin(preservedSessionId, 'stale-transport-detach-ended');
                                break;
                            } else {
                                localStorage.removeItem(SESSION_STORAGE_KEY);
                            }
                            this.rejoinSessionPending = false;
                            this.freshSessionStartedAt = 0;
                            this.clearUserSessionIntentTimer();
                            this.suppressRemoteEndedDuringDisconnect = false;
                            this.rejoinHydrationRunId += 1;
                            this.clearRejoinHydrationTimer();
                            this.state = 'NOT_CONNECTED';
                            this.setHealthStatus('idle', '');
                            this.notifyStateChange();
                            this.afterSessionEnded(endSnapshot);
                            break;
                        }
                    }
                }
            );

            // --- Remote player connection changes (e.g., stopped from Google Home) ---
            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED,
                () => {
                    this.logCast(
                        this.player.isConnected ? 'ok' : 'warn',
                        'REMOTE_PLAYER_CONNECTED_CHANGED',
                        `isConnected=${this.player.isConnected}`
                    );
                    if (!this.player.isConnected) {
                        console.log('[Cast] Remote player disconnected');
                        this.logCast('warn', 'Remote player disconnected');
                        if (this.rejoinSessionPending || this.staleTransportRecoveryPromise) {
                            this.state = 'CONNECTING';
                            this.setHealthStatus('recovering', 'Reconnecting Cast control...', 'remote-player-disconnected-during-rejoin');
                            this.notifyStateChange();
                            this.logCast('warn', 'Remote player disconnect preserved during Cast reconnect');
                            return;
                        }
                        localStorage.removeItem(SESSION_STORAGE_KEY);
                        this.rejoinSessionPending = false;
                        this.rejoinHydrationRunId += 1;
                        this.clearRejoinHydrationTimer();
                        this.state = 'NOT_CONNECTED';
                        // Leaving another device's Cast session on purpose
                        // (cast-join-left) disconnects too; that is no failure.
                        if (isOwnLeaveDisconnect(this.leftJoinedSessionAt, Date.now())) this.setHealthStatus('idle', '');
                        else this.setHealthStatus('error', 'Cast device disconnected.');
                        this.notifyStateChange();
                    }
                }
            );

            // Set initial state
            this.state = this.castContext.getCastState();
            this.notifyStateChange();

            // --- Player state events ---
            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.IS_PAUSED_CHANGED,
                () => {
                    this.publishPlayState(!this.player.isPaused);
                }
            );

            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED,
                () => {
                    this.lastRemotePlayerEventAt = Date.now();
                    this.lastRemoteEvidenceAt = Date.now();
                    if (!this.mediaMatchesCurrentTrack(this.player?.mediaInfo)) return;
                    this.lastRemotePositionAt = Date.now();
                    this.lastRemotePositionEntryId = this.currentEntryId();
                    if (this.confirmationLoadAccepted) this.playbackConfirmation.observe({ entryId: this.currentEntryId(), playerState: this.player.playerState, currentTime: this.player.currentTime });
                    this.publishPosition(this.player.currentTime);
                }
            );

            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.DURATION_CHANGED,
                () => {
                    if (this.remotePositionMatchesTrack()) this.publishDuration(this.player.duration);
                }
            );

            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.PLAYER_STATE_CHANGED,
                () => {
                    this.lastRemotePlayerEventAt = Date.now();
                    this.lastRemoteEvidenceAt = Date.now();
                    const mediaSession = this.getHydratableMediaSession();
                    const stateKey = `state=${this.player.playerState || 'unknown'} idleReason=${mediaSession?.idleReason || 'none'} paused=${this.player.isPaused}`;
                    if (stateKey !== this.lastRemotePlayerStateKey) {
                        this.lastRemotePlayerStateKey = stateKey;
                        this.logCast('ok', 'REMOTE_PLAYER_STATE_CHANGED', stateKey);
                    }
                    if (this.hasActiveRemoteMediaSession(mediaSession)) {
                        void this.hydrateSenderFromRemoteSession(mediaSession, 'remote-player-state-changed');
                    }
                    if (this.player.playerState === chrome.cast.media.PlayerState.IDLE) {
                        // idleReason is only available on the media session, not RemotePlayer
                        try {
                            if (mediaSession?.idleReason === chrome.cast.media.IdleReason.FINISHED) {
                                if (this.suppressRemoteEndedDuringDisconnect || this.playbackConfirmation.unconfirmed) return;
                                this.onEnded?.();
                            }
                        } catch { /* ignore */ }
                    }
                }
            );

            // --- Volume sync from receiver → sender (per Google Cast docs) ---
            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.VOLUME_LEVEL_CHANGED,
                () => {
                    this.onVolumeChange?.(this.player.volumeLevel);
                    void this.refreshMediaSessionStatus('volume-level-changed')
                        .then((mediaSession) => this.hydrateSenderFromRemoteSession(mediaSession, 'volume-level-changed'));
                }
            );

            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.IS_MUTED_CHANGED,
                () => {
                    this.onMuteChange?.(this.player.isMuted);
                    void this.refreshMediaSessionStatus('mute-changed')
                        .then((mediaSession) => this.hydrateSenderFromRemoteSession(mediaSession, 'mute-changed'));
                }
            );

            // --- Queue change events (receiver auto-advances tracks) ---
            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.MEDIA_INFO_CHANGED,
                () => {
                    if (!this.isConnected()) return;
                    try {
                        // Track-identity sync must read the REAL media session.
                        // Around item transitions it can be transiently null;
                        // the synthetic RemotePlayer snapshot carries no queue
                        // identity, so syncing from it is wasted work — the
                        // next status refires this event with a real session.
                        const mediaSession = this.getMediaSession();
                        if (!mediaSession) return;
                        this.logCast('ok', 'REMOTE_MEDIA_INFO_CHANGED', this.describeMediaSession(mediaSession));
                        this.syncCurrentTrackFromSession(mediaSession);
                    } catch { /* ignore */ }
                }
            );

            // Not present in current Web Sender SDKs (registering undefined
            // never fires) — guarded so it activates if the SDK adds it.
            if (cast.framework.RemotePlayerEventType.MEDIA_STATUS_CHANGED) {
                this.playerController.addEventListener(
                    cast.framework.RemotePlayerEventType.MEDIA_STATUS_CHANGED,
                    () => {
                        try {
                            const mediaSession = this.getMediaSession();
                            if (!mediaSession) return;
                            const statusKey = this.describeMediaSession(mediaSession);
                            if (statusKey !== this.lastRemoteMediaStatusKey) {
                                this.lastRemoteMediaStatusKey = statusKey;
                                this.logCast('ok', 'REMOTE_MEDIA_STATUS_CHANGED', statusKey);
                            }
                            this.syncCurrentTrackFromSession(mediaSession);
                        } catch { /* ignore */ }
                    }
                );
            }

            if (cast.framework.RemotePlayerEventType.IS_MEDIA_LOADED_CHANGED) {
                this.playerController.addEventListener(
                    cast.framework.RemotePlayerEventType.IS_MEDIA_LOADED_CHANGED,
                    () => {
                        const mediaSession = this.getHydratableMediaSession();
                        this.logCast('ok', 'REMOTE_MEDIA_LOADED_CHANGED', `${this.describeRemotePlayer()} ${this.describeMediaSession(mediaSession)}`);
                        if (this.hasActiveRemoteMediaSession(mediaSession)) {
                            void this.hydrateSenderFromRemoteSession(mediaSession, 'remote-media-loaded-changed');
                        }
                    }
                );
            }

            if (cast.framework.RemotePlayerEventType.QUEUE_DATA_CHANGED) {
                this.playerController.addEventListener(
                    cast.framework.RemotePlayerEventType.QUEUE_DATA_CHANGED,
                    () => {
                        const mediaSession = this.getHydratableMediaSession();
                        this.logCast('ok', 'REMOTE_QUEUE_DATA_CHANGED', `${this.describeRemotePlayer()} ${this.describeMediaSession(mediaSession)}`);
                        if (this.hasActiveRemoteMediaSession(mediaSession)) {
                            void this.hydrateSenderFromRemoteSession(mediaSession, 'remote-queue-data-changed');
                        }
                    }
                );
            }

            // --- Try to rejoin an existing session on init ---
            this.tryRejoinSession();
            this.scheduleSessionReconcile('cast-init');

        } catch (e) {
            console.error("Failed to initialize Google Cast API", e);
            this.logCast('error', 'Failed to initialize Google Cast API', this.describeError(e));
            toast.error('Failed to initialize Google Cast. Please refresh and try again.');
        }
    }

    private getRepeatMode(repeat: 'none' | 'one' | 'all'): any {
        if (repeat === 'one') return chrome.cast.media.RepeatMode.SINGLE;
        if (repeat === 'all') return chrome.cast.media.RepeatMode.ALL;
        return chrome.cast.media.RepeatMode.OFF;
    }

    private getMediaSession(): any | null {
        return this.castContext?.getCurrentSession?.()?.getMediaSession?.() || null;
    }

    private ensureStoreQueueEntryIds() {
        const state = usePlayerStore.getState();
        const normalized = ensureQueueEntryIds(state.playlist);
        if (normalized.changed) {
            usePlayerStore.setState({ playlist: normalized.tracks });
        }
        return normalized.tracks;
    }

    private buildMediaInfo(track: {
        queueEntryId?: string;
        url?: string;
        rawUrl?: string;
        title?: string;
        artist?: string;
        artUrl?: string;
        album?: string;
        format?: string;
        duration?: number;
        startTime?: number;
    }, options?: {
        includeAuthTokenInCustomData?: boolean;
        includeArtwork?: boolean;
        includeDuration?: boolean;
        compactHlsUrl?: boolean;
    }) {
        const includeAuthTokenInCustomData = options?.includeAuthTokenInCustomData ?? true;
        const includeArtwork = options?.includeArtwork ?? true;
        const includeDuration = options?.includeDuration ?? true;
        const compactHlsUrl = options?.compactHlsUrl ?? false;
        const streamingQuality = usePlayerStore.getState().streamingQuality;
        // The custom receiver stays on the proven fixed AAC HLS path. Browser
        // Auto ABR and Source passthrough are intentionally local-only.
        const useHls = !!this.customAppId;
        const effectiveHlsUrl = useHls
            ? applyCastStreamingQualityToHlsUrl(track.url || '', streamingQuality)
            : applyStreamingQualityToHlsUrl(track.url || '', streamingQuality);
        let mediaUrl = useHls ? (effectiveHlsUrl || track.rawUrl || '') : (track.rawUrl || effectiveHlsUrl || '');
        if (useHls) {
            if (compactHlsUrl) {
                mediaUrl = stripQueryParam(mediaUrl, 'token');
            }
            try {
                const url = new URL(mediaUrl);
                url.searchParams.set('codec', CUSTOM_RECEIVER_HLS_CODEC);
                mediaUrl = url.toString();
            } catch { /* ignore */ }
        }
        const contentType = useHls ? 'application/vnd.apple.mpegurl' : inferContentType(mediaUrl, track.format);
        const mediaInfo = new chrome.cast.media.MediaInfo(mediaUrl, contentType);
        mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;
        if (useHls && chrome.cast.media.HlsSegmentFormat?.TS) {
            mediaInfo.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat.TS;
        }
        mediaInfo.metadata = new chrome.cast.media.MusicTrackMediaMetadata();
        mediaInfo.metadata.title = track.title || 'Unknown Title';
        mediaInfo.metadata.artist = track.artist || 'Unknown Artist';
        if (track.album) mediaInfo.metadata.albumName = track.album;
        const castImageUrl = includeArtwork ? this.getCastImageUrl(track.artUrl) : '';
        if (castImageUrl) mediaInfo.metadata.images = [new chrome.cast.Image(castImageUrl)];
        if (includeDuration && typeof track.duration === 'number' && isFinite(track.duration) && track.duration > 0) {
            mediaInfo.metadata.duration = track.duration;
        }

        const customData: Record<string, any> = {};
        if (track.queueEntryId) {
            customData.queueEntryId = track.queueEntryId;
        }
        if (useHls) {
            const authToken = this.extractTokenFromUrl(mediaUrl);
            if (includeAuthTokenInCustomData && authToken) customData.token = authToken;
            customData.codec = CUSTOM_RECEIVER_HLS_CODEC;
        }
        customData.diagnosticsVerbose = this.diagnosticsVerbose;
        if (Object.keys(customData).length > 0) {
            mediaInfo.customData = customData;
        }
        return mediaInfo;
    }

    private buildQueueItem(track: {
        queueEntryId?: string;
        url?: string;
        rawUrl?: string;
        title?: string;
        artist?: string;
        artUrl?: string;
        album?: string;
        format?: string;
        duration?: number;
        startTime?: number;
    }, options?: {
        includeAuthTokenInCustomData?: boolean;
        includeArtwork?: boolean;
        includeDuration?: boolean;
        compactHlsUrl?: boolean;
    }) {
        const item = new chrome.cast.media.QueueItem(this.buildMediaInfo(track, options));
        item.autoplay = true;
        if (typeof track.startTime === 'number' && isFinite(track.startTime) && track.startTime > 0) {
            item.startTime = track.startTime;
        }
        item.preloadTime = 30;
        return item;
    }

    private syncQueueItemMapFromSession(mediaSession: any | null = this.getMediaSession()) {
        if (!this.queueWindow) this.queueItemIdByEntryId.clear();
        const items = mediaSession?.items;
        if (!Array.isArray(items)) return;
        for (const item of items) {
            const queueEntryId = item?.media?.customData?.queueEntryId;
            if (queueEntryId && typeof item.itemId === 'number') {
                this.queueItemIdByEntryId.set(queueEntryId, item.itemId);
            }
        }
    }

    private getSessionQueueEntryIds(mediaSession: any | null = this.getMediaSession()): string[] {
        const items = mediaSession?.items;
        if (!Array.isArray(items)) return [];
        return items
            .map((item: any) => item?.media?.customData?.queueEntryId)
            .filter((entryId: string | undefined): entryId is string => !!entryId);
    }

    private getCurrentQueueEntryId(mediaSession: any | null = this.getMediaSession()): string | null {
        // A recent receiver push is the most reliable source there is: the SDK
        // strips customData from relayed queue items, so the lookups below
        // almost always fall through on this receiver.
        if (this.lastAuroraStatus?.queueEntryId && Date.now() - this.lastAuroraStatusAt < this.auroraStatusFreshMs) {
            return this.lastAuroraStatus.queueEntryId;
        }
        if (!mediaSession) return null;
        const currentItemId = mediaSession.currentItemId;
        if (typeof currentItemId === 'number' && Array.isArray(mediaSession.items)) {
            const currentItem = mediaSession.items.find((item: any) => item?.itemId === currentItemId);
            const currentEntryId = currentItem?.media?.customData?.queueEntryId;
            if (currentEntryId) return currentEntryId;
        }
        return mediaSession.media?.customData?.queueEntryId || null;
    }

    private beginPlaybackConfirmation(session: unknown, entryId: string, time: number): void {
        this.confirmationLoadAccepted = false;
        this.positionAnchor = { position: time, atMs: Date.now(), entryId };
        this.previousPlaybackEntryId = this.lastAuroraStatus?.queueEntryId || this.getCurrentQueueEntryId();
        this.playbackRetry = null;
        this.playbackConfirmation.start({
            entryId,
            isCurrent: () => this.isConnected() && session === this.castContext?.getCurrentSession?.() && this.currentEntryId() === entryId,
            retry: async () => {
                const state = usePlayerStore.getState();
                const index = state.playlist.findIndex(track => track.queueEntryId === entryId);
                if (index >= 0) await this.castQueue(state.playlist, index, state.repeat, time, true);
            },
            confirmed: (attempt, elapsedMs) => {
                usePlayerStore.setState({ castPlaybackStatus: null, isBuffering: false });
                this.queueLoadRetry = null;
                this.playbackRetry = null;
                this.logCast('ok', 'playback-confirmed', `entryId=${entryId} elapsedMs=${elapsedMs} attempt=${attempt}`);
                this.setHealthStatus('connected', `Casting to ${this.getCastDeviceName() || 'device'}.`);
                this.publishPlayState(true);
                // Edits made while starting were held back; apply them now.
                void this.reconcileQueueWindow();
            },
            pausedElsewhere: (attempt, elapsedMs) => {
                usePlayerStore.setState({ castPlaybackStatus: null, isBuffering: false });
                this.queueLoadRetry = null;
                this.playbackRetry = null;
                this.logCast('ok', 'playback-paused-before-confirmation', `entryId=${entryId} elapsedMs=${elapsedMs} attempt=${attempt}`);
                this.setHealthStatus('connected', `Casting to ${this.getCastDeviceName() || 'device'}.`);
                this.publishPlayState(false);
                void this.reconcileQueueWindow();
            },
            extended: (elapsedMs) => {
                this.logCast('warn', 'playback-confirmation-extended', `entryId=${entryId} elapsedMs=${elapsedMs} reason=entry-already-starting`);
            },
            failed: (attempt, elapsedMs) => {
                this.playbackRetry = { session, entryId, time };
                usePlayerStore.setState({ castPlaybackStatus: 'unconfirmed', isBuffering: false, playbackState: 'paused' });
                this.logCast('error', 'playback-unconfirmed', `entryId=${entryId} elapsedMs=${elapsedMs} attempt=${attempt}`);
                this.setHealthStatus('error', 'Playback did not start on the Cast device. Retry to try again.');
            },
            cancelled: () => {
                usePlayerStore.setState({ castPlaybackStatus: null, isBuffering: false });
            },
        });
        // No words while starting: the play button's spinner is the feedback
        // (Andreas, 2026-10-13). 'starting' keeps that spinner on until the
        // receiver confirms; no surface renders text for it, and the Cast icon
        // is left alone. Only a failed start says anything.
        usePlayerStore.setState({ castPlaybackStatus: 'starting', isBuffering: true });
    }

    private publishPlayState(playing: boolean): void {
        if (!this.playbackConfirmation.unconfirmed) this.onPlayStateChange?.(playing);
    }

    private currentEntryId(): string | null {
        const state = usePlayerStore.getState();
        return state.currentIndex === null ? null : state.playlist[state.currentIndex]?.queueEntryId || null;
    }

    private mediaMatchesCurrentTrack(media: { customData?: { queueEntryId?: string }; contentId?: string } | null | undefined): boolean {
        const expected = this.currentEntryId();
        if (!expected || !media) return false;
        if (media.customData?.queueEntryId) return media.customData.queueEntryId === expected;
        const url = this.normalizeCastUrlForMatch(media.contentId);
        if (!url) return false;
        const state = usePlayerStore.getState();
        // Legacy relays strip customData. URL matching is safe only when that
        // URL identifies exactly one queue occurrence, including duplicates.
        const matches = state.playlist.filter(track => [track.rawUrl,
            applyCastStreamingQualityToHlsUrl(track.url || '', state.streamingQuality)]
            .some(candidate => candidate && this.normalizeCastUrlForMatch(candidate) === url));
        return matches.length === 1 && matches[0].queueEntryId === expected;
    }

    private remotePositionMatchesTrack(): boolean {
        return this.lastRemotePositionEntryId === this.currentEntryId() && this.mediaMatchesCurrentTrack(this.player?.mediaInfo);
    }

    private chooseCurrentPosition(mediaSession: any) {
        const state = usePlayerStore.getState();
        const track = state.currentIndex === null ? null : state.playlist[state.currentIndex];
        const receiver = this.lastAuroraStatus;
        const receiverMatches = receiver?.queueEntryId === this.currentEntryId() && Date.now() - this.lastAuroraStatusAt < this.auroraStatusFreshMs;
        const mediaMatches = this.mediaMatchesCurrentTrack(mediaSession?.media);
        return pickRemotePosition({
            playerTime: this.player?.currentTime, playerDuration: this.player?.duration,
            playerMatchesTrack: this.remotePositionMatchesTrack(),
            sessionTime: receiverMatches ? receiver?.currentTime : mediaSession?.currentTime,
            sessionDuration: receiverMatches ? receiver?.duration : mediaSession?.media?.duration,
            sessionMatchesTrack: receiverMatches || mediaMatches,
            fallbackDuration: track?.duration,
            sessionIsSynthetic: !receiverMatches && mediaSession?.__source === 'remote-player',
            msSinceRemotePlayerEvent: Date.now() - this.lastRemotePositionAt,
        });
    }

    private normalizeTextForMatch(value: unknown): string {
        return typeof value === 'string' ? value.trim().toLowerCase() : '';
    }

    private normalizeCastUrlForMatch(value: unknown): string {
        if (typeof value !== 'string' || !value) return '';
        try {
            const parsed = new URL(value, window.location.origin);
            parsed.searchParams.delete('token');
            parsed.searchParams.delete('codec');
            return parsed.toString();
        } catch {
            return value.replace(/([?&](token|codec)=)[^&\s]+/g, '').replace(/[?&]$/, '');
        }
    }

    private describeMediaSession(mediaSession: any | null = this.getMediaSession()): string {
        if (!mediaSession) return 'mediaSession=none';
        const metadata = mediaSession.media?.metadata || {};
        return [
            `playerState=${mediaSession.playerState || this.player?.playerState || 'unknown'}`,
            `idleReason=${mediaSession.idleReason || 'none'}`,
            `currentItemId=${typeof mediaSession.currentItemId === 'number' ? mediaSession.currentItemId : 'none'}`,
            `currentItemIndex=${typeof mediaSession.currentItemIndex === 'number' ? mediaSession.currentItemIndex : 'none'}`,
            `items=${Array.isArray(mediaSession.items) ? mediaSession.items.length : 0}`,
            `title=${metadata.title || 'unknown'}`,
            `artist=${metadata.artist || 'unknown'}`,
            `time=${typeof this.player?.currentTime === 'number' ? this.player.currentTime.toFixed(1) : 'unknown'}`,
        ].join(' ');
    }

    private resolveTrackIndexFromSession(mediaSession: any | null = this.getMediaSession(), playlist = usePlayerStore.getState().playlist): number | null {
        if (!mediaSession) return null;

        const currentQueueEntryId = this.getCurrentQueueEntryId(mediaSession);
        if (currentQueueEntryId) {
            const index = playlist.findIndex((track) => track.queueEntryId === currentQueueEntryId);
            if (index >= 0) return index;
        }

        const fallbackIndex = mediaSession.media?.metadata?.index;
        if (!this.queueWindow && typeof fallbackIndex === 'number' && fallbackIndex >= 0 && fallbackIndex < playlist.length) {
            return fallbackIndex;
        }

        // During a track change the top-level `media` still describes the item
        // that just finished, so matching on it resolves to the previous track,
        // equals the stored index, and updates nothing — the queue keeps the old
        // row highlighted until something forces a fresh status. The item named
        // by `currentItemId` is the authoritative one, so prefer its contentId.
        const currentItemId = mediaSession.currentItemId;
        const currentItem = typeof currentItemId === 'number' && Array.isArray(mediaSession.items)
            ? mediaSession.items.find((item: any) => item?.itemId === currentItemId)
            : null;
        const mediaUrl = this.normalizeCastUrlForMatch(
            currentItem?.media?.contentId || mediaSession.media?.contentId,
        );
        if (mediaUrl) {
            const streamingQuality = usePlayerStore.getState().streamingQuality;
            const urlIndex = playlist.findIndex((track) => {
                const hlsUrl = track.url
                    ? this.normalizeCastUrlForMatch(applyCastStreamingQualityToHlsUrl(track.url, streamingQuality))
                    : '';
                const rawUrl = this.normalizeCastUrlForMatch(track.rawUrl);
                return (!!hlsUrl && hlsUrl === mediaUrl) || (!!rawUrl && rawUrl === mediaUrl);
            });
            if (urlIndex >= 0) {
                // Only log when the mapping actually moves the index — this
                // path runs on every status update (entry-id matching doesn't
                // survive this receiver's statuses) and was posting thousands
                // of identical lines per day.
                if (urlIndex !== usePlayerStore.getState().currentIndex) {
                    this.logCast('ok', 'Mapped Cast session item by media URL', `index=${urlIndex}`);
                }
                return urlIndex;
            }
        }

        const metadata = mediaSession.media?.metadata || {};
        const mediaTitle = this.normalizeTextForMatch(metadata.title);
        const mediaArtist = this.normalizeTextForMatch(metadata.artist);
        if (mediaTitle) {
            const matches = playlist
                .map((track, index) => {
                    const title = this.normalizeTextForMatch(track.title);
                    const artist = this.normalizeTextForMatch(
                        track.artist || (Array.isArray(track.artists) ? track.artists.join(', ') : track.artists)
                    );
                    return { index, title, artist };
                })
                .filter((candidate) => (
                    candidate.title === mediaTitle
                    && (!mediaArtist || !candidate.artist || candidate.artist === mediaArtist)
                ));
            if (matches.length === 1) {
                this.logCast('ok', 'Mapped Cast session item by metadata', `index=${matches[0].index} title=${metadata.title || 'unknown'}`);
                return matches[0].index;
            }
        }

        return null;
    }

    private mapCastPlayerState(playerState: any): 'playing' | 'paused' | 'stopped' {
        if (playerState === chrome.cast.media.PlayerState.PLAYING) return 'playing';
        if (playerState === chrome.cast.media.PlayerState.PAUSED) return 'paused';
        return 'stopped';
    }

    private getImageUrlFromMediaSession(mediaSession: any | null): string | undefined {
        const image = mediaSession?.media?.metadata?.images?.[0];
        return image?.url || image;
    }

    private getCastMediaSessionSnapshot(
        mediaSession: any | null = this.getMediaSession(),
        playlist = usePlayerStore.getState().playlist,
        sessionIndex: number | null = this.resolveTrackIndexFromSession(mediaSession, playlist)
    ): {
        track: Partial<TrackInfo> & { title?: string; artist?: string; album?: string; artUrl?: string; duration?: number };
        position: number | null;
        duration: number | null;
        playbackState: 'playing' | 'paused' | 'stopped';
    } | null {
        if (!mediaSession) return null;

        const media = mediaSession.media || {};
        const metadata = media.metadata || {};
        const storeTrack = sessionIndex !== null ? playlist[sessionIndex] : null;
        const choice = !this.playbackConfirmation.unconfirmed && sessionIndex === usePlayerStore.getState().currentIndex
            ? this.chooseCurrentPosition(mediaSession)
            : { currentTime: null, duration: storeTrack?.duration ?? null, source: 'none' as const };
        const playerState = mediaSession.playerState || this.player?.playerState;

        return {
            track: {
                ...storeTrack,
                title: storeTrack?.title || metadata.title || 'Unknown Title',
                artist: storeTrack?.artist || metadata.artist || 'Unknown Artist',
                album: storeTrack?.album || metadata.albumName || '',
                artUrl: storeTrack?.artUrl || this.getImageUrlFromMediaSession(mediaSession),
                duration: choice.duration ?? storeTrack?.duration,
            },
            position: choice.currentTime,
            duration: choice.duration,
            playbackState: this.playbackConfirmation.unconfirmed ? 'paused' : this.mapCastPlayerState(playerState),
        };
    }

    private syncBrowserMediaSessionFromCast(
        mediaSession: any | null = this.getMediaSession(),
        sessionIndex: number | null = this.resolveTrackIndexFromSession(mediaSession)
    ): void {
        const snapshot = this.getCastMediaSessionSnapshot(mediaSession, usePlayerStore.getState().playlist, sessionIndex);
        if (!snapshot) return;
        playbackManager.syncMediaSessionFromTrack(snapshot.track, {
            playbackState: snapshot.playbackState,
            position: snapshot.position ?? undefined,
            duration: snapshot.duration ?? undefined,
            // Forcing a position we do not trust would push the frozen value
            // onto the lock screen as well as the in-app bar.
            forcePosition: snapshot.position !== null,
        });
    }

    public doesSessionTrackMatchStore(): boolean {
        const state = usePlayerStore.getState();
        if (state.currentIndex === null) return false;
        const sessionIndex = this.resolveTrackIndexFromSession(this.getHydratableMediaSession(), state.playlist);
        return sessionIndex === state.currentIndex;
    }

    private async hydrateSenderFromRemoteSession(mediaSession: any | null = null, reason: string = 'remote-session'): Promise<boolean> {
        // Leaving another device's Cast session: its state is not this
        // device's. Taking it on set the store to "playing" for a moment, and
        // the sync mirror claimed the output from the device that casts
        // (prod 2026-10-14 19:59:24).
        if (this.leftJoinedSession) return false;
        mediaSession = this.getHydratableMediaSession(mediaSession);
        if (!mediaSession || !this.hasActiveRemoteMediaSession(mediaSession)) return false;

        // With no Cast session there is nothing to hydrate from: the remote
        // player still describes the session that just ended for a moment
        // (IS_MEDIA_LOADED_CHANGED ~10 ms after SESSION_ENDED, or a hydration
        // that began before the end). Going on would pause the local player
        // the end-of-session handoff has just started (prod 2026-10-13
        // 18:27:59, sid=none). A new or resumed session hydrates with its own.
        if (!this.castContext?.getCurrentSession?.()) {
            this.logCast('ok', 'hydrate-skipped-no-session', `reason=${reason}`);
            return false;
        }

        // Stop any stale local playback before hydrating sender state from Cast.
        try {
            playbackManager.getLocalAudioElement().pause();
        } catch { /* ignore */ }

        if (this.playbackConfirmation.unconfirmed && !this.mediaMatchesCurrentTrack(mediaSession.media)) return false;
        if (this.confirmationLoadAccepted && mediaSession.__source !== 'remote-player' && this.mediaMatchesCurrentTrack(mediaSession.media)) {
            this.playbackConfirmation.observe({ entryId: this.currentEntryId(), playerState: mediaSession.playerState, currentTime: mediaSession.currentTime });
        }
        const trackSynced = this.syncCurrentTrackFromSession(mediaSession);
        const choice = this.chooseCurrentPosition(mediaSession);

        // The guard here used to be doesSessionTrackMatchStore(), which cannot
        // fail in this position: syncCurrentTrackFromSession has just written
        // the store's index from this same session, so re-deriving it and
        // comparing always agrees. What the guard was reaching for is that the
        // position belongs to the track we synced to, and pickRemotePosition
        // reports that directly — 'none' means neither side offered a value
        // worth publishing, so the previous one stands.
        if (trackSynced && choice.source !== 'none') {
            if (choice.duration !== null) this.publishDuration(choice.duration);
            if (choice.currentTime !== null) this.publishPosition(choice.currentTime);
        }

        const playerState = mediaSession.playerState || this.player?.playerState;
        if (playerState === chrome.cast.media.PlayerState.PLAYING) {
            this.publishPlayState(true);
        } else if (playerState === chrome.cast.media.PlayerState.PAUSED) {
            this.publishPlayState(false);
        }

        this.syncBrowserMediaSessionFromCast(mediaSession);

        console.log(`[Cast] Hydrated sender from remote session (${reason})`);
        this.logCast(
            'ok',
            `Hydrated sender from remote session: ${reason}`,
            `trackSynced=${trackSynced} playerState=${playerState || 'unknown'} time=${choice.currentTime ?? 'none'} `
            + `duration=${choice.duration ?? 'none'} source=${choice.source} playerSilentMs=${this.msSinceRemotePlayerEvent()}`,
        );
        return trackSynced;
    }

    private async startPlaybackForCurrentSession(reason: string): Promise<void> {
        if (this.autoCastInProgress) return;
        if (this.castContext?.getCastState) {
            this.state = this.castContext.getCastState();
            this.notifyStateChange();
        }
        if (!this.castContext?.getCurrentSession?.()) return;
        if (this.leaveIfCastingElsewhere(reason)) return;

        const mediaSession = this.getHydratableMediaSession();
        if (this.hasActiveRemoteMediaSession(mediaSession)) {
            await this.hydrateSenderFromRemoteSession(mediaSession, reason);
            return;
        }

        // It may still be a join: another of the user's devices playing on
        // this receiver, whose media the SDK has not heard about yet.
        const joined = await this.waitForJoinedReceiverMedia(reason);
        if (joined === 'stop') return;
        if (joined) {
            await this.hydrateSenderFromRemoteSession(joined, `${reason}:joined`);
            return;
        }

        // Fresh handover would load a queue whose media URLs the receiver
        // can't fetch from this origin — it would accept the load and sit
        // silently IDLE. End the session with an explicit error instead.
        // (Joining an ongoing session above is fine: the receiver already
        // holds URLs from the origin that started it.)
        const originIssue = this.getOriginCastabilityIssue();
        if (originIssue) {
            this.logCast('error', 'Blocking fresh Cast handover from non-castable origin', originIssue);
            toast.error(`Stopped casting — the Cast device can't reach ${window.location.host}. Use the HTTPS app.`);
            try {
                this.castContext?.endCurrentSession?.(true);
            } catch { /* ignore */ }
            this.resetSessionAttemptState('non-castable-origin', {
                clearStoredSession: true,
                healthPhase: 'error',
                healthMessage: 'Casting is unavailable from this origin.',
            });
            return;
        }

        // Fresh handover (session connected, receiver has no media yet): clamp
        // the receiver to a safe startup volume before the first load — some
        // receivers power on reporting 100% and would blast the first track.
        // Joins/rejoins of an ongoing session (the hydration paths above and
        // in the session handlers) keep their established volume.
        this.applyFreshSessionStartupVolume(reason);

        await this.handleCastConnected();
    }

    /**
     * A session that looks fresh waits up to JOIN_MEDIA_WAIT_MS for evidence
     * (castJoinPolicy.ts). Returns the receiver's media to take on, null to
     * go ahead with a fresh load, or 'stop' to load nothing.
     */
    private async waitForJoinedReceiverMedia(reason: string): Promise<any | null | 'stop'> {
        const session = this.castContext?.getCurrentSession?.();
        if (!session) return 'stop';
        const startedAt = Date.now();
        this.sendMediaGetStatus(session);
        for (;;) {
            if (this.castContext?.getCurrentSession?.() !== session) return 'stop';
            const media = this.getHydratableMediaSession();
            const elapsedMs = Date.now() - startedAt;
            const verdict = decideJoin({
                sdkHasMedia: this.hasActiveRemoteMediaSession(media),
                receiverStatus: this.lastAuroraStatusAt >= startedAt ? this.lastAuroraStatus : null,
                elapsedMs,
            });
            if (verdict === 'adopt') {
                this.logCast('ok', 'cast-join-adopted', `reason=${reason} waitedMs=${elapsedMs}`);
                return media;
            }
            if (verdict === 'hold') {
                this.logCast('warn', 'cast-join-media-unseen', `reason=${reason} waitedMs=${elapsedMs} entryId=${this.lastAuroraStatus?.queueEntryId || 'none'} state=${this.lastAuroraStatus?.playerState || 'none'}`);
                return 'stop';
            }
            if (verdict === 'fresh') {
                if (elapsedMs > 0) this.logCast('ok', 'cast-join-none', `reason=${reason} waitedMs=${elapsedMs}`);
                return null;
            }
            await this.delay(100);
        }
    }

    private applyFreshSessionStartupVolume(reason: string) {
        const sessionId = this.getCurrentSessionId();
        if (!sessionId || this.startupVolumeSessionId === sessionId) return;
        this.startupVolumeSessionId = sessionId;
        this.setVolume(FRESH_SESSION_STARTUP_VOLUME);
        // Reflect it in the app immediately; the receiver's VOLUME_LEVEL_CHANGED
        // confirmation keeps it in sync afterwards.
        this.onVolumeChange?.(FRESH_SESSION_STARTUP_VOLUME);
        this.logCast('ok', 'Applied fresh-session startup volume', `volume=${FRESH_SESSION_STARTUP_VOLUME} reason=${reason}`);
    }

    private syncCurrentTrackFromSession(mediaSession: any | null = this.getMediaSession()): boolean {
        if (this.playbackConfirmation.unconfirmed && !this.mediaMatchesCurrentTrack(mediaSession?.media)) return false;
        if (!mediaSession) return false;

        this.syncQueueItemMapFromSession(mediaSession);

        const state = usePlayerStore.getState();
        const sessionIndex = this.resolveTrackIndexFromSession(mediaSession, state.playlist);
        this.syncBrowserMediaSessionFromCast(mediaSession, sessionIndex);
        if (sessionIndex !== null) {
            if (sessionIndex !== state.currentIndex) {
                this.logCast('ok', 'Syncing sender track index from Cast session', `from=${state.currentIndex} to=${sessionIndex}`);
                this.invalidatePositionAnchor();
                this.onTrackChange?.(sessionIndex);
            }
            return true;
        }

        const now = Date.now();
        if (now - this.lastUnmappedSessionLogAt > 10000) {
            this.lastUnmappedSessionLogAt = now;
            this.logCast('warn', 'Could not map Cast session item to local playlist');
        }
        return false;
    }

    private getQueueItemId(queueEntryId: string, mediaSession: any | null = this.getMediaSession()): number | null {
        this.syncQueueItemMapFromSession(mediaSession);
        const itemId = this.queueItemIdByEntryId.get(queueEntryId);
        return typeof itemId === 'number' ? itemId : null;
    }

    /**
     * Play the given queue entry on the receiver. Fast presses coalesce: one
     * skip runs at a time and only the newest requested target follows it, so
     * a burst becomes a few jumps rather than a LOAD per press.
     */
    public ensureQueuePlayback(tracks: CastQueueTrack[], startIndex = 0, repeat: CastRepeat = 'none'): Promise<void> {
        this.pendingSkip = { tracks, startIndex, repeat };
        this.skipRequestSeq++;
        if (this.skipRunner) return this.skipRunner;
        this.skipRunner = (async () => {
            try {
                while (this.pendingSkip) {
                    const next = this.pendingSkip;
                    this.pendingSkip = null;
                    await this.runQueueSkip(next.tracks, next.startIndex, next.repeat, this.skipRequestSeq);
                }
            } finally {
                this.skipRunner = null;
            }
        })();
        return this.skipRunner;
    }

    private async runQueueSkip(tracks: CastQueueTrack[], startIndex: number, repeat: CastRepeat, requestSeq: number) {
        if (!this.isConnected()) return;
        const session = this.castContext.getCurrentSession();
        const window = this.queueWindow;
        const entryId = tracks[startIndex]?.queueEntryId;
        const media = session?.getMediaSession();
        // The SDK may expose only current + next, and may strip customData.
        // Never interpret a local playlist index as a receiver array index.
        // A played entry kept for Previous is usually no longer listed by the
        // SDK, but the receiver reported its item ID while it played.
        const knownId = entryId ? this.queueItemIdByEntryId.get(entryId) : undefined;
        // An inferred ID the SDK happens to list must name the same track.
        const listedById = typeof knownId === 'number'
            ? media?.items?.find((candidate: { itemId: number }) => candidate.itemId === knownId) : undefined;
        const listedKey = streamKey(listedById?.media?.contentId);
        const wantedKey = streamKey(tracks[startIndex]?.url || tracks[startIndex]?.rawUrl);
        if (window && entryId && window.inferred.has(entryId) && listedKey && wantedKey && listedKey !== wantedKey) {
            this.dropInferredItemIds(window, `entryId=${entryId} itemId=${knownId} listed=${listedKey} wanted=${wantedKey}`);
        }
        const usableId = entryId ? this.queueItemIdByEntryId.get(entryId) : undefined;
        const listed = media?.items?.find((item: { itemId: number; media?: { customData?: { queueEntryId?: string } } }) =>
            item.media?.customData?.queueEntryId === entryId ||
            (entryId && this.queueItemIdByEntryId.get(entryId) === item.itemId));
        const item = listed ?? (media && typeof usableId === 'number' ? { itemId: usableId } : null);
        if (media && window && window.session === session && typeof media.mediaSessionId === 'number') window.mediaSessionId = media.mediaSessionId;
        const inWindow = !!window && window.session === session && !window.blocked && window.repeat === repeat && !!entryId && window.ids.includes(entryId);
        // A newer press supersedes this one; only the latest may reload.
        const stillLatest = () => requestSeq === this.skipRequestSeq;
        const jumpId: number | undefined = typeof usableId === 'number' ? usableId : item?.itemId;
        if (inWindow && window && entryId && typeof jumpId === 'number') {
            const status = this.lastAuroraStatus && Date.now() - this.lastAuroraStatusAt <= this.auroraStatusFreshMs ? this.lastAuroraStatus : null;
            // The receiver's own report decides "already there"; a stale SDK
            // Media object's currentItemId can be wrong.
            if (status ? status.queueEntryId === entryId : media?.currentItemId === jumpId) return;
            // Start confirming the target before any jump is sent: while a
            // start is unconfirmed, statuses for other entries are dropped, and
            // the jump's own evidence must get through. A fallback LOAD below
            // restarts confirmation for itself.
            this.beginPlaybackConfirmation(session, entryId, 0);
            this.confirmationLoadAccepted = true;
            // The media channel first: it worked on the NAD within 100-800 ms
            // (2026-10-12), while the SDK's Media object goes stale or missing
            // once the receiver advances by itself.
            const viaChannel = await this.jumpViaMediaChannel(session, window, jumpId, entryId, stillLatest);
            if (viaChannel === 'ok' || viaChannel === 'superseded') return;
            const sdkMedia = this.castContext.getCurrentSession()?.getMediaSession();
            if (sdkMedia && sdkMedia !== this.staleSdkMedia) {
                try {
                    // Recovery keeps the receiver's queue, so its item IDs stay valid.
                    await this.runCastCommand('queue-jump', () => castQueueCallback((ok, fail) => {
                        const active = this.castContext.getCurrentSession()?.getMediaSession();
                        if (!active) throw new Error('No active Cast media session');
                        active.queueJumpToItem(jumpId, ok, fail);
                    }, CAST_QUEUE_JUMP_ACK_TIMEOUT_MS));
                    return;
                } catch (error) {
                    // A stale SDK Media object accepts the call and never answers
                    // (NAD 2026-10-12 21:26: seven presses, no track change).
                    // Do not wait on the same object again.
                    this.staleSdkMedia = sdkMedia;
                    this.logCast('warn', 'Cast queue jump via SDK unconfirmed', `${this.describeError(error)} itemId=${jumpId}`);
                }
            }
            if (!stillLatest()) return;
        }
        if (window && window.session === session) {
            const reason = window.blocked ? 'blocked' : window.repeat !== repeat ? 'repeat-changed'
                : !entryId || !window.ids.includes(entryId) ? 'outside-window'
                : typeof jumpId !== 'number' ? 'unknown-item-id' : 'jump-unconfirmed';
            this.logCast('ok', 'Cast queue jump fell back to LOAD', `reason=${reason}`);
        }
        // Reloading at the requested entry is what the old "Retry" did by hand:
        // do it directly, without an error, when a jump could not be confirmed.
        await this.castQueue(tracks, startIndex, repeat);
    }

    /**
     * Pick up a Cast session that is still running from a previous page load.
     *
     * This no longer calls requestSessionById(): the SDK's own
     * `resumeSavedSession` + ORIGIN_SCOPED auto-join re-attaches and fires
     * SESSION_RESUMED on its own. All this does is reconcile against whatever
     * session the SDK has already restored, so the sender picks it up without
     * waiting for a user gesture.
     */
    private tryRejoinSession() {
        const storedId = localStorage.getItem(SESSION_STORAGE_KEY);
        if (!storedId) return;

        this.logCast('ok', 'Boot reconcile against SDK-resumed session', `stored=${storedId}`);
        void this.reconcileActiveSession('boot-stored-session');
    }

    /**
     * Called when cast state transitions to CONNECTED.
     * Automatically takes the currently playing track and starts casting it.
     */
    private async handleCastConnected() {
        // Read current playback state from the store
        const state = usePlayerStore.getState();
        const { currentIndex, repeat } = state;
        const playlist = this.ensureStoreQueueEntryIds();

        if (!playlist.length || currentIndex === null) {
            console.log('[Cast] Connected but no playlist is active — nothing to auto-cast.');
            this.logCast('ok', 'Cast connected without active local playback', `playlist=${playlist.length} currentIndex=${currentIndex ?? 'none'}`);
            this.setHealthStatus('connected', `Casting to ${this.getCastDeviceName() || 'device'}.`, 'idle-session');
            return;
        }

        const track = playlist[currentIndex];
        // Get current playback position before we pause local audio
        const currentTime = playbackManager.getCurrentTime();

        console.log(`[Cast] Auto-casting: "${track.title}" by ${track.artist} (position: ${currentTime.toFixed(1)}s)`);
        this.logCast('ok', 'Auto-casting current local queue', `index=${currentIndex} title=${track.title || 'Unknown Title'} position=${currentTime.toFixed(1)}`);

        this.autoCastInProgress = true;
        try {
            // Pause local audio DIRECTLY on the HTMLAudioElement.
            // We cannot use playbackManager.pause() because it checks
            // castManager.isConnected() — which is now true — and routes to
            // castManager.pause(), which is a no-op since no media is loaded
            // on the Cast device yet. This would leave local audio playing.
            playbackManager.getLocalAudioElement().pause();

            await this.castQueue(
                playlist.map((item) => ({
                    queueEntryId: item.queueEntryId,
                    url: item.url || '',
                    rawUrl: item.rawUrl || '',
                    title: item.title || 'Unknown Title',
                    artist: item.artist || ((item.artists as string[])?.join(', ')) || 'Unknown Artist',
                    artUrl: item.artUrl,
                    album: item.album,
                    format: item.format,
                    duration: item.duration,
                })),
                currentIndex,
                repeat,
                currentTime
            );
        } catch (e) {
            console.error('[Cast] Failed to auto-cast current track:', e);
            this.logCast('error', 'Failed to auto-cast current track', this.describeError(e));
            toast.error('Connected to Cast device but failed to play media.');
        } finally {
            this.autoCastInProgress = false;
        }
    }

    public isConnected(): boolean {
        return this.state === 'CONNECTED';
    }

    /**
     * The Web Receiver runs on the Cast device and fetches media from THIS
     * page's origin. A loopback host resolves to the Cast device itself, and
     * an http: origin is blocked as mixed content by the HTTPS receiver page —
     * both make the receiver's loads fail silently (queue accepted, player
     * stays IDLE, progress frozen). Returns why this origin can't serve a
     * receiver, or null if it can.
     */
    private getOriginCastabilityIssue(): string | null {
        const { protocol, hostname } = window.location;
        const isLoopback = hostname === 'localhost'
            || hostname === '127.0.0.1'
            || hostname === '0.0.0.0'
            || hostname === '::1'
            || hostname === '[::1]'
            || hostname.endsWith('.localhost');
        if (isLoopback) {
            return `media URLs would point at ${hostname}, which resolves to the Cast device itself`;
        }
        if (protocol !== 'https:') {
            return 'the HTTPS receiver page cannot fetch http: media (mixed content)';
        }
        return null;
    }

    public getCastState(): CastState {
        return this.state;
    }

    /**
     * Returns the friendly name of the connected Cast device (e.g. "Living Room TV").
     */
    public getCastDeviceName(): string {
        try {
            const session = this.castContext?.getCurrentSession();
            if (session) {
                const device = session.getCastDevice();
                return device?.friendlyName || '';
            }
        } catch { /* ignore */ }
        return '';
    }

    /**
     * Extract the auth token from a track URL's query parameters.
     */
    private extractTokenFromUrl(url: string): string {
        try {
            return new URL(url).searchParams.get('token') || '';
        } catch {
            return '';
        }
    }

    private getCastImageUrl(url?: string): string {
        if (!url) return '';
        try {
            const parsed = new URL(url, window.location.href);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
            return parsed.toString();
        } catch {
            return '';
        }
    }

    public async castMedia(hlsUrl: string, rawUrl: string, title: string, artist: string, artUrl?: string, album?: string, format?: string, token?: string) {
        if (!this.isConnected()) return;

        const castSession = this.castContext.getCurrentSession();
        if (!castSession) return;

        const streamingQuality = usePlayerStore.getState().streamingQuality;
        const effectiveHlsUrl = this.customAppId
            ? applyCastStreamingQualityToHlsUrl(hlsUrl, streamingQuality)
            : applyStreamingQualityToHlsUrl(hlsUrl, streamingQuality);

        // The custom receiver always uses fixed 128 kbps AAC for Auto and
        // Source. Adaptive browser HLS is not sent to Cast.
        const useHls = !!(this.customAppId && effectiveHlsUrl);
        let mediaUrl = useHls ? effectiveHlsUrl : (rawUrl || effectiveHlsUrl);
        const authToken = token || this.extractTokenFromUrl(mediaUrl);

        if (useHls) {
            try {
                const url = new URL(mediaUrl);
                url.searchParams.set('codec', CUSTOM_RECEIVER_HLS_CODEC);
                mediaUrl = url.toString();
            } catch { /* ignore */ }
        }

        // Warn if the Chromecast can't reach the server (localhost / 127.0.0.1)
        try {
            const host = new URL(mediaUrl).hostname;
            if (host === 'localhost' || host === '127.0.0.1') {
                console.warn('[Cast] Server URL is localhost — the Chromecast device cannot reach it. Access the app via your LAN IP or domain to cast.');
                toast.error('Cannot cast: server is at localhost. Access the app via your LAN IP address to cast.');
                return;
            }
        } catch { /* ignore */ }

        const contentType = useHls ? 'application/vnd.apple.mpegurl' : inferContentType(mediaUrl, format);
        const mediaInfo = new chrome.cast.media.MediaInfo(mediaUrl, contentType);
        mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;
        if (useHls && chrome.cast.media.HlsSegmentFormat?.TS) {
            mediaInfo.hlsSegmentFormat = chrome.cast.media.HlsSegmentFormat.TS;
        }
        mediaInfo.metadata = new chrome.cast.media.MusicTrackMediaMetadata();
        mediaInfo.metadata.title = title;
        mediaInfo.metadata.artist = artist;
        if (album) {
            mediaInfo.metadata.albumName = album;
        }

        const castImageUrl = this.getCastImageUrl(artUrl);
        if (castImageUrl) {
            mediaInfo.metadata.images = [new chrome.cast.Image(castImageUrl)];
        }

        // Pass auth token to custom receiver via customData for Bearer header injection
        if (useHls || this.diagnosticsVerbose) {
            mediaInfo.customData = {
                ...(useHls && authToken ? { token: authToken } : {}),
                ...(useHls ? { codec: CUSTOM_RECEIVER_HLS_CODEC } : {}),
                diagnosticsVerbose: this.diagnosticsVerbose,
            };
        }

        // Serialize loadMedia calls to prevent concurrent loads from clashing
        const previous = this.currentLoadPromise;
        let resolveLoad: () => void;
        this.currentLoadPromise = new Promise<void>((resolve) => { resolveLoad = resolve; });

        // Wait for any in-flight load to complete
        await previous;

        const request = new chrome.cast.media.LoadRequest(mediaInfo);
        request.autoplay = true;

        try {
            this.logCast('ok', 'Loading single media on Cast device', `title=${title} useHls=${useHls} url=${mediaUrl}`);
            await this.runCastCommand('load-single-media', async () => {
                const activeSession = this.castContext.getCurrentSession();
                if (!activeSession) throw new Error('No active Cast session');
                return activeSession.loadMedia(request);
            });
            this.queueItemIdByEntryId.clear();
            this.logCast('ok', 'Single media load succeeded', `title=${title}`);
        } catch (e: any) {
            const errorDetail = e?.code || e?.message || String(e);
            const errorDesc = e?.description || '';
            console.error(`[Cast] Failed to load media: ${errorDetail}${errorDesc ? ' — ' + errorDesc : ''}`, e);
            this.logCast('error', 'Failed to load single media', `${errorDetail}${errorDesc ? ' - ' + errorDesc : ''} ${this.describeError(e)}`);
            if (!String(errorDetail).includes('cancel') && !String(errorDetail).includes('abort')) {
                toast.error(`Failed to play "${title}" on Cast device.`);
            }
            return;
        } finally {
            resolveLoad!();
        }

        // Store session ID for rejoin after successful load
        const sessionId = castSession.getSessionId();
        if (sessionId) {
            localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
        }
    }

    /**
     * Load a queue of tracks onto the Cast device for gapless playback.
     * The receiver handles auto-advancement, eliminating gaps between tracks.
     * @param tracks Array of track objects with url, title, artist, artUrl, album, format, duration
     * @param startIndex Which track to start playing (0-based)
     * @param repeat 'none' | 'one' | 'all' — repeat mode
     */
    public async castQueue(tracks: CastQueueTrack[], startIndex = 0, repeat: CastRepeat = 'none', startTime = 0, confirmationRetry = false) {
        if (!this.isConnected() || tracks.length === 0) return;
        let session = this.castContext.getCurrentSession();
        if (!session) return;
        const generation = ++this.queueLoadGeneration;
        // `tracks` is the queue as of this call; edits after it stay pending
        // and are reconciled against the new window once it has landed.
        const editSeqAtCall = this.queueWindowEditSeq;
        this.queueLoadingSession = session;
        const requestedEntryId = tracks[startIndex]?.queueEntryId;
        this.confirmationLoadAccepted = false;
        if (!confirmationRetry && requestedEntryId) this.beginPlaybackConfirmation(session, requestedEntryId, startTime);
        const previous = this.currentLoadPromise;
        let release!: () => void;
        this.currentLoadPromise = new Promise<void>(resolve => { release = resolve; });
        await previous;
        const stillCurrent = () => generation === this.queueLoadGeneration && session === this.castContext.getCurrentSession();
        try {
            if (!stillCurrent()) return;
            this.queueLoadRetry = null;
            this.queueWindow = null;
            this.queueWindowEditHandled = Math.max(this.queueWindowEditHandled, editSeqAtCall);
            this.queueItemIdByEntryId.clear();
            const index = Number.isInteger(startIndex) ? Math.max(0, Math.min(startIndex, tracks.length - 1)) : 0;
            const time = Number.isFinite(startTime) && startTime > 0 ? startTime : 0;
            if (!(tracks[index]?.url || tracks[index]?.rawUrl)) throw new Error('Cast track has no content URL');
            if (tracks.some(track => !track.queueEntryId)) throw new Error('Cast queue entries require stable identities');
            // Up to CAST_QUEUE_KEEP_PREVIOUS played entries ride along so Previous, and the device's
            // own controls, jump instead of reloading. With repeat-all the
            // wrapped tail stops before them, so no entry is queued twice and
            // the receiver's items stay in cyclic order.
            const before = tracks.slice(Math.max(0, index - CAST_QUEUE_KEEP_PREVIOUS), index);
            const ordered = repeat === 'all'
                ? [...tracks.slice(index), ...tracks.slice(0, Math.max(0, index - CAST_QUEUE_KEEP_PREVIOUS))]
                : queueWindowEntries(tracks, index, false);
            const cafRepeatFor = (selected: CastQueueTrack[]): CastRepeat =>
                repeat === 'all' && before.length + selected.length < tracks.length ? 'none' : repeat;
            const build = (selected: CastQueueTrack[]) => {
                const all = [...before, ...selected];
                const start = before.length;
                // Every item carries its cover: the receiver shows art only from
                // the item it plays (Google TV, 2026-10-13: most covers missing
                // when only the start item had one). The byte budget pays for it
                // with fewer items per load, and refill tops up the rest.
                const items = all.map((track, i) => this.buildQueueItem(track, {
                    includeAuthTokenInCustomData: false, includeArtwork: true,
                    includeDuration: i === start, compactHlsUrl: true,
                }));
                const token = this.extractTokenFromUrl(tracks[index].url || tracks[index].rawUrl || '');
                items[start].media.customData = { ...items[start].media.customData, ...(token ? { token } : {}), diagnosticsVerbose: this.diagnosticsVerbose };
                const request = new chrome.cast.media.LoadRequest(items[start].media);
                request.autoplay = true;
                request.queueData = new chrome.cast.media.QueueData();
                request.queueData.items = items;
                request.queueData.startIndex = start;
                request.queueData.repeatMode = this.getRepeatMode(cafRepeatFor(selected));
                if (time > 0) {
                    items[start].startTime = time;
                    request.currentTime = time;
                    request.queueData.startTime = time;
                }
                return request;
            };
            // Previous entries count toward the item cap; the byte budget covers all of them.
            let cap = Math.max(1, CAST_QUEUE_MAX_ITEMS - before.length);
            for (let attempt = 0; attempt < 3; attempt++) {
                const bounded = boundedQueueRequest(ordered, build, cap);
                this.logCast('ok', 'Queue load requested', `items=${before.length + bounded.entries.length} previous=${before.length} startIndex=${index} startTime=${time} bytes=${bounded.bytes} attempt=${attempt + 1}`);
                try {
                    // Through the stale-transport wrapper like every other
                    // command: a tap after waking into a dead transport
                    // recovers and retries (#39/#86). Recovery can replace the
                    // session object, so the retry re-reads it.
                    const acknowledged = await this.runCastCommand('load-queue', async () => {
                        const active = this.castContext.getCurrentSession();
                        if (!active) throw new Error('No active Cast session');
                        // A newer load (for example one started by recovery's own
                        // hydration) owns the device now; never send a second LOAD.
                        if (generation !== this.queueLoadGeneration) throw new Error('Cast queue load superseded');
                        session = active;
                        // A hung acknowledgement must not hold the load lock, but
                        // it is not a failure either: the LOAD may be playing.
                        // Treat it as sent and let receiver evidence decide.
                        let timer: ReturnType<typeof setTimeout> | undefined;
                        try {
                            return await Promise.race([
                                Promise.resolve(active.loadMedia(bounded.request)).then(() => true),
                                new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), CAST_LOAD_ACK_TIMEOUT_MS); }),
                            ]);
                        } finally { if (timer !== undefined) clearTimeout(timer); }
                    });
                    if (!stillCurrent()) return;
                    if (!acknowledged) this.logCast('warn', 'Queue load acknowledgement timed out; awaiting receiver evidence', `items=${before.length + bounded.entries.length} timeoutMs=${CAST_LOAD_ACK_TIMEOUT_MS}`);
                    this.confirmationLoadAccepted = true;
                    this.queueWindow = {
                        session, ids: [...before, ...bounded.entries].map(entry => entry.queueEntryId!), repeat, blocked: false,
                        complete: bounded.entries.length === ordered.length, cafRepeat: cafRepeatFor(bounded.entries),
                        inferred: new Set(), nextItemId: null, seedable: true, inferenceOff: false,
                    };
                    this.noteSdkMedia(this.queueWindow, session.getMediaSession?.());
                    this.persistQueueWindow();
                    this.lastAuroraStatus = null; // status from the previous LOAD cannot refill this window
                    this.lastAuroraStatusAt = 0;
                    this.syncQueueItemMapFromSession(session.getMediaSession());
                    const id = session.getSessionId();
                    if (id) localStorage.setItem(SESSION_STORAGE_KEY, id);
                    this.logCast('ok', 'Queue load succeeded', `items=${before.length + bounded.entries.length} previous=${before.length} startIndex=${index} bytes=${bounded.bytes}`);
                    if (this.pauseAfterLoadGeneration === generation) {
                        // The listener paused while this LOAD was in flight.
                        this.pauseAfterLoadGeneration = null;
                        this.queueLoadingSession = null;
                        this.pause();
                    }
                    return;
                } catch (error) {
                    if (!stillCurrent()) return;
                    const nextCap = attempt === 0 ? Math.max(1, Math.floor(bounded.entries.length / 2)) : 6;
                    if (!/invalid_parameter/i.test(this.describeError(error)) || attempt === 2 || nextCap >= bounded.entries.length) throw error;
                    cap = nextCap;
                    this.logCast('warn', 'Retrying Cast load with smaller window', `items=${cap}`);
                }
            }
        } catch (error) {
            if (stillCurrent()) {
                this.queueLoadRetry = requestedEntryId ? { session, entryId: requestedEntryId, time: startTime } : null;
                this.logCast('error', 'Failed to load queue', this.describeError(error));
                if (!this.playbackConfirmation.unconfirmed) this.setHealthStatus('error', 'Failed to load the Cast queue. Retry to try again.');
            }
        } finally {
            if (generation === this.queueLoadGeneration) this.queueLoadingSession = null;
            release();
        }
    }

    /**
     * Keep the receiver's window in step with the local queue. Edits are
     * mirrored by item ID; a truncated window is refilled below the low-water
     * mark; a complete window gets appends at once; played entries are pruned
     * only by item IDs we observed. A reload happens only for an edit that
     * cannot be mirrored.
     */
    private async reconcileQueueWindow(edited = false): Promise<void> {
        if (edited) this.queueWindowEditSeq++;
        // Store queue actions call us inside their updater; read after it commits.
        await Promise.resolve();
        const editSeq = this.queueWindowEditSeq;
        const window = this.queueWindow;
        const session = this.castContext?.getCurrentSession?.();
        if (!this.isConnected() || !window || window.session !== session || window.blocked || this.queueWindowBusy) return;
        // Nothing touches a queue whose LOAD is still in flight.
        if (this.playbackConfirmation.unconfirmed && this.queueLoadingSession === session) return;
        const mediaSnapshot = session.getMediaSession();
        const status: AuroraReceiverStatus | null = this.lastAuroraStatus && Date.now() - this.lastAuroraStatusAt <= this.auroraStatusFreshMs
            ? this.lastAuroraStatus : mediaSnapshot ? {
                queueEntryId: mediaSnapshot.items?.find((item: { itemId: number }) => item.itemId === mediaSnapshot.currentItemId)?.media?.customData?.queueEntryId
                    || mediaSnapshot.media?.customData?.queueEntryId,
                currentTime: mediaSnapshot.getEstimatedTime?.() ?? mediaSnapshot.currentTime,
            } : null;
        if (!status?.queueEntryId) return;
        this.syncQueueItemMapFromSession(mediaSnapshot);
        const offset = window.ids.indexOf(status.queueEntryId);
        if (offset < 0) return; // another sender replaced the media; never seize it back
        const state = usePlayerStore.getState();
        const index = state.playlist.findIndex(track => track.queueEntryId === status.queueEntryId);
        // Under CAF repeat-all the receiver loops its items, so from the current
        // entry the window is the whole cycle.
        const cyclic = window.cafRepeat === 'all' && state.repeat === 'all';
        const remaining = cyclic ? [...window.ids.slice(offset), ...window.ids.slice(0, offset)] : window.ids.slice(offset);
        const ordered = index < 0 ? [] : queueWindowEntries(state.playlist, index, state.repeat === 'all');
        const edit: CastWindowEdit = index < 0 ? { kind: 'reload' } : planWindowEdit(remaining, ordered.map(track => track.queueEntryId || ''));
        const generation = this.queueLoadGeneration;
        const current = () => generation === this.queueLoadGeneration && this.queueWindow === window && session === this.castContext.getCurrentSession();
        this.queueWindowBusy = true;
        // Serialize with LOAD too; a late insert must not contaminate its replacement.
        const previous = this.currentLoadPromise;
        let release!: () => void;
        this.currentLoadPromise = new Promise<void>(resolve => { release = resolve; });
        let reload: { index: number; time: number } | null = null;
        let again = false;
        let deferred = false; // edits held for playback confirmation; it re-runs this
        try {
            await previous;
            if (!current()) return;
            // While a jump is unconfirmed the receiver's status may still name
            // the previous entry, so edits wait for confirmation (which runs
            // this again). Refill at the end does not depend on it and goes
            // ahead: holding it back made fast skips outrun Infinity's appends
            // and reload (Google TV, 2026-10-13 22:14:46).
            if ((index < 0 || edit.kind !== 'none') && this.playbackConfirmation.unconfirmed) {
                deferred = true;
                return;
            }
            if (index < 0 || edit.kind !== 'none') {
                // Only our own edits change the receiver; a transient mismatch does not.
                if (this.queueWindowEditHandled >= editSeq) return;
                this.queueWindowEditHandled = editSeq;
                if (index < 0) {
                    if (state.playlist.length === 0 || ((state.currentIndex ?? 0) >= state.playlist.length && state.repeat !== 'all')) {
                        await castQueueCallback((ok, fail) => session.getMediaSession()?.stop(null, ok, fail));
                        if (current()) {
                            this.queueWindow = null;
                            usePlayerStore.setState({ currentIndex: null, playbackState: 'stopped' });
                        }
                    } else if (mediaSnapshot && remaining[1] && state.playlist.some(track => track.queueEntryId === remaining[1]) &&
                        typeof this.queueItemIdByEntryId.get(remaining[0]) === 'number' &&
                        mediaSnapshot.items?.some((item: { itemId: number }) => item.itemId === this.queueItemIdByEntryId.get(remaining[1]))) {
                        const oldId = this.queueItemIdByEntryId.get(remaining[0]);
                        const nextId = this.queueItemIdByEntryId.get(remaining[1]);
                        await castQueueCallback((ok, fail) => mediaSnapshot.queueJumpToItem(nextId, ok, fail));
                        if (!current()) return;
                        await castQueueCallback((ok, fail) => mediaSnapshot.queueRemoveItem(oldId, ok, fail));
                        if (!current()) return;
                        window.ids = window.ids.filter(id => id !== remaining[0]);
                        this.queueItemIdByEntryId.delete(remaining[0]);
                        window.inferred.delete(remaining[0]);
                        window.seedable = false;
                        this.persistQueueWindow();
                        again = true;
                    } else {
                        reload = { index: (state.currentIndex ?? 0) >= state.playlist.length ? 0 : (state.currentIndex ?? 0), time: 0 };
                    }
                    return;
                }
                const mirrored = await this.mirrorWindowEdit(session, window, edit, remaining, status, current);
                if (mirrored === 'reload') {
                    reload = { index, time: status.currentTime || 0 };
                    return;
                }
                if (!mirrored) return;
                again = true;
            } else {
                this.queueWindowEditHandled = Math.max(this.queueWindowEditHandled, editSeq);
            }

            // Repeat: CAF repeat-all only when every local entry is on the
            // receiver; otherwise it would loop a partial window, and the
            // sender wraps by refilling instead.
            const desired: CastRepeat = state.repeat === 'one' ? 'one'
                : state.repeat === 'all' && state.playlist.every(track => window.ids.includes(track.queueEntryId || '')) ? 'all' : 'none';
            const media = session.getMediaSession();
            if (desired !== window.cafRepeat && media) {
                await castQueueCallback((ok, fail) => media.queueSetRepeatMode(this.getRepeatMode(desired), ok, fail));
                if (!current()) return;
                this.logCast('ok', 'Cast queue window repeat mode set', `repeat=${state.repeat} receiver=${desired}`);
                window.cafRepeat = desired;
            }
            window.repeat = state.repeat;
            if (again || window.cafRepeat !== 'none' || index < 0) return;

            // Refill. Entries already on the receiver (the kept previous ones,
            // when repeat-all wraps around to them) end the candidate run.
            const onReceiver = new Set(window.ids);
            const candidates: CastQueueTrack[] = [];
            for (const track of ordered.slice(remaining.length)) {
                if (onReceiver.has(track.queueEntryId || '')) break;
                candidates.push(track);
            }
            if (!candidates.length || (remaining.length - 1 >= CAST_QUEUE_LOW_WATER && !window.complete)) return;
            // CAF retains played entries. Prune only IDs actually observed,
            // keep the last few for Previous, and never reload to prune.
            const consumed = window.ids.slice(0, Math.max(0, offset - CAST_QUEUE_KEEP_PREVIOUS));
            const prunable = consumed.filter(id => typeof this.queueItemIdByEntryId.get(id) === 'number');
            if (prunable.length && media) {
                const ids = prunable.map(id => this.queueItemIdByEntryId.get(id));
                await castQueueCallback((ok, fail) => media.queueRemoveItems(new chrome.cast.media.QueueRemoveItemsRequest(ids), ok, fail));
                if (!current()) return;
                prunable.forEach(id => { this.queueItemIdByEntryId.delete(id); window.inferred.delete(id); });
                window.ids = window.ids.filter(id => !prunable.includes(id));
                window.seedable = false;
                this.persistQueueWindow();
            }
            const available = Math.min(CAST_QUEUE_INSERT_MAX_ITEMS, CAST_QUEUE_MAX_ITEMS - remaining.length);
            if (available <= 0) {
                window.complete = false;
                return;
            }
            const requestId = ++this.auroraControlRequestId;
            const capable = status.caps?.includes(RECEIVER_QUEUE_INSERT_CAP);
            const bounded = boundedQueueRequest(candidates, selected => {
                const items = selected.map(track => this.buildQueueItem(track, { includeAuthTokenInCustomData: false, includeArtwork: true, compactHlsUrl: true }));
                return capable ? { type: 'aurora.queue.insert', requestId, position: 'end', items: items.map(toReceiverQueueItem) }
                    : new chrome.cast.media.QueueInsertItemsRequest(items);
            }, available);
            if (capable) {
                await this.queueInsertAcks.wait(session, requestId, bounded.entries.length,
                    () => session.sendMessage(getAuroraStatusNamespace(session), bounded.request));
            } else {
                if (!media) throw new Error('Cast queue refill requires a media session');
                await castQueueCallback((ok, fail) => media.queueInsertItems(bounded.request, ok, fail));
            }
            if (!current()) return;
            window.ids.push(...bounded.entries.map(entry => entry.queueEntryId!));
            this.assignInsertedItemIds(window, bounded.entries.map(entry => entry.queueEntryId!));
            window.complete = bounded.entries.length === candidates.length && candidates.length === ordered.length - remaining.length;
            this.persistQueueWindow();
            again = true;
            this.logCast('ok', 'Cast queue window replenished', `inserted=${bounded.entries.length} items=${window.ids.length} bytes=${bounded.bytes}`);
        } catch (error) {
            again = false;
            if (current()) {
                window.blocked = true;
                this.logCast('error', 'Cast queue window acknowledgement failed', this.describeError(error));
                this.setHealthStatus('error', 'Cast queue update unconfirmed. Retry to reload the queue.');
            }
        } finally {
            release();
            this.queueWindowBusy = false;
            if (reload && current()) await this.castQueue(state.playlist, reload.index, state.repeat, reload.time);
            // An edit that arrived while we were busy, or a refill/repeat step
            // that follows a mirrored edit, runs now rather than on the next tick.
            else if (!deferred && (again || this.queueWindowEditHandled < this.queueWindowEditSeq) && current()) void this.reconcileQueueWindow();
        }
    }

    /**
     * Mirror one planned edit onto the receiver by item ID. Returns true when
     * applied, false when superseded, and 'reload' when it cannot be expressed.
     */
    private async mirrorWindowEdit(
        session: any, window: CastQueueWindow, edit: CastWindowEdit, remaining: string[],
        status: AuroraReceiverStatus, current: () => boolean,
    ): Promise<boolean | 'reload'> {
        const media = session.getMediaSession();
        const itemOf = (id: string | null) => (id === null ? undefined : this.queueItemIdByEntryId.get(id));
        const known = (id: string | null) => typeof itemOf(id) === 'number';
        let detail = '';
        if (edit.kind === 'insert') {
            const playlist = usePlayerStore.getState().playlist;
            const tracks = edit.ids.map(id => playlist.find(track => track.queueEntryId === id));
            if (tracks.length > CAST_QUEUE_INSERT_MAX_ITEMS || tracks.some(track => !track)) return 'reload';
            const items = (tracks as CastQueueTrack[]).map(track => this.buildQueueItem(track, { includeAuthTokenInCustomData: false, includeArtwork: true, compactHlsUrl: true }));
            const next = edit.before === remaining[1];
            if (next && status.caps?.includes(RECEIVER_QUEUE_INSERT_CAP)) {
                // The receiver channel inserts after its current item (#56 Stage 0).
                const requestId = ++this.auroraControlRequestId;
                const message = { type: 'aurora.queue.insert', requestId, position: 'next', items: items.map(toReceiverQueueItem) };
                if (message.items.some(item => !item) || JSON.stringify(message).length > RECEIVER_MESSAGE_MAX_BYTES) return 'reload';
                await this.queueInsertAcks.wait(session, requestId, items.length,
                    () => session.sendMessage(getAuroraStatusNamespace(session), message));
            } else {
                if (!media || !known(edit.before)) return 'reload';
                const request = new chrome.cast.media.QueueInsertItemsRequest(items);
                request.insertBefore = itemOf(edit.before);
                await castQueueCallback((ok, fail) => media.queueInsertItems(request, ok, fail));
            }
            detail = `insert=${edit.ids.length} next=${next}`;
        } else if (edit.kind === 'remove') {
            if (!media || !edit.ids.every(known)) return 'reload';
            const ids = edit.ids.map(itemOf);
            await castQueueCallback((ok, fail) => media.queueRemoveItems(new chrome.cast.media.QueueRemoveItemsRequest(ids), ok, fail));
            edit.ids.forEach(id => this.queueItemIdByEntryId.delete(id));
            detail = `remove=${edit.ids.length}`;
        } else if (edit.kind === 'move') {
            if (!media || !known(edit.id) || (edit.before !== null && !known(edit.before))) return 'reload';
            const request = new chrome.cast.media.QueueReorderItemsRequest([itemOf(edit.id)]);
            if (edit.before !== null) request.insertBefore = itemOf(edit.before);
            await castQueueCallback((ok, fail) => media.queueReorderItems(request, ok, fail));
            detail = 'move=1';
        } else {
            return 'reload';
        }
        if (!current()) return false;
        window.ids = applyWindowEdit(window.ids, edit);
        if (edit.kind === 'insert') this.assignInsertedItemIds(window, edit.ids);
        else window.seedable = false; // positions moved: an unseeded window can no longer seed
        this.persistQueueWindow();
        this.logCast('ok', 'Cast queue window edit mirrored', detail);
        return true;
    }

    /**
     * Jump with a QUEUE_UPDATE on the media namespace when the SDK has no Media
     * object to call queueJumpToItem on. It reuses the media session ID from
     * this window's LOAD; whether CAF still accepts it after the receiver has
     * advanced is exactly what the outcome log answers. Success is only the
     * receiver reporting the entry; one miss disables it for the Cast session.
     */
    private async jumpViaMediaChannel(
        session: any, window: CastQueueWindow, itemId: number, entryId: string, isLatest: () => boolean,
    ): Promise<'ok' | 'superseded' | 'failed'> {
        if (this.mediaChannelJumpFailedFor === session || typeof window.mediaSessionId !== 'number' || typeof session?.sendMessage !== 'function') return 'failed';
        const requestId = ++this.auroraControlRequestId;
        try {
            await Promise.resolve(session.sendMessage(CAST_MEDIA_NAMESPACE, {
                type: 'QUEUE_UPDATE', requestId, mediaSessionId: window.mediaSessionId, currentItemId: itemId,
            }));
        } catch (error) {
            this.mediaChannelJumpFailedFor = session;
            this.logCast('warn', 'Cast queue jump via media channel failed', `${this.describeError(error)} itemId=${itemId}`);
            return 'failed';
        }
        const startedAt = Date.now();
        while (Date.now() - startedAt < CAST_MEDIA_CHANNEL_JUMP_TIMEOUT_MS) {
            if (this.lastAuroraStatus?.queueEntryId === entryId && this.lastAuroraStatusAt >= startedAt) {
                this.logCast('ok', 'Cast queue jump via media channel', `itemId=${itemId} mediaSessionId=${window.mediaSessionId} ms=${Date.now() - startedAt}`);
                return 'ok';
            }
            // A newer skip overtook this one (fast presses, NAD 2026-10-12
            // 21:39:50): the receiver may pass this entry without reporting it.
            // That is not evidence against the channel.
            if (!isLatest()) return 'superseded';
            if (this.queueWindow !== window || session !== this.castContext?.getCurrentSession?.()) return 'superseded';
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        // The latest skip went unanswered: this receiver does not accept it.
        // Never pay the wait again in this Cast session.
        this.mediaChannelJumpFailedFor = session;
        this.logCast('warn', 'Cast queue jump via media channel unconfirmed', `itemId=${itemId} mediaSessionId=${window.mediaSessionId} timeoutMs=${CAST_MEDIA_CHANNEL_JUMP_TIMEOUT_MS}`);
        return 'failed';
    }

    /**
     * Learn what a fresh SDK Media object can tell us about the window: its
     * media session ID, and (cross-checked by stream URL) the item ID of the
     * entry it plays, which seeds the rest at once instead of after the first
     * aurora.status. A skip inside that gap otherwise reloaded again (NAD
     * 2026-10-12 21:40:04: twelve loads in two seconds). Seeds stay inferred
     * and are verified by every receiver report.
     */
    private noteSdkMedia(window: CastQueueWindow | null, media: any): void {
        if (!window || !media || window.session !== this.castContext?.getCurrentSession?.()) return;
        if (typeof media.mediaSessionId === 'number') window.mediaSessionId = media.mediaSessionId;
        if (window.nextItemId !== null || !window.seedable || window.inferenceOff || typeof media.currentItemId !== 'number') return;
        const key = streamKey(media.media?.contentId);
        if (!key) return;
        const playlist = usePlayerStore.getState().playlist;
        const matches = window.ids.filter(id => {
            const track = playlist.find(candidate => candidate.queueEntryId === id);
            return streamKey(track?.url || track?.rawUrl) === key;
        });
        if (matches.length !== 1) return; // the same track twice is ambiguous
        const seed = seedItemIds(window.ids, matches[0], media.currentItemId);
        if (!seed) return;
        for (const [id, inferred] of seed.ids) {
            if (this.queueItemIdByEntryId.has(id)) continue;
            this.queueItemIdByEntryId.set(id, inferred);
            window.inferred.add(id);
        }
        window.nextItemId = seed.next;
        this.logCast('ok', 'queue-item-ids-inferred', `items=${window.ids.length} base=${seed.next - window.ids.length} source=sdk-media`);
        this.persistQueueWindow();
    }

    /** Remember the window under its Cast session ID, for adoption after a reload or recovery. */
    private persistQueueWindow(): void {
        const window = this.queueWindow;
        const sessionId = (window?.session as { getSessionId?: () => string } | undefined)?.getSessionId?.();
        if (!window || !sessionId) return;
        try {
            const itemIds: Record<string, number> = {};
            for (const id of window.ids) {
                const itemId = this.queueItemIdByEntryId.get(id);
                if (typeof itemId === 'number') itemIds[id] = itemId;
            }
            const stored: StoredCastWindow = { sessionId, ids: window.ids, itemIds, nextItemId: window.inferenceOff ? null : window.nextItemId };
            localStorage.setItem(QUEUE_WINDOW_STORAGE_KEY, JSON.stringify(stored));
        } catch { /* adoption simply will not happen */ }
    }

    /**
     * A resumed sender (PWA reload, stored-session rejoin, #86 recovery with a
     * new session object) has no window. Adopt the stored one only on proof
     * that it still describes the receiver and the local queue; otherwise
     * leave the receiver untouched and fall back to per-edit mirroring.
     */
    private maybeAdoptQueueWindow(status: AuroraReceiverStatus): void {
        const session = this.castContext?.getCurrentSession?.();
        if (!session || !status.queueEntryId) return;
        if (this.queueWindow?.session === session) return;
        if (this.queueWindowAdoptionChecked === session) return;
        this.queueWindowAdoptionChecked = session;
        let stored: StoredCastWindow | null = null;
        try { stored = JSON.parse(localStorage.getItem(QUEUE_WINDOW_STORAGE_KEY) || 'null'); } catch { stored = null; }
        const state = usePlayerStore.getState();
        const index = state.playlist.findIndex(track => track.queueEntryId === status.queueEntryId);
        const local = index < 0 ? [] : queueWindowEntries(state.playlist, index, state.repeat === 'all').map(track => track.queueEntryId || '');
        const verdict = adoptableWindow(stored, session.getSessionId?.(), status, local);
        if (!verdict.ok) {
            this.queueWindow = null;
            this.logCast('warn', 'queue-window-not-adopted', `reason=${verdict.reason}`);
            return;
        }
        const offset = verdict.ids.indexOf(status.queueEntryId);
        const covers = state.playlist.every(track => verdict.ids.includes(track.queueEntryId || ''));
        this.queueWindow = {
            session, ids: verdict.ids, repeat: state.repeat, blocked: false,
            complete: verdict.ids.length - offset >= local.length,
            cafRepeat: this.cafRepeatOf(session.getMediaSession?.()?.repeatMode)
                ?? (state.repeat === 'one' ? 'one' : state.repeat === 'all' && covers ? 'all' : 'none'),
            // Stored IDs are treated as inferred: the receiver confirms or refutes them.
            inferred: new Set(), nextItemId: typeof stored?.nextItemId === 'number' ? stored.nextItemId : null,
            seedable: false, inferenceOff: false,
        };
        const window = this.queueWindow;
        for (const [entryId, itemId] of Object.entries(stored?.itemIds ?? {})) {
            if (!verdict.ids.includes(entryId) || typeof itemId !== 'number') continue;
            this.queueItemIdByEntryId.set(entryId, itemId);
            window.inferred.add(entryId);
        }
        if (typeof status.itemId === 'number') this.observeItemId(window, status.queueEntryId, status.itemId);
        this.logCast('ok', 'queue-window-adopted', `items=${verdict.ids.length} offset=${offset} itemIds=${Object.keys(stored?.itemIds ?? {}).length}`);
    }

    /**
     * Record an item ID the receiver reported, check it against any inferred
     * one, and seed the rest of a freshly loaded window from it.
     */
    private observeItemId(window: CastQueueWindow, entryId: string, itemId: number): void {
        const prior = this.queueItemIdByEntryId.get(entryId);
        if (window.inferred.delete(entryId) && prior !== itemId) {
            this.dropInferredItemIds(window, `entryId=${entryId} inferred=${prior} observed=${itemId}`);
        }
        this.queueItemIdByEntryId.set(entryId, itemId);
        if (window.nextItemId === null && window.seedable && !window.inferenceOff) {
            const seed = seedItemIds(window.ids, entryId, itemId);
            if (seed) {
                for (const [id, inferred] of seed.ids) {
                    if (this.queueItemIdByEntryId.has(id)) continue;
                    this.queueItemIdByEntryId.set(id, inferred);
                    window.inferred.add(id);
                }
                window.nextItemId = seed.next;
                this.logCast('ok', 'queue-item-ids-inferred', `items=${window.ids.length} base=${seed.next - window.ids.length}`);
            }
        }
        if (prior !== itemId) this.persistQueueWindow();
    }

    /** Inserted items continue CAF's numbering, once a window has been seeded. */
    private assignInsertedItemIds(window: CastQueueWindow, entryIds: string[]): void {
        if (window.nextItemId === null || window.inferenceOff) {
            window.seedable = false;
            return;
        }
        for (const id of entryIds) {
            this.queueItemIdByEntryId.set(id, window.nextItemId++);
            window.inferred.add(id);
        }
    }

    /** One contradiction is enough: fall back to observed IDs for this window. */
    private dropInferredItemIds(window: CastQueueWindow, detail: string): void {
        for (const id of window.inferred) this.queueItemIdByEntryId.delete(id);
        window.inferred.clear();
        window.inferenceOff = true;
        window.nextItemId = null;
        this.logCast('warn', 'queue-item-id-inference-mismatch', detail);
        this.persistQueueWindow();
    }

    /** The receiver's repeat mode as reported in its media status, if any. */
    private cafRepeatOf(mode: unknown): CastRepeat | null {
        if (mode === undefined || mode === null) return null;
        if (mode === this.getRepeatMode('all')) return 'all';
        if (mode === this.getRepeatMode('one')) return 'one';
        return 'none';
    }

    /** Queue edits that bypass the store's per-edit hooks (Undo) reconcile here. */
    public reconcileQueueEdits(): void {
        if (this.queueWindow?.session === this.castContext?.getCurrentSession?.()) void this.reconcileQueueWindow(true);
    }

    /**
     * Jump to a specific index in the cast queue.
     * Much faster than reloading the entire queue for next/prev navigation.
     */
    public async jumpToQueueIndex(index: number) {
        const state = usePlayerStore.getState();
        await this.ensureQueuePlayback(state.playlist, index, state.repeat);
    }

    /**
     * Appends a new track to the end of the active Cast queue without interrupting playback.
     */
    public async appendToQueue(track: { queueEntryId?: string; url?: string; rawUrl?: string; title?: string; artist?: string; artUrl?: string; album?: string; format?: string; duration?: number }) {
        if (this.queueLoadingSession && this.queueLoadingSession === this.castContext?.getCurrentSession?.()) {
            this.queueWindowEditSeq++; // reconciled once the load has landed
            return;
        }
        if (this.queueWindow?.session === this.castContext?.getCurrentSession?.()) {
            await this.reconcileQueueWindow(true);
            return;
        }
        if (!this.isConnected()) return;
        const session = this.castContext.getCurrentSession();
        if (!session) {
            this.logCast('warn', 'Cast queue append skipped: no session', `title=${track.title || 'unknown'}`);
            return;
        }
        // Infinity Mode appends exactly when a short queue is running out, which
        // is when the sender is most likely to be between media sessions. This
        // used to return silently: the track entered the local playlist, never
        // reached the device, and playback simply stopped at the end of the
        // queue with nothing logged. Prod every attempt, 2026-09-01. Prod the
        // receiver for a status and retry once before giving up.
        let mediaSession = session.getMediaSession();
        const queueEntryId = track.queueEntryId || createQueueEntryId();
        if (!mediaSession) {
            // The receiver can insert it itself, which needs no media session
            // on this side at all — the condition behind every failure above.
            if (this.sendReceiverQueueInsert(this.buildQueueItem({ ...track, queueEntryId }), 'end', track.title)) return;
            this.logCast('warn', 'Cast queue append: no media session, requesting status', `title=${track.title || 'unknown'}`);
            this.requestMediaStatusBroadcast(Date.now() - this.lastRemotePlayerEventAt);
            await new Promise((resolve) => setTimeout(resolve, 1000));
            mediaSession = session.getMediaSession();
        }
        if (!mediaSession) {
            this.logCast('error', 'Cast queue append failed: no media session', `title=${track.title || 'unknown'}`);
            return;
        }
        const item = this.buildQueueItem({ ...track, queueEntryId });

        try {
            await this.runCastCommand('queue-append', async () => {
                const activeMediaSession = this.getMediaSession();
                if (!activeMediaSession) throw new Error('No active Cast media session');
                return activeMediaSession.queueAppendItem(item);
            });
            this.syncQueueItemMapFromSession(this.getMediaSession());
            this.logCast('ok', 'Appended track to Cast queue', `title=${track.title || 'unknown'}`);
        } catch (e) {
            console.error('[Cast] Failed to append track to queue:', e);
            this.logCast('error', 'Failed to append Cast queue item', this.describeError(e));
        }
    }

    public async insertNextInQueue(track: { queueEntryId?: string; url?: string; rawUrl?: string; title?: string; artist?: string; artUrl?: string; album?: string; format?: string; duration?: number }) {
        if (this.queueLoadingSession && this.queueLoadingSession === this.castContext?.getCurrentSession?.()) {
            this.queueWindowEditSeq++; // reconciled once the load has landed
            return;
        }
        if (this.queueWindow?.session === this.castContext?.getCurrentSession?.()) {
            await this.reconcileQueueWindow(true);
            return;
        }
        if (!this.isConnected()) return;
        const mediaSession = this.getMediaSession();
        const item = this.buildQueueItem({
            ...track,
            queueEntryId: track.queueEntryId || createQueueEntryId(),
        });
        if (!mediaSession) {
            if (this.sendReceiverQueueInsert(item, 'next', track.title)) return;
            // This used to return silently: the track went into the local queue
            // as "next" and never reached the device.
            this.logCast('error', 'Cast play-next failed: no media session', `title=${track.title || 'unknown'}`);
            return;
        }

        const request = new chrome.cast.media.QueueInsertItemsRequest([item]);
        // Media sessions expose currentItemId, not an index — derive the
        // position from it. Without insertBefore the item appends to the end,
        // which is only correct when the current item is already last.
        const items = mediaSession.items;
        const currentItemId = mediaSession.currentItemId;
        if (Array.isArray(items) && typeof currentItemId === 'number') {
            const currentIndex = items.findIndex((queueItem: any) => queueItem?.itemId === currentItemId);
            if (currentIndex >= 0 && currentIndex < items.length - 1) {
                request.insertBefore = items[currentIndex + 1].itemId;
            }
        }

        try {
            await this.runCastCommand('queue-insert', async () => {
                const activeMediaSession = this.getMediaSession();
                if (!activeMediaSession) throw new Error('No active Cast media session');
                return activeMediaSession.queueInsertItems(request);
            });
            this.syncQueueItemMapFromSession(this.getMediaSession());
        } catch (e) {
            console.error('[Cast] Failed to insert track after current item:', e);
            this.logCast('error', 'Failed to insert Cast queue item', this.describeError(e));
        }
    }

    public async removeFromQueue(queueEntryId: string) {
        if (this.queueLoadingSession && this.queueLoadingSession === this.castContext?.getCurrentSession?.()) {
            this.queueWindowEditSeq++; // reconciled once the load has landed
            return;
        }
        if (this.queueWindow?.session === this.castContext?.getCurrentSession?.()) {
            await this.reconcileQueueWindow(true);
            return;
        }
        if (!this.isConnected()) return;
        const mediaSession = this.getMediaSession();
        if (!mediaSession) return;

        const itemId = this.getQueueItemId(queueEntryId, mediaSession);
        if (itemId === null) return;
        try {
            await this.runCastCommand('queue-remove', async () => {
                const activeMediaSession = this.getMediaSession();
                if (!activeMediaSession) throw new Error('No active Cast media session');
                return activeMediaSession.queueRemoveItem(itemId);
            });
            this.syncQueueItemMapFromSession(this.getMediaSession());
        } catch (e) {
            console.error('[Cast] Failed to remove track from queue:', e);
            this.logCast('error', 'Failed to remove Cast queue item', this.describeError(e));
        }
    }

    public async moveQueueItem(queueEntryId: string, newIndex: number) {
        if (this.queueLoadingSession && this.queueLoadingSession === this.castContext?.getCurrentSession?.()) {
            this.queueWindowEditSeq++; // reconciled once the load has landed
            return;
        }
        if (this.queueWindow?.session === this.castContext?.getCurrentSession?.()) {
            await this.reconcileQueueWindow(true);
            return;
        }
        if (!this.isConnected()) return;
        const mediaSession = this.getMediaSession();
        if (!mediaSession) return;

        const itemId = this.getQueueItemId(queueEntryId, mediaSession);
        if (itemId === null) return;
        try {
            await this.runCastCommand('queue-move', async () => {
                const activeMediaSession = this.getMediaSession();
                if (!activeMediaSession) throw new Error('No active Cast media session');
                return activeMediaSession.queueMoveItemToNewIndex(itemId, newIndex);
            });
            this.syncQueueItemMapFromSession(this.getMediaSession());
        } catch (e) {
            console.error('[Cast] Failed to reorder Cast queue:', e);
            this.logCast('error', 'Failed to reorder Cast queue', this.describeError(e));
        }
    }

    public async setRepeatMode(repeat: 'none' | 'one' | 'all') {
        if (this.queueLoadingSession && this.queueLoadingSession === this.castContext?.getCurrentSession?.()) {
            this.queueWindowEditSeq++; // reconciled once the load has landed
            return;
        }
        if (this.queueWindow?.session === this.castContext?.getCurrentSession?.()) {
            await this.reconcileQueueWindow(true);
            return;
        }
        if (!this.isConnected()) return;
        const mediaSession = this.getMediaSession();
        if (!mediaSession) return;
        try {
            await this.runCastCommand('queue-repeat-mode', async () => {
                const activeMediaSession = this.getMediaSession();
                if (!activeMediaSession) throw new Error('No active Cast media session');
                return activeMediaSession.queueSetRepeatMode(this.getRepeatMode(repeat));
            });
        } catch (e) {
            console.error('[Cast] Failed to update repeat mode:', e);
            this.logCast('error', 'Failed to update Cast repeat mode', this.describeError(e));
        }
    }

    public playOrPause() {
        if (this.playbackRetry) { void this.retryConnectionFromUi(); return; }
        if (this.playbackConfirmation.pending) { this.pause(); return; }
        if (this.tryTransportViaMediaSession('play-or-pause', 'toggle')) return;
        try {
            if (!this.playerController) {
                this.logCast('warn', 'Cast play/pause ignored: no RemotePlayer controller');
                return;
            }
            this.playerController.playOrPause();
        } catch (error) {
            this.handleControlError('play-or-pause', error);
        }
    }

    public pause() {
        // A LOAD in flight was sent with autoplay. Abandoning it (as bumping
        // the load generation did) left the receiver playing with no window
        // and no refill; let it land, then pause the media it created.
        if (this.queueLoadingSession && this.queueLoadingSession === this.castContext?.getCurrentSession?.()) {
            this.pauseAfterLoadGeneration = this.queueLoadGeneration;
        }
        this.playbackConfirmation.cancel();
        this.playbackRetry = null;
        if (this.tryTransportViaMediaSession('pause', 'pause')) return;
        try {
            if (!this.playerController) {
                this.logCast('warn', 'Cast pause ignored: no RemotePlayer controller');
                return;
            }
            if (this.player?.isPaused) return;
            this.playerController.playOrPause();
        } catch (error) {
            this.handleControlError('pause', error);
        }
    }

    public resume() {
        if (this.playbackRetry) { void this.retryConnectionFromUi(); return; }
        if (this.tryTransportViaMediaSession('resume', 'play')) return;
        try {
            if (!this.playerController) {
                this.logCast('warn', 'Cast resume ignored: no RemotePlayer controller');
                return;
            }
            if (!this.player?.isPaused) return;
            this.playerController.playOrPause();
        } catch (error) {
            this.handleControlError('resume', error);
        }
    }

    public stop() {
        this.queueLoadingSession = null;
        this.queueWindow = null;
        this.queueLoadRetry = null;
        this.playbackConfirmation.cancel();
        this.playbackRetry = null;
        this.queueLoadGeneration++;
        try {
            if (this.playerController) {
                this.playerController.stop();
            }
        } catch (error) {
            this.handleControlError('stop', error);
        }
    }

    public seek(time: number) {
        if (this.playbackConfirmation.unconfirmed) {
            this.playbackConfirmation.cancel();
            this.playbackRetry = null;
        }
        const view = this.getReceiverTrackView();
        const state = usePlayerStore.getState();
        const decision = decideSeek({
            target: time,
            receiverDuration: view.duration,
            receiverIsCurrentTrack: view.isCurrentTrack,
            receiverOnDifferentTrack: view.isDifferentTrack,
            catalogDuration: state.currentIndex !== null ? state.playlist[state.currentIndex]?.duration : undefined,
        });
        if (decision.action === 'refuse') {
            this.logCast(
                'warn',
                'Cast seek refused',
                `reason=${decision.reason} target=${Number(time).toFixed(1)} trackDuration=${decision.trackDuration?.toFixed(2) ?? 'unknown'} `
                + `barDuration=${this.lastKnownDuration.toFixed(2)}`,
            );
            // The bar was drawn against the wrong length; give it the right one
            // so the next drag lands where it is aimed.
            if (decision.trackDuration !== null && decision.reason !== 'track-mismatch') {
                this.lastKnownDuration = decision.trackDuration;
                this.onDuration?.(decision.trackDuration);
            }
            return;
        }
        time = decision.time;
        if (this.trySeekViaMediaSession(time)) return;
        try {
            if (!this.playerController) {
                this.logCast('warn', 'Cast seek ignored: no RemotePlayer controller');
                return;
            }
            this.player.currentTime = time;
            this.playerController.seek();
        } catch (error) {
            this.handleControlError('seek', error);
        }
    }

    public getCurrentCastTime(): number {
        const anchor = this.positionAnchor;
        if (!anchor || anchor.entryId !== this.currentEntryId()) return 0;
        if (this.playbackConfirmation.unconfirmed) return anchor.position;
        return interpolatePosition({ anchorPosition: anchor.position, anchorAtMs: anchor.atMs,
            nowMs: Date.now(), playing: usePlayerStore.getState().playbackState === 'playing', duration: this.lastKnownDuration || null });
    }

    public async retryConnectionFromUi(): Promise<boolean> {
        const playbackRetry = this.playbackRetry;
        if (playbackRetry && playbackRetry.session === this.castContext?.getCurrentSession?.() && playbackRetry.entryId === this.currentEntryId()) {
            const state = usePlayerStore.getState();
            await this.castQueue(state.playlist, state.currentIndex ?? 0, state.repeat, playbackRetry.time);
            return this.playbackConfirmation.pending;
        }
        if (this.queueLoadRetry && this.queueLoadRetry.entryId === this.currentEntryId() && this.queueLoadRetry.session === this.castContext?.getCurrentSession?.()) {
            const retry = this.queueLoadRetry;
            const state = usePlayerStore.getState();
            await this.castQueue(state.playlist, state.playlist.findIndex(track => track.queueEntryId === retry.entryId), state.repeat, retry.time);
            return this.queueLoadRetry === null;
        }
        if (this.queueWindow?.blocked && this.queueWindow.session === this.castContext?.getCurrentSession?.()) {
            const state = usePlayerStore.getState();
            await this.castQueue(state.playlist, state.currentIndex ?? 0, state.repeat, this.lastAuroraStatus?.currentTime || 0);
            return Boolean(this.queueWindow && !this.queueWindow.blocked);
        }
        this.setHealthStatus('rejoining', 'Retrying Cast connection...', 'user-action');
        this.logCast('ok', 'User requested Cast recovery retry');
        // The user gets a fresh recovery attempt even on a session we had
        // given up on automatically.
        this.clearDeadTransport();

        const reconciled = await this.reconcileActiveSession('user-retry');
        if (reconciled) {
            this.setHealthStatus('recovered', 'Cast control reconnected.', this.getCastDeviceName());
            return true;
        }

        // Recovery already reported the dead transport; "no active media"
        // would be the wrong explanation.
        if (this.isKnownDeadTransport()) return false;

        if (this.state === 'CONNECTED' && this.castContext?.getCurrentSession?.()) {
            this.setHealthStatus('warning', 'Connected, but no active Cast media was found.');
            return false;
        }

        try {
            await this.requestSession();
            return this.isConnected();
        } catch {
            return false;
        }
    }

    public setVolume(volumeLevel: number) {
        try {
            if (this.playerController) {
                this.player.volumeLevel = volumeLevel;
                this.playerController.setVolumeLevel();
            }
        } catch (error) {
            this.handleControlError('set-volume', error);
        }
    }

    public async requestSession() {
        if (!this.castContext) {
            this.initializeCastApi();
            if (this.initializePromise) {
                await this.initializePromise;
            }
        }
        if (!this.castContext) {
            this.logCast('error', 'Cast session request blocked before SDK initialization');
            toast.error('Cast is still starting. Please try again in a moment.');
            return;
        }
        this.userSessionRequestPending = true;
        this.freshSessionStartedAt = Date.now();
        try {
            this.logCast('ok', 'User requested Cast session');
            await this.castContext.requestSession();
            this.logCast('ok', 'Cast session request resolved');
            await this.startPlaybackForCurrentSession('request-session');
        } catch (e: any) {
            console.error("Failed to request cast session", e);
            this.logCast('error', 'Cast session request failed', this.describeError(e));
            // User cancelled or an error occurred
            const msg = e?.message || String(e);
            if (!msg.includes('cancel') && !msg.includes('abort') && !msg.includes('cancelled')) {
                toast.error('Failed to connect to Cast device. Please try again.');
                this.setHealthStatus('error', 'Failed to connect to Cast device.', msg);
            } else {
                this.resetSessionAttemptState('request-session-cancelled', {
                    healthPhase: 'idle',
                    healthMessage: '',
                });
            }
        } finally {
            this.userSessionRequestPending = false;
        }
    }

    /**
     * Disconnect from the cast device.
     * Stops cast playback and resumes local playback from the current position.
     */
    /**
     * Another of the user's devices took over the playback session while this
     * one casts to a different device (or plays itself): stop casting, so the
     * Cast device goes quiet and this device can follow the new one. Unlike
     * disconnect(), nothing is handed back to this device.
     */
    public stopCastingBecauseReplaced(by: string): boolean {
        if (!this.castContext || !this.isConnected()) return false;
        this.stoppedBecauseReplaced = true;
        this.logCast('ok', 'cast-stopped-replaced', `by=${by}`);
        localStorage.removeItem(SESSION_STORAGE_KEY);
        try {
            this.suppressRemoteEndedDuringDisconnect = true;
            this.stop();
            this.castContext.endCurrentSession(true);
            return true;
        } catch (error) {
            this.stoppedBecauseReplaced = false;
            this.logCast('warn', 'cast-stop-replaced-failed', this.describeError(error));
            return false;
        }
    }

    private stoppedBecauseReplaced = false;

    public async disconnect() {
        if (!this.castContext) return;

        // Where the Cast device is now, before stopping it resets that. The
        // SESSION_ENDED that follows hands playback back to this device.
        this.castEndSnapshotAtStop = this.captureCastEndSnapshot();
        this.userStopRequested = true;
        console.log(`[Cast] Disconnecting — position: ${this.castEndSnapshotAtStop?.positionSeconds.toFixed(1) ?? 'none'}s, wasPlaying: ${this.castEndSnapshotAtStop?.wasPlaying ?? false}`);

        // Clear stored session ID before ending
        localStorage.removeItem(SESSION_STORAGE_KEY);

        try {
            // Stop the cast media first
            this.suppressRemoteEndedDuringDisconnect = true;
            this.stop();

            // End the cast session — pass true to stop the receiver app
            this.castContext.endCurrentSession(true);
        } catch (e) {
            console.error('[Cast] Error during disconnect:', e);
            toast.error('Error disconnecting from Cast device.');
        }
    }

    public getState(): CastState {
        return this.state;
    }
}

export const castManager = CastManager.getInstance();
