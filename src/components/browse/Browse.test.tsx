import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { BrowseHome } from './BrowseHome';
import { BrowseGenrePage } from './BrowseGenrePage';
import { usePlayerStore } from '../../store';
import type { BrowseGenreDetail, BrowseGenres } from '../../../shared/api/v1';

jest.mock('../../hooks/useExternalImage', () => ({ useExternalImage: () => ({ imageUrl: undefined, isLoading: false, error: null }) }));
jest.mock('../../hooks/useInView', () => ({ useInView: () => [() => {}, false] }));
// The v1 → playable conversion has its own tests; here the tracks pass through.
jest.mock('../../utils/playableTracks', () => ({ toPlayableTracks: (tracks: unknown[]) => tracks }));

const ok = (data: unknown, page?: { nextCursor: string | null }) =>
  ({ ok: true, status: 200, json: async () => (page ? { data, page, meta: {} } : { data, meta: {} }) }) as Response;
const originalFetch = global.fetch;

const style = (id: number, name: string, trackCount: number, genre = 'Electronic') => ({ id, genre, name, trackCount });
const genres: BrowseGenres = {
  genres: [
    { name: 'Electronic', hidden: false, trackCount: 9734, styles: [style(92, 'House', 2823), style(140, 'Trance', 2215), style(58, 'Drum n Bass', 1089)], artworkIds: [] },
    { name: 'Rock', hidden: false, trackCount: 11778, styles: [style(300, 'Alternative Rock', 3085, 'Rock')], artworkIds: [] },
    { name: 'Non-Music', hidden: true, trackCount: 26, styles: [], artworkIds: [] },
  ],
  unsorted: { trackCount: 57, tagCount: 6 },
};
const electronic: BrowseGenreDetail = {
  genre: { name: 'Electronic', hidden: false, trackCount: 9734 },
  styles: Array.from({ length: 8 }, (_, i) => style(100 + i, `Style ${i + 1}`, 800 - i * 10)),
  noStyleTrackCount: 748,
  albums: [],
  artists: [],
  decades: [{ decade: 1990, trackCount: 372 }, { decade: 2000, trackCount: 3330 }],
};

const track = (id: string) => ({ id, title: id, artists: [], album: null, durationMs: 1000, artworkUrl: null });
const fetchMock = jest.fn(async (url: RequestInfo | URL) => {
  const path = String(url);
  if (path.startsWith('/api/v1/browse/genres?') || path === '/api/v1/browse/genres') return ok(genres);
  if (path === '/api/v1/browse/genres/Electronic') return ok(electronic);
  if (path.startsWith('/api/v1/browse/search')) {
    return ok([{ genre: 'Electronic', styleId: 58, label: 'Drum n Bass · Electronic', matchedAlias: 'drum & bass', trackCount: 1089 }]);
  }
  if (path.startsWith('/api/v1/browse/tracks')) return ok([track('t1'), track('t2'), track('t3')], { nextCursor: null });
  return ok({});
});

const setPlaylist = jest.fn(async () => {});
beforeEach(() => {
  fetchMock.mockClear();
  setPlaylist.mockClear();
  usePlayerStore.setState({ setPlaylist, addToast: jest.fn(), mediaAccessToken: 'm' } as never);
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { global.fetch = originalFetch; });

const Where = () => <span data-testid="where">{decodeURIComponent(useLocation().pathname)}</span>;
const renderAt = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/library/genres" element={<><BrowseHome /><Where /></>} />
      <Route path="/library/browse/genre/:genre" element={<><BrowseGenrePage /><Where /></>} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);

test('genres show their track counts and biggest styles; hidden genres wait behind a toggle; unsorted is last', async () => {
  renderAt('/library/genres');
  const tile = (await screen.findByText('Electronic')).closest('a')!;
  expect(tile.getAttribute('href')).toBe('/library/browse/genre/Electronic');
  expect(within(tile).getByText('9,734 tracks')).toBeTruthy();
  expect(within(tile).getByText('House · Trance · Drum n Bass')).toBeTruthy();
  expect(screen.queryByText('Non-Music')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show Non-Music' }));
  expect(screen.getByText('Non-Music')).toBeTruthy();
  expect(screen.getByText('57 tracks without a genre yet').closest('a')!.getAttribute('href')).toBe('/library/browse/unsorted');
});

test('search finds a style by a tag that maps to it, and Enter opens the first result', async () => {
  renderAt('/library/genres');
  const input = await screen.findByLabelText('Find a genre or style');
  fireEvent.change(input, { target: { value: 'drum & bass' } });
  expect(await screen.findByText('matches “drum & bass”')).toBeTruthy();
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/library/browse/style/58'));
});

test('a genre page shows its biggest styles as tiles, every other style in an index, and shuffles by genre or decade', async () => {
  renderAt('/library/browse/genre/Electronic');
  expect(await screen.findByRole('heading', { level: 1, name: 'Electronic' })).toBeTruthy();
  expect(screen.getByText('9,734 tracks · 8 styles')).toBeTruthy();
  // 6 tiles, then the rest and the tracks without a style in the index.
  expect(screen.getByText('Style 6').closest('a')!.getAttribute('href')).toBe('/library/browse/style/105');
  const index = screen.getByRole('list');
  expect(within(index).getByText('Style 7')).toBeTruthy();
  expect(within(index).queryByText('Style 1')).toBeNull();
  expect(within(index).getByText('Electronic, no specific style')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Shuffle Electronic' }));
  await waitFor(() => expect(setPlaylist).toHaveBeenCalledTimes(1));
  expect(String(fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/v1/browse/tracks'))![0])).toBe('/api/v1/browse/tracks?genre=Electronic&limit=500');
  expect((setPlaylist.mock.calls[0] as unknown[])[0]).toHaveLength(3);

  fireEvent.click(screen.getByRole('button', { name: /^Shuffle Electronic from the 1990s/ }));
  await waitFor(() => expect(setPlaylist).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/v1/browse/tracks?genre=Electronic&decade=1990&limit=500')).toBe(true);
});
