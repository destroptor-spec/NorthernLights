/** @jest-environment node */
import { Pool } from 'pg';
import { config } from 'dotenv';
if (process.env.AURORA_DB_TESTS === '1') config({ quiet: true });
const describeDb = process.env.AURORA_DB_TESTS === '1' ? describe : describe.skip;
const name = `aurora_video_test_${process.pid}_${Date.now().toString(36)}`;
let admin: Pool;
let pool: Pool;
let db: typeof import('../index');
let artist: string;
const upload = { videoId: 'video', title: 'Artist - Song (Official Video)', thumbnailUrl: null, publishedAt: null, position: 0 };
const options = { fetched: true, sourceKey: 'source', libraryKey: 'library', channelId: 'channel' };

describeDb('music video catalog and migration', () => {
  jest.setTimeout(120000);
  beforeAll(async () => {
    admin = new Pool({ user: process.env.DB_USER || 'musicuser', password: process.env.DB_PASSWORD || 'musicpass',
      host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), database: 'postgres', connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE ${name}`);
    process.env.DB_NAME = name;
    db = await import('../index');
    pool = await db.initDB();
    artist = (await pool.query("INSERT INTO artists(name) VALUES ('Video Test Artist') RETURNING id")).rows[0].id;
    for (const id of ['track-a', 'track-b']) await pool.query("INSERT INTO tracks(id,title,path,artist_id) VALUES ($1,'Song',$1,$2)", [id, artist]);
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      try { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
      finally { await admin.end(); }
    }
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM track_video_matches');
    await pool.query('DELETE FROM artist_video_uploads');
    await pool.query('DELETE FROM artist_videos_cache');
    await pool.query('DELETE FROM artist_music_videos');
  });

  test('legacy matches remain readable until a successful new catalog replaces them', async () => {
    await pool.query("INSERT INTO artist_music_videos(video_id,artist_id,track_id,title) VALUES ('legacy',$1,'track-a','Song')", [artist]);
    expect((await db.getMusicVideoByTrackId('track-a')).video_id).toBe('legacy');
    await db.noteArtistVideoFailure(artist, 'source', 'provider-error', 60000);
    expect((await db.getMusicVideoByTrackId('track-a')).video_id).toBe('legacy');
    await db.saveArtistVideoCatalog(artist, [], [], options);
    expect(await db.getMusicVideoByTrackId('track-a')).toBeNull();
    expect(await db.getMusicVideosForArtist(artist)).toEqual([]);
  });

  test('one upload serves both album copies but appears once in the artist rail', async () => {
    await db.saveArtistVideoCatalog(artist, [upload], [{ trackId: 'track-a', videoId: 'video' }, { trackId: 'track-b', videoId: 'video' }], options);
    expect((await db.getMusicVideoByTrackId('track-a')).video_id).toBe('video');
    expect((await db.getMusicVideoByTrackId('track-b')).video_id).toBe('video');
    expect(await db.getMusicVideosForArtist(artist)).toHaveLength(1);
    expect(await db.getArtistVideosCache(artist)).toMatchObject({ videos_count: 1, uploads_cached: true, source_key: 'source' });
  });

  test('failed fetches and local rematches preserve successful-fetch time and upload titles', async () => {
    await db.saveArtistVideoCatalog(artist, [upload], [{ trackId: 'track-a', videoId: 'video' }], options);
    const before = await db.getArtistVideosCache(artist);
    await db.noteArtistVideoFailure(artist, 'source', 'provider-error', 60000);
    await db.saveArtistVideoCatalog(artist, [upload], [{ trackId: 'track-b', videoId: 'video' }], { ...options, fetched: false, libraryKey: 'updated-library' });
    const after = await db.getArtistVideosCache(artist);
    expect(after.fetched_at).toEqual(before.fetched_at);
    expect(after.last_error).toBe('provider-error');
    expect(after.retry_after.getTime()).toBeGreaterThan(Date.now());
    expect(after.library_key).toBe('updated-library');
    expect((await db.getArtistVideoUploads(artist))[0].title).toBe(upload.title);
    expect((await db.getMusicVideoByTrackId('track-b')).video_id).toBe('video');
  });

  test('a failed association write rolls back the whole refresh including freshness', async () => {
    await db.saveArtistVideoCatalog(artist, [upload], [{ trackId: 'track-a', videoId: 'video' }], options);
    const before = await db.getArtistVideosCache(artist);
    await expect(db.saveArtistVideoCatalog(artist, [], [{ trackId: 'missing', videoId: 'missing' }], options)).rejects.toThrow();
    expect((await db.getMusicVideoByTrackId('track-a')).video_id).toBe('video');
    expect((await db.getArtistVideosCache(artist)).fetched_at).toEqual(before.fetched_at);
  });
});
