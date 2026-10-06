/** @jest-environment node */
jest.mock('../state', () => ({ getSessionHistory: jest.fn() }));
jest.mock('../database', () => ({ getUserSetting: jest.fn() }));
jest.mock('../services/recommendation.service', () => ({ calculateNextInfinityTrack: jest.fn() }));
import type { Request, Response } from 'express';
import router from './recommend.routes';
import { getSessionHistory } from '../state';
import { calculateNextInfinityTrack } from '../services/recommendation.service';
import { getUserSetting } from '../database';

async function request(body: unknown) {
  const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await router.stack[0].route!.stack[0].handle(
    { body, user: { userId: 'listener' } } as Request,
    response as unknown as Response, jest.fn(),
  );
  return response;
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getSessionHistory).mockReturnValue([]);
  jest.mocked(getUserSetting).mockResolvedValue(null);
  jest.mocked(calculateNextInfinityTrack).mockResolvedValue({ id: 'new' });
});

test('authenticated browser playback-start history survives empty server history after restart', async () => {
  await request({ sessionHistoryTrackIds: ['previous', 'playing'], excludeTrackIds: ['playing', 'queued'], settings: { discoveryLevel: 100 } });
  expect(calculateNextInfinityTrack).toHaveBeenCalledWith(['previous', 'playing'], { discoveryLevel: 100 }, { excludeTrackIds: ['playing', 'queued'] });
});

test('delayed telemetry cannot move the playing track behind older server history', async () => {
  jest.mocked(getSessionHistory).mockReturnValue(['older', 'previous']);
  await request({ sessionHistoryTrackIds: ['previous', 'playing'] });
  expect(calculateNextInfinityTrack).toHaveBeenCalledWith(['older', 'previous', 'playing'], {}, { excludeTrackIds: [] });
  expect(getSessionHistory('listener')).toEqual(['older', 'previous']);
});

test('uses server history when a client does not supply playback context', async () => {
  jest.mocked(getSessionHistory).mockReturnValue(['heard']);
  await request({});
  expect(calculateNextInfinityTrack).toHaveBeenCalledWith(['heard'], {}, { excludeTrackIds: [] });
});

test.each([{ sessionHistoryTrackIds: 'bad' }, { excludeTrackIds: [null] }])('invalid context returns 400', async body => {
  expect((await request(body)).status).toHaveBeenCalledWith(400);
  expect(calculateNextInfinityTrack).not.toHaveBeenCalled();
});

test('exhaustion is represented as a null track', async () => {
  jest.mocked(calculateNextInfinityTrack).mockResolvedValue(undefined);
  expect((await request({})).json).toHaveBeenCalledWith({ track: null });
});
