/**
 * Where a track is from and what it's sung in, for filters and playlists
 * ("Dansk rap fra 90'erne"): one ISO country and one ISO language per track
 * in track_origin, with where each came from.
 *
 * Country, first found wins:
 *   1. artist  — the primary artist's MusicBrainz country (artists.country,
 *      or its area when that names a country). 82 % of dev tracks.
 *   2. artist-tags — the artist's strongest place tag on Last.fm or
 *      MusicBrainz ("danish", "dansk", "denmark", "danmark" are all DK), for
 *      artists MusicBrainz doesn't place. Tags that map to a genre never count.
 *   3. release — the file's release country (Picard), except Europe and
 *      Worldwide (XE, XW): where the record came out, the weakest hint.
 * Language: the file's lyrics language (TLAN / LANGUAGE) only; "no lyrics"
 * (zxx) and "unknown" count as none.
 *
 * Optional sources only improve this: without MusicBrainz or Last.fm the file
 * tags still give a release country and language where they're tagged.
 */
import fs from 'fs';
import type { Pool, PoolClient } from 'pg';
import { countryCode, languageCode, placeFromTag } from '../../shared/places';
import { firstTagValue } from '../utils/tagValues';

/** A place tag counts from this weight (Last.fm's are relative to the artist's top tag). */
const PLACE_TAG_MIN_WEIGHT = 0.2;
const NOT_A_COUNTRY = ['XE', 'XW', 'XU', 'XG', 'XC', 'XK'];
const FILE_BATCH = 200;
const FILE_CONCURRENCY = 4;

const log = (message: string) => console.log(`[TrackOrigin] ${message}`);

/** Fills artists.country from stored area names ("Denmark", "England") where it's missing. */
export async function backfillArtistCountries(db: Pool | PoolClient): Promise<number> {
  const areas = (await db.query(
    `SELECT DISTINCT area FROM artists WHERE country IS NULL AND area IS NOT NULL`)).rows.map((r: any) => String(r.area));
  const pairs = areas.map(area => [area, countryCode(area)] as const).filter((p): p is readonly [string, string] => !!p[1]);
  if (!pairs.length) return 0;
  const result = await db.query(`
    UPDATE artists a SET country = m.country
    FROM unnest($1::text[], $2::text[]) AS m(area, country)
    WHERE a.area = m.area AND a.country IS NULL`, [pairs.map(p => p[0]), pairs.map(p => p[1])]);
  return result.rowCount ?? 0;
}

/**
 * Rebuilds track_origin for `trackIds` (every track when omitted). Cheap SQL
 * over stored data; place tags and language spellings are normalised here.
 */
export async function rebuildTrackOrigin(db: Pool | PoolClient, trackIds?: string[]): Promise<number> {
  const [tags, languages] = await Promise.all([
    db.query(`
      SELECT DISTINCT at.tag_key, at.tag FROM artist_tags at
      WHERE NOT EXISTS (SELECT 1 FROM tag_map m WHERE m.tag = at.tag_key)`),
    db.query(`SELECT DISTINCT lyrics_language AS raw FROM tracks WHERE lyrics_language IS NOT NULL`),
  ]);
  const placeKeys: string[] = [];
  const placeCountries: string[] = [];
  for (const r of tags.rows as any[]) {
    const country = placeFromTag(r.tag) ?? placeFromTag(r.tag_key);
    if (country && !placeKeys.includes(r.tag_key)) { placeKeys.push(r.tag_key); placeCountries.push(country); }
  }
  const rawLanguages: string[] = [];
  const languageCodes: string[] = [];
  for (const r of languages.rows as any[]) {
    const code = languageCode(String(r.raw).split(/[;,/]/)[0]);
    if (code) { rawLanguages.push(String(r.raw)); languageCodes.push(code); }
  }
  if (trackIds) await db.query('DELETE FROM track_origin WHERE track_id = ANY($1::text[])', [trackIds]);
  else await db.query('DELETE FROM track_origin');
  const result = await db.query(`
    WITH place_tag AS (
      SELECT * FROM unnest($1::text[], $2::text[]) AS p(tag_key, country)
    ), artist_place AS (
      SELECT DISTINCT ON (at.artist_id) at.artist_id, p.country
      FROM artist_tags at JOIN place_tag p ON p.tag_key = at.tag_key
      WHERE at.weight >= $3
      ORDER BY at.artist_id, at.weight DESC, p.country
    ), language_map AS (
      SELECT * FROM unnest($4::text[], $5::text[]) AS l(raw, code)
    ), origin AS (
      SELECT t.id,
             COALESCE(m.country, a.country) AS artist_country,
             ap.country AS tag_country,
             CASE WHEN upper(t.release_country) ~ '^[A-Z]{2}$' AND upper(t.release_country) <> ALL($7::text[])
                  THEN CASE upper(t.release_country) WHEN 'UK' THEN 'GB' ELSE upper(t.release_country) END END AS release_country,
             lm.code AS language
      FROM tracks t
      LEFT JOIN artists a ON a.id = t.artist_id
      LEFT JOIN artists m ON m.id = a.merged_into
      LEFT JOIN artist_place ap ON ap.artist_id = COALESCE(m.id, a.id)
      LEFT JOIN language_map lm ON lm.raw = t.lyrics_language
      WHERE $6::text[] IS NULL OR t.id = ANY($6::text[])
    )
    INSERT INTO track_origin (track_id, country, country_source, language, language_source)
    SELECT id,
           COALESCE(artist_country, tag_country, release_country),
           CASE WHEN artist_country IS NOT NULL THEN 'artist' WHEN tag_country IS NOT NULL THEN 'artist-tags'
                WHEN release_country IS NOT NULL THEN 'release' END,
           language,
           CASE WHEN language IS NOT NULL THEN 'file' END
    FROM origin
    WHERE COALESCE(artist_country, tag_country, release_country, language) IS NOT NULL`,
  [placeKeys, placeCountries, PLACE_TAG_MIN_WEIGHT, rawLanguages, languageCodes, trackIds ?? null, NOT_A_COUNTRY]);
  return result.rowCount ?? 0;
}

let fileBackfill: Promise<void> | null = null;
let stopRequested = false;

/**
 * Reads the release country and lyrics language of files scanned before
 * Aurora stored them (origin_read_at is null), a batch at a time, then
 * rebuilds track_origin. Local files only; resumes where it stopped. A file
 * that can't be read is stamped too, so it isn't retried every start.
 */
export function startFileOriginBackfill(getDb: () => Promise<Pool>): Promise<void> {
  if (fileBackfill) return fileBackfill;
  stopRequested = false;
  fileBackfill = (async () => {
    const db = await getDb();
    let read = 0;
    const started = Date.now();
    for (;;) {
      if (stopRequested) return;
      const rows = (await db.query(
        `SELECT id, path FROM tracks WHERE origin_read_at IS NULL ORDER BY id LIMIT $1`, [FILE_BATCH])).rows as Array<{ id: string; path: string }>;
      if (!rows.length) break;
      const results: Array<{ id: string; country: string | null; language: string | null }> = [];
      for (let i = 0; i < rows.length; i += FILE_CONCURRENCY) {
        results.push(...await Promise.all(rows.slice(i, i + FILE_CONCURRENCY).map(readFileOrigin)));
      }
      await db.query(`
        UPDATE tracks t SET release_country = r.country, lyrics_language = r.language, origin_read_at = NOW()
        FROM unnest($1::text[], $2::text[], $3::text[]) AS r(id, country, language)
        WHERE t.id = r.id`,
      [results.map(r => r.id), results.map(r => r.country), results.map(r => r.language)]);
      read += rows.length;
      if (read % 5000 < FILE_BATCH) log(`Read release country and language from ${read} files`);
    }
    if (read > 0) log(`Read release country and language from ${read} files in ${Math.round((Date.now() - started) / 1000)} s`);
    const built = await rebuildTrackOrigin(db);
    if (read > 0) log(`Placed ${built} tracks`);
  })().catch(error => console.error('[TrackOrigin] File backfill failed:', error?.message || error))
    .finally(() => { fileBackfill = null; });
  return fileBackfill;
}

export function stopFileOriginBackfill() {
  stopRequested = true;
}

async function readFileOrigin(row: { id: string; path: string }) {
  const file = Buffer.from(row.path, 'base64').toString('utf8');
  try {
    if (!fs.existsSync(file)) return { id: row.id, country: null, language: null };
    // Loaded on first use: music-metadata is ESM-only.
    const mm = await import('music-metadata');
    const metadata = await mm.parseFile(file, { duration: false, skipCovers: true });
    return {
      id: row.id,
      country: metadata.common.releasecountry || null,
      language: firstTagValue(metadata.common.language) || null,
    };
  } catch {
    return { id: row.id, country: null, language: null };
  }
}
