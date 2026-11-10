import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TrackRays } from './TrackRays';
import { StyleProfileChips } from './StyleProfileChips';
import { usePlayerStore } from '../../store';
import type { TrackRays as Rays } from '../../../shared/api/v1';

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data, meta: {} }) }) as Response;
const originalFetch = global.fetch;

const rays = (): Rays => ({
  track: { id: 't1', title: 'Finally Moving', artist: 'Pretty Lights', year: 2006 } as Rays['track'],
  credits: [
    { role: 'producer', artistId: 'a1', name: 'Derek Vincent Smith', detail: null },
    { role: 'performer', artistId: 'a2', name: 'John Shanks', detail: 'guitar' },
    { role: 'performer', artistId: 'a2', name: 'John Shanks', detail: 'bass guitar' },
  ],
  tags: ['Electric Hip Hop Soul'],
  styles: [
    { genre: 'Electronic', styleId: null, style: null, source: 'tag', strength: 1, fromTags: ['Electric Hip Hop Soul'] },
    { genre: 'Electronic', styleId: 78, style: 'Glitch', source: 'audio', strength: 0.4, fromTags: [] },
  ],
  sound: { energy: 0.8, danceability: 0.9, acousticness: 0.1, instrumentalness: 0.7, bpm: 74,
    closestStyles: [{ genre: 'Electronic', styleId: 78, style: 'Glitch', score: 0.5 }] },
  album: { id: 'al1', title: 'Taking Up Your Precious Time', entries: [
    { genre: 'Electronic', styleId: null, style: null, share: 1, trackCount: 15 },
    { genre: 'Electronic', styleId: 56, style: 'Downtempo', share: 0.6, trackCount: 9 },
  ] },
  artist: { id: 'ar1', name: 'Pretty Lights', entries: [], listenerTags: ['electronic', 'downtempo'] },
  otherAlbums: [{ trackId: 't9', albumId: 'al9', albumTitle: 'Best Of', artistName: 'Pretty Lights', year: 2015 }],
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
  expect(heading.textContent).toBe('Aurora rays fromFinally Moving');
  expect(screen.getByText('From the file tag “Electric Hip Hop Soul”')).toBeTruthy();
  expect(screen.getByText('From the sound')).toBeTruthy();
  expect(screen.getByText('Electronic › Glitch').closest('a')!.getAttribute('href')).toBe('/library/browse/style/78');
  // One row per person in a role, with each instrument.
  expect(screen.getByText('(guitar, bass guitar)')).toBeTruthy();
  expect(screen.getByText('Glitch, where Downtempo leads Taking Up Your Precious Time (60 %).')).toBeTruthy();
  expect(screen.getByRole('meter', { name: 'Character' }).getAttribute('aria-valuenow')).toBe('90');
  expect(screen.getByText('Best Of').closest('a')!.getAttribute('href')).toBe('/library/album/al9');
  // Listeners can't change genres; there's no Remove.
  expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
});

test('an admin removes a style from the track, with Undo', async () => {
  usePlayerStore.setState({ currentUser: { role: 'admin' } } as never);
  renderRays();
  fireEvent.click(await screen.findByRole('button', { name: 'Remove Electronic › Glitch from this track' }));
  await waitFor(() => expect(usePlayerStore.getState().addToast).toHaveBeenCalled());
  const call = fetchMock.mock.calls.find(([u]) => String(u).startsWith('/api/library/track-styles/'))!;
  expect(JSON.parse(String(call[1].body))).toEqual({ genre: 'Electronic', styleId: 78, action: 'remove' });
  expect((usePlayerStore.getState().addToast as jest.Mock).mock.calls[0][0]).toBe('Removed Electronic › Glitch');
  expect((usePlayerStore.getState().addToast as jest.Mock).mock.calls[0][2].actionLabel).toBe('Undo');
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
