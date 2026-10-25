import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ArtistEntitiesTab, describeDecision } from './ArtistEntitiesTab';
import { usePlayerStore } from '../../store';
import type { ArtistReviewDecision, ArtistReviewEntry, ArtistReviewPreview } from '../../../shared/artistReview';

const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const originalFetch = global.fetch;

const joined: ArtistReviewEntry = {
  key: 'artist-joined:raffaella carra and bob sinclar',
  signature: '{"subject":"Raffaella Carrà & Bob Sinclar","names":["Raffaella Carrà","Bob Sinclar"]}',
  kind: 'joined-credit',
  subject: 'Raffaella Carrà & Bob Sinclar',
  artists: [
    { id: 'j', name: 'Raffaella Carrà & Bob Sinclar', mbid: null, imageUrl: null, trackCount: 9, albumCount: 1 },
    { id: 'r', name: 'Raffaella Carrà', mbid: null, imageUrl: null, trackCount: 0, albumCount: 0 },
    { id: 'b', name: 'Bob Sinclar', mbid: null, imageUrl: null, trackCount: 3, albumCount: 2 },
  ],
  splitInto: ['Raffaella Carrà', 'Bob Sinclar'],
  totalTracks: 9,
  outcomes: [
    { id: 'keep-together', kind: 'keep-together', label: 'Keep together' },
    { id: 'split', kind: 'split', label: 'Split into Raffaella Carrà and Bob Sinclar' },
  ],
};

const release = (title: string, change: 'added' | 'removed' | null = null) => ({ albumId: title, title, year: 2011, tracks: 9, change });
const preview: ArtistReviewPreview = {
  key: joined.key,
  outcomes: [
    {
      id: 'keep-together',
      pages: joined.artists.map(a => ({
        name: a.name, artistId: a.id, imageUrl: null, status: 'unchanged' as const,
        ownTracks: a.trackCount, ownTracksBefore: a.trackCount, releases: [], appearances: [],
      })),
    },
    {
      id: 'split',
      pages: [
        { name: 'Raffaella Carrà & Bob Sinclar', artistId: 'j', imageUrl: null, status: 'removed', ownTracks: 0, ownTracksBefore: 9, releases: [release("Far l'amore", 'removed')], appearances: [] },
        { name: 'Raffaella Carrà', artistId: 'r', imageUrl: null, status: 'changed', ownTracks: 9, ownTracksBefore: 0, releases: [release("Far l'amore", 'added')], appearances: [] },
        { name: 'Bob Sinclar', artistId: 'b', imageUrl: null, status: 'unchanged', ownTracks: 3, ownTracksBefore: 3, releases: [], appearances: [] },
      ],
    },
  ],
};

const decision: ArtistReviewDecision = {
  id: 'd1', key: 'artist-mbid:x', decision: 'merged', names: ['Sabrina Salerno', 'Sabrina'],
  decidedAt: new Date().toISOString(), undoableUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
};

let entries: ArtistReviewEntry[];
const addToast = jest.fn();
const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  const path = String(url);
  if (path === '/api/library/artist-reviews') return response({ entries });
  if (path === '/api/library/artist-reviews/decisions') return response({ decisions: [decision] });
  if (path.startsWith('/api/library/artist-reviews/preview')) return response(preview);
  if (path === '/api/library/artist-reviews/decide' && init?.method === 'POST') {
    entries = [];
    return response({ status: 'decided', decisionId: 'd2' });
  }
  if (path.endsWith('/undo')) return response({ status: 'undone', rereading: 0 });
  return response({});
});

beforeEach(() => {
  entries = [joined];
  addToast.mockReset();
  fetchMock.mockClear();
  usePlayerStore.setState({
    ensureFullLibraryLoaded: jest.fn(async () => {}),
    fetchLibraryFromServer: jest.fn(async () => {}),
    addToast,
    artists: [],
    library: [],
  } as never);
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { global.fetch = originalFetch; });

test('opens the first question with its outcomes side by side and their artist page previews', async () => {
  render(<ArtistEntitiesTab />);

  const row = await screen.findByRole('button', { name: /One act, or two artists\?.*Raffaella Carrà & Bob Sinclar/ });
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('1 to review')).toBeTruthy();

  const split = (await screen.findByText('Split into Raffaella Carrà and Bob Sinclar')).closest('label')!;
  expect(within(split).getByText('Page removed')).toBeTruthy();
  expect(within(split).getByText('0 → 9')).toBeTruthy();
  expect(within(split).getByText('New')).toBeTruthy();
  const keep = screen.getByText('Keep together').closest('label')!;
  expect(within(keep).getAllByText('Unchanged')).toHaveLength(3);
});

test('applies the chosen outcome and offers Undo in the toast', async () => {
  render(<ArtistEntitiesTab />);
  const apply = await screen.findByRole('button', { name: 'Apply' });
  expect((apply as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(await screen.findByRole('radio', { name: /Split into/ }));
  fireEvent.click(apply);

  await waitFor(() => expect(addToast).toHaveBeenCalled());
  const decide = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/decide'))!;
  expect(JSON.parse(String(decide[1]!.body))).toEqual({ key: joined.key, signature: joined.signature, outcomeId: 'split' });
  const [message, type, options] = addToast.mock.calls[0];
  expect([message, type, options.actionLabel]).toEqual(['Split Raffaella Carrà & Bob Sinclar into Raffaella Carrà and Bob Sinclar', 'success', 'Undo']);
  expect(await screen.findByText('Nothing to review')).toBeTruthy();
});

test('lists recent decisions in words and undoes one', async () => {
  render(<ArtistEntitiesTab />);
  fireEvent.click(await screen.findByText('Decided'));
  fireEvent.click(screen.getByRole('button', { name: 'Undo: Merged Sabrina into Sabrina Salerno' }));
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/library/artist-reviews/decisions/d1/undo')).toBe(true));
});

test('describes every kind of decision', () => {
  expect(describeDecision({ decision: 'dismissed', names: ['Tiësto', 'Tiesto', 'DJ Tiësto'] })).toBe('Kept Tiësto, Tiesto and DJ Tiësto apart');
  expect(describeDecision({ decision: 'kept', names: ['Grandmaster Flash & The Furious Five'] })).toBe('Kept Grandmaster Flash & The Furious Five together');
});
