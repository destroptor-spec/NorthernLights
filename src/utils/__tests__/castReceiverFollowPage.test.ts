import fs from 'fs';
import path from 'path';
import vm from 'vm';

/**
 * Phase 5, PR D: the actual receiver.html with receiver-follow.js. It says it
 * can follow a session only when the module loaded, takes a handover with an
 * ack, and gives up following when a sender loads a queue itself. Without the
 * module it behaves exactly as before.
 */
function startReceiver(withFollower: boolean, loadFirst = true) {
  const html = fs.readFileSync(path.join(process.cwd(), 'public/receiver.html'), 'utf8');
  const receiverDoc = new DOMParser().parseFromString(html, 'text/html');
  const inlineScript = receiverDoc.body.querySelector('script:not([src])')!;
  const script = inlineScript.textContent ?? '';
  inlineScript.remove();
  document.body.innerHTML = receiverDoc.body.innerHTML;
  const queue = {
    getItems: () => [], getCurrentItemIndex: () => -1, getCurrentItem: () => null,
    insertItems: jest.fn(), removeItems: jest.fn(), updateItems: jest.fn(), setRepeatMode: jest.fn(),
  };
  const player = {
    getQueueManager: () => queue, getMediaInformation: () => null,
    getPlayerState: () => 'PLAYING', getCurrentTimeSec: () => 42, getDurationSec: () => 180,
    setMessageInterceptor: jest.fn(), setMediaElement: jest.fn(), addEventListener: jest.fn(),
    play: jest.fn(), pause: jest.fn(), seek: jest.fn(), load: jest.fn(), stop: jest.fn(), sendLocalMediaRequest: jest.fn(),
  };
  const context = {
    getPlayerManager: () => player, addEventListener: jest.fn(),
    addCustomMessageListener: jest.fn(), sendCustomMessage: jest.fn(), start: jest.fn(), stop: jest.fn(),
  };
  const cast = { framework: {
    CastReceiverContext: { getInstance: () => context },
    PlaybackConfig: class {}, CastReceiverOptions: class {},
    system: { EventType: { READY: 'READY', ERROR: 'ERROR' }, MessageType: { JSON: 'JSON' } },
    events: { EventType: { ERROR: 'ERROR', BUFFERING: 'BUFFERING', SEEKING: 'SEEKING', MEDIA_STATUS: 'MEDIA_STATUS' } },
    messages: { MessageType: { LOAD: 'LOAD' }, StreamType: { BUFFERED: 'BUFFERED' },
      HlsSegmentFormat: { TS: 'TS' }, Command: { ALL_BASIC_MEDIA: 1, QUEUE_NEXT: 2, QUEUE_PREV: 4 },
      RepeatMode: { REPEAT_OFF: 'REPEAT_OFF', REPEAT_SINGLE: 'REPEAT_SINGLE' } },
  } };
  const streams: string[] = [];
  class FakeEventSource {
    readyState = 0;
    onopen?: () => void;
    onerror?: () => void;
    constructor(public url: string) { streams.push(url); }
    addEventListener() { /* events are covered in receiverFollow.test.ts */ }
    close() { this.readyState = 2; }
  }
  const session = { id: 'session-1', revision: 3, currentEntryId: null, repeatMode: 'none', queue: [],
    output: { id: 'receiver:cast-77', generation: 2, castSessionId: 'cast-77' } };
  const fetch = jest.fn((url: string, _init?: unknown) => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve(url.startsWith('/api/v1/playback-sessions/') ? { data: session } : {}),
  }));
  const sandbox: Record<string, unknown> = { window, document, cast, URL, console, performance, fetch, EventSource: FakeEventSource,
    navigator: { userAgent: 'CrKey/1.56' }, setInterval: jest.fn(), setTimeout: jest.fn(), clearTimeout: jest.fn() };
  vm.createContext(sandbox);
  delete (window as unknown as Record<string, unknown>).AuroraSessionFollow;
  if (withFollower) {
    vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'public/receiver-follow.js'), 'utf8'), sandbox);
    // In a browser the module's `this` is window.
    (window as unknown as Record<string, unknown>).AuroraSessionFollow = sandbox.AuroraSessionFollow;
  }
  vm.runInContext(script, sandbox);
  if (!context.start.mock.calls.length) throw new Error(document.getElementById('debug-panel')?.textContent || 'Receiver did not start');
  const [namespace, receive] = context.addCustomMessageListener.mock.calls[0];
  const load = player.setMessageInterceptor.mock.calls.find(([type]) => type === 'LOAD')![1];
  const firstLoad = () => load({ media: { contentId: 'https://music.example.test/api/stream/track/playlist.m3u8', customData: { token: 'media-token' }, metadata: { title: 'Track' } } });
  if (loadFirst) firstLoad();
  const status = () => {
    context.sendCustomMessage.mockClear();
    receive({ senderId: 'sender', data: { type: 'aurora.diagnostics', enabled: false, requestId: 99 } });
    return context.sendCustomMessage.mock.calls.map(([, , payload]) => payload).find((payload) => payload.type === 'aurora.status');
  };
  const caps = () => status().caps as string[];
  const loggedLines = () => fetch.mock.calls
    .filter(([url]) => String(url).startsWith('/api/cast/log'))
    .map(([, init]) => JSON.parse((init as unknown as { body: string }).body) as { message: string; detail: string });
  return { namespace, receive, context, player, fetch, streams, load, firstLoad, caps, status, session, loggedLines };
}

const handover = {
  type: 'aurora.session.follow', requestId: 5, sessionId: 'session-1', outputId: 'receiver:cast-77', generation: 2,
  token: 'receiver-secret', expiresAt: '2026-10-17T08:00:00.000Z', renewableUntil: '2026-10-17T20:00:00.000Z', quality: '128k',
};

afterAll(() => { delete (window as unknown as Record<string, unknown>).AuroraSessionFollow; });

test('advertises session-follow and takes a handover, with an ack', async () => {
  const r = startReceiver(true);
  expect(r.caps()).toEqual(['control', 'queue-insert', 'diagnostics', 'session-follow']);
  r.context.sendCustomMessage.mockClear();
  r.receive({ senderId: 'sender', data: handover });
  expect(r.context.sendCustomMessage).toHaveBeenCalledWith(r.namespace, 'sender', { type: 'aurora.session.follow.ack', requestId: 5, ok: true });
  expect(r.streams).toEqual(['/api/v1/events?token=receiver-secret']);
  await Promise.resolve();
  expect(r.fetch.mock.calls.some(([url, init]) => url === '/api/v1/playback-sessions/session-1'
    && (init as unknown as { headers: Record<string, string> }).headers.Authorization === 'Bearer receiver-secret')).toBe(true);
  expect(JSON.stringify(r.loggedLines())).not.toContain('receiver-secret');
});

test('neither advertises following nor takes a handover before the first LOAD', () => {
  // Prod 2026-10-16 19:27: handed over before anything was loaded, it had no
  // media token, the sender's own first LOAD was blocked, and nothing played.
  const r = startReceiver(true, false);
  expect(r.caps()).toEqual(['control', 'queue-insert', 'diagnostics']);
  r.context.sendCustomMessage.mockClear();
  r.receive({ senderId: 'sender', data: handover });
  expect(r.context.sendCustomMessage).toHaveBeenCalledWith(r.namespace, 'sender', { type: 'aurora.session.follow.ack', requestId: 5, ok: false });
  expect(r.streams).toEqual([]);

  r.firstLoad();
  expect(r.caps()).toContain('session-follow');
});

test("keeps following when CAF loads the next queue item itself", () => {
  // Prod 2026-10-16 19:42:02 and 19:47:18: CAF moving to the next item runs
  // through the LOAD interceptor; taking that for a sender's LOAD ended
  // following at every track change.
  const r = startReceiver(true);
  r.receive({ senderId: 'sender', data: handover });
  r.load({ media: { contentId: 'https://music.example.test/api/stream/next/playlist.m3u8', customData: { token: 'media-token', queueEntryId: 'e2' }, metadata: { title: 'Next' } } });
  expect(r.loggedLines().some((line) => line.message.includes('receiver-follow-stopped'))).toBe(false);
});

test('refuses a handover, and does not advertise following, without the module', () => {
  const r = startReceiver(false);
  expect(r.caps()).toEqual(['control', 'queue-insert', 'diagnostics']);
  r.context.sendCustomMessage.mockClear();
  r.receive({ senderId: 'sender', data: handover });
  expect(r.context.sendCustomMessage).toHaveBeenCalledWith(r.namespace, 'sender', { type: 'aurora.session.follow.ack', requestId: 5, ok: false });
  expect(r.streams).toEqual([]);
});

test('says in its status whether it follows a session, and says so at once when following ends', async () => {
  const r = startReceiver(true);
  expect(r.status().following).toBe(false);
  r.receive({ senderId: 'sender', data: handover });
  expect(r.status().following).toBe(true);

  // The session moved on to a newer grant: following ends here.
  r.session.output = { ...r.session.output, generation: 3 };
  r.context.sendCustomMessage.mockClear();
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  const sent = r.context.sendCustomMessage.mock.calls.map(([, to, payload]) => ({ to, payload }));
  const stopped = sent.find(({ payload }) => payload.type === 'aurora.status' && payload.reason === 'follow-stopped');
  expect(stopped?.payload.following).toBe(false);
  // Every sender gets this status: it carries no session, grant or credential.
  expect(stopped?.to).toBeUndefined();
  expect(JSON.stringify(stopped?.payload)).not.toMatch(/receiver-secret|session-1|receiver:cast-77/);
});

describe('the Cast media token (6a-2)', () => {
  const manifestUrl = (r: ReturnType<typeof startReceiver>) => {
    const config = r.context.start.mock.calls[0][0].playbackConfig;
    const request = { url: 'https://music.example.test/api/stream/t/playlist.m3u8?token=older', headers: {} as Record<string, string> };
    config.manifestRequestHandler(request);
    return { url: request.url, auth: request.headers.Authorization };
  };

  test('every request carries the newest token, also over an older one in the URL', () => {
    const r = startReceiver(true);
    expect(manifestUrl(r)).toEqual({ url: expect.stringContaining('token=media-token'), auth: 'Bearer media-token' });
  });

  test("takes a connected sender's renewed token while it follows no session", () => {
    const r = startReceiver(true);
    r.receive({ senderId: 'sender', data: { type: 'aurora.media-token', token: 'cast-renewed' } });
    expect(manifestUrl(r).url).toContain('token=cast-renewed');
    expect(r.loggedLines().some((line) => line.message.includes('receiver-media-token') && line.detail.includes('result=taken'))).toBe(true);
    expect(JSON.stringify(r.loggedLines())).not.toContain('cast-renewed');
  });

  test('while it follows a session, only the handover and its own renewals set the token', () => {
    const r = startReceiver(true);
    r.receive({ senderId: 'owner', data: { ...handover, mediaToken: 'cast-from-owner' } });
    expect(manifestUrl(r).url).toContain('token=cast-from-owner');
    r.receive({ senderId: 'guest', data: { type: 'aurora.media-token', token: 'guest-token' } });
    expect(manifestUrl(r).url).toContain('token=cast-from-owner');
  });
});

describe('nothing the session broadcasts carries the media token (6a-3)', () => {
  const loadRequest = (extra: Record<string, unknown> = {}) => ({
    media: {
      contentId: 'https://music.example.test/api/stream/t1/playlist.m3u8?quality=128k&token=sender-token',
      contentType: 'application/vnd.apple.mpegurl',
      customData: { queueEntryId: 'e1', token: 'sender-token', codec: 'aac' },
      metadata: { title: 'One' },
    },
    queueData: { items: [
      { media: { contentId: 'https://music.example.test/api/stream/t2/playlist.m3u8?quality=128k&token=sender-token', contentType: 'application/vnd.apple.mpegurl', customData: { queueEntryId: 'e2' } } },
    ] },
    ...extra,
  });
  const manifestToken = (r: ReturnType<typeof startReceiver>) => {
    const request = { url: 'https://music.example.test/api/stream/t1/playlist.m3u8', headers: {} as Record<string, string> };
    r.context.start.mock.calls[0][0].playbackConfig.manifestRequestHandler(request);
    return new URL(request.url).searchParams.get('token');
  };

  test("takes the token from the LOAD request's own customData, and keeps it out of the media", () => {
    const r = startReceiver(true, false);
    const out = r.load(loadRequest({ customData: { token: 'request-token' } }));
    expect(JSON.stringify(out.media)).not.toContain('token');
    expect(JSON.stringify(out.queueData)).not.toContain('token');
    expect(out.customData).toEqual({});
    expect(manifestToken(r)).toBe('request-token');
  });

  test("an older sender's token in the media is taken, then scrubbed from it", () => {
    const r = startReceiver(true, false);
    const out = r.load(loadRequest());
    expect(out.media.customData).toEqual({ queueEntryId: 'e1', codec: 'aac' });
    expect(out.media.contentId).not.toContain('token=');
    expect(out.queueData.items[0].media.contentId).not.toContain('token=');
    expect(manifestToken(r)).toBe('sender-token');
  });

  test('a progressive load keeps its token in the URL: the platform player fetches it directly', () => {
    const r = startReceiver(true, false);
    const out = r.load({ media: { contentId: 'https://music.example.test/api/stream/t1/raw', contentType: 'audio/flac', customData: {} }, customData: { token: 'request-token' } });
    expect(out.media.contentId).toContain('token=request-token');
  });
});
