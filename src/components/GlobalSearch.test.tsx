import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { TextDecoder, TextEncoder } from 'util';

Object.assign(globalThis, { TextDecoder, TextEncoder });

const { MemoryRouter, Route, Routes, useLocation } = require('react-router-dom') as typeof import('react-router-dom');

var mockStoreState: Record<string, any>;

jest.mock('../store', () => {
  const usePlayerStore = (selector: (state: Record<string, any>) => unknown) => selector(mockStoreState);
  usePlayerStore.getState = () => mockStoreState;
  return { usePlayerStore };
});

jest.mock('./AlbumArt', () => ({
  AlbumArt: () => <span data-testid="album-art" />,
}));

jest.mock('./LoveButton', () => ({
  LoveButton: () => <button type="button" aria-label="Like track" />,
}));

const { GlobalSearch } = require('./GlobalSearch') as typeof import('./GlobalSearch');

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
};

function renderGlobalSearch() {
  return render(
    <MemoryRouter initialEntries={['/library']}>
      <Routes>
        <Route path="*" element={<><GlobalSearch /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

function groupedTrackResponse() {
  return {
    ok: true,
    json: async () => ({
      artists: [],
      albums: [],
      tracks: [{
        id: 'track-1',
        path: 'track-1.flac',
        title: 'Exact Track',
        artist: 'NTO',
        album: 'Exact Album',
        albumId: 'album-1',
      }],
    }),
  };
}

describe('GlobalSearch navigation', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    window.matchMedia = jest.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }));
    mockStoreState = {
      setPlaylist: jest.fn(),
      openContextMenu: jest.fn(),
      hydrateTracks: (tracks: unknown[]) => tracks,
      getAuthHeader: () => ({ Authorization: 'Bearer token' }),
      artists: [{ id: 'artist-1', name: 'NTO' }],
    };
    globalThis.fetch = jest.fn() as jest.Mock;
  });

  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('opens the dedicated results route only when the search is submitted', () => {
    renderGlobalSearch();
    fireEvent.click(screen.getByText('Search'));
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'NTO' } });

    expect(screen.getByTestId('location').textContent).toBe('/library');
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(screen.getByTestId('location').textContent).toBe('/search?q=NTO');
  });

  it('plays from artwork without navigating away', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue(groupedTrackResponse());
    renderGlobalSearch();
    fireEvent.click(screen.getByText('Search'));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'NTO' } });

    fireEvent.click(await screen.findByRole('button', { name: 'Play Exact Track' }));
    expect(mockStoreState.setPlaylist).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'track-1' }),
    ], 0);
    expect(screen.getByTestId('location').textContent).toBe('/library');
  });

  it('opens and targets a track album from the live result text', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue(groupedTrackResponse());
    renderGlobalSearch();
    fireEvent.click(screen.getByText('Search'));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'NTO' } });

    fireEvent.click(await screen.findByRole('button', { name: 'Open Exact Album and highlight Exact Track' }));
    expect(screen.getByTestId('location').textContent).toBe('/library/album/album-1?track=track-1');
    expect(mockStoreState.setPlaylist).not.toHaveBeenCalled();
  });

  it('links a live track artist to the artist page', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue(groupedTrackResponse());
    renderGlobalSearch();
    fireEvent.click(screen.getByText('Search'));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'NTO' } });

    fireEvent.click(await screen.findByRole('link', { name: 'NTO' }));
    expect(screen.getByTestId('location').textContent).toBe('/library/artist/artist-1');
    expect(mockStoreState.setPlaylist).not.toHaveBeenCalled();
  });

  it('collapses back to the pill on outside click when no results dropdown is shown (#16)', () => {
    renderGlobalSearch();
    fireEvent.click(screen.getByText('Search'));
    expect(screen.queryByRole('searchbox')).not.toBeNull(); // expanded

    // Empty query → no results dropdown is mounted. Clicking outside the field
    // must still collapse it back to the pill (regression: it used to stay open
    // because the outside-click check required a mounted dropdown ref).
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole('searchbox')).toBeNull(); // collapsed
    expect(screen.getByText('Search')).toBeTruthy();     // pill restored
  });
});
