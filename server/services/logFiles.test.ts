/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logPolicyFromEnv, pruneLogs, RotatingLogFile, type LogPolicy } from './logFiles';

const DAY = 24 * 60 * 60 * 1000;
let dir: string;
const policy = (extra: Partial<LogPolicy> = {}): LogPolicy => ({ dir, maxFileBytes: 100, keepFiles: 3, retentionMs: 30 * DAY, ...extra });

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-logs-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the policy reads .env, with 50 MB × 5 and 30 days by default', () => {
  expect(logPolicyFromEnv({})).toMatchObject({ maxFileBytes: 50 * 1024 * 1024, keepFiles: 5, retentionMs: 30 * DAY });
  expect(logPolicyFromEnv({ LOG_MAX_FILE_MB: '10', LOG_KEEP_FILES: '2', LOG_RETENTION_DAYS: '7', LOG_DIR: dir }))
    .toEqual({ dir: path.resolve(dir), maxFileBytes: 10 * 1024 * 1024, keepFiles: 2, retentionMs: 7 * DAY });
  expect(logPolicyFromEnv({ LOG_MAX_FILE_MB: 'lots' }).maxFileBytes).toBe(50 * 1024 * 1024);
});

test('a log rotates by size and keeps its number of files', () => {
  const log = new RotatingLogFile('production.log', policy());
  for (let i = 0; i < 20; i++) log.write(`line ${String(i).padStart(2, '0')} ${'x'.repeat(30)}`);
  log.close();
  expect(fs.readdirSync(dir).sort()).toEqual(['production.log', 'production.log.1', 'production.log.2']);
  for (const name of fs.readdirSync(dir)) expect(fs.statSync(path.join(dir, name)).size).toBeLessThanOrEqual(100);
  // The newest lines are in the current file.
  expect(fs.readFileSync(path.join(dir, 'production.log'), 'utf8')).toContain('line 19');
});

test('a log never writes outside the log folder', () => {
  expect(() => new RotatingLogFile('../escape.log', policy())).toThrow();
});

test('expiry removes Aurora\'s old logs and extra copies, and nothing else', () => {
  const touch = (name: string, ageDays: number) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');
    const t = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(file, t, t);
  };
  touch('production.log', 1);
  touch('production.log.1', 40);
  touch('scanner.log.4', 1);          // beyond keepFiles 3
  touch('auth.log', 31);
  touch('hls-sessions/a--b--c.log', 31);
  touch('hls-sessions/d--e--f.log', 2);
  touch('my-notes.log', 365);         // not Aurora's
  touch('production.log.bak', 365);   // not a rotated copy
  expect(pruneLogs(policy())).toBe(4);
  expect(fs.readdirSync(dir).sort()).toEqual(['hls-sessions', 'my-notes.log', 'production.log', 'production.log.bak']);
  expect(fs.readdirSync(path.join(dir, 'hls-sessions'))).toEqual(['d--e--f.log']);
});
