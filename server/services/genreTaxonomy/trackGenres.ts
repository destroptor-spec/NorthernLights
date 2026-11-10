/**
 * The genres every other client sees (phase 4 of the genre redesign):
 * `track_genres` and `tracks.genre_id` are derived from the fused genres and
 * styles, so Subsonic apps, the API's track genre and the filters show
 * Aurora's taxonomy ("Grunge", "Alternative Rock", "Rock") instead of the raw
 * file tags. The tags themselves stay in tracks.genre / tracks.genres and
 * track_tags, and raw spellings stay in `genres` for the spelling review.
 *
 * Per track: its styles first (strongest first), then its genres; position 0
 * is tracks.genre_id. A style name in two genres ("Trip Hop") is one genre
 * row. A track with no fused genre has no row and genre_id NULL.
 */
import type { Pool, PoolClient } from 'pg';
import { normalizeGenreIdentity } from '../../utils/genreIdentity';

type Db = Pool | PoolClient;

/** Bumped when the derivation changes; startup rebuilds every track once. */
export const TRACK_GENRES_VERSION = 1;
export const TRACK_GENRES_SETTING = 'trackGenresVersion';

/**
 * Rebuilds track_genres and tracks.genre_id for `trackIds` (every track when
 * omitted) from track_styles. Returns the number of tracks with a genre.
 */
export async function rebuildTrackGenres(db: Db, trackIds?: string[]): Promise<number> {
  const scope = trackIds ?? null;
  if (scope && !scope.length) return 0;
  const names = (await db.query(`
    SELECT DISTINCT COALESCE(s.name, ts.genre) AS name
    FROM track_styles ts LEFT JOIN style s ON s.id = ts.style_id
    WHERE $1::text[] IS NULL OR ts.track_id = ANY($1::text[])`, [scope])).rows.map((r: any) => String(r.name));

  // One genres row per name: an existing row of that name (the exact
  // spelling first), else a new one. A row grouped under another spelling
  // is ungrouped: it now names a genre or style of its own, and a tag with
  // that exact name maps to it before any grouping.
  const ids = new Map<string, string>();
  if (names.length) {
    const existing = (await db.query(
      `SELECT id, name, merged_into FROM genres WHERE lower(name) = ANY($1::text[])
       ORDER BY (merged_into IS NOT NULL), created_at`, [names.map(n => n.toLowerCase())])).rows as Array<{ id: string; name: string; merged_into: string | null }>;
    for (const name of names) {
      const row = existing.find(r => r.name === name) ?? existing.find(r => r.name.toLowerCase() === name.toLowerCase());
      if (row) { ids.set(name, row.id); continue; }
      const created = await db.query(
        `INSERT INTO genres (name, normalized_key) VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [name, normalizeGenreIdentity(name)]);
      ids.set(name, created.rows[0].id);
    }
    await db.query(`UPDATE genres SET merged_into = NULL WHERE id = ANY($1::uuid[]) AND merged_into IS NOT NULL`, [[...ids.values()]]);
  }

  if (scope) await db.query('DELETE FROM track_genres WHERE track_id = ANY($1::text[])', [scope]);
  else await db.query('DELETE FROM track_genres');
  await db.query(`
    WITH m AS (SELECT * FROM unnest($1::text[], $2::uuid[]) AS m(name, genre_id)),
    r AS (
      SELECT DISTINCT ON (ts.track_id, m.genre_id) ts.track_id, m.genre_id, ts.style_id IS NULL AS is_genre, ts.strength, m.name
      FROM track_styles ts
      LEFT JOIN style s ON s.id = ts.style_id
      JOIN m ON m.name = COALESCE(s.name, ts.genre)
      WHERE $3::text[] IS NULL OR ts.track_id = ANY($3::text[])
      ORDER BY ts.track_id, m.genre_id, (ts.style_id IS NULL), ts.strength DESC
    )
    INSERT INTO track_genres (track_id, genre_id, position)
    SELECT track_id, genre_id, (ROW_NUMBER() OVER (PARTITION BY track_id ORDER BY is_genre, strength DESC, name) - 1)::int
    FROM r`, [[...ids.keys()], [...ids.values()], scope]);
  await db.query(`
    UPDATE tracks t SET genre_id = tg.genre_id
    FROM tracks src LEFT JOIN track_genres tg ON tg.track_id = src.id AND tg.position = 0
    WHERE src.id = t.id AND ($1::text[] IS NULL OR t.id = ANY($1::text[]))
      AND t.genre_id IS DISTINCT FROM tg.genre_id`, [scope]);
  return Number((await db.query(
    `SELECT COUNT(DISTINCT track_id)::int AS n FROM track_genres WHERE $1::text[] IS NULL OR track_id = ANY($1::text[])`, [scope])).rows[0].n);
}
