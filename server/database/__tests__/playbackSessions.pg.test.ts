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
  type Operations = import('../../../shared/api/v1').PlaybackSessionPatch['operations'];
  const send = (
    session: { id: string; revision: number },
    operations: Operations,
    extra: { clientId?: string; requestId?: string } = {},
  ) => sessions.patchPlaybackSession({
    userId,
    clientId: extra.clientId ?? 'phone',
    sessionId: session.id,
    patch: { expectedRevision: session.revision, operations, ...(extra.requestId ? { requestId: extra.requestId } : {}) },
  });
  const patch = async (session: { id: string; revision: number }, operations: Operations, clientId = 'phone') =>
    (await send(session, operations, { clientId })).session;
  const storedRows = async (sessionId: string) => (await pool.query(
    'SELECT queue_entry_id, track_id, position FROM playback_session_entries WHERE session_id = $1 ORDER BY position',
    [sessionId],
  )).rows as Array<{ queue_entry_id: string; track_id: string; position: number }>;
  const rejection = async (pending: Promise<unknown>) => pending.then(() => { throw new Error('expected a rejection'); }, (error) => error);
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

  it("rebuilds a device's queue from the operations the web app plans", async () => {
    const { planSessionPatch } = await import('../../../src/utils/sessionQueueDiff');
    let session = await create(trackIds(0, 20));
    let seed = 11;
    const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
    let next = 100;
    const fresh = () => ({ entryId: crypto.randomUUID(), trackId: trackId(next++) });
    for (let round = 0; round < 25; round += 1) {
      // Round 10 starts something new, which is sent as one replaceQueue.
      const local = round === 10
        ? Array.from({ length: 8 }, fresh)
        : session.queue.map((entry) => ({ entryId: entry.queueEntryId, trackId: entry.track.id })).filter(() => random() > 0.15);
      for (let edit = 0; edit < 5; edit += 1) {
        if (random() < 0.5 && local.length) {
          const [moved] = local.splice(Math.floor(random() * local.length), 1);
          local.splice(Math.floor(random() * (local.length + 1)), 0, moved);
        } else {
          local.splice(Math.floor(random() * (local.length + 1)), 0, fresh());
        }
      }
      const operations = planSessionPatch(session, local, local.length ? 0 : null, { repeatMode: 'none', shuffle: false });
      if (!operations.length) continue;
      session = await patch(session, operations);
      expect(session.queue.map((entry) => [entry.queueEntryId, entry.track.id])).toEqual(local.map((entry) => [entry.entryId, entry.trackId]));
      expectContiguous(session);
    }
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

  it("lets any of the owner's devices change or delete the session, no handoff needed", async () => {
    let session = await create(trackIds(0, 2), 0, 'phone');
    session = await patch(session, [{ type: 'insert', afterEntryId: null, trackIds: [trackId(5)] }], 'laptop');
    session = await patch(session, [{ type: 'setTransport', playbackState: 'playing' }], 'tablet');
    expect(session.playbackState).toBe('playing');
    expect(session.ownerClientId).toBe('phone');

    await expect(sessions.deletePlaybackSession(userId, session.id, session.revision - 1))
      .rejects.toBeInstanceOf(sessions.PlaybackSessionRevisionError);
    await sessions.deletePlaybackSession(userId, session.id, session.revision);
    expect(await sessions.getPlaybackSession(userId, session.id)).toBeNull();
    expect(await storedRows(session.id)).toHaveLength(0);
  });

  describe('output grants', () => {
    const claim = (session: { id: string }, clientId: string, name?: string) => sessions.claimPlaybackOutput({
      userId, clientId, sessionId: session.id, output: { kind: 'browser', ...(name ? { name } : {}) },
    });
    const grantOf = (session: { id: string; output: { id: string; generation: number } | null }) => sessions.getCurrentOutputGrant({
      userId, sessionId: session.id, outputId: session.output!.id, generation: session.output!.generation,
    });

    it('starts without an output; a claim makes the calling device the output', async () => {
      const created = await create(trackIds(0, 2));
      expect(created.output).toBeNull();
      const claimed = await claim(created, 'phone-1234', 'Pixel');
      expect(claimed.output).toMatchObject({ id: 'phone-1234', kind: 'browser', name: 'Pixel', generation: 1 });
      expect(claimed.revision).toBe(created.revision + 1);
      expect(claimed.ownerClientId).toBe('phone-1234');
      expect(await grantOf(claimed)).toEqual({ sid: claimed.id, oid: 'phone-1234', gen: 1 });
    });

    it('moves playback to another device at any time, without a revision, and retires the old grant', async () => {
      let session = await create(trackIds(0, 2));
      const onPhone = await claim(session, 'phone-1234');
      // The queue changes after the phone claimed; the laptop still takes over.
      session = await patch(onPhone, [{ type: 'insert', afterEntryId: null, trackIds: [trackId(7)] }], 'tablet');
      const onLaptop = await claim(session, 'laptop-5678');
      expect(onLaptop.output).toMatchObject({ id: 'laptop-5678', generation: 2 });
      expect(trackOrder(onLaptop)).toEqual(trackOrder(session));

      const replaced = await rejection(grantOf(onPhone));
      expect(replaced).toBeInstanceOf(sessions.PlaybackOutputGrantReplacedError);
      expect(replaced.current.output.id).toBe('laptop-5678');

      // Coming back to the phone is a new grant, never the old one revived.
      const backOnPhone = await claim(onLaptop, 'phone-1234');
      expect(backOnPhone.output!.generation).toBe(3);
      await expect(grantOf(onPhone)).rejects.toBeInstanceOf(sessions.PlaybackOutputGrantReplacedError);
      expect(await grantOf(backOnPhone)).toMatchObject({ oid: 'phone-1234', gen: 3 });
    });

    it('settles two claims at once on one device with distinct generations', async () => {
      const session = await create(trackIds(0, 1));
      const [a, b] = await Promise.all([claim(session, 'phone-1234'), claim(session, 'laptop-5678')]);
      expect([a.output!.generation, b.output!.generation].sort()).toEqual([1, 2]);
      const winner = a.output!.generation === 2 ? a : b;
      const current = (await sessions.getPlaybackSession(userId, session.id))!;
      expect(current.output).toEqual(winner.output);
      await expect(grantOf(a.output!.generation === 2 ? b : a)).rejects.toBeInstanceOf(sessions.PlaybackOutputGrantReplacedError);
    });

    it('keeps the handoff alias: a browser claim by the caller at an expected revision', async () => {
      const session = await create(trackIds(0, 1));
      await expect(sessions.handoffPlaybackSession({ userId, clientId: 'tv-0001', sessionId: session.id, expectedRevision: session.revision + 5 }))
        .rejects.toBeInstanceOf(sessions.PlaybackSessionRevisionError);
      const handedOff = await sessions.handoffPlaybackSession({
        userId, clientId: 'tv-0001', clientName: 'Aurora Web', sessionId: session.id, expectedRevision: session.revision,
      });
      expect(handedOff.output).toMatchObject({ id: 'tv-0001', kind: 'browser', name: 'Aurora Web', generation: 1 });
    });

    it("never lets another user claim or check a grant, and ends the grant with the session", async () => {
      const session = await claim(await create(trackIds(0, 1)), 'phone-1234');
      await expect(sessions.claimPlaybackOutput({ userId: otherUserId, clientId: 'x-0000001', sessionId: session.id, output: { kind: 'browser' } }))
        .rejects.toBeInstanceOf(sessions.PlaybackSessionNotFoundError);
      await expect(sessions.getCurrentOutputGrant({ userId: otherUserId, sessionId: session.id, outputId: 'phone-1234', generation: 1 }))
        .rejects.toBeInstanceOf(sessions.PlaybackSessionNotFoundError);
      await sessions.deletePlaybackSession(userId, session.id, session.revision);
      await expect(grantOf(session)).rejects.toBeInstanceOf(sessions.PlaybackSessionNotFoundError);
    });

    it('mints an output credential that names exactly its grant', async () => {
      const tokens = await import('../../services/scopedToken.service');
      const session = await claim(await create(trackIds(0, 1)), 'phone-1234');
      const user = { userId, username: 'listener', role: 'user' };
      const { token, expiresAt } = await tokens.generateOutputCredential(user, await grantOf(session));
      const claims = await tokens.verifyOutputCredential(token);
      expect(claims).toMatchObject({ scope: 'output', userId, sid: session.id, oid: 'phone-1234', gen: 1 });
      expect(claims!.jti).toMatch(/^[0-9a-f-]{36}$/);
      expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(55 * 60 * 1000);
      // It is no other kind of token.
      for (const scope of ['sse', 'media', 'receiver'] as const) expect(await tokens.verifyScopedToken(token, scope)).toBeNull();
      expect(await tokens.verifyOutputCredential(
        await tokens.generateEphemeralScopedToken('sse', user),
      )).toBeNull();
    });
  });

  describe('output reports', () => {
    type Report = import('../../../shared/api/v1').PlaybackOutputReport;
    const playing = async (clientId = 'laptop-5678') => {
      const created = await create(trackIds(0, 3));
      const session = await sessions.claimPlaybackOutput({ userId, clientId, sessionId: created.id, output: { kind: 'browser' } });
      return { session, grant: { sid: session.id, oid: clientId, gen: session.output!.generation } };
    };
    const reportAs = (grant: { sid: string; oid: string; gen: number }, report: Report) =>
      sessions.reportPlaybackOutput({ userId, grant, sessionId: grant.sid, report });
    const read = async (id: string) => (await sessions.getPlaybackSession(userId, id))!;
    const age = (id: string, column: 'output_reported_at' | 'output_claimed_at', seconds: number) => pool.query(
      `UPDATE playback_sessions SET ${column} = NOW() - make_interval(secs => $2) WHERE id = $1`, [id, seconds],
    );

    it('stores position without a revision bump, and bumps it for a track or play-state change', async () => {
      const { session, grant } = await playing();
      const [first, second] = session.queue.map((entry) => entry.queueEntryId);

      expect(await reportAs(grant, { seq: 1, state: 'playing', queueEntryId: first, positionMs: 0 }))
        .toEqual({ accepted: true, revision: session.revision + 1 });
      expect(await reportAs(grant, { seq: 2, state: 'playing', queueEntryId: first, positionMs: 10_000 }))
        .toEqual({ accepted: true, revision: session.revision + 1 });
      let current = await read(session.id);
      expect(current).toMatchObject({ playbackState: 'playing', currentEntryId: first, positionMs: 10_000 });
      expect(current.output).toMatchObject({ status: 'active', report: { seq: 2, state: 'playing', queueEntryId: first, positionMs: 10_000 } });

      // The output moved on to the next track by itself.
      expect((await reportAs(grant, { seq: 3, state: 'playing', queueEntryId: second, positionMs: 1_000 })).revision).toBe(session.revision + 2);
      expect((await reportAs(grant, { seq: 4, state: 'paused', queueEntryId: second, positionMs: 2_000 })).revision).toBe(session.revision + 3);
      // Buffering is between states: the session keeps saying paused.
      expect((await reportAs(grant, { seq: 5, state: 'buffering', queueEntryId: second, positionMs: 2_000 })).revision).toBe(session.revision + 3);
      current = await read(session.id);
      expect(current).toMatchObject({ currentEntryId: second, positionMs: 2_000, playbackState: 'paused' });
    });

    it('drops a report that is not newer than the last accepted one, such as one from before a seek', async () => {
      const { session, grant } = await playing();
      const entry = session.queue[0].queueEntryId;
      await reportAs(grant, { seq: 7, state: 'playing', queueEntryId: entry, positionMs: 150_000 });
      expect((await reportAs(grant, { seq: 6, state: 'playing', queueEntryId: entry, positionMs: 4_000 })).accepted).toBe(false);
      expect((await reportAs(grant, { seq: 7, state: 'playing', queueEntryId: entry, positionMs: 4_000 })).accepted).toBe(false);
      expect((await read(session.id)).output!.report).toMatchObject({ seq: 7, positionMs: 150_000 });
    });

    it('refuses reports from a replaced grant, and starts the new grant afresh', async () => {
      const { session, grant: laptop } = await playing();
      const entry = session.queue[0].queueEntryId;
      await reportAs(laptop, { seq: 40, state: 'playing', queueEntryId: entry, positionMs: 90_000 });
      const onPhone = await sessions.claimPlaybackOutput({ userId, clientId: 'phone-1234', sessionId: session.id, output: { kind: 'browser' } });
      expect(onPhone.output!.report).toBeNull();

      const late = await rejection(reportAs(laptop, { seq: 41, state: 'playing', queueEntryId: entry, positionMs: 95_000 }));
      expect(late).toBeInstanceOf(sessions.PlaybackOutputGrantReplacedError);
      expect(late.current.output.id).toBe('phone-1234');
      // Same device, older generation: still replaced.
      await expect(reportAs({ ...laptop, oid: 'phone-1234' }, { seq: 1, state: 'playing', queueEntryId: entry, positionMs: 0 }))
        .rejects.toBeInstanceOf(sessions.PlaybackOutputGrantReplacedError);

      const phone = { sid: session.id, oid: 'phone-1234', gen: onPhone.output!.generation };
      expect((await reportAs(phone, { seq: 0, state: 'playing', queueEntryId: entry, positionMs: 90_500 })).accepted).toBe(true);
      expect((await read(session.id)).output!.report).toMatchObject({ seq: 0, positionMs: 90_500 });
    });

    it('refuses a body that names another output or generation than the credential', async () => {
      const { session, grant } = await playing();
      const entry = session.queue[0].queueEntryId;
      for (const extra of [{ outputId: 'phone-1234' }, { outputGeneration: grant.gen + 1 }]) {
        await expect(reportAs(grant, { seq: 1, state: 'playing', queueEntryId: entry, positionMs: 0, ...extra }))
          .rejects.toBeInstanceOf(sessions.PlaybackOutputIdentityError);
      }
      expect(await reportAs(grant, { seq: 1, state: 'playing', queueEntryId: entry, positionMs: 0, outputId: grant.oid, outputGeneration: grant.gen }))
        .toMatchObject({ accepted: true });
      await expect(sessions.reportPlaybackOutput({ userId, grant, sessionId: (await create(trackIds(0, 1))).id, report: { seq: 2, state: 'playing', queueEntryId: null, positionMs: 0 } }))
        .rejects.toBeInstanceOf(sessions.PlaybackOutputIdentityError);
    });

    it('marks a silent output unreachable and never ends it for silence alone', async () => {
      const { session, grant } = await playing();
      const entry = session.queue[0].queueEntryId;
      // Claimed but never heard from.
      await age(session.id, 'output_claimed_at', 61);
      expect((await read(session.id)).output!.status).toBe('unreachable');

      await reportAs(grant, { seq: 1, state: 'paused', queueEntryId: entry, positionMs: 33_000 });
      expect((await read(session.id)).output!.status).toBe('active');
      await age(session.id, 'output_reported_at', 59);
      expect((await read(session.id)).output!.status).toBe('active');
      // A day of silence is still only unreachable, with the last state kept.
      await age(session.id, 'output_reported_at', 86_400);
      const silent = (await read(session.id)).output!;
      expect(silent.status).toBe('unreachable');
      expect(silent.report).toMatchObject({ state: 'paused', positionMs: 33_000 });

      // Recovery is a report on the same grant.
      await reportAs(grant, { seq: 2, state: 'paused', queueEntryId: entry, positionMs: 33_000 });
      expect((await read(session.id)).output!.status).toBe('active');
    });

    it('ends the output only when it says so itself, and a later report revives it', async () => {
      const { session, grant } = await playing();
      const entry = session.queue[0].queueEntryId;
      await reportAs(grant, { seq: 1, state: 'playing', queueEntryId: entry, positionMs: 5_000 });
      await reportAs(grant, { seq: 2, state: 'stopped', reason: 'shutdown', queueEntryId: entry, positionMs: 6_000 });
      let current = await read(session.id);
      expect(current.output).toMatchObject({ status: 'ended', report: { state: 'stopped', reason: 'shutdown' } });
      expect(current.playbackState).toBe('stopped');
      await age(session.id, 'output_reported_at', 3_600);
      expect((await read(session.id)).output!.status).toBe('ended');

      await reportAs(grant, { seq: 3, state: 'playing', queueEntryId: entry, positionMs: 6_000 });
      current = await read(session.id);
      expect(current.output!.status).toBe('active');
      expect(current.playbackState).toBe('playing');
    });

    it('keeps position bound to its entry when the output plays something no longer queued', async () => {
      const { session, grant } = await playing();
      const [first, second] = session.queue.map((entry) => entry.queueEntryId);
      await reportAs(grant, { seq: 1, state: 'playing', queueEntryId: first, positionMs: 20_000 });
      const afterRemoval = await patch(await read(session.id), [{ type: 'remove', queueEntryIds: [second] }], 'phone-1234');
      // A controller removed the entry; the output reports it anyway, as it is still playing it.
      await reportAs(grant, { seq: 2, state: 'playing', queueEntryId: second, positionMs: 3_000 });
      const current = await read(session.id);
      expect(current.currentEntryId).toBe(afterRemoval.currentEntryId);
      expect(current.positionMs).toBe(20_000);
      expect(current.output!.report).toMatchObject({ queueEntryId: second, positionMs: 3_000 });
    });

    it("doesn't make controllers' edits conflict with position reports", async () => {
      const { session, grant } = await playing();
      const entry = session.queue[0].queueEntryId;
      await reportAs(grant, { seq: 1, state: 'playing', queueEntryId: entry, positionMs: 0 });
      const before = await read(session.id);
      for (let seq = 2; seq < 8; seq++) await reportAs(grant, { seq, state: 'playing', queueEntryId: entry, positionMs: seq * 10_000 });
      // Built on the revision read before six position reports, and still accepted.
      await expect(patch(before, [{ type: 'insert', afterEntryId: entry, trackIds: [trackId(50)] }], 'phone-1234')).resolves.toBeDefined();
    });
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

  describe('entry anchors, proposed entry IDs and request keys', () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const requestKeys = async (sessionId: string) => Number((await pool.query(
      'SELECT COUNT(*)::int AS n FROM playback_session_requests WHERE session_id = $1', [sessionId],
    )).rows[0].n);

    it('inserts after an anchor entry, or at the head for null, using the proposed entry IDs', async () => {
      let session = await create(trackIds(0, 3));
      const [a, b, c] = session.queue.map((entry) => entry.queueEntryId);
      session = await patch(session, [{ type: 'insert', afterEntryId: b, trackIds: trackIds(10, 2), entryIds: [uuid(1), uuid(2)] }]);
      session = await patch(session, [{ type: 'insert', afterEntryId: null, trackIds: [trackId(12)], entryIds: [uuid(3)] }]);
      expect(session.queue.map((entry) => entry.queueEntryId)).toEqual([uuid(3), a, b, uuid(1), uuid(2), c]);
      expectContiguous(session);
      // Without proposed IDs the server still makes its own.
      session = await patch(session, [{ type: 'insert', afterEntryId: c, trackIds: [trackId(13)] }]);
      expect(session.queue[6].queueEntryId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('moves after an anchor entry, to the head for null, and treats its own ID as staying put', async () => {
      let session = await create(trackIds(0, 4));
      const [a, b, c, d] = session.queue.map((entry) => entry.queueEntryId);
      session = await patch(session, [{ type: 'move', queueEntryId: a, afterEntryId: c }]);
      expect(session.queue.map((entry) => entry.queueEntryId)).toEqual([b, c, a, d]);
      session = await patch(session, [{ type: 'move', queueEntryId: d, afterEntryId: null }]);
      expect(session.queue.map((entry) => entry.queueEntryId)).toEqual([d, b, c, a]);
      session = await patch(session, [{ type: 'move', queueEntryId: c, afterEntryId: c }]);
      expect(session.queue.map((entry) => entry.queueEntryId)).toEqual([d, b, c, a]);
      // Moving an entry that is already gone changes nothing in the queue.
      session = await patch(session, [{ type: 'move', queueEntryId: uuid(99), afterEntryId: null }]);
      expect(session.queue.map((entry) => entry.queueEntryId)).toEqual([d, b, c, a]);
    });

    it('answers ANCHOR_NOT_FOUND with the current session when the anchor is gone, and writes nothing', async () => {
      let session = await create(trackIds(0, 3));
      const [a, b] = session.queue.map((entry) => entry.queueEntryId);
      session = await patch(session, [{ type: 'remove', queueEntryIds: [b] }]);
      for (const operation of [
        { type: 'insert' as const, afterEntryId: b, trackIds: [trackId(20)] },
        { type: 'move' as const, queueEntryId: a, afterEntryId: b },
      ]) {
        const error = await rejection(send(session, [operation], { requestId: uuid(50) }));
        expect(error).toBeInstanceOf(sessions.PlaybackSessionAnchorError);
        expect(error.anchorEntryId).toBe(b);
        expect(error.current.revision).toBe(session.revision);
        expect(trackOrder(error.current)).toEqual(trackOrder(session));
      }
      expect(await requestKeys(session.id)).toBe(0);
    });

    it('rejects the whole patch when a proposed entry ID is already in the queue', async () => {
      const session = await create(trackIds(0, 2));
      const [a] = session.queue.map((entry) => entry.queueEntryId);
      const inUse = await rejection(patch(session, [
        { type: 'setTransport', playbackState: 'playing' },
        { type: 'insert', afterEntryId: null, trackIds: [trackId(30)], entryIds: [a] },
      ]));
      expect(inUse).toBeInstanceOf(sessions.PlaybackSessionEntryIdError);
      expect(inUse.entryIds).toEqual([a]);
      expect(inUse.current.revision).toBe(1);
      expect(inUse.current.playbackState).toBe('paused');

      // Two ops in one patch proposing the same ID: the second clashes with the first.
      const twice = await rejection(patch(session, [
        { type: 'insert', afterEntryId: null, trackIds: [trackId(30)], entryIds: [uuid(1)] },
        { type: 'insert', afterEntryId: null, trackIds: [trackId(31)], entryIds: [uuid(1)] },
      ]));
      expect(twice).toBeInstanceOf(sessions.PlaybackSessionEntryIdError);
      expect(await storedRows(session.id)).toHaveLength(2);
    });

    it('keeps an entry a queue replacement names again for the same track, and refuses it for another track', async () => {
      let session = await create(trackIds(0, 2));
      const [a, b] = session.queue;
      session = await patch(session, [{ type: 'replaceQueue', trackIds: [trackId(1), trackId(5)], entryIds: [b.queueEntryId, uuid(1)] }]);
      expect(session.queue.map((entry) => entry.queueEntryId)).toEqual([b.queueEntryId, uuid(1)]);
      expect(session.queue[0].addedAt).toBe(b.addedAt);
      const error = await rejection(patch(session, [{ type: 'replaceQueue', trackIds: [trackId(9)], entryIds: [uuid(1)] }]));
      expect(error).toBeInstanceOf(sessions.PlaybackSessionEntryIdError);
      expect(a.queueEntryId).not.toBe(uuid(1));
    });

    it('returns the original success for a retried requestId instead of applying it again', async () => {
      const session = await create(trackIds(0, 2));
      const operations: Operations = [{ type: 'insert', afterEntryId: null, trackIds: [trackId(40)], entryIds: [uuid(1)] }];
      const first = await send(session, operations, { requestId: uuid(70) });
      expect(first).toMatchObject({ appliedRevision: 2, replayed: false });

      // Another change lands, then the lost-response retry arrives: same key,
      // same body, now a stale revision and an ID that is already in use.
      const later = await patch(first.session, [{ type: 'setTransport', playbackState: 'playing' }]);
      const retry = await send(session, operations, { requestId: uuid(70) });
      expect(retry).toMatchObject({ appliedRevision: 2, replayed: true });
      expect(retry.session.revision).toBe(later.revision);
      expect(retry.session.queue.filter((entry) => entry.queueEntryId === uuid(1))).toHaveLength(1);
      expect(await storedRows(session.id)).toHaveLength(3);
    });

    it('refuses a reused requestId with a different body, and records no key for a rejected patch', async () => {
      const session = await create(trackIds(0, 2));
      await send(session, [{ type: 'setTransport', positionMs: 100 }], { requestId: uuid(80) });
      await expect(send(session, [{ type: 'setTransport', positionMs: 200 }], { requestId: uuid(80) }))
        .rejects.toBeInstanceOf(sessions.PlaybackSessionRequestReusedError);

      // A stale revision is rejected and leaves no key, so the rebased patch
      // goes out under a new key and the old one stays free.
      await expect(send(session, [{ type: 'setTransport', positionMs: 300 }], { requestId: uuid(81) }))
        .rejects.toBeInstanceOf(sessions.PlaybackSessionRevisionError);
      expect(await requestKeys(session.id)).toBe(1);
      const current = (await sessions.getPlaybackSession(userId, session.id))!;
      const rebased = await send(current, [{ type: 'setTransport', positionMs: 300 }], { requestId: uuid(81) });
      expect(rebased.replayed).toBe(false);
      expect(rebased.session.positionMs).toBe(300);
    });

    it('scopes keys to one session and forgets them after 24 hours', async () => {
      const one = await create(trackIds(0, 1));
      const two = await create(trackIds(0, 1));
      await send(one, [{ type: 'setTransport', positionMs: 1 }], { requestId: uuid(90) });
      expect((await send(two, [{ type: 'setTransport', positionMs: 2 }], { requestId: uuid(90) })).replayed).toBe(false);

      await pool.query(`UPDATE playback_session_requests SET created_at = NOW() - INTERVAL '25 hours' WHERE session_id = $1`, [one.id]);
      const current = (await sessions.getPlaybackSession(userId, one.id))!;
      const again = await send(current, [{ type: 'setTransport', positionMs: 1 }], { requestId: uuid(90) });
      expect(again).toMatchObject({ replayed: false, appliedRevision: current.revision + 1 });
      expect(await requestKeys(one.id)).toBe(1);
    });

    it('keeps at most 1,000 keys per session, dropping the oldest', async () => {
      const session = await create(trackIds(0, 1));
      await pool.query(`
        INSERT INTO playback_session_requests (session_id, request_id, request_hash, revision, created_at)
        SELECT $1, gen_random_uuid(), 'x', 1, NOW() - (n || ' seconds')::interval FROM generate_series(1, 1000) AS n
      `, [session.id]);
      await send(session, [{ type: 'setTransport', positionMs: 5 }], { requestId: uuid(95) });
      expect(await requestKeys(session.id)).toBe(1000);
      // Of the 1,000 older keys, exactly the oldest one made room for the new key.
      const kept = await pool.query(`
        SELECT COUNT(*)::int AS n
        FROM playback_session_requests WHERE session_id = $1 AND request_hash = 'x'
      `, [session.id]);
      expect(kept.rows[0].n).toBe(999);
      const ages = await pool.query(`
        SELECT EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at)))::int AS span
        FROM playback_session_requests WHERE session_id = $1 AND request_hash = 'x'
      `, [session.id]);
      expect(ages.rows[0].span).toBe(998);
      expect((await send(session, [{ type: 'setTransport', positionMs: 5 }], { requestId: uuid(95) })).replayed).toBe(true);
    });

    it('rebases an anchored insert onto a concurrent change without moving its target', async () => {
      let session = await create(trackIds(0, 3));
      const [, b] = session.queue.map((entry) => entry.queueEntryId);
      // This client means "play after b" while another tab inserts at the head.
      const intent: Operations = [{ type: 'insert', afterEntryId: b, trackIds: [trackId(60)], entryIds: [uuid(6)] }];
      await patch(session, [{ type: 'insert', afterEntryId: null, trackIds: [trackId(61)] }]);
      const conflict = await rejection(send(session, intent, { requestId: uuid(100) }));
      expect(conflict).toBeInstanceOf(sessions.PlaybackSessionRevisionError);
      session = (await send(conflict.current, intent, { requestId: uuid(101) })).session;
      const ids = session.queue.map((entry) => entry.queueEntryId);
      expect(ids[ids.indexOf(b) + 1]).toBe(uuid(6));
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
