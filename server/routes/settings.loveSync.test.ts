/** @jest-environment node */
jest.mock('../database', () => ({
  getSystemSetting: jest.fn(),
  setSystemSetting: jest.fn(),
  getUserSetting: jest.fn(),
  setUserSetting: jest.fn(),
  getSubGenreMappings: jest.fn(),
}));
jest.mock('../middleware/auth', () => ({ requireAdmin: jest.fn() }));
jest.mock('../services/genreMatrix.service', () => ({ genreMatrixService: {} }));
jest.mock('../services/downloadModels', () => ({}));
import type { Request, Response } from 'express';
import router from './settings.routes';
import { getSystemSetting, getUserSetting, setUserSetting } from '../database';

/**
 * The settings route only stores keys on its allowlists. Without
 * subsonicProviderLoveSyncEnabled there, the Settings toggle would flip in the
 * UI and be silently dropped on save.
 */
async function request(method: 'get' | 'post', body = {}, role = 'user') {
  const layer = router.stack.find((l) => l.route?.path === '/settings' && l.route.stack.some((h) => h.method === method));
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await layer!.route!.stack[0].handle({ body, user: { userId: 'u1', role } } as unknown as Request, res as unknown as Response, jest.fn());
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getSystemSetting).mockResolvedValue(null);
  jest.mocked(getUserSetting).mockResolvedValue(null);
});

test('any listener can save the love-sync preference for themselves', async () => {
  const res = await request('post', { subsonicProviderLoveSyncEnabled: false });
  expect(res.status).not.toHaveBeenCalledWith(403);
  expect(res.status).not.toHaveBeenCalledWith(400);
  expect(setUserSetting).toHaveBeenCalledWith('u1', 'subsonicProviderLoveSyncEnabled', false);
});

test('the saved preference is returned to the client', async () => {
  jest.mocked(getUserSetting).mockImplementation(async (_u, key) => (key === 'subsonicProviderLoveSyncEnabled' ? false : null));
  const res = await request('get');
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ subsonicProviderLoveSyncEnabled: false }));
});
