import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  AlbumArt: ({ className = '' }: { className?: string }) => <span data-testid="album-art" className={className} />,
}));

jest.mock('./LoveButton', () => ({
  LoveButton: () => <button type="button" aria-label="Like track" />,
}));

const { SearchResultsPage } = require('./SearchResultsPage') as typeof import('./SearchResultsPage');

const LocationProbe = () => {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
};

function renderSearch(path = '/search?q=NTO') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<><SearchResultsPage /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SearchResultsPage', () => {
  let observerCallback: IntersectionObserverCallback | null;

  beforeEach(() => {
    observerCallback = null;
    mockStoreState = {
      hydrateTracks: (tracks: unknown[]) => tracks,
      getAuthHeader: () => ({ Authorization: 'Bearer token' }),
      setPlaylist: jest.fn(),
      openContextMenu: jest.fn(),
      artists: [{ id: 'artist-1', name: 'NTO' }],
    };
    globalThis.fetch = jest.fn() as jest.Mock;

    class MockIntersectionObserver {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe = jest.fn();
      disconnect = jest.fn();
      unobserve = jest.fn();
      takeRecords = jest.fn(() => []);
    }

    globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
  });

  it('keeps artwork playback separate from album navigation', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{
          type: 'track',
          relevance: 100,
          item: {
            id: 'track-1',
            path: 'track-1.flac',
            title: 'Exact Track',
            artist: 'NTO',
            artistId: 'artist-1',
            album: 'Exact Album',
            albumId: 'album-1',
          },
        }],
        nextCursor: null,
      }),
    });

    renderSearch();
    fireEvent.click(await screen.findByRole('button', { name: 'Play Exact Track' }));
    expect(mockStoreState.setPlaylist).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'track-1' }),
    ], 0);
    expect(screen.getByTestId('location').textContent).toBe('/search?q=NTO');
    expect(screen.getByRole('link', { name: 'NTO' }).getAttribute('href')).toBe('/library/artist/artist-1');
    expect(screen.queryByRole('button', { name: 'Like track' })).toBeNull();
    expect(screen.getByRole('button', { name: 'More options for Exact Track' }).className).toContain('search-result-context-action');

    fireEvent.click(screen.getByRole('button', { name: 'Open Exact Album and highlight Exact Track' }));
    expect(screen.getByTestId('location').textContent).toBe('/library/album/album-1?track=track-1');
  });

  it('loads the next mixed batch when the sentinel enters view', async () => {
    (globalThis.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ type: 'artist', relevance: 100, item: { id: 'artist-1', name: 'NTO' } }],
          nextCursor: 'next-cursor',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ type: 'album', relevance: 80, item: { id: 'album-1', title: 'Apnea', artist_name: 'NTO' } }],
          nextCursor: null,
        }),
      });

    renderSearch();
    expect(await screen.findByText('NTO')).toBeTruthy();
    await waitFor(() => expect(observerCallback).not.toBeNull());

    act(() => {
      observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(await screen.findByText('Apnea')).toBeTruthy();
    const secondUrl = String((globalThis.fetch as jest.Mock).mock.calls[1][0]);
    expect(secondUrl).toContain('mode=ranked');
    expect(secondUrl).toContain('cursor=next-cursor');
    expect(screen.getByRole('link', { name: 'NTO' }).getAttribute('href')).toBe('/library/artist/artist-1');
    expect(screen.getByText('Showing all confident matches')).toBeTruthy();
  });
});
