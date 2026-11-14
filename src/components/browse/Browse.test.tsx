import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { BrowseHome } from './BrowseHome';
import { BrowseGenrePage } from './BrowseGenrePage';
import { BrowseStylePage } from './BrowseStylePage';
import { BrowseUnsorted } from './BrowseUnsorted';
import { COVER_GRADIENTS, coverGradientFor } from './AuroraCard';
import { usePlayerStore } from '../../store';
import type { BrowseGenreDetail, BrowseGenres, BrowseStyleDetail } from '../../../shared/api/v1';

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
  countries: [{ country: 'US', trackCount: 4100 }, { country: 'DK', trackCount: 640 }],
  vocals: [{ value: 'female', trackCount: 2300 }, { value: 'male', trackCount: 900 }],
  moods: [{ value: 'chill', trackCount: 800 }],
};

const grunge = (soundsCloseTo: BrowseStyleDetail['soundsCloseTo']): BrowseStyleDetail => ({
  style: style(51, 'Grunge', 151, 'Rock'), albums: [], artists: [], decades: [], countries: [], vocals: [], moods: [], soundsCloseTo,
});
let grungeDetail = grunge([]);
const nuMetal = { genre: 'Rock', styleId: 61, style: 'Nu Metal', score: 0.002, fromTags: ['Nu Metal'] };
const altRock = { genre: 'Rock', styleId: 30, style: 'Alternative Rock', score: 0.004, fromTags: ['Alternative Rock'] };
const disputedRow = (trackId: string, title: string, styles = [nuMetal]) => ({
  trackId, title, artist: 'Linkin Park', album: 'Minutes to Midnight', artworkId: null, styles,
});
const disputedPage = () => ({ total: 2, styles: 3, items: [disputedRow('d1', 'Wake'), disputedRow('d2', 'Jornada Del Muerto', [nuMetal, altRock])] });
let disputed = disputedPage();

const track = (id: string) => ({ id, title: id, artists: [], album: null, durationMs: 1000, artworkUrl: null });
const fetchMock = jest.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
  const path = String(url);
  if (path.startsWith('/api/v1/browse/genres?') || path === '/api/v1/browse/genres') return ok(genres);
  if (path === '/api/v1/browse/genres/Electronic') return ok(electronic);
  if (path === '/api/v1/browse/styles/51') return ok(grungeDetail);
  if (path === '/api/v1/browse/unsorted') return ok({ tags: [], untaggedTrackCount: 0 });
  if (path.startsWith('/api/library/track-styles/disputed')) return { ok: true, json: async () => disputed } as Response;
  if (path.startsWith('/api/library/track-styles/')) return { ok: true, json: async () => ({ status: 'saved' }) } as Response;
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
      <Route path="/library/browse/style/:styleId" element={<><BrowseStylePage /><Where /></>} />
      <Route path="/library/browse/unsorted" element={<BrowseUnsorted />} />
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

test('a genre page shows its biggest styles as tiles, every other style in an index, and shuffles by genre, decade and country', async () => {
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

  // Decade and country narrow the one Shuffle; picking again clears.
  fireEvent.click(screen.getByRole('button', { name: '1990s' }));
  fireEvent.click(screen.getByRole('button', { name: 'Denmark' }));
  expect(screen.getByRole('button', { name: 'Denmark' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Shuffle Electronic · Denmark · 1990s' }));
  await waitFor(() => expect(setPlaylist).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/v1/browse/mix?genre=Electronic&decade=1990&country=DK')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '1990s' }));
  expect(screen.getByRole('button', { name: 'Shuffle Electronic · Denmark' })).toBeTruthy();
  // Vocals and mood narrow too, by the artists' tags.
  fireEvent.click(screen.getByRole('button', { name: 'Female' }));
  fireEvent.click(screen.getByRole('button', { name: 'Chill' }));
  fireEvent.click(screen.getByRole('button', { name: 'Shuffle Electronic · Chill · Denmark · Female vocals' }));
  await waitFor(() => expect(setPlaylist).toHaveBeenCalledTimes(3));
  expect(fetchMock.mock.calls.some(([u]) => String(u) === '/api/v1/browse/mix?genre=Electronic&country=DK&vocals=female&mood=chill')).toBe(true);
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

test('a style page shows what sounds close to it, with the genre on each card, once it has a centroid', async () => {
  grungeDetail = grunge([style(52, 'Punk', 107, 'Rock'), style(92, 'House', 2823)]);
  const { unmount } = renderAt('/library/browse/style/51');
  const section = await screen.findByRole('region', { name: 'Sounds close to' });
  const house = within(section).getByText('House').closest('a')!;
  expect(house.getAttribute('href')).toBe('/library/browse/style/92');
  expect(within(house).getByText('Electronic')).toBeTruthy();
  unmount();

  // Without a centroid there is nothing to say yet.
  grungeDetail = grunge([]);
  renderAt('/library/browse/style/51');
  expect(await screen.findByRole('heading', { level: 1, name: 'Grunge' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Sounds close to' })).toBeNull();
});

test('admins review disputed tags on Unsorted: Remove writes the correction, drops the row and offers Undo; listeners see none', async () => {
  const addToast = jest.fn();
  usePlayerStore.setState({ currentUser: { role: 'admin' }, addToast } as never);
  disputed = disputedPage();
  const { unmount } = renderAt('/library/browse/unsorted');
  const section = await screen.findByRole('region', { name: 'Disputed tags' });
  expect(await within(section).findByText('2 tracks to review')).toBeTruthy();
  expect(within(section).getByText('Jornada Del Muerto').closest('a')!.getAttribute('href')).toBe('/library/rays/d2');

  // One row per track: both of its disputed styles, answered together.
  fireEvent.click(within(section).getByRole('button', { name: 'Remove Nu Metal and Alternative Rock from Jornada Del Muerto' }));
  await waitFor(() => expect(within(section).queryByText('Jornada Del Muerto')).toBeNull());
  const posts = fetchMock.mock.calls.filter(([u]) => String(u) === '/api/library/track-styles/d2').map(([, init]) => JSON.parse(String(init!.body)));
  expect(posts).toEqual([{ genre: 'Rock', styleId: 61, action: 'remove' }, { genre: 'Rock', styleId: 30, action: 'remove' }]);
  expect(addToast.mock.calls[0][0]).toBe('Removed Nu Metal and Alternative Rock from Jornada Del Muerto');
  expect(addToast.mock.calls[0][2].actionLabel).toBe('Undo');
  expect(within(section).getByText('1 track to review')).toBeTruthy();

  fireEvent.click(within(section).getByRole('button', { name: 'Keep Nu Metal on Wake' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([u, init]) => String(u) === '/api/library/track-styles/d1'
    && JSON.parse(String(init!.body)).action === 'add')).toBe(true));
  unmount();

  usePlayerStore.setState({ currentUser: { role: 'listener' } } as never);
  renderAt('/library/browse/unsorted');
  expect(await screen.findByRole('heading', { level: 1, name: 'Unsorted' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Disputed tags' })).toBeNull();
});
