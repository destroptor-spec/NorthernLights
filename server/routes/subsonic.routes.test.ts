jest.mock('music-metadata', () => ({}), { virtual: true });
jest.mock('../database', () => ({
  initDB: jest.fn(),
  touchSubsonicApiKey: jest.fn(),
  getActiveSubsonicApiKeyByPrefix: jest.fn(),
  updateSubsonicApiKeyHash: jest.fn(),
  getPlaylists: jest.fn(),
  getPlaylistTracks: jest.fn(),
  getPlaylistMeta: jest.fn(),
  createPlaylist: jest.fn(),
  addTracksToPlaylist: jest.fn(),
  deletePlaylist: jest.fn(),
  recordPlaybackForUser: jest.fn(),
  setTrackLovedForUser: jest.fn(),
  setTrackRatingForUser: jest.fn(),
  getUserSetting: jest.fn(),
  setUserSetting: jest.fn(),
  getSystemSetting: jest.fn(),
  getArtworkInfoForPath: jest.fn(),
}));
jest.mock('../state', () => ({
  isPathAllowed: jest.fn(),
  pathToBuffer: jest.fn(),
}));
jest.mock('../services/hlsStream.service', () => ({
  getOrCreateHlsSession: jest.fn(),
  getSessionInfo: jest.fn(),
  touchSession: jest.fn(),
  getSessionOutputDir: jest.fn(),
}));
jest.mock('../services/scopedToken.service', () => ({
  generateScopedToken: jest.fn(),
  verifyScopedToken: jest.fn(),
}));
jest.mock('../services/debugLogger.service', () => ({
  writeDebugLog: jest.fn(),
}));
jest.mock('../services/lastfm.service', () => ({
  scrobbleTracks: jest.fn(),
  updateNowPlaying: jest.fn(),
}));
jest.mock('../services/listenbrainz.service', () => ({
  scrobbleTracks: jest.fn(),
  updateNowPlaying: jest.fn(),
}));
jest.mock('../services/artworkFallback.service', () => ({
  providerArtworkProxyPath: jest.fn(),
  resolveProviderArtworkUrl: jest.fn(),
}));
jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('../services/loggingConfig', () => ({
  logFfmpeg: jest.fn(),
  logHls: jest.fn(),
}));

import {
  buildAlbumListPayload,
  buildSearchPayload,
  buildSubsonicScrobbleEvents,
  buildStructuredLyrics,
  buildSubsonicUser,
  buildSubsonicXml,
  isSubsonicProviderScrobbleBridgeEnabled,
  isSubsonicSubmission,
  mapAlbum,
  buildTranscodeArgs,
  describeRangeHeader,
  parseTimeOffset,
  resolveStreamPlan,
  mapArtist,
  mapTrackToSubsonic,
  normalizeSearchQuery,
  openSubsonicExtensionsPayload,
  parseSubsonicAuthParams,
  queueProviderScrobbleReports,
  sendProviderScrobbleReports,
  subsonicError,
  subsonicSuccess,
} from './subsonic.routes';

const databaseMock = jest.requireMock('../database') as { getUserSetting: jest.Mock };
const lastFmMock = jest.requireMock('../services/lastfm.service') as { scrobbleTracks: jest.Mock; updateNowPlaying: jest.Mock };
const listenBrainzMock = jest.requireMock('../services/listenbrainz.service') as { scrobbleTracks: jest.Mock; updateNowPlaying: jest.Mock };
const debugLoggerMock = jest.requireMock('../services/debugLogger.service') as { writeDebugLog: jest.Mock };
const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('subsonic route helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('accepts API-key-only auth params', () => {
    expect(parseSubsonicAuthParams({ apiKey: 'aurora_sub_test' })).toEqual({ apiKey: 'aurora_sub_test' });
    expect(parseSubsonicAuthParams({ api_key: 'aurora_sub_test' })).toEqual({ apiKey: 'aurora_sub_test' });
  });

  it('rejects unsupported and conflicting auth params with OpenSubsonic codes', () => {
    expect(parseSubsonicAuthParams({ u: 'alice', p: 'secret' }).error?.code).toBe(41);
    expect(parseSubsonicAuthParams({ t: 'token', s: 'salt' }).error?.code).toBe(42);
    expect(parseSubsonicAuthParams({ apiKey: 'aurora_sub_test', u: 'alice' }).error?.code).toBe(43);
    expect(parseSubsonicAuthParams({}).error?.code).toBe(43);
  });

  it('advertises apiKeyAuthentication so clients can discover apiKey auth before logging in', () => {
    const payload = openSubsonicExtensionsPayload();
    const extensions = (payload.openSubsonicExtensions as any).extension as Array<{ name: string; versions: number[] }>;
    const names = extensions.map((e) => e.name);
    expect(names).toContain('apiKeyAuthentication');
    expect(names).toContain('formPost');
    // The extensions list must be self-contained (no auth context) so the
    // endpoint can be served before authentication, per the OpenSubsonic spec.
    expect(extensions.every((e) => Array.isArray(e.versions) && e.versions.length > 0)).toBe(true);
  });

  it('treats the Subsonic match-all query ("" / empty / whitespace) as an empty query for full-library sync', () => {
    // Symfonium (compatibility mode OFF) enumerates the library via search3
    // with query="", which arrives as the literal two characters "".
    expect(normalizeSearchQuery('""')).toBe('');
    expect(normalizeSearchQuery("''")).toBe('');
    expect(normalizeSearchQuery('')).toBe('');
    expect(normalizeSearchQuery('   ')).toBe('');
    expect(normalizeSearchQuery(undefined)).toBe('');
    // A real query is preserved; wrapping quotes are stripped, inner text kept.
    expect(normalizeSearchQuery('rock')).toBe('rock');
    expect(normalizeSearchQuery('"hello world"')).toBe('hello world');
    expect(normalizeSearchQuery('  beatles ')).toBe('beatles');
  });

  it('advertises songLyrics and indexBasedQueue alongside apiKey auth', () => {
    const names = ((openSubsonicExtensionsPayload().openSubsonicExtensions as any).extension as any[]).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['apiKeyAuthentication', 'formPost', 'songLyrics', 'indexBasedQueue']));
  });

  it('maps user role to Subsonic capability flags (admin gets adminRole/settingsRole)', () => {
    const admin = buildSubsonicUser('root', 'admin');
    expect(admin).toMatchObject({ username: 'root', adminRole: true, settingsRole: true, streamRole: true, scrobblingEnabled: true });
    const user = buildSubsonicUser('alice', 'user');
    expect(user).toMatchObject({ username: 'alice', adminRole: false, settingsRole: false, downloadRole: true, playlistRole: true });
    // Out-of-scope server-side features are off; no legacy/admin-over-Subsonic.
    expect(user.podcastRole).toBe(false);
    expect(user.shareRole).toBe(false);
    expect(user.jukeboxRole).toBe(false);
  });

  it('builds structuredLyrics for synced and unsynced embedded lyrics', () => {
    const synced = buildStructuredLyrics(
      [{ language: 'eng', syncText: [{ timestamp: 0, text: 'one' }, { timestamp: 1500, text: 'two' }] }],
      'Artist', 'Title',
    );
    expect(synced).toHaveLength(1);
    expect(synced[0]).toMatchObject({ displayArtist: 'Artist', displayTitle: 'Title', lang: 'eng', synced: true });
    expect((synced[0] as any).line).toEqual([{ start: 0, value: 'one' }, { start: 1500, value: 'two' }]);

    const unsynced = buildStructuredLyrics([{ text: 'line a\r\nline b' }], 'A', 'T');
    expect(unsynced[0]).toMatchObject({ synced: false, lang: 'und' });
    expect((unsynced[0] as any).line).toEqual([{ value: 'line a' }, { value: 'line b' }]);

    // No lyric tags → no structured entries (caller returns empty lyricsList).
    expect(buildStructuredLyrics([])).toEqual([]);
    expect(buildStructuredLyrics([{ text: '   ' }])).toEqual([]);
  });

  it('builds standard success and error envelopes', () => {
    const ok = subsonicSuccess({ ping: true });
    expect(ok['subsonic-response']).toMatchObject({
      status: 'ok',
      version: '1.16.1',
      type: 'aurora',
      openSubsonic: true,
      ping: true,
    });

    const failed = subsonicError(44, 'Invalid key');
    expect(failed['subsonic-response']).toMatchObject({
      status: 'failed',
      error: { code: 44, message: 'Invalid key' },
    });
  });

  it('parses scrobble submissions and repeated id/time params', () => {
    const playedAt = new Date('2026-06-12T10:11:12.000Z');
    const encoded = Buffer.from('track/with+chars', 'utf8').toString('base64url');
    const events = buildSubsonicScrobbleEvents(
      [`song:v1:${encoded}`, 'song:legacy-track', 'raw-track', ''],
      [String(playedAt.getTime()), '', 'not-a-time', '123'],
    );

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      rawId: `song:v1:${encoded}`,
      trackId: 'track/with+chars',
      timestamp: Math.floor(playedAt.getTime() / 1000),
    });
    expect(events[0].playedAt?.toISOString()).toBe('2026-06-12T10:11:12.000Z');
    expect(events[1]).toMatchObject({ rawId: 'song:legacy-track', trackId: 'legacy-track' });
    expect(events[2]).toMatchObject({ rawId: 'raw-track', trackId: 'raw-track' });
    expect(events[2].playedAt).toBeUndefined();
  });

  it('distinguishes Subsonic scrobble submissions from now-playing notifications', () => {
    expect(isSubsonicSubmission(undefined)).toBe(true);
    expect(isSubsonicSubmission('true')).toBe(true);
    expect(isSubsonicSubmission('1')).toBe(true);
    expect(isSubsonicSubmission('false')).toBe(false);
    expect(isSubsonicSubmission('0')).toBe(false);
  });

  it('keeps the Subsonic provider scrobble bridge opt-in per user', async () => {
    databaseMock.getUserSetting.mockResolvedValueOnce(null);
    await expect(isSubsonicProviderScrobbleBridgeEnabled('user-1')).resolves.toBe(false);

    databaseMock.getUserSetting.mockResolvedValueOnce('true');
    await expect(isSubsonicProviderScrobbleBridgeEnabled('user-1')).resolves.toBe(true);

    expect(databaseMock.getUserSetting).toHaveBeenCalledWith('user-1', 'subsonicProviderScrobbleEnabled');
  });

  it('queues provider scrobble forwarding without waiting for the provider request', async () => {
    databaseMock.getUserSetting.mockImplementation(async (_userId: string, key: string) => (
      ['subsonicProviderScrobbleEnabled', 'lastFmConnected', 'lastFmScrobbleEnabled'].includes(key)
    ));
    let resolveProvider: (value: unknown) => void = () => {};
    lastFmMock.scrobbleTracks.mockReturnValueOnce(new Promise((resolve) => { resolveProvider = resolve; }));

    expect(queueProviderScrobbleReports('user-1', [{ artist: 'Artist', track: 'Title' } as any], true)).toBeUndefined();
    await flushPromises();

    expect(lastFmMock.scrobbleTracks).toHaveBeenCalledWith('user-1', [{ artist: 'Artist', track: 'Title' }]);
    expect(listenBrainzMock.scrobbleTracks).not.toHaveBeenCalled();

    resolveProvider({ status: 'ok' });
    await flushPromises();
  });

  it('contains and logs provider bridge failures', async () => {
    databaseMock.getUserSetting.mockImplementation(async (_userId: string, key: string) => (
      ['subsonicProviderScrobbleEnabled', 'lastFmConnected', 'lastFmScrobbleEnabled'].includes(key)
    ));
    lastFmMock.scrobbleTracks.mockRejectedValueOnce(new Error('provider offline'));

    await expect(sendProviderScrobbleReports('user-1', [{ artist: 'Artist', track: 'Title' } as any], true)).resolves.toBeUndefined();

    expect(debugLoggerMock.writeDebugLog).toHaveBeenCalledWith(
      'subsonic-api.log',
      expect.stringContaining('provider_error provider=lastfm action=scrobble count=1 message=provider offline'),
    );
  });

  it('serializes XML response metadata and nested errors', () => {
    const xml = buildSubsonicXml(subsonicError(41, 'Use API keys'));
    expect(xml).toContain('<subsonic-response');
    expect(xml).toContain('status="failed"');
    expect(xml).toContain('version="1.16.1"');
    expect(xml).toContain('<error code="41" message="Use API keys"></error>');
  });

  it('maps Aurora tracks to Subsonic song fields without leaking file paths', () => {
    const song = mapTrackToSubsonic({
      id: 'track/with+unsafe=chars',
      path: '/music/Artist/Album/song.flac',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      artist_id: 'artist-1',
      album_id: 'album-1',
      duration: 123.4,
      bitrate: 960000,
      track_number: 2,
      genre: 'Ambient',
      is_loved: true,
      user_rating: 5,
    });

    expect(song).toMatchObject({
      parent: 'album:album-1',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      artistId: 'artist:artist-1',
      albumId: 'album:album-1',
      duration: 123,
      bitRate: 960,
      track: 2,
      genre: 'Ambient',
      contentType: 'audio/flac',
      userRating: 5,
    });
    expect(song.id).toMatch(/^song:v1:[A-Za-z0-9_-]+$/);
    expect(song.coverArt).toBe(song.id);
    expect(song.id).not.toContain('/');
    expect(song.id).not.toContain('+');
    expect(song.id).not.toContain('=');
    expect(song.path).toBeUndefined();
    expect(song.starred).toBeDefined();
  });

  it('uses zero duration for tracks with missing duration so sync clients receive an integer', () => {
    const song = mapTrackToSubsonic({
      id: 'track-1',
      path: '/music/Artist/Album/song.mp3',
      title: 'Song',
      duration: null,
    });

    expect(song.duration).toBe(0);
  });

  it('derives a valid slash-free suffix and correct contentType from the base64-encoded path', () => {
    const b64 = (p: string) => Buffer.from(p, 'utf8').toString('base64');
    const cases = [
      { path: '/music/A/B/song.mp3', format: 'MPEG', suffix: 'mp3', contentType: 'audio/mpeg' },
      { path: '/music/A/B/song.m4a', format: 'M4A/mp42/isom', suffix: 'm4a', contentType: 'audio/mp4' },
      { path: '/music/A/B/song.wma', format: 'ASF/audio', suffix: 'wma', contentType: 'audio/x-ms-wma' },
      { path: '/music/A/B/song.wav', format: 'WAVE', suffix: 'wav', contentType: 'audio/wav' },
      { path: '/music/A/B/song.flac', format: 'FLAC', suffix: 'flac', contentType: 'audio/flac' },
    ];
    for (const c of cases) {
      const song = mapTrackToSubsonic({ id: 't', path: b64(c.path), format: c.format, title: 'x' });
      expect(song.suffix).toBe(c.suffix);
      expect(String(song.suffix)).not.toContain('/');
      expect(song.contentType).toBe(c.contentType);
    }
  });

  it('emits size from file_size and created from file_mtime (BIGINT comes back as a string from pg)', () => {
    const b64 = Buffer.from('/music/A/B/song.mp3', 'utf8').toString('base64');
    const song = mapTrackToSubsonic({
      id: 't', path: b64, format: 'MPEG', title: 'x',
      file_size: '7654321',      // pg returns BIGINT as a string
      file_mtime: '1700000000000',
    });
    expect(song.size).toBe(7654321);
    expect(typeof song.size).toBe('number');
    expect(song.created).toBe(new Date(1700000000000).toISOString());
  });

  it('falls back to a slash-free suffix from the container name when a track has no path', () => {
    const song = mapTrackToSubsonic({ id: 't', path: null, format: 'M4A/mp42/isom', title: 'x' });
    expect(song.suffix).toBe('m4a');
    expect(String(song.suffix)).not.toContain('/');
    expect(song.contentType).toBe('audio/mp4');
  });

  it('includes a title on artist directory entries for directory-browsing clients', () => {
    const artist = mapArtist({ id: 'artist-1', name: 'Artist' }, 3);

    expect(artist).toMatchObject({
      id: 'artist:artist-1',
      name: 'Artist',
      title: 'Artist',
      albumCount: 3,
    });
  });

  it('maps Aurora albums to ID3 album fields expected by sync clients', () => {
    const album = mapAlbum({
      id: 'album-1',
      title: 'Album',
      artist_name: 'Artist',
      artist_id: 'artist-1',
      song_count: 12,
      duration: 3600,
      play_count: 4,
      release_year: 2001,
      genre: 'Rock',
    });

    expect(album).toMatchObject({
      id: 'album:album-1',
      album: 'Album',
      name: 'Album',
      title: 'Album',
      artist: 'Artist',
      artistId: 'artist:artist-1',
      songCount: 12,
      duration: 3600,
      playCount: 4,
      year: 2001,
      genre: 'Rock',
      isDir: true,
    });
  });

  it('returns only the response root matching album-list method variants', () => {
    const legacy = buildAlbumListPayload('getalbumlist', [{ id: 'album-1', title: 'Album' }]);
    const id3 = buildAlbumListPayload('getalbumlist2', [{ id: 'album-1', title: 'Album' }]);

    expect(legacy).toHaveProperty('albumList');
    expect(legacy).not.toHaveProperty('albumList2');
    expect(id3).toHaveProperty('albumList2');
    expect(id3).not.toHaveProperty('albumList');
  });

  it('returns only the response root matching search method variants', () => {
    const result = { artist: [], album: [], song: [] };

    expect(buildSearchPayload('search', result)).toHaveProperty('searchResult');
    expect(buildSearchPayload('search2', result)).toHaveProperty('searchResult2');
    expect(buildSearchPayload('search3', result)).toHaveProperty('searchResult3');
    expect(buildSearchPayload('search3', result)).not.toHaveProperty('searchResult2');
  });
});

/**
 * `stream.view` transcoding, driven by the Subsonic spec's `maxBitRate`
 * ("attempt to limit the bitrate to this value... If set to zero, no limit is
 * imposed") and `format` ("raw" disables transcoding). Clients surface this as
 * a per-network quality setting: Symfonium's "Original" must keep getting the
 * untouched file, while a cellular setting of e.g. 320 asks for a transcode.
 */
describe('resolveStreamPlan', () => {
  const flac = { suffix: 'flac', bitrateKbps: 1411 };
  const mp3v0 = { suffix: 'mp3', bitrateKbps: 192 };

  describe('serves the original file', () => {
    it('when no quality parameters are sent at all ("Original")', () => {
      const plan = resolveStreamPlan(flac, {});
      expect(plan.mode).toBe('direct');
      expect(plan.suffix).toBe('flac');
      expect(plan.contentType).toBe('audio/flac');
    });

    it('when maxBitRate is zero, which the spec defines as no limit', () => {
      expect(resolveStreamPlan(flac, { maxBitRate: '0' }).mode).toBe('direct');
    });

    it('when format=raw, even alongside a bitrate cap', () => {
      const plan = resolveStreamPlan(flac, { maxBitRate: '320', format: 'raw' });
      expect(plan.mode).toBe('direct');
      expect(plan.reason).toBe('format=raw');
    });

    it('when the source already fits under the cap', () => {
      const plan = resolveStreamPlan(mp3v0, { maxBitRate: '320' });
      expect(plan.mode).toBe('direct');
      expect(plan.reason).toContain('within-cap');
    });

    it('when the requested format is what the source already is', () => {
      expect(resolveStreamPlan(mp3v0, { format: 'mp3' }).mode).toBe('direct');
    });

    it('when maxBitRate is not a number', () => {
      expect(resolveStreamPlan(flac, { maxBitRate: 'high' }).mode).toBe('direct');
    });
  });

  describe('transcodes', () => {
    it('lossless down to a cellular cap, defaulting to mp3', () => {
      const plan = resolveStreamPlan(flac, { maxBitRate: '320' });
      expect(plan.mode).toBe('transcode');
      expect(plan.bitrateKbps).toBe(320);
      expect(plan.suffix).toBe('mp3');
      expect(plan.codec).toBe('libmp3lame');
      expect(plan.container).toBe('mp3');
      expect(plan.contentType).toBe('audio/mpeg');
    });

    it('to a lower cap than the source bitrate', () => {
      const plan = resolveStreamPlan(mp3v0, { maxBitRate: '128' });
      expect(plan.mode).toBe('transcode');
      expect(plan.bitrateKbps).toBe(128);
    });

    it('to an explicitly requested format', () => {
      const plan = resolveStreamPlan(flac, { maxBitRate: '128', format: 'opus' });
      expect(plan.mode).toBe('transcode');
      expect(plan.suffix).toBe('opus');
      expect(plan.codec).toBe('libopus');
      expect(plan.container).toBe('ogg');
    });

    it('on a format change alone, with no cap', () => {
      const plan = resolveStreamPlan(flac, { format: 'mp3' });
      expect(plan.mode).toBe('transcode');
      expect(plan.bitrateKbps).toBe(320);
    });

    // MP4 needs a seekable output, so m4a is served as ADTS AAC over a pipe.
    it('m4a as streamable ADTS AAC', () => {
      const plan = resolveStreamPlan(flac, { maxBitRate: '256', format: 'm4a' });
      expect(plan.container).toBe('adts');
      expect(plan.suffix).toBe('aac');
      expect(plan.codec).toBe('aac');
    });

    it('falls back rather than failing on an unsupported format', () => {
      const plan = resolveStreamPlan(flac, { maxBitRate: '192', format: 'flv' });
      expect(plan.mode).toBe('transcode');
      expect(plan.suffix).toBe('mp3');
    });

    it('caps the default bitrate when the source bitrate is unknown', () => {
      const plan = resolveStreamPlan({ suffix: 'flac', bitrateKbps: null }, { format: 'mp3' });
      expect(plan.bitrateKbps).toBe(320);
    });
  });
});

/**
 * These exact argument lists were run against a real 1696kbps FLAC and probed:
 * mp3 320079bps, opus 133335bps, vorbis 186308bps, aac 250515bps — every
 * container pipes to stdout without a seekable output.
 */
describe('buildTranscodeArgs', () => {
  const plan = (over: Partial<ReturnType<typeof resolveStreamPlan>>) => ({
    ...resolveStreamPlan({ suffix: 'flac', bitrateKbps: 1411 }, { maxBitRate: '320' }),
    ...over,
  });

  it('drops video so embedded cover art cannot break the container', () => {
    const args = buildTranscodeArgs('/music/track.flac', plan({}));
    expect(args).toContain('-vn');
    expect(args.join(' ')).toContain('-map 0:a:0');
  });

  it('writes to stdout with the planned codec, bitrate and container', () => {
    const args = buildTranscodeArgs('/music/track.flac', plan({}));
    expect(args.join(' ')).toBe(
      '-i /music/track.flac -vn -map 0:a:0 -c:a libmp3lame -b:a 320k -id3v2_version 3 -f mp3 -',
    );
  });

  it('tags mp3 with id3v2.3 for client compatibility, and nothing else', () => {
    const mp3 = buildTranscodeArgs('/a.flac', plan({}));
    const opus = buildTranscodeArgs('/a.flac', plan({ codec: 'libopus', container: 'ogg' }));
    expect(mp3).toContain('-id3v2_version');
    expect(opus).not.toContain('-id3v2_version');
    expect(opus.join(' ')).toBe('-i /a.flac -vn -map 0:a:0 -c:a libopus -b:a 320k -f ogg -');
  });

  it('passes the source path through untouched so odd filenames survive', () => {
    const args = buildTranscodeArgs("/music/Sean Paul - Dynamite (Banx N' Ranx).flac", plan({}));
    expect(args[1]).toBe("/music/Sean Paul - Dynamite (Banx N' Ranx).flac");
  });
});

/**
 * OpenSubsonic's `transcodeOffset` extension: "When a server support this
 * extension this means that it support the `timeOffset` parameter of the
 * stream endpoint for music" — which is what lets a client seek inside a
 * transcoded stream, since a pipe offers no byte range to seek into.
 *
 * Seek accuracy was measured against a real 141.63s library FLAC by counting
 * decoded AAC frames rather than trusting ffprobe: at a 90s offset the output
 * is 2225 frames x 1024 / 44100 = 51.66s against 51.63s expected. Raw ADTS has
 * no container duration field, so ffprobe's estimate for it is off by seconds
 * and must not be used to judge this.
 */
describe('transcodeOffset extension', () => {
  it('is advertised so clients know seeking is possible', () => {
    const payload = openSubsonicExtensionsPayload() as {
      openSubsonicExtensions: { extension: Array<{ name: string; versions: number[] }> };
    };
    const names = payload.openSubsonicExtensions.extension.map((e) => e.name);
    expect(names).toContain('transcodeOffset');
    const ext = payload.openSubsonicExtensions.extension.find((e) => e.name === 'transcodeOffset');
    expect(ext?.versions).toEqual([1]);
  });

  describe('parseTimeOffset', () => {
    it('treats an absent, empty or non-numeric offset as no seek', () => {
      expect(parseTimeOffset(undefined)).toBe(0);
      expect(parseTimeOffset('')).toBe(0);
      expect(parseTimeOffset('halfway')).toBe(0);
    });

    it('treats zero and negative offsets as no seek', () => {
      expect(parseTimeOffset('0')).toBe(0);
      expect(parseTimeOffset('-30')).toBe(0);
    });

    it('accepts a fractional offset', () => {
      expect(parseTimeOffset('90.5', 141.63)).toBeCloseTo(90.5, 3);
    });

    // Seeking past the end would hand the client an empty stream.
    it('clamps an offset beyond the track to just before the end', () => {
      expect(parseTimeOffset('500', 141.63)).toBeCloseTo(140.63, 3);
    });

    it('passes the offset through when the duration is unknown', () => {
      expect(parseTimeOffset('90', null)).toBe(90);
      expect(parseTimeOffset('90', 0)).toBe(90);
    });
  });

  describe('buildTranscodeArgs with an offset', () => {
    const plan = resolveStreamPlan({ suffix: 'flac', bitrateKbps: 1411 }, { maxBitRate: '320' });

    // `-ss` must precede `-i`, or FFmpeg decodes and discards everything before
    // the offset instead of skipping to it.
    it('seeks on the input, not the output', () => {
      const args = buildTranscodeArgs('/music/track.flac', plan, 90);
      expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
      expect(args[args.indexOf('-ss') + 1]).toBe('90');
    });

    it('omits the seek entirely when there is no offset', () => {
      expect(buildTranscodeArgs('/music/track.flac', plan, 0)).not.toContain('-ss');
      expect(buildTranscodeArgs('/music/track.flac', plan)).not.toContain('-ss');
    });

    it('still writes to stdout with the planned encoding', () => {
      expect(buildTranscodeArgs('/a.flac', plan, 60).join(' ')).toBe(
        '-ss 60 -i /a.flac -vn -map 0:a:0 -c:a libmp3lame -b:a 320k -id3v2_version 3 -f mp3 -',
      );
    });
  });
});

/**
 * The stream log previously recorded range as yes/no, which could not tell an
 * opening `bytes=0-` from a real byte-seek — the distinction that matters when
 * a client scrubs a transcoded stream, since a pipe has no byte space to seek
 * within. Symfonium was observed sending Range on transcodes without ever
 * sending the spec's `timeOffset`, and yes/no could not say which it meant.
 */
describe('describeRangeHeader', () => {
  it('distinguishes an opening request from a byte-seek', () => {
    expect(describeRangeHeader('bytes=0-')).toBe('bytes=0-');
    expect(describeRangeHeader('bytes=1048576-')).toBe('bytes=1048576-');
    expect(describeRangeHeader('bytes=0-1023')).toBe('bytes=0-1023');
  });

  it('reports an absent header rather than an empty field', () => {
    expect(describeRangeHeader(undefined)).toBe('none');
    expect(describeRangeHeader('')).toBe('none');
    expect(describeRangeHeader(null)).toBe('none');
    expect(describeRangeHeader(['bytes=0-'])).toBe('none');
  });

  it('keeps multi-range requests legible', () => {
    expect(describeRangeHeader('bytes=0-99,200-299')).toBe('bytes=0-99,200-299');
  });

  // The header is attacker-controlled and lands in a log file, so it must not
  // be able to forge a new record or break the key=value format.
  it('cannot inject a new log record or break the line format', () => {
    const injected = describeRangeHeader('bytes=0-\n[2026-01-01T00:00:00Z] stream id=forged mode=direct');
    expect(injected).not.toContain('\n');
    expect(injected).not.toContain(' ');
    expect(injected.length).toBeLessThanOrEqual(64);
  });

  it('caps an over-long header', () => {
    expect(describeRangeHeader('bytes=' + '9'.repeat(500)).length).toBe(64);
  });

  it('flags anything that is not a byte range rather than echoing it', () => {
    expect(describeRangeHeader('items=0-10')).toBe('malformed');
    expect(describeRangeHeader('../../etc/passwd')).toBe('malformed');
  });
});
