/** @jest-environment node */
// The whole API v1 pipeline, as a request meets it: request context, auth,
// the router-wide listener limiter, then a route's own limiter. CodeQL's
// js/missing-rate-limiting reads routes one by one and models neither
// router.use() nor createRateLimiter, so it reports these routes as
// unlimited; this pins that they are not.
jest.mock('music-metadata', () => ({}), { virtual: true });
const query = jest.fn(async () => ({ rows: [] }));
jest.mock('../database', () => ({ initDB: jest.fn(async () => ({ query })) }));
jest.mock('../middleware/apiV1Auth', () => ({
  ...jest.requireActual('../middleware/apiV1Auth'),
  // Signed in as one listener: the real auth only decides who is asking.
  requireApiV1Auth: (req: { apiV1?: unknown; user?: unknown }, _res: unknown, next: () => void) => {
    req.apiV1 = { userId: 'listener', username: 'listener', role: 'user', clientId: 'test', clientName: 'test', authKind: 'jwt' };
    req.user = { userId: 'listener', username: 'listener', role: 'user' };
    next();
  },
}));

import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import router from './apiV1.routes';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => query.mockClear());

/** Sends `count` requests in batches; returns their statuses in order. */
async function hit(path: string, count: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let sent = 0; sent < count; sent += 100) {
    const batch = Array.from({ length: Math.min(100, count - sent) }, () => fetch(`${base}${path}`).then((r) => r.status));
    statuses.push(...await Promise.all(batch));
  }
  return statuses;
}

describe('API v1 rate limiting', () => {
  it('stops stream-format at its own 120 a minute, before the handler touches the database', async () => {
    const statuses = await hit('/tracks/t1/stream-format', 125);
    expect(statuses.filter((s) => s === 404)).toHaveLength(120); // reached the handler: no such track
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect(query).toHaveBeenCalledTimes(120);
  });

  it('limits a route with no limiter of its own through the router-wide listener limiter', async () => {
    // stream-format above already spent 125 of this listener's 1,200 a minute.
    const statuses = await hit('/tracks/t1/lyrics', 1080);
    expect(statuses.filter((s) => s === 404)).toHaveLength(1075);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect(query).toHaveBeenCalledTimes(1075);
  });
});
