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

// A complete API v1 Track; search now returns these instead of raw rows.
const v1Track = (overrides: Record<string, unknown>) => ({
  id: 'track-1', title: 'Track', artist: null, albumArtist: null, artists: [], album: null,
  genre: null, genres: [], durationSeconds: 100, trackNumber: null, discNumber: null, year: null,
  releaseType: null, compilation: false, bitrate: null, format: 'FLAC', lossless: true, fileSize: null,
  mediaEtag: null, artistId: null, albumId: null, genreId: null, loved: false, rating: 0, playCount: 0,
  lastPlayedAt: null, artworkId: null, artworkUrl: null,
  musicBrainz: { recordingId: null, trackId: null, albumId: null, artistId: null, albumArtistId: null, releaseGroupId: null, workId: null },
  ...overrides,
});
const v1Ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: { requestId: 'test' } }), headers: { get: () => null } });

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
    (globalThis.fetch as jest.Mock).mockResolvedValue(v1Ok({
      results: [{
        type: 'track',
        relevance: 100,
        item: v1Track({ id: 'track-1', title: 'Exact Track', artist: 'NTO', artists: ['NTO'], artistId: 'artist-1', album: 'Exact Album', albumId: 'album-1' }),
      }],
      nextCursor: null,
    }));

    renderSearch();
    expect(String((globalThis.fetch as jest.Mock).mock.calls[0][0])).toMatch(/^\/api\/v1\/search\/ranked\?/);
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
      .mockResolvedValueOnce(v1Ok({
        results: [{ type: 'artist', relevance: 100, item: { id: 'artist-1', name: 'NTO', imageUrl: null } }],
        nextCursor: 'next-cursor',
      }))
      .mockResolvedValueOnce(v1Ok({
        results: [{ type: 'album', relevance: 80, item: { id: 'album-1', title: 'Apnea', artistName: 'NTO', imageUrl: null } }],
        nextCursor: null,
      }));

    renderSearch();
    expect(await screen.findByText('NTO')).toBeTruthy();
    await waitFor(() => expect(observerCallback).not.toBeNull());

    act(() => {
      observerCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    });

    expect(await screen.findByText('Apnea')).toBeTruthy();
    const secondUrl = String((globalThis.fetch as jest.Mock).mock.calls[1][0]);
    expect(secondUrl).toMatch(/^\/api\/v1\/search\/ranked\?/);
    expect(secondUrl).toContain('cursor=next-cursor');
    expect(screen.getByRole('link', { name: 'NTO' }).getAttribute('href')).toBe('/library/artist/artist-1');
    expect(screen.getByText('Showing all confident matches')).toBeTruthy();
  });
});
