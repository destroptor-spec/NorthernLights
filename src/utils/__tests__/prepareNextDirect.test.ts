/**
 * Prod 2026-10-17: at Source quality every skip took 2–6 s. A file the
 * browser plays as it is streams directly, and nothing loaded the next one
 * ahead (only HLS was prepared), so each skip fetched a lossless file from
 * scratch. Now the next original file is loaded in a second element and a
 * skip switches to it.
 */
const telemetry: Array<Record<string, unknown>> = [];
const store = {
  streamingQuality: 'source',
  prebufferPolicy: 'conservative',
  playbackState: 'paused',
  recordPlaybackTelemetry: (entry: Record<string, unknown>) => telemetry.push(entry),
  setAutoplayBlocked: jest.fn(),
  addToast: jest.fn(),
};
const cast = { connected: false };

jest.mock('../CastManager', () => ({ castManager: { isConnected: () => cast.connected } }));
jest.mock('../../store', () => ({ usePlayerStore: { getState: () => store } }));
jest.mock('../AudioOutputManager', () => ({
  audioOutputManager: {
    registerElement: jest.fn(), unregisterElement: jest.fn(), applyToRegisteredElements: jest.fn(async () => undefined),
    isContextSinkSupported: () => false, isElementSinkSupported: () => false,
  },
}));
jest.mock('../losslessCapability', () => ({ canBrowserPlayNative: (format?: string) => format === 'FLAC' }));

import { playbackManager } from '../PlaybackManager';

type Internals = { audio: HTMLAudioElement; nextAudio: HTMLAudioElement | null };
const internals = () => playbackManager as unknown as Internals;

const hls = (id: string) => `https://music.example.test/api/stream/${id}/playlist.m3u8?quality=128k&token=t`;
const raw = (id: string) => `https://music.example.test/api/v1/media/tracks/${id}?token=t`;
const setConnection = (connection: unknown) => Object.defineProperty(navigator, 'connection', { value: connection, configurable: true });

beforeAll(() => {
  jest.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  jest.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  jest.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined);
  // jsdom has no AudioContext; the failed-prepare case warns on purpose.
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

beforeEach(() => {
  telemetry.length = 0;
  store.streamingQuality = 'source';
  cast.connected = false;
  setConnection(undefined);
  playbackManager.clearPreparedAudio();
});

const lastLoadPath = () => [...telemetry].reverse().find((entry) => 'loadPath' in entry)?.loadPath;

it('loads the next original file ahead at Source quality', async () => {
  await playbackManager.prepareNextUrl(hls('b'), raw('b'), 'B', 'Artist', undefined, undefined, 'FLAC');
  const prepared = internals().nextAudio!;
  expect(prepared.src).toBe(raw('b'));
  expect(telemetry).toContainEqual(expect.objectContaining({ prepareStatus: 'preparing', preparedTrackTitle: 'B' }));

  prepared.dispatchEvent(new Event('canplay'));
  expect(telemetry).toContainEqual(expect.objectContaining({ prepareStatus: 'ready' }));
});

it('a skip to that track switches to the prepared element', async () => {
  await playbackManager.prepareNextUrl(hls('b'), raw('b'), 'B', undefined, undefined, undefined, 'FLAC');
  const prepared = internals().nextAudio!;
  await playbackManager.playUrl(hls('b'), raw('b'), 'B', undefined, undefined, undefined, 'FLAC');
  expect(internals().audio).toBe(prepared);
  expect(internals().nextAudio).toBeNull();
  expect(lastLoadPath()).toBe('prepared-direct');
});

it('a jump to another track loads that file as before', async () => {
  await playbackManager.prepareNextUrl(hls('b'), raw('b'), 'B', undefined, undefined, undefined, 'FLAC');
  const prepared = internals().nextAudio!;
  await playbackManager.playUrl(hls('x'), raw('x'), 'X', undefined, undefined, undefined, 'FLAC');
  expect(internals().audio).not.toBe(prepared);
  expect(internals().audio.src).toBe(raw('x'));
  expect(lastLoadPath()).toBe('lossless-passthrough');
});

it('prepares the same file once, and a different next track replaces it', async () => {
  await playbackManager.prepareNextUrl(hls('b'), raw('b'), 'B', undefined, undefined, undefined, 'FLAC');
  const first = internals().nextAudio;
  await playbackManager.prepareNextUrl(hls('b'), raw('b'), 'B', undefined, undefined, undefined, 'FLAC');
  expect(internals().nextAudio).toBe(first);
  await playbackManager.prepareNextUrl(hls('c'), raw('c'), 'C', undefined, undefined, undefined, 'FLAC');
  expect(internals().nextAudio).not.toBe(first);
  expect(internals().nextAudio!.src).toBe(raw('c'));
});

it('holds back on Save-Data and slow connections', async () => {
  setConnection({ saveData: true });
  await playbackManager.prepareNextUrl(hls('b'), raw('b'), 'B', undefined, undefined, undefined, 'FLAC');
  expect(internals().nextAudio).toBeNull();
  expect(telemetry).toContainEqual(expect.objectContaining({ prebufferSkippedReason: 'save-data' }));

  setConnection({ effectiveType: '2g' });
  await playbackManager.prepareNextUrl(hls('b'), raw('b'), 'B', undefined, undefined, undefined, 'FLAC');
  expect(internals().nextAudio).toBeNull();
});

it('drops a prepared file that fails, and plays the track normally', async () => {
  await playbackManager.prepareNextUrl(hls('b'), raw('b'), 'B', undefined, undefined, undefined, 'FLAC');
  internals().nextAudio!.dispatchEvent(new Event('error'));
  expect(internals().nextAudio).toBeNull();
  expect(telemetry).toContainEqual(expect.objectContaining({ prepareStatus: 'failed' }));
  await playbackManager.playUrl(hls('b'), raw('b'), 'B', undefined, undefined, undefined, 'FLAC');
  expect(lastLoadPath()).toBe('lossless-passthrough');
});

it('a quality change clears the prepared file', async () => {
  await playbackManager.prepareNextUrl(hls('b'), raw('b'), 'B', undefined, undefined, undefined, 'FLAC');
  playbackManager.clearPreparedAudio();
  expect(internals().nextAudio).toBeNull();
});

it('prepares nothing directly while casting', async () => {
  cast.connected = true;
  await playbackManager.prepareNextUrl(hls('b'), raw('b'), 'B', undefined, undefined, undefined, 'FLAC');
  expect(internals().nextAudio).toBeNull();
});
