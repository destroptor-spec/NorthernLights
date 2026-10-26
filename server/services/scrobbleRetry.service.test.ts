/**
 * @jest-environment node
 */
jest.mock('./lastfm.service', () => ({}));
jest.mock('./listenbrainz.service', () => ({}));

import {
  SCROBBLE_RETRY_DELAYS_MS,
  SCROBBLE_RETRY_MAX_PENDING,
  isTransientScrobbleError,
  pendingScrobbleCount,
  resetScrobbleRetries,
  scrobbleWithRetry,
  type ScrobbleRetryDeps,
} from './scrobbleRetry.service';

/** What undici throws when a request never gets an answer (prod: ETIMEDOUT / ECONNRESET). */
function fetchFailed(code = 'ETIMEDOUT') {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
}

function harness(outcomes: Array<'ok' | Error>) {
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const logs: string[] = [];
  const sent: Array<{ provider: string; tracks: unknown[] }> = [];
  const deps: ScrobbleRetryDeps = {
    send: jest.fn(async (provider, _userId, tracks) => {
      sent.push({ provider, tracks });
      const outcome = outcomes.shift() ?? 'ok';
      if (outcome !== 'ok') throw outcome;
      return { accepted: tracks.length };
    }),
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true; },
    nowS: () => 1_700_000_000,
    log: (message) => logs.push(message),
  };
  /** Fire the most recent timer and let the retry settle. */
  const fireNext = async () => {
    const timer = timers[timers.length - 1];
    timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { deps, timers, logs, sent, fireNext };
}

const track = { artist: 'A', track: 'One', timestamp: 1_699_999_000 };

afterEach(() => resetScrobbleRetries({ clearTimer: () => undefined }));

it('sends straight through when the provider answers', async () => {
  const h = harness(['ok']);
  await expect(scrobbleWithRetry('listenbrainz', 'u1', [track], h.deps)).resolves.toEqual({ accepted: 1 });
  expect(h.timers).toHaveLength(0);
  expect(pendingScrobbleCount()).toBe(0);
});

it('holds a scrobble lost to a network failure and sends it again later', async () => {
  const h = harness([fetchFailed(), 'ok']);
  await expect(scrobbleWithRetry('listenbrainz', 'u1', [track], h.deps)).resolves.toEqual({ queued: true });
  expect(h.timers[0].delayMs).toBe(SCROBBLE_RETRY_DELAYS_MS[0]);
  expect(h.logs[0]).toBe('scrobble_retry_queued provider=listenbrainz count=1 message=fetch failed (cause: ETIMEDOUT)');

  await h.fireNext();
  expect(h.sent).toHaveLength(2);
  expect(h.sent[1].tracks).toEqual([track]);
  expect(h.logs[1]).toBe('scrobble_retry_sent provider=listenbrainz count=1 attempt=1');
  expect(pendingScrobbleCount()).toBe(0);
});

it('keeps the time of the listen when the caller sent none', async () => {
  const h = harness([fetchFailed(), 'ok']);
  await scrobbleWithRetry('lastfm', 'u1', [{ artist: 'A', track: 'One' }], h.deps);
  await h.fireNext();
  expect(h.sent[1].tracks).toEqual([{ artist: 'A', track: 'One', timestamp: 1_700_000_000 }]);
});

it('backs off through every delay, then gives up', async () => {
  const failures = SCROBBLE_RETRY_DELAYS_MS.map(() => fetchFailed('ECONNRESET'));
  const h = harness([fetchFailed(), ...failures]);
  await scrobbleWithRetry('listenbrainz', 'u1', [track], h.deps);
  for (let i = 0; i < SCROBBLE_RETRY_DELAYS_MS.length; i += 1) {
    expect(h.timers[i].delayMs).toBe(SCROBBLE_RETRY_DELAYS_MS[i]);
    await h.fireNext();
  }
  expect(h.sent).toHaveLength(1 + SCROBBLE_RETRY_DELAYS_MS.length);
  expect(h.timers).toHaveLength(SCROBBLE_RETRY_DELAYS_MS.length);
  expect(h.logs[h.logs.length - 1]).toMatch(/^scrobble_retry_gave_up provider=listenbrainz count=1 attempt=5 message=fetch failed \(cause: ECONNRESET\)/);
  expect(pendingScrobbleCount()).toBe(0);
});

it('stops retrying when the provider rejects the scrobble outright', async () => {
  const h = harness([fetchFailed(), new Error('Last.fm error 9: Invalid session key')]);
  await scrobbleWithRetry('lastfm', 'u1', [track], h.deps);
  await h.fireNext();
  expect(h.timers).toHaveLength(1);
  expect(h.logs[1]).toMatch(/^scrobble_retry_gave_up provider=lastfm/);
  expect(pendingScrobbleCount()).toBe(0);
});

it('throws a non-network failure as before, without holding it', async () => {
  const h = harness([new Error('ListenBrainz not connected')]);
  await expect(scrobbleWithRetry('listenbrainz', 'u1', [track], h.deps)).rejects.toThrow('ListenBrainz not connected');
  expect(h.timers).toHaveLength(0);
});

it('stops holding scrobbles once the queue is full', async () => {
  const h = harness(Array.from({ length: SCROBBLE_RETRY_MAX_PENDING + 1 }, () => fetchFailed()));
  for (let i = 0; i < SCROBBLE_RETRY_MAX_PENDING; i += 1) {
    await scrobbleWithRetry('listenbrainz', 'u1', [track], h.deps);
  }
  await expect(scrobbleWithRetry('listenbrainz', 'u1', [track], h.deps)).rejects.toThrow('fetch failed');
  expect(pendingScrobbleCount()).toBe(SCROBBLE_RETRY_MAX_PENDING);
  expect(h.logs[h.logs.length - 1]).toMatch(/^scrobble_retry_dropped provider=listenbrainz count=1 reason=queue-full/);
});

describe('isTransientScrobbleError', () => {
  it('counts network failures, timeouts and temporary outages', () => {
    expect(isTransientScrobbleError(fetchFailed())).toBe(true);
    expect(isTransientScrobbleError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(true);
    expect(isTransientScrobbleError(new Error('Last.fm HTTP 503: Service Unavailable'))).toBe(true);
    expect(isTransientScrobbleError(new Error('ListenBrainz returned 502'))).toBe(true);
    expect(isTransientScrobbleError(new Error('Last.fm error 11: Service Offline'))).toBe(true);
    expect(isTransientScrobbleError(new Error('Last.fm error 16: The service is temporarily unavailable'))).toBe(true);
  });

  it('leaves out failures that would repeat', () => {
    expect(isTransientScrobbleError(new Error('Last.fm error 9: Invalid session key'))).toBe(false);
    expect(isTransientScrobbleError(new Error('ListenBrainz returned 400'))).toBe(false);
    expect(isTransientScrobbleError(new Error('Invalid token'))).toBe(false);
    expect(isTransientScrobbleError(null)).toBe(false);
  });
});
