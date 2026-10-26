import { lastFmThrottle, fetchWithRetry } from '../rateLimiter';
import { RateLimitError, ProviderError, messageWithCause } from '../errors';

const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';

export interface LastFmArtistInfo {
  name: string;
  bio?: { summary?: string; content?: string };
  image?: Array<{ size: string; '#text': string }>;
  tags?: { tag: Array<{ name: string; count?: number | string }> };
  stats?: { listeners?: string; plays?: string };
}

export interface LastFmAlbumInfo {
  name: string;
  artist?: string;
  image?: Array<{ size: string; '#text': string }>;
  tags?: { tag: Array<{ name: string }> };
  wiki?: { summary?: string; content?: string };
  listeners?: string;
  playcount?: string;
}

export interface LastFmTagAlbums {
  album?: Array<{ name: string; image: Array<{ size: string; '#text': string }> }>;
}

export interface LastFmTagInfo {
  name: string;
  wiki?: { summary?: string; content?: string };
}

export interface LastFmTopTags {
  tag?: Array<{ name: string; count?: number | string }>;
}

export interface LastFmArtistTopTrack {
  name: string;
  playcount?: string;
  listeners?: string;
  mbid?: string;
  url?: string;
}

export interface LastFmArtistTopTracks {
  track?: LastFmArtistTopTrack | LastFmArtistTopTrack[];
}



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
  return lastFmThrottle.run(async () => {
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
  }).catch((err: any) => {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    console.error(`[Last.fm] fetch error for "${artist}":`, err.message);
    throw new ProviderError('lastfm', messageWithCause(err));
  });
}

export async function lastFmAlbumInfo(
  album: string,
  artist: string,
  apiKey: string
): Promise<LastFmAlbumInfo | null> {
  return lastFmThrottle.run(async () => {
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
  }).catch((err: any) => {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    throw new ProviderError('lastfm', messageWithCause(err));
  });
}

export async function lastFmArtistTopTags(
  artist: string,
  apiKey: string
): Promise<LastFmTopTags | null> {
  return lastFmThrottle.run(async () => {
    const res = await fetchWithRetry(
      `${LASTFM_API}?method=artist.gettoptags&artist=${encodeURIComponent(artist)}&api_key=${apiKey}&format=json`
    );
    if (!res.ok) {
      if (res.status === 429) throw new RateLimitError('lastfm');
      throw new ProviderError('lastfm', `HTTP ${res.status}`, res.status);
    }
    const json = await res.json();
    if (json.error === 29) throw new RateLimitError('lastfm');
    if (json.error) throw new ProviderError('lastfm', json.message, json.error);
    return json.toptags || null;
  }).catch((err: any) => {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    throw new ProviderError('lastfm', messageWithCause(err));
  });
}

export async function lastFmArtistTopTracks(
  artist: string,
  apiKey: string,
  limit: number = 25
): Promise<LastFmArtistTopTrack[]> {
  return lastFmThrottle.run(async () => {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const res = await fetchWithRetry(
      `${LASTFM_API}?method=artist.gettoptracks&artist=${encodeURIComponent(artist)}&api_key=${apiKey}&format=json&limit=${safeLimit}`
    );
    if (!res.ok) {
      if (res.status === 429) throw new RateLimitError('lastfm');
      throw new ProviderError('lastfm', `HTTP ${res.status}`, res.status);
    }
    const json = await res.json();
    if (json.error === 29) throw new RateLimitError('lastfm');
    if (json.error) throw new ProviderError('lastfm', json.message, json.error);
    const rawTracks = (json.toptracks as LastFmArtistTopTracks | undefined)?.track;
    if (!rawTracks) return [];
    return Array.isArray(rawTracks) ? rawTracks : [rawTracks];
  }).catch((err: any) => {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    throw new ProviderError('lastfm', messageWithCause(err));
  });
}

export async function lastFmTagTopAlbums(
  tag: string,
  apiKey: string
): Promise<LastFmTagAlbums | null> {
  return lastFmThrottle.run(async () => {
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
  }).catch((err: any) => {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    throw new ProviderError('lastfm', messageWithCause(err));
  });
}

export async function lastFmTagInfo(
  tag: string,
  apiKey: string
): Promise<LastFmTagInfo | null> {
  return lastFmThrottle.run(async () => {
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
  }).catch((err: any) => {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    throw new ProviderError('lastfm', messageWithCause(err));
  });
}

import { createHash } from 'crypto';

function buildTestSignature(params: Record<string, string>, secret: string): string {
  const filtered = Object.entries(params)
    .filter(([key]) => key !== 'format' && key !== 'callback')
    .sort(([a], [b]) => a.localeCompare(b));

  let sigString = '';
  for (const [key, value] of filtered) {
    sigString += key + value;
  }
  sigString += secret;

  return createHash('md5').update(sigString, 'utf8').digest('hex');
}

export async function testLastFm(apiKey: string, sharedSecret: string): Promise<{ status: string; error?: string }> {
  if (!apiKey) return { status: 'error', error: 'No API key configured' };
  if (!sharedSecret) return { status: 'error', error: 'No Shared Secret configured' };

  try {
    // Step 1: Validate API Key and fetch an unauthorized token
    const tokenParams: Record<string, string> = {
      method: 'auth.getToken',
      api_key: apiKey.trim(),
      format: 'json'
    };
    tokenParams.api_sig = buildTestSignature(tokenParams, sharedSecret.trim());

    const tokenRes = await fetchWithRetry(LASTFM_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenParams).toString()
    });
    
    let tokenJson = await tokenRes.json().catch(() => ({}));

    if (tokenJson.error) {
      return { status: 'error', error: tokenJson.message || `API error ${tokenJson.error}` };
    }
    
    const token = tokenJson.token;
    if (!token) return { status: 'error', error: 'Unexpected response from Last.fm' };

    // Step 2: Validate Shared Secret by generating a signature for auth.getSession
    const sessionParams: Record<string, string> = {
      method: 'auth.getSession',
      api_key: apiKey.trim(),
      token: token
    };
    sessionParams.api_sig = buildTestSignature(sessionParams, sharedSecret.trim());

    // Send as query parameters alongside format=json
    const sessionUrl = `${LASTFM_API}?method=auth.getSession&api_key=${encodeURIComponent(sessionParams.api_key)}&token=${encodeURIComponent(sessionParams.token)}&api_sig=${encodeURIComponent(sessionParams.api_sig)}&format=json`;

    const sessionRes = await fetchWithRetry(sessionUrl);
    let sessionJson = await sessionRes.json().catch(() => ({}));

    // Error 14 is "Unauthorized Token", which GUARANTEES the signature (and thus the Secret) was Valid!
    if (sessionJson.error === 14) {
      return { status: 'ok' };
    }

    // Error 13 is "Invalid signature", indicating wrong secretly
    if (sessionJson.error === 13) {
      return { status: 'error', error: 'Invalid Shared Secret (Signature Mismatch)' };
    }

    if (sessionJson.error) {
       return { status: 'error', error: sessionJson.message || `API error ${sessionJson.error}` };
    }

    // If it somehow succeeds completely (highly unlikely without browser auth)
    return { status: 'ok' };
  } catch (err: any) {
    return { status: 'error', error: err.message || 'Network error' };
  }
}
