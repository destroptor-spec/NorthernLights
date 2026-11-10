/**
 * "Aurora rays from {title}" (docs/Aurora genre and style redesign.md, Three
 * levels): everything Aurora knows about one track, for the view of that name.
 * Reads the stored credits, the fused genres and styles, the analysis, and the
 * album and artist profiles; computes nothing heavy.
 */
import type { Pool } from 'pg';
import type { TrackRays } from '../../shared/api/v1';
import { creditRoleRank } from '../../shared/trackCredits';
import { splitArtistNames, splitAtFeaturing } from '../../shared/artistCredit';
import { getAlbumStyleProfile, getArtistStyleProfile } from './browse.service';
import { nearTrack } from './genreTaxonomy/centroids';

const CLOSEST_STYLES = 12;
const OTHER_ALBUMS = 20;
/** In context: at most this many artists besides the track's own. */
const OTHER_ARTISTS = 10;

/** Positions in track_features.acoustic_vector_8d (extractor.py). */
const VECTOR = { energy: 0, brightness: 1, percussiveness: 2, instrumentalness: 4, acousticness: 5, danceability: 6 } as const;

const parseVector = (value: unknown): number[] | null => {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value !== 'string') return null;
  try { return (JSON.parse(value) as unknown[]).map(Number); } catch { return null; }
};
const unit = (n: number | undefined) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n as number)) : 0);

/** The rays as the service builds them: the route adds the v1 track and turns nearby track ids into v1 tracks. */
export type TrackRaysRows = Omit<TrackRays, 'track' | 'soundsCloseTo'> & {
  soundsCloseTo: { styles: NonNullable<TrackRays['soundsCloseTo']>['styles']; trackIds: string[] } | null;
};

/** Everything but the v1 track itself (the route adds it); null for an unknown track. */
export async function getTrackRays(db: Pool, trackId: string): Promise<TrackRaysRows | null> {
  const head = (await db.query(
    `SELECT id, title, artist, artists, album_id, artist_id, mb_recording_id FROM tracks WHERE id = $1`, [trackId])).rows[0];
  if (!head) return null;
  const billed = await billedArtists(db, head);

  const [credits, tags, styles, features, scores, others, mix] = await Promise.all([
    db.query(`
      SELECT tac.role, tac.artist_id, a.name, NULLIF(tac.detail, '') AS detail, tac.position, a.image_url
      FROM track_artist_credits tac JOIN artists a ON a.id = tac.artist_id
      WHERE tac.track_id = $1 ORDER BY tac.position`, [trackId]),
    db.query(`SELECT tag FROM track_tags WHERE track_id = $1 ORDER BY position`, [trackId]),
    db.query(`
      SELECT ts.genre, ts.style_id, s.name AS style, ts.source, ts.strength, ts.disputed,
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
             COALESCE(t.album_artist, t.artist, '') AS artist_name, NULLIF(t.year, 0) AS year,
             NULLIF(t.art_hash, '') AS art_hash
      FROM tracks t LEFT JOIN albums al ON al.id = t.album_id
      WHERE t.id <> $1 AND (
        ($2::text IS NOT NULL AND t.mb_recording_id = $2)
        OR ($2::text IS NULL AND lower(btrim(t.artist)) = lower(btrim($3)) AND lower(btrim(t.title)) = lower(btrim($4)))
      )
      ORDER BY t.year NULLS LAST, album_title LIMIT $5`,
    [trackId, head.mb_recording_id || null, head.artist || '', head.title || '', OTHER_ALBUMS]),
    // Where the model's scores fall: each genre's share of the summed scores.
    db.query(`
      SELECT st.genre, SUM(u.score) / NULLIF(SUM(SUM(u.score)) OVER (), 0) AS share
      FROM track_style_scores ss
      CROSS JOIN LATERAL unnest(ss.scores) WITH ORDINALITY u(score, idx)
      JOIN style st ON st.model_index = u.idx - 1
      WHERE ss.track_id = $1 GROUP BY st.genre ORDER BY share DESC`, [trackId]),
  ]);

  const feature = features.rows[0];
  const vector = feature && !feature.is_simulated ? parseVector(feature.vector) : null;
  const sound: TrackRays['sound'] = vector ? {
    energy: unit(vector[VECTOR.energy]),
    danceability: unit(vector[VECTOR.danceability]),
    acousticness: unit(vector[VECTOR.acousticness]),
    instrumentalness: unit(vector[VECTOR.instrumentalness]),
    brightness: unit(vector[VECTOR.brightness]),
    percussiveness: unit(vector[VECTOR.percussiveness]),
    bpm: Number(feature.bpm) > 0 ? Math.round(Number(feature.bpm)) : null,
    closestStyles: scores.rows.map((r: any) => ({ genre: r.genre, styleId: Number(r.id), style: r.name, score: Number(r.score) })),
    genreMix: mix.rows.filter((r: any) => r.share !== null).map((r: any) => ({ genre: r.genre, share: unit(Number(r.share)) })),
  } : null;

  const albumRow = head.album_id
    ? (await db.query(`
        SELECT al.id, al.title,
               (SELECT t.art_hash FROM tracks t WHERE t.album_id = al.id AND COALESCE(t.art_hash, '') <> ''
                ORDER BY t.track_number NULLS LAST LIMIT 1) AS art_hash
        FROM albums al WHERE al.id = $1`, [head.album_id])).rows[0] : null;
  const artistRow = head.artist_id
    ? (await db.query(`
        SELECT id, name, image_url, artwork_url, mbid FROM artists
        WHERE id = $1 AND COALESCE(is_va_pseudo, FALSE) = FALSE`, [head.artist_id])).rows[0] : null;
  const [albumProfile, artistProfile, otherArtists, soundsCloseTo] = await Promise.all([
    albumRow ? getAlbumStyleProfile(db, String(albumRow.id)) : null,
    artistRow ? getArtistStyleProfile(db, String(artistRow.id)) : null,
    contextArtists(db, [
      ...billed,
      ...credits.rows.filter((r: any) => r.role === 'remixer').map((r: any) => ({ role: 'remixer', artistId: String(r.artist_id) })),
    ], artistRow ? String(artistRow.id) : null),
    // Needs only the audio embedding (nearTrack checks), not the sound vector.
    nearTrack(db, trackId),
  ]);

  return {
    credits: [
      ...billed,
      ...credits.rows
        .map((r: any, index: number) => ({ r, index }))
        .sort((a, b) => creditRoleRank(a.r.role) - creditRoleRank(b.r.role) || a.index - b.index)
        .map(({ r }) => ({
          role: String(r.role), artistId: String(r.artist_id), name: String(r.name), detail: r.detail ?? null, imageUrl: r.image_url ?? null,
        })),
    ],
    tags: tags.rows.map((r: any) => String(r.tag)),
    styles: styles.rows.map((r: any) => ({
      genre: r.genre,
      styleId: r.style_id === null ? null : Number(r.style_id),
      style: r.style ?? null,
      source: r.source,
      strength: Math.min(1, Number(r.strength)),
      fromTags: r.source === 'tag' ? (r.from_tags as string[]) : [],
      disputed: r.disputed === true,
    })),
    sound,
    album: albumRow && albumProfile ? {
      id: String(albumRow.id), title: String(albumRow.title), artworkId: albumRow.art_hash ?? null, entries: albumProfile.entries,
    } : null,
    artist: artistRow && artistProfile ? {
      id: String(artistRow.id), name: String(artistRow.name),
      imageUrl: artistRow.image_url ?? null, artworkUrl: artistRow.artwork_url ?? null, musicBrainzId: artistRow.mbid ?? null,
      entries: artistProfile.entries, listenerTags: artistProfile.listenerTags,
    } : null,
    otherArtists,
    soundsCloseTo,
    otherAlbums: others.rows.map((r: any) => ({
      trackId: String(r.id),
      albumId: r.album_id ? String(r.album_id) : null,
      albumTitle: String(r.album_title),
      artistName: String(r.artist_name),
      year: r.year === null ? null : Number(r.year),
      artworkId: r.art_hash ?? null,
    })),
  };
}

/**
 * In context beyond the track's own artist: the other billed artists, the
 * featured artists and the remixers, in that order, each once (a person with
 * two of those roles keeps the first), only those in the library (a name
 * without an artist has no page and no profile). Stored images only: no
 * provider lookups per person.
 */
async function contextArtists(
  db: Pool, people: Array<{ role: string; artistId: string | null }>, ownArtistId: string | null,
): Promise<TrackRays['otherArtists']> {
  const picked = new Map<string, 'artist' | 'featured' | 'remixer'>();
  for (const p of people) {
    if (!p.artistId || p.artistId === ownArtistId || picked.has(p.artistId)) continue;
    if (p.role === 'artist' || p.role === 'featured' || p.role === 'remixer') picked.set(p.artistId, p.role);
  }
  const ids = [...picked.keys()].slice(0, OTHER_ARTISTS);
  if (!ids.length) return [];
  const rows = (await db.query(`
    SELECT id, name, image_url, artwork_url, mbid FROM artists
    WHERE id = ANY($1::uuid[]) AND COALESCE(is_va_pseudo, FALSE) = FALSE`, [ids])).rows;
  const byId = new Map(rows.map((r: any) => [String(r.id), r]));
  const present = ids.filter(id => byId.has(id));
  const profiles = await Promise.all(present.map(id => getArtistStyleProfile(db, id)));
  return present.map((id, i) => {
    const r: any = byId.get(id);
    return {
      role: picked.get(id)!,
      id, name: String(r.name),
      imageUrl: r.image_url ?? null, artworkUrl: r.artwork_url ?? null, musicBrainzId: r.mbid ?? null,
      entries: profiles[i].entries, listenerTags: profiles[i].listenerTags,
    };
  });
}

/**
 * The track's billed artists, as credits: "Calvin Harris feat. Example" is
 * Calvin Harris (artist) and Example (featured). Names come from the stored
 * artist list (the file's artists tags), split like everywhere else when the
 * list is missing; each is matched to the library's artist of that name
 * (following merges), or left unlinked.
 */
async function billedArtists(db: Pool, head: { artist: string | null; artists: unknown }): Promise<TrackRays['credits']> {
  const stored = Array.isArray(head.artists) ? head.artists
    : typeof head.artists === 'string' ? (() => { try { return JSON.parse(head.artists as string); } catch { return null; } })() : null;
  const names: string[] = (Array.isArray(stored) && stored.length ? stored : splitArtistNames(head.artist))
    .map((n: unknown) => String(n).trim()).filter(Boolean);
  if (!names.length) return [];
  const featured = new Set((splitAtFeaturing(head.artist)?.slice(1) || []).map(n => n.toLowerCase()));
  const rows = (await db.query(`
    SELECT DISTINCT ON (lower(a.name)) lower(a.name) AS key, COALESCE(m.id, a.id) AS id, COALESCE(m.name, a.name) AS name,
           COALESCE(m.image_url, a.image_url) AS image_url
    FROM artists a LEFT JOIN artists m ON m.id = a.merged_into
    WHERE lower(a.name) = ANY($1::text[])
    ORDER BY lower(a.name), (a.merged_into IS NULL) DESC`, [names.map(n => n.toLowerCase())])).rows;
  const byName = new Map(rows.map((r: any) => [String(r.key), r]));
  return names.map((name, index) => {
    const row: any = byName.get(name.toLowerCase());
    return {
      role: index > 0 && featured.has(name.toLowerCase()) ? 'featured' : 'artist',
      artistId: row ? String(row.id) : null,
      name: row ? String(row.name) : name,
      detail: null,
      imageUrl: row?.image_url ?? null,
    };
  });
}
