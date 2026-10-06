/** @jest-environment node */
jest.mock('child_process', () => ({ spawn: jest.fn() }));
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { ChildProcessPool } from './processPool';
import { applyLoggingSettings } from '../services/loggingConfig';
import type { ProcessingLogChannel } from '../../shared/logging';

class FakeChild extends EventEmitter {
  pid: number;
  stdout = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  stderr = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  stdin = Object.assign(new EventEmitter(), { destroyed: false, writable: true, write: jest.fn(() => true) });
  kill = jest.fn();
  constructor(pid: number) { super(); this.pid = pid; }
}
let children: FakeChild[];
let pools: ChildProcessPool[];
let kill: jest.SpyInstance;
async function pool(size = 1, channel?: ProcessingLogChannel) {
  const value = new ChildProcessPool('/fixture.ts', size, undefined, channel);
  pools.push(value);
  await value.init();
  return value;
}
const job = (id: string) => ({ id, payload: { id } });
const reply = (child: FakeChild, id: string) => child.stdout.emit('data', JSON.stringify({ id, ok: true }) + '\n');

beforeEach(() => {
  jest.useFakeTimers();
  children = []; pools = [];
  applyLoggingSettings({ analyzerLoggingEnabled: false, scannerLoggingEnabled: false, loudnessLoggingEnabled: false });
  kill = jest.spyOn(process, 'kill').mockReturnValue(true);
  jest.mocked(spawn).mockImplementation(() => {
    const child = new FakeChild(90000 + children.length);
    children.push(child);
    return child as unknown as ReturnType<typeof spawn>;
  });
});
afterEach(() => {
  pools.forEach(value => value.terminate());
  jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks();
});

test('a crashed worker resolves immediately and duplicate exit notifications do not respawn twice', async () => {
  const value = await pool();
  const result = value.runJob(job('crash'));
  children[0].emit('exit', 1, null);
  children[0].emit('close', 1, null);
  await expect(result).resolves.toMatchObject({ id: 'crash', error: expect.stringContaining('exited') });
  expect(value.getActiveCount()).toBe(0);
  expect(kill).toHaveBeenCalledWith(-90000, 'SIGKILL');
  jest.advanceTimersByTime(250);
  expect(children).toHaveLength(2);
});

test('shutdown settles active and queued work, clears timers, and rejects subsequent jobs', async () => {
  const value = await pool();
  const jobs = [value.runJob(job('active')), value.runJob(job('queued'))];
  value.terminate();
  for (const result of jobs) await expect(result).resolves.toMatchObject({ error: 'Worker pool terminated' });
  expect(jest.getTimerCount()).toBe(0);
  expect(value.getActiveCount()).toBe(0);
  await expect(value.runJob(job('late'))).resolves.toMatchObject({ error: 'Worker pool terminated' });
});

test('timeout kills the dedicated group, discards late replies, and makes progress on queued work', async () => {
  const value = await pool();
  const first = value.runJob(job('slow'), 1000);
  const second = value.runJob(job('next'), 5000);
  jest.advanceTimersByTime(1000);
  await expect(first).resolves.toMatchObject({ error: expect.stringContaining('timed out') });
  reply(children[0], 'slow');
  jest.advanceTimersByTime(250);
  expect(children[1].stdin.write).toHaveBeenCalledWith('{"id":"next"}\n', expect.any(Function));
  reply(children[1], 'next');
  await expect(second).resolves.toMatchObject({ ok: true });
  expect(value.getActiveCount()).toBe(0);
});

test('growth fills all free slots and shrinking then growing cancels pending retirement', async () => {
  const value = await pool(0);
  const jobs = ['a', 'b', 'c'].map(id => value.runJob(job(id)));
  value.resize(3);
  expect(value.getActiveCount()).toBe(3);
  value.resize(1);
  value.resize(3);
  children.forEach((child, index) => reply(child, ['a', 'b', 'c'][2-index]));
  await Promise.all(jobs);
  expect(value.getWorkerCount()).toBe(3);
  expect(kill).not.toHaveBeenCalled();
  value.resize(1);
  expect(value.getWorkerCount()).toBe(1);
});

test('closed stdin and EPIPE settle jobs instead of leaking active slots', async () => {
  const value = await pool();
  children[0].stdin.destroyed = true;
  await expect(value.runJob(job('closed'))).resolves.toMatchObject({ error: expect.stringContaining('stdin') });
  expect(value.getActiveCount()).toBe(0);
  jest.advanceTimersByTime(250);
  const next = value.runJob(job('pipe'));
  children[1].stdin.emit('error', new Error('EPIPE'));
  children[1].emit('exit', 1, null);
  await expect(next).resolves.toMatchObject({ error: 'EPIPE' });
  expect(value.getActiveCount()).toBe(0);
});


test('an exit event cannot discard a final result still buffered on stdout', async () => {
  const value = await pool();
  const result = value.runJob(job('last'));
  const next = value.runJob(job('next'));
  children[0].emit('exit', 0, null);
  reply(children[0], 'last');
  children[0].emit('close', 0, null);
  await expect(result).resolves.toMatchObject({ id: 'last', ok: true });
  expect(kill).toHaveBeenCalledTimes(1);
  expect(children[0].stdin.write).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(250);
  reply(children[1], 'next');
  await expect(next).resolves.toMatchObject({ id: 'next', ok: true });
});


test('active worker diagnostics follow live toggles while failures and results stay visible', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const value = await pool(1, 'analyzer');
  const result = value.runJob(job('active'));
  const debug = JSON.stringify({ kind: 'aurora-worker-log', level: 'debug', message: 'model timing' }) + '\n';
  children[0].stderr.emit('data', debug);
  expect(log).not.toHaveBeenCalled();
  applyLoggingSettings({ analyzerLoggingEnabled: true });
  children[0].stderr.emit('data', debug.slice(0, 19));
  children[0].stderr.emit('data', debug.slice(19));
  expect(log).toHaveBeenCalledWith('model timing');
  log.mockClear();
  applyLoggingSettings({ analyzerLoggingEnabled: false });
  children[0].stderr.emit('data', debug);
  children[0].stderr.emit('data', JSON.stringify({ kind: 'aurora-worker-log', level: 'warn', message: 'fallback' }) + '\n');
  children[0].stderr.emit('data', 'Unexpected Node crash');
  children[0].stderr.emit('end');
  expect(log).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith('fallback');
  expect(error).toHaveBeenCalledWith('[analyzer worker] Unexpected Node crash');
  reply(children[0], 'active');
  await expect(result).resolves.toMatchObject({ ok: true });
  expect(children).toHaveLength(1);
});
