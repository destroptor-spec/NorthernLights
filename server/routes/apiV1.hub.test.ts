/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({
  getPlaylistByIdReadable: jest.fn(),
  getPlaylistTracks: jest.fn(),
}));
jest.mock('../services/recommendation.service', () => ({ getHubCollections: jest.fn() }));
jest.mock('../services/hubRefresh.service', () => ({
  generateCustomHubPlaylist: jest.fn(),
  queueLlmHubRefreshForUser: jest.fn(),
  runLlmHubRegeneration: jest.fn(),
}));
jest.mock('../services/smartHub.service', () => ({
  computeSmartHubBundle: jest.fn(),
  evaluateArtistRadioEligibility: jest.fn(),
  generateArtistRadio: jest.fn(),
  queueSmartHubRefreshForUser: jest.fn(),
}));
jest.mock('../services/apiV1Events.service', () => ({
  publishApiV1Event: jest.fn(), replayApiV1Events: jest.fn(), subscribeApiV1Events: jest.fn(),
}));
jest.mock('../services/apiV1Dto.service', () => ({
  ...jest.requireActual('../services/apiV1Dto.service'),
  getApiV1TracksByIds: jest.fn(async () => []),
  mapPlaylistV1: jest.fn(async (row: any) => ({ id: row.id, title: row.title })),
}));
import type { Request, Response } from 'express';
import router from './apiV1.routes';
import { getPlaylistByIdReadable, getPlaylistTracks } from '../database';
import { getHubCollections } from '../services/recommendation.service';
import { generateCustomHubPlaylist, queueLlmHubRefreshForUser, runLlmHubRegeneration } from '../services/hubRefresh.service';
import { evaluateArtistRadioEligibility, queueSmartHubRefreshForUser } from '../services/smartHub.service';
import { artistRadioEligibilitySchema, hubRegenerationSchema } from '../../shared/api/v1';

/** The web Hub moved from /api/hub/* to v1, which first needed legacy parity. */
async function call(method: 'get' | 'post', path: string, { query = {}, body }: { query?: Record<string, string>; body?: unknown } = {}) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.stack.some((h) => h.method === method))!;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), end: jest.fn() };
  await layer.route!.stack[0].handle({ query, body, params: {}, apiV1: { userId: 'listener' }, requestId: 'r1' } as unknown as Request, res as unknown as Response, jest.fn());
  return res;
}
const data = (res: { json: jest.Mock }) => res.json.mock.calls[0][0].data;

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getHubCollections).mockResolvedValue([] as never);
});

describe('GET /hub', () => {
  it('queues the LLM and smart refreshes on a view', async () => {
    await call('get', '/hub');
    expect(queueLlmHubRefreshForUser).toHaveBeenCalledWith('listener', 'hub-view');
    expect(queueSmartHubRefreshForUser).toHaveBeenCalledWith('listener');
  });

  it('queues nothing on a background re-poll', async () => {
    await call('get', '/hub', { query: { queueRefresh: 'false' } });
    expect(queueLlmHubRefreshForUser).not.toHaveBeenCalled();
    expect(queueSmartHubRefreshForUser).not.toHaveBeenCalled();
    expect(getHubCollections).toHaveBeenCalledWith([], 'listener');
  });
});

describe('POST /hub/regenerate', () => {
  it('forces a manual regeneration and reports the count', async () => {
    jest.mocked(runLlmHubRegeneration).mockResolvedValue({ generated: 3, schedule: 'Daily' } as never);
    const res = await call('post', '/hub/regenerate', { body: { force: true } });
    expect(runLlmHubRegeneration).toHaveBeenCalledWith('listener', { force: true, source: 'manual' });
    expect(data(res)).toEqual({ skipped: false, reason: null, generated: 3 });
    expect(hubRegenerationSchema.safeParse(data(res)).success).toBe(true);
  });

  it('reports a skip with its reason', async () => {
    jest.mocked(runLlmHubRegeneration).mockResolvedValue({ skipped: true, reason: 'No LLM base URL configured' } as never);
    const res = await call('post', '/hub/regenerate', {});
    expect(runLlmHubRegeneration).toHaveBeenCalledWith('listener', { force: false, source: 'manual' });
    expect(data(res)).toEqual({ skipped: true, reason: 'No LLM base URL configured', generated: 0 });
  });
});

describe('GET /hub/artist-radio/eligibility', () => {
  it('requires an artistId', async () => {
    const res = await call('get', '/hub/artist-radio/eligibility');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(evaluateArtistRadioEligibility).not.toHaveBeenCalled();
  });

  it('returns only the public eligibility fields', async () => {
    jest.mocked(evaluateArtistRadioEligibility).mockResolvedValue({ eligible: false, reason: 'Not enough analysed tracks', targetLength: 50, ownAnalyzed: 1, similarPool: 3 } as never);
    const res = await call('get', '/hub/artist-radio/eligibility', { query: { artistId: 'a1' } });
    expect(evaluateArtistRadioEligibility).toHaveBeenCalledWith('listener', 'a1');
    expect(data(res)).toEqual({ eligible: false, reason: 'Not enough analysed tracks', targetLength: 50 });
    expect(artistRadioEligibilitySchema.safeParse(data(res)).success).toBe(true);
  });
});

describe('POST /hub/custom', () => {
  it('uses the shared retrying generator and returns the playlist', async () => {
    jest.mocked(generateCustomHubPlaylist).mockResolvedValue({ id: 'p1' } as never);
    jest.mocked(getPlaylistByIdReadable).mockResolvedValue({ id: 'p1', title: 'Rainy jazz' } as never);
    jest.mocked(getPlaylistTracks).mockResolvedValue([] as never);
    const res = await call('post', '/hub/custom', { body: { prompt: '  rainy jazz ', count: 20 } });
    expect(generateCustomHubPlaylist).toHaveBeenCalledWith('listener', 'rainy jazz', { tracksPerPlaylist: 20 });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(data(res)).toMatchObject({ id: 'p1', title: 'Rainy jazz' });
  });

  it('returns 503 when every attempt failed', async () => {
    jest.mocked(generateCustomHubPlaylist).mockResolvedValue(null as never);
    const res = await call('post', '/hub/custom', { body: { prompt: 'rainy jazz' } });
    expect(res.status).toHaveBeenCalledWith(503);
  });
});
