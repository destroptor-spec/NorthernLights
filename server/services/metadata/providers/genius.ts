import { Semaphore, fetchWithRetry } from '../rateLimiter';
import { RateLimitError, ProviderError } from '../errors';

export const geniusSemaphore = new Semaphore(5);

export interface GeniusSearchResult {
  response?: {
    hits?: Array<{
      type?: string;
      result?: {
        primary_artist?: { id: number; name: string; image_url?: string };
        title?: string;
        song_art_image_url?: string;
        header_image_url?: string;
        url?: string;
      };
    }>;
  };
}

export interface GeniusArtist {
  response?: {
    artist?: {
      description?: { plain?: string };
    };
  };
}

export async function geniusSearch(
  query: string,
  apiKey: string
): Promise<GeniusSearchResult | null> {
  await geniusSemaphore.acquire();
  try {
    const res = await fetchWithRetry(`https://api.genius.com/search?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.warn(`[Genius] search failed for "${query}": HTTP ${res.status}`);
      if (res.status === 429) throw new RateLimitError('genius');
      throw new ProviderError('genius', `HTTP ${res.status}`, res.status);
    }
    return res.json();
  } catch (err: any) {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    console.error(`[Genius] search error for "${query}":`, err.message);
    throw new ProviderError('genius', err.message);
  } finally {
    geniusSemaphore.release();
  }
}

export async function geniusGetArtist(
  artistId: number,
  apiKey: string
): Promise<GeniusArtist | null> {
  await geniusSemaphore.acquire();
  try {
    const res = await fetchWithRetry(`https://api.genius.com/artists/${artistId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.warn(`[Genius] getArtist failed for ID ${artistId}: HTTP ${res.status}`);
      if (res.status === 429) throw new RateLimitError('genius');
      throw new ProviderError('genius', `HTTP ${res.status}`, res.status);
    }
    return res.json();
  } catch (err: any) {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    console.error(`[Genius] getArtist error for ID ${artistId}:`, err.message);
    throw new ProviderError('genius', err.message);
  } finally {
    geniusSemaphore.release();
  }
}
