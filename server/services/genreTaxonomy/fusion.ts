/**
 * Fusion, phase 2 of docs/Aurora genre and style redesign.md: each track's
 * genres and styles from its file tags, its sound and optional artist tags,
 * written to track_styles (one row per membership, with where it came from),
 * then the album and artist profiles that summarise them.
 *
 * Rules (fusion version 1):
 * - Tagged tracks: every tag mapping with reliability ≥ 0.8 is a membership
 *   (ambiguous and low-reliability mappings wait for the review). A tagged
 *   genre without a tagged style gets up to 3 styles from the track's sound
 *   within that genre (raw score ≥ 0.15), so one genre-only tag never stamps
 *   a style on every track.
 * - Tracks with no such tag (untagged, or only unmapped / ignored /
 *   ambiguous tags): the genre comes from the artist's tags when the install
 *   has them, else from the sound, but only in genres where the sound agrees
 *   with tags on at least 70 % of tagged tracks (measured on this library).
 *   Styles come from the sound within that genre. Neither: Unsorted.
 * - Hand corrections (track_style_overrides) apply last.
 *
 * Simulated tracks (placeholder vectors) never use audio evidence.
 */
import type { Pool, PoolClient } from 'pg';
import { getSystemSetting, setSystemSetting } from '../../database';
import { parseSetting } from './seed';

/** Bump when the rules or thresholds change; a stale version triggers a full run at startup. */
export const FUSION_VERSION = 1;
export const MEMBER_RELIABILITY = 0.8;
/** Artist tags below this weight say little about an artist's genre. */
export const ARTIST_TAG_MIN_WEIGHT = 0.3;
const AUDIO_STYLE_MIN_SCORE = 0.15;
const AUDIO_STYLES_PER_GENRE = 3;
/** Audio-only memberships count at most 0.8 of their raw score (strength = max(tag, 0.8 · audio)). */
const AUDIO_WEIGHT = 0.8;
const AUDIO_GENRE_MIN_AGREEMENT = 0.7;
const AUDIO_AGREEMENT_MIN_TRACKS = 50;
/** An inferred genre (no tag) ranks below tagged members on Browse pages. */
const INFERRED_GENRE_STRENGTH = 0.6;
const STATUS_SETTING = 'genreFusion';
const AGREEMENT_SETTING = 'genreFusionAudioAgreement';

export interface AudioAgreement { genre: string; tracks: number; agreement: number }
export interface FusionStatus {
  version: number;
  ranAt: string;
  durationMs: number;
  tracks: number;
  /** Tracks by where their genre came from; unsorted have none. */
  byGenreSource: { tag: number; artist: number; audio: number; override: number; unsorted: number };
  /** Tracks with at least one style. */
  withStyle: number;
  audioGenres: string[];
}

/**
 * How often the sound's top genre is one of the track's tagged genres, per
 * genre, over tagged, analysed, non-simulated tracks. About 2 s on 30,000
 * tracks; cached for incremental runs.
 */
export async function measureAudioAgreement(db: Pool | PoolClient): Promise<AudioAgreement[]> {
  const rows = (await db.query(`
    WITH top AS (
      SELECT ss.track_id, st.genre
      FROM track_style_scores ss
      JOIN track_features tf ON tf.track_id = ss.track_id AND tf.is_simulated IS NOT TRUE
      CROSS JOIN LATERAL (
        SELECT x.idx FROM unnest(ss.scores) WITH ORDINALITY x(score, idx) ORDER BY x.score DESC LIMIT 1
      ) u
      JOIN style st ON st.model_index = u.idx - 1
    ), tagged AS MATERIALIZED (
      SELECT DISTINCT tt.track_id, m.genre
      FROM track_tags tt JOIN tag_map m ON m.tag = tt.tag_key
      LEFT JOIN tag_ignored i ON i.tag = tt.tag_key
      WHERE m.reliability >= $1 AND i.tag IS NULL
    ), tagged_tracks AS MATERIALIZED (
      SELECT DISTINCT track_id FROM tagged
    )
    SELECT top.genre, COUNT(*)::int AS tracks, AVG((g.track_id IS NOT NULL)::int)::real AS agreement
    FROM top
    JOIN tagged_tracks tt ON tt.track_id = top.track_id
    LEFT JOIN tagged g ON g.track_id = top.track_id AND g.genre = top.genre
    GROUP BY top.genre ORDER BY tracks DESC`, [MEMBER_RELIABILITY])).rows;
  return rows.map((r: any) => ({ genre: r.genre, tracks: r.tracks, agreement: Number(r.agreement) }));
}

/** Genres whose sound is trusted to name the genre of a track without a tag. */
export function trustedAudioGenres(agreement: AudioAgreement[]): AudioAgreement[] {
  return agreement.filter(a => a.tracks >= AUDIO_AGREEMENT_MIN_TRACKS && a.agreement >= AUDIO_GENRE_MIN_AGREEMENT);
}

async function audioAgreementFor(db: Pool | PoolClient, full: boolean): Promise<AudioAgreement[]> {
  if (!full) {
    const cached = parseSetting<{ version: number; genres: AudioAgreement[] }>(await getSystemSetting(AGREEMENT_SETTING));
    if (cached?.version === FUSION_VERSION && Array.isArray(cached.genres)) return cached.genres;
  }
  const measured = await measureAudioAgreement(db);
  await setSystemSetting(AGREEMENT_SETTING, { version: FUSION_VERSION, genres: measured });
  return measured;
}

/** Top audio styles (raw score ≥ 0.15, at most 3) of each (track, genre) pair in `pairs`. */
const AUDIO_STYLES_SQL = (pairs: string) => `
  SELECT p.track_id, s.genre, s.id AS style_id, s.score
  FROM ${pairs} p
  JOIN track_features tf ON tf.track_id = p.track_id AND tf.is_simulated IS NOT TRUE
  JOIN track_style_scores ss ON ss.track_id = p.track_id
  CROSS JOIN LATERAL (
    SELECT st.id, st.genre, ss.scores[st.model_index + 1] AS score
    FROM style st
    WHERE st.genre = p.genre AND st.model_index IS NOT NULL AND ss.scores[st.model_index + 1] >= ${AUDIO_STYLE_MIN_SCORE}
    ORDER BY score DESC, st.id LIMIT ${AUDIO_STYLES_PER_GENRE}
  ) s`;

/**
 * Rebuilds track_styles for `trackIds` (all tracks when omitted), then the
 * profiles of their albums and artists. One transaction, so Browse never
 * sees a half-written state.
 */
export async function runFusion(db: Pool, { trackIds }: { trackIds?: string[] } = {}): Promise<FusionStatus> {
  const started = Date.now();
  const full = !trackIds;
  const trusted = trustedAudioGenres(await audioAgreementFor(db, full));
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE fz_t ON COMMIT DROP AS
      SELECT t.id AS track_id, t.artist_id, t.album_id FROM tracks t
      WHERE $1::text[] IS NULL OR t.id = ANY($1::text[])`, [trackIds ?? null]);
    await client.query('CREATE INDEX ON fz_t (track_id)');
    await client.query('ANALYZE fz_t');

    // Tag memberships: reliable mappings of tags that aren't ignored.
    await client.query(`
      CREATE TEMP TABLE fz_tag ON COMMIT DROP AS
      SELECT tt.track_id, m.genre, m.style_id, MAX(m.reliability)::real AS r
      FROM fz_t JOIN track_tags tt ON tt.track_id = fz_t.track_id
      JOIN tag_map m ON m.tag = tt.tag_key
      WHERE m.reliability >= $1 AND NOT EXISTS (SELECT 1 FROM tag_ignored i WHERE i.tag = tt.tag_key)
      GROUP BY tt.track_id, m.genre, m.style_id`, [MEMBER_RELIABILITY]);

    await client.query(`
      CREATE TEMP TABLE fz_rows (
        track_id TEXT NOT NULL, genre TEXT NOT NULL, style_id INTEGER,
        source TEXT NOT NULL, strength REAL NOT NULL, confidence REAL NOT NULL
      ) ON COMMIT DROP`);
    // Tagged styles, and one genre row per tagged genre (its strongest mapping).
    await client.query(`
      INSERT INTO fz_rows SELECT track_id, genre, style_id, 'tag', r, r FROM fz_tag WHERE style_id IS NOT NULL`);
    await client.query(`
      INSERT INTO fz_rows SELECT track_id, genre, NULL, 'tag', MAX(r), MAX(r) FROM fz_tag GROUP BY track_id, genre`);
    // A tagged genre with no tagged style: styles from the sound within it.
    await client.query(`
      CREATE TEMP TABLE fz_genre_only ON COMMIT DROP AS
      SELECT track_id, genre FROM fz_tag GROUP BY track_id, genre HAVING COUNT(style_id) = 0`);
    await client.query(`
      INSERT INTO fz_rows
      SELECT track_id, genre, style_id, 'audio', LEAST(1, $1 * score), LEAST(1, score)
      FROM (${AUDIO_STYLES_SQL('fz_genre_only')}) a`, [AUDIO_WEIGHT]);

    // No usable tag: the genre from artist tags, else from a trusted sound.
    await client.query(`
      CREATE TEMP TABLE fz_untagged ON COMMIT DROP AS
      SELECT f.track_id, f.artist_id FROM fz_t f
      WHERE NOT EXISTS (SELECT 1 FROM fz_tag g WHERE g.track_id = f.track_id)`);
    await client.query(`
      CREATE TEMP TABLE fz_inferred ON COMMIT DROP AS
      WITH per_provider AS (
        SELECT at.artist_id, at.provider, m.genre, MAX(at.weight) AS w
        FROM artist_tags at JOIN tag_map m ON m.tag = at.tag_key
        WHERE at.artist_id IN (SELECT artist_id FROM fz_untagged WHERE artist_id IS NOT NULL)
          AND at.weight >= $1 AND m.reliability >= $2
        GROUP BY at.artist_id, at.provider, m.genre
      ), per_genre AS (
        SELECT artist_id, genre, SUM(w) AS w FROM per_provider GROUP BY artist_id, genre
      ), artist_genre AS (
        SELECT DISTINCT ON (artist_id) artist_id, genre, LEAST(1, w)::real AS w
        FROM per_genre ORDER BY artist_id, w DESC, genre
      ), trusted AS (
        SELECT * FROM unnest($3::text[], $4::real[]) AS k(genre, agreement)
      ), audio_genre AS (
        SELECT u.track_id, st.genre, trusted.agreement
        FROM fz_untagged u
        JOIN track_features tf ON tf.track_id = u.track_id AND tf.is_simulated IS NOT TRUE
        JOIN track_style_scores ss ON ss.track_id = u.track_id
        CROSS JOIN LATERAL (
          SELECT x.idx FROM unnest(ss.scores) WITH ORDINALITY x(score, idx) ORDER BY x.score DESC LIMIT 1
        ) top
        JOIN style st ON st.model_index = top.idx - 1
        JOIN trusted ON trusted.genre = st.genre
      )
      SELECT u.track_id,
             COALESCE(ag.genre, au.genre) AS genre,
             CASE WHEN ag.genre IS NOT NULL THEN 'artist' ELSE 'audio' END AS source,
             CASE WHEN ag.genre IS NOT NULL THEN ag.w ELSE au.agreement END AS confidence
      FROM fz_untagged u
      LEFT JOIN artist_genre ag ON ag.artist_id = u.artist_id
      LEFT JOIN audio_genre au ON au.track_id = u.track_id
      WHERE COALESCE(ag.genre, au.genre) IS NOT NULL`,
    [ARTIST_TAG_MIN_WEIGHT, MEMBER_RELIABILITY, trusted.map(t => t.genre), trusted.map(t => t.agreement)]);
    await client.query(`
      INSERT INTO fz_rows SELECT track_id, genre, NULL, source, $1, confidence FROM fz_inferred`, [INFERRED_GENRE_STRENGTH]);
    await client.query(`
      INSERT INTO fz_rows
      SELECT track_id, genre, style_id, 'audio', LEAST(1, $1 * score), LEAST(1, score)
      FROM (${AUDIO_STYLES_SQL('fz_inferred')}) a`, [AUDIO_WEIGHT]);

    // Hand corrections last: an excluded genre takes its styles with it; an
    // added style brings its genre.
    await client.query(`
      DELETE FROM fz_rows r USING track_style_overrides o
      WHERE o.track_id = r.track_id AND o.action = 'exclude' AND o.genre = r.genre
        AND (o.style_id IS NULL OR o.style_id = r.style_id)`);
    await client.query(`
      CREATE TEMP TABLE fz_add ON COMMIT DROP AS
      SELECT o.track_id, o.genre, o.style_id FROM track_style_overrides o JOIN fz_t ON fz_t.track_id = o.track_id
      WHERE o.action = 'add'
      UNION
      SELECT o.track_id, o.genre, NULL FROM track_style_overrides o JOIN fz_t ON fz_t.track_id = o.track_id
      WHERE o.action = 'add' AND o.style_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fz_rows r WHERE r.track_id = o.track_id AND r.genre = o.genre AND r.style_id IS NULL)`);
    await client.query(`
      DELETE FROM fz_rows r USING fz_add a
      WHERE a.track_id = r.track_id AND a.genre = r.genre AND r.style_id IS NOT DISTINCT FROM a.style_id`);
    await client.query(`INSERT INTO fz_rows SELECT track_id, genre, style_id, 'override', 1, 1 FROM fz_add`);

    await client.query('DELETE FROM track_styles WHERE track_id IN (SELECT track_id FROM fz_t)');
    await client.query(`
      INSERT INTO track_styles (track_id, genre, style_id, source, strength, confidence, fusion_version)
      SELECT DISTINCT ON (track_id, genre, style_id) track_id, genre, style_id, source, strength, confidence, $1
      FROM fz_rows
      ORDER BY track_id, genre, style_id,
               CASE source WHEN 'override' THEN 0 WHEN 'tag' THEN 1 WHEN 'artist' THEN 2 ELSE 3 END, strength DESC`,
    [FUSION_VERSION]);

    await rebuildProfiles(client, full);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const status = await summarise(db, Date.now() - started, trusted.map(t => t.genre));
  if (full) await setSystemSetting(STATUS_SETTING, status);
  return status;
}

/**
 * Album profiles: per genre and style, the share of the album's tracks that
 * are members and their mean strength. Artist profiles: own tracks only
 * (primary artist, not Various Artists), each album counted once: the mean of
 * the per-album shares; tracks without an album count as one album.
 */
async function rebuildProfiles(client: PoolClient, full: boolean) {
  const albumScope = full ? 'TRUE' : 't.album_id IN (SELECT album_id FROM fz_t WHERE album_id IS NOT NULL)';
  const artistScope = full ? 'TRUE' : 't.artist_id IN (SELECT artist_id FROM fz_t WHERE artist_id IS NOT NULL)';

  await client.query(full ? 'DELETE FROM album_styles'
    : 'DELETE FROM album_styles WHERE album_id IN (SELECT album_id FROM fz_t WHERE album_id IS NOT NULL)');
  await client.query(`
    INSERT INTO album_styles (album_id, genre, style_id, share, strength, tracks, fusion_version)
    WITH sized AS (
      SELECT t.album_id, COUNT(*) AS n FROM tracks t WHERE t.album_id IS NOT NULL AND ${albumScope} GROUP BY t.album_id
    )
    SELECT t.album_id, s.genre, s.style_id, COUNT(*)::real / sized.n, SUM(s.strength)::real / sized.n, COUNT(*), $1
    FROM tracks t JOIN sized ON sized.album_id = t.album_id JOIN track_styles s ON s.track_id = t.id
    GROUP BY t.album_id, s.genre, s.style_id, sized.n`, [FUSION_VERSION]);

  await client.query(full ? 'DELETE FROM artist_styles'
    : 'DELETE FROM artist_styles WHERE artist_id IN (SELECT artist_id FROM fz_t WHERE artist_id IS NOT NULL)');
  await client.query(`
    INSERT INTO artist_styles (artist_id, genre, style_id, share, albums, tracks, fusion_version)
    WITH own AS (
      SELECT t.id, t.artist_id, t.album_id FROM tracks t JOIN artists a ON a.id = t.artist_id
      WHERE COALESCE(a.is_va_pseudo, FALSE) = FALSE AND ${artistScope}
    ), buckets AS (
      SELECT artist_id, album_id, COUNT(*) AS n FROM own GROUP BY artist_id, album_id
    ), bucket_count AS (
      SELECT artist_id, COUNT(*) AS b FROM buckets GROUP BY artist_id
    ), per_album AS (
      SELECT o.artist_id, o.album_id, s.genre, s.style_id, COUNT(*) AS m
      FROM own o JOIN track_styles s ON s.track_id = o.id
      GROUP BY o.artist_id, o.album_id, s.genre, s.style_id
    )
    SELECT p.artist_id, p.genre, p.style_id, (SUM(p.m::real / bk.n) / bc.b)::real, COUNT(*), SUM(p.m), $1
    FROM per_album p
    JOIN buckets bk ON bk.artist_id = p.artist_id AND bk.album_id IS NOT DISTINCT FROM p.album_id
    JOIN bucket_count bc ON bc.artist_id = p.artist_id
    GROUP BY p.artist_id, p.genre, p.style_id, bc.b`, [FUSION_VERSION]);
}

async function summarise(db: Pool, durationMs: number, audioGenres: string[]): Promise<FusionStatus> {
  const row = (await db.query(`
    WITH genre_source AS (
      SELECT track_id, MIN(CASE source WHEN 'tag' THEN 1 WHEN 'override' THEN 2 WHEN 'artist' THEN 3 ELSE 4 END) AS s
      FROM track_styles WHERE style_id IS NULL GROUP BY track_id
    )
    SELECT (SELECT COUNT(*) FROM tracks)::int AS tracks,
           COUNT(*) FILTER (WHERE s = 1)::int AS tag, COUNT(*) FILTER (WHERE s = 2)::int AS override,
           COUNT(*) FILTER (WHERE s = 3)::int AS artist, COUNT(*) FILTER (WHERE s = 4)::int AS audio,
           (SELECT COUNT(DISTINCT track_id) FROM track_styles WHERE style_id IS NOT NULL)::int AS with_style
    FROM genre_source`)).rows[0];
  const inGenre = row.tag + row.override + row.artist + row.audio;
  return {
    version: FUSION_VERSION,
    ranAt: new Date().toISOString(),
    durationMs,
    tracks: row.tracks,
    byGenreSource: { tag: row.tag, artist: row.artist, audio: row.audio, override: row.override, unsorted: row.tracks - inGenre },
    withStyle: row.with_style,
    audioGenres,
  };
}

export async function getFusionStatus(): Promise<FusionStatus | null> {
  return parseSetting<FusionStatus>(await getSystemSetting(STATUS_SETTING));
}

export async function fusionIsCurrent(): Promise<boolean> {
  return (await getFusionStatus())?.version === FUSION_VERSION;
}

export class TrackStyleOverrideError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'TrackStyleOverrideError'; }
}

/**
 * A hand correction on one track ("Aurora rays from {title}"): `remove`
 * takes back a style added by hand, or else excludes it from fusion; `add`
 * lifts an exclusion, or else adds it. The track is fused again at once.
 */
export async function setTrackStyleOverride(db: Pool, opts: {
  trackId: string; genre: string; styleId: number | null; action: 'add' | 'remove'; userId?: string | null;
}): Promise<void> {
  const { trackId, genre, styleId, action } = opts;
  const valid = (await db.query(
    `SELECT EXISTS (SELECT 1 FROM tracks WHERE id = $1) AS track,
            EXISTS (SELECT 1 FROM taxonomy_genre WHERE name = $2) AS genre,
            ($3::int IS NULL OR EXISTS (SELECT 1 FROM style WHERE id = $3 AND genre = $2)) AS style`,
    [trackId, genre, styleId])).rows[0];
  if (!valid.track) throw new TrackStyleOverrideError('Track not found.', 404);
  if (!valid.genre || !valid.style) throw new TrackStyleOverrideError('No such genre or style.');

  const current = (await db.query(
    `SELECT action FROM track_style_overrides WHERE track_id = $1 AND genre = $2 AND style_id IS NOT DISTINCT FROM $3`,
    [trackId, genre, styleId])).rows[0]?.action as 'add' | 'exclude' | undefined;
  const opposite = action === 'add' ? 'exclude' : 'add';
  if (current === opposite) {
    await db.query(`DELETE FROM track_style_overrides WHERE track_id = $1 AND genre = $2 AND style_id IS NOT DISTINCT FROM $3`,
      [trackId, genre, styleId]);
  } else if (!current) {
    await db.query(
      `INSERT INTO track_style_overrides (track_id, genre, style_id, action, user_id) VALUES ($1, $2, $3, $4, $5)`,
      [trackId, genre, styleId, action === 'add' ? 'add' : 'exclude', opts.userId ?? null]);
  }
  await runFusion(db, { trackIds: [trackId] });
}
