/** @jest-environment node */
jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../database', () => ({}));
jest.mock('../state', () => ({ isPathAllowed: jest.fn(async () => true) }));
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { measureLoudness } from './loudness.service';
import { applyLoggingSettings } from './loggingConfig';

let child: EventEmitter & { stderr: EventEmitter; kill: jest.Mock };
beforeEach(() => {
  jest.useFakeTimers();
  child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill: jest.fn() });
  jest.mocked(spawn).mockReset().mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  applyLoggingSettings({ loudnessLoggingEnabled: false });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

test('a toggle takes effect during measurement without disrupting output parsing', async () => {
  const result = measureLoudness('/music/test.flac');
  await Promise.resolve();
  expect(console.log).not.toHaveBeenCalled();
  applyLoggingSettings({ loudnessLoggingEnabled: true });
  child.stderr.emit('data', Buffer.from('{"input_i":"-14.5","input_tp":"-1.2"}'));
  child.emit('close', 0, null);
  await expect(result).resolves.toEqual({ lufs: -14.5, truePeakDbfs: -1.2 });
  expect(console.log).toHaveBeenCalledWith('[Loudness] Measurement completed', expect.objectContaining({ lufs: -14.5, truePeakDbfs: -1.2 }));
  expect(console.warn).not.toHaveBeenCalled();
});

test.each(['exit', 'timeout', 'spawn', 'invalid'])('failure remains visible with logs disabled: %s', async failure => {
  if (failure === 'spawn') jest.mocked(spawn).mockImplementation(() => { throw new Error('spawn failed'); });
  const result = measureLoudness('/music/test.flac');
  await Promise.resolve();
  if (failure === 'exit') child.emit('close', 1, null);
  if (failure === 'timeout') { jest.advanceTimersByTime(120000); child.emit('close', null, 'SIGKILL'); }
  if (failure === 'invalid') child.emit('close', 0, null);
  await expect(result).resolves.toBeNull();
  expect(console.warn).toHaveBeenCalledTimes(1);
  expect(console.log).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
