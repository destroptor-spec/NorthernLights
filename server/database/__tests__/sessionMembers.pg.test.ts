/**
 * @jest-environment node
 *
 * Listen together against the real schema (docs/listen-together.md, 6c):
 * join links, what they show before joining, joining and leaving, the
 * owner's controls, and the events each step sends.
 *
 * Gated on AURORA_DB_TESTS=1 like the other *.pg tests; with the gate on and
 * Postgres unreachable they FAIL rather than skip.
 */
import { Pool } from 'pg';

const ENABLED = process.env.AURORA_DB_TESTS === '1';
const describeDb = ENABLED ? describe : describe.skip;
const ADMIN = { user: process.env.DB_USER || 'musicuser', password: process.env.DB_PASSWORD || 'musicpass', host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432) };
const suffix = `${process.pid}_${Date.now().toString(36)}`;

describeDb('listen together', () => {
  jest.setTimeout(120_000);
  const DB_NAME = `aurora_members_test_${suffix}`;
  let admin: Pool;
  let pool: Pool;
  let db: typeof import('../index');
  let sessions: typeof import('../../services/playbackSession.service');
  let members: typeof import('../../services/sessionMembers.service');
  let events: typeof import('../../services/apiV1Events.service');
  let ownerId: string;
  let guestId: string;
  let otherId: string;

  beforeAll(async () => {
    admin = new Pool({ ...ADMIN, database: 'postgres', connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    process.env.DB_NAME = DB_NAME;
    db = await import('../index');
    pool = await db.initDB();
    sessions = await import('../../services/playbackSession.service');
    members = await import('../../services/sessionMembers.service');
    events = await import('../../services/apiV1Events.service');
    ownerId = (await db.createUser('owner', 'x', 'user')).id;
    guestId = (await db.createUser('guest', 'x', 'user')).id;
    otherId = (await db.createUser('zoe', 'x', 'user')).id;
    await pool.query(`
      INSERT INTO tracks (id, title, artist, album, path, duration)
      SELECT 'dHJhY2s' || n, 'Track ' || n, 'Artist', 'Album', '/music/' || n || '.flac', 180
      FROM generate_series(0, 9) AS n
    `);
  });
  afterAll(async () => {
    try { if (pool) await pool.end(); } catch { /* already closed */ }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });
  beforeEach(async () => {
    await pool.query('DELETE FROM playback_sessions');
    await db.setSystemSetting('playbackSyncMode', 'on');
  });

  const create = (userId = ownerId) => sessions.createPlaybackSession({
    userId, clientId: `${userId}-phone`, name: 'Listening', trackIds: ['dHJhY2s0', 'dHJhY2s1'], currentIndex: 0, positionMs: 0,
  });
  const rejection = async (pending: Promise<unknown>) => pending.then(() => { throw new Error('expected a rejection'); }, (error) => error);
  const listen = (userId: string) => {
    const heard: Array<{ type: string; data: unknown }> = [];
    const unsubscribe = events.subscribeApiV1Events(userId, (event) => heard.push(event as { type: string; data: unknown }));
    return { heard, types: () => heard.map((event) => event.type), unsubscribe };
  };

  it('a link makes a private session invite-only and works for anyone on the server', async () => {
    const session = await create();
    const invite = await members.createSessionInvite(ownerId, session.id);
    expect(invite).toMatchObject({ path: `/listen/${invite.token}`, permissions: ['transport', 'queue', 'replace'] });
    expect(invite.token).toMatch(/^[0-9a-f]{64}$/);
    expect((await sessions.getPlaybackSession(ownerId, session.id))!.visibility).toBe('invite');
    expect(await members.listSessionInvites(ownerId, session.id)).toEqual([invite]);

    const joined = await members.joinSessionByInvite(guestId, invite.token);
    expect(joined).toMatchObject({ id: session.id, access: { role: 'guest', permissions: ['transport', 'queue', 'replace'] } });
    await members.joinSessionByInvite(otherId, invite.token); // the same link, again
    const list = await members.listSessionMembers(guestId, session.id);
    expect(list.owner).toMatchObject({ username: 'owner', role: 'owner', avatar: { userId: ownerId, initial: 'O', pictureUrl: null } });
    expect(list.guests.map((guest) => guest.username)).toEqual(['guest', 'zoe']);
  });

  it("a link's scopes become the guest's", async () => {
    const session = await create();
    const invite = await members.createSessionInvite(ownerId, session.id, ['transport']);
    const joined = await members.joinSessionByInvite(guestId, invite.token);
    expect(joined.access).toEqual({ role: 'guest', permissions: ['transport'] });
  });

  it('before joining, a link shows the owner and avatars only: no guest names, nothing about what plays', async () => {
    const session = await create();
    const invite = await members.createSessionInvite(ownerId, session.id);
    await members.joinSessionByInvite(guestId, invite.token);
    const preview = await members.previewSessionInvite(otherId, invite.token);
    expect(preview).toEqual({
      ownerName: 'owner',
      owner: { userId: ownerId, initial: 'O', pictureUrl: null },
      guests: [{ userId: guestId, initial: 'G', pictureUrl: null }],
      sessionId: session.id,
      joined: false,
    });
    expect((await members.previewSessionInvite(guestId, invite.token)).joined).toBe(true);
    expect((await members.previewSessionInvite(ownerId, invite.token)).joined).toBe(true);
  });

  it('a revoked or unknown link does not work; a private session cannot be joined', async () => {
    const session = await create();
    const invite = await members.createSessionInvite(ownerId, session.id);
    await members.setSessionVisibility(ownerId, session.id, 'private');
    expect(await rejection(members.previewSessionInvite(guestId, invite.token))).toBeInstanceOf(members.SessionNotJoinableError);
    expect(await rejection(members.joinSessionByInvite(guestId, invite.token))).toBeInstanceOf(members.SessionNotJoinableError);
    expect(await rejection(members.promptSessionInvite(ownerId, session.id, invite.token, [guestId]))).toBeInstanceOf(members.SessionNotJoinableError);

    await members.setSessionVisibility(ownerId, session.id, 'invite');
    await members.revokeSessionInvite(ownerId, session.id, invite.token);
    expect(await members.listSessionInvites(ownerId, session.id)).toEqual([]);
    expect(await rejection(members.joinSessionByInvite(guestId, invite.token))).toBeInstanceOf(members.SessionInviteNotFoundError);
    expect(await rejection(members.previewSessionInvite(guestId, 'f'.repeat(64)))).toBeInstanceOf(members.SessionInviteNotFoundError);
    expect(await rejection(members.revokeSessionInvite(ownerId, session.id, invite.token))).toBeInstanceOf(members.SessionInviteNotFoundError);
  });

  it("joining needs the owner's sync to be on", async () => {
    const session = await create();
    const invite = await members.createSessionInvite(ownerId, session.id);
    await db.setSystemSetting('playbackSyncMode', 'off');
    expect(await rejection(members.joinSessionByInvite(guestId, invite.token))).toBeInstanceOf(members.SessionSyncOffError);
  });

  it('the owner opening its own link just gets its session back', async () => {
    const session = await create();
    const invite = await members.createSessionInvite(ownerId, session.id);
    const back = await members.joinSessionByInvite(ownerId, invite.token);
    expect(back.access?.role).toBe('owner');
    expect((await members.listSessionMembers(ownerId, session.id)).guests).toEqual([]);
  });

  it('joining another session leaves the first; both sessions hear it', async () => {
    const first = await create();
    const second = await create(otherId);
    const firstLink = await members.createSessionInvite(ownerId, first.id);
    const secondLink = await members.createSessionInvite(otherId, second.id);
    await members.joinSessionByInvite(guestId, firstLink.token);
    const owner = listen(ownerId);
    const other = listen(otherId);
    try {
      await members.joinSessionByInvite(guestId, secondLink.token);
      expect(owner.heard).toContainEqual(expect.objectContaining({ type: 'playbackSession.memberLeft', data: { sessionId: first.id, userId: guestId, reason: 'left' } }));
      expect(other.heard).toContainEqual(expect.objectContaining({
        type: 'playbackSession.memberJoined',
        data: { sessionId: second.id, userId: guestId, avatar: { userId: guestId, initial: 'G', pictureUrl: null } },
      }));
    } finally {
      owner.unsubscribe();
      other.unsubscribe();
    }
    expect(await sessions.getPlaybackSession(guestId, first.id)).toBeNull();
    expect((await sessions.getPlaybackSession(guestId, second.id))!.access?.role).toBe('guest');
  });

  it('joining twice is one membership and one event', async () => {
    const session = await create();
    const invite = await members.createSessionInvite(ownerId, session.id);
    const owner = listen(ownerId);
    try {
      await members.joinSessionByInvite(guestId, invite.token);
      await members.joinSessionByInvite(guestId, invite.token);
      expect(owner.types().filter((type) => type === 'playbackSession.memberJoined')).toHaveLength(1);
    } finally {
      owner.unsubscribe();
    }
  });

  it('the owner removes a guest; a guest may leave but not remove others', async () => {
    const session = await create();
    const invite = await members.createSessionInvite(ownerId, session.id);
    await members.joinSessionByInvite(guestId, invite.token);
    await members.joinSessionByInvite(otherId, invite.token);
    expect(await rejection(members.removeSessionMember(guestId, session.id, otherId))).toBeInstanceOf(sessions.PlaybackSessionOwnerOnlyError);

    const guest = listen(guestId);
    try {
      await members.removeSessionMember(ownerId, session.id, otherId);
      expect(guest.heard).toContainEqual(expect.objectContaining({ type: 'playbackSession.memberLeft', data: { sessionId: session.id, userId: otherId, reason: 'removed' } }));
      await members.removeSessionMember(guestId, session.id, guestId);
      expect(guest.heard).toContainEqual(expect.objectContaining({ type: 'playbackSession.memberLeft', data: { sessionId: session.id, userId: guestId, reason: 'left' } }));
    } finally {
      guest.unsubscribe();
    }
    expect(await sessions.getPlaybackSession(guestId, session.id)).toBeNull();
    expect(await rejection(members.removeSessionMember(ownerId, session.id, guestId))).toBeInstanceOf(sessions.PlaybackSessionNotFoundError);
  });

  it("links, visibility and ending are the owner's; a stranger sees nothing", async () => {
    const session = await create();
    const invite = await members.createSessionInvite(ownerId, session.id);
    await members.joinSessionByInvite(guestId, invite.token);
    for (const attempt of [
      () => members.createSessionInvite(guestId, session.id),
      () => members.listSessionInvites(guestId, session.id),
      () => members.revokeSessionInvite(guestId, session.id, invite.token),
      () => members.promptSessionInvite(guestId, session.id, invite.token, [otherId]),
      () => members.setSessionVisibility(guestId, session.id, 'private'),
      () => members.endListeningTogether(guestId, session.id),
    ]) {
      expect(await rejection(attempt())).toBeInstanceOf(sessions.PlaybackSessionOwnerOnlyError);
    }
    expect(await rejection(members.listSessionMembers(otherId, session.id))).toBeInstanceOf(sessions.PlaybackSessionNotFoundError);
    expect(await rejection(members.createSessionInvite(otherId, session.id))).toBeInstanceOf(sessions.PlaybackSessionNotFoundError);
  });

  it('ending listening together removes every guest and link; the session plays on, private', async () => {
    const session = await create();
    const invite = await members.createSessionInvite(ownerId, session.id);
    await members.joinSessionByInvite(guestId, invite.token);
    const guest = listen(guestId);
    let ended: Awaited<ReturnType<typeof members.endListeningTogether>>;
    try {
      ended = await members.endListeningTogether(ownerId, session.id);
      expect(guest.types()).toEqual(['playbackSession.togetherEnded', 'playbackSession.memberLeft']);
      expect(guest.heard[1].data).toEqual({ sessionId: session.id, userId: guestId, reason: 'ended' });
    } finally {
      guest.unsubscribe();
    }
    expect(ended.visibility).toBe('private');
    expect(ended.queue).toHaveLength(2);
    expect(await sessions.getPlaybackSession(guestId, session.id)).toBeNull();
    expect(await members.listSessionInvites(ownerId, session.id)).toEqual([]);
    expect(await rejection(members.joinSessionByInvite(guestId, invite.token))).toBeInstanceOf(members.SessionInviteNotFoundError);
  });

  it('visibility changes reach the guests', async () => {
    const session = await create();
    const invite = await members.createSessionInvite(ownerId, session.id);
    await members.joinSessionByInvite(guestId, invite.token);
    const guest = listen(guestId);
    try {
      const updated = await members.setSessionVisibility(ownerId, session.id, 'private');
      expect(updated.visibility).toBe('private');
      expect(guest.heard).toContainEqual(expect.objectContaining({ type: 'playbackSession.visibilityChanged', data: { sessionId: session.id, visibility: 'private' } }));
    } finally {
      guest.unsubscribe();
    }
    // Guests already in stay.
    expect((await sessions.getPlaybackSession(guestId, session.id))!.access?.role).toBe('guest');
  });

  it('a prompt sends the link and the preview to known users other than the owner', async () => {
    const session = await create();
    const invite = await members.createSessionInvite(ownerId, session.id);
    const guest = listen(guestId);
    const owner = listen(ownerId);
    try {
      const result = await members.promptSessionInvite(ownerId, session.id, invite.token, [guestId, guestId, ownerId, '00000000-0000-4000-8000-000000000000']);
      expect(result).toEqual({ prompted: 1 });
      expect(guest.heard).toEqual([expect.objectContaining({
        type: 'playbackSession.invitePrompt',
        data: {
          sessionId: session.id, token: invite.token, path: invite.path,
          preview: { ownerName: 'owner', owner: { userId: ownerId, initial: 'O', pictureUrl: null }, guests: [], sessionId: session.id, joined: false },
        },
      })]);
      expect(owner.types()).not.toContain('playbackSession.invitePrompt');
    } finally {
      guest.unsubscribe();
      owner.unsubscribe();
    }
  });

  it('online users are the others with Aurora open, by name', async () => {
    const closeGuest = events.noteClientListening(guestId, 'guest-phone');
    const closeOther = events.noteClientListening(otherId, 'zoe-laptop');
    const closeOwner = events.noteClientListening(ownerId, 'owner-phone');
    try {
      expect(await members.listOnlineUsers(ownerId)).toEqual([
        { username: 'guest', avatar: { userId: guestId, initial: 'G', pictureUrl: null } },
        { username: 'zoe', avatar: { userId: otherId, initial: 'Z', pictureUrl: null } },
      ]);
    } finally {
      closeGuest();
      closeOther();
      closeOwner();
    }
    expect(await members.listOnlineUsers(ownerId)).toEqual([]);
  });
});
