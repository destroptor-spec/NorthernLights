/**
 * The receiver's session follower (public/receiver-follow.js, Phase 5 PR D),
 * against fakes of CAF's PlayerManager/QueueManager, fetch and EventSource.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const follow = require('../../../public/receiver-follow.js');

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const entry = (n: number) => ({
  queueEntryId: uuid(n),
  track: { id: `track-${n}`, title: `T${n}`, artist: `A${n}`, album: 'Album', durationSeconds: 200, artworkUrl: `/api/v1/artwork/h${n}` },
});
const NOW = Date.parse('2026-10-16T20:00:00.000Z');

class Base { [key: string]: any }
const messages = {
  MediaInformation: class extends Base {},
  MusicTrackMediaMetadata: class extends Base {},
  Image: class extends Base { constructor(public url: string) { super(); } },
  QueueItem: class extends Base {},
  LoadRequestData: class extends Base {},
  QueueData: class extends Base {},
  QueueUpdateRequestData: class extends Base {},
  StreamType: { BUFFERED: 'BUFFERED' },
  HlsSegmentFormat: { TS: 'ts' },
  RepeatMode: { REPEAT_OFF: 'REPEAT_OFF', REPEAT_SINGLE: 'REPEAT_SINGLE' },
};

function sessionOf(entries: number[], extra: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    revision: 10,
    currentEntryId: uuid(entries[0]),
    repeatMode: 'none',
    shuffle: false,
    output: { id: 'receiver:cast-77', kind: 'receiver', generation: 3, castSessionId: 'cast-77' },
    queue: entries.map(entry),
    ...extra,
  };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  listeners = new Map<string, (event: { data: string }) => void>();
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.set(type, listener); }
  close() { this.closed = true; this.readyState = 2; }
  open() { this.readyState = 1; this.onopen?.(); }
  fail() { this.readyState = 2; this.onerror?.(); }
  emit(type: string, data: Record<string, unknown>) { this.listeners.get(type)?.({ data: JSON.stringify({ data }) }); }
}

function harness(options: { caf?: number[]; current?: number; session?: ReturnType<typeof sessionOf> } = {}) {
  FakeEventSource.instances = [];
  let nextItemId = 100;
  const item = (n: number) => ({ itemId: nextItemId++, media: { customData: { queueEntryId: uuid(n) } } });
  const queue = {
    items: (options.caf ?? [1, 2]).map(item) as any[],
    current: options.current ?? 0,
    getItems() { return this.items; },
    getCurrentItemIndex() { return this.current; },
    insertItems: jest.fn(function (this: any, items: any[]) { items.forEach((i) => { i.itemId = nextItemId++; this.items.push(i); }); }),
    removeItems: jest.fn(function (this: any, ids: number[]) { this.items = this.items.filter((i: any) => !ids.includes(i.itemId)); }),
    setRepeatMode: jest.fn(),
  };
  let playerState = 'PLAYING';
  const player = {
    getMediaInformation: () => queue.items[queue.current]?.media ?? null,
    getPlayerState: () => playerState,
    getCurrentTimeSec: () => 42,
    getDurationSec: () => 200,
    play: jest.fn(), pause: jest.fn(), seek: jest.fn(), stop: jest.fn(),
    sendLocalMediaRequest: jest.fn(),
    load: jest.fn(async (request: any) => { queue.items = request.queueData.items; queue.current = 0; }),
  };
  let session = options.session ?? sessionOf([1, 2, 3, 4]);
  const routes: Record<string, (init: any) => { status: number; body: unknown }> = {
    'GET /api/v1/playback-sessions/session-1': () => ({ status: 200, body: { data: session } }),
    'POST /api/v1/playback-sessions/session-1/reports': () => ({ status: 200, body: { data: { accepted: true, revision: session.revision } } }),
    'POST /api/v1/playback-sessions/session-1/output/renew': () => ({
      status: 200, body: { data: { token: 'renewed-token', expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString() } },
    }),
  };
  const fetch = jest.fn(async (url: string, init: any) => {
    const route = routes[`${init.method} ${url}`];
    const { status, body } = route ? route(init) : { status: 404, body: { error: { code: 'NOT_FOUND' } } };
    return { ok: status < 300, status, json: async () => body };
  });
  const markers: string[] = [];
  const onStopped = jest.fn();
  const follower = follow.createFollower({
    playerManager: player, queueManager: queue, messages, fetch, EventSource: FakeEventSource,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    now: () => Date.now(),
    mediaToken: () => 'media-token',
    origin: 'https://aurora.example',
    marker: (name: string, detail: string) => markers.push(`${name} ${detail}`),
    onStopped,
  });
  const handover = {
    sessionId: 'session-1', outputId: 'receiver:cast-77', generation: 3, token: 'receiver-token',
    expiresAt: new Date(NOW + 12 * 3600_000).toISOString(), renewableUntil: new Date(NOW + 24 * 3600_000).toISOString(), quality: '256k',
  };
  const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
  return {
    follower, queue, player, fetch, routes, markers, onStopped, handover, settle,
    stream: () => FakeEventSource.instances[FakeEventSource.instances.length - 1],
    setSession: (next: ReturnType<typeof sessionOf>) => { session = next; },
    setPlayerState: (next: string) => { playerState = next; },
    calls: (method: string, path: string) => fetch.mock.calls.filter(([url, init]) => url === path && init.method === method),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

describe('planning the window', () => {
  const caf = (...ns: number[]) => ns.map((n, i) => ({ itemId: i + 1, media: { customData: { queueEntryId: uuid(n) } } }));

  it('keeps what already follows, appends the rest, and drops what no longer follows', () => {
    const desired = follow.desiredUpcoming(sessionOf([1, 2, 3, 4]).queue, uuid(1), 'none', 9);
    expect(follow.planWindow(caf(1, 2), 0, desired)).toEqual({ removeItemIds: [], insert: [entry(3), entry(4)] });
    // Play next (9 after 1): everything after the change goes, then comes back in order.
    const playNext = follow.desiredUpcoming(sessionOf([1, 9, 2, 3]).queue, uuid(1), 'none', 9);
    expect(follow.planWindow(caf(1, 2, 3), 0, playNext)).toEqual({ removeItemIds: [2, 3], insert: [entry(9), entry(2), entry(3)] });
    // Previous items stay as they are.
    expect(follow.planWindow(caf(7, 1, 2), 1, follow.desiredUpcoming(sessionOf([1, 2]).queue, uuid(1), 'none', 9)))
      .toEqual({ removeItemIds: [], insert: [] });
  });

  it('refills from the head for repeat-all, never back onto the current entry', () => {
    const queue = sessionOf([1, 2, 3]).queue;
    expect(follow.desiredUpcoming(queue, uuid(3), 'all', 9).map((e: any) => e.queueEntryId)).toEqual([uuid(1), uuid(2)]);
    expect(follow.desiredUpcoming(queue, uuid(3), 'none', 9)).toEqual([]);
    expect(follow.desiredUpcoming(queue, uuid(8), 'none', 9)).toBeNull();
  });

  it('reports a short IDLE (between tracks) as buffering', () => {
    expect(follow.reportState('IDLE', false)).toBe('buffering');
    expect(follow.reportState('IDLE', true)).toBe('idle');
    expect(follow.reportState('PAUSED', false)).toBe('paused');
  });
});

describe('following', () => {
  it('opens its event stream, reads the session and appends what is missing, built like the sender', async () => {
    const { follower, queue, stream, calls, handover, settle, markers } = harness();
    expect(follower.start(handover)).toBe(true);
    await settle();
    expect(stream().url).toBe('/api/v1/events?token=receiver-token');
    expect(calls('GET', '/api/v1/playback-sessions/session-1')[0][1].headers.Authorization).toBe('Bearer receiver-token');
    expect(queue.insertItems).toHaveBeenCalledTimes(1);
    const [inserted] = queue.insertItems.mock.calls[0] as any[];
    expect(inserted.map((i: any) => i.media.customData.queueEntryId)).toEqual([uuid(3), uuid(4)]);
    expect(inserted[0].media).toMatchObject({
      contentId: 'https://aurora.example/api/stream/track-3/playlist.m3u8?quality=256k&codec=aac&token=media-token',
      contentType: 'application/vnd.apple.mpegurl',
      streamType: 'BUFFERED',
      hlsSegmentFormat: 'ts',
      customData: { queueEntryId: uuid(3), token: 'media-token', codec: 'aac', auroraFollow: true },
    });
    expect(inserted[0].media.metadata).toMatchObject({ title: 'T3', songName: 'T3', artist: 'A3', albumName: 'Album' });
    expect(inserted[0].media.metadata.images[0].url).toBe('https://aurora.example/api/v1/artwork/h3?token=media-token');
    expect(markers.join('\n')).toContain('receiver-window-reconciled reason=start removed=0 inserted=2 revision=10');
  });

  it('follows a queue edit in one batch, and jumps on when the entry that plays is removed', async () => {
    const { follower, queue, player, stream, setSession, handover, settle } = harness({ caf: [1, 2, 3] });
    follower.start(handover);
    await settle();
    setSession(sessionOf([1, 9, 2, 3], { revision: 11 }));
    stream().emit('playbackSession.updated', { sessionId: 'session-1', revision: 11 });
    await settle();
    // 2 and 3 move behind 9, and 4 (appended at the start) is gone from the session.
    expect(queue.removeItems).toHaveBeenLastCalledWith([101, 102, 103]);
    expect((queue.insertItems.mock.calls.at(-1) as any[])[0].map((i: any) => i.media.customData.queueEntryId)).toEqual([uuid(9), uuid(2), uuid(3)]);

    setSession(sessionOf([9, 2, 3], { revision: 12, currentEntryId: uuid(9) }));
    stream().emit('playbackSession.updated', { sessionId: 'session-1', revision: 12 });
    await settle();
    const jump = player.sendLocalMediaRequest.mock.calls.at(-1)[0];
    expect(jump).toBeInstanceOf(messages.QueueUpdateRequestData);
    expect(jump.currentItemId).toBe(queue.items.find((i: any) => i.media.customData.queueEntryId === uuid(9)).itemId);
    expect(queue.removeItems).not.toHaveBeenCalledWith(expect.arrayContaining([100])); // never the item that plays
  });

  it('ignores another session, an older revision and a stale command', async () => {
    const { follower, stream, calls, player, handover, settle } = harness();
    follower.start(handover);
    await settle();
    const reads = calls('GET', '/api/v1/playback-sessions/session-1').length;
    stream().emit('playbackSession.updated', { sessionId: 'session-2', revision: 99 });
    stream().emit('playbackSession.updated', { sessionId: 'session-1', revision: 9 });
    stream().emit('playbackSession.command', { sessionId: 'session-1', outputId: 'receiver:cast-77', generation: 2, command: { type: 'pause' } });
    await settle();
    expect(calls('GET', '/api/v1/playback-sessions/session-1')).toHaveLength(reads);
    expect(player.pause).not.toHaveBeenCalled();
  });
});

describe('commands', () => {
  const command = (h: ReturnType<typeof harness>, cmd: Record<string, unknown>) =>
    h.stream().emit('playbackSession.command', { sessionId: 'session-1', outputId: 'receiver:cast-77', generation: 3, command: cmd });

  it('plays, pauses, seeks and steps, and reports right after', async () => {
    const h = harness();
    h.follower.start(h.handover);
    await h.settle();
    command(h, { type: 'pause' });
    command(h, { type: 'seek', positionMs: 61_000 });
    command(h, { type: 'seek', positionMs: 199_500 }); // onto the last second: refused
    command(h, { type: 'next' });
    expect(h.player.pause).toHaveBeenCalled();
    expect(h.player.seek).toHaveBeenCalledTimes(1);
    expect(h.player.seek).toHaveBeenCalledWith(61);
    expect(h.player.sendLocalMediaRequest.mock.calls.at(-1)[0].jump).toBe(1);
    await jest.advanceTimersByTimeAsync(300);
    expect(h.calls('POST', '/api/v1/playback-sessions/session-1/reports').length).toBeGreaterThan(0);
    expect(h.markers.join('\n')).toContain('receiver-command-applied type=seek ok=false invalid-position');
  });

  it('jumps to an entry it has, and loads a new window from one it lacks', async () => {
    const h = harness({ caf: [1, 2] });
    h.follower.start(h.handover);
    await h.settle();
    command(h, { type: 'jump', entryId: uuid(2) });
    expect(h.player.sendLocalMediaRequest.mock.calls.at(-1)[0].currentItemId).toBe(101);

    // A remote load: the queue is replaced (current entry 6), then the command.
    h.setSession(sessionOf([5, 6, 7], { revision: 14, currentEntryId: uuid(6) }));
    command(h, { type: 'load', revision: 14, entryId: uuid(6) });
    await h.settle();
    expect(h.player.load).toHaveBeenCalledTimes(1); // once, not again for the command
    const load = h.player.load.mock.calls[0][0];
    expect(load.queueData.items.map((i: any) => i.media.customData.queueEntryId)).toEqual([uuid(6), uuid(7)]);
    expect(load.media.customData.auroraFollow).toBe(true);
    expect(h.markers.join('\n')).toContain('receiver-command-applied type=load ok=true');
  });

  it('jumps for a load command to an entry it has, and loads one beyond its window', async () => {
    const long = Array.from({ length: 20 }, (_, i) => i + 1);
    const h = harness({ caf: [1, 2] });
    h.setSession(sessionOf(long, { revision: 10 }));
    h.follower.start(h.handover);
    await h.settle();
    h.setSession(sessionOf(long, { revision: 15 }));
    command(h, { type: 'load', revision: 15, entryId: uuid(5) });
    await h.settle();
    expect(h.player.load).not.toHaveBeenCalled();
    expect(h.player.sendLocalMediaRequest.mock.calls.at(-1)[0].currentItemId).toBeDefined();

    command(h, { type: 'load', revision: 15, entryId: uuid(18) });
    await h.settle();
    expect(h.player.load).toHaveBeenCalledTimes(1);
    expect(h.player.load.mock.calls[0][0].queueData.items.map((i: any) => i.media.customData.queueEntryId))
      .toEqual([uuid(18), uuid(19), uuid(20)]);
  });
});

describe('reports and the credential', () => {
  it('reports what plays with its credential, every 10 s while playing', async () => {
    const h = harness();
    h.follower.start(h.handover);
    await jest.advanceTimersByTimeAsync(300);
    const [, init] = h.calls('POST', '/api/v1/playback-sessions/session-1/reports')[0];
    expect(init.headers.Authorization).toBe('Bearer receiver-token');
    expect(JSON.parse(init.body)).toEqual({ seq: 1, state: 'playing', queueEntryId: uuid(1), positionMs: 42_000 });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(h.calls('POST', '/api/v1/playback-sessions/session-1/reports')).toHaveLength(2);
  });

  // Twelve hours of fake time: paused, so reports come every 30 s, not 10.
  it('renews its own credential before it runs out, and plays out its window when it cannot', async () => {
    const h = harness();
    h.setPlayerState('PAUSED');
    h.follower.start({ ...h.handover, expiresAt: new Date(NOW + 20 * 60_000).toISOString() });
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.calls('POST', '/api/v1/playback-sessions/session-1/output/renew')).toHaveLength(1);
    await h.settle();
    expect(h.markers.join('\n')).toContain('credential=self-renewed');

    h.routes['POST /api/v1/playback-sessions/session-1/output/renew'] = () => ({ status: 401, body: { error: { code: 'RECEIVER_RENEWAL_EXPIRED' } } });
    await jest.advanceTimersByTimeAsync(12 * 3600_000 - 10 * 60_000);
    await h.settle();
    expect(h.onStopped).toHaveBeenCalledWith('expired');
    expect(h.player.stop).not.toHaveBeenCalled();
    expect(h.follower.following()).toBe(false);
  }, 30_000);

  it('takes a renewed credential from a sender for the same grant, and ignores an older grant', async () => {
    const h = harness();
    h.follower.start(h.handover);
    expect(h.follower.start({ ...h.handover, token: 'sender-refreshed' })).toBe(true);
    expect(h.follower.start({ ...h.handover, generation: 2 })).toBe(false);
    await jest.advanceTimersByTimeAsync(300);
    expect(h.calls('POST', '/api/v1/playback-sessions/session-1/reports').at(-1)![1].headers.Authorization).toBe('Bearer sender-refreshed');
  });
});

describe('when the session moves on', () => {
  it('stops playing when another device takes over', async () => {
    const h = harness();
    h.follower.start(h.handover);
    await h.settle();
    h.stream().emit('playbackSession.handedOff', { sessionId: 'session-1', outputId: 'laptop-5678', outputKind: 'browser', generation: 4 });
    expect(h.player.stop).toHaveBeenCalled();
    expect(h.onStopped).toHaveBeenCalledWith('replaced');
    expect(h.stream().closed).toBe(true);
  });

  it('plays on when a sender in its own Cast session claims, or a newer grant names this receiver', async () => {
    const same = harness();
    same.follower.start(same.handover);
    await same.settle();
    same.stream().emit('playbackSession.handedOff', { sessionId: 'session-1', outputId: 'phone-1', outputKind: 'cast', castSessionId: 'cast-77', generation: 4 });
    expect(same.player.stop).not.toHaveBeenCalled();
    expect(same.onStopped).toHaveBeenCalledWith('sender-claimed');

    const regrant = harness();
    regrant.follower.start(regrant.handover);
    await regrant.settle();
    regrant.routes['POST /api/v1/playback-sessions/session-1/reports'] = () => ({
      status: 409, body: { error: { code: 'OUTPUT_GRANT_REPLACED', details: { current: { output: { id: 'receiver:cast-77', generation: 4 } } } } },
    });
    await jest.advanceTimersByTimeAsync(10_300);
    await regrant.settle();
    expect(regrant.onStopped).toHaveBeenCalledWith('superseded');
    expect(regrant.player.stop).not.toHaveBeenCalled();
  });

  it('plays out what it has when the session is deleted or sync is turned off', async () => {
    const deleted = harness();
    deleted.follower.start(deleted.handover);
    await deleted.settle();
    deleted.stream().emit('playbackSession.deleted', { sessionId: 'session-1' });
    expect(deleted.onStopped).toHaveBeenCalledWith('deleted');
    expect(deleted.player.stop).not.toHaveBeenCalled();

    const off = harness();
    off.follower.start(off.handover);
    await off.settle();
    off.stream().emit('playbackSync.changed', { enabled: false });
    expect(off.onStopped).toHaveBeenCalledWith('sync-off');
  });

  it('lets a sender that loads a queue itself take charge again', async () => {
    const h = harness();
    h.follower.start(h.handover);
    h.follower.noteForeignLoad();
    expect(h.onStopped).toHaveBeenCalledWith('sender-load');
    expect(h.player.stop).not.toHaveBeenCalled();
  });

  it('polls the session every 5 s once its event stream has failed twice', async () => {
    const h = harness();
    h.follower.start(h.handover);
    await h.settle();
    h.stream().fail();
    await jest.advanceTimersByTimeAsync(5_000);
    h.stream().fail();
    await h.settle();
    const reads = h.calls('GET', '/api/v1/playback-sessions/session-1').length;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(h.calls('GET', '/api/v1/playback-sessions/session-1').length).toBeGreaterThanOrEqual(reads + 2);
    expect(h.markers.join('\n')).toContain('events=polling failures=2');
  });

  it('reports idle only once the receiver has stayed idle, not between tracks', async () => {
    const h = harness();
    h.follower.start(h.handover);
    await jest.advanceTimersByTimeAsync(300);
    h.setPlayerState('IDLE');
    h.follower.notePlayerChanged();
    await jest.advanceTimersByTimeAsync(300);
    const states = () => h.calls('POST', '/api/v1/playback-sessions/session-1/reports').map(([, init]) => JSON.parse(init.body).state);
    expect(states().at(-1)).not.toBe('idle');
    await jest.advanceTimersByTimeAsync(3_300);
    expect(states().at(-1)).toBe('idle');
  });
});
