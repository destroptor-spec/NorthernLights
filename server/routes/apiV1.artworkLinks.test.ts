/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({}));
jest.mock('../services/auth.service', () => ({
  ...jest.requireActual('../services/auth.service'),
  getJwtSecret: jest.fn(async () => 'server-secret'),
  getCachedJwtSecret: jest.fn(() => 'server-secret'),
}));
import type { Request, Response } from 'express';
import router from './apiV1.routes';
import { artworkLinksSchema } from '../../shared/api/v1';
import { artworkSignatureValid } from '../services/artworkLink.service';

/** 6a-4: signed links for artwork a client holds unsigned (a queue saved before links were signed). */
async function links(body: unknown) {
  const layer = router.stack.find((l) => l.route?.path === '/artwork/links' && l.route.stack.some((h) => h.method === 'post'))!;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await layer.route!.stack[0].handle({ apiV1: { userId: 'u1' }, body, requestId: 'r1' } as unknown as Request, res as unknown as Response, jest.fn());
  return { status: res.status.mock.calls[0]?.[0] ?? 200, body: res.json.mock.calls[0][0] };
}

it('signs each ID once, with a link that opens that one image', async () => {
  const { status, body } = await links({ ids: ['ab12', 'ab12', 'cd34'] });
  expect(status).toBe(200);
  expect(artworkLinksSchema.safeParse(body.data).success).toBe(true);
  expect(Object.keys(body.data.links)).toEqual(['ab12', 'cd34']);
  const sig = new URL(body.data.links.ab12, 'https://a.example').searchParams.get('sig');
  await expect(artworkSignatureValid('ab12', sig)).resolves.toBe(true);
  await expect(artworkSignatureValid('cd34', sig)).resolves.toBe(false);
});

it('refuses IDs that are not artwork IDs', async () => {
  const { status } = await links({ ids: ['../etc/passwd'] });
  expect(status).toBe(400);
});
