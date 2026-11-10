import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TrackRays } from './TrackRays';
import { StyleProfileChips } from './StyleProfileChips';
import { usePlayerStore } from '../../store';
import type { TrackRays as Rays } from '../../../shared/api/v1';

// The artist's portrait and banner come from the provider cache; here, none.
jest.mock('../../hooks/useArtistData', () => ({ useArtistData: () => ({ imageUrl: undefined, artworkUrl: undefined }) }));
jest.mock('../../hooks/useInView', () => ({ useInView: () => [() => {}, false] }));
// The v1 → playable conversion has its own tests; the fixture track is partial.
jest.mock('../../utils/playableTracks', () => ({ toPlayableTracks: (tracks: unknown[]) => tracks }));

// The credits rail measures itself; the test DOM has no ResizeObserver.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: {} }) }) as Response;
const originalFetch = global.fetch;

const rays = (): Rays => ({
  track: { id: 't1', title: 'Finally Moving', artist: 'Pretty Lights', year: 2006 } as Rays['track'],
  credits: [
    { role: 'artist', artistId: 'a3', name: 'Pretty Lights', detail: null, imageUrl: null },
    { role: 'featured', artistId: null, name: 'Guest Unknown', detail: null, imageUrl: null },
    { role: 'performer', artistId: 'a2', name: 'John Shanks', detail: 'guitar', imageUrl: null },
    { role: 'performer', artistId: 'a2', name: 'John Shanks', detail: 'bass guitar', imageUrl: null },
    { role: 'composer', artistId: 'a2', name: 'John Shanks', detail: null, imageUrl: null },
    { role: 'producer', artistId: 'a2', name: 'John Shanks', detail: null, imageUrl: null },
    { role: 'producer', artistId: 'a1', name: 'Derek Vincent Smith', detail: null, imageUrl: '/img/derek.jpg' },
    { role: 'engineer', artistId: 'a2', name: 'John Shanks', detail: null, imageUrl: null },
  ],
  tags: ['Electric Hip Hop Soul'],
  styles: [
    { genre: 'Electronic', styleId: null, style: null, source: 'tag', strength: 1, fromTags: ['Electric Hip Hop Soul'] },
    { genre: 'Electronic', styleId: 78, style: 'Glitch', source: 'audio', strength: 0.4, fromTags: [] },
  ],
  sound: { energy: 0.8, danceability: 0.9, acousticness: 0.1, instrumentalness: 0.7, brightness: 0.4, percussiveness: 0.6, bpm: 74,
    closestStyles: [{ genre: 'Electronic', styleId: 78, style: 'Glitch', score: 0.5 }, { genre: 'Electronic', styleId: 56, style: 'Downtempo', score: 0.31 }],
    genreMix: [{ genre: 'Electronic', share: 0.7 }, { genre: 'Hip Hop', share: 0.2 }, { genre: 'Funk / Soul', share: 0.1 }] },
  album: { id: 'al1', title: 'Taking Up Your Precious Time', artworkId: 'hash1', entries: [
    { genre: 'Electronic', styleId: null, style: null, share: 1, trackCount: 15 },
    { genre: 'Electronic', styleId: 56, style: 'Downtempo', share: 0.6, trackCount: 9 },
  ] },
  artist: { id: 'ar1', name: 'Pretty Lights', imageUrl: null, artworkUrl: null, musicBrainzId: null, entries: [], listenerTags: ['electronic', 'downtempo'] },
  otherArtists: [
    { role: 'featured', id: 'ar5', name: 'Guest Star', imageUrl: null, artworkUrl: null, musicBrainzId: null, entries: [], listenerTags: [] },
    { role: 'remixer', id: 'ar7', name: 'Remix Person', imageUrl: null, artworkUrl: null, musicBrainzId: null,
      entries: [{ genre: 'Electronic', styleId: 56, style: 'Downtempo', share: 0.8, trackCount: 4, albumCount: 1 }], listenerTags: ['chillout'] },
  ],
  otherAlbums: [{ trackId: 't9', albumId: 'al9', albumTitle: 'Best Of', artistName: 'Pretty Lights', year: 2015, artworkId: 'hash9' }],
});

let fetchMock: jest.Mock;
beforeEach(() => {
  fetchMock = jest.fn(async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path === '/api/v1/tracks/t1/rays') return ok(rays());
    if (path === '/api/library/genre-reviews/taxonomy') return { ok: true, json: async () => ({ genres: ['Electronic'], styles: [] }) } as Response;
    if (path.startsWith('/api/library/track-styles/')) return { ok: true, json: async () => ({ status: 'saved' }) } as Response;
    if (path === '/api/v1/albums/al1/styles') return ok({ entries: [{ genre: 'Electronic', styleId: 56, style: 'Downtempo', share: 0.6, trackCount: 9 }] });
    return ok({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  usePlayerStore.setState({ addToast: jest.fn(), currentUser: { role: 'listener' }, newBrowseEnabled: true } as never);
});
afterEach(() => { global.fetch = originalFetch; });

const renderRays = () => render(
  <MemoryRouter initialEntries={['/library/rays/t1']}>
    <Routes><Route path="/library/rays/:trackId" element={<TrackRays />} /></Routes>
  </MemoryRouter>,
);

test('says where each genre and style came from, groups credits by person, and sets the track in its album', async () => {
  renderRays();
  const heading = await screen.findByRole('heading', { level: 1 });
  expect(heading.textContent).toBe('Aurora rays from Finally Moving');
  // One card per person in the credits rail: every role in order, then the
  // instruments; the first role is the badge; the stored image when there is one.
  expect(screen.getAllByText('John Shanks')).toHaveLength(1);
  const shanks = screen.getByRole('link', { name: 'John Shanks: Performer · Composer · Producer · Engineer, guitar, bass guitar' });
  expect(within(shanks).getByText('performer')).toBeTruthy();
  // The billed artists come first; a featured name without a library artist is a card, not a link.
  expect(screen.getByRole('link', { name: 'Pretty Lights: Artist' }).getAttribute('href')).toBe('/library/artist/a3');
  expect(screen.getByRole('group', { name: 'Guest Unknown: Featured' }).closest('a')).toBeNull();
  const derek = screen.getByRole('link', { name: 'Derek Vincent Smith: Producer' });
  expect(derek.getAttribute('href')).toBe('/library/artist/a1');
  expect(derek.querySelector('img')!.getAttribute('src')).toBe('/img/derek.jpg');
  // Sections in order: Credits, In context, Sound and style, Also on.
  expect([...document.querySelectorAll('section')].map(el => el.getAttribute('aria-label')))
    .toEqual(['Credits', 'In context', 'Sound and style', 'Also on']);
  // The model's scores: Glitch is one of the track's styles (check), Downtempo only close to it.
  const glitchBar = screen.getByTitle("Glitch (Electronic): strong, model score 0.50, one of this track's styles");
  expect(within(glitchBar).getByText('Strong')).toBeTruthy();
  expect(glitchBar.getAttribute('data-member')).toBe('true');
  expect(within(glitchBar).getByLabelText("One of this track's styles")).toBeTruthy();
  expect(screen.getByTitle('Downtempo (Electronic): clear, model score 0.31').getAttribute('data-member')).toBeNull();
  expect(screen.getByTitle('Hip Hop: 20 % of the scores')).toBeTruthy();
  expect(screen.getByRole('meter', { name: 'Brightness' }).getAttribute('aria-valuenow')).toBe('40');
  expect(screen.getByText('Glitch, where Downtempo leads Taking Up Your Precious Time (60 %).')).toBeTruthy();
  expect(screen.getByRole('meter', { name: 'Character' }).getAttribute('aria-valuenow')).toBe('90');
  expect(screen.getByText('Best Of').closest('a')!.getAttribute('href')).toBe('/library/album/al9');
  // In context: a card per album and artist, the context line in the album's card.
  const albumCard = screen.getByText('Taking Up Your Precious Time', { selector: '.rays-context-card__title' }).closest('article')!;
  expect(within(albumCard).getByText('Taking Up Your Precious Time', { selector: 'a' }).getAttribute('href')).toBe('/library/album/al1');
  expect(within(albumCard).getByText('Glitch, where Downtempo leads Taking Up Your Precious Time (60 %).')).toBeTruthy();
  // After the album and the artist: a card per featured artist and remixer, saying which.
  const contextCards = [...document.querySelectorAll('.rays-context-card')];
  expect(contextCards.map(c => c.querySelector('.rays-context-card__info')!.textContent))
    .toEqual(['The album', 'The artist', 'Featured artist', 'Remixer']);
  const remixCard = contextCards[3] as HTMLElement;
  expect(within(remixCard).getByText('Remix Person', { selector: 'a' }).getAttribute('href')).toBe('/library/artist/ar7');
  expect(within(remixCard).getByText('Downtempo')).toBeTruthy();
  expect(within(contextCards[2] as HTMLElement).getByText('No genres or styles of their own in your library yet.')).toBeTruthy();
  // Sound and style: a Sound card and a Styles card; the track's genres and
  // styles wait behind Advanced at the foot of the Styles card.
  const styles = screen.getByRole('group', { name: 'Styles' });
  expect(within(styles).queryByText('Genres and styles')).toBeNull();
  const advanced = within(styles).getByRole('button', { name: 'Advanced' });
  expect(advanced.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(advanced);
  expect(advanced.getAttribute('aria-expanded')).toBe('true');
  const headings = [...styles.querySelectorAll('h3, h4, figcaption .rays-chart__title')].map(el => el.textContent);
  expect(headings[headings.length - 1]).toBe('Genres and styles');
  expect(screen.getByText('From the file tag “Electric Hip Hop Soul”')).toBeTruthy();
  expect(screen.getByText('From the sound')).toBeTruthy();
  expect(screen.getByText('Electronic › Glitch').closest('a')!.getAttribute('href')).toBe('/library/browse/style/78');
  expect(within(screen.getByRole('group', { name: 'Sound' })).getByRole('meter', { name: 'Energy' })).toBeTruthy();
  // Listeners can't change genres: no Remove, and the bars open the style.
  expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
  expect(glitchBar.tagName).toBe('A');
});

test('when this is the track playing, the page says so and Play becomes Pause, then Resume', async () => {
  const pause = jest.fn();
  const resume = jest.fn(async () => {});
  usePlayerStore.setState({ playlist: [{ id: 't1' }], currentIndex: 0, playbackState: 'playing', pause, resume } as never);
  renderRays();
  fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
  expect(pause).toHaveBeenCalled();
  expect(screen.getByText('now playing')).toBeTruthy();

  usePlayerStore.setState({ playbackState: 'paused' } as never);
  fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
  expect(resume).toHaveBeenCalled();
  usePlayerStore.setState({ playlist: [], currentIndex: null, playbackState: 'stopped' } as never);
});

test('an admin removes a style from the track, with Undo', async () => {
  usePlayerStore.setState({ currentUser: { role: 'admin' } } as never);
  renderRays();
  fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Remove Electronic › Glitch from this track' }));
  await waitFor(() => expect(usePlayerStore.getState().addToast).toHaveBeenCalled());
  const call = fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/library/track-styles/'))!;
  expect(JSON.parse(String(call[1].body))).toEqual({ genre: 'Electronic', styleId: 78, action: 'remove' });
  expect((usePlayerStore.getState().addToast as jest.Mock).mock.calls[0][0]).toBe('Removed Electronic › Glitch');
  expect((usePlayerStore.getState().addToast as jest.Mock).mock.calls[0][2].actionLabel).toBe('Undo');
});

test('an admin toggles a style on the track from its bar', async () => {
  usePlayerStore.setState({ currentUser: { role: 'admin' } } as never);
  renderRays();
  const posted = () => fetchMock.mock.calls
    .filter(([u]) => String(u).startsWith('/api/library/track-styles/'))
    .map(([, init]) => JSON.parse(String(init.body)));

  // Downtempo isn't one of its styles: selecting it adds it.
  const downtempo = await screen.findByTitle('Downtempo (Electronic): clear, model score 0.31. Add it to this track');
  expect(downtempo.tagName).toBe('BUTTON');
  expect(downtempo.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(downtempo);
  await waitFor(() => expect(posted()).toEqual([{ genre: 'Electronic', styleId: 56, action: 'add' }]));
  await waitFor(() => expect((usePlayerStore.getState().addToast as jest.Mock).mock.calls[0][0]).toBe('Added Electronic › Downtempo'));

  // Glitch is: selecting it takes it off.
  const glitch = screen.getByTitle('Glitch (Electronic): strong, model score 0.50. Take it off this track');
  expect(glitch.getAttribute('aria-pressed')).toBe('true');
  await waitFor(() => expect((glitch as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(glitch);
  await waitFor(() => expect(posted()[1]).toEqual({ genre: 'Electronic', styleId: 78, action: 'remove' }));
});

test('album and artist pages show their profile only while genre and style browse is on', async () => {
  const { unmount } = render(<MemoryRouter><StyleProfileChips kind="album" id="al1" /></MemoryRouter>);
  const chip = (await screen.findByText('Downtempo')).closest('a')!;
  expect(chip.getAttribute('href')).toBe('/library/browse/style/56');
  expect(within(chip).getByText('60 %')).toBeTruthy();
  unmount();

  usePlayerStore.setState({ newBrowseEnabled: false } as never);
  fetchMock.mockClear();
  const { container } = render(<MemoryRouter><StyleProfileChips kind="album" id="al1" /></MemoryRouter>);
  expect(container.textContent).toBe('');
  expect(fetchMock).not.toHaveBeenCalled();
});
