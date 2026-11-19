/**
 * @jest-environment node
 *
 * A moved or renamed file keeps its track (#78): moveTrackPaths moves the row
 * in place, so its id, likes and playlist entries stay; re-scanning the file at
 * its new path updates that row; a new file at the old path gets a row of its
 * own. Against the real schema (the cascades are what lost the data).
 *
 * Gated on AURORA_DB_TESTS=1 like the other *.pg tests.
 */
import { Pool } from 'pg';

const ENABLED = process.env.AURORA_DB_TESTS === '1';
const describeDb = ENABLED ? describe : describe.skip;
const ADMIN = { user: process.env.DB_USER || 'musicuser', password: process.env.DB_PASSWORD || 'musicpass', host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432) };
const suffix = `${process.pid}_${Date.now().toString(36)}`;

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describeDb('moved and renamed files (#78)', () => {
  jest.setTimeout(120_000);
  const DB_NAME = `aurora_moves_test_${suffix}`;
  let admin: Pool;
  let db: typeof import('../index');
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ ...ADMIN, database: 'postgres', connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    process.env.DB_NAME = DB_NAME;
    db = await import('../index');
    pool = await db.initDB();
  });
  afterAll(async () => {
    try { if (pool) await pool.end(); } catch { /* already closed */ }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });

  it('keeps the id, likes and playlist entries of a moved track, and re-scans update it', async () => {
    const user = await db.createUser('listener', 'x', 'user');
    const oldPath = b64('/music/Artist/Album/01 Song.flac');
    const newPath = b64('/music/Artist/Album (2020)/01 Song.flac');
    const id = await db.addTrack({ path: oldPath, title: 'Song', artist: 'Artist', album: 'Album', duration: 200, fileMtime: 111, fileSize: 1000 });
    await db.createPlaylist('pl-1', 'Road trip', null, false, user.id);
    await db.addTracksToPlaylist('pl-1', [id]);
    await db.setTrackLovedForUser(user.id, id, true);

    expect(await db.getTracksForMoveMatching([oldPath])).toEqual([
      { path: oldPath, size: 1000, mtime: 111, duration: 200, title: 'Song', artist: 'Artist', album: 'Album' },
    ]);
    expect(await db.moveTrackPaths([{ from: oldPath, to: newPath, size: 1000, mtime: 111 }])).toEqual([{ from: oldPath, to: newPath }]);

    const row = (await pool.query('SELECT id, path, decoded_path, file_mtime FROM tracks')).rows;
    expect(row).toHaveLength(1);
    expect(row[0].id).toBe(id);
    expect(row[0].path).toBe(newPath);
    expect(Buffer.from(row[0].decoded_path).toString('utf8')).toBe('/music/Artist/Album (2020)/01 Song.flac');
    expect((await pool.query('SELECT track_id FROM playlist_tracks WHERE playlist_id = $1', ['pl-1'])).rows).toEqual([{ track_id: id }]);
    expect((await pool.query('SELECT track_id FROM user_loved_tracks WHERE user_id = $1', [user.id])).rows).toEqual([{ track_id: id }]);

    // Re-tagged later at its new path: the same row is updated, not a second one added.
    expect(await db.addTrack({ path: newPath, title: 'Song (Remastered)', artist: 'Artist', album: 'Album', duration: 200, fileMtime: 222, fileSize: 1000 })).toBe(id);
    expect((await pool.query('SELECT id, title FROM tracks')).rows).toEqual([{ id, title: 'Song (Remastered)' }]);

    // A new file at the old path: its own row, under a new id (base64 of its path is taken).
    const freshId = await db.addTrack({ path: oldPath, title: 'Another', artist: 'Artist', album: 'Album', duration: 180, fileMtime: 333, fileSize: 900 });
    expect(freshId).not.toBe(id);
    expect((await pool.query('SELECT count(*)::int AS n FROM tracks')).rows[0].n).toBe(2);
    await db.recordUnparsedTrack({ path: oldPath, title: 'ignored', fileMtime: 444, fileSize: 901 });
    expect((await pool.query('SELECT id, file_mtime FROM tracks WHERE path = $1', [oldPath])).rows).toEqual([{ id: freshId, file_mtime: '444' }]);
  });

  it('never moves a track onto a path that already has one', async () => {
    const a = b64('/music/x/a.flac');
    const b = b64('/music/x/b.flac');
    await db.addTrack({ path: a, title: 'A', fileMtime: 1, fileSize: 10 });
    await db.addTrack({ path: b, title: 'B', fileMtime: 2, fileSize: 20 });
    expect(await db.moveTrackPaths([{ from: a, to: b, size: 10, mtime: 1 }])).toEqual([]);
    expect((await pool.query('SELECT title FROM tracks WHERE path = $1', [b])).rows).toEqual([{ title: 'B' }]);
  });
});
