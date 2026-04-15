import Hls from 'hls.js';
import { castManager } from './CastManager';

export type PlaybackState = 'playing' | 'paused' | 'stopped';

class PlaybackManager {
    private static instance: PlaybackManager;
    private audio: HTMLAudioElement;
    private audioContext: AudioContext | null = null;
    private hls: Hls | null = null;
    
    // Internal state to track what's playing in case we switch to Cast mid-stream
    private currentUrl: string | null = null;
    private currentTitle: string | null = null;
    private currentArtist: string | null = null;
    private currentArtUrl: string | null = null;
    private currentAlbum: string | null = null;
    private currentFormat: string | null = null;

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
        this.audio = new Audio();
        // Enable cross-origin for potential future network streaming
        this.audio.crossOrigin = 'anonymous';

        // Set up standard event listeners
        this.audio.addEventListener('timeupdate', () => {
            if (!castManager.isConnected()) {
                this.onTimeUpdateCallback?.(this.audio.currentTime);
            }
        });

        this.audio.addEventListener('loadedmetadata', () => {
            if (!castManager.isConnected()) {
                this.onDurationCallback?.(this.audio.duration || 0);
            }
        });

        // hls.js updates the media element's duration asynchronously after manifest parsing.
        // 'durationchange' fires when that happens, giving us the real VOD duration.
        this.audio.addEventListener('durationchange', () => {
            if (!castManager.isConnected() && isFinite(this.audio.duration) && this.audio.duration > 0) {
                this.onDurationCallback?.(this.audio.duration);
            }
        });

        this.audio.addEventListener('ended', () => {
            if (!castManager.isConnected()) {
                this.onPlayStateChangeCallback?.('stopped');
                this.onEndedCallback?.();
            }
        });

        this.audio.addEventListener('waiting', () => {
            if (!castManager.isConnected()) {
                this.onBufferingChangeCallback?.(true);
            }
        });

        this.audio.addEventListener('playing', () => {
            if (!castManager.isConnected()) {
                this.onBufferingChangeCallback?.(false);
            }
        });

        this.audio.addEventListener('canplay', () => {
            if (!castManager.isConnected()) {
                this.onBufferingChangeCallback?.(false);
            }
        });

        this.audio.addEventListener('play', () => {
             if (!castManager.isConnected()) this.onPlayStateChangeCallback?.('playing');
        });
        this.audio.addEventListener('pause', () => {
             if (!castManager.isConnected()) this.onPlayStateChangeCallback?.('paused');
        });

        // Set up CastManager listeners
        castManager.onTimeUpdate = (time) => {
            if (castManager.isConnected()) this.onTimeUpdateCallback?.(time);
        };
        castManager.onDuration = (duration) => {
            if (castManager.isConnected()) this.onDurationCallback?.(duration);
        };
        castManager.onPlayStateChange = (isPlaying) => {
            if (castManager.isConnected()) {
                this.onPlayStateChangeCallback?.(isPlaying ? 'playing' : 'paused');
            }
        };
        castManager.onEnded = () => {
            if (castManager.isConnected()) {
                this.onPlayStateChangeCallback?.('stopped');
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

    // --- Core Playback Controls ---

    public async playUrl(url: string, title?: string, artist?: string, artUrl?: string, album?: string, format?: string): Promise<void> {
        this.currentUrl = url;
        this.currentTitle = title || 'Unknown Title';
        this.currentArtist = artist || 'Unknown Artist';
        this.currentArtUrl = artUrl || null;
        this.currentAlbum = album || null;
        this.currentFormat = format || null;

        try {
            if (castManager.isConnected()) {
                this.audio.pause();
                await castManager.castMedia(this.currentUrl, this.currentTitle, this.currentArtist, this.currentArtUrl || undefined, album, format);
                return;
            }

            // Route HLS URLs through hls.js
            if (url.includes('.m3u8')) {
                await this.playHls(url);
                return;
            }

            // Clean up previous HLS instance if switching away
            this.destroyHls();

            // Clean up previous URL if it exists AND is a blob
            if (this.audio.src && this.audio.src.startsWith('blob:')) {
                URL.revokeObjectURL(this.audio.src);
            }

            this.audio.src = url;
            this.audio.load();
            await this.audio.play();

            this.ensureAudioContext();
        } catch (error) {
            // AbortError: play() was interrupted by a new source loading — not a real error
            if (error instanceof DOMException && error.name === 'AbortError') return;
            console.error('PlaybackManager playUrl error:', error);
            throw error;
        }
    }

    // --- HLS Playback ---

    private async playHls(playlistUrl: string): Promise<void> {
        // Clean up previous HLS instance
        this.destroyHls();

        // Extract auth token from the playlist URL so we can pass it to segment requests.
        // hls.js constructs segment URLs relative to the playlist but drops query params.
        const urlObj = new URL(playlistUrl, window.location.origin);
        const authToken = urlObj.searchParams.get('token') || '';

        if (Hls.isSupported()) {
            this.hls = new Hls({
                maxBufferLength: 60,         // Buffer up to 60s ahead
                maxMaxBufferLength: 120,     // Hard cap at 120s
                startFragPrefetch: true,     // Start fetching immediately
                xhrSetup: (xhr: XMLHttpRequest, _url: string) => {
                    // DO NOT call xhr.open() here — hls.js has already opened the request.
                    // Use setRequestHeader to inject the auth token as a Bearer header.
                    if (authToken) {
                        xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
                    }
                },
            });

            this.hls.loadSource(playlistUrl);
            this.hls.attachMedia(this.audio);

            // Wait for the manifest to be parsed, then play
            await new Promise<void>((resolve, reject) => {
                const onParsed = () => {
                    this.hls?.off(Hls.Events.MANIFEST_PARSED, onParsed);
                    this.hls?.off(Hls.Events.ERROR, onError);
                    resolve();
                };

                const onError = (_event: string, data: any) => {
                    if (data.fatal) {
                        this.hls?.off(Hls.Events.MANIFEST_PARSED, onParsed);
                        this.hls?.off(Hls.Events.ERROR, onError);

                        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
                            console.error('[HLS] Fatal network error:', data);
                            // Try to recover once
                            this.hls?.startLoad();
                        } else {
                            console.error('[HLS] Fatal error:', data);
                            this.destroyHls();
                            reject(new Error(`HLS fatal error: ${data.details}`));
                        }
                    }
                };

                this.hls!.on(Hls.Events.MANIFEST_PARSED, onParsed);
                this.hls!.on(Hls.Events.ERROR, onError);
            });

            await this.safePlay();
        }
        // Fallback for iOS Safari (native HLS support)
        else if (this.audio.canPlayType('application/vnd.apple.mpegurl')) {
            this.audio.src = playlistUrl;
            await new Promise<void>((resolve) => {
                this.audio.addEventListener('loadedmetadata', () => resolve(), { once: true });
            });
            await this.safePlay();
        }
        else {
            throw new Error('HLS is not supported on this browser');
        }
    }

    /**
     * Safely handle AudioContext and play() promises.
     * Catches NotAllowedError which occurs when autoplay is blocked.
     */
    private async safePlay(): Promise<void> {
        try {
            await this.audio.play();
            this.ensureAudioContext();
        } catch (error) {
            if (error instanceof DOMException && error.name === 'NotAllowedError') {
                console.warn('Autoplay blocked. User interaction required.');
            } else if (error instanceof DOMException && error.name === 'AbortError') {
                // Play was interrupted by a new load — not an error
                return;
            } else {
                throw error;
            }
        }
    }

    private destroyHls(): void {
        if (this.hls) {
            this.hls.destroy();
            this.hls = null;
        }
    }

    public async playFile(fileHandle: FileSystemFileHandle): Promise<void> {
        // Cast cannot play files loaded locally directly by default without spinning up a local server inline.
        // We just fallback to local playback.
        try {
            // Clean up HLS if active
            this.destroyHls();

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
                await this.audio.play();
                if (this.audioContext?.state === 'suspended') {
                    await this.audioContext.resume();
                }
            }
        }
    }

    public stop(): void {
        if (castManager.isConnected()) {
            castManager.stop();
        } else {
            this.audio.pause();
            this.audio.currentTime = 0;
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
    }

    public setVolume(volume: number): void {
        // Clamp between 0 and 1
        const v = Math.max(0, Math.min(1, volume));
        if (castManager.isConnected()) {
            castManager.setVolume(v);
        } else {
            this.audio.volume = v;
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
        this.destroyHls();
        this.audio.pause();
        this.audio.src = '';
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
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
                const source = this.audioContext.createMediaElementSource(this.audio);

                // Basic routing: Source -> Destination
                // Future: Source -> Gain (crossfade) -> Analyser (visualizer) -> Biquads (EQ) -> Destination
                source.connect(this.audioContext.destination);
            }

            if (this.audioContext.state === 'suspended') {
                this.audioContext.resume();
            }
        } catch (e) {
            console.warn("Could not initialize AudioContext:", e);
        }
    }
}

export const playbackManager = PlaybackManager.getInstance();
