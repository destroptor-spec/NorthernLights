import { getRepresentativeReleaseMbid, getStoredRecordingPlaces, getSystemSetting, initDB, storeRecordingPlaces } from '../../database';
import { mergeForDisplay, normaliseProviderTags, saveArtistTagsByName, type ProviderTag, type TagProvider, type WeightedTag } from '../genreTaxonomy/artistTags';
import { scheduleTagMapping } from '../genreTaxonomy';
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
import { extractMbLinks, extractMbMembers, mbGetArtist, mbGetAlbumCover, mbGetReleaseGroupCover, mbReleaseGroupOfRelease, mbReleaseRecordingPlaces, mbSearchReleaseGroup, type RecordingPlace } from './providers/musicbrainz';
import { countryCode } from '../../../shared/places';
import { isGeniusPlaceholderImage, type MetadataItem, type MetadataProvider, type MetadataProviderPriority } from '../../../shared/metadataProviders';
import { getMetadataProviderPriority } from './providerPriority';
import { tadbAlbumByReleaseGroup, tadbArtistByMbid, tadbSearchArtist, tadbSearchAlbum, tadbImage, type TadbAlbum, type TadbArtist } from './providers/theaudiodb';
import { fanartArtist, fanartAlbum, bestFanartImage } from './providers/fanarttv';
import { mergeLinks, sameArtistName, sameName, theAudioDbFacts, withDisplayTags } from './theAudioDbFacts';

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
  providers: Array<'lastfm' | 'musicbrainz' | 'theaudiodb'>;
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
  theAudioDbApiKey: string;
  fanartTvApiKey: string;
  /** Each item's providers in the admin's order, set up or not. */
  priority: MetadataProviderPriority;
}

/** The item's providers in order, leaving out the ones not set up. */
function usableProviders(settings: ProviderSettings, item: MetadataItem): MetadataProvider[] {
  return settings.priority[item].filter((provider) =>
    provider === 'lastfm' ? !!settings.lastFmApiKey
      : provider === 'genius' ? !!settings.geniusApiKey
        : provider === 'theaudiodb' ? !!settings.theAudioDbApiKey
          : provider === 'fanarttv' ? !!settings.fanartTvApiKey
            : settings.musicBrainzEnabled);
}

// ─── Helpers ────────────────────────────────────────────────────────
const MUSICBRAINZ_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A Genius artist name is this artist: the same name ignoring case, width and
 * spacing, or that name with a note in brackets after it ("Name (UK)").
 */
function sameGeniusArtistName(geniusName: unknown, name: string): boolean {
  if (typeof geniusName !== 'string') return false;
  return sameName(geniusName, name) || sameName(geniusName.replace(/\s*\([^()]*\)\s*$/, ''), name);
}

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

async function getProviderSettings(): Promise<ProviderSettings> {
  return {
    lastFmApiKey: (await getSystemSetting('lastFmApiKey')) || '',
    geniusApiKey: (await getSystemSetting('geniusApiKey')) || '',
    musicBrainzEnabled:
      (await getSystemSetting('musicBrainzEnabled')) === true ||
      (await getSystemSetting('musicBrainzEnabled')) === 'true',
    theAudioDbApiKey: (await getSystemSetting('theAudioDbApiKey')) || '',
    fanartTvApiKey: (await getSystemSetting('fanartTvApiKey')) || '',
    priority: await getMetadataProviderPriority(),
  };
}

// ─── Public API ─────────────────────────────────────────────────────

export const ARTIST_NO_IMAGE_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

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

  // A stamped row is a completed lookup (failed ones stay unstamped), so serve
  // it while fresh rather than asking every provider again on each page view:
  // the APIs are free and rate limited. Without a picture it is re-checked
  // weekly, so an artist that missed out during a provider outage recovers
  // soon; with one, after the usual 30 days.
  // A Genius stock picture stored before it was recognised is no picture: look
  // again (the save below clears it when nothing better turns up).
  const cachedHasPlaceholder = isGeniusPlaceholderImage(cached?.image_url) || isGeniusPlaceholderImage(cached?.artwork_url);
  if (cached && !cachedHasPlaceholder && isCacheFresh(cached.last_updated, cached.image_url ? undefined : ARTIST_NO_IMAGE_RECHECK_MS)) {
    return {
      imageUrl: cached.image_url || undefined,
      artworkUrl: settings.priority.artistBanner.length === 0 ? undefined : cached.artwork_url || undefined,
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
  // Raw tags per provider that answered. Kept apart: Last.fm counts are 0–100
  // relative, MusicBrainz counts are votes; they are normalised per provider
  // (genreTaxonomy/artistTags) and never summed.
  const providerTags: Partial<Record<TagProvider, ProviderTag[]>> = {};

  // The stored id (from the files) wins over one the caller derived.
  // ISO country from MusicBrainz, stored for filters and playlists.
  let mbCountry: string | null = null;
  if (settings.musicBrainzEnabled && (cached?.mbid || mbArtistId)) {
    const mbid = cached?.mbid || mbArtistId;
    if (mbid) {
      try {
        const mbArtist = await mbGetArtist(mbid);
        if (mbArtist) {
          data.disambiguation = mbArtist.disambiguation || undefined;
          data.area = mbArtist.area?.name || undefined;
          mbCountry = countryCode(mbArtist.country) ?? countryCode(mbArtist.area?.name);
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
          // Genres are a subset of tags with the same votes; normalising keeps the max.
          providerTags.musicbrainz = [
            ...(Array.isArray(mbArtist.genres) ? mbArtist.genres : []),
            ...(Array.isArray(mbArtist.tags) ? mbArtist.tags : []),
          ].map((t: any) => ({ name: t?.name, count: Number(t?.count) }));
          const members = extractMbMembers(mbArtist.relations || []);
          if (members.length > 0) data.members = members;
        }
      } catch (e) {
        console.warn('[Metadata] MusicBrainz artist lookup failed:', e);
      }
    }
  }

  // Each item asks its providers in the admin's order and keeps the first one
  // that has it (Settings → Metadata). A provider is asked once for everything
  // it can give; once every item is decided (a provider has it and everyone
  // ahead of that provider in its list has been asked), the rest are skipped,
  // except TheAudioDB, which is always asked when set up for its facts (country,
  // years, links, genre/style/mood).
  type ArtistSource = 'genius' | 'lastfm' | 'theaudiodb' | 'fanarttv';
  type ArtistField = 'imageUrl' | 'bio' | 'artworkUrl';
  const FIELDS: ArtistField[] = ['imageUrl', 'artworkUrl', 'bio'];
  const isArtistSource = (p: MetadataProvider): p is ArtistSource => p !== 'musicbrainz';
  const lists: Record<ArtistField, ArtistSource[]> = {
    imageUrl: usableProviders(settings, 'artistImage').filter(isArtistSource),
    artworkUrl: usableProviders(settings, 'artistBanner').filter(isArtistSource),
    bio: usableProviders(settings, 'artistBio').filter(isArtistSource),
  };
  const found: Record<ArtistField, Partial<Record<ArtistSource, string>>> = { imageUrl: {}, bio: {}, artworkUrl: {} };
  // Who has answered for each item, found or not (a failure counts as answered).
  const answered: Record<ArtistField, Set<ArtistSource>> = { imageUrl: new Set(), bio: new Set(), artworkUrl: new Set() };
  const answerAll = (source: ArtistSource) => FIELDS.forEach((field) => answered[field].add(source));
  const firstFound = (field: ArtistField) =>
    lists[field].map((source) => found[field][source]).find(Boolean);
  /** No provider ahead of `source` in the item's list has it (yet). */
  const wouldUse = (field: ArtistField, source: ArtistSource) => {
    for (const s of lists[field]) {
      if (s === source) return true;
      if (found[field][s]) return false;
    }
    return false;
  };
  /** Everyone ahead of `source` has answered without it: `source` decides the item now. */
  const nextInLine = (field: ArtistField, source: ArtistSource) => {
    for (const s of lists[field]) {
      if (s === source) return true;
      if (found[field][s] || !answered[field].has(s)) return false;
    }
    return false;
  };
  const decided = (field: ArtistField) => {
    for (const s of lists[field]) {
      if (found[field][s]) return true;
      if (!answered[field].has(s)) return false;
    }
    return true;
  };
  const sourceName: Record<ArtistSource, string> = { genius: 'Genius', lastfm: 'Last.fm', theaudiodb: 'TheAudioDB', fanarttv: 'fanart.tv' };

  // fanart.tv only knows artists by MusicBrainz id. The files' id comes first;
  // without one, TheAudioDB's name match may supply one for this lookup only
  // (never stored: a same-name mix-up must not stick to the artist).
  const knownMbid = [cached?.mbid, mbArtistId].find(isMusicBrainzUuid);
  let lookupMbid: string | undefined = knownMbid;

  const apisToTry: ArtistSource[] = [];
  for (const source of [...lists.imageUrl, ...lists.artworkUrl, ...lists.bio]) {
    if (!apisToTry.includes(source)) apisToTry.push(source);
  }
  // Last.fm's tags feed genres and styles; it is asked last when nothing else needs it.
  if (settings.lastFmApiKey && !apisToTry.includes('lastfm')) apisToTry.push('lastfm');
  if (settings.theAudioDbApiKey && !apisToTry.includes('theaudiodb')) apisToTry.push('theaudiodb');
  if (!knownMbid && apisToTry.includes('fanarttv') && apisToTry.includes('theaudiodb')
    && apisToTry.indexOf('theaudiodb') > apisToTry.indexOf('fanarttv')) {
    // Ask TheAudioDB first, for the id.
    apisToTry.splice(apisToTry.indexOf('theaudiodb'), 1);
    apisToTry.splice(apisToTry.indexOf('fanarttv'), 0, 'theaudiodb');
  }

  let wasRateLimited = false;
  let lastError: string | undefined;
  // A provider that could have supplied the picture failed (outage, 5xx,
  // Genius 429). The artist must not be stamped as fetched, or the image
  // backfill never asks again.
  let imageLookupFailed = false;
  let geniusArtistId: number | undefined;
  let geniusArtistFetched = false;
  let tadbArtist: TadbArtist | null = null;

  // The Genius artist record holds the bio, header artwork and avatar.
  const fetchGeniusArtist = async (artistId: number) => {
    geniusArtistFetched = true;
    const artistJson = await geniusGetArtist(artistId, settings.geniusApiKey);
    const artist = artistJson?.response?.artist;
    if (!artist) return;
    const artworkUrl = artist.header_image_url;
    const artistImageUrl = artist.image_url;
    if (artworkUrl && !found.artworkUrl.genius && !isGeniusPlaceholderImage(artworkUrl)) {
      found.artworkUrl.genius = artworkUrl;
    }
    if (artistImageUrl && !found.imageUrl.genius && !isGeniusPlaceholderImage(artistImageUrl)) {
      found.imageUrl.genius = artistImageUrl;
    }
    const bioPlain = artist.description?.plain;
    if (typeof bioPlain === 'string' && bioPlain.trim().length > 0 && bioPlain !== '?') {
      found.bio.genius = bioPlain;
    }
  };

  for (const api of apisToTry) {
    if (api !== 'theaudiodb' && FIELDS.every(decided)) continue;
    try {
      if (api === 'genius') {
        const json = await geniusSearch(name, settings.geniusApiKey);
        if (json) {
          const hits = json.response?.hits;
          if (hits && hits.length > 0) {
            // A song whose artist has this very name. Not one whose name
            // merely contains it: "Demon Hunter" found only songs by the
            // "KPop Demon Hunters Cast" and took their picture.
            const isThisArtist = (h: any) => h.type === 'song' && sameGeniusArtistName(h.result?.primary_artist?.name, name);
            const match = hits.find(isThisArtist);

            // No song by this artist in the hits: leave it unmatched rather
            // than borrowing the first hit's artist, whose picture and bio
            // belong to someone else (e.g. Electrypnose → Seed Nation).

            geniusArtistId = match?.result?.primary_artist?.id;
            const imageUrl = match?.result?.primary_artist?.image_url;
            const fallbackArtworkUrl = match?.result?.header_image_url;

            if (imageUrl && !found.imageUrl.genius && !isGeniusPlaceholderImage(imageUrl)) {
              found.imageUrl.genius = imageUrl;
            }

            if (fallbackArtworkUrl && !found.artworkUrl.genius && !isGeniusPlaceholderImage(fallbackArtworkUrl)) {
              found.artworkUrl.genius = fallbackArtworkUrl;
            }

            // Skip the artist call when nothing still wanted from Genius is in
            // it. Its bio waits until the providers ahead of Genius in the bio
            // list have answered (after the loop): they have one for most
            // artists, and the call is half of the Genius traffic.
            const wantsGeniusArtist =
              (!found.artworkUrl.genius && wouldUse('artworkUrl', 'genius')) ||
              (!found.imageUrl.genius && wouldUse('imageUrl', 'genius')) ||
              (!found.bio.genius && nextInLine('bio', 'genius'));
            if (geniusArtistId && wantsGeniusArtist) await fetchGeniusArtist(geniusArtistId);
          }
        }
        answered.imageUrl.add('genius');
        answered.artworkUrl.add('genius');
        if (!geniusArtistId || geniusArtistFetched) answered.bio.add('genius');
      } else if (api === 'lastfm') {
        try {
          const artist = await lastFmArtistInfo(name, settings.lastFmApiKey);
          if (artist) {
            if (artist.bio?.summary) {
              const lastFmBio = cleanHtml(artist.bio.summary.split('<a href')[0].trim());
              if (lastFmBio) found.bio.lastfm = lastFmBio;
            }
            if (artist.image) {
              const imageUrl = extractLastFmImage(artist.image);
              if (imageUrl) found.imageUrl.lastfm = imageUrl;
            }
            if (!data.listeners && artist.stats?.listeners) {
              data.listeners = artist.stats.listeners;
            }
            const topTags = await lastFmArtistTopTags(name, settings.lastFmApiKey);
            if (topTags?.tag && topTags.tag.length > 0) {
              providerTags.lastfm = topTags.tag.map((tag: any) => ({ name: tag?.name, count: Number(tag?.count) }));
            } else if (artist.tags?.tag && artist.tags.tag.length > 0) {
              // artist.getinfo lists tags without counts: keep their order as weight.
              providerTags.lastfm = artist.tags.tag.map((tag: any, i: number) => ({ name: tag?.name, count: Math.max(10, 100 - i * 10) }));
            } else {
              providerTags.lastfm = [];
            }
          }
          answerAll('lastfm');
        } catch (err) {
          if (isRateLimitError(err)) {
            wasRateLimited = true;
            lastError = 'Rate limited by Last.fm';
            answerAll('lastfm');
            continue;
          }
          if (isProviderError(err)) {
            lastError = `${err.provider}: ${err.message}`;
          }
          throw err;
        }
      } else if (api === 'theaudiodb') {
        // By the files' MusicBrainz id when there is one; else by name, kept
        // only when the name is the same (the free key returns a single hit).
        tadbArtist = knownMbid
          ? await tadbArtistByMbid(knownMbid, settings.theAudioDbApiKey)
          : await tadbSearchArtist(name, settings.theAudioDbApiKey);
        if (tadbArtist && !knownMbid && !sameArtistName(tadbArtist, name)) tadbArtist = null;
        if (tadbArtist) {
          if (!lookupMbid && isMusicBrainzUuid(tadbArtist.strMusicBrainzID)) lookupMbid = tadbArtist.strMusicBrainzID;
          const thumb = tadbImage(tadbArtist.strArtistThumb);
          if (thumb) found.imageUrl.theaudiodb = thumb;
          const banner = [tadbArtist.strArtistFanart, tadbArtist.strArtistFanart2, tadbArtist.strArtistFanart3, tadbArtist.strArtistFanart4, tadbArtist.strArtistWideThumb]
            .map(tadbImage).find(Boolean);
          if (banner) found.artworkUrl.theaudiodb = banner;
          const bio = (tadbArtist.strBiography || tadbArtist.strBiographyEN || '').trim();
          if (bio) found.bio.theaudiodb = bio;
        }
        answerAll('theaudiodb');
      } else if (api === 'fanarttv') {
        if (lookupMbid) {
          const fanart = await fanartArtist(lookupMbid, settings.fanartTvApiKey);
          const thumb = bestFanartImage(fanart?.artistthumb);
          if (thumb) found.imageUrl.fanarttv = thumb;
          const background = bestFanartImage(fanart?.artistbackground);
          if (background) found.artworkUrl.fanarttv = background;
        }
        answerAll('fanarttv');
      }
    } catch (e) {
      answerAll(api);
      if (lists.imageUrl.includes(api)) {
        imageLookupFailed = true;
        if (isRateLimitError(e)) wasRateLimited = true;
        lastError = isRateLimitError(e)
          ? `Rate limited by ${sourceName[api]}`
          : lastError || `${api}: ${e instanceof Error ? e.message : String(e)}`;
      }
      console.warn(`[Metadata] Failed fetching from ${api}:`, e);
    }
  }

  // The Genius bio, when every provider ahead of it in the bio list came up empty.
  if (geniusArtistId && !geniusArtistFetched && !found.bio.genius && nextInLine('bio', 'genius')) {
    try {
      await fetchGeniusArtist(geniusArtistId);
    } catch (e) {
      console.warn('[Metadata] Failed fetching the Genius artist:', e);
    }
  }

  data.imageUrl = firstFound('imageUrl');
  data.artworkUrl = firstFound('artworkUrl');
  data.bio = firstFound('bio');
  // TheAudioDB's facts fill what MusicBrainz didn't give.
  let tadbTags: CommunityTag[] = [];
  if (tadbArtist) {
    const facts = theAudioDbFacts(tadbArtist);
    data.area ??= facts.area;
    mbCountry ??= facts.country ?? null;
    data.lifeSpan ??= facts.lifeSpan;
    if (facts.links.length > 0) data.links = mergeLinks(data.links, facts.links);
    tadbTags = facts.tags;
  }
  const weightedTags: Partial<Record<TagProvider, WeightedTag[]>> = {};
  for (const provider of Object.keys(providerTags) as TagProvider[]) {
    weightedTags[provider] = normaliseProviderTags(providerTags[provider] || []);
  }
  data.communityTags = withDisplayTags(mergeForDisplay(weightedTags), tadbTags);

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
      country: mbCountry,
      artworkUrl: data.artworkUrl ?? null,
    };
    await upsertArtistCache(
      name,
      data.imageUrl || null,
      data.bio || null,
      cached?.mbid || mbArtistId || null,
      !wasRateLimited && !(imageLookupFailed && !data.imageUrl),
      extras
    );
    // Per-provider tags for the genre & style taxonomy (optional evidence).
    if (Object.keys(weightedTags).length > 0) {
      try {
        const db = await initDB();
        await saveArtistTagsByName(db, name, weightedTags);
        scheduleTagMapping();
      } catch (e: any) {
        console.warn('[Metadata] Saving artist tags failed (non-fatal):', e?.message || e);
      }
    }
  }

  if (lastError && !data.imageUrl && (!data.bio || imageLookupFailed)) {
    data.error = lastError;
  }

  return data;
}

const rankingRefreshes = new Map<string, Promise<ArtistTopTrack[]>>();
const rankingRetryAfter = new Map<string, number>();

export async function getArtistTopTracks(name: string, limit: number = 25): Promise<ArtistTopTrack[]> {
  const artistKey = name.trim().toLowerCase();
  if (!artistKey) return [];
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const db = await initDB();
  // Changing the configured credential creates a new PostgreSQL row version.
  // Use that version to invalidate rankings without deriving a token from the secret.
  const { rows: [provider] } = await db.query<{
    value: string | null; revision: string; tracks: ArtistTopTrack[] | null; fetched_at: Date | null;
  }>(
    `SELECT s.value, s.xmin::text AS revision, c.tracks, c.fetched_at
       FROM system_settings s LEFT JOIN artist_top_tracks_cache c
         ON c.artist_key = $1 AND c.result_limit = $2 AND c.provider_key = s.xmin::text
      WHERE s.key = 'lastFmApiKey'`,
    [artistKey, safeLimit],
  );
  // Parsed here, not cast in SQL, so a stored value that isn't valid JSON reads
  // as unset (as getSystemSetting does) instead of failing every request.
  let lastFmApiKey: unknown = null;
  try { lastFmApiKey = provider?.value ? JSON.parse(provider.value) : null; } catch { /* unset */ }
  if (typeof lastFmApiKey !== 'string' || !lastFmApiKey.trim()) return [];
  const { revision } = provider;
  const key = JSON.stringify([artistKey, safeLimit, revision]);
  const cached = provider.tracks && provider.fetched_at ? { tracks: provider.tracks, fetched_at: provider.fetched_at } : null;
  if (cached && Date.now() - cached.fetched_at.getTime() < (cached.tracks.length ? 3600000 : 300000)) return cached.tracks;
  if ((rankingRetryAfter.get(key) ?? 0) > Date.now()) {
    if (cached) return cached.tracks;
    // Our own back-off after a failed refresh: reported like a rate limit, so
    // the route answers 503 quietly instead of logging every artist page.
    throw new RateLimitError('lastfm', Math.ceil(((rankingRetryAfter.get(key) ?? 0) - Date.now()) / 1000));
  }
  let refresh = rankingRefreshes.get(key);
  if (!refresh) {
    refresh = (async () => {
      const response = await lastFmArtistTopTracks(name, lastFmApiKey, safeLimit);
      const tracks = response.filter(track => track.name?.trim()).map(track => ({
        name: track.name.trim(), playcount: track.playcount, listeners: track.listeners,
        mbid: track.mbid || undefined, url: track.url || undefined,
      }));
      await db.query(`
        INSERT INTO artist_top_tracks_cache (artist_key,result_limit,provider_key,tracks) VALUES ($1,$2,$3,$4)
        ON CONFLICT (artist_key,result_limit) DO UPDATE SET tracks=EXCLUDED.tracks,
          provider_key=EXCLUDED.provider_key, fetched_at=NOW()
      `, [artistKey, safeLimit, revision, JSON.stringify(tracks)]);
      return tracks;
    })().catch(error => {
      rankingRetryAfter.set(key, Date.now() + 60000);
      setTimeout(() => rankingRetryAfter.delete(key), 60000).unref();
      throw error;
    }).finally(() => rankingRefreshes.delete(key));
    rankingRefreshes.set(key, refresh);
  }
  if (!cached) return refresh;
  void refresh.catch(() => {});
  return cached.tracks;
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
// Where an album was recorded: asked of MusicBrainz when its page is first
// opened (one request), kept on the album, and asked again after this long
// (places get entered). Never in a background sweep: MusicBrainz is free and
// rate-limited, and most albums' pages are never opened.
const RECORDING_PLACES_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * The album's recording places, most tracks first; [] when MusicBrainz has
 * none (or the files name no release), null when it can't say now
 * (MusicBrainz off, or the lookup failed: asked again next time).
 */
export async function getAlbumRecordingPlaces(albumId: string): Promise<RecordingPlace[] | null> {
  const settings = await getProviderSettings();
  if (!settings.musicBrainzEnabled) return null;
  const stored = await getStoredRecordingPlaces(albumId);
  if (!stored) return null;
  if (stored.readAt && Date.now() - new Date(stored.readAt).getTime() < RECORDING_PLACES_TTL_MS && Array.isArray(stored.places)) {
    return stored.places as RecordingPlace[];
  }
  const releaseId = await getRepresentativeReleaseMbid(albumId);
  if (!isMusicBrainzUuid(releaseId)) {
    await storeRecordingPlaces(albumId, []);
    return [];
  }
  try {
    const places = await mbReleaseRecordingPlaces(releaseId);
    await storeRecordingPlaces(albumId, places);
    return places;
  } catch (error) {
    console.warn('[Metadata] Recording places lookup failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

// Disc images found (or not) per album and disc: the album page asks on every
// visit, and fanart.tv and TheAudioDB are rate-limited free APIs. A day, then
// asked again (art gets added); a failed lookup isn't kept.
const DISC_ART_TTL_MS = 24 * 60 * 60 * 1000;
const DISC_ART_MAX = 2000;
const discArtCache = new Map<string, { url: string | null; at: number }>();

/** Test hook. */
export function clearDiscArtCacheForTests(): void {
  discArtCache.clear();
}

/**
 * A picture of the disc itself (transparent PNG) for the disc that rolls out
 * of the album's cover, when the Cover Art Archive has no scan of it: from
 * fanart.tv (`cdart`, by release group, for this disc when it says) and
 * TheAudioDB (`strAlbumCDart`), asked in the admin's Album art order, and only
 * those on that list. Null when none has one.
 */
export async function getAlbumDiscArt(album: {
  title: string;
  artist: string;
  releaseGroupId?: string | null;
  /** 0 for the first disc. */
  discIndex?: number;
}): Promise<string | null> {
  const discIndex = album.discIndex ?? 0;
  const releaseGroupId = isMusicBrainzUuid(album.releaseGroupId) ? album.releaseGroupId : null;
  const key = `${releaseGroupId || `${album.artist}\u0000${album.title}`.toLowerCase()}#${discIndex}`;
  const cached = discArtCache.get(key);
  if (cached && Date.now() - cached.at < DISC_ART_TTL_MS) return cached.url;

  const settings = await getProviderSettings();
  let failed = false;
  let url: string | null = null;
  for (const api of usableProviders(settings, 'albumArt')) {
    try {
      if (api === 'fanarttv' && releaseGroupId) {
        const fanart = await fanartAlbum(releaseGroupId, settings.fanartTvApiKey);
        const discs = fanart?.albums?.[releaseGroupId]?.cdart || [];
        const thisDisc = discs.filter(d => Number(d.disc) === discIndex + 1);
        url = bestFanartImage(thisDisc.length ? thisDisc : discs) ?? null;
      } else if (api === 'theaudiodb') {
        const hit = releaseGroupId
          ? await tadbAlbumByReleaseGroup(releaseGroupId, settings.theAudioDbApiKey)
          : (await tadbSearchAlbum(album.artist, album.title, settings.theAudioDbApiKey)).find(a => sameName(a.strAlbum, album.title)) ?? null;
        url = tadbImage(hit?.strAlbumCDart) ?? null;
      }
    } catch (error) {
      failed = true;
      console.warn(`[Metadata] Disc art from ${api} failed:`, error instanceof Error ? error.message : error);
    }
    if (url) break;
  }

  if (url || !failed) {
    discArtCache.delete(key);
    discArtCache.set(key, { url, at: Date.now() });
    while (discArtCache.size > DISC_ART_MAX) discArtCache.delete(discArtCache.keys().next().value as string);
  }
  return url;
}

export async function getAlbumImage(
  albumName: string,
  artistName: string,
  mbAlbumId?: string | null,
  mbReleaseGroupId?: string | null
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

  // The admin's order (Settings → Metadata → Album art); the first cover wins.
  let wasRateLimited = false;
  const releaseId = [mbAlbumId, cached?.mbid].find(isMusicBrainzUuid);
  // TheAudioDB's album search, made at most once per lookup.
  let tadbAlbumHit: TadbAlbum | null | undefined;
  const findTadbAlbum = async () => {
    if (tadbAlbumHit === undefined) {
      const hits = await tadbSearchAlbum(artistName, albumName, settings.theAudioDbApiKey);
      tadbAlbumHit = hits.find((hit) => sameName(hit.strAlbum, albumName)) ?? null;
    }
    return tadbAlbumHit;
  };
  // The release group the files name (tag MUSICBRAINZ_RELEASEGROUPID, kept on
  // the track and the album row): no lookup needed.
  const taggedReleaseGroupId = [mbReleaseGroupId, cached?.mb_release_group_id].find(isMusicBrainzUuid) ?? null;
  // fanart.tv knows albums by release group: the files' own, else asked of
  // MusicBrainz for the files' release, else TheAudioDB's match.
  let releaseGroupId: string | null | undefined = taggedReleaseGroupId ?? undefined;
  const resolveReleaseGroup = async () => {
    if (releaseGroupId !== undefined) return releaseGroupId;
    releaseGroupId = null;
    if (releaseId && settings.musicBrainzEnabled) {
      releaseGroupId = await mbReleaseGroupOfRelease(releaseId).catch(() => null);
    }
    if (!releaseGroupId && settings.theAudioDbApiKey) {
      const hit = await findTadbAlbum().catch(() => null);
      if (isMusicBrainzUuid(hit?.strMusicBrainzID)) releaseGroupId = hit!.strMusicBrainzID!;
    }
    return releaseGroupId;
  };

  for (const api of usableProviders(settings, 'albumArt')) {
    try {
      if (api === 'musicbrainz') {
        // The Cover Art Archive: by the release the files name, then their
        // release group; only without either, by searching MusicBrainz.
        if (releaseId) {
          const coverUrl = await mbGetAlbumCover(releaseId);
          if (coverUrl) {
            await upsertAlbumCache(albumName, artistName, coverUrl, releaseId);
            return coverUrl;
          }
        }
        if (taggedReleaseGroupId) {
          const coverUrl = await mbGetReleaseGroupCover(taggedReleaseGroupId);
          if (coverUrl) {
            await upsertAlbumCache(albumName, artistName, coverUrl, releaseId ?? null);
            return coverUrl;
          }
        } else if (!releaseId) {
          const hits = await mbSearchReleaseGroup(`${artistName} ${albumName}`);
          const match = hits.find((h) => h.title?.toLowerCase() === albumName.toLowerCase()) || hits[0];
          if (match?.id) {
            const coverUrl = await mbGetReleaseGroupCover(match.id);
            if (coverUrl) {
              await upsertAlbumCache(albumName, artistName, coverUrl, null);
              return coverUrl;
            }
          }
        }
      } else if (api === 'lastfm') {
        try {
          const album = await lastFmAlbumInfo(albumName, artistName, settings.lastFmApiKey);
          const imageUrl = album?.image ? extractLastFmImage(album.image) : undefined;
          if (imageUrl) {
            await upsertAlbumCache(albumName, artistName, imageUrl, null);
            return imageUrl;
          }
        } catch (err) {
          if (isRateLimitError(err)) {
            wasRateLimited = true;
            continue;
          }
          throw err;
        }
      } else if (api === 'theaudiodb') {
        const coverUrl = tadbImage((await findTadbAlbum())?.strAlbumThumb);
        if (coverUrl) {
          await upsertAlbumCache(albumName, artistName, coverUrl, null);
          return coverUrl;
        }
      } else if (api === 'fanarttv') {
        const groupId = await resolveReleaseGroup();
        if (groupId) {
          const fanart = await fanartAlbum(groupId, settings.fanartTvApiKey);
          const coverUrl = bestFanartImage(fanart?.albums?.[groupId]?.albumcover);
          if (coverUrl) {
            await upsertAlbumCache(albumName, artistName, coverUrl, null);
            return coverUrl;
          }
        }
      } else if (api === 'genius') {
        const query = `${artistName} ${albumName}`;
        const json = await geniusSearch(query, settings.geniusApiKey);
        const hits = json?.response?.hits;
        if (hits && hits.length > 0) {
          const songHit = hits.find((h: any) => h.type === 'song');
          const imageUrl =
            songHit?.result?.song_art_image_url ||
            songHit?.result?.header_image_url;
          if (imageUrl && !isGeniusPlaceholderImage(imageUrl)) {
            await upsertAlbumCache(albumName, artistName, imageUrl, null);
            return imageUrl;
          }
        }
      }
    } catch (e) {
      if (isRateLimitError(e)) wasRateLimited = true;
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
      thumbnailUrl: isGeniusPlaceholderImage(thumbnailUrl)
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
