import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import MobileMiniPlayer from '../MobileMiniPlayer';
import { useListenTogetherStore } from '../../store/listenTogether';

const mockState = () => ({
  playlist: [{ id: '1', path: '/a.flac', title: 'Always on my mind', artist: 'Artist' }], currentIndex: 0,
  playbackState: 'playing', isBuffering: false, castConnected: false, castPlaybackStatus: null,
  pause: jest.fn(), resume: jest.fn(), nextTrack: jest.fn(), prevTrack: jest.fn(),
  audioOutputSupported: false, audioOutputActive: false, audioOutputDeviceLabel: '', audioOutputSelecting: false, selectAudioOutput: jest.fn(),
});
jest.mock('../../store/index', () => ({ usePlayerStore: Object.assign(
  (select: (state: unknown) => unknown) => select(mockState()), { getState: () => mockState() },
) }));
jest.mock('../../hooks/useSwipe', () => ({ useSwipe: () => ({ current: null }) }));
jest.mock('../MobileNowPlaying', () => ({ isOpen }: { isOpen: boolean }) => <div data-testid="now-playing" data-open={String(isOpen)} />);
jest.mock('../../hooks/useDominantColor', () => ({ prefetchPalette: jest.fn(), NOW_PLAYING_PALETTE_QUALITY: 1 }));
jest.mock('../../utils/CastManager', () => ({ castManager: { getCastDeviceName: () => '', addStateChangeListener: () => () => {} } }));
jest.mock('../../hooks/useCastStatus', () => ({ useCastStatus: () => ({ available: false, connected: false, busy: false, deviceName: '' }) }));

let navigate: ReturnType<typeof useNavigate>;
const NavigateHook = () => { navigate = useNavigate(); return null; };

test('navigating (Go to Album in the track menu, a link) closes Now Playing first', () => {
  render(<MemoryRouter initialEntries={['/library']}><NavigateHook /><MobileMiniPlayer /></MemoryRouter>);
  act(() => { screen.getByRole('button', { name: /Always on my mind/i }).click(); });
  expect(screen.getByTestId('now-playing').dataset.open).toBe('true');

  act(() => navigate('/library/album/42'));
  expect(screen.getByTestId('now-playing').dataset.open).toBe('false');
});

test("a guest below Playback Control can't play, pause or skip here (no text)", () => {
  act(() => {
    useListenTogetherStore.setState({ openedSessionId: 's', shared: { sessionId: 's', ownerName: 'Andreas', owner: null, permissions: ['queue'] } });
  });
  render(<MemoryRouter><MobileMiniPlayer /></MemoryRouter>);
  expect((screen.getByRole('button', { name: 'Pause' }) as HTMLButtonElement).disabled).toBe(true);
  act(() => {
    useListenTogetherStore.setState({ shared: { sessionId: 's', ownerName: 'Andreas', owner: null, permissions: ['queue', 'transport'] } });
  });
  expect((screen.getByRole('button', { name: 'Pause' }) as HTMLButtonElement).disabled).toBe(false);
  act(() => { useListenTogetherStore.setState({ openedSessionId: null, shared: null }); });
});
