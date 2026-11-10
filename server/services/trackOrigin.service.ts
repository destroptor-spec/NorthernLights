/**
 * Where, when and how a track is by its tags, for filters and playlists
 * ("Dansk rap fra 90'erne", "chill med kvindelig vokal"): one row per track
 * in track_origin, each value with where it came from.
 *
 * Country, first found wins:
 *   1. artist  — the primary artist's MusicBrainz country (artists.country,
 *      or its area when that names a country). 82 % of dev tracks.
 *   2. artist-tags — the artist's strongest place tag on Last.fm or
 *      MusicBrainz ("danish", "dansk", "denmark", "danmark", "dansk rap" are
 *      all DK), for artists MusicBrainz doesn't place.
 *   3. release — the file's release country (Picard), except Europe and
 *      Worldwide (XE, XW): where the record came out, the weakest hint.
 * Language: the file's lyrics language (TLAN / LANGUAGE) only; "no lyrics"
 * (zxx) and "unknown" count as none.
 * Year and decade: the file's original year (a 2021 remaster of a 1991 song
 * is 1991), else its year, else the artist's era tag ("80s") as a decade.
 * Vocals and moods: the artist's tags (shared/descriptors.ts), so they
 * describe the artist rather than the one track.
 *
 * Tags that map to a genre never count as anything here. Optional sources
 * only improve this: without MusicBrainz or Last.fm the file tags still give a
 * year, a release country and a language where they're tagged.
 */
import fs from 'fs';
import type { Pool, PoolClient } from 'pg';
import { countryCode, languageCode, placeFromTag } from '../../shared/places';
import { descriptorOf } from '../../shared/descriptors';
import { firstTagValue } from '../utils/tagValues';
import { ORIGIN_READ_VERSION } from '../database';

/** A tag counts from this weight (Last.fm's are relative to the artist's top tag). */
const PLACE_TAG_MIN_WEIGHT = 0.2;
const ERA_TAG_MIN_WEIGHT = 0.2;
const MOOD_TAG_MIN_WEIGHT = 0.1;
/** Last.fm weighs "male vocalists" low (median 0.07 on dev) though it's usually right. */
const VOCALS_TAG_MIN_WEIGHT = 0.05;
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
 * over stored data; tags and language spellings are classified here.
 */
export async function rebuildTrackOrigin(db: Pool | PoolClient, trackIds?: string[]): Promise<number> {
  const [tags, languages] = await Promise.all([
    db.query(`
      SELECT DISTINCT at.tag_key, at.tag FROM artist_tags at
      WHERE NOT EXISTS (SELECT 1 FROM tag_map m WHERE m.tag = at.tag_key)`),
    db.query(`SELECT DISTINCT lyrics_language AS raw FROM tracks WHERE lyrics_language IS NOT NULL`),
  ]);
  // Each unmapped tag once: a place, or a vocals, mood or era descriptor.
  const keys: string[] = [];
  const kinds: string[] = [];
  const values: string[] = [];
  const seen = new Set<string>();
  for (const r of tags.rows as any[]) {
    if (seen.has(r.tag_key)) continue;
    const country = placeFromTag(r.tag) ?? placeFromTag(r.tag_key);
    const descriptor = country ? { kind: 'place', value: country } : descriptorOf(r.tag) ?? descriptorOf(r.tag_key);
    if (!descriptor) continue;
    seen.add(r.tag_key);
    keys.push(r.tag_key); kinds.push(descriptor.kind); values.push(descriptor.value);
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
    WITH tag_class AS (
      SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) AS c(tag_key, kind, value)
    ), artist_class AS (
      SELECT at.artist_id, c.kind, c.value, MAX(at.weight) AS w
      FROM artist_tags at JOIN tag_class c ON c.tag_key = at.tag_key
      WHERE at.weight >= CASE c.kind WHEN 'place' THEN $4::real WHEN 'era' THEN $5::real WHEN 'mood' THEN $6::real ELSE $7::real END
      GROUP BY at.artist_id, c.kind, c.value
    ), artist_place AS (
      SELECT DISTINCT ON (artist_id) artist_id, value AS country FROM artist_class WHERE kind = 'place'
      ORDER BY artist_id, w DESC, value
    ), artist_era AS (
      SELECT DISTINCT ON (artist_id) artist_id, value::int AS decade FROM artist_class WHERE kind = 'era'
      ORDER BY artist_id, w DESC, value
    ), artist_lists AS (
      SELECT artist_id,
             array_agg(value ORDER BY value) FILTER (WHERE kind = 'vocals') AS vocals,
             array_agg(value ORDER BY w DESC, value) FILTER (WHERE kind = 'mood') AS moods
      FROM artist_class GROUP BY artist_id
    ), language_map AS (
      SELECT * FROM unnest($8::text[], $9::text[]) AS l(raw, code)
    ), origin AS (
      SELECT t.id,
             COALESCE(m.country, a.country) AS artist_country,
             ap.country AS tag_country,
             CASE WHEN upper(t.release_country) ~ '^[A-Z]{2}$' AND upper(t.release_country) <> ALL($11::text[])
                  THEN CASE upper(t.release_country) WHEN 'UK' THEN 'GB' ELSE upper(t.release_country) END END AS release_country,
             lm.code AS language,
             CASE WHEN t.original_year BETWEEN 1000 AND 2999 THEN t.original_year END AS original_year,
             CASE WHEN t.year BETWEEN 1000 AND 2999 THEN t.year END AS file_year,
             ae.decade AS era_decade,
             al.vocals, al.moods
      FROM tracks t
      LEFT JOIN artists a ON a.id = t.artist_id
      LEFT JOIN artists m ON m.id = a.merged_into
      LEFT JOIN artist_place ap ON ap.artist_id = COALESCE(m.id, a.id)
      LEFT JOIN artist_era ae ON ae.artist_id = COALESCE(m.id, a.id)
      LEFT JOIN artist_lists al ON al.artist_id = COALESCE(m.id, a.id)
      LEFT JOIN language_map lm ON lm.raw = t.lyrics_language
      WHERE $10::text[] IS NULL OR t.id = ANY($10::text[])
    ), resolved AS (
      SELECT *,
             COALESCE(original_year, file_year) AS year,
             COALESCE((COALESCE(original_year, file_year) / 10) * 10, era_decade) AS decade
      FROM origin
    )
    INSERT INTO track_origin (track_id, country, country_source, language, language_source, year, decade, year_source, vocals, moods)
    SELECT id,
           COALESCE(artist_country, tag_country, release_country),
           CASE WHEN artist_country IS NOT NULL THEN 'artist' WHEN tag_country IS NOT NULL THEN 'artist-tags'
                WHEN release_country IS NOT NULL THEN 'release' END,
           language,
           CASE WHEN language IS NOT NULL THEN 'file' END,
           year,
           decade,
           CASE WHEN original_year IS NOT NULL THEN 'original' WHEN file_year IS NOT NULL THEN 'file'
                WHEN era_decade IS NOT NULL THEN 'artist-tags' END,
           vocals,
           moods
    FROM resolved
    WHERE COALESCE(artist_country, tag_country, release_country, language) IS NOT NULL
       OR decade IS NOT NULL OR vocals IS NOT NULL OR moods IS NOT NULL`,
  [keys, kinds, values, PLACE_TAG_MIN_WEIGHT, ERA_TAG_MIN_WEIGHT, MOOD_TAG_MIN_WEIGHT, VOCALS_TAG_MIN_WEIGHT,
    rawLanguages, languageCodes, trackIds ?? null, NOT_A_COUNTRY]);
  return result.rowCount ?? 0;
}

let fileBackfill: Promise<void> | null = null;
let stopRequested = false;

/**
 * Reads the release country, lyrics language and original year of files
 * scanned before Aurora stored them (origin_read_version older than the
 * scanner's), a batch at a time, then rebuilds track_origin. Local files
 * only; resumes where it stopped. A file that can't be read is stamped too,
 * so it isn't retried every start.
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
        `SELECT id, path FROM tracks WHERE COALESCE(origin_read_version, 0) < $2 ORDER BY id LIMIT $1`,
        [FILE_BATCH, ORIGIN_READ_VERSION])).rows as Array<{ id: string; path: string }>;
      if (!rows.length) break;
      const results: FileOrigin[] = [];
      for (let i = 0; i < rows.length; i += FILE_CONCURRENCY) {
        results.push(...await Promise.all(rows.slice(i, i + FILE_CONCURRENCY).map(readFileOrigin)));
      }
      await db.query(`
        UPDATE tracks t SET release_country = r.country, lyrics_language = r.language, original_year = r.original_year,
               origin_read_at = NOW(), origin_read_version = $5
        FROM unnest($1::text[], $2::text[], $3::text[], $4::int[]) AS r(id, country, language, original_year)
        WHERE t.id = r.id`,
      [results.map(r => r.id), results.map(r => r.country), results.map(r => r.language), results.map(r => r.originalYear), ORIGIN_READ_VERSION]);
      read += rows.length;
      if (read % 5000 < FILE_BATCH) log(`Read release country, language and original year from ${read} files`);
    }
    if (read > 0) log(`Read release country, language and original year from ${read} files in ${Math.round((Date.now() - started) / 1000)} s`);
    const built = await rebuildTrackOrigin(db);
    if (read > 0) log(`Placed ${built} tracks`);
  })().catch(error => console.error('[TrackOrigin] File backfill failed:', error?.message || error))
    .finally(() => { fileBackfill = null; });
  return fileBackfill;
}

export function stopFileOriginBackfill() {
  stopRequested = true;
}

interface FileOrigin { id: string; country: string | null; language: string | null; originalYear: number | null }

async function readFileOrigin(row: { id: string; path: string }): Promise<FileOrigin> {
  const file = Buffer.from(row.path, 'base64').toString('utf8');
  const none = { id: row.id, country: null, language: null, originalYear: null };
  try {
    if (!fs.existsSync(file)) return none;
    // Loaded on first use: music-metadata is ESM-only.
    const mm = await import('music-metadata');
    const metadata = await mm.parseFile(file, { duration: false, skipCovers: true });
    const originalYear = Number(metadata.common.originalyear);
    return {
      id: row.id,
      country: metadata.common.releasecountry || null,
      language: firstTagValue(metadata.common.language) || null,
      originalYear: Number.isInteger(originalYear) && originalYear > 0 ? originalYear : null,
    };
  } catch {
    return none;
  }
}
