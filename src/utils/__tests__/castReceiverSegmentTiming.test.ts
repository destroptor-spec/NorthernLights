import fs from 'fs';
import path from 'path';
import vm from 'vm';

/**
 * After a short outage on the route to the server (prod 2026-11-02, A9) the
 * receiver stalled at segment boundaries for an hour while the server had
 * every segment ready. The receiver now logs segments that take long from
 * request to data; diagnostics only, nothing about playback changes.
 */
function startReceiver() {
  const html = fs.readFileSync(path.join(process.cwd(), 'public/receiver.html'), 'utf8');
  const receiverDoc = new DOMParser().parseFromString(html, 'text/html');
  const inlineScript = receiverDoc.body.querySelector('script:not([src])')!;
  const script = inlineScript.textContent ?? '';
  inlineScript.remove();
  document.body.innerHTML = receiverDoc.body.innerHTML;
  const queue = {
    getItems: () => [], getCurrentItemIndex: () => -1, getCurrentItem: () => null,
    insertItems: jest.fn(), removeItems: jest.fn(), updateItems: jest.fn(),
  };
  const player = {
    getQueueManager: () => queue, getMediaInformation: () => null,
    getPlayerState: () => 'PLAYING', getCurrentTimeSec: () => 20, getDurationSec: () => 180,
    setMessageInterceptor: jest.fn(), setMediaElement: jest.fn(), addEventListener: jest.fn(), setPlaybackConfig: jest.fn(),
    play: jest.fn(), pause: jest.fn(), seek: jest.fn(), load: jest.fn(), stop: jest.fn(),
  };
  const context = {
    getPlayerManager: () => player, addEventListener: jest.fn(), getDeviceCapabilities: () => null,
    addCustomMessageListener: jest.fn(), sendCustomMessage: jest.fn(), start: jest.fn(), stop: jest.fn(),
    canDisplayType: () => false,
  };
  const cast = { framework: {
    CastReceiverContext: { getInstance: () => context },
    PlaybackConfig: class {}, CastReceiverOptions: class {},
    system: { EventType: { READY: 'READY', ERROR: 'ERROR' }, MessageType: { JSON: 'JSON' } },
    events: { EventType: { ERROR: 'ERROR', BUFFERING: 'BUFFERING', SEEKING: 'SEEKING', MEDIA_STATUS: 'MEDIA_STATUS' } },
    messages: { MessageType: { LOAD: 'LOAD' }, StreamType: { BUFFERED: 'BUFFERED' },
      HlsSegmentFormat: { TS: 'TS' }, Command: { ALL_BASIC_MEDIA: 1, QUEUE_NEXT: 2, QUEUE_PREV: 4 } },
  } };
  let now = 1_000_000;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const fetch = jest.fn(() => Promise.resolve({ ok: true }));
  const sandbox = { window, document, cast, URL, console, performance, fetch, Date: FakeDate,
    navigator: { userAgent: 'CrKey/1.56' }, setInterval: jest.fn(), setTimeout: jest.fn(), clearTimeout: jest.fn() };
  vm.runInNewContext(script, sandbox);
  if (!context.start.mock.calls.length) throw new Error(document.getElementById('debug-panel')?.textContent || 'Receiver did not start');
  // A media token arrives with the first LOAD; logs need it.
  const load = player.setMessageInterceptor.mock.calls.find(([type]) => type === 'LOAD')![1];
  load({ media: { contentId: 'https://music.example.test/api/stream/track/playlist.m3u8', customData: { token: 'media-token' }, metadata: { title: 'Track' } } });
  const config = context.start.mock.calls[0][0].playbackConfig;
  const segmentUrl = (name: string) => `https://music.example.test/api/stream/track/${name}?quality=128k&codec=aac`;
  const request = (name: string) => {
    const info = { url: segmentUrl(name), headers: {} as Record<string, string> };
    config.segmentRequestHandler(info);
    return info;
  };
  const receive = (bytes: number) => config.segmentHandler(new Uint8Array(bytes));
  const advance = (ms: number) => { now += ms; };
  return { fetch, request, receive, advance };
}

const slowLines = (fetch: jest.Mock) => fetch.mock.calls
  .filter(([url]) => String(url).startsWith('/api/cast/log'))
  .map(([, init]) => JSON.parse((init as { body: string }).body) as { message: string; detail: string })
  .filter((line) => line.message.endsWith('receiver-segment-slow'))
  .map((line) => line.detail);

test('a fast segment logs nothing and the data passes through unchanged', () => {
  const { fetch, request, receive, advance } = startReceiver();
  const info = request('segment000.ts');
  expect(info.headers.Authorization).toBe('Bearer media-token');
  advance(400);
  const data = receive(1000);
  expect(data).toBeInstanceOf(Uint8Array);
  expect(data.byteLength).toBe(1000);
  expect(slowLines(fetch)).toEqual([]);
});

test('a slow segment is logged with its time, size and attempts', () => {
  const { fetch, request, receive, advance } = startReceiver();
  request('segment001.ts');
  advance(2000);
  request('segment001.ts'); // Shaka retries the same segment
  advance(2500);
  receive(160_000);
  expect(slowLines(fetch)).toEqual([
    'segment=segment001.ts ms=4500 bytes=160000 attempts=2 suppressed=0 state=LOADING time=20',
  ]);
});

test('logs at most one slow segment per 10 s and counts the rest', () => {
  const { fetch, request, receive, advance } = startReceiver();
  for (let i = 0; i < 3; i += 1) {
    request(`segment00${i}.ts`);
    advance(3500);
    receive(100);
  }
  expect(slowLines(fetch)).toHaveLength(1);

  advance(10_000);
  request('segment003.ts');
  advance(3000);
  receive(100);
  expect(slowLines(fetch)[1]).toMatch(/^segment=segment003\.ts ms=3000 .* suppressed=2 /);
});

test('a request that never answers does not shift later timings', () => {
  const { fetch, request, receive, advance } = startReceiver();
  request('segment004.ts'); // failed for good, no data ever arrives
  advance(61_000);
  request('segment000.ts'); // the next track starts
  advance(500);
  receive(100);
  expect(slowLines(fetch)).toEqual([]);
});
