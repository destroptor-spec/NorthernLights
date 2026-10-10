/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { BoundedDiagnosticLog, HLS_LOG_RETENTION_MS } from './boundedDiagnosticLog';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-log-test-')); });
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

test('redacts query, bearer and JSON credentials before writing or rotating', () => {
  const log = new BoundedDiagnosticLog(root, 350);
  const message = 'playlist?token=secret&codec=aac Bearer bearer-secret {"token":"json-secret"} eyJabc.def.ghi\nnext';
  for (let i = 0; i < 8; i++) log.append('hls-server.log', message);
  expect(fs.readdirSync(root).sort()).toEqual(['hls-server.log', 'hls-server.log.1']);
  for (const file of fs.readdirSync(root)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    expect(text).not.toMatch(/secret|eyJabc|\nnext/);
    expect(text).toContain('token=[redacted]&codec=aac');
    expect(fs.statSync(path.join(root, file)).size).toBeLessThanOrEqual(350);
  }
});

test('prunes old session history and keeps recent logs within the directory budget', () => {
  const directory = path.join(root, 'hls-sessions');
  fs.mkdirSync(directory);
  const now = Date.now();
  fs.writeFileSync(path.join(directory, 'expired.log'), 'old');
  const old = new Date(now - HLS_LOG_RETENTION_MS - 1000);
  fs.utimesSync(path.join(directory, 'expired.log'), old, old);
  fs.writeFileSync(path.join(directory, 'large.log.1'), 'x'.repeat(500));
  fs.writeFileSync(path.join(directory, 'keep.txt'), 'unrelated');
  const log = new BoundedDiagnosticLog(root, 350, 200);
  log.append('hls-sessions/current.log', 'current', now);
  expect(fs.readdirSync(directory).sort()).toEqual(['current.log', 'keep.txt']);
});

test('filesystem failures never propagate into playback', () => {
  const log = new BoundedDiagnosticLog(root);
  jest.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('ENOSPC'); });
  expect(() => log.append('hls-server.log', 'failure')).not.toThrow();
});
