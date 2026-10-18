/** @jest-environment node */
import { mbFetch } from './musicbrainz.service';

jest.mock('../database', () => ({ getSystemSetting: jest.fn(async () => null) }));

test('a timed-out metadata lookup leaves the queue promptly and never sends its request', async () => {
  jest.useFakeTimers();
  const originalFetch = global.fetch;
  let finishFirst!: (response: Response) => void;
  const response = { ok: true, json: async () => ({ id: 'artist' }) } as Response;
  const fetchMock = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  // Keep the provider busy so the cancelled request cannot reach the front.
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }));
  fetchMock.mockResolvedValue(response);
  global.fetch = fetchMock;
  try {
    const first = mbFetch('https://musicbrainz.org/ws/2/artist/first');
    await jest.advanceTimersByTimeAsync(0);
    const controller = new AbortController();
    const queued = mbFetch('https://musicbrainz.org/ws/2/artist/cancelled', controller.signal);
    const rejection = expect(queued).rejects.toThrow('metadata deadline');
    controller.abort(new Error('metadata deadline'));
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    finishFirst(response);
    await first;
    await jest.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const next = mbFetch('https://musicbrainz.org/ws/2/artist/next');
    await jest.advanceTimersByTimeAsync(1000);
    await expect(next).resolves.toEqual({ id: 'artist' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  } finally {
    global.fetch = originalFetch;
    jest.useRealTimers();
  }
});
