import {
    isPublicImageRequest,
    isAdaptiveHlsPlaylistRequest,
    isAdaptiveHlsSegmentRequest,
    reuseCachedAdaptiveAudioChunk,
    reuseCachedAdaptivePlaylist,
} from '../pwaRuntimeCaching';

describe('adaptive HLS runtime caching', () => {
    const originalCaches = globalThis.caches;

    afterEach(() => {
        Object.defineProperty(globalThis, 'caches', {
            configurable: true,
            value: originalCaches,
        });
        jest.restoreAllMocks();
    });

    it('routes only adaptive segment requests through rendition fallback', () => {
        expect(isAdaptiveHlsSegmentRequest({
            url: new URL('https://aurora.test/api/stream/track/segment000.ts?quality=auto&adaptive=1&rendition=320k'),
        })).toBe(true);
        expect(isAdaptiveHlsSegmentRequest({
            url: new URL('https://aurora.test/api/stream/track/segment000.ts?quality=128k'),
        })).toBe(false);
    });

    it('routes the Auto master and adaptive media playlists through offline fallback', () => {
        expect(isAdaptiveHlsPlaylistRequest({
            url: new URL('https://aurora.test/api/stream/track/playlist.m3u8?quality=auto'),
        })).toBe(true);
        expect(isAdaptiveHlsPlaylistRequest({
            url: new URL('https://aurora.test/api/stream/track/media.m3u8?quality=auto&adaptive=1&rendition=64k'),
        })).toBe(true);
        expect(isAdaptiveHlsPlaylistRequest({
            url: new URL('https://aurora.test/api/stream/track/playlist.m3u8?quality=128k'),
        })).toBe(false);
    });

    it.each([
        ['chunk', 'nl-audio-chunks-v1', reuseCachedAdaptiveAudioChunk, 'segment000.ts'],
        ['playlist', 'nl-audio-playlists-v1', reuseCachedAdaptivePlaylist, 'media.m3u8'],
    ] as const)('reuses a cached %s with the same path when an exact rendition misses', async (
        _kind,
        cacheName,
        fallback,
        filename,
    ) => {
        const cachedResponse = { cached: true } as unknown as Response;
        const match = jest.fn().mockResolvedValue(cachedResponse);
        const open = jest.fn().mockResolvedValue({ match });
        Object.defineProperty(globalThis, 'caches', {
            configurable: true,
            value: { open },
        });
        const request = {
            url: `https://aurora.test/api/stream/track/${filename}?adaptive=1&rendition=320k`,
        } as Request;

        await expect(fallback({ request, error: new Error('offline') })).resolves.toBe(cachedResponse);
        expect(open).toHaveBeenCalledWith(cacheName);
        expect(match).toHaveBeenCalledWith(request, { ignoreSearch: true });
    });

    it('preserves the original network failure when no cached rendition exists', async () => {
        const networkError = new Error('offline');
        Object.defineProperty(globalThis, 'caches', {
            configurable: true,
            value: { open: jest.fn().mockResolvedValue({ match: jest.fn().mockResolvedValue(undefined) }) },
        });
        const request = {
            url: 'https://aurora.test/api/stream/track/segment999.ts?adaptive=1&rendition=320k',
        } as Request;

        await expect(reuseCachedAdaptiveAudioChunk({ request, error: networkError })).rejects.toBe(networkError);
    });
});


describe('public image caching boundary', () => {
    it.each(['/api/status', '/api/private.jpg', '/rest/getCoverArt.png', '/api/library/scan/status'])('does not capture authenticated/API requests: %s', (pathname) => {
        expect(isPublicImageRequest({ url: new URL(pathname, 'https://aurora.test'), sameOrigin: true })).toBe(false);
    });
    it('retains public image caching', () => {
        expect(isPublicImageRequest({ url: new URL('https://aurora.test/cover.jpg'), sameOrigin: true })).toBe(true);
    });
    it.each([
        'https://images.genius.com/0d46b6d23734cdfc989af2eeb4730f9a.640x640x1.jpg',
        'https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png',
    ])('leaves cross-origin provider images to the browser: %s', (href) => {
        expect(isPublicImageRequest({ url: new URL(href), sameOrigin: false })).toBe(false);
    });
});
