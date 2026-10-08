/** @jest-environment node */
jest.mock('../database', () => ({
  deleteOldLlmPlaylists: jest.fn(),
  getPlaylists: jest.fn(),
  getSystemSetting: jest.fn(),
  getUserRecentTracks: jest.fn(),
  getUserSetting: jest.fn(),
}));
jest.mock('./llm.service', () => ({ generateCustomPlaylist: jest.fn(), generateHubConcepts: jest.fn() }));
jest.mock('./recommendation.service', () => ({ getHubCollections: jest.fn() }));
jest.mock('./apiV1Events.service', () => ({ publishApiV1Event: jest.fn() }));
import { getPlaylists, getUserSetting } from '../database';
import { generateCustomPlaylist } from './llm.service';
import { getHubCollections } from './recommendation.service';
import { generateCustomHubPlaylist } from './hubRefresh.service';

/**
 * Shared by the legacy /api/hub/generate-custom and v1 POST /hub/custom. v1
 * used to try once, so prompts the legacy route recovered from failed there.
 */
const concept = (extra: Record<string, unknown> = {}) => ({ title: 'Rainy jazz', ...extra });
const saved = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: 'Rainy jazz', isLlmGenerated: true, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getUserSetting).mockResolvedValue(null as never);
  jest.mocked(getPlaylists).mockResolvedValue([{ id: 'old' }] as never);
});

it('returns the first newly saved LLM playlist', async () => {
  jest.mocked(generateCustomPlaylist).mockResolvedValue(concept() as never);
  jest.mocked(getHubCollections).mockResolvedValue([saved('old'), saved('new')] as never);
  await expect(generateCustomHubPlaylist('u1', 'rainy jazz', { retryDelayMs: 0 })).resolves.toMatchObject({ id: 'new' });
  expect(generateCustomPlaylist).toHaveBeenCalledTimes(1);
  expect(jest.mocked(getHubCollections).mock.calls[0][2]).toMatchObject({ llmGenerationSource: 'custom' });
});

it('retries when the LLM returns nothing, then succeeds', async () => {
  jest.mocked(generateCustomPlaylist).mockResolvedValueOnce(null as never).mockResolvedValue(concept() as never);
  jest.mocked(getHubCollections).mockResolvedValue([saved('new')] as never);
  await expect(generateCustomHubPlaylist('u1', 'rainy jazz', { retryDelayMs: 0 })).resolves.toMatchObject({ id: 'new' });
  expect(generateCustomPlaylist).toHaveBeenCalledTimes(2);
});

it('retries a concept the matcher dropped', async () => {
  jest.mocked(generateCustomPlaylist)
    .mockResolvedValueOnce(concept({ dropped: true }) as never)
    .mockResolvedValue(concept() as never);
  jest.mocked(getHubCollections).mockResolvedValue([saved('new')] as never);
  await expect(generateCustomHubPlaylist('u1', 'rainy jazz', { retryDelayMs: 0 })).resolves.toMatchObject({ id: 'new' });
  expect(generateCustomPlaylist).toHaveBeenCalledTimes(2);
});

it('ignores system collections and playlists that already existed', async () => {
  jest.mocked(generateCustomPlaylist).mockResolvedValue(concept() as never);
  jest.mocked(getHubCollections).mockResolvedValue([saved('old'), saved('sys', { isLlmGenerated: false })] as never);
  await expect(generateCustomHubPlaylist('u1', 'rainy jazz', { retryDelayMs: 0 })).resolves.toBeNull();
});

it('gives up after three attempts', async () => {
  jest.mocked(generateCustomPlaylist).mockResolvedValue(null as never);
  await expect(generateCustomHubPlaylist('u1', 'rainy jazz', { retryDelayMs: 0 })).resolves.toBeNull();
  expect(generateCustomPlaylist).toHaveBeenCalledTimes(3);
});

it('passes a requested track count through', async () => {
  jest.mocked(generateCustomPlaylist).mockResolvedValue(concept() as never);
  jest.mocked(getHubCollections).mockResolvedValue([saved('new')] as never);
  await generateCustomHubPlaylist('u1', 'rainy jazz', { tracksPerPlaylist: 25, retryDelayMs: 0 });
  expect(jest.mocked(getHubCollections).mock.calls[0][2]).toMatchObject({ llmTracksPerPlaylist: 25 });
});
