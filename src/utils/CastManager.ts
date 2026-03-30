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

    // Callbacks for UI/Store updates
    public onStateChange?: (state: CastState) => void;
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
                    this.state = event.castState;
                    this.onStateChange?.(this.state);
                }
            );

            // Set initial state
            this.state = this.castContext.getCastState();
            this.onStateChange?.(this.state);

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
                console.warn('[Cast] Server URL is localhost — the Chromecast device cannot reach it. Access the app via your LAN IP (e.g. http://192.168.x.x) to cast.');
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

    public getState(): CastState {
        return this.state;
    }
}

export const castManager = CastManager.getInstance();
