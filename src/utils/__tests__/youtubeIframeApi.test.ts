import type { YTNamespace } from '../youtubeIframeApi';

let load: typeof import('../youtubeIframeApi').loadYouTubeIframeApi;
const script = () => document.querySelector<HTMLScriptElement>('script[src="https://www.youtube.com/iframe_api"]')!;
beforeEach(() => {
  jest.resetModules();
  jest.useFakeTimers();
  delete window.YT;
  delete window.onYouTubeIframeAPIReady;
  document.head.innerHTML = '';
  load = require('../youtubeIframeApi').loadYouTubeIframeApi;
});
afterEach(() => { jest.useRealTimers(); });
const ready = () => {
  window.YT = { Player: jest.fn() } as unknown as YTNamespace;
  window.onYouTubeIframeAPIReady?.();
};

test('concurrent consumers share a single load', async () => {
  const first = load();
  expect(load()).toBe(first);
  expect(document.head.querySelectorAll('script')).toHaveLength(1);
  ready();
  await expect(first).resolves.toBe(window.YT);
  expect(jest.getTimerCount()).toBe(0);
});

test('a failed script is removed and reopening can load a fresh one', async () => {
  const first = load();
  const failure = expect(first).rejects.toThrow('Failed to load');
  const failedScript = script();
  failedScript.dispatchEvent(new Event('error'));
  await failure;
  const retry = load();
  expect(script()).not.toBe(failedScript);
  ready();
  await expect(retry).resolves.toBe(window.YT);
});

test('a script that never signals readiness times out and permits retry', async () => {
  const first = load();
  const failure = expect(first).rejects.toThrow('timed out');
  jest.advanceTimersByTime(15000);
  await failure;
  expect(script()).toBeNull();
  const retry = load();
  ready();
  await expect(retry).resolves.toBe(window.YT);
});

test('an existing loader callback is preserved and restored', async () => {
  const previous = jest.fn();
  window.onYouTubeIframeAPIReady = previous;
  const pending = load();
  ready();
  await pending;
  expect(previous).toHaveBeenCalledTimes(1);
  expect(window.onYouTubeIframeAPIReady).toBe(previous);
});
