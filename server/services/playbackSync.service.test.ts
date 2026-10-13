jest.mock('../database', () => ({ getSystemSetting: jest.fn(), getUserSetting: jest.fn(), initDB: jest.fn() }));
jest.mock('./apiV1Events.service', () => ({ publishApiV1Event: jest.fn() }));
import { getSystemSetting, getUserSetting, initDB } from '../database';
import { publishApiV1Event } from './apiV1Events.service';
import { isPlaybackSyncEnabledFor, publishPlaybackSyncChanged } from './playbackSync.service';

const settings = (mode: unknown, users: Record<string, unknown> = {}) => {
  jest.mocked(getSystemSetting).mockImplementation(async (key) => (key === 'playbackSyncMode' ? mode : null) as never);
  jest.mocked(getUserSetting).mockImplementation(async (userId, key) => (key === 'playbackSyncEnabled' ? users[userId] ?? null : null) as never);
};

beforeEach(() => jest.clearAllMocks());

it("follows the admin's mode, and the user's own choice only when delegated", async () => {
  settings(null, { u1: true });
  expect(await isPlaybackSyncEnabledFor('u1')).toBe(false);
  settings('on');
  expect(await isPlaybackSyncEnabledFor('u1')).toBe(true);
  settings('off', { u1: true });
  expect(await isPlaybackSyncEnabledFor('u1')).toBe(false);
  settings('user', { u1: true });
  expect(await isPlaybackSyncEnabledFor('u1')).toBe(true);
  expect(await isPlaybackSyncEnabledFor('u2')).toBe(false);
});

it('tells each user whether sync is now on for them', async () => {
  settings('user', { u1: true });
  jest.mocked(initDB).mockResolvedValue({ query: jest.fn(async () => ({ rows: [{ id: 'u1' }, { id: 'u2' }] })) } as never);
  await publishPlaybackSyncChanged();
  expect(publishApiV1Event).toHaveBeenCalledWith('u1', 'playbackSync.changed', { enabled: true });
  expect(publishApiV1Event).toHaveBeenCalledWith('u2', 'playbackSync.changed', { enabled: false });

  jest.mocked(publishApiV1Event).mockClear();
  await publishPlaybackSyncChanged('u2');
  expect(publishApiV1Event).toHaveBeenCalledTimes(1);
  expect(publishApiV1Event).toHaveBeenCalledWith('u2', 'playbackSync.changed', { enabled: false });
});
