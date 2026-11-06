/**
 * Original genre tags per track (track_tags). Kept free of database-module
 * imports: server/database calls replaceTrackTags while writing a track.
 */
import type { Pool } from 'pg';
import { tagKey } from './data';

/** Splits tracks.genres (JSON array text, or a plain string) into tags, file order kept. */
export function splitStoredGenres(genres: string | null, genre: string | null): string[] {
  let list: unknown[] = [];
  if (genres) {
    try {
      const parsed = JSON.parse(genres);
      list = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      list = [genres];
    }
  }
  if (list.length === 0 && genre) list = [genre];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of list) {
    const tag = String(value ?? '').trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** Replaces one track's tags; called wherever the scanner rewrites track genres. */
export async function replaceTrackTags(db: Pick<Pool, 'query'>, trackId: string, rawGenres: string[]) {
  const tags = Array.from(new Set(rawGenres.map(tag => tag.trim()).filter(Boolean)));
  await db.query('DELETE FROM track_tags WHERE track_id = $1', [trackId]);
  if (tags.length === 0) return;
  await db.query(
    `INSERT INTO track_tags (track_id, tag, tag_key, position)
     SELECT $1, tag, key, pos FROM unnest($2::text[], $3::text[], $4::smallint[]) AS t(tag, key, pos)
     ON CONFLICT (track_id, tag) DO UPDATE SET tag_key = EXCLUDED.tag_key, position = EXCLUDED.position`,
    [trackId, tags, tags.map(tagKey), tags.map((_, i) => i)]);
}

/** Fills track_tags for tracks that have genres but no rows (all tracks on first run). */
export async function backfillTrackTags(db: Pool, batchSize = 2000): Promise<number> {
  let written = 0;
  for (;;) {
    const rows = (await db.query(
      `SELECT t.id, t.genres, t.genre FROM tracks t
       WHERE (COALESCE(t.genres, '') NOT IN ('', '[]') OR COALESCE(t.genre, '') <> '')
         AND NOT EXISTS (SELECT 1 FROM track_tags tt WHERE tt.track_id = t.id)
       LIMIT $1`, [batchSize])).rows as { id: string; genres: string | null; genre: string | null }[];
    if (rows.length === 0) return written;
    const ids: string[] = []; const tags: string[] = []; const keys: string[] = []; const pos: number[] = [];
    for (const row of rows) {
      splitStoredGenres(row.genres, row.genre).forEach((tag, i) => {
        ids.push(row.id); tags.push(tag); keys.push(tagKey(tag)); pos.push(i);
      });
    }
    if (tags.length === 0) return written; // only empty-after-trim genres left
    await db.query(
      `INSERT INTO track_tags (track_id, tag, tag_key, position)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::smallint[])
       ON CONFLICT (track_id, tag) DO NOTHING`, [ids, tags, keys, pos]);
    written += rows.length;
  }
}
