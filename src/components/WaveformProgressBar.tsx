import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../store/index';
import { usePlaybackTimeStore } from '../store/playbackTime';
import { formatTime } from '../utils/formatTime';

const KEYBOARD_SEEK_STEP_S = 5;   // Arrow keys
const KEYBOARD_SEEK_PAGE_S = 10;  // PageUp / PageDown

const INTRO_DURATION_MS = 520; // total intro sweep duration
function easeOutCubic(t: number): number { return 1 - Math.pow(1 - t, 3); }

interface WaveformProgressBarProps {
    audioUrl: string;
    duration: number;
    onSeek: (time: number) => void;
    dbDuration?: number;       // Fallback duration from DB when stream reports Infinity
    allowWaveformDecode?: boolean; // Set to false for live-transcoded streams to skip fetch+decode
}

function clampProgress(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

// Extract peaks from audio buffer
function extractPeaks(buffer: AudioBuffer, numBars: number): Float32Array {
    const channelData = buffer.getChannelData(0); // mono / left channel
    const samplesPerBar = Math.max(1, Math.floor(channelData.length / numBars));
    const peaks = new Float32Array(numBars);

    for (let i = 0; i < numBars; i++) {
        let max = 0;
        const start = i * samplesPerBar;
        const end = Math.min(start + samplesPerBar, channelData.length);
        for (let j = start; j < end; j++) {
            const abs = Math.abs(channelData[j]);
            if (abs > max) max = abs;
        }
        peaks[i] = max;
    }

    return peaks;
}

function setCanvasSize(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): void {
    const nextWidth = Math.max(1, Math.floor(width * dpr));
    const nextHeight = Math.max(1, Math.floor(height * dpr));
    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;
}

function resetCanvas(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, dpr: number): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawPlaceholder(
    canvas: HTMLCanvasElement,
    dpr: number,
    isDark: boolean,
    variant: 'base' | 'progress'
): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    resetCanvas(ctx, canvas, dpr);
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const midY = height / 2;

    if (variant === 'progress') {
        const grad = ctx.createLinearGradient(0, 0, width, 0);
        grad.addColorStop(0, 'rgba(34, 197, 94, 0.9)');
        grad.addColorStop(1, 'rgba(52, 211, 153, 1)');
        ctx.fillStyle = grad;
    } else {
        ctx.fillStyle = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
    }

    ctx.beginPath();
    ctx.roundRect(0, midY - 1.5, width, 3, 2);
    ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// Draw one static waveform layer. The moving progress is handled by transform
// updates on the pre-rendered progress layer instead of repainting on every tick.
// animProgress (0–1): sweep position from left; bars to the left of the front are
// fully drawn, bars at the front scale up from 0 → full from their vertical centre.
function drawWaveformLayer(
    canvas: HTMLCanvasElement,
    peaks: Float32Array,
    dpr: number,
    isDark: boolean,
    variant: 'base' | 'progress',
    animProgress = 1
): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    resetCanvas(ctx, canvas, dpr);
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;
    const numBars = peaks.length;
    const barWidth = width / numBars;
    const gap = Math.max(1, barWidth * 0.25);
    const barW = Math.max(1, barWidth - gap);
    const midY = height / 2;

    if (variant === 'progress') {
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, 'rgba(52, 211, 153, 0.9)');
        grad.addColorStop(0.5, 'rgba(34, 197, 94, 1.0)');
        grad.addColorStop(1, 'rgba(21, 128, 61, 0.8)');
        ctx.fillStyle = grad;
    } else {
        ctx.fillStyle = isDark
            ? 'rgba(255, 255, 255, 0.18)'
            : 'rgba(0, 0, 0, 0.12)';
    }

    // How many bars the sweep front has reached (fractional)
    const frontBar = animProgress * numBars;

    for (let i = 0; i < numBars; i++) {
        // How far past this bar the sweep front is (0 = not reached, 1 = fully revealed)
        // Use a soft window of 2 bars so adjacent pillars stagger nicely
        const barScale = Math.min(1, Math.max(0, (frontBar - i) / 2));
        if (barScale === 0) continue;

        const x = i * barWidth;
        const fullBarH = Math.max(2, peaks[i] * (height * 0.85));
        const barH = fullBarH * barScale;
        const bx = x + gap / 2;
        const by = midY - barH / 2; // always centred vertically

        ctx.beginPath();
        ctx.roundRect(bx, by, barW, barH, 2);
        ctx.fill();
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

const WaveformProgressBarComponent: React.FC<WaveformProgressBarProps> = ({
    audioUrl,
    duration: rawDuration,
    onSeek,
    dbDuration,
    allowWaveformDecode = true,
}) => {
    // For transcoded streams, the audio element reports Infinity duration.
    // Fall back to the DB-stored duration (in seconds) in that case.
    const duration = (!Number.isFinite(rawDuration) || rawDuration === 0) && dbDuration
        ? dbDuration
        : rawDuration;
    const theme = usePlayerStore(state => state.resolvedTheme);
    const isDark = theme === 'dark';
    const reducedMotion = usePlayerStore(state => state.reducedMotion);
    const containerRef = useRef<HTMLDivElement>(null);
    const baseCanvasRef = useRef<HTMLCanvasElement>(null);
    const progressCanvasRef = useRef<HTMLCanvasElement>(null);
    const progressLayerRef = useRef<HTMLDivElement>(null);
    const durationRef = useRef(duration);
    const [peaks, setPeaks] = useState<Float32Array | null>(null);
    const [loading, setLoading] = useState(false);
    const lastUrlRef = useRef<string>('');
    // Retain the decoded audio buffer so we can re-extract peaks at new
    // bucket counts when the container is resized, without re-fetching.
    const decodedBufferRef = useRef<AudioBuffer | null>(null);
    const lastBarCountRef = useRef<number>(0);
    // Intro animation state
    const introAnimRef = useRef<number | null>(null);
    const introStartRef = useRef<number | null>(null);
    const animProgressRef = useRef<number>(1); // 1 = fully drawn (no animation pending)
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;

    const updateProgressLayer = useCallback((time: number) => {
        const progress = durationRef.current > 0 ? clampProgress(time / durationRef.current) : 0;
        // Update the slider's accessible position imperatively (no React re-render)
        // so screen readers can report seek position without breaking the
        // per-tick render-avoidance this component is built around.
        const container = containerRef.current;
        if (container && durationRef.current > 0) {
            container.setAttribute('aria-valuenow', String(Math.round(time)));
            container.setAttribute('aria-valuetext', `${formatTime(time)} of ${formatTime(durationRef.current)}`);
        }
        const layer = progressLayerRef.current;
        const progressCanvas = progressCanvasRef.current;
        if (!layer || !progressCanvas) return;

        if (progress <= 0.0005) {
            layer.style.opacity = '0';
            layer.style.transform = 'scaleX(0)';
            progressCanvas.style.transform = 'scaleX(1)';
            return;
        }

        const visibleProgress = Math.max(progress, 0.001);
        layer.style.opacity = '1';
        layer.style.transform = `scaleX(${visibleProgress.toFixed(5)})`;
        progressCanvas.style.transform = `scaleX(${(1 / visibleProgress).toFixed(5)})`;
    }, []);

    useEffect(() => {
        durationRef.current = duration;
        updateProgressLayer(usePlaybackTimeStore.getState().currentTime);
    }, [duration, updateProgressLayer]);

    useEffect(() => {
        return usePlaybackTimeStore.subscribe((state, previousState) => {
            if (state.currentTime !== previousState.currentTime || state.duration !== previousState.duration) {
                updateProgressLayer(state.currentTime);
            }
        });
    }, [updateProgressLayer]);

    const drawStaticLayers = useCallback((animProgress = animProgressRef.current) => {
        const container = containerRef.current;
        const baseCanvas = baseCanvasRef.current;
        const progressCanvas = progressCanvasRef.current;
        if (!container || !baseCanvas || !progressCanvas) return;

        const rect = container.getBoundingClientRect();
        const width = rect.width || container.offsetWidth || 1;
        const height = rect.height || 48;
        setCanvasSize(baseCanvas, width, height, dpr);
        setCanvasSize(progressCanvas, width, height, dpr);

        if (peaks) {
            drawWaveformLayer(baseCanvas, peaks, dpr, isDark, 'base', animProgress);
            drawWaveformLayer(progressCanvas, peaks, dpr, isDark, 'progress', animProgress);
        } else {
            drawPlaceholder(baseCanvas, dpr, isDark, 'base');
            drawPlaceholder(progressCanvas, dpr, isDark, 'progress');
        }

        updateProgressLayer(usePlaybackTimeStore.getState().currentTime);
    }, [dpr, isDark, peaks, updateProgressLayer]);

    // Kick off the intro sweep whenever peaks first arrive
    useEffect(() => {
        if (!peaks) return;

        // Cancel any previous in-flight animation
        if (introAnimRef.current !== null) cancelAnimationFrame(introAnimRef.current);
        introStartRef.current = null;
        animProgressRef.current = 0;

        // Respect the user's reduced-motion preference: skip the sweep and draw
        // the final waveform immediately.
        if (reducedMotion) {
            animProgressRef.current = 1;
            drawStaticLayers(1);
            return;
        }

        const tick = (now: number) => {
            if (introStartRef.current === null) introStartRef.current = now;
            const elapsed = now - introStartRef.current;
            const raw = Math.min(elapsed / INTRO_DURATION_MS, 1);
            const eased = easeOutCubic(raw);
            animProgressRef.current = eased;
            drawStaticLayers(eased);

            if (raw < 1) {
                introAnimRef.current = requestAnimationFrame(tick);
            } else {
                introAnimRef.current = null;
                animProgressRef.current = 1;
            }
        };

        introAnimRef.current = requestAnimationFrame(tick);
        return () => {
            if (introAnimRef.current !== null) cancelAnimationFrame(introAnimRef.current);
        };
    // drawStaticLayers is intentionally excluded: we only want this to fire when peaks change
    // (or when the reduced-motion preference flips).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [peaks, reducedMotion]);

    // Load and decode audio when URL changes. Skip for live transcoded streams.
    useEffect(() => {
        if (!allowWaveformDecode) {
            setLoading(false);
            setPeaks(null);
            decodedBufferRef.current = null;
            lastBarCountRef.current = 0;
            lastUrlRef.current = ''; // Reset so switching back to a decodable URL works
            return;
        }
        if (!audioUrl || audioUrl === lastUrlRef.current) return;
        lastUrlRef.current = audioUrl;
        decodedBufferRef.current = null;
        lastBarCountRef.current = 0;
        setPeaks(null);
        setLoading(true);

        const abortCtrl = new AbortController();

        (async () => {
            try {
                const res = await fetch(audioUrl, { signal: abortCtrl.signal });
                const arrayBuffer = await res.arrayBuffer();
                if (abortCtrl.signal.aborted) return;

                const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 22050 });
                const decoded = await audioCtx.decodeAudioData(arrayBuffer);
                audioCtx.close();
                if (abortCtrl.signal.aborted) return;

                decodedBufferRef.current = decoded;
                const width = containerRef.current?.offsetWidth || 600;
                const numBars = Math.max(24, Math.floor(width / 3));
                lastBarCountRef.current = numBars;
                setPeaks(extractPeaks(decoded, numBars));
            } catch (e) {
                if ((e as any)?.name !== 'AbortError') {
                    console.warn('Waveform decode failed:', e);
                }
            } finally {
                setLoading(false);
            }
        })();

        return () => abortCtrl.abort();
    }, [audioUrl, allowWaveformDecode]);

    // When the container width changes significantly (e.g. dock/undock),
    // re-extract peaks at the new bucket count. The decoded buffer is kept
    // in a ref so this is essentially free — no fetch, no re-decode.
    const reextractPeaksForWidth = useCallback((widthPx: number) => {
        const decoded = decodedBufferRef.current;
        if (!decoded) return;
        const numBars = Math.max(24, Math.floor(widthPx / 3));
        if (Math.abs(numBars - lastBarCountRef.current) < 6) return; // ignore noise
        lastBarCountRef.current = numBars;
        setPeaks(extractPeaks(decoded, numBars));
    }, []);

    useEffect(() => {
        drawStaticLayers();
    }, [drawStaticLayers]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        let frame: number | null = null;
        const observer = new ResizeObserver(() => {
            // Re-extract peaks first (state update triggers a redraw via the
            // drawStaticLayers effect), then defensively redraw for the
            // common case where bucket count is stable.
            const width = container.offsetWidth || container.clientWidth;
            if (width > 0) reextractPeaksForWidth(width);
            if (frame !== null) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                frame = null;
                drawStaticLayers();
            });
        });
        observer.observe(container);
        return () => {
            observer.disconnect();
            if (frame !== null) cancelAnimationFrame(frame);
        };
    }, [drawStaticLayers, reextractPeaksForWidth]);

    const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        const container = containerRef.current;
        if (!container || duration === 0) return;
        const rect = container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const fraction = Math.max(0, Math.min(1, x / rect.width));
        onSeek(fraction * duration);
    }, [duration, onSeek]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        if (!duration) return;
        const current = usePlaybackTimeStore.getState().currentTime;
        let next: number | null = null;
        switch (e.key) {
            case 'ArrowRight':
            case 'ArrowUp':
                next = current + KEYBOARD_SEEK_STEP_S;
                break;
            case 'ArrowLeft':
            case 'ArrowDown':
                next = current - KEYBOARD_SEEK_STEP_S;
                break;
            case 'PageUp':
                next = current + KEYBOARD_SEEK_PAGE_S;
                break;
            case 'PageDown':
                next = current - KEYBOARD_SEEK_PAGE_S;
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = duration;
                break;
            default:
                return;
        }
        e.preventDefault();
        onSeek(Math.max(0, Math.min(duration, next)));
    }, [duration, onSeek]);

    return (
        <div
            ref={containerRef}
            className="waveform-container"
            onClick={handleClick}
            onKeyDown={handleKeyDown}
            role="slider"
            tabIndex={0}
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Number.isFinite(duration) ? Math.round(duration) : 0}
            aria-valuenow={0}
            style={{
                position: 'relative',
                width: '100%',
                height: '48px',
                cursor: 'pointer',
                borderRadius: '6px',
                overflow: 'hidden',
                touchAction: 'manipulation',
            }}
        >
            <canvas
                ref={baseCanvasRef}
                style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    display: 'block',
                }}
            />
            <div
                ref={progressLayerRef}
                style={{
                    position: 'absolute',
                    inset: 0,
                    pointerEvents: 'none',
                    overflow: 'hidden',
                    opacity: 0,
                    transform: 'scaleX(0)',
                    transformOrigin: 'left center',
                    willChange: 'transform',
                }}
            >
                <canvas
                    ref={progressCanvasRef}
                    style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        display: 'block',
                        transformOrigin: 'left center',
                        willChange: 'transform',
                    }}
                />
            </div>
            {loading && (
                <div style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'none',
                }}>
                    <span style={{ fontSize: '0.65rem', color: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)', letterSpacing: '0.1em' }}>
                        Loading waveform...
                    </span>
                </div>
            )}
        </div>
    );
};

export const WaveformProgressBar = React.memo(WaveformProgressBarComponent);
WaveformProgressBar.displayName = 'WaveformProgressBar';
