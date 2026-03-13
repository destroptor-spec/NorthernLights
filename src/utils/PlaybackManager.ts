export type PlaybackState = 'playing' | 'paused' | 'stopped';

class PlaybackManager {
    private static instance: PlaybackManager;
    private audio: HTMLAudioElement;
    private audioContext: AudioContext | null = null;

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
            this.onTimeUpdateCallback?.(this.audio.currentTime);
        });

        this.audio.addEventListener('loadedmetadata', () => {
            this.onDurationCallback?.(this.audio.duration || 0);
        });

        this.audio.addEventListener('ended', () => {
            this.onPlayStateChangeCallback?.('stopped');
            this.onEndedCallback?.();
        });

        this.audio.addEventListener('play', () => this.onPlayStateChangeCallback?.('playing'));
        this.audio.addEventListener('pause', () => this.onPlayStateChangeCallback?.('paused'));
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

    public async playUrl(url: string): Promise<void> {
        try {
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

            // Initialize AudioContext lazily on user interaction
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
        this.audio.pause();
    }

    public async resume(): Promise<void> {
        if (this.audio.src) {
            await this.audio.play();
            if (this.audioContext?.state === 'suspended') {
                await this.audioContext.resume();
            }
        }
    }

    public stop(): void {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.onPlayStateChangeCallback?.('stopped');
    }

    public seek(time: number): void {
        if (isFinite(time) && time >= 0) {
            this.audio.currentTime = time;
        }
    }

    public setVolume(volume: number): void {
        // Clamp between 0 and 1
        this.audio.volume = Math.max(0, Math.min(1, volume));
    }

    public getDuration(): number {
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
