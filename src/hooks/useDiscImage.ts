import { useEffect, useState } from 'react';
import { usePlayerStore } from '../store';

interface DiscImageState {
    /** Real "Medium" (printed disc/vinyl-label) scan from Cover Art Archive, if any. */
    mediumUrl: string | null;
    /** Release-level front cover from CAA — fallback art for the procedural label. */
    frontUrl: string | null;
    releaseMbid: string | null;
    loading: boolean;
}

const EMPTY: DiscImageState = { mediumUrl: null, frontUrl: null, releaseMbid: null, loading: false };

// In-memory cache keyed by album id — the album disc view is revisited often
// (back/forward, edition switches) and the CAA lookup is stable per release.
const cache = new Map<string, DiscImageState>();

/**
 * Resolves disc/label artwork for an album. The server maps the album to its
 * release MBID (tracks.mb_album_id) and queries Cover Art Archive. Returns
 * nulls when MusicBrainz is disabled or the release has no disc scan — callers
 * then fall back to a procedural label built from local cover art.
 */
export function useDiscImage(albumId: string | undefined, discIndex = 0): DiscImageState {
    const key = albumId ? `${albumId}::${discIndex}` : '';
    const [state, setState] = useState<DiscImageState>(() => (key && cache.get(key)) || { ...EMPTY, loading: !!albumId });

    useEffect(() => {
        if (!albumId) { setState(EMPTY); return; }
        const cached = cache.get(key);
        if (cached) { setState(cached); return; }

        let cancelled = false;
        setState({ ...EMPTY, loading: true });

        const authHeaders = usePlayerStore.getState().getAuthHeader();
        fetch(`/api/providers/album/media-image?albumId=${encodeURIComponent(albumId)}&discIndex=${discIndex}`, { headers: authHeaders })
            .then(r => (r.ok ? r.json() : null))
            .then(data => {
                const next: DiscImageState = {
                    mediumUrl: data?.mediumUrl ?? null,
                    frontUrl: data?.frontUrl ?? null,
                    releaseMbid: data?.releaseMbid ?? null,
                    loading: false,
                };
                cache.set(key, next);
                if (!cancelled) setState(next);
            })
            .catch(() => { if (!cancelled) setState(EMPTY); });

        return () => { cancelled = true; };
    }, [albumId, discIndex, key]);

    return state;
}
