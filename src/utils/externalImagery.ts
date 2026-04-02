import { usePlayerStore } from '../store';

interface ArtistData {
    imageUrl?: string;
    bio?: string;
    disambiguation?: string;
    area?: string;
    type?: string;
    lifeSpan?: { begin?: string; end?: string };
    links?: { url: string; type: string }[];
    genres?: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Proxy an external image URL through the server to avoid CORS and enable caching */
function proxyImageUrl(externalUrl: string): string {
    return `/api/providers/external/proxy-image?url=${encodeURIComponent(externalUrl)}`;
}

function getAuthHeaders(): Record<string, string> {
    const state = usePlayerStore.getState();
    return (state as any).getAuthHeader?.() || {};
}

async function serverFetch<T>(path: string): Promise<T | null> {
    try {
        const res = await fetch(path, {
            headers: { ...getAuthHeaders() },
        });
        if (!res.ok) return null;
        return res.json();
    } catch {
        return null;
    }
}

// ─── Public API ─────────────────────────────────────────────────────

export const fetchArtistData = async (artistName: string, mbArtistId?: string | null): Promise<ArtistData> => {
    if (!artistName) return {};

    const params = new URLSearchParams({ name: artistName });
    if (mbArtistId) params.set('mbid', mbArtistId);

    const data = await serverFetch<ArtistData>(`/api/providers/external/artist?${params}`);
    if (!data) return {};

    // Proxy image URL for CORS-free loading
    if (data.imageUrl) {
        data.imageUrl = proxyImageUrl(data.imageUrl);
    }

    return data;
};

export const fetchAlbumImage = async (albumName: string, artistName: string, mbAlbumId?: string | null): Promise<string | undefined> => {
    if (!albumName || !artistName) return undefined;

    const params = new URLSearchParams({ album: albumName, artist: artistName });
    if (mbAlbumId) params.set('mbid', mbAlbumId);

    const data = await serverFetch<{ imageUrl: string | null }>(`/api/providers/external/album-art?${params}`);
    if (!data?.imageUrl) return undefined;

    return proxyImageUrl(data.imageUrl);
};

export const fetchGenreImage = async (genreName: string): Promise<string | undefined> => {
    if (!genreName) return undefined;

    const data = await serverFetch<{ imageUrl: string | null }>(`/api/providers/external/genre-image?genre=${encodeURIComponent(genreName)}`);
    if (!data?.imageUrl) return undefined;

    return proxyImageUrl(data.imageUrl);
};

export const fetchGenreInfo = async (genreName: string): Promise<{ imageUrl?: string; summary?: string } | undefined> => {
    if (!genreName) return undefined;

    const data = await serverFetch<{ imageUrl?: string; summary?: string }>(`/api/providers/external/genre-info?genre=${encodeURIComponent(genreName)}`);
    if (!data || (!data.imageUrl && !data.summary)) return undefined;

    // Proxy image URL
    if (data.imageUrl) {
        data.imageUrl = proxyImageUrl(data.imageUrl);
    }

    return data;
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
    // Server-side cache clearing is admin-only via POST /api/providers/external/refresh
    // This function is kept for backward compatibility with store.saveSettings()
    // The server cache is TTL-based and doesn't need client-side clearing
};
