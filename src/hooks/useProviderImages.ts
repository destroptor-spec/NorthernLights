import { useEffect, useState } from 'react';
import { auroraApiRequest } from '../api/auroraApi';
import { usePlayerStore } from '../store';
import type { ProviderImages } from '../../shared/api/v1';

type Image = NonNullable<ProviderImages['images']>[number];

/**
 * The provider pictures for an About card's carousel: an artist's hero images
 * (`/artists/:id/hero-images`) or an album's artwork (`/albums/:id/artwork-images`).
 * Its own request once the page is open (the first per artist or album asks
 * the providers); null until it answers, and when it fails.
 */
export function useProviderImages(path: string | null): Image[] | null {
    const [result, setResult] = useState<{ path: string; images: Image[] | null } | null>(null);
    useEffect(() => {
        if (!path) return;
        let live = true;
        auroraApiRequest<ProviderImages>(path, usePlayerStore.getState().getAuthHeader())
            .then(data => { if (live) setResult({ path, images: data?.images ?? null }); })
            .catch(() => { if (live) setResult({ path, images: null }); });
        return () => { live = false; };
    }, [path]);
    return result?.path === path ? result.images : null;
}
