import type { PlaybackSession, SessionInvitePreview, UserAvatar } from '../../shared/api/v1';
import { AuroraApiError } from '../api/auroraApi';
import * as api from '../api/listenTogether';
import { usePlayerStore } from '../store/index';
import { useListenTogetherStore as store } from '../store/listenTogether';
import { castManager } from './CastManager';
import { sessionFollower } from './SessionFollower';
import { sessionMirror } from './SessionMirror';
import { isFollowedOutputPlaying } from './sessionFollow';
import { sendRemoteAction } from './sessionRemote';
import { previewLabel, sessionTitle } from './listenTogetherText';

// Listen together in the web app (docs/listen-together.md, 6c): the owner's
// sheet in Connect, invitations (prompts and /listen/<token> links), and
// which session this user is a guest in. The device a guest joins on shows
// that session (6d): it follows it like another device's playback, and
// sends what is done here to the device that plays it.

const auth = () => usePlayerStore.getState().getAuthHeader();
const me = () => usePlayerStore.getState().currentUser?.id ?? null;
const toast = (message: string, type: 'info' | 'error' = 'error') => usePlayerStore.getState().addToast(message, type);

export { previewLabel, sessionTitle };

export function listenUrl(path: string): string {
  return `${window.location.origin}${path}`;
}

function failure(error: unknown, ownerName?: string | null): string {
  const code = error instanceof AuroraApiError ? error.code : null;
  const session = ownerName ? sessionTitle(ownerName) : 'This session';
  switch (code) {
    case 'SESSION_INVITE_NOT_FOUND': return "This invite link doesn't work any more.";
    case 'SESSION_NOT_JOINABLE': return `${session} is private right now.`;
    case 'PLAYBACK_SYNC_DISABLED': return `${session} can't be shared: sync across devices is off.`;
    default: return "Couldn't reach the server.";
  }
}

// --- What the session follower reads -------------------------------------

/** The user's own session changed (or there is none). */
export function noteOwnSession(session: PlaybackSession | null): void {
  const previous = store.getState().ownSessionId;
  if (!session) {
    if (previous) store.setState({ ownSessionId: null, own: null });
    return;
  }
  const visibility = session.visibility ?? 'private';
  const own = store.getState().own;
  if (previous !== session.id) {
    store.setState({ ownSessionId: session.id, own: { visibility, guests: [] } });
    void refreshOwn();
  } else if (own && own.visibility !== visibility) {
    store.setState({ own: { ...own, visibility } });
  }
}

/** The session this user is a guest in, as listed or read (or none). */
export function noteSharedSession(session: PlaybackSession | null): void {
  if (!session) {
    clearShared();
    return;
  }
  noteSharedSessionId(session.id);
}

/** Whether `sessionId` is the session this user is a guest in: its events aren't this user's own. */
export function isSharedSession(sessionId: string): boolean {
  const { shared, openedSessionId } = store.getState();
  return shared?.sessionId === sessionId || openedSessionId === sessionId;
}

/** The shared session this device shows, if any: the session follower follows it. */
export function openedSharedSession(): string | null {
  return store.getState().openedSessionId;
}

/** Out of the shared session (left, removed, ended, gone): every device back to the user's own. */
function clearShared(): void {
  const { shared, openedSessionId } = store.getState();
  if (shared || openedSessionId) store.setState({ shared: null, openedSessionId: null });
}

/**
 * Joining ends the user's own playback (decided, docs/listen-together.md):
 * here, by pausing or stopping the cast (no handoff), and on another of
 * their devices that plays their session, by a pause sent to it. Their own
 * queue stays, to return to.
 */
async function stopOwnPlayback(): Promise<void> {
  const player = usePlayerStore.getState();
  const elsewhere = player.sessionFollow;
  if (player.castConnected) castManager.stopCastingBecauseReplaced('listening-together');
  else if (player.playbackState === 'playing') player.pause();
  sessionMirror.endOutput('listening-together');
  if (elsewhere && !elsewhere.silent && isFollowedOutputPlaying(elsewhere)) {
    await sendRemoteAction({ type: 'pause' }, elsewhere, {
      auth: auth(),
      sessionRevision: () => sessionFollower.sessionRevision(),
    });
  }
}

/** Shows the shared session on this device, its own playback ended first. */
export async function openSharedSession(): Promise<void> {
  const shared = store.getState().shared;
  if (!shared || store.getState().openedSessionId === shared.sessionId) return;
  await stopOwnPlayback();
  store.setState({ openedSessionId: shared.sessionId });
}

/** Marks the session at once (events for it must not count as the user's own), then reads its owner. */
function noteSharedSessionId(sessionId: string, owner?: { name: string; avatar: UserAvatar }): void {
  const current = store.getState().shared;
  if (current?.sessionId === sessionId && (current.ownerName || !owner)) return;
  store.setState({ shared: { sessionId, ownerName: owner?.name ?? null, owner: owner?.avatar ?? null } });
  if (owner) return;
  void api.listSessionMembers(auth(), sessionId).then((members) => {
    if (store.getState().shared?.sessionId !== sessionId) return;
    store.setState({ shared: { sessionId, ownerName: members.owner.username, owner: members.owner.avatar } });
  }).catch(() => {
    // Shown without the owner's name until the next read.
  });
}

/** Re-reads who is in the user's own session. */
export async function refreshOwn(): Promise<void> {
  const sessionId = store.getState().ownSessionId;
  if (!sessionId) return;
  try {
    const members = await api.listSessionMembers(auth(), sessionId);
    const own = store.getState().own;
    if (store.getState().ownSessionId !== sessionId) return;
    store.setState({ own: { visibility: own?.visibility ?? 'private', guests: members.guests } });
  } catch {
    // The sheet keeps what it showed; the next event reads again.
  }
}

/** Listen together's events on /events (the follower passes them on). */
export function onTogetherEvent(type: string, data: Record<string, unknown>): void {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
  const { ownSessionId, own, shared } = store.getState();
  const isOwn = !!sessionId && sessionId === ownSessionId;
  switch (type) {
    case 'playbackSession.invitePrompt': {
      const preview = data.preview as SessionInvitePreview | undefined;
      if (typeof data.token !== 'string' || !preview || shared?.sessionId === preview.sessionId) return;
      store.setState({ prompt: { token: data.token, preview } });
      return;
    }
    case 'playbackSession.memberJoined':
      if (isOwn) void refreshOwn();
      // Joined on another of this user's devices.
      else if (sessionId && data.userId === me()) noteSharedSessionId(sessionId);
      return;
    case 'playbackSession.memberLeft':
      if (isOwn) void refreshOwn();
      if (sessionId && data.userId === me() && shared?.sessionId === sessionId) {
        clearShared();
        const owner = shared.ownerName ?? 'The owner';
        if (data.reason === 'removed') toast(`${owner} removed you.`, 'info');
        else if (data.reason === 'ended') toast(`${owner} ended listening together.`, 'info');
      }
      return;
    case 'playbackSession.visibilityChanged':
      if (isOwn && own && typeof data.visibility === 'string') {
        store.setState({ own: { ...own, visibility: data.visibility as typeof own.visibility } });
      }
      return;
    case 'playbackSession.togetherEnded':
      if (isOwn) store.setState({ own: { visibility: 'private', guests: [] } });
      return;
  }
}

// --- The invitee ---------------------------------------------------------

/** A `/listen/<token>` link: shows its preview, unless this user is in that session already. */
export async function openInviteLink(token: string): Promise<void> {
  try {
    const preview = await api.previewSessionInvite(auth(), token);
    if (preview.joined) {
      // In it already: the link shows it here.
      if (preview.sessionId !== store.getState().ownSessionId) {
        noteSharedSessionId(preview.sessionId, { name: preview.ownerName, avatar: preview.owner });
        await openSharedSession();
      }
      return;
    }
    store.setState({ prompt: { token, preview } });
  } catch (error) {
    toast(failure(error));
  }
}

export function dismissInvite(): void {
  store.setState({ prompt: null });
}

export async function joinInvite(): Promise<boolean> {
  const prompt = store.getState().prompt;
  if (!prompt) return false;
  const { preview } = prompt;
  // Closes at once: joining just takes effect (no status text while it works).
  store.setState({ prompt: null });
  try {
    const session = await api.joinSessionByInvite(auth(), prompt.token);
    if (session.access?.role === 'guest') {
      noteSharedSessionId(session.id, { name: preview.ownerName, avatar: preview.owner });
      // The device joined on shows the session.
      await openSharedSession();
    }
    return true;
  } catch (error) {
    toast(failure(error, preview.ownerName));
    return false;
  }
}

/** The guest leaves the session it is in. */
export async function leaveSharedSession(): Promise<void> {
  const shared = store.getState().shared;
  const userId = me();
  if (!shared || !userId) return;
  try {
    await api.removeSessionMember(auth(), shared.sessionId, userId);
    clearShared();
  } catch (error) {
    if (error instanceof AuroraApiError && error.status === 404) {
      clearShared();
      return;
    }
    toast(`Couldn't leave ${shared.ownerName ? sessionTitle(shared.ownerName) : 'the session'}.`);
  }
}

// --- The owner -----------------------------------------------------------

async function ownAction<T>(run: (sessionId: string) => Promise<T>, message: string): Promise<T | null> {
  const sessionId = store.getState().ownSessionId;
  if (!sessionId) return null;
  try {
    return await run(sessionId);
  } catch {
    toast(message);
    return null;
  }
}

export async function setSharing(visibility: 'private' | 'invite'): Promise<void> {
  const session = await ownAction((id) => api.setSessionSharing(auth(), id, visibility), "Couldn't change who can join.");
  const own = store.getState().own;
  if (session && own) store.setState({ own: { ...own, visibility: session.visibility ?? visibility } });
}

/**
 * The session's join link: the newest working one while it is open to
 * invites; a fresh one when it is private (closing it revoked the old ones).
 */
async function joinLink(sessionId: string) {
  const open = store.getState().own?.visibility !== 'private';
  const [newest] = open ? await api.listSessionInvites(auth(), sessionId) : [];
  const link = newest ?? await api.createSessionInvite(auth(), sessionId);
  // Making a link opens a private session to invites.
  const own = store.getState().own;
  if (own && own.visibility === 'private') store.setState({ own: { ...own, visibility: 'invite' } });
  return link;
}

/** The join link as a full URL, for copying or sharing. */
export async function inviteUrl(): Promise<string | null> {
  const link = await ownAction((id) => joinLink(id), "Couldn't make an invite link.");
  return link ? listenUrl(link.path) : null;
}

/** Prompts an online user with the session's join link. */
export async function inviteUser(userId: string): Promise<boolean> {
  const result = await ownAction(async (id) => {
    const link = await joinLink(id);
    return api.promptSessionInvite(auth(), id, link.token, [userId]);
  }, "Couldn't send the invite.");
  return !!result && result.prompted > 0;
}

export async function removeGuest(userId: string): Promise<void> {
  const done = await ownAction((id) => api.removeSessionMember(auth(), id, userId).then(() => true), "Couldn't remove them.");
  const own = store.getState().own;
  if (done && own) store.setState({ own: { ...own, guests: own.guests.filter((guest) => guest.avatar.userId !== userId) } });
}

export async function endTogether(): Promise<void> {
  const session = await ownAction((id) => api.endListeningTogether(auth(), id), "Couldn't end listening together.");
  if (session) store.setState({ own: { visibility: 'private', guests: [] } });
}

export async function loadOnlineUsers() {
  try {
    return await api.listOnlineUsers(auth());
  } catch {
    return [];
  }
}
