/**
 * Style overlap, the phase 4 engine (docs/Aurora genre and style redesign.md,
 * Engine): a candidate that shares styles with the seed ranks a little
 * closer; changing genre never pushes one away.
 *
 *   d'(t) = today's distance − β · cos(v_t, v_seed)
 *
 * v is a track's style vector from its fused memberships (track_styles):
 * each style at its strength, each genre row at half its strength (so two
 * genre-only Rock tracks still overlap, and a styled Rock track overlaps a
 * genre-only one a little), L2-normalised, so a track with many labels gains
 * nothing for having them. β comes from the genre strictness setting: on dev,
 * β = 0.1 (strictness 50) brings about 3 of the 10 nearest in from a little
 * further down (the 10th nearest is a median 0.066 away from the nearest).
 *
 * The classic engine (genre hop cost) stays selectable per user while the two
 * are compared.
 */
import type { Pool, PoolClient } from 'pg';
import { tagKey } from './genreTaxonomy/data';

export type RecommendationEngine = 'classic' | 'styles';
export const RECOMMENDATION_ENGINES: readonly RecommendationEngine[] = ['classic', 'styles'];
/** The engine until the blind comparison says otherwise. */
export const DEFAULT_RECOMMENDATION_ENGINE: RecommendationEngine = 'classic';

export const engineOf = (value: unknown): RecommendationEngine =>
  value === 'styles' || value === 'classic' ? value : DEFAULT_RECOMMENDATION_ENGINE;

/** β at full genre strictness (100). */
export const STYLE_OVERLAP_MAX_BETA = 0.2;
/** β for a genre strictness of 0–100. */
export const styleBeta = (strictness: number) => (Math.max(0, Math.min(100, strictness)) / 100) * STYLE_OVERLAP_MAX_BETA;

/** Sparse and L2-normalised: "s<style id>" and "g<genre>" → weight. */
export type StyleVector = Map<string, number>;

const GENRE_WEIGHT = 0.5;

function normalise(v: StyleVector): StyleVector | null {
  const n = Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));
  if (!n) return null;
  for (const [k, x] of v) v.set(k, x / n);
  return v;
}

/** Cosine of two normalised style vectors: 0 (nothing shared) to 1. Missing vectors share nothing. */
export function styleCosine(a: StyleVector | null | undefined, b: StyleVector | null | undefined): number {
  if (!a || !b) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [k, x] of small) sum += x * (large.get(k) ?? 0);
  return Math.max(0, Math.min(1, sum));
}

/** Style vectors of tracks from their fused genres and styles; tracks with none are absent. */
export async function styleVectors(db: Pool | PoolClient, trackIds: string[]): Promise<Map<string, StyleVector>> {
  const out = new Map<string, StyleVector>();
  if (!trackIds.length) return out;
  const rows = (await db.query(
    `SELECT track_id, genre, style_id, strength FROM track_styles WHERE track_id = ANY($1::text[])`,
    [[...new Set(trackIds)]])).rows as Array<{ track_id: string; genre: string; style_id: number | null; strength: number }>;
  for (const r of rows) {
    const v = out.get(r.track_id) ?? new Map<string, number>();
    const key = r.style_id === null ? `g${r.genre}` : `s${r.style_id}`;
    v.set(key, (v.get(key) ?? 0) + Number(r.strength) * (r.style_id === null ? GENRE_WEIGHT : 1));
    out.set(r.track_id, v);
  }
  for (const [id, v] of out) { if (!normalise(v)) out.delete(id); }
  return out;
}

/**
 * The seed of a run of tracks: their vectors weighted by recency like
 * Infinity's acoustic centroid (the newest counts 1, each older one λ times
 * less), normalised. Null when none of them has genres or styles.
 */
export function blendStyleVectors(ordered: Array<StyleVector | null | undefined>, lambda = 0.8): StyleVector | null {
  const sum = new Map<string, number>();
  ordered.forEach((v, i) => {
    if (!v) return;
    const w = Math.pow(lambda, ordered.length - 1 - i);
    for (const [k, x] of v) sum.set(k, (sum.get(k) ?? 0) + x * w);
  });
  return sum.size ? normalise(sum) : null;
}

/** The blended style vector of tracks in play order (oldest first). */
export async function seedStyleVector(db: Pool | PoolClient, orderedTrackIds: string[]): Promise<StyleVector | null> {
  const vectors = await styleVectors(db, orderedTrackIds);
  return blendStyleVectors(orderedTrackIds.map(id => vectors.get(id)));
}

/**
 * A style vector for genre names as the old engine and the AI playlist
 * prompts write them ("deep house", "electronic.house.deep house", "Hip
 * Hop"): each name (a path's last part) through the tag mapping, its styles
 * at 1 and its genres at half. Null when no name maps.
 */
export async function styleVectorForNames(db: Pool | PoolClient, names: string[]): Promise<StyleVector | null> {
  const keys = [...new Set(names.map(n => String(n || '').split('.').pop() || '').map(n => tagKey(n)).filter(Boolean))];
  if (!keys.length) return null;
  const rows = (await db.query(
    `SELECT DISTINCT genre, style_id FROM tag_map WHERE tag = ANY($1::text[]) AND reliability >= 0.8`, [keys])).rows as Array<{ genre: string; style_id: number | null }>;
  const v = new Map<string, number>();
  for (const r of rows) {
    if (r.style_id !== null) v.set(`s${r.style_id}`, 1);
    v.set(`g${r.genre}`, Math.max(v.get(`g${r.genre}`) ?? 0, GENRE_WEIGHT));
  }
  return normalise(v);
}
