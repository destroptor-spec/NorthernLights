/**
 * Builds a test library in its own database from the dev library, for the
 * phase 5 scale test (docs/Aurora genre and style redesign.md, AI playlists
 * → Evaluation): a small one carved from whole albums, or a big one with the
 * library copied several times. The source database is only read.
 *
 *   npx tsx scripts/library-scale/make-library.ts <userId> --target=aurora_small --tracks=500
 *   npx tsx scripts/library-scale/make-library.ts <userId> --target=aurora_big --copies=3
 *
 * Copies the base data (artists, albums, tracks, analysis, style scores,
 * moods, origins, artist tags, the user with their plays and settings, the
 * LLM settings), then runs Aurora's own genre pipeline on it (seed, tag
 * mapping, fusion, profiles, centroids, track genres), so everything derived
 * is computed for that library. Copies get new ids and paths and " [k]" on
 * their titles, so they count as other songs. Provider keys are not copied:
 * nothing calls Genius, Last.fm or MusicBrainz.
 */
import { Pool } from 'pg';
import { config } from 'dotenv';

config({ quiet: true });
const userId = process.argv[2];
const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const target = arg('target') ?? '';
const smallTracks = Number(arg('tracks') ?? 0);
const copies = Number(arg('copies') ?? 0);
if (!userId || !/^aurora_(small|big|test)\w*$/.test(target) || (!smallTracks && !copies)) {
  throw new Error('usage: make-library.ts <userId> --target=aurora_small|aurora_big… (--tracks=500 | --copies=3)');
}
const sourceName = process.env.DB_NAME || 'musicdb';
if (target === sourceName) throw new Error('target must not be the source database');

const connection = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
};
/** Only these system settings: the AI and the Hub. No provider keys. */
const SETTINGS = ['llmApiKey', 'llmBaseUrl', 'llmModelName', 'hubGenerationSchedule', 'systemPlaylistConfig'];
const BATCH = 400;

const log = (message: string) => console.log(`[make-library] ${message}`);

(async () => {
  const started = Date.now();
  const admin = new Pool({ ...connection, database: 'postgres' });
  await admin.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${target}`);
  await admin.end();
  log(`created ${target}`);

  const source = new Pool({ ...connection, database: sourceName });
  // The app's database module connects to DB_NAME on first use.
  process.env.DB_NAME = target;
  const { initDB } = await import('../../server/database');
  const db = await initDB();
  log('schema ready');

  const columnsOf = new Map<string, string[]>();
  const targetColumns = async (table: string) => {
    if (!columnsOf.has(table)) {
      const res = await db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' AND is_identity = 'NO'`, [table]);
      columnsOf.set(table, (res.rows as any[]).map(r => r.column_name));
    }
    return columnsOf.get(table)!;
  };
  /** Copies the rows a query returns (one jsonb `row` each) into `table`. */
  const copy = async (table: string, sql: string, params: unknown[] = []) => {
    const columns = await targetColumns(table);
    const list = columns.map(c => `"${c}"`).join(', ');
    const res = await source.query(sql, params);
    for (let i = 0; i < res.rows.length; i += BATCH) {
      const rows = res.rows.slice(i, i + BATCH).map((r: any) => r.row);
      await db.query(
        `INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb) ON CONFLICT DO NOTHING`,
        [JSON.stringify(rows)]);
    }
    return res.rowCount ?? 0;
  };

  // Which tracks: whole albums at random (analysed tracks), or all.
  let trackIds: string[];
  if (smallTracks) {
    const res = await source.query(`
      WITH albums AS (
        SELECT t.album_id, COUNT(*) AS n, random() AS r FROM tracks t
        JOIN track_features tf ON tf.track_id = t.id AND NOT tf.is_simulated
        WHERE t.album_id IS NOT NULL GROUP BY t.album_id
      ), picked AS (
        SELECT album_id, n, SUM(n) OVER (ORDER BY r ROWS UNBOUNDED PRECEDING) AS running FROM albums
      )
      -- Albums until the analysed tracks reach the size asked for (the last one whole).
      SELECT t.id FROM tracks t WHERE t.album_id IN (SELECT album_id FROM picked WHERE running - n < $1)`, [smallTracks]);
    trackIds = (res.rows as any[]).map(r => r.id);
  } else {
    trackIds = ((await source.query('SELECT id FROM tracks')).rows as any[]).map(r => r.id);
  }
  log(`${trackIds.length} source tracks`);
  // Numbered, so per-track tables copy in chunks (embeddings are large).
  await source.query('CREATE TEMP TABLE chosen (id text PRIMARY KEY, n int NOT NULL)');
  await source.query('INSERT INTO chosen SELECT id, n::int FROM unnest($1::text[]) WITH ORDINALITY AS u(id, n)', [trackIds]);
  const CHUNK = 2000;
  /** `copy` for a query over `chosen c`, chunk by chunk ($1, $2 = the chunk's range). */
  const copyChunked = async (table: string, sql: string, params: unknown[] = []) => {
    let total = 0;
    for (let from = 0; from < trackIds.length; from += CHUNK) total += await copy(table, sql, [from, from + CHUNK, ...params]);
    return total;
  };

  // The user, their settings, the AI settings.
  await copy('users', `SELECT to_jsonb(u) AS row FROM users u WHERE u.id = $1`, [userId]);
  await copy('user_settings', `SELECT to_jsonb(s) AS row FROM user_settings s WHERE s.user_id = $1`, [userId]);
  await copy('system_settings', `SELECT to_jsonb(s) AS row FROM system_settings s WHERE s.key = ANY($1::text[])`, [SETTINGS]);

  // Artists and albums of the chosen tracks (merge targets first).
  await copy('artists', `SELECT to_jsonb(a) - 'merged_into' AS row FROM artists a
    WHERE a.id IN (SELECT t.artist_id FROM tracks t JOIN chosen c ON c.id = t.id)`);
  await copy('albums', `SELECT to_jsonb(al) AS row FROM albums al
    WHERE al.id IN (SELECT t.album_id FROM tracks t JOIN chosen c ON c.id = t.id)`);
  await copy('artist_tags', `SELECT to_jsonb(x) AS row FROM artist_tags x
    WHERE x.artist_id IN (SELECT t.artist_id FROM tracks t JOIN chosen c ON c.id = t.id)`);

  // Tracks and what hangs off them, once per copy.
  const rounds = Math.max(1, copies);
  for (let k = 0; k < rounds; k++) {
    const roundStarted = Date.now();
    const suffix = k === 0 ? null : `~${k}`;
    const id = (column: string) => (suffix ? `${column} || '${suffix}'` : column);
    const track = suffix
      ? `to_jsonb(t) - 'genre_id' || jsonb_build_object('id', t.id || '${suffix}', 'path', t.path || '${suffix}',
           'title', t.title || ' [${k}]', 'mb_recording_id', NULLIF(t.mb_recording_id, '') || '${suffix}')`
      : `to_jsonb(t) - 'genre_id'`;
    const n = await copyChunked('tracks', `SELECT ${track} AS row FROM tracks t JOIN chosen c ON c.id = t.id WHERE c.n > $1 AND c.n <= $2`);
    for (const table of ['track_features', 'track_style_scores', 'track_moods', 'track_origin']) {
      await copyChunked(table, `SELECT to_jsonb(x) || jsonb_build_object('track_id', ${id('x.track_id')}) AS row
        FROM ${table} x JOIN chosen c ON c.id = x.track_id WHERE c.n > $1 AND c.n <= $2`);
    }
    for (const table of ['user_playback_stats', 'user_track_play_buckets']) {
      await copyChunked(table, `SELECT to_jsonb(x) || jsonb_build_object('track_id', ${id('x.track_id')}) AS row
        FROM ${table} x JOIN chosen c ON c.id = x.track_id WHERE c.n > $1 AND c.n <= $2 AND x.user_id = $3`, [userId]);
    }
    log(`copy ${k + 1}/${rounds}: ${n} tracks with analysis, moods, origins and plays (${Math.round((Date.now() - roundStarted) / 1000)} s)`);
  }
  await source.end();

  // Aurora's own genre pipeline on this library.
  const pipelineStarted = Date.now();
  const { initializeGenreTaxonomy } = await import('../../server/services/genreTaxonomy');
  await initializeGenreTaxonomy();
  log(`genre pipeline ${Math.round((Date.now() - pipelineStarted) / 1000)} s`);
  const counts = (await db.query(`SELECT
      (SELECT COUNT(*) FROM tracks) AS tracks,
      (SELECT COUNT(*) FROM track_features WHERE NOT is_simulated) AS analysed,
      (SELECT COUNT(DISTINCT track_id) FROM track_styles) AS fused,
      (SELECT COUNT(*) FROM style_centroids) AS centroids,
      (SELECT COUNT(*) FROM artists) AS artists`)).rows[0];
  log(`done in ${Math.round((Date.now() - started) / 1000)} s: ${JSON.stringify(counts)}`);
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
