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
  type ArtistCacheExtras,
  type AlbumCacheExtras,
} from './cache';
import {
  lastFmArtistInfo,
  lastFmAlbumInfo,
  lastFmArtistTopTags,
  lastFmArtistTopTracks,
  lastFmTagTopAlbums,
  lastFmTagInfo,
  extractLastFmImage,
  testLastFm,
} from './providers/lastfm';
import { geniusSearch, geniusGetArtist } from './providers/genius';
import { extractMbLinks, extractMbMembers, mbGetArtist, mbGetAlbumCover, mbSearchReleaseGroup } from './providers/musicbrainz';

// ─── Types ──────────────────────────────────────────────────────────
export interface ArtistData {
  imageUrl?: string;
  artworkUrl?: string;
  bio?: string;
  disambiguation?: string;
  area?: string;
  type?: string;
  lifeSpan?: { begin?: string; end?: string };
  links?: { url: string; type: string }[];
  genres?: string[];
  communityTags?: CommunityTag[];
  listeners?: string;
  members?: string[];
  error?: string;
}

export interface CommunityTag {
  name: string;
  count: number;
  providers: Array<'lastfm' | 'musicbrainz'>;
}

export interface ArtistTopTrack {
  name: string;
  playcount?: string;
  listeners?: string;
  mbid?: string;
  url?: string;
}

export interface AlbumData {
  imageUrl?: string;
  description?: string;
  tags?: string[];
  listeners?: string;
  playcount?: string;
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
  providerArtistArtwork: string;
  providerArtistBio: string;
  providerAlbumArt: string;
}

// ─── Helpers ────────────────────────────────────────────────────────
const MUSICBRAINZ_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMusicBrainzUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && MUSICBRAINZ_UUID_RE.test(value);
}

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

function addCommunityTag(
  tagMap: Map<string, CommunityTag>,
  rawName: unknown,
  rawCount: unknown,
  provider: 'lastfm' | 'musicbrainz'
) {
  if (typeof rawName !== 'string') return;
  const name = rawName.trim();
  if (!name) return;

  const key = name.toLowerCase();
  const parsedCount = typeof rawCount === 'number'
    ? rawCount
    : typeof rawCount === 'string'
      ? parseInt(rawCount, 10)
      : 0;
  const count = Number.isFinite(parsedCount) ? parsedCount : 0;

  const existing = tagMap.get(key);
  if (existing) {
    existing.count += count;
    if (!existing.providers.includes(provider)) existing.providers.push(provider);
    return;
  }

  tagMap.set(key, { name, count, providers: [provider] });
}

function sortedCommunityTags(tagMap: Map<string, CommunityTag>): CommunityTag[] | undefined {
  const tags = Array.from(tagMap.values())
    .sort((a, b) => b.count - a.count || b.providers.length - a.providers.length || a.name.localeCompare(b.name))
    .slice(0, 16);
  return tags.length > 0 ? tags : undefined;
}

async function getProviderSettings(): Promise<ProviderSettings> {
  return {
    lastFmApiKey: (await getSystemSetting('lastFmApiKey')) || '',
    geniusApiKey: (await getSystemSetting('geniusApiKey')) || '',
    musicBrainzEnabled:
      (await getSystemSetting('musicBrainzEnabled')) === true ||
      (await getSystemSetting('musicBrainzEnabled')) === 'true',
    providerArtistImage: (await getSystemSetting('providerArtistImage')) || 'lastfm',
    providerArtistArtwork: (await getSystemSetting('providerArtistArtwork')) || 'genius',
    providerArtistBio: (await getSystemSetting('providerArtistBio')) || 'lastfm',
    providerAlbumArt: (await getSystemSetting('providerAlbumArt')) || 'lastfm',
  };
}

// ─── Public API ─────────────────────────────────────────────────────

const ARTIST_NO_IMAGE_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

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
  const wantsGeniusArtwork = settings.providerArtistArtwork === 'genius' && !!settings.geniusApiKey;

  // A stamped row is a completed lookup (failed ones stay unstamped), so serve
  // it while fresh rather than asking every provider again on each page view:
  // the APIs are free and rate limited. Without a picture it is re-checked
  // weekly, so an artist that missed out during a provider outage recovers
  // soon; with one, after the usual 30 days.
  if (cached && isCacheFresh(cached.last_updated, cached.image_url ? undefined : ARTIST_NO_IMAGE_RECHECK_MS)) {
    return {
      imageUrl: cached.image_url || undefined,
      artworkUrl: settings.providerArtistArtwork === 'none' ? undefined : cached.artwork_url || undefined,
      bio: cached.bio || undefined,
      disambiguation: cached.disambiguation || undefined,
      area: cached.area || undefined,
      type: cached.artist_type || undefined,
      lifeSpan: cached.lifespan_begin ? { begin: cached.lifespan_begin || undefined, end: cached.lifespan_end || undefined } : undefined,
      links: cached.links ? JSON.parse(cached.links) : undefined,
      genres: cached.genres ? JSON.parse(cached.genres) : undefined,
      communityTags: cached.community_tags ? JSON.parse(cached.community_tags) : undefined,
      listeners: cached.listeners || undefined,
      members: cached.members ? JSON.parse(cached.members) : undefined,
    };
  }

  let data: ArtistData = {};
  const communityTagMap = new Map<string, CommunityTag>();

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
            mbArtist.genres.forEach((g: any) => addCommunityTag(communityTagMap, g.name, g.count, 'musicbrainz'));
          }
          if (Array.isArray(mbArtist.tags) && mbArtist.tags.length > 0) {
            mbArtist.tags.forEach((tag: any) => addCommunityTag(communityTagMap, tag.name, tag.count, 'musicbrainz'));
          }
          const members = extractMbMembers(mbArtist.relations || []);
          if (members.length > 0) data.members = members;
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
  const artworkProvider = settings.providerArtistArtwork;
  const bioProvider = settings.providerArtistBio;

  if (imgProvider === 'genius' && settings.geniusApiKey) pushApi('genius');
  if (artworkProvider === 'genius' && settings.geniusApiKey) pushApi('genius');
  if (imgProvider === 'lastfm' && settings.lastFmApiKey) pushApi('lastfm');
  if (bioProvider === 'genius' && settings.geniusApiKey) pushApi('genius');
  if (bioProvider === 'lastfm' && settings.lastFmApiKey) pushApi('lastfm');
  if (settings.lastFmApiKey) pushApi('lastfm');

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
  // A provider that could have supplied the picture failed (outage, 5xx,
  // Genius 429). The artist must not be stamped as fetched, or the image
  // backfill never asks again.
  let imageLookupFailed = false;

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

            // No song by this artist in the hits: leave it unmatched rather
            // than borrowing the first hit's artist, whose picture and bio
            // belong to someone else (e.g. Electrypnose → Seed Nation).

            const artistId = match?.result?.primary_artist?.id;
            const imageUrl = match?.result?.primary_artist?.image_url;
            const fallbackArtworkUrl = match?.result?.header_image_url;

            if (
              imageUrl &&
              !data.imageUrl &&
              !imageUrl.includes('default_cover_image.png')
            ) {
              data.imageUrl = imageUrl;
            }

            if (wantsGeniusArtwork && fallbackArtworkUrl && !data.artworkUrl && !fallbackArtworkUrl.includes('default_cover_image.png')) {
              data.artworkUrl = fallbackArtworkUrl;
            }

            if (artistId && (!data.bio || (wantsGeniusArtwork && !data.artworkUrl))) {
              const artistJson = await geniusGetArtist(
                artistId,
                settings.geniusApiKey
              );
              if (artistJson) {
                const artist = artistJson.response?.artist;
                const artworkUrl = artist?.header_image_url;
                const artistImageUrl = artist?.image_url;
                if (wantsGeniusArtwork && artworkUrl && !data.artworkUrl && !artworkUrl.includes('default_avatar')) {
                  data.artworkUrl = artworkUrl;
                }
                if (
                  artistImageUrl &&
                  !data.imageUrl &&
                  !artistImageUrl.includes('default_avatar')
                ) {
                  data.imageUrl = artistImageUrl;
                }
                const bioPlain =
                  artist?.description?.plain;
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
            if (!data.listeners && artist.stats?.listeners) {
              data.listeners = artist.stats.listeners;
            }
            const topTags = await lastFmArtistTopTags(name, settings.lastFmApiKey);
            if (topTags?.tag && topTags.tag.length > 0) {
              topTags.tag.forEach((tag: any) => addCommunityTag(communityTagMap, tag.name, tag.count, 'lastfm'));
            } else if (artist.tags?.tag && artist.tags.tag.length > 0) {
              artist.tags.tag.forEach((tag: any) => addCommunityTag(communityTagMap, tag.name, tag.count, 'lastfm'));
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
      if (api === 'genius' || imgProvider === 'lastfm') {
        imageLookupFailed = true;
        if (isRateLimitError(e)) wasRateLimited = true;
        lastError = isRateLimitError(e)
          ? `Rate limited by ${api === 'genius' ? 'Genius' : 'Last.fm'}`
          : lastError || `${api}: ${e instanceof Error ? e.message : String(e)}`;
      }
      console.warn(`[Metadata] Failed fetching from ${api}:`, e);
    }
  }

  data.communityTags = sortedCommunityTags(communityTagMap);

  if (!wasRateLimited || data.imageUrl || data.bio) {
    const extras: ArtistCacheExtras = {
      disambiguation: data.disambiguation ?? null,
      area: data.area ?? null,
      artistType: data.type ?? null,
      lifespanBegin: data.lifeSpan?.begin ?? null,
      lifespanEnd: data.lifeSpan?.end ?? null,
      links: data.links && data.links.length > 0 ? JSON.stringify(data.links) : null,
      genres: data.genres && data.genres.length > 0 ? JSON.stringify(data.genres) : null,
      communityTags: data.communityTags && data.communityTags.length > 0 ? JSON.stringify(data.communityTags) : null,
      listeners: data.listeners ?? null,
      members: data.members && data.members.length > 0 ? JSON.stringify(data.members) : null,
      artworkUrl: data.artworkUrl ?? null,
    };
    await upsertArtistCache(
      name,
      data.imageUrl || null,
      data.bio || null,
      mbArtistId || cached?.mbid || null,
      !wasRateLimited && !(imageLookupFailed && !data.imageUrl),
      extras
    );
  }

  if (lastError && !data.imageUrl && (!data.bio || imageLookupFailed)) {
    data.error = lastError;
  }

  return data;
}

export async function getArtistTopTracks(name: string, limit: number = 25): Promise<ArtistTopTrack[]> {
  if (!name) return [];
  const settings = await getProviderSettings();
  if (!settings.lastFmApiKey) return [];

  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  try {
    const tracks = await lastFmArtistTopTracks(name, settings.lastFmApiKey, safeLimit);
    return tracks
      .filter((track) => typeof track.name === 'string' && track.name.trim().length > 0)
      .map((track) => ({
        name: track.name.trim(),
        playcount: track.playcount,
        listeners: track.listeners,
        mbid: track.mbid || undefined,
        url: track.url || undefined,
      }));
  } catch (error) {
    if (isRateLimitError(error)) return [];
    console.warn('[Metadata] Last.fm artist top tracks fetch failed:', error);
    return [];
  }
}

/**
 * Fetch album metadata (description, tags, listener stats).
 * Checks DB cache first, falls back to Last.fm.
 */
export async function getAlbumData(
  albumName: string,
  artistName: string,
  mbAlbumId?: string | null
): Promise<AlbumData> {
  if (!albumName || !artistName) return {};

  const settings = await getProviderSettings();
  const cached = await getCachedAlbum(albumName, artistName);

  if (cached && isCacheFresh(cached.last_updated)) {
    if (cached.image_url || cached.description || cached.listeners) {
      return {
        imageUrl: cached.image_url || undefined,
        description: cached.description || undefined,
        tags: cached.tags ? JSON.parse(cached.tags) : undefined,
        listeners: cached.listeners || undefined,
        playcount: cached.playcount || undefined,
      };
    }
  }

  const data: AlbumData = {};

  if (settings.lastFmApiKey) {
    try {
      const album = await lastFmAlbumInfo(albumName, artistName, settings.lastFmApiKey);
      if (album) {
        if (album.wiki?.summary) {
          data.description = cleanHtml(album.wiki.summary.split('<a href')[0].trim());
          if (!data.description) delete data.description;
        }
        if (album.tags?.tag && album.tags.tag.length > 0) {
          data.tags = album.tags.tag.map((t: any) => t.name).filter(Boolean);
        }
        if (album.listeners) data.listeners = album.listeners;
        if (album.playcount) data.playcount = album.playcount;
        if (!data.imageUrl && album.image) {
          const imageUrl = extractLastFmImage(album.image);
          if (imageUrl) data.imageUrl = imageUrl;
        }
      }
    } catch (e) {
      console.warn('[Metadata] Last.fm album data fetch failed:', e);
    }
  }

  const extras: AlbumCacheExtras = {
    description: data.description ?? null,
    tags: data.tags && data.tags.length > 0 ? JSON.stringify(data.tags) : null,
    listeners: data.listeners ?? null,
    playcount: data.playcount ?? null,
  };

  await upsertAlbumCache(albumName, artistName, data.imageUrl || null, mbAlbumId || cached?.mbid || null, true, extras);

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
    if (isMusicBrainzUuid(mbid)) {
      try {
        const coverUrl = `https://coverartarchive.org/release/${encodeURIComponent(mbid)}/front-500`;
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
