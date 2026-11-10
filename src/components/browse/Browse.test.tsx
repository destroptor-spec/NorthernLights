import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { BrowseHome } from './BrowseHome';
import { BrowseGenrePage } from './BrowseGenrePage';
import { COVER_GRADIENTS, coverGradientFor } from './AuroraCard';
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
  if (path.startsWith('/api/v1/browse/mix')) return ok([track('t1'), track('t2'), track('t3')]);
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

test('genre cards carry the name and one line: track count and biggest style; hidden genres wait behind a toggle; unsorted is last', async () => {
  renderAt('/library/genres');
  const card = (await screen.findByText('Electronic')).closest('a')!;
  expect(card.getAttribute('href')).toBe('/library/browse/genre/Electronic');
  expect(within(card).getByText('9,734 tracks · House')).toBeTruthy();
  expect(screen.queryByLabelText('Find a genre or style')).toBeNull();
  expect(screen.queryByText('Non-Music')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show Non-Music' }));
  expect(screen.getByText('Non-Music')).toBeTruthy();
  expect(screen.getByText('57 tracks without a genre yet').closest('a')!.getAttribute('href')).toBe('/library/browse/unsorted');
});

test('a genre page shows its biggest styles as tiles, every other style in an index, and shuffles by genre or decade', async () => {
  renderAt('/library/browse/genre/Electronic');
  expect(await screen.findByRole('heading', { level: 1, name: 'Electronic' })).toBeTruthy();
  expect(screen.getByText('9,734 tracks · 8 styles')).toBeTruthy();
  // 6 tiles, then the rest and the tracks without a style in the index.
  const styleCard = screen.getByText('Style 6').closest('a')!;
  expect(styleCard.getAttribute('href')).toBe('/library/browse/style/105');
  expect(within(styleCard).getByText('750 tracks')).toBeTruthy();
  const index = screen.getByRole('list');
  expect(within(index).getByText('Style 7')).toBeTruthy();
  expect(within(index).queryByText('Style 1')).toBeNull();
  expect(within(index).getByText('Electronic, no specific style')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Shuffle Electronic' }));
  await waitFor(() => expect(setPlaylist).toHaveBeenCalledTimes(1));
  expect(String(fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/v1/browse/mix'))![0])).toBe('/api/v1/browse/mix?genre=Electronic');
  // The server picks and orders the mix; the client plays it as it comes.
  expect(((setPlaylist.mock.calls[0] as unknown[])[0] as Array<{ id: string }>).map(t => t.id)).toEqual(['t1', 't2', 't3']);

  fireEvent.click(screen.getByRole('button', { name: /^Shuffle Electronic from the 1990s/ }));
  await waitFor(() => expect(setPlaylist).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/v1/browse/mix?genre=Electronic&decade=1990')).toBe(true);
});

test('a card takes one of the Hub cover gradients, the same one for a name every time', () => {
  for (const name of ['Rock', 'Pop', 'Funk / Soul', 'Electronic', 'Trip Hop']) {
    const gradient = coverGradientFor(name);
    expect(COVER_GRADIENTS.map(token => `var(${token})`)).toContain(gradient);
    expect(coverGradientFor(name)).toBe(gradient);
  }
});

test("a card's Play shuffles that genre and stays on the page; the button is beside the link, not in it", async () => {
  renderAt('/library/genres');
  const play = await screen.findByRole('button', { name: 'Shuffle Rock' });
  expect(play.closest('a')).toBeNull();
  fireEvent.click(play);
  await waitFor(() => expect(setPlaylist).toHaveBeenCalledTimes(1));
  expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/v1/browse/mix?genre=Rock')).toBe(true);
  expect(screen.getByTestId('where').textContent).toBe('/library/genres');
});
