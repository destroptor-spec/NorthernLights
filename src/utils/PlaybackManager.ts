import { castManager } from './CastManager';

export type PlaybackState = 'playing' | 'paused' | 'stopped';

class PlaybackManager {
    private static instance: PlaybackManager;
    private audio: HTMLAudioElement;
    private audioContext: AudioContext | null = null;
    
    // Internal state to track what's playing in case we switch to Cast mid-stream
    private currentUrl: string | null = null;
    private currentTitle: string | null = null;
    private currentArtist: string | null = null;
    private currentArtUrl: string | null = null;

    // Store callbacks for Zustand to update its state
    private onTimeUpdateCallback?: (time: number) => void;
    private onDurationCallback?: (duration: number) => void;
    private onEndedCallback?: () => void;
    private onPlayStateChangeCallback?: (state: PlaybackState) => void;

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

        this.audio.addEventListener('ended', () => {
            if (!castManager.isConnected()) {
                this.onPlayStateChangeCallback?.('stopped');
                this.onEndedCallback?.();
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
    }) {
        this.onTimeUpdateCallback = callbacks.onTimeUpdate;
        this.onDurationCallback = callbacks.onDuration;
        this.onEndedCallback = callbacks.onEnded;
        this.onPlayStateChangeCallback = callbacks.onPlayStateChange;
    }

    // --- Core Playback Controls ---

    public async playUrl(url: string, title?: string, artist?: string, artUrl?: string): Promise<void> {
        this.currentUrl = url;
        this.currentTitle = title || 'Unknown Title';
        this.currentArtist = artist || 'Unknown Artist';
        this.currentArtUrl = artUrl || null;

        try {
            if (castManager.isConnected()) {
                this.audio.pause();
                await castManager.castMedia(this.currentUrl, this.currentTitle, this.currentArtist, this.currentArtUrl || undefined);
                return;
            }

            // Clean up previous URL if it exists AND is a blob
            if (this.audio.src && this.audio.src.startsWith('blob:')) {
                URL.revokeObjectURL(this.audio.src);
            }

            this.audio.src = url;
            this.audio.load();
            await this.audio.play();

            if (!this.audioContext) {
                this.initAudioContext();
            } else if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
        } catch (error) {
            console.error('PlaybackManager playUrl error:', error);
            throw error;
        }
    }

    public async playFile(fileHandle: FileSystemFileHandle): Promise<void> {
        // Cast cannot play files loaded locally directly by default without spinning up a local server inline.
        // We just fallback to local playback.
        try {
            const file = await fileHandle.getFile();
            const url = URL.createObjectURL(file);

            // Clean up previous URL if it exists
            if (this.audio.src && this.audio.src.startsWith('blob:')) {
                URL.revokeObjectURL(this.audio.src);
            }

            this.audio.src = url;
            this.audio.load();
            await this.audio.play();

            if (!this.audioContext) {
                this.initAudioContext();
            } else if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }

        } catch (error) {
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

    public destroy(): void {
        this.audio.pause();
        this.audio.src = '';
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }

    // --- Web Audio API Integration (Foundation for EQ/Visualizers) ---
    private initAudioContext() {
        try {
            this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            const source = this.audioContext.createMediaElementSource(this.audio);

            // Basic routing: Source -> Destination
            // Future: Source -> Gain (crossfade) -> Analyser (visualizer) -> Biquads (EQ) -> Destination
            source.connect(this.audioContext.destination);
        } catch (e) {
            console.warn("Could not initialize AudioContext:", e);
        }
    }
}

export const playbackManager = PlaybackManager.getInstance();
