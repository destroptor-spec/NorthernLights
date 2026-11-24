import { fanartTvThrottle, fetchWithRetry } from '../rateLimiter';
import { ProviderError, RateLimitError, messageWithCause } from '../errors';

// fanart.tv API v3 (music): looked up by MusicBrainz id only, never by name.
// A project API key is required; a personal (client) key is optional and gets
// newer images sooner. The response shapes below follow the v3 API as known;
// fanart.tv's docs site refuses automated reads, so they could not be checked
// against it.

const BASE = 'https://webservice.fanart.tv/v3/music';

export interface FanartImage {
  id?: string;
  url?: string;
  likes?: string;
  lang?: string;
}

export interface FanartArtist {
  name?: string;
  mbid_id?: string;
  artistthumb?: FanartImage[];
  artistbackground?: FanartImage[];
  albums?: Record<string, { albumcover?: FanartImage[]; cdart?: FanartImage[] }>;
}

// The admin's project API key only. fanart.tv also offers a personal key
// (client_key) that shows newly added images sooner; a personal key belongs to
// one fanart.tv user, so Aurora doesn't use one for the whole server.
async function fanartGet<T>(path: string, apiKey: string): Promise<T | null> {
  return fanartTvThrottle.run(async () => {
    const params = new URLSearchParams({ api_key: apiKey });
    const res = await fetchWithRetry(`${BASE}/${path}?${params.toString()}`, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return null; // nothing on fanart.tv for that id
    if (res.status === 429) throw new RateLimitError('fanarttv');
    if (res.status === 401 || res.status === 403) throw new ProviderError('fanarttv', `HTTP ${res.status} (is the API key right?)`, res.status);
    if (!res.ok) throw new ProviderError('fanarttv', `HTTP ${res.status}`, res.status);
    return res.json() as Promise<T>;
  }).catch((err: any) => {
    if (err instanceof RateLimitError || err instanceof ProviderError) throw err;
    throw new ProviderError('fanarttv', messageWithCause(err));
  });
}

export async function fanartArtist(mbid: string, apiKey: string): Promise<FanartArtist | null> {
  return fanartGet<FanartArtist>(encodeURIComponent(mbid), apiKey);
}

/** An album's images by MusicBrainz release-group id. */
export async function fanartAlbum(releaseGroupId: string, apiKey: string): Promise<FanartArtist | null> {
  return fanartGet<FanartArtist>(`albums/${encodeURIComponent(releaseGroupId)}`, apiKey);
}

/** The most-liked https image of a list, preferring English or language-free ones. */
export function bestFanartImage(images: FanartImage[] | undefined): string | undefined {
  if (!Array.isArray(images)) return undefined;
  const usable = images
    .map((image) => ({ image, url: typeof image?.url === 'string' ? image.url.replace(/^http:\/\//i, 'https://') : '' }))
    .filter(({ url }) => /^https:\/\/\S+$/.test(url));
  const langRank = (lang?: string) => (!lang || lang === 'en' || lang === '00' ? 0 : 1);
  usable.sort((a, b) =>
    langRank(a.image.lang) - langRank(b.image.lang) || Number(b.image.likes || 0) - Number(a.image.likes || 0));
  return usable[0]?.url;
}

/** Connection test: one well-known artist; 404 still proves the key works. */
export async function testFanartTv(apiKey: string): Promise<{ artist?: string }> {
  const artist = await fanartArtist('cc197bad-dc9c-440d-a5b5-d52ba2e14234', apiKey);
  return { artist: artist?.name };
}
