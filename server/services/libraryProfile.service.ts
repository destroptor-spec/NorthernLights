import { queryWithRetry } from '../utils/db';

export interface VectorDimensionProfile {
  p10: number;
  p50: number;
  p90: number;
}

export interface LibraryProfile {
  totalTracks: number;
  analyzedTracks: number;
  artistCount: number;
  artistEntropy: number;
  vector: VectorDimensionProfile[];
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

export function clearLibraryProfileCache() {
  cachedProfile = null;
}

let refreshing: Promise<LibraryProfile> | null = null;

/**
 * The library profile, cached for 5 minutes. Past that the cached one still
 * answers at once while a fresh one is computed behind it: on a 95,000-track
 * test library the profile takes about 7 s, which every AI playlist after a
 * quiet spell used to wait for (most of it the genre health that only the
 * pool-era compiler read; gone with it).
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
  const [summaryRes, vectorRes] = await Promise.all([
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
  };

  cachedProfile = { value: profile, expiresAt: now + PROFILE_TTL_MS };
  return profile;
}
