import type { TrackInfo } from './fileSystem';
import { logPlaybackInfo } from './playbackDebug';
import { canBrowserPlayNative } from './losslessCapability';
import { applyCastStreamingQualityToHlsUrl, applyStreamingQualityToHlsUrl, type StreamingQualityPreset } from './streaming';

// Preparing ahead is a non-essential optimization, so don't spend bandwidth on
// it when we shouldn't: offline (the request just fails), Save-Data enabled, or
// a slow cellular link. Reads navigator directly since this is not a React hook.
// Shared with PlaybackManager, which loads the next original file ahead.
export function backgroundPrefetchSkipReason(): string | null {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (conn?.saveData) return 'save-data';
    if (conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g') return `slow connection (${conn.effectiveType})`;
    return null;
}

/**
 * At Source quality a file this browser plays as it is streams directly
 * (PlaybackManager.playUrl), never through HLS. Casting always uses HLS.
 */
export function playsDirect(track: Pick<TrackInfo, 'format'>, streamingQuality: StreamingQualityPreset, castConnected = false): boolean {
    return !castConnected && streamingQuality === 'source' && canBrowserPlayNative(track.format);
}

type PrewarmOptions = {
    castConnected?: boolean;
    aheadCount?: 1 | 2;
};

class PreloadManager {
    private static instance: PreloadManager;
    private readonly inFlight = new Map<string, Promise<void>>();
    private readonly completedAt = new Map<string, number>();
    private readonly completedTtlMs = 10 * 60 * 1000;

    public static getInstance(): PreloadManager {
        if (!PreloadManager.instance) {
            PreloadManager.instance = new PreloadManager();
        }
        return PreloadManager.instance;
    }

    public prewarmNext(
        playlist: TrackInfo[],
        currentIndex: number | null,
        streamingQuality: StreamingQualityPreset,
        options: PrewarmOptions = {}
    ): void {
        if (currentIndex === null || currentIndex < 0) return;
        const aheadCount = options.aheadCount ?? 1;
        for (let offset = 1; offset <= aheadCount; offset += 1) {
            const track = playlist[currentIndex + offset];
            if (!track) break;
            this.prewarmTrack(track, streamingQuality, options);
        }
    }

    public prewarmTrack(
        track: TrackInfo,
        streamingQuality: StreamingQualityPreset,
        options: PrewarmOptions = {}
    ): void {
        // Nothing plays an HLS session for a track that streams directly.
        if (playsDirect(track, streamingQuality, options.castConnected)) return;
        const skipReason = backgroundPrefetchSkipReason();
        if (skipReason) {
            logPlaybackInfo(`[Preload] Skipping prewarm: ${skipReason}`);
            return;
        }

        const prewarmUrl = this.buildPrewarmUrl(track, streamingQuality, options);
        if (!prewarmUrl) return;

        const key = prewarmUrl.toString();
        const completedAt = this.completedAt.get(key);
        if (completedAt && Date.now() - completedAt < this.completedTtlMs) return;
        if (this.inFlight.has(key)) return;

        logPlaybackInfo(`[Preload] Prewarming next HLS session: ${track.title || 'Unknown Title'}${track.artist ? ` by ${track.artist}` : ''}`);

        const request = fetch(prewarmUrl, {
            method: 'POST',
            keepalive: true,
        })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`HLS prewarm failed with HTTP ${response.status}`);
                }
                logPlaybackInfo(`[Preload] Next HLS session ready: ${track.title || 'Unknown Title'}${track.artist ? ` by ${track.artist}` : ''}`);
                this.completedAt.set(key, Date.now());
            })
            .catch((error) => {
                console.warn('[Preload] HLS prewarm skipped/failed:', error);
            })
            .finally(() => {
                this.inFlight.delete(key);
                this.pruneCompleted();
            });

        this.inFlight.set(key, request);
    }

    private buildPrewarmUrl(
        track: TrackInfo,
        streamingQuality: StreamingQualityPreset,
        options: PrewarmOptions
    ): URL | null {
        if (!track.url || !track.url.includes('/playlist.m3u8')) return null;

        try {
            // Warm the flavor that will actually be requested. The custom Cast
            // receiver always plays the fixed cast quality with codec=aac (see
            // CastManager.buildMediaInfo); browser playback resolves the preset
            // locally and omits codec (the server defaults it to aac).
            const flavoredUrl = options.castConnected
                ? applyCastStreamingQualityToHlsUrl(track.url, streamingQuality)
                : applyStreamingQualityToHlsUrl(track.url, streamingQuality);
            const hlsUrl = new URL(flavoredUrl, window.location.origin);
            hlsUrl.pathname = hlsUrl.pathname.replace(/\/playlist\.m3u8$/, '/prewarm');
            if (options.castConnected && !hlsUrl.searchParams.has('codec')) {
                hlsUrl.searchParams.set('codec', 'aac');
            }
            return hlsUrl;
        } catch {
            return null;
        }
    }

    private pruneCompleted(): void {
        const now = Date.now();
        for (const [key, completedAt] of this.completedAt.entries()) {
            if (now - completedAt >= this.completedTtlMs) {
                this.completedAt.delete(key);
            }
        }
    }
}

export const preloadManager = PreloadManager.getInstance();
