/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({}));
import type { Request, Response } from 'express';
import router from './apiV1.routes';
import { meSchema } from '../../shared/api/v1';

/** The web client's session check reads `user.id`; the contract now says so. */
async function me(apiV1: Record<string, unknown>) {
  const layer = router.stack.find((l) => l.route?.path === '/me' && l.route.stack.some((h) => h.method === 'get'))!;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await layer.route!.stack[0].handle({ apiV1, requestId: 'r1' } as unknown as Request, res as unknown as Response, jest.fn());
  return res.json.mock.calls[0][0].data;
}

it.each([
  ['a web session', { authKind: 'jwt', clientId: 'web:1', clientName: 'Aurora Web' }],
  ['an app key', { authKind: 'appKey', clientId: 'c-1', clientName: 'Desktop' }],
])('returns { user: { id, username, role }, client } for %s', async (_kind, client) => {
  const body = await me({ userId: '5f0c8a8e-8f3e-4a39-9a43-5d0c6b1f2a10', username: 'andreas', role: 'admin', ...client });
  expect(body.user).toEqual({ id: '5f0c8a8e-8f3e-4a39-9a43-5d0c6b1f2a10', username: 'andreas', role: 'admin' });
  expect(meSchema.safeParse(body).success).toBe(true);
});
