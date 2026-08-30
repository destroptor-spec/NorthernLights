import { playbackManager } from './PlaybackManager';
import { usePlayerStore } from '../store';
import { applyCastStreamingQualityToHlsUrl, applyStreamingQualityToHlsUrl } from './streaming';
import { createQueueEntryId, ensureQueueEntryIds } from './queue';
import type { TrackInfo } from './fileSystem';
declare const chrome: any;
declare const cast: any;

const toast = {
    success: (msg: string) => usePlayerStore.getState().addToast(msg, 'success'),
    error: (msg: string) => usePlayerStore.getState().addToast(msg, 'error'),
    info: (msg: string) => usePlayerStore.getState().addToast(msg, 'info'),
};

export type CastState = 'NO_DEVICES_AVAILABLE' | 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED';
export type CastHealthPhase = 'idle' | 'connected' | 'rejoining' | 'recovering' | 'recovered' | 'warning' | 'error';

export interface CastHealthStatus {
    phase: CastHealthPhase;
    message: string;
    detail?: string;
    updatedAt: number;
}

const SESSION_STORAGE_KEY = 'cast_session_id';
// Receiver volume applied once when a FRESH session hands playback over (some
// receivers power on reporting 100% and would blast the first track). Never
// applied when joining or rejoining an ongoing session.
const FRESH_SESSION_STARTUP_VOLUME = 0.3;
const CUSTOM_RECEIVER_HLS_CODEC = 'aac';
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
    private lastRemotePlayerEventAt = 0;
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
    private lifecycleReconcileBurstActive = false;
    private diagnosticsVerbose = false;
    private suppressRemoteEndedDuringDisconnect = false;
    private lastCastButtonStateKey = '';
    private lastRemotePlayerStateKey = '';
    private lastRemoteMediaStatusKey = '';

    // Serializes concurrent loadMedia calls to prevent session_error on rapid clicks
    private currentLoadPromise: Promise<void> = Promise.resolve();

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
        this.mediaSessionProbeStartedAt = 0;
        this.remoteMediaConcludedGone = false;
        this.statusWatchdogTimer = setInterval(() => {
            void this.runStatusWatchdogTick();
        }, 5000);
    }

    private stopStatusWatchdog() {
        if (this.statusWatchdogTimer !== null) {
            clearInterval(this.statusWatchdogTimer);
            this.statusWatchdogTimer = null;
        }
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
                if (this.remoteMediaConcludedGone) return;
                const now = Date.now();
                if (this.mediaSessionProbeStartedAt === 0) this.mediaSessionProbeStartedAt = now;
                const probedMs = now - this.mediaSessionProbeStartedAt;
                if (probedMs >= this.mediaSessionProbeGraceMs) {
                    this.concludeRemoteMediaGone(eventSilenceMs, probedMs);
                    return;
                }
                this.requestMediaStatusBroadcast(eventSilenceMs);
                return;
            }

            const refreshed = await this.refreshMediaSessionStatus('status-watchdog');
            if (refreshed && this.hasActiveRemoteMediaSession(refreshed)) {
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
    private requestMediaStatusBroadcast(eventSilenceMs: number) {
        try {
            const session = this.castContext?.getCurrentSession?.();
            if (!session || typeof session.sendMessage !== 'function') return;
            this.watchdogMediaRequestId = (this.watchdogMediaRequestId % 100000) + 1;
            void session.sendMessage('urn:x-cast:com.google.cast.media', {
                type: 'GET_STATUS',
                requestId: this.watchdogMediaRequestId,
            });
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
     * gone (queue finished, or another sender took the receiver over). Release
     * the local playing state so the watchdog's `streamLooksDead` guard goes
     * quiet and the UI stops showing a track that isn't playing. The Cast
     * session itself is left alone: the user is still connected and may queue
     * something next. Deliberately not `onEnded` — that would auto-advance a
     * queue whose remote state we've just admitted we can't see.
     */
    private concludeRemoteMediaGone(eventSilenceMs: number, probedMs: number) {
        this.remoteMediaConcludedGone = true;
        this.mediaSessionProbeStartedAt = 0;
        this.logCast('warn', 'Cast remote media gone; releasing local playing state', `eventSilenceMs=${eventSilenceMs} probedMs=${probedMs}`);
        try {
            this.onPlayStateChange?.(false);
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
        if (this.lifecycleReconcileBurstActive) return;
        this.lifecycleReconcileBurstActive = true;
        [0, 750, 2500].forEach((delay) => {
            window.setTimeout(() => {
                void this.reconcileActiveSession(`${reason}+${delay}ms`);
                if (delay === 2500) {
                    this.lifecycleReconcileBurstActive = false;
                }
            }, delay);
        });
    }

    private async recoverStaleTransport(reason: string, error?: unknown): Promise<boolean> {
        if (this.staleTransportRecoveryPromise) return this.staleTransportRecoveryPromise;

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

            for (let attempt = 0; attempt < 16; attempt += 1) {
                await this.delay(250);
                const session = this.castContext?.getCurrentSession?.() || null;
                if (!session) continue;

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
                        finish(session?.getMediaSession?.() || mediaSession);
                    },
                    (error: unknown) => {
                        this.logCast('warn', `Failed to refresh Cast media status: ${reason}`, this.describeError(error));
                        if (this.isDisconnectedPresentationError(error)) {
                            void this.recoverStaleTransport(`media-status:${reason}`, error);
                        }
                        finish(session?.getMediaSession?.() || mediaSession);
                    }
                );
            } catch (error) {
                this.logCast('warn', `Cast media status refresh threw: ${reason}`, this.describeError(error));
                if (this.isDisconnectedPresentationError(error)) {
                    void this.recoverStaleTransport(`media-status:${reason}`, error);
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
            const refreshedMediaSession = startingSession
                ? await this.refreshMediaSessionStatus(`reconcile:${reason}`)
                : null;
            const session = startingSession ? this.castContext.getCurrentSession?.() || null : null;

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
                    if (prevState !== 'CONNECTED' && this.state === 'CONNECTED' && !this.autoCastInProgress) {
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
                    switch (event.sessionState) {
                        case cast.framework.SessionState.SESSION_STARTING:
                            if (!this.rejoinSessionPending) {
                                this.freshSessionStartedAt = Date.now();
                            }
                            this.setHealthStatus('rejoining', 'Connecting to Cast device...');
                            break;

                        case cast.framework.SessionState.SESSION_STARTED:
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
                            if (treatStartedSessionAsRejoin) {
                                this.beginRejoinHydration('session-started');
                            } else if (this.userSessionRequestPending) {
                                this.scheduleFreshSessionPlayback('session-started', 250);
                            } else {
                                this.scheduleFreshSessionPlayback('session-started', 250);
                            }
                            break;

                        case cast.framework.SessionState.SESSION_RESUMED:
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
                        case cast.framework.SessionState.SESSION_ENDED:
                            console.log('[Cast] Session ended');
                            this.logCast('ok', 'SESSION_ENDED');
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
                            break;
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
                        this.setHealthStatus('error', 'Cast device disconnected.');
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
                    this.onPlayStateChange?.(!this.player.isPaused);
                }
            );

            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.CURRENT_TIME_CHANGED,
                () => {
                    this.lastRemotePlayerEventAt = Date.now();
                    this.onTimeUpdate?.(this.player.currentTime);
                }
            );

            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.DURATION_CHANGED,
                () => {
                    this.onDuration?.(this.player.duration);
                }
            );

            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.PLAYER_STATE_CHANGED,
                () => {
                    this.lastRemotePlayerEventAt = Date.now();
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
                                if (this.suppressRemoteEndedDuringDisconnect) return;
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
        this.queueItemIdByEntryId.clear();
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
        if (!mediaSession) return null;
        const currentItemId = mediaSession.currentItemId;
        if (typeof currentItemId === 'number' && Array.isArray(mediaSession.items)) {
            const currentItem = mediaSession.items.find((item: any) => item?.itemId === currentItemId);
            const currentEntryId = currentItem?.media?.customData?.queueEntryId;
            if (currentEntryId) return currentEntryId;
        }
        return mediaSession.media?.customData?.queueEntryId || null;
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
        if (typeof fallbackIndex === 'number' && fallbackIndex >= 0 && fallbackIndex < playlist.length) {
            return fallbackIndex;
        }

        const mediaUrl = this.normalizeCastUrlForMatch(mediaSession.media?.contentId);
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
        position: number;
        duration: number;
        playbackState: 'playing' | 'paused' | 'stopped';
    } | null {
        if (!mediaSession) return null;

        const media = mediaSession.media || {};
        const metadata = media.metadata || {};
        const storeTrack = sessionIndex !== null ? playlist[sessionIndex] : null;
        const duration =
            (typeof this.player?.duration === 'number' && isFinite(this.player.duration) && this.player.duration > 0
                ? this.player.duration
                : metadata.duration || storeTrack?.duration || 0) || 0;
        const position =
            (typeof this.player?.currentTime === 'number' && isFinite(this.player.currentTime) && this.player.currentTime >= 0
                ? this.player.currentTime
                : mediaSession.currentTime || 0) || 0;
        const playerState = mediaSession.playerState || this.player?.playerState;

        return {
            track: {
                ...storeTrack,
                title: storeTrack?.title || metadata.title || 'Unknown Title',
                artist: storeTrack?.artist || metadata.artist || 'Unknown Artist',
                album: storeTrack?.album || metadata.albumName || '',
                artUrl: storeTrack?.artUrl || this.getImageUrlFromMediaSession(mediaSession),
                duration,
            },
            position,
            duration,
            playbackState: this.mapCastPlayerState(playerState),
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
            position: snapshot.position,
            duration: snapshot.duration,
            forcePosition: true,
        });
    }

    public doesSessionTrackMatchStore(): boolean {
        const state = usePlayerStore.getState();
        if (state.currentIndex === null) return false;
        const sessionIndex = this.resolveTrackIndexFromSession(this.getHydratableMediaSession(), state.playlist);
        return sessionIndex === state.currentIndex;
    }

    private async hydrateSenderFromRemoteSession(mediaSession: any | null = null, reason: string = 'remote-session'): Promise<boolean> {
        mediaSession = this.getHydratableMediaSession(mediaSession);
        if (!mediaSession || !this.hasActiveRemoteMediaSession(mediaSession)) return false;

        // Stop any stale local playback before hydrating sender state from Cast.
        try {
            playbackManager.getLocalAudioElement().pause();
        } catch { /* ignore */ }

        const trackSynced = this.syncCurrentTrackFromSession(mediaSession);
        const duration =
            (typeof this.player?.duration === 'number' && isFinite(this.player.duration) && this.player.duration > 0
                ? this.player.duration
                : mediaSession.media?.metadata?.duration) || 0;
        const currentTime =
            (typeof this.player?.currentTime === 'number' && isFinite(this.player.currentTime) && this.player.currentTime >= 0
                ? this.player.currentTime
                : mediaSession.currentTime) || 0;

        if (trackSynced && this.doesSessionTrackMatchStore()) {
            this.onDuration?.(duration);
            this.onTimeUpdate?.(currentTime);
        }

        const playerState = mediaSession.playerState || this.player?.playerState;
        if (playerState === chrome.cast.media.PlayerState.PLAYING) {
            this.onPlayStateChange?.(true);
        } else if (playerState === chrome.cast.media.PlayerState.PAUSED) {
            this.onPlayStateChange?.(false);
        }

        this.syncBrowserMediaSessionFromCast(mediaSession);

        console.log(`[Cast] Hydrated sender from remote session (${reason})`);
        this.logCast('ok', `Hydrated sender from remote session: ${reason}`, `trackSynced=${trackSynced} playerState=${playerState || 'unknown'} time=${currentTime} duration=${duration}`);
        return trackSynced;
    }

    private async startPlaybackForCurrentSession(reason: string): Promise<void> {
        if (this.autoCastInProgress) return;
        if (this.castContext?.getCastState) {
            this.state = this.castContext.getCastState();
            this.notifyStateChange();
        }
        if (!this.castContext?.getCurrentSession?.()) return;

        const mediaSession = this.getHydratableMediaSession();
        if (this.hasActiveRemoteMediaSession(mediaSession)) {
            await this.hydrateSenderFromRemoteSession(mediaSession, reason);
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
        if (!mediaSession) return false;

        this.syncQueueItemMapFromSession(mediaSession);

        const state = usePlayerStore.getState();
        const sessionIndex = this.resolveTrackIndexFromSession(mediaSession, state.playlist);
        this.syncBrowserMediaSessionFromCast(mediaSession, sessionIndex);
        if (sessionIndex !== null) {
            if (sessionIndex !== state.currentIndex) {
                this.logCast('ok', 'Syncing sender track index from Cast session', `from=${state.currentIndex} to=${sessionIndex}`);
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

    private isSessionQueueMatchingTracks(tracks: { queueEntryId?: string }[], mediaSession: any | null = this.getMediaSession()): boolean {
        if (!mediaSession) return false;
        const sessionEntryIds = this.getSessionQueueEntryIds(mediaSession);
        if (sessionEntryIds.length !== tracks.length) return false;
        return tracks.every((track, index) => track.queueEntryId && track.queueEntryId === sessionEntryIds[index]);
    }

    public async ensureQueuePlayback(
        tracks: { queueEntryId?: string; url?: string; rawUrl?: string; title?: string; artist?: string; artUrl?: string; album?: string; format?: string; duration?: number }[],
        startIndex: number = 0,
        repeat: 'none' | 'one' | 'all' = 'none'
    ) {
        if (!this.isConnected()) return;
        const mediaSession = this.getMediaSession();
        if (!mediaSession || !this.isSessionQueueMatchingTracks(tracks, mediaSession)) {
            await this.castQueue(tracks, startIndex, repeat);
            return;
        }

        const desiredRepeatMode = this.getRepeatMode(repeat);
        if (mediaSession.repeatMode !== desiredRepeatMode) {
            try {
                await mediaSession.queueSetRepeatMode(desiredRepeatMode);
            } catch (e) {
                console.warn('[Cast] Failed to sync repeat mode:', e);
            }
        }

        const items = mediaSession.items;
        if (!items || !items[startIndex]) return;
        const targetItemId = items[startIndex].itemId;
        if (targetItemId === mediaSession.currentItemId) return;
        try {
            await mediaSession.queueJumpToItem(targetItemId);
        } catch (e) {
            console.error('[Cast] Failed to jump to queue item:', e);
        }
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
    public async castQueue(
        tracks: { queueEntryId?: string; url?: string; rawUrl?: string; title?: string; artist?: string; artUrl?: string; album?: string; format?: string; duration?: number }[],
        startIndex: number = 0,
        repeat: 'none' | 'one' | 'all' = 'none',
        startTime: number = 0
    ) {
        if (!this.isConnected()) return;

        const castSession = this.castContext.getCurrentSession();
        if (!castSession) return;
        const normalizedStartIndex = Math.max(0, Math.min(startIndex, tracks.length - 1));
        const normalizedStartTime = Number.isFinite(startTime) && startTime > 0 ? startTime : 0;
        const queueItems: any[] = tracks.map((track, index) => this.buildQueueItem(
            track,
            {
                includeAuthTokenInCustomData: false,
                includeArtwork: index === normalizedStartIndex,
                includeDuration: index === normalizedStartIndex,
                compactHlsUrl: true,
            }
        ));

        const startItem = queueItems[normalizedStartIndex] || queueItems[0];
        if (!startItem?.media) {
            console.error('[Cast] Cannot load queue: missing start item media');
            return;
        }
        // A queue built without playable URLs (empty contentId) would otherwise
        // be sent to the device, silently fail to load, and leave the previous
        // queue playing. Surface it instead of casting nothing.
        if (!startItem.media.contentId) {
            console.error('[Cast] Cannot load queue: start item has no content URL (unhydrated track?)');
            this.logCast('error', 'Queue load aborted: empty content URL', `startIndex=${normalizedStartIndex} title=${tracks[normalizedStartIndex]?.title || 'unknown'}`);
            toast.error('Cannot cast this queue — track URLs are missing. Try reloading.');
            return;
        }

        const startTrack = tracks[normalizedStartIndex] || tracks[0];
        const startTrackUrl = applyCastStreamingQualityToHlsUrl(
            startTrack?.url || '',
            usePlayerStore.getState().streamingQuality
        );
        const sharedAuthToken = this.extractTokenFromUrl(startTrackUrl || startTrack?.rawUrl || '');
        startItem.media.customData = {
            ...(startItem.media.customData || {}),
            ...(sharedAuthToken ? { token: sharedAuthToken } : {}),
            diagnosticsVerbose: this.diagnosticsVerbose,
        };

        const request = new chrome.cast.media.LoadRequest(startItem.media);
        request.autoplay = true;
        request.queueData = new chrome.cast.media.QueueData();
        request.queueData.items = queueItems;
        request.queueData.startIndex = normalizedStartIndex;
        if (normalizedStartTime > 0) {
            request.queueData.startTime = normalizedStartTime;
        }
        request.queueData.repeatMode = this.getRepeatMode(repeat);

        try {
            const approxPayloadChars = JSON.stringify({
                media: request.media,
                queueData: {
                    startIndex: request.queueData.startIndex,
                    startTime: request.queueData.startTime,
                    repeatMode: request.queueData.repeatMode,
                    items: request.queueData.items,
                }
            }).length;
            console.log(`[Cast] Queue load summary: items=${queueItems.length} startIndex=${normalizedStartIndex} startTime=${normalizedStartTime.toFixed(1)} approxPayloadChars=${approxPayloadChars}`);
            this.logCast('ok', 'Queue load requested', `items=${queueItems.length} startIndex=${normalizedStartIndex} startTime=${normalizedStartTime.toFixed(1)} bytesApprox=${approxPayloadChars}`);
        } catch { /* ignore */ }

        // Serialize loadMedia calls to prevent concurrent loads from clashing
        const previous = this.currentLoadPromise;
        let resolveLoad: () => void;
        this.currentLoadPromise = new Promise<void>((resolve) => { resolveLoad = resolve; });
        await previous;

        try {
            await this.runCastCommand('load-queue', async () => {
                const activeSession = this.castContext.getCurrentSession();
                if (!activeSession) throw new Error('No active Cast session');
                return activeSession.loadMedia(request);
            });
            this.logCast('ok', 'Queue load succeeded', `items=${queueItems.length} startIndex=${normalizedStartIndex}`);
        } catch (e: any) {
            const errorDetail = e?.code || e?.message || String(e);
            const errorDesc = e?.description || '';
            const describedError = this.describeError(e);
            console.error(`[Cast] Failed to load queue: ${errorDetail}${errorDesc ? ' — ' + errorDesc : ''}`, e);
            this.logCast('error', 'Failed to load queue', `${errorDetail}${errorDesc ? ' - ' + errorDesc : ''} ${describedError}`);
            const isInvalidParameter = /invalid_parameter|INVALID_PARAMETER/.test(`${errorDetail} ${errorDesc} ${describedError}`);
            if (isInvalidParameter && startTrack) {
                try {
                    const fallbackMediaInfo = this.buildMediaInfo(startTrack, {
                        includeAuthTokenInCustomData: true,
                        includeArtwork: true,
                        includeDuration: true,
                        compactHlsUrl: false,
                    });
                    const fallbackRequest = new chrome.cast.media.LoadRequest(fallbackMediaInfo);
                    fallbackRequest.autoplay = true;
                    if (normalizedStartTime > 0) {
                        fallbackRequest.currentTime = normalizedStartTime;
                    }
                    this.logCast('warn', 'Retrying Cast queue failure as current media load', `index=${normalizedStartIndex} startTime=${normalizedStartTime.toFixed(1)}`);
                    await this.runCastCommand('load-current-media-after-queue-invalid', async () => {
                        const activeSession = this.castContext.getCurrentSession();
                        if (!activeSession) throw new Error('No active Cast session');
                        return activeSession.loadMedia(fallbackRequest);
                    });
                    this.queueItemIdByEntryId.clear();
                    const sessionId = castSession.getSessionId();
                    if (sessionId) {
                        localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
                    }
                    this.logCast('warn', 'Cast queue load fell back to current track', `index=${normalizedStartIndex} title=${startTrack.title || 'Unknown Title'}`);
                    return;
                } catch (fallbackError) {
                    console.error('[Cast] Current media fallback after queue failure also failed:', fallbackError);
                    this.logCast('error', 'Cast queue fallback failed', this.describeError(fallbackError));
                }
            }
            if (!String(errorDetail).includes('cancel') && !String(errorDetail).includes('abort')) {
                toast.error('Failed to load queue on Cast device.');
            }
            return;
        } finally {
            resolveLoad!();
        }

        // Store session ID for rejoin
        const sessionId = castSession.getSessionId();
        if (sessionId) {
            localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
        }
        this.syncQueueItemMapFromSession(castSession.getMediaSession());
    }

    /**
     * Jump to a specific index in the cast queue.
     * Much faster than reloading the entire queue for next/prev navigation.
     */
    public async jumpToQueueIndex(index: number) {
        if (!this.isConnected()) return;
        const mediaSession = this.getMediaSession();
        if (!mediaSession) return;

        const items = mediaSession.items;
        if (!items || !items[index]) return;
        const itemId = items[index].itemId;

        // Jump to the specified item in the cast queue
        try {
            await this.runCastCommand('queue-jump', async () => {
                const activeMediaSession = this.getMediaSession();
                if (!activeMediaSession) throw new Error('No active Cast media session');
                return activeMediaSession.queueJumpToItem(itemId);
            });
        } catch (e) {
            console.error('[Cast] Failed to jump to queue index:', e);
            this.logCast('error', 'Failed to jump to Cast queue item', this.describeError(e));
        }
    }

    /**
     * Appends a new track to the end of the active Cast queue without interrupting playback.
     */
    public async appendToQueue(track: { queueEntryId?: string; url?: string; rawUrl?: string; title?: string; artist?: string; artUrl?: string; album?: string; format?: string; duration?: number }) {
        if (!this.isConnected()) return;
        const session = this.castContext.getCurrentSession();
        if (!session) return;
        const mediaSession = session.getMediaSession();
        if (!mediaSession) return;
        const item = this.buildQueueItem({
            ...track,
            queueEntryId: track.queueEntryId || createQueueEntryId(),
        });

        try {
            await this.runCastCommand('queue-append', async () => {
                const activeMediaSession = this.getMediaSession();
                if (!activeMediaSession) throw new Error('No active Cast media session');
                return activeMediaSession.queueAppendItem(item);
            });
            this.syncQueueItemMapFromSession(this.getMediaSession());
        } catch (e) {
            console.error('[Cast] Failed to append track to queue:', e);
            this.logCast('error', 'Failed to append Cast queue item', this.describeError(e));
        }
    }

    public async insertNextInQueue(track: { queueEntryId?: string; url?: string; rawUrl?: string; title?: string; artist?: string; artUrl?: string; album?: string; format?: string; duration?: number }) {
        if (!this.isConnected()) return;
        const mediaSession = this.getMediaSession();
        if (!mediaSession) return;

        const item = this.buildQueueItem({
            ...track,
            queueEntryId: track.queueEntryId || createQueueEntryId(),
        });
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
        try {
            if (this.playerController) {
                this.playerController.playOrPause();
            }
        } catch (error) {
            this.handleControlError('play-or-pause', error);
        }
    }

    public pause() {
        try {
            if (this.playerController && !this.player.isPaused) {
                this.playerController.playOrPause();
            }
        } catch (error) {
            this.handleControlError('pause', error);
        }
    }

    public resume() {
        try {
            if (this.playerController && this.player.isPaused) {
                this.playerController.playOrPause();
            }
        } catch (error) {
            this.handleControlError('resume', error);
        }
    }

    public stop() {
        try {
            if (this.playerController) {
                this.playerController.stop();
            }
        } catch (error) {
            this.handleControlError('stop', error);
        }
    }

    public seek(time: number) {
        try {
            if (this.playerController) {
                this.player.currentTime = time;
                this.playerController.seek();
            }
        } catch (error) {
            this.handleControlError('seek', error);
        }
    }

    public getCurrentCastTime(): number {
        return this.player?.currentTime ?? 0;
    }

    public async retryConnectionFromUi(): Promise<boolean> {
        this.setHealthStatus('rejoining', 'Retrying Cast connection...', 'user-action');
        this.logCast('ok', 'User requested Cast recovery retry');

        const reconciled = await this.reconcileActiveSession('user-retry');
        if (reconciled) {
            this.setHealthStatus('recovered', 'Cast control reconnected.', this.getCastDeviceName());
            return true;
        }

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
    public async disconnect() {
        if (!this.castContext) return;

        // Capture current cast playback position
        const castTime = this.getCurrentCastTime();
        const isPlaying = this.player && !this.player.isPaused;

        console.log(`[Cast] Disconnecting — position: ${castTime.toFixed(1)}s, wasPlaying: ${isPlaying}`);

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

        // Resume local playback at the position we left off
        try {
            const trackInfo = playbackManager.getCurrentTrackInfo();
            if (trackInfo && (castTime > 0 || isPlaying)) {
                await playbackManager.resumeLocalAt(castTime, Boolean(isPlaying));
            }
        } catch (e) {
            console.error('[Cast] Error resuming local playback after disconnect:', e);
        }
    }

    public getState(): CastState {
        return this.state;
    }
}

export const castManager = CastManager.getInstance();
