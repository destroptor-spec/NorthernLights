/**
 * AI playlists on one score (docs/Aurora genre and style redesign.md, AI
 * playlists): instead of six pools mixed in fixed shares, every candidate is
 * ranked by
 *
 *   score = d̂ − β · match(t, c) − ν · 0.5 · novelty (novelty scaled to 0–1)
 *
 * d̂ is the sound distance in units of the candidate set's spread (p10 to
 * p90), so β means the same at every library size and target sound. The
 * concept's weights: target styles at 1, 0.9, 0.8, 0.7 in the AI's order, their
 * nearest styles by centroid (or, without one, their genre's biggest styles)
 * at 0.5 × Adjacent Reach, genres at half. match is the track's best
 * membership against them, weight × strength: a track tagged with the first
 * target is 1, a genre-only track of that genre 0.5, a weak sound guess
 * (0.15) near 0. Not a cosine: a cosine against a concept of many styles
 * gave even a pure jazz track only about 0.4 (dev, 11 Nov 2026).
 */
import type { Pool, PoolClient } from 'pg';
import { normaliseStyleVector, type StyleVector } from './styleOverlap.service';
import { pathSegment } from './genreTaxonomy/paths';

type Db = Pool | PoolClient;

/** A membership at this strength or more is "strong" (a tag, a correction, or a clear sound match). */
export const STRONG_MEMBER = 0.5;
/**
 * β at full Genre Cohesion and full support, in units of the candidate set's
 * distance spread: at the default 50 % a full match outweighs two spreads of
 * sound, so a playlist is mostly its styles and sound orders them.
 */
export const SCORE_MAX_BETA = 4.0;
/** The discovery bonus at its largest (never played, nor for 180 days), in spread units at Discovery Bias 1. */
export const NOVELTY_WEIGHT = 0.5;
/** The largest novelty bonus the pool query gives (0.16 + 0.08). */
const NOVELTY_FULL = 0.24;
const NEIGHBOURS_PER_TARGET = 3;
const GENRE_WEIGHT = 0.5;

export interface ConceptStyles {
  vector: StyleVector | null;
  /** "s<style id>" / "g<genre>" → weight (the first target 1), for match(). */
  weights: Map<string, number>;
  /** Target styles and genres, for fetching members and counting support. */
  styleIds: number[];
  genres: string[];
  /**
   * The target styles' sound: their centroids (the mean embedding of their
   * tagged tracks), weighted by target order. The AI's own target sound is an
   * 8-number guess, and the embedding imputed from it sits far from the
   * styles it names (dev, "Euphoric Horizons": its nearest tracks were R&B
   * and hip hop). Null when no target style has a centroid.
   */
  centroid: string | null;
  /** For the log: "Trance 1.00, Progressive Trance 0.85, Hard Trance 0.25 …". */
  describe: string;
}

/** Target weights in the AI's order: 1, 0.9, 0.8, then 0.7 (its order says little). */
export const targetWeight = (index: number) => Math.max(0.7, 1 - index * 0.1);

/**
 * The concept's style vector from its target paths ("electronic.trance",
 * "hip hop") in the AI's order.
 */
export async function conceptStyles(db: Db, paths: string[], adjacentReach: number): Promise<ConceptStyles> {
  const rows = (await db.query(`
    SELECT s.id, s.genre, s.name, lower(replace(s.genre, '.', ' ')) || '.' || lower(replace(s.name, '.', ' ')) AS path
    FROM style s`)).rows as Array<{ id: number; genre: string; name: string; path: string }>;
  const byPath = new Map(rows.map(r => [r.path, r]));
  const genres = (await db.query('SELECT name FROM taxonomy_genre')).rows.map((r: any) => String(r.name));
  const genreByPath = new Map(genres.map(g => [pathSegment(g), g]));

  const weights = new Map<string, number>();
  const label = new Map<string, string>();
  const put = (key: string, weight: number, name: string) => {
    if (weight <= (weights.get(key) ?? 0)) return;
    weights.set(key, weight);
    label.set(key, name);
  };
  const styleIds: number[] = [];
  const targetGenres = new Set<string>();
  paths.forEach((path, index) => {
    const weight = targetWeight(index);
    const style = byPath.get(path);
    if (style) {
      styleIds.push(style.id);
      put(`s${style.id}`, weight, style.name);
      put(`g${style.genre}`, weight * GENRE_WEIGHT, style.genre);
      return;
    }
    const genre = genreByPath.get(path);
    if (genre) {
      targetGenres.add(genre);
      put(`g${genre}`, weight, genre);
    }
  });

  const reach = Math.max(0, Math.min(1, adjacentReach));
  if (reach > 0 && styleIds.length) {
    const near = (await db.query(`
      SELECT me.style_id AS target, n.id, n.name, n.genre
      FROM style_centroids me
      CROSS JOIN LATERAL (
        SELECT c.style_id FROM style_centroids c
        WHERE c.style_id <> me.style_id
        ORDER BY c.centroid <=> me.centroid
        LIMIT $2
      ) c
      JOIN style n ON n.id = c.style_id
      WHERE me.style_id = ANY($1::int[])`, [styleIds, NEIGHBOURS_PER_TARGET])).rows as Array<{ target: number; id: number; name: string; genre: string }>;
    const withCentroid = new Set(near.map(r => r.target));
    // Without a centroid (fewer than 8 tracks by 3 artists): the genre's biggest styles.
    const fallback = styleIds.filter(id => !withCentroid.has(id));
    const siblings = fallback.length ? (await db.query(`
      SELECT me.id AS target, n.id, n.name, n.genre
      FROM style me
      CROSS JOIN LATERAL (
        SELECT s.id, s.name, s.genre FROM style s
        WHERE s.genre = me.genre AND s.id <> me.id
        ORDER BY (SELECT COUNT(*) FROM track_styles ts WHERE ts.style_id = s.id AND ts.strength >= $3) DESC, s.id
        LIMIT $2
      ) n
      WHERE me.id = ANY($1::int[])`, [fallback, NEIGHBOURS_PER_TARGET, STRONG_MEMBER])).rows as typeof near : [];
    for (const r of [...near, ...siblings]) {
      const targetIndex = paths.findIndex(p => byPath.get(p)?.id === r.target);
      const weight = targetWeight(Math.max(0, targetIndex)) * 0.5 * reach;
      put(`s${r.id}`, weight, r.name);
      put(`g${r.genre}`, weight * GENRE_WEIGHT, r.genre);
    }
  }

  let centroid: string | null = null;
  if (styleIds.length) {
    const found = (await db.query(
      `SELECT style_id, centroid::text AS c FROM style_centroids WHERE style_id = ANY($1::int[])`, [styleIds])).rows as Array<{ style_id: number; c: string }>;
    let sum: number[] | null = null;
    for (const r of found) {
      const index = styleIds.indexOf(r.style_id);
      const w = targetWeight(index);
      const v = JSON.parse(r.c) as number[];
      sum ??= new Array(v.length).fill(0);
      v.forEach((x, i) => { sum![i] += x * w; });
    }
    if (sum) {
      const n = Math.sqrt(sum.reduce((a, x) => a + x * x, 0));
      if (n > 0) centroid = `[${sum.map(x => x / n).join(',')}]`;
    }
  }

  const describe = [...weights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, w]) => `${label.get(key)} ${w.toFixed(2)}`)
    .join(', ');
  return { vector: normaliseStyleVector(new Map(weights)), weights, styleIds, genres: [...targetGenres], centroid, describe };
}

/** Tracks' memberships: "s<style id>" / "g<genre>" → strength. */
export async function trackMemberships(db: Db, trackIds: string[]): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  if (!trackIds.length) return out;
  const rows = (await db.query(
    `SELECT track_id, genre, style_id, strength FROM track_styles WHERE track_id = ANY($1::text[])`,
    [[...new Set(trackIds)]])).rows as Array<{ track_id: string; genre: string; style_id: number | null; strength: number }>;
  for (const r of rows) {
    const m = out.get(r.track_id) ?? new Map<string, number>();
    const key = r.style_id === null ? `g${r.genre}` : `s${r.style_id}`;
    m.set(key, Math.max(m.get(key) ?? 0, Number(r.strength)));
    out.set(r.track_id, m);
  }
  return out;
}

/** A track's best membership against the concept: weight × strength, 0 to 1. */
export function conceptMatch(weights: Map<string, number>, memberships: Map<string, number> | undefined): number {
  if (!memberships) return 0;
  let best = 0;
  for (const [key, strength] of memberships) best = Math.max(best, (weights.get(key) ?? 0) * strength);
  return Math.min(1, best);
}

/** p10 to p90 of the candidates' sound distances; at least 0.02 so a tight set doesn't blow up β. */
export function distanceSpread(distances: number[]): { low: number; spread: number } {
  const sorted = distances.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { low: 0, spread: 1 };
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
  return { low: at(0.1), spread: Math.max(0.02, at(0.9) - at(0.1)) };
}

/** β for a general list: Genre Cohesion (0–1) times how much of the concept the library has. */
export function scoreBeta(cohesion: number, support: number, playlistLength: number): number {
  const supportFactor = Math.min(1, support / Math.max(1, 4 * playlistLength));
  return Math.max(0, Math.min(1, cohesion)) * SCORE_MAX_BETA * supportFactor;
}

export interface ScoredRow {
  styleMatch: number;
  score: number;
}

/**
 * Ranks candidates by the score, best first. Rows carry `distance` (sound,
 * mood lean included) and `novelty_boost`; `penalty` adds to a row's score
 * (banned genres under the adaptive veto).
 */
export function rankByScore<T extends { id: string; distance: number | string; novelty_boost?: number | string | null }>(
  rows: T[],
  opts: { match: (row: T) => number; beta: number; nu: number; penalty?: (row: T) => number },
): Array<T & ScoredRow> {
  const { low, spread } = distanceSpread(rows.map(r => Number(r.distance)));
  const ranked = rows
    .map(row => {
      const styleMatch = opts.match(row);
      const score = (Number(row.distance) - low) / spread
        - opts.beta * styleMatch
        - opts.nu * NOVELTY_WEIGHT * Math.min(1, Number(row.novelty_boost ?? 0) / NOVELTY_FULL)
        + (opts.penalty?.(row) ?? 0);
      return { ...row, styleMatch, score };
    })
    .filter(row => Number.isFinite(row.score))
    .sort((a, b) => a.score - b.score);
  if (process.env.AI_SCORE_DEBUG) {
    console.log(`[AI score] low=${low.toFixed(3)} spread=${spread.toFixed(3)} beta=${opts.beta.toFixed(2)} nu=${opts.nu.toFixed(2)}`);
    for (const r of ranked.slice(0, 12)) {
      console.log(`  ${r.score.toFixed(2)} d̂=${((Number(r.distance) - low) / spread).toFixed(2)} match=${r.styleMatch.toFixed(2)} nov=${Math.min(1, Number(r.novelty_boost ?? 0) / NOVELTY_FULL).toFixed(2)} ${(r as any).artist} — ${(r as any).title}`);
    }
  }
  return ranked;
}

/**
 * Tracks per artist: the Artist Spread setting's cap, raised when the
 * candidates have too few artists to fill the list otherwise.
 */
export function artistCap(playlistLength: number, artistsAvailable: number, artistSpread: number): number {
  const fromSetting = artistSpread >= 0.75
    ? 1
    : artistSpread >= 0.45
      ? (playlistLength <= 10 ? 1 : 2)
      : (playlistLength <= 5 ? 1 : playlistLength <= 15 ? 2 : 3);
  const needed = artistsAvailable >= playlistLength ? 1 : Math.ceil(playlistLength / Math.max(1, artistsAvailable));
  return Math.max(fromSetting, needed);
}
