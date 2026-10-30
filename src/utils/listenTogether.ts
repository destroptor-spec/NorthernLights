import type { PlaybackSession, SessionInvitePreview, UserAvatar } from '../../shared/api/v1';
import { AuroraApiError } from '../api/auroraApi';
import * as api from '../api/listenTogether';
import { createPlaybackSession } from '../api/playbackSessions';
import { usePlayerStore } from '../store/index';
import { useListenTogetherStore as store, type SessionScope } from '../store/listenTogether';
import { isFollowedOutputPlaying } from './sessionFollow';
import { sendRemoteAction } from './sessionRemote';
import { GIG_LEVELS, previewLabel, sessionTitle } from './listenTogetherText';

// Listen together in the web app (docs/listen-together.md): the owner's gig
// in Connect (its line, discoverable, link, level, End), invitations
// (prompts and /listen/<token> links), gigs nearby ("Available gigs", 6e),
// and which session this user is a guest in. The device a guest joins on
// shows that session (6d): it follows it like another device's playback,
// and sends what is done here to the device that plays it.

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
  notePermissions(session.id, session.access?.permissions ?? null);
}

/** What this user may do in the shared session (its gig level). */
function notePermissions(sessionId: string, permissions: SessionScope[] | null) {
  const shared = store.getState().shared;
  if (shared?.sessionId !== sessionId || !permissions) return;
  if (shared.permissions && shared.permissions.join() === permissions.join()) return;
  store.setState({ shared: { ...shared, permissions } });
}

/**
 * Whether this device may do what needs `scope` (a guest's level). Always
 * on the user's own session; on a shared one, by the gig's level.
 */
export function guestMay(scope: SessionScope): boolean {
  const { openedSessionId, shared } = store.getState();
  if (!openedSessionId || !shared?.permissions) return true;
  return shared.permissions.includes(scope);
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
 * What ending the user's own playback needs from the playback singletons.
 * main.tsx passes them in: importing CastManager here gave the
 * CastManager/PlaybackManager import cycle a new way in (through ListenLink),
 * which broke loading it in tests.
 */
export interface OwnPlaybackControls {
  /** Stops casting without handing the music back here. */
  stopCasting: () => void;
  /** Reports this device's own output stopped, and claims nothing after. */
  endOutput: () => void;
  /** The own session's revision as last read, for a remote command. */
  sessionRevision: () => number | null;
}

let controls: OwnPlaybackControls | null = null;

export function configureListenTogether(own: OwnPlaybackControls): void {
  controls = own;
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
  if (player.castConnected) controls?.stopCasting();
  else if (player.playbackState === 'playing') player.pause();
  controls?.endOutput();
  if (elsewhere && !elsewhere.silent && isFollowedOutputPlaying(elsewhere)) {
    await sendRemoteAction({ type: 'pause' }, elsewhere, {
      auth: auth(),
      sessionRevision: () => controls?.sessionRevision() ?? null,
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
  const permissions = current?.sessionId === sessionId ? current.permissions ?? null : null;
  store.setState({ shared: { sessionId, ownerName: owner?.name ?? null, owner: owner?.avatar ?? null, permissions } });
  if (owner) return;
  void api.listSessionMembers(auth(), sessionId).then((members) => {
    const latest = store.getState().shared;
    if (latest?.sessionId !== sessionId) return;
    store.setState({ shared: { ...latest, ownerName: members.owner.username, owner: members.owner.avatar } });
  }).catch(() => {
    // Shown without the owner's name until the next read.
  });
}

/** Re-reads who is in the user's own session, and its gig's level. */
export async function refreshOwn(): Promise<void> {
  const sessionId = store.getState().ownSessionId;
  if (!sessionId) return;
  try {
    const open = store.getState().own?.visibility !== 'private';
    const [members, links] = await Promise.all([
      api.listSessionMembers(auth(), sessionId),
      open ? api.listSessionInvites(auth(), sessionId) : Promise.resolve([]),
    ]);
    const own = store.getState().own;
    if (store.getState().ownSessionId !== sessionId) return;
    store.setState({
      own: {
        visibility: own?.visibility ?? 'private',
        guests: members.guests,
        ownerAvatar: members.owner.avatar,
        permissions: links[0]?.permissions ?? own?.permissions ?? null,
      },
    });
  } catch {
    // The card keeps what it showed; the next event reads again.
  }
}

/** Discoverable gigs nearby ("Available gigs"), other than the one this user is in. */
export async function refreshNearby(): Promise<void> {
  try {
    store.setState({ available: await api.listNearbyGigs(auth()) });
  } catch {
    // Keeps what it showed.
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
        else if (data.reason === 'ended') toast(`${owner} ended the gig.`, 'info');
      }
      return;
    case 'playbackSession.accessChanged':
      // The owner moved the gig's level: it applies here at once.
      if (sessionId && Array.isArray(data.permissions)) notePermissions(sessionId, data.permissions as SessionScope[]);
      if (isOwn && own && Array.isArray(data.permissions)) store.setState({ own: { ...own, permissions: data.permissions as SessionScope[] } });
      return;
    case 'playbackSession.discoverable':
      void refreshNearby();
      return;
    case 'playbackSession.visibilityChanged':
      if (isOwn && own && typeof data.visibility === 'string') {
        store.setState({ own: { ...own, visibility: data.visibility as typeof own.visibility } });
      }
      return;
    case 'playbackSession.togetherEnded':
      if (isOwn) store.setState({ own: { ...own, visibility: 'private', guests: [], permissions: null } });
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
    await joined(await api.joinSessionByInvite(auth(), prompt.token), preview);
    return true;
  } catch (error) {
    toast(failure(error, preview.ownerName));
    return false;
  }
}

/** Joined: the session is the shared one, and the device joined on shows it. */
async function joined(session: PlaybackSession, preview: SessionInvitePreview) {
  if (session.access?.role !== 'guest') return;
  noteSharedSessionId(session.id, { name: preview.ownerName, avatar: preview.owner });
  notePermissions(session.id, session.access.permissions);
  await openSharedSession();
}

/** Joins a gig from "Available gigs". */
export async function joinNearby(preview: SessionInvitePreview): Promise<void> {
  try {
    await joined(await api.joinNearbyGig(auth(), preview.sessionId), preview);
    store.setState({ available: store.getState().available.filter((gig) => gig.sessionId !== preview.sessionId) });
  } catch (error) {
    toast(error instanceof AuroraApiError && error.status === 404
      ? `${sessionTitle(preview.ownerName)} isn't available any more.`
      : failure(error, preview.ownerName));
    void refreshNearby();
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

// --- The owner: the gig ------------------------------------------------

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

function setOwn(change: Partial<NonNullable<ReturnType<typeof store.getState>['own']>>) {
  const own = store.getState().own ?? { visibility: 'private' as const, guests: [] };
  store.setState({ own: { ...own, ...change } });
}

/**
 * Starts a gig: a link at the first level opens the session to it (private
 * until then). A user who never played anything here has no session yet,
 * so one is made.
 */
export async function startGig(): Promise<void> {
  if (!store.getState().ownSessionId) {
    try {
      noteOwnSession(await createPlaybackSession(auth(), 'Listening'));
    } catch {
      toast("Couldn't start the gig.");
      return;
    }
  }
  const first = GIG_LEVELS[0].scopes;
  const link = await ownAction((id) => api.createSessionInvite(auth(), id, first), "Couldn't start the gig.");
  if (!link) return;
  setOwn({ visibility: 'invite', permissions: link.permissions });
  // The line shows everyone in the gig, the owner first.
  void refreshOwn();
}

/** "Make discoverable": users nearby see the gig too (on), or only the link lets people in (off). */
export async function setDiscoverable(on: boolean): Promise<void> {
  const visibility = on ? 'discoverable' : 'invite';
  setOwn({ visibility });
  const session = await ownAction((id) => api.setSessionSharing(auth(), id, { visibility }), "Couldn't change who can find the gig.");
  setOwn({ visibility: session?.visibility ?? (on ? 'invite' : 'discoverable') });
}

/** The guests' level, for the link and every guest already in, at once. */
export async function setGigLevel(level: 1 | 2 | 3): Promise<void> {
  const before = store.getState().own?.permissions ?? null;
  const permissions = GIG_LEVELS[level - 1].scopes;
  setOwn({ permissions });
  const session = await ownAction((id) => api.setSessionSharing(auth(), id, { permissions }), "Couldn't change what guests can do.");
  if (!session) setOwn({ permissions: before });
}

/** Copies the gig's link (its newest working one, or a new one at its level), with a toast. */
export async function copyInviteLink(): Promise<void> {
  const link = await ownAction(async (id) => {
    const [newest] = await api.listSessionInvites(auth(), id);
    return newest ?? api.createSessionInvite(auth(), id, store.getState().own?.permissions ?? GIG_LEVELS[0].scopes);
  }, "Couldn't make an invite link.");
  if (!link) return;
  const url = listenUrl(link.path);
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied!', 'info');
  } catch {
    // No clipboard here (an insecure origin, a refused permission): the share sheet, if there is one.
    if (typeof navigator.share === 'function') await navigator.share({ title: 'Listen together', url }).catch(() => undefined);
    else toast("Couldn't copy the link.");
  }
}

/** Ends the gig: everyone out, links dead, private again. The music plays on. */
export async function endTogether(): Promise<void> {
  const session = await ownAction((id) => api.endListeningTogether(auth(), id), "Couldn't end the gig.");
  if (session) setOwn({ visibility: 'private', guests: [], permissions: null });
}
