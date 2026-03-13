import { usePlayerStore } from '../index';
import { TrackInfo } from '../../utils/fileSystem';

describe('Music Store Logic', () => {
  beforeEach(() => {
    usePlayerStore.setState({ library: [], playlist: [] });
  });
  it('removes track from library state', async () => {
    const mockTracks: TrackInfo[] = [
      { id: 'foo', path: '/foo.mp3', title: 'a' },
      { id: 'bar', path: '/bar.mp3', title: 'b' }
    ];
    usePlayerStore.setState({ library: mockTracks });
    await usePlayerStore.getState().deleteTrackFromLibrary('foo');
    expect(usePlayerStore.getState().library).toEqual([{ id: 'bar', path: '/bar.mp3', title: 'b' }]);
  });

  it('adds tracks to library', () => {
    usePlayerStore.setState({ library: [] });
    usePlayerStore.getState().addTracksToLibrary([{ id: 'baz', path: '/baz.mp3', title: 'c' }]);
    expect(usePlayerStore.getState().library).toHaveLength(1);
    expect(usePlayerStore.getState().library[0].title).toBe('c');
  });

  it('moves a track in the playlist', () => {
    usePlayerStore.setState({
      playlist: [
        { id: 'a', path: '/a.mp3', title: 'x' },
        { id: 'b', path: '/b.mp3', title: 'y' }
      ]
    });
    usePlayerStore.getState().moveInPlaylist(0, 1);
    expect(usePlayerStore.getState().playlist.map((t: TrackInfo) => t.id)).toEqual(['b', 'a']);
  });
});
