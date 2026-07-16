import { scrollToAlbumTrackTarget } from '../albumTrackFocus';

describe('scrollToAlbumTrackTarget', () => {
  it('scrolls an ordinary album row into view', () => {
    const container = document.createElement('div');
    const first = document.createElement('div');
    first.dataset.trackId = 'track-1';
    const target = document.createElement('div');
    target.dataset.trackId = 'track-2';
    target.scrollIntoView = jest.fn();
    container.append(first, target);
    const scrollToIndex = jest.fn();

    expect(scrollToAlbumTrackTarget({
      rows: [
        { type: 'track', track: { id: 'track-1' } },
        { type: 'track', track: { id: 'track-2' } },
      ],
      targetTrackId: 'track-2',
      container,
      virtualized: false,
      behavior: 'smooth',
      scrollToIndex,
    })).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it('uses the virtual row index, including preceding disc headers', () => {
    const scrollToIndex = jest.fn();

    expect(scrollToAlbumTrackTarget({
      rows: [
        { type: 'disc' },
        { type: 'track', track: { id: 'track-1' } },
        { type: 'disc' },
        { type: 'track', track: { id: 'track-2' } },
      ],
      targetTrackId: 'track-2',
      container: null,
      virtualized: true,
      behavior: 'auto',
      scrollToIndex,
    })).toBe(true);
    expect(scrollToIndex).toHaveBeenCalledWith(3, { align: 'center', behavior: 'auto' });
  });

  it('does nothing when the requested track is not on the album', () => {
    const scrollToIndex = jest.fn();
    expect(scrollToAlbumTrackTarget({
      rows: [{ type: 'track', track: { id: 'track-1' } }],
      targetTrackId: 'missing',
      container: document.createElement('div'),
      virtualized: false,
      behavior: 'smooth',
      scrollToIndex,
    })).toBe(false);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});
