import fs from 'fs';
import path from 'path';
import vm from 'vm';

/**
 * Phase 5, PR D: the actual receiver.html with receiver-follow.js. It says it
 * can follow a session only when the module loaded, takes a handover with an
 * ack, and gives up following when a sender loads a queue itself. Without the
 * module it behaves exactly as before.
 */
function startReceiver(withFollower: boolean) {
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
  load({ media: { contentId: 'https://music.example.test/api/stream/track/playlist.m3u8', customData: { token: 'media-token' }, metadata: { title: 'Track' } } });
  const caps = () => {
    context.sendCustomMessage.mockClear();
    receive({ senderId: 'sender', data: { type: 'aurora.diagnostics', enabled: false, requestId: 99 } });
    const status = context.sendCustomMessage.mock.calls.map(([, , payload]) => payload).find((payload) => payload.type === 'aurora.status');
    return status.caps as string[];
  };
  const loggedLines = () => fetch.mock.calls
    .filter(([url]) => String(url).startsWith('/api/cast/log'))
    .map(([, init]) => JSON.parse((init as unknown as { body: string }).body) as { message: string; detail: string });
  return { namespace, receive, context, player, fetch, streams, load, caps, loggedLines };
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

test('lets a sender that loads a queue itself take charge again', () => {
  const r = startReceiver(true);
  r.receive({ senderId: 'sender', data: handover });
  r.load({ media: { contentId: 'https://music.example.test/api/stream/other/playlist.m3u8', customData: { token: 'media-token' }, metadata: { title: 'Other' } } });
  expect(r.loggedLines().some((line) => line.message.includes('receiver-follow-stopped') && line.detail.includes('reason=sender-load'))).toBe(true);
});

test('refuses a handover, and does not advertise following, without the module', () => {
  const r = startReceiver(false);
  expect(r.caps()).toEqual(['control', 'queue-insert', 'diagnostics']);
  r.context.sendCustomMessage.mockClear();
  r.receive({ senderId: 'sender', data: handover });
  expect(r.context.sendCustomMessage).toHaveBeenCalledWith(r.namespace, 'sender', { type: 'aurora.session.follow.ack', requestId: 5, ok: false });
  expect(r.streams).toEqual([]);
});
