import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { usePlayerStore } from '../../store';
import * as api from '../../api/auroraApi';
import { RecentlyPlayedList } from '../RecentlyPlayedList';

jest.mock('../AlbumArt', () => ({ AlbumArt: () => null }));
jest.mock('../../utils/playableTracks', () => ({
  toPlayableTracks: (tracks: Array<{ id: string; title: string }>) =>
    tracks.map((t) => ({ id: t.id, path: `/${t.id}.mp3`, title: t.title, artist: 'A' })),
}));

const pageSpy = jest.spyOn(api, 'auroraApiPage');
const envelope = (ids: string[], nextCursor: string | null) =>
  ({ data: ids.map((id) => ({ id, title: `Song ${id}` })), page: { nextCursor }, meta: { requestId: 'r' } }) as never;

let observed: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
beforeAll(() => {
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observed = callback; }
    observe() {}
    disconnect() {}
  };
});

const setPlaylist = jest.fn(async () => undefined);
beforeEach(() => {
  pageSpy.mockReset();
  setPlaylist.mockClear();
  usePlayerStore.setState({ setPlaylist, artists: [], getAuthHeader: () => ({}) } as never);
});

const renderList = () => render(
  <MemoryRouter>
    <RecentlyPlayedList active getScrollElement={() => null} />
  </MemoryRouter>,
);

it('shows the first page, loads the next when its end comes near, and plays the list from a tapped track', async () => {
  pageSpy.mockResolvedValueOnce(envelope(['a', 'b'], 'c1')).mockResolvedValueOnce(envelope(['c'], null));
  renderList();
  await screen.findByText('Song b');
  expect(pageSpy.mock.calls[0][0]).toBe('/me/recently-played?limit=30');

  await act(async () => { observed!([{ isIntersecting: true }]); });
  await screen.findByText('Song c');
  expect(pageSpy.mock.calls[1][0]).toBe('/me/recently-played?limit=30&cursor=c1');

  fireEvent.click(screen.getByText('Song b'));
  expect(setPlaylist).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'a' })]), 1);
});

it('says when nothing has been played', async () => {
  pageSpy.mockResolvedValueOnce(envelope([], null));
  renderList();
  expect(await screen.findByText('Nothing played yet.')).toBeTruthy();
});

it('offers Try again when the server cannot be reached', async () => {
  pageSpy.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(envelope(['a'], null));
  renderList();
  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(screen.getByText('Song a')).toBeTruthy());
});
