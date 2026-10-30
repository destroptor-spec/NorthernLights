import { act, fireEvent, render, screen } from '@testing-library/react';
import { usePlayerStore } from '../../store';
import { useListenTogetherStore } from '../../store/listenTogether';
import * as together from '../../utils/listenTogether';
import { InvitePrompt } from '../InvitePrompt';
import { GigSection } from '../GigSection';
import { GigMembers } from '../GigMembers';
import { UserAvatar } from '../UserAvatar';
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
  refreshNearby: jest.fn(async () => undefined),
  startGig: jest.fn(async () => undefined),
  setDiscoverable: jest.fn(async () => undefined),
  setGigLevel: jest.fn(async () => undefined),
  copyInviteLink: jest.fn(async () => undefined),
  shareInviteLink: jest.fn(async () => undefined),
  prepareInviteLink: jest.fn(),
  removeGuest: jest.fn(async () => undefined),
  joinNearby: jest.fn(async () => undefined),
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
    useListenTogetherStore.setState({ ownSessionId: null, own: null, shared: null, prompt: null, openedSessionId: null, available: [], membersOpen: false });
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
    expect(screen.getByRole('heading', { name: "Andreas' Gig" })).toBeTruthy();
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

describe('avatars', () => {
  it('each user has their own aurora colors, the same wherever they show; a picture shows as it is', () => {
    const { container } = render(<><UserAvatar avatar={avatar('u-1', 'A')} /><UserAvatar avatar={avatar('u-1', 'A')} /><UserAvatar avatar={{ userId: 'u-2', initial: 'B', pictureUrl: '/p.jpg' }} /></>);
    const [first, again, picture] = Array.from(container.querySelectorAll<HTMLElement>('.user-avatar'));
    expect(first.className).toContain('is-aurora');
    expect(first.style.getPropertyValue('--avatar-from')).toMatch(/^#[0-9a-f]{6}$/);
    expect(again.getAttribute('style')).toBe(first.getAttribute('style'));
    expect(picture.className).not.toContain('is-aurora');
  });
});

describe("the owner's gig", () => {
  const people = (count: number) => Array.from({ length: count }, (_, index) => guest(`g${index}`, `guest${index}`));

  it('starts from a line like Output, and shows its controls only once started', () => {
    act(() => { useListenTogetherStore.setState({ ownSessionId: 's', own: { visibility: 'private', guests: [] } }); });
    const { container } = render(<GigSection />);
    expect(container.querySelector('.connect-gig')!.className).not.toContain('is-running');
    expect(container.querySelector('.connect-gig-body')!.hasAttribute('inert')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Start a gig Listen together/ }));
    expect(mocked.startGig).toHaveBeenCalled();
  });

  it('while it runs: the panel (Andreas, 2026-10-30), everyone on its edge (three, then +N), level, Open session, End gig and Invite', () => {
    act(() => {
      useListenTogetherStore.setState({
        ownSessionId: 's',
        own: { visibility: 'invite', guests: people(4), ownerAvatar: avatar('o', 'A'), permissions: ['queue'] },
      });
    });
    const { container } = render(<GigSection />);
    expect(container.querySelector('.connect-gig')!.className).toContain('is-running');
    expect(screen.queryByText('Start a gig')).toBeNull();
    expect(container.querySelectorAll('.gig-people .avatar-stack > .user-avatar:not(.avatar-stack-more)')).toHaveLength(3);
    expect(screen.getByText('+2')).toBeTruthy();
    expect(mocked.prepareInviteLink).toHaveBeenCalled();

    const level = screen.getByRole('slider', { name: 'Guest permissions' });
    expect(level.getAttribute('aria-valuetext')).toBe('Queue Editor');
    expect(level.dataset.level).toBe('1'); // the rail fills up to it
    expect(screen.getByText('Queue Editor')).toBeTruthy();
    fireEvent.change(level, { target: { value: '3' } });
    expect(mocked.setGigLevel).toHaveBeenCalledWith(3);

    const discoverable = screen.getByRole('switch', { name: 'Open session' });
    expect(discoverable.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(discoverable);
    expect(mocked.setDiscoverable).toHaveBeenCalledWith(true);

    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull(); // Invite does it
    fireEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(mocked.shareInviteLink).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'End gig' }));
    expect(mocked.endTogether).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'End for everyone?' }));
    expect(mocked.endTogether).toHaveBeenCalled();
  });

  it('tapping everyone closes the card and opens the members: the owner, then each guest with Remove', () => {
    act(() => {
      useListenTogetherStore.setState({
        ownSessionId: 's',
        own: { visibility: 'invite', guests: people(2), ownerAvatar: avatar('o', 'A'), ownerName: 'Andreas', permissions: ['queue'] },
      });
    });
    const onDone = jest.fn();
    render(<><GigSection onDone={onDone} /><GigMembers /></>);
    expect(screen.queryByRole('dialog', { name: 'Your gig' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: "Who's in your gig: 3 people" }));
    expect(onDone).toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Your gig' });
    expect(dialog.textContent).toContain('Andreas');
    expect(dialog.textContent).toContain('Owner');
    expect(screen.queryByRole('button', { name: 'Remove Andreas' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove guest1' }));
    expect(mocked.removeGuest).toHaveBeenCalledWith('g1');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Your gig' })).toBeNull();
  });

  it('closes the members when the gig ends', () => {
    act(() => {
      useListenTogetherStore.setState({ ownSessionId: 's', own: { visibility: 'invite', guests: people(1) }, membersOpen: true });
    });
    render(<GigMembers />);
    expect(screen.getByRole('dialog', { name: 'Your gig' })).toBeTruthy();
    act(() => { useListenTogetherStore.setState({ own: { visibility: 'private', guests: [] } }); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useListenTogetherStore.getState().membersOpen).toBe(false);
  });

  it('shows the level the gig is at', () => {
    act(() => {
      useListenTogetherStore.setState({ ownSessionId: 's', own: { visibility: 'discoverable', guests: [], permissions: ['queue', 'transport'] } });
    });
    render(<GigSection />);
    expect(screen.getByRole('slider', { name: 'Guest permissions' }).getAttribute('aria-valuetext')).toBe('Playback Control');
    expect(screen.getByRole('switch', { name: 'Open session' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('Connect', () => {
  it('keeps the devices, with the gig line below them, and offers gigs nearby to join', () => {
    act(() => {
      useListenTogetherStore.setState({
        ownSessionId: 's', own: { visibility: 'private', guests: [] },
        available: [{ ownerName: 'Bo', owner: avatar('b', 'B'), guests: [], sessionId: 'nearby-1', joined: false }],
      });
    });
    render(<ConnectMenuContent onDone={jest.fn()} />);
    expect(screen.getByRole('button', { name: /This device/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start a gig/ })).toBeTruthy();
    expect(screen.getByText('Available gigs')).toBeTruthy();
    expect(screen.getByText("Bo's Gig")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(mocked.joinNearby).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'nearby-1' }));
  });

  it("offers the user's other devices to open the shared session", () => {
    act(() => { useListenTogetherStore.setState({ shared: { sessionId: 'shared', ownerName: 'Andreas', owner: avatar('o', 'A') } }); });
    render(<ConnectMenuContent onDone={jest.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Andreas' Gig Open/ }));
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
    expect(screen.getByText("Andreas' Gig")).toBeTruthy();
    expect(screen.getByRole('button', { name: /NAD Forstærker Playing/ }).className).toContain('is-selected');
    for (const name of [/This device/, /Cast to a device/, /Chrome on Android/, /Start a gig/]) {
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
    expect(screen.queryByRole('button', { name: /Start a gig|Gig/ })).toBeNull();
  });
});
