import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { usePlayerStore } from '../store';
import type { Track } from '../api/auroraApi';
import { Hub } from './Hub';
// Resolve react-router through Jest's CommonJS loader, as the other component tests do.
const { MemoryRouter } = require('react-router-dom') as typeof import('react-router-dom');

/**
 * The Hub moved from /api/hub/* to API v1: collections arrive as a bare array
 * in the v1 envelope, tracks as v1 Track DTOs, and POSTs need an explicit JSON
 * content type (auroraApiRequest doesn't add one; without it the body is
 * never parsed and v1 answers 400).
 */
const apiTrack = (id: string): Track => ({
  id, title: `Song ${id}`, artist: 'Artist', albumArtist: null, artists: ['Artist'], album: 'Album',
  genre: null, genres: [], durationSeconds: 100, trackNumber: null, discNumber: null, year: null,
  releaseType: null, compilation: false, bitrate: null, format: 'FLAC', lossless: true, fileSize: null,
  mediaEtag: null, artistId: null, albumId: null, genreId: null, loved: false, rating: 0, playCount: 0,
  lastPlayedAt: null, artworkId: null, artworkUrl: null,
  musicBrainz: { recordingId: null, trackId: null, albumId: null, artistId: null, albumArtistId: null, releaseGroupId: null, workId: null },
});

const emptySmart = {
  jumpBackIn: [], onRepeat: null, repeatRewind: null, daylist: null, artistRadios: [],
  seasonalRewind: null, yearRewind: null, wrappedYear: null, wrappedSeason: null,
};

let routes: Record<string, unknown>;
const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
  const key = `${init?.method || 'GET'} ${url}`;
  const body = key in routes ? routes[key] : {};
  return { ok: true, status: 200, json: async () => ({ data: body }), headers: { get: () => null } };
});
const calls = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method || 'GET'} ${url}`);
const callTo = (key: string) => fetchMock.mock.calls.find(([url, init]) => `${init?.method || 'GET'} ${url}` === key);

// jsdom has no ResizeObserver; the smart-section rails use one.
(global as unknown as { ResizeObserver: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const setPlaylist = jest.fn();
beforeEach(() => {
  fetchMock.mockClear();
  setPlaylist.mockClear();
  global.fetch = fetchMock as never;
  routes = {
    'GET /api/v1/hub': [{ id: 'c1', title: 'Late Night Jazz', isLlmGenerated: true, tracks: [apiTrack('t1')] }],
    'GET /api/v1/hub/smart': emptySmart,
  };
  usePlayerStore.setState({
    library: [], albums: [{ id: 'al1', title: 'Album' }], playlists: [],
    authToken: 'jwt', mediaAccessToken: 'media', streamingQuality: 'auto',
    llmBaseUrl: 'http://llm', llmModelName: 'model',
    setPlaylist, fetchPlaylistsFromServer: jest.fn(async () => {}),
  } as never);
});

const renderHub = () => render(<MemoryRouter><Hub /></MemoryRouter>);

it('loads both hub feeds from v1 and nothing from the legacy routes', async () => {
  renderHub();
  await screen.findByLabelText('play Late Night Jazz');
  expect(calls()).toEqual(expect.arrayContaining(['GET /api/v1/hub', 'GET /api/v1/hub/smart']));
  expect(calls().filter((c) => c.includes('/api/hub'))).toEqual([]);
});

it('plays a collection with v1 tracks converted to playable ones', async () => {
  renderHub();
  const card = await screen.findByLabelText('play Late Night Jazz');
  fireEvent.click(within(card).getByLabelText('play'));
  await waitFor(() => expect(setPlaylist).toHaveBeenCalled());
  const [tracks] = setPlaylist.mock.calls[0];
  expect(tracks.map((t: { id: string }) => t.id)).toEqual(['t1']);
  expect(tracks[0].url).toContain('/api/stream/t1/');
  expect(tracks[0].url).toContain('token=media');
});

it('regenerates through v1 with a JSON body and shows why it was skipped', async () => {
  routes['GET /api/v1/hub'] = [];
  routes['POST /api/v1/hub/regenerate'] = { skipped: true, reason: 'Refresh already running', generated: 0 };
  renderHub();
  fireEvent.click(await screen.findByLabelText('generate playlists'));
  await screen.findByText(/Refresh already running/);
  const [, init] = callTo('POST /api/v1/hub/regenerate')!;
  expect(new Headers(init!.headers).get('Content-Type')).toBe('application/json');
  expect(JSON.parse(String(init!.body))).toEqual({ force: true });
});

it('opens an artist radio through v1 with a JSON body', async () => {
  routes['GET /api/v1/hub/smart'] = {
    ...emptySmart,
    artistRadios: [{ artistId: 'a1', artistName: 'Tove Lo', imageUrl: null, recentPlays: 3, withArtists: [] }],
  };
  routes['POST /api/v1/hub/artist-radio'] = { id: 'radio1', title: 'Tove Lo radio', tracks: [] };
  renderHub();
  fireEvent.click(await screen.findByText('Tove Lo radio'));
  await waitFor(() => expect(callTo('POST /api/v1/hub/artist-radio')).toBeTruthy());
  const [, init] = callTo('POST /api/v1/hub/artist-radio')!;
  expect(new Headers(init!.headers).get('Content-Type')).toBe('application/json');
  expect(JSON.parse(String(init!.body))).toEqual({ artistId: 'a1' });
});
