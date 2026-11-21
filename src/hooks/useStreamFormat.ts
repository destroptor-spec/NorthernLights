import { useEffect, useState } from 'react';
import { auroraApiRequest } from '../api/auroraApi';
import { usePlayerStore } from '../store/index';
import type { StreamFormat } from '../../shared/api/v1';

const cache = new Map<string, StreamFormat>();
const CACHE_LIMIT = 200;

/**
 * The track's source audio and what the stream at `quality` carries
 * (GET /api/v1/tracks/:id/stream-format). Null until it arrives, and for no
 * track; a failed request leaves it null (the chip then shows what the
 * library row knows).
 */
export function useStreamFormat(trackId: string | null | undefined, quality: string): StreamFormat | null {
  const key = trackId ? `${trackId}::${quality}` : null;
  const [format, setFormat] = useState<StreamFormat | null>(() => (key ? cache.get(key) ?? null : null));

  useEffect(() => {
    if (!key || !trackId) {
      setFormat(null);
      return;
    }
    const cached = cache.get(key);
    if (cached) {
      setFormat(cached);
      return;
    }
    setFormat(null);
    let cancelled = false;
    const params = new URLSearchParams({ quality, codec: 'aac' });
    auroraApiRequest<StreamFormat>(
      `/tracks/${encodeURIComponent(trackId)}/stream-format?${params.toString()}`,
      usePlayerStore.getState().getAuthHeader(),
    ).then((result) => {
      if (cache.size >= CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, result);
      if (!cancelled) setFormat(result);
    }).catch(() => { /* the chip falls back to the library row */ });
    return () => { cancelled = true; };
  }, [key, trackId, quality]);

  return format;
}
