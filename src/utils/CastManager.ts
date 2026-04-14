declare const chrome: any;
declare const cast: any;

export type CastState = 'NO_DEVICES_AVAILABLE' | 'NOT_CONNECTED' | 'CONNECTING' | 'CONNECTED';

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

            // Listen to Cast state changes
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

            // Also listen to SESSION_RESUMED (e.g., reconnecting to an existing cast session)
            this.castContext.addEventListener(
                cast.framework.CastContextEventType.SESSION_RESUMED,
                () => {
                    this.state = this.castContext.getCastState();
                    this.notifyStateChange();
                }
            );

            // Set initial state
            this.state = this.castContext.getCastState();
            this.notifyStateChange();

            // Listen to Player states
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
                    if (this.player.playerState === chrome.cast.media.PlayerState.IDLE && this.player.idleReason === chrome.cast.media.IdleReason.FINISHED) {
                        this.onEnded?.();
                    }
                }
            );

        } catch (e) {
            console.error("Failed to initialize Google Cast API", e);
        }
    }

    /**
     * Called when cast state transitions to CONNECTED.
     * Automatically takes the currently playing track and starts casting it.
     */
    private async handleCastConnected() {
        // Dynamic import to avoid circular dependency issues
        // PlaybackManager imports CastManager, so we can't import PlaybackManager at module level
        const { playbackManager } = await import('./PlaybackManager');

        const trackInfo = playbackManager.getCurrentTrackInfo();
        if (!trackInfo) {
            console.log('[Cast] Connected but no track is playing — nothing to auto-cast.');
            return;
        }

        // Get current playback position before we pause local audio
        const currentTime = playbackManager.getCurrentTime();

        console.log(`[Cast] Auto-casting: "${trackInfo.title}" by ${trackInfo.artist} (position: ${currentTime.toFixed(1)}s)`);

        this.autoCastInProgress = true;
        try {
            // Pause local audio immediately to prevent double playback
            playbackManager.pause();

            // Cast the current track to the device
            await this.castMedia(
                trackInfo.url,
                trackInfo.title,
                trackInfo.artist,
                trackInfo.artUrl,
                trackInfo.album,
                trackInfo.format
            );

            // Seek to where we left off locally (with a small delay to let the media load)
            if (currentTime > 1) {
                setTimeout(() => {
                    this.seek(currentTime);
                }, 500);
            }
        } catch (e) {
            console.error('[Cast] Failed to auto-cast current track:', e);
        } finally {
            this.autoCastInProgress = false;
        }
    }

    public isConnected(): boolean {
        return this.state === 'CONNECTED';
    }

    public async castMedia(url: string, title: string, artist: string, artUrl?: string, album?: string, format?: string) {
        if (!this.isConnected()) return;

        const castSession = this.castContext.getCurrentSession();
        if (!castSession) return;

        // Warn if the Chromecast can't reach the server (localhost / 127.0.0.1)
        try {
            const host = new URL(url).hostname;
            if (host === 'localhost' || host === '127.0.0.1') {
                console.warn('[Cast] Server URL is localhost — the Chromecast device cannot reach it. Access the app via your LAN IP or domain to cast.');
            }
        } catch { /* ignore */ }

        const contentType = inferContentType(url, format);
        const mediaInfo = new chrome.cast.media.MediaInfo(url, contentType);
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

        await castSession.loadMedia(request);
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
        } catch (e) {
            console.error("Failed to request cast session", e);
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

        try {
            // Stop the cast media first
            this.stop();

            // End the cast session
            const session = this.castContext.getCurrentSession();
            if (session) {
                await session.end(true);
            }
        } catch (e) {
            console.error('[Cast] Error during disconnect:', e);
        }

        // Resume local playback at the position we left off
        try {
            const { playbackManager } = await import('./PlaybackManager');
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
