import { getUserSetting, initDB, createPlaylist, addTracksToPlaylist, getPlaylists, getPlaylistTracks, getUserRecentTracks, getUserTopTracks, deleteSystemPlaylistsForUser, getSystemSetting } from '../database';
import { getLibraryProfile } from './libraryProfile.service';
import { compileConceptToLibrary } from './llmConceptCompiler.service';
import { queryWithRetry } from '../utils/db';
import { christmasExclusionSql, isChristmasSeason, isChristmasRow } from '../utils/seasonalFilter';
import { countryCode, languageCode, placeFromTag } from '../../shared/places';
import { seedStyleVector, styleBeta, styleCosine, styleVectorForNames, styleVectors, type StyleVector } from './styleOverlap.service';
import { isRowBanned, pathsMatchSql, trackGenrePathsJoin } from './genreTaxonomy/paths';
import { artistCap, blendEmbeddings, conceptMatch, conceptStyles, focusOf, moodBeta, moodMatch, moodTargetOf, rankByScore, scoreBeta, soundQualitySql, STRONG_MEMBER, styleSoundShare, trackMemberships, trackMoods, type MoodTarget } from './aiPlaylistScore.service';
import type { SoundQuality } from '../../shared/audioMoods';
import { ACTIVITIES, buildThemeMenu, recentSpecialThemes, type Theme } from './specialLists.service';
import { imputeEffNetCentroid, leadArtistKey } from './scoredMix.service';
import { hasHardFilter, thinRequest } from './aiPlaylistSupport';

/** A special list's tracks fit when they are within this share of the theme's tracks nearest by sound. */
const SPECIAL_FIT_SHARE = 0.75;
import { moodOf, vocalsOf, type Mood } from '../../shared/descriptors';

// 1. Z-Score normalization is handled by scaling 0-1 mapped values in JS, but 
// for simplicity we assume vectors are already [0,1] normalized.
// Distance query uses native PGLite `<->` vector L2 distance operator.

function normalizeTitle(title: string): string {
  if (!title) return '';
  let t = title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

  // 1. Strip known "noise" tags in parentheses or brackets
  // Matches things like (Remastered), [2012 Remaster], (Deluxe Edition), etc.
  const noiseRegex = /[\(\[]\s*(?:(?:\d{4}\s*)?remaster(?:ed)?|deluxe|special|expanded|anniversary|digital|mono|stereo|explicit|edition)\s*[\)\]]/gi;
  t = t.replace(noiseRegex, '');

  // 2. Also strip plain "Remastered" text not in parentheses
  t = t.replace(/(?:\d{4}\s*)?remaster(?:ed)?/gi, '');

  // 3. Clean up leading/trailing punctuation and double spaces
  return t.replace(/\s+/g, ' ')
          .replace(/[\s\-\:\.\(\)\[\]]+$/, '')
          .trim();
}

function isSameSong(a: { title: string, artist: string, mb_recording_id?: string }, b: { title: string, artist: string, mb_recording_id?: string }) {
  if (a.mb_recording_id && b.mb_recording_id && a.mb_recording_id !== '') {
    return a.mb_recording_id === b.mb_recording_id;
  }
  const artistA = (a.artist || '').toLowerCase().trim();
  const artistB = (b.artist || '').toLowerCase().trim();
  if (artistA !== artistB) return false;

  const titleA = normalizeTitle(a.title);
  const titleB = normalizeTitle(b.title);
  return titleA === titleB;
}

function normalizeArtistName(artist: string): string {
  return (artist || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ');
}

/** The artist a track counts under for artist spread: the credit's lead name (scoredMix.leadArtistKey). */
const spreadArtistKey = leadArtistKey;

function normalizeLooseKey(value: string): string {
  return (value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ');
}

function getSongDedupKey(track: { title?: string, artist?: string, mb_recording_id?: string }): string {
  if (track.mb_recording_id && track.mb_recording_id.trim() !== '') {
    return `mb:${track.mb_recording_id.trim().toLowerCase()}`;
  }
  return `meta:${normalizeArtistName(track.artist || '')}:${normalizeTitle(track.title || '')}`;
}

function getGenreRoot(row: any): string {
  const path = row.genre_path || row.genre || '';
  return normalizeLooseKey(String(path).split('.')[0] || path || 'unknown-genre');
}

function toSystemGenreSlug(genre: string): string {
  const slug = normalizeLooseKey(genre)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'genre';
}

function formatSystemGenreName(genre: string): string {
  return String(genre || 'Genre')
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((part) => {
      if (!part) return part;
      if (part === '&') return part;
      if (/^[A-Z0-9&-]+$/.test(part) && part.length <= 4) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(' ');
}

// Full-decade form for titles ("2010's"); the cover art derives its short
// numeral ("10's") from this client-side.
function formatDecadeTitleLabel(decade: number): string {
  return `${decade}'s`;
}

// "With artists like Tiësto, Armin van Buuren, Delerium..." from the mix's own
// (already relevance-ordered) tracks; falls back when too few distinct artists.
function topArtistsBlurb(rows: any[], fallback: string): string {
  const names: string[] = [];
  for (const r of rows) {
    const artist = String((r as any)?.artist || '').trim();
    if (artist && !names.includes(artist)) names.push(artist);
    if (names.length >= 3) break;
  }
  return names.length >= 2 ? `With artists like ${names.join(', ')}...` : fallback;
}

function getEngineHubGenerationIntervalMs(schedule: string | null | undefined): number | null {
  const normalized = String(schedule || 'Daily').trim().toLowerCase();
  const hourMs = 60 * 60 * 1000;

  switch (normalized) {
    case 'manual only':
      return null;
    case 'hourly':
      return hourMs;
    case 'every 2 hours':
    case 'every 2 hrs':
      return 2 * hourMs;
    case 'every 4 hours':
    case 'every 4 hrs':
      return 4 * hourMs;
    case 'weekly':
      return 7 * 24 * hourMs;
    case 'daily':
    default:
      return 24 * hourMs;
  }
}

function hashSystemOrder(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getEngineSystemPriority(collection: any): number {
  const id = String(collection?.id || '');
  if (id.startsWith('engine_upnext')) return 0;
  if (id.startsWith('engine_vault')) return 1;
  if (id.startsWith('engine_jumpback')) return 2;
  return 10;
}

function orderEngineSystemHubs(collections: any[], seed: string | number): any[] {
  return [...collections].sort((a, b) => {
    const priorityDelta = getEngineSystemPriority(a) - getEngineSystemPriority(b);
    if (priorityDelta !== 0) return priorityDelta;
    if (getEngineSystemPriority(a) < 10) return String(a.id || '').localeCompare(String(b.id || ''));
    return hashSystemOrder(`${seed}:${a.id || a.title}`) - hashSystemOrder(`${seed}:${b.id || b.title}`);
  });
}

function isEngineSystemPlaylist(playlist: any): boolean {
  return !!playlist?.isSystem && (playlist.generationSource || 'system') === 'system';
}

const defaultSystemPlaylistConfig = {
  upNext: true,
  vault: true,
  jumpBackIn: true,
  genreHeavyRotation: true,
  genreRediscovery: true,
  decadeMixes: true,
  decadeGenreMixes: true,
  // Smart-bundle rails (gated in smartHub.service); listed here only so
  // normalizeSystemPlaylistConfig round-trips them instead of dropping them.
  smartJumpBackIn: true,
  uniquelyYours: true,
  wrapped: true,
};

function normalizeSystemPlaylistConfig(value: unknown): Record<keyof typeof defaultSystemPlaylistConfig, boolean> {
  const parsed = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(
    Object.entries(defaultSystemPlaylistConfig).map(([key, defaultValue]) => [
      key,
      typeof parsed[key] === 'boolean' ? parsed[key] : defaultValue,
    ])
  ) as Record<keyof typeof defaultSystemPlaylistConfig, boolean>;
}

function isEnginePlaylistEnabled(id: string, config: Record<keyof typeof defaultSystemPlaylistConfig, boolean>): boolean {
  if (id.startsWith('engine_upnext')) return config.upNext;
  if (id.startsWith('engine_vault')) return config.vault;
  if (id.startsWith('engine_jumpback')) return config.jumpBackIn;
  if (id.startsWith('engine_genre-most')) return config.genreHeavyRotation;
  if (id.startsWith('engine_genre-stale')) return config.genreRediscovery;
  if (id.startsWith('engine_decade-genre')) return config.decadeGenreMixes;
  if (id.startsWith('engine_decade')) return config.decadeMixes;
  return true;
}

function normalizeTargetVector(vector: unknown): number[] | null {
  if (!Array.isArray(vector) || vector.length !== 8) {
    return null;
  }

  const normalized = vector.map((value) => Number(value));
  if (normalized.some((value) => !Number.isFinite(value))) {
    return null;
  }

  return normalized.map((value) => Math.min(1, Math.max(0, value)));
}

function parseAcousticVector(row: any): number[] | null {
  const raw = row?.acoustic_vector_text || row?.acoustic_vector_8d;
  if (!raw || typeof raw !== 'string') return null;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length < 8) return null;
    const normalized = parsed.slice(0, 8).map((value: unknown) => Number(value));
    if (normalized.some((value: number) => !Number.isFinite(value))) return null;
    return normalized;
  } catch {
    return null;
  }
}

function parseNumericVector(raw: unknown, expectedLength?: number): number[] | null {
  if (!raw || typeof raw !== 'string') return null;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (expectedLength !== undefined && parsed.length !== expectedLength) return null;
    const vector = parsed.map((value: unknown) => Number(value));
    if (vector.some((value) => !Number.isFinite(value))) return null;
    return vector;
  } catch {
    return null;
  }
}

function buildTasteProfileCentroids(rows: any[]): {
  acousticVectorStr: string;
  effnetVectorStr: string | null;
  acousticCount: number;
} | null {
  const acoustic = new Array(8).fill(0);
  const effnet = new Array(1280).fill(0);
  let acousticCount = 0;
  let effnetCount = 0;

  for (const row of rows) {
    const acousticVector = parseNumericVector(row.acoustic_vector_8d, 8);
    if (!acousticVector) continue;

    for (let i = 0; i < 8; i++) acoustic[i] += acousticVector[i];
    acousticCount++;

    const effnetVector = parseNumericVector(row.embedding_vector, 1280);
    if (effnetVector) {
      for (let i = 0; i < 1280; i++) effnet[i] += effnetVector[i];
      effnetCount++;
    }
  }

  if (acousticCount === 0) return null;

  const acousticCentroid = acoustic.map((value) => value / acousticCount);
  const effnetCentroid = effnetCount > 0
    ? effnet.map((value) => value / effnetCount)
    : null;

  return {
    acousticVectorStr: `[${acousticCentroid.join(',')}]`,
    effnetVectorStr: effnetCentroid ? `[${effnetCentroid.join(',')}]` : null,
    acousticCount,
  };
}

function getAcousticClusterKey(row: any): string {
  const vector = parseAcousticVector(row);
  if (!vector) return 'unknown';
  const bins = [vector[0], vector[4], vector[5], vector[6]].map((value) => Math.max(0, Math.min(3, Math.floor(value * 4))));
  return bins.join(':');
}

function acousticDistance(a: number[] | null, b: number[] | null): number | null {
  if (!a || !b || a.length !== b.length) return null;
  let sum = 0;
  for (let index = 0; index < a.length; index++) {
    const delta = a[index] - b[index];
    sum += delta * delta;
  }
  return Math.sqrt(sum / a.length);
}

/** A custom playlist's filters, normalised (see originFilterOf). Moods only lean. */
export interface OriginFilter {
  countries: string[];
  languages: string[];
  yearFrom: number | null;
  yearTo: number | null;
  vocals: string | null;
  moods: string[];
}

/** How much closer a track by an artist tagged with a requested mood ranks (distances run about 0.3–1.5). */
const MOOD_BOOST = 0.1;

const asYear = (value: unknown): number | null => {
  const year = Math.round(Number(value));
  return Number.isFinite(year) && year >= 1900 && year <= 2100 ? year : null;
};

/**
 * The hard filters a concept asks for, as ISO codes and years, or null when
 * it asks for none. Unknown spellings are dropped, so a model that writes
 * "Denmark" or "dansk" still filters on DK and da.
 */
export function originFilterOf(concept: { countries?: unknown; languages?: unknown; year_from?: unknown; year_to?: unknown; vocals?: unknown; moods?: unknown }): OriginFilter | null {
  const list = (value: unknown) => (Array.isArray(value) ? value : value == null ? [] : [value]).map(String);
  const countries = [...new Set(list(concept.countries).map(c => countryCode(c) ?? placeFromTag(c)).filter((c): c is string => !!c))];
  const languages = [...new Set(list(concept.languages).map(l => languageCode(l)).filter((l): l is string => !!l))];
  let yearFrom = asYear(concept.year_from);
  let yearTo = asYear(concept.year_to);
  if (yearFrom != null && yearTo != null && yearFrom > yearTo) [yearFrom, yearTo] = [yearTo, yearFrom];
  const vocals = vocalsOf(Array.isArray(concept.vocals) ? concept.vocals[0] : concept.vocals);
  const moods = [...new Set(list(concept.moods).map(m => moodOf(m)).filter((m): m is Mood => !!m))];
  if (!countries.length && !languages.length && yearFrom == null && yearTo == null && !vocals && !moods.length) return null;
  return { countries, languages, yearFrom, yearTo, vocals, moods };
}

/** Which kinds of track_origin data the library has at all. */
export interface OriginCoverage { places: boolean; years: boolean; vocals: boolean; moods: boolean }

/**
 * Drops the parts of a filter the library has no data for, so a request
 * never filters everything away: vocals and moods come from artist tags
 * (Last.fm, MusicBrainz), which an install without providers doesn't have;
 * places need MusicBrainz, artist tags or release-country file tags. With
 * some data, the filter stands, even if few tracks match. Returns the filter
 * (or null when nothing is left) and what was dropped, for the log.
 */
export function withinCoverage(filter: OriginFilter, coverage: OriginCoverage): { filter: OriginFilter | null; dropped: string[] } {
  const dropped: string[] = [];
  const next: OriginFilter = { ...filter };
  if (!coverage.places && (next.countries.length || next.languages.length)) {
    dropped.push('countries and languages'); next.countries = []; next.languages = [];
  }
  if (!coverage.years && (next.yearFrom != null || next.yearTo != null)) {
    dropped.push('years'); next.yearFrom = null; next.yearTo = null;
  }
  if (!coverage.vocals && next.vocals) { dropped.push('vocals'); next.vocals = null; }
  if (!coverage.moods && next.moods.length) { dropped.push('moods'); next.moods = []; }
  const empty = !next.countries.length && !next.languages.length && next.yearFrom == null && next.yearTo == null && !next.vocals && !next.moods.length;
  return { filter: empty ? null : next, dropped };
}

async function originCoverage(): Promise<OriginCoverage> {
  const row = (await queryWithRetry(`
    SELECT EXISTS (SELECT 1 FROM track_origin WHERE country IS NOT NULL OR language IS NOT NULL) AS places,
           EXISTS (SELECT 1 FROM track_origin WHERE decade IS NOT NULL) AS years,
           EXISTS (SELECT 1 FROM track_origin WHERE vocals IS NOT NULL) AS vocals,
           EXISTS (SELECT 1 FROM track_origin WHERE moods IS NOT NULL) AS moods`, [])).rows[0];
  return { places: !!row?.places, years: !!row?.years, vocals: !!row?.vocals, moods: !!row?.moods };
}

export function describeOriginFilter(filter: OriginFilter): string {
  const parts: string[] = [];
  if (filter.countries.length || filter.languages.length) parts.push(`from ${[...filter.countries, ...filter.languages.map(l => `language ${l}`)].join(' or ')}`);
  if (filter.yearFrom != null || filter.yearTo != null) parts.push(`years ${filter.yearFrom ?? '…'}–${filter.yearTo ?? '…'}`);
  if (filter.vocals) parts.push(`${filter.vocals} vocals`);
  if (filter.moods.length) parts.push(`leaning ${filter.moods.join(', ')}`);
  return parts.join(', ');
}

export async function getHubCollections(
  llmConcepts: {
    section: string, title?: string, description: string, target_vector: number[], target_genres?: string[], banned_genres?: string[],
    /** Hard filters (custom playlists): where the music is from, what it's sung in, and when it came out. */
    countries?: string[], languages?: string[], year_from?: number, year_to?: number,
    /** By the artists' tags: vocals a hard filter, moods a preference. */
    vocals?: string, moods?: string[],
    /** What the request is mainly about: 0 mood or activity, 1 genre or style (aiPlaylistScore.focusOf). */
    focus?: number,
    /** How the music should sound on the five moods from the sound, 0–1 (aiPlaylistScore.moodTargetOf). */
    sound_moods?: Record<string, number>,
    /** A special list: built only from this theme's tracks, and only when enough of them fit (specialLists.service). */
    special?: Theme,
  }[],
  userId: string | null = null,
  settings: {
    llmGenreCohesion?: number,
    llmDiscoveryBias?: number,
    llmArtistSpread?: number,
    llmRecoveryStrength?: number,
    llmAdjacentReach?: number,
    llmTracksPerPlaylist?: number,
    llmPlaylistDiversity?: number,
    llmVetoMode?: 'hard' | 'adaptive',
    llmGenerationSource?: 'hub' | 'custom',
    /** false: build and return the playlists without saving them (comparisons, previews). */
    persist?: boolean,
    /**
     * true: mood-led requests (the AI's focus and moods from the sound in the
     * score). Off until the blind comparison ("Mood test 01–10") decides;
     * off = the engine as before: no mood term, focus ignored.
     */
    moodTerm?: boolean,
  } = {}
) {
  // Style vectors for genre references ("electronic.house"), read once per name.
  const nameStyleCache = new Map<string, Promise<StyleVector | null>>();
  const styleRefFor = (reference: string) => {
    const key = reference.toLowerCase();
    if (!nameStyleCache.has(key)) nameStyleCache.set(key, initDB().then(db => styleVectorForNames(db, [reference])));
    return nameStyleCache.get(key)!;
  };
  const hubs: any[] = [];

  const genreBlend = (settings.llmGenreCohesion ?? 50) / 100; // 0.0 to 1.0
  const discoveryBias = (settings.llmDiscoveryBias ?? 45) / 100; // 0.0 to 1.0
  const artistSpread = (settings.llmArtistSpread ?? 70) / 100; // 0.0 to 1.0
  const recoveryStrength = (settings.llmRecoveryStrength ?? 50) / 100; // 0.0 to 1.0
  const adjacentReach = (settings.llmAdjacentReach ?? 50) / 100; // 0.0 to 1.0
  const tracksPerPlaylist = settings.llmTracksPerPlaylist ?? 10;
  const diversity = (settings.llmPlaylistDiversity ?? 50) / 100; // 0.0 to 1.0
  const allowSoftVetoRecovery = settings.llmVetoMode === 'adaptive';
  // Genre paths from the fused genres and styles ("electronic.house").
  const genrePathJoinSql = `
    LEFT JOIN genres canonical_genre ON canonical_genre.id = t.genre_id
    ${trackGenrePathsJoin('t')}
  `;
  const normalizedTitleSql = `regexp_replace(trim(regexp_replace(lower(coalesce(t.title, '')), '[^[:alnum:]]+', ' ', 'g')), '[[:space:]]+', ' ', 'g')`;
  const structuralTitleCue = `(intro|outro|interlude|skit|prelude|prologue|epilogue|segue|transition)`;
  const llmPlayableTrackSql = `
    t.duration > 90
    AND NOT (
      ${normalizedTitleSql} ~ '^(the )?${structuralTitleCue}( [0-9ivx]+)?( .*)?$'
      OR (
        t.duration < 240
        AND ${normalizedTitleSql} ~ '(^| )${structuralTitleCue}( |$)'
      )
    )
  `;

  // Helper: re-rank a pool of tracks by sound and shared styles (phase 4 of
  // the genre redesign). Shared styles with the reference (a genre path, or
  // `styleRef` from seed tracks) pull a track closer by β · cos, with
  // β = weight × 0.2; changing genre never counts against a track.
  // bannedPaths: normally an absolute veto; optionally a strong penalty in adaptive recovery mode.
  const reRankByStyle = async (
    rows: any[],
    referenceGenre: string,
    limit: number,
    blendWeight?: number,
    bannedPaths?: string[],
    softVeto = false,
    styleRef?: StyleVector | null,
  ) => {
    const weight = blendWeight ?? genreBlend;
    const reference = styleRef !== undefined ? styleRef : referenceGenre ? await styleRefFor(referenceGenre) : null;
    const candidateStyles = reference ? await styleVectors(await initDB(), rows.map(row => row.id).filter(Boolean)) : null;
    const beta = styleBeta(weight * 100);
    const scored = rows.map(row => {
      const isBanned = isRowBanned(row, bannedPaths ?? []);
      if (isBanned && !softVeto) return { ...row, combined: Infinity };
      const distance = Number(row.distance ?? 0);
      const vetoPenalty = isBanned ? (1.75 + weight) : 1;
      const styleOverlap = styleCosine(reference, candidateStyles?.get(row.id));
      const combined = (distance * vetoPenalty) + (isBanned ? 0.15 : 0) - beta * styleOverlap - Number(row.pool_bias ?? 0);
      return { ...row, styleOverlap, combined };
    }).filter(row => Number.isFinite(row.combined));
    scored.sort((a, b) => a.combined - b.combined);
    return scored.slice(0, limit);
  };

  const selectDiverseTracks = (
    scoredRows: any[],
    count: number,
    wanderStrength: number,
    maxTracksPerArtist: number,
    poolTargets: Map<string, number> = new Map(),
    options: {
      discoveryBias: number;
      artistSpread: number;
      /** How well a row fits, 0 = best; default its rank as a fraction of the list. The scored engine passes its score, in spreads. */
      fitOf?: (row: any) => number;
      /**
       * Scales the sound-variety terms (genre root, sound cluster, similarity).
       * The scored engine lowers it: its fit is in spreads, and at full weight
       * ten tracks of one style in one sound cluster pushed the next one out
       * for music outside the concept.
       */
      varietyWeight?: number;
      /** The novelty bonus is already in fitOf. */
      noveltyInFit?: boolean;
    } = { discoveryBias: 0.45, artistSpread: 0.70 }
  ): { selected: any[]; diversityScore: number; diagnostics: { distinctArtists: number; distinctAlbums: number; distinctRoots: number; distinctPools: number; distinctClusters: number; meanPairwiseDistance: number; } } => {
    const selected: any[] = [];
    const selectedSongKeys = new Set<string>();
    const artistCounts = new Map<string, number>();
    const albumCounts = new Map<string, number>();
    const rootCounts = new Map<string, number>();
    const poolCounts = new Map<string, number>();
    const clusterCounts = new Map<string, number>();
    const rankBySong = new Map<string, number>();
    const selectedVectors: number[][] = [];

    scoredRows.forEach((row, index) => {
      const key = getSongDedupKey(row);
      if (!rankBySong.has(key)) rankBySong.set(key, index);
    });

    const pickOne = (enforceArtistCap: boolean): boolean => {
      const candidates = scoredRows.filter((row) => {
        const songKey = getSongDedupKey(row);
        if (selectedSongKeys.has(songKey)) return false;

        const artistKey = spreadArtistKey(row.artist || 'unknown-artist');
        if (enforceArtistCap && (artistCounts.get(artistKey) ?? 0) >= maxTracksPerArtist) {
          return false;
        }

        return true;
      });

      if (candidates.length === 0) return false;

      const windowSize = Math.min(candidates.length, Math.max(60, count * 8));
      const window = candidates.slice(0, windowSize);
      let best = window[0];
      let bestScore = Infinity;

      for (const candidate of window) {
        const songKey = getSongDedupKey(candidate);
        const artistKey = spreadArtistKey(candidate.artist || 'unknown-artist');
        const albumKey = normalizeLooseKey(candidate.album || candidate.album_title || '');
        const rootKey = getGenreRoot(candidate);
        const poolKey = String(candidate.pool_source || 'acoustic');
        const clusterKey = getAcousticClusterKey(candidate);
        const candidateVector = parseAcousticVector(candidate);
        const rank = rankBySong.get(songKey) ?? scoredRows.length;
        const fitScore = options.fitOf ? options.fitOf(candidate) : rank / Math.max(1, scoredRows.length - 1);
        const artistPenalty = (artistCounts.get(artistKey) ?? 0) * (0.65 + (options.artistSpread * 0.70));
        const albumPenalty = albumKey ? (albumCounts.get(albumKey) ?? 0) * (0.22 + (options.artistSpread * 0.18)) : 0;
        const variety = options.varietyWeight ?? 1;
        const rootPenalty = (rootCounts.get(rootKey) ?? 0) * 0.06 * variety;
        const clusterPenalty = (clusterCounts.get(clusterKey) ?? 0) * 0.38 * variety;
        const desiredPoolCount = poolTargets.get(poolKey) ?? 0;
        const currentPoolCount = poolCounts.get(poolKey) ?? 0;
        const poolPenalty = desiredPoolCount > 0
          ? Math.max(0, (currentPoolCount + 1) - desiredPoolCount) * 0.25
          : currentPoolCount * 0.08;
        const poolBonus = desiredPoolCount > currentPoolCount ? 0.06 : 0;
        const poolBias = Number(candidate.pool_bias ?? 0);
        const noveltyBonus = options.noveltyInFit ? 0 : Math.min(0.18, Number(candidate.novelty_boost ?? 0) * (0.55 + (options.discoveryBias * 0.90)));
        const newArtistBonus = (artistCounts.get(artistKey) ?? 0) === 0 ? (0.04 + (options.artistSpread * 0.10)) : 0;
        const pairwiseDistances = selectedVectors
          .map((vector) => acousticDistance(candidateVector, vector))
          .filter((value): value is number => value !== null);
        const meanDistance = pairwiseDistances.length > 0
          ? pairwiseDistances.reduce((sum, value) => sum + value, 0) / pairwiseDistances.length
          : 0.30;
        const similarityPenalty = pairwiseDistances.length > 0
          ? Math.max(0, 0.20 - meanDistance) * 2.2 * variety
          : 0;
        const diversityBonus = (pairwiseDistances.length > 0 ? Math.min(0.14, meanDistance * 0.45) : 0.04) * variety;
        const randomBonus = Math.random() * wanderStrength * 0.18;
        const score =
          fitScore +
          artistPenalty +
          albumPenalty +
          rootPenalty +
          clusterPenalty +
          similarityPenalty +
          poolPenalty -
          poolBonus -
          poolBias -
          noveltyBonus -
          newArtistBonus -
          diversityBonus -
          randomBonus;

        if (score < bestScore) {
          bestScore = score;
          best = candidate;
        }
      }

      const songKey = getSongDedupKey(best);
      const artistKey = spreadArtistKey(best.artist || 'unknown-artist');
      const albumKey = normalizeLooseKey(best.album || best.album_title || '');
      const rootKey = getGenreRoot(best);
      const poolKey = String(best.pool_source || 'acoustic');
      const clusterKey = getAcousticClusterKey(best);
      const vector = parseAcousticVector(best);

      selected.push(best);
      selectedSongKeys.add(songKey);
      artistCounts.set(artistKey, (artistCounts.get(artistKey) ?? 0) + 1);
      if (albumKey) albumCounts.set(albumKey, (albumCounts.get(albumKey) ?? 0) + 1);
      rootCounts.set(rootKey, (rootCounts.get(rootKey) ?? 0) + 1);
      poolCounts.set(poolKey, (poolCounts.get(poolKey) ?? 0) + 1);
      clusterCounts.set(clusterKey, (clusterCounts.get(clusterKey) ?? 0) + 1);
      if (vector) selectedVectors.push(vector);
      return true;
    };

    while (selected.length < count && pickOne(true)) {}
    while (selected.length < count && pickOne(false)) {}

    const pairwiseDistances: number[] = [];
    for (let left = 0; left < selectedVectors.length; left++) {
      for (let right = left + 1; right < selectedVectors.length; right++) {
        const distance = acousticDistance(selectedVectors[left], selectedVectors[right]);
        if (distance !== null) pairwiseDistances.push(distance);
      }
    }
    const meanPairwiseDistance = pairwiseDistances.length > 0
      ? pairwiseDistances.reduce((sum, value) => sum + value, 0) / pairwiseDistances.length
      : 0;

    const distinctArtists = artistCounts.size;
    const distinctAlbums = albumCounts.size;
    const distinctRoots = rootCounts.size;
    const distinctPools = poolCounts.size;
    const distinctClusters = clusterCounts.size;
    const diversityScore = Math.max(0, Math.min(1,
      (distinctArtists / Math.max(1, selected.length)) * 0.32 +
      (distinctAlbums / Math.max(1, selected.length)) * 0.12 +
      (distinctRoots / Math.max(1, Math.min(selected.length, 4))) * 0.10 +
      (distinctPools / Math.max(1, Math.min(selected.length, 5))) * 0.14 +
      (distinctClusters / Math.max(1, Math.min(selected.length, 5))) * 0.14 +
      Math.min(1, meanPairwiseDistance / 0.28) * 0.18
    ));

    return {
      selected,
      diversityScore,
      diagnostics: {
        distinctArtists,
        distinctAlbums,
        distinctRoots,
        distinctPools,
        distinctClusters,
        meanPairwiseDistance,
      },
    };
  };

  const libraryProfile = await getLibraryProfile();

  // Track already-assigned track IDs across LLM concepts to prevent duplicate playlists
  const assignedTrackIds = new Set<string>();
  const assignedSongKeys = new Set<string>();

  const fetchLlmPool = async ({
    poolName,
    vectorStr,
    embeddingCentroidStr,
    effnetWeight,
    limit,
    pathPrefixes = [],
    excludeIds = [],
    excludePrefixes = [],
    enableDiscoveryBoost = false,
    origin = null,
    restrictIds,
    includeNovelty = false,
    withPaths = true,
    members,
    moodOrder,
    activitySql,
  }: {
    poolName: 'core' | 'adjacent' | 'root' | 'acoustic' | 'discovery' | 'bridge' | 'score';
    vectorStr: string;
    embeddingCentroidStr: string | null;
    effnetWeight: number;
    limit: number;
    pathPrefixes?: string[];
    excludeIds?: string[];
    excludePrefixes?: string[];
    enableDiscoveryBoost?: boolean;
    origin?: OriginFilter | null;
    /** Only these tracks (the scored engine's second pass). */
    restrictIds?: string[];
    /** Compute the novelty bonus without ordering by it. */
    includeNovelty?: boolean;
    /** Genre paths per row (a lateral per row: leave out on whole-library passes). */
    withPaths?: boolean;
    /** Only members of these styles or genres at this strength or more. */
    members?: { styleIds: number[]; genres: string[]; minStrength: number };
    /** Order by how well the moods from the sound fit (then by sound), instead of by sound. */
    moodOrder?: MoodTarget | null;
    /** An activity theme's condition on the sound (specialLists.ACTIVITIES; `mo` = track_moods, `tf`, `t`). */
    activitySql?: string;
  }): Promise<any[]> => {
    if (limit <= 0) return [];
    if (restrictIds && restrictIds.length === 0) return [];

    const params: any[] = [vectorStr];
    let nextParam = 2;

    const requiresEmbedding = Boolean(embeddingCentroidStr);
    const distanceSql = requiresEmbedding
      ? `(tf.acoustic_vector_8d <-> $1::vector) + ((tf.embedding_vector <=> $2::vector) * ${effnetWeight})`
      : `tf.acoustic_vector_8d <-> $1::vector`;

    if (requiresEmbedding) {
      params.push(embeddingCentroidStr);
      nextParam++;
    }

    let joinSql = withPaths ? genrePathJoinSql : `LEFT JOIN genres canonical_genre ON canonical_genre.id = t.genre_id`;
    let noveltySql = '0.0';

    if (enableDiscoveryBoost || includeNovelty) {
      if (userId) {
        params.push(userId);
        joinSql += ` LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $${nextParam}`;
        nextParam++;
        noveltySql = `
          (
            CASE
              WHEN ups.play_count IS NULL OR ups.play_count = 0 THEN 0.16
              ELSE GREATEST(0.0, 0.10 - LEAST(ups.play_count, 8) * 0.012)
            END
          ) + (
            CASE
              WHEN ups.last_played_at IS NULL THEN 0.08
              WHEN ups.last_played_at < NOW() - INTERVAL '180 days' THEN 0.08
              WHEN ups.last_played_at < NOW() - INTERVAL '60 days' THEN 0.04
              ELSE 0.0
            END
          )
        `;
      } else {
        noveltySql = `
          (
            CASE
              WHEN COALESCE(t.play_count, 0) = 0 THEN 0.14
              ELSE GREATEST(0.0, 0.08 - LEAST(COALESCE(t.play_count, 0), 8) * 0.010)
            END
          ) + (
            CASE
              WHEN t.last_played_at IS NULL THEN 0.06
              WHEN t.last_played_at < NOW() - INTERVAL '180 days' THEN 0.06
              WHEN t.last_played_at < NOW() - INTERVAL '60 days' THEN 0.03
              ELSE 0.0
            END
          )
        `;
      }
    }

    const whereClauses = [
      `tf.acoustic_vector_8d IS NOT NULL`,
      llmPlayableTrackSql,
    ];

    if (requiresEmbedding) {
      whereClauses.push(`tf.embedding_vector IS NOT NULL`);
    }

    if (pathPrefixes.length > 0) {
      params.push(pathPrefixes);
      whereClauses.push(pathsMatchSql(`$${nextParam}`));
      nextParam++;
    }

    if (excludePrefixes.length > 0) {
      params.push(excludePrefixes);
      whereClauses.push(`NOT ${pathsMatchSql(`$${nextParam}`)}`);
      nextParam++;
    }

    if (excludeIds.length > 0) {
      params.push(excludeIds);
      whereClauses.push(`NOT (t.id = ANY($${nextParam}::text[]))`);
      nextParam++;
    }

    if (restrictIds) {
      params.push(restrictIds);
      whereClauses.push(`t.id = ANY($${nextParam}::text[])`);
      nextParam++;
    }

    if (activitySql) {
      whereClauses.push(`EXISTS (SELECT 1 FROM track_moods mo WHERE mo.track_id = t.id AND ${activitySql})`);
    }

    if (members) {
      params.push(members.styleIds, members.genres, members.minStrength);
      whereClauses.push(`EXISTS (SELECT 1 FROM track_styles ms WHERE ms.track_id = t.id
        AND (ms.style_id = ANY($${nextParam}::int[]) OR (ms.style_id IS NULL AND ms.genre = ANY($${nextParam + 1}::text[])))
        AND ms.strength >= $${nextParam + 2})`);
      nextParam += 3;
    }

    // "Dansk rap fra 90'erne med kvindelig vokal" (track_origin): a country or
    // a language asked for, the years (the original release year; a track
    // known only by its artist's era tag counts when that decade overlaps),
    // and the vocals. Hard filters, through every relaxation step: a Danish
    // playlist never backfills with other music.
    const narrow: string[] = [];
    if (origin && (origin.countries.length > 0 || origin.languages.length > 0)) {
      params.push(origin.countries, origin.languages);
      narrow.push(`(o.country = ANY($${nextParam}::text[]) OR o.language = ANY($${nextParam + 1}::text[]))`);
      nextParam += 2;
    }
    if (origin?.yearFrom != null) {
      params.push(origin.yearFrom);
      narrow.push(`COALESCE(o.year, o.decade + 9) >= $${nextParam}`);
      nextParam++;
    }
    if (origin?.yearTo != null) {
      params.push(origin.yearTo);
      narrow.push(`COALESCE(o.year, o.decade) <= $${nextParam}`);
      nextParam++;
    }
    if (origin?.vocals) {
      params.push(origin.vocals);
      narrow.push(`$${nextParam} = ANY(o.vocals)`);
      nextParam++;
    }
    if (narrow.length > 0) {
      whereClauses.push(`EXISTS (SELECT 1 FROM track_origin o WHERE o.track_id = t.id AND ${narrow.join(' AND ')})`);
    }
    // Moods only lean: an artist tagged with one ranks a little closer; the
    // target sound still decides.
    let moodBoostSql = '0';
    if (origin && origin.moods.length > 0) {
      params.push(origin.moods);
      moodBoostSql = `(CASE WHEN EXISTS (SELECT 1 FROM track_origin om WHERE om.track_id = t.id AND om.moods && $${nextParam}::text[]) THEN ${MOOD_BOOST} ELSE 0 END)`;
      nextParam++;
    }

    params.push(limit);
    const limitParam = nextParam;
    nextParam++;
    let moodDistanceSql = 'NULL::float8';
    if (moodOrder) {
      const parts: string[] = [];
      for (const [mood, want] of Object.entries(moodOrder)) {
        params.push(want);
        parts.push(`abs(${soundQualitySql(mood as SoundQuality)} - $${nextParam}::float8)`);
        nextParam++;
      }
      joinSql += ` JOIN track_moods mo ON mo.track_id = t.id`;
      moodDistanceSql = `((${parts.join(' + ')}) / ${parts.length})`;
    }
    const orderSql = moodOrder ? `mood_distance, distance` : enableDiscoveryBoost ? `(distance - novelty_boost)` : `distance`;
    const poolBiasByName: Record<string, number> = {
      core: 0.11,
      adjacent: 0.07,
      root: 0.055,
      acoustic: 0.03,
      bridge: 0.05,
      discovery: 0.06,
      score: 0,
    };

    const res = await queryWithRetry(`
      SELECT * FROM (
        SELECT
          t.*,
          COALESCE(canonical_genre.name, t.genre) AS genre,
          ${withPaths ? 'tgp.genre_path' : 'NULL::text AS genre_path'},
          ${withPaths ? 'tgp.genre_paths' : 'NULL::text[] AS genre_paths'},
          tf.acoustic_vector_8d::text AS acoustic_vector_text,
          (${distanceSql}) - ${moodBoostSql} AS distance,
          ${noveltySql} AS novelty_boost,
          ${moodDistanceSql} AS mood_distance,
          '${poolName}'::text AS pool_source,
          ${poolBiasByName[poolName]}::float8 AS pool_bias
        FROM tracks t
        JOIN track_features tf ON t.id = tf.track_id
        ${joinSql}
        WHERE ${whereClauses.join('\n          AND ')}${christmasExclusionSql('t')}
      ) pool
      ORDER BY ${orderSql} ASC
      LIMIT $${limitParam}
    `, params);

    return res.rows;
  };

  // The AI's 8 numbers become an embedding target through scoredMix.imputeEffNetCentroid.

  // Generate tracks for each LLM concept and persist them as Playlists
  // What filters the library can honour; read once, when a concept asks for one.
  let coverage: OriginCoverage | null = null;
  for (const concept of llmConcepts) {
    // Case B: LLM High-Concept generated concept (e.g. "Evening Acoustic Drift")
    if (concept.target_vector) {
      const targetVector = normalizeTargetVector(concept.target_vector);
      if (!targetVector) {
        console.warn(`[LLM Hub] Dropping playlist "${concept.title}" - invalid target_vector. Expected 8 finite numbers.`);
        (concept as any).dropped = true;
        continue;
      }

      const compiled = await compileConceptToLibrary(
        {
          ...concept,
          target_vector: targetVector,
          target_genres: (concept as any).target_genres || [],
          banned_genres: (concept as any).banned_genres || [],
        },
        libraryProfile,
        {
          requestedGenreBlend: genreBlend,
          tracksPerPlaylist,
          adjacentReach,
        }
      );

      const asked = originFilterOf(concept);
      let originFilter: OriginFilter | null = null;
      if (asked) {
        coverage ??= await originCoverage();
        const within = withinCoverage(asked, coverage);
        originFilter = within.filter;
        if (within.dropped.length) {
          console.log(`[LLM Hub] "${concept.title}" → ignoring ${within.dropped.join(', ')}: this library has no such data (artist tags come from Last.fm or MusicBrainz)`);
        }
        if (originFilter) console.log(`[LLM Hub] "${concept.title}" → ${describeOriginFilter(originFilter)}`);
      }
      const vectorStr = `[${compiled.adaptedTargetVector.join(',')}]`;
      const targetAcousticness = compiled.adaptedTargetVector[5];
      const effnetWeight = targetAcousticness < 0.3 ? 3.0 : 1.0;
      const embeddingCentroidStr = await imputeEffNetCentroid(vectorStr);

      const assignedIds = Array.from(assignedTrackIds);

      if (compiled.diagnostics.notes.length > 0) {
        console.log(`[LLM Hub] "${concept.title}" → ${compiled.diagnostics.notes.join(' ')}`);
      }
      // A special list's theme is the specific part (Hip Hop from Denmark), not its genre.
      if (compiled.diagnostics.shouldRegenerate && !concept.special) {
        console.warn(`[LLM Hub] Dropping playlist "${concept.title}" - low-quality concept compile (score=${compiled.diagnostics.qualityScore.toFixed(2)}). ${compiled.diagnostics.regenerateReason || ''}`.trim());
        (concept as any).dropped = true;
        continue;
      }

      let topTracks: any[] = [];
      {
        // One score over a bounded candidate set (docs/Aurora genre and style
        // redesign.md, AI playlists): the nearest by sound, plus the target
        // styles' strong members nearest in sound (and their weaker members
        // when the library has few strong ones), then scored together.
        const db = await initDB();
        const L = tracksPerPlaylist;
        // What the request is mainly about (the AI's focus, 0 mood … 1 genre):
        // a mood request lets style count less, counts a target's genre nearly
        // as much as the style itself, and aims at the AI's sound.
        const moodLed = settings.moodTerm === true;
        const focus = focusOf(concept.focus);
        // How the music should sound (moods from the sound: sad = tender or
        // wistful, whatever the lyrics). It weighs most in a mood request.
        const moodTarget = moodLed ? moodTargetOf(concept.sound_moods) : null;
        const styles = await conceptStyles(db, compiled.corePaths, adjacentReach, moodLed ? focus : 1);
        const hasTargets = styles.styleIds.length + styles.genres.length > 0;
        // The sound to aim at: the AI's 8 numbers, and an embedding between
        // the target styles' own sound (centroids) and the one imputed from
        // the AI's numbers. Styles alone lost the mood ("melancholic indie
        // rock" came out upbeat, "music for code" with vocals); the imputed
        // embedding alone pointed a trance concept at R&B.
        const embeddingTarget = blendEmbeddings(styles.centroid, embeddingCentroidStr, moodLed ? styleSoundShare(focus) : 0.5);
        const base = { origin: originFilter, poolName: 'score' as const, vectorStr, embeddingCentroidStr: embeddingTarget, effnetWeight, excludeIds: assignedIds };
        const small = libraryProfile.analyzedTracks < 2000;
        let soundLimit = small ? libraryProfile.analyzedTracks + 1 : Math.max(10 * L, 300);
        let memberLimit = Math.max(8 * L, 200);
        const widenings = recoveryStrength > 0 ? 1 : 0;
        let rows: any[] = [];
        let strongIds = new Set<string>();
        let counts = { sound: 0, strong: 0, weak: 0, mood: 0 };
        // A custom request that names a theme with hard filters ("Dansk rap
        // fra 90'erne") is made only when the library has enough of it:
        // otherwise Aurora says how much there is instead of padding the list.
        if (!concept.special && (settings.llmGenerationSource ?? 'hub') === 'custom' && hasTargets && hasHardFilter(originFilter)) {
          const found = await fetchLlmPool({ ...base, limit: 4 * L, withPaths: false, members: { styleIds: styles.styleIds, genres: styles.genres, minStrength: 0 } });
          const songs = new Set(found.map(getSongDedupKey)).size;
          if (songs < L) {
            const named = (await db.query('SELECT id, name FROM style WHERE id = ANY($1::int[])', [styles.styleIds])).rows as Array<{ id: number; name: string }>;
            const names = [...styles.styleIds.map(id => named.find(r => r.id === id)?.name).filter((n): n is string => !!n), ...styles.genres];
            const support = thinRequest(names, originFilter, { songs, artists: new Set(found.map((r: any) => spreadArtistKey(r.artist || ''))).size }, L);
            console.warn(`[LLM Hub] Custom request "${concept.title}" not made: ${support.message}`);
            (concept as any).dropped = true;
            (concept as any).dropReason = 'too-thin';
            (concept as any).support = support;
            continue;
          }
        }
        const special = concept.special;
        if (special) {
          // Only the theme's own tracks: its style's (or genre's) strong
          // members, narrowed by the theme's country or decade through the
          // concept's filters, or the tracks an activity's sound calls for.
          const limit = small ? libraryProfile.analyzedTracks + 1 : Math.max(15 * L, 500);
          const members = special.activity
            ? await fetchLlmPool({ ...base, limit, withPaths: false, activitySql: ACTIVITIES[special.activity].sql })
            : await fetchLlmPool({ ...base, limit, withPaths: false, members: {
              styleIds: special.styleId ? [special.styleId] : [], genres: special.styleId ? [] : [special.genre ?? ''], minStrength: STRONG_MEMBER,
            } });
          strongIds = new Set(members.map((r: any) => String(r.id)));
          counts = { sound: 0, strong: members.length, weak: 0, mood: 0 };
          rows = (await fetchLlmPool({ ...base, limit: members.length, restrictIds: [...strongIds], includeNovelty: true }))
            .filter((r: any) => !assignedSongKeys.has(getSongDedupKey(r)));
        }
        for (let attempt = 0; !special && attempt <= widenings; attempt++) {
          const members = { styleIds: styles.styleIds, genres: styles.genres };
          const [sound, strong, byMood] = await Promise.all([
            fetchLlmPool({ ...base, limit: soundLimit, withPaths: false }),
            hasTargets ? fetchLlmPool({ ...base, limit: memberLimit, withPaths: false, members: { ...members, minStrength: STRONG_MEMBER } }) : Promise.resolve([]),
            // The tracks whose moods fit best, from anywhere: a mood request
            // ("music for code") can find them outside the target styles.
            moodTarget ? fetchLlmPool({ ...base, limit: memberLimit, withPaths: false, moodOrder: moodTarget }) : Promise.resolve([]),
          ]);
          // Relative floor: too few strong members, so the weaker ones count too.
          const weak = hasTargets && new Set(strong.map(getSongDedupKey)).size < 2 * L
            ? await fetchLlmPool({ ...base, limit: memberLimit, withPaths: false, members: { ...members, minStrength: 0 } })
            : [];
          // Support: the strong members, or (relative floor) the weaker ones too.
          strongIds = new Set([...strong, ...weak].map((r: any) => String(r.id)));
          counts = { sound: sound.length, strong: strong.length, weak: weak.length, mood: byMood.length };
          const ids = [...new Set([...sound, ...strong, ...weak, ...byMood].map((r: any) => String(r.id)))];
          rows = (await fetchLlmPool({ ...base, limit: ids.length, restrictIds: ids, includeNovelty: true }))
            .filter((r: any) => !assignedSongKeys.has(getSongDedupKey(r)));
          const allowed = rows.filter((r: any) => !isRowBanned(r, compiled.bannedGenres));
          const songs = new Set(allowed.map(getSongDedupKey)).size;
          const artists = new Set(allowed.map((r: any) => spreadArtistKey(r.artist || ''))).size;
          if (small || (songs >= 3 * L && artists >= Math.ceil(L / 2))) break;
          // Short: widen once, as far as Recovery Strength allows.
          soundLimit = Math.ceil(soundLimit * (1 + 2 * recoveryStrength));
          memberLimit = Math.ceil(memberLimit * (1 + 2 * recoveryStrength));
        }

        let allowed = rows.filter((r: any) => !isRowBanned(r, compiled.bannedGenres));
        if (special) {
          // Dry run: the theme's tracks within the nearest three quarters by
          // sound fit. Too few songs or artists, and the list is not made.
          const distances = allowed.map((r: any) => Number(r.distance)).filter(Number.isFinite).sort((a, b) => a - b);
          const cut = distances[Math.max(0, Math.ceil(distances.length * SPECIAL_FIT_SHARE) - 1)] ?? -Infinity;
          const fits = allowed.filter((r: any) => Number(r.distance) <= cut);
          const fitSongs = new Set(fits.map(getSongDedupKey)).size;
          const fitArtists = new Set(fits.map((r: any) => spreadArtistKey(r.artist || ''))).size;
          if (fitSongs < L || fitArtists < Math.ceil(L / 2)) {
            console.warn(`[LLM Hub] Special list "${concept.title}" (${special.label}) not made: ${fitSongs} fitting songs from ${fitArtists} artists, needs ${L} from ${Math.ceil(L / 2)}.`);
            (concept as any).dropped = true;
            (concept as any).dropReason = 'too-few-fitting';
            continue;
          }
          allowed = fits;
        }
        let softVeto = false;
        if (new Set(allowed.map(getSongDedupKey)).size < L && allowSoftVetoRecovery && compiled.bannedGenres.length) {
          allowed = rows;
          softVeto = true;
        }
        const support = new Set(allowed.filter((r: any) => strongIds.has(String(r.id))).map(getSongDedupKey)).size;
        const beta = scoreBeta(genreBlend, support, L, moodLed ? focus : 1);
        const memberships = await trackMemberships(db, allowed.map((r: any) => String(r.id)));
        const moods = moodTarget ? await trackMoods(db, allowed.map((r: any) => String(r.id))) : new Map();
        const moodWeight = moodBeta(focus, Boolean(moodTarget));
        const ranked = rankByScore(allowed, {
          match: (r: any) => conceptMatch(styles.weights, memberships.get(String(r.id))),
          mood: (r: any) => moodMatch(moodTarget, moods.get(String(r.id))),
          moodBeta: moodWeight,
          moodGate: hasTargets,
          beta,
          nu: discoveryBias,
          penalty: softVeto ? (r: any) => (isRowBanned(r, compiled.bannedGenres) ? 1 : 0) : undefined,
        }).map(r => ({ ...r, pool_source: 'score', pool_bias: 0 }));

        // Artists who actually fit (match ≥ 0.5): with few of them, each may
        // bring more tracks before the list reaches outside the concept.
        const fitting = ranked.filter((r: any) => r.styleMatch >= 0.5);
        const artistsAvailable = new Set((fitting.length ? fitting : ranked).map((r: any) => spreadArtistKey(r.artist || ''))).size;
        const bestScore = ranked[0]?.score ?? 0;
        // A genre request on a thin theme (Danish 90s rap: about 8 artists)
        // takes another track by a fitting artist before music outside the
        // genre: Artist Spread counts in proportion to the fitting artists.
        // Without mood-led requests every request is a genre request.
        const thinGenreRequest = (!moodLed || focus >= 0.7) && fitting.length > 0 && artistsAvailable < L;
        const spreadForPick = thinGenreRequest ? artistSpread * artistsAvailable / L : artistSpread;
        const selection = selectDiverseTracks(ranked, L, diversity, artistCap(L, artistsAvailable, artistSpread), new Map([['score', L]]), {
          discoveryBias,
          artistSpread: spreadForPick,
          fitOf: (r: any) => r.score - bestScore,
          // Playlist Diversity sets how much sound variety counts against fit.
          varietyWeight: diversity * 0.5,
          noveltyInFit: true,
        });
        topTracks = selection.selected;
        if (topTracks.length === 0) {
          console.warn(`[LLM Hub] Dropping playlist "${concept.title}" - no candidates passed the filters and the veto.`);
          (concept as any).dropped = true;
          continue;
        }
        const meanMatch = topTracks.reduce((sum, t) => sum + Number(t.styleMatch || 0), 0) / topTracks.length;
        const meanMood = topTracks.reduce((sum, t) => sum + Number(t.moodFit || 0), 0) / topTracks.length;
        const strongInList = topTracks.filter(t => strongIds.has(String(t.id))).length;
        console.log([
          `[LLM Hub] Playlist Diagnostic (score${concept.special ? `, special: ${concept.special.label}` : ''}): "${concept.title || concept.section}"`,
          `  targets=${compiled.corePaths.join(', ') || 'none'} | concept=${styles.describe || 'none'}`,
          `  candidates=sound ${counts.sound} + strong members ${counts.strong} + weaker ${counts.weak} + by mood ${counts.mood} → ${new Set(allowed.map(getSongDedupKey)).size} songs, ${artistsAvailable} artists${small ? ' (small library: every track)' : ''}`,
          `  focus=${focus.toFixed(2)} | moods=${moodTarget ? Object.entries(moodTarget).map(([m, v]) => `${m} ${v}`).join(', ') : 'none'} (weight ${moodWeight.toFixed(2)}) | support=${support} | beta=${beta.toFixed(2)} | nu=${discoveryBias.toFixed(2)} | veto=${compiled.bannedGenres.length ? `${softVeto ? 'adaptive (relaxed)' : 'hard'} [${compiled.bannedNames.join(', ')}]` : 'none'}`,
          `  selected=${topTracks.length} tracks / ${new Set(topTracks.map(t => spreadArtistKey(t.artist || ''))).size} artists | strong members ${strongInList}/${topTracks.length} | mean style match ${meanMatch.toFixed(2)} | mean mood fit ${meanMood.toFixed(2)}`,
        ].join('\n'));
      }

      // Register these track IDs to prevent overlap in subsequent playlists
      for (const t of topTracks) {
        assignedTrackIds.add(t.id);
        assignedSongKeys.add(getSongDedupKey(t));
      }

      // Create a formal Playlist record (user-scoped)
      const playlistId = `${settings.persist === false ? 'preview' : 'llm'}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      if (settings.persist !== false) {
        await createPlaylist(
          playlistId,
          concept.title || concept.section,
          concept.description,
          true,
          userId,
          false,
          settings.llmGenerationSource ?? 'hub'
        );
        await addTracksToPlaylist(playlistId, topTracks.map((r: any) => r.id));
      }

      hubs.push({
        id: playlistId,
        title: concept.title || concept.section,
        description: concept.description,
        isLlmGenerated: true,
        theme: concept.special?.key ?? null,
        tracks: topTracks.map((r: any) => ({
          ...r,
          albumArtist: r.album_artist,
          trackNumber: r.track_number,
          releaseType: r.release_type,
          isCompilation: !!r.is_compilation
        }))
      });
    }
  }

  // A preview stops here: the rest saves system playlists.
  if (settings.persist === false) return hubs;

  // Also append user's existing Playlists to the Hub
  const existingPlaylists = await getPlaylists(userId);
  const fourHoursMs = 4 * 60 * 60 * 1000;

  for (const pl of existingPlaylists) {
     // Hide LLM playlists older than 4 hours from the active Hub view (unless pinned)
     if (pl.isLlmGenerated && !pl.pinned && (Date.now() - pl.createdAt) > fourHoursMs) {
         continue;
     }

     // System playlists are repopulated below by the engine sections; skip stale rows here.
     if (pl.isSystem) continue;

     if (!hubs.find((h: any) => h.id === pl.id)) {
        const tracks = await getPlaylistTracks(pl.id);
        if (tracks.length > 0) {
            hubs.push({
              id: pl.id,
              title: pl.title,
              description: pl.description,
              isLlmGenerated: pl.isLlmGenerated,
              pinned: pl.pinned,
              tracks
            });
        }
     }
  }

  // --- ENGINE-DRIVEN CATEGORIES (per-user) ---
  const systemPlaylistTrackLimit = 15;
  const systemPlaylistMinTracks = 15;
  const maxGenreSystemMixes = 10;
  const maxDecadeSystemMixes = 6;
  const maxDecadeGenreSystemMixes = 12;

  const shouldRefreshEngineWithLlm =
    llmConcepts.length > 0 && (settings.llmGenerationSource ?? 'hub') === 'hub';
  const systemPlaylistConfig = normalizeSystemPlaylistConfig(await getSystemSetting('systemPlaylistConfig'));
  const cachedEnginePlaylists = userId
    ? existingPlaylists.filter((playlist: any) =>
        isEngineSystemPlaylist(playlist) &&
        isEnginePlaylistEnabled(String(playlist.id || ''), systemPlaylistConfig)
      )
    : [];
  const cachedEngineCreatedAt = cachedEnginePlaylists
    .map((playlist: any) => Number(playlist.createdAt || 0))
    .filter((createdAt: number) => Number.isFinite(createdAt) && createdAt > 0);
  const latestEngineCreatedAt = cachedEngineCreatedAt.length > 0 ? Math.max(...cachedEngineCreatedAt) : null;
  const engineSchedule = (await getSystemSetting('hubGenerationSchedule')) || 'Daily';
  const engineIntervalMs = getEngineHubGenerationIntervalMs(engineSchedule);
  // When an admin changes the system-playlist toggles we stamp this timestamp;
  // any engine playlists generated before it are stale, so a newly-enabled
  // family regenerates on the next Hub load instead of waiting out the schedule
  // interval (or a manual Reset Hub) — which made the toggles feel dead.
  const configUpdatedAt = Number(await getSystemSetting('systemPlaylistConfigUpdatedAt')) || 0;
  const cachedEngineHubs = (
    await Promise.all(cachedEnginePlaylists.map(async (playlist: any) => {
      const tracks = await getPlaylistTracks(playlist.id, userId);
      if (tracks.length < systemPlaylistMinTracks) return null;
      return {
        id: playlist.id,
        title: playlist.title,
        description: playlist.description,
        isLlmGenerated: false,
        isSystem: true,
        tracks,
      };
    }))
  ).filter(Boolean) as any[];
  const engineCacheIsFresh =
    !shouldRefreshEngineWithLlm &&
    cachedEngineHubs.length > 0 &&
    cachedEngineHubs.length === cachedEnginePlaylists.length &&
    latestEngineCreatedAt !== null &&
    latestEngineCreatedAt >= configUpdatedAt &&
    (engineIntervalMs === null || (Date.now() - latestEngineCreatedAt) < engineIntervalMs);

  if (engineCacheIsFresh) {
    hubs.push(...orderEngineSystemHubs(cachedEngineHubs, latestEngineCreatedAt));
    return hubs;
  }

  // Wipe stale system playlists for this user up-front so sections that fail to
  // generate don't leave outdated rows behind.
  if (userId) {
    await deleteSystemPlaylistsForUser(userId);
  }

  const engineHubs: any[] = [];

  // Persist a system-owned playlist and return the descriptor for the hub list.
  const persistSystem = async (slug: string, title: string, description: string, tracks: any[]) => {
    // Off-season, drop Christmas content before it's persisted or returned. This
    // is the single choke for every engine system hub (Up Next, Jump Back In,
    // The Vault, genre/decade mixes) — their candidate queries select t.*, so
    // genre/album are present for isChristmasRow. LLM mixes are filtered at the
    // SQL pool (fetchLlmPool) instead. (#18)
    const eligible = isChristmasSeason() ? tracks : tracks.filter((t: any) => !isChristmasRow(t));
    const selectedTracks = eligible.slice(0, systemPlaylistTrackLimit);
    if (!userId || selectedTracks.length < systemPlaylistMinTracks) {
      return null;
    }
    const id = `engine_${slug}_${userId}`;
    await createPlaylist(id, title, description, false, userId, true);
    await addTracksToPlaylist(id, selectedTracks.map((t: any) => t.id));
    return { id, title, description, isLlmGenerated: false, isSystem: true, tracks: selectedTracks };
  };

  const constraints = await getDynamicConstraints();

  // 1. Up Next (Near user's recent history, genre-aware re-ranking)
  if (userId && systemPlaylistConfig.upNext) {
    const userRecentTracks = await getUserRecentTracks(userId, 5);
    if (userRecentTracks.length >= 3) {
      // Get MusiCNN and EffNet vectors for the user's recent tracks
      const recentIds = userRecentTracks.map((t: any) => t.id);
      const placeholders = recentIds.map((_, i) => `$${i + 1}`).join(',');
      const vecRes = await queryWithRetry(`
        SELECT t.id, COALESCE(g.name, t.genre) AS genre, tf.acoustic_vector_8d, tf.embedding_vector
        FROM tracks t JOIN track_features tf ON t.id = tf.track_id
        LEFT JOIN genres g ON g.id = t.genre_id
        WHERE t.id IN (${placeholders}) AND tf.acoustic_vector_8d IS NOT NULL
      `, recentIds);

      const profile = buildTasteProfileCentroids(vecRes.rows);
      if (profile && profile.acousticCount >= 3) {
        const vecStr = profile.acousticVectorStr;
        const effnetStr = profile.effnetVectorStr;
        const referenceGenre = (vecRes.rows[0] as any).genre || '';

        let upNextRes;
        if (effnetStr) {
          upNextRes = await queryWithRetry(`
            SELECT t.*, COALESCE(g.name, t.genre) AS genre, (tf.acoustic_vector_8d <-> $1::vector) + (tf.embedding_vector <=> $2::vector) AS distance
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            LEFT JOIN genres g ON g.id = t.genre_id
            WHERE t.id NOT IN (${recentIds.map((_,i) => `$${i+3}`).join(',')}) AND tf.acoustic_vector_8d IS NOT NULL AND tf.embedding_vector IS NOT NULL
            ORDER BY distance ASC LIMIT $${recentIds.length + 3}
          `, [vecStr, effnetStr, ...recentIds, constraints.nearestNeighborLimit]);
        } else {
          upNextRes = await queryWithRetry(`
            SELECT t.*, COALESCE(g.name, t.genre) AS genre, tf.acoustic_vector_8d <-> $1::vector AS distance
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            LEFT JOIN genres g ON g.id = t.genre_id
            WHERE t.id NOT IN (${recentIds.map((_,i) => `$${i+2}`).join(',')}) AND tf.acoustic_vector_8d IS NOT NULL
            ORDER BY distance ASC LIMIT $${recentIds.length + 2}
          `, [vecStr, ...recentIds, constraints.nearestNeighborLimit]);
        }

        if (upNextRes.rows.length > 0) {
          const ranked = await reRankByStyle(upNextRes.rows, referenceGenre, 30, undefined, undefined, false,
            await seedStyleVector(await initDB(), [...recentIds].reverse()));
          const pool = ranked.sort(() => 0.5 - Math.random());
          const playlist = await persistSystem('upnext', 'Up Next', 'Based on what you just listened to.', pool);
          if (playlist) engineHubs.push(playlist);
        }
      }
    }
  } else if (systemPlaylistConfig.upNext) {
    // Fallback: use global tracks table
    const recentTracksRes = await queryWithRetry(
      'SELECT t.id, COALESCE(g.name, t.genre) AS genre, tf.acoustic_vector_8d, tf.embedding_vector FROM tracks t JOIN track_features tf ON t.id = tf.track_id LEFT JOIN genres g ON g.id = t.genre_id WHERE t.last_played_at IS NOT NULL AND tf.acoustic_vector_8d IS NOT NULL ORDER BY t.last_played_at DESC LIMIT 5'
    );
     const profile = buildTasteProfileCentroids(recentTracksRes.rows);
     if (profile && profile.acousticCount >= 3) {
       const vecStr = profile.acousticVectorStr;
       const effnetStr = profile.effnetVectorStr;
       const recentIds = recentTracksRes.rows.map((r:any) => r.id);
       const referenceGenre = (recentTracksRes.rows[0] as any).genre || '';

       let upNextRes;
       if (effnetStr) {
         upNextRes = await queryWithRetry(`
           SELECT t.*, COALESCE(g.name, t.genre) AS genre, (tf.acoustic_vector_8d <-> $1::vector) + (tf.embedding_vector <=> $2::vector) AS distance
           FROM tracks t
           JOIN track_features tf ON t.id = tf.track_id
           LEFT JOIN genres g ON g.id = t.genre_id
           WHERE t.id NOT IN (${recentIds.map((_,i) => `$${i+3}`).join(',')}) AND tf.acoustic_vector_8d IS NOT NULL AND tf.embedding_vector IS NOT NULL
           ORDER BY distance ASC LIMIT $${recentIds.length + 3}
         `, [vecStr, effnetStr, ...recentIds, constraints.nearestNeighborLimit]);
       } else {
         upNextRes = await queryWithRetry(`
           SELECT t.*, COALESCE(g.name, t.genre) AS genre, tf.acoustic_vector_8d <-> $1::vector AS distance
           FROM tracks t
           JOIN track_features tf ON t.id = tf.track_id
           LEFT JOIN genres g ON g.id = t.genre_id
           WHERE t.id NOT IN (${recentIds.map((_,i) => `$${i+2}`).join(',')}) AND tf.acoustic_vector_8d IS NOT NULL
           ORDER BY distance ASC LIMIT $${recentIds.length + 2}
         `, [vecStr, ...recentIds, constraints.nearestNeighborLimit]);
       }

       if (upNextRes.rows.length > 0) {
         const ranked = await reRankByStyle(upNextRes.rows, referenceGenre, 30, undefined, undefined, false,
           await seedStyleVector(await initDB(), [...recentIds].reverse()));
         const pool = ranked.sort(() => 0.5 - Math.random());
         const playlist = await persistSystem('upnext', 'Up Next', 'Based on what you just listened to.', pool);
         if (playlist) engineHubs.push(playlist);
       }
    }
  }

  // 2. Jump Back In — Heat Score system (per-user)
  const nowMs = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;

  let jumpRes;
  if (userId && systemPlaylistConfig.jumpBackIn) {
    jumpRes = await queryWithRetry(`
      SELECT t.*, ups.play_count, ups.last_played_at,
        ups.play_count * GREATEST(0, 1 - POWER(
          EXTRACT(EPOCH FROM (NOW() - ups.last_played_at)) / (365.0 * 86400), 2
        )) AS heatScore
      FROM user_playback_stats ups
      JOIN tracks t ON ups.track_id = t.id
      WHERE ups.user_id = $1
        AND ups.play_count >= 2
        AND ups.last_played_at IS NOT NULL
        AND ups.last_played_at < NOW() - INTERVAL '30 days'
        AND ups.last_played_at > NOW() - INTERVAL '2 years'
      ORDER BY heatScore DESC
      LIMIT 30
    `, [userId]);
  } else if (systemPlaylistConfig.jumpBackIn) {
    // Fallback: global (backward compat)
    jumpRes = await queryWithRetry(`
      SELECT *,
        play_count * GREATEST(0, 1 - POWER(
          EXTRACT(EPOCH FROM (NOW() - last_played_at)) / (365.0 * 86400), 2
        )) AS heatScore
      FROM tracks
      WHERE play_count >= 2
        AND last_played_at IS NOT NULL
        AND last_played_at < NOW() - INTERVAL '30 days'
        AND last_played_at > NOW() - INTERVAL '2 years'
      ORDER BY heatScore DESC
      LIMIT 30
    `);
  }

  const jumpRows = jumpRes?.rows ?? [];
  if (jumpRows.length > 0) {
     const shuffled = jumpRows.sort(() => 0.5 - Math.random());
     const playlist = await persistSystem('jumpback', 'Jump Back In', 'Tracks you love that have been waiting.', shuffled);
     if (playlist) engineHubs.push(playlist);
  }

  // 3. The Vault (0 plays, acoustically near user's most-played tracks, genre-aware)
  if (userId && systemPlaylistConfig.vault) {
    const userTopTracks = await getUserTopTracks(userId, 10);
    if (userTopTracks.length > 0) {
      // Get MusiCNN and EffNet vectors for user's top tracks
      const topIds = userTopTracks.map((t: any) => t.id);
      const topPlaceholders = topIds.map((_, i) => `$${i + 1}`).join(',');
      const topVecRes = await queryWithRetry(`
        SELECT t.id, COALESCE(g.name, t.genre) AS genre, tf.acoustic_vector_8d, tf.embedding_vector
        FROM tracks t JOIN track_features tf ON t.id = tf.track_id
        LEFT JOIN genres g ON g.id = t.genre_id
        WHERE t.id IN (${topPlaceholders}) AND tf.acoustic_vector_8d IS NOT NULL
      `, topIds);

      const profile = buildTasteProfileCentroids(topVecRes.rows);
      if (profile) {
        const vecStr = profile.acousticVectorStr;
        const effnetStr = profile.effnetVectorStr;
        const referenceGenre = (topVecRes.rows[0] as any).genre || '';

        // Find tracks with 0 plays by THIS user
        let vaultRes;
        if (effnetStr) {
          vaultRes = await queryWithRetry(`
            SELECT t.*, COALESCE(g.name, t.genre) AS genre, (tf.acoustic_vector_8d <-> $1::vector) + (tf.embedding_vector <=> $2::vector) AS distance
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            LEFT JOIN genres g ON g.id = t.genre_id
            WHERE t.id NOT IN (
              SELECT track_id FROM user_playback_stats WHERE user_id = $4 AND play_count > 0
            ) AND tf.acoustic_vector_8d IS NOT NULL AND tf.embedding_vector IS NOT NULL
            ORDER BY distance ASC LIMIT $3
          `, [vecStr, effnetStr, constraints.nearestNeighborLimit, userId]);
        } else {
          vaultRes = await queryWithRetry(`
            SELECT t.*, COALESCE(g.name, t.genre) AS genre, tf.acoustic_vector_8d <-> $1::vector AS distance
            FROM tracks t
            JOIN track_features tf ON t.id = tf.track_id
            LEFT JOIN genres g ON g.id = t.genre_id
            WHERE t.id NOT IN (
              SELECT track_id FROM user_playback_stats WHERE user_id = $3 AND play_count > 0
            ) AND tf.acoustic_vector_8d IS NOT NULL
            ORDER BY distance ASC LIMIT $2
          `, [vecStr, constraints.nearestNeighborLimit, userId]);
        }

        if (vaultRes.rows.length > 0) {
          // Styles: the reference is the taste the Vault matches, the user's top tracks.
          const ranked = await reRankByStyle(vaultRes.rows, referenceGenre, 30, undefined, undefined, false,
            await seedStyleVector(await initDB(), topIds));
          const shuffled = ranked.sort(() => 0.5 - Math.random());
          const playlist = await persistSystem('vault', 'The Vault', 'Unplayed tracks that match your taste.', shuffled);
          if (playlist) engineHubs.push(playlist);
        }
      }
    }
  } else if (systemPlaylistConfig.vault) {
    // Fallback: global
    const topTracksRes = await queryWithRetry(
      'SELECT t.id, COALESCE(g.name, t.genre) AS genre, tf.acoustic_vector_8d, tf.embedding_vector FROM tracks t JOIN track_features tf ON t.id = tf.track_id LEFT JOIN genres g ON g.id = t.genre_id WHERE t.play_count > 0 AND tf.acoustic_vector_8d IS NOT NULL ORDER BY t.play_count DESC LIMIT 10'
    );
    const profile = buildTasteProfileCentroids(topTracksRes.rows);
    if (profile) {
       const vecStr = profile.acousticVectorStr;
       const effnetStr = profile.effnetVectorStr;
       const referenceGenre = (topTracksRes.rows[0] as any).genre || '';

       let vaultRes;
       if (effnetStr) {
         vaultRes = await queryWithRetry(`
           SELECT t.*, COALESCE(g.name, t.genre) AS genre, (tf.acoustic_vector_8d <-> $1::vector) + (tf.embedding_vector <=> $2::vector) AS distance
           FROM tracks t
           JOIN track_features tf ON t.id = tf.track_id
           LEFT JOIN genres g ON g.id = t.genre_id
           WHERE t.play_count = 0 AND tf.acoustic_vector_8d IS NOT NULL AND tf.embedding_vector IS NOT NULL
           ORDER BY distance ASC LIMIT $3
         `, [vecStr, effnetStr, constraints.nearestNeighborLimit]);
       } else {
         vaultRes = await queryWithRetry(`
           SELECT t.*, COALESCE(g.name, t.genre) AS genre, tf.acoustic_vector_8d <-> $1::vector AS distance
           FROM tracks t
           JOIN track_features tf ON t.id = tf.track_id
           LEFT JOIN genres g ON g.id = t.genre_id
           WHERE t.play_count = 0 AND tf.acoustic_vector_8d IS NOT NULL
           ORDER BY distance ASC LIMIT $2
         `, [vecStr, constraints.nearestNeighborLimit]);
       }

       if (vaultRes.rows.length > 0) {
         const ranked = await reRankByStyle(vaultRes.rows, referenceGenre, 30, undefined, undefined, false,
           await seedStyleVector(await initDB(), topTracksRes.rows.map((r: any) => r.id)));
         const shuffled = ranked.sort(() => 0.5 - Math.random());
         const playlist = await persistSystem('vault', 'The Vault', 'Unplayed tracks that match your taste.', shuffled);
         if (playlist) engineHubs.push(playlist);
       }
    }
  }

  // 4. Style system playlists. For the user's most-played styles, one full
  // familiar set and one rediscovery set whose tracks are untouched for 4+
  // weeks. A style's tracks are its strong members (as the special-list menu
  // counts them), so a track counts under each style it really is; tracks
  // that have a genre but no style in it count under the genre.
  if (userId && (systemPlaylistConfig.genreHeavyRotation || systemPlaylistConfig.genreRediscovery)) {
    const genreStatsRes = await queryWithRetry(`
      SELECT
        ts.style_id,
        ts.genre,
        COALESCE(MAX(s.name), ts.genre) AS name,
        COUNT(*)::int AS track_count,
        COALESCE(SUM(ups.play_count), 0)::int AS user_plays,
        COUNT(*) FILTER (
          WHERE ups.track_id IS NULL
             OR ups.play_count = 0
             OR ups.last_played_at IS NULL
             OR ups.last_played_at < NOW() - INTERVAL '4 weeks'
        )::int AS rediscovery_count
      FROM track_styles ts
      JOIN taxonomy_genre tg ON tg.name = ts.genre AND NOT tg.hidden
      LEFT JOIN style s ON s.id = ts.style_id
      LEFT JOIN user_playback_stats ups ON ups.track_id = ts.track_id AND ups.user_id = $1
      WHERE ts.strength >= $2
      GROUP BY ts.style_id, ts.genre
      HAVING COUNT(*) >= ${systemPlaylistMinTracks}
      ORDER BY COALESCE(SUM(ups.play_count), 0) DESC, COUNT(*) DESC
      LIMIT ${maxGenreSystemMixes}
    `, [userId, STRONG_MEMBER]);
    // The style's strong members ($2 style id or null for the genre alone, $3 genre, $4 floor).
    const inStyle = `EXISTS (SELECT 1 FROM track_styles ts WHERE ts.track_id = t.id AND ts.genre = $3
      AND ts.style_id IS NOT DISTINCT FROM $2::int AND ts.strength >= $4)`;

    const seenGenreSlugs = new Set<string>();
    for (const row of genreStatsRes.rows) {
      const rawGenre = String((row as any).name || '').trim();
      const styleParams = [(row as any).style_id ?? null, String((row as any).genre), STRONG_MEMBER];
      const genreSlug = toSystemGenreSlug(rawGenre);
      if (!rawGenre || seenGenreSlugs.has(genreSlug)) continue;
      seenGenreSlugs.add(genreSlug);

      const genreName = formatSystemGenreName(rawGenre);
      const mostPlayedRes = Number((row as any).user_plays || 0) > 0
        ? await queryWithRetry(`
            SELECT t.*, ups.play_count, ups.last_played_at AS user_last_played
            FROM user_playback_stats ups
            JOIN tracks t ON t.id = ups.track_id
            WHERE ups.user_id = $1
              AND ups.play_count > 0
              AND ${inStyle}
            ORDER BY ups.play_count DESC, ups.last_played_at DESC NULLS LAST
            LIMIT ${systemPlaylistTrackLimit * 2}
          `, [userId, ...styleParams])
        : { rows: [] };

      if (systemPlaylistConfig.genreHeavyRotation && mostPlayedRes.rows.length >= systemPlaylistMinTracks) {
        const playlist = await persistSystem(
          `genre-most-${genreSlug}`,
          `Your ${genreName} favourites`,
          topArtistsBlurb(mostPlayedRes.rows, `Your most-played ${genreName} tracks.`),
          mostPlayedRes.rows
        );
        if (playlist) engineHubs.push(playlist);
      }

      const rediscoveryRes = Number((row as any).rediscovery_count || 0) > 0
        ? await queryWithRetry(`
            SELECT t.*, COALESCE(ups.play_count, 0) AS play_count, ups.last_played_at AS user_last_played
            FROM tracks t
            LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
            WHERE ${inStyle}
              AND (
                ups.track_id IS NULL
                OR ups.play_count = 0
                OR ups.last_played_at IS NULL
                OR ups.last_played_at < NOW() - INTERVAL '4 weeks'
              )
            ORDER BY
              CASE WHEN ups.track_id IS NULL OR ups.play_count = 0 THEN 0 ELSE 1 END ASC,
              ups.last_played_at ASC NULLS FIRST,
              random()
            LIMIT ${systemPlaylistTrackLimit * 2}
          `, [userId, ...styleParams])
        : { rows: [] };

      if (systemPlaylistConfig.genreRediscovery && rediscoveryRes.rows.length >= systemPlaylistMinTracks) {
        const playlist = await persistSystem(
          `genre-stale-${genreSlug}`,
          `Rediscover ${genreName}`,
          topArtistsBlurb(rediscoveryRes.rows, `Forgotten ${genreName} worth replaying.`),
          rediscoveryRes.rows
        );
        if (playlist) engineHubs.push(playlist);
      }
    }
  }

  // 5. Decade system playlists, by the decade Browse uses (track_origin:
  // the original release year first, so a 2011 remaster of a 1991 album is
  // a 90s track). Then the style × decade mixes ("Trance from the 2000's"):
  // the era themes of the special-list menu (enough strong members from
  // enough artists), leaving out those made as special lists lately.
  if (userId && systemPlaylistConfig.decadeMixes) {
    const decadeStatsRes = await queryWithRetry(`
      SELECT
        o.decade,
        COUNT(*)::int AS track_count,
        COALESCE(SUM(ups.play_count), 0)::int AS user_plays
      FROM track_origin o
      LEFT JOIN user_playback_stats ups ON ups.track_id = o.track_id AND ups.user_id = $1
      WHERE o.decade IS NOT NULL
        AND o.decade >= 1950
        AND o.decade <= EXTRACT(YEAR FROM NOW())::int
      GROUP BY o.decade
      HAVING COUNT(*) >= ${systemPlaylistMinTracks}
      ORDER BY COALESCE(SUM(ups.play_count), 0) DESC, COUNT(*) DESC, o.decade DESC
      LIMIT ${maxDecadeSystemMixes}
    `, [userId]);

    for (const decade of decadeStatsRes.rows.map((row: any) => Number(row.decade)).filter(Number.isFinite)) {
      const decadeRes = await queryWithRetry(`
        SELECT t.*, COALESCE(ups.play_count, 0) AS play_count, ups.last_played_at AS user_last_played
        FROM track_origin o
        JOIN tracks t ON t.id = o.track_id
        LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
        WHERE o.decade = $2
        ORDER BY COALESCE(ups.play_count, 0) DESC, ups.last_played_at DESC NULLS LAST, random()
        LIMIT ${systemPlaylistTrackLimit * 2}
      `, [userId, decade]);

      if (decadeRes.rows.length >= systemPlaylistMinTracks) {
        const playlist = await persistSystem(
          `decade-${decade}`,
          `The ${formatDecadeTitleLabel(decade)}`,
          `A decade mix from the ${formatDecadeTitleLabel(decade)}.`,
          decadeRes.rows
        );
        if (playlist) engineHubs.push(playlist);
      }
    }
  }

  if (userId && systemPlaylistConfig.decadeGenreMixes) {
    const recent = (await recentSpecialThemes(userId)).map((e) => e.theme);
    const eras = (await buildThemeMenu(await initDB(), {
      userId, playlistLength: systemPlaylistTrackLimit, kinds: ['era'], recentKeys: recent, limit: maxDecadeGenreSystemMixes,
    })).filter((theme) => theme.kind === 'era' && theme.styleId != null && theme.decade != null);

    for (const theme of eras) {
      const decade = Number(theme.decade);
      const styleName = formatSystemGenreName(theme.styleName || theme.label);
      const eraRes = await queryWithRetry(`
        SELECT t.*, COALESCE(ups.play_count, 0) AS play_count, ups.last_played_at AS user_last_played
        FROM track_origin o
        JOIN tracks t ON t.id = o.track_id
        LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
        WHERE o.decade = $2
          AND EXISTS (SELECT 1 FROM track_styles ts WHERE ts.track_id = t.id AND ts.style_id = $3 AND ts.strength >= $4)
        ORDER BY COALESCE(ups.play_count, 0) DESC, ups.last_played_at DESC NULLS LAST, random()
        LIMIT ${systemPlaylistTrackLimit * 4}
      `, [userId, decade, theme.styleId, STRONG_MEMBER]);
      // At most two tracks per artist: the theme has enough artists for that.
      const perArtist = new Map<string, number>();
      const tracks = eraRes.rows.filter((r: any) => {
        const key = spreadArtistKey(r.artist || '');
        const n = perArtist.get(key) ?? 0;
        perArtist.set(key, n + 1);
        return n < 2;
      });
      const playlist = await persistSystem(
        `decade-genre-${decade}-${toSystemGenreSlug(styleName)}`,
        `${styleName} from the ${formatDecadeTitleLabel(decade)}`,
        topArtistsBlurb(tracks, `${styleName} from the ${formatDecadeTitleLabel(decade)}.`),
        tracks
      );
      if (playlist) engineHubs.push(playlist);
    }
  }

  hubs.push(...orderEngineSystemHubs(engineHubs, Date.now()));
  return hubs;

}

export async function getDynamicConstraints() {
  const res = await queryWithRetry(`SELECT COUNT(*) as count FROM tracks`);
  const total = parseInt((res.rows[0] as any).count, 10) || 0;

  // Defaults for Medium (500 - 5000)
  const constraints = {
    historyPenaltySize: 10,
    randomizerPoolSize: 20,
    nearestNeighborLimit: 50,
    distanceThreshold: 0.5
  };

  if (total < 500) {
    constraints.historyPenaltySize = 0; // Loosen restrictions for tiny libraries
    constraints.randomizerPoolSize = 5;
    constraints.nearestNeighborLimit = 20;
    constraints.distanceThreshold = 1.0;
  } else if (total > 5000) {
    constraints.historyPenaltySize = 50; // Strict penalties for large libraries
    constraints.randomizerPoolSize = 50;
    constraints.nearestNeighborLimit = 100;
    constraints.distanceThreshold = 0.3;
  }

  return constraints;
}

/**
 * Track ids to exclude from a recommendation: recent history, plus anything the
 * caller already has queued but unheard.
 *
 * Two separate concerns are unioned here deliberately.
 *
 * `penaltySize` bounds how far back *heard* history suppresses a repeat, and
 * the relaxation loop halves it on each failed attempt to widen the candidate
 * pool. Note `slice(-0)` returns the whole array rather than an empty one, so a
 * `penaltySize` of 0 — reachable both from `artistAmnesiaLimit: 0` and from that
 * halving bottoming out — used to apply the *maximum* penalty instead of none,
 * exactly inverting the relaxation it was meant to perform.
 *
 * `excludeTrackIds` is what the caller already holds in its queue. It is not
 * subject to relaxation: widening the pool is worth doing, re-recommending a
 * track that is already queued never is.
 */
export function buildPenaltyIds(
  sessionHistoryTrackIds: string[],
  penaltySize: number,
  excludeTrackIds: string[] = []
): string[] {
  const recent = penaltySize > 0 ? sessionHistoryTrackIds.slice(-penaltySize) : [];
  return Array.from(new Set([...recent, ...excludeTrackIds]));
}

export async function calculateNextInfinityTrack(
  sessionHistoryTrackIds: string[],
  settings: any = {},
  options: { excludeTrackIds?: string[]; seedTrackIds?: string[] } = {}
) {
  // Seeds steer the recommendation: the end of the client's queue when it
  // sends one, so reorders, removals and a new queue take effect at once.
  // Playback history is only the fallback, and keeps its repeat-protection role.
  const seedTrackIds = (options.seedTrackIds?.length ? options.seedTrackIds : sessionHistoryTrackIds).slice(-10);
  const excludeTrackIds = Array.from(new Set([
    ...(Array.isArray(options.excludeTrackIds) ? options.excludeTrackIds : []),
    ...sessionHistoryTrackIds.slice(-2),
    ...(options.seedTrackIds?.length ? seedTrackIds : []),
  ]));
  const constraints = await getDynamicConstraints();
  
  // 1. Fetch vectors for the seed tracks to compute the Weighted Decay Centroid
  let targetVector = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]; // safe fallback
  let recentVectors: number[][] = [];
  let seedFeatureVersion: number | null = null;
  const orderedEffnet: number[][] = [];
  
  if (seedTrackIds.length > 0) {
    const last10Ids = seedTrackIds;
    // Maintain strict order
    const placeholders = last10Ids.map((_, i) => `$${i + 1}`).join(',');
    const vecRes = await queryWithRetry(`
      SELECT t.id, tf.acoustic_vector_8d, tf.embedding_vector, tf.feature_version
      FROM tracks t JOIN track_features tf ON t.id = tf.track_id
      WHERE t.id IN (${placeholders}) AND tf.acoustic_vector_8d IS NOT NULL
        AND tf.is_simulated = FALSE
    `, last10Ids);

    // Version 1 used saturated energy and the "happy" tag where version 2
    // stores RMS energy and the "dance" tag. Never average or compare those
    // incompatible acoustic coordinates while a library is being reanalyzed.
    const orderedRows = last10Ids.map(id => vecRes.rows.find(row => row.id === id));
    const newestSeed = orderedRows.filter(row => parseNumericVector(row?.acoustic_vector_8d, 8)).at(-1);
    seedFeatureVersion = newestSeed?.feature_version ?? null;
    for (const id of last10Ids) {
      const row = vecRes.rows.find((r: any) => r.id === id) as any;
      if (row?.feature_version !== seedFeatureVersion) continue;
      const acousticVector = parseNumericVector(row?.acoustic_vector_8d, 8);
      if (acousticVector) {
        recentVectors.push(acousticVector);
        const embeddingVector = parseNumericVector(row.embedding_vector, 1280);
        if (embeddingVector?.some(value => value !== 0)) orderedEffnet.push(embeddingVector);
      }
    }

    if (recentVectors.length > 0) {
      // 9.1: The Weighted Decay Centroid (lambda = 0.8)
      const lambda = 0.8;
      targetVector = [0,0,0,0,0,0,0,0];
      let weightSum = 0;
      
      // Iterate from oldest to newest in the recent active window
      for (let i = 0; i < recentVectors.length; i++) {
        const weight = Math.pow(lambda, recentVectors.length - 1 - i);
        weightSum += weight;
        for (let j = 0; j < 8; j++) {
           const val = recentVectors[i][j] ?? 0.5; // fallback for inconsistent vector length
           targetVector[j] += val * weight;
        }
      }
      
      for (let j = 0; j < 8; j++) {
        targetVector[j] /= weightSum;
      }
      
      // 9.2: Momentum & Trajectory Tracking (last 3 tracks)
      if (recentVectors.length >= 3) {
         const v3 = recentVectors[recentVectors.length - 1]; // newest
         const v2 = recentVectors[recentVectors.length - 2];
         const v1 = recentVectors[recentVectors.length - 3]; // oldest
           
         // Simple linear slope detection: average the two deltas
         const energyDelta = ((v3[0] - v2[0]) + (v2[0] - v1[0])) / 2;
         const danceDelta = ((v3[6] - v2[6]) + (v2[6] - v1[6])) / 2;
         
         if (energyDelta > 0.05) targetVector[0] = Math.min(1.0, targetVector[0] * 1.1);
         else if (energyDelta < -0.05) targetVector[0] = Math.max(0.0, targetVector[0] * 0.9);

         if (danceDelta > 0.05) targetVector[6] = Math.min(1.0, targetVector[6] * 1.1);
         else if (danceDelta < -0.05) targetVector[6] = Math.max(0.0, targetVector[6] * 0.9);
      }
    }
  }

  // Deduplication: Fetch metadata for the last 50 tracks to prevent duplicate songs from different albums
  const dedupeHistoryIds = Array.from(new Set([
    ...sessionHistoryTrackIds.slice(-50),
    ...excludeTrackIds,
  ]));
  let historyMetadata: any[] = [];
  if (dedupeHistoryIds.length > 0) {
    const metaPlaceholders = dedupeHistoryIds.map((_, i) => `$${i + 1}`).join(',');
    const metaRes = await queryWithRetry(`
      SELECT id, title, artist, mb_recording_id FROM tracks WHERE id IN (${metaPlaceholders})
    `, dedupeHistoryIds);
    historyMetadata = metaRes.rows;
  }

  const vectorStr = `[${targetVector.join(',')}]`;

  // Compute EffNet embedding centroid (weighted decay, same lambda) for the last-10 window
  let effnetVectorStr: string | null = null;
  if (orderedEffnet.length > 0) {
    const lambda = 0.8;
    const effnetTarget = new Array(1280).fill(0);
    let effnetWeightSum = 0;
    for (let i = 0; i < orderedEffnet.length; i++) {
      const weight = Math.pow(lambda, orderedEffnet.length - 1 - i);
      effnetWeightSum += weight;
      for (let j = 0; j < 1280; j++) effnetTarget[j] += orderedEffnet[i][j] * weight;
    }
    effnetVectorStr = `[${effnetTarget.map(v => v / effnetWeightSum).join(',')}]`;
  }

  // Apply Frontend Settings for Engine Tuning
  let discoveryLevel = settings.discoveryLevel ?? 50; // 1-100
  let genreStrictness = settings.genreStrictness ?? 50; // 0-100
  
  // Base parameters. Genre strictness ("Style match") sets β, the
  // style-overlap bonus; changing genre never counts against a track.
  let styleWeight = styleBeta(genreStrictness);
  const seedStyles = seedTrackIds.length > 0
    ? await seedStyleVector(await initDB(), seedTrackIds)
    : null;
  let poolSize = Math.max(5, Math.floor(discoveryLevel / 2));
  const penaltySize = settings.artistAmnesiaLimit !== undefined
                      ? settings.artistAmnesiaLimit 
                      : constraints.historyPenaltySize;
                      
  let finalCandidates: any[] = [];

  // Iterative Relaxation Loop
  for (let attempt = 0; attempt < 3; attempt++) {
    const penaltyIds = buildPenaltyIds(sessionHistoryTrackIds, penaltySize, excludeTrackIds);
    const historyParams = penaltyIds.map((_, i) => `$${i + 2}`);
    const historyClause = historyParams.length > 0 ? `WHERE t.id NOT IN (${historyParams.join(',')})` : '';

    // Step 4.1: Over-fetch
    const overFetchLimit = poolSize * 3 + 50;

    let res;
    if (effnetVectorStr) {
      const renumberedHistory = historyClause
        ? `AND ${historyClause.replace(/^WHERE /, '').replace(/\$(\d+)/g, (_, n) => `$${Number(n) + 1}`)}`
        : '';
      res = await queryWithRetry(`
        SELECT t.*, COALESCE(g.name, t.genre) AS genre,
               (tf.acoustic_vector_8d <-> $1::vector) + (tf.embedding_vector <=> $2::vector) AS distance
        FROM tracks t
        JOIN track_features tf ON t.id = tf.track_id
        LEFT JOIN genres g ON g.id = t.genre_id
        WHERE tf.acoustic_vector_8d IS NOT NULL AND tf.embedding_vector IS NOT NULL
        AND tf.is_simulated = FALSE${christmasExclusionSql('t')}
        ${renumberedHistory}
        AND ($${penaltyIds.length + 4}::integer IS NULL OR tf.feature_version = $${penaltyIds.length + 4})
        ORDER BY distance ASC
        LIMIT $${penaltyIds.length + 3}
      `, [vectorStr, effnetVectorStr, ...penaltyIds, overFetchLimit, seedFeatureVersion]);
    } else {
      res = await queryWithRetry(`
        SELECT t.*, COALESCE(g.name, t.genre) AS genre,
               tf.acoustic_vector_8d <-> $1::vector AS distance
        FROM tracks t
        JOIN track_features tf ON t.id = tf.track_id
        LEFT JOIN genres g ON g.id = t.genre_id
        WHERE tf.acoustic_vector_8d IS NOT NULL AND tf.is_simulated = FALSE${christmasExclusionSql('t')}
        ${historyClause ? `AND ${historyClause.replace(/^WHERE /, '')}` : ''}
        AND ($${penaltyIds.length + 3}::integer IS NULL OR tf.feature_version = $${penaltyIds.length + 3})
        ORDER BY distance ASC
        LIMIT $${penaltyIds.length + 2}
      `, [vectorStr, ...penaltyIds, overFetchLimit, seedFeatureVersion]);
    }

    if (res.rows.length > 0) {
      const finite = res.rows.filter(row => Number.isFinite(row.distance));
      // Step 4.2: shared styles pull a candidate closer (d − β·cos); a seed
      // without genres or styles adds nothing.
      const candidateStyles = seedStyles ? await styleVectors(await initDB(), finite.map((row: any) => row.id)) : null;
      const scored = finite.map((row: any) => {
        const styleOverlap = styleCosine(seedStyles, candidateStyles?.get(row.id));
        return { ...row, styleOverlap, originalDistance: row.distance, finalScore: row.distance - styleWeight * styleOverlap };
      });

      // Step 4.2b: Filter out "Same Song" duplicates (different albums/remasters)
      const uniqueScored = scored.filter(candidate => {
        const matchingHistory = historyMetadata.find(h => isSameSong(h, candidate));
        if (matchingHistory) {
          // If the candidate IS the exact same track ID, it's already excluded by SQL
          // But if it's a sibling (same recording, different album), we drop it here.
          return false;
        }
        return true;
      });

      // Filter and sort by the dynamically weighted score
      uniqueScored.sort((a, b) => a.finalScore - b.finalScore);
      
      // Ensure we have candidates within an acceptable boundary
      // We become less strict on absolute bounds as attempts increase
      const acceptable = uniqueScored.filter(c => c.finalScore < (constraints.distanceThreshold * (1 + attempt)));
      const pool = acceptable.length > 0 ? acceptable : uniqueScored; // fallback to best available if none acceptable

      finalCandidates = pool.slice(0, poolSize);
      if (finalCandidates.length > 0) {
        const avgMatch = finalCandidates.reduce((sum, c) => sum + (c.finalScore || 0), 0) / finalCandidates.length;
        const avgOverlap = finalCandidates.reduce((sum, c) => sum + (c.styleOverlap || 0), 0) / finalCandidates.length;
        console.log(`[Engine] Found tracks after ${attempt} relaxation(s). AvgMatch: ${avgMatch.toFixed(3)}, AvgStyleOverlap: ${avgOverlap.toFixed(2)}, PenaltySize: ${penaltySize}, Beta: ${styleWeight.toFixed(3)}${seedStyles ? '' : ' (seed has no styles)'}`);
        break; // Met quota
      }
    }

    // Relax Constraints. Repeat protection is the listener's explicit limit
    // and is never relaxed; widening the pool and loosening genre is enough.
    poolSize += 10;
    styleWeight *= 0.75;
  }

  // Exhaustion can relax similarity, never queue/recent-song exclusions.
  // Scan fallback candidates in bounded pages so duplicate editions cannot
  // hide a usable track, without loading the entire library into memory.
  if (finalCandidates.length === 0) {
    const fallbackShuffleSeed = Math.random().toString();
    for (let offset = 0; ; offset += 100) {
      const fallback = await queryWithRetry(`
        SELECT t.* FROM tracks t
        LEFT JOIN track_features tf ON tf.track_id = t.id
        WHERE NOT (t.id = ANY($1::text[]))${christmasExclusionSql('t')}
        ORDER BY (tf.acoustic_vector_8d IS NOT NULL AND tf.is_simulated = FALSE) DESC,
                 md5(t.id || $2), t.id
        LIMIT 100 OFFSET $3
      `, [dedupeHistoryIds, fallbackShuffleSeed, offset]);
      const next = fallback.rows.find(candidate => !historyMetadata.some(previous => isSameSong(previous, candidate)));
      if (next) return next;
      if (fallback.rows.length < 100) return undefined;
    }
  }

  // Wander Factor: Pick a track from the final candidates using a weighted randomizer.
  // Scores can drop to zero or below (d − β·cos), so weigh by the score
  // shifted by β, i.e. 1 / (d + β·(1 − cos)): positive, same order.
  const candidates = finalCandidates.map((row: any) => ({
      ...row,
      weight: 1 / (Math.max(0.01, row.finalScore + styleWeight))
  }));

  const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
  let randomVal = Math.random() * totalWeight;
  
  for (const c of candidates) {
      randomVal -= c.weight;
      if (randomVal <= 0) {
          return c;
      }
  }

  return candidates[0]; // fallback to #1
}
