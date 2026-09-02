/**
 * @jest-environment node
 *
 * Every SQL statement in this repo is only exercised at runtime. On 2026-09-02
 * that let a parse-time type error reach production and take the library down:
 *
 *     /api/v1/albums 500 — operator does not exist: uuid > text   (SQLSTATE 42883)
 *
 * Three keyset queries compared `(title, id) > ($1::text, $2::text)` against a
 * `uuid` primary key. Postgres rejects that when it *parses* the statement, so
 * even the first unpaginated page failed — and no test could see it, because
 * nothing in the suite touches a database.
 *
 * This builds a throwaway database, applies the real schema via initDB(), and
 * calls the actual exported read functions. The assertion is deliberately about
 * a *class* of Postgres error rather than specific values: a query whose text is
 * wrong fails at parse time whatever arguments it receives, which is precisely
 * why the outage was reachable on page one.
 *
 * Gated on AURORA_DB_TESTS=1 so `npm test` stays runnable without Postgres.
 * When the gate is on and the database is unreachable, these FAIL rather than
 * skip — a silently-skipped guard is worse than none.
 */
import { Pool } from 'pg';

const ENABLED = process.env.AURORA_DB_TESTS === '1';
const describeDb = ENABLED ? describe : describe.skip;

// Postgres codes meaning "this statement is wrong regardless of its arguments".
// These are the outage class. Anything else — a not-null violation, a malformed
// uuid literal — comes from the arguments this sweep guessed, not from the SQL.
const SQL_DEFECT_CODES: Record<string, string> = {
  '42601': 'syntax_error',
  '42703': 'undefined_column',
  '42883': 'undefined_function_or_operator',
  '42P01': 'undefined_table',
  '42804': 'datatype_mismatch',
  '42P18': 'indeterminate_datatype',
  '42846': 'cannot_coerce',
  '42P10': 'invalid_column_reference',
};

const DB_NAME = `aurora_test_${process.pid}_${Date.now().toString(36)}`;
const ADMIN = { user: process.env.DB_USER || 'musicuser', password: process.env.DB_PASSWORD || 'musicpass', host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432) };

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TRACK_ID = 'dGVzdC90cmFjay5mbGFj';

let admin: Pool;
let db: typeof import('../index');
let pool: Pool;
let seeded: { artistId: string; albumId: string; genreId: string };

describeDb('database read queries', () => {
  jest.setTimeout(120_000);

  beforeAll(async () => {
    admin = new Pool({ ...ADMIN, database: 'postgres', connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE ${DB_NAME}`);

    // initDB() reads env when first called and memoises the pool, so the target
    // must be set before the module is imported.
    process.env.DB_NAME = DB_NAME;
    db = await import('../index');
    pool = await db.initDB();

    const artist = await pool.query("INSERT INTO artists (name) VALUES ('Test Artist') RETURNING id");
    const album = await pool.query("INSERT INTO albums (title) VALUES ('Test Album') RETURNING id");
    const genre = await pool.query("INSERT INTO genres (name) VALUES ('Test Genre') RETURNING id");
    seeded = { artistId: artist.rows[0].id, albumId: album.rows[0].id, genreId: genre.rows[0].id };

    await pool.query(
      `INSERT INTO users (id, username, password_hash, role) VALUES ($1, 'tester', 'x', 'admin')
       ON CONFLICT DO NOTHING`, [USER_ID]).catch(() => { /* shape may differ; user-scoped reads then report as needing args */ });

    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO tracks (id, title, artist, album, path, artist_id, album_id, duration)
         VALUES ($1, $2, 'Test Artist', 'Test Album', $3, $4, $5, 180)`,
        [`${TRACK_ID}${i}`, `Test Track ${i}`, `dGVzdC90cmFjaw==${i}`, seeded.artistId, seeded.albumId],
      );
    }
  });

  afterAll(async () => {
    try { if (pool) await pool.end(); } catch { /* already closed */ }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });

  // The outage itself. First page alone would have caught it, but the cursor
  // page is what the ORDER BY cast guarantees, so both are asserted.
  describe('keyset pagination (the 2026-09-02 outage)', () => {
    const cases: Array<[string, 'title' | 'name']> = [
      ['getAlbumsPage', 'title'],
      ['getArtistsPage', 'name'],
      ['getGenresPage', 'name'],
    ];

    it.each(cases)('%s returns a first page against uuid ids', async (name) => {
      const fn = (db as unknown as Record<string, (o: unknown) => Promise<unknown[]>>)[name];
      await expect(fn({ limit: 5 })).resolves.toBeInstanceOf(Array);
    });

    it.each(cases)('%s pages by cursor without repeating a row', async (name, sortKey) => {
      const fn = (db as unknown as Record<string, (o: unknown) => Promise<Array<Record<string, unknown>>>>)[name];
      const first = await fn({ limit: 1 });
      if (first.length === 0) return; // nothing seeded for this entity
      const last = first[first.length - 1];
      const second = await fn({ limit: 5, after: { sort: String(last[sortKey] ?? ''), id: String(last.id) } });
      const firstIds = new Set(first.map((r) => String(r.id)));
      expect(second.filter((r) => firstIds.has(String(r.id)))).toHaveLength(0);
    });
  });

  // The broad guard. Calls every exported read-shaped function and fails only on
  // the error class that means the statement itself is malformed.
  describe('every exported read query parses', () => {
    it('no exported read function raises a SQL-defect error', async () => {
      const READ_SHAPED = /^(get|list|search|find|count|has)[A-Z]/;
      const argsFor = (): Record<string, unknown[]> => ({
        getTrackById: [`${TRACK_ID}0`],
        getAlbumById: [seeded.albumId],
        getArtistById: [seeded.artistId],
        getGenreById: [seeded.genreId],
        getTracksByAlbum: [seeded.albumId, USER_ID],
        getTracksByArtist: [seeded.artistId, USER_ID],
        getAlbumsPage: [{ limit: 5 }],
        getArtistsPage: [{ limit: 5 }],
        getGenresPage: [{ limit: 5 }],
        getUserSetting: [USER_ID, 'discoveryLevel'],
        getSystemSetting: ['turnstileEnabled'],
        searchLibrary: ['test'],
        searchLibraryRanked: ['test'],
        getUserRecentTracks: [USER_ID, 5],
        getTrackLoudnessByIds: [[`${TRACK_ID}0`]],
        getArtworkInfoForPath: ['dGVzdC90cmFjaw==0'],
        getPlaylists: [USER_ID],
        getPathsForDirectory: ['/test'],
        getPrimaryArtistName: ['Test Artist', 'Test Artist'],
        searchLibraryArtists: [USER_ID, 'test'],
        // 8-dimensional acoustic vector; the function bails on non-finite input
        // before touching SQL, so the values must be real numbers.
        getGenrePathFromKNN: [[0, 0, 0, 0, 0, 0, 0, 0]],
      });

      const args = argsFor();
      const defects: string[] = [];
      const needArgs: string[] = [];
      let exercised = 0;

      for (const [name, value] of Object.entries(db as Record<string, unknown>)) {
        if (typeof value !== 'function' || !READ_SHAPED.test(name)) continue;
        if (name === 'getPoolStats' || name === 'getDatabaseStats') continue; // no SQL / very slow
        try {
          await (value as (...a: unknown[]) => Promise<unknown>)(...(args[name] ?? []));
          exercised++;
        } catch (error) {
          const code = (error as { code?: string })?.code;
          if (code && SQL_DEFECT_CODES[code]) {
            defects.push(`${name}: ${SQL_DEFECT_CODES[code]} (${code}) — ${(error as Error).message}`);
          } else {
            needArgs.push(name);
          }
        }
      }

      // The defect list is the point of the test.
      expect(defects).toEqual([]);

      // Coverage is enforced rather than reported. A new exported read query
      // with arguments this sweep cannot guess fails here, which is the prompt
      // to add an entry above — otherwise the sweep quietly narrows over time
      // and stops protecting the thing it was written for.
      expect({ needArgs: needArgs.sort() }).toEqual({ needArgs: [] });
      expect(exercised).toBeGreaterThanOrEqual(90);
    });
  });
});
