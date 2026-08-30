import { publishApiV1Event, replayApiV1Events, subscribeApiV1Events } from './apiV1Events.service';

describe('Aurora API v1 event stream', () => {
  it('isolates listeners and replay history by user', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeApiV1Events('user-a', listener);
    const first = publishApiV1Event('user-a', 'playlist.changed', { playlistId: 'p1' });
    publishApiV1Event('user-b', 'playlist.changed', { playlistId: 'private' });
    const second = publishApiV1Event('user-a', 'library.revision', { revision: 'r2' });
    unsubscribe();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(replayApiV1Events('user-a', first.id)).toEqual([second]);
    expect(replayApiV1Events('user-b', first.id)).toBeNull();
  });
});
