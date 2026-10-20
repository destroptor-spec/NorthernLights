import fs from 'fs';
import path from 'path';
import vm from 'vm';

/**
 * A screensaver hides the receiver page on a device with a screen; Chrome then
 * wakes its timers once a minute and Shaka's default few-segment buffer runs
 * dry (Stue TV, 2026-10-20). With a screen the receiver buffers about a song
 * ahead; audio-only devices keep the defaults.
 */
function startReceiver(capabilities: Record<string, unknown> | null) {
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
    getPlayerState: () => 'IDLE', getCurrentTimeSec: () => 0, getDurationSec: () => 180,
    setMessageInterceptor: jest.fn(), setMediaElement: jest.fn(), addEventListener: jest.fn(), setPlaybackConfig: jest.fn(),
    play: jest.fn(), pause: jest.fn(), seek: jest.fn(), load: jest.fn(), stop: jest.fn(),
  };
  const context = {
    getPlayerManager: () => player, addEventListener: jest.fn(), getDeviceCapabilities: () => capabilities,
    addCustomMessageListener: jest.fn(), sendCustomMessage: jest.fn(), start: jest.fn(), stop: jest.fn(),
    canDisplayType: () => false,
  };
  const cast = { framework: {
    CastReceiverContext: { getInstance: () => context },
    PlaybackConfig: class {}, CastReceiverOptions: class {},
    system: {
      EventType: { READY: 'READY', ERROR: 'ERROR' }, MessageType: { JSON: 'JSON' },
      DeviceCapabilities: { DISPLAY_SUPPORTED: 'display_supported' },
    },
    events: { EventType: { ERROR: 'ERROR', BUFFERING: 'BUFFERING', SEEKING: 'SEEKING', MEDIA_STATUS: 'MEDIA_STATUS' } },
    messages: { MessageType: { LOAD: 'LOAD' }, StreamType: { BUFFERED: 'BUFFERED' },
      HlsSegmentFormat: { TS: 'TS' }, Command: { ALL_BASIC_MEDIA: 1, QUEUE_NEXT: 2, QUEUE_PREV: 4 } },
  } };
  const fetch = jest.fn(() => Promise.resolve({ ok: true }));
  const sandbox = { window, document, cast, URL, console, performance, fetch,
    navigator: { userAgent: 'CrKey/1.56' }, setInterval: jest.fn(), setTimeout: jest.fn(), clearTimeout: jest.fn() };
  vm.runInNewContext(script, sandbox);
  if (!context.start.mock.calls.length) throw new Error(document.getElementById('debug-panel')?.textContent || 'Receiver did not start');
  const ready = context.addEventListener.mock.calls.find(([type]) => type === 'READY')![1] as () => void;
  const load = player.setMessageInterceptor.mock.calls.find(([type]) => type === 'LOAD')![1] as (request: unknown) => unknown;
  const loadTrack = () => load({ media: { contentId: 'https://music.example.test/api/stream/track/playlist.m3u8', customData: { token: 'media-token' }, metadata: { title: 'Track' } } });
  return { ready, loadTrack, player, fetch };
}

const profileLines = (fetch: jest.Mock) => fetch.mock.calls
  .filter(([url]) => String(url).startsWith('/api/cast/log'))
  .map(([, init]) => JSON.parse((init as { body: string }).body) as { message: string; detail: string })
  .filter((line) => line.message.endsWith('receiver-buffer-profile'))
  .map((line) => line.detail);

test('a device with a screen buffers about a song ahead and logs it once', () => {
  const { ready, loadTrack, player, fetch } = startReceiver({ display_supported: true });
  ready();
  expect(player.setPlaybackConfig).toHaveBeenCalledTimes(1);
  const config = player.setPlaybackConfig.mock.calls[0][0];
  expect(config.shakaConfig).toEqual({ streaming: { bufferingGoal: 180 } });
  // The auth handlers stay on the config that now carries the buffer goal.
  expect(typeof config.segmentRequestHandler).toBe('function');

  loadTrack();
  loadTrack();
  expect(profileLines(fetch)).toEqual(['display=true bufferingGoal=180']);
});

test('an audio-only device keeps the default buffer', () => {
  const { ready, loadTrack, player, fetch } = startReceiver({ display_supported: false });
  ready();
  loadTrack();
  expect(player.setPlaybackConfig).not.toHaveBeenCalled();
  expect(profileLines(fetch)).toEqual(['display=false bufferingGoal=default']);
});

test('no capabilities reported counts as audio-only', () => {
  const { ready, loadTrack, player, fetch } = startReceiver(null);
  ready();
  loadTrack();
  expect(player.setPlaybackConfig).not.toHaveBeenCalled();
  expect(profileLines(fetch)).toEqual(['display=false bufferingGoal=default']);
});
