import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StyleProfileSection } from './StyleProfileSection';
import { usePlayerStore } from '../../store';

// The v1 → playable conversion has its own tests; here the tracks pass through.
jest.mock('../../utils/playableTracks', () => ({ toPlayableTracks: (tracks: unknown[]) => tracks }));

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: {} }) }) as Response;
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

const profile = {
  entries: [
    { genre: 'Rock', styleId: 61, style: 'Nu Metal', share: 0.6, trackCount: 7, albumCount: 1 },
    { genre: 'Rock', styleId: null, style: null, share: 1, trackCount: 11, albumCount: 1 },
  ],
  listenerTags: [],
};

function serve() {
  const fetchMock = jest.fn(async (url: string) => (
    String(url).includes('/styles') ? ok(profile)
      : String(url).includes('/browse/mix') ? ok([{ id: 't1' }])
        : ({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) }) as unknown as Response
  ));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

it('shows an artist’s styles and genres as cards that open and shuffle them', async () => {
  // Shuffle hands the tracks to the player; playing them is not this test's business.
  const setPlaylist = jest.fn(async () => {});
  usePlayerStore.setState({ newBrowseEnabled: true, setPlaylist } as never);
  const fetchMock = serve();

  render(<MemoryRouter><StyleProfileSection kind="artist" id="a1" name="Daysend" /></MemoryRouter>);

  const section = await screen.findByRole('region', { name: 'Genres and styles' });
  expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/artists/a1/styles');
  const nuMetal = within(section).getByRole('link', { name: /Nu Metal/ });
  expect(nuMetal.getAttribute('href')).toBe('/library/browse/style/61');
  expect(within(nuMetal).getByText('Rock')).toBeTruthy();
  expect(within(section).getByRole('link', { name: /^Rock\s*Genre$/ }).getAttribute('href')).toBe('/library/browse/genre/Rock');

  fireEvent.click(within(section).getByRole('button', { name: 'Shuffle Nu Metal' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/v1/browse/mix?') && String(url).includes('style=61'))).toBe(true));
  await waitFor(() => expect(setPlaylist).toHaveBeenCalledWith([{ id: 't1' }], 0, null));
});

it('reads an album’s profile for the album page', async () => {
  usePlayerStore.setState({ newBrowseEnabled: true } as never);
  const fetchMock = serve();

  render(<MemoryRouter><StyleProfileSection kind="album" id="al1" name="Wasting Light" /></MemoryRouter>);

  const section = await screen.findByRole('region', { name: 'Genres and styles' });
  expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/albums/al1/styles');
  expect(within(section).getAllByRole('link')).toHaveLength(2);
});

it('is left out while genre & style browse is off', () => {
  usePlayerStore.setState({ newBrowseEnabled: false } as never);
  const fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;

  render(<MemoryRouter><StyleProfileSection kind="album" id="al1" name="Wasting Light" /></MemoryRouter>);

  expect(screen.queryByRole('region', { name: 'Genres and styles' })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
