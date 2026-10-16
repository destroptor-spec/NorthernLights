type RuntimeCacheMatchContext = {
    url: URL;
};

type RuntimeCacheErrorContext = {
    request: Request;
    error: Error;
};

// API image-looking URLs must not fall into the public image cache when the
// generic API NetworkOnly route is removed. Dedicated artwork routes opt in.
export function isPublicImageRequest({ url }: RuntimeCacheMatchContext): boolean {
    return !/^\/(?:api|rest)(?:\/|$)/.test(url.pathname)
        && /\.(?:png|jpg|jpeg|gif|webp|avif)$/.test(url.href);
}

/**
 * Adaptive HLS uses the same pathname for every rendition and differentiates
 * them with query parameters. Keep this route ahead of the generic segment
 * cache so an offline miss can reuse the aligned rendition already on disk.
 */
export function isAdaptiveHlsSegmentRequest({ url }: RuntimeCacheMatchContext): boolean {
    return /\/api\/stream\/.*\.ts$/i.test(url.pathname)
        && url.searchParams.get('adaptive') === '1';
}

/**
 * The Auto master uses quality=auto while its child playlists also carry the
 * adaptive marker. Both need rendition-agnostic fallback during offline replay.
 */
export function isAdaptiveHlsPlaylistRequest({ url }: RuntimeCacheMatchContext): boolean {
    return /\/api\/stream\/.*\.m3u8$/i.test(url.pathname)
        && (url.searchParams.get('quality') === 'auto' || url.searchParams.get('adaptive') === '1');
}

export async function reuseCachedAdaptiveAudioChunk({
    request,
    error,
}: RuntimeCacheErrorContext): Promise<Response> {
    const cache = await caches.open('nl-audio-chunks-v1');
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
}

export async function reuseCachedAdaptivePlaylist({
    request,
    error,
}: RuntimeCacheErrorContext): Promise<Response> {
    const cache = await caches.open('nl-audio-playlists-v1');
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw error;
}

export const adaptiveAudioChunkFallbackPlugin = {
    handlerDidError: reuseCachedAdaptiveAudioChunk,
};

export const adaptivePlaylistFallbackPlugin = {
    handlerDidError: reuseCachedAdaptivePlaylist,
};
