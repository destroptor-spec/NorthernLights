import { Semaphore, fetchWithRetry } from '../rateLimiter';
import { RateLimitError, ProviderError } from '../errors';

const LASTFM_API = 'https://ws.audioscrobbler.org/2.0/';

export interface LastFmArtistInfo {
  name: string;
  bio?: { summary?: string; content?: string };
  image?: Array<{ size: string; '#text': string }>;
  tags?: { tag: Array<{ name: string }> };
  stats?: { listeners?: string; plays?: string };
}

export interface LastFmAlbumInfo {
  name: string;
  artist?: string;
  image?: Array<{ size: string; '#text': string }>;
  tags?: { tag: Array<{ name: string }> };
}

export interface LastFmTagAlbums {
  album?: Array<{ name: string; image: Array<{ size: string; '#text': string }> }>;
}

export interface LastFmTagInfo {
  name: string;
  wiki?: { summary?: string; content?: string };
}

export const lastFmSemaphore = new Semaphore(5);

export function extractLastFmImage(images: any[]): string | undefined {
  if (!Array.isArray(images)) return undefined;
  const largeImg = images.find(
    (i: any) => i.size === 'mega' || i.size === 'extralarge' || i.size === 'large'
  );
  if (
    largeImg &&
    largeImg['#text'] &&
    !largeImg['#text'].includes('2a96cbd8b46e442fc41c2b86b821562f')
  ) {
    return largeImg['#text'];
  }
  return undefined;
}

export async function lastFmArtistInfo(
  artist: string,
  apiKey: string
): Promise<LastFmArtistInfo | null> {
  await lastFmSemaphore.acquire();
  try {
    const res = await fetchWithRetry(
      `${LASTFM_API}?method=artist.getinfo&artist=${encodeURIComponent(artist)}&api_key=${apiKey}&format=json`
    );
    if (!res.ok) {
      console.warn(`[Last.fm] artist.getinfo failed for "${artist}": HTTP ${res.status}`);
      if (res.status === 429) throw new RateLimitError('lastfm');
      throw new ProviderError('lastfm', `HTTP ${res.status}`, res.status);
    }
    const json = await res.json();
    if (json.error) {
      console.warn(`[Last.fm] API error for "${artist}": ${json.message} (code ${json.error})`);
      if (json.error === 29) throw new RateLimitError('lastfm');
      throw new ProviderError('lastfm', json.message, json.error);
    }
    return json.artist || null;
  } catch (err: any) {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    console.error(`[Last.fm] fetch error for "${artist}":`, err.message);
    throw new ProviderError('lastfm', err.message);
  } finally {
    lastFmSemaphore.release();
  }
}

export async function lastFmAlbumInfo(
  album: string,
  artist: string,
  apiKey: string
): Promise<LastFmAlbumInfo | null> {
  await lastFmSemaphore.acquire();
  try {
    const res = await fetchWithRetry(
      `${LASTFM_API}?method=album.getinfo&api_key=${apiKey}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&format=json`
    );
    if (!res.ok) {
      if (res.status === 429) throw new RateLimitError('lastfm');
      throw new ProviderError('lastfm', `HTTP ${res.status}`, res.status);
    }
    const json = await res.json();
    if (json.error === 29) throw new RateLimitError('lastfm');
    if (json.error) throw new ProviderError('lastfm', json.message, json.error);
    return json.album || null;
  } catch (err: any) {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    throw new ProviderError('lastfm', err.message);
  } finally {
    lastFmSemaphore.release();
  }
}

export async function lastFmTagTopAlbums(
  tag: string,
  apiKey: string
): Promise<LastFmTagAlbums | null> {
  await lastFmSemaphore.acquire();
  try {
    const res = await fetchWithRetry(
      `${LASTFM_API}?method=tag.gettopalbums&tag=${encodeURIComponent(tag)}&api_key=${apiKey}&format=json&limit=1`
    );
    if (!res.ok) {
      if (res.status === 429) throw new RateLimitError('lastfm');
      throw new ProviderError('lastfm', `HTTP ${res.status}`, res.status);
    }
    const json = await res.json();
    if (json.error === 29) throw new RateLimitError('lastfm');
    if (json.error) throw new ProviderError('lastfm', json.message, json.error);
    return json.albums || null;
  } catch (err: any) {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    throw new ProviderError('lastfm', err.message);
  } finally {
    lastFmSemaphore.release();
  }
}

export async function lastFmTagInfo(
  tag: string,
  apiKey: string
): Promise<LastFmTagInfo | null> {
  await lastFmSemaphore.acquire();
  try {
    const res = await fetchWithRetry(
      `${LASTFM_API}?method=tag.getinfo&tag=${encodeURIComponent(tag)}&api_key=${apiKey}&format=json`
    );
    if (!res.ok) {
      if (res.status === 429) throw new RateLimitError('lastfm');
      throw new ProviderError('lastfm', `HTTP ${res.status}`, res.status);
    }
    const json = await res.json();
    if (json.error === 29) throw new RateLimitError('lastfm');
    if (json.error) throw new ProviderError('lastfm', json.message, json.error);
    return json.tag || null;
  } catch (err: any) {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    throw new ProviderError('lastfm', err.message);
  } finally {
    lastFmSemaphore.release();
  }
}

export async function testLastFm(apiKey: string, sharedSecret: string): Promise<{ status: string; error?: string }> {
  if (!apiKey) return { status: 'error', error: 'No API key configured' };
  if (!sharedSecret) return { status: 'error', error: 'No Shared Secret configured' };

  try {
    const res = await fetchWithRetry(
      `${LASTFM_API}?method=artist.getinfo&artist=Radiohead&api_key=${apiKey}&format=json`
    );
    const json = await res.json();
    if (json.error) {
      return { status: 'error', error: json.message || `API error ${json.error}` };
    }
    if (json.artist) {
      return { status: 'ok' };
    }
    return { status: 'error', error: 'Unexpected response' };
  } catch (err: any) {
    return { status: 'error', error: err.message || 'Network error' };
  }
}
