import { isClientListening, listConnectedDevices, noteClientListening, publishApiV1Event, replayApiV1Events, subscribeApiV1Events } from './apiV1Events.service';

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

  it('delivers a transient event live but never replays it', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeApiV1Events('user-t', listener);
    const before = publishApiV1Event('user-t', 'playlist.changed', { playlistId: 'p1' });
    const progress = publishApiV1Event('user-t', 'playbackSession.progress', { sessionId: 's1' }, { transient: true });
    const after = publishApiV1Event('user-t', 'playlist.changed', { playlistId: 'p2' });
    unsubscribe();

    expect(listener).toHaveBeenCalledWith(progress);
    expect(replayApiV1Events('user-t', before.id)).toEqual([after]);
    // A client whose last seen event was a transient one has lost its place.
    expect(replayApiV1Events('user-t', progress.id)).toBeNull();
  });

  it('knows which devices have a stream open, counting each one', () => {
    const first = noteClientListening('user-l', 'phone-1234');
    const second = noteClientListening('user-l', 'phone-1234');
    expect(isClientListening('user-l', 'phone-1234')).toBe(true);
    expect(isClientListening('user-other', 'phone-1234')).toBe(false);
    first();
    first();
    expect(isClientListening('user-l', 'phone-1234')).toBe(true);
    second();
    expect(isClientListening('user-l', 'phone-1234')).toBe(false);
  });

  it('lists the devices with Aurora open by name, and tells every stream when one comes or goes', () => {
    const heard = jest.fn();
    const unsubscribe = subscribeApiV1Events('user-d', heard);
    const closeLaptop = noteClientListening('user-d', 'laptop-0001', { name: 'Chrome on Linux', kind: 'browser' });
    const closePhone = noteClientListening('user-d', 'phone-0002', { name: 'Chrome on Android', kind: 'browser' });
    const closeLaptopAgain = noteClientListening('user-d', 'laptop-0001', { name: 'Chrome on Linux', kind: 'browser' });
    expect(listConnectedDevices('user-d')).toEqual([
      { clientId: 'laptop-0001', name: 'Chrome on Linux', kind: 'browser' },
      { clientId: 'phone-0002', name: 'Chrome on Android', kind: 'browser' },
    ]);
    // A second tab of the same device is no news; only arrivals and departures are.
    expect(heard.mock.calls.map(([event]) => event.type)).toEqual(['devices.changed', 'devices.changed']);

    closePhone();
    expect(heard).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'devices.changed', data: { devices: [{ clientId: 'laptop-0001', name: 'Chrome on Linux', kind: 'browser' }] },
    }));
    closeLaptop();
    expect(heard).toHaveBeenCalledTimes(3);
    closeLaptopAgain();
    expect(listConnectedDevices('user-d')).toEqual([]);
    expect(heard).toHaveBeenCalledTimes(4);
    unsubscribe();
  });
});
