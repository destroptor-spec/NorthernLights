import { initDB } from '../database';
import { SESSION_SCOPES, type OnlineUser, type PlaybackSession, type SessionInvite, type SessionInvitePreview, type SessionMembers, type UserAvatar } from '../../shared/api/v1';
import { listOnlineUserIds, publishApiV1Event } from './apiV1Events.service';
import { isPlaybackSyncEnabledFor } from './playbackSync.service';
import {
  enforceAccess,
  loadSessionFor,
  PlaybackSessionNotFoundError,
  PlaybackSessionOwnerOnlyError,
  publishToSession,
  serializeSession,
  sessionAudience,
} from './playbackSession.service';
import { OWNER_ONLY, READ, type SessionScope } from './sessionAccess';

/**
 * Listen together: guests, join links and their prompts (docs/listen-together.md, 6c).
 *
 * A join link works for anyone signed in on this server (Andreas,
 * 2026-10-27), as many times as wanted, until the owner revokes it or ends
 * listening together. Prompting online users sends them the same link. Before
 * joining, a user sees only "{owner}'s session" and the members' avatars: no
 * guest names, nothing about what plays. The owner alone manages guests,
 * links and visibility; a guest may leave.
 */

/** No such link, revoked, or its session gone. */
export class SessionInviteNotFoundError extends Error {}
/** The session is private: nobody can join, links or not. */
export class SessionNotJoinableError extends Error {}
/** The owner's "Sync playback across devices" is off: the session cannot be used. */
export class SessionSyncOffError extends Error {}

type Db = Awaited<ReturnType<typeof initDB>>;
type UserRow = { id: string; username: string };

export function avatarFor(user: UserRow): UserAvatar {
  return { userId: user.id, initial: (Array.from(user.username.trim())[0] || '?').toUpperCase(), pictureUrl: null };
}

const joinPath = (token: string) => `/listen/${token}`;

async function usersById(db: Db, ids: string[]): Promise<Map<string, UserRow>> {
  if (ids.length === 0) return new Map();
  const result = await db.query('SELECT id, username FROM users WHERE id = ANY($1::uuid[])', [ids]);
  return new Map((result.rows as UserRow[]).map((row) => [String(row.id), { id: String(row.id), username: String(row.username) }]));
}

async function ownerSession(db: Db, userId: string, sessionId: string) {
  const loaded = await loadSessionFor(db, userId, sessionId);
  enforceAccess(loaded?.access ?? null, OWNER_ONLY);
  return loaded!;
}

/** Every working link of a session stops working. */
async function revokeLinks(db: Db, sessionId: string) {
  await db.query('UPDATE playback_session_invites SET revoked_at = NOW() WHERE session_id = $1 AND revoked_at IS NULL', [sessionId]);
}

/**
 * Private (nobody can join; guests already in stay) or invite (anyone with a
 * link). Going private revokes the links: a closed session's old link never
 * works again, and opening it again takes a fresh one (Andreas, 2026-10-28).
 */
export async function setSessionVisibility(userId: string, sessionId: string, visibility: 'private' | 'invite'): Promise<PlaybackSession> {
  const db = await initDB();
  const { access } = await ownerSession(db, userId, sessionId);
  if (visibility === 'private') await revokeLinks(db, sessionId);
  const updated = await db.query('UPDATE playback_sessions SET visibility = $2 WHERE id = $1 RETURNING *', [sessionId, visibility]);
  await publishToSession(db, userId, sessionId, 'playbackSession.visibilityChanged', { sessionId, visibility });
  return serializeSession(db, updated.rows[0], { userId, access });
}

/** The owner and the guests, with names: for the people in the session. */
export async function listSessionMembers(userId: string, sessionId: string): Promise<SessionMembers> {
  const db = await initDB();
  const loaded = await loadSessionFor(db, userId, sessionId);
  enforceAccess(loaded?.access ?? null, READ);
  const ownerId = loaded!.access.ownerId;
  const rows = (await db.query(
    'SELECT user_id, permissions, joined_at FROM playback_session_members WHERE session_id = $1 ORDER BY joined_at',
    [sessionId],
  )).rows as Array<{ user_id: string; permissions: string[]; joined_at: Date | string }>;
  const users = await usersById(db, [ownerId, ...rows.map((row) => String(row.user_id))]);
  const owner = users.get(ownerId)!;
  return {
    owner: { username: owner.username, avatar: avatarFor(owner), role: 'owner', permissions: [...SESSION_SCOPES], joinedAt: null },
    guests: rows.flatMap((row) => {
      const user = users.get(String(row.user_id));
      return user ? [{
        username: user.username,
        avatar: avatarFor(user),
        role: 'guest' as const,
        permissions: SESSION_SCOPES.filter((scope) => row.permissions.includes(scope)),
        joinedAt: new Date(row.joined_at).toISOString(),
      }] : [];
    }),
  };
}

/** The owner removes a guest; a guest may remove itself (leave). */
export async function removeSessionMember(userId: string, sessionId: string, memberId: string): Promise<void> {
  const db = await initDB();
  const loaded = await loadSessionFor(db, userId, sessionId);
  enforceAccess(loaded?.access ?? null, READ);
  const leaving = memberId === userId;
  if (!leaving && loaded!.access.role !== 'owner') throw new PlaybackSessionOwnerOnlyError();
  const ownerId = loaded!.access.ownerId;
  const audience = await sessionAudience(db, ownerId, sessionId);
  const removed = await db.query('DELETE FROM playback_session_members WHERE session_id = $1 AND user_id = $2', [sessionId, memberId]);
  if (!removed.rowCount) throw new PlaybackSessionNotFoundError();
  for (const user of audience) {
    publishApiV1Event(user, 'playbackSession.memberLeft', { sessionId, userId: memberId, reason: leaving ? 'left' : 'removed' });
  }
}

function toInvite(row: { token: string; permissions: string[]; created_at: Date | string }): SessionInvite {
  return {
    token: row.token,
    path: joinPath(row.token),
    permissions: SESSION_SCOPES.filter((scope) => row.permissions.includes(scope)),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * A new join link. A private session becomes invite-only, a link being for
 * joining, and any link left from before it was closed dies: only the new
 * one works.
 */
export async function createSessionInvite(userId: string, sessionId: string, permissions?: SessionScope[]): Promise<SessionInvite> {
  const db = await initDB();
  const { row } = await ownerSession(db, userId, sessionId);
  const opening = (row.visibility ?? 'private') === 'private';
  if (opening) await revokeLinks(db, sessionId);
  const result = await db.query(
    'INSERT INTO playback_session_invites (session_id, permissions, created_by) VALUES ($1, $2, $3) RETURNING token, permissions, created_at',
    [sessionId, permissions ?? [...SESSION_SCOPES], userId],
  );
  if (opening) {
    await db.query("UPDATE playback_sessions SET visibility = 'invite' WHERE id = $1", [sessionId]);
    await publishToSession(db, userId, sessionId, 'playbackSession.visibilityChanged', { sessionId, visibility: 'invite' });
  }
  return toInvite(result.rows[0]);
}

/** The session's working links, newest first: so the owner can copy one again. */
export async function listSessionInvites(userId: string, sessionId: string): Promise<SessionInvite[]> {
  const db = await initDB();
  await ownerSession(db, userId, sessionId);
  const result = await db.query(
    'SELECT token, permissions, created_at FROM playback_session_invites WHERE session_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC',
    [sessionId],
  );
  return result.rows.map(toInvite);
}

export async function revokeSessionInvite(userId: string, sessionId: string, token: string): Promise<void> {
  const db = await initDB();
  await ownerSession(db, userId, sessionId);
  const result = await db.query(
    'UPDATE playback_session_invites SET revoked_at = NOW() WHERE token = $1 AND session_id = $2 AND revoked_at IS NULL',
    [token, sessionId],
  );
  if (!result.rowCount) throw new SessionInviteNotFoundError();
}

/** A working link with its session and owner, or null. */
async function activeInvite(db: Db, token: string) {
  const result = await db.query(`
    SELECT i.token, i.permissions, s.id AS session_id, s.user_id AS owner_id, s.visibility
    FROM playback_session_invites i JOIN playback_sessions s ON s.id = i.session_id
    WHERE i.token = $1 AND i.revoked_at IS NULL
  `, [token]);
  const row = result.rows[0] as { token: string; permissions: string[]; session_id: string; owner_id: string; visibility: string } | undefined;
  return row ?? null;
}

/**
 * Prompts users of this server with a link: each hears
 * playbackSession.invitePrompt, with the link and the preview. Unknown users,
 * and the owner, are skipped. Answers how many were prompted.
 */
export async function promptSessionInvite(userId: string, sessionId: string, token: string, userIds: string[]): Promise<{ prompted: number }> {
  const db = await initDB();
  await ownerSession(db, userId, sessionId);
  const invite = await activeInvite(db, token);
  if (!invite || invite.session_id !== sessionId) throw new SessionInviteNotFoundError();
  if (invite.visibility === 'private') throw new SessionNotJoinableError();
  const preview = await buildPreview(db, invite);
  const users = await usersById(db, [...new Set(userIds)].filter((id) => id !== userId));
  for (const id of users.keys()) {
    publishApiV1Event(id, 'playbackSession.invitePrompt', { sessionId, token, path: joinPath(token), preview: { ...preview, joined: false } });
  }
  return { prompted: users.size };
}

async function buildPreview(db: Db, invite: { session_id: string; owner_id: string }): Promise<Omit<SessionInvitePreview, 'joined'>> {
  const guestIds = (await db.query('SELECT user_id FROM playback_session_members WHERE session_id = $1 ORDER BY joined_at', [invite.session_id]))
    .rows.map((row) => String(row.user_id));
  const users = await usersById(db, [invite.owner_id, ...guestIds]);
  const owner = users.get(invite.owner_id)!;
  return {
    ownerName: owner.username,
    owner: avatarFor(owner),
    guests: guestIds.flatMap((id) => (users.has(id) ? [avatarFor(users.get(id)!)] : [])),
    sessionId: invite.session_id,
  };
}

/** What a link shows before joining: "{owner}'s session" and avatars, nothing else. */
export async function previewSessionInvite(userId: string, token: string): Promise<SessionInvitePreview> {
  const db = await initDB();
  const invite = await activeInvite(db, token);
  if (!invite) throw new SessionInviteNotFoundError();
  if (invite.visibility === 'private') throw new SessionNotJoinableError();
  const preview = await buildPreview(db, invite);
  const joined = invite.owner_id === userId || preview.guests.some((guest) => guest.userId === userId);
  return { ...preview, joined };
}

/**
 * Joins through a link, with its scopes. A guest in another session leaves
 * that one first (one session at a time). The owner joining its own link
 * just gets its session back.
 */
export async function joinSessionByInvite(userId: string, token: string): Promise<PlaybackSession> {
  const db = await initDB();
  const invite = await activeInvite(db, token);
  if (!invite) throw new SessionInviteNotFoundError();
  if (invite.visibility === 'private') throw new SessionNotJoinableError();
  if (!(await isPlaybackSyncEnabledFor(invite.owner_id))) throw new SessionSyncOffError();
  if (invite.owner_id !== userId) {
    const previous = (await db.query(
      'SELECT m.session_id, s.user_id AS owner_id FROM playback_session_members m JOIN playback_sessions s ON s.id = m.session_id WHERE m.user_id = $1 AND m.session_id <> $2',
      [userId, invite.session_id],
    )).rows[0] as { session_id: string; owner_id: string } | undefined;
    if (previous) {
      const audience = await sessionAudience(db, previous.owner_id, previous.session_id);
      await db.query('DELETE FROM playback_session_members WHERE session_id = $1 AND user_id = $2', [previous.session_id, userId]);
      for (const user of audience) publishApiV1Event(user, 'playbackSession.memberLeft', { sessionId: previous.session_id, userId, reason: 'left' });
    }
    const inserted = await db.query(`
      INSERT INTO playback_session_members (session_id, user_id, permissions, invite_token) VALUES ($1, $2, $3, $4)
      ON CONFLICT (session_id, user_id) DO NOTHING
    `, [invite.session_id, userId, invite.permissions, token]);
    if (inserted.rowCount) {
      const user = (await usersById(db, [userId])).get(userId);
      await publishToSession(db, invite.owner_id, invite.session_id, 'playbackSession.memberJoined', {
        sessionId: invite.session_id, userId, avatar: user ? avatarFor(user) : null,
      });
    }
  }
  const loaded = await loadSessionFor(db, userId, invite.session_id);
  return serializeSession(db, loaded!.row, { userId, access: loaded!.access });
}

/** The owner ends listening together: every guest out, every link dead, private again. The music plays on. */
export async function endListeningTogether(userId: string, sessionId: string): Promise<PlaybackSession> {
  const db = await initDB();
  const { access } = await ownerSession(db, userId, sessionId);
  const audience = await sessionAudience(db, userId, sessionId);
  const guests = (await db.query('DELETE FROM playback_session_members WHERE session_id = $1 RETURNING user_id', [sessionId]))
    .rows.map((row) => String(row.user_id));
  await revokeLinks(db, sessionId);
  const updated = await db.query("UPDATE playback_sessions SET visibility = 'private' WHERE id = $1 RETURNING *", [sessionId]);
  for (const user of audience) {
    publishApiV1Event(user, 'playbackSession.togetherEnded', { sessionId });
    for (const guest of guests) publishApiV1Event(user, 'playbackSession.memberLeft', { sessionId, userId: guest, reason: 'ended' });
  }
  return serializeSession(db, updated.rows[0], { userId, access });
}

/** Users of this server with Aurora open now, other than the caller: whom the owner can prompt. Names only. */
export async function listOnlineUsers(userId: string): Promise<OnlineUser[]> {
  const db = await initDB();
  const users = await usersById(db, listOnlineUserIds().filter((id) => id !== userId));
  return [...users.values()]
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((user) => ({ username: user.username, avatar: avatarFor(user) }));
}
