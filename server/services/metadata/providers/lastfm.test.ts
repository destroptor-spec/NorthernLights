/**
 * @jest-environment node
 */
import { lastFmAlbumInfo, lastFmArtistInfo, lastFmArtistTopTags, lastFmArtistTopTracks } from './lastfm';
import { fetchWithRetry } from '../rateLimiter';

jest.mock('../rateLimiter', () => ({
  lastFmThrottle: { run: (task: () => Promise<unknown>) => task() },
  fetchWithRetry: jest.fn(),
}));

const answer = (body: unknown) => jest.mocked(fetchWithRetry).mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }));

beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

describe('Last.fm "not found" (error 6)', () => {
  // A normal miss: thrown as a failure, it stopped the artist image backfill
  // after ~100 artists and left those artists unstamped.
  it('is no result, not a failure', async () => {
    answer({ error: 6, message: 'The artist you supplied could not be found' });
    await expect(lastFmArtistInfo('Nobody', 'key')).resolves.toBeNull();
    await expect(lastFmArtistTopTags('Nobody', 'key')).resolves.toBeNull();
    await expect(lastFmArtistTopTracks('Nobody', 'key')).resolves.toEqual([]);
    answer({ error: 6, message: 'Album not found' });
    await expect(lastFmAlbumInfo('Nothing', 'Nobody', 'key')).resolves.toBeNull();
  });

  it('keeps other errors as failures and a rate limit as a rate limit', async () => {
    answer({ error: 10, message: 'Invalid API key' });
    await expect(lastFmArtistInfo('Usher', 'key')).rejects.toMatchObject({ provider: 'lastfm', message: 'Invalid API key' });
    answer({ error: 29, message: 'Rate limit exceeded' });
    await expect(lastFmArtistInfo('Usher', 'key')).rejects.toMatchObject({ name: 'RateLimitError' });
  });
});
