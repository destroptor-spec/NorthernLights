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

  it('selects legacy feature versions for reanalysis and preserves loudness on feature writes', async () => {
    const legacyId = `${TRACK_ID}0`;
    const currentId = `${TRACK_ID}1`;
    const simulatedId = `${TRACK_ID}2`;
    const features = { bpm: 120, acoustic_vector: Array(8).fill(0.5), embedding_vector: [1, ...Array(1279).fill(0)] };
    try {
      await db.addTrackFeatures(legacyId, features);
      await db.setTrackLoudness(currentId, -12, -1);
      await db.addTrackFeatures(currentId, { ...features, feature_version: 2 });
      await db.addTrackFeatures(simulatedId, { ...features, is_simulated: true, feature_version: 2 });
      expect((await db.getTracksWithoutFeatures()).map(row => row.id)).toEqual([legacyId]);
      await db.addTrackFeatures(legacyId, { ...features, feature_version: 2 });
      expect(await db.getTracksWithoutFeatures()).toEqual([]);
      const row = (await pool.query('SELECT feature_version, loudness_lufs FROM track_features WHERE track_id = $1', [currentId])).rows[0];
      expect(row).toMatchObject({ feature_version: 2, loudness_lufs: -12 });
      expect((await db.getTracksWithSimulatedFeatures()).map(row => row.id)).toEqual([simulatedId]);
    } finally {
      await pool.query('DELETE FROM track_features WHERE track_id = ANY($1::text[])', [[legacyId, currentId, simulatedId]]);
    }
  });

  it('returns stored artist artwork in Jump back in without waiting for client entity pages', async () => {
    const { computeJumpBackIn } = await import('../../services/smartHub.service');
    await pool.query(`INSERT INTO user_playback_stats (user_id, track_id, play_count, last_played_at)
      VALUES ($1, $2, 1, NOW()) ON CONFLICT (user_id, track_id)
      DO UPDATE SET last_played_at = NOW()`, [USER_ID, `${TRACK_ID}0`]);
    try {
      for (const [image, artwork, expected] of [
        [null, '/artwork.jpg', '/artwork.jpg'],
        ['', '/artwork.jpg', '/artwork.jpg'],
        ['/portrait.jpg', '/artwork.jpg', '/portrait.jpg'],
        [null, null, null],
      ]) {
        await pool.query('UPDATE artists SET image_url = $1, artwork_url = $2 WHERE id = $3', [image, artwork, seeded.artistId]);
        const tile = (await computeJumpBackIn(USER_ID)).find(t => t.type === 'artist' && t.id === seeded.artistId);
        expect(tile).toMatchObject({ title: 'Test Artist', imageUrl: expected });
      }
    } finally {
      await pool.query('UPDATE artists SET image_url = NULL, artwork_url = NULL WHERE id = $1', [seeded.artistId]);
      await pool.query('DELETE FROM user_playback_stats WHERE user_id = $1 AND track_id = $2', [USER_ID, `${TRACK_ID}0`]);
    }
  });

  it('returns stored artist artwork for similar artists when the primary image is missing', async () => {
    const neighbour = (await pool.query("INSERT INTO artists (name) VALUES ('Neighbour Artist') RETURNING id")).rows[0].id;
    const ownIds = [`${TRACK_ID}0`, `${TRACK_ID}1`];
    const neighbourIds = ['bmVpZ2hib3VyMA==', 'bmVpZ2hib3VyMQ=='];
    const features = { bpm: 120, acoustic_vector: Array(8).fill(0.5), embedding_vector: [1, ...Array(1279).fill(0)], feature_version: 2 };
    try {
      for (const [i, id] of neighbourIds.entries()) {
        await pool.query(
          `INSERT INTO tracks (id, title, artist, album, path, artist_id, album_id, duration)
           VALUES ($1, $2, 'Neighbour Artist', 'Test Album', $3, $4, $5, 180)`,
          [id, `Neighbour Track ${i}`, `bmVpZ2hib3Vy${i}`, neighbour, seeded.albumId],
        );
      }
      for (const id of [...ownIds, ...neighbourIds]) await db.addTrackFeatures(id, features);
      await db.refreshArtistAudioProfiles();
      for (const [image, artwork, expected] of [
        [null, '/artwork.jpg', '/artwork.jpg'],
        ['', '/artwork.jpg', '/artwork.jpg'],
        ['/portrait.jpg', '/artwork.jpg', '/portrait.jpg'],
        [null, null, undefined],
      ]) {
        await pool.query('UPDATE artists SET image_url = $1, artwork_url = $2 WHERE id = $3', [image, artwork, neighbour]);
        const similar = (await db.getSimilarArtistsByAudioProfile(seeded.artistId)).find(a => a.id === neighbour);
        expect(similar).toMatchObject({ name: 'Neighbour Artist', imageUrl: expected });
      }
    } finally {
      await pool.query('DELETE FROM track_features WHERE track_id = ANY($1::text[])', [[...ownIds, ...neighbourIds]]);
      await pool.query('DELETE FROM tracks WHERE id = ANY($1::text[])', [neighbourIds]);
      await pool.query('DELETE FROM artists WHERE id = $1', [neighbour]);
      await db.refreshArtistAudioProfiles();
    }
  });

  it('returns stored artist artwork in search, subscriptions, auto-add and concerts', async () => {
    const trackId = `${TRACK_ID}0`;
    const artistId = seeded.artistId;
    await pool.query(`INSERT INTO user_playback_stats (user_id, track_id, play_count, last_played_at)
      VALUES ($1, $2, 3, NOW()) ON CONFLICT (user_id, track_id)
      DO UPDATE SET play_count = 3, last_played_at = NOW()`, [USER_ID, trackId]);
    await pool.query(`INSERT INTO concert_events (jambase_event_id, artist_id, event_date)
      VALUES ('artwork-test', $1, CURRENT_DATE + 7)`, [artistId]);
    const images = async () => {
      const ranked = (await db.searchLibraryRanked('Test Artist', USER_ID)).results
        .find(r => r.type === 'artist' && (r.item as any).id === artistId)?.item as any;
      const autoAdd = (await db.getAutoAddCandidates(USER_ID)).find((a: any) => a.id === artistId);
      await db.addArtistSubscription(USER_ID, artistId);
      const subscribed = (await db.getArtistSubscriptions(USER_ID)).find((a: any) => a.id === artistId);
      const event = (await db.getHubEventsForUser(USER_ID)).find((e: any) => e.artist_id === artistId);
      await db.removeArtistSubscription(USER_ID, artistId);
      await db.dismissAutoArtist(USER_ID, artistId);
      const dismissed = (await db.getDismissedAutoArtists(USER_ID)).find((a: any) => a.id === artistId);
      await db.undismissAutoArtist(USER_ID, artistId);
      return {
        ranked: ranked?.image_url,
        autoAdd: autoAdd?.image_url,
        topArtists: (await db.getUserTopArtists(USER_ID)).find((a: any) => a.id === artistId)?.image_url,
        librarySearch: (await db.searchLibraryArtists(USER_ID, 'Test Artist')).find((a: any) => a.id === artistId)?.image_url,
        subscribed: subscribed?.image_url,
        event: event?.artist_image_url,
        dismissed: dismissed?.image_url,
      };
    };
    const every = (url: string) => ({ ranked: url, autoAdd: url, topArtists: url, librarySearch: url, subscribed: url, event: url, dismissed: url });
    try {
      for (const [image, artwork, expected] of [
        [null, '/artwork.jpg', '/artwork.jpg'],
        ['', '/artwork.jpg', '/artwork.jpg'],
        ['/portrait.jpg', '/artwork.jpg', '/portrait.jpg'],
      ] as const) {
        await pool.query('UPDATE artists SET image_url = $1, artwork_url = $2 WHERE id = $3', [image, artwork, artistId]);
        expect(await images()).toEqual(every(expected));
      }
    } finally {
      await pool.query('UPDATE artists SET image_url = NULL, artwork_url = NULL WHERE id = $1', [artistId]);
      await pool.query("DELETE FROM concert_events WHERE jambase_event_id = 'artwork-test'");
      await pool.query('DELETE FROM user_artist_subscriptions WHERE user_id = $1', [USER_ID]);
      await pool.query('DELETE FROM user_dismissed_auto_artists WHERE user_id = $1', [USER_ID]);
      await pool.query('DELETE FROM user_playback_stats WHERE user_id = $1 AND track_id = $2', [USER_ID, trackId]);
    }
  });

  it('selects never-fetched artists first, then imageless library artists past the cache TTL', async () => {
    const day = 86400;
    const now = Math.floor(Date.now() / 1000);
    const rows: Array<[string, string | null, number, boolean]> = [
      ['Stale Imageless', null, now - 40 * day, true],
      ['Recent Imageless', null, now - 5 * day, true],
      ['Stale With Image', '/portrait.jpg', now - 40 * day, true],
      ['Never Fetched', null, 0, true],
      ['Stale Credit Only', null, now - 40 * day, false],
      ['Never Fetched Credit Only', null, 0, false],
    ];
    const ids: string[] = [];
    try {
      for (const [i, [name, image, lastUpdated, hasTracks]] of rows.entries()) {
        const id = (await pool.query('INSERT INTO artists (name, image_url, last_updated) VALUES ($1, $2, $3) RETURNING id', [name, image, lastUpdated])).rows[0].id;
        ids.push(id);
        if (!hasTracks) continue;
        await pool.query(
          `INSERT INTO tracks (id, title, artist, album, path, artist_id, album_id, duration)
           VALUES ($1, 'Track', $2, 'Test Album', $3, $4, $5, 180)`,
          [`c2VsZWN0b3I=${i}`, name, `c2VsZWN0b3I=${i}`, id, seeded.albumId],
        );
      }
      const selected = (await db.getArtistsNeedingImage(50)).map(a => a.name).filter(name => rows.some(r => r[0] === name));
      expect(selected).toEqual(['Never Fetched', 'Never Fetched Credit Only', 'Stale Imageless']);
    } finally {
      await pool.query('DELETE FROM tracks WHERE artist_id = ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM artists WHERE id = ANY($1::uuid[])', [ids]);
    }
  });

  describe('artist names follow the files, merges hold', () => {
    const SABRINA_MBID = '00000000-0000-4000-8000-00000000aaaa';
    const KANJI_MBID = '00000000-0000-4000-8000-00000000bbbb';
    const GLUED_MBID = '00000000-0000-4000-8000-00000000cccc';
    const created = new Set<string>();
    const artist = async (name: string, mbid: string | null) => {
      const id = await db.getOrCreateArtist(name, mbid);
      created.add(id);
      return id;
    };
    const row = async (id: string) => (await pool.query('SELECT name, mbid, merged_into FROM artists WHERE id = $1', [id])).rows[0];
    const mbidCandidate = async (mbid: string) =>
      (await db.getArtistDuplicateCandidates()).find(c => c.candidateKey === `artist-mbid:${mbid}`);

    afterAll(async () => {
      await pool.query("DELETE FROM artist_duplicate_reviews WHERE candidate_key LIKE 'artist-mbid:00000000-%' OR artist_ids::text LIKE ANY($1)",
        [[...created].map(id => `%${id}%`)]);
      await pool.query('UPDATE artists SET merged_into = NULL WHERE id = ANY($1::uuid[])', [[...created]]);
      await pool.query('DELETE FROM artists WHERE id = ANY($1::uuid[])', [[...created]]);
    });

    it('gives a different spelling of the same MusicBrainz artist its own row, and reuses the row for the same spelling', async () => {
      const salerno = await artist('ZZ Sabrina Salerno', SABRINA_MBID);
      const sabrina = await artist('ZZ Sabrina', SABRINA_MBID);

      expect(sabrina).not.toBe(salerno);
      expect(await row(sabrina)).toMatchObject({ name: 'ZZ Sabrina', mbid: SABRINA_MBID });
      expect(await artist('zz sabrina', SABRINA_MBID)).toBe(sabrina);
      expect(await artist('ZZ Sabrina Salerno', SABRINA_MBID)).toBe(salerno);
    });

    it('applies the same rule to names without Latin letters', async () => {
      const kanji = await artist('植松伸夫', KANJI_MBID);
      expect(await artist('植松伸夫', KANJI_MBID)).toBe(kanji);
      expect(await artist('ZZ Nobuo Uematsu', KANJI_MBID)).not.toBe(kanji);
    });

    it('lists the spellings for review, hides them once kept apart, and keeps a fold after it', async () => {
      const salerno = await artist('ZZ Sabrina Salerno', SABRINA_MBID);
      const sabrina = await artist('ZZ Sabrina', SABRINA_MBID);
      const candidate = await mbidCandidate(SABRINA_MBID);
      expect(candidate?.artists.map(a => a.id).sort()).toEqual([salerno, sabrina].sort());

      await db.dismissArtistDuplicateCandidate({ candidateKey: candidate!.candidateKey, signature: candidate!.signature, artistIds: [salerno, sabrina] });
      expect(await mbidCandidate(SABRINA_MBID)).toBeUndefined();

      await db.mergeArtistsManually({ canonicalArtistId: salerno, duplicateArtistIds: [sabrina] });
      expect(await artist('ZZ Sabrina', SABRINA_MBID)).toBe(salerno);
      expect(await artist('ZZ Sabrina', null)).toBe(salerno);
      expect((await row(sabrina)).merged_into).toBe(salerno);
    });

    it('counts a merged row\'s MusicBrainz id for the artist it was folded into', async () => {
      const glued = await artist('ZZ CleanZZ CleanZZ Other', GLUED_MBID);
      const clean = await artist('ZZ Clean', null);
      await db.mergeArtistsManually({ canonicalArtistId: clean, duplicateArtistIds: [glued] });

      // The fold holds for the clean spelling, found through the merged row's MBID.
      expect(await artist('ZZ Clean', GLUED_MBID)).toBe(clean);
      // A new spelling of that MusicBrainz artist gets its own row and is listed next to it.
      const duo = await artist('ZZ Clean vs. ZZ Other', GLUED_MBID);
      expect(duo).not.toBe(clean);
      const candidate = await mbidCandidate(GLUED_MBID);
      expect(candidate?.artists.map(a => a.id).sort()).toEqual([clean, duo].sort());
    });
  });

  it('reports the same missing and outdated backlog that incremental analysis selects', async () => {
    const directory = "/coverage/Blå — O'Brien";
    const ids = ['missing', 'loudness', 'embedding-only', 'legacy', 'current', 'future', 'simulated']
      .map(name => `coverage-${name}`);
    const features = { bpm: 120, acoustic_vector: Array(8).fill(0.5), embedding_vector: [1, ...Array(1279).fill(0)] };
    try {
      await db.addDirectory(directory);
      for (const id of ids) {
        await pool.query('INSERT INTO tracks (id, title, path) VALUES ($1, $1, $2)',
          [id, Buffer.from(`${directory}/${id}.flac`).toString('base64')]);
      }
      await db.setTrackLoudness(ids[1], -12, -1);
      await db.addTrackFeatures(ids[2], { ...features, feature_version: 2 });
      await pool.query('UPDATE track_features SET acoustic_vector_8d = NULL WHERE track_id = $1', [ids[2]]);
      await db.addTrackFeatures(ids[3], { ...features, feature_version: 1 });
      await db.addTrackFeatures(ids[4], { ...features, feature_version: 2 });
      await db.addTrackFeatures(ids[5], { bpm: 120, acoustic_vector: features.acoustic_vector, feature_version: 3 });
      await db.addTrackFeatures(ids[6], { ...features, feature_version: 2, is_simulated: true });
      const stats = (await db.getLibraryDirectoryStats()).find(row => row.path === directory)!;
      expect(stats).toEqual({ path: directory, totalTracks: 7, withMetadata: 0, analyzed: 3, missingAnalysis: 3, outdatedAnalysis: 1 });
      const pending = (await db.getTracksWithoutFeatures()).filter(row => ids.includes(row.id));
      expect(pending.map(row => row.id).sort()).toEqual(ids.slice(0, 4).sort());
      expect(pending).toHaveLength(stats.missingAnalysis + stats.outdatedAnalysis);
      // Completing the backlog changes coverage and eligibility together.
      for (const track of pending) await db.addTrackFeatures(track.id, { ...features, feature_version: 2 });
      expect((await db.getLibraryDirectoryStats()).find(row => row.path === directory))
        .toMatchObject({ analyzed: 7, missingAnalysis: 0, outdatedAnalysis: 0 });
      expect((await db.getTracksWithoutFeatures()).filter(row => ids.includes(row.id))).toEqual([]);
    } finally {
      await pool.query('DELETE FROM tracks WHERE id = ANY($1::text[])', [ids]);
      await db.removeDirectory(directory);
    }
  });

  it.each([true, false])('Infinity reads stored vectors by version and never repeats excluded tracks (embedding=%s)', async withEmbedding => {
    const ids = [0, 1, 2].map(index => `${TRACK_ID}${index}`);
    const features = { bpm: 120, acoustic_vector: [0.7, 0.1, 0.1, 0.5, 0.1, 0.1, 0.1, 0.6], embedding_vector: withEmbedding ? [1, ...Array(1279).fill(0)] : undefined };
    try {
      await db.addTrackFeatures(ids[0], { ...features, feature_version: 2 });
      await db.addTrackFeatures(ids[1], { ...features, feature_version: 1 });
      await db.addTrackFeatures(ids[2], { ...features, acoustic_vector: [0.71, ...features.acoustic_vector.slice(1)], feature_version: 2 });
      const { calculateNextInfinityTrack } = await import('../../services/recommendation.service');
      const next = await calculateNextInfinityTrack([ids[0]], { discoveryLevel: 0 });
      // The old-version row is closer numerically, but has different semantics.
      expect(next?.id).toBe(ids[2]);
      await expect(calculateNextInfinityTrack([ids[0], ids[2]], { artistAmnesiaLimit: 0 }, { excludeTrackIds: [ids[1]] })).resolves.toBeUndefined();
    } finally {
      await pool.query('DELETE FROM track_features WHERE track_id = ANY($1::text[])', [ids]);
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
