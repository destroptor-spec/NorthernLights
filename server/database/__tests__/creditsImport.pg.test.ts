/** @jest-environment node */
import { Pool } from 'pg';
import { config } from 'dotenv';
if (process.env.AURORA_DB_TESTS === '1') config({ quiet: true });
const describeDb = process.env.AURORA_DB_TESTS === '1' ? describe : describe.skip;

const mbGetRecording = jest.fn();
const geniusResolveSongId = jest.fn();
const geniusGetSong = jest.fn();
jest.mock('../../services/metadata/providers/musicbrainz', () => ({ mbGetRecording: (...a: unknown[]) => mbGetRecording(...a) }));
jest.mock('../../services/metadata/providers/genius', () => ({
  geniusResolveSongId: (...a: unknown[]) => geniusResolveSongId(...a),
  geniusGetSong: (...a: unknown[]) => geniusGetSong(...a),
}));

const name = `aurora_credits_test_${process.pid}_${Date.now().toString(36)}`;
let admin: Pool;
let pool: Pool;
let db: typeof import('../index');
let credits: typeof import('../../services/creditsEnrichment.service');

const pathOf = (n: string) => Buffer.from(`/music/${n}.flac`).toString('base64');
const idOf = (n: string) => Buffer.from(pathOf(n)).toString('base64');

/**
 * The MusicBrainz and Genius credit imports run on the server by themselves.
 * They must never ask a free API the same thing twice: every lookup is
 * logged, and a track comes back only when retagged or due again.
 */
describeDb('automatic credit imports', () => {
  jest.setTimeout(120000);
  beforeAll(async () => {
    admin = new Pool({ user: process.env.DB_USER || 'musicuser', password: process.env.DB_PASSWORD || 'musicpass',
      host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), database: 'postgres', connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE ${name}`);
    process.env.DB_NAME = name;
    db = await import('../index');
    pool = await db.initDB();
    credits = await import('../../services/creditsEnrichment.service');
    credits.setCreditsImportPaceForTests(0);
  });
  afterAll(async () => {
    credits?.stopCreditsImports();
    if (pool) await pool.end();
    if (admin) {
      try { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
      finally { await admin.end(); }
    }
  });

  const add = (key: string, mbRecordingId: string | null) =>
    db.addTrack({ path: pathOf(key), title: `Song ${key}`, artist: 'C Artist', mbRecordingId } as never);
  const settle = async (provider: 'musicbrainz' | 'genius') => {
    await credits.ensureCreditsImport(provider);
    for (let i = 0; i < 200; i++) {
      const status = await credits.getCreditsImportStatus(provider);
      if (status.state !== 'running') return status;
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error('import did not settle');
  };
  const lookup = async (key: string, source: string) => (await pool.query(
    'SELECT lookup_key, outcome, credits FROM track_credit_lookups WHERE track_id = $1 AND source = $2', [idOf(key), source])).rows[0] ?? null;

  test('MusicBrainz: imports once per recording, never asks again, and asks again after a retag', async () => {
    expect((await credits.getCreditsImportStatus('musicbrainz')).state).toBe('off');
    await db.setSystemSetting('musicBrainzConnected', true);
    await add('m1', 'rec-1');
    await add('m2', 'rec-2');
    await add('m3', 'rec-3');
    await add('m-none', null);
    mbGetRecording.mockImplementation(async (id: string) => {
      if (id === 'rec-1') return [{ role: 'producer', name: 'P One', detail: '' }];
      if (id === 'rec-3') throw Object.assign(new Error('MusicBrainz HTTP 404'), { statusCode: 404 });
      return [];
    });
    const status = await settle('musicbrainz');
    expect(status).toMatchObject({ state: 'idle', eligible: 3, lookedUp: 3, withCredits: 1, withoutCredits: 2, failed: 0, remaining: 0, creditRows: 1 });
    expect(await lookup('m1', 'musicbrainz')).toEqual({ lookup_key: 'rec-1', outcome: 'found', credits: 1 });
    expect(await lookup('m3', 'musicbrainz')).toMatchObject({ outcome: 'none' });
    expect(mbGetRecording).toHaveBeenCalledTimes(3);

    // A second pass asks nothing.
    await settle('musicbrainz');
    expect(mbGetRecording).toHaveBeenCalledTimes(3);

    // Retagged: the new recording is looked up; credits from the old one go when it has none.
    await pool.query(`UPDATE tracks SET mb_recording_id = 'rec-1b' WHERE id = $1`, [idOf('m1')]);
    await settle('musicbrainz');
    expect(mbGetRecording).toHaveBeenLastCalledWith('rec-1b');
    expect(mbGetRecording).toHaveBeenCalledTimes(4);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM track_artist_credits WHERE track_id = $1 AND source = 'musicbrainz'`, [idOf('m1')])).rows[0].n).toBe(0);
  });

  test('a rate limit pauses the import without recording the track, so it is asked later', async () => {
    await add('m4', 'rec-4');
    mbGetRecording.mockImplementation(async () => { throw new Error('MusicBrainz HTTP 503'); });
    const status = await settle('musicbrainz');
    expect(status).toMatchObject({ state: 'paused', pauseReason: 'rate-limit', remaining: 1 });
    expect(status.resumesAt).toBeGreaterThan(Date.now());
    expect(await lookup('m4', 'musicbrainz')).toBeNull();
  });

  test('Genius: resolves the song once, keeps its id, imports producer and writer credits once', async () => {
    expect((await credits.getCreditsImportStatus('genius')).state).toBe('off');
    await db.setSystemSetting('geniusApiKey', 'genius-key');
    geniusResolveSongId.mockImplementation(async (title: string) => (title === 'Song m2' ? 77 : null));
    geniusGetSong.mockResolvedValue([{ role: 'writer', name: 'W Writer' }]);
    const status = await settle('genius');
    expect(status.state).toBe('idle');
    expect(status.withCredits).toBe(1);
    expect(status.lookedUp).toBe(status.eligible);
    expect((await pool.query('SELECT genius_song_id FROM tracks WHERE id = $1', [idOf('m2')])).rows[0].genius_song_id).toBe('77');
    expect(await lookup('m2', 'genius')).toEqual({ lookup_key: 'song m2|c artist', outcome: 'found', credits: 1 });
    const calls = geniusResolveSongId.mock.calls.length;
    await settle('genius');
    expect(geniusResolveSongId.mock.calls.length).toBe(calls);
  });
});
