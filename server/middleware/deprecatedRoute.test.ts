/** @jest-environment node */
import express, { Router } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { deprecatedRoute, legacyRouteTallies, resetLegacyRouteTallies, LEGACY_ROUTES_DEPRECATED_AT } from './deprecatedRoute';

let server: Server;
let base: string;
let now = Date.UTC(2026, 10, 17, 12);
let warn: jest.SpyInstance;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => { req.user = { userId: 'u1', username: 'listener', role: 'user' } as never; next(); });

  // A whole legacy router, as hub, playlists and playback are marked.
  const whole = Router();
  whole.use(deprecatedRoute('the /api/v1/playlists routes'));
  whole.get('/', (_req, res) => { res.json([]); });
  whole.get('/:id', (req, res) => { res.json({ id: req.params.id }); });
  app.use('/api/playlists', whole);

  // Single routes in a router that also has current ones, as on /api.
  const mixed = Router();
  mixed.post('/providers/lastfm/scrobble', deprecatedRoute('POST /api/v1/playback/reports'), (_req, res) => { res.status(202).end(); });
  mixed.get('/providers/lastfm/status', (_req, res) => { res.json({ ok: true }); });
  app.use('/api', mixed);

  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

beforeEach(() => {
  resetLegacyRouteTallies();
  now = Date.UTC(2026, 10, 17, 12);
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

/** Waits for the response's 'finish' to have run on the server. */
async function call(path: string, method = 'GET') {
  const res = await fetch(`${base}${path}`, { method, headers: { 'user-agent': 'OldClient/1.0\tTabbed' } });
  await res.arrayBuffer();
  await new Promise(resolve => setImmediate(resolve));
  return res;
}

test('logs the declared route once, names the replacement, and marks the response', async () => {
  const res = await call('/api/playlists/42');
  expect(res.headers.get('deprecation')).toBe(`@${LEGACY_ROUTES_DEPRECATED_AT}`);
  expect(warn).toHaveBeenCalledTimes(1);
  const line = String(warn.mock.calls[0][0]);
  expect(line).toContain('[Deprecated API] GET /api/playlists/:id: 1 call since 2026-11-17T12:00:00.000Z');
  expect(line).toContain('last: 200, user listener, client "OldClient/1.0 Tabbed"');
  expect(line).toContain('Use the /api/v1/playlists routes.');
  expect(line).not.toContain('/42');
});

test('logs a router root as its mount point', async () => {
  await call('/api/playlists');
  expect(String(warn.mock.calls[0][0])).toContain('[Deprecated API] GET /api/playlists: 1 call');
});

test('logs a marked single route with its full path, and leaves the router\'s other routes alone', async () => {
  const scrobble = await call('/api/providers/lastfm/scrobble', 'POST');
  const status = await call('/api/providers/lastfm/status');
  expect(scrobble.headers.get('deprecation')).not.toBeNull();
  expect(status.headers.get('deprecation')).toBeNull();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toContain('[Deprecated API] POST /api/providers/lastfm/scrobble: 1 call');
  expect(String(warn.mock.calls[0][0])).toContain('last: 202');
});

test('then logs at most once an hour per route, with the calls since the last line', async () => {
  await call('/api/playlists/1');
  now += 10 * 60 * 1000;
  await call('/api/playlists/2');
  await call('/api/playlists/3');
  expect(warn).toHaveBeenCalledTimes(1);
  expect(legacyRouteTallies()).toEqual({ 'GET /api/playlists/:id': 2 });

  now += 60 * 60 * 1000;
  await call('/api/playlists/4');
  expect(warn).toHaveBeenCalledTimes(2);
  expect(String(warn.mock.calls[1][0])).toContain('GET /api/playlists/:id: 3 calls since 2026-11-17T12:00:00.000Z');
  expect(legacyRouteTallies()).toEqual({ 'GET /api/playlists/:id': 0 });
});
