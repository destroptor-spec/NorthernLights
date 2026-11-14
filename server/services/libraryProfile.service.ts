import { queryWithRetry } from '../utils/db';
import { PATH_SQL } from './genreTaxonomy/paths';

export interface VectorDimensionProfile {
  p10: number;
  p50: number;
  p90: number;
}

export interface GenreHealth {
  path: string;
  root: string;
  trackCount: number;
  artistCount: number;
  songCount: number;
  health: number;
}

export interface LibraryProfile {
  totalTracks: number;
  analyzedTracks: number;
  artistCount: number;
  artistEntropy: number;
  vector: VectorDimensionProfile[];
  genreHealth: Map<string, GenreHealth>;
}

const PROFILE_TTL_MS = 5 * 60 * 1000;
let cachedProfile: { value: LibraryProfile; expiresAt: number } | null = null;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function normalizeVectorText(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? clamp01(n) : 0.5;
}

function scoreHealth(trackCount: number, artistCount: number, songCount: number): number {
  const trackScore = Math.min(1, trackCount / 80);
  const artistScore = Math.min(1, artistCount / 12);
  const songScore = Math.min(1, songCount / 40);
  return (trackScore * 0.35) + (artistScore * 0.45) + (songScore * 0.20);
}

function normalizePath(path: string): string {
  return path.toLowerCase().trim();
}

export function adaptVectorToLibrary(vector: number[], profile: LibraryProfile): number[] {
  if (profile.vector.length !== 8) return vector;

  return vector.map((value, index) => {
    const dim = profile.vector[index];
    const target = clamp01(value);
    const range = dim.p90 - dim.p10;
    if (!Number.isFinite(range) || range < 0.05) {
      return target;
    }
    return clamp01(dim.p10 + target * range);
  });
}

export function getGenreHealth(profile: LibraryProfile, path: string): GenreHealth | null {
  const normalized = normalizePath(path);
  return profile.genreHealth.get(normalized) ?? null;
}

export function getGenreHealthForPrefix(profile: LibraryProfile, path: string): GenreHealth {
  const normalized = normalizePath(path);
  const direct = getGenreHealth(profile, normalized);
  if (direct) return direct;

  let trackCount = 0;
  const artists = new Set<string>();
  let songCount = 0;
  let root = normalized.split('.')[0] || normalized;

  for (const [candidatePath, health] of profile.genreHealth) {
    if (!candidatePath.startsWith(normalized)) continue;
    root = health.root || root;
    trackCount += health.trackCount;
    songCount += health.songCount;
    // Artist count is already distinct inside each path. Use a conservative additive cap.
    for (let i = 0; i < health.artistCount; i++) artists.add(`${candidatePath}:${i}`);
  }

  const artistCount = artists.size;
  return {
    path: normalized,
    root,
    trackCount,
    artistCount,
    songCount,
    health: scoreHealth(trackCount, artistCount, songCount),
  };
}

export function adaptGenreBlendForHealth(requestedBlend: number, health: GenreHealth | null): number {
  if (!health) return Math.min(requestedBlend, 0.35);
  if (health.health >= 0.85) return requestedBlend;
  if (health.health >= 0.55) return Math.min(requestedBlend, 0.65);
  if (health.health >= 0.30) return Math.min(requestedBlend, 0.45);
  return Math.min(requestedBlend, 0.25);
}

export function clearLibraryProfileCache() {
  cachedProfile = null;
}

let refreshing: Promise<LibraryProfile> | null = null;

/**
 * The library profile, cached for 5 minutes. Past that the cached one still
 * answers at once while a fresh one is computed behind it: on a 95,000-track
 * test library the profile takes about 7 s, which every AI playlist after a
 * quiet spell used to wait for.
 */
export async function getLibraryProfile(): Promise<LibraryProfile> {
  if (cachedProfile) {
    if (cachedProfile.expiresAt <= Date.now() && !refreshing) {
      const stale = cachedProfile.value;
      refreshing = computeLibraryProfile()
        .catch((error) => { console.warn('[LibraryProfile] refresh failed:', error?.message || error); return stale; })
        .finally(() => { refreshing = null; });
    }
    return cachedProfile.value;
  }
  refreshing ??= computeLibraryProfile().finally(() => { refreshing = null; });
  return refreshing;
}

async function computeLibraryProfile(): Promise<LibraryProfile> {
  const now = Date.now();
  const [summaryRes, vectorRes, genreRes] = await Promise.all([
    queryWithRetry(`
      SELECT
        COUNT(*)::int AS total_tracks,
        COUNT(tf.track_id)::int AS analyzed_tracks,
        COUNT(DISTINCT lower(trim(t.artist)))::int AS artist_count
      FROM tracks t
      LEFT JOIN track_features tf ON t.id = tf.track_id AND tf.acoustic_vector_8d IS NOT NULL
    `),
    queryWithRetry(`
      SELECT
        ${Array.from({ length: 8 }, (_, i) => {
          const idx = i + 1;
          const expr = `(string_to_array(trim(both '[]' from acoustic_vector_8d::text), ',')::float8[])[${idx}]`;
          return `
            percentile_cont(0.10) WITHIN GROUP (ORDER BY ${expr}) AS p10_${idx},
            percentile_cont(0.50) WITHIN GROUP (ORDER BY ${expr}) AS p50_${idx},
            percentile_cont(0.90) WITHIN GROUP (ORDER BY ${expr}) AS p90_${idx}
          `;
        }).join(',')}
      FROM track_features
      WHERE acoustic_vector_8d IS NOT NULL
    `),
    // Genre health from the fused genres and styles: every analysed track
    // counts for each of its genres ("electronic") and styles
    // ("electronic.house"), so a genre's health covers all its styles.
    queryWithRetry(`
      WITH member AS (
        SELECT ts.track_id, lower(replace(ts.genre, '.', ' ')) AS root, ${PATH_SQL} AS path
        FROM track_styles ts
        LEFT JOIN style s ON s.id = ts.style_id
        JOIN track_features tf ON tf.track_id = ts.track_id AND tf.acoustic_vector_8d IS NOT NULL
      ), resolved AS (
        SELECT track_id, root, path FROM member
        UNION
        SELECT track_id, root, root FROM member
      )
      SELECT
        r.path,
        r.root,
        COUNT(*)::int AS track_count,
        COUNT(DISTINCT lower(trim(COALESCE(t.artist, 'unknown-artist'))))::int AS artist_count,
        COUNT(DISTINCT COALESCE(NULLIF(t.mb_recording_id, ''), lower(trim(COALESCE(t.artist, ''))) || ':' || lower(trim(COALESCE(t.title, '')))))::int AS song_count
      FROM resolved r
      JOIN tracks t ON t.id = r.track_id
      GROUP BY r.path, r.root
    `),
  ]);

  const summary = summaryRes.rows[0] ?? {};
  const vectorRow = vectorRes.rows[0] ?? {};
  const vector = Array.from({ length: 8 }, (_, i) => {
    const idx = i + 1;
    return {
      p10: normalizeVectorText(vectorRow[`p10_${idx}`]),
      p50: normalizeVectorText(vectorRow[`p50_${idx}`]),
      p90: normalizeVectorText(vectorRow[`p90_${idx}`]),
    };
  });

  const genreHealth = new Map<string, GenreHealth>();
  for (const row of genreRes.rows) {
    const trackCount = Number(row.track_count) || 0;
    const artistCount = Number(row.artist_count) || 0;
    const songCount = Number(row.song_count) || 0;
    const path = normalizePath(row.path);
    genreHealth.set(path, {
      path,
      root: normalizePath(row.root || path.split('.')[0] || path),
      trackCount,
      artistCount,
      songCount,
      health: scoreHealth(trackCount, artistCount, songCount),
    });
  }

  const totalTracks = Number(summary.total_tracks) || 0;
  const artistCount = Number(summary.artist_count) || 0;
  const artistEntropy = totalTracks > 0 && artistCount > 0
    ? Math.min(1, Math.log(artistCount) / Math.log(Math.max(totalTracks, 2)))
    : 0;

  const profile: LibraryProfile = {
    totalTracks,
    analyzedTracks: Number(summary.analyzed_tracks) || 0,
    artistCount,
    artistEntropy,
    vector,
    genreHealth,
  };

  cachedProfile = { value: profile, expiresAt: now + PROFILE_TTL_MS };
  return profile;
}
