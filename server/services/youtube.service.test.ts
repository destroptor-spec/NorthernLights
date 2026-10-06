/** @jest-environment node */
import * as db from '../database';
import { getMusicVideoForTrack } from './youtube.service';

jest.mock('../database', () => ({
  getSystemSetting: jest.fn(), getArtistById: jest.fn(), getTracksByArtist: jest.fn(),
  incrementYoutubeApiUsage: jest.fn(), getYoutubeApiUsage: jest.fn(),
  upsertArtistVideosCache: jest.fn(), getArtistVideosCache: jest.fn(),
  replaceArtistVideos: jest.fn(), getMusicVideosForArtist: jest.fn(),
  getMusicVideoByTrackId: jest.fn(), getTrackById: jest.fn(),
  isCompilationArtistName: jest.fn(() => false),
}));

const mocked = jest.mocked(db);
const originalFetch = global.fetch;
let fetchMock: jest.Mock;
let cached: { video_id: string } | null;
beforeEach(() => {
  jest.clearAllMocks();
  cached = null;
  mocked.getSystemSetting.mockImplementation(async key => ({
    youtubeEnabled: true, youtubeApiKey: 'test-key', youtubeCacheTtlDays: 14,
    youtubeDailyQuotaCap: 9000, youtubeHardStop: true,
  })[key as 'youtubeEnabled'] ?? null);
  mocked.getMusicVideoByTrackId.mockImplementation(async () => cached);
  mocked.getTrackById.mockResolvedValue({ artistId: 'artist' } as Awaited<ReturnType<typeof db.getTrackById>>);
  mocked.getArtistById.mockResolvedValue({ name: 'Artist', links: [{ url: 'https://www.youtube.com/channel/UCtest', type: 'youtube' }] });
  mocked.getArtistVideosCache.mockResolvedValue(null);
  mocked.getTracksByArtist.mockResolvedValue([{ id: 'track', title: 'Song' }]);
  mocked.incrementYoutubeApiUsage.mockResolvedValue(1);
  mocked.replaceArtistVideos.mockImplementation(async (_artist, videos) => {
    cached = videos[0] ? { video_id: videos[0].video_id } : null;
  });
  fetchMock = jest.fn(async (url: string) => ({
    ok: true,
    json: async () => url.includes('/channels?')
      ? { items: [{ contentDetails: { relatedPlaylists: { uploads: 'uploads' } } }] }
      : { items: [{ contentDetails: { videoId: 'video' }, snippet: { title: 'Artist - Song (Official Video)' } }] },
  }));
  global.fetch = fetchMock;
});
afterEach(() => { global.fetch = originalFetch; });

test('Now Playing populates a cold artist cache and returns the matched video', async () => {
  await expect(getMusicVideoForTrack('track')).resolves.toEqual({ video_id: 'video' });
  expect(mocked.replaceArtistVideos).toHaveBeenCalledWith('artist', [expect.objectContaining({ video_id: 'video', track_id: 'track' })]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(mocked.incrementYoutubeApiUsage).toHaveBeenCalledWith({ cap: 9000, units: 1 });
});

test('an existing track match does not spend quota', async () => {
  cached = { video_id: 'cached' };
  await expect(getMusicVideoForTrack('track')).resolves.toEqual(cached);
  expect(mocked.getTrackById).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('concurrent misses for the same artist share one refresh', async () => {
  const results = await Promise.all([getMusicVideoForTrack('track'), getMusicVideoForTrack('track')]);
  expect(results).toEqual([{ video_id: 'video' }, { video_id: 'video' }]);
  expect(mocked.replaceArtistVideos).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('fresh negative artist cache does not trigger another provider request', async () => {
  mocked.getArtistVideosCache.mockResolvedValue({ fetched_at: new Date().toISOString(), videos_count: 0 });
  await expect(getMusicVideoForTrack('track')).resolves.toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('exhausted daily quota falls back to cover without a YouTube request', async () => {
  mocked.incrementYoutubeApiUsage.mockResolvedValue(null);
  await expect(getMusicVideoForTrack('track')).resolves.toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  // A failed shared refresh is released so a later attempt can recover.
  mocked.incrementYoutubeApiUsage.mockResolvedValue(1);
  await expect(getMusicVideoForTrack('track')).resolves.toEqual({ video_id: 'video' });
});

test('disabled integration does not read or refresh matches', async () => {
  mocked.getSystemSetting.mockResolvedValue(false);
  await expect(getMusicVideoForTrack('track')).resolves.toBeNull();
  expect(mocked.getMusicVideoByTrackId).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('missing artist metadata falls back without spending quota', async () => {
  mocked.getArtistById.mockResolvedValue({ name: 'Artist', links: [] });
  await expect(getMusicVideoForTrack('track')).resolves.toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(mocked.upsertArtistVideosCache).not.toHaveBeenCalled();
});
