/** @jest-environment node */
import { Pool } from 'pg';
import { config } from 'dotenv';
if (process.env.AURORA_DB_TESTS === '1') config({ quiet: true });
const describeDb = process.env.AURORA_DB_TESTS === '1' ? describe : describe.skip;
// Provider clients are mocked: the backfill must never reach the real APIs in tests.
jest.mock('../../services/metadata/providers/lastfm', () => ({ lastFmArtistTopTags: jest.fn() }));
jest.mock('../../services/metadata/providers/musicbrainz', () => ({ mbGetArtist: jest.fn() }));
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

  test('the artist-tag backfill fetches library artists once per provider, most-played first, and stops on a rate limit', async () => {
    const lastfm = jest.requireMock('../../services/metadata/providers/lastfm').lastFmArtistTopTags as jest.Mock;
    const mb = jest.requireMock('../../services/metadata/providers/musicbrainz').mbGetArtist as jest.Mock;
    const { RateLimitError } = await import('../../services/metadata/errors');
    const backfill = await import('../../services/genreTaxonomy/artistTagBackfill');
    const artistIds: string[] = [];
    for (const [name, mbid, plays] of [['Busy Artist', 'mbid-busy', 3], ['Quiet Artist', null, 1], ['Various Artists', null, 5]] as const) {
      const id = (await pool.query('INSERT INTO artists (name, mbid) VALUES ($1, $2) RETURNING id', [name, mbid])).rows[0].id;
      artistIds.push(id);
      for (let i = 0; i < plays; i++) {
        await pool.query('INSERT INTO tracks (id, title, path, artist_id) VALUES ($1, $1, $1, $2)', [`bf-${name}-${i}`, id]);
      }
    }
    await db.setSystemSetting('lastFmApiKey', 'test-key');
    await db.setSystemSetting('musicBrainzEnabled', true);
    lastfm.mockResolvedValue({ tag: [{ name: 'trip-hop', count: 100 }, { name: 'electronic', count: 40 }] });
    mb.mockResolvedValue({ genres: [{ name: 'electronic', count: 3 }], tags: [{ name: 'electronic', count: 3 }, { name: 'downtempo', count: 1 }] });

    const first = await backfill.runArtistTagBackfill({ paceMs: 0 });
    expect(first.stoppedReason).toBe('done');
    // Various Artists is skipped; MusicBrainz only for artists with an MBID.
    expect(first.fetched).toEqual({ lastfm: 2, musicbrainz: 1 });
    expect(lastfm.mock.calls.map(c => c[0])).toEqual(['Busy Artist', 'Quiet Artist']);
    const rows = (await pool.query(
      `SELECT provider, tag, raw_count, weight FROM artist_tags WHERE artist_id = $1 ORDER BY provider, weight DESC`, [artistIds[0]])).rows;
    expect(rows.map(r => `${r.provider}:${r.tag}:${r.raw_count}:${Number(r.weight).toFixed(2)}`)).toEqual([
      'lastfm:trip-hop:100:1.00', 'lastfm:electronic:40:0.40', 'musicbrainz:electronic:3:1.00', 'musicbrainz:downtempo:1:0.33']);

    // Resumable: a second run has nothing left to ask.
    lastfm.mockClear(); mb.mockClear();
    expect((await backfill.runArtistTagBackfill({ paceMs: 0 })).fetched).toEqual({ lastfm: 0, musicbrainz: 0 });
    expect(lastfm).not.toHaveBeenCalled();

    // A rate limit stops the run without recording the artist, so the next run retries it.
    await pool.query('DELETE FROM artist_tag_fetches');
    lastfm.mockRejectedValueOnce(new RateLimitError('lastfm'));
    const limited = await backfill.runArtistTagBackfill({ paceMs: 0 });
    expect(limited.stoppedReason).toBe('rate limited by lastfm');
    expect((await backfill.countRemaining(pool)).lastfm).toBe(2);
    await db.setSystemSetting('lastFmApiKey', '');
    await db.setSystemSetting('musicBrainzEnabled', false);
  });
  test('the review queue asks about open tags, applies answers and undoes them in order', async () => {
    const review = await import('../../services/genreTaxonomy/review');
    const rowsOf = async (key: string) => (await pool.query(
      `SELECT m.method, m.genre, s.name AS style, m.reviewed_at IS NOT NULL AS reviewed FROM tag_map m
       LEFT JOIN style s ON s.id = m.style_id WHERE m.tag = $1 ORDER BY m.genre, s.name`, [key])).rows;
    const state = await review.getGenreReviewState(pool);
    const byTag = new Map(state.entries.map(e => [e.tagKey, e]));
    expect(byTag.get('trip hop')?.kind).toBe('two-genres');
    expect(byTag.get('groove metal')?.kind).toBe('guessed');
    expect(byTag.get('groove metal')?.note).toMatch(/^MusicBrainz lists it under metal/i);
    expect(byTag.get('hard rock heavy metal')?.kind).toBe('compound');
    expect(byTag.has('electric hip hop soul')).toBe(false); // a hand choice is already reviewed
    expect(state.exact.map(m => m.subject)).toEqual(['Techno']);
    expect(state.ignored).toEqual([expect.objectContaining({ subject: 'Other', byHand: false })]);
    expect(state.coverage.ratio).toBeCloseTo(1);

    // An answer to an entry that changed since it was loaded is refused.
    const trip = byTag.get('trip hop')!;
    await expect(review.decideGenreReview(pool, { key: trip.key, signature: 'stale', outcomeId: 'accept' })).rejects.toThrow(/changed/);

    // One of two genres becomes a hand choice, so a full remap keeps it.
    const only = trip.outcomes.find(o => o.label === 'Electronic › Trip Hop')!;
    const picked = await review.decideGenreReview(pool, { key: trip.key, signature: trip.signature, outcomeId: only.id });
    expect(picked.summary).toBe('Trip Hop → Electronic › Trip Hop');
    await taxonomy.runTagMapping(pool, { full: true });
    expect(await rowsOf('trip hop')).toEqual([{ method: 'manual', genre: 'Electronic', style: 'Trip Hop', reviewed: true }]);

    // A picked style must exist under the genre sent with it.
    const compound = byTag.get('hard rock heavy metal')!;
    const hardRock = (await pool.query(`SELECT id FROM style WHERE label = 'Rock---Hard Rock'`)).rows[0].id;
    await expect(review.decideGenreReview(pool, {
      key: compound.key, signature: compound.signature, outcomeId: 'pick', targets: [{ genre: 'Jazz', styleId: hardRock }],
    })).rejects.toThrow(/Unknown style/);
    await review.decideGenreReview(pool, {
      key: compound.key, signature: compound.signature, outcomeId: 'pick', targets: [{ genre: 'Rock', styleId: hardRock }],
    });
    expect(await rowsOf('hard rock heavy metal')).toEqual([{ method: 'manual', genre: 'Rock', style: 'Hard Rock', reviewed: true }]);

    // Not a genre, then a genre again: the tag goes back through the automatic mapping.
    const groove = byTag.get('groove metal')!;
    const ignored = await review.decideGenreReview(pool, { key: groove.key, signature: groove.signature, outcomeId: 'ignore' });
    expect(await rowsOf('groove metal')).toEqual([]);
    const asIgnored = (await review.getGenreReviewEntry(pool, groove.key))!;
    expect(asIgnored.kind).toBe('ignored');
    const restored = await review.decideGenreReview(pool, { key: groove.key, signature: asIgnored.signature, outcomeId: 'restore' });
    expect((await rowsOf('groove metal')).map(r => r.method)).toEqual(['mb_parent']);
    // Undo goes newest first per tag.
    await expect(review.undoGenreReviewDecision(pool, ignored.decisionId)).rejects.toThrow(/later decision/);
    await review.undoGenreReviewDecision(pool, restored.decisionId);
    expect((await pool.query(`SELECT source FROM tag_ignored WHERE tag = 'groove metal'`)).rows).toEqual([{ source: 'manual' }]);
    await review.undoGenreReviewDecision(pool, ignored.decisionId);
    expect(await rowsOf('groove metal')).toEqual([{ method: 'mb_parent', genre: 'Rock', style: 'Heavy Metal', reviewed: false }]);
    expect((await pool.query(`SELECT 1 FROM tag_ignored WHERE tag = 'groove metal'`)).rowCount).toBe(0);

    // Name matches are accepted together and undone as one.
    const fresh = await review.getGenreReviewState(pool);
    const bulk = await review.acceptExactMatches(pool, { items: fresh.exact.map(m => ({ key: m.key, signature: m.signature })) });
    expect(bulk).toMatchObject({ accepted: 1, summary: 'Accepted 1 name match' });
    expect((await review.getGenreReviewState(pool)).exact).toEqual([]);
    await review.undoGenreReviewDecision(pool, bulk.decisionId!);
    expect((await review.getGenreReviewState(pool)).exact.map(m => m.subject)).toEqual(['Techno']);

    expect((await review.getRecentGenreReviewDecisions(pool)).map(d => d.summary))
      .toEqual(['Hard Rock/Heavy Metal → Rock › Hard Rock', 'Trip Hop → Electronic › Trip Hop']);
  });

  test('the evidence counts each track under its top style, shows a lone artist\'s tags and suggests the genre when styles vary', async () => {
    const review = await import('../../services/genreTaxonomy/review');
    const styleIndex = async (genre: string, name: string) => (await pool.query(
      'SELECT model_index FROM style WHERE genre = $1 AND name = $2', [genre, name])).rows[0].model_index as number;
    const tops = [
      ['Electronic', 'Downtempo'], ['Electronic', 'Downtempo'], ['Electronic', 'Glitch'],
      ['Electronic', 'Dubstep'], ['Hip Hop', 'Instrumental'],
    ] as const;
    for (const [i, [genre, style]] of tops.entries()) {
      await db.addTrack({ ...track(`t-lights-${i}`, ['Glitch Soul']), artist: 'Lights Artist', album: `Lights ${i % 2}` });
      const scores = Array(400).fill(0.01);
      scores[await styleIndex(genre, style)] = 0.4;
      await pool.query(`INSERT INTO track_features (track_id) VALUES ($1)`, [idOf(`t-lights-${i}`)]);
      await pool.query(`INSERT INTO track_style_scores (track_id, scores, model, windows, genre_version) VALUES ($1, $2, 'test', '20,50,80', 1)`,
        [idOf(`t-lights-${i}`), scores]);
    }
    // A simulated track never counts.
    await db.addTrack({ ...track('t-lights-sim', ['Glitch Soul']), artist: 'Lights Artist' });
    await pool.query(`INSERT INTO track_features (track_id, is_simulated) VALUES ($1, true)`, [idOf('t-lights-sim')]);
    await pool.query(`INSERT INTO track_style_scores (track_id, scores, model, windows, genre_version) VALUES ($1, $2, 'test', '20,50,80', 1)`,
      [idOf('t-lights-sim'), Array(400).fill(0.5)]);
    await taxonomy.runTagMapping(pool);

    const key = 'tag:glitch soul';
    let evidence = (await review.getGenreReviewEvidence(pool, key))!;
    expect(evidence.audio).toMatchObject({ analysed: 5, sampled: false, genres: [{ genre: 'Electronic', tracks: 4 }, { genre: 'Hip Hop', tracks: 1 }] });
    expect(evidence.audio!.styles[0]).toMatchObject({ genre: 'Electronic', style: 'Downtempo', tracks: 2 });
    // Without artist tags, audio alone suggests the genre (4 of 5); Downtempo is 2 of 5, so no style.
    expect(evidence.artistTags).toBeNull();
    expect(evidence.suggestion).toEqual({ targets: [{ genre: 'Electronic', styleId: null, style: null }], basis: 'audio', stylesVary: true, looseStyles: [] });
    // Near counts each track's 5 closest styles: the other four scored styles tie at 0.01, so every track lists five.
    expect(evidence.audio!.styles.reduce((n, s) => n + s.near, 0)).toBe(25);

    // With artist tags that agree, the suggestion says both; one artist shows their own tags.
    // addTrack leaves the artist entity to the scanner; link the tracks by hand.
    const artistId = (await pool.query(`INSERT INTO artists (name) VALUES ('Lights Artist') RETURNING id`)).rows[0].id;
    await pool.query(`UPDATE tracks SET artist_id = $1 WHERE artist = 'Lights Artist'`, [artistId]);
    await pool.query(`INSERT INTO artist_tags (artist_id, provider, tag, tag_key, raw_count, weight) VALUES
      ($1, 'lastfm', 'electronic', 'electronic', 100, 1), ($1, 'lastfm', 'funk', 'funk', 31, 0.31),
      ($1, 'musicbrainz', 'hip hop', 'hip hop', 2, 1), ($1, 'musicbrainz', 'electronic', 'electronic', 1, 0.5)`, [artistId]);
    await taxonomy.runTagMapping(pool);
    evidence = (await review.getGenreReviewEvidence(pool, key))!;
    // Both providers in one list, each tag once at its stronger weight.
    expect(evidence.artistTags).toEqual(['electronic', 'hip hop', 'funk']);
    expect(evidence.lean).toBeNull();
    expect(evidence.suggestion?.basis).toBe('both');

    // Artist tags that disagree with the audio leave the choice open.
    await pool.query(`UPDATE artist_tags SET weight = 0.1 WHERE artist_id = $1 AND tag = 'electronic'`, [artistId]);
    expect((await review.getGenreReviewEvidence(pool, key))!.suggestion).toBeNull();
  });

  test('two spellings of one genre are kept as one in the old genre list, and the undo separates them again', async () => {
    const review = await import('../../services/genreTaxonomy/review');
    await db.addTrack(track('t-alt-1', ['Alternative Rock']));
    await db.addTrack(track('t-alt-2', ['Alternative-Rock']));
    const spelling = (await review.getGenreReviewState(pool)).entries.find(e => e.kind === 'spelling'
      && e.spellings!.some(s => s.name === 'Alternative-Rock'));
    expect(spelling?.outcomes.map(o => o.label)).toEqual(expect.arrayContaining(['Keep "Alternative Rock"', 'Keep apart']));
    const keep = spelling!.spellings!.find(s => s.name === 'Alternative Rock')!;
    const other = spelling!.spellings!.find(s => s.name === 'Alternative-Rock')!;
    const decided = await review.decideGenreReview(pool, { key: spelling!.key, signature: spelling!.signature, outcomeId: `merge:${keep.id}` });
    expect(decided.summary).toMatch(/→ Alternative Rock$/);
    expect((await pool.query('SELECT merged_into FROM genres WHERE id = $1', [other.id])).rows[0].merged_into).toBe(keep.id);
    expect((await review.getGenreReviewState(pool)).entries.some(e => e.key === spelling!.key)).toBe(false);

    await review.undoGenreReviewDecision(pool, decided.decisionId);
    expect((await pool.query('SELECT merged_into FROM genres WHERE id = $1', [other.id])).rows[0].merged_into).toBeNull();
    expect((await review.getGenreReviewState(pool)).entries.some(e => e.kind === 'spelling'
      && e.spellings!.some(s => s.name === 'Alternative-Rock'))).toBe(true);
  });

  test('fusion gives every track a genre or leaves it unsorted, adds sound styles to genre-only tags, and builds album and artist profiles', async () => {
    const fusion = await import('../../services/genreTaxonomy/fusion');
    const styleOf = async (genre: string, name: string) => (await pool.query(
      'SELECT id, model_index FROM style WHERE genre = $1 AND name = $2', [genre, name])).rows[0] as { id: number; model_index: number };
    const [house, techno, hardRock, popRock, punk] = await Promise.all([
      styleOf('Electronic', 'House'), styleOf('Electronic', 'Techno'), styleOf('Rock', 'Hard Rock'), styleOf('Rock', 'Pop Rock'), styleOf('Rock', 'Punk')]);
    const artist = (await pool.query(`INSERT INTO artists (name) VALUES ('Fusion Artist') RETURNING id`)).rows[0].id;
    const tagged = (await pool.query(`INSERT INTO artists (name) VALUES ('Fusion Tagged Artist') RETURNING id`)).rows[0].id;
    const albumA = (await pool.query(`INSERT INTO albums (title, artist_name) VALUES ('Fusion A', 'Fusion Artist') RETURNING id`)).rows[0].id;
    const albumB = (await pool.query(`INSERT INTO albums (title, artist_name) VALUES ('Fusion B', 'Fusion Artist') RETURNING id`)).rows[0].id;
    const add = async (name: string, genres: string[] | null, opts: { artistId: string; albumId: string; scores?: Record<number, number>; simulated?: boolean }) => {
      await db.addTrack(track(name, genres));
      const id = idOf(name);
      await pool.query('UPDATE tracks SET artist_id = $2, album_id = $3 WHERE id = $1', [id, opts.artistId, opts.albumId]);
      if (opts.scores) {
        const scores = Array(400).fill(0.01);
        for (const [index, score] of Object.entries(opts.scores)) scores[Number(index)] = score;
        await pool.query('INSERT INTO track_features (track_id, is_simulated) VALUES ($1, $2)', [id, opts.simulated ?? false]);
        await pool.query(`INSERT INTO track_style_scores (track_id, scores, model, windows, genre_version) VALUES ($1, $2, 'test', '20,50,80', 1)`, [id, scores]);
      }
      return id;
    };
    // A style tag; a genre-only tag with a sound that leans Hard Rock, a bit
    // Pop Rock, too little Punk, and loud House (another genre: ignored).
    const styled = await add('fz-house', ['House'], { artistId: tagged, albumId: albumA });
    const rock = await add('fz-rock', ['Rock'], {
      artistId: artist, albumId: albumA, scores: { [hardRock.model_index]: 0.6, [popRock.model_index]: 0.3, [punk.model_index]: 0.1, [house.model_index]: 0.9 } });
    const simulatedRock = await add('fz-rock-sim', ['Rock'], { artistId: artist, albumId: albumA, scores: { [hardRock.model_index]: 0.9 }, simulated: true });
    // No tag: the artist's tags decide (Last.fm "electronic"), the sound picks styles.
    const untagged = await add('fz-untagged', null, { artistId: artist, albumId: albumB, scores: { [techno.model_index]: 0.7, [hardRock.model_index]: 0.8 } });
    await pool.query(`INSERT INTO artist_tags (artist_id, provider, tag, tag_key, raw_count, weight) VALUES ($1, 'lastfm', 'electronic', 'electronic', 100, 1)`, [artist]);
    // No tag, no artist tags, and too little library to trust the sound alone: Unsorted.
    const unsorted = await add('fz-unsorted', null, { artistId: tagged, albumId: albumB, scores: { [house.model_index]: 0.9 } });
    await taxonomy.runTagMapping(pool);

    const status = await fusion.runFusion(pool);
    expect(status.version).toBe(fusion.FUSION_VERSION);
    expect(status.byGenreSource.unsorted).toBeGreaterThanOrEqual(1);
    const rowsOf = async (id: string) => (await pool.query(
      `SELECT ts.genre, s.name AS style, ts.source, round(ts.strength::numeric, 2)::float AS strength FROM track_styles ts
       LEFT JOIN style s ON s.id = ts.style_id WHERE ts.track_id = $1 ORDER BY ts.genre, s.name NULLS FIRST`, [id])).rows;
    expect(await rowsOf(styled)).toEqual([
      { genre: 'Electronic', style: null, source: 'tag', strength: 1 }, { genre: 'Electronic', style: 'House', source: 'tag', strength: 1 }]);
    expect(await rowsOf(rock)).toEqual([
      { genre: 'Rock', style: null, source: 'tag', strength: 1 },
      { genre: 'Rock', style: 'Hard Rock', source: 'audio', strength: 0.48 },
      { genre: 'Rock', style: 'Pop Rock', source: 'audio', strength: 0.24 }]);
    expect(await rowsOf(simulatedRock)).toEqual([{ genre: 'Rock', style: null, source: 'tag', strength: 1 }]);
    expect(await rowsOf(untagged)).toEqual([
      { genre: 'Electronic', style: null, source: 'artist', strength: 0.6 },
      { genre: 'Electronic', style: 'Techno', source: 'audio', strength: 0.56 }]);
    expect(await rowsOf(unsorted)).toEqual([]);

    // Profiles: album A has 3 tracks (1 House); the artist's own tracks are
    // album A (2 Rock tracks) and album B (1 Electronic), each album counted once.
    const albumRow = (await pool.query(`SELECT share, tracks FROM album_styles WHERE album_id = $1 AND style_id = $2`, [albumA, house.id])).rows[0];
    expect(Number(albumRow.share)).toBeCloseTo(1 / 3);
    const artistRows = (await pool.query(
      `SELECT genre, style_id, share, albums, tracks FROM artist_styles WHERE artist_id = $1 AND style_id IS NULL ORDER BY genre`, [artist])).rows;
    expect(artistRows.map(r => [r.genre, Number(Number(r.share).toFixed(2)), r.albums, r.tracks]))
      .toEqual([['Electronic', 0.5, 1, 1], ['Rock', 0.5, 1, 2]]);

    // Hand corrections apply last, and an incremental run touches only its tracks.
    await pool.query(`INSERT INTO track_style_overrides (track_id, genre, style_id, action) VALUES
      ($1, 'Rock', $2, 'exclude'), ($3, 'Electronic', $4, 'add')`, [rock, hardRock.id, styled, techno.id]);
    await fusion.runFusion(pool, { trackIds: [rock, styled] });
    expect((await rowsOf(rock)).map(r => r.style)).toEqual([null, 'Pop Rock']);
    expect(await rowsOf(styled)).toContainEqual({ genre: 'Electronic', style: 'Techno', source: 'override', strength: 1 });
    expect(await rowsOf(untagged)).toHaveLength(2);
  });

  test('browse lists genres and styles from the fused results, finds styles by alias, and shows unsorted tracks and profiles', async () => {
    const browse = await import('../../services/browse.service');
    const none = { albums: async () => [], artists: async () => [] };
    const genres = await browse.listBrowseGenres(pool);
    const electronic = genres.genres.find(g => g.name === 'Electronic')!;
    expect(electronic.trackCount).toBeGreaterThanOrEqual(2);
    expect(electronic.styles.map(s => s.name)).toEqual(expect.arrayContaining(['House', 'Techno']));
    expect(genres.genres.some(g => g.hidden)).toBe(false);
    expect(genres.unsorted.trackCount).toBeGreaterThanOrEqual(1);

    const rock = (await browse.getBrowseGenre(pool, 'Rock', none))!;
    expect(rock.styles.find(s => s.name === 'Pop Rock')?.trackCount).toBeGreaterThanOrEqual(1);
    // fz-rock-sim (simulated) is Rock without a style.
    const noStyle = await browse.listBrowseTrackIds(pool, { genre: 'Rock', noStyle: true }, 0, 500);
    expect(noStyle.ids).toContain(idOf('fz-rock-sim'));
    expect(noStyle.ids).not.toContain(idOf('fz-rock'));
    expect(await browse.getBrowseGenre(pool, 'Polka', none)).toBeNull();

    const house = (await pool.query(`SELECT id FROM style WHERE genre = 'Electronic' AND name = 'House'`)).rows[0].id;
    const style = (await browse.getBrowseStyle(pool, house, none))!;
    expect(style.style).toMatchObject({ genre: 'Electronic', name: 'House' });
    const albums = await browse.listBrowseAlbumRows(pool, { styleId: house }, 0, 10);
    const fusionA = (await pool.query(`SELECT id FROM albums WHERE title = 'Fusion A'`)).rows[0].id;
    expect(albums.rows.map(r => r.albumId)).toContain(fusionA);

    // A tag that maps to a style finds it ("Deep House" is a style; the House tag is its own name).
    const results = await browse.searchBrowseStyles(pool, 'house');
    expect(results[0]).toMatchObject({ genre: 'Electronic', label: 'House · Electronic', matchedAlias: null });

    // Shuffle: a genre this small (under 15 tracks) plays whole, each track once.
    const rockIds = (await browse.listBrowseTrackIds(pool, { genre: 'Rock' }, 0, 500)).ids;
    expect(rockIds.length).toBeLessThan(15);
    const mix = await browse.pickBrowseMix(pool, { genre: 'Rock' });
    expect([...mix].sort()).toEqual([...rockIds].sort());
    expect(mix).toContain(idOf('fz-rock'));
    expect(await browse.pickBrowseMix(pool, { genre: 'Polka' })).toEqual([]);

    const unsorted = await browse.getBrowseUnsorted(pool);
    expect(unsorted.untaggedTrackCount).toBeGreaterThanOrEqual(1);
    const unsortedIds = await browse.listBrowseTrackIds(pool, { unsorted: true }, 0, 500);
    expect(unsortedIds.ids).toContain(idOf('fz-unsorted'));

    const artist = (await pool.query(`SELECT id FROM artists WHERE name = 'Fusion Artist'`)).rows[0].id;
    const profile = await browse.getArtistStyleProfile(pool, artist);
    expect(profile.entries.filter(e => e.styleId === null).map(e => e.genre).sort()).toEqual(['Electronic', 'Rock']);
    expect(profile.listenerTags).toEqual(['electronic']);
    expect((await browse.getAlbumStyleProfile(pool, fusionA)).entries.length).toBeGreaterThan(0);
  });

  test('rays show where each genre and style came from, the album and artist context, and hand corrections re-fuse the track', async () => {
    const { getTrackRays } = await import('../../services/trackRays.service');
    const fusion = await import('../../services/genreTaxonomy/fusion');
    const rock = idOf('fz-rock');
    // energy, brightness, percussiveness, pitch, instrumentalness, acousticness, danceability, tempo (extractor.py)
    await pool.query(`UPDATE track_features SET acoustic_vector_8d = '[0.8,0.5,0.4,0.5,0.1,0.2,0.6,0.6]', bpm = 120 WHERE track_id = $1`, [rock]);
    let rays = (await getTrackRays(pool, rock))!;
    expect(rays.sound).toMatchObject({ energy: 0.8, brightness: 0.5, percussiveness: 0.4, instrumentalness: 0.1, acousticness: 0.2, danceability: 0.6, bpm: 120 });
    // The genre mix splits the summed scores: it adds up to the whole, largest first.
    const mix = rays.sound!.genreMix;
    expect(mix.reduce((n, g) => n + g.share, 0)).toBeCloseTo(1, 5);
    expect(mix[0].share).toBeGreaterThanOrEqual(mix[mix.length - 1].share);
    expect(rays.tags).toEqual(['Rock']);
    expect(rays.styles[0]).toMatchObject({ genre: 'Rock', styleId: null, source: 'tag', fromTags: ['Rock'] });
    // Hard Rock was excluded by hand in the fusion test; Pop Rock comes from the sound.
    expect(rays.styles.map(r => `${r.style}:${r.source}`)).toEqual(['null:tag', 'Pop Rock:audio']);
    expect(rays.sound!.closestStyles.map(s => s.style).slice(0, 3)).toEqual(['House', 'Hard Rock', 'Pop Rock']);
    expect(rays.album?.title).toBe('Fusion A');
    expect(rays.otherAlbums).toEqual([]);
    expect(rays.artist).toMatchObject({ name: 'Fusion Artist', listenerTags: ['electronic'] });
    expect(await getTrackRays(pool, 'no-such-track')).toBeNull();

    // Hard Rock is excluded by hand: adding it lifts the exclusion, and the sound's Hard Rock returns.
    const hardRock = (await pool.query(`SELECT id FROM style WHERE genre = 'Rock' AND name = 'Hard Rock'`)).rows[0].id;
    await fusion.setTrackStyleOverride(pool, { trackId: rock, genre: 'Rock', styleId: hardRock, action: 'add' });
    rays = (await getTrackRays(pool, rock))!;
    expect(rays.styles.find(r => r.style === 'Hard Rock')?.source).toBe('audio');
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM track_style_overrides WHERE track_id = $1 AND style_id = $2', [rock, hardRock])).rows[0].n).toBe(0);

    // Removing a style the sound gave writes an exclusion; adding a new one writes an addition, and removing that takes it back.
    await fusion.setTrackStyleOverride(pool, { trackId: rock, genre: 'Rock', styleId: hardRock, action: 'remove' });
    expect((await getTrackRays(pool, rock))!.styles.some(r => r.style === 'Hard Rock')).toBe(false);
    const punk = (await pool.query(`SELECT id FROM style WHERE genre = 'Rock' AND name = 'Punk'`)).rows[0].id;
    await fusion.setTrackStyleOverride(pool, { trackId: rock, genre: 'Rock', styleId: punk, action: 'add' });
    expect((await getTrackRays(pool, rock))!.styles.find(r => r.style === 'Punk')?.source).toBe('override');
    await fusion.setTrackStyleOverride(pool, { trackId: rock, genre: 'Rock', styleId: punk, action: 'remove' });
    expect((await getTrackRays(pool, rock))!.styles.some(r => r.style === 'Punk')).toBe(false);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM track_style_overrides WHERE track_id = $1 AND style_id = $2', [rock, punk])).rows[0].n).toBe(0);

    await expect(fusion.setTrackStyleOverride(pool, { trackId: rock, genre: 'Rock', styleId: 92, action: 'add' }))
      .rejects.toThrow('No such genre or style.');
  });

  test('rays bill the track\'s artists first: the main act as artist, a "feat." name as featured', async () => {
    const { getTrackRays } = await import('../../services/trackRays.service');
    await db.addTrack({ ...track('t-feat', ['Pop']), artist: 'Fusion Artist feat. Guest Singer', artists: ['Fusion Artist', 'Guest Singer'] } as never);
    const id = idOf('t-feat');
    const guest = (await pool.query(`INSERT INTO artists (name) VALUES ('Guest Singer') RETURNING id`)).rows[0].id;
    const credits = (await getTrackRays(pool, id))!.credits.filter(c => c.role === 'artist' || c.role === 'featured');
    const fusion = (await pool.query(`SELECT id FROM artists WHERE name = 'Fusion Artist'`)).rows[0].id;
    expect(credits).toEqual([
      { role: 'artist', artistId: fusion, name: 'Fusion Artist', detail: null, imageUrl: null },
      { role: 'featured', artistId: guest, name: 'Guest Singer', detail: null, imageUrl: null },
    ]);

    // In context: the featured artist, then a remixer; the track's own
    // artist has its own card, and a person with two roles shows once.
    await pool.query('UPDATE tracks SET artist_id = $1 WHERE id = $2', [fusion, id]);
    const remixer = (await pool.query(`INSERT INTO artists (name) VALUES ('Remix Person') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO track_artist_credits (track_id, artist_id, role, position) VALUES ($1, $2, 'remixer', 0), ($1, $3, 'remixer', 1), ($1, $4, 'remixer', 2)`,
      [id, remixer, guest, fusion]);
    expect((await getTrackRays(pool, id))!.otherArtists.map(a => `${a.role}:${a.name}`))
      .toEqual(['featured:Guest Singer', 'remixer:Remix Person']);

    // Without a library artist of that name the credit stays, unlinked.
    await db.addTrack({ ...track('t-feat-2', ['Pop']), artist: 'Fusion Artist feat. Nobody Known', artists: ['Fusion Artist', 'Nobody Known'] } as never);
    const unknown = (await getTrackRays(pool, idOf('t-feat-2')))!.credits.find(c => c.name === 'Nobody Known');
    expect(unknown).toMatchObject({ role: 'featured', artistId: null });
    // ...and has no In context card: no page, no profile.
    await pool.query('UPDATE tracks SET artist_id = $1 WHERE id = $2', [fusion, idOf('t-feat-2')]);
    expect((await getTrackRays(pool, idOf('t-feat-2')))!.otherArtists).toEqual([]);
  });
  test('style centroids come from tagged tracks only, and say what sounds close to a style and a track', async () => {
    const { stylesNearStyle, nearTrack, CENTROID_MIN_TRACKS } = await import('../../services/genreTaxonomy/centroids');
    const fusion = await import('../../services/genreTaxonomy/fusion');
    // 1280-d embeddings: Grunge and Punk share half their direction, Techno none.
    const vec = (from: number, jitter: number) => {
      const v = Array(1280).fill(0);
      for (let i = from; i < from + 10; i++) v[i] = 1;
      v[1000 + jitter] = 0.2;
      return `[${v.join(',')}]`;
    };
    const artists = await Promise.all(['C One', 'C Two', 'C Three', 'C Four'].map(async n =>
      (await pool.query('INSERT INTO artists (name) VALUES ($1) RETURNING id', [n])).rows[0].id as string));
    let n = 0;
    const addTagged = async (name: string, tag: string, base: number, artistId: string, opts: { simulated?: boolean; title?: string } = {}) => {
      await db.addTrack({ ...track(name, [tag]), title: opts.title ?? name } as never);
      const id = idOf(name);
      await pool.query('UPDATE tracks SET artist_id = $2 WHERE id = $1', [id, artistId]);
      await pool.query('INSERT INTO track_features (track_id, embedding_vector, is_simulated) VALUES ($1, $2, $3)', [id, vec(base, n++ % 200), opts.simulated ?? false]);
      return id;
    };
    for (let i = 0; i < CENTROID_MIN_TRACKS; i++) {
      await addTagged(`c-grunge-${i}`, 'Grunge', 0, artists[i % 3]);
      await addTagged(`c-punk-${i}`, 'Punk', 5, artists[i % 3]);
      await addTagged(`c-techno-${i}`, 'Techno', 100, artists[i % 3]);
    }
    // One short of a centroid, and one artist only: no centroid either way.
    for (let i = 0; i < CENTROID_MIN_TRACKS - 1; i++) await addTagged(`c-grind-${i}`, 'Grindcore', 0, artists[i % 3]);
    for (let i = 0; i < CENTROID_MIN_TRACKS; i++) await addTagged(`c-sludge-${i}`, 'Sludge Metal', 0, artists[3]);
    // A simulated Grunge track far from the rest must not move the centroid.
    await addTagged('c-grunge-sim', 'Grunge', 100, artists[0], { simulated: true });
    // Two versions of one song, near Grunge: "Sounds close to" keeps one.
    await addTagged('c-version-a', 'Alternative Rock', 0, artists[3], { title: 'Same Song' });
    await addTagged('c-version-b', 'Alternative Rock', 0, artists[3], { title: 'Same Song (Live)' });
    await taxonomy.runTagMapping(pool);
    await fusion.runFusion(pool);

    const centroids = (await pool.query(`
      SELECT s.name, c.tracks, c.artists, c.p90_distance FROM style_centroids c JOIN style s ON s.id = c.style_id ORDER BY s.name`)).rows;
    expect(centroids.map(c => c.name)).toEqual(['Grunge', 'Punk', 'Techno']);
    expect(centroids[0]).toMatchObject({ tracks: CENTROID_MIN_TRACKS, artists: 3 });
    expect(centroids[0].p90_distance).toBeGreaterThan(0);
    expect(centroids[0].p90_distance).toBeLessThan(0.1);

    const styleId = async (name: string) => (await pool.query('SELECT id FROM style WHERE name = $1', [name])).rows[0].id as number;
    const near = await stylesNearStyle(pool, await styleId('Grunge'));
    expect(near.map(s => `${s.genre} › ${s.name}`)).toEqual(['Rock › Punk', 'Electronic › Techno']);
    expect(near[0].trackCount).toBe(CENTROID_MIN_TRACKS);
    expect(await stylesNearStyle(pool, await styleId('Grindcore'))).toEqual([]);

    // A Grunge track: its own style left out, Punk nearest; its neighbours
    // two per artist, one version of a song, nearest first.
    const probe = (await nearTrack(pool, idOf('c-grunge-0')))!;
    expect(probe.styles.map(s => s.name)).toEqual(['Punk', 'Techno']);
    const titles = (await pool.query('SELECT id, title, artist_id FROM tracks WHERE id = ANY($1)', [probe.trackIds])).rows;
    const byArtist = new Map<string, number>();
    for (const t of titles) byArtist.set(t.artist_id, (byArtist.get(t.artist_id) || 0) + 1);
    expect(Math.max(...byArtist.values())).toBe(2);
    expect(titles.filter(t => t.title.startsWith('Same Song'))).toHaveLength(1);
    expect(probe.trackIds).not.toContain(idOf('c-grunge-0'));
    expect(await nearTrack(pool, idOf('c-grunge-sim'))).toBeNull();
  });
  test('fusion v2: the sound adds clear styles to tagged tracks and disputes tags it contradicts, for review', async () => {
    const fusion = await import('../../services/genreTaxonomy/fusion');
    const { listDisputedStyles } = await import('../../services/genreTaxonomy/disputed');
    const styleOf = async (genre: string, name: string) => (await pool.query(
      'SELECT id, model_index FROM style WHERE genre = $1 AND name = $2', [genre, name])).rows[0] as { id: number; model_index: number };
    const [grunge, punk, hardRock, techno] = await Promise.all([
      styleOf('Rock', 'Grunge'), styleOf('Rock', 'Punk'), styleOf('Rock', 'Hard Rock'), styleOf('Electronic', 'Techno')]);
    const vec = (from: number, jitter: number | null) => {
      const v = Array(1280).fill(0);
      for (let i = from; i < from + 10; i++) v[i] = 1;
      if (jitter !== null) v[1000 + jitter] = 0.2;
      return `[${v.join(',')}]`;
    };
    const artists = await Promise.all(['V2 One', 'V2 Two', 'V2 Three'].map(async n =>
      (await pool.query('INSERT INTO artists (name) VALUES ($1) RETURNING id', [n])).rows[0].id as string));
    let n = 0;
    const add = async (name: string, tag: string, scores: Record<number, number>, base = 0, exact = false) => {
      await db.addTrack(track(name, [tag]));
      const id = idOf(name);
      const all = Array(400).fill(0.01);
      for (const [index, score] of Object.entries(scores)) all[Number(index)] = score;
      await pool.query('UPDATE tracks SET artist_id = $2 WHERE id = $1', [id, artists[n % 3]]);
      await pool.query('INSERT INTO track_features (track_id, embedding_vector) VALUES ($1, $2)', [id, vec(base, exact ? (n++, null) : n++ % 200)]);
      await pool.query(`INSERT INTO track_style_scores (track_id, scores, model, windows, genre_version) VALUES ($1, $2, 'test', '20,50,80', 1)`, [id, all]);
      return id;
    };
    // Enough Grunge-tagged tracks that sound like Grunge for the sound to be trusted on Rock.
    for (let i = 0; i < 60; i++) await add(`v2-grunge-${i}`, 'Grunge', { [grunge.model_index]: 0.6 });
    // In the tagged genre: Punk at 0.35 joins, Hard Rock at 0.2 does not.
    const inGenre = await add('v2-in-genre', 'Grunge', { [grunge.model_index]: 0.6, [punk.model_index]: 0.35, [hardRock.model_index]: 0.2 });
    // Another genre the sound isn't trusted on (Electronic, too few tracks here): nothing joins.
    const untrusted = await add('v2-untrusted', 'Grunge', { [grunge.model_index]: 0.6, [techno.model_index]: 0.9 });
    // A Techno tag, but the sound is clearly Grunge, and Rock is trusted: Grunge and Rock join.
    const otherGenre = await add('v2-other-genre', 'Techno', { [grunge.model_index]: 0.7 });
    // Tagged Grunge, scores nothing for it and sounds far away: disputed. Near the centroid: not.
    const far = await add('v2-far', 'Grunge', { [grunge.model_index]: 0.001 }, 300);
    const near = await add('v2-near', 'Grunge', { [grunge.model_index]: 0.001 }, 0, true);
    await taxonomy.runTagMapping(pool);
    const status = await fusion.runFusion(pool);
    expect(status.audioGenres).toContain('Rock');
    expect(status.audioGenres).not.toContain('Electronic');

    const rows = async (id: string) => (await pool.query(`
      SELECT ts.genre, s.name AS style, ts.source, ts.disputed FROM track_styles ts LEFT JOIN style s ON s.id = ts.style_id
      WHERE ts.track_id = $1 ORDER BY ts.genre, s.name NULLS FIRST`, [id])).rows;
    expect((await rows(inGenre)).map(r => `${r.style}:${r.source}`)).toEqual(['null:tag', 'Grunge:tag', 'Punk:audio']);
    expect((await rows(untrusted)).map(r => r.genre)).not.toContain('Electronic');
    expect((await rows(otherGenre)).map(r => `${r.genre}/${r.style}:${r.source}`)).toEqual([
      'Electronic/null:tag', 'Electronic/Techno:tag', 'Rock/null:audio', 'Rock/Grunge:audio']);

    expect((await rows(far)).find(r => r.style === 'Grunge')?.disputed).toBe(true);
    expect((await rows(near)).find(r => r.style === 'Grunge')?.disputed).toBe(false);
    const listed = await listDisputedStyles(pool);
    expect(listed.items.map(i => i.trackId)).toEqual([far]);
    expect(listed.items[0].styles).toEqual([expect.objectContaining({ genre: 'Rock', style: 'Grunge', fromTags: ['Grunge'] })]);
    expect(listed).toMatchObject({ total: 1, styles: 1 });
    expect(status.disputed).toBe(1);

    // Keep: an add override; the tag is never disputed again.
    await fusion.setTrackStyleOverride(pool, { trackId: far, genre: 'Rock', styleId: grunge.id, action: 'add' });
    expect((await rows(far)).find(r => r.style === 'Grunge')).toMatchObject({ source: 'override', disputed: false });
    expect((await listDisputedStyles(pool)).total).toBe(0);
  });
  test('track origin: one country and language per track, from the artist, its place tags, then the file', async () => {
    const { backfillArtistCountries, rebuildTrackOrigin } = await import('../../services/trackOrigin.service');
    const artist = async (name: string, cols: { country?: string; area?: string } = {}) => (await pool.query(
      'INSERT INTO artists (name, country, area) VALUES ($1, $2, $3) RETURNING id', [name, cols.country ?? null, cols.area ?? null])).rows[0].id as string;
    const mbDane = await artist('O Dane', { country: 'DK' });
    const english = await artist('O English', { area: 'England' });
    const tagged = await artist('O Tagged');
    const nowhere = await artist('O Nowhere');
    await pool.query(`INSERT INTO artist_tags (artist_id, provider, tag, tag_key, raw_count, weight) VALUES
      ($1, 'lastfm', 'dansk', 'dansk', 60, 0.6), ($1, 'lastfm', 'electronic', 'electronic', 100, 1),
      ($2, 'lastfm', 'indie', 'indie', 100, 1)`, [tagged, nowhere]);
    const add = async (name: string, artistId: string, file: { releaseCountry?: string; lyricsLanguage?: string }) => {
      await db.addTrack({ ...track(name, null), originRead: true, ...file } as never);
      await pool.query('UPDATE tracks SET artist_id = $2 WHERE id = $1', [idOf(name), artistId]);
      return idOf(name);
    };
    const a = await add('o-mb', mbDane, { releaseCountry: 'US', lyricsLanguage: 'dan' });
    const b = await add('o-area', english, { lyricsLanguage: 'zxx' });
    const c = await add('o-tags', tagged, { releaseCountry: 'XE' });
    const d = await add('o-release', nowhere, { releaseCountry: 'SE', lyricsLanguage: 'swe' });
    const e = await add('o-europe', nowhere, { releaseCountry: 'XE' });

    expect(await backfillArtistCountries(pool)).toBeGreaterThanOrEqual(1);
    await rebuildTrackOrigin(pool);
    const origin = async (id: string) => (await pool.query(
      'SELECT country, country_source, language, language_source FROM track_origin WHERE track_id = $1', [id])).rows[0] ?? null;
    // MusicBrainz's country beats the release country; the file says Danish.
    expect(await origin(a)).toEqual({ country: 'DK', country_source: 'artist', language: 'da', language_source: 'file' });
    // An area that names a UK nation is the UK; "no lyrics" is no language.
    expect(await origin(b)).toEqual({ country: 'GB', country_source: 'artist', language: null, language_source: null });
    // No MusicBrainz country: the artist's place tag ("dansk"); Europe (XE) isn't a country.
    expect(await origin(c)).toMatchObject({ country: 'DK', country_source: 'artist-tags' });
    // Nothing on the artist ("indie" is no place): the release country, the weakest hint.
    expect(await origin(d)).toEqual({ country: 'SE', country_source: 'release', language: 'sv', language_source: 'file' });
    expect(await origin(e)).toBeNull();

    // Browse narrows by country: the tracks of a filter, and the countries it offers.
    const browse = await import('../../services/browse.service');
    await pool.query(`INSERT INTO track_styles (track_id, genre, style_id, source, strength, confidence, fusion_version)
      SELECT id, 'Hip Hop', NULL, 'tag', 1, 1, 2 FROM tracks WHERE id = ANY($1)`, [[a, b, c, d]]);
    expect((await browse.listBrowseTrackIds(pool, { genre: 'Hip Hop', country: 'DK' }, 0, 50)).ids.sort()).toEqual([a, c].sort());

    // A rescan that finds the tag removed clears it; one that couldn't read the file keeps it.
    await db.addTrack({ ...track('o-release', null), originRead: true, releaseCountry: null, lyricsLanguage: 'swe' } as never);
    await pool.query('UPDATE tracks SET artist_id = $2 WHERE id = $1', [d, nowhere]);
    await db.addTrack({ ...track('o-mb', null) } as never);
    await pool.query('UPDATE tracks SET artist_id = $2 WHERE id = $1', [a, mbDane]);
    await rebuildTrackOrigin(pool, [a, d]);
    expect(await origin(d)).toEqual({ country: null, country_source: null, language: 'sv', language_source: 'file' });
    expect((await pool.query('SELECT release_country, lyrics_language FROM tracks WHERE id = $1', [a])).rows[0])
      .toEqual({ release_country: 'US', lyrics_language: 'dan' });
  });
  test('track origin: the year, decade, vocals and moods, from the file first and then the artist\'s tags', async () => {
    const { rebuildTrackOrigin } = await import('../../services/trackOrigin.service');
    const singer = (await pool.query(`INSERT INTO artists (name) VALUES ('D Singer') RETURNING id`)).rows[0].id as string;
    const band = (await pool.query(`INSERT INTO artists (name) VALUES ('D Band') RETURNING id`)).rows[0].id as string;
    await pool.query(`INSERT INTO artist_tags (artist_id, provider, tag, tag_key, raw_count, weight) VALUES
      ($1, 'lastfm', 'female vocalists', 'female vocalists', 80, 0.8), ($1, 'lastfm', 'chillout', 'chillout', 40, 0.4),
      ($1, 'lastfm', 'sad', 'sad', 20, 0.2), ($1, 'lastfm', '80s', '80s', 50, 0.5), ($1, 'lastfm', 'dansk rap', 'dansk rap', 30, 0.3),
      ($2, 'lastfm', 'male vocalists', 'male vocalists', 7, 0.07), ($2, 'lastfm', 'party', 'party', 3, 0.03)`, [singer, band]);
    const add = async (name: string, artistId: string, file: Record<string, unknown>) => {
      await db.addTrack({ ...track(name, null), originRead: true, ...file } as never);
      await pool.query('UPDATE tracks SET artist_id = $2 WHERE id = $1', [idOf(name), artistId]);
      return idOf(name);
    };
    // A 2021 remaster of a 1991 song is 1991; a track with no year takes the artist's era.
    const remaster = await add('d-remaster', singer, { year: 2021, originalYear: 1991 });
    const undated = await add('d-undated', singer, { year: null });
    const plain = await add('d-plain', band, { year: 2004 });
    await rebuildTrackOrigin(pool);
    const row = async (id: string) => (await pool.query(
      'SELECT country, country_source, year, decade, year_source, vocals, moods FROM track_origin WHERE track_id = $1', [id])).rows[0];
    expect(await row(remaster)).toEqual({
      country: 'DK', country_source: 'artist-tags', year: 1991, decade: 1990, year_source: 'original',
      vocals: ['female'], moods: ['chill', 'melancholic'] });
    expect(await row(undated)).toMatchObject({ year: null, decade: 1980, year_source: 'artist-tags' });
    // Last.fm weighs "male vocalists" low but it counts; a mood that faint does not.
    expect(await row(plain)).toMatchObject({ year: 2004, decade: 2000, year_source: 'file', vocals: ['male'], moods: null });

    // Browse narrows by decade (the effective one), vocals and mood.
    const browse = await import('../../services/browse.service');
    await pool.query(`INSERT INTO track_styles (track_id, genre, style_id, source, strength, confidence, fusion_version)
      SELECT id, 'Pop', NULL, 'tag', 1, 1, 2 FROM tracks WHERE id = ANY($1)`, [[remaster, undated, plain]]);
    const ids = async (filter: object) => (await browse.listBrowseTrackIds(pool, { genre: 'Pop', ...filter }, 0, 50)).ids.sort();
    expect(await ids({ decade: 1990 })).toEqual([remaster]);
    expect(await ids({ decade: 1980 })).toEqual([undated]);
    expect(await ids({ vocals: 'female' })).toEqual([remaster, undated].sort());
    expect(await ids({ mood: 'chill', vocals: 'female', decade: 1990 })).toEqual([remaster]);
  });

  test('style vectors (the phase 4 engine): from fused memberships, and from genre names through the tag mapping', async () => {
    const { styleVectors, styleVectorForNames, styleCosine, seedStyleVector } = await import('../../services/styleOverlap.service');
    const grungeId = (await pool.query(`SELECT id FROM style WHERE genre = 'Rock' AND name = 'Grunge'`)).rows[0].id;
    const vectors = await styleVectors(pool, [idOf('v2-grunge-0'), idOf('v2-other-genre'), 'no-such-track']);
    const grunge = vectors.get(idOf('v2-grunge-0'))!;
    // Its style counts in full, its genre at half; normalised.
    expect([...grunge.keys()].sort()).toEqual(['gRock', `s${grungeId}`]);
    expect(grunge.get(`s${grungeId}`)! / grunge.get('gRock')!).toBeCloseTo(2);
    expect(vectors.has('no-such-track')).toBe(false);
    // A Techno-tagged track that sounds like Grunge shares some of it.
    const overlap = styleCosine(grunge, vectors.get(idOf('v2-other-genre')));
    expect(overlap).toBeGreaterThan(0.3);
    expect(overlap).toBeLessThan(1);
    // Names as the old engine and AI prompts write them map through tag_map.
    expect(styleCosine(grunge, await styleVectorForNames(pool, ['rock.alternative rock.grunge']))).toBeCloseTo(1);
    expect(styleCosine(grunge, await styleVectorForNames(pool, ['Rock']))).toBeGreaterThan(0.4);
    expect(await styleVectorForNames(pool, ['no such genre'])).toBeNull();
    expect(styleCosine(grunge, await seedStyleVector(pool, [idOf('v2-other-genre'), idOf('v2-grunge-1')]))).toBeGreaterThan(overlap);
  });

  test('genre paths (phase 4): tracks, names, banned names and artists map onto the fused genres and styles', async () => {
    const paths = await import('../../services/genreTaxonomy/paths');
    const { getLibraryProfile, clearLibraryProfileCache } = await import('../../services/libraryProfile.service');
    paths.clearGenrePathCache();
    const styleId = async (genre: string, name: string) => (await pool.query('SELECT id FROM style WHERE genre = $1 AND name = $2', [genre, name])).rows[0].id;
    const punk = await styleId('Rock', 'Punk');
    const artist = (await pool.query(`INSERT INTO artists (name) VALUES ('Paths Artist') RETURNING id`)).rows[0].id;
    for (const name of ['p-punk', 'p-pop']) {
      await db.addTrack(track(name, null));
      await pool.query('UPDATE tracks SET artist_id = $2 WHERE id = $1', [idOf(name), artist]);
      await pool.query(`INSERT INTO track_features (track_id, acoustic_vector_8d, is_simulated) VALUES ($1, '[0.5,0.5,0.5,0.5,0.5,0.5,0.5,0.5]', false)`, [idOf(name)]);
    }
    const member = (id: string, genre: string, style: number | null, strength: number) => pool.query(
      `INSERT INTO track_styles (track_id, genre, style_id, source, strength, confidence, fusion_version) VALUES ($1, $2, $3, 'override', $4, 1, 2)`,
      [id, genre, style, strength]);
    await member(idOf('p-punk'), 'Rock', punk, 0.9);
    await member(idOf('p-punk'), 'Pop', null, 0.5);
    await member(idOf('p-pop'), 'Pop', null, 0.8);
    await pool.query(`INSERT INTO artist_styles (artist_id, genre, style_id, share, albums, tracks, fusion_version)
      VALUES ($1, 'Rock', $2, 0.5, 1, 1, 2), ($1, 'Pop', NULL, 1, 1, 2, 2), ($1, 'Rock', NULL, 0.5, 1, 1, 2)`, [artist, punk]);

    // Names as the AI writes them.
    expect(await paths.resolveGenrePaths(pool, 'Deep House')).toEqual(['electronic.deep house']);
    expect((await paths.resolveGenrePaths(pool, 'trip hop')).sort()).toEqual(['electronic.trip hop', 'hip hop.trip hop']);
    expect(await paths.resolveGenrePaths(pool, 'Hip Hop')).toEqual(['hip hop']);
    expect(await paths.resolveGenrePaths(pool, 'electronic.house')).toEqual(['electronic.house']);
    expect(await paths.resolveGenrePaths(pool, 'P.Funk')).toEqual(['funk / soul.p funk']);
    expect(await paths.resolveGenrePaths(pool, 'no such genre')).toEqual([]);
    // Banned names: a family word bans every style ending in it, never the whole genre.
    const metal = await paths.resolveBannedPaths(pool, ['metal']);
    expect(metal).toEqual(expect.arrayContaining(['rock.heavy metal', 'rock.death metal', 'rock.doom metal']));
    expect(metal).not.toContain('rock');
    expect(await paths.resolveBannedPaths(pool, ['Rock'])).toEqual(['rock']);

    // A track's paths: one per membership, the strongest first.
    const rows = (await pool.query(`SELECT t.id, tgp.genre_path, tgp.genre_paths FROM tracks t ${paths.trackGenrePathsJoin('t')} WHERE t.id = ANY($1) ORDER BY t.title`,
      [[idOf('p-punk'), idOf('p-pop'), idOf('t-untagged')]])).rows;
    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get(idOf('p-punk'))).toMatchObject({ genre_path: 'rock.punk', genre_paths: ['rock.punk', 'pop'] });
    expect(byId.get(idOf('p-pop'))).toMatchObject({ genre_path: 'pop', genre_paths: ['pop'] });
    const matching = async (prefixes: string[]) => (await pool.query(
      `SELECT t.id FROM tracks t ${paths.trackGenrePathsJoin('t')} WHERE t.id = ANY($1) AND ${paths.pathsMatchSql('$2')} ORDER BY t.id`,
      [[idOf('p-punk'), idOf('p-pop')], prefixes])).rows.map(r => r.id);
    expect(await matching(['rock'])).toEqual([idOf('p-punk')]);
    expect(await matching(['pop'])).toEqual([idOf('p-punk'), idOf('p-pop')].sort());
    expect(await matching(['rock.pu'])).toEqual([]);
    expect(paths.isRowBanned(byId.get(idOf('p-punk')), await paths.resolveBannedPaths(pool, ['punk']))).toBe(true);
    expect(paths.isRowBanned(byId.get(idOf('p-pop')), await paths.resolveBannedPaths(pool, ['punk']))).toBe(false);

    // Artist radio: the strongest style, then the rest, and the genre of the strongest.
    expect(await paths.artistGenrePaths(pool, artist)).toEqual({ primaryPath: 'rock.punk', adjacentPaths: ['pop', 'rock'], rootPath: 'rock' });
    // The AI's vocabulary: the library's genres first, then its styles.
    const vocabulary = await paths.getStyleVocabulary(pool);
    expect(vocabulary.indexOf('Rock')).toBeLessThan(vocabulary.indexOf('Punk'));
    expect(vocabulary).not.toContain('Gabber');
    // Genre health counts a track under its genre and each of its styles.
    clearLibraryProfileCache();
    const profile = await getLibraryProfile();
    expect(profile.genreHealth.get('rock.punk')?.trackCount).toBeGreaterThanOrEqual(1);
    expect(profile.genreHealth.get('pop')!.trackCount).toBeGreaterThanOrEqual(2);
    expect(profile.genreHealth.get('rock')!.trackCount).toBeGreaterThanOrEqual(profile.genreHealth.get('rock.punk')!.trackCount);
  });

  test('track genres (phase 4): derived from the fused genres and styles, kept through rescans, and the only genres listed', async () => {
    const { rebuildTrackGenres } = await import('../../services/genreTaxonomy/trackGenres');
    // A spelling row named like a taxonomy genre, grouped under another spelling.
    const other = (await pool.query(`INSERT INTO genres (name) VALUES ('Pop Music') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO genres (name, merged_into) VALUES ('Pop', $1) ON CONFLICT (name) DO UPDATE SET merged_into = $1`, [other]);
    const ids = [idOf('p-punk'), idOf('p-pop'), idOf('t-untagged')];
    expect(await rebuildTrackGenres(pool, ids)).toBe(2);
    const genresOf = async (id: string) => (await pool.query(
      `SELECT g.name FROM track_genres tg JOIN genres g ON g.id = tg.genre_id WHERE tg.track_id = $1 ORDER BY tg.position`, [id])).rows.map(r => r.name);
    // Styles first, strongest first, then genres; position 0 is genre_id.
    expect(await genresOf(idOf('p-punk'))).toEqual(['Punk', 'Pop']);
    expect(await genresOf(idOf('p-pop'))).toEqual(['Pop']);
    expect(await genresOf(idOf('t-untagged'))).toEqual([]);
    const primary = async (id: string) => (await pool.query(
      'SELECT g.name FROM tracks t LEFT JOIN genres g ON g.id = t.genre_id WHERE t.id = $1', [id])).rows[0].name;
    expect(await primary(idOf('p-punk'))).toBe('Punk');
    expect(await primary(idOf('t-untagged'))).toBeNull();
    // "Pop" names a genre now, so it is no longer a spelling of "Pop Music".
    expect((await pool.query(`SELECT merged_into FROM genres WHERE name = 'Pop'`)).rows[0].merged_into).toBeNull();

    // A rescan records the file's tags but leaves the derived genres alone.
    await db.addTrack({ ...track('p-punk', ['Skate Punk']), artist: 'Taxonomy Artist' });
    expect(await genresOf(idOf('p-punk'))).toEqual(['Punk', 'Pop']);
    expect(await primary(idOf('p-punk'))).toBe('Punk');
    expect((await pool.query('SELECT tag FROM track_tags WHERE track_id = $1', [idOf('p-punk')])).rows.map(r => r.tag)).toEqual(['Skate Punk']);

    // Genre lists (the app, API v1, Subsonic) show genres with tracks only;
    // tag spellings stay for the review but aren't listed or purged.
    const listed = (await db.getAllGenres()).map((g: any) => g.name);
    expect(listed).toEqual(expect.arrayContaining(['Punk', 'Pop']));
    expect(listed).not.toContain('Skate Punk');
    expect((await db.getGenresPage({ limit: 200 })).map((g: any) => g.name)).not.toContain('Skate Punk');
    await db.purgeOrphanedEntities();
    expect((await pool.query(`SELECT 1 FROM genres WHERE name = 'Skate Punk'`)).rowCount).toBe(1);
  });
});
