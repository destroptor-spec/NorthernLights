class PlaybackManager {
    static instance;
    audio;
    audioContext = null;
    // Store callbacks for Zustand to update its state
    onTimeUpdateCallback;
    onDurationCallback;
    onEndedCallback;
    onPlayStateChangeCallback;
    constructor() {
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
    static getInstance() {
        if (!PlaybackManager.instance) {
            PlaybackManager.instance = new PlaybackManager();
        }
        return PlaybackManager.instance;
    }
    // --- Callbacks Setup ---
    setCallbacks(callbacks) {
        this.onTimeUpdateCallback = callbacks.onTimeUpdate;
        this.onDurationCallback = callbacks.onDuration;
        this.onEndedCallback = callbacks.onEnded;
        this.onPlayStateChangeCallback = callbacks.onPlayStateChange;
    }
    // --- Core Playback Controls ---
    async playUrl(url) {
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
            }
            else if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
        }
        catch (error) {
            console.error('PlaybackManager playUrl error:', error);
            throw error;
        }
    }
    async playFile(fileHandle) {
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
            }
            else if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
        }
        catch (error) {
            console.error('PlaybackManager playFile error:', error);
            throw error;
        }
    }
    pause() {
        this.audio.pause();
    }
    async resume() {
        if (this.audio.src) {
            await this.audio.play();
            if (this.audioContext?.state === 'suspended') {
                await this.audioContext.resume();
            }
        }
    }
    stop() {
        this.audio.pause();
        this.audio.currentTime = 0;
        this.onPlayStateChangeCallback?.('stopped');
    }
    seek(time) {
        if (isFinite(time) && time >= 0) {
            this.audio.currentTime = time;
        }
    }
    setVolume(volume) {
        // Clamp between 0 and 1
        this.audio.volume = Math.max(0, Math.min(1, volume));
    }
    getDuration() {
        return this.audio.duration || 0;
    }
    getCurrentTime() {
        return this.audio.currentTime || 0;
    }
    destroy() {
        this.audio.pause();
        this.audio.src = '';
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
    }
    // --- Web Audio API Integration (Foundation for EQ/Visualizers) ---
    initAudioContext() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = this.audioContext.createMediaElementSource(this.audio);
            // Basic routing: Source -> Destination
            // Future: Source -> Gain (crossfade) -> Analyser (visualizer) -> Biquads (EQ) -> Destination
            source.connect(this.audioContext.destination);
        }
        catch (e) {
            console.warn("Could not initialize AudioContext:", e);
        }
    }
}
export const playbackManager = PlaybackManager.getInstance();
