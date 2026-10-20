import fs from 'fs';
import path from 'path';
import vm from 'vm';

/**
 * A TV screensaver hides the receiver page and Chrome throttles its timers to
 * once a minute, which starves the stream (Stue TV, 2026-10-20). The receiver
 * logs what the platform reports and when its timers slow down; diagnostics
 * only, nothing about playback changes.
 */
function startReceiver(options: { castStates?: boolean } = {}) {
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
    getPlayerState: () => 'PLAYING', getCurrentTimeSec: () => 42, getDurationSec: () => 180,
    setMessageInterceptor: jest.fn(), setMediaElement: jest.fn(), addEventListener: jest.fn(),
    play: jest.fn(), pause: jest.fn(), seek: jest.fn(), load: jest.fn(), stop: jest.fn(),
  };
  const context: Record<string, unknown> & { addEventListener: jest.Mock; start: jest.Mock } = {
    getPlayerManager: () => player, addEventListener: jest.fn(),
    addCustomMessageListener: jest.fn(), sendCustomMessage: jest.fn(), start: jest.fn(), stop: jest.fn(),
  };
  if (options.castStates) {
    context.getVisibilityState = () => 'NOT_VISIBLE';
    context.getStandbyState = () => 'NOT_STANDBY';
  }
  const cast = { framework: {
    CastReceiverContext: { getInstance: () => context },
    PlaybackConfig: class {}, CastReceiverOptions: class {},
    system: {
      EventType: { READY: 'READY', ERROR: 'ERROR', VISIBILITY_CHANGED: 'VISIBILITY_CHANGED', STANDBY_CHANGED: 'STANDBY_CHANGED' },
      MessageType: { JSON: 'JSON' },
    },
    events: { EventType: { ERROR: 'ERROR', BUFFERING: 'BUFFERING', SEEKING: 'SEEKING', MEDIA_STATUS: 'MEDIA_STATUS' } },
    messages: { MessageType: { LOAD: 'LOAD' }, StreamType: { BUFFERED: 'BUFFERED' },
      HlsSegmentFormat: { TS: 'TS' }, Command: { ALL_BASIC_MEDIA: 1, QUEUE_NEXT: 2, QUEUE_PREV: 4 } },
  } };
  let now = 1_000_000;
  class FakeDate extends Date {
    static now() { return now; }
  }
  const intervals: Array<{ run: () => void; ms: number }> = [];
  const fetch = jest.fn(() => Promise.resolve({ ok: true }));
  const sandbox = { window, document, cast, URL, console, performance, fetch, Date: FakeDate,
    navigator: { userAgent: 'CrKey/1.56' },
    setInterval: (run: () => void, ms: number) => { intervals.push({ run, ms }); return intervals.length; },
    setTimeout: jest.fn(), clearTimeout: jest.fn() };
  vm.runInNewContext(script, sandbox);
  if (!context.start.mock.calls.length) throw new Error(document.getElementById('debug-panel')?.textContent || 'Receiver did not start');
  // A media token arrives with the first LOAD; logs need it.
  const load = player.setMessageInterceptor.mock.calls.find(([type]) => type === 'LOAD')![1];
  load({ media: { contentId: 'https://music.example.test/api/stream/track/playlist.m3u8', customData: { token: 'media-token' }, metadata: { title: 'Track' } } });
  const systemListener = (type: string) => context.addEventListener.mock.calls.find(([t]) => t === type)![1] as (event: unknown) => void;
  // Advance the clock and fire every timer once, the way a throttled page does.
  const tick = (ms: number) => { now += ms; intervals.forEach((interval) => interval.run()); };
  return { fetch, systemListener, tick };
}

const markers = (fetch: jest.Mock, name: string) => fetch.mock.calls
  .filter(([url]) => String(url).startsWith('/api/cast/log'))
  .map(([, init]) => JSON.parse((init as { body: string }).body) as { message: string; detail: string })
  .filter((line) => line.message.endsWith(name));

test('logs the platform visibility and standby events', () => {
  const { fetch, systemListener } = startReceiver({ castStates: true });
  systemListener('VISIBILITY_CHANGED')({ isVisible: false });
  systemListener('STANDBY_CHANGED')({ isStandby: true });
  expect(markers(fetch, 'receiver-visibility').map((line) => line.detail)).toEqual([
    'event=visibility isVisible=false page=visible cast=NOT_VISIBLE standby=NOT_STANDBY',
    'event=standby isStandby=true page=visible cast=NOT_VISIBLE standby=NOT_STANDBY',
  ]);
});

test('logs page visibility changes, also where CAF has no state getters', () => {
  const { fetch } = startReceiver();
  document.dispatchEvent(new Event('visibilitychange'));
  expect(markers(fetch, 'receiver-visibility').map((line) => line.detail)).toEqual(['event=page page=visible']);
});

test('logs once when the timers slow to a minute and once when they recover', () => {
  const { fetch, tick } = startReceiver();
  tick(5_000);
  expect(markers(fetch, 'receiver-timers-throttled')).toHaveLength(0);

  tick(60_000);
  tick(60_000);
  expect(markers(fetch, 'receiver-timers-throttled').map((line) => line.detail)).toEqual([
    expect.stringMatching(/^gapMs=60000 state=\S+ page=visible$/),
  ]);

  tick(5_000);
  tick(5_000);
  expect(markers(fetch, 'receiver-timers-recovered').map((line) => line.detail)).toEqual([
    expect.stringMatching(/^gapMs=5000 state=\S+ page=visible$/),
  ]);
});
