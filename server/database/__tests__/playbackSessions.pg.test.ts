/**
 * @jest-environment node
 *
 * Contract tests for durable playback sessions against the real schema
 * (docs/playback_sessions.md, Phase 1). The session is meant to become the
 * source of truth for every client's queue, so each queue op, the revision
 * check and the ownership check are exercised through the service, and the
 * stored rows are checked as well as what the API returns.
 *
 * Gated on AURORA_DB_TESTS=1 like the other *.pg tests; with the gate on and
 * Postgres unreachable they FAIL rather than skip.
 */
import { Pool } from 'pg';

const ENABLED = process.env.AURORA_DB_TESTS === '1';
const describeDb = ENABLED ? describe : describe.skip;
const ADMIN = { user: process.env.DB_USER || 'musicuser', password: process.env.DB_PASSWORD || 'musicpass', host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432) };
const suffix = `${process.pid}_${Date.now().toString(36)}`;

const TRACK_COUNT = 2100;
const trackId = (n: number) => `dHJhY2s${n}`;
const trackIds = (from: number, count: number) => Array.from({ length: count }, (_, i) => trackId(from + i));

describeDb('playback sessions', () => {
  jest.setTimeout(120_000);
  const DB_NAME = `aurora_sessions_test_${suffix}`;
  let admin: Pool;
  let pool: Pool;
  let sessions: typeof import('../../services/playbackSession.service');
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    admin = new Pool({ ...ADMIN, database: 'postgres', connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    process.env.DB_NAME = DB_NAME;
    const db = await import('../index');
    pool = await db.initDB();
    sessions = await import('../../services/playbackSession.service');
    userId = (await db.createUser('listener', 'x', 'user')).id;
    otherUserId = (await db.createUser('other', 'x', 'user')).id;
    await pool.query(`
      INSERT INTO tracks (id, title, artist, album, path, duration)
      SELECT 'dHJhY2s' || n, 'Track ' || n, 'Artist', 'Album', '/music/' || n || '.flac', 180
      FROM generate_series(0, $1::int - 1) AS n
    `, [TRACK_COUNT]);
  });
  afterAll(async () => {
    try { if (pool) await pool.end(); } catch { /* already closed */ }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });
  beforeEach(async () => { await pool.query('DELETE FROM playback_sessions'); });

  const create = (ids: string[], currentIndex = 0, clientId = 'phone') => sessions.createPlaybackSession({
    userId, clientId, name: 'Listening', trackIds: ids, currentIndex, positionMs: 0,
  });
  const patch = (
    session: { id: string; revision: number },
    operations: import('../../../shared/api/v1').PlaybackSessionPatch['operations'],
    clientId = 'phone',
  ) => sessions.patchPlaybackSession({
    userId, clientId, sessionId: session.id, patch: { expectedRevision: session.revision, operations },
  });
  const storedRows = async (sessionId: string) => (await pool.query(
    'SELECT queue_entry_id, track_id, position FROM playback_session_entries WHERE session_id = $1 ORDER BY position',
    [sessionId],
  )).rows as Array<{ queue_entry_id: string; track_id: string; position: number }>;
  const trackOrder = (session: { queue: Array<{ track: { id: string } }> }) => session.queue.map((entry) => entry.track.id);
  const expectContiguous = (session: { queue: Array<{ position: number }> }) =>
    expect(session.queue.map((entry) => entry.position)).toEqual(session.queue.map((_, index) => index));

  it('creates a session with one entry per track, in order, starting at the chosen entry', async () => {
    const ids = [trackId(0), trackId(1), trackId(0)];
    const session = await create(ids, 1);
    expect(trackOrder(session)).toEqual(ids);
    expectContiguous(session);
    expect(new Set(session.queue.map((entry) => entry.queueEntryId)).size).toBe(3);
    expect(session.currentEntryId).toBe(session.queue[1].queueEntryId);
    expect(session.revision).toBe(1);
    expect((await storedRows(session.id)).map((row) => row.track_id)).toEqual(ids);
  });

  it('inserts, removes and moves entries while keeping every surviving entry ID', async () => {
    let session = await create(trackIds(0, 4));
    const [a, b, c, d] = session.queue.map((entry) => entry.queueEntryId);

    session = await patch(session, [{ type: 'insert', index: 1, trackIds: [trackId(10), trackId(11)] }]);
    expect(trackOrder(session)).toEqual([trackId(0), trackId(10), trackId(11), trackId(1), trackId(2), trackId(3)]);
    expect(session.revision).toBe(2);

    session = await patch(session, [{ type: 'remove', queueEntryIds: [c] }]);
    session = await patch(session, [{ type: 'move', queueEntryId: d, toIndex: 0 }]);
    expect(trackOrder(session)).toEqual([trackId(3), trackId(0), trackId(10), trackId(11), trackId(1)]);
    expect(session.queue.map((entry) => entry.queueEntryId)).toEqual(expect.arrayContaining([a, b, d]));
    expect(session.queue[0].queueEntryId).toBe(d);
    expectContiguous(session);
    expect((await storedRows(session.id)).map((row) => row.position)).toEqual([0, 1, 2, 3, 4]);
    expect(session.revision).toBe(4);
  });

  it('applies several operations in one patch, in order, as one revision', async () => {
    let session = await create(trackIds(0, 3));
    const second = session.queue[1].queueEntryId;
    session = await patch(session, [
      { type: 'insert', index: 3, trackIds: [trackId(20)] },
      { type: 'move', queueEntryId: second, toIndex: 3 },
      { type: 'setTransport', currentEntryId: second, positionMs: 1234, playbackState: 'playing' },
    ]);
    expect(trackOrder(session)).toEqual([trackId(0), trackId(2), trackId(20), trackId(1)]);
    expect(session.currentEntryId).toBe(second);
    expect(session.positionMs).toBe(1234);
    expect(session.playbackState).toBe('playing');
    expect(session.revision).toBe(2);
  });

  it('replaces the queue with fresh entry IDs and starts at the chosen index', async () => {
    let session = await create(trackIds(0, 3));
    const before = new Set(session.queue.map((entry) => entry.queueEntryId));
    session = await patch(session, [{ type: 'replaceQueue', trackIds: trackIds(5, 2), currentIndex: 1 }]);
    expect(trackOrder(session)).toEqual(trackIds(5, 2));
    expect(session.queue.some((entry) => before.has(entry.queueEntryId))).toBe(false);
    expect(session.currentEntryId).toBe(session.queue[1].queueEntryId);
    expect(await storedRows(session.id)).toHaveLength(2);
  });

  it('moves the current entry to the head of the queue when it is removed', async () => {
    let session = await create(trackIds(0, 3), 1);
    session = await patch(session, [{ type: 'setTransport', positionMs: 5000 }]);
    session = await patch(session, [{ type: 'remove', queueEntryIds: [session.currentEntryId!] }]);
    expect(session.currentEntryId).toBe(session.queue[0].queueEntryId);
    expect(session.positionMs).toBe(0);
  });

  it('resets the position when the current entry changes, and keeps it otherwise', async () => {
    let session = await create(trackIds(0, 2));
    session = await patch(session, [{ type: 'setTransport', positionMs: 9000 }]);
    session = await patch(session, [{ type: 'setTransport', currentEntryId: session.currentEntryId }]);
    expect(session.positionMs).toBe(9000);
    session = await patch(session, [{ type: 'setTransport', currentEntryId: session.queue[1].queueEntryId }]);
    expect(session.positionMs).toBe(0);
  });

  it('rewrites only the entries whose position changed', async () => {
    // xmin is the transaction that last wrote a row, so a row the write left
    // alone keeps it.
    const writers = async (sessionId: string) => new Map((await pool.query(
      'SELECT queue_entry_id, xmin::text AS xmin FROM playback_session_entries WHERE session_id = $1',
      [sessionId],
    )).rows.map((row) => [row.queue_entry_id as string, row.xmin as string]));
    const rewritten = (before: Map<string, string>, after: Map<string, string>) =>
      [...after].filter(([id, xmin]) => before.get(id) !== xmin).map(([id]) => id);

    let session = await create(trackIds(0, 6));
    const ids = session.queue.map((entry) => entry.queueEntryId);

    let before = await writers(session.id);
    session = await patch(session, [{ type: 'insert', index: 6, trackIds: trackIds(6, 2) }]);
    expect(rewritten(before, await writers(session.id))).toEqual(session.queue.slice(6).map((entry) => entry.queueEntryId));

    before = await writers(session.id);
    session = await patch(session, [{ type: 'insert', index: 4, trackIds: [trackId(8)] }]);
    expect(rewritten(before, await writers(session.id)).sort())
      .toEqual(session.queue.slice(4).map((entry) => entry.queueEntryId).sort());

    before = await writers(session.id);
    session = await patch(session, [{ type: 'move', queueEntryId: ids[2], toIndex: 3 }]);
    expect(rewritten(before, await writers(session.id)).sort()).toEqual([ids[2], ids[3]].sort());

    before = await writers(session.id);
    session = await patch(session, [{ type: 'setTransport', positionMs: 1000 }]);
    expect(rewritten(before, await writers(session.id))).toEqual([]);
    expectContiguous(session);
  });

  it('rejects a stale revision with the current session and changes nothing', async () => {
    const session = await create(trackIds(0, 2));
    const moved = await patch(session, [{ type: 'insert', index: 0, trackIds: [trackId(9)] }]);
    const stale = patch(session, [{ type: 'remove', queueEntryIds: [session.queue[0].queueEntryId] }]);
    await expect(stale).rejects.toBeInstanceOf(sessions.PlaybackSessionRevisionError);
    const error = await stale.catch((caught) => caught);
    expect(error.current.revision).toBe(moved.revision);
    expect(trackOrder(error.current)).toEqual(trackOrder(moved));
    expect((await storedRows(session.id)).map((row) => row.track_id)).toEqual(trackOrder(moved));
  });

  it('lets exactly one of two patches at the same revision win', async () => {
    const session = await create(trackIds(0, 2));
    const results = await Promise.allSettled([
      patch(session, [{ type: 'insert', index: 0, trackIds: [trackId(30)] }]),
      patch(session, [{ type: 'insert', index: 0, trackIds: [trackId(31)] }]),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(sessions.PlaybackSessionRevisionError);
    expect(await storedRows(session.id)).toHaveLength(3);
  });

  it('refuses unknown tracks and an unknown current entry without writing anything', async () => {
    const session = await create(trackIds(0, 2));
    await expect(patch(session, [
      { type: 'insert', index: 0, trackIds: [trackId(0)] },
      { type: 'insert', index: 0, trackIds: ['bm8tc3VjaC10cmFjaw'] },
    ])).rejects.toBeInstanceOf(sessions.PlaybackSessionTrackError);
    await expect(patch(session, [{ type: 'setTransport', currentEntryId: '00000000-0000-4000-8000-000000000000' }]))
      .rejects.toBeInstanceOf(sessions.PlaybackSessionTrackError);
    expect(await storedRows(session.id)).toHaveLength(2);
    expect((await sessions.getPlaybackSession(userId, session.id))!.revision).toBe(1);
    await expect(create(['bm8tc3VjaC10cmFjaw'])).rejects.toBeInstanceOf(sessions.PlaybackSessionTrackError);
  });

  it('allows only the owning client to patch or delete until a handoff', async () => {
    let session = await create(trackIds(0, 2));
    await expect(patch(session, [{ type: 'setTransport', playbackState: 'playing' }], 'tv'))
      .rejects.toBeInstanceOf(sessions.PlaybackSessionOwnershipError);
    await expect(sessions.deletePlaybackSession(userId, 'tv', session.id, session.revision))
      .rejects.toBeInstanceOf(sessions.PlaybackSessionOwnershipError);

    session = await sessions.handoffPlaybackSession({ userId, clientId: 'tv', sessionId: session.id, expectedRevision: session.revision });
    expect(session.ownerClientId).toBe('tv');
    session = await patch(session, [{ type: 'setTransport', playbackState: 'playing' }], 'tv');
    await expect(patch(session, [{ type: 'setTransport', playbackState: 'paused' }], 'phone'))
      .rejects.toBeInstanceOf(sessions.PlaybackSessionOwnershipError);

    await expect(sessions.deletePlaybackSession(userId, 'tv', session.id, session.revision - 1))
      .rejects.toBeInstanceOf(sessions.PlaybackSessionRevisionError);
    await sessions.deletePlaybackSession(userId, 'tv', session.id, session.revision);
    expect(await sessions.getPlaybackSession(userId, session.id)).toBeNull();
    expect(await storedRows(session.id)).toHaveLength(0);
  });

  it("keeps one user's sessions invisible to another", async () => {
    const session = await create(trackIds(0, 1));
    expect(await sessions.getPlaybackSession(otherUserId, session.id)).toBeNull();
    expect(await sessions.listPlaybackSessions(otherUserId)).toEqual([]);
    await expect(sessions.patchPlaybackSession({
      userId: otherUserId, clientId: 'phone', sessionId: session.id,
      patch: { expectedRevision: session.revision, operations: [{ type: 'setTransport', playbackState: 'playing' }] },
    })).rejects.toBeInstanceOf(sessions.PlaybackSessionNotFoundError);
  });

  describe('when a track leaves the library', () => {
    afterEach(async () => {
      await pool.query(`
        INSERT INTO tracks (id, title, artist, album, path, duration)
        VALUES ($1, 'Track 1', 'Artist', 'Album', '/music/1.flac', 180) ON CONFLICT DO NOTHING
      `, [trackId(1)]);
    });

    it('serves positions without gaps and keeps the queue editable', async () => {
      let session = await create(trackIds(0, 4));
      await pool.query('DELETE FROM tracks WHERE id = $1', [trackId(1)]);

      session = (await sessions.getPlaybackSession(userId, session.id))!;
      expect(trackOrder(session)).toEqual([trackId(0), trackId(2), trackId(3)]);
      expectContiguous(session);

      session = await patch(session, [{ type: 'insert', index: 2, trackIds: [trackId(40)] }]);
      expect(trackOrder(session)).toEqual([trackId(0), trackId(2), trackId(40), trackId(3)]);
      expect((await storedRows(session.id)).map((row) => row.position)).toEqual([0, 1, 2, 3]);
    });

    it('clears the current entry when its track is gone', async () => {
      const session = await create(trackIds(0, 3), 1);
      await pool.query('DELETE FROM tracks WHERE id = $1', [trackId(1)]);
      expect((await sessions.getPlaybackSession(userId, session.id))!.currentEntryId).toBeNull();
    });
  });

  it('handles a 2,000-entry queue', async () => {
    const ids = trackIds(0, 2000);
    const timings: Record<string, number> = {};
    const timed = async <T>(label: string, run: () => Promise<T>) => {
      const started = performance.now();
      const result = await run();
      timings[label] = Math.round(performance.now() - started);
      return result;
    };

    let session = await timed('create', () => create(ids, 1000));
    expect(session.queue).toHaveLength(2000);
    const ids0 = session.queue.map((entry) => entry.queueEntryId);

    session = await timed('insert next', () => patch(session, [{ type: 'insert', index: 1001, trackIds: [trackId(2050)] }]));
    session = await timed('append 3', () => patch(session, [{ type: 'insert', index: 2001, trackIds: trackIds(2051, 3) }]));
    session = await timed('move', () => patch(session, [{ type: 'move', queueEntryId: ids0[1999], toIndex: 0 }]));
    session = await timed('remove 50', () => patch(session, [{ type: 'remove', queueEntryIds: ids0.slice(0, 50) }]));
    session = await timed('replace', () => patch(session, [{ type: 'replaceQueue', trackIds: [...ids].reverse(), currentIndex: 0 }]));
    session = await timed('read', async () => (await sessions.getPlaybackSession(userId, session.id))!);

    expect(session.queue).toHaveLength(2000);
    expect(session.queue[0].track.id).toBe(trackId(1999));
    expectContiguous(session);
    expect(await storedRows(session.id)).toHaveLength(2000);
    // A loose ceiling for a slow CI runner. Locally every step is under 70 ms;
    // an append writes only its new rows (see above).
    for (const [label, ms] of Object.entries(timings)) expect([label, ms < 1500]).toEqual([label, true]);
    console.log('2,000-entry session timings (ms):', timings);
  });
});
