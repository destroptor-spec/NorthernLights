/**
 * @jest-environment node
 */
import { cachedLookup, probeDatabase, resetHealthCheckState } from './healthCheck.service';

beforeEach(() => resetHealthCheckState());

describe('probeDatabase', () => {
  it('answers with the latency when the database does', async () => {
    let t = 1000;
    const result = await probeDatabase(async () => { t += 40; }, { now: () => t });
    expect(result).toEqual({ ok: true, latencyMs: 40 });
  });

  it('gives up after its deadline instead of waiting for a stalled pool, and says so in the log', async () => {
    jest.useFakeTimers();
    const log = jest.fn();
    const pending = probeDatabase(() => new Promise(() => undefined), { timeoutMs: 2000, log });
    jest.advanceTimersByTime(2000);
    const result = await pending;
    jest.useRealTimers();
    expect(result).toMatchObject({ ok: false, error: 'no answer within 2000ms' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[Health] database probe failed'));
  });

  it('logs a failure at most once a minute, however many clients poll', async () => {
    let t = 0;
    const log = jest.fn();
    const failing = () => Promise.reject(new Error('Connection terminated unexpectedly'));
    await probeDatabase(failing, { now: () => t, log });
    t += 10_000;
    await probeDatabase(failing, { now: () => t, log });
    expect(log).toHaveBeenCalledTimes(1);
    t += 60_000;
    await probeDatabase(failing, { now: () => t, log });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toContain('Connection terminated unexpectedly');
  });
});

describe('cachedLookup', () => {
  it('runs the lookup (podman ps) once per interval, shared by concurrent callers', async () => {
    let t = 0;
    const lookup = jest.fn(async (name: string) => ({ status: 'running', name }));
    const status = cachedLookup(lookup, { ttlMs: 30_000, now: () => t });
    await Promise.all([status('music-postgres'), status('music-postgres')]);
    t += 29_000;
    await status('music-postgres');
    expect(lookup).toHaveBeenCalledTimes(1);
    t += 2_000;
    await status('music-postgres');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('does not keep a failed lookup', async () => {
    const lookup = jest.fn()
      .mockRejectedValueOnce(new Error('podman busy'))
      .mockResolvedValueOnce({ status: 'running' });
    const status = cachedLookup(lookup);
    await expect(status('music-postgres')).rejects.toThrow('podman busy');
    await expect(status('music-postgres')).resolves.toEqual({ status: 'running' });
  });
});
