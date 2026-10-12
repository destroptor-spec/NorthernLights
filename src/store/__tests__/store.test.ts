import { usePlayerStore } from '../index';
import { TrackInfo } from '../../utils/fileSystem';

describe('Music Store Logic', () => {
  beforeEach(() => {
    usePlayerStore.setState({ library: [], playlist: [] });
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

  it('preserves Auto quality while hydrating browser track URLs', () => {
    usePlayerStore.setState({ mediaAccessToken: 'media-token', streamingQuality: 'auto' });
    const [track] = usePlayerStore.getState().hydrateTracks([
      { id: 'adaptive-track', path: 'L211c2ljL2FkYXB0aXZlLmZsYWM=', title: 'Adaptive' },
    ]);
    const url = new URL(track.url!);
    expect(url.searchParams.get('quality')).toBe('auto');
    expect(url.searchParams.get('token')).toBe('media-token');
  });

  describe('Next on the last track', () => {
    const queue = () => [{ id: 'a', path: '/a.mp3', title: 'a' }, { id: 'b', path: '/b.mp3', title: 'b' }];
    const stubs = () => {
      const playAtIndex = jest.fn().mockResolvedValue(undefined);
      const stop = jest.fn();
      const fetchNextInfinityTrack = jest.fn().mockResolvedValue(undefined);
      usePlayerStore.setState({ playAtIndex, stop, fetchNextInfinityTrack, recordSkip: jest.fn(), _scrobbleEligible: true, shuffle: false } as never);
      return { playAtIndex, stop, fetchNextInfinityTrack };
    };

    it('wraps to the first track only with repeat-all', async () => {
      const { playAtIndex } = stubs();
      usePlayerStore.setState({ playlist: queue(), currentIndex: 1, repeat: 'all' });
      await usePlayerStore.getState().nextTrack();
      expect(playAtIndex).toHaveBeenCalledWith(0);
    });

    it('continues with Infinity instead of jumping back to the first track', async () => {
      const { playAtIndex, fetchNextInfinityTrack } = stubs();
      usePlayerStore.setState({ playlist: queue(), currentIndex: 1, repeat: 'none', isInfinityMode: true });
      await usePlayerStore.getState().nextTrack();
      expect(fetchNextInfinityTrack).toHaveBeenCalledWith(false);
      expect(playAtIndex).not.toHaveBeenCalled();
    });

    it('ends the queue without Infinity, as the last track ending by itself does', async () => {
      const { playAtIndex, stop } = stubs();
      usePlayerStore.setState({ playlist: queue(), currentIndex: 1, repeat: 'none', isInfinityMode: false });
      await usePlayerStore.getState().nextTrack();
      expect(stop).toHaveBeenCalled();
      expect(playAtIndex).not.toHaveBeenCalled();
    });

    it('still advances normally before the end', async () => {
      const { playAtIndex } = stubs();
      usePlayerStore.setState({ playlist: queue(), currentIndex: 0, repeat: 'none', isInfinityMode: false });
      await usePlayerStore.getState().nextTrack();
      expect(playAtIndex).toHaveBeenCalledWith(1);
    });
  });
});
