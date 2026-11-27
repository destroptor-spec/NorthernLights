/**
 * Where a track ranks in the library on each sound axis (0–1: the share of
 * analysed tracks below it), and the average rank of each main genre's
 * tracks. The Rays page's radar and aurora read these instead of the raw
 * 0–1 values, which crowd into small parts of their range (percussion and
 * brightness use a tenth of it).
 *
 * The sorted values and genre averages are cached for an hour and refreshed
 * in the background; a request never waits for a refresh once one exists.
 */
import { getGenreAverageRanks, getLibraryAxisValues, type GenreAverageRanks, type LibraryAxis } from '../database';

const TTL_MS = 60 * 60 * 1000;

interface LibraryRanks {
  values: Record<LibraryAxis, number[]>;
  genres: Map<string, GenreAverageRanks>;
  builtAt: number;
}

let cached: LibraryRanks | null = null;
let loading: Promise<LibraryRanks> | null = null;

/** The share of `sorted` strictly below `value` (binary search). */
export function rankIn(sorted: number[], value: number): number {
  if (sorted.length === 0 || !Number.isFinite(value)) return 0;
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo / sorted.length;
}

async function load(): Promise<LibraryRanks> {
  const [values, genres] = await Promise.all([getLibraryAxisValues(), getGenreAverageRanks()]);
  return { values, genres: new Map(genres.map(g => [g.genre, g])), builtAt: Date.now() };
}

export async function getLibraryRanks(): Promise<LibraryRanks> {
  const fresh = cached && Date.now() - cached.builtAt < TTL_MS;
  if (cached && fresh) return cached;
  if (!loading) {
    loading = load()
      .then(result => { cached = result; return result; })
      .finally(() => { loading = null; });
  }
  // Stale but present: answer now, refresh behind it.
  if (cached) {
    loading.catch(() => { /* keep the stale ranks */ });
    return cached;
  }
  return loading;
}

/** Tests only. */
export function resetLibraryRanksCache() {
  cached = null;
  loading = null;
}

export type TrackAxisValues = Record<LibraryAxis, number | null>;

/** A track's rank on every axis, and its main genre's average ranks when the genre is known. */
export async function trackFingerprint(values: TrackAxisValues, mainGenre: string | null) {
  const library = await getLibraryRanks();
  const ranks = Object.fromEntries((Object.keys(values) as LibraryAxis[]).map(axis => {
    const v = values[axis];
    return [axis, v === null || library.values[axis].length === 0 ? null : rankIn(library.values[axis], v)];
  })) as Record<LibraryAxis, number | null>;
  const genre = mainGenre ? library.genres.get(mainGenre) : undefined;
  return {
    ranks,
    genre: genre ? { name: genre.genre, trackCount: genre.trackCount, ranks: genre.ranks } : null,
  };
}
