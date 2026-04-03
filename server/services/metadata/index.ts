import { getSystemSetting } from '../../database';
import { RateLimitError, ProviderError, isRateLimitError, isProviderError } from './errors';
import {
  getCachedArtist,
  getCachedAlbum,
  getCachedGenre,
  upsertArtistCache,
  upsertAlbumCache,
  upsertGenreCache,
  clearExternalCache,
  isCacheFresh,
} from './cache';
import {
  lastFmArtistInfo,
  lastFmAlbumInfo,
  lastFmTagTopAlbums,
  lastFmTagInfo,
  extractLastFmImage,
  testLastFm,
} from './providers/lastfm';
import { geniusSearch, geniusGetArtist } from './providers/genius';
import { extractMbLinks, mbGetArtist, mbGetAlbumCover, mbSearchReleaseGroup } from './providers/musicbrainz';

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
  error?: string;
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

// ─── Helpers ────────────────────────────────────────────────────────
function cleanHtml(text: string): string {
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

async function getProviderSettings(): Promise<ProviderSettings> {
  return {
    lastFmApiKey: (await getSystemSetting('lastFmApiKey')) || '',
    geniusApiKey: (await getSystemSetting('geniusApiKey')) || '',
    musicBrainzEnabled:
      (await getSystemSetting('musicBrainzEnabled')) === true ||
      (await getSystemSetting('musicBrainzEnabled')) === 'true',
    providerArtistImage: (await getSystemSetting('providerArtistImage')) || 'lastfm',
    providerArtistBio: (await getSystemSetting('providerArtistBio')) || 'lastfm',
    providerAlbumArt: (await getSystemSetting('providerAlbumArt')) || 'lastfm',
  };
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Fetch artist data (image, bio, MusicBrainz metadata).
 * Checks DB cache first, falls back to external APIs.
 */
export async function getArtistData(
  name: string,
  mbArtistId?: string | null
): Promise<ArtistData> {
  if (!name) return {};

  const settings = await getProviderSettings();
  const cached = await getCachedArtist(name);

  if (cached && isCacheFresh(cached.last_updated)) {
    if (cached.image_url || cached.bio) {
      return {
        imageUrl: cached.image_url || undefined,
        bio: cached.bio || undefined,
      };
    }
  }

  let data: ArtistData = {};

  if (settings.musicBrainzEnabled && (mbArtistId || cached?.mbid)) {
    const mbid = mbArtistId || cached?.mbid;
    if (mbid) {
      try {
        const mbArtist = await mbGetArtist(mbid);
        if (mbArtist) {
          data.disambiguation = mbArtist.disambiguation || undefined;
          data.area = mbArtist.area?.name || undefined;
          data.type = mbArtist.type || undefined;
          if (mbArtist['life-span']) {
            data.lifeSpan = {
              begin: mbArtist['life-span'].begin || undefined,
              end: mbArtist['life-span'].ended
                ? mbArtist['life-span'].end || undefined
                : undefined,
            };
          }
          data.links = extractMbLinks(mbArtist.relations || []);
          if (Array.isArray(mbArtist.genres) && mbArtist.genres.length > 0) {
            data.genres = mbArtist.genres.map((g: any) => g.name);
          }
        }
      } catch (e) {
        console.warn('[Metadata] MusicBrainz artist lookup failed:', e);
      }
    }
  }

  const seen = new Set<string>();
  const apisToTry: string[] = [];
  const pushApi = (api: string) => {
    if (!seen.has(api)) {
      seen.add(api);
      apisToTry.push(api);
    }
  };

  const imgProvider = settings.providerArtistImage;
  const bioProvider = settings.providerArtistBio;

  if (imgProvider === 'genius' && settings.geniusApiKey) pushApi('genius');
  if (imgProvider === 'lastfm' && settings.lastFmApiKey) pushApi('lastfm');
  if (bioProvider === 'genius' && settings.geniusApiKey) pushApi('genius');
  if (bioProvider === 'lastfm' && settings.lastFmApiKey) pushApi('lastfm');

  if (imgProvider === 'lastfm' && !settings.lastFmApiKey && settings.geniusApiKey)
    pushApi('genius');
  if (imgProvider === 'genius' && !settings.geniusApiKey && settings.lastFmApiKey)
    pushApi('lastfm');
  if (bioProvider === 'lastfm' && !settings.lastFmApiKey && settings.geniusApiKey)
    pushApi('genius');
  if (bioProvider === 'genius' && !settings.geniusApiKey && settings.lastFmApiKey)
    pushApi('lastfm');

  let wasRateLimited = false;
  let lastError: string | undefined;

  for (const api of apisToTry) {
    try {
      if (api === 'genius' && settings.geniusApiKey) {
        const json = await geniusSearch(name, settings.geniusApiKey);
        if (json) {
          const hits = json.response?.hits;
          if (hits && hits.length > 0) {
            let match = hits.find(
              (h: any) =>
                h.type === 'song' &&
                h.result?.primary_artist?.name?.toLowerCase() === name.toLowerCase()
            );

            if (!match) {
              match = hits.find(
                (h: any) =>
                  h.type === 'song' &&
                  h.result?.primary_artist?.name
                    ?.toLowerCase()
                    .includes(name.toLowerCase())
              );
            }

            if (!match) match = hits[0];

            const artistId = match?.result?.primary_artist?.id;
            const imageUrl = match?.result?.primary_artist?.image_url;

            if (
              imageUrl &&
              !data.imageUrl &&
              !imageUrl.includes('default_cover_image.png')
            ) {
              data.imageUrl = imageUrl;
            }

            if (artistId && !data.bio) {
              const artistJson = await geniusGetArtist(
                artistId,
                settings.geniusApiKey
              );
              if (artistJson) {
                const bioPlain =
                  artistJson.response?.artist?.description?.plain;
                if (
                  typeof bioPlain === 'string' &&
                  bioPlain.trim().length > 0 &&
                  bioPlain !== '?'
                ) {
                  data.bio = bioPlain;
                }
              }
            }
          }
        }
      } else if (api === 'lastfm' && settings.lastFmApiKey) {
        try {
          const artist = await lastFmArtistInfo(name, settings.lastFmApiKey);
          if (artist) {
            if (!data.bio && artist.bio?.summary) {
              const rawBio = artist.bio.summary;
              data.bio = cleanHtml(rawBio.split('<a href')[0].trim());
            }
            if (!data.imageUrl && artist.image) {
              const imageUrl = extractLastFmImage(artist.image);
              if (imageUrl) data.imageUrl = imageUrl;
            }
          }
        } catch (err) {
          if (isRateLimitError(err)) {
            wasRateLimited = true;
            lastError = 'Rate limited by Last.fm';
            continue;
          }
          if (isProviderError(err)) {
            lastError = `${err.provider}: ${err.message}`;
          }
          throw err;
        }
      }
      if (data.imageUrl && data.bio) break;
    } catch (e) {
      console.warn(`[Metadata] Failed fetching from ${api}:`, e);
    }
  }

  if (!wasRateLimited || data.imageUrl || data.bio) {
    await upsertArtistCache(
      name,
      data.imageUrl || null,
      data.bio || null,
      mbArtistId || cached?.mbid || null,
      !wasRateLimited
    );
  }

  if (lastError && !data.imageUrl && !data.bio) {
    data.error = lastError;
  }

  return data;
}

/**
 * Fetch album art. Checks DB cache, falls back to external APIs.
 */
export async function getAlbumImage(
  albumName: string,
  artistName: string,
  mbAlbumId?: string | null
): Promise<string | undefined> {
  if (!albumName || !artistName) return undefined;

  const settings = await getProviderSettings();
  const cached = await getCachedAlbum(albumName, artistName);

  if (
    cached &&
    isCacheFresh(cached.last_updated) &&
    cached.image_url
  ) {
    return cached.image_url;
  }

  if (settings.musicBrainzEnabled && (mbAlbumId || cached?.mbid)) {
    const mbid = mbAlbumId || cached?.mbid;
    if (mbid) {
      try {
        const coverUrl = `https://coverartarchive.org/release/${mbid}/front-500`;
        const coverRes = await fetch(coverUrl, { method: 'HEAD' });
        if (coverRes.ok) {
          await upsertAlbumCache(albumName, artistName, coverUrl, mbid);
          return coverUrl;
        }
      } catch {
        /* fall through */
      }
    }
  }

  if (
    settings.musicBrainzEnabled &&
    settings.providerAlbumArt === 'musicbrainz' &&
    !mbAlbumId
  ) {
    try {
      const searchQuery = `${artistName} ${albumName}`;
      const mbResult = await mbSearchReleaseGroup(searchQuery);
      const hits = mbResult;
      if (hits && hits.length > 0) {
        const match =
          hits.find(
            (h: any) =>
              h.title?.toLowerCase() === albumName.toLowerCase()
          ) || hits[0];
        if (match?.id) {
          const coverUrl = await mbGetAlbumCover(match.id);
          if (coverUrl) {
            await upsertAlbumCache(albumName, artistName, coverUrl, match.id);
            return coverUrl;
          }
        }
      }
    } catch {
      /* fall through */
    }
  }

  const apisToTry: string[] = [];
  const pushApi = (api: string) => {
    if (!apisToTry.includes(api)) apisToTry.push(api);
  };
  const albumProvider = settings.providerAlbumArt;

  if (albumProvider === 'genius' && settings.geniusApiKey) pushApi('genius');
  if (albumProvider === 'lastfm' && settings.lastFmApiKey) pushApi('lastfm');
  if (albumProvider === 'musicbrainz' && settings.musicBrainzEnabled)
    pushApi('musicbrainz');

  if (albumProvider === 'lastfm' && !settings.lastFmApiKey && settings.geniusApiKey)
    pushApi('genius');
  if (albumProvider === 'genius' && !settings.geniusApiKey && settings.lastFmApiKey)
    pushApi('lastfm');
  if (albumProvider === 'musicbrainz' && !settings.musicBrainzEnabled) {
    if (settings.lastFmApiKey) pushApi('lastfm');
    if (settings.geniusApiKey) pushApi('genius');
  }

  let wasRateLimited = false;

  for (const api of apisToTry) {
    try {
      if (api === 'lastfm' && settings.lastFmApiKey) {
        try {
          const album = await lastFmAlbumInfo(
            albumName,
            artistName,
            settings.lastFmApiKey
          );
          if (album) {
            if (album.image) {
              const imageUrl = extractLastFmImage(album.image);
              if (imageUrl) {
                await upsertAlbumCache(albumName, artistName, imageUrl, null);
                return imageUrl;
              }
            }
          }
        } catch (err) {
          if (isRateLimitError(err)) {
            wasRateLimited = true;
            continue;
          }
          throw err;
        }
      } else if (api === 'genius' && settings.geniusApiKey) {
        const query = `${artistName} ${albumName}`;
        const json = await geniusSearch(query, settings.geniusApiKey);
        if (json) {
          const hits = json.response?.hits;
          if (hits && hits.length > 0) {
            const songHit = hits.find((h: any) => h.type === 'song');
            const imageUrl =
              songHit?.result?.song_art_image_url ||
              songHit?.result?.header_image_url;
            if (imageUrl && !imageUrl.includes('default_cover_image.png')) {
              await upsertAlbumCache(albumName, artistName, imageUrl, null);
              return imageUrl;
            }
          }
        }
      }
    } catch (e) {
      console.warn(`[Metadata] Failed fetching album image from ${api}:`, e);
    }
  }

  if (!wasRateLimited) {
    await upsertAlbumCache(albumName, artistName, null, null);
  }
  return undefined;
}

/**
 * Fetch genre representative image from Last.fm.
 */
export async function getGenreImage(
  genreName: string
): Promise<string | undefined> {
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
      if (albums.album && albums.album.length > 0) {
        const imageUrl = extractLastFmImage(albums.album[0].image);
        if (imageUrl) {
          await upsertGenreCache(
            genreName,
            imageUrl,
            cached?.description || null
          );
          return imageUrl;
        }
      }
    }
  } catch (e) {
    console.warn('[Metadata] Failed fetching genre image:', e);
  }

  return undefined;
}

/**
 * Fetch genre info (description) from Last.fm.
 */
export async function getGenreInfo(
  genreName: string
): Promise<{ imageUrl?: string; summary?: string } | undefined> {
  if (!genreName) return undefined;

  const cached = await getCachedGenre(genreName);
  if (
    cached &&
    isCacheFresh(cached.last_updated) &&
    (cached.description || cached.image_url)
  ) {
    return {
      imageUrl: cached.image_url || undefined,
      summary: cached.description || undefined,
    };
  }

  const apiKey = (await getSystemSetting('lastFmApiKey')) || '';
  if (!apiKey) return undefined;

  try {
    const tag = await lastFmTagInfo(genreName, apiKey);
    const summary = tag?.wiki?.summary
      ? cleanHtml(tag.wiki.summary.split('<a href')[0].trim())
      : undefined;
    const result: { imageUrl?: string; summary?: string } = {};
    if (summary && summary.length > 0) result.summary = summary;

    await upsertGenreCache(
      genreName,
      cached?.image_url || null,
      result.summary || null
    );
    return result.summary ? result : undefined;
  } catch (e) {
    console.warn('[Metadata] Failed fetching genre info:', e);
  }

  return undefined;
}

/**
 * Fetch lyrics link from Genius.
 */
export async function getLyrics(
  trackName: string,
  artistName: string
): Promise<LyricsData | undefined> {
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
    const exactHit = hits.find(
      (h: any) =>
        h.type === 'song' &&
        h.result.primary_artist?.name?.toLowerCase().includes(artistLower) &&
        h.result.title?.toLowerCase().includes(titleLower)
    );
    const songHit = exactHit || hits.find((h: any) => h.type === 'song');
    if (!songHit?.result) return undefined;

    const song = songHit.result;
    const thumbnailUrl = (song as any).song_art_image_thumbnail_url;
    return {
      songUrl: song.url || '',
      title: song.title || trackName,
      artist: song.primary_artist?.name || artistName,
      thumbnailUrl: thumbnailUrl?.includes('default_cover_image.png')
        ? undefined
        : thumbnailUrl,
    };
  } catch (e) {
    console.warn('[Metadata] Failed fetching lyrics:', e);
    return undefined;
  }
}

/**
 * Test Last.fm connection.
 */
export { testLastFm };

/**
 * Clear all external metadata cache.
 */
export { clearExternalCache };

// Re-export for convenience
export { RateLimitError, ProviderError, isRateLimitError, isProviderError } from './errors';
