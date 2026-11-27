/**
 * Reads and writes for the library's sound map and the library ranks behind
 * the Rays page's fingerprint (radar and aurora). Only analysed tracks count:
 * simulated features sit at the centre of the space and would skew both.
 */
import { initDB } from './index';

const REAL = `NOT COALESCE(f.is_simulated, false)`;

/** The axes a track is ranked on, as stored. Positions in acoustic_vector_8d come from extractor.py. */
export const LIBRARY_AXES = {
  energy: `(f.acoustic_vector_8d::real[])[1]`,
  brightness: `(f.acoustic_vector_8d::real[])[2]`,
  percussiveness: `(f.acoustic_vector_8d::real[])[3]`,
  instrumentalness: `(f.acoustic_vector_8d::real[])[5]`,
  acousticness: `(f.acoustic_vector_8d::real[])[6]`,
  danceability: `(f.acoustic_vector_8d::real[])[7]`,
  loudness: `f.loudness_lufs`,
} as const;
export type LibraryAxis = keyof typeof LIBRARY_AXES;

export interface SoundMapState {
  /** Analysed tracks with an embedding: what the map should hold. */
  analysed: number;
  /** Tracks on the map now. */
  mapped: number;
  builtAt: Date | null;
}

export async function getSoundMapState(): Promise<SoundMapState> {
  const db = await initDB();
  const r = await db.query(`
    SELECT (SELECT COUNT(*) FROM track_features f WHERE ${REAL} AND f.embedding_vector IS NOT NULL)::int AS analysed,
           (SELECT COUNT(*) FROM sound_map)::int AS mapped,
           (SELECT MAX(built_at) FROM sound_map) AS built_at`);
  const row = r.rows[0];
  return { analysed: Number(row.analysed), mapped: Number(row.mapped), builtAt: row.built_at ?? null };
}

/** A stable sample of the map for its backdrop: the same tracks every time, so the sky doesn't reshuffle. */
export async function getSoundMapPoints(limit: number): Promise<Array<[number, number]>> {
  const db = await initDB();
  const r = await db.query(`SELECT x, y FROM sound_map ORDER BY md5(track_id) LIMIT $1`, [limit]);
  return r.rows.map((row: any) => [Number(row.x), Number(row.y)]);
}

export interface SoundMapLabel { genre: string; x: number; y: number; trackCount: number }

/** Where each main genre sits: the median position of the tracks it is strongest on. */
export async function getSoundMapLabels(minTracks: number): Promise<SoundMapLabel[]> {
  const db = await initDB();
  const r = await db.query(`
    WITH main AS (
      SELECT DISTINCT ON (track_id) track_id, genre FROM track_styles WHERE style_id IS NULL ORDER BY track_id, strength DESC, genre
    )
    SELECT main.genre,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY m.x) AS x,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY m.y) AS y,
           COUNT(*)::int AS n
    FROM sound_map m JOIN main ON main.track_id = m.track_id
    GROUP BY main.genre HAVING COUNT(*) >= $1
    ORDER BY n DESC`, [minTracks]);
  return r.rows.map((row: any) => ({ genre: row.genre, x: Number(row.x), y: Number(row.y), trackCount: Number(row.n) }));
}

export async function getSoundMapPositions(trackIds: string[]): Promise<Map<string, { x: number; y: number }>> {
  if (trackIds.length === 0) return new Map();
  const db = await initDB();
  const r = await db.query(`SELECT track_id, x, y FROM sound_map WHERE track_id = ANY($1::text[])`, [trackIds]);
  return new Map(r.rows.map((row: any) => [String(row.track_id), { x: Number(row.x), y: Number(row.y) }]));
}

/** A random sample of analysed embeddings, to fit the map's projection on. */
export async function getEmbeddingSample(limit: number): Promise<number[][]> {
  const db = await initDB();
  const r = await db.query(`
    SELECT f.embedding_vector::text AS v FROM track_features f
    WHERE ${REAL} AND f.embedding_vector IS NOT NULL
    ORDER BY random() LIMIT $1`, [limit]);
  return r.rows.map((row: any) => String(row.v).slice(1, -1).split(',').map(Number));
}

/**
 * Replaces the whole map: every analysed track projected onto the two
 * components in SQL (pgvector's <#> is the negative inner product). The mean
 * is left out: it only shifts the map, and clients fit the view to the points.
 */
export async function replaceSoundMap(first: number[], second: number[]): Promise<number> {
  const db = await initDB();
  const client = await db.connect();
  const literal = (v: number[]) => `[${v.map(n => (Number.isFinite(n) ? n : 0)).join(',')}]`;
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM sound_map');
    const r = await client.query(`
      INSERT INTO sound_map (track_id, x, y)
      SELECT f.track_id, -(f.embedding_vector <#> $1::vector), -(f.embedding_vector <#> $2::vector)
      FROM track_features f JOIN tracks t ON t.id = f.track_id
      WHERE ${REAL} AND f.embedding_vector IS NOT NULL`, [literal(first), literal(second)]);
    await client.query('COMMIT');
    return r.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Every analysed track's value on each axis, sorted ascending: the library a track is ranked against. */
export async function getLibraryAxisValues(): Promise<Record<LibraryAxis, number[]>> {
  const db = await initDB();
  const columns = Object.entries(LIBRARY_AXES)
    .map(([name, expr]) => `array_agg(${expr} ORDER BY ${expr}) FILTER (WHERE ${expr} IS NOT NULL) AS ${name}`)
    .join(', ');
  const r = await db.query(`SELECT ${columns} FROM track_features f WHERE ${REAL}`);
  const row = r.rows[0] ?? {};
  return Object.fromEntries(Object.keys(LIBRARY_AXES).map(name => [name, ((row[name] as unknown[]) ?? []).map(Number)])) as Record<LibraryAxis, number[]>;
}

export interface GenreAverageRanks { genre: string; trackCount: number; ranks: Record<LibraryAxis, number | null> }

/** For each main genre, its tracks' average rank in the library on every axis (0–1). */
export async function getGenreAverageRanks(): Promise<GenreAverageRanks[]> {
  const db = await initDB();
  const names = Object.keys(LIBRARY_AXES) as LibraryAxis[];
  const ranks = names.map(name => {
    const expr = LIBRARY_AXES[name];
    return `CASE WHEN ${expr} IS NULL THEN NULL ELSE percent_rank() OVER (PARTITION BY ${expr} IS NULL ORDER BY ${expr}) END AS ${name}`;
  }).join(', ');
  const r = await db.query(`
    WITH ranked AS (SELECT f.track_id, ${ranks} FROM track_features f WHERE ${REAL}),
    main AS (
      SELECT DISTINCT ON (track_id) track_id, genre FROM track_styles WHERE style_id IS NULL ORDER BY track_id, strength DESC, genre
    )
    SELECT main.genre, COUNT(*)::int AS n, ${names.map(n => `AVG(ranked.${n}) AS ${n}`).join(', ')}
    FROM ranked JOIN main ON main.track_id = ranked.track_id
    GROUP BY main.genre`);
  return r.rows.map((row: any) => ({
    genre: String(row.genre),
    trackCount: Number(row.n),
    ranks: Object.fromEntries(names.map(n => [n, row[n] === null ? null : Number(row[n])])) as Record<LibraryAxis, number | null>,
  }));
}
