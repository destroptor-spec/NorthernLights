/** @jest-environment node */
import { Pool } from 'pg';
import { config } from 'dotenv';
if (process.env.AURORA_DB_TESTS === '1') config({ quiet: true });
const describeDb = process.env.AURORA_DB_TESTS === '1' ? describe : describe.skip;
// No metadata providers: every provider call would fail the test.
jest.mock('../../services/metadata/providers/lastfm', () => ({
  lastFmArtistTopTags: jest.fn(() => { throw new Error('Last.fm must not be called'); }),
}));
jest.mock('../../services/metadata/providers/musicbrainz', () => ({
  mbGetArtist: jest.fn(() => { throw new Error('MusicBrainz must not be called'); }),
}));
const name = `aurora_noproviders_test_${process.pid}_${Date.now().toString(36)}`;
let admin: Pool;
let pool: Pool;
let db: typeof import('../index');

const pathOf = (n: string) => Buffer.from(`/music/${n}.flac`).toString('base64');
const idOf = (n: string) => Buffer.from(pathOf(n)).toString('base64');

/**
 * The genre and style engine, Browse, Aurora rays and the filters must work
 * from file tags and audio alone (docs/Aurora genre and style redesign.md:
 * Last.fm and MusicBrainz are optional). This library has neither: no artist
 * tags, no artist countries or areas, no MusicBrainz ids.
 */
describeDb('genres, styles, places and filters without metadata providers', () => {
  jest.setTimeout(180000);
  beforeAll(async () => {
    admin = new Pool({ user: process.env.DB_USER || 'musicuser', password: process.env.DB_PASSWORD || 'musicpass',
      host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432), database: 'postgres', connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE ${name}`);
    process.env.DB_NAME = name;
    db = await import('../index');
    pool = await db.initDB();
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      try { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
      finally { await admin.end(); }
    }
  });

  test('every step works from file tags and audio alone', async () => {
    const taxonomy = await import('../../services/genreTaxonomy');
    // Seed the taxonomy so style ids and model indexes exist.
    await db.addTrack({ path: pathOf('seed'), title: 'seed', artist: 'Seed', genres: ['Rock'], genre: 'Rock' } as never);
    await taxonomy.initializeGenreTaxonomy();
    const styleOf = async (genre: string, s: string) => (await pool.query(
      'SELECT id, model_index FROM style WHERE genre = $1 AND name = $2', [genre, s])).rows[0] as { id: number; model_index: number };
    const [grunge, punk] = await Promise.all([styleOf('Rock', 'Grunge'), styleOf('Rock', 'Punk')]);
    const vec = (from: number, jitter: number) => {
      const v = Array(1280).fill(0);
      for (let i = from; i < from + 10; i++) v[i] = 1;
      v[1000 + jitter] = 0.2;
      return `[${v.join(',')}]`;
    };
    const artists = await Promise.all(['N One', 'N Two', 'N Three'].map(async n =>
      (await pool.query('INSERT INTO artists (name) VALUES ($1) RETURNING id', [n])).rows[0].id as string));
    let n = 0;
    const add = async (key: string, genres: string[] | null, scores: Record<number, number>, file: Record<string, unknown> = {}, base = 0) => {
      await db.addTrack({ path: pathOf(key), title: key, artist: 'N', album: 'N Album', genres, genre: genres?.[0] ?? null,
        year: 2001, originRead: true, ...file } as never);
      const id = idOf(key);
      const all = Array(400).fill(0.01);
      for (const [index, score] of Object.entries(scores)) all[Number(index)] = score;
      await pool.query('UPDATE tracks SET artist_id = $2 WHERE id = $1', [id, artists[n % 3]]);
      await pool.query('INSERT INTO track_features (track_id, embedding_vector) VALUES ($1, $2)', [id, vec(base, n++ % 200)]);
      await pool.query(`INSERT INTO track_style_scores (track_id, scores, model, windows, genre_version) VALUES ($1, $2, 'test', '20,50,80', 1)`, [id, all]);
      return id;
    };
    // Enough Grunge-tagged tracks that sound like it for the sound to be trusted on Rock.
    for (let i = 0; i < 60; i++) {
      await add(`n-grunge-${i}`, ['Grunge'], { [grunge.model_index]: 0.6 },
        i % 2 ? { releaseCountry: 'DK', lyricsLanguage: 'dan' } : { releaseCountry: 'XE', originalYear: 1994 });
    }
    // No genre tag at all: the sound names the genre (no artist tags to ask).
    const untagged = await add('n-untagged', null, { [grunge.model_index]: 0.7, [punk.model_index]: 0.4 });
    // A tagged track the sound contradicts: disputed, from audio alone.
    const far = await add('n-far', ['Grunge'], { [grunge.model_index]: 0.001 }, {}, 300);
    await taxonomy.runTagMapping(pool);
    const status = await taxonomy.runFusion(pool);

    // Fusion: every track has a genre or is unsorted; genres come from tags and the sound only.
    expect(status.byGenreSource.artist).toBe(0);
    expect(status.audioGenres).toContain('Rock');
    const untaggedRows = (await pool.query(
      `SELECT ts.genre, s.name AS style, ts.source FROM track_styles ts LEFT JOIN style s ON s.id = ts.style_id WHERE ts.track_id = $1 ORDER BY s.name NULLS FIRST`, [untagged])).rows;
    expect(untaggedRows.map(r => `${r.genre}/${r.style}:${r.source}`)).toEqual(['Rock/null:audio', 'Rock/Grunge:audio', 'Rock/Punk:audio']);

    // Centroids, "Sounds close to" and disputes need only audio and file tags.
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM style_centroids WHERE style_id = $1', [grunge.id])).rows[0].n).toBe(1);
    const { listDisputedStyles } = await import('../../services/genreTaxonomy/disputed');
    expect((await listDisputedStyles(pool)).items.map(i => i.trackId)).toEqual([far]);
    const { nearTrack } = await import('../../services/genreTaxonomy/centroids');
    expect((await nearTrack(pool, idOf('n-grunge-0')))!.trackIds.length).toBeGreaterThan(0);

    // Places, languages and years from the files; no vocals or moods without artist tags.
    const origin = (await pool.query(`SELECT country_source, COUNT(*)::int AS n, COUNT(language)::int AS lang,
      COUNT(*) FILTER (WHERE year_source = 'original')::int AS original, COUNT(vocals)::int AS vocals, COUNT(moods)::int AS moods
      FROM track_origin GROUP BY 1 ORDER BY 1 NULLS LAST`)).rows;
    expect(origin.find(r => r.country_source === 'release')).toMatchObject({ n: 30, lang: 30 });
    expect(origin.every(r => r.vocals === 0 && r.moods === 0)).toBe(true);
    expect(origin.reduce((s, r) => s + r.original, 0)).toBe(30);
    expect(origin.some(r => r.country_source === 'artist' || r.country_source === 'artist-tags')).toBe(false);

    // Browse: genre pages, the country and decade filters, and no empty vocals or mood rows.
    const browse = await import('../../services/browse.service');
    const none = { albums: async () => [], artists: async () => [] };
    const rock = (await browse.getBrowseGenre(pool, 'Rock', none))!;
    expect(rock.countries).toEqual([{ country: 'DK', trackCount: 30 }]);
    expect(rock.decades.map(d => d.decade)).toEqual([1990, 2000]);
    expect(rock.vocals).toEqual([]);
    expect(rock.moods).toEqual([]);
    expect((await browse.listBrowseTrackIds(pool, { genre: 'Rock', country: 'DK' }, 0, 100)).ids).toHaveLength(30);
    expect(await browse.pickBrowseMix(pool, { genre: 'Rock', decade: 1990 })).not.toHaveLength(0);

    // Aurora rays: credits, styles, sound and context, with no listener tags.
    const { getTrackRays } = await import('../../services/trackRays.service');
    const rays = (await getTrackRays(pool, idOf('n-grunge-1')))!;
    expect(rays.styles.length).toBeGreaterThan(0);
    expect(rays.soundsCloseTo).not.toBeNull();
    expect(rays.artist?.listenerTags ?? []).toEqual([]);

    // AI playlists: vocals and moods are dropped (no data), places and years stand.
    const { originFilterOf, withinCoverage } = await import('../../services/recommendation.service');
    const coverage = (await pool.query(`SELECT bool_or(country IS NOT NULL) AS places, bool_or(decade IS NOT NULL) AS years,
      bool_or(vocals IS NOT NULL) AS vocals, bool_or(moods IS NOT NULL) AS moods FROM track_origin`)).rows[0];
    const within = withinCoverage(originFilterOf({ countries: ['DK'], year_from: 1990, year_to: 1999, vocals: 'female', moods: ['chill'] })!, coverage);
    expect(within.dropped).toEqual(['vocals', 'moods']);
    expect(within.filter).toMatchObject({ countries: ['DK'], yearFrom: 1990, yearTo: 1999, vocals: null, moods: [] });

    // Nothing was fetched from a provider, and no artist tags exist.
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM artist_tags')).rows[0].n).toBe(0);
  });
});
