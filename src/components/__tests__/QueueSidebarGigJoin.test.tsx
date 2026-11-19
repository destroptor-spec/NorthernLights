import { act, fireEvent, render, screen } from '@testing-library/react';
import { usePlayerStore } from '../../store';
import { useListenTogetherStore } from '../../store/listenTogether';
import * as together from '../../utils/listenTogether';
import { QueueSidebarHeader } from '../QueueSidebarHeader';

jest.mock('../../hooks/useQueueSidebarShowsGig', () => ({ useQueueSidebarShowsGig: () => true }));
jest.mock('../../utils/listenTogether', () => ({
  ...jest.requireActual('../../utils/listenTogether'),
  joinNearby: jest.fn(async () => undefined),
  openSharedSession: jest.fn(async () => undefined),
  leaveSharedSession: jest.fn(async () => undefined),
  refreshNearby: jest.fn(async () => undefined),
  prepareInviteLink: jest.fn(),
  startGig: jest.fn(async () => undefined),
}));
const mocked = together as jest.Mocked<typeof together>;
const avatar = (userId: string, initial: string) => ({ userId, initial, pictureUrl: null });

beforeEach(() => {
  jest.clearAllMocks();
  act(() => {
    usePlayerStore.setState({ syncPlaybackAcrossDevices: true, playlist: [] } as never);
    useListenTogetherStore.setState({ ownSessionId: 's-own', own: { visibility: 'private', guests: [] }, shared: null, openedSessionId: null, available: [] });
  });
});

const renderHeader = () => render(<QueueSidebarHeader onSave={jest.fn()} saving={false} onClear={jest.fn()} onCollapse={jest.fn()} />);

it("offers a gig nearby as \"Join Bo's Gig\" with Bo's avatar, and joins it", () => {
  act(() => {
    useListenTogetherStore.setState({ available: [{ ownerName: 'Bo', owner: avatar('b', 'B'), guests: [], sessionId: 'near', joined: false }] });
  });
  renderHeader();
  expect(mocked.refreshNearby).toHaveBeenCalled();
  const button = screen.getByRole('button', { name: /Join Bo's Gig/ });
  expect(button.className).toContain('gig-join');
  expect(button.querySelector('.user-avatar')).toBeTruthy();
  fireEvent.click(button);
  expect(mocked.joinNearby).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'near' }));
});

it('offers the gig this user is a guest in on another device, and opens it here', () => {
  act(() => {
    useListenTogetherStore.setState({ shared: { sessionId: 'theirs', ownerName: 'Tove', owner: avatar('t', 'T') } });
  });
  renderHeader();
  fireEvent.click(screen.getByRole('button', { name: /Join Tove's Gig/ }));
  expect(mocked.openSharedSession).toHaveBeenCalled();
});

it('on the device that shows the gig: its name, and Leave', () => {
  act(() => {
    useListenTogetherStore.setState({ shared: { sessionId: 'theirs', ownerName: 'Tove', owner: avatar('t', 'T') }, openedSessionId: 'theirs' });
  });
  renderHeader();
  expect(screen.getByRole('heading', { name: "Tove's Gig" })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Join/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
  expect(mocked.leaveSharedSession).toHaveBeenCalled();
});
