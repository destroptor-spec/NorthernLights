import { act, fireEvent, render, screen } from '@testing-library/react';
import { WarmUpButton } from './LiveConcertsHubSection';
import { usePlayerStore } from '../store';
import { auroraApiRequest } from '../api/auroraApi';

jest.mock('../api/auroraApi', () => ({ ...jest.requireActual('../api/auroraApi'), auroraApiRequest: jest.fn() }));
jest.mock('../utils/playableTracks', () => ({
  toPlayableTracks: (tracks: Array<{ id: string; artistId: string }>) => tracks.map(t => ({ id: t.id, artistId: t.artistId })),
}));
jest.mock('../utils/shuffle', () => ({ shuffled: <T,>(items: T[]) => [...items].reverse() }));

const setPlaylist = jest.fn(async () => {});
const addToast = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  usePlayerStore.setState({ setPlaylist, addToast } as never);
});

it('shuffles the artist’s own tracks from the library into the queue as a warm-up', async () => {
  jest.mocked(auroraApiRequest).mockResolvedValue({ tracks: [
    { id: 't1', artistId: 'a1' }, { id: 'mix', artistId: 'dj' }, { id: 't2', artistId: 'a1' },
  ] });
  render(<WarmUpButton artistId="a1" artistName="Foo Fighters" />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Warm up: shuffle Foo Fighters from your library' })); });
  expect(auroraApiRequest).toHaveBeenCalledWith('/artists/a1', expect.any(Object));
  expect(setPlaylist).toHaveBeenCalledWith([{ id: 't2', artistId: 'a1' }, { id: 't1', artistId: 'a1' }], 0,
    { kind: 'artist', id: 'a1', name: 'Foo Fighters warm-up' });
});

it('says so when the library has nothing by them, and offers Retry when the request fails', async () => {
  jest.mocked(auroraApiRequest).mockResolvedValueOnce({ tracks: [] });
  render(<WarmUpButton artistId="a1" artistName="Foo Fighters" />);
  const button = screen.getByRole('button', { name: /Warm up/ });
  await act(async () => { fireEvent.click(button); });
  expect(addToast).toHaveBeenLastCalledWith('No tracks by Foo Fighters in your library', 'info');
  jest.mocked(auroraApiRequest).mockRejectedValueOnce(new Error('offline'));
  await act(async () => { fireEvent.click(button); });
  expect(addToast).toHaveBeenLastCalledWith('Could not play Foo Fighters', 'error', expect.objectContaining({ actionLabel: 'Retry' }));
  expect(setPlaylist).not.toHaveBeenCalled();
});
