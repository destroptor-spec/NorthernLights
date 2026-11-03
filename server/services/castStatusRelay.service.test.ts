import { publishApiV1Event, replayApiV1Events, subscribeApiV1Events } from './apiV1Events.service';
import { CAST_STATUS_MAX_BYTES, relayCastStatus } from './castStatusRelay.service';

jest.mock('../database', () => ({}));

const status = {
  type: 'aurora.status',
  reason: 'interval',
  queueEntryId: '6c3010d2-40a2-43dd-8ad6-1ede5bf0ea7f',
  playerState: 'PLAYING',
  currentTime: 75,
  duration: 172,
  castingClientId: 'web:1bb9',
};

/**
 * Prod 2026-10-27 12:33 and 2026-11-02 21:47: desktop Chrome joining a Cast
 * session another device started heard nothing back from the receiver. The
 * receiver posts its status, and its media token's user hears it here.
 */
describe('the Cast status relay', () => {
  it("passes the receiver's status on, live only, to the user whose token signs it and nobody else", () => {
    const before = publishApiV1Event('user-b', 'playlist.changed', { playlistId: 'p1' });
    const mine = jest.fn();
    const theirs = jest.fn();
    const stopMine = subscribeApiV1Events('user-b', mine);
    const stopTheirs = subscribeApiV1Events('user-a', theirs);

    expect(relayCastStatus('user-b', { castSessionId: '56399d73-9d3e-4a95-8d71-977d51a831ec', status })).toBe('relayed');
    stopMine();
    stopTheirs();

    expect(mine).toHaveBeenCalledTimes(1);
    expect(mine.mock.calls[0][0]).toMatchObject({
      type: 'cast.status',
      data: { castSessionId: '56399d73-9d3e-4a95-8d71-977d51a831ec', status },
    });
    expect(theirs).not.toHaveBeenCalled();
    // Live only: a reconnecting stream never replays an old status.
    expect(replayApiV1Events('user-b', before.id)).toEqual([]);
  });

  it('refuses anything but a receiver status for a Cast session id, and anything oversized', () => {
    const listener = jest.fn();
    const stop = subscribeApiV1Events('user-c', listener);
    const sid = '56399d73-9d3e-4a95-8d71-977d51a831ec';
    for (const body of [
      null,
      'aurora.status',
      { status },
      { castSessionId: '', status },
      { castSessionId: 'a b', status },
      { castSessionId: 'x'.repeat(129), status },
      { castSessionId: sid },
      { castSessionId: sid, status: [status] },
      { castSessionId: sid, status: { ...status, type: 'aurora.control.ack' } },
      { castSessionId: sid, status: { ...status, contentId: 'x'.repeat(CAST_STATUS_MAX_BYTES) } },
    ]) {
      expect(relayCastStatus('user-c', body)).toBe('invalid');
    }
    stop();
    expect(listener).not.toHaveBeenCalled();
  });
});
