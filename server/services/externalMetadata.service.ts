import { getSystemSetting, initDB } from '../database';
import { mbFetch } from './musicbrainz.service';

// ─── Types ──────────────────────────────────────────────────────────
export interface ArtistData {
  imageUrl?: string;
  bio?: string;
  disambiguation?: string;
  area?: string;
  type?: string;
  lifeSpan?: { begin?: string; end?: string };
  links?: { url: string; type: string }[];
  genres?: string[];
}

export interface LyricsData {
  songUrl: string;
  title: string;
  artist: string;
  thumbnailUrl?: string;
}

interface ProviderSettings {
  lastFmApiKey: string;
  geniusApiKey: string;
  musicBrainzEnabled: boolean;
  providerArtistImage: string;
  providerArtistBio: string;
  providerAlbumArt: string;
}

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
const LASTFM_API = 'https://ws.audioscrobbler.com/2.0/';

// ─── Concurrency Limiting ──────────────────────────────────────────
class Semaphore {
  private tasks: Array<() => void> = [];
  private count: number;

  constructor(max: number) { this.count = max; }

  async acquire() {
    if (this.count > 0) {
      this.count--;
      return;
    }
    await new Promise<void>((resolve) => { 
      this.tasks.push(resolve); 
    });
  }

  release() {
    if (this.tasks.length > 0) {
      const fn = this.tasks.shift();
      if (fn) fn();
    } else {
      this.count++;
    }
  }
}

const externalRequestSemaphore = new Semaphore(5); // Max 5 parallel external API calls

// ─── Helpers ────────────────────────────────────────────────────────
function cleanHtml(text: string): string {
  // Strip HTML tags and decode basic entities
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

async function fetchWithRetry(url: string, options?: RequestInit, retries = 1): Promise<Response> {
  const res = await fetch(url, options);
  if (res.status === 429 && retries > 0) {
    const retryAfter = res.headers.get('Retry-After');
    const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000;
    await new Promise(r => setTimeout(r, Math.min(delay, 5000)));
    return fetchWithRetry(url, options, retries - 1);
  }
  return res;
}

async function getProviderSettings(): Promise<ProviderSettings> {
  return {
    lastFmApiKey: (await getSystemSetting('lastFmApiKey')) || '',
    geniusApiKey: (await getSystemSetting('geniusApiKey')) || '',
    musicBrainzEnabled: (await getSystemSetting('musicBrainzEnabled')) === true || (await getSystemSetting('musicBrainzEnabled')) === 'true',
    providerArtistImage: (await getSystemSetting('providerArtistImage')) || 'lastfm',
    providerArtistBio: (await getSystemSetting('providerArtistBio')) || 'lastfm',
    providerAlbumArt: (await getSystemSetting('providerAlbumArt')) || 'lastfm',
  };
}

function isCacheFresh(lastUpdated: number): boolean {
  if (!lastUpdated) return false;
  return (Date.now() - lastUpdated * 1000) < CACHE_TTL;
}

// ─── Database Cache ─────────────────────────────────────────────────
async function getCachedArtist(name: string): Promise<any | null> {
  const db = await initDB();
  const res = await db.query('SELECT * FROM artists WHERE name = $1', [name]);
  return res.rows[0] || null;
}

async function upsertArtistCache(name: string, imageUrl: string | null, bio: string | null, mbid: string | null): Promise<void> {
  const db = await initDB();
  const now = Math.floor(Date.now() / 1000);
  await db.query(
    `INSERT INTO artists (id, name, image_url, bio, mbid, last_updated)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     ON CONFLICT (name) DO UPDATE SET
       image_url = COALESCE($2, artists.image_url),
       bio = COALESCE($3, artists.bio),
       mbid = COALESCE($4, artists.mbid),
       last_updated = $5`,
    [name, imageUrl, bio, mbid, now]
  );
}

async function getCachedAlbum(title: string, artistName: string): Promise<any | null> {
  const db = await initDB();
  const res = await db.query('SELECT * FROM albums WHERE title = $1 AND artist_name = $2', [title, artistName]);
  return res.rows[0] || null;
}

async function upsertAlbumCache(title: string, artistName: string, imageUrl: string | null, mbid: string | null): Promise<void> {
  const db = await initDB();
  const now = Math.floor(Date.now() / 1000);
  await db.query(
    `INSERT INTO albums (id, title, artist_name, image_url, mbid, last_updated)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
     ON CONFLICT (title, artist_name) DO UPDATE SET
       image_url = COALESCE($3, albums.image_url),
       mbid = COALESCE($4, albums.mbid),
       last_updated = $5`,
    [title, artistName, imageUrl, mbid, now]
  );
}

async function getCachedGenre(name: string): Promise<any | null> {
  const db = await initDB();
  const res = await db.query('SELECT * FROM genres WHERE name = $1', [name]);
  return res.rows[0] || null;
}

async function upsertGenreCache(name: string, imageUrl: string | null, description: string | null): Promise<void> {
  const db = await initDB();
  const now = Math.floor(Date.now() / 1000);
  await db.query(
    `INSERT INTO genres (id, name, image_url, description, last_updated)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)
     ON CONFLICT (name) DO UPDATE SET
       image_url = COALESCE($2, genres.image_url),
       description = COALESCE($3, genres.description),
       last_updated = $4`,
    [name, imageUrl, description, now]
  );
}

// ─── Last.fm API (server-side reads) ────────────────────────────────
async function lastFmArtistInfo(artist: string, apiKey: string): Promise<any> {
  await externalRequestSemaphore.acquire();
  try {
    const res = await fetchWithRetry(
      `${LASTFM_API}?method=artist.getinfo&artist=${encodeURIComponent(artist)}&api_key=${apiKey}&format=json`
    );
    if (!res.ok) {
      console.warn(`[ExternalMeta] Last.fm artist.getinfo failed for "${artist}": HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    if (json.error) {
      console.warn(`[ExternalMeta] Last.fm API error for "${artist}": ${json.message} (code ${json.error})`);
      if (json.error === 29) return { _isRateLimited: true };
      return null;
    }
    return json.artist || null;
  } catch (err: any) {
    console.error(`[ExternalMeta] Last.fm fetch error for "${artist}":`, err.message);
    return null;
  } finally {
    externalRequestSemaphore.release();
  }
}

async function lastFmAlbumInfo(album: string, artist: string, apiKey: string): Promise<any> {
  await externalRequestSemaphore.acquire();
  try {
    const res = await fetchWithRetry(
      `${LASTFM_API}?method=album.getinfo&api_key=${apiKey}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}&format=json`
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (json.error === 29) return { _isRateLimited: true };
    if (json.error) return null;
    return json.album || null;
  } catch { return null; }
  finally { externalRequestSemaphore.release(); }
}

async function lastFmTagTopAlbums(tag: string, apiKey: string): Promise<any> {
  await externalRequestSemaphore.acquire();
  try {
    const res = await fetchWithRetry(
      `${LASTFM_API}?method=tag.gettopalbums&tag=${encodeURIComponent(tag)}&api_key=${apiKey}&format=json&limit=1`
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (json.error === 29) return { _isRateLimited: true };
    if (json.error) return null;
    return json.albums || null;
  } catch { return null; }
  finally { externalRequestSemaphore.release(); }
}

async function lastFmTagInfo(tag: string, apiKey: string): Promise<any> {
  await externalRequestSemaphore.acquire();
  try {
    const res = await fetchWithRetry(
      `${LASTFM_API}?method=tag.getinfo&tag=${encodeURIComponent(tag)}&api_key=${apiKey}&format=json`
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (json.error === 29) return { _isRateLimited: true };
    if (json.error) return null;
    return json.tag || null;
  } catch { return null; }
  finally { externalRequestSemaphore.release(); }
}

function extractLastFmImage(images: any[]): string | undefined {
  if (!Array.isArray(images)) return undefined;
  const largeImg = images.find((i: any) => i.size === 'mega' || i.size === 'extralarge' || i.size === 'large');
  if (largeImg && largeImg['#text'] && !largeImg['#text'].includes('2a96cbd8b46e442fc41c2b86b821562f')) {
    return largeImg['#text'];
  }
  return undefined;
}

// ─── Genius API (server-side) ───────────────────────────────────────
async function geniusSearch(query: string, apiKey: string): Promise<any> {
  await externalRequestSemaphore.acquire();
  try {
    const res = await fetchWithRetry(`https://api.genius.com/search?q=${encodeURIComponent(query)}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!res.ok) {
      console.warn(`[ExternalMeta] Genius search failed for "${query}": HTTP ${res.status}`);
      return null;
    }
    return res.json();
  } catch (err: any) {
    console.error(`[ExternalMeta] Genius search error for "${query}":`, err.message);
    return null;
  } finally {
    externalRequestSemaphore.release();
  }
}

async function geniusGetArtist(artistId: number, apiKey: string): Promise<any> {
  await externalRequestSemaphore.acquire();
  try {
    const res = await fetchWithRetry(`https://api.genius.com/artists/${artistId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!res.ok) {
      console.warn(`[ExternalMeta] Genius getArtist failed for ID ${artistId}: HTTP ${res.status}`);
      return null;
    }
    return res.json();
  } catch (err: any) {
    console.error(`[ExternalMeta] Genius getArtist error for ID ${artistId}:`, err.message);
    return null;
  } finally {
    externalRequestSemaphore.release();
  }
}

// ─── MusicBrainz helpers ────────────────────────────────────────────
function extractMbLinks(relations: any[]): { url: string; type: string }[] {
  if (!Array.isArray(relations)) return [];
  return relations
    .filter((r: any) => r.target_type === 'url' && r.url?.resource)
    .map((r: any) => ({
      url: r.url.resource,
      type: r.type || 'other'
    }));
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Fetch artist data (image, bio, MusicBrainz metadata).
 * Checks DB cache first, falls back to external APIs.
 */
export async function getArtistData(name: string, mbArtistId?: string | null): Promise<ArtistData> {
  if (!name) return {};

  const settings = await getProviderSettings();
  const cached = await getCachedArtist(name);

  // If cache is fresh and has data, return it
  if (cached && isCacheFresh(cached.last_updated)) {
    if (cached.image_url || cached.bio) {
      return {
        imageUrl: cached.image_url || undefined,
        bio: cached.bio || undefined,
      };
    }
  }

  let data: ArtistData = {};

  // MusicBrainz structured metadata (if we have an MBID)
  if (settings.musicBrainzEnabled && (mbArtistId || cached?.mbid)) {
    const mbid = mbArtistId || cached?.mbid;
    if (mbid) {
      try {
        const mbArtist = await mbFetch(`https://musicbrainz.org/ws/2/artist/${mbid}?inc=url-rels+tags+genres+ratings&fmt=json`);
        if (mbArtist) {
          data.disambiguation = mbArtist.disambiguation || undefined;
          data.area = mbArtist.area?.name || undefined;
          data.type = mbArtist.type || undefined;
          if (mbArtist['life-span']) {
            data.lifeSpan = {
              begin: mbArtist['life-span'].begin || undefined,
              end: mbArtist['life-span'].ended ? mbArtist['life-span'].end || undefined : undefined
            };
          }
          data.links = extractMbLinks(mbArtist.relations);
          if (Array.isArray(mbArtist.genres) && mbArtist.genres.length > 0) {
            data.genres = mbArtist.genres.map((g: any) => g.name);
          }
        }
      } catch (e) {
        console.warn('[ExternalMeta] MusicBrainz artist lookup failed:', e);
      }
    }
  }

  // Build provider priority order for image + bio based on dropdown settings
  const seen = new Set<string>();
  const apisToTry: string[] = [];
  const pushApi = (api: string) => {
    if (!seen.has(api)) { seen.add(api); apisToTry.push(api); }
  };
  
  // Add providers in dropdown preference order
  const imgProvider = settings.providerArtistImage;
  const bioProvider = settings.providerArtistBio;
  
  if (imgProvider === 'genius' && settings.geniusApiKey) pushApi('genius');
  if (imgProvider === 'lastfm' && settings.lastFmApiKey) pushApi('lastfm');
  if (bioProvider === 'genius' && settings.geniusApiKey) pushApi('genius');
  if (bioProvider === 'lastfm' && settings.lastFmApiKey) pushApi('lastfm');
  
  // Fallback: if selected provider has no key, try the other
  if (imgProvider === 'lastfm' && !settings.lastFmApiKey && settings.geniusApiKey) pushApi('genius');
  if (imgProvider === 'genius' && !settings.geniusApiKey && settings.lastFmApiKey) pushApi('lastfm');
  if (bioProvider === 'lastfm' && !settings.lastFmApiKey && settings.geniusApiKey) pushApi('genius');
  if (bioProvider === 'genius' && !settings.geniusApiKey && settings.lastFmApiKey) pushApi('lastfm');

  let wasRateLimited = false;
  for (const api of apisToTry) {
    try {
      if (api === 'genius' && settings.geniusApiKey) {
        const json = await geniusSearch(name, settings.geniusApiKey);
        if (json) {
          const hits = json.response?.hits;
          if (hits && hits.length > 0) {
            // Priority 1: Exact artist name match on primary artist
            let match = hits.find((h: any) => 
               h.type === 'song' && 
               h.result?.primary_artist?.name?.toLowerCase() === name.toLowerCase()
            );
            
            // Priority 2: Case-insensitive "contains" match
            if (!match) {
              match = hits.find((h: any) => 
                h.type === 'song' && 
                h.result?.primary_artist?.name?.toLowerCase().includes(name.toLowerCase())
              );
            }
            
            // Priority 3: Just use the first hit
            if (!match) match = hits[0];

            const artistId = match?.result?.primary_artist?.id;
            const imageUrl = match?.result?.primary_artist?.image_url;

            if (imageUrl && !data.imageUrl && !imageUrl.includes('default_cover_image.png')) {
              data.imageUrl = imageUrl;
            }

            if (artistId && !data.bio) {
              const artistJson = await geniusGetArtist(artistId, settings.geniusApiKey);
              if (artistJson) {
                const bioPlain = artistJson.response?.artist?.description?.plain;
                if (typeof bioPlain === 'string' && bioPlain.trim().length > 0 && bioPlain !== '?') {
                  data.bio = bioPlain;
                }
              }
            }
          }
        }
      } else if (api === 'lastfm' && settings.lastFmApiKey) {
        const artist = await lastFmArtistInfo(name, settings.lastFmApiKey);
        if (artist) {
          if (artist._isRateLimited) {
            wasRateLimited = true;
            continue;
          }
          if (!data.bio && artist.bio?.summary) {
            const rawBio = artist.bio.summary;
            data.bio = cleanHtml(rawBio.split('<a href')[0].trim());
          }
          if (!data.imageUrl && artist.image) {
            const imageUrl = extractLastFmImage(artist.image);
            if (imageUrl) data.imageUrl = imageUrl;
          }
        }
      }
      if (data.imageUrl && data.bio) break;
    } catch (e) {
      console.warn(`[ExternalMeta] Failed fetching from ${api}:`, e);
    }
  }

  // Upsert into DB cache ONLY if we weren't rate limited OR we found actual data
  if (!wasRateLimited || data.imageUrl || data.bio) {
    await upsertArtistCache(name, data.imageUrl || null, data.bio || null, mbArtistId || cached?.mbid || null);
  }

  return data;
}

/**
 * Fetch album art. Checks DB cache, falls back to external APIs.
 */
export async function getAlbumImage(albumName: string, artistName: string, mbAlbumId?: string | null): Promise<string | undefined> {
  if (!albumName || !artistName) return undefined;

  const settings = await getProviderSettings();
  const cached = await getCachedAlbum(albumName, artistName);

  // Fresh cache hit with an image
  if (cached && isCacheFresh(cached.last_updated) && cached.image_url) {
    return cached.image_url;
  }

  // Try Cover Art Archive via MusicBrainz MBID
  if (settings.musicBrainzEnabled && (mbAlbumId || cached?.mbid)) {
    const mbid = mbAlbumId || cached?.mbid;
    if (mbid) {
      try {
        const coverUrl = `https://coverartarchive.org/release/${mbid}/front-500`;
        const coverRes = await fetchWithRetry(coverUrl, { method: 'HEAD' });
        if (coverRes.ok) {
          await upsertAlbumCache(albumName, artistName, coverUrl, mbid);
          return coverUrl;
        }
      } catch { /* fall through */ }
    }
  }

  // Try Cover Art Archive via text search if MusicBrainz is preferred
  if (settings.musicBrainzEnabled && settings.providerAlbumArt === 'musicbrainz' && !mbAlbumId) {
    try {
      const searchQuery = `${artistName} ${albumName}`;
      const mbResult = await mbFetch(`https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(searchQuery)}&limit=5&fmt=json`);
      const hits = mbResult?.['release-groups'];
      if (hits && hits.length > 0) {
        const match = hits.find((h: any) =>
          h.title?.toLowerCase() === albumName.toLowerCase() &&
          h['artist-credit']?.some((ac: any) => ac.name?.toLowerCase() === artistName.toLowerCase())
        ) || hits[0];
        if (match?.id) {
          const rgRes = await fetchWithRetry(`https://musicbrainz.org/ws/2/release-group/${match.id}?inc=releases&fmt=json`);
          if (rgRes.ok) {
            const rgJson = await rgRes.json();
            const releases = rgJson.releases || [];
            for (const release of releases.slice(0, 3)) {
              try {
                const coverUrl = `https://coverartarchive.org/release/${release.id}/front-500`;
                const headRes = await fetchWithRetry(coverUrl, { method: 'HEAD' });
                if (headRes.ok) {
                  await upsertAlbumCache(albumName, artistName, coverUrl, match.id);
                  return coverUrl;
                }
              } catch { /* continue */ }
            }
          }
        }
      }
    } catch { /* fall through */ }
  }

  // Try providers in dropdown preference order
  const apisToTry: string[] = [];
  const pushApi = (api: string) => { if (!apisToTry.includes(api)) apisToTry.push(api); };
  const albumProvider = settings.providerAlbumArt;
  
  if (albumProvider === 'genius' && settings.geniusApiKey) pushApi('genius');
  if (albumProvider === 'lastfm' && settings.lastFmApiKey) pushApi('lastfm');
  if (albumProvider === 'musicbrainz' && settings.musicBrainzEnabled) pushApi('musicbrainz');
  
  // Fallback to other providers if selected one has no key
  if (albumProvider === 'lastfm' && !settings.lastFmApiKey && settings.geniusApiKey) pushApi('genius');
  if (albumProvider === 'genius' && !settings.geniusApiKey && settings.lastFmApiKey) pushApi('lastfm');
  if (albumProvider === 'musicbrainz' && !settings.musicBrainzEnabled) {
    if (settings.lastFmApiKey) pushApi('lastfm');
    if (settings.geniusApiKey) pushApi('genius');
  }

  let wasRateLimited = false;
  for (const api of apisToTry) {
    try {
      if (api === 'lastfm' && settings.lastFmApiKey) {
        const album = await lastFmAlbumInfo(albumName, artistName, settings.lastFmApiKey);
        if (album) {
          if (album._isRateLimited) {
            wasRateLimited = true;
            continue;
          }
          if (album.image) {
            const imageUrl = extractLastFmImage(album.image);
            if (imageUrl) {
              await upsertAlbumCache(albumName, artistName, imageUrl, null);
              return imageUrl;
            }
          }
        }
      } else if (api === 'genius' && settings.geniusApiKey) {
        const query = `${artistName} ${albumName}`;
        const json = await geniusSearch(query, settings.geniusApiKey);
        if (json) {
          const hits = json.response?.hits;
          if (hits && hits.length > 0) {
            const songHit = hits.find((h: any) => h.type === 'song');
            const imageUrl = songHit?.result?.song_art_image_url || songHit?.result?.header_image_url;
            if (imageUrl && !imageUrl.includes('default_cover_image.png')) {
              await upsertAlbumCache(albumName, artistName, imageUrl, null);
              return imageUrl;
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[ExternalMeta] Failed fetching album image from ${api}:`, e);
    }
  }

  // Cache the miss ONLY if we weren't rate limited
  if (!wasRateLimited) {
    await upsertAlbumCache(albumName, artistName, null, null);
  }
  return undefined;
}

/**
 * Fetch genre representative image from Last.fm.
 */
export async function getGenreImage(genreName: string): Promise<string | undefined> {
  if (!genreName) return undefined;

  const cached = await getCachedGenre(genreName);
  if (cached && isCacheFresh(cached.last_updated) && cached.image_url) {
    return cached.image_url;
  }

  const apiKey = (await getSystemSetting('lastFmApiKey')) || '';
  if (!apiKey) return undefined;

  try {
    const albums = await lastFmTagTopAlbums(genreName, apiKey);
    if (albums) {
      if (albums._isRateLimited) return undefined;
      if (albums.album && albums.album.length > 0) {
        const imageUrl = extractLastFmImage(albums.album[0].image);
        if (imageUrl) {
          await upsertGenreCache(genreName, imageUrl, cached?.description || null);
          return imageUrl;
        }
      }
    }
  } catch (e) {
    console.warn('[ExternalMeta] Failed fetching genre image:', e);
  }

  return undefined;
}

/**
 * Fetch genre info (description) from Last.fm.
 */
export async function getGenreInfo(genreName: string): Promise<{ imageUrl?: string; summary?: string } | undefined> {
  if (!genreName) return undefined;

  const cached = await getCachedGenre(genreName);
  if (cached && isCacheFresh(cached.last_updated) && (cached.description || cached.image_url)) {
    return {
      imageUrl: cached.image_url || undefined,
      summary: cached.description || undefined,
    };
  }

  const apiKey = (await getSystemSetting('lastFmApiKey')) || '';
  if (!apiKey) return undefined;

  try {
    const tag = await lastFmTagInfo(genreName, apiKey);
    if (tag?._isRateLimited) return undefined;
    const summary = tag?.wiki?.summary ? cleanHtml(tag.wiki.summary.split('<a href')[0].trim()) : undefined;
    const result: { imageUrl?: string; summary?: string } = {};
    if (summary && summary.length > 0) result.summary = summary;

    await upsertGenreCache(genreName, cached?.image_url || null, result.summary || null);
    return result.summary ? result : undefined;
  } catch (e) {
    console.warn('[ExternalMeta] Failed fetching genre info:', e);
  }

  return undefined;
}

/**
 * Fetch lyrics link from Genius.
 */
export async function getLyrics(trackName: string, artistName: string): Promise<LyricsData | undefined> {
  if (!trackName || !artistName) return undefined;

  const apiKey = (await getSystemSetting('geniusApiKey')) || '';
  if (!apiKey) return undefined;

  try {
    const query = `${artistName} ${trackName}`;
    const json = await geniusSearch(query, apiKey);
    if (!json) return undefined;

    const hits = json.response?.hits;
    if (!hits || hits.length === 0) return undefined;

    const artistLower = artistName.toLowerCase();
    const titleLower = trackName.toLowerCase();
    const exactHit = hits.find((h: any) =>
      h.type === 'song' &&
      h.result.primary_artist?.name?.toLowerCase().includes(artistLower) &&
      h.result.title?.toLowerCase().includes(titleLower)
    );
    const songHit = exactHit || hits.find((h: any) => h.type === 'song');
    if (!songHit) return undefined;

    const song = songHit.result;
    const thumbnailUrl = song.song_art_image_thumbnail_url;
    return {
      songUrl: song.url,
      title: song.title || trackName,
      artist: song.primary_artist?.name || artistName,
      thumbnailUrl: thumbnailUrl?.includes('default_cover_image.png') ? undefined : thumbnailUrl,
    };
  } catch (e) {
    console.warn('[ExternalMeta] Failed fetching lyrics:', e);
    return undefined;
  }
}

/**
 * Test Last.fm connection by fetching artist info.
 */
export async function testLastFm(): Promise<{ status: string; error?: string; username?: string }> {
  try {
    const apiKey = (await getSystemSetting('lastFmApiKey')) || '';
    const sharedSecret = (await getSystemSetting('lastFmSharedSecret')) || '';
    
    if (!apiKey) return { status: 'error', error: 'No API key configured' };
    if (!sharedSecret) return { status: 'error', error: 'No Shared Secret configured' };

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

/**
 * Clear all external metadata cache (force re-fetch on next access).
 */
export async function clearExternalCache(): Promise<void> {
  const db = await initDB();
  const now = 0;
  await db.query('UPDATE artists SET last_updated = 0 WHERE last_updated > 0');
  await db.query('UPDATE albums SET last_updated = 0 WHERE last_updated > 0');
  await db.query('UPDATE genres SET last_updated = 0 WHERE last_updated > 0');
}
