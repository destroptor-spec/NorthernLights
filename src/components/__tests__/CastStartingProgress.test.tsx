import React from 'react';
import { render, screen } from '@testing-library/react';
import ProgressBar from '../ProgressBar';

let mockStatus: 'starting' | 'unconfirmed' | null = 'starting';
jest.mock('../../store', () => ({ usePlayerStore: (select: (state: unknown) => unknown) => select({
    playlist: [], currentIndex: null, castPlaybackStatus: mockStatus,
}) }));
jest.mock('../../store/playbackTime', () => ({ usePlaybackTimeStore: (select: (state: unknown) => unknown) => select({ currentTime: 0, duration: 0 }) }));
jest.mock('../../utils/PlaybackManager', () => ({ playbackManager: { seek: jest.fn() } }));
jest.mock('../../utils/CastManager', () => ({ castManager: { getCastDeviceName: () => 'NAD' } }));
jest.mock('../WaveformProgressBar', () => ({ WaveformProgressBar: () => <div data-testid="waveform" /> }));

test('a start in progress keeps the normal bar; only an unconfirmed start replaces it', () => {
    const { rerender } = render(<ProgressBar />);
    expect(screen.queryByRole('status')).toBeNull(); // no "Starting on…": the play button spins
    mockStatus = 'unconfirmed';
    // ProgressBar is memoized; unmount to simulate the store subscription update.
    rerender(<ProgressBar key="failed" />);
    expect(screen.getByRole('status').textContent).toBe('Playback not confirmed');
    mockStatus = null;
    rerender(<ProgressBar key="confirmed" />);
    expect(screen.queryByRole('status')).toBeNull();
});
