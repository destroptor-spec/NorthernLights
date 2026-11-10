/**
 * Style centroids, phase 3 of docs/Aurora genre and style redesign.md: the
 * mean EffNet embedding of each style's reference tracks, for "Sounds close
 * to" (nearby styles and tracks) and, later, disputed tags.
 *
 * References are the memberships a person vouched for: file tags and hand
 * corrections, never memberships inferred from the sound, so a centroid can't
 * pull inferred tracks towards itself and grow on them. Simulated tracks
 * (placeholder vectors) never count. A style needs at least 8 reference
 * tracks by 3 artists; with fewer, one album would be the style.
 */
import type { Pool, PoolClient } from 'pg';
import type { BrowseStyleRef } from '../../../shared/api/v1';

export const CENTROID_MIN_TRACKS = 8;
export const CENTROID_MIN_ARTISTS = 3;
/** Nearby styles a style page or a track shows. */
export const NEAR_STYLES = 6;
/** Nearby tracks for a track, after one version per song and two per artist. */
export const NEAR_TRACKS = 12;
const NEAR_TRACKS_PER_ARTIST = 2;
/** Nearest neighbours fetched before the album, version and artist filters. */
const NEAR_TRACK_CANDIDATES = 80;

const REFERENCES = `
  SELECT ts.style_id, ts.track_id, t.artist_id, tf.embedding_vector
  FROM track_styles ts
  JOIN tracks t ON t.id = ts.track_id
  JOIN track_features tf ON tf.track_id = ts.track_id
  WHERE ts.style_id IS NOT NULL AND ts.source IN ('tag', 'override')
    AND NOT tf.is_simulated AND tf.embedding_vector IS NOT NULL`;

/**
 * Rebuilds every centroid from the current fused memberships, with each
 * style's 90th-percentile member distance (cosine) for the disputed-tag check.
 * About 0.2 s on 30,000 tracks; runs in fusion's transaction.
 */
export async function rebuildCentroids(client: PoolClient | Pool, fusionVersion: number): Promise<number> {
  await client.query('DELETE FROM style_centroids');
  const inserted = await client.query(`
    INSERT INTO style_centroids (style_id, genre, centroid, tracks, artists, fusion_version)
    SELECT r.style_id, s.genre, AVG(r.embedding_vector), COUNT(*), COUNT(DISTINCT r.artist_id), $3
    FROM (${REFERENCES}) r JOIN style s ON s.id = r.style_id
    GROUP BY r.style_id, s.genre
    HAVING COUNT(*) >= $1 AND COUNT(DISTINCT r.artist_id) >= $2`,
  [CENTROID_MIN_TRACKS, CENTROID_MIN_ARTISTS, fusionVersion]);
  await client.query(`
    UPDATE style_centroids c SET p90_distance = d.p90
    FROM (
      SELECT r.style_id, percentile_cont(0.9) WITHIN GROUP (ORDER BY r.embedding_vector <=> c.centroid)::real AS p90
      FROM (${REFERENCES}) r JOIN style_centroids c ON c.style_id = r.style_id
      GROUP BY r.style_id
    ) d WHERE d.style_id = c.style_id`);
  return inserted.rowCount ?? 0;
}

const nearStyleRef = (r: any): BrowseStyleRef => ({
  id: Number(r.style_id), genre: String(r.genre), name: String(r.name), trackCount: Number(r.tracks),
});

/** The styles whose centroids sit nearest this style's, from any genre; empty without a centroid. */
export async function stylesNearStyle(db: Pool, styleId: number, limit = NEAR_STYLES): Promise<BrowseStyleRef[]> {
  return (await db.query(`
    SELECT c.style_id, s.genre, s.name,
           (SELECT COUNT(*) FROM track_styles ts WHERE ts.style_id = c.style_id)::int AS tracks
    FROM style_centroids me
    JOIN style_centroids c ON c.style_id <> me.style_id
    JOIN style s ON s.id = c.style_id
    WHERE me.style_id = $1
    ORDER BY c.centroid <=> me.centroid
    LIMIT $2`, [styleId, limit])).rows.map(nearStyleRef);
}

/**
 * What a track sounds close to: the styles whose centroids sit nearest its
 * embedding (its own styles left out), and its nearest tracks: none from its
 * own album or recording, one version of each song (titles compared without
 * their brackets), at most two per artist. Null for a track without a real
 * embedding.
 */
export async function nearTrack(db: Pool, trackId: string): Promise<{ styles: BrowseStyleRef[]; trackIds: string[] } | null> {
  const me = (await db.query(`
    SELECT t.album_id, t.mb_recording_id, t.artist, t.title, tf.embedding_vector::text AS v
    FROM tracks t JOIN track_features tf ON tf.track_id = t.id
    WHERE t.id = $1 AND NOT tf.is_simulated AND tf.embedding_vector IS NOT NULL`, [trackId])).rows[0];
  if (!me) return null;
  const [styles, tracks] = await Promise.all([
    db.query(`
      SELECT c.style_id, s.genre, s.name,
             (SELECT COUNT(*) FROM track_styles ts WHERE ts.style_id = c.style_id)::int AS tracks
      FROM style_centroids c JOIN style s ON s.id = c.style_id
      WHERE NOT EXISTS (SELECT 1 FROM track_styles own WHERE own.track_id = $1 AND own.style_id = c.style_id)
      ORDER BY c.centroid <=> $2::vector
      LIMIT $3`, [trackId, me.v, NEAR_STYLES]),
    db.query(`
      WITH near AS (
        SELECT tf.track_id, tf.embedding_vector <=> $2::vector AS d
        FROM track_features tf
        WHERE tf.track_id <> $1 AND NOT tf.is_simulated AND tf.embedding_vector IS NOT NULL
        ORDER BY tf.embedding_vector <=> $2::vector
        LIMIT $3
      )
      SELECT t.id, t.artist_id, lower(btrim(COALESCE(t.artist, ''))) AS artist,
             lower(btrim(regexp_replace(COALESCE(t.title, ''), '\\s*[\\(\\[].*$', ''))) AS song
      FROM near JOIN tracks t ON t.id = near.track_id
      WHERE ($4::uuid IS NULL OR t.album_id IS DISTINCT FROM $4::uuid)
        AND ($5::text IS NULL OR t.mb_recording_id IS DISTINCT FROM $5)
      ORDER BY near.d`, [trackId, me.v, NEAR_TRACK_CANDIDATES, me.album_id, me.mb_recording_id || null]),
  ]);
  const ownSong = `${String(me.artist || '').trim().toLowerCase()}|${songKey(me.title)}`;
  const songs = new Set([ownSong]);
  const perArtist = new Map<string, number>();
  const trackIds: string[] = [];
  for (const r of tracks.rows) {
    const song = `${r.artist}|${r.song}`;
    const artist = String(r.artist_id ?? r.artist);
    if (songs.has(song) || (perArtist.get(artist) || 0) >= NEAR_TRACKS_PER_ARTIST) continue;
    songs.add(song);
    perArtist.set(artist, (perArtist.get(artist) || 0) + 1);
    trackIds.push(String(r.id));
    if (trackIds.length >= NEAR_TRACKS) break;
  }
  return { styles: styles.rows.map(nearStyleRef), trackIds };
}

const songKey = (title: unknown) => String(title || '').replace(/\s*[([].*$/, '').trim().toLowerCase();
