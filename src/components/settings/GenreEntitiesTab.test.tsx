import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { GenreEntitiesTab, genreQuestion } from './GenreEntitiesTab';
import { usePlayerStore } from '../../store';
import type { GenreReviewEntry, GenreReviewEvidence, GenreReviewState } from '../../../shared/genreReview';

const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const originalFetch = global.fetch;

const disco: GenreReviewEntry = {
  key: 'tag:disco', signature: 's-disco', kind: 'two-genres', subject: 'Disco', tagKey: 'disco', totalTracks: 154,
  current: [{ genre: 'Electronic', styleId: 53, style: 'Disco' }, { genre: 'Funk / Soul', styleId: 168, style: 'Disco' }],
  note: 'A style name found under two genres',
  outcomes: [
    { id: 'only:0', kind: 'only', label: 'Electronic › Disco', targets: [{ genre: 'Electronic', styleId: 53, style: 'Disco' }] },
    { id: 'only:1', kind: 'only', label: 'Funk / Soul › Disco', targets: [{ genre: 'Funk / Soul', styleId: 168, style: 'Disco' }] },
    { id: 'accept', kind: 'accept', label: 'Both' },
    { id: 'pick', kind: 'pick', label: 'Something else' },
  ],
};
const unmapped: GenreReviewEntry = {
  key: 'tag:electric hip hop soul', signature: 's-odd', kind: 'unmapped', subject: 'Electric Hip Hop Soul',
  tagKey: 'electric hip hop soul', totalTracks: 135, current: [],
  outcomes: [{ id: 'pick', kind: 'pick', label: 'Choose a genre or style' }, { id: 'ignore', kind: 'ignore', label: 'Not a genre' }],
};
const spelling: GenreReviewEntry = {
  key: 'spelling:genre-normalized:hip hop', signature: 's-sp', kind: 'spelling', subject: 'Hip-Hop and Hip Hop', totalTracks: 40,
  current: [], taxonomyConflict: true,
  spellings: [{ id: 'g1', name: 'Hip Hop', trackCount: 30 }, { id: 'g2', name: 'Hip-Hop', trackCount: 10 }],
  outcomes: [{ id: 'merge:g1', kind: 'merge', label: 'Keep "Hip Hop"' }, { id: 'keep-apart', kind: 'keep-apart', label: 'Keep apart' }],
};

const evidence: GenreReviewEvidence = {
  key: 'tag:disco',
  artists: [{ name: 'Boney M.', imageUrl: null, tracks: 83 }],
  albums: ['Nightflight to Venus'],
  lean: { genre: 'Funk / Soul', artists: 7, of: 9 },
  targetTracks: { 'Electronic|53': 0, 'Funk / Soul|168': 412 },
};

let state: GenreReviewState;
const addToast = jest.fn();
const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  const path = String(url);
  if (path === '/api/library/genre-reviews') return response(state);
  if (path === '/api/library/genre-reviews/decisions') return response({ decisions: [] });
  if (path === '/api/library/genre-reviews/taxonomy') {
    return response({ genres: ['Electronic', 'Hip Hop'], styles: [{ id: 53, genre: 'Electronic', name: 'Disco' }, { id: 70, genre: 'Hip Hop', name: 'Trip Hop' }] });
  }
  if (path.startsWith('/api/library/genre-reviews/preview')) return response({ ...evidence, key: decodeURIComponent(path.split('key=')[1]) });
  if (path === '/api/library/genre-reviews/decide' && init?.method === 'POST') {
    const body = JSON.parse(String(init.body));
    if (body.key === spelling.key && !body.acknowledgeConflict) return response({ error: 'conflict', code: 'GENRE_TAXONOMY_CONFLICT' }, 409);
    state = { ...state, entries: state.entries.filter(e => e.key !== body.key) };
    return response({ status: 'decided', decisionId: 'd1', summary: `${body.key} decided` });
  }
  if (path === '/api/library/genre-reviews/accept-exact') return response({ status: 'decided', decisionId: 'd2', summary: 'Accepted 1 name match', accepted: 1 });
  return response({});
});

const decideBodies = () => fetchMock.mock.calls
  .filter(([url]) => String(url).endsWith('/decide'))
  .map(([, init]) => JSON.parse(String(init!.body)));

beforeEach(() => {
  state = {
    entries: [disco, unmapped, spelling],
    exact: [{ key: 'tag:techno', signature: 's-techno', subject: 'Techno', targets: [{ genre: 'Electronic', styleId: 99, style: 'Techno' }], tracks: 12 }],
    ignored: [{ key: 'tag:other', signature: 's-other', subject: 'Other', tracks: 3, byHand: false }],
    groups: [],
    coverage: { tagged: 1000, mapped: 983, ratio: 0.983, target: 0.95 },
  };
  addToast.mockReset();
  fetchMock.mockClear();
  usePlayerStore.setState({ fetchLibraryFromServer: jest.fn(async () => {}), addToast } as never);
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => { global.fetch = originalFetch; });

test('heads the queue with coverage and the count, and opens the first question with its evidence', async () => {
  render(<GenreEntitiesTab />);
  expect(await screen.findByText('98.3 % of tagged tracks have a genre')).toBeTruthy();
  expect(screen.getByText('3 to review')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Two genres 1/ })).toBeTruthy();

  const row = screen.getByRole('button', { name: /Electronic or Funk \/ Soul\?.*Disco/ });
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(await screen.findByText('Boney M.')).toBeTruthy();
  expect(screen.getByText(/lean Funk \/ Soul: 7 of 9 artists/)).toBeTruthy();
  // A style with no tracks yet is marked new; one with tracks shows how many.
  const electronic = screen.getByText('Electronic › Disco', { selector: '.entity-review-outcome__text' }).closest('label')!;
  expect(within(electronic).getByText('New')).toBeTruthy();
  const funk = screen.getByText('Funk / Soul › Disco', { selector: '.entity-review-outcome__text' }).closest('label')!;
  expect(within(funk).getByText('412')).toBeTruthy();
});

test('applies an outcome with Undo in the toast, then opens the next question', async () => {
  render(<GenreEntitiesTab />);
  fireEvent.click(await screen.findByRole('radio', { name: 'Electronic › Disco' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

  await waitFor(() => expect(addToast).toHaveBeenCalled());
  expect(decideBodies()[0]).toEqual({ key: disco.key, signature: disco.signature, outcomeId: 'only:0', acknowledgeConflict: false });
  expect(addToast.mock.calls[0].slice(0, 2)).toEqual(['tag:disco decided', 'success']);
  expect(addToast.mock.calls[0][2].actionLabel).toBe('Undo');
  await waitFor(() => expect(screen.getByRole('button', { name: /Which genre\?.*Electric Hip Hop Soul/ }).getAttribute('aria-expanded')).toBe('true'));
});

test('a tag with no genre is answered by picking a style from the list', async () => {
  state.entries = [unmapped];
  render(<GenreEntitiesTab />);
  const input = await screen.findByLabelText('Genre or style for Electric Hip Hop Soul');
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  const apply = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);

  fireEvent.change(input, { target: { value: 'Trip Hop · Hip Hop' } });
  expect(screen.getByText('Hip Hop › Trip Hop')).toBeTruthy();
  fireEvent.click(apply);
  await waitFor(() => expect(decideBodies()).toHaveLength(1));
  expect(decideBodies()[0]).toMatchObject({ outcomeId: 'pick', targets: [{ genre: 'Hip Hop', styleId: 70, style: 'Trip Hop' }] });
});

test('keeping spellings from different parts of the genre tree asks first', async () => {
  state.entries = [spelling];
  render(<GenreEntitiesTab />);
  fireEvent.click(await screen.findByRole('radio', { name: 'Keep "Hip Hop"' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Keep as one' }));
  await waitFor(() => expect(decideBodies()).toHaveLength(1));
  expect(decideBodies()[0]).toMatchObject({ outcomeId: 'merge:g1', acknowledgeConflict: true });
});

test('name matches are listed, then accepted together', async () => {
  render(<GenreEntitiesTab />);
  fireEvent.click(await screen.findByText('Name matches'));
  expect(screen.getByText('Techno → Electronic › Techno')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Accept all 1' }));
  await waitFor(() => expect(addToast).toHaveBeenCalledWith('Accepted 1 name match', 'success', expect.objectContaining({ actionLabel: 'Undo' })));
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/accept-exact'))!;
  expect(JSON.parse(String(call[1]!.body))).toEqual({ items: [{ key: 'tag:techno', signature: 's-techno' }] });
});

test('asks each kind of question in words', () => {
  expect(genreQuestion(unmapped)).toBe('Which genre?');
  expect(genreQuestion(disco)).toBe('Electronic or Funk / Soul?');
  expect(genreQuestion(spelling)).toBe('One genre, two spellings?');
  expect(genreQuestion({ ...unmapped, kind: 'guessed', current: [{ genre: 'Rock', styleId: 1, style: 'Heavy Metal' }] })).toBe('Rock › Heavy Metal?');
});
