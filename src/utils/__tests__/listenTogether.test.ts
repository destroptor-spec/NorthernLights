import type { PlaybackSession, SessionInvitePreview, SessionMembers } from '../../../shared/api/v1';
import { AuroraApiError } from '../../api/auroraApi';
import * as api from '../../api/listenTogether';
import { usePlayerStore } from '../../store';
import { useListenTogetherStore } from '../../store/listenTogether';
import {
  endTogether,
  inviteUrl,
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

jest.mock('../../api/listenTogether');
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
beforeEach(() => {
  jest.resetAllMocks();
  addToast = jest.fn();
  usePlayerStore.setState({ currentUser: { id: 'me', username: 'bo', role: 'user' }, addToast, getAuthHeader: () => ({}) } as never);
  useListenTogetherStore.setState({ ownSessionId: null, own: null, shared: null, prompt: null });
  mocked.listSessionMembers.mockResolvedValue(members());
});

it('names a session after its owner, and says how many others without naming them', () => {
  expect(sessionTitle('Andreas')).toBe("Andreas' session");
  expect(sessionTitle('Bo')).toBe("Bo's session");
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
    expect(useListenTogetherStore.getState().shared).toEqual({ sessionId: 'shared-1', ownerName: 'Andreas', owner: OWNER });
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
    expect(addToast).toHaveBeenLastCalledWith("Andreas' session is private right now.", 'error');
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
    expect(addToast).toHaveBeenLastCalledWith('Andreas ended listening together.', 'info');

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
    expect(useListenTogetherStore.getState().shared).toEqual({ sessionId: 'shared-2', ownerName: 'Andreas', owner: OWNER });
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
    expect(useListenTogetherStore.getState().own).toEqual({ visibility: 'private', guests: [guest] });
    mocked.listSessionMembers.mockResolvedValue(members());
    onTogetherEvent('playbackSession.memberLeft', { sessionId: 'own-1', userId: 'g-1', reason: 'left' });
    await flush();
    expect(useListenTogetherStore.getState().own?.guests).toEqual([]);
  });

  it('reuses the newest working link, or makes one (which opens the session to invites)', async () => {
    mocked.listSessionInvites.mockResolvedValue([]);
    mocked.createSessionInvite.mockResolvedValue({ token: 'new', path: '/listen/new', permissions: ['transport'], createdAt: '' });
    expect(await inviteUrl()).toBe(`${window.location.origin}/listen/new`);
    expect(useListenTogetherStore.getState().own?.visibility).toBe('invite');

    mocked.listSessionInvites.mockResolvedValue([{ token: 'old', path: '/listen/old', permissions: ['transport'], createdAt: '' }]);
    expect(await inviteUrl()).toBe(`${window.location.origin}/listen/old`);
    expect(mocked.createSessionInvite).toHaveBeenCalledTimes(1);
  });

  it('takes a fresh link for a private session, never the old one', async () => {
    mocked.listSessionInvites.mockResolvedValue([{ token: 'old', path: '/listen/old', permissions: ['transport'], createdAt: '' }]);
    mocked.createSessionInvite.mockResolvedValue({ token: 'new', path: '/listen/new', permissions: ['transport'], createdAt: '' });
    expect(await inviteUrl()).toBe(`${window.location.origin}/listen/new`);
    expect(mocked.listSessionInvites).not.toHaveBeenCalled();
  });

  it('ending clears the guests and makes the session private', async () => {
    mocked.endListeningTogether.mockResolvedValue(session('own-1'));
    await endTogether();
    expect(useListenTogetherStore.getState().own).toEqual({ visibility: 'private', guests: [] });
  });

  it('visibility changes from another of the owner\'s devices show here', () => {
    onTogetherEvent('playbackSession.visibilityChanged', { sessionId: 'own-1', visibility: 'invite' });
    expect(useListenTogetherStore.getState().own?.visibility).toBe('invite');
  });
});
