import { act, render, screen } from '@testing-library/react';
import { ArtistInitial } from './ArtistInitial';
import { resetArtistImageLookupsForTests, setArtistImageLookupAuth } from '../../utils/artistImageLookups';

type Status = 'found' | 'queued' | 'none' | 'unknown';
let answers: Record<string, { status: Status; imageUrl: string | null }>;
const fetchMock = jest.fn(async (_url: string, init: RequestInit) => {
  const { names } = JSON.parse(String(init.body)) as { names: string[] };
  const artists = names.map((name) => ({ name, ...(answers[name] ?? { status: 'unknown', imageUrl: null }) }));
  // jsdom has no Response.
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: { artists } }) };
});
const sentNames = () => fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init.body)) as { names: string[] }).names);
const flush = async (ms: number) => {
  await act(async () => { await jest.advanceTimersByTimeAsync(ms); });
};

beforeEach(() => {
  jest.useFakeTimers();
  resetArtistImageLookupsForTests();
  setArtistImageLookupAuth(() => ({ Authorization: 'Bearer t' }));
  fetchMock.mockClear();
  global.fetch = fetchMock as unknown as typeof fetch;
  answers = {};
});

afterEach(() => jest.useRealTimers());

it('asks for every artist on screen in one request and shows a picture it already has', async () => {
  answers = { Lange: { status: 'found', imageUrl: 'https://img/lange.jpg' }, Chicane: { status: 'none', imageUrl: null } };
  const { container } = render(<><ArtistInitial name="Lange" /><ArtistInitial name="Chicane" /><ArtistInitial name="Lange" /></>);
  expect(screen.getAllByRole('img')).toHaveLength(3); // initials first

  await flush(300);

  expect(sentNames()).toEqual([['Lange', 'Chicane']]);
  expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/artists/image-lookups');
  expect(container.querySelectorAll('img.artist-initial-image')).toHaveLength(2);
  expect(screen.getByRole('img', { name: 'Chicane artist initial' })).toBeTruthy();
});

it('asks again while a queued artist is on screen and swaps in its picture', async () => {
  answers = { 'Cosmic Gate': { status: 'queued', imageUrl: null } };
  const { container } = render(<ArtistInitial name="Cosmic Gate" />);
  await flush(300);
  expect(container.querySelector('img')).toBeNull();

  answers = { 'Cosmic Gate': { status: 'found', imageUrl: 'https://img/cg.jpg' } };
  await flush(5000);

  expect(sentNames()).toEqual([['Cosmic Gate'], ['Cosmic Gate']]);
  expect(container.querySelector('img')?.getAttribute('src')).toBe('https://img/cg.jpg');
});

it('stops asking once the card is gone, and asks nothing with lookup off or signed out', async () => {
  answers = { 'Ferry Corsten': { status: 'queued', imageUrl: null } };
  const { unmount } = render(<ArtistInitial name="Ferry Corsten" />);
  await flush(300);
  unmount();
  await flush(20_000);
  expect(sentNames()).toEqual([['Ferry Corsten']]);

  render(<ArtistInitial name="Keeno" lookup={false} />);
  setArtistImageLookupAuth(() => null);
  render(<ArtistInitial name="Nic Chagall" />);
  await flush(20_000);
  expect(sentNames()).toEqual([['Ferry Corsten']]);
});
