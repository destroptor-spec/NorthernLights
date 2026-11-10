/**
 * Disputed tags (phase 3, "trust, then verify"): tagged styles the sound
 * contradicts (see DISPUTE_MAX_SCORE in fusion.ts), listed for an admin to
 * Keep (an add override: never raised again) or Remove (an exclude override).
 */
import type { Pool } from 'pg';
import type { DisputedTrack } from '../../../shared/genreReview';

export type { DisputedTrack };

/**
 * One page of tracks with disputed styles (each track once, its disputed
 * styles together), grouped by artist and album; the totals count tracks and
 * styles.
 */
export async function listDisputedStyles(db: Pool, { limit = 50, offset = 0 } = {}): Promise<{ total: number; styles: number; items: DisputedTrack[] }> {
  const [rows, totals] = await Promise.all([
    db.query(`
      WITH tracks_page AS (
        SELECT t.id, t.title, t.artist, COALESCE(al.title, NULLIF(t.album, '')) AS album, NULLIF(t.art_hash, '') AS art_hash,
               lower(COALESCE(t.album_artist, t.artist, '')) AS sort_artist, lower(COALESCE(al.title, t.album, '')) AS sort_album, t.track_number
        FROM tracks t LEFT JOIN albums al ON al.id = t.album_id
        WHERE EXISTS (SELECT 1 FROM track_styles d WHERE d.track_id = t.id AND d.disputed)
        ORDER BY sort_artist, sort_album, t.track_number NULLS LAST, t.title
        LIMIT $1 OFFSET $2
      )
      SELECT p.*, ts.genre, ts.style_id, s.name AS style, ss.scores[s.model_index + 1] AS score,
             COALESCE((SELECT array_agg(DISTINCT tt.tag ORDER BY tt.tag)
                       FROM track_tags tt JOIN tag_map m ON m.tag = tt.tag_key
                       WHERE tt.track_id = ts.track_id AND m.genre = ts.genre AND m.style_id = ts.style_id), '{}') AS from_tags
      FROM tracks_page p
      JOIN track_styles ts ON ts.track_id = p.id AND ts.disputed
      JOIN style s ON s.id = ts.style_id
      LEFT JOIN track_style_scores ss ON ss.track_id = p.id
      ORDER BY p.sort_artist, p.sort_album, p.track_number NULLS LAST, p.title, p.id, s.name`, [limit, offset]),
    db.query('SELECT COUNT(DISTINCT track_id)::int AS tracks, COUNT(*)::int AS styles FROM track_styles WHERE disputed'),
  ]);
  const items: DisputedTrack[] = [];
  for (const r of rows.rows as any[]) {
    let item = items[items.length - 1];
    if (!item || item.trackId !== String(r.id)) {
      item = { trackId: String(r.id), title: String(r.title ?? ''), artist: String(r.artist ?? ''), album: r.album ?? null, artworkId: r.art_hash ?? null, styles: [] };
      items.push(item);
    }
    item.styles.push({
      genre: String(r.genre),
      styleId: Number(r.style_id),
      style: String(r.style),
      score: r.score === null || r.score === undefined ? null : Number(r.score),
      fromTags: r.from_tags as string[],
    });
  }
  return { total: totals.rows[0].tracks, styles: totals.rows[0].styles, items };
}
