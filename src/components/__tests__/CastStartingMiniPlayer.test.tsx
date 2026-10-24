import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MobileMiniPlayer from '../MobileMiniPlayer';

let mockStatus: 'starting' | 'unconfirmed' | null = 'starting';
const mockState = () => ({
    playlist: [{ id: '1', path: '/a.flac', title: 'Always on my mind', artist: 'Artist' }], currentIndex: 0,
    playbackState: 'paused', isBuffering: true, castConnected: true, castPlaybackStatus: mockStatus,
    pause: jest.fn(), resume: jest.fn(), nextTrack: jest.fn(), prevTrack: jest.fn(),
    audioOutputSupported: false, audioOutputActive: false, audioOutputDeviceLabel: '', audioOutputSelecting: false, selectAudioOutput: jest.fn(),
});
jest.mock('../../store/index', () => ({ usePlayerStore: Object.assign(
    (select: (state: unknown) => unknown) => select(mockState()), { getState: () => mockState() },
) }));
jest.mock('../../hooks/useSwipe', () => ({ useSwipe: () => ({ current: null }) }));
jest.mock('../MobileNowPlaying', () => () => null);
jest.mock('../cast/CastButton', () => ({ CastButton: () => null }));
jest.mock('../../hooks/useDominantColor', () => ({ prefetchPalette: jest.fn(), NOW_PLAYING_PALETTE_QUALITY: 1 }));
jest.mock('../../utils/CastManager', () => ({ castManager: { getCastDeviceName: () => 'NAD Forstærker', addStateChangeListener: () => () => {} } }));

// The phone PWA is the prod case: its always-visible surface must say a start is pending.
test('the mobile mini player keeps its device line while starting and flags only a failed start', () => {
    const { rerender } = render(<MobileMiniPlayer />, { wrapper: MemoryRouter });
    expect(screen.getByRole('status').textContent).toBe('NAD Forstærker');
    mockStatus = 'unconfirmed';
    rerender(<MobileMiniPlayer key="failed" />);
    expect(screen.getByRole('status').textContent).toBe('Playback not confirmed on NAD Forstærker');
    mockStatus = null;
    rerender(<MobileMiniPlayer key="confirmed" />);
    expect(screen.getByRole('status').textContent).toBe('NAD Forstærker');
});
