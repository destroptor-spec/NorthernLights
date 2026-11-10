/**
 * "Aurora rays from {title}" (docs/Aurora genre and style redesign.md, Three
 * levels): everything Aurora knows about one track, for the view of that name.
 * Reads the stored credits, the fused genres and styles, the analysis, and the
 * album and artist profiles; computes nothing heavy.
 */
import type { Pool } from 'pg';
import type { TrackRays } from '../../shared/api/v1';
import { creditRoleRank } from '../../shared/trackCredits';
import { getAlbumStyleProfile, getArtistStyleProfile } from './browse.service';

const CLOSEST_STYLES = 5;
const OTHER_ALBUMS = 20;

/** Positions in track_features.acoustic_vector_8d (extractor.py). */
const VECTOR = { energy: 0, instrumentalness: 4, acousticness: 5, danceability: 6 } as const;

const parseVector = (value: unknown): number[] | null => {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== 'string') return null;
  try { return (JSON.parse(value) as unknown[]).map(Number); } catch { return null; }
};
const unit = (n: number | undefined) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n as number)) : 0);

/** Everything but the v1 track itself (the route adds it); null for an unknown track. */
export async function getTrackRays(db: Pool, trackId: string): Promise<Omit<TrackRays, 'track'> | null> {
  const head = (await db.query(
    `SELECT id, title, artist, album_id, artist_id, mb_recording_id FROM tracks WHERE id = $1`, [trackId])).rows[0];
  if (!head) return null;

  const [credits, tags, styles, features, scores, others] = await Promise.all([
    db.query(`
      SELECT tac.role, tac.artist_id, a.name, NULLIF(tac.detail, '') AS detail, tac.position
      FROM track_artist_credits tac JOIN artists a ON a.id = tac.artist_id
      WHERE tac.track_id = $1 ORDER BY tac.position`, [trackId]),
    db.query(`SELECT tag FROM track_tags WHERE track_id = $1 ORDER BY position`, [trackId]),
    db.query(`
      SELECT ts.genre, ts.style_id, s.name AS style, ts.source, ts.strength,
             COALESCE((SELECT array_agg(DISTINCT tt.tag ORDER BY tt.tag)
                       FROM track_tags tt JOIN tag_map m ON m.tag = tt.tag_key
                       WHERE tt.track_id = ts.track_id AND m.genre = ts.genre
                         AND (ts.style_id IS NULL OR m.style_id = ts.style_id)), '{}') AS from_tags
      FROM track_styles ts LEFT JOIN style s ON s.id = ts.style_id
      WHERE ts.track_id = $1
      ORDER BY (ts.style_id IS NOT NULL), ts.strength DESC, ts.genre, s.name`, [trackId]),
    db.query(`SELECT acoustic_vector_8d::text AS vector, bpm, is_simulated FROM track_features WHERE track_id = $1`, [trackId]),
    db.query(`
      SELECT st.genre, st.id, st.name, u.score
      FROM track_style_scores ss
      CROSS JOIN LATERAL unnest(ss.scores) WITH ORDINALITY u(score, idx)
      JOIN style st ON st.model_index = u.idx - 1
      WHERE ss.track_id = $1 ORDER BY u.score DESC LIMIT $2`, [trackId, CLOSEST_STYLES]),
    // The same recording on other albums: by MusicBrainz recording id, else
    // the same artist and title (case and surrounding spaces ignored).
    db.query(`
      SELECT t.id, t.album_id, COALESCE(al.title, t.album, 'Unknown Album') AS album_title,
             COALESCE(t.album_artist, t.artist, '') AS artist_name, NULLIF(t.year, 0) AS year
      FROM tracks t LEFT JOIN albums al ON al.id = t.album_id
      WHERE t.id <> $1 AND (
        ($2::text IS NOT NULL AND t.mb_recording_id = $2)
        OR ($2::text IS NULL AND lower(btrim(t.artist)) = lower(btrim($3)) AND lower(btrim(t.title)) = lower(btrim($4)))
      )
      ORDER BY t.year NULLS LAST, album_title LIMIT $5`,
    [trackId, head.mb_recording_id || null, head.artist || '', head.title || '', OTHER_ALBUMS]),
  ]);

  const feature = features.rows[0];
  const vector = feature && !feature.is_simulated ? parseVector(feature.vector) : null;
  const sound: TrackRays['sound'] = vector ? {
    energy: unit(vector[VECTOR.energy]),
    danceability: unit(vector[VECTOR.danceability]),
    acousticness: unit(vector[VECTOR.acousticness]),
    instrumentalness: unit(vector[VECTOR.instrumentalness]),
    bpm: Number(feature.bpm) > 0 ? Math.round(Number(feature.bpm)) : null,
    closestStyles: scores.rows.map((r: any) => ({ genre: r.genre, styleId: Number(r.id), style: r.name, score: Number(r.score) })),
  } : null;

  const albumRow = head.album_id
    ? (await db.query(`SELECT id, title FROM albums WHERE id = $1`, [head.album_id])).rows[0] : null;
  const artistRow = head.artist_id
    ? (await db.query(`SELECT id, name FROM artists WHERE id = $1 AND COALESCE(is_va_pseudo, FALSE) = FALSE`, [head.artist_id])).rows[0] : null;
  const [albumProfile, artistProfile] = await Promise.all([
    albumRow ? getAlbumStyleProfile(db, String(albumRow.id)) : null,
    artistRow ? getArtistStyleProfile(db, String(artistRow.id)) : null,
  ]);

  return {
    credits: credits.rows
      .map((r: any, index: number) => ({ r, index }))
      .sort((a, b) => creditRoleRank(a.r.role) - creditRoleRank(b.r.role) || a.index - b.index)
      .map(({ r }) => ({ role: String(r.role), artistId: String(r.artist_id), name: String(r.name), detail: r.detail ?? null })),
    tags: tags.rows.map((r: any) => String(r.tag)),
    styles: styles.rows.map((r: any) => ({
      genre: r.genre,
      styleId: r.style_id === null ? null : Number(r.style_id),
      style: r.style ?? null,
      source: r.source,
      strength: Math.min(1, Number(r.strength)),
      fromTags: r.source === 'tag' ? (r.from_tags as string[]) : [],
    })),
    sound,
    album: albumRow && albumProfile ? { id: String(albumRow.id), title: String(albumRow.title), entries: albumProfile.entries } : null,
    artist: artistRow && artistProfile
      ? { id: String(artistRow.id), name: String(artistRow.name), entries: artistProfile.entries, listenerTags: artistProfile.listenerTags }
      : null,
    otherAlbums: others.rows.map((r: any) => ({
      trackId: String(r.id),
      albumId: r.album_id ? String(r.album_id) : null,
      albumTitle: String(r.album_title),
      artistName: String(r.artist_name),
      year: r.year === null ? null : Number(r.year),
    })),
  };
}
