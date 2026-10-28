import { act, fireEvent, render, screen } from '@testing-library/react';
import { usePlayerStore } from '../../store';
import { useListenTogetherStore } from '../../store/listenTogether';
import * as together from '../../utils/listenTogether';
import { InvitePrompt } from '../InvitePrompt';
import { GigSection } from '../GigSection';
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
    useListenTogetherStore.setState({ ownSessionId: null, own: null, shared: null, prompt: null, openedSessionId: null, available: [] });
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

  it('while it runs: everyone in it overlapping (five, then +N), discoverable, link, level and End', () => {
    act(() => {
      useListenTogetherStore.setState({
        ownSessionId: 's',
        own: { visibility: 'invite', guests: people(6), ownerAvatar: avatar('o', 'A'), permissions: ['queue'] },
      });
    });
    const { container } = render(<GigSection />);
    expect(container.querySelector('.connect-gig')!.className).toContain('is-running');
    expect(screen.queryByText('Start a gig')).toBeNull();
    expect(container.querySelectorAll('.connect-gig .avatar-stack > .user-avatar:not(.avatar-stack-more)')).toHaveLength(5);
    expect(screen.getByText('+2')).toBeTruthy();

    const discoverable = screen.getByRole('switch', { name: 'Make discoverable' });
    expect(discoverable.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(discoverable);
    expect(mocked.setDiscoverable).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'Copy invite link' }));
    expect(mocked.copyInviteLink).toHaveBeenCalled();

    const level = screen.getByRole('slider', { name: 'What guests can do' });
    expect(level.getAttribute('aria-valuetext')).toBe('Queue Editor');
    expect(screen.getByText('Queue Editor')).toBeTruthy();
    fireEvent.change(level, { target: { value: '3' } });
    expect(mocked.setGigLevel).toHaveBeenCalledWith(3);

    fireEvent.click(screen.getByRole('button', { name: 'End' }));
    expect(mocked.endTogether).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'End the gig? Tap to confirm' }));
    expect(mocked.endTogether).toHaveBeenCalled();
  });

  it('shows the level the gig is at', () => {
    act(() => {
      useListenTogetherStore.setState({ ownSessionId: 's', own: { visibility: 'discoverable', guests: [], permissions: ['queue', 'transport'] } });
    });
    render(<GigSection />);
    expect(screen.getByRole('slider', { name: 'What guests can do' }).getAttribute('aria-valuetext')).toBe('Playback Control');
    expect(screen.getByRole('switch', { name: 'Make discoverable' }).getAttribute('aria-checked')).toBe('true');
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
