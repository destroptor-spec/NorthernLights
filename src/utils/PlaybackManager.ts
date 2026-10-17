import type Hls from 'hls.js';
import { castManager } from './CastManager';
import { dbToLinear } from './loudness';

// hls.js is ~512 KB. Load it lazily on first HLS playback so cast-only
// or never-played sessions don't pay for it on initial paint.
let HlsCtor: typeof Hls | null = null;
let hlsLoadPromise: Promise<typeof Hls> | null = null;
async function loadHls(): Promise<typeof Hls> {
    if (HlsCtor) return HlsCtor;
    if (!hlsLoadPromise) {
        hlsLoadPromise = import('hls.js').then((mod) => {
            HlsCtor = mod.default;
            return HlsCtor;
        });
    }
    return hlsLoadPromise;
}
import { usePlayerStore, type PlaybackTelemetry } from '../store';
import { getPlaybackTimeSnapshot, setPlaybackCurrentTime } from '../store/playbackTime';
import {
    AdaptiveHlsTelemetryTracker,
    applyAdaptiveDataSaverLevelCap,
    applyStreamingQualityToHlsUrl,
    getAdaptiveInitialBandwidthEstimate,
    getBrowserNetworkInformation,
    isDataSaverEnabled,
    type BrowserNetworkInformation,
} from './streaming';
import { canBrowserPlayNative } from './losslessCapability';
import { backgroundPrefetchSkipReason } from './PreloadManager';
import type { PlaybackLoadPath } from '../store';
import { logPlaybackInfo } from './playbackDebug';
import { audioOutputManager } from './AudioOutputManager';
import type { TrackInfo } from './fileSystem';
import {
    isRecentContinuitySnapshot,
    readPlaybackContinuitySnapshot,
    savePlaybackContinuitySnapshot,
} from './playbackContinuity';

export type PlaybackState = 'playing' | 'paused' | 'stopped';

class PlaybackManager {
    private static instance: PlaybackManager;
    private audio: HTMLAudioElement;
    private audioContext: AudioContext | null = null;
    // Loudness-normalization gain, wired per <audio> element (source → gain →
    // destination). Kept per element because promotePreparedAudio() swaps the
    // active element; activeGainNode always points at the current element's node.
    private webAudioNodes = new WeakMap<HTMLAudioElement, { source: MediaElementAudioSourceNode; gain: GainNode }>();
    private activeGainNode: GainNode | null = null;
    private currentLoudnessGainDb: number | null = null; // null → unity (no normalization)
    // On browsers without AudioContext.setSinkId (Firefox, Safari) the graph
    // exits through a MediaStream bridge element whose element-level sink CAN
    // be routed; on Chromium these stay null and ctx.destination is used.
    private bridgeDestination: MediaStreamAudioDestinationNode | null = null;
    private bridgeAudio: HTMLAudioElement | null = null;
    private hls: Hls | null = null;
    private nextAudio: HTMLAudioElement | null = null;
    private nextHls: Hls | null = null;
    private nextUrlKey: string | null = null;
    private transitionStartedAt: number | null = null;
    private localVolume = 1;
    private localMuted = false;
    private lastPrepareFailureReason: string | null = null;
    
    // Internal state to track what's playing in case we switch to Cast mid-stream
    private currentUrl: string | null = null;
    private currentTitle: string | null = null;
    private currentArtist: string | null = null;
    private currentArtUrl: string | null = null;
    private currentAlbum: string | null = null;
    private currentFormat: string | null = null;
    private currentPlaylistUrl: string | null = null;
    private currentHlsAuthToken = '';
    private hlsRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    private hlsNetworkRetryCount = 0;
    private hlsMediaRetryCount = 0;
    private hlsRebuildRetryCount = 0;
    private adaptiveFallbackAttempted = false;
    private readonly adaptiveTelemetryTracker = new AdaptiveHlsTelemetryTracker();
    private networkInformation: BrowserNetworkInformation | null = null;
    private readonly maxHlsNetworkRetries = 5;
    private readonly maxHlsMediaRetries = 2;
    private readonly maxHlsRebuildRetries = 2;
    private readonly mediaSessionPositionIntervalMs = 5000;
    private lastMediaSessionPositionUpdate = 0;
    private lastMediaErrorToastAt = 0;
    // Screen Wake Lock — keeps the phone screen from sleeping mid-track. Typed
    // structurally to avoid depending on lib.dom's WakeLockSentinel being present.
    private wakeLock: { release: () => Promise<void>; addEventListener: (t: 'release', cb: () => void) => void } | null = null;

    // Store callbacks for Zustand to update its state
    private onTimeUpdateCallback?: (time: number) => void;
    private onDurationCallback?: (duration: number) => void;
    private onEndedCallback?: () => void;
    private onPlayStateChangeCallback?: (state: PlaybackState) => void;
    private onVolumeChangeCallback?: (volume: number) => void;
    private onMuteChangeCallback?: (muted: boolean) => void;
    private onTrackChangeCallback?: (index: number) => void;
    private onBufferingChangeCallback?: (isBuffering: boolean) => void;

    private constructor() {
        this.audio = this.createAudioElement();
        this.attachAudioEvents(this.audio);
        this.networkInformation = getBrowserNetworkInformation();
        this.networkInformation?.addEventListener('change', this.handleNetworkInformationChange);

        // Set up CastManager listeners
        castManager.onTimeUpdate = (time) => {
            if (castManager.isConnected() && castManager.doesSessionTrackMatchStore()) {
                this.onTimeUpdateCallback?.(time);
                this.updateMediaSessionPosition();
            }
        };
        castManager.onDuration = (duration) => {
            if (castManager.isConnected() && castManager.doesSessionTrackMatchStore()) {
                this.onDurationCallback?.(duration);
                this.updateMediaSessionPosition(true);
            }
        };
        castManager.onPlayStateChange = (isPlaying) => {
            if (castManager.isConnected()) {
                this.onPlayStateChangeCallback?.(isPlaying ? 'playing' : 'paused');
                this.updateMediaSessionPlaybackState(isPlaying ? 'playing' : 'paused');
            }
        };
        castManager.onEnded = () => {
            if (castManager.isConnected()) {
                this.onPlayStateChangeCallback?.('stopped');
                this.updateMediaSessionPlaybackState('none');
                this.onEndedCallback?.();
            }
        };
        castManager.onVolumeChange = (volume) => {
            if (castManager.isConnected()) this.onVolumeChangeCallback?.(volume);
        };
        castManager.onMuteChange = (muted) => {
            if (castManager.isConnected()) this.onMuteChangeCallback?.(muted);
        };
        castManager.onTrackChange = (index) => {
            if (castManager.isConnected()) this.onTrackChangeCallback?.(index);
        };

        this.configureMediaSessionActionHandlers();
        this.attachLifecycleHandlers();
    }

    private readonly handleNetworkInformationChange = (): void => {
        this.applyDataSaverCap(this.hls);
        this.applyDataSaverCap(this.nextHls);
    };

    private createAudioElement(): HTMLAudioElement {
        const audio = new Audio();
        audio.crossOrigin = 'anonymous';
        audio.preload = 'auto';
        audio.volume = this.localVolume;
        audio.muted = this.localMuted;
        audioOutputManager.registerElement(audio);
        return audio;
    }

    private syncLocalAudioOutputState(audio: HTMLAudioElement | null): void {
        if (!audio) return;
        audio.volume = this.localVolume;
        audio.muted = this.localMuted;
    }

    private getErrorMessage(error: unknown): string {
        if (error instanceof Error) return error.message;
        if (error instanceof DOMException) return error.message || error.name;
        if (typeof error === 'string') return error;
        return 'unknown playback error';
    }

    /**
     * Surface an otherwise-silent playback failure to the user with a manual
     * "Skip" recovery action. Throttled so a burst of media errors can't stack
     * toasts. We deliberately do NOT auto-advance — that risks an infinite skip
     * loop if every track in the queue fails.
     */
    private notifyPlaybackError(message: string): void {
        const now = performance.now();
        if (now - this.lastMediaErrorToastAt < 4000) return;
        this.lastMediaErrorToastAt = now;
        this.onBufferingChangeCallback?.(false);
        try {
            usePlayerStore.getState().addToast(message, 'error', {
                actionLabel: 'Skip',
                onAction: () => { void usePlayerStore.getState().nextTrack(); },
                duration: 6000,
            });
        } catch {
            // Store not ready (e.g. during teardown) — swallow.
        }
    }

    // Acquire a screen wake lock so the device doesn't sleep during playback.
    // No-ops when unsupported, when the tab isn't visible (the API requires
    // visibility), or when one is already held. Failures are swallowed — a wake
    // lock is a best-effort nicety, never required for playback.
    private async acquireWakeLock(): Promise<void> {
        try {
            const wl = (navigator as any).wakeLock;
            if (!wl || this.wakeLock) return;
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
            const sentinel = await wl.request('screen');
            this.wakeLock = sentinel;
            // The OS auto-releases on tab hide; clear our handle so reconcile() can re-acquire.
            sentinel.addEventListener('release', () => { this.wakeLock = null; });
        } catch {
            this.wakeLock = null;
        }
    }

    private releaseWakeLock(): void {
        const wl = this.wakeLock;
        this.wakeLock = null;
        if (wl) { void wl.release().catch(() => {}); }
    }

    private attachAudioEvents(audio: HTMLAudioElement): void {
        // Set up standard event listeners
        audio.addEventListener('timeupdate', () => {
            if (!castManager.isConnected() && audio === this.audio) {
                this.onTimeUpdateCallback?.(audio.currentTime);
                this.updateMediaSessionPosition();
            }
        });

        audio.addEventListener('loadedmetadata', () => {
            if (!castManager.isConnected() && audio === this.audio) {
                this.onDurationCallback?.(audio.duration || 0);
            }
        });

        // hls.js updates the media element's duration asynchronously after manifest parsing.
        // 'durationchange' fires when that happens, giving us the real VOD duration.
        audio.addEventListener('durationchange', () => {
            if (!castManager.isConnected() && audio === this.audio && isFinite(audio.duration) && audio.duration > 0) {
                this.onDurationCallback?.(audio.duration);
                this.updateMediaSessionPosition(true);
            }
        });

        audio.addEventListener('ended', () => {
            if (!castManager.isConnected() && audio === this.audio) {
                this.transitionStartedAt = performance.now();
                this.releaseWakeLock();
                this.onPlayStateChangeCallback?.('stopped');
                this.updateMediaSessionPlaybackState('none');
                this.onEndedCallback?.();
            }
        });

        audio.addEventListener('waiting', () => {
            if (!castManager.isConnected() && audio === this.audio) {
                this.onBufferingChangeCallback?.(true);
            }
        });

        audio.addEventListener('playing', () => {
            if (!castManager.isConnected() && audio === this.audio) {
                if (this.transitionStartedAt !== null) {
                    const elapsed = performance.now() - this.transitionStartedAt;
                    logPlaybackInfo(`[Playback] Track transition audible after ${Math.round(elapsed)}ms`);
                    this.recordTelemetry({
                        lastTransitionLatencyMs: Math.round(elapsed),
                        lastAudibleAt: Date.now(),
                    });
                    this.transitionStartedAt = null;
                }
                this.onBufferingChangeCallback?.(false);
                this.updateMediaSessionPlaybackState('playing');
                this.updateMediaSessionPosition(true);
            }
        });

        audio.addEventListener('canplay', () => {
            if (!castManager.isConnected() && audio === this.audio) {
                this.onBufferingChangeCallback?.(false);
            }
        });

        audio.addEventListener('play', () => {
             if (!castManager.isConnected() && audio === this.audio) {
                void this.acquireWakeLock();
                this.onPlayStateChangeCallback?.('playing');
                this.updateMediaSessionPlaybackState('playing');
             }
        });
        audio.addEventListener('pause', () => {
             if (!castManager.isConnected() && audio === this.audio) {
                this.releaseWakeLock();
                this.onPlayStateChangeCallback?.('paused');
                this.updateMediaSessionPlaybackState('paused');
                this.updateMediaSessionPosition(true);
             }
        });

        // Fatal media-element errors (decode failure, unsupported codec, network
        // abort, native-iOS-HLS failure). When hls.js owns the pipeline it runs its
        // own ERROR recovery (attachActiveHlsRecovery), so we only surface here for
        // the non-hls paths (native HLS, blob/file, direct media) to avoid double
        // toasts during recoverable hls.js hiccups.
        audio.addEventListener('error', () => {
            if (castManager.isConnected() || audio !== this.audio) return;
            if (this.hls) return; // hls.js error handler is responsible
            const mediaError = audio.error;
            logPlaybackInfo(`[Playback] Media element error: code ${mediaError?.code ?? 'unknown'} — ${mediaError?.message || ''}`);
            this.onPlayStateChangeCallback?.('paused');
            this.updateMediaSessionPlaybackState('paused');
            this.notifyPlaybackError('Playback failed for this track.');
        });
    }

    public static getInstance(): PlaybackManager {
        if (!PlaybackManager.instance) {
            PlaybackManager.instance = new PlaybackManager();
        }
        return PlaybackManager.instance;
    }

    // --- Callbacks Setup ---
    public setCallbacks(callbacks: {
        onTimeUpdate?: (time: number) => void;
        onDuration?: (duration: number) => void;
        onEnded?: () => void;
        onPlayStateChange?: (state: PlaybackState) => void;
        onVolumeChange?: (volume: number) => void;
        onMuteChange?: (muted: boolean) => void;
        onTrackChange?: (index: number) => void;
        onBufferingChange?: (isBuffering: boolean) => void;
    }) {
        this.onTimeUpdateCallback = callbacks.onTimeUpdate;
        this.onDurationCallback = callbacks.onDuration;
        this.onEndedCallback = callbacks.onEnded;
        this.onPlayStateChangeCallback = callbacks.onPlayStateChange;
        this.onVolumeChangeCallback = callbacks.onVolumeChange;
        this.onMuteChangeCallback = callbacks.onMuteChange;
        this.onTrackChangeCallback = callbacks.onTrackChange;
        this.onBufferingChangeCallback = callbacks.onBufferingChange;
    }

    private configureMediaSessionActionHandlers(): void {
        if (!('mediaSession' in navigator)) return;

        const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler | null>> = {
            play: () => { void usePlayerStore.getState().resume(); },
            pause: () => usePlayerStore.getState().pause(),
            previoustrack: () => { void usePlayerStore.getState().prevTrack(); },
            nexttrack: () => { void usePlayerStore.getState().nextTrack(); },
            seekbackward: (details) => {
                const offset = details.seekOffset || 10;
                const { currentTime } = getPlaybackTimeSnapshot();
                const current = castManager.isConnected() ? currentTime : this.getCurrentTime();
                this.seek(Math.max(0, current - offset));
            },
            seekforward: (details) => {
                const offset = details.seekOffset || 10;
                const { currentTime, duration: remoteDuration } = getPlaybackTimeSnapshot();
                const current = castManager.isConnected() ? currentTime : this.getCurrentTime();
                const duration = castManager.isConnected() ? remoteDuration : this.getDuration();
                this.seek(duration > 0 ? Math.min(duration, current + offset) : current + offset);
            },
            seekto: (details) => {
                if (typeof details.seekTime === 'number') {
                    this.seek(details.seekTime);
                }
            },
            stop: () => usePlayerStore.getState().stop(),
        };

        for (const [action, handler] of Object.entries(handlers) as [MediaSessionAction, MediaSessionActionHandler][]) {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch {
                // Older browsers may expose Media Session but not every action.
            }
        }
    }

    private updateMediaSessionMetadata(): void {
        if (!('mediaSession' in navigator)) return;

        const artworkType = this.inferArtworkMimeType(this.currentArtUrl);
        const artwork = this.currentArtUrl
            ? [
                { src: this.currentArtUrl, sizes: '96x96', type: artworkType },
                { src: this.currentArtUrl, sizes: '128x128', type: artworkType },
                { src: this.currentArtUrl, sizes: '192x192', type: artworkType },
                { src: this.currentArtUrl, sizes: '512x512', type: artworkType },
            ]
            : [
                { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
            ];

        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: this.currentTitle || 'Unknown Title',
                artist: this.currentArtist || 'Unknown Artist',
                album: this.currentAlbum || 'Aurora',
                artwork,
            });
            this.updateMediaSessionPosition(true);
        } catch (error) {
            console.warn('[Playback] Failed to update Media Session metadata:', error);
        }
    }

    private inferArtworkMimeType(url: string | null): string {
        if (!url) return 'image/png';
        try {
            const pathname = new URL(url, window.location.origin).pathname.toLowerCase();
            if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
            if (pathname.endsWith('.webp')) return 'image/webp';
            if (pathname.endsWith('.gif')) return 'image/gif';
        } catch {
            const lower = url.toLowerCase();
            if (lower.includes('.jpg') || lower.includes('.jpeg')) return 'image/jpeg';
            if (lower.includes('.webp')) return 'image/webp';
            if (lower.includes('.gif')) return 'image/gif';
        }
        return 'image/png';
    }

    private updateMediaSessionPlaybackState(state: MediaSessionPlaybackState): void {
        if (!('mediaSession' in navigator)) return;
        navigator.mediaSession.playbackState = state;
    }

    private updateMediaSessionPosition(force = false): void {
        const timeState = getPlaybackTimeSnapshot();
        const duration = timeState.duration || this.getDuration();
        const position = castManager.isConnected() ? timeState.currentTime : this.getCurrentTime();
        this.updateMediaSessionPositionState(position, duration, force);
    }

    public syncMediaSessionFromTrack(
        track: Partial<TrackInfo> & {
            title?: string;
            artist?: string;
            album?: string;
            artUrl?: string;
            duration?: number;
        },
        options?: {
            playbackState?: PlaybackState;
            position?: number;
            duration?: number;
            forcePosition?: boolean;
        }
    ): void {
        const artist =
            track.artist ||
            (Array.isArray(track.artists) ? track.artists.join(', ') : typeof track.artists === 'string' ? track.artists : '') ||
            'Unknown Artist';

        this.currentTitle = track.title || 'Unknown Title';
        this.currentArtist = artist;
        this.currentArtUrl = track.artUrl || null;
        this.currentAlbum = track.album || null;
        this.currentFormat = track.format || null;
        this.updateMediaSessionMetadata();

        if (options?.playbackState) {
            this.updateMediaSessionPlaybackState(
                options.playbackState === 'playing'
                    ? 'playing'
                    : options.playbackState === 'paused'
                        ? 'paused'
                        : 'none'
            );
        }

        if (typeof options?.position === 'number' || typeof options?.duration === 'number') {
            const duration = options.duration || track.duration || 0;
            const position = options.position || 0;
            this.updateMediaSessionPositionState(position, duration, options.forcePosition ?? true);
        }
    }

    private attachLifecycleHandlers(): void {
        const saveSnapshot = () => this.persistContinuitySnapshot();
        const reconcile = () => {
            this.updateMediaSessionMetadata();
            const storeState = usePlayerStore.getState().playbackState;
            this.updateMediaSessionPlaybackState(
                storeState === 'playing' ? 'playing' : storeState === 'paused' ? 'paused' : 'none'
            );
            this.updateMediaSessionPosition(true);
            // The wake lock auto-releases when the tab is hidden; re-acquire it on
            // return if we're still playing locally.
            if (storeState === 'playing' && !castManager.isConnected()) {
                void this.acquireWakeLock();
            }
        };

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                saveSnapshot();
            } else {
                reconcile();
            }
        });
        window.addEventListener('pagehide', saveSnapshot);
        window.addEventListener('beforeunload', saveSnapshot);
        window.addEventListener('pageshow', reconcile);
        document.addEventListener('freeze', saveSnapshot);
        document.addEventListener('resume', reconcile);
    }

    private updateMediaSessionPositionState(position: number, duration: number, force = false): void {
        if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
        const now = Date.now();
        if (!force && now - this.lastMediaSessionPositionUpdate < this.mediaSessionPositionIntervalMs) return;
        if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;
        this.lastMediaSessionPositionUpdate = now;

        try {
            navigator.mediaSession.setPositionState({
                duration,
                playbackRate: this.audio.playbackRate || 1,
                position: Math.min(Math.max(0, position), duration),
            });
        } catch {
            // Ignore invalid transient duration/position combinations.
        }
    }

    public persistContinuitySnapshot(): void {
        const state = usePlayerStore.getState();
        const timeState = getPlaybackTimeSnapshot();
        savePlaybackContinuitySnapshot({
            playlist: state.playlist,
            currentIndex: state.currentIndex,
            currentTime: castManager.isConnected() ? timeState.currentTime : this.getCurrentTime(),
            duration: timeState.duration || this.getDuration(),
            playbackState: state.playbackState,
            wasPlaying: state.playbackState === 'playing',
            repeat: state.repeat,
            shuffle: state.shuffle,
            streamingQuality: state.streamingQuality,
        });
    }

    /**
     * `mayResume` is asked last, and may take a moment: with sync on, another
     * device may have taken over since this one closed (prod 2026-10-14
     * 20:01:13: the reopened phone resumed and took playback from the desktop).
     */
    public async restoreFromContinuitySnapshot(options: { mayResume?: () => Promise<boolean> } = {}): Promise<void> {
        const snapshot = readPlaybackContinuitySnapshot();
        if (!isRecentContinuitySnapshot(snapshot) || !snapshot.wasPlaying) return;
        if (castManager.isConnected() || castManager.hasStoredSession()) return;

        if (!usePlayerStore.getState().authToken || usePlayerStore.getState().playbackState === 'playing') return;
        if (options.mayResume && !(await options.mayResume())) return;
        const state = usePlayerStore.getState();
        if (!state.authToken || state.playbackState === 'playing' || castManager.isConnected()) return;

        const playlist = state.playlist.length > 0 ? state.playlist : snapshot.playlist;
        const index = snapshot.currentIndex;
        if (index === null || index < 0 || index >= playlist.length) return;

        try {
            if (state.playlist.length === 0) {
                await state.setPlaylist(playlist, index);
            } else {
                await state.playAtIndex(index);
            }
            if (snapshot.currentTime > 2) {
                this.seek(snapshot.currentTime);
                setPlaybackCurrentTime(snapshot.currentTime);
            }
        } catch (error) {
            console.warn('[Playback] Could not restore previous playback session:', error);
        }
    }

    // --- Core Playback Controls ---

    public async playUrl(hlsUrl: string, rawUrl: string, title?: string, artist?: string, artUrl?: string, album?: string, format?: string): Promise<void> {
        const streamingQuality = usePlayerStore.getState().streamingQuality;
        const effectiveHlsUrl = applyStreamingQualityToHlsUrl(hlsUrl, streamingQuality);
        const adaptiveRequested = streamingQuality === 'auto' && !castManager.isConnected();
        this.adaptiveFallbackAttempted = false;
        this.adaptiveTelemetryTracker.reset();
        this.recordTelemetry({
            adaptiveActiveBitrateKbps: null,
            adaptiveBandwidthEstimateKbps: adaptiveRequested
                ? Math.round(getAdaptiveInitialBandwidthEstimate(this.networkInformation) / 1000)
                : null,
            adaptiveLevelCount: 0,
            adaptiveSwitchCount: 0,
            adaptiveFallbackState: 'none',
            adaptiveNativePlayback: false,
        });

        // True lossless: when the user picks Source and the browser can decode
        // the file's native codec, bypass HLS entirely and stream the raw bytes
        // via /api/stream?pathB64=… (Range-seekable, zero transcoding). Cast
        // sessions are unaffected — CastManager strips 'source' to 128k AAC.
        const useRawPassthrough = streamingQuality === 'source' && canBrowserPlayNative(format);
        const directUrl = useRawPassthrough ? rawUrl : (effectiveHlsUrl || rawUrl);

        this.currentUrl = useRawPassthrough ? rawUrl : (effectiveHlsUrl || rawUrl);
        this.currentTitle = title || 'Unknown Title';
        this.currentArtist = artist || 'Unknown Artist';
        this.currentArtUrl = artUrl || null;
        this.currentAlbum = album || null;
        this.currentFormat = format || null;
        this.currentPlaylistUrl = !useRawPassthrough && effectiveHlsUrl.includes('.m3u8') ? effectiveHlsUrl : null;
        this.updateMediaSessionMetadata();

        try {
            if (castManager.isConnected()) {
                this.audio.pause();
                this.recordTelemetry({
                    loadPath: 'cast',
                    currentTrackTitle: this.currentTitle,
                    currentTrackArtist: this.currentArtist,
                    preparedAudioUsed: false,
                    fallbackHlsLoadUsed: false,
                    lastFallbackReason: null,
                    recoveredFromPrepareFailure: false,
                    recoveryPath: 'none',
                    recoveryError: null,
                    prebufferPolicy: usePlayerStore.getState().prebufferPolicy,
                    prebufferSkippedReason: null,
                });
                // Pass both URLs — CastManager picks based on receiver mode
                await castManager.castMedia(effectiveHlsUrl, rawUrl, this.currentTitle, this.currentArtist, this.currentArtUrl || undefined, album, format);
                return;
            }

            // Route HLS URLs through hls.js (skipped for lossless raw passthrough)
            if (!useRawPassthrough && effectiveHlsUrl.includes('.m3u8')) {
                if (this.isPreparedUrl(effectiveHlsUrl)) {
                    try {
                        await this.promotePreparedAudio();
                    } catch (error) {
                        const recoveryError = this.getErrorMessage(error);
                        console.warn('[Playback] Prepared promotion failed, falling back to normal HLS load:', error);
                        this.recordTelemetry({
                            loadPath: 'fallback-hls',
                            currentTrackTitle: this.currentTitle,
                            currentTrackArtist: this.currentArtist,
                            preparedAudioUsed: false,
                            fallbackHlsLoadUsed: true,
                            lastFallbackReason: 'promotion-failed',
                            recoveredFromPrepareFailure: true,
                            recoveryPath: 'normal-hls-after-promotion-failure',
                            recoveryError,
                            prebufferPolicy: usePlayerStore.getState().prebufferPolicy,
                            prebufferSkippedReason: null,
                        });
                        await this.playHlsWithAdaptiveFallback(effectiveHlsUrl);
                    }
                    return;
                }
                const prepareFailureReason = this.lastPrepareFailureReason;
                this.recordTelemetry({
                    loadPath: 'fallback-hls',
                    currentTrackTitle: this.currentTitle,
                    currentTrackArtist: this.currentArtist,
                    preparedAudioUsed: false,
                    fallbackHlsLoadUsed: true,
                    lastFallbackReason: prepareFailureReason ? 'prepare-failed' : this.nextUrlKey ? 'prepared-url-mismatch' : 'no-prepared-audio',
                    recoveredFromPrepareFailure: !!prepareFailureReason,
                    recoveryPath: prepareFailureReason ? 'normal-hls-after-prepare-failure' : 'none',
                    recoveryError: prepareFailureReason,
                    prebufferPolicy: usePlayerStore.getState().prebufferPolicy,
                    prebufferSkippedReason: null,
                });
                await this.playHlsWithAdaptiveFallback(effectiveHlsUrl);
                if (prepareFailureReason) {
                    this.lastPrepareFailureReason = null;
                }
                return;
            }

            // The original file of the next track, loaded ahead (prepareNextDirect).
            if (useRawPassthrough && this.isPreparedUrl(rawUrl)) {
                try {
                    await this.promotePreparedAudio('prepared-direct');
                    return;
                } catch (error) {
                    console.warn('[Playback] Prepared direct file failed, loading it again:', error);
                }
            }

            // Clean up previous HLS instance if switching away
            this.destroyHls();

            // Clean up previous URL if it exists AND is a blob
            if (this.audio.src && this.audio.src.startsWith('blob:')) {
                URL.revokeObjectURL(this.audio.src);
            }

            this.audio.src = directUrl;
            if (useRawPassthrough) {
                this.audio.preload = 'auto';
            }
            this.audio.load();
            await this.audio.play();

            this.recordTelemetry({
                loadPath: useRawPassthrough ? 'lossless-passthrough' : 'direct',
                currentTrackTitle: this.currentTitle,
                currentTrackArtist: this.currentArtist,
                preparedAudioUsed: false,
                fallbackHlsLoadUsed: false,
                lastFallbackReason: null,
                recoveredFromPrepareFailure: false,
                recoveryPath: 'none',
                recoveryError: null,
                prebufferPolicy: usePlayerStore.getState().prebufferPolicy,
                prebufferSkippedReason: null,
            });
            this.ensureAudioContext();
        } catch (error) {
            // AbortError: play() was interrupted by a new source loading — not a real error
            if (error instanceof DOMException && error.name === 'AbortError') return;
            // NotAllowedError: the browser blocked autoplay (no user gesture yet,
            // e.g. restoring a session on reload). The audio is loaded and ready —
            // surface it as paused and wait for a gesture instead of throwing,
            // which would otherwise cascade into nextTrack() through the queue.
            if (error instanceof DOMException && error.name === 'NotAllowedError') {
                this.onPlayStateChangeCallback?.('paused');
                this.updateMediaSessionPlaybackState('paused');
                return;
            }
            console.error('PlaybackManager playUrl error:', error);
            throw error;
        }
    }

    // --- HLS Playback ---

    public async prepareNextUrl(hlsUrl: string, rawUrl: string, title?: string, artist?: string, artUrl?: string, album?: string, format?: string): Promise<void> {
        if (castManager.isConnected()) return;
        const streamingQuality = usePlayerStore.getState().streamingQuality;
        const effectiveHlsUrl = applyStreamingQualityToHlsUrl(hlsUrl, streamingQuality);
        // Source quality, a file this browser plays as it is: playUrl streams
        // the original bytes, so those are what to load ahead, not HLS.
        if (streamingQuality === 'source' && canBrowserPlayNative(format)) {
            this.prepareNextDirect(rawUrl, title, artist);
            return;
        }
        const key = this.normalizePreparedUrlKey(effectiveHlsUrl || rawUrl);
        if (!key || !effectiveHlsUrl.includes('.m3u8')) return;
        if (this.nextUrlKey === key) return;

        this.destroyPreparedAudio();
        this.lastPrepareFailureReason = null;

        const Hls = await loadHls();

        // The active prepared key may have changed while we were waiting for the
        // hls.js chunk to load (e.g. user skipped tracks). Bail if so.
        if (this.nextUrlKey !== null) return;

        try {
            logPlaybackInfo(`[Playback] Preparing next HLS track: ${title || 'Unknown Title'}${artist ? ` by ${artist}` : ''}`);
            this.recordTelemetry({
                preparedTrackTitle: title || 'Unknown Title',
                preparedTrackArtist: artist || null,
                prepareStatus: 'preparing',
                prepareStartedAt: Date.now(),
                prepareReadyAt: null,
                prepareError: null,
                recoveredFromPrepareFailure: false,
                recoveryPath: 'none',
                recoveryError: null,
                prebufferPolicy: usePlayerStore.getState().prebufferPolicy,
                prebufferSkippedReason: null,
            });

            const nextAudio = this.createAudioElement();
            this.syncLocalAudioOutputState(nextAudio);
            this.attachAudioEvents(nextAudio);
            this.nextAudio = nextAudio;
            this.nextUrlKey = key;
            // Wire the prepared element's loudness chain now (context exists by
            // prebuffer time) so gapless promotion doesn't bypass the graph.
            if (this.audioContext) this.attachLoudnessChain(nextAudio);

            const authToken = new URL(effectiveHlsUrl, window.location.origin).searchParams.get('token') || '';

            if (Hls.isSupported()) {
                const nextHls = this.createHlsInstance(
                    authToken,
                    30,
                    60,
                    this.isAdaptivePlaylistUrl(effectiveHlsUrl),
                );
                this.nextHls = nextHls;
                nextHls.on(Hls.Events.MANIFEST_PARSED, () => {
                    if (nextHls !== this.nextHls) return;
                    logPlaybackInfo(`[Playback] Prepared next HLS track: ${title || 'Unknown Title'}${artist ? ` by ${artist}` : ''}`);
                    this.recordTelemetry({
                        preparedTrackTitle: title || 'Unknown Title',
                        preparedTrackArtist: artist || null,
                        prepareStatus: 'ready',
                        prepareReadyAt: Date.now(),
                        prepareError: null,
                    });
                });
                nextHls.on(Hls.Events.ERROR, (_event: string, data: any) => {
                    if (nextHls !== this.nextHls) return;
                    if (data.fatal) {
                        console.warn('[Playback] Prepared next HLS track failed:', data);
                        const prepareError = data?.details || data?.type || 'fatal HLS prepare error';
                        this.lastPrepareFailureReason = prepareError;
                        this.recordTelemetry({
                            prepareStatus: 'failed',
                            prepareError,
                        });
                        this.destroyPreparedAudio();
                    }
                });
                nextHls.loadSource(effectiveHlsUrl);
                nextHls.attachMedia(nextAudio);
            } else if (nextAudio.canPlayType('application/vnd.apple.mpegurl')) {
                nextAudio.src = effectiveHlsUrl;
                nextAudio.load();
            }
        } catch (error) {
            console.warn('[Playback] Failed to prepare next track:', error);
            const prepareError = this.getErrorMessage(error);
            this.lastPrepareFailureReason = prepareError;
            this.recordTelemetry({
                prepareStatus: 'failed',
                prepareError,
            });
            this.destroyPreparedAudio();
        }
    }

    /**
     * Loads the next track's original file in a second element while this one
     * plays, so a skip or the end of the track switches to it at once. Without
     * it every skip at Source quality fetched a lossless file from scratch
     * (prod 2026-10-17: 2–6 s per skip).
     */
    private prepareNextDirect(rawUrl: string, title?: string, artist?: string): void {
        const key = rawUrl ? this.normalizePreparedUrlKey(rawUrl) : '';
        if (!key || this.nextUrlKey === key) return;
        this.destroyPreparedAudio();
        this.lastPrepareFailureReason = null;
        const trackTitle = title || 'Unknown Title';
        // Tens of megabytes: hold back where the HLS prewarm does.
        const skipReason = backgroundPrefetchSkipReason();
        if (skipReason) {
            logPlaybackInfo(`[Playback] Not loading the next file ahead: ${skipReason}`);
            this.recordTelemetry({ prepareStatus: 'idle', preparedTrackTitle: null, preparedTrackArtist: null, prebufferSkippedReason: skipReason });
            return;
        }

        logPlaybackInfo(`[Playback] Preparing next direct file: ${trackTitle}${artist ? ` by ${artist}` : ''}`);
        this.recordTelemetry({
            preparedTrackTitle: trackTitle,
            preparedTrackArtist: artist || null,
            prepareStatus: 'preparing',
            prepareStartedAt: Date.now(),
            prepareReadyAt: null,
            prepareError: null,
            recoveredFromPrepareFailure: false,
            recoveryPath: 'none',
            recoveryError: null,
            prebufferPolicy: usePlayerStore.getState().prebufferPolicy,
            prebufferSkippedReason: null,
        });

        const nextAudio = this.createAudioElement();
        this.syncLocalAudioOutputState(nextAudio);
        this.attachAudioEvents(nextAudio);
        this.nextAudio = nextAudio;
        this.nextUrlKey = key;
        if (this.audioContext) this.attachLoudnessChain(nextAudio);
        nextAudio.addEventListener('canplay', () => {
            if (nextAudio !== this.nextAudio) return;
            logPlaybackInfo(`[Playback] Prepared next direct file: ${trackTitle}${artist ? ` by ${artist}` : ''}`);
            this.recordTelemetry({ prepareStatus: 'ready', prepareReadyAt: Date.now(), prepareError: null });
        }, { once: true });
        nextAudio.addEventListener('error', () => {
            if (nextAudio !== this.nextAudio) return;
            const prepareError = nextAudio.error?.message || `media error ${nextAudio.error?.code ?? ''}`.trim();
            console.warn('[Playback] Prepared next direct file failed:', prepareError);
            this.lastPrepareFailureReason = prepareError;
            this.recordTelemetry({ prepareStatus: 'failed', prepareError });
            this.destroyPreparedAudio();
        }, { once: true });
        nextAudio.src = rawUrl;
        nextAudio.load();
    }

    private recordTelemetry(telemetry: Partial<PlaybackTelemetry>): void {
        usePlayerStore.getState().recordPlaybackTelemetry(telemetry);
    }

    private isAdaptivePlaylistUrl(playlistUrl: string): boolean {
        try {
            return new URL(playlistUrl, window.location.origin).searchParams.get('quality') === 'auto';
        } catch {
            return false;
        }
    }

    private buildFixedFallbackUrl(playlistUrl: string): { url: string; quality: '64k' | '128k' } {
        const quality = isDataSaverEnabled(this.networkInformation) ? '64k' : '128k';
        const url = new URL(playlistUrl, window.location.origin);
        url.searchParams.set('quality', quality);
        url.searchParams.delete('maxBitrate');
        url.searchParams.delete('adaptive');
        url.searchParams.delete('rendition');
        url.searchParams.delete('ladder');
        return { url: url.toString(), quality };
    }

    private recordAdaptiveFallback(quality: '64k' | '128k', error: unknown): void {
        this.recordTelemetry({
            loadPath: 'fallback-hls',
            fallbackHlsLoadUsed: true,
            lastFallbackReason: 'adaptive-failed',
            recoveredFromPrepareFailure: false,
            recoveryPath: 'fixed-quality-after-adaptive-failure',
            recoveryError: this.getErrorMessage(error),
            adaptiveFallbackState: quality === '64k' ? 'fixed-64k' : 'fixed-128k',
            adaptiveActiveBitrateKbps: Number.parseInt(quality, 10),
            adaptiveLevelCount: 1,
            adaptiveSwitchCount: this.adaptiveTelemetryTracker.getSwitchCount(),
            adaptiveNativePlayback: false,
        });
    }

    private async playHlsWithAdaptiveFallback(playlistUrl: string): Promise<void> {
        try {
            await this.playHls(playlistUrl);
        } catch (error) {
            if (!this.isAdaptivePlaylistUrl(playlistUrl) || this.adaptiveFallbackAttempted) throw error;
            this.adaptiveFallbackAttempted = true;
            const fallback = this.buildFixedFallbackUrl(playlistUrl);
            console.warn(`[HLS] Adaptive startup failed; retrying fixed ${fallback.quality}:`, error);
            this.recordAdaptiveFallback(fallback.quality, error);
            await this.playHls(fallback.url);
        }
    }

    private async playHls(playlistUrl: string): Promise<void> {
        // Clean up previous HLS instance
        this.destroyHls();
        this.currentPlaylistUrl = playlistUrl;
        this.hlsNetworkRetryCount = 0;
        this.hlsMediaRetryCount = 0;
        this.hlsRebuildRetryCount = 0;

        // Extract auth token from the playlist URL so we can pass it to segment requests.
        // hls.js constructs segment URLs relative to the playlist but drops query params.
        const urlObj = new URL(playlistUrl, window.location.origin);
        const authToken = urlObj.searchParams.get('token') || '';
        this.currentHlsAuthToken = authToken;

        const Hls = await loadHls();
        const adaptive = this.isAdaptivePlaylistUrl(playlistUrl);

        if (Hls.isSupported()) {
            this.hls = this.createHlsInstance(authToken, 60, 120, adaptive);
            if (adaptive) this.attachAdaptiveTelemetry(this.hls);
            this.hls.loadSource(playlistUrl);
            this.hls.attachMedia(this.audio);

            // Wait for the manifest to be parsed, then play
            await new Promise<void>((resolve, reject) => {
                const onParsed = () => {
                    this.hls?.off(Hls.Events.MANIFEST_PARSED, onParsed);
                    this.hls?.off(Hls.Events.ERROR, onError);
                    if (this.hls) {
                        this.attachActiveHlsRecovery(this.hls, playlistUrl, authToken);
                    }
                    resolve();
                };

                const onError = (_event: string, data: any) => {
                    if (data.fatal) {
                        this.hls?.off(Hls.Events.MANIFEST_PARSED, onParsed);
                        this.hls?.off(Hls.Events.ERROR, onError);
                        reject(new Error(`HLS fatal error before manifest: ${data.details || data.type}`));
                    }
                };

                this.hls!.on(Hls.Events.MANIFEST_PARSED, onParsed);
                this.hls!.on(Hls.Events.ERROR, onError);
            });

            await this.safePlay();
        }
        // Fallback for iOS Safari (native HLS support)
        else if (this.audio.canPlayType('application/vnd.apple.mpegurl')) {
            if (adaptive) {
                this.recordTelemetry({
                    adaptiveActiveBitrateKbps: null,
                    adaptiveBandwidthEstimateKbps: null,
                    adaptiveLevelCount: 0,
                    adaptiveSwitchCount: 0,
                    adaptiveNativePlayback: true,
                });
            }
            this.audio.src = playlistUrl;
            // Resolve on metadata, but also reject on a media 'error' — otherwise a
            // failed native-HLS load leaves this promise (and the whole playAtIndex
            // chain) hung forever with no error surfaced to the user.
            await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    this.audio.removeEventListener('loadedmetadata', onLoaded);
                    this.audio.removeEventListener('error', onError);
                };
                const onLoaded = () => { cleanup(); resolve(); };
                const onError = () => {
                    cleanup();
                    const mediaError = this.audio.error;
                    reject(new Error(`Native HLS load failed: ${mediaError ? `code ${mediaError.code}` : 'unknown'}`));
                };
                this.audio.addEventListener('loadedmetadata', onLoaded, { once: true });
                this.audio.addEventListener('error', onError, { once: true });
            });
            await this.safePlay();
        }
        else {
            throw new Error('HLS is not supported on this browser');
        }
    }

    private createHlsInstance(
        authToken: string,
        maxBufferLength: number,
        maxMaxBufferLength: number,
        adaptive: boolean = false,
    ): Hls {
        const hls = new HlsCtor!({
            maxBufferLength,
            maxMaxBufferLength,
            backBufferLength: 90,
            fragLoadingMaxRetry: 6,
            manifestLoadingMaxRetry: 4,
            levelLoadingMaxRetry: 4,
            fragLoadingRetryDelay: 1000,
            manifestLoadingRetryDelay: 1000,
            levelLoadingRetryDelay: 1000,
            startFragPrefetch: true,
            ...(adaptive
                ? { abrEwmaDefaultEstimate: getAdaptiveInitialBandwidthEstimate(this.networkInformation) }
                : {}),
            xhrSetup: (xhr: XMLHttpRequest, _url: string) => {
                // DO NOT call xhr.open() here — hls.js has already opened the request.
                // Use setRequestHeader to inject the auth token as a Bearer header.
                if (authToken) {
                    xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
                }
            },
        });
        if (adaptive) this.applyDataSaverCap(hls);
        return hls;
    }

    private applyDataSaverCap(hls: Hls | null): void {
        if (!hls || !this.isAdaptivePlaylistUrl(hls.url || this.currentPlaylistUrl || '')) return;
        applyAdaptiveDataSaverLevelCap(hls, isDataSaverEnabled(this.networkInformation));
    }

    private attachAdaptiveTelemetry(hls: Hls): void {
        const Hls = HlsCtor!;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (hls !== this.hls) return;
            this.applyDataSaverCap(hls);
            const snapshot = this.adaptiveTelemetryTracker.onManifest(hls);
            this.recordTelemetry({
                adaptiveActiveBitrateKbps: snapshot.activeBitrateKbps,
                adaptiveBandwidthEstimateKbps: snapshot.bandwidthEstimateKbps,
                adaptiveLevelCount: snapshot.levelCount,
                adaptiveSwitchCount: snapshot.switchCount,
                adaptiveNativePlayback: false,
            });
        });
        hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
            if (hls !== this.hls) return;
            const snapshot = this.adaptiveTelemetryTracker.onLevelSwitched(hls, data.level);
            this.recordTelemetry({
                adaptiveActiveBitrateKbps: snapshot.activeBitrateKbps,
                adaptiveBandwidthEstimateKbps: snapshot.bandwidthEstimateKbps,
                adaptiveLevelCount: snapshot.levelCount,
                adaptiveSwitchCount: snapshot.switchCount,
            });
        });
    }

    private attachActiveHlsRecovery(hls: Hls, playlistUrl: string, authToken: string): void {
        const Hls = HlsCtor!;
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (hls === this.hls) {
                this.hlsNetworkRetryCount = 0;
                this.hlsMediaRetryCount = 0;
                this.onBufferingChangeCallback?.(false);
            }
        });

        hls.on(Hls.Events.ERROR, (_event: string, data: any) => {
            if (hls !== this.hls || !data?.fatal) return;

            this.onBufferingChangeCallback?.(true);
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                this.recoverHlsNetworkError(hls, data);
                return;
            }

            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
                this.recoverHlsMediaError(hls, data);
                return;
            }

            this.rebuildActiveHls(playlistUrl, authToken, data);
        });
    }

    private recoverHlsNetworkError(hls: Hls, data: any): void {
        if (this.hlsNetworkRetryCount >= this.maxHlsNetworkRetries) {
            this.rebuildActiveHls(this.currentPlaylistUrl || '', this.currentHlsAuthToken, data);
            return;
        }

        const retryNumber = ++this.hlsNetworkRetryCount;
        const delay = Math.min(15000, 1000 * Math.pow(2, retryNumber - 1));
        console.warn(`[HLS] Fatal network error; retrying load in ${delay}ms`, data);
        this.clearHlsRecoveryTimer();
        this.hlsRecoveryTimer = setTimeout(() => {
            if (hls === this.hls) {
                try {
                    hls.startLoad();
                } catch (error) {
                    console.warn('[HLS] startLoad recovery failed:', error);
                }
            }
        }, delay);
    }

    private recoverHlsMediaError(hls: Hls, data: any): void {
        if (this.hlsMediaRetryCount >= this.maxHlsMediaRetries) {
            this.rebuildActiveHls(this.currentPlaylistUrl || '', this.currentHlsAuthToken, data);
            return;
        }

        this.hlsMediaRetryCount += 1;
        console.warn('[HLS] Fatal media error; attempting recoverMediaError()', data);
        try {
            hls.recoverMediaError();
        } catch (error) {
            console.warn('[HLS] recoverMediaError failed:', error);
            this.rebuildActiveHls(this.currentPlaylistUrl || '', this.currentHlsAuthToken, data);
        }
    }

    private rebuildActiveHls(playlistUrl: string, authToken: string, data: any): void {
        if (!playlistUrl || this.hlsRebuildRetryCount >= this.maxHlsRebuildRetries) {
            if (playlistUrl && this.isAdaptivePlaylistUrl(playlistUrl) && !this.adaptiveFallbackAttempted) {
                this.adaptiveFallbackAttempted = true;
                const fallback = this.buildFixedFallbackUrl(playlistUrl);
                this.loadFixedFallbackAfterAdaptiveFailure(fallback.url, fallback.quality, authToken, data);
                return;
            }
            console.error('[HLS] Unrecoverable fatal error:', data);
            this.destroyHls();
            this.onPlayStateChangeCallback?.('paused');
            // hls.js has exhausted network/media/rebuild retries — tell the user
            // instead of leaving a silently-paused player. (destroyHls() cleared
            // this.hls, so notifyPlaybackError's hls guard no longer applies.)
            this.notifyPlaybackError('Could not stream this track after several retries.');
            return;
        }

        const position = this.getCurrentTime();
        this.hlsRebuildRetryCount += 1;
        console.warn('[HLS] Rebuilding active HLS pipeline after fatal error:', data);
        this.destroyHls();

        const adaptive = this.isAdaptivePlaylistUrl(playlistUrl);
        const nextHls = this.createHlsInstance(authToken, 60, 120, adaptive);
        this.hls = nextHls;
        this.currentHlsAuthToken = authToken;
        if (adaptive) this.attachAdaptiveTelemetry(nextHls);
        this.attachActiveHlsRecovery(nextHls, playlistUrl, authToken);
        nextHls.once(HlsCtor!.Events.MANIFEST_PARSED, () => {
            if (position > 0) {
                this.seek(position);
            }
            void this.safePlay();
        });
        nextHls.loadSource(playlistUrl);
        nextHls.attachMedia(this.audio);
    }

    private loadFixedFallbackAfterAdaptiveFailure(
        playlistUrl: string,
        quality: '64k' | '128k',
        authToken: string,
        error: unknown,
    ): void {
        const position = this.getCurrentTime();
        console.warn(`[HLS] Adaptive recovery exhausted; retrying fixed ${quality}:`, error);
        this.recordAdaptiveFallback(quality, error);
        this.destroyHls();
        this.currentPlaylistUrl = playlistUrl;
        this.hlsNetworkRetryCount = 0;
        this.hlsMediaRetryCount = 0;
        this.hlsRebuildRetryCount = 0;
        const fallbackHls = this.createHlsInstance(authToken, 60, 120, false);
        this.hls = fallbackHls;
        this.currentHlsAuthToken = authToken;
        this.attachActiveHlsRecovery(fallbackHls, playlistUrl, authToken);
        fallbackHls.once(HlsCtor!.Events.MANIFEST_PARSED, () => {
            if (position > 0) this.seek(position);
            void this.safePlay();
        });
        fallbackHls.loadSource(playlistUrl);
        fallbackHls.attachMedia(this.audio);
    }

    private clearHlsRecoveryTimer(): void {
        if (this.hlsRecoveryTimer) {
            clearTimeout(this.hlsRecoveryTimer);
            this.hlsRecoveryTimer = null;
        }
    }

    private normalizePreparedUrlKey(url: string): string {
        try {
            const parsed = new URL(url, window.location.origin);
            const sortedParams = new URLSearchParams();
            Array.from(parsed.searchParams.entries())
                .sort(([left], [right]) => left.localeCompare(right))
                .forEach(([key, value]) => sortedParams.append(key, value));
            parsed.search = sortedParams.toString();
            return parsed.toString();
        } catch {
            return url;
        }
    }

    private isPreparedUrl(url: string): boolean {
        return !!this.nextAudio && this.nextUrlKey === this.normalizePreparedUrlKey(url);
    }

    private async promotePreparedAudio(loadPath: PlaybackLoadPath = 'prepared-hls'): Promise<void> {
        if (!this.nextAudio || !this.nextUrlKey) return;

        const oldAudio = this.audio;
        oldAudio.pause();
        this.destroyHls();
        this.syncLocalAudioOutputState(this.nextAudio);
        await audioOutputManager.applyToRegisteredElements();

        this.audio = this.nextAudio;
        this.hls = this.nextHls;
        this.nextAudio = null;
        this.nextHls = null;
        this.nextUrlKey = null;

        if (this.hls && this.currentPlaylistUrl) {
            this.currentHlsAuthToken = new URL(this.currentPlaylistUrl, window.location.origin).searchParams.get('token') || '';
            if (this.isAdaptivePlaylistUrl(this.currentPlaylistUrl)) {
                this.attachAdaptiveTelemetry(this.hls);
                this.applyDataSaverCap(this.hls);
            }
            this.attachActiveHlsRecovery(this.hls, this.currentPlaylistUrl, this.currentHlsAuthToken);
        }

        // The promoted element already owns its loudness chain (wired in
        // prepareNextUrl); re-point the active gain node and re-apply.
        const promotedGain = this.attachLoudnessChain(this.audio);
        if (promotedGain) this.activeGainNode = promotedGain;
        this.applyLoudnessGainToActive();

        if (oldAudio.src && oldAudio.src.startsWith('blob:')) {
            URL.revokeObjectURL(oldAudio.src);
        }
        oldAudio.removeAttribute('src');
        oldAudio.load();
        audioOutputManager.unregisterElement(oldAudio);
        // Disconnect the discarded element's loudness chain so it doesn't linger
        // connected to the destination for the rest of the session.
        const oldNodes = this.webAudioNodes.get(oldAudio);
        if (oldNodes) {
            try { oldNodes.source.disconnect(); oldNodes.gain.disconnect(); } catch { /* already gone */ }
            this.webAudioNodes.delete(oldAudio);
        }

        logPlaybackInfo('[Playback] Promoting prepared next track');
        this.recordTelemetry({
            loadPath,
            currentTrackTitle: this.currentTitle,
            currentTrackArtist: this.currentArtist,
            preparedAudioUsed: true,
            fallbackHlsLoadUsed: false,
            lastFallbackReason: null,
            recoveredFromPrepareFailure: false,
            recoveryPath: 'none',
            recoveryError: null,
            prebufferPolicy: usePlayerStore.getState().prebufferPolicy,
            prebufferSkippedReason: null,
        });
        await this.safePlay();
    }

    /**
     * Safely handle AudioContext and play() promises.
     * Catches NotAllowedError which occurs when autoplay is blocked.
     */
    private async safePlay(): Promise<void> {
        try {
            await this.audio.play();
            this.ensureAudioContext();
            // Playback started — clear any prior autoplay-blocked state.
            try { usePlayerStore.getState().setAutoplayBlocked(false); } catch { /* store not ready */ }
        } catch (error) {
            if (error instanceof DOMException && error.name === 'NotAllowedError') {
                console.warn('Autoplay blocked. User interaction required.');
                this.onBufferingChangeCallback?.(false);
                this.onPlayStateChangeCallback?.('paused');
                this.updateMediaSessionPlaybackState('paused');
                // Previously this resolved to a bare 'paused' state indistinguishable
                // from an intentional pause — leaving iOS/Safari users staring at a
                // dead play button. Flag it and tell them what to do.
                try {
                    const store = usePlayerStore.getState();
                    store.setAutoplayBlocked(true);
                    store.addToast('Tap play to start playback.', 'info', { duration: 5000 });
                } catch { /* store not ready */ }
            } else if (error instanceof DOMException && error.name === 'AbortError') {
                // Play was interrupted by a new load — not an error
                return;
            } else {
                throw error;
            }
        }
    }

    private destroyHls(): void {
        this.clearHlsRecoveryTimer();
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
    }

    private destroyPreparedAudio(): void {
        if (this.nextHls) {
            this.nextHls.destroy();
            this.nextHls = null;
        }
        if (this.nextAudio) {
            this.nextAudio.pause();
            if (this.nextAudio.src && this.nextAudio.src.startsWith('blob:')) {
                URL.revokeObjectURL(this.nextAudio.src);
            }
            this.nextAudio.removeAttribute('src');
            this.nextAudio.load();
            audioOutputManager.unregisterElement(this.nextAudio);
            this.nextAudio = null;
        }
        this.nextUrlKey = null;
    }

    public clearPreparedAudio(): void {
        this.destroyPreparedAudio();
        this.lastPrepareFailureReason = null;
    }

    public async selectAudioOutputDevice(preferredDeviceId?: string) {
        if (castManager.isConnected()) return audioOutputManager.getState();
        return audioOutputManager.selectOutputDevice(preferredDeviceId);
    }

    public async clearAudioOutputDevice() {
        return audioOutputManager.clearOutputDevice();
    }

    public async playFile(fileHandle: FileSystemFileHandle): Promise<void> {
        // Cast cannot play files loaded locally directly by default without spinning up a local server inline.
        // We just fallback to local playback.
        try {
            // Clean up HLS if active
            this.destroyHls();
            this.destroyPreparedAudio();

            const file = await fileHandle.getFile();
            const url = URL.createObjectURL(file);

            // Clean up previous URL if it exists
            if (this.audio.src && this.audio.src.startsWith('blob:')) {
                URL.revokeObjectURL(this.audio.src);
            }

            this.audio.src = url;
            this.audio.load();
            await this.audio.play();

            this.ensureAudioContext();

        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            console.error('PlaybackManager playFile error:', error);
            throw error;
        }
    }

    public pause(): void {
        if (castManager.isConnected()) {
            castManager.pause();
        } else {
            this.audio.pause();
        }
    }

    public async resume(): Promise<void> {
        if (castManager.isConnected()) {
            castManager.resume();
        } else {
            if (this.audio.src) {
                // Route through safePlay so a blocked autoplay surfaces a toast
                // instead of throwing an uncaught NotAllowedError.
                await this.safePlay();
                if (this.audioContext?.state === 'suspended') {
                    await this.audioContext.resume();
                }
            }
        }
    }

    public async resumeLocalAt(time: number, shouldPlay: boolean): Promise<void> {
        if (!this.audio.src) return;
        if (isFinite(time) && time >= 0) {
            this.audio.currentTime = time;
            this.onTimeUpdateCallback?.(time);
        }
        this.updateMediaSessionPosition(true);
        this.persistContinuitySnapshot();

        if (!shouldPlay) {
            this.audio.pause();
            this.onPlayStateChangeCallback?.('paused');
            return;
        }

        await this.safePlay();
        if (this.audioContext?.state === 'suspended') {
            await this.audioContext.resume();
        }
        // safePlay may have been blocked by autoplay policy and left us paused —
        // don't falsely report 'playing' in that case.
        if (!this.audio.paused) {
            this.onPlayStateChangeCallback?.('playing');
            this.updateMediaSessionPlaybackState('playing');
        }
    }

    public stop(): void {
        if (castManager.isConnected()) {
            castManager.stop();
        } else {
            this.releaseWakeLock();
            this.audio.pause();
            this.audio.currentTime = 0;
            this.destroyPreparedAudio();
            this.onPlayStateChangeCallback?.('stopped');
        }
    }

    public seek(time: number): void {
        if (castManager.isConnected()) {
            castManager.seek(time);
        } else {
            if (isFinite(time) && time >= 0) {
                this.audio.currentTime = time;
            }
        }
        this.onTimeUpdateCallback?.(time);
        this.updateMediaSessionPosition(true);
        this.persistContinuitySnapshot();
    }

    public setVolume(volume: number): void {
        // Clamp between 0 and 1
        const v = Math.max(0, Math.min(1, volume));
        this.localVolume = v;
        this.syncLocalAudioOutputState(this.audio);
        this.syncLocalAudioOutputState(this.nextAudio);

        if (castManager.isConnected()) {
            castManager.setVolume(v);
        }
    }

    public getDuration(): number {
        // Since getDuration is often synchronous, we rely on the state maintained locally if needed,
        // but it's largely obsolete if Zustand stores it.
        return this.audio.duration || 0;
    }

    public getCurrentTime(): number {
        return this.audio.currentTime || 0;
    }

    public getCurrentTrackInfo() {
        if (!this.currentUrl) return null;
        return {
            url: this.currentUrl,
            title: this.currentTitle || 'Unknown Title',
            artist: this.currentArtist || 'Unknown Artist',
            artUrl: this.currentArtUrl || undefined,
            album: this.currentAlbum || undefined,
            format: this.currentFormat || undefined,
        };
    }

    public getLocalAudioElement(): HTMLAudioElement {
        return this.audio;
    }

    public destroy(): void {
        this.networkInformation?.removeEventListener('change', this.handleNetworkInformationChange);
        this.networkInformation = null;
        this.destroyHls();
        this.destroyPreparedAudio();
        this.audio.pause();
        this.audio.src = '';
        audioOutputManager.unregisterElement(this.audio);
        if (this.bridgeAudio) {
            this.bridgeAudio.pause();
            this.bridgeAudio.srcObject = null;
            audioOutputManager.unregisterElement(this.bridgeAudio);
            this.bridgeAudio = null;
        }
        this.bridgeDestination = null;
        if (this.audioContext) {
            audioOutputManager.unregisterContext(this.audioContext);
            this.audioContext.close();
            this.audioContext = null;
        }
        this.activeGainNode = null;
        this.webAudioNodes = new WeakMap();
    }

    // --- Web Audio API Integration (Foundation for EQ/Visualizers) ---

    /**
     * Ensures an AudioContext exists. Call this on first user interaction
     * (e.g., from App.tsx) so Safari doesn't block it.
     * If already created, resumes from suspended state if needed.
     */
    public ensureAudioContext(): void {
        try {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
                // The loudness graph bypasses element-level sinks, so its exit
                // must follow the selected output device. Registration applies
                // any already-active selection.
                if (audioOutputManager.isContextSinkSupported()) {
                    audioOutputManager.registerContext(this.audioContext);
                } else if (audioOutputManager.isElementSinkSupported()) {
                    // Firefox/Safari: no AudioContext.setSinkId — exit through a
                    // MediaStream bridge element and route that element's sink.
                    this.bridgeDestination = this.audioContext.createMediaStreamDestination();
                    const bridge = new Audio();
                    bridge.srcObject = this.bridgeDestination.stream;
                    audioOutputManager.registerBridgeElement(bridge);
                    this.bridgeAudio = bridge;
                }
            }
            // ensureAudioContext runs on user gestures and before each play —
            // both valid moments to (re)start the gesture-gated bridge element.
            if (this.bridgeAudio && this.bridgeAudio.paused) {
                void this.bridgeAudio.play().catch((e) => console.warn('[Audio] bridge element play failed:', e));
            }
            // Wire (or re-point to) the active element's loudness chain. Idempotent
            // per element; also covers a post-promotion element that was created
            // before the context existed.
            const gain = this.attachLoudnessChain(this.audio);
            if (gain) this.activeGainNode = gain;
            this.applyLoudnessGainToActive();

            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }
        } catch (e) {
            console.warn("Could not initialize AudioContext:", e);
        }
    }

    /**
     * Build MediaElementSource(el) → GainNode → destination exactly once per
     * element (WeakMap-guarded — createMediaElementSource throws on a 2nd call).
     * Returns the element's GainNode, or null if the context doesn't exist yet.
     */
    private attachLoudnessChain(element: HTMLAudioElement): GainNode | null {
        const ctx = this.audioContext;
        if (!ctx) return null;
        const existing = this.webAudioNodes.get(element);
        if (existing) return existing.gain;
        try {
            const source = ctx.createMediaElementSource(element);
            const gain = ctx.createGain();
            gain.gain.value = dbToLinear(this.currentLoudnessGainDb); // start correct → no click
            source.connect(gain);
            gain.connect(this.bridgeDestination ?? ctx.destination);
            this.webAudioNodes.set(element, { source, gain });
            return gain;
        } catch (e) {
            console.warn('[Loudness] attachLoudnessChain failed:', e);
            return null;
        }
    }

    private applyLoudnessGainToActive(): void {
        const ctx = this.audioContext;
        if (!ctx || !this.activeGainNode) return;
        // Short ramp to avoid a click when the gain changes mid-playback.
        this.activeGainNode.gain.setTargetAtTime(dbToLinear(this.currentLoudnessGainDb), ctx.currentTime, 0.05);
    }

    /** Set the loudness-normalization gain for the current track. null → unity. */
    public setLoudnessGainDb(dbOrNull: number | null): void {
        this.currentLoudnessGainDb = dbOrNull;
        this.applyLoudnessGainToActive();
    }
}

export const playbackManager = PlaybackManager.getInstance();
