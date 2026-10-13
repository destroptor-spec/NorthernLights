/** @jest-environment node */
jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({}));
jest.mock('../services/playbackSync.service', () => ({ isPlaybackSyncEnabledFor: jest.fn() }));
import type { Request, Response } from 'express';
import router from './apiV1.routes';
import { isPlaybackSyncEnabledFor } from '../services/playbackSync.service';

/**
 * Playback sessions follow "Sync playback across devices" for every API v1
 * client alike, so turning it off is not something only the web app honours.
 */
type MatchingLayer = { route?: unknown; match: (path: string) => boolean; handle: (...args: unknown[]) => unknown };
const layers = router.stack as unknown as MatchingLayer[];
// The path-scoped middleware: matches session paths and nothing else.
const guard = layers.find((layer) => !layer.route && layer.match('/playback-sessions/s-1/output') && !layer.match('/playlists'))!;

async function through(path: string, apiV1: Record<string, unknown>) {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), setHeader: jest.fn() };
  const next = jest.fn();
  await guard.handle({ apiV1, requestId: 'r1', path, originalUrl: `/api/v1${path}`, headers: {} } as unknown as Request, res as unknown as Response, next);
  return { res, next };
}

const clients = [
  { userId: 'u1', authKind: 'jwt', clientId: 'web-browser', clientName: 'Aurora Web' },
  { userId: 'u1', authKind: 'appKey', clientId: 'aurora_app_1', clientName: 'Some listener app' },
  { userId: 'u1', authKind: 'scoped', scope: 'output', clientId: 'phone', clientName: 'Aurora playback output' },
];

it('guards the session routes only', () => {
  expect(guard).toBeDefined();
  expect(guard.match('/playback-sessions')).toBe(true);
  expect(guard.match('/playlists')).toBe(false);
});

it('refuses every kind of client the same way when sync is off for the account', async () => {
  jest.mocked(isPlaybackSyncEnabledFor).mockResolvedValue(false);
  for (const client of clients) {
    const { res, next } = await through('/playback-sessions/s-1/output', client);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].error).toMatchObject({ code: 'PLAYBACK_SYNC_DISABLED' });
  }
  expect(isPlaybackSyncEnabledFor).toHaveBeenCalledWith('u1');
});

it('lets every kind of client through when it is on', async () => {
  jest.mocked(isPlaybackSyncEnabledFor).mockResolvedValue(true);
  for (const client of clients) {
    const { res, next } = await through('/playback-sessions', client);
    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  }
});
