import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { LibraryTab } from './LibraryTab';
import type { LibraryDirectoryStats } from '../../../shared/libraryStats';

const mockState = {
  libraryFolders: ['/music'], getAuthHeader: () => ({}), isScanning: false,
};
jest.mock('../../store/index', () => ({ usePlayerStore: (selector: (state: typeof mockState) => unknown) => selector(mockState) }));
jest.mock('../../hooks/useToast', () => ({ useToast: () => ({ addToast: jest.fn() }) }));

let stats: LibraryDirectoryStats;
beforeEach(() => {
  mockState.isScanning = false;
  stats = { path: '/music', totalTracks: 28013, withMetadata: 28013, analyzed: 21000, missingAnalysis: 13, outdatedAnalysis: 7000 };
  global.fetch = jest.fn(async (url: RequestInfo | URL) => ({
    ok: true,
    json: async () => String(url) === '/api/library/stats' ? { directories: [stats] } : { tracks: [], models: [] },
  } as Response));
});
afterEach(cleanup);

test('explains why 13 new tracks can coexist with thousands of pending updates', async () => {
  render(<LibraryTab />);
  expect(await screen.findByText('21000 / 28013 tracks (75%)')).toBeTruthy();
  expect(screen.getByText('13 awaiting analysis; 7000 need analysis updates.')).toBeTruthy();
  expect(screen.getByText('7000 need analysis updates')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Analyze Pending' })).toBeTruthy();
  expect(screen.getByText(/Rescans also process this backlog across the library/)).toBeTruthy();
});

test('never rounds unfinished analysis to 100 percent', async () => {
  stats = { ...stats, totalTracks: 28000, analyzed: 27999, missingAnalysis: 0, outdatedAnalysis: 1 };
  render(<LibraryTab />);
  expect(await screen.findByText('27999 / 28000 tracks (99%)')).toBeTruthy();
});

test('refreshes coverage after analysis completes', async () => {
  mockState.isScanning = true;
  const view = render(<LibraryTab />);
  await screen.findByText('21000 / 28013 tracks (75%)');
  stats = { ...stats, analyzed: 28013, missingAnalysis: 0, outdatedAnalysis: 0 };
  mockState.isScanning = false;
  view.rerender(<LibraryTab />);
  await waitFor(() => expect(screen.getByText('28013 / 28013 tracks (100%)')).toBeTruthy());
  expect(screen.queryByText('7000 need analysis updates')).toBeNull();
});
