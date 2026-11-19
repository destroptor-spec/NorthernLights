import { act, fireEvent, render, screen } from '@testing-library/react';
import { usePlayerStore } from '../../store';
import * as albumTracks from '../../utils/albumTracks';
import { AlbumContextMenu } from '../library/AlbumContextMenu';
import { compareAlbumOrder } from '../../utils/albumTracks';

const tracks = [
  { id: 't1', path: '/1.mp3', title: 'One', discNumber: 1, trackNumber: 1 },
  { id: 't2', path: '/2.mp3', title: 'Two', discNumber: 1, trackNumber: 2 },
];
const fetchSpy = jest.spyOn(albumTracks, 'fetchAlbumTracks');

const setPlaylist = jest.fn(async () => undefined);
const addTracksToQueue = jest.fn();
const addTracksToUserPlaylist = jest.fn(async () => undefined);
const addToast = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  fetchSpy.mockResolvedValue(tracks as never);
  usePlayerStore.setState({
    setPlaylist, addTracksToQueue, addTracksToUserPlaylist, addToast, getAuthHeader: () => ({}),
    playlists: [
      { id: 'mine', title: 'Road trip', tracks: [], isOwner: true },
      { id: 'radio', title: 'ATB radio', tracks: [], isOwner: true, isSystem: true },
    ],
  } as never);
});

const open = () => {
  const onClose = jest.fn();
  render(<AlbumContextMenu album={{ id: 'al1', title: 'Kid A', artist: 'Radiohead' }} position={{ x: 10, y: 10 }} onClose={onClose} />);
  return onClose;
};
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

it('plays the album from its first track, as an album', async () => {
  const onClose = open();
  fireEvent.click(screen.getByText('Play Album'));
  expect(onClose).toHaveBeenCalled();
  await flush();
  expect(fetchSpy).toHaveBeenCalledWith('al1', {});
  expect(setPlaylist).toHaveBeenCalledWith(tracks, 0, { kind: 'album', id: 'al1', name: 'Kid A' });
});

it('adds all its tracks to the queue, with one undoable toast', async () => {
  open();
  fireEvent.click(screen.getByText('Add to Queue'));
  await flush();
  expect(addTracksToQueue).toHaveBeenCalledWith(tracks, { notify: true, undo: true, message: 'Added "Kid A" to queue.' });
});

it('adds it to a playlist this listener may add to (not a radio)', async () => {
  open();
  fireEvent.click(screen.getByRole('button', { name: 'Add to Playlist' }));
  expect(screen.queryByText('ATB radio')).toBeNull();
  fireEvent.click(screen.getByText('Road trip'));
  await flush();
  expect(addTracksToUserPlaylist).toHaveBeenCalledWith('mine', ['t1', 't2']);
  expect(addToast).toHaveBeenCalledWith('Added "Kid A" to Road trip.', 'success');
});

it('says so when the album cannot be read', async () => {
  fetchSpy.mockRejectedValueOnce(new Error('offline'));
  open();
  fireEvent.click(screen.getByText('Add to Queue'));
  await flush();
  expect(addTracksToQueue).not.toHaveBeenCalled();
  expect(addToast).toHaveBeenCalledWith("Couldn't load this album. Try again.", 'error');
});

it('orders an album by disc, then track number', () => {
  const t = (disc: number, n: number | undefined, title = '') => ({ path: '/x', title, discNumber: disc, trackNumber: n });
  const sorted = [t(2, 1), t(1, 2), t(1, undefined, 'Bonus'), t(1, 1)].sort(compareAlbumOrder);
  expect(sorted.map((x) => `${x.discNumber}.${x.trackNumber ?? '-'}`)).toEqual(['1.1', '1.2', '1.-', '2.1']);
});
