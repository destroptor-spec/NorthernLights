import { initDB, createPlaylist, addTracksToPlaylist, getPlaylists, getPlaylistTracks, getUserRecentTracks, getUserTopTracks, deleteSystemPlaylistsForUser, getSystemSetting } from '../database';
import { genreMatrixService } from './genreMatrix.service';
import { getLibraryProfile, GenreHealth } from './libraryProfile.service';
import { compileConceptToLibrary } from './llmConceptCompiler.service';
import { queryWithRetry } from '../utils/db';
import { christmasExclusionSql, isChristmasSeason, isChristmasRow } from '../utils/seasonalFilter';

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

function getPathHopCost(pathA: string, pathB: string): number {
  const a = String(pathA || '').toLowerCase().trim();
  const b = String(pathB || '').toLowerCase().trim();
  if (!a || !b) return 2.0;
  if (a === b) return 0.0;

  const partsA = a.split('.');
  const partsB = b.split('.');
  let commonLevels = 0;

  for (let index = 0; index < Math.min(partsA.length, partsB.length); index++) {
    if (partsA[index] === partsB[index]) {
      commonLevels++;
    } else {
      break;
    }
  }

  if (commonLevels >= 3) return 0.05;
  if (commonLevels === 2) return 0.20;
  if (commonLevels === 1) return 0.50;
  return 2.0;
}

function getHopCostForCandidate(referenceGenre: string, row: any): number {
  if (!referenceGenre) return 0;

  const leafGenre = (row.genre || '').toLowerCase();
  const fullPath = row.genre_path || genreMatrixService.getGenrePath(leafGenre) || leafGenre;
  const referencePath = referenceGenre.includes('.')
    ? referenceGenre.toLowerCase()
    : (genreMatrixService.getGenrePath(referenceGenre) || referenceGenre.toLowerCase());

  if (referencePath.includes('.') && fullPath.includes('.')) {
    return getPathHopCost(referencePath, fullPath);
  }

  return genreMatrixService.getHopCost(referenceGenre, leafGenre);
}

function isPathBlockedByBannedGenre(path: string, bannedGenres: string[]): boolean {
  const cleanPath = String(path || '').toLowerCase().trim();
  if (!cleanPath) return false;
  return bannedGenres.some((genre) => {
    const banned = String(genre || '').toLowerCase().trim();
    if (!banned) return false;
    return cleanPath === banned || cleanPath.startsWith(`${banned}.`) || cleanPath.includes(`.${banned}.`) || cleanPath.endsWith(`.${banned}`);
  });
}

function getFullGenrePath(row: any): string {
  const leafGenre = (row.genre || '').toLowerCase();
  return row.genre_path || genreMatrixService.getGenrePath(leafGenre) || leafGenre;
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

export async function getHubCollections(
  llmConcepts: { section: string, title?: string, description: string, target_vector: number[], target_genres?: string[], banned_genres?: string[] }[],
  userId: string | null = null,
  settings: {
    llmGenreCohesion?: number,
    llmDiscoveryBias?: number,
    llmArtistSpread?: number,
    genrePenaltyCurve?: number,
    llmRecoveryStrength?: number,
    llmAdjacentReach?: number,
    llmTracksPerPlaylist?: number,
    llmPlaylistDiversity?: number,
    llmVetoMode?: 'hard' | 'adaptive',
    llmGenerationSource?: 'hub' | 'custom'
  } = {}
) {
  const hubs: any[] = [];

  const genreBlend = (settings.llmGenreCohesion ?? 50) / 100; // 0.0 to 1.0
  const discoveryBias = (settings.llmDiscoveryBias ?? 45) / 100; // 0.0 to 1.0
  const artistSpread = (settings.llmArtistSpread ?? 70) / 100; // 0.0 to 1.0
  const penaltyCurve = 0.5 + ((settings.genrePenaltyCurve ?? 50) / 100) * 1.5; // 0.5 to 2.0
  const recoveryStrength = (settings.llmRecoveryStrength ?? 50) / 100; // 0.0 to 1.0
  const adjacentReach = (settings.llmAdjacentReach ?? 50) / 100; // 0.0 to 1.0
  const tracksPerPlaylist = settings.llmTracksPerPlaylist ?? 10;
  const diversity = (settings.llmPlaylistDiversity ?? 50) / 100; // 0.0 to 1.0
  const allowSoftVetoRecovery = settings.llmVetoMode === 'adaptive';
  const genreKeySql = `regexp_replace(lower(trim(COALESCE(canonical_genre.name, t.genre))), '[^[:alnum:]_[:space:]-]', '', 'g')`;
  const genrePathJoinSql = `
    LEFT JOIN genres canonical_genre ON canonical_genre.id = t.genre_id
    LEFT JOIN subgenre_mappings sm ON ${genreKeySql} = sm.sub_genre
    LEFT JOIN LATERAL (
      (SELECT path FROM genre_tree_paths WHERE LOWER(genre_name) = ${genreKeySql} LIMIT 1)
      UNION ALL
      (SELECT gtp.path FROM genre_tree_paths gtp
       JOIN genre_alias ga ON gtp.genre_id = ga.genre
       WHERE LOWER(ga.name) = ${genreKeySql} LIMIT 1)
      LIMIT 1
    ) gm ON true
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

  // Helper: re-rank a pool of tracks by blending vector distance with genre hop cost.
  // Exponential model: genre penalty scales distance via Math.pow(1 + hopCost, weight * curve).
  // bannedGenres: normally an absolute veto; optionally become a strong penalty in adaptive recovery mode.
  // Root node enforcement: at high weight, blocks tracks from different genre families.
  const reRankByHopCost = (
    rows: any[],
    referenceGenre: string,
    limit: number,
    blendWeight?: number,
    bannedGenres?: string[],
    softVeto = false,
    allowedRoots: string[] = []
  ) => {
    const weight = blendWeight ?? genreBlend;
    const anchorRoot = referenceGenre ? referenceGenre.split('.')[0].toLowerCase() : null;
    const allowedRootSet = new Set(allowedRoots.map((root) => String(root || '').toLowerCase().trim()).filter(Boolean));

    const scored = rows.map(row => {
      const fullPath = getFullGenrePath(row);
      const trackRoot = fullPath.split('.')[0].toLowerCase();
      const isBanned = !!(bannedGenres && isPathBlockedByBannedGenre(fullPath, bannedGenres));

      // 1. Explicit LLM vetoes (full path check)
      if (isBanned && !softVeto) {
        return { ...row, combined: Infinity };
      }

      // 2. Root node enforcement: at high weight, block different genre families
      if (weight > 0.8 && anchorRoot && trackRoot && anchorRoot !== trackRoot && !allowedRootSet.has(trackRoot)) {
        return { ...row, combined: Infinity };
      }

      // 3. Multiplicative penalty
      const distance = Number(row.distance ?? 0);
      const hopCost = getHopCostForCandidate(referenceGenre, row);
      const vetoPenalty = isBanned ? (1.75 + weight) : 1;
      const poolBias = Number(row.pool_bias ?? 0);
      const combined = ((distance * Math.pow(1 + hopCost, weight * penaltyCurve) * vetoPenalty) + (isBanned ? 0.15 : 0)) - poolBias;
      return { ...row, combined };
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
    options: { discoveryBias: number; artistSpread: number } = { discoveryBias: 0.45, artistSpread: 0.70 }
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

        const artistKey = normalizeArtistName(row.artist || 'unknown-artist');
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
        const artistKey = normalizeArtistName(candidate.artist || 'unknown-artist');
        const albumKey = normalizeLooseKey(candidate.album || candidate.album_title || '');
        const rootKey = getGenreRoot(candidate);
        const poolKey = String(candidate.pool_source || 'acoustic');
        const clusterKey = getAcousticClusterKey(candidate);
        const candidateVector = parseAcousticVector(candidate);
        const rank = rankBySong.get(songKey) ?? scoredRows.length;
        const fitScore = rank / Math.max(1, scoredRows.length - 1);
        const artistPenalty = (artistCounts.get(artistKey) ?? 0) * (0.65 + (options.artistSpread * 0.70));
        const albumPenalty = albumKey ? (albumCounts.get(albumKey) ?? 0) * (0.22 + (options.artistSpread * 0.18)) : 0;
        const rootPenalty = (rootCounts.get(rootKey) ?? 0) * 0.06;
        const clusterPenalty = (clusterCounts.get(clusterKey) ?? 0) * 0.38;
        const desiredPoolCount = poolTargets.get(poolKey) ?? 0;
        const currentPoolCount = poolCounts.get(poolKey) ?? 0;
        const poolPenalty = desiredPoolCount > 0
          ? Math.max(0, (currentPoolCount + 1) - desiredPoolCount) * 0.25
          : currentPoolCount * 0.08;
        const poolBonus = desiredPoolCount > currentPoolCount ? 0.06 : 0;
        const poolBias = Number(candidate.pool_bias ?? 0);
        const noveltyBonus = Math.min(0.18, Number(candidate.novelty_boost ?? 0) * (0.55 + (options.discoveryBias * 0.90)));
        const newArtistBonus = (artistCounts.get(artistKey) ?? 0) === 0 ? (0.04 + (options.artistSpread * 0.10)) : 0;
        const pairwiseDistances = selectedVectors
          .map((vector) => acousticDistance(candidateVector, vector))
          .filter((value): value is number => value !== null);
        const meanDistance = pairwiseDistances.length > 0
          ? pairwiseDistances.reduce((sum, value) => sum + value, 0) / pairwiseDistances.length
          : 0.30;
        const similarityPenalty = pairwiseDistances.length > 0
          ? Math.max(0, 0.20 - meanDistance) * 2.2
          : 0;
        const diversityBonus = pairwiseDistances.length > 0 ? Math.min(0.14, meanDistance * 0.45) : 0.04;
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
      const artistKey = normalizeArtistName(best.artist || 'unknown-artist');
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

  const isGenrePoolWeak = (
    rows: any[],
    playlistTitle: string | undefined,
    health: GenreHealth | null,
    poolLabel: string
  ): boolean => {
    const uniqueArtists = new Set(rows.map((row) => normalizeArtistName(row.artist || 'unknown-artist')));
    const uniqueSongs = new Set(rows.map(getSongDedupKey));
    const minArtists = getTargetArtistFloor(tracksPerPlaylist, 0);

    if (health && health.health < 0.30) {
      console.log(
        `[LLM Hub] Library profile marks "${playlistTitle}" genre weak (${health.trackCount} tracks, ${health.artistCount} artists, health=${health.health.toFixed(2)}). Leaning on musical similarity.`
      );
      return true;
    }

    if (rows.length < 5) {
      console.log(`[LLM Hub] ${poolLabel} starved (${rows.length} tracks). Leaning on non-genre pools.`);
      return true;
    }

    if (uniqueArtists.size < minArtists || uniqueSongs.size < tracksPerPlaylist) {
      console.log(
        `[LLM Hub] ${poolLabel} weak for "${playlistTitle}" (${rows.length} tracks, ${uniqueArtists.size} artists, ${uniqueSongs.size} songs). Leaning on musical similarity.`
      );
      return true;
    }

    return false;
  };

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
  }: {
    poolName: 'core' | 'adjacent' | 'root' | 'acoustic' | 'discovery' | 'bridge';
    vectorStr: string;
    embeddingCentroidStr: string | null;
    effnetWeight: number;
    limit: number;
    pathPrefixes?: string[];
    excludeIds?: string[];
    excludePrefixes?: string[];
    enableDiscoveryBoost?: boolean;
  }): Promise<any[]> => {
    if (limit <= 0) return [];

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

    let joinSql = genrePathJoinSql;
    let noveltySql = '0.0';

    if (enableDiscoveryBoost) {
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
      whereClauses.push(`EXISTS (SELECT 1 FROM unnest($${nextParam}::text[]) AS prefix WHERE COALESCE(sm.path, gm.path) LIKE prefix || '%')`);
      nextParam++;
    }

    if (excludePrefixes.length > 0) {
      params.push(excludePrefixes);
      whereClauses.push(`NOT EXISTS (SELECT 1 FROM unnest($${nextParam}::text[]) AS prefix WHERE COALESCE(sm.path, gm.path) LIKE prefix || '%')`);
      nextParam++;
    }

    if (excludeIds.length > 0) {
      params.push(excludeIds);
      whereClauses.push(`NOT (t.id = ANY($${nextParam}::text[]))`);
      nextParam++;
    }

    params.push(limit);
    const limitParam = nextParam;
    const orderSql = enableDiscoveryBoost ? `(distance - novelty_boost)` : `distance`;
    const poolBiasByName: Record<string, number> = {
      core: 0.11,
      adjacent: 0.07,
      root: 0.055,
      acoustic: 0.03,
      bridge: 0.05,
      discovery: 0.06,
    };

    const res = await queryWithRetry(`
      SELECT * FROM (
        SELECT
          t.*,
          COALESCE(canonical_genre.name, t.genre) AS genre,
          COALESCE(sm.path, gm.path) AS genre_path,
          tf.acoustic_vector_8d::text AS acoustic_vector_text,
          ${distanceSql} AS distance,
          ${noveltySql} AS novelty_boost,
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

  const dedupeCandidateRows = (rows: any[]): any[] => {
    const mergedCandidateMap = new Map<string, any>();
    for (const row of rows) {
      const candidateKey = String(row.id || getSongDedupKey(row));
      const existing = mergedCandidateMap.get(candidateKey);
      const currentScore = Number(row.distance ?? Infinity) - Number(row.pool_bias ?? 0);
      const existingScore = existing ? (Number(existing.distance ?? Infinity) - Number(existing.pool_bias ?? 0)) : Infinity;
      if (!existing || currentScore < existingScore) {
        mergedCandidateMap.set(candidateKey, row);
      }
    }
    return Array.from(mergedCandidateMap.values());
  };

  const getTargetArtistFloor = (requestedCount: number, relaxationLevel: number): number => {
    const ratio = relaxationLevel <= 1
      ? 0.65
      : relaxationLevel === 2
        ? 0.55
        : 0.45;
    return Math.min(requestedCount, Math.max(4, Math.ceil(requestedCount * ratio)));
  };

  const getFilteredCandidateRows = (
    rows: any[],
    options: { excludedSongKeys?: Set<string>; bannedGenres?: string[]; softVeto?: boolean }
  ) => rows.filter((row) => {
    if (options.excludedSongKeys?.has(getSongDedupKey(row))) return false;
    if (options.bannedGenres && options.bannedGenres.length > 0 && !options.softVeto) {
      const fullPath = getFullGenrePath(row);
      if (isPathBlockedByBannedGenre(fullPath, options.bannedGenres)) return false;
    }
    return true;
  });

  const getCandidateViability = (
    rows: any[],
    options: { relaxationLevel: number; excludedSongKeys?: Set<string>; bannedGenres?: string[]; softVeto?: boolean }
  ) => {
    const availableRows = getFilteredCandidateRows(rows, options);
    const uniqueSongs = new Set(availableRows.map(getSongDedupKey)).size;
    const uniqueArtists = new Set(availableRows.map((row) => normalizeArtistName(row.artist || 'unknown-artist'))).size;
    const minArtists = getTargetArtistFloor(tracksPerPlaylist, options.relaxationLevel);
    return {
      trackCount: availableRows.length,
      uniqueSongs,
      uniqueArtists,
      viable: uniqueSongs >= tracksPerPlaylist && uniqueArtists >= minArtists,
    };
  };

  const formatFilteredPoolStat = (
    name: string,
    rows: any[],
    options: { excludedSongKeys?: Set<string>; bannedGenres?: string[]; softVeto?: boolean }
  ) => {
    const filteredRows = getFilteredCandidateRows(rows, options);
    return formatPoolStat(name, filteredRows);
  };

  const formatPoolStat = (name: string, rows: any[]) => {
    const uniqueSongs = new Set(rows.map(getSongDedupKey)).size;
    const uniqueArtists = new Set(rows.map((row) => normalizeArtistName(row.artist || 'unknown-artist'))).size;
    return `${name}=${rows.length}t/${uniqueSongs}s/${uniqueArtists}a`;
  };

  const formatDiagnosticBlock = ({
    title,
    compiled,
    relaxationSnapshots,
    relaxationLabelReached,
    relaxationLevelReached,
    poolStats,
    vetoModeLabel,
    referenceGenre,
    llmGenreWeight,
    selectedCount,
    selectedArtistCount,
    selectedPoolMix,
    diversityScore,
    diagnostics,
  }: {
    title: string;
    compiled: Awaited<ReturnType<typeof compileConceptToLibrary>>;
    relaxationSnapshots: string[];
    relaxationLabelReached: string;
    relaxationLevelReached: number;
    poolStats: string;
    vetoModeLabel: string;
    referenceGenre: string;
    llmGenreWeight: number;
    selectedCount: number;
    selectedArtistCount: number;
    selectedPoolMix: Record<string, number>;
    diversityScore: number;
    diagnostics: {
      distinctArtists: number;
      distinctAlbums: number;
      distinctRoots: number;
      distinctPools: number;
      distinctClusters: number;
      meanPairwiseDistance: number;
    };
  }) => {
    const healthSummary = compiled.primaryHealth
      ? `${compiled.primaryHealth.health.toFixed(2)} (${compiled.primaryHealth.trackCount}t/${compiled.primaryHealth.artistCount}a/${compiled.primaryHealth.songCount}s)`
      : 'n/a';
    const targetPaths = compiled.corePaths.length > 0 ? compiled.corePaths.join(', ') : 'none';
    const adjacentPaths = compiled.adjacentPaths.length > 0 ? compiled.adjacentPaths.join(', ') : 'none';
    const poolMixSummary = Object.entries(selectedPoolMix).length > 0
      ? Object.entries(selectedPoolMix).map(([key, value]) => `${key}:${value}`).join(', ')
      : 'none';

    return [
      `[LLM Hub] Playlist Diagnostic: "${title}"`,
      `  mode=${compiled.mode} | targets=${targetPaths} | adjacent=${adjacentPaths}`,
      `  health=${healthSummary} | effectiveBlend=${compiled.effectiveGenreBlend.toFixed(2)} | veto=${vetoModeLabel}`,
      `  pools=${poolStats}`,
      `  relaxation=${relaxationSnapshots.join(' -> ')} | reached=${relaxationLabelReached} (L${relaxationLevelReached})`,
      `  anchor=${referenceGenre || 'none'}${referenceGenre ? ` (weight=${llmGenreWeight.toFixed(2)})` : ''}`,
      `  selected=${selectedCount} tracks / ${selectedArtistCount} artists | poolMix=${poolMixSummary}`,
      `  diversity=${diversityScore.toFixed(2)} | artists=${diagnostics.distinctArtists} albums=${diagnostics.distinctAlbums} roots=${diagnostics.distinctRoots} pools=${diagnostics.distinctPools} clusters=${diagnostics.distinctClusters} meanPairDistance=${diagnostics.meanPairwiseDistance.toFixed(3)}`,
    ].join('\n');
  };

  // Helper: synthesize a 1280D EffNet embedding centroid from the 8D acoustic seed results.
  // The LLM generates an 8D target vector — we don't have a 1280D embedding from the LLM.
  // Instead, we find the 20 closest 8D tracks and average their 1280D embeddings.
  // Uses "Relative Cliff" check to detect sparse/poisoned neighborhoods.
  const imputeEffNetCentroid = async (seed8DStr: string): Promise<string | null> => {
    try {
      const seedRes = await queryWithRetry(`
        SELECT tf.embedding_vector::text as vec,
               (tf.acoustic_vector_8d <-> $1::vector) as distance
        FROM tracks t
        JOIN track_features tf ON t.id = tf.track_id
        WHERE tf.embedding_vector IS NOT NULL
        ORDER BY tf.acoustic_vector_8d <-> $1::vector ASC
        LIMIT 20
      `, [seed8DStr]);

      if (seedRes.rows.length < 5) return null;

      const firstBestDistance = seedRes.rows[0].distance;
      const fifthBestDistance = seedRes.rows[4].distance;

      const ABSOLUTE_CEILING = 1.5;
      const MAX_ALLOWED_CLIFF = 0.5;

      if (fifthBestDistance > ABSOLUTE_CEILING || (fifthBestDistance - firstBestDistance > MAX_ALLOWED_CLIFF)) {
        console.log(`[EffNet Impute] Neighborhood too sparse/steep. 1st: ${firstBestDistance.toFixed(3)}, 5th: ${fifthBestDistance.toFixed(3)}. Aborting.`);
        return null;
      }

      // Compute centroid from valid seeds
      const validSeeds = seedRes.rows.filter((r: any) => r.distance <= 1.5);

      // Determine dimension from the first valid EffNet seed; current embeddings are 1280D.
      const firstVec = JSON.parse(validSeeds[0].vec);
      const dim = firstVec.length;
      const centroid = new Array(dim).fill(0);

      for (const row of validSeeds) {
        const vec = JSON.parse(row.vec);
        for (let i = 0; i < dim; i++) centroid[i] += vec[i];
      }

      const n = validSeeds.length;
      // L2-normalize the centroid for cosine distance compatibility
      const norm = Math.sqrt(centroid.reduce((s, v) => s + (v / n) * (v / n), 0));
      if (norm > 0) {
        for (let i = 0; i < dim; i++) centroid[i] = (centroid[i] / n) / norm;
      } else {
        for (let i = 0; i < dim; i++) centroid[i] = centroid[i] / n;
      }

      console.log(`[EffNet Impute] Successfully blended ${n} seeds (${dim}D) for embedding centroid.`);
      return `[${centroid.join(',')}]`;
    } catch {
      return null;
    }
  };

  // Generate tracks for each LLM concept and persist them as Playlists
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

      const vectorStr = `[${compiled.adaptedTargetVector.join(',')}]`;
      const bridgeVectorStr = `[${compiled.bridgeVector.join(',')}]`;
      const targetAcousticness = compiled.adaptedTargetVector[5];
      const effnetWeight = targetAcousticness < 0.3 ? 3.0 : 1.0;
      const embeddingCentroidStr = await imputeEffNetCentroid(vectorStr);

      const ABSOLUTE_MAX_FETCH = 240;
      const dynamicFetchSize = Math.min((tracksPerPlaylist * (4 + (recoveryStrength * 1.5))) + 60, ABSOLUTE_MAX_FETCH);
      const assignedIds = Array.from(assignedTrackIds);

      if (compiled.diagnostics.notes.length > 0) {
        console.log(`[LLM Hub] "${concept.title}" → ${compiled.diagnostics.notes.join(' ')}`);
      }
      if (compiled.diagnostics.shouldRegenerate) {
        console.warn(`[LLM Hub] Dropping playlist "${concept.title}" - low-quality concept compile (score=${compiled.diagnostics.qualityScore.toFixed(2)}). ${compiled.diagnostics.regenerateReason || ''}`.trim());
        (concept as any).dropped = true;
        continue;
      }
      if (compiled.primaryPath && compiled.primaryHealth && compiled.effectiveGenreBlend < genreBlend) {
        console.log(
          `[LLM Hub] "${concept.title}" → adapting genre blend ${genreBlend.toFixed(2)} → ${compiled.effectiveGenreBlend.toFixed(2)} for local genre health ${compiled.primaryHealth.health.toFixed(2)} (${compiled.primaryHealth.trackCount} tracks, ${compiled.primaryHealth.artistCount} artists).`
        );
      }

      const coreLimit = compiled.corePaths.length
        ? Math.max(10, Math.floor(dynamicFetchSize * Math.max(0.16, compiled.effectiveGenreBlend * (0.48 - (recoveryStrength * 0.10)))))
        : 0;
      const adjacentLimit = compiled.adjacentPaths.length
        ? Math.max(10, Math.floor(dynamicFetchSize * (0.15 + (adjacentReach * 0.15))))
        : 0;
      const rootLimit = compiled.rootPaths.length
        ? Math.max(12, Math.floor(dynamicFetchSize * (0.12 + (recoveryStrength * 0.10))))
        : 0;
      const acousticLimit = Math.max(18, Math.floor(dynamicFetchSize * (compiled.mode === 'acoustic-only' ? 0.55 + (recoveryStrength * 0.15) : 0.24 + (recoveryStrength * 0.16))));
      const bridgeLimit = Math.max(10, Math.ceil(tracksPerPlaylist * (1.6 + (recoveryStrength * 1.0))));
      const discoveryLimit = Math.max(10, Math.ceil(tracksPerPlaylist * (1.4 + (discoveryBias * 1.4))));

      const [coreRows, adjacentRows, rootRows, acousticRows, discoveryRows, bridgeRows] = await Promise.all([
        compiled.corePaths.length > 0
          ? fetchLlmPool({
              poolName: 'core',
              vectorStr,
              embeddingCentroidStr,
              effnetWeight,
              limit: coreLimit,
              pathPrefixes: compiled.corePaths,
              excludeIds: assignedIds,
            })
          : Promise.resolve([]),
        compiled.adjacentPaths.length > 0
          ? fetchLlmPool({
              poolName: 'adjacent',
              vectorStr,
              embeddingCentroidStr,
              effnetWeight,
              limit: adjacentLimit,
              pathPrefixes: compiled.adjacentPaths,
              excludeIds: assignedIds,
              excludePrefixes: compiled.corePaths,
            })
          : Promise.resolve([]),
        compiled.rootPaths.length > 0
          ? fetchLlmPool({
              poolName: 'root',
              vectorStr,
              embeddingCentroidStr,
              effnetWeight,
              limit: rootLimit,
              pathPrefixes: compiled.rootPaths,
              excludeIds: assignedIds,
              excludePrefixes: [...compiled.corePaths, ...compiled.adjacentPaths],
            })
          : Promise.resolve([]),
        fetchLlmPool({
          poolName: 'acoustic',
          vectorStr,
          embeddingCentroidStr,
          effnetWeight,
          limit: acousticLimit,
          excludeIds: assignedIds,
        }),
        fetchLlmPool({
          poolName: 'discovery',
          vectorStr,
          embeddingCentroidStr,
          effnetWeight,
          limit: discoveryLimit,
          excludeIds: assignedIds,
          enableDiscoveryBoost: true,
        }),
        fetchLlmPool({
          poolName: 'bridge',
          vectorStr: bridgeVectorStr,
          embeddingCentroidStr,
          effnetWeight,
          limit: bridgeLimit,
          excludeIds: assignedIds,
        }),
      ]);

      const genrePoolWeak = compiled.primaryPath
        ? isGenrePoolWeak(coreRows, concept.title, compiled.primaryHealth, 'Core pool')
        : true;

      const relaxationSteps: Array<{ level: number; key: string; label: string; rows: any[] }> = [
        { level: 0, key: 'core', label: 'exact-path', rows: coreRows },
        { level: 1, key: 'adjacent', label: 'adjacent-path', rows: adjacentRows },
        { level: 2, key: 'root', label: 'same-root', rows: rootRows },
        { level: 3, key: 'acoustic', label: 'acoustic-similarity', rows: acousticRows },
        { level: 4, key: 'bridge', label: 'mood-bridge', rows: bridgeRows },
        { level: 5, key: 'discovery', label: 'discovery-backfill', rows: discoveryRows },
      ];

      let candidateRows: any[] = [];
      let relaxationLevelReached = 5;
      let relaxationLabelReached = 'discovery-backfill';
      const relaxationSnapshots: string[] = [];

      for (const step of relaxationSteps) {
        candidateRows = dedupeCandidateRows([
          ...candidateRows,
          ...step.rows,
        ]);
        const viability = getCandidateViability(candidateRows, {
          relaxationLevel: step.level,
          excludedSongKeys: assignedSongKeys,
          bannedGenres: compiled.bannedGenres,
          softVeto: allowSoftVetoRecovery && step.level >= 3,
        });
        relaxationSnapshots.push(`${step.label}=${viability.trackCount}t/${viability.uniqueSongs}s/${viability.uniqueArtists}a`);
        relaxationLevelReached = step.level;
        relaxationLabelReached = step.label;
        if (viability.viable) {
          break;
        }
      }

      const poolStatsSummary = [
        formatPoolStat('core', coreRows),
        formatPoolStat('adjacent', adjacentRows),
        formatPoolStat('root', rootRows),
        formatPoolStat('acoustic', acousticRows),
        formatPoolStat('discovery', discoveryRows),
        formatPoolStat('bridge', bridgeRows),
      ].join(' | ');
      const hardFilteredPoolStatsSummary = [
        formatFilteredPoolStat('core', coreRows, { excludedSongKeys: assignedSongKeys, bannedGenres: compiled.bannedGenres, softVeto: false }),
        formatFilteredPoolStat('adjacent', adjacentRows, { excludedSongKeys: assignedSongKeys, bannedGenres: compiled.bannedGenres, softVeto: false }),
        formatFilteredPoolStat('root', rootRows, { excludedSongKeys: assignedSongKeys, bannedGenres: compiled.bannedGenres, softVeto: false }),
        formatFilteredPoolStat('acoustic', acousticRows, { excludedSongKeys: assignedSongKeys, bannedGenres: compiled.bannedGenres, softVeto: false }),
        formatFilteredPoolStat('discovery', discoveryRows, { excludedSongKeys: assignedSongKeys, bannedGenres: compiled.bannedGenres, softVeto: false }),
        formatFilteredPoolStat('bridge', bridgeRows, { excludedSongKeys: assignedSongKeys, bannedGenres: compiled.bannedGenres, softVeto: false }),
      ].join(' | ');

      if (candidateRows.length === 0) {
        console.warn(`[LLM Hub] Dropping playlist "${concept.title}" - no candidates survived compiled pool generation. Filtered pools: ${hardFilteredPoolStatsSummary}`);
        (concept as any).dropped = true;
        continue;
      }

      const referenceGenre = compiled.primaryPath && relaxationLevelReached <= 2 ? compiled.primaryPath : '';
      const llmGenreWeight = referenceGenre
        ? Math.min(1.0, compiled.effectiveGenreBlend * 2)
        : Math.min(0.35, compiled.effectiveGenreBlend);
      const softVetoEnabled = allowSoftVetoRecovery && relaxationLevelReached >= 3;
      const vetoModeLabel = compiled.bannedGenres.length > 0
        ? `${allowSoftVetoRecovery ? 'hard veto with adaptive recovery' : 'hard veto'} [${compiled.bannedGenres.join(', ')}]`
        : 'none';
      const admissibleRows = getFilteredCandidateRows(candidateRows, {
        excludedSongKeys: assignedSongKeys,
        bannedGenres: compiled.bannedGenres,
        softVeto: softVetoEnabled,
      });

      let ranked = reRankByHopCost(
        candidateRows,
        referenceGenre,
        Math.max(tracksPerPlaylist * 3, 30),
        llmGenreWeight,
        compiled.bannedGenres,
        softVetoEnabled,
        compiled.rootPaths
      );
      if (allowSoftVetoRecovery && ranked.length === 0 && compiled.bannedGenres.length > 0) {
        console.warn(`[LLM Hub] "${concept.title}" → hard veto removed every candidate; retrying with soft veto penalties.`);
        ranked = reRankByHopCost(
          candidateRows,
          referenceGenre,
          Math.max(tracksPerPlaylist * 3, 30),
          llmGenreWeight,
          compiled.bannedGenres,
          true,
          compiled.rootPaths
        );
      }
      if (ranked.length === 0 && admissibleRows.length > 0) {
        console.warn(`[LLM Hub] "${concept.title}" → anchored rerank returned 0 despite ${admissibleRows.length} admissible candidates; retrying with relaxed rerank.`);
        ranked = reRankByHopCost(
          admissibleRows,
          '',
          Math.max(tracksPerPlaylist * 3, 30),
          Math.min(0.25, llmGenreWeight),
          [],
          true,
          compiled.rootPaths
        );
      }
      if (ranked.length === 0 && admissibleRows.length > 0) {
        ranked = [...admissibleRows]
          .filter((row) => Number.isFinite(Number(row.distance ?? NaN)))
          .sort((left, right) => {
            const leftScore = Number(left.distance ?? Infinity) - Number(left.pool_bias ?? 0);
            const rightScore = Number(right.distance ?? Infinity) - Number(right.pool_bias ?? 0);
            return leftScore - rightScore;
          })
          .slice(0, Math.max(tracksPerPlaylist * 3, 30));
      }
      const candidateSongKeys = new Set<string>();
      let uniqueRanked = ranked.filter((row) => {
        const songKey = getSongDedupKey(row);
        if (assignedSongKeys.has(songKey) || candidateSongKeys.has(songKey)) return false;
        candidateSongKeys.add(songKey);
        return true;
      });
      if (uniqueRanked.length === 0 && admissibleRows.length > 0) {
        console.warn(`[LLM Hub] "${concept.title}" → ranked candidate set collapsed after fallback despite ${admissibleRows.length} admissible rows; using direct admissible dedupe.`);
        const admissibleSongKeys = new Set<string>();
        uniqueRanked = [...admissibleRows]
          .sort((left, right) => {
            const leftScore = Number(left.distance ?? Infinity) - Number(left.pool_bias ?? 0);
            const rightScore = Number(right.distance ?? Infinity) - Number(right.pool_bias ?? 0);
            return leftScore - rightScore;
          })
          .filter((row) => {
            const songKey = getSongDedupKey(row);
            if (assignedSongKeys.has(songKey) || admissibleSongKeys.has(songKey)) return false;
            admissibleSongKeys.add(songKey);
            return true;
          })
          .slice(0, Math.max(tracksPerPlaylist * 3, 30));
      }
      if (uniqueRanked.length === 0) {
        const postRankViability = getCandidateViability(candidateRows, {
          relaxationLevel: relaxationLevelReached,
          excludedSongKeys: assignedSongKeys,
          bannedGenres: compiled.bannedGenres,
          softVeto: softVetoEnabled,
        });
        console.warn(`[LLM Hub] Dropping playlist "${concept.title}" - all candidate tracks were vetoed or invalid. Filtered pools: ${hardFilteredPoolStatsSummary}. Post-filter viability=${postRankViability.trackCount}t/${postRankViability.uniqueSongs}s/${postRankViability.uniqueArtists}a`);
        (concept as any).dropped = true;
        continue;
      }

      const getPoolAvailability = (poolName: string) => {
        const rows = uniqueRanked.filter((row) => String(row.pool_source || 'unknown') === poolName);
        return {
          trackCount: rows.length,
          uniqueSongs: new Set(rows.map(getSongDedupKey)).size,
          uniqueArtists: new Set(rows.map((row) => normalizeArtistName(row.artist || 'unknown-artist'))).size,
        };
      };

      const coreAvailability = getPoolAvailability('core');
      const adjacentAvailability = getPoolAvailability('adjacent');
      const rootAvailability = getPoolAvailability('root');
      const acousticAvailability = getPoolAvailability('acoustic');
      const bridgeAvailability = getPoolAvailability('bridge');
      const discoveryAvailability = getPoolAvailability('discovery');
      const shouldForceBlend = tracksPerPlaylist >= 12 && (
        relaxationLevelReached >= 1 ||
        genrePoolWeak ||
        coreAvailability.uniqueArtists < getTargetArtistFloor(tracksPerPlaylist, 0) ||
        coreAvailability.uniqueSongs < Math.ceil(tracksPerPlaylist * 1.35)
      );

      const poolTargets = new Map<string, number>();
      if (referenceGenre) {
        const desiredCoreTarget = Math.max(1, Math.round(tracksPerPlaylist * Math.max(0.20, compiled.effectiveGenreBlend * (0.50 - (discoveryBias * 0.15)))));
        const cappedCoreTarget = shouldForceBlend
          ? Math.min(desiredCoreTarget, Math.max(2, Math.round(tracksPerPlaylist * 0.55)))
          : desiredCoreTarget;
        poolTargets.set('core', cappedCoreTarget);
      }
      if (compiled.adjacentPaths.length > 0 && adjacentAvailability.trackCount > 0) {
        const adjacentTarget = Math.max(1, Math.round(tracksPerPlaylist * (0.12 + (adjacentReach * 0.12))));
        poolTargets.set('adjacent', shouldForceBlend ? Math.max(adjacentTarget, Math.round(tracksPerPlaylist * 0.15)) : adjacentTarget);
      }
      if (compiled.rootPaths.length > 0 && (relaxationLevelReached >= 2 || (shouldForceBlend && rootAvailability.trackCount > 0))) {
        poolTargets.set('root', Math.max(1, Math.round(tracksPerPlaylist * (shouldForceBlend ? 0.18 : (0.10 + (recoveryStrength * 0.08))))));
      }
      if (relaxationLevelReached >= 3 || (shouldForceBlend && acousticAvailability.trackCount > 0)) {
        const acousticTarget = Math.max(2, Math.round(tracksPerPlaylist * (genrePoolWeak ? (0.35 + (recoveryStrength * 0.22)) : (0.18 + (recoveryStrength * 0.12)))));
        poolTargets.set('acoustic', shouldForceBlend ? Math.max(acousticTarget, Math.round(tracksPerPlaylist * 0.20)) : acousticTarget);
      }
      if (relaxationLevelReached >= 4 || (shouldForceBlend && bridgeAvailability.trackCount > 0)) {
        poolTargets.set('bridge', Math.max(1, Math.round(tracksPerPlaylist * (shouldForceBlend ? 0.12 : (0.10 + (discoveryBias * 0.10) + (recoveryStrength * 0.08))))));
      }
      if (relaxationLevelReached >= 5 || discoveryBias >= 0.55 || (shouldForceBlend && discoveryAvailability.trackCount > 0)) {
        poolTargets.set('discovery', Math.max(1, Math.round(tracksPerPlaylist * (shouldForceBlend ? 0.12 : (0.10 + (discoveryBias * 0.16))))));
      }

      const maxTracksPerArtist = artistSpread >= 0.75
        ? 1
        : artistSpread >= 0.45
          ? (tracksPerPlaylist <= 10 ? 1 : 2)
          : (tracksPerPlaylist <= 5 ? 1 : tracksPerPlaylist <= 15 ? 2 : 3);
      let selection = selectDiverseTracks(uniqueRanked, tracksPerPlaylist, diversity, maxTracksPerArtist, poolTargets, {
        discoveryBias,
        artistSpread,
      });
      const minimumSelectedArtists = Math.min(tracksPerPlaylist, getTargetArtistFloor(tracksPerPlaylist, Math.min(3, relaxationLevelReached + 1)));
      const shouldRescueSelection =
        selection.selected.length < tracksPerPlaylist ||
        selection.diagnostics.distinctArtists < minimumSelectedArtists ||
        (tracksPerPlaylist >= 10 && selection.diversityScore < 0.46);

      if (shouldRescueSelection) {
        const rescueTargets = new Map(poolTargets);
        if (coreAvailability.trackCount > 0) {
          rescueTargets.set('core', Math.min(rescueTargets.get('core') ?? tracksPerPlaylist, Math.max(2, Math.round(tracksPerPlaylist * 0.35))));
        }
        if (adjacentAvailability.trackCount > 0) {
          rescueTargets.set('adjacent', Math.max(rescueTargets.get('adjacent') ?? 0, Math.max(1, Math.round(tracksPerPlaylist * 0.15))));
        }
        if (rootAvailability.trackCount > 0) {
          rescueTargets.set('root', Math.max(rescueTargets.get('root') ?? 0, Math.max(1, Math.round(tracksPerPlaylist * 0.18))));
        }
        if (acousticAvailability.trackCount > 0) {
          rescueTargets.set('acoustic', Math.max(rescueTargets.get('acoustic') ?? 0, Math.max(2, Math.round(tracksPerPlaylist * 0.20))));
        }
        if (bridgeAvailability.trackCount > 0) {
          rescueTargets.set('bridge', Math.max(rescueTargets.get('bridge') ?? 0, Math.max(1, Math.round(tracksPerPlaylist * 0.12))));
        }
        if (discoveryAvailability.trackCount > 0) {
          rescueTargets.set('discovery', Math.max(rescueTargets.get('discovery') ?? 0, Math.max(1, Math.round(tracksPerPlaylist * 0.12))));
        }

        const rescuedSelection = selectDiverseTracks(
          uniqueRanked,
          tracksPerPlaylist,
          Math.min(1, diversity + 0.12),
          Math.max(1, maxTracksPerArtist - 1),
          rescueTargets,
          {
            discoveryBias: Math.min(1, discoveryBias + 0.10),
            artistSpread: Math.min(1, artistSpread + 0.15),
          }
        );

        const rescuedIsBetter =
          rescuedSelection.selected.length > selection.selected.length ||
          rescuedSelection.diagnostics.distinctArtists > selection.diagnostics.distinctArtists ||
          rescuedSelection.diversityScore > selection.diversityScore + 0.04;

        if (rescuedIsBetter) {
          selection = rescuedSelection;
        }
      }

      const longPlaylistQualityFloorTriggered = tracksPerPlaylist >= 18 && (
        selection.diagnostics.distinctArtists < 14 ||
        selection.diversityScore < 0.45
      );
      if (longPlaylistQualityFloorTriggered) {
        const qualityFloorTargets = new Map<string, number>();
        if (coreAvailability.trackCount > 0) {
          qualityFloorTargets.set('core', Math.max(2, Math.round(tracksPerPlaylist * 0.35)));
        }
        if (adjacentAvailability.trackCount > 0) {
          qualityFloorTargets.set('adjacent', Math.max(2, Math.round(tracksPerPlaylist * 0.18)));
        }
        if (rootAvailability.trackCount > 0) {
          qualityFloorTargets.set('root', Math.max(2, Math.round(tracksPerPlaylist * 0.18)));
        }
        if (acousticAvailability.trackCount > 0) {
          qualityFloorTargets.set('acoustic', Math.max(3, Math.round(tracksPerPlaylist * 0.22)));
        }
        if (bridgeAvailability.trackCount > 0) {
          qualityFloorTargets.set('bridge', Math.max(2, Math.round(tracksPerPlaylist * 0.12)));
        }
        if (discoveryAvailability.trackCount > 0) {
          qualityFloorTargets.set('discovery', Math.max(2, Math.round(tracksPerPlaylist * 0.12)));
        }

        const qualityFloorRows = uniqueRanked.map((row) => ({
          ...row,
          pool_bias: Number(row.pool_bias ?? 0) + (String(row.pool_source || 'unknown') === 'core' ? -0.06 : 0.10),
        }));

        const qualityFloorSelection = selectDiverseTracks(
          qualityFloorRows,
          tracksPerPlaylist,
          Math.min(1, diversity + 0.18),
          1,
          qualityFloorTargets,
          {
            discoveryBias: Math.min(1, discoveryBias + 0.15),
            artistSpread: 1,
          }
        );

        const floorSatisfied = qualityFloorSelection.selected.length === tracksPerPlaylist && (
          qualityFloorSelection.diagnostics.distinctArtists >= 14 ||
          qualityFloorSelection.diversityScore >= 0.45
        );
        const floorImproved =
          qualityFloorSelection.diagnostics.distinctArtists > selection.diagnostics.distinctArtists ||
          qualityFloorSelection.diversityScore > selection.diversityScore + 0.03;

        if (floorSatisfied || floorImproved) {
          selection = qualityFloorSelection;
        }
      }

      const topTracks = selection.selected;
      if (topTracks.length === 0) {
        console.warn(`[LLM Hub] Dropping playlist "${concept.title}" - no selectable tracks remained after ranking.`);
        (concept as any).dropped = true;
        continue;
      }

      const selectedPoolMix = topTracks.reduce<Record<string, number>>((acc, track) => {
        const key = String(track.pool_source || 'unknown');
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {});
      const selectedArtistCount = new Set(topTracks.map((track) => normalizeArtistName(track.artist || 'unknown-artist'))).size;
      console.log(formatDiagnosticBlock({
        title: concept.title || concept.section,
        compiled,
        relaxationSnapshots,
        relaxationLabelReached,
        relaxationLevelReached,
        poolStats: poolStatsSummary,
        vetoModeLabel,
        referenceGenre,
        llmGenreWeight,
        selectedCount: topTracks.length,
        selectedArtistCount,
        selectedPoolMix,
        diversityScore: selection.diversityScore,
        diagnostics: selection.diagnostics,
      }));

      // Register these track IDs to prevent overlap in subsequent playlists
      for (const t of topTracks) {
        assignedTrackIds.add(t.id);
        assignedSongKeys.add(getSongDedupKey(t));
      }

      // Create a formal Playlist record (user-scoped)
      const playlistId = `llm_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      await createPlaylist(
        playlistId,
        concept.title || concept.section,
        concept.description,
        true,
        userId,
        false,
        settings.llmGenerationSource ?? 'hub'
      );

      const trackIds = topTracks.map((r: any) => r.id);
      await addTracksToPlaylist(playlistId, trackIds);

      hubs.push({
        id: playlistId,
        title: concept.title || concept.section,
        description: concept.description,
        isLlmGenerated: true,
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
          const ranked = reRankByHopCost(upNextRes.rows, referenceGenre, 30);
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
         const ranked = reRankByHopCost(upNextRes.rows, referenceGenre, 30);
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
          const ranked = reRankByHopCost(vaultRes.rows, referenceGenre, 30);
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
         const ranked = reRankByHopCost(vaultRes.rows, referenceGenre, 30);
         const shuffled = ranked.sort(() => 0.5 - Math.random());
         const playlist = await persistSystem('vault', 'The Vault', 'Unplayed tracks that match your taste.', shuffled);
         if (playlist) engineHubs.push(playlist);
       }
    }
  }

  // 4. Genre system playlists. For the user's strongest genres, create one
  // full familiar set and one rediscovery set whose tracks are untouched for 4+ weeks.
  if (userId && (systemPlaylistConfig.genreHeavyRotation || systemPlaylistConfig.genreRediscovery)) {
    const genreStatsRes = await queryWithRetry(`
      SELECT
        g.id AS genre_id,
        g.name AS genre,
        COUNT(*)::int AS track_count,
        COALESCE(SUM(ups.play_count), 0)::int AS user_plays,
        COUNT(*) FILTER (
          WHERE ups.track_id IS NULL
             OR ups.play_count = 0
             OR ups.last_played_at IS NULL
             OR ups.last_played_at < NOW() - INTERVAL '4 weeks'
        )::int AS rediscovery_count
      FROM tracks t
      JOIN genres g ON g.id = t.genre_id AND g.merged_into IS NULL
      LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
      WHERE trim(g.name) <> ''
      GROUP BY g.id, g.name
      HAVING COUNT(*) >= ${systemPlaylistMinTracks}
      ORDER BY COALESCE(SUM(ups.play_count), 0) DESC, COUNT(*) DESC
      LIMIT ${maxGenreSystemMixes}
    `, [userId]);

    const seenGenreSlugs = new Set<string>();
    for (const row of genreStatsRes.rows) {
      const rawGenre = String((row as any).genre || '').trim();
      const canonicalGenreId = String((row as any).genre_id || '');
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
              AND t.genre_id = $2::uuid
            ORDER BY ups.play_count DESC, ups.last_played_at DESC NULLS LAST
            LIMIT ${systemPlaylistTrackLimit}
          `, [userId, canonicalGenreId])
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
            WHERE t.genre_id = $2::uuid
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
            LIMIT ${systemPlaylistTrackLimit}
          `, [userId, canonicalGenreId])
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

  // 5. Decade system playlists. Build broad decade mixes first, then expand
  // into decade + genre cards only when the library can fill the card.
  if (userId && (systemPlaylistConfig.decadeMixes || systemPlaylistConfig.decadeGenreMixes)) {
    const decadeStatsRes = await queryWithRetry(`
      SELECT
        (floor(t.year / 10) * 10)::int AS decade,
        COUNT(*)::int AS track_count,
        COALESCE(SUM(ups.play_count), 0)::int AS user_plays
      FROM tracks t
      LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
      WHERE t.year IS NOT NULL
        AND t.year >= 1950
        AND t.year <= EXTRACT(YEAR FROM NOW())::int
      GROUP BY (floor(t.year / 10) * 10)::int
      HAVING COUNT(*) >= ${systemPlaylistMinTracks}
      ORDER BY COALESCE(SUM(ups.play_count), 0) DESC, COUNT(*) DESC, (floor(t.year / 10) * 10)::int DESC
      LIMIT ${maxDecadeSystemMixes}
    `, [userId]);

    const decadeValues = decadeStatsRes.rows
      .map((row: any) => Number(row.decade))
      .filter((decade: number) => Number.isFinite(decade));

    for (const decade of systemPlaylistConfig.decadeMixes ? decadeValues : []) {
      const decadeRes = await queryWithRetry(`
        SELECT t.*, COALESCE(ups.play_count, 0) AS play_count, ups.last_played_at AS user_last_played
        FROM tracks t
        LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
        WHERE t.year >= $2 AND t.year < $3
        ORDER BY COALESCE(ups.play_count, 0) DESC, ups.last_played_at DESC NULLS LAST, random()
        LIMIT ${systemPlaylistTrackLimit}
      `, [userId, decade, decade + 10]);

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

    if (systemPlaylistConfig.decadeGenreMixes && decadeValues.length > 0) {
      const decadeGenreRes = await queryWithRetry(`
        SELECT
          (floor(t.year / 10) * 10)::int AS decade,
          g.id AS genre_id,
          g.name AS genre,
          COUNT(*)::int AS track_count,
          COALESCE(SUM(ups.play_count), 0)::int AS user_plays
        FROM tracks t
        JOIN genres g ON g.id = t.genre_id AND g.merged_into IS NULL
        LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
        WHERE t.year IS NOT NULL
          AND t.year >= 1950
          AND t.year <= EXTRACT(YEAR FROM NOW())::int
          AND trim(g.name) <> ''
        GROUP BY (floor(t.year / 10) * 10)::int, g.id, g.name
        HAVING COUNT(*) >= ${systemPlaylistMinTracks}
        ORDER BY user_plays DESC, track_count DESC, decade DESC
        LIMIT 40
      `, [userId]);

      const decadeGenreCandidates = decadeGenreRes.rows as any[];
      const selectedDecadeGenreRows: any[] = [];
      const selectedGenreSlugs = new Set<string>();
      for (const row of decadeGenreCandidates) {
        const genreSlug = toSystemGenreSlug(String((row as any).genre || ''));
        if (selectedGenreSlugs.has(genreSlug)) continue;
        selectedGenreSlugs.add(genreSlug);
        selectedDecadeGenreRows.push(row);
        if (selectedDecadeGenreRows.length >= maxDecadeGenreSystemMixes) break;
      }
      for (const row of decadeGenreCandidates) {
        if (selectedDecadeGenreRows.length >= maxDecadeGenreSystemMixes) break;
        if (!selectedDecadeGenreRows.includes(row)) selectedDecadeGenreRows.push(row);
      }

      const seenDecadeGenreSlugs = new Set<string>();
      for (const row of selectedDecadeGenreRows) {
        const decade = Number((row as any).decade);
        const rawGenre = String((row as any).genre || '').trim();
        const canonicalGenreId = String((row as any).genre_id || '');
        const genreSlug = toSystemGenreSlug(rawGenre);
        const slug = `${decade}-${genreSlug}`;
        if (!Number.isFinite(decade) || !rawGenre || seenDecadeGenreSlugs.has(slug)) continue;
        seenDecadeGenreSlugs.add(slug);

        const genreName = formatSystemGenreName(rawGenre);
        const decadeGenreTracksRes = await queryWithRetry(`
          SELECT t.*, COALESCE(ups.play_count, 0) AS play_count, ups.last_played_at AS user_last_played
          FROM tracks t
          LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
          WHERE t.year >= $2
            AND t.year < $3
            AND t.genre_id = $4::uuid
          ORDER BY COALESCE(ups.play_count, 0) DESC, ups.last_played_at DESC NULLS LAST, random()
          LIMIT ${systemPlaylistTrackLimit}
        `, [userId, decade, decade + 10, canonicalGenreId]);

        if (decadeGenreTracksRes.rows.length >= systemPlaylistMinTracks) {
          const playlist = await persistSystem(
            `decade-genre-${slug}`,
            `${genreName} from the ${formatDecadeTitleLabel(decade)}`,
            `A decade mix with ${genreName} from the ${formatDecadeTitleLabel(decade)}.`,
            decadeGenreTracksRes.rows
          );
          if (playlist) engineHubs.push(playlist);
        }
      }
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
  options: { excludeTrackIds?: string[] } = {}
) {
  const excludeTrackIds = Array.isArray(options.excludeTrackIds) ? options.excludeTrackIds : [];
  const constraints = await getDynamicConstraints();
  
  // 1. Fetch vectors for the last 10 tracks to compute the Weighted Decay Centroid
  let targetVector = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]; // safe fallback
  let recentVectors: number[][] = [];
  
  if (sessionHistoryTrackIds.length > 0) {
    const last10Ids = sessionHistoryTrackIds.slice(-10);
    // Maintain strict order
    const placeholders = last10Ids.map((_, i) => `$${i + 1}`).join(',');
    const vecRes = await queryWithRetry(`
      SELECT t.id, tf.acoustic_vector_8d
      FROM tracks t JOIN track_features tf ON t.id = tf.track_id
      WHERE t.id IN (${placeholders}) AND tf.acoustic_vector_8d IS NOT NULL
        AND tf.is_simulated = FALSE
    `, last10Ids);

    // Map rows back to the ordered last10 array
    for (const id of last10Ids) {
      const row = vecRes.rows.find((r: any) => r.id === id) as any;
      const acousticVector = parseNumericVector(row?.acoustic_vector_8d, 8);
      if (acousticVector) {
        recentVectors.push(acousticVector);
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
  if (sessionHistoryTrackIds.length > 0) {
    const last10Ids = sessionHistoryTrackIds.slice(-10);
    const placeholders2 = last10Ids.map((_, i) => `$${i + 1}`).join(',');
    const effnetRes = await queryWithRetry(`
      SELECT t.id, tf.embedding_vector
      FROM tracks t JOIN track_features tf ON t.id = tf.track_id
      WHERE t.id IN (${placeholders2}) AND tf.embedding_vector IS NOT NULL
        AND tf.is_simulated = FALSE
    `, last10Ids);
    if (effnetRes.rows.length > 0) {
      const lambda = 0.8;
      const effnetTarget = new Array(1280).fill(0);
      let effnetWeightSum = 0;
      const orderedEffnet: number[][] = [];
      for (const id of last10Ids) {
        const row = effnetRes.rows.find((r: any) => r.id === id) as any;
        const embeddingVector = parseNumericVector(row?.embedding_vector, 1280);
        if (embeddingVector) orderedEffnet.push(embeddingVector);
      }
      if (orderedEffnet.length > 0) {
        for (let i = 0; i < orderedEffnet.length; i++) {
          const weight = Math.pow(lambda, orderedEffnet.length - 1 - i);
          effnetWeightSum += weight;
          for (let j = 0; j < 1280; j++) effnetTarget[j] += orderedEffnet[i][j] * weight;
        }
        effnetVectorStr = `[${effnetTarget.map(v => v / effnetWeightSum).join(',')}]`;
      }
    }
  }

  // Apply Frontend Settings for Engine Tuning
  let discoveryLevel = settings.discoveryLevel ?? 50; // 1-100
  let genreStrictness = settings.genreStrictness ?? 50; // 0-100
  
  // Base parameters
  let genreWeight = (genreStrictness / 100) * 3.0;
  let poolSize = Math.max(5, Math.floor(discoveryLevel / 2));
  let penaltySize = settings.artistAmnesiaLimit !== undefined 
                      ? settings.artistAmnesiaLimit 
                      : constraints.historyPenaltySize;
                      
  let currentGenre = '';
  if (sessionHistoryTrackIds.length > 0) {
    const lastTrackId = sessionHistoryTrackIds[sessionHistoryTrackIds.length - 1];
    const lastTrackRes = await queryWithRetry(`
      SELECT COALESCE(g.name, t.genre) AS genre
      FROM tracks t
      LEFT JOIN genres g ON g.id = t.genre_id
      WHERE t.id = $1
    `, [lastTrackId]);
    if (lastTrackRes.rows.length > 0 && (lastTrackRes.rows[0] as any).genre) {
      currentGenre = (lastTrackRes.rows[0] as any).genre as string;
    }
  }

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
        ORDER BY distance ASC
        LIMIT $${penaltyIds.length + 3}
      `, [vectorStr, effnetVectorStr, ...penaltyIds, overFetchLimit]);
    } else {
      res = await queryWithRetry(`
        SELECT t.*, COALESCE(g.name, t.genre) AS genre,
               tf.acoustic_vector_8d <-> $1::vector AS distance
        FROM tracks t
        JOIN track_features tf ON t.id = tf.track_id
        LEFT JOIN genres g ON g.id = t.genre_id
        WHERE tf.acoustic_vector_8d IS NOT NULL AND tf.is_simulated = FALSE${christmasExclusionSql('t')}
        ${historyClause ? `AND ${historyClause.replace(/^WHERE /, '')}` : ''}
        ORDER BY distance ASC
        LIMIT $${penaltyIds.length + 2}
      `, [vectorStr, ...penaltyIds, overFetchLimit]);
    }

    if (res.rows.length > 0) {
      // Step 4.2: Apply Hop Cost
      const scored = res.rows.map((row: any) => {
        const hopCost = genreMatrixService.getHopCost(currentGenre, row.genre || '');
        const finalScore = row.distance * Math.pow(1 + hopCost, genreWeight / 3.0);
        return { ...row, hopCost, originalDistance: row.distance, finalScore };
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
        const avgHop = finalCandidates.reduce((sum, c) => sum + (c.hopCost || 0), 0) / finalCandidates.length;
        console.log(`[Engine] Found tracks after ${attempt} relaxation(s). AvgMatch: ${avgMatch.toFixed(3)}, AvgHop: ${avgHop.toFixed(2)}, PenaltySize: ${penaltySize}, GenWt: ${genreWeight.toFixed(2)}`);
        break; // Met quota
      }
    }

    // Relax Constraints
    poolSize += 10;
    genreWeight *= 0.75;
    penaltySize = Math.max(0, Math.floor(penaltySize / 2));
  }

  // Handle absolute pool exhaustion gracefully. Prefer genuinely analyzed
  // tracks — simulated-fallback features are barred from Infinity unless the
  // library holds nothing else.
  if (finalCandidates.length === 0) {
      const randomFallback = await queryWithRetry(`
        SELECT t.* FROM tracks t
        LEFT JOIN track_features tf ON tf.track_id = t.id
        WHERE TRUE${christmasExclusionSql('t')}
        ORDER BY (tf.track_id IS NOT NULL AND tf.is_simulated = FALSE) DESC, RANDOM()
        LIMIT 1
      `);
      return randomFallback.rows[0];
  }

  // Wander Factor: Pick a track from the final candidates using a weighted randomizer
  const candidates = finalCandidates.map((row: any) => ({
      ...row,
      weight: 1 / (Math.max(0.01, row.finalScore))
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
