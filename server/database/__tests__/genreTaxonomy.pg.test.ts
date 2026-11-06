/** @jest-environment node */
import { Pool } from 'pg';
import { config } from 'dotenv';
if (process.env.AURORA_DB_TESTS === '1') config({ quiet: true });
const describeDb = process.env.AURORA_DB_TESTS === '1' ? describe : describe.skip;
const name = `aurora_taxonomy_test_${process.pid}_${Date.now().toString(36)}`;
let admin: Pool;
let pool: Pool;
let db: typeof import('../index');
let taxonomy: typeof import('../../services/genreTaxonomy');

// As the scanner does: path is the base64 of the file path, the track id the base64 of that.
const pathOf = (name: string) => Buffer.from(`/music/${name}.flac`).toString('base64');
const idOf = (name: string) => Buffer.from(pathOf(name)).toString('base64');
const track = (name: string, genres: string[] | null, genre: string | null = null) => ({
  path: pathOf(name), title: name, artist: 'Taxonomy Artist', album: 'Taxonomy Album', genre: genre ?? genres?.[0] ?? null, genres,
});

describeDb('genre & style taxonomy on a fresh database', () => {
  jest.setTimeout(180000);
  beforeAll(async () => {
    admin = new Pool({ user: process.env.DB_USER || 'musicuser', password: process.env.DB_PASSWORD || 'musicpass',
      host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), database: 'postgres', connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE ${name}`);
    process.env.DB_NAME = name;
    db = await import('../index');
    pool = await db.initDB();
    taxonomy = await import('../../services/genreTaxonomy');
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      try { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
      finally { await admin.end(); }
    }
  });

  test('startup seeds the taxonomy and MusicBrainz genres, maps track tags, and reports the gate', async () => {
    await db.addTrack(track('t-house', ['House', 'Deep House']));
    await db.addTrack(track('t-compound', ['Hard Rock/Heavy Metal']));
    await db.addTrack(track('t-trip', ['Trip Hop']));
    await db.addTrack(track('t-groove', ['Groove Metal']));
    await db.addTrack(track('t-other', ['Other']));
    await db.addTrack(track('t-odd', ['Electric Hip Hop Soul']));
    await db.addTrack(track('t-untagged', null, null));

    // addTrack writes original tags verbatim; the untagged placeholder is not a tag.
    const tags = (await pool.query('SELECT track_id, tag, position FROM track_tags ORDER BY track_id, position')).rows;
    expect(tags.filter(t => t.track_id === idOf('t-house')).map(t => t.tag)).toEqual(['House', 'Deep House']);
    expect(tags.some(t => t.track_id === idOf('t-untagged'))).toBe(false);

    await taxonomy.initializeGenreTaxonomy();
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM style')).rows[0].n).toBe(400);
    expect((await pool.query('SELECT hidden FROM taxonomy_genre WHERE name = \'Non-Music\'')).rows[0].hidden).toBe(true);
    // Empty MusicBrainz tables get the shipped snapshot, and the old engine's view is rebuilt.
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM genre')).rows[0].n).toBeGreaterThan(2000);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM genre_tree_paths')).rows[0].n).toBeGreaterThan(1000);
    expect(await db.getSystemSetting('mbGenreSource')).toMatchObject({ kind: 'snapshot' });

    const map = async (key: string) => (await pool.query(
      `SELECT m.method, m.genre, s.name AS style FROM tag_map m LEFT JOIN style s ON s.id = m.style_id
       WHERE m.tag = $1 ORDER BY m.genre, s.name`, [key])).rows;
    expect(await map('deep house')).toEqual([{ method: 'exact', genre: 'Electronic', style: 'Deep House' }]);
    expect((await map('trip hop')).map(r => r.genre)).toEqual(['Electronic', 'Hip Hop']);
    expect((await map('hard rock heavy metal')).map(r => `${r.method}:${r.style}`)).toEqual(['compound:Hard Rock', 'compound:Heavy Metal']);
    expect((await map('groove metal'))[0]).toMatchObject({ method: 'mb_parent', genre: 'Rock', style: 'Heavy Metal' });
    expect((await pool.query('SELECT source FROM tag_ignored WHERE tag = \'other\'')).rows[0].source).toBe('seed');

    const coverage = await taxonomy.getMappingCoverage(pool);
    // 6 tagged tracks, 1 only "Other" → 5 count; 4 of them mapped.
    expect(coverage.tracks).toMatchObject({ tagged: 6, ignoredOnly: 1, mapped: 4 });
    expect(coverage.tracks.coverage).toBeCloseTo(0.8);
    expect(coverage.unmapped).toEqual([{ tagKey: 'electric hip hop soul', example: 'Electric Hip Hop Soul', tracks: 1 }]);
    expect(coverage.gate).toEqual({ coverageMet: false, allReviewed: false, passed: false });
  });

  test('a full remap keeps manual decisions and the review marks of unchanged mappings', async () => {
    await pool.query(`UPDATE tag_map SET reviewed_at = NOW() WHERE tag = 'deep house'`);
    await pool.query(`INSERT INTO tag_map (tag, genre, method, reliability, mapping_version)
                      VALUES ('electric hip hop soul', 'Hip Hop', 'manual', 1, 0)`);
    const before = (await pool.query(`SELECT id FROM tag_map WHERE tag = 'deep house'`)).rows[0].id;
    await taxonomy.runTagMapping(pool, { full: true });
    const deep = (await pool.query(`SELECT id, reviewed_at FROM tag_map WHERE tag = 'deep house'`)).rows[0];
    expect(deep.id).toBe(before);
    expect(deep.reviewed_at).not.toBeNull();
    expect((await pool.query(`SELECT method FROM tag_map WHERE tag = 'electric hip hop soul'`)).rows).toEqual([{ method: 'manual' }]);
    const coverage = await taxonomy.getMappingCoverage(pool);
    expect(coverage.tracks.mapped).toBe(5);
    expect(coverage.gate.coverageMet).toBe(true);
  });

  test('retagging a track replaces its tags, and the next scan maps the new one', async () => {
    await db.addTrack(track('t-house', ['Techno']));
    expect((await pool.query('SELECT tag FROM track_tags WHERE track_id = $1', [idOf('t-house')])).rows).toEqual([{ tag: 'Techno' }]);
    const result = await taxonomy.runTagMapping(pool);
    expect(result.keys).toBeGreaterThanOrEqual(1);
    expect((await pool.query(`SELECT genre FROM tag_map WHERE tag = 'techno'`)).rows).toEqual([{ genre: 'Electronic' }]);
  });
});
