import React, { useEffect, useRef, useState, useCallback } from 'react';

interface WaveformProgressBarProps {
    audioUrl: string;
    currentTime: number;
    duration: number;
    onSeek: (time: number) => void;
    dbDuration?: number;       // Fallback duration from DB when stream reports Infinity
    allowWaveformDecode?: boolean; // Set to false for live-transcoded streams to skip fetch+decode
}

// Extract peaks from audio buffer
function extractPeaks(buffer: AudioBuffer, numBars: number): Float32Array {
    const channelData = buffer.getChannelData(0); // mono / left channel
    const samplesPerBar = Math.floor(channelData.length / numBars);
    const peaks = new Float32Array(numBars);

    for (let i = 0; i < numBars; i++) {
        let max = 0;
        const start = i * samplesPerBar;
        const end = start + samplesPerBar;
        for (let j = start; j < end; j++) {
            const abs = Math.abs(channelData[j]);
            if (abs > max) max = abs;
        }
        peaks[i] = max;
    }

    return peaks;
}

// Draw the waveform on the canvas
function drawWaveform(
    canvas: HTMLCanvasElement,
    peaks: Float32Array,
    progress: number, // 0-1
    dpr: number,
    isDark: boolean
) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const numBars = peaks.length;
    const barWidth = W / numBars;
    const gap = Math.max(1, barWidth * 0.25);
    const barW = barWidth - gap;
    const midY = H / 2;
    const progressX = W * progress;

    // Unplayed bar color adapts to theme
    const unplayedColor = isDark
        ? 'rgba(255, 255, 255, 0.18)'
        : 'rgba(0, 0, 0, 0.12)';

    for (let i = 0; i < numBars; i++) {
        const x = i * barWidth;
        const barH = Math.max(2, peaks[i] * (H * 0.85));
        const isPlayed = (x + barW / 2) <= progressX;

        if (isPlayed) {
            const grad = ctx.createLinearGradient(0, midY - barH / 2, 0, midY + barH / 2);
            grad.addColorStop(0, 'rgba(167, 139, 250, 0.9)');
            grad.addColorStop(0.5, 'rgba(139, 92, 246, 1.0)');
            grad.addColorStop(1, 'rgba(109, 40, 217, 0.8)');
            ctx.fillStyle = grad;
        } else {
            ctx.fillStyle = unplayedColor;
        }

        const rx = 2;
        const bx = x + gap / 2;
        const by = midY - barH / 2;
        ctx.beginPath();
        ctx.roundRect(bx, by, barW, barH, rx);
        ctx.fill();

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export const WaveformProgressBar: React.FC<WaveformProgressBarProps> = ({
    audioUrl,
    currentTime,
    duration: rawDuration,
    onSeek,
    dbDuration,
    allowWaveformDecode = true,
}) => {
    // For transcoded streams, the audio element reports Infinity duration.
    // Fall back to the DB-stored duration (in seconds) in that case.
    const duration = (!isFinite(rawDuration) || rawDuration === 0) && dbDuration
        ? dbDuration
        : rawDuration;
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [peaks, setPeaks] = useState<Float32Array | null>(null);
    const [loading, setLoading] = useState(false);
    const lastUrlRef = useRef<string>('');
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

    // Load and decode audio when URL changes -- only when allowed (skip for live transcoded streams)
    useEffect(() => {
        if (!allowWaveformDecode) {
            setLoading(false);
            setPeaks(null);
            lastUrlRef.current = ''; // Reset so switching back to a decodable URL works
            return;
        }
        if (!audioUrl || audioUrl === lastUrlRef.current) return;
        lastUrlRef.current = audioUrl;
        setPeaks(null);
        setLoading(true);

        // We still want the canvas to be usable before decode completes
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

                const canvas = canvasRef.current;
                const numBars = canvas ? Math.floor(canvas.offsetWidth / 3) : 200;
                const extracted = extractPeaks(decoded, numBars);
                setPeaks(extracted);
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

    // Redraw whenever peaks or progress changes
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        if (!peaks) {
            // Draw a placeholder flat line
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const W = canvas.width / dpr;
            const H = canvas.height / dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            const progress = duration > 0 ? currentTime / duration : 0;
            const progressX = W * progress;
            const midY = H / 2;
            // Plain thin track
            ctx.fillStyle = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
            ctx.beginPath();
            ctx.roundRect(0, midY - 1.5, W, 3, 2);
            ctx.fill();
            if (progress > 0) {
                const grad = ctx.createLinearGradient(0, 0, progressX, 0);
                grad.addColorStop(0, 'rgba(139, 92, 246, 0.9)');
                grad.addColorStop(1, 'rgba(167, 139, 250, 1)');
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.roundRect(0, midY - 1.5, progressX, 3, 2);
                ctx.fill();
            }
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            return;
        }

        const progress = duration > 0 ? currentTime / duration : 0;
        drawWaveform(canvas, peaks, progress, dpr, isDark);
    }, [peaks, currentTime, duration, dpr, isDark]);

    // Handle resize: re-extract peaks with new bar count
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !peaks) return;

        const observer = new ResizeObserver(entries => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                canvas.width = width * dpr;
                canvas.height = height * dpr;
                canvas.style.width = `${width}px`;
                canvas.style.height = `${height}px`;
                const progress = duration > 0 ? currentTime / duration : 0;
                drawWaveform(canvas, peaks, progress, dpr, isDark);
            }
        });
        observer.observe(canvas);
        return () => observer.disconnect();
    }, [peaks, currentTime, duration, dpr]);

    // Set canvas size on mount
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
    }, [dpr]);

    const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas || duration === 0) return;
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const fraction = Math.max(0, Math.min(1, x / rect.width));
        onSeek(fraction * duration);
    }, [duration, onSeek]);

    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
        // Show hover cursor
        const canvas = canvasRef.current;
        if (canvas) canvas.style.cursor = 'pointer';
    }, []);

    return (
        <div className="waveform-container" style={{ position: 'relative', width: '100%', height: '48px', display: 'flex', alignItems: 'center' }}>
            <canvas
                ref={canvasRef}
                onClick={handleClick}
                onMouseMove={handleMouseMove}
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'block',
                    cursor: 'pointer',
                    borderRadius: '6px',
                }}
            />
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
                        Loading waveform…
                    </span>
                </div>
            )}
        </div>
    );
};
