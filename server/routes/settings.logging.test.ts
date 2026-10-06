/** @jest-environment node */
jest.mock('../database', () => ({ getSystemSetting: jest.fn(), setSystemSetting: jest.fn(), getUserSetting: jest.fn() }));
jest.mock('../middleware/auth', () => ({ requireAdmin: jest.fn() }));
jest.mock('../services/genreMatrix.service', () => ({ genreMatrixService: {} }));
jest.mock('../services/downloadModels', () => ({}));
import type { Request, Response } from 'express';
import router from './settings.routes';
import { getSystemSetting, setSystemSetting, getUserSetting } from '../database';
import { applyLoggingSettings, getLoggingSettings, loadLoggingSettingsFromDB } from '../services/loggingConfig';
import { SERVER_LOGGING_SETTINGS } from '../../shared/logging';

const persisted = new Map<string, unknown>();
async function request(method: 'get' | 'post', body = {}, role = 'admin') {
  const layer = router.stack.find(layer => layer.route?.path === '/settings' && layer.route.stack.some(handler => handler.method === method));
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  await layer!.route!.stack[0].handle({ body, user: { userId: 1, role } } as unknown as Request, res as unknown as Response, jest.fn());
  return res;
}
beforeEach(() => {
  jest.clearAllMocks();
  persisted.clear();
  applyLoggingSettings(Object.fromEntries(Object.keys(SERVER_LOGGING_SETTINGS).map(key => [key, false])));
  jest.mocked(getSystemSetting).mockImplementation(async key => persisted.get(key) ?? null);
  jest.mocked(getUserSetting).mockResolvedValue(null);
  jest.mocked(setSystemSetting).mockImplementation(async (key, value) => { persisted.set(key, value); });
});

test('admin updates persist, apply immediately, reload, and are returned by GET', async () => {
  for (const key of Object.keys(SERVER_LOGGING_SETTINGS)) {
    const res = await request('post', { [key]: true });
    expect(res.json).toHaveBeenCalledWith({ status: 'updated' });
    expect(getLoggingSettings()).toHaveProperty(key, true);
  }
  applyLoggingSettings(Object.fromEntries(Object.keys(SERVER_LOGGING_SETTINGS).map(key => [key, false])));
  await loadLoggingSettingsFromDB();
  const res = await request('get');
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining(getLoggingSettings()));
  expect(Object.values(getLoggingSettings())).toEqual([true, true, true, true, true]);
  await request('post', { analyzerLoggingEnabled: false });
  expect(getLoggingSettings().analyzerLoggingEnabled).toBe(false);
});

test('GET includes effective defaults when no override is saved', async () => {
  applyLoggingSettings({ analyzerLoggingEnabled: true });
  const res = await request('get');
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ analyzerLoggingEnabled: true, scannerLoggingEnabled: false }));
});

test('non-admins cannot change server logging', async () => {
  const res = await request('post', { scannerLoggingEnabled: true }, 'user');
  expect(res.status).toHaveBeenCalledWith(403);
  expect(setSystemSetting).not.toHaveBeenCalled();
  expect(getLoggingSettings().scannerLoggingEnabled).toBe(false);
});

test.each(['false', 1, null, {}])('rejects non-boolean logging values before writing: %p', async value => {
  const res = await request('post', { scannerLoggingEnabled: true, loudnessLoggingEnabled: value });
  expect(res.status).toHaveBeenCalledWith(400);
  expect(setSystemSetting).not.toHaveBeenCalled();
});

test('a failed save leaves the running flag unchanged', async () => {
  jest.mocked(setSystemSetting).mockRejectedValueOnce(new Error('database unavailable'));
  const res = await request('post', { analyzerLoggingEnabled: true });
  expect(res.status).toHaveBeenCalledWith(500);
  expect(getLoggingSettings().analyzerLoggingEnabled).toBe(false);
});
