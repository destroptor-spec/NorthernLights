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
import { SOUND_QUALITIES, type SoundQuality } from '../../shared/audioMoods';

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
/** A target style's genre counts half the style. */
const GENRE_WEIGHT = 0.5;
/**
 * The nearest styles a target brings in (by centroid), and how much they
 * count: Adjacent Reach for a genre request, more for a mood request, which
 * loosens to the styles that sound closest rather than the whole genre. (A
 * rainy-day indie list given the whole Rock genre at 0.74 drifted to Journey,
 * Toto and Queen and lost a blind comparison, 12 Nov 2026; Indie Rock's
 * nearest are Indie Pop, Folk, Pop Rock, Alternative Rock, Blues Rock.)
 */
export const neighbourCount = (focus: number) => 3 + Math.round(3 * (1 - clamp01(focus)));
export const neighbourWeight = (adjacentReach: number, focus: number) =>
  Math.min(0.8, 0.5 * clamp01(adjacentReach) + 0.4 * (1 - clamp01(focus)));
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }

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
export async function conceptStyles(db: Db, paths: string[], adjacentReach: number, focus = 1): Promise<ConceptStyles> {
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

  const reach = neighbourWeight(adjacentReach, focus);
  const neighbours = neighbourCount(focus);
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
      WHERE me.style_id = ANY($1::int[])`, [styleIds, neighbours])).rows as Array<{ target: number; id: number; name: string; genre: string }>;
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
      WHERE me.id = ANY($1::int[])`, [fallback, neighbours, STRONG_MEMBER])).rows as typeof near : [];
    for (const r of [...near, ...siblings]) {
      const targetIndex = paths.findIndex(p => byPath.get(p)?.id === r.target);
      const weight = targetWeight(Math.max(0, targetIndex)) * reach;
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

/**
 * Two embedding targets ("[…]" strings), each normalised, averaged with
 * `styleShare` for the first and normalised again; either alone when the
 * other is missing.
 */
export function blendEmbeddings(styleSound: string | null, aiSound: string | null, styleShare = 0.5): string | null {
  const parse = (v: string | null) => {
    if (!v) return null;
    const x = JSON.parse(v) as number[];
    const n = Math.sqrt(x.reduce((a, b) => a + b * b, 0));
    return n > 0 ? x.map(e => e / n) : null;
  };
  const a = parse(styleSound);
  const b = parse(aiSound);
  if (!a || !b || a.length !== b.length) return styleSound ?? aiSound;
  const mixed = a.map((e, i) => e * styleShare + b[i] * (1 - styleShare));
  const n = Math.sqrt(mixed.reduce((s, e) => s + e * e, 0)) || 1;
  return `[${mixed.map(e => e / n).join(',')}]`;
}

export type MoodTarget = Partial<Record<SoundQuality, number>>;

/** The AI's sound_moods: the qualities it named (moods, acoustic, instrumental), clamped to 0–1; null when none. */
export function moodTargetOf(value: unknown): MoodTarget | null {
  if (!value || typeof value !== 'object') return null;
  const out: MoodTarget = {};
  for (const mood of SOUND_QUALITIES) {
    const n = Number((value as Record<string, unknown>)[mood]);
    if (Number.isFinite(n)) out[mood] = Math.max(0, Math.min(1, n));
  }
  return Object.keys(out).length ? out : null;
}

/** How well a track's moods from the sound fit the target: 1 − mean distance over the named moods. */
export function moodMatch(target: MoodTarget | null, moods: Partial<Record<SoundQuality, number>> | undefined): number {
  if (!target || !moods) return 0;
  let sum = 0;
  let n = 0;
  for (const mood of SOUND_QUALITIES) {
    const want = target[mood];
    const have = moods[mood];
    if (want === undefined || have === undefined) continue;
    sum += Math.abs(want - have);
    n++;
  }
  return n ? 1 - sum / n : 0;
}

/**
 * β for the mood fit at a pure mood request, in spreads. 2.5 let mood
 * override style (the rainy-day list above); at 1.25 mood picks among tracks
 * that fit rather than replacing them.
 */
export const MOOD_MAX_BETA = 1.25;
/**
 * The mood's weight: most for a mood request (focus 0), a little for a genre
 * request (focus 1: a "90s Eurodance party" still wants party). None without
 * a mood target.
 */
export function moodBeta(focus: number, hasTarget: boolean): number {
  if (!hasTarget) return 0;
  return MOOD_MAX_BETA * (0.25 + 0.75 * (1 - Math.max(0, Math.min(1, focus))));
}

/**
 * Tracks' sound qualities: moods from track_moods, acoustic and instrumental
 * from analysis (acoustic_vector_8d positions 6 and 5). A track without mood
 * scores still has those two.
 */
export async function trackMoods(db: Db, trackIds: string[]): Promise<Map<string, Partial<Record<SoundQuality, number>>>> {
  const out = new Map<string, Partial<Record<SoundQuality, number>>>();
  if (!trackIds.length) return out;
  const rows = (await db.query(`
    SELECT tf.track_id, m.happy, m.sad, m.relaxed, m.aggressive, m.party,
           (tf.acoustic_vector_8d::real[])[6] AS acoustic, (tf.acoustic_vector_8d::real[])[5] AS instrumental
    FROM track_features tf LEFT JOIN track_moods m ON m.track_id = tf.track_id
    WHERE tf.track_id = ANY($1::text[]) AND NOT tf.is_simulated`,
    [[...new Set(trackIds)]])).rows as Array<Record<string, unknown>>;
  for (const r of rows) {
    const q: Partial<Record<SoundQuality, number>> = {};
    for (const k of SOUND_QUALITIES) if (r[k] !== null && r[k] !== undefined) q[k] = Number(r[k]);
    out.set(String(r.track_id), q);
  }
  return out;
}

/** SQL for one quality, with track_moods as `mo` and track_features as `tf`. */
export function soundQualitySql(quality: SoundQuality): string {
  if (quality === 'acoustic') return '(tf.acoustic_vector_8d::real[])[6]';
  if (quality === 'instrumental') return '(tf.acoustic_vector_8d::real[])[5]';
  return `mo.${quality}`;
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

/** What a concept is about when the AI didn't say: a little more style than mood. */
export const DEFAULT_FOCUS = 0.6;

/** The AI's focus, 0 (mood, activity, feeling) to 1 (genre, style); the default when missing or not a number. */
export function focusOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && value !== null && value !== '' ? Math.max(0, Math.min(1, n)) : DEFAULT_FOCUS;
}

/**
 * β for a general list: Genre Cohesion (0–1) times how much of the concept
 * the library has, times what the request is about: full at focus 1, half
 * at focus 0, so a mood request ("music for code") can reach into
 * neighbouring styles for music that feels right.
 */
export function scoreBeta(cohesion: number, support: number, playlistLength: number, focus = 1): number {
  const supportFactor = Math.min(1, support / Math.max(1, 4 * playlistLength));
  // Half at a pure mood request: a blind comparison (12 Nov 2026) preferred
  // a rainy-day list that stayed indie rock over a moodier one that drifted
  // into classic rock.
  const focusFactor = 0.5 + 0.5 * Math.max(0, Math.min(1, focus));
  return Math.max(0, Math.min(1, cohesion)) * SCORE_MAX_BETA * supportFactor * focusFactor;
}

/**
 * The styles' share of the sound target: mostly the styles' own sound for a
 * genre request, mostly the AI's sound (mood, energy, instrumental) for a
 * mood request; 0.56 at the default focus 0.6.
 */
export const styleSoundShare = (focus: number) => 0.35 + 0.35 * Math.max(0, Math.min(1, focus));

export interface ScoredRow {
  styleMatch: number;
  moodFit: number;
  score: number;
}

/**
 * Ranks candidates by the score, best first. Rows carry `distance` (sound,
 * mood lean included) and `novelty_boost`; `penalty` adds to a row's score
 * (banned genres under the adaptive veto).
 */
export function rankByScore<T extends { id: string; distance: number | string; novelty_boost?: number | string | null }>(
  rows: T[],
  opts: {
    match: (row: T) => number; beta: number; nu: number; penalty?: (row: T) => number;
    mood?: (row: T) => number; moodBeta?: number;
    /** Mood counts in proportion to style fit (0.4 + 0.6 · match), so it picks among tracks of the concept. */
    moodGate?: boolean;
  },
): Array<T & ScoredRow> {
  const { low, spread } = distanceSpread(rows.map(r => Number(r.distance)));
  const ranked = rows
    .map(row => {
      const styleMatch = opts.match(row);
      const moodFit = opts.mood ? opts.mood(row) : 0;
      const score = (Number(row.distance) - low) / spread
        - opts.beta * styleMatch
        - (opts.moodBeta ?? 0) * moodFit * (opts.moodGate ? 0.4 + 0.6 * styleMatch : 1)
        - opts.nu * NOVELTY_WEIGHT * Math.min(1, Number(row.novelty_boost ?? 0) / NOVELTY_FULL)
        + (opts.penalty?.(row) ?? 0);
      return { ...row, styleMatch, moodFit, score };
    })
    .filter(row => Number.isFinite(row.score))
    .sort((a, b) => a.score - b.score);
  if (process.env.AI_SCORE_DEBUG) {
    console.log(`[AI score] low=${low.toFixed(3)} spread=${spread.toFixed(3)} beta=${opts.beta.toFixed(2)} nu=${opts.nu.toFixed(2)}`);
    for (const r of ranked.slice(0, Number(process.env.AI_SCORE_DEBUG) > 1 ? Number(process.env.AI_SCORE_DEBUG) : 12)) {
      console.log(`  ${r.score.toFixed(2)} d̂=${((Number(r.distance) - low) / spread).toFixed(2)} match=${r.styleMatch.toFixed(2)} mood=${r.moodFit.toFixed(2)} nov=${Math.min(1, Number(r.novelty_boost ?? 0) / NOVELTY_FULL).toFixed(2)} ${(r as any).artist} — ${(r as any).title}`);
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
