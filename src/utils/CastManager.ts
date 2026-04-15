import { playbackManager } from './PlaybackManager';
import { usePlayerStore } from '../store';
declare const chrome: any;
declare const cast: any;

const toast = {
    success: (msg: string) => usePlayerStore.getState().addToast(msg, 'success'),
    error: (msg: string) => usePlayerStore.getState().addToast(msg, 'error'),
    info: (msg: string) => usePlayerStore.getState().addToast(msg, 'info'),
};

export type CastState = 'NO_DEVICES_AVAILABLE' | 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED';

const SESSION_STORAGE_KEY = 'cast_session_id';

// Client-side format/extension to MIME type mapping (mirrors server MIME_TYPES)
const FORMAT_TO_MIME: Record<string, string> = {
    mp3: 'audio/mpeg',
    mpeg: 'audio/mpeg',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    aac: 'audio/aac',
    wav: 'audio/wav',
    wma: 'audio/x-ms-wma',
};

function inferContentType(url: string, format?: string): string {
    if (format) {
        const key = format.toLowerCase().replace('mpeg', 'mp3');
        if (FORMAT_TO_MIME[key]) return FORMAT_TO_MIME[key];
    }
    // Try extracting extension from the URL path (before query params)
    try {
        const pathname = new URL(url).pathname;
        const ext = pathname.split('.').pop()?.toLowerCase();
        if (ext && FORMAT_TO_MIME[ext]) return FORMAT_TO_MIME[ext];
    } catch { /* ignore */ }
    return 'audio/mpeg';
}

export class CastManager {
    private static instance: CastManager;
    private castContext: any = null;
    private player: any = null;
    private playerController: any = null;
    private state: CastState = 'NO_DEVICES_AVAILABLE';

    // Tracks whether this manager initiated the cast session (vs joining an existing one)
    private autoCastInProgress = false;

    // Listener pattern for state changes (multiple subscribers)
    private stateChangeListeners: Set<(state: CastState) => void> = new Set();

    // Proxies for the player events so PlaybackManager can route them
    public onTimeUpdate?: (time: number) => void;
    public onDuration?: (duration: number) => void;
    public onPlayStateChange?: (isPlaying: boolean) => void;
    public onEnded?: () => void;
    public onVolumeChange?: (volume: number) => void;
    public onMuteChange?: (muted: boolean) => void;
    public onTrackChange?: (index: number) => void;

    private constructor() {
        // The Cast API is loaded asynchronously via the script tag in index.html
        // It dispatches 'castApiAvailable' when ready.
        window.addEventListener('castApiAvailable', this.initializeCastApi.bind(this));

        // If it's already available
        if (typeof cast !== 'undefined' && cast.framework) {
            this.initializeCastApi();
        }
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
        for (const listener of this.stateChangeListeners) {
            try {
                listener(this.state);
            } catch (e) {
                console.error('[Cast] State change listener error:', e);
            }
        }
    }

    private initializeCastApi() {
        if (this.castContext) return;

        try {
            cast.framework.CastContext.getInstance().setOptions({
                receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
                autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
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

                    // Auto-cast: when we transition to CONNECTED and have a track playing locally
                    if (prevState !== 'CONNECTED' && this.state === 'CONNECTED' && !this.autoCastInProgress) {
                        this.handleCastConnected();
                    }
                }
            );

            // --- Session state changes (session lifecycle — per Google Cast docs) ---
            this.castContext.addEventListener(
                cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
                (event: any) => {
                    switch (event.sessionState) {
                        case cast.framework.SessionState.SESSION_STARTED:
                            // Store session ID for rejoin
                            const session = this.castContext.getCurrentSession();
                            if (session) {
                                const sid = session.getSessionId();
                                if (sid) {
                                    localStorage.setItem(SESSION_STORAGE_KEY, sid);
                                    console.log('[Cast] Session started, stored ID:', sid);
                                }
                            }
                            break;

                        case cast.framework.SessionState.SESSION_RESUMED:
                            this.state = this.castContext.getCastState();
                            this.notifyStateChange();
                            // Re-store the session ID
                            const resumedSession = this.castContext.getCurrentSession();
                            if (resumedSession) {
                                const sid = resumedSession.getSessionId();
                                if (sid) localStorage.setItem(SESSION_STORAGE_KEY, sid);
                            }
                            break;

                        case cast.framework.SessionState.SESSION_ENDING:
                        case cast.framework.SessionState.SESSION_ENDED:
                            console.log('[Cast] Session ended');
                            localStorage.removeItem(SESSION_STORAGE_KEY);
                            this.state = 'NOT_CONNECTED';
                            this.notifyStateChange();
                            break;
                    }
                }
            );

            // --- Remote player connection changes (e.g., stopped from Google Home) ---
            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.IS_CONNECTED_CHANGED,
                () => {
                    if (!this.player.isConnected) {
                        console.log('[Cast] Remote player disconnected');
                        localStorage.removeItem(SESSION_STORAGE_KEY);
                        this.state = 'NOT_CONNECTED';
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
                    if (this.player.playerState === chrome.cast.media.PlayerState.IDLE) {
                        // idleReason is only available on the media session, not RemotePlayer
                        try {
                            const session = this.castContext?.getCurrentSession();
                            const mediaSession = session?.getMediaSession();
                            if (mediaSession?.idleReason === chrome.cast.media.IdleReason.FINISHED) {
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
                }
            );

            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.IS_MUTED_CHANGED,
                () => {
                    this.onMuteChange?.(this.player.isMuted);
                }
            );

            // --- Queue change events (receiver auto-advances tracks) ---
            this.playerController.addEventListener(
                cast.framework.RemotePlayerEventType.MEDIA_INFO_CHANGED,
                () => {
                    if (!this.isConnected()) return;
                    // When using the queue API, the receiver auto-advances.
                    // The currentItemId from the media session tells us which track is playing.
                    try {
                        const session = this.castContext.getCurrentSession();
                        const mediaSession = session?.getMediaSession();
                        if (!mediaSession) return;
                        const mediaInfo = mediaSession.media;
                        if (!mediaInfo) return;
                        // The metadata.index field on the current media tells us the queue position
                        const index = mediaInfo.metadata?.index;
                        if (typeof index === 'number' && index >= 0) {
                            this.onTrackChange?.(index);
                        }
                    } catch { /* ignore */ }
                }
            );

            // --- Try to rejoin an existing session on init ---
            this.tryRejoinSession();

        } catch (e) {
            console.error("Failed to initialize Google Cast API", e);
            toast.error('Failed to initialize Google Cast. Please refresh and try again.');
        }
    }

    /**
     * Attempt to rejoin a previously stored cast session.
     * Per Google Cast docs: use requestSessionById() to resume without page reload.
     */
    private tryRejoinSession() {
        const storedId = localStorage.getItem(SESSION_STORAGE_KEY);
        if (!storedId) return;

        console.log('[Cast] Attempting to rejoin session:', storedId);
        try {
            chrome.cast.requestSessionById(storedId);
        } catch (e) {
            console.warn('[Cast] Failed to rejoin session:', e);
            localStorage.removeItem(SESSION_STORAGE_KEY);
            toast.info('Cast session could not be restored. Starting fresh.');
        }
    }

    /**
     * Called when cast state transitions to CONNECTED.
     * Automatically takes the current playlist and starts casting from the active track.
     */
    private async handleCastConnected() {
        // Read current playback state from the store — this gives us the full
        // playlist, current index, and repeat mode (consistent with playAtIndex).
        const state = usePlayerStore.getState();
        const { playlist, currentIndex, repeat } = state;

        if (!playlist.length || currentIndex === null) {
            console.log('[Cast] Connected but no playlist is active — nothing to auto-cast.');
            return;
        }

        const track = playlist[currentIndex];
        // Get current playback position before we pause local audio
        const currentTime = playbackManager.getCurrentTime();

        console.log(`[Cast] Auto-casting playlist (${playlist.length} tracks, index ${currentIndex}): "${track.title}" by ${track.artist} (position: ${currentTime.toFixed(1)}s)`);

        this.autoCastInProgress = true;
        try {
            // Pause local audio DIRECTLY on the HTMLAudioElement.
            // We cannot use playbackManager.pause() because it checks
            // castManager.isConnected() — which is now true — and routes to
            // castManager.pause(), which is a no-op since no media is loaded
            // on the Cast device yet. This would leave local audio playing.
            playbackManager.getLocalAudioElement().pause();

            // Build the same cast track list that the store's playAtIndex uses
            const castTracks = playlist.map(t => ({
                url: t.url || '',
                title: t.title || 'Unknown Title',
                artist: t.artist || ((t.artists as string[])?.join(', ')) || 'Unknown Artist',
                artUrl: t.artUrl,
                album: t.album,
                format: t.format,
                duration: t.duration,
            })).filter(t => t.url);

            if (castTracks.length > 0) {
                const castIndex = castTracks.findIndex(ct => ct.url === (track.url || ''));
                await this.castQueue(castTracks, castIndex >= 0 ? castIndex : 0, repeat);
            }

            // Seek to where we left off locally (with a small delay to let the media load)
            if (currentTime > 1) {
                setTimeout(() => {
                    this.seek(currentTime);
                }, 500);
            }
        } catch (e) {
            console.error('[Cast] Failed to auto-cast current track:', e);
            toast.error('Connected to Cast device but failed to play media.');
        } finally {
            this.autoCastInProgress = false;
        }
    }

    public isConnected(): boolean {
        return this.state === 'CONNECTED';
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
     * Forces AAC transcode quality for cast compatibility.
     * Returns a URL with quality=128k set, ensuring the Chromecast receives AAC audio.
     */
    public getCastUrl(url: string): string {
        try {
            const u = new URL(url);
            u.searchParams.set('quality', '128k');
            return u.toString();
        } catch {
            return url;
        }
    }

    /**
     * Infer the correct content type for Cast based on the URL.
     * HLS streams (.m3u8) MUST use application/x-mpegurl, not audio/mp4.
     */
    private getCastContentType(url: string): string {
        try {
            const u = new URL(url);
            if (u.pathname.endsWith('.m3u8')) {
                return 'application/x-mpegurl';
            }
        } catch { /* fall through */ }
        return 'audio/mp4';
    }

    public async castMedia(url: string, title: string, artist: string, artUrl?: string, album?: string, format?: string) {
        if (!this.isConnected()) return;

        const castSession = this.castContext.getCurrentSession();
        if (!castSession) return;

        // Force AAC transcode for cast compatibility — override quality parameter to 128k
        // The Default Media Receiver may not support FLAC/OGG/WMA, so we always transcode
        let castUrl = url;
        try {
            const u = new URL(url);
            u.searchParams.set('quality', '128k');
            castUrl = u.toString();
        } catch { /* use original url */ }

        // Warn if the Chromecast can't reach the server (localhost / 127.0.0.1)
        try {
            const host = new URL(castUrl).hostname;
            if (host === 'localhost' || host === '127.0.0.1') {
                console.warn('[Cast] Server URL is localhost — the Chromecast device cannot reach it. Access the app via your LAN IP or domain to cast.');
                toast.error('Cannot cast: server is at localhost. Access the app via your LAN IP address to cast.');
                return;
            }
        } catch { /* ignore */ }

        // Always use audio/mp4 content type since we're forcing AAC transcoding
        const contentType = this.getCastContentType(castUrl);
        const mediaInfo = new chrome.cast.media.MediaInfo(castUrl, contentType);
        mediaInfo.metadata = new chrome.cast.media.MusicTrackMediaMetadata();
        mediaInfo.metadata.title = title;
        mediaInfo.metadata.artist = artist;
        if (album) {
            mediaInfo.metadata.albumName = album;
        }

        if (artUrl) {
            mediaInfo.metadata.images = [new chrome.cast.Image(artUrl)];
        }

        const request = new chrome.cast.media.LoadRequest(mediaInfo);
        request.autoplay = true;

        try {
            await castSession.loadMedia(request);
        } catch (e: any) {
            console.error('[Cast] Failed to load media:', e);
            const msg = e?.message || String(e);
            if (!msg.includes('cancel') && !msg.includes('abort') && !msg.includes('cancelled')) {
                toast.error(`Failed to play "${title}" on Cast device.`);
            }
            return;
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
    public async castQueue(tracks: { url: string; title: string; artist: string; artUrl?: string; album?: string; format?: string; duration?: number }[], startIndex: number = 0, repeat: 'none' | 'one' | 'all' = 'none') {
        if (!this.isConnected()) return;

        const castSession = this.castContext.getCurrentSession();
        if (!castSession) return;

        // repeat='one': use single loadMedia with loop instead of queue
        if (repeat === 'one' && tracks[startIndex]) {
            const t = tracks[startIndex];
            await this.castMedia(t.url, t.title, t.artist, t.artUrl, t.album, t.format);
            // Set the media to loop via the queue repeat mode API
            const media = castSession.getMediaSession();
            if (media) {
                try {
                    await media.queueSetRepeatMode(chrome.cast.media.RepeatMode.SINGLE);
                } catch (e) {
                    console.warn('[Cast] Failed to set repeat mode:', e);
                }
            }
            return;
        }

        // Build QueueItems from playlist
        const queueItems: any[] = tracks.map((t, i) => {
            const castUrl = this.getCastUrl(t.url);
            const contentType = this.getCastContentType(castUrl);
            const mediaInfo = new chrome.cast.media.MediaInfo(castUrl, contentType);
            mediaInfo.metadata = new chrome.cast.media.MusicTrackMediaMetadata();
            mediaInfo.metadata.title = t.title || 'Unknown Title';
            mediaInfo.metadata.artist = t.artist || 'Unknown Artist';
            if (t.album) mediaInfo.metadata.albumName = t.album;
            if (t.artUrl) mediaInfo.metadata.images = [new chrome.cast.Image(t.artUrl)];
            if (t.duration) mediaInfo.metadata.duration = t.duration;

            const item = new chrome.cast.media.QueueItem(mediaInfo);
            item.autoplay = true;
            item.preloadTime = 30; // Start preloading 30s before track ends
            return item;
        });

        const request = new chrome.cast.media.QueueLoadRequest(queueItems);
        request.startIndex = startIndex;
        request.repeatMode = repeat === 'all' ? chrome.cast.media.RepeatMode.ALL : chrome.cast.media.RepeatMode.OFF;
        request.autoplay = true;

        try {
            await castSession.loadMedia(request);
        } catch (e: any) {
            console.error('[Cast] Failed to load queue:', e);
            const msg = e?.message || String(e);
            if (!msg.includes('cancel') && !msg.includes('abort') && !msg.includes('cancelled')) {
                toast.error('Failed to load playlist on Cast device.');
            }
            return;
        }

        // Store session ID for rejoin
        const sessionId = castSession.getSessionId();
        if (sessionId) {
            localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
        }
    }

    /**
     * Jump to a specific index in the cast queue.
     * Much faster than reloading the entire queue for next/prev navigation.
     */
    public async jumpToQueueIndex(index: number) {
        if (!this.isConnected()) return;
        const session = this.castContext.getCurrentSession();
        if (!session) return;
        const mediaSession = session.getMediaSession();
        if (!mediaSession) return;

        const items = mediaSession.items;
        if (!items || !items[index]) return;

        // Jump to the specified item in the cast queue
        try {
            await mediaSession.queueJumpToItem(items[index].itemId);
        } catch (e) {
            console.error('[Cast] Failed to jump to queue index:', e);
        }
    }

    public playOrPause() {
        if (this.playerController) {
            this.playerController.playOrPause();
        }
    }

    public pause() {
        if (this.playerController && !this.player.isPaused) {
            this.playerController.playOrPause();
        }
    }

    public resume() {
        if (this.playerController && this.player.isPaused) {
            this.playerController.playOrPause();
        }
    }

    public stop() {
        if (this.playerController) {
            this.playerController.stop();
        }
    }

    public seek(time: number) {
        if (this.playerController) {
            this.player.currentTime = time;
            this.playerController.seek();
        }
    }

    public getCurrentCastTime(): number {
        return this.player?.currentTime ?? 0;
    }

    public setVolume(volumeLevel: number) {
        if (this.playerController) {
            this.player.volumeLevel = volumeLevel;
            this.playerController.setVolumeLevel();
        }
    }

    public async requestSession() {
        if (!this.castContext) return;
        try {
            await this.castContext.requestSession();
        } catch (e: any) {
            console.error("Failed to request cast session", e);
            // User cancelled or an error occurred
            const msg = e?.message || String(e);
            if (!msg.includes('cancel') && !msg.includes('abort') && !msg.includes('cancelled')) {
                toast.error('Failed to connect to Cast device. Please try again.');
            }
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
            if (trackInfo && castTime > 0) {
                // Seek the local audio to the cast position
                playbackManager.seek(castTime);
                if (isPlaying) {
                    await playbackManager.resume();
                }
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
