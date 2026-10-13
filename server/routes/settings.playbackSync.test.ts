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
jest.mock('../services/apiV1Events.service', () => ({ publishApiV1SettingsChanged: jest.fn() }));
import type { Request, Response } from 'express';
import router from './settings.routes';
import { getSystemSetting, getUserSetting, setSystemSetting, setUserSetting } from '../database';
import { publishApiV1SettingsChanged } from '../services/apiV1Events.service';

/**
 * "Sync playback across devices" is the admin's to decide (off, on, or each
 * user), and is stored server-side so every device of a user agrees.
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

test('only an admin sets the mode, and every user hears about it', async () => {
  const refused = await request('post', { playbackSyncMode: 'on' });
  expect(refused.status).toHaveBeenCalledWith(403);
  expect(setSystemSetting).not.toHaveBeenCalled();

  await request('post', { playbackSyncMode: 'user' }, 'admin');
  expect(setSystemSetting).toHaveBeenCalledWith('playbackSyncMode', 'user');
  expect(publishApiV1SettingsChanged).toHaveBeenCalledWith(['playbackSyncMode']);
});

test('refuses a mode that does not exist', async () => {
  const res = await request('post', { playbackSyncMode: 'sometimes' }, 'admin');
  expect(res.status).toHaveBeenCalledWith(400);
  expect(setSystemSetting).not.toHaveBeenCalled();
});

test("a user's own choice is stored for them and reaches their other devices", async () => {
  await request('post', { playbackSyncEnabled: true });
  expect(setUserSetting).toHaveBeenCalledWith('u1', 'playbackSyncEnabled', true);
  expect(publishApiV1SettingsChanged).toHaveBeenCalledWith(['playbackSyncEnabled'], 'u1');
  expect((await request('post', { playbackSyncEnabled: 'yes' })).status).toHaveBeenCalledWith(400);
});

test('every user reads the mode and their own choice, never the admin fallback for it', async () => {
  jest.mocked(getSystemSetting).mockImplementation(async (key) => (key === 'playbackSyncMode' ? 'user' : key === 'playbackSyncEnabled' ? true : null));
  jest.mocked(getUserSetting).mockResolvedValue(null);
  const asUser = await request('get');
  expect(asUser.json).toHaveBeenCalledWith(expect.objectContaining({ playbackSyncMode: 'user' }));
  const asAdmin = await request('get', {}, 'admin');
  expect(asAdmin.json.mock.calls[0][0].playbackSyncEnabled).toBeUndefined();
});
