import { fireEvent, render, screen, within } from '@testing-library/react';
import { ArtistEntitiesTab } from './ArtistEntitiesTab';
import { usePlayerStore } from '../../store';

const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const originalFetch = global.fetch;

const sabrina = {
  candidateKey: 'artist-mbid:6a6dd3a6-0000-4000-8000-000000000001',
  normalizedKey: 'sabrinasalerno',
  signature: 'a:3:1|b:2:1',
  totalTracks: 5,
  artists: [
    { id: 'a', name: 'Sabrina Salerno', mbid: '6a6dd3a6-0000-4000-8000-000000000001', trackCount: 3, albumCount: 1, displayScore: 1 },
    { id: 'b', name: 'Sabrina', mbid: '6a6dd3a6-0000-4000-8000-000000000001', trackCount: 2, albumCount: 1, displayScore: 1 },
  ],
};

beforeEach(() => {
  usePlayerStore.setState({ ensureFullLibraryLoaded: jest.fn(async () => {}), artists: [], library: [] } as never);
  global.fetch = jest.fn(async (url: RequestInfo | URL) =>
    String(url) === '/api/library/artist-duplicates' ? response({ candidates: [sabrina] }) : response({})) as typeof fetch;
});
afterEach(() => { global.fetch = originalFetch; });

test('lists one MusicBrainz artist under two names as its own kind, with a fold explanation', async () => {
  render(<ArtistEntitiesTab />);

  const card = (await screen.findByText('sabrinasalerno')).closest('article')!;
  expect(within(card).getByText('Same MusicBrainz artist')).toBeTruthy();
  const summary = screen.getByRole('region', { name: 'Artist entity review summary' });
  expect(within(summary).getByText('MusicBrainz').nextElementSibling?.textContent).toBe('1');

  fireEvent.click(within(card).getByRole('button', { name: /merge/i }));
  expect(await screen.findByText(/Files tagged with that spelling keep landing on "Sabrina Salerno"/)).toBeTruthy();
});
