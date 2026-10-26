import { geniusThrottle, fetchWithRetry } from '../rateLimiter';
import { RateLimitError, ProviderError, messageWithCause } from '../errors';

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
      image_url?: string;
      header_image_url?: string;
      description?: { plain?: string };
    };
  };
}

export async function geniusSearch(
  query: string,
  apiKey: string
): Promise<GeniusSearchResult | null> {
  return geniusThrottle.run(async () => {
    const res = await fetchWithRetry(
      `https://api.genius.com/search?q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!res.ok) {
      console.warn(`[Genius] search failed for "${query}": HTTP ${res.status}`);
      if (res.status === 429) throw new RateLimitError('genius');
      throw new ProviderError('genius', `HTTP ${res.status}`, res.status);
    }
    return res.json();
  }).catch((err: any) => {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    console.error(`[Genius] search error for "${query}":`, err.message);
    throw new ProviderError('genius', messageWithCause(err));
  });
}

export interface GeniusSongCredit { role: string; name: string; geniusArtistId?: number }

// Fetches a Genius song's producer + writer credits. Genius exposes these
// as top-level arrays on the song JSON; we map producer → 'producer' and
// writer → 'writer'. Featured artists are intentionally NOT mapped here —
// those flow through Aurora's existing primary/featured artists path,
// not the role-credits join.
export async function geniusGetSong(
  songId: number | string,
  apiKey: string
): Promise<GeniusSongCredit[]> {
  return geniusThrottle.run(async () => {
    const res = await fetchWithRetry(
      `https://api.genius.com/songs/${songId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!res.ok) {
      console.warn(`[Genius] getSong failed for ID ${songId}: HTTP ${res.status}`);
      if (res.status === 429) throw new RateLimitError('genius');
      throw new ProviderError('genius', `HTTP ${res.status}`, res.status);
    }
    const json = await res.json();
    const song = json?.response?.song;
    if (!song) return [];
    const out: GeniusSongCredit[] = [];
    for (const p of (song.producer_artists || [])) {
      if (p?.name) out.push({ role: 'producer', name: p.name, geniusArtistId: p.id });
    }
    for (const w of (song.writer_artists || [])) {
      if (w?.name) out.push({ role: 'writer', name: w.name, geniusArtistId: w.id });
    }
    return out;
  }).catch((err: any) => {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    console.error(`[Genius] getSong error for ID ${songId}:`, err.message);
    throw new ProviderError('genius', messageWithCause(err));
  });
}

// Best-effort song-id resolver: takes "<title> <primary artist>" and
// returns the first Genius hit's id where the primary artist matches.
// Returns null when no plausible match is found.
export async function geniusResolveSongId(
  title: string,
  artistName: string,
  apiKey: string,
): Promise<number | null> {
  if (!title || !artistName) return null;
  const data = await geniusSearch(`${title} ${artistName}`, apiKey);
  const hits = data?.response?.hits || [];
  const wantArtist = artistName.trim().toLowerCase();
  for (const hit of hits) {
    if (hit.type !== 'song' || !hit.result) continue;
    const primary = (hit.result.primary_artist?.name || '').trim().toLowerCase();
    if (primary && (primary === wantArtist || primary.includes(wantArtist) || wantArtist.includes(primary))) {
      const id = (hit.result as any).id;
      if (typeof id === 'number') return id;
    }
  }
  // Fallback: accept the first song hit even if the primary artist match
  // is fuzzy. The producer/writer payload itself is the credible signal.
  const firstSong = hits.find(h => h.type === 'song' && h.result);
  return firstSong ? ((firstSong.result as any).id || null) : null;
}

export async function geniusGetArtist(
  artistId: number,
  apiKey: string
): Promise<GeniusArtist | null> {
  return geniusThrottle.run(async () => {
    const res = await fetchWithRetry(
      `https://api.genius.com/artists/${artistId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    if (!res.ok) {
      console.warn(`[Genius] getArtist failed for ID ${artistId}: HTTP ${res.status}`);
      if (res.status === 429) throw new RateLimitError('genius');
      throw new ProviderError('genius', `HTTP ${res.status}`, res.status);
    }
    return res.json();
  }).catch((err: any) => {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    console.error(`[Genius] getArtist error for ID ${artistId}:`, err.message);
    throw new ProviderError('genius', messageWithCause(err));
  });
}
