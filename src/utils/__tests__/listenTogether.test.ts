import type { PlaybackSession, SessionInvitePreview, SessionMembers } from '../../../shared/api/v1';
import { AuroraApiError } from '../../api/auroraApi';
import * as api from '../../api/listenTogether';
import { usePlayerStore } from '../../store';
import { useListenTogetherStore } from '../../store/listenTogether';
import {
  configureListenTogether,
  endTogether,
  openSharedSession,
  copyInviteLink,
  guestMay,
  joinNearby,
  setDiscoverable,
  setGigLevel,
  startGig,
  isSharedSession,
  joinInvite,
  leaveSharedSession,
  noteOwnSession,
  noteSharedSession,
  onTogetherEvent,
  openInviteLink,
  previewLabel,
  sessionTitle,
} from '../listenTogether';

import { sendRemoteAction } from '../sessionRemote';

jest.mock('../../api/listenTogether');
jest.mock('../sessionRemote', () => ({ ...jest.requireActual('../sessionRemote'), sendRemoteAction: jest.fn(async () => 'sent') }));
const mocked = api as jest.Mocked<typeof api>;

const avatar = (userId: string, initial: string) => ({ userId, initial, pictureUrl: null });
const OWNER = avatar('owner-1', 'A');
const preview = (extra: Partial<SessionInvitePreview> = {}): SessionInvitePreview => ({
  ownerName: 'Andreas', owner: OWNER, guests: [avatar('g-1', 'B')], sessionId: 'shared-1', joined: false, ...extra,
});
const members = (guests: SessionMembers['guests'] = []): SessionMembers => ({
  owner: { username: 'Andreas', avatar: OWNER, role: 'owner', permissions: ['transport', 'queue', 'replace'], joinedAt: null },
  guests,
});
const session = (id: string, extra: Partial<PlaybackSession> = {}) => ({ id, visibility: 'private', ...extra }) as PlaybackSession;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let addToast: jest.Mock;
const controls = { stopCasting: jest.fn(), endOutput: jest.fn(), sessionRevision: jest.fn(() => 12) };
beforeEach(() => {
  jest.resetAllMocks();
  addToast = jest.fn();
  usePlayerStore.setState({ currentUser: { id: 'me', username: 'bo', role: 'user' }, addToast, getAuthHeader: () => ({}) } as never);
  useListenTogetherStore.setState({ ownSessionId: null, own: null, shared: null, prompt: null, openedSessionId: null, available: [] });
  usePlayerStore.setState({ playbackState: 'paused', castConnected: false, sessionFollow: null } as never);
  mocked.listSessionMembers.mockResolvedValue(members());
  configureListenTogether(controls);
});
afterEach(() => jest.restoreAllMocks());

it('names a session after its owner, and says how many others without naming them', () => {
  expect(sessionTitle('Andreas')).toBe("Andreas' Gig");
  expect(sessionTitle('Bo')).toBe("Bo's Gig");
  expect(previewLabel('Bo', 0)).toBe('Bo');
  expect(previewLabel('Bo', 1)).toBe('Bo and 1 other');
  expect(previewLabel('Bo', 3)).toBe('Bo and 3 others');
});

describe('the invitee', () => {
  it('a link shows its preview; joining makes the session the shared one and closes the prompt at once', async () => {
    mocked.previewSessionInvite.mockResolvedValue(preview());
    await openInviteLink('tok');
    expect(useListenTogetherStore.getState().prompt).toEqual({ token: 'tok', preview: preview() });

    mocked.joinSessionByInvite.mockResolvedValue(session('shared-1', { access: { role: 'guest', permissions: ['transport'] } }));
    const joining = joinInvite();
    expect(useListenTogetherStore.getState().prompt).toBeNull();
    expect(await joining).toBe(true);
    expect(useListenTogetherStore.getState().shared).toEqual({ sessionId: 'shared-1', ownerName: 'Andreas', owner: OWNER, permissions: ['transport'] });
    expect(isSharedSession('shared-1')).toBe(true);
    expect(addToast).not.toHaveBeenCalled();
  });

  it('a link to a session this user is in already shows nothing', async () => {
    mocked.previewSessionInvite.mockResolvedValue(preview({ joined: true }));
    await openInviteLink('tok');
    expect(useListenTogetherStore.getState().prompt).toBeNull();
    expect(useListenTogetherStore.getState().shared?.sessionId).toBe('shared-1');
  });

  it('says why a link or a join failed, and only then', async () => {
    mocked.previewSessionInvite.mockRejectedValue(new AuroraApiError('gone', 404, 'SESSION_INVITE_NOT_FOUND'));
    await openInviteLink('tok');
    expect(addToast).toHaveBeenLastCalledWith("This invite link doesn't work any more.", 'error');

    useListenTogetherStore.setState({ prompt: { token: 'tok', preview: preview() } });
    mocked.joinSessionByInvite.mockRejectedValue(new AuroraApiError('private', 409, 'SESSION_NOT_JOINABLE'));
    expect(await joinInvite()).toBe(false);
    expect(addToast).toHaveBeenLastCalledWith("Andreas' Gig is private right now.", 'error');
    expect(useListenTogetherStore.getState().shared).toBeNull();
  });

  it('a prompt from an owner opens the same preview, unless this user is in that session', () => {
    onTogetherEvent('playbackSession.invitePrompt', { sessionId: 'shared-1', token: 'tok', path: '/listen/tok', preview: preview() });
    expect(useListenTogetherStore.getState().prompt?.token).toBe('tok');

    useListenTogetherStore.setState({ prompt: null, shared: { sessionId: 'shared-1', ownerName: 'Andreas', owner: OWNER } });
    onTogetherEvent('playbackSession.invitePrompt', { sessionId: 'shared-1', token: 'tok', path: '/listen/tok', preview: preview() });
    expect(useListenTogetherStore.getState().prompt).toBeNull();
  });
});

describe('the guest', () => {
  beforeEach(() => {
    useListenTogetherStore.setState({ shared: { sessionId: 'shared-1', ownerName: 'Andreas', owner: OWNER } });
  });

  it('leaves the shared session', async () => {
    mocked.removeSessionMember.mockResolvedValue(undefined);
    await leaveSharedSession();
    expect(mocked.removeSessionMember).toHaveBeenCalledWith({}, 'shared-1', 'me');
    expect(useListenTogetherStore.getState().shared).toBeNull();
  });

  it('is told when the owner removed it or ended listening together; not when it left on another device', () => {
    onTogetherEvent('playbackSession.memberLeft', { sessionId: 'shared-1', userId: 'me', reason: 'removed' });
    expect(useListenTogetherStore.getState().shared).toBeNull();
    expect(addToast).toHaveBeenLastCalledWith('Andreas removed you.', 'info');

    useListenTogetherStore.setState({ shared: { sessionId: 'shared-1', ownerName: 'Andreas', owner: OWNER } });
    onTogetherEvent('playbackSession.memberLeft', { sessionId: 'shared-1', userId: 'me', reason: 'ended' });
    expect(addToast).toHaveBeenLastCalledWith('Andreas ended the gig.', 'info');

    addToast.mockClear();
    useListenTogetherStore.setState({ shared: { sessionId: 'shared-1', ownerName: 'Andreas', owner: OWNER } });
    onTogetherEvent('playbackSession.memberLeft', { sessionId: 'shared-1', userId: 'me', reason: 'left' });
    expect(useListenTogetherStore.getState().shared).toBeNull();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('another guest leaving changes nothing here', () => {
    onTogetherEvent('playbackSession.memberLeft', { sessionId: 'shared-1', userId: 'someone', reason: 'removed' });
    expect(useListenTogetherStore.getState().shared?.sessionId).toBe('shared-1');
  });

  it('a join on another of this user\'s devices marks the session at once, then reads its owner', async () => {
    useListenTogetherStore.setState({ shared: null });
    onTogetherEvent('playbackSession.memberJoined', { sessionId: 'shared-2', userId: 'me', avatar: avatar('me', 'B') });
    expect(isSharedSession('shared-2')).toBe(true);
    await flush();
    expect(useListenTogetherStore.getState().shared).toMatchObject({ sessionId: 'shared-2', ownerName: 'Andreas', owner: OWNER });
  });

  it('the follower listing no shared session clears it', () => {
    noteSharedSession(null);
    expect(useListenTogetherStore.getState().shared).toBeNull();
  });
});

describe('the owner', () => {
  const guest = { username: 'bo', avatar: avatar('g-1', 'B'), role: 'guest' as const, permissions: ['transport' as const], joinedAt: '2026-10-27T12:00:00.000Z' };

  beforeEach(async () => {
    mocked.listSessionMembers.mockResolvedValue(members([guest]));
    noteOwnSession(session('own-1'));
    await flush();
  });

  it("reads who is in the user's own session, and again when someone joins or leaves", async () => {
    expect(useListenTogetherStore.getState().own).toMatchObject({ visibility: 'private', guests: [guest], ownerAvatar: OWNER });
    mocked.listSessionMembers.mockResolvedValue(members());
    onTogetherEvent('playbackSession.memberLeft', { sessionId: 'own-1', userId: 'g-1', reason: 'left' });
    await flush();
    expect(useListenTogetherStore.getState().own?.guests).toEqual([]);
  });

  it('starts a gig with a link at the first level, Queue Editor', async () => {
    mocked.createSessionInvite.mockResolvedValue({ token: 'new', path: '/listen/new', permissions: ['queue'], createdAt: '' });
    await startGig();
    expect(mocked.createSessionInvite).toHaveBeenCalledWith({}, 'own-1', ['queue']);
    expect(useListenTogetherStore.getState().own).toMatchObject({ visibility: 'invite', permissions: ['queue'] });
  });

  it('moves the level for everyone at once, and puts it back if the server refuses', async () => {
    mocked.setSessionSharing.mockResolvedValue(session('own-1', { visibility: 'invite' }));
    await setGigLevel(2);
    expect(mocked.setSessionSharing).toHaveBeenCalledWith({}, 'own-1', { permissions: ['queue', 'transport'] });
    expect(useListenTogetherStore.getState().own?.permissions).toEqual(['queue', 'transport']);
    mocked.setSessionSharing.mockRejectedValue(new Error('offline'));
    await setGigLevel(3);
    expect(useListenTogetherStore.getState().own?.permissions).toEqual(['queue', 'transport']);
    expect(addToast).toHaveBeenLastCalledWith("Couldn't change what guests can do.", 'error');
  });

  it('makes the gig discoverable, or not', async () => {
    mocked.setSessionSharing.mockResolvedValue(session('own-1', { visibility: 'discoverable' }));
    await setDiscoverable(true);
    expect(mocked.setSessionSharing).toHaveBeenCalledWith({}, 'own-1', { visibility: 'discoverable' });
    expect(useListenTogetherStore.getState().own?.visibility).toBe('discoverable');
  });

  it('copies the newest working link and says so', async () => {
    const writeText = jest.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mocked.listSessionInvites.mockResolvedValue([{ token: 'old', path: '/listen/old', permissions: ['queue'], createdAt: '' }]);
    await copyInviteLink();
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/listen/old`);
    expect(addToast).toHaveBeenLastCalledWith('Link copied!', 'info');
    expect(mocked.createSessionInvite).not.toHaveBeenCalled();
  });

  it('ending clears the guests and the level, and makes the session private', async () => {
    mocked.endListeningTogether.mockResolvedValue(session('own-1'));
    await endTogether();
    expect(useListenTogetherStore.getState().own).toMatchObject({ visibility: 'private', guests: [], permissions: null });
  });

  it("visibility and level changes from another of the owner's devices show here", () => {
    onTogetherEvent('playbackSession.visibilityChanged', { sessionId: 'own-1', visibility: 'invite' });
    onTogetherEvent('playbackSession.accessChanged', { sessionId: 'own-1', permissions: ['queue', 'transport', 'replace'] });
    expect(useListenTogetherStore.getState().own).toMatchObject({ visibility: 'invite', permissions: ['queue', 'transport', 'replace'] });
  });
});

describe('gigs nearby (6e)', () => {
  const gig = preview({ sessionId: 'nearby-1', guests: [] });

  it('a gig appearing or going nearby reads the list again', async () => {
    mocked.listNearbyGigs.mockResolvedValue([gig]);
    onTogetherEvent('playbackSession.discoverable', { sessionId: 'nearby-1', discoverable: true });
    await flush();
    expect(useListenTogetherStore.getState().available).toEqual([gig]);
  });

  it('joining one makes it the shared gig, shown here, at its level', async () => {
    useListenTogetherStore.setState({ available: [gig] });
    mocked.joinNearbyGig.mockResolvedValue(session('nearby-1', { access: { role: 'guest', permissions: ['queue'] } }));
    await joinNearby(gig);
    expect(useListenTogetherStore.getState()).toMatchObject({
      openedSessionId: 'nearby-1',
      shared: { sessionId: 'nearby-1', ownerName: 'Andreas', permissions: ['queue'] },
      available: [],
    });
  });

  it("says when a gig isn't there any more", async () => {
    mocked.joinNearbyGig.mockRejectedValue(new AuroraApiError('gone', 404, 'PLAYBACK_SESSION_NOT_FOUND'));
    mocked.listNearbyGigs.mockResolvedValue([]);
    await joinNearby(gig);
    expect(addToast).toHaveBeenLastCalledWith("Andreas' Gig isn't available any more.", 'error');
  });
});

describe("a guest's level", () => {
  it('decides what this device may do while it shows the gig, and follows the owner moving it', () => {
    useListenTogetherStore.setState({ shared: { sessionId: 'shared-1', ownerName: 'Andreas', owner: OWNER, permissions: ['queue'] }, openedSessionId: 'shared-1' });
    expect(guestMay('queue')).toBe(true);
    expect(guestMay('transport')).toBe(false);
    onTogetherEvent('playbackSession.accessChanged', { sessionId: 'shared-1', permissions: ['queue', 'transport'] });
    expect(guestMay('transport')).toBe(true);
    expect(guestMay('replace')).toBe(false);
  });

  it("never limits the user's own session", () => {
    useListenTogetherStore.setState({ shared: { sessionId: 'shared-1', ownerName: 'Andreas', owner: OWNER, permissions: ['queue'] }, openedSessionId: null });
    expect(guestMay('replace')).toBe(true);
  });
});

describe('showing the shared session on a device (6d)', () => {
  const ownFollow = {
    sessionId: 'own-1', outputId: 'desktop', name: 'Chrome on Linux', kind: 'browser' as const, generation: 2,
    state: 'playing' as const, entryId: null, positionMs: 0, anchorMs: Date.now(),
  };

  it('the device joined on shows the session, its own playback ended first', async () => {
    const pause = jest.fn();
    usePlayerStore.setState({ playbackState: 'playing', pause } as never);
    useListenTogetherStore.setState({ prompt: { token: 'tok', preview: preview() } });
    mocked.joinSessionByInvite.mockResolvedValue(session('shared-1', { access: { role: 'guest', permissions: ['transport'] } }));
    await joinInvite();
    expect(pause).toHaveBeenCalled();
    expect(controls.endOutput).toHaveBeenCalled();
    expect(useListenTogetherStore.getState().openedSessionId).toBe('shared-1');
  });

  it('stops a cast without handing it back here, and pauses the user\'s own music on another device', async () => {
    usePlayerStore.setState({ castConnected: true, sessionFollow: ownFollow } as never);
    useListenTogetherStore.setState({ shared: { sessionId: 'shared-1', ownerName: 'Andreas', owner: OWNER } });
    await openSharedSession();
    expect(controls.stopCasting).toHaveBeenCalled();
    expect(sendRemoteAction).toHaveBeenCalledWith({ type: 'pause' }, ownFollow, expect.anything());
    expect(useListenTogetherStore.getState().openedSessionId).toBe('shared-1');
  });

  it('a link to a session this user is in opens it here', async () => {
    mocked.previewSessionInvite.mockResolvedValue(preview({ joined: true }));
    await openInviteLink('tok');
    expect(useListenTogetherStore.getState().openedSessionId).toBe('shared-1');
  });

  it("counts the opened session as shared before its owner is read (its claims aren't this user's)", () => {
    useListenTogetherStore.setState({ openedSessionId: 'shared-1' });
    expect(isSharedSession('shared-1')).toBe(true);
  });

  it('leaving, being removed, or the session going away takes every device back to its own', async () => {
    const open = () => useListenTogetherStore.setState({ shared: { sessionId: 'shared-1', ownerName: 'Andreas', owner: OWNER }, openedSessionId: 'shared-1' });
    open();
    mocked.removeSessionMember.mockResolvedValue(undefined);
    await leaveSharedSession();
    expect(useListenTogetherStore.getState().openedSessionId).toBeNull();

    open();
    onTogetherEvent('playbackSession.memberLeft', { sessionId: 'shared-1', userId: 'me', reason: 'removed' });
    expect(useListenTogetherStore.getState().openedSessionId).toBeNull();

    open();
    noteSharedSession(null);
    expect(useListenTogetherStore.getState().openedSessionId).toBeNull();
  });
});
