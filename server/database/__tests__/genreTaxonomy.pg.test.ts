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
});
