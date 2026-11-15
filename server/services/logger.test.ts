/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-logger-'));
process.env.LOG_DIR = dir;
// Imported after LOG_DIR is set: the policy is read when the module loads.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const logger = require('./logger') as typeof import('./logger');
const files = require('./logFiles') as typeof import('./logFiles');

const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };
const read = (name: string) => { try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return ''; } };

beforeAll(() => {
  // Keep the test output quiet: the logger prints through these.
  for (const key of Object.keys(saved) as Array<keyof typeof saved>) jest.spyOn(console, key).mockImplementation(() => {});
});
afterAll(() => {
  Object.assign(console, saved);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('errors and warnings are recorded at every level; info and debug by the level', () => {
  expect(logger.isRecorded('error', 'warn')).toBe(true);
  expect(logger.isRecorded('warn', 'warn')).toBe(true);
  expect(logger.isRecorded('info', 'warn')).toBe(false);
  expect(logger.isRecorded('info', 'info')).toBe(true);
  expect(logger.isRecorded('debug', 'info')).toBe(false);
  expect(logger.isRecorded('debug', 'debug')).toBe(true);
});

test('a line belongs to an area by its prefix', () => {
  expect(logger.channelOf('[Scanner] walk failed')).toBe('scanner');
  expect(logger.channelOf('[AudioExtract:python] boom')).toBe('analyzer');
  expect(logger.channelOf('[Loudness] measure failed')).toBe('loudness');
  expect(logger.channelOf('[HLS] session')).toBeNull();
});

test('once installed, the console is recorded: everything in production.log, errors also in their area\'s file', () => {
  logger.installLogging();
  logger.setLogLevel('info');
  console.log('[Scanner] scanned 10 files');
  console.error('[Scanner] could not read /music/a.flac');
  console.warn('[Loudness] true peak out of range');
  console.debug('a debug line');
  logger.logChannelDetail('analyzer', '[AudioExtract] timings');
  logger.logChannel('analyzer', 'error', 'worker crashed');
  for (const name of ['production.log', 'scanner.log', 'loudness.log', 'analyzer.log']) files.logFile(name).close();

  const production = read('production.log');
  expect(production).toMatch(/INFO  \[Scanner\] scanned 10 files/);
  expect(production).toMatch(/ERROR \[Scanner\] could not read/);
  expect(production).not.toContain('a debug line');
  // Info stays out of the area file; errors and warnings go in, and an area's detail when its switch let it through.
  expect(read('scanner.log')).toContain('could not read');
  expect(read('scanner.log')).not.toContain('scanned 10 files');
  expect(read('loudness.log')).toContain('true peak');
  expect(read('analyzer.log')).toContain('[AudioExtract] timings');
  expect(read('analyzer.log')).toContain('worker crashed');

  logger.setLogLevel('warn');
  console.log('quiet now');
  files.logFile('production.log').close();
  expect(read('production.log')).not.toContain('quiet now');
});
