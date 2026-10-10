import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { AURORA_STATUS_NAMESPACE } from '../castNamespace';

test('the actual receiver applies and acknowledges diagnostics without changing playback, including auto-advance', () => {
  const html = fs.readFileSync(path.join(process.cwd(), 'public/receiver.html'), 'utf8');
  document.body.innerHTML = html.match(/<body>([\s\S]*?)<script>/)![1];
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  const queue = { getItems: () => [], getCurrentItemIndex: () => -1, getCurrentItem: () => null };
  const player = {
    getQueueManager: () => queue, getMediaInformation: () => null,
    getPlayerState: () => 'PLAYING', getCurrentTimeSec: () => 42, getDurationSec: () => 180,
    setMessageInterceptor: jest.fn(), setMediaElement: jest.fn(), addEventListener: jest.fn(),
    play: jest.fn(), pause: jest.fn(), seek: jest.fn(),
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
  const sandbox = { window, document, cast, URL, console, performance, fetch: jest.fn().mockResolvedValue({ ok: true }),
    setInterval: jest.fn(), setTimeout: jest.fn() };
  vm.runInNewContext(script, sandbox);
  if (!context.start.mock.calls.length) throw new Error(document.getElementById('debug-panel')?.textContent || 'Receiver did not start');
  expect(context.start).toHaveBeenCalledTimes(1);
  const [namespace, receive] = context.addCustomMessageListener.mock.calls[0];
  expect(namespace).toBe(AURORA_STATUS_NAMESPACE);
  const load = player.setMessageInterceptor.mock.calls.find(([type]) => type === 'LOAD')![1];
  const loadItem = (enabled: boolean) => load({ media: {
    contentId: 'https://music.example.test/api/stream/track/playlist.m3u8',
    customData: { token: 'test-token', diagnosticsVerbose: enabled }, metadata: { title: 'Track' },
  } });
  loadItem(false);
  context.sendCustomMessage.mockClear();
  receive({ senderId: 'sender', data: { type: 'aurora.diagnostics', enabled: true, requestId: 1 } });
  expect(context.sendCustomMessage).toHaveBeenCalledWith(namespace, 'sender', {
    type: 'aurora.diagnostics.ack', requestId: 1, enabled: true,
  });
  loadItem(false); // A queued item with the old preference must not disable diagnostics.
  expect(document.body.classList.contains('debug-access-visible')).toBe(true);
  receive({ senderId: 'sender', data: { type: 'aurora.diagnostics', enabled: false, requestId: 2 } });
  loadItem(true);
  expect(document.body.classList.contains('debug-access-visible')).toBe(false);
  const calls = context.sendCustomMessage.mock.calls.length;
  receive({ senderId: 'sender', data: { type: 'aurora.diagnostics', enabled: 'true' } });
  expect(context.sendCustomMessage).toHaveBeenCalledTimes(calls);
  expect(player.play).not.toHaveBeenCalled();
  expect(player.pause).not.toHaveBeenCalled();
  expect(player.seek).not.toHaveBeenCalled();
  expect(context.stop).not.toHaveBeenCalled();
});
