/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({ getUserSetting: jest.fn() }));
jest.mock('../state', () => ({ getSessionHistory: jest.fn(), addToSessionHistory: jest.fn() }));
jest.mock('../services/recommendation.service', () => ({ calculateNextInfinityTrack: jest.fn() }));
jest.mock('../services/apiV1Dto.service', () => ({
  ...jest.requireActual('../services/apiV1Dto.service'), getApiV1TrackById: jest.fn(),
}));
import type { Request, Response } from 'express';
import router from './apiV1.routes';
import legacyRouter from './recommend.routes';
import { getUserSetting } from '../database';
import { getSessionHistory, addToSessionHistory } from '../state';
import { calculateNextInfinityTrack } from '../services/recommendation.service';
import { getApiV1TrackById, mapTrackV1 } from '../services/apiV1Dto.service';

async function request(body: unknown, legacy = false) {
  const layer = (legacy ? legacyRouter : router).stack.find(layer => layer.route?.path === (legacy ? '/recommend' : '/recommendations/next'))!;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await layer.route!.stack[0].handle({ body, apiV1: { userId: 'listener' }, user: { userId: 'listener' }, requestId: 'request-1' } as unknown as Request, res as unknown as Response, jest.fn());
  return res;
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getSessionHistory).mockReturnValue(['older', 'previous']);
  jest.mocked(getUserSetting).mockResolvedValue(null);
  jest.mocked(calculateNextInfinityTrack).mockResolvedValue({ id: 'next', path: 'private-path', distance: 0.1 });
  jest.mocked(getApiV1TrackById).mockResolvedValue(mapTrackV1({ id: 'next', title: 'Next', path: 'private-path' }));
});

test('v1 merges playback-start context and exclusions, returning a path-free Track envelope', async () => {
  const res = await request({ sessionHistoryTrackIds: ['previous', 'playing'], exclude: ['playing', 'queued'] });
  expect(calculateNextInfinityTrack).toHaveBeenCalledWith(['older', 'previous', 'playing'], {}, { excludeTrackIds: ['playing', 'queued'] });
  expect(getApiV1TrackById).toHaveBeenCalledWith('listener', 'next');
  expect(res.json).toHaveBeenCalledWith({ data: expect.objectContaining({ id: 'next', musicBrainz: expect.any(Object) }), meta: { requestId: 'request-1' } });
  expect(res.json.mock.calls[0][0].data).not.toHaveProperty('path');
  expect(res.json.mock.calls[0][0].data).not.toHaveProperty('distance');
  expect(addToSessionHistory).not.toHaveBeenCalled();
});

test('queue seeds pass through to the engine alongside history', async () => {
  await request({ sessionHistoryTrackIds: ['playing'], exclude: ['queued'], seedTrackIds: ['playing', 'queued'] });
  expect(calculateNextInfinityTrack).toHaveBeenCalledWith(['older', 'previous', 'playing'], {}, { excludeTrackIds: ['queued'], seedTrackIds: ['playing', 'queued'] });
});

test('saved user tuning is resolved for existing clients; explicit zero overrides win', async () => {
  jest.mocked(getUserSetting).mockImplementation(async (userId, key) => {
    expect(userId).toBe('listener');
    return { discoveryLevel: 80, genreStrictness: 60, artistAmnesiaLimit: 50 }[key];
  });
  await request({ settings: { discoveryLevel: 0 }, exclude: ['queued'] });
  expect(calculateNextInfinityTrack).toHaveBeenCalledWith(['older', 'previous'], { discoveryLevel: 0, genreStrictness: 60, artistAmnesiaLimit: 50 }, { excludeTrackIds: ['queued'] });
});

test('empty server history after restart keeps browser context and history stays bounded', async () => {
  jest.mocked(getSessionHistory).mockReturnValue([]);
  const history = Array.from({ length: 200 }, (_, i) => `t-${i}`);
  await request({ sessionHistoryTrackIds: history });
  expect(calculateNextInfinityTrack).toHaveBeenCalledWith(history.slice(-50), {}, { excludeTrackIds: [] });
});

test.each([
  { sessionHistoryTrackIds: 'invalid' }, { exclude: [null] },
  { sessionHistoryTrackIds: Array(201).fill('id') }, { exclude: Array(201).fill('id') },
  { settings: { discoveryLevel: '100' } }, { settings: { genreStrictness: 101 } },
  { settings: { artistAmnesiaLimit: -1 } }, { excludeTrackIds: ['legacy-field'] },
  { seedTrackIds: Array(51).fill('id') }, { seedTrackIds: [''] },
])('rejects invalid v1 input with the standard error envelope: %p', async body => {
  const res = await request(body);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(res.json).toHaveBeenCalledWith({ error: expect.objectContaining({ code: 'VALIDATION_FAILED', requestId: 'request-1' }) });
  expect(calculateNextInfinityTrack).not.toHaveBeenCalled();
});

test('legacy adapter and v1 resolve identical engine arguments', async () => {
  jest.mocked(getUserSetting).mockResolvedValue(25);
  await request({ sessionHistoryTrackIds: ['playing'], exclude: ['queued'], seedTrackIds: ['playing', 'queued'] });
  await request({ sessionHistoryTrackIds: ['playing'], excludeTrackIds: ['queued'], seedTrackIds: ['playing', 'queued'] }, true);
  const calls = jest.mocked(calculateNextInfinityTrack).mock.calls;
  expect(calls[0]).toEqual(calls[1]);
});

test('exhaustion returns data null without a DTO lookup', async () => {
  jest.mocked(calculateNextInfinityTrack).mockResolvedValue(undefined);
  const res = await request({});
  expect(res.json).toHaveBeenCalledWith({ data: null, meta: { requestId: 'request-1' } });
  expect(getApiV1TrackById).not.toHaveBeenCalled();
});
