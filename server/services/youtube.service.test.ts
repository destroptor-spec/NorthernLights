/** @jest-environment node */
import * as db from '../database';
import { getMusicVideoForTrack, lookupMusicVideoForTrack, refreshArtistVideosIfStale } from './youtube.service';
import { loadArtistVideoLinks } from './metadata/videoLinks';
import type { VideoUpload, VideoAssociation } from '../database/musicVideos';

jest.mock('../database', () => ({
  getSystemSetting: jest.fn(), getArtistById: jest.fn(), getTracksByArtist: jest.fn(),
  incrementYoutubeApiUsage: jest.fn(), getYoutubeApiUsage: jest.fn(),
  getArtistVideosCache: jest.fn(), getMusicVideosForArtist: jest.fn(),
  getMusicVideoByTrackId: jest.fn(), getTrackById: jest.fn(),
  getArtistVideoUploads: jest.fn(), saveArtistVideoCatalog: jest.fn(), noteArtistVideoFailure: jest.fn(),
  isCompilationArtistName: jest.fn(() => false),
}));
jest.mock('./metadata/videoLinks', () => ({ loadArtistVideoLinks: jest.fn() }));
const mocked = jest.mocked(db);
const originalFetch = global.fetch;
let fetchMock: jest.Mock;
let cache: Record<string, unknown> | null;
let artist: { id: string; name: string; mbid?: string; links: { url: string }[] };
let tracks: { id: string; title: string; mbArtistId?: string }[];
let uploads: VideoUpload[];
let matches: VideoAssociation[];
beforeEach(() => {
  jest.resetAllMocks();
  cache = null; uploads = []; matches = [];
  artist = { id: 'artist', name: 'Artist', links: [{ url: 'https://www.youtube.com/channel/UCtest' }] };
  tracks = [{ id: 'track', title: 'Song' }];
  mocked.getSystemSetting.mockImplementation(async key => ({
    youtubeEnabled: true, youtubeApiKey: 'test-key', youtubeCacheTtlDays: 14,
    youtubeDailyQuotaCap: 9000, youtubeHardStop: true,
  })[key as 'youtubeEnabled'] ?? null);
  mocked.getMusicVideoByTrackId.mockImplementation(async id => {
    const match = matches.find(m => m.trackId === id);
    return match ? { video_id: match.videoId, title: 'Song', thumbnail_url: null } : null;
  });
  mocked.getTrackById.mockResolvedValue({ artistId: 'artist' } as Awaited<ReturnType<typeof db.getTrackById>>);
  mocked.getArtistById.mockImplementation(async () => artist);
  mocked.getArtistVideosCache.mockImplementation(async () => cache);
  mocked.getTracksByArtist.mockImplementation(async () => tracks);
  mocked.getArtistVideoUploads.mockImplementation(async () => uploads);
  mocked.incrementYoutubeApiUsage.mockResolvedValue(1);
  mocked.saveArtistVideoCatalog.mockImplementation(async (_artist, videos, associations, options) => {
    uploads = videos; matches = associations;
    cache = { ...cache, library_key: options.libraryKey };
    if (options.fetched) cache = { ...cache, uploads_cached: true, source_key: options.sourceKey,
      fetched_at: new Date().toISOString(), last_error: null, youtube_channel_id: options.channelId, retry_after: null };
  });
  mocked.noteArtistVideoFailure.mockImplementation(async (_artist, source, reason, retryMs) => {
    cache = { ...cache, attempt_source_key: source, last_error: reason, retry_after: new Date(Date.now() + retryMs).toISOString() };
  });
  jest.mocked(loadArtistVideoLinks).mockResolvedValue(false);
  fetchMock = jest.fn(async (url: string) => ({ ok: true,
    json: async () => url.includes('/channels?')
      ? { items: [{ contentDetails: { relatedPlaylists: { uploads: 'uploads' } } }] }
      : { items: [{ contentDetails: { videoId: 'video' }, snippet: { title: 'Artist - Song (Official Video)' } }] },
  }));
  global.fetch = fetchMock;
});
afterEach(() => { global.fetch = originalFetch; });

test('cold lookup populates matches and concurrent requests share provider calls', async () => {
  const results = await Promise.all([lookupMusicVideoForTrack('track'), lookupMusicVideoForTrack('track')]);
  expect(results).toEqual(Array(2).fill({ status: 'matched', video: { video_id: 'video', title: 'Song', thumbnail_url: null } }));
  expect(mocked.saveArtistVideoCatalog).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('album copies share a video, and newly scanned copies rematch cached uploads without quota', async () => {
  tracks.push({ id: 'copy', title: 'Song (Remastered)' });
  await lookupMusicVideoForTrack('track');
  expect(matches.map(m => m.trackId).sort()).toEqual(['copy', 'track']);
  const fetchedAt = cache!.fetched_at;
  tracks.push({ id: 'new-copy', title: 'Song' });
  expect((await lookupMusicVideoForTrack('new-copy')).video?.video_id).toBe('video');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(cache!.fetched_at).toBe(fetchedAt);
});

test('successful hits return immediately but stale caches refresh in the background', async () => {
  await lookupMusicVideoForTrack('track');
  fetchMock.mockClear();
  await lookupMusicVideoForTrack('track');
  await refreshArtistVideosIfStale('artist');
  expect(fetchMock).not.toHaveBeenCalled();
  cache!.fetched_at = new Date(0).toISOString();
  expect((await lookupMusicVideoForTrack('track')).status).toBe('matched');
  await refreshArtistVideosIfStale('artist');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('temporary errors preserve successful time and matches, then retry after a short cooldown', async () => {
  await lookupMusicVideoForTrack('track');
  cache!.fetched_at = new Date(0).toISOString();
  fetchMock.mockRejectedValueOnce(new Error('network unavailable'));
  await lookupMusicVideoForTrack('track');
  await refreshArtistVideosIfStale('artist').catch(() => {});
  expect(cache!.fetched_at).toBe(new Date(0).toISOString());
  expect(matches).toHaveLength(1);
  const count = fetchMock.mock.calls.length;
  expect((await refreshArtistVideosIfStale('artist')).reason).toBe('temporary-error');
  expect(fetchMock).toHaveBeenCalledTimes(count);
  cache!.retry_after = new Date(0).toISOString();
  expect((await refreshArtistVideosIfStale('artist')).refreshed).toBe(true);
});

test('metadata is resolved using a library MusicBrainz ID before declaring no match', async () => {
  artist.links = [];
  tracks[0].mbArtistId = 'mb-artist';
  jest.mocked(loadArtistVideoLinks).mockImplementation(async () => {
    artist.links = [{ url: 'https://www.youtube.com/channel/UCtest' }];
    return true;
  });
  expect((await lookupMusicVideoForTrack('track')).status).toBe('matched');
  expect(loadArtistVideoLinks).toHaveBeenCalledWith('artist', 'mb-artist');
});

test('missing metadata is pending and newly available links bypass the retry cooldown', async () => {
  artist.links = [];
  expect((await lookupMusicVideoForTrack('track')).status).toBe('pending');
  expect(fetchMock).not.toHaveBeenCalled();
  artist.links = [{ url: 'https://www.youtube.com/channel/UCtest' }];
  expect((await lookupMusicVideoForTrack('track')).status).toBe('matched');
});

test('a new channel link invalidates a fresh no-channel result', async () => {
  artist.links = [{ url: 'https://example.com' }];
  expect((await lookupMusicVideoForTrack('track')).status).toBe('no-match');
  artist.links = [{ url: 'https://www.youtube.com/channel/UCtest' }];
  expect((await lookupMusicVideoForTrack('track')).status).toBe('matched');
});

test('a slow cold lookup returns pending while shared work continues', async () => {
  const result = await lookupMusicVideoForTrack('track', 1);
  expect(result.status).toBe('pending');
  await refreshArtistVideosIfStale('artist');
  expect((await getMusicVideoForTrack('track'))?.video_id).toBe('video');
  await refreshArtistVideosIfStale('artist');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('disabled integration and exhausted budget never call YouTube', async () => {
  mocked.incrementYoutubeApiUsage.mockResolvedValue(null);
  expect((await lookupMusicVideoForTrack('track')).status).toBe('temporary-error');
  expect(fetchMock).not.toHaveBeenCalled();
  mocked.getSystemSetting.mockResolvedValue(false);
  expect((await lookupMusicVideoForTrack('track')).status).toBe('disabled');
});
