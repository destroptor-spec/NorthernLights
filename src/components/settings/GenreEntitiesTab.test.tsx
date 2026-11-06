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
  artistTags: null,
  audio: null,
  suggestion: null,
  targetTracks: { 'Electronic|53': 0, 'Funk / Soul|168': 412 },
};
let evidenceFor: (key: string) => GenreReviewEvidence = key => ({ ...evidence, key });

let state: GenreReviewState;
const addToast = jest.fn();
const fetchMock = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  const path = String(url);
  if (path === '/api/library/genre-reviews') return response(state);
  if (path === '/api/library/genre-reviews/decisions') return response({ decisions: [] });
  if (path === '/api/library/genre-reviews/taxonomy') {
    return response({ genres: ['Electronic', 'Hip Hop'], styles: [{ id: 53, genre: 'Electronic', name: 'Disco' }, { id: 70, genre: 'Hip Hop', name: 'Trip Hop' }] });
  }
  if (path.startsWith('/api/library/genre-reviews/preview')) return response(evidenceFor(decodeURIComponent(path.split('key=')[1])));
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
  evidenceFor = key => ({ ...evidence, key });
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
  expect(screen.getByText('Mostly Funk / Soul for 7 of 9 artists')).toBeTruthy();
  // Not analysed yet: the sound section says so rather than disappearing.
  expect(screen.getByText('None of these tracks has been analysed yet.')).toBeTruthy();
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

test('a lone artist\'s tags and the audio fill in a suggestion, and a style few tracks share gets a warning', async () => {
  state.entries = [unmapped];
  evidenceFor = key => ({
    ...evidence, key, lean: null, targetTracks: {},
    artists: [{ name: 'Pretty Lights', imageUrl: null, tracks: 135 }],
    artistTags: ['electronic', 'downtempo', 'hip hop', 'soul'],
    audio: {
      analysed: 135, sampled: false,
      genres: [{ genre: 'Electronic', tracks: 95 }, { genre: 'Hip Hop', tracks: 15 }],
      styles: [{ genre: 'Electronic', styleId: 60, style: 'Downtempo', tracks: 32, near: 82 }, { genre: 'Hip Hop', styleId: 71, style: 'Instrumental', tracks: 11, near: 40 }],
    },
    suggestion: { targets: [{ genre: 'Electronic', styleId: null, style: null }], basis: 'both', stylesVary: true, looseStyles: [] },
  });
  render(<GenreEntitiesTab />);
  // Each source says what it is and where it comes from.
  expect(await screen.findByText('How the tracks sound')).toBeTruthy();
  expect(screen.getByText(/^From Aurora's analysis of the audio in all 135 tracks\./)).toBeTruthy();
  expect(screen.getByText('Instrumental (Hip Hop)')).toBeTruthy();
  expect(screen.getByText(/^What listeners tag Pretty Lights with on Last\.fm and MusicBrainz/)).toBeTruthy();
  expect(screen.getByText('downtempo')).toBeTruthy();
  // The reason sits in the suggested card.
  expect(screen.getByText(/^Suggested\. The sound of the tracks and the artist tags both point to Electronic\. No style: the tracks sound like different ones \(Downtempo\)/)).toBeTruthy();

  // The picker starts with the suggestion, so Apply is one step.
  const chip = await screen.findByRole('button', { name: 'Remove Electronic' });
  expect(screen.getByText('Suggested')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement).disabled).toBe(false);

  // Swapping in a style that only a quarter of the tracks have says so.
  fireEvent.click(chip);
  fireEvent.change(screen.getByLabelText('Genre or style for Electric Hip Hop Soul'), { target: { value: 'Disco · Electronic' } });
  expect(screen.getByText(/^Only 0 of the 135 analysed tracks sound most like Disco, but all 135 tracks/)).toBeTruthy();
  expect(screen.queryByText('Suggested')).toBeNull();
  expect(screen.queryByText(/^Suggested\./)).toBeNull();
});

test('a style the tag names: each card says how many tracks sound like it, and a loosely used one is left out', async () => {
  state.entries = [disco];
  const audio = {
    analysed: 154, sampled: false, genres: [{ genre: 'Electronic', tracks: 120 }, { genre: 'Funk / Soul', tracks: 34 }],
    styles: [
      { genre: 'Electronic', styleId: 1, style: 'House', tracks: 40, near: 90 },
      { genre: 'Electronic', styleId: 53, style: 'Disco', tracks: 30, near: 101 },
      { genre: 'Funk / Soul', styleId: 168, style: 'Disco', tracks: 20, near: 84 },
    ],
  };
  evidenceFor = key => ({
    ...evidence, key, lean: { genre: 'Electronic', artists: 5, of: 6 }, audio,
    suggestion: { targets: [{ genre: 'Electronic', styleId: 53, style: 'Disco' }], basis: 'both', stylesVary: false, looseStyles: [] },
  });
  const { unmount } = render(<GenreEntitiesTab />);
  const radio = await screen.findByRole('radio', { name: /^Electronic › Disco/ });
  await waitFor(() => expect((radio as HTMLInputElement).checked).toBe(true));
  expect(screen.getByText('Suggested. The sound of the tracks and the artist tags both point to Electronic.')).toBeTruthy();
  const card = radio.closest('label')!;
  expect(within(card).getByText(/^101 of the 154 analysed\s+tracks have Disco among their 5 closest styles\.$/)).toBeTruthy();
  unmount();

  // Few tracks sound like the named style: the genre alone, in the picker.
  evidenceFor = key => ({
    ...evidence, key, lean: { genre: 'Electronic', artists: 5, of: 6 }, audio,
    suggestion: { targets: [{ genre: 'Electronic', styleId: null, style: null }], basis: 'both', stylesVary: false, looseStyles: [{ style: 'Disco', near: 12 }] },
  });
  render(<GenreEntitiesTab />);
  expect(await screen.findByRole('button', { name: 'Remove Electronic' })).toBeTruthy();
  expect(screen.getByText(/Few of the tracks have Disco \(12 of 154\) among their 5 closest styles, so the tag looks loosely used: Electronic alone, without the style\.$/)).toBeTruthy();
  expect((screen.getByRole('radio', { name: /^Electronic › Disco/ }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('radio', { name: /^Something else/ }) as HTMLInputElement).checked).toBe(true);
});

test('a compound tag keeps the styles the tracks sound like and says which it leaves out', async () => {
  const compound: GenreReviewEntry = {
    key: 'tag:hard rock/heavy metal', signature: 's-c', kind: 'compound', subject: 'Hard Rock/Heavy Metal', tagKey: 'hard rock/heavy metal',
    totalTracks: 38, current: [{ genre: 'Rock', styleId: 1, style: 'Hard Rock' }, { genre: 'Rock', styleId: 2, style: 'Heavy Metal' }],
    outcomes: [
      { id: 'accept', kind: 'accept', label: 'Both', targets: [{ genre: 'Rock', styleId: 1, style: 'Hard Rock' }, { genre: 'Rock', styleId: 2, style: 'Heavy Metal' }] },
      { id: 'only:0', kind: 'only', label: 'Rock › Hard Rock', targets: [{ genre: 'Rock', styleId: 1, style: 'Hard Rock' }] },
      { id: 'pick', kind: 'pick', label: 'Something else' },
    ],
  };
  state.entries = [compound];
  evidenceFor = key => ({
    ...evidence, key, lean: null, artistTags: ['hard rock'], targetTracks: {},
    audio: { analysed: 38, sampled: false, genres: [{ genre: 'Rock', tracks: 38 }], styles: [{ genre: 'Rock', styleId: 1, style: 'Hard Rock', tracks: 30, near: 37 }] },
    suggestion: { targets: [{ genre: 'Rock', styleId: 1, style: 'Hard Rock' }], basis: 'both', stylesVary: false, looseStyles: [{ style: 'Heavy Metal', near: 0 }] },
  });
  render(<GenreEntitiesTab />);
  const radio = await screen.findByRole('radio', { name: /^Rock › Hard Rock/ });
  await waitFor(() => expect((radio as HTMLInputElement).checked).toBe(true));
  expect(screen.getByText(/Few of the tracks have Heavy Metal \(0 of 38\) among their 5 closest styles, so it is left out\.$/)).toBeTruthy();
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
