import { usePlayerStore } from '../store';

interface ArtistData {
    imageUrl?: string;
    artworkUrl?: string;
    bio?: string;
    disambiguation?: string;
    area?: string;
    type?: string;
    lifeSpan?: { begin?: string; end?: string };
    links?: { url: string; type: string }[];
    genres?: string[];
    communityTags?: { name: string; count: number; providers: Array<'lastfm' | 'musicbrainz'> }[];
    listeners?: string;
    members?: string[];
}

export interface ArtistTopTrackData {
    name: string;
    playcount?: string;
    listeners?: string;
    mbid?: string;
    url?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Proxy an external image URL through the server to avoid CORS and enable caching */
function proxyImageUrl(externalUrl: string): string {
    return `/api/providers/external/proxy-image?url=${encodeURIComponent(externalUrl)}`;
}

function getAuthHeaders(): Record<string, string> {
    const state = usePlayerStore.getState();
    return state.getAuthHeader();
}

// External provider lookups share the browser's small per-origin connection
// budget (6 on HTTP/1.1) with every other request — including the /api/health
// poll that decides whether to swap the app for the DB recovery panel. A grid
// of art-less cards (e.g. Various Artists' 200+ comps) can otherwise enqueue
// dozens of slow lookups (MusicBrainz is rate-limited to ~1 req/s upstream)
// and starve the health check into a false "database down". Cap concurrent
// lookups so most of the pool stays free for interactive traffic.
const MAX_CONCURRENT_LOOKUPS = 4;
let activeLookups = 0;
const pendingLookups: Array<() => void> = [];

async function withLookupSlot<T>(run: () => Promise<T>): Promise<T> {
    if (activeLookups >= MAX_CONCURRENT_LOOKUPS) {
        await new Promise<void>((resolve) => pendingLookups.push(resolve));
    }
    activeLookups++;
    try {
        return await run();
    } finally {
        activeLookups--;
        pendingLookups.shift()?.();
    }
}

async function serverFetch<T>(path: string): Promise<T | null> {
    return withLookupSlot(async () => {
        try {
            const res = await fetch(path, {
                headers: { ...getAuthHeaders() },
            });
            if (!res.ok) return null;
            return res.json();
        } catch {
            return null;
        }
    });
}

// In-memory cache for lookup results that resolve to an image URL or summary.
// The image bytes themselves are already cached by the service worker
// (vite.config.ts runtimeCaching → /api/art, /api/providers/external/proxy-image,
// and generic image MIME types). What this cache eliminates is the small JSON
// lookup that *returns* those URLs — without it, every AlbumArt re-mount on
// scroll re-hits the server, even though the answer never changes within a
// session.
//
// Storing the Promise (not the resolved value) also dedupes concurrent calls
// for the same key — if two cards mount simultaneously and both ask for the
// same album's art, only one network request fires.
const imageryLookupCache = new Map<string, Promise<unknown>>();

function cachedLookup<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = imageryLookupCache.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = run().catch((err) => {
        // Don't poison the cache on failure — let the next caller retry.
        imageryLookupCache.delete(key);
        throw err;
    });
    imageryLookupCache.set(key, promise);
    return promise;
}

// ─── Public API ─────────────────────────────────────────────────────

export const fetchArtistData = (artistName: string, mbArtistId?: string | null): Promise<ArtistData> => {
    if (!artistName) return Promise.resolve({});

    return cachedLookup(`artist::${artistName}::${mbArtistId || ''}`, async () => {
        const params = new URLSearchParams({ name: artistName });
        if (mbArtistId) params.set('mbid', mbArtistId);

        const data = await serverFetch<ArtistData>(`/api/providers/external/artist?${params}`);
        if (!data) return {};

        // Proxy image URL for CORS-free loading
        if (data.imageUrl) {
            data.imageUrl = proxyImageUrl(data.imageUrl);
        }
        if (data.artworkUrl) {
            data.artworkUrl = proxyImageUrl(data.artworkUrl);
        }

        return data;
    });
};

export const fetchArtistTopTracks = (artistName: string, limit: number = 25): Promise<ArtistTopTrackData[]> => {
    if (!artistName) return Promise.resolve([]);

    return cachedLookup(`artist-top-tracks::${artistName}::${limit}`, async () => {
        const params = new URLSearchParams({ name: artistName, limit: String(limit) });
        const data = await serverFetch<{ tracks: ArtistTopTrackData[] }>(`/api/providers/external/artist-top-tracks?${params}`);
        return data?.tracks || [];
    });
};

interface AlbumData {
    imageUrl?: string;
    description?: string;
    tags?: string[];
    listeners?: string;
    playcount?: string;
}

export const fetchAlbumData = (albumName: string, artistName: string, mbAlbumId?: string | null): Promise<AlbumData> => {
    if (!albumName || !artistName) return Promise.resolve({});

    return cachedLookup(`album::${albumName}::${artistName}::${mbAlbumId || ''}`, async () => {
        const params = new URLSearchParams({ album: albumName, artist: artistName });
        if (mbAlbumId) params.set('mbid', mbAlbumId);

        const data = await serverFetch<AlbumData>(`/api/providers/external/album?${params}`);
        if (!data) return {};

        if (data.imageUrl) {
            data.imageUrl = proxyImageUrl(data.imageUrl);
        }

        return data;
    });
};

export const fetchAlbumImage = (albumName: string, artistName: string, mbAlbumId?: string | null): Promise<string | undefined> => {
    if (!albumName || !artistName) return Promise.resolve(undefined);

    const cacheKey = `album-art::${albumName}::${artistName}::${mbAlbumId || ''}`;
    return cachedLookup(cacheKey, async () => {
        const params = new URLSearchParams({ album: albumName, artist: artistName });
        if (mbAlbumId) params.set('mbid', mbAlbumId);

        const data = await serverFetch<{ imageUrl: string | null }>(`/api/providers/external/album-art?${params}`);
        if (!data?.imageUrl) return undefined;
        return proxyImageUrl(data.imageUrl);
    });
};

export const fetchGenreImage = (genreName: string): Promise<string | undefined> => {
    if (!genreName) return Promise.resolve(undefined);

    return cachedLookup(`genre-image::${genreName}`, async () => {
        const data = await serverFetch<{ imageUrl: string | null }>(`/api/providers/external/genre-image?genre=${encodeURIComponent(genreName)}`);
        if (!data?.imageUrl) return undefined;
        return proxyImageUrl(data.imageUrl);
    });
};

export const fetchGenreInfo = (genreName: string): Promise<{ imageUrl?: string; summary?: string } | undefined> => {
    if (!genreName) return Promise.resolve(undefined);

    return cachedLookup(`genre-info::${genreName}`, async () => {
        const data = await serverFetch<{ imageUrl?: string; summary?: string }>(`/api/providers/external/genre-info?genre=${encodeURIComponent(genreName)}`);
        if (!data || (!data.imageUrl && !data.summary)) return undefined;
        return data.imageUrl ? { ...data, imageUrl: proxyImageUrl(data.imageUrl) } : data;
    });
};

export interface LyricsData {
    songUrl: string;
    title: string;
    artist: string;
    thumbnailUrl?: string;
}

export const fetchLyrics = async (trackName: string, artistName: string): Promise<LyricsData | undefined> => {
    if (!trackName || !artistName) return undefined;

    const params = new URLSearchParams({ track: trackName, artist: artistName });
    const data = await serverFetch<LyricsData>(`/api/providers/external/lyrics?${params}`);
    return data || undefined;
};

/**
 * Clear all external imagery caches on the server (admin action).
 * No-op on client — server handles cache invalidation.
 */
export const clearExternalCache = () => {
    // Drop the client-side lookup cache so the next render forces a fresh
    // server hit. The server-side cache clears via POST /api/providers/external/refresh
    // (admin-only), so this client-side reset is what most callers actually need.
    imageryLookupCache.clear();
    // Server-side cache clearing is admin-only via POST /api/providers/external/refresh
    // This function is kept for backward compatibility with store.saveSettings()
    // The server cache is TTL-based and doesn't need client-side clearing
};
