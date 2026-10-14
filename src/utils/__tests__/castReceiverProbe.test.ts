import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { AURORA_STATUS_NAMESPACE } from '../castNamespace';

/**
 * Phase 5 probe (docs/cast-receiver-output.md): the actual receiver runs it
 * only when a sender asks, never edits the queue or playback, and logs
 * receiver-probe markers without the token.
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
    getPlayerState: () => 'PLAYING', getCurrentTimeSec: () => 42, getDurationSec: () => 180,
    setMessageInterceptor: jest.fn(), setMediaElement: jest.fn(), addEventListener: jest.fn(),
    play: jest.fn(), pause: jest.fn(), seek: jest.fn(), load: jest.fn(), stop: jest.fn(),
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
      HlsSegmentFormat: { TS: 'TS' }, Command: { ALL_BASIC_MEDIA: 1, QUEUE_NEXT: 2, QUEUE_PREV: 4 } },
  } };
  const streams: Array<{ url: string; onopen?: () => void; onerror?: () => void; readyState: number; close: jest.Mock }> = [];
  class FakeEventSource {
    url: string;
    readyState = 0;
    onopen?: () => void;
    onerror?: () => void;
    close = jest.fn();
    constructor(url: string) { this.url = url; streams.push(this); }
    addEventListener() { /* counted, not needed here */ }
  }
  let resolveEvents: (value: unknown) => void = () => undefined;
  const fetch = jest.fn((url: string) => {
    if (url.startsWith('/api/v1/events')) return new Promise((resolve) => { resolveEvents = resolve; });
    return Promise.resolve({ ok: true });
  });
  const sandbox = { window, document, cast, URL, console, performance, fetch, EventSource: FakeEventSource,
    navigator: { userAgent: 'CrKey/1.56' }, setInterval: jest.fn(), setTimeout: jest.fn(), clearTimeout: jest.fn() };
  vm.runInNewContext(script, sandbox);
  if (!context.start.mock.calls.length) throw new Error(document.getElementById('debug-panel')?.textContent || 'Receiver did not start');
  const [namespace, receive] = context.addCustomMessageListener.mock.calls[0];
  const load = player.setMessageInterceptor.mock.calls.find(([type]) => type === 'LOAD')![1];
  // A media token arrives with the first LOAD; logs need it.
  load({ media: { contentId: 'https://music.example.test/api/stream/track/playlist.m3u8', customData: { token: 'media-token' }, metadata: { title: 'Track' } } });
  context.sendCustomMessage.mockClear();
  return { namespace, receive, context, player, queue, fetch, streams, resolveEvents: (value: unknown) => resolveEvents(value) };
}

const loggedProbeLines = (fetch: jest.Mock) => fetch.mock.calls
  .filter(([url]) => String(url).startsWith('/api/cast/log'))
  .map(([, init]) => JSON.parse((init as { body: string }).body) as { message: string; detail: string })
  .filter((line) => line.message.includes('receiver-probe'));

test('runs the probe on request, once at a time, without touching the queue or playback', async () => {
  const { namespace, receive, context, player, queue, fetch, streams, resolveEvents } = startReceiver();
  receive({ senderId: 'sender', data: { type: 'aurora.probe', requestId: 7, sseToken: 'sse-secret' } });
  expect(context.sendCustomMessage).toHaveBeenCalledWith(namespace, 'sender', { type: 'aurora.probe.ack', requestId: 7, accepted: true });

  receive({ senderId: 'sender', data: { type: 'aurora.probe', requestId: 8, sseToken: 'sse-secret' } });
  expect(context.sendCustomMessage).toHaveBeenLastCalledWith(namespace, 'sender', { type: 'aurora.probe.ack', requestId: 8, accepted: false });

  expect(fetch).toHaveBeenCalledWith('/api/v1/events?token=sse-secret&clientId=receiver-probe', expect.anything());
  resolveEvents({ ok: true, status: 200, body: { getReader: () => ({ read: () => Promise.resolve({ value: new Uint8Array(12) }) }) } });
  for (let i = 0; i < 5; i += 1) await Promise.resolve();

  // The fetch is done, so the event stream starts.
  expect(streams).toHaveLength(1);
  expect(streams[0].url).toBe('/api/v1/events?token=sse-secret&clientId=receiver-probe');
  streams[0].onopen?.();

  const lines = loggedProbeLines(fetch);
  const details = lines.map((line) => line.detail).join('\n');
  expect(details).toContain('env eventSource=true fetch=true');
  expect(details).toContain('queueApis=getItems,getCurrentItem,getCurrentItemIndex,insertItems,removeItems,updateItems');
  expect(details).toMatch(/fetch result=ok status=200 firstChunkBytes=12/);
  expect(details).toMatch(/eventsource result=open/);
  expect(JSON.stringify(fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/cast/log')))).not.toContain('sse-secret');

  for (const fn of [queue.insertItems, queue.removeItems, queue.updateItems, player.play, player.pause, player.seek, player.load, player.stop]) {
    expect(fn).not.toHaveBeenCalled();
  }
});

test('refuses a probe without a token', () => {
  const { namespace, receive, context, fetch } = startReceiver();
  receive({ senderId: 'sender', data: { type: 'aurora.probe', requestId: 3 } });
  expect(context.sendCustomMessage).toHaveBeenCalledWith(namespace, 'sender', { type: 'aurora.probe.ack', requestId: 3, accepted: false });
  expect(fetch.mock.calls.some(([url]) => String(url).startsWith('/api/v1/events'))).toBe(false);
});
