import { act, fireEvent, render, screen } from '@testing-library/react';
import { usePlayerStore } from '../../store';
import { useListenTogetherStore } from '../../store/listenTogether';
import * as together from '../../utils/listenTogether';
import { InvitePrompt } from '../InvitePrompt';
import { ListenTogetherPanel } from '../ListenTogetherPanel';
import { ConnectMenuContent } from '../ConnectMenu';
import type { CastStatus } from '../../hooks/useCastStatus';

jest.mock('../../hooks/useCastStatus', () => ({
  useCastStatus: (): CastStatus => ({ available: false, connected: false, busy: false, deviceName: '' }),
}));
jest.mock('../../utils/listenTogether', () => ({
  ...jest.requireActual('../../utils/listenTogether'),
  joinInvite: jest.fn(async () => true),
  dismissInvite: jest.fn(),
  refreshOwn: jest.fn(async () => undefined),
  loadOnlineUsers: jest.fn(async () => []),
  setSharing: jest.fn(async () => undefined),
  inviteUrl: jest.fn(async () => 'https://aurora.test/listen/tok'),
  inviteUser: jest.fn(async () => true),
  removeGuest: jest.fn(async () => undefined),
  endTogether: jest.fn(async () => undefined),
  leaveSharedSession: jest.fn(async () => undefined),
  openSharedSession: jest.fn(async () => undefined),
}));
const mocked = together as jest.Mocked<typeof together>;

const avatar = (userId: string, initial: string) => ({ userId, initial, pictureUrl: null });
const guest = (userId: string, username: string) => ({
  username, avatar: avatar(userId, username[0].toUpperCase()), role: 'guest' as const, permissions: ['transport' as const], joinedAt: '2026-10-27T12:00:00.000Z',
});

beforeEach(() => {
  jest.clearAllMocks();
  act(() => {
    useListenTogetherStore.setState({ ownSessionId: null, own: null, shared: null, prompt: null, openedSessionId: null });
    usePlayerStore.setState({
      sessionFollow: null, remoteControlOutputId: null, castConnected: false, audioOutputSupported: false,
      syncPlaybackAcrossDevices: true, connectedDevices: [],
    } as never);
  });
});

describe('the invitation', () => {
  it("shows the owner's session and avatars, but never a guest's name", () => {
    act(() => {
      useListenTogetherStore.setState({
        prompt: {
          token: 'tok',
          preview: { ownerName: 'Andreas', owner: avatar('o', 'A'), guests: [avatar('g1', 'B'), avatar('g2', 'C')], sessionId: 's', joined: false },
        },
      });
    });
    render(<InvitePrompt />);
    expect(screen.getByRole('heading', { name: "Andreas' session" })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Andreas and 2 others' })).toBeTruthy();
    screen.getByRole('button', { name: 'Join' }).click();
    expect(mocked.joinInvite).toHaveBeenCalled();
    screen.getByRole('button', { name: 'Not now' }).click();
    expect(mocked.dismissInvite).toHaveBeenCalled();
  });

  it('stacks four guests and counts the rest', () => {
    const guests = ['B', 'C', 'D', 'E', 'F', 'G'].map((initial, index) => avatar(`g${index}`, initial));
    act(() => {
      useListenTogetherStore.setState({ prompt: { token: 'tok', preview: { ownerName: 'Bo', owner: avatar('o', 'B'), guests, sessionId: 's', joined: false } } });
    });
    render(<InvitePrompt />);
    expect(screen.getByText('+2')).toBeTruthy();
    expect(screen.queryByText('F')).toBeNull();
  });
});

describe("the owner's sheet", () => {
  it('sets who can join, and copies the invite link', async () => {
    const writeText = jest.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    act(() => { useListenTogetherStore.setState({ ownSessionId: 's', own: { visibility: 'private', guests: [] } }); });
    render(<ListenTogetherPanel onBack={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Private' }).getAttribute('aria-pressed')).toBe('true');
    // Nothing to end while it is private and nobody is in.
    expect(screen.queryByRole('button', { name: /End listening together/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Invite only' }));
    expect(mocked.setSharing).toHaveBeenCalledWith('invite');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy invite link/ })); });
    expect(writeText).toHaveBeenCalledWith('https://aurora.test/listen/tok');
  });

  it('shows the link to copy by hand when the clipboard refuses', async () => {
    Object.assign(navigator, { clipboard: { writeText: jest.fn(async () => { throw new Error('denied'); }) } });
    act(() => { useListenTogetherStore.setState({ ownSessionId: 's', own: { visibility: 'invite', guests: [] } }); });
    render(<ListenTogetherPanel onBack={jest.fn()} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy invite link/ })); });
    expect((screen.getByRole('textbox', { name: 'Invite link' }) as HTMLInputElement).value).toBe('https://aurora.test/listen/tok');
  });

  it('lists the guests to remove, and invites people online who are not in yet', async () => {
    mocked.loadOnlineUsers.mockResolvedValue([
      { username: 'bo', avatar: avatar('g1', 'B') },
      { username: 'zoe', avatar: avatar('z', 'Z') },
    ]);
    act(() => { useListenTogetherStore.setState({ ownSessionId: 's', own: { visibility: 'invite', guests: [guest('g1', 'bo')] } }); });
    await act(async () => { render(<ListenTogetherPanel onBack={jest.fn()} />); });

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(mocked.removeGuest).toHaveBeenCalledWith('g1');
    expect(screen.queryByRole('button', { name: 'Invite bo' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Invite zoe' })); });
    expect(mocked.inviteUser).toHaveBeenCalledWith('z');
    expect((screen.getByRole('button', { name: 'Invited zoe' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('ends listening together on the second tap', () => {
    act(() => { useListenTogetherStore.setState({ ownSessionId: 's', own: { visibility: 'invite', guests: [guest('g1', 'bo')] } }); });
    render(<ListenTogetherPanel onBack={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'End listening together' }));
    expect(mocked.endTogether).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'End for everyone? Tap to confirm' }));
    expect(mocked.endTogether).toHaveBeenCalled();
  });
});

describe('Connect', () => {
  it('opens the sheet from a Listen together row once the user has a session', () => {
    const first = render(<ConnectMenuContent onDone={jest.fn()} />);
    expect(screen.queryByRole('button', { name: /Listen together/ })).toBeNull();
    first.unmount();

    act(() => { useListenTogetherStore.setState({ ownSessionId: 's', own: { visibility: 'invite', guests: [guest('g1', 'bo')] } }); });
    render(<ConnectMenuContent onDone={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Listen together 1 listening with you/ }));
    expect(screen.getByRole('dialog', { name: 'Listen together' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Connect' }));
    expect(screen.getByRole('dialog', { name: 'Connect' })).toBeTruthy();
  });

  it("offers the user's other devices to open the shared session", () => {
    act(() => { useListenTogetherStore.setState({ shared: { sessionId: 'shared', ownerName: 'Andreas', owner: avatar('o', 'A') } }); });
    render(<ConnectMenuContent onDone={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Listening with Andreas Open/ }));
    expect(mocked.openSharedSession).toHaveBeenCalled();
  });

  it("on the device that shows it: the session's playing device, marked, and Leave; where it plays isn't the guest's", () => {
    act(() => {
      useListenTogetherStore.setState({ shared: { sessionId: 'shared', ownerName: 'Andreas', owner: avatar('o', 'A') }, openedSessionId: 'shared', ownSessionId: 'own' });
      usePlayerStore.setState({
        sessionFollow: { sessionId: 'shared', outputId: 'receiver:nad', name: 'NAD Forstærker', kind: 'receiver', generation: 3, state: 'playing', entryId: 'e1', positionMs: 0, anchorMs: 0 },
        connectedDevices: [{ clientId: 'phone-2', name: 'Chrome on Android', kind: 'browser' }],
      } as never);
    });
    render(<ConnectMenuContent onDone={jest.fn()} />);
    expect(screen.getByText('Listening with Andreas')).toBeTruthy();
    expect(screen.getByRole('button', { name: /NAD Forstærker Playing/ }).className).toContain('is-selected');
    for (const name of [/This device/, /Cast to a device/, /Chrome on Android/, /^Listen together/]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    fireEvent.click(screen.getByRole('button', { name: /Leave Back to your own music/ }));
    expect(mocked.leaveSharedSession).toHaveBeenCalled();
  });

  it('shows none of it while sync is off', () => {
    act(() => {
      usePlayerStore.setState({ syncPlaybackAcrossDevices: false } as never);
      useListenTogetherStore.setState({ ownSessionId: 's', shared: { sessionId: 'shared', ownerName: 'Andreas', owner: null } });
    });
    render(<ConnectMenuContent onDone={jest.fn()} />);
    expect(screen.queryByRole('button', { name: /Listen/ })).toBeNull();
  });
});
