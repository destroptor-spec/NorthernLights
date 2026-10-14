import React from 'react';
import { render, screen } from '@testing-library/react';
import type { PlayerState } from '../store';
const { MemoryRouter } = require('react-router-dom') as typeof import('react-router-dom');

let mockState: Partial<PlayerState>;
jest.mock('../store/index', () => ({
  usePlayerStore: (selector: (state: Partial<PlayerState>) => unknown) => selector(mockState),
}));
jest.mock('../hooks/usePlayerPlacement', () => ({ usePlayerPlacement: () => ['dock'] }));
jest.mock('../hooks/useScrollRestoration', () => ({ useScrollRestoration: jest.fn() }));
jest.mock('../utils/routePrefetch', () => ({
  Hub: () => <div>Hub route</div>,
  Playlists: () => <div>Playlists route</div>,
  ArtistDetail: () => <div>Artist route</div>,
  LibraryHome: () => <div>Library route</div>,
}));
const { MainContent } = require('./MainContent') as typeof import('./MainContent');

beforeEach(() => {
  mockState = { library: [], albums: [], artists: [], playlist: [], isLibraryLoading: true, libraryError: null };
});

it.each([
  ['/library', 'Hub route'], ['/playlists', 'Playlists route'],
  ['/library/artist/a1', 'Artist route'], ['/library/artists', 'Library route'],
])('mounts %s while artist pages are pending', (path, text) => {
  render(<MemoryRouter initialEntries={[path]}><MainContent /></MemoryRouter>);
  expect(screen.getByText(text)).toBeTruthy();
  expect(screen.queryByText('NorthernLights')).toBeNull();
});

it('shows folder setup on home only after a successful empty load', () => {
  mockState.isLibraryLoading = false;
  render(<MemoryRouter initialEntries={['/library']}><MainContent /></MemoryRouter>);
  expect(screen.getByText('NorthernLights')).toBeTruthy();
});

it('does not mistake a failed load for an empty library', () => {
  mockState.isLibraryLoading = false;
  mockState.libraryError = 'Offline';
  render(<MemoryRouter initialEntries={['/library/artists']}><MainContent /></MemoryRouter>);
  expect(screen.getByText('Library route')).toBeTruthy();
  expect(screen.queryByText('NorthernLights')).toBeNull();
});
