import { CastStatusStream, type CastStatusStreamState } from '../castStatusStream';

/**
 * docs/cast-takeover.md, PR 4: with sync off nothing else opens the event
 * stream, so this one carries the receiver's relayed status while casting.
 */
class FakeSource {
  static made: FakeSource[] = [];
  readyState = 1;
  onopen = null;
  onerror = null;
  closed = false;
  listeners = new Map<string, (event: { data: string }) => void>();
  constructor(public url: string) { FakeSource.made.push(this); }
  addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, listener); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { this.listeners.get(type)?.({ data: JSON.stringify({ data }) }); }
}

const state = (extra: Partial<CastStatusStreamState> = {}): CastStatusStreamState => ({
  castConnected: true, syncPlaybackAcrossDevices: false, currentUser: { id: 'u-b' }, authToken: 'session-jwt', sseAccessToken: 'sse-token', ...extra,
});

beforeEach(() => { FakeSource.made = []; });

it('opens while casting with sync off, with the sse token only, and passes cast.status on', () => {
  const onStatus = jest.fn();
  const stream = new CastStatusStream({ onStatus, createEventSource: (url) => new FakeSource(url) as never });
  stream.update(state());
  expect(FakeSource.made.map((s) => s.url)).toEqual(['/api/v1/events?token=sse-token']);
  FakeSource.made[0].emit('cast.status', { castSessionId: 'sid', status: { type: 'aurora.status' } });
  expect(onStatus).toHaveBeenCalledWith('sid', { type: 'aurora.status' });
  // The same state again changes nothing.
  stream.update(state());
  expect(FakeSource.made).toHaveLength(1);
});

it('stays closed with sync on (the follower carries it), when not casting, or without a scoped token', () => {
  const stream = new CastStatusStream({ onStatus: jest.fn(), createEventSource: (url) => new FakeSource(url) as never });
  stream.update(state({ syncPlaybackAcrossDevices: true }));
  stream.update(state({ castConnected: false }));
  stream.update(state({ sseAccessToken: null }));
  stream.update(state({ sseAccessToken: 'session-jwt' }));
  expect(FakeSource.made).toHaveLength(0);
});

it('closes when casting ends', () => {
  const stream = new CastStatusStream({ onStatus: jest.fn(), createEventSource: (url) => new FakeSource(url) as never });
  stream.update(state());
  stream.update(state({ castConnected: false }));
  expect(FakeSource.made[0].closed).toBe(true);
});
