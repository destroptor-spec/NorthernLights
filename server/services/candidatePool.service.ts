import { queryWithRetry } from '../utils/db';
import { christmasExclusionSql } from '../utils/seasonalFilter';

// Shared multi-pool primitive used by smart-hub features (artist radio,
// daylist). Concepts are borrowed from the LLM playlist generator
// (recommendation.service.ts) — pool fetching with novelty/distance scoring,
// MB-recording-id + normalized-title dedup, artist-floor diversity selection,
// banned-genre veto with soft recovery. This module is intentionally
// self-contained so smart-hub features don't pull on the LLM generator.

// ─── Dedup helpers ─────────────────────────────────────────

function normalizeTitle(title: string): string {
  if (!title) return '';
  let t = title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const noise = /[\(\[]\s*(?:(?:\d{4}\s*)?remaster(?:ed)?|deluxe|special|expanded|anniversary|digital|mono|stereo|explicit|edition)\s*[\)\]]/gi;
  t = t.replace(noise, '').replace(/(?:\d{4}\s*)?remaster(?:ed)?/gi, '');
  return t.replace(/\s+/g, ' ').replace(/[\s\-\:\.\(\)\[\]]+$/, '').trim();
}

function normalizeArtistName(artist: string): string {
  return (artist || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ');
}

function normalizeLooseKey(value: string): string {
  return (value || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ');
}

export function getSongDedupKey(row: { title?: string; artist?: string; mb_recording_id?: string | null }): string {
  if (row.mb_recording_id && String(row.mb_recording_id).trim() !== '') {
    return `mb:${String(row.mb_recording_id).trim().toLowerCase()}`;
  }
  return `meta:${normalizeArtistName(row.artist || '')}:${normalizeTitle(row.title || '')}`;
}

// ─── Genre helpers ─────────────────────────────────────────

export function isPathBlockedByBannedGenre(path: string, bannedGenres: string[]): boolean {
  const clean = String(path || '').toLowerCase().trim();
  if (!clean) return false;
  return bannedGenres.some((g) => {
    const banned = String(g || '').toLowerCase().trim();
    if (!banned) return false;
    return clean === banned || clean.startsWith(`${banned}.`) || clean.includes(`.${banned}.`) || clean.endsWith(`.${banned}`);
  });
}

function getFullGenrePath(row: any): string {
  return String(row.genre_path || row.genre || '').toLowerCase();
}

function getGenreRoot(row: any): string {
  const path = getFullGenrePath(row);
  return normalizeLooseKey(path.split('.')[0] || path || 'unknown-genre');
}

// ─── Acoustic helpers ──────────────────────────────────────

function parseAcousticVector(row: any): number[] | null {
  const raw = row?.acoustic_vector_text || row?.acoustic_vector_8d;
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length < 8) return null;
    const v = parsed.slice(0, 8).map((x: unknown) => Number(x));
    if (v.some((x: number) => !Number.isFinite(x))) return null;
    return v;
  } catch {
    return null;
  }
}

function acousticDistance(a: number[] | null, b: number[] | null): number | null {
  if (!a || !b || a.length !== b.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / a.length);
}

function getAcousticClusterKey(row: any): string {
  const v = parseAcousticVector(row);
  if (!v) return 'unknown';
  const bins = [v[0], v[4], v[5], v[6]].map((x) => Math.max(0, Math.min(3, Math.floor(x * 4))));
  return bins.join(':');
}


const VA_EXCLUSION_SQL = `AND NOT EXISTS (SELECT 1 FROM artists va WHERE va.id = t.artist_id AND va.is_va_pseudo = TRUE)`;

// Track playability gate borrowed from the LLM playlist pool query: skip
// intros / outros / interludes / skits that wouldn't make sense in a radio
// or daylist queue. Mirrors llmPlayableTrackSql in recommendation.service.ts.
const PLAYABLE_TRACK_SQL = `
  t.duration > 90
  AND NOT (
    regexp_replace(trim(regexp_replace(lower(coalesce(t.title, '')), '[^[:alnum:]]+', ' ', 'g')), '[[:space:]]+', ' ', 'g')
      ~ '^(the )?(intro|outro|interlude|skit|prelude|prologue|epilogue|segue|transition)( [0-9ivx]+)?( .*)?$'
    OR (
      t.duration < 240
      AND regexp_replace(trim(regexp_replace(lower(coalesce(t.title, '')), '[^[:alnum:]]+', ' ', 'g')), '[[:space:]]+', ' ', 'g')
        ~ '(^| )(intro|outro|interlude|skit|prelude|prologue|epilogue|segue|transition)( |$)'
    )
  )
`;

const GENRE_KEY_SQL = `regexp_replace(lower(trim(COALESCE(canonical_genre.name, t.genre))), '[^[:alnum:]_[:space:]-]', '', 'g')`;
const GENRE_PATH_JOIN_SQL = `
  LEFT JOIN genres canonical_genre ON canonical_genre.id = t.genre_id
  LEFT JOIN subgenre_mappings sm ON ${GENRE_KEY_SQL} = sm.sub_genre
  LEFT JOIN LATERAL (
    (SELECT path FROM genre_tree_paths WHERE LOWER(genre_name) = ${GENRE_KEY_SQL} LIMIT 1)
    UNION ALL
    (SELECT gtp.path FROM genre_tree_paths gtp
     JOIN genre_alias ga ON gtp.genre_id = ga.genre
     WHERE LOWER(ga.name) = ${GENRE_KEY_SQL} LIMIT 1)
    LIMIT 1
  ) gm ON true
`;

// ─── Public types ──────────────────────────────────────────

export type PoolName = 'seed' | 'core' | 'adjacent' | 'root' | 'acoustic' | 'bridge' | 'discovery' | 'favorites';

// Default per-pool bias applied to ranking (lower combined = better).
// Mirrors the LLM playlist bias table.
const DEFAULT_POOL_BIAS: Record<PoolName, number> = {
  seed: 0.14,
  core: 0.11,
  adjacent: 0.07,
  root: 0.055,
  acoustic: 0.03,
  bridge: 0.05,
  discovery: 0.06,
  favorites: 0.09,
};

export interface PoolSpec {
  name: PoolName;
  limit: number;
  vectorStr?: string | null;
  embeddingCentroidStr?: string | null;
  effnetWeight?: number;
  pathPrefixes?: string[];
  excludePrefixes?: string[];
  enableDiscoveryBoost?: boolean;
  dormantOnly?: boolean;
  favoritesScore?: boolean;
  restrictArtistIds?: string[];
  poolBias?: number;
}

export interface FetchPoolOptions extends PoolSpec {
  userId: string;
  excludeIds?: string[];
  bannedGenres?: string[];
}

export interface BuildPlaylistOptions {
  userId: string;
  count: number;
  poolSpecs: PoolSpec[];
  poolTargets?: Map<PoolName, number>;
  bannedGenres?: string[];
  excludeIds?: string[];
  artistSpread?: number;
  diversity?: number;
  discoveryBias?: number;
  freshness?: number;
  allowSoftVetoRecovery?: boolean;
  relaxationPlan?: Array<{
    poolSpecs: PoolSpec[];
    poolTargets?: Map<PoolName, number>;
    softVeto?: boolean;
  }>;
}

export interface BuildPlaylistResult {
  trackIds: string[];
  rows: any[];
  diagnostics: {
    relaxationLevel: number;
    distinctArtists: number;
    distinctAlbums: number;
    distinctRoots: number;
    distinctPools: number;
    distinctClusters: number;
    meanPairwiseDistance: number;
    poolCounts: Record<string, number>;
    diversityScore: number;
  };
}

// ─── Pool fetch ────────────────────────────────────────────

export async function fetchCandidatePool(opts: FetchPoolOptions): Promise<any[]> {
  if (opts.limit <= 0) return [];

  const params: any[] = [];
  const where: string[] = [PLAYABLE_TRACK_SQL];
  let nextParam = 1;

  let distanceSql = `0.0`;
  let orderSql: string;

  // Acoustic / embedding distance — only when a vector is supplied.
  // Simulated-fallback features are constant center-of-space vectors, so any
  // distance ranking over-picks them; bar them from vector pools entirely.
  if (opts.vectorStr) {
    params.push(opts.vectorStr);
    const vectorParam = nextParam++;
    where.push(`tf.acoustic_vector_8d IS NOT NULL`);
    where.push(`tf.is_simulated = FALSE`);
    if (opts.embeddingCentroidStr) {
      params.push(opts.embeddingCentroidStr);
      const embParam = nextParam++;
      where.push(`tf.embedding_vector IS NOT NULL`);
      const w = opts.effnetWeight ?? 0.55;
      distanceSql = `(tf.acoustic_vector_8d <-> $${vectorParam}::vector) + ((tf.embedding_vector <=> $${embParam}::vector) * ${w})`;
    } else {
      distanceSql = `tf.acoustic_vector_8d <-> $${vectorParam}::vector`;
    }
  }

  // Novelty boost — needs a user join. Also used by dormantOnly to enforce
  // a hard recency filter.
  let noveltyJoinSql = '';
  let noveltySql = '0.0';
  let favoritesScoreSql = '0.0';
  const wantsUserJoin = opts.enableDiscoveryBoost || opts.dormantOnly || opts.favoritesScore;

  if (wantsUserJoin) {
    params.push(opts.userId);
    const userParam = nextParam++;
    noveltyJoinSql = `LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $${userParam}`;
  }

  if (opts.enableDiscoveryBoost) {
    noveltySql = `
      (CASE
        WHEN ups.play_count IS NULL OR ups.play_count = 0 THEN 0.16
        ELSE GREATEST(0.0, 0.10 - LEAST(ups.play_count, 8) * 0.012)
      END)
      + (CASE
        WHEN ups.last_played_at IS NULL THEN 0.08
        WHEN ups.last_played_at < NOW() - INTERVAL '180 days' THEN 0.08
        WHEN ups.last_played_at < NOW() - INTERVAL '60 days' THEN 0.04
        ELSE 0.0
      END)
    `;
  }

  if (opts.dormantOnly) {
    where.push(`(ups.last_played_at IS NULL OR ups.last_played_at < NOW() - INTERVAL '60 days')`);
  }

  if (opts.favoritesScore) {
    favoritesScoreSql = `(COALESCE(ups.play_count, 0) + COALESCE(ups.rating, 0) * 2)::float8`;
    where.push(`(COALESCE(ups.play_count, 0) > 0 OR COALESCE(ups.rating, 0) > 0)`);
  }

  // Genre-path filters (use the same lateral join as the LLM pool).
  let joinSql = '';
  let needsGenreJoin = false;
  if ((opts.pathPrefixes && opts.pathPrefixes.length > 0) || (opts.excludePrefixes && opts.excludePrefixes.length > 0)) {
    needsGenreJoin = true;
  }
  if (needsGenreJoin) {
    joinSql += GENRE_PATH_JOIN_SQL;
  }

  if (opts.pathPrefixes && opts.pathPrefixes.length > 0) {
    params.push(opts.pathPrefixes);
    const p = nextParam++;
    where.push(`EXISTS (SELECT 1 FROM unnest($${p}::text[]) AS prefix WHERE COALESCE(sm.path, gm.path) LIKE prefix || '%')`);
  }

  if (opts.excludePrefixes && opts.excludePrefixes.length > 0) {
    params.push(opts.excludePrefixes);
    const p = nextParam++;
    where.push(`NOT EXISTS (SELECT 1 FROM unnest($${p}::text[]) AS prefix WHERE COALESCE(sm.path, gm.path) LIKE prefix || '%')`);
  }

  if (opts.restrictArtistIds && opts.restrictArtistIds.length > 0) {
    params.push(opts.restrictArtistIds);
    const p = nextParam++;
    where.push(`t.artist_id::text = ANY($${p}::text[])`);
  }

  if (opts.excludeIds && opts.excludeIds.length > 0) {
    params.push(opts.excludeIds);
    const p = nextParam++;
    where.push(`NOT (t.id::text = ANY($${p}::text[]))`);
  }

  if (opts.bannedGenres && opts.bannedGenres.length > 0) {
    if (!needsGenreJoin) {
      joinSql += GENRE_PATH_JOIN_SQL;
      needsGenreJoin = true;
    }
    params.push(opts.bannedGenres);
    const p = nextParam++;
    where.push(`NOT EXISTS (
      SELECT 1 FROM unnest($${p}::text[]) AS banned(name)
      WHERE COALESCE(sm.path, gm.path, lower(canonical_genre.name), lower(t.genre), '') = banned.name
         OR COALESCE(sm.path, gm.path, lower(canonical_genre.name), lower(t.genre), '') LIKE banned.name || '.%'
         OR COALESCE(sm.path, gm.path, lower(canonical_genre.name), lower(t.genre), '') LIKE '%.' || banned.name
         OR COALESCE(sm.path, gm.path, lower(canonical_genre.name), lower(t.genre), '') LIKE '%.' || banned.name || '.%'
    )`);
  }

  // Christmas / VA filters are always-on.
  const christmasSql = christmasExclusionSql('t');

  // Track-features join is only required when we have a vector to compute
  // distance against; otherwise a LEFT JOIN keeps non-analysed tracks
  // available (used by 'seed' / 'favorites' pools).
  const featuresJoin = opts.vectorStr
    ? `JOIN track_features tf ON tf.track_id = t.id`
    : `LEFT JOIN track_features tf ON tf.track_id = t.id`;

  // Order by combined distance minus novelty bonus, then favorites score.
  // For pools that mark themselves as 'favorites', the play/rating score
  // leads and the optional mood vector is only a tiebreaker — listeners want
  // their actual favorites in a daylist, not mood-filtered favorites.
  if (opts.favoritesScore) {
    orderSql = opts.vectorStr
      ? `favorites_score DESC, distance ASC`
      : `favorites_score DESC`;
  } else if (opts.vectorStr) {
    orderSql = opts.enableDiscoveryBoost
      ? `(distance - novelty_boost) ASC`
      : `distance ASC`;
  } else {
    orderSql = `RANDOM()`;
  }

  params.push(opts.limit);
  const limitParam = nextParam++;

  const poolBias = opts.poolBias ?? DEFAULT_POOL_BIAS[opts.name] ?? 0.05;

  const sql = `
    SELECT * FROM (
      SELECT
        t.*,
        ${needsGenreJoin ? `COALESCE(sm.path, gm.path)` : `NULL::text`} AS genre_path,
        CASE WHEN COALESCE(tf.is_simulated, FALSE) THEN NULL
             ELSE tf.acoustic_vector_8d::text END AS acoustic_vector_text,
        ${distanceSql} AS distance,
        ${noveltySql} AS novelty_boost,
        ${favoritesScoreSql} AS favorites_score,
        '${opts.name}'::text AS pool_source,
        ${poolBias}::float8 AS pool_bias
      FROM tracks t
      ${featuresJoin}
      ${joinSql}
      ${noveltyJoinSql}
      WHERE ${where.join('\n        AND ')}
        ${christmasSql}
        ${VA_EXCLUSION_SQL}
    ) pool
    ORDER BY ${orderSql}
    LIMIT $${limitParam}
  `;

  const res = await queryWithRetry(sql, params);
  return res.rows;
}

// ─── Dedup ─────────────────────────────────────────────────

export function dedupeCandidateRows(rows: any[]): any[] {
  // Merge by song key (MB recording id → normalized artist+title). For each
  // duplicate, keep the row with the best combined score (lower distance,
  // higher pool bias, novelty bonus). Tracks the same recording across pools
  // collapse to one entry but keep the strongest evidence.
  const map = new Map<string, any>();
  for (const row of rows) {
    const songKey = getSongDedupKey(row);
    // Also keep an id-level fallback in case title/artist are missing.
    const key = songKey === 'meta::' ? `id:${row.id}` : songKey;
    const existing = map.get(key);
    const score = Number(row.distance ?? Infinity) - Number(row.pool_bias ?? 0) - Number(row.novelty_boost ?? 0) * 0.3;
    const existingScore = existing
      ? Number(existing.distance ?? Infinity) - Number(existing.pool_bias ?? 0) - Number(existing.novelty_boost ?? 0) * 0.3
      : Infinity;
    if (!existing || score < existingScore) {
      map.set(key, row);
    }
  }
  return Array.from(map.values());
}

// ─── Selection ─────────────────────────────────────────────

export function getTargetArtistFloor(count: number, relaxationLevel: number): number {
  const ratio = relaxationLevel <= 1 ? 0.65 : relaxationLevel === 2 ? 0.55 : 0.45;
  return Math.min(count, Math.max(4, Math.ceil(count * ratio)));
}

export function maxTracksPerArtistFromSpread(artistSpread: number, count: number): number {
  if (artistSpread >= 0.75) return 1;
  if (artistSpread >= 0.45) return count <= 10 ? 1 : 2;
  return count <= 5 ? 1 : count <= 15 ? 2 : 3;
}

interface SelectOptions {
  artistSpread: number;
  discoveryBias: number;
  diversity: number;
  poolTargets?: Map<PoolName, number>;
  maxTracksPerArtist?: number;
  protectArtistIds?: Set<string>;
  // Multiplier on the per-pick random jitter. 1 = default. Raised by callers
  // (e.g. artist-radio) that want a meaningfully different mix on every run
  // rather than a deterministic re-selection.
  freshness?: number;
}

export function selectDiverseTracks(rows: any[], count: number, opts: SelectOptions): {
  selected: any[];
  diagnostics: {
    distinctArtists: number;
    distinctAlbums: number;
    distinctRoots: number;
    distinctPools: number;
    distinctClusters: number;
    meanPairwiseDistance: number;
    poolCounts: Record<string, number>;
    diversityScore: number;
  };
} {
  const cap = opts.maxTracksPerArtist ?? maxTracksPerArtistFromSpread(opts.artistSpread, count);
  const selected: any[] = [];
  const selectedSongKeys = new Set<string>();
  const artistCounts = new Map<string, number>();
  const albumCounts = new Map<string, number>();
  const rootCounts = new Map<string, number>();
  const poolCounts = new Map<string, number>();
  const clusterCounts = new Map<string, number>();
  const rankBySong = new Map<string, number>();
  const selectedVectors: number[][] = [];

  rows.forEach((row, i) => {
    const k = getSongDedupKey(row);
    if (!rankBySong.has(k)) rankBySong.set(k, i);
  });

  const pickOne = (enforceCap: boolean): boolean => {
    const candidates = rows.filter((row) => {
      const songKey = getSongDedupKey(row);
      if (selectedSongKeys.has(songKey)) return false;
      const artistKey = normalizeArtistName(row.artist || 'unknown-artist');
      const isProtected = opts.protectArtistIds?.has(String(row.artist_id || ''));
      if (enforceCap && !isProtected && (artistCounts.get(artistKey) ?? 0) >= cap) return false;
      return true;
    });
    if (candidates.length === 0) return false;

    const windowSize = Math.min(candidates.length, Math.max(60, count * 8));
    const window = candidates.slice(0, windowSize);
    let best = window[0];
    let bestScore = Infinity;

    for (const c of window) {
      const songKey = getSongDedupKey(c);
      const artistKey = normalizeArtistName(c.artist || 'unknown-artist');
      const albumKey = normalizeLooseKey(c.album || c.album_title || '');
      const rootKey = getGenreRoot(c);
      const poolKey = String(c.pool_source || 'acoustic');
      const clusterKey = getAcousticClusterKey(c);
      const vector = parseAcousticVector(c);
      const rank = rankBySong.get(songKey) ?? rows.length;
      const fitScore = rank / Math.max(1, rows.length - 1);
      const artistPenalty = (artistCounts.get(artistKey) ?? 0) * (0.65 + opts.artistSpread * 0.70);
      const albumPenalty = albumKey ? (albumCounts.get(albumKey) ?? 0) * (0.22 + opts.artistSpread * 0.18) : 0;
      const rootPenalty = (rootCounts.get(rootKey) ?? 0) * 0.06;
      const clusterPenalty = (clusterCounts.get(clusterKey) ?? 0) * 0.38;
      const desiredPool = opts.poolTargets?.get(poolKey as PoolName) ?? 0;
      const currentPool = poolCounts.get(poolKey) ?? 0;
      const poolPenalty = desiredPool > 0
        ? Math.max(0, (currentPool + 1) - desiredPool) * 0.25
        : currentPool * 0.08;
      const poolBonus = desiredPool > currentPool ? 0.06 : 0;
      const poolBias = Number(c.pool_bias ?? 0);
      const novelty = Math.min(0.18, Number(c.novelty_boost ?? 0) * (0.55 + opts.discoveryBias * 0.90));
      const newArtistBonus = (artistCounts.get(artistKey) ?? 0) === 0 ? (0.04 + opts.artistSpread * 0.10) : 0;
      const pairwise = selectedVectors
        .map((v) => acousticDistance(vector, v))
        .filter((x): x is number => x !== null);
      const meanD = pairwise.length > 0 ? pairwise.reduce((s, x) => s + x, 0) / pairwise.length : 0.30;
      const simPenalty = pairwise.length > 0 ? Math.max(0, 0.20 - meanD) * 2.2 : 0;
      const divBonus = pairwise.length > 0 ? Math.min(0.14, meanD * 0.45) : 0.04;
      const randomBonus = Math.random() * opts.diversity * 0.18 * (opts.freshness ?? 1);

      const score =
        fitScore + artistPenalty + albumPenalty + rootPenalty + clusterPenalty + simPenalty + poolPenalty
        - poolBonus - poolBias - novelty - newArtistBonus - divBonus - randomBonus;

      if (score < bestScore) {
        bestScore = score;
        best = c;
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

  const pairwiseAll: number[] = [];
  for (let i = 0; i < selectedVectors.length; i++) {
    for (let j = i + 1; j < selectedVectors.length; j++) {
      const d = acousticDistance(selectedVectors[i], selectedVectors[j]);
      if (d !== null) pairwiseAll.push(d);
    }
  }
  const meanPairwiseDistance = pairwiseAll.length > 0
    ? pairwiseAll.reduce((s, x) => s + x, 0) / pairwiseAll.length
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

  const poolCountsObj: Record<string, number> = {};
  for (const [k, v] of poolCounts) poolCountsObj[k] = v;

  return {
    selected,
    diagnostics: {
      distinctArtists, distinctAlbums, distinctRoots, distinctPools, distinctClusters,
      meanPairwiseDistance, poolCounts: poolCountsObj, diversityScore,
    },
  };
}

// ─── Orchestrator ──────────────────────────────────────────

async function fetchPoolsParallel(
  userId: string,
  specs: PoolSpec[],
  bannedGenres: string[],
  excludeIds: string[],
): Promise<any[]> {
  const results = await Promise.all(
    specs.map((spec) => fetchCandidatePool({
      ...spec,
      userId,
      bannedGenres,
      excludeIds,
    }).catch((e) => {
      console.error(`[CandidatePool] Pool '${spec.name}' failed`, e);
      return [];
    }))
  );
  return results.flat();
}

export async function buildPlaylistFromPools(opts: BuildPlaylistOptions): Promise<BuildPlaylistResult> {
  const artistSpread = opts.artistSpread ?? 0.70;
  const diversity = opts.diversity ?? 0.50;
  const discoveryBias = opts.discoveryBias ?? 0.45;
  const bannedGenres = opts.bannedGenres ?? [];
  const excludeIds = opts.excludeIds ?? [];

  const attempts: Array<{ specs: PoolSpec[]; targets?: Map<PoolName, number>; softVeto: boolean; level: number }> = [
    { specs: opts.poolSpecs, targets: opts.poolTargets, softVeto: false, level: 0 },
  ];

  if (opts.relaxationPlan) {
    opts.relaxationPlan.forEach((step, i) => {
      attempts.push({
        specs: step.poolSpecs,
        targets: step.poolTargets,
        softVeto: !!step.softVeto && (opts.allowSoftVetoRecovery ?? true),
        level: i + 1,
      });
    });
  }

  let best: BuildPlaylistResult | null = null;

  for (const attempt of attempts) {
    const rows = await fetchPoolsParallel(opts.userId, attempt.specs, attempt.softVeto ? [] : bannedGenres, excludeIds);
    if (rows.length === 0) continue;

    // Banned-genre soft veto: keep but penalise rows that match a banned path.
    // Favorites contribution is clipped + scaled to ~0.25 max so a heavily
    // played track pulls strongly toward the front without dwarfing acoustic
    // signal entirely.
    const ranked = rows.map((r) => {
      const path = getFullGenrePath(r);
      const banned = bannedGenres.length > 0 && isPathBlockedByBannedGenre(path, bannedGenres);
      const distance = Number(r.distance ?? 0);
      const poolBias = Number(r.pool_bias ?? 0);
      const novelty = Number(r.novelty_boost ?? 0);
      const favorites = Math.min(Number(r.favorites_score ?? 0), 50) * 0.005;
      const vetoPenalty = banned ? (attempt.softVeto ? 0.18 : Infinity) : 0;
      const combined = distance - poolBias - novelty * 0.30 - favorites + vetoPenalty;
      return { ...r, combined };
    }).filter((r) => Number.isFinite(r.combined));

    ranked.sort((a, b) => a.combined - b.combined);
    const deduped = dedupeCandidateRows(ranked);

    const selection = selectDiverseTracks(deduped, opts.count, {
      artistSpread,
      discoveryBias,
      diversity,
      freshness: opts.freshness,
      poolTargets: attempt.targets,
    });

    const result: BuildPlaylistResult = {
      trackIds: selection.selected.map((r) => String(r.id)),
      rows: selection.selected,
      diagnostics: {
        relaxationLevel: attempt.level,
        ...selection.diagnostics,
      },
    };

    const minArtists = getTargetArtistFloor(opts.count, attempt.level);
    const enoughTracks = result.trackIds.length >= Math.max(Math.floor(opts.count * 0.8), opts.count - 4);
    const enoughArtists = selection.diagnostics.distinctArtists >= minArtists;

    if (enoughTracks && enoughArtists) {
      return result;
    }

    if (!best || result.trackIds.length > best.trackIds.length) {
      best = result;
    }
  }

  if (best) return best;
  return {
    trackIds: [],
    rows: [],
    diagnostics: {
      relaxationLevel: -1,
      distinctArtists: 0, distinctAlbums: 0, distinctRoots: 0, distinctPools: 0, distinctClusters: 0,
      meanPairwiseDistance: 0, poolCounts: {}, diversityScore: 0,
    },
  };
}

// ─── Centroid helper ───────────────────────────────────────

// Pull the user's top-N tracks for an artist, parse their acoustic + embedding
// vectors, and average them. Used as the seed centroid for artist-radio
// (richer than picking a single seed track).
export async function computeArtistCentroids(
  userId: string,
  artistId: string,
  topN = 5,
  opts?: { sampleFrom?: number }
): Promise<{
  acousticVectorStr: string | null;
  embeddingCentroidStr: string | null;
  sampleSize: number;
} | null> {
  // When `sampleFrom` is given, pull a wider candidate window (the artist's top
  // `sampleFrom` analysed tracks) and randomly keep `topN` of them, weighted
  // toward the most-played. This rotates the seed centroid slightly on every
  // call so artist-radio yields a different mix each press; without it the
  // behaviour is the deterministic strict top-N (used by the subsonic caller).
  const fetchN = opts?.sampleFrom && opts.sampleFrom > topN ? opts.sampleFrom : topN;
  const res = await queryWithRetry(
    `
    SELECT
      tf.acoustic_vector_8d::text AS acoustic_text,
      tf.embedding_vector::text AS embedding_text
    FROM tracks t
    JOIN track_features tf ON tf.track_id = t.id
    LEFT JOIN user_playback_stats ups ON ups.track_id = t.id AND ups.user_id = $1
    WHERE t.artist_id::text = $2
      AND tf.acoustic_vector_8d IS NOT NULL
      AND tf.is_simulated = FALSE
    ORDER BY COALESCE(ups.play_count, 0) DESC, t.id ASC
    LIMIT $3
    `,
    [userId, artistId, fetchN]
  );

  if (res.rowCount === 0) return null;

  // Sample `topN` rows from the fetched window, biasing toward earlier (more
  // played) rows so the centroid still reflects the artist's core sound.
  let rows = res.rows as any[];
  if (opts?.sampleFrom && rows.length > topN) {
    const pool = rows.map((row, i) => ({ row, key: Math.random() / (i + 1) }));
    pool.sort((a, b) => b.key - a.key);
    rows = pool.slice(0, topN).map((p) => p.row);
  }

  const acoustic = new Array(8).fill(0);
  const embedding = new Array(1280).fill(0);
  let acousticCount = 0;
  let embeddingCount = 0;

  for (const row of rows) {
    try {
      const av = JSON.parse(row.acoustic_text);
      if (Array.isArray(av) && av.length === 8 && av.every((x) => Number.isFinite(Number(x)))) {
        for (let i = 0; i < 8; i++) acoustic[i] += Number(av[i]);
        acousticCount++;
      }
    } catch {}
    if (row.embedding_text) {
      try {
        const ev = JSON.parse(row.embedding_text);
        if (Array.isArray(ev) && ev.length === 1280) {
          for (let i = 0; i < 1280; i++) embedding[i] += Number(ev[i]);
          embeddingCount++;
        }
      } catch {}
    }
  }

  if (acousticCount === 0) return null;

  const acousticAvg = acoustic.map((x) => x / acousticCount);
  const embeddingAvg = embeddingCount > 0 ? embedding.map((x) => x / embeddingCount) : null;

  return {
    acousticVectorStr: `[${acousticAvg.join(',')}]`,
    embeddingCentroidStr: embeddingAvg ? `[${embeddingAvg.join(',')}]` : null,
    sampleSize: acousticCount,
  };
}

// ─── Library mainstream centroid (cached) ──────────────────

let _mainstreamCache: { acousticVectorStr: string; ts: number } | null = null;
const MAINSTREAM_CACHE_MS = 60 * 60 * 1000;

export async function getLibraryMainstreamVector(): Promise<string | null> {
  if (_mainstreamCache && Date.now() - _mainstreamCache.ts < MAINSTREAM_CACHE_MS) {
    return _mainstreamCache.acousticVectorStr;
  }
  // PostgreSQL has no native vector AVG, so we pull a random sample of
  // acoustic vectors and average them in JS.
  const sample = await queryWithRetry(
    `SELECT tf.acoustic_vector_8d::text AS v
     FROM track_features tf
     WHERE tf.acoustic_vector_8d IS NOT NULL
       AND tf.is_simulated = FALSE
     ORDER BY RANDOM()
     LIMIT 1000`,
    []
  ).catch(() => null);
  if (!sample || sample.rowCount === 0) return null;
  const acc = new Array(8).fill(0);
  let n = 0;
  for (const r of sample.rows as any[]) {
    try {
      const v = JSON.parse(r.v);
      if (Array.isArray(v) && v.length === 8) {
        for (let i = 0; i < 8; i++) acc[i] += Number(v[i]);
        n++;
      }
    } catch {}
  }
  if (n === 0) return null;
  const avg = acc.map((x) => x / n);
  const str = `[${avg.join(',')}]`;
  _mainstreamCache = { acousticVectorStr: str, ts: Date.now() };
  return str;
}

// ─── Genre path resolver ───────────────────────────────────

export async function resolveGenrePath(genre: string): Promise<string | null> {
  const clean = String(genre || '').toLowerCase().trim();
  if (!clean) return null;
  const res = await queryWithRetry(
    `(SELECT path FROM genre_tree_paths WHERE LOWER(genre_name) = $1 LIMIT 1)
     UNION ALL
     (SELECT gtp.path FROM genre_tree_paths gtp
      JOIN genre_alias ga ON gtp.genre_id = ga.genre
      WHERE LOWER(ga.name) = $1 LIMIT 1)
     LIMIT 1`,
    [clean]
  );
  return (res.rows[0] as any)?.path || null;
}

// ─── Seed-artist genre paths ──────────────────────────────

// For artist radio: derive the seed artist's primary genre path + simple
// adjacent paths (sharing one or two parent levels). Read-only SQL; if the
// artist has no resolvable genre, returns empty arrays and the radio falls
// back to embedding K-NN with no genre filter.
export async function getArtistGenrePaths(artistId: string): Promise<{
  primaryPath: string | null;
  adjacentPaths: string[];
  rootPath: string | null;
}> {
  const res = await queryWithRetry(
    `
    SELECT g.name AS genre, COUNT(*) AS n
    FROM tracks t
    JOIN genres g ON g.id = t.genre_id AND g.merged_into IS NULL
    WHERE t.artist_id::text = $1
      AND g.name <> ''
    GROUP BY g.id, g.name
    ORDER BY n DESC
    LIMIT 4
    `,
    [artistId]
  );

  if (res.rowCount === 0) return { primaryPath: null, adjacentPaths: [], rootPath: null };

  const genres = (res.rows as any[]).map((r) => String(r.genre).toLowerCase());
  const paths: string[] = [];
  for (const g of genres) {
    const p = await resolveGenrePath(g);
    if (p) paths.push(p);
  }

  if (paths.length === 0) return { primaryPath: null, adjacentPaths: [], rootPath: null };

  const primaryPath = paths[0];
  const root = primaryPath.split('.')[0];
  const adjacent = Array.from(new Set(paths.slice(1))).filter((p) => p !== primaryPath);
  return { primaryPath, adjacentPaths: adjacent, rootPath: root };
}
