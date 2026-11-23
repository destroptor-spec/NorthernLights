/** @jest-environment node */
// #260: sign-in ran before any limiter, so failed sign-ins were never counted
// and each junk app key cost a database lookup. Drives the real router with
// sign-in failing for a bad credential.
jest.mock('music-metadata', () => ({}), { virtual: true });
const query = jest.fn(async () => ({ rows: [] }));
jest.mock('../database', () => ({ initDB: jest.fn(async () => ({ query })) }));
const signIns = jest.fn();
jest.mock('../middleware/apiV1Auth', () => {
  const actual = jest.requireActual('../middleware/apiV1Auth');
  return {
    ...actual,
    // Async like the real one: an app key waits on the database.
    requireApiV1Auth: async (req: { headers: Record<string, string>; apiV1?: unknown; user?: unknown }, res: unknown, next: () => void) => {
      signIns();
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (req.headers.authorization !== 'Bearer good') {
        return actual.sendApiV1Error(req, res, 401, 'INVALID_SESSION', 'The Aurora session is invalid or expired.');
      }
      req.apiV1 = { userId: 'listener', username: 'listener', role: 'user', clientId: 'test', clientName: 'test', authKind: 'jwt' };
      req.user = { userId: 'listener', username: 'listener', role: 'user' };
      next();
    },
  };
});

import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import router from './apiV1.routes';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use('/api/v1', router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** Sends `count` requests all at once. */
async function hit(count: number, token: string) {
  return Promise.all(Array.from({ length: count }, async () => {
    const res = await fetch(`${base}/tracks/t1/lyrics`, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => null) as { error?: { code?: string } } | null;
    return { status: res.status, code: body?.error?.code };
  }));
}

it('never counts signed-in requests, and stops an address after 120 failed sign-ins a minute, even sent at once', async () => {
  // Working credentials give their count back once they succeed (in flight
  // they count, so they go in two turns, each under the limit).
  const good = [...await hit(100, 'good'), ...await hit(50, 'good')];
  expect(good.every((r) => r.status === 404)).toBe(true); // reached the route: no such track

  // A burst of junk, all in flight together: only 120 reach sign-in.
  const bad = await hit(125, 'junk');
  expect(bad.filter((r) => r.status === 401)).toHaveLength(120);
  const refused = bad.filter((r) => r.status === 429);
  expect(refused).toHaveLength(5);
  expect(refused[0].code).toBe('TOO_MANY_FAILED_SIGN_INS');
  // The refused ones never reached sign-in, so a junk app key costs no lookup.
  expect(signIns).toHaveBeenCalledTimes(150 + 120);
});
