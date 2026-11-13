/**
 * The scored mix: artist radio and the daylist on the same score as AI
 * playlists (docs/Aurora genre and style redesign.md, AI playlists → one
 * score), in place of the six-pool mixer (candidatePool.buildPlaylistFromPools)
 * that lost the blind comparison for AI playlists.
 *
 * Candidates: the tracks nearest a target sound, the target styles' strong
 * members nearest that sound, and (when asked) the listener's favourites
 * near it. Score (lower is better), in spreads of sound distance:
 *
 *   d̂ − β · style match − ν · ½ · novelty − φ · ½ · favourite + jitter
 *
 * β from cohesion and how many strong members there are (scoreBeta), ν the
 * discovery bias, φ the favourites weight, the jitter (freshness) so a radio
 * pressed twice differs. Then the best first, one song once, an artist cap.
 */
import { queryWithRetry } from '../utils/db';
import { initDB } from '../database';
import { fetchCandidatePool, getSongDedupKey } from './candidatePool.service';
import { artistCap, conceptMatch, rankByScore, scoreBeta, STRONG_MEMBER, trackMemberships, type ConceptStyles } from './aiPlaylistScore.service';
import { splitAtFeaturing } from '../../shared/artistCredit';

/**
 * A 1280D EffNet embedding centroid for an 8D target sound (the AI's or a
 * daylist mood's numbers): the mean embedding of the 20 tracks nearest it,
 * or null when that neighbourhood is too sparse or steep to trust.
 */
export async function imputeEffNetCentroid(seed8DStr: string): Promise<string | null> {
  try {
    const seedRes = await queryWithRetry(`
      SELECT tf.embedding_vector::text as vec,
             (tf.acoustic_vector_8d <-> $1::vector) as distance
      FROM tracks t
      JOIN track_features tf ON t.id = tf.track_id
      WHERE tf.embedding_vector IS NOT NULL AND tf.is_simulated = FALSE
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

    const validSeeds = seedRes.rows.filter((r: any) => r.distance <= 1.5);
    const firstVec = JSON.parse(validSeeds[0].vec);
    const dim = firstVec.length;
    const centroid = new Array(dim).fill(0);
    for (const row of validSeeds) {
      const vec = JSON.parse(row.vec);
      for (let i = 0; i < dim; i++) centroid[i] += vec[i];
    }
    const n = validSeeds.length;
    // L2-normalised for cosine distance.
    const norm = Math.sqrt(centroid.reduce((s, v) => s + (v / n) * (v / n), 0));
    for (let i = 0; i < dim; i++) centroid[i] = norm > 0 ? (centroid[i] / n) / norm : centroid[i] / n;
    console.log(`[EffNet Impute] Successfully blended ${n} seeds (${dim}D) for embedding centroid.`);
    return `[${centroid.join(',')}]`;
  } catch {
    return null;
  }
}

/** The artist a track counts under for the artist cap: the credit's lead name. */
const JOINT_CREDIT = /\s*,\s+|\s+(?:&|\+|and|og|und|et|with|vs\.?|x|presents|pres\.)\s+/i;
export function leadArtistKey(artist: string): string {
  const main = splitAtFeaturing(artist)?.[0] ?? artist;
  return (main.split(JOINT_CREDIT)[0] || main).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ');
}

/** How much a favourite counts at most, in spreads (as the novelty bonus). */
const FAVOURITE_WEIGHT = 0.5;
/** Plays at which a track counts as a full favourite. */
const FAVOURITE_FULL_PLAYS = 10;

export interface ScoredMixOptions {
  userId: string;
  length: number;
  /** The target sound: 8 numbers, and an embedding centroid when there is one. */
  sound: { vectorStr: string; embeddingStr: string | null; effnetWeight?: number };
  /** Target styles (conceptStyles), or null for sound alone. */
  styles: Pick<ConceptStyles, 'weights' | 'styleIds' | 'genres'> | null;
  /** How strictly to keep to the styles, 0–1 (as Genre Cohesion). */
  cohesion: number;
  /** ν: how much unheard and long-unplayed tracks are favoured, 0–1. */
  discovery: number;
  /** φ: how much the listener's favourites are favoured, 0–1. */
  favourites?: number;
  /** Artist Spread, 0–1 (artistCap). */
  artistSpread: number;
  /** Random jitter on each score, in spreads (0 = the same mix every time). */
  freshness?: number;
  bannedPaths?: string[];
  excludeIds?: string[];
  excludeArtistIds?: string[];
  /** Lead-artist keys (leadArtistKey) to leave out: the radio's own artist under other credits. */
  excludeArtistKeys?: string[];
  /** Name for the log line. */
  label?: string;
}

export async function scoredMix(opts: ScoredMixOptions): Promise<any[]> {
  const L = opts.length;
  if (L <= 0) return [];
  const db = await initDB();
  const shared = {
    userId: opts.userId,
    vectorStr: opts.sound.vectorStr,
    embeddingCentroidStr: opts.sound.embeddingStr,
    effnetWeight: opts.sound.effnetWeight ?? 0.55,
    enableDiscoveryBoost: true,
    bannedPaths: opts.bannedPaths,
    excludeIds: opts.excludeIds,
    excludeArtistIds: opts.excludeArtistIds,
  };
  const styles = opts.styles && (opts.styles.styleIds.length || opts.styles.genres.length) ? opts.styles : null;
  const [sound, strong, favourites] = await Promise.all([
    fetchCandidatePool({ ...shared, name: 'core', limit: Math.max(10 * L, 300) }),
    styles
      ? fetchCandidatePool({ ...shared, name: 'adjacent', limit: Math.max(8 * L, 200), memberOf: { styleIds: styles.styleIds, genres: styles.genres, minStrength: STRONG_MEMBER } })
      : Promise.resolve([]),
    (opts.favourites ?? 0) > 0
      ? fetchCandidatePool({ ...shared, name: 'favorites', limit: Math.max(4 * L, 80), favoritesScore: true })
      : Promise.resolve([]),
  ]);

  // One row per track; the plain distance (favourites rows order differently but carry it too).
  const byId = new Map<string, any>();
  for (const row of [...sound, ...strong, ...favourites]) {
    const id = String(row.id);
    if (!byId.has(id)) byId.set(id, row);
  }
  const excludedKeys = new Set(opts.excludeArtistKeys ?? []);
  const rows = [...byId.values()].filter((r: any) => !excludedKeys.has(leadArtistKey(r.artist || '')));
  if (!rows.length) return [];

  const ids = rows.map((r: any) => String(r.id));
  const strongIds = new Set(strong.map((r: any) => String(r.id)));
  const support = new Set(rows.filter((r: any) => strongIds.has(String(r.id))).map(getSongDedupKey)).size;
  const memberships = styles ? await trackMemberships(db, ids) : new Map();
  const plays = new Map<string, number>();
  if ((opts.favourites ?? 0) > 0) {
    const res = await queryWithRetry(
      `SELECT track_id, COALESCE(play_count, 0) + COALESCE(rating, 0) * 2 AS score
       FROM user_playback_stats WHERE user_id = $1 AND track_id = ANY($2::text[])`,
      [opts.userId, ids],
    );
    for (const r of res.rows as any[]) plays.set(String(r.track_id), Number(r.score) || 0);
  }
  const beta = styles ? scoreBeta(opts.cohesion, support, L) : 0;
  const phi = opts.favourites ?? 0;
  const jitter = opts.freshness ?? 0;
  const ranked = rankByScore(rows, {
    match: (r: any) => (styles ? conceptMatch(styles.weights, memberships.get(String(r.id))) : 0),
    beta,
    nu: opts.discovery,
    penalty: (r: any) => {
      const favourite = Math.min(1, Math.log1p(plays.get(String(r.id)) ?? 0) / Math.log1p(FAVOURITE_FULL_PLAYS));
      return -phi * FAVOURITE_WEIGHT * favourite + (jitter > 0 ? Math.random() * jitter : 0);
    },
  });

  // Artists who fit (match ≥ 0.5) set how many each may bring.
  const fitting = styles ? ranked.filter(r => r.styleMatch >= 0.5) : ranked;
  const artistsAvailable = new Set((fitting.length ? fitting : ranked).map((r: any) => leadArtistKey(r.artist || ''))).size;
  const cap = artistCap(L, artistsAvailable, opts.artistSpread);
  const picked: any[] = [];
  const songs = new Set<string>();
  const perArtist = new Map<string, number>();
  for (const row of ranked) {
    if (picked.length >= L) break;
    const song = getSongDedupKey(row);
    const artist = leadArtistKey((row as any).artist || '');
    if (songs.has(song) || (perArtist.get(artist) ?? 0) >= cap) continue;
    songs.add(song);
    perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
    picked.push(row);
  }

  const meanMatch = picked.reduce((sum, r) => sum + Number(r.styleMatch || 0), 0) / Math.max(1, picked.length);
  console.log(`[Scored mix] ${opts.label ?? 'mix'}: candidates sound ${sound.length} + strong ${strong.length} + favourites ${favourites.length} → ${rows.length}`
    + ` | support=${support} beta=${beta.toFixed(2)} nu=${opts.discovery.toFixed(2)} phi=${phi.toFixed(2)} cap=${cap}`
    + ` | picked ${picked.length} from ${perArtist.size} artists, mean style match ${meanMatch.toFixed(2)}`);
  return picked;
}
