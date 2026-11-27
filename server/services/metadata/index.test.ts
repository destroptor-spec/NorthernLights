/**
 * @jest-environment node
 */
import { clearDiscArtCacheForTests, getAlbumDiscArt, getAlbumImage, getAlbumRecordingPlaces, getArtistData, getArtistTopTracks } from './index';
import { initDB, getRepresentativeReleaseMbid, getStoredRecordingPlaces, getSystemSetting, storeRecordingPlaces } from '../../database';
import { getCachedAlbum, getCachedArtist, upsertAlbumCache, upsertArtistCache } from './cache';
import { geniusSearch, geniusGetArtist } from './providers/genius';
import { lastFmArtistTopTracks, lastFmAlbumInfo, lastFmArtistInfo, lastFmArtistTopTags, extractLastFmImage } from './providers/lastfm';
import { mbGetAlbumCover, mbGetArtist, mbGetReleaseGroupCover, mbReleaseGroupOfRelease, mbReleaseRecordingPlaces, mbSearchReleaseGroup } from './providers/musicbrainz';
import { tadbAlbumByReleaseGroup, tadbArtistByMbid, tadbSearchArtist, tadbSearchAlbum } from './providers/theaudiodb';
import { fanartAlbum, fanartArtist } from './providers/fanarttv';
import { ProviderError, RateLimitError } from './errors';

jest.mock('../../database', () => ({
  getSystemSetting: jest.fn(),
  initDB: jest.fn(),
  getStoredRecordingPlaces: jest.fn(),
  storeRecordingPlaces: jest.fn(async () => {}),
  getRepresentativeReleaseMbid: jest.fn(),
}));
jest.mock('./cache', () => ({
  getCachedArtist: jest.fn(),
  upsertArtistCache: jest.fn(async () => {}),
  getCachedAlbum: jest.fn(async () => null),
  upsertAlbumCache: jest.fn(async () => {}),
  isCacheFresh: jest.requireActual('./cache').isCacheFresh,
}));
jest.mock('./providers/genius', () => ({ geniusSearch: jest.fn(), geniusGetArtist: jest.fn() }));
jest.mock('./providers/lastfm', () => ({
  lastFmArtistInfo: jest.fn(),
  lastFmArtistTopTracks: jest.fn(),
  lastFmArtistTopTags: jest.fn(),
  lastFmAlbumInfo: jest.fn(),
  extractLastFmImage: jest.fn(() => undefined),
}));
jest.mock('./providers/musicbrainz', () => ({
  mbGetArtist: jest.fn(),
  extractMbLinks: jest.fn(() => []),
  extractMbMembers: jest.fn(() => []),
  mbGetAlbumCover: jest.fn(),
  mbGetReleaseGroupCover: jest.fn(),
  mbSearchReleaseGroup: jest.fn(async () => []),
  mbReleaseGroupOfRelease: jest.fn(async () => null),
  mbReleaseRecordingPlaces: jest.fn(async () => []),
}));
jest.mock('./providers/theaudiodb', () => ({
  ...jest.requireActual('./providers/theaudiodb'),
  tadbArtistByMbid: jest.fn(async () => null),
  tadbSearchArtist: jest.fn(async () => null),
  tadbSearchAlbum: jest.fn(async () => []),
  tadbAlbumByReleaseGroup: jest.fn(async () => null),
}));
jest.mock('./providers/fanarttv', () => ({
  ...jest.requireActual('./providers/fanarttv'),
  fanartArtist: jest.fn(async () => null),
  fanartAlbum: jest.fn(async () => null),
}));

const settings: Record<string, unknown> = {
  lastFmApiKey: 'lastfm-key',
  geniusApiKey: 'genius-key',
  musicBrainzEnabled: false,
  metadataProviderPriority: {
    artistImage: ['genius', 'lastfm'],
    artistBanner: ['genius'],
    artistBio: ['lastfm', 'genius'],
    albumArt: ['musicbrainz', 'lastfm', 'genius'],
  },
};
function priority(patch: Record<string, string[]>) {
  settings.metadataProviderPriority = { ...(defaultSettings.metadataProviderPriority as object), ...patch };
}

const songBy = (artist: { id: number; name: string; image_url?: string }, header?: string) => ({
  type: 'song',
  result: { primary_artist: artist, header_image_url: header },
});
const defaultSettings = { ...settings };

/** The `updateLastUpdated` flag of the one cache write: true marks the artist fetched. */
const stamped = () => {
  expect(upsertArtistCache).toHaveBeenCalledTimes(1);
  return jest.mocked(upsertArtistCache).mock.calls[0][4];
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.mocked(getSystemSetting).mockImplementation(async (key: string) => settings[key]);
  jest.mocked(getCachedArtist).mockResolvedValue(null);
  jest.mocked(lastFmArtistInfo).mockResolvedValue({ bio: { summary: 'A bio.' } } as never);
  jest.mocked(lastFmArtistTopTags).mockResolvedValue({ tag: [] } as never);
});

afterEach(() => {
  for (const key of ['providerArtistImage', 'providerArtistBio', 'theAudioDbApiKey', 'fanartTvApiKey']) delete settings[key];
  Object.assign(settings, defaultSettings);
  jest.restoreAllMocks();
});

it('stores the picture and marks the artist fetched when Genius matches the artist', async () => {
  jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [songBy({ id: 7, name: 'Usher', image_url: 'https://images.genius.com/usher.png' })] } } as never);
  jest.mocked(geniusGetArtist).mockResolvedValue({ response: { artist: { header_image_url: 'https://images.genius.com/header.png' } } } as never);

  const data = await getArtistData('Usher');

  expect(data).toMatchObject({ imageUrl: 'https://images.genius.com/usher.png', bio: 'A bio.' });
  expect(data.error).toBeUndefined();
  expect(stamped()).toBe(true);
});

it.each([
  ['an outage', new ProviderError('genius', 'HTTP 503', 503), /^genius: HTTP 503$/],
  ['a rate limit', new RateLimitError('genius'), /^Rate limited by Genius$/],
])('leaves the artist unfetched when the Genius lookup fails with %s, even with a Last.fm bio', async (_label, error, message) => {
  jest.mocked(geniusSearch).mockRejectedValue(error);

  const data = await getArtistData('Usher');

  expect(data.imageUrl).toBeUndefined();
  expect(data.bio).toBe('A bio.');
  expect(data.error).toMatch(message);
  expect(stamped()).toBe(false);
  expect(jest.mocked(upsertArtistCache).mock.calls[0][2]).toBe('A bio.');
});

it('takes only an artist with the same name, not one whose name contains it', async () => {
  jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [
    songBy({ id: 1, name: 'HUNTR/X', image_url: 'https://images.genius.com/huntrx.png' }),
    songBy({ id: 2, name: 'KPop Demon Hunters Cast', image_url: 'https://images.genius.com/kpop.png' }),
  ] } } as never);

  const data = await getArtistData('Demon Hunter');

  expect(data.imageUrl).toBeUndefined();
  expect(geniusGetArtist).not.toHaveBeenCalled();
});

it('matches a Genius name with a note in brackets after it, ignoring case', async () => {
  jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [
    songBy({ id: 3, name: 'DEMON HUNTER (USA)', image_url: 'https://images.genius.com/band.png' }),
  ] } } as never);

  expect((await getArtistData('Demon Hunter')).imageUrl).toBe('https://images.genius.com/band.png');
});

it('does not borrow another artist from the first search hit', async () => {
  jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [songBy({ id: 9, name: 'Seed Nation', image_url: 'https://images.genius.com/seed.png' })] } } as never);

  const data = await getArtistData('Electrypnose');

  expect(data.imageUrl).toBeUndefined();
  expect(data.error).toBeUndefined();
  expect(geniusGetArtist).not.toHaveBeenCalled();
  expect(stamped()).toBe(true);
});

it('holds back the fetch stamp when the picture list’s fallback fails without a picture', async () => {
  jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [] } } as never);
  jest.mocked(lastFmArtistInfo).mockRejectedValue(new ProviderError('lastfm', 'HTTP 500', 500));

  await getArtistData('Usher');

  expect(stamped()).toBe(false);
});

it('does not hold back the fetch stamp for a Last.fm failure when Last.fm is not in the picture list', async () => {
  priority({ artistImage: ['genius'] });
  jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [] } } as never);
  jest.mocked(lastFmArtistInfo).mockRejectedValue(new ProviderError('lastfm', 'HTTP 500', 500));

  await getArtistData('Usher');

  expect(stamped()).toBe(true);
});

describe('cached artists', () => {
  const daysAgo = (days: number) => Math.floor(Date.now() / 1000) - days * 86400;
  const providersCalled = () =>
    jest.mocked(geniusSearch).mock.calls.length + jest.mocked(lastFmArtistInfo).mock.calls.length;

  it.each([
    ['with a picture, 20 days old', { image_url: 'https://images.genius.com/u.png', last_updated: daysAgo(20) }],
    ['without a picture, 3 days old', { image_url: null, last_updated: daysAgo(3) }],
  ])('serves a completed lookup %s without asking any provider, even lacking artwork and tags', async (_label, row) => {
    jest.mocked(getCachedArtist).mockResolvedValue({ name: 'Usher', bio: 'Cached bio.', artwork_url: null, community_tags: null, ...row });

    const data = await getArtistData('Usher');

    expect(data.bio).toBe('Cached bio.');
    expect(providersCalled()).toBe(0);
    expect(upsertArtistCache).not.toHaveBeenCalled();
  });

  it.each([
    ['without a picture, 8 days old', { image_url: null, last_updated: daysAgo(8) }],
    ['with a picture, 31 days old', { image_url: 'https://images.genius.com/u.png', last_updated: daysAgo(31) }],
    ['never completed', { image_url: null, last_updated: 0 }],
  ])('asks the providers again for a row %s', async (_label, row) => {
    jest.mocked(getCachedArtist).mockResolvedValue({ name: 'Usher', bio: 'Cached bio.', ...row });
    jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [] } } as never);

    await getArtistData('Usher');

    expect(geniusSearch).toHaveBeenCalledTimes(1);
  });
});

describe('provider choice', () => {
  const usher = { id: 7, name: 'Usher', image_url: 'https://images.genius.com/usher.png' };
  const geniusArtist = { response: { artist: { description: { plain: 'Genius bio.' }, header_image_url: 'https://images.genius.com/artist-header.png' } } };

  it('takes the bio from Last.fm when it is the bio provider, even though Genius is asked first', async () => {
    jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [songBy(usher, 'https://images.genius.com/song-header.png')] } } as never);
    jest.mocked(geniusGetArtist).mockResolvedValue(geniusArtist as never);

    const data = await getArtistData('Usher');

    expect(data).toMatchObject({ imageUrl: usher.image_url, bio: 'A bio.' });
    // Picture and header came with the search hit, and the bio is Last.fm's:
    // the Genius artist call would add nothing.
    expect(geniusGetArtist).not.toHaveBeenCalled();
  });

  it('falls back to the Genius bio when Last.fm has none', async () => {
    jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [songBy(usher)] } } as never);
    jest.mocked(geniusGetArtist).mockResolvedValue(geniusArtist as never);
    jest.mocked(lastFmArtistInfo).mockResolvedValue({ bio: { summary: '' } } as never);

    const data = await getArtistData('Usher');

    expect(data.bio).toBe('Genius bio.');
  });

  it('takes the picture from Last.fm when it is the picture provider', async () => {
    priority({ artistImage: ['lastfm', 'genius'] });
    jest.mocked(extractLastFmImage).mockReturnValue('https://lastfm.freetls.fastly.net/i/u/usher.png');
    jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [songBy(usher)] } } as never);
    jest.mocked(geniusGetArtist).mockResolvedValue(geniusArtist as never);
    jest.mocked(lastFmArtistInfo).mockResolvedValue({ bio: { summary: 'A bio.' }, image: [{}] } as never);

    const data = await getArtistData('Usher');

    expect(data.imageUrl).toBe('https://lastfm.freetls.fastly.net/i/u/usher.png');
  });

  it('stops before Last.fm when Genius is the provider for both and supplied both', async () => {
    priority({ artistBio: ['genius', 'lastfm'] });
    jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [songBy(usher)] } } as never);
    jest.mocked(geniusGetArtist).mockResolvedValue(geniusArtist as never);

    const data = await getArtistData('Usher');

    expect(data).toMatchObject({ imageUrl: usher.image_url, bio: 'Genius bio.' });
    expect(lastFmArtistInfo).not.toHaveBeenCalled();
  });

  it('never asks a provider left off every list, except Last.fm for its tags', async () => {
    priority({ artistImage: ['lastfm'], artistBanner: [], artistBio: ['lastfm'] });
    jest.mocked(extractLastFmImage).mockReturnValue('https://lastfm.freetls.fastly.net/i/u/usher.png');
    jest.mocked(lastFmArtistInfo).mockResolvedValue({ bio: { summary: '' }, image: [{}] } as never);

    const data = await getArtistData('Usher');

    expect(data.imageUrl).toBe('https://lastfm.freetls.fastly.net/i/u/usher.png');
    expect(data.bio).toBeUndefined();
    expect(geniusSearch).not.toHaveBeenCalled();
  });

  it('asks Genius for the banner even when Last.fm decided the picture and the bio', async () => {
    priority({ artistImage: ['lastfm'], artistBio: ['lastfm'] });
    jest.mocked(extractLastFmImage).mockReturnValue('https://lastfm.freetls.fastly.net/i/u/usher.png');
    jest.mocked(lastFmArtistInfo).mockResolvedValue({ bio: { summary: 'A bio.' }, image: [{}] } as never);
    jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [songBy(usher)] } } as never);
    jest.mocked(geniusGetArtist).mockResolvedValue(geniusArtist as never);

    const data = await getArtistData('Usher');

    expect(data).toMatchObject({ imageUrl: 'https://lastfm.freetls.fastly.net/i/u/usher.png', bio: 'A bio.', artworkUrl: 'https://images.genius.com/artist-header.png' });
  });

  it('skips a provider that is not set up and takes the next one', async () => {
    Object.assign(settings, { geniusApiKey: '' });
    jest.mocked(extractLastFmImage).mockReturnValue('https://lastfm.freetls.fastly.net/i/u/usher.png');
    jest.mocked(lastFmArtistInfo).mockResolvedValue({ bio: { summary: 'A bio.' }, image: [{}] } as never);

    const data = await getArtistData('Usher');

    expect(data.imageUrl).toBe('https://lastfm.freetls.fastly.net/i/u/usher.png');
    expect(geniusSearch).not.toHaveBeenCalled();
  });

  it('does not let a failing bio-only provider hold back the fetch stamp', async () => {
    priority({ artistImage: ['lastfm'], artistBanner: [], artistBio: ['genius', 'lastfm'] });
    jest.mocked(extractLastFmImage).mockReturnValue('https://lastfm.freetls.fastly.net/i/u/usher.png');
    jest.mocked(lastFmArtistInfo).mockResolvedValue({ bio: { summary: 'A bio.' }, image: [{}] } as never);
    jest.mocked(geniusSearch).mockRejectedValue(new ProviderError('genius', 'HTTP 503', 503));

    const data = await getArtistData('Usher');

    expect(data).toMatchObject({ imageUrl: 'https://lastfm.freetls.fastly.net/i/u/usher.png', bio: 'A bio.' });
    expect(stamped()).toBe(true);
  });

  it('follows the old single choice until the order is saved', async () => {
    Object.assign(settings, { metadataProviderPriority: undefined, providerArtistImage: 'lastfm', providerArtistBio: 'lastfm' });
    jest.mocked(extractLastFmImage).mockReturnValue('https://lastfm.freetls.fastly.net/i/u/usher.png');
    jest.mocked(lastFmArtistInfo).mockResolvedValue({ bio: { summary: 'A bio.' }, image: [{}] } as never);
    jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [songBy(usher)] } } as never);

    const data = await getArtistData('Usher');

    expect(data.imageUrl).toBe('https://lastfm.freetls.fastly.net/i/u/usher.png');
  });
});

describe('album art', () => {
  const RELEASE = '0b2c7a3e-6f0e-4d3c-9b8e-1a2b3c4d5e6f';
  const caa = `https://coverartarchive.org/release/${RELEASE}/front-500`;
  const lastFmCover = 'https://lastfm.freetls.fastly.net/i/u/album.png';

  beforeEach(() => {
    Object.assign(settings, { musicBrainzEnabled: true });
    jest.mocked(lastFmAlbumInfo).mockResolvedValue({ image: [{}] } as never);
    jest.mocked(extractLastFmImage).mockReturnValue(lastFmCover);
  });

  it('takes the Cover Art Archive first for a release the files name', async () => {
    jest.mocked(mbGetAlbumCover).mockResolvedValue(caa);

    expect(await getAlbumImage('Confessions', 'Usher', RELEASE)).toBe(caa);
    expect(lastFmAlbumInfo).not.toHaveBeenCalled();
  });

  it('goes down the list when a provider has no cover', async () => {
    jest.mocked(mbGetAlbumCover).mockResolvedValue(null);

    expect(await getAlbumImage('Confessions', 'Usher', RELEASE)).toBe(lastFmCover);
  });

  it('asks in the admin’s order and never asks a provider left off', async () => {
    priority({ albumArt: ['lastfm'] });

    expect(await getAlbumImage('Confessions', 'Usher', RELEASE)).toBe(lastFmCover);
    expect(mbGetAlbumCover).not.toHaveBeenCalled();
  });

  it('looks a search hit up as a release group, not a release', async () => {
    jest.mocked(mbSearchReleaseGroup).mockResolvedValue([{ id: 'rg-1', title: 'Confessions' }]);
    jest.mocked(mbGetReleaseGroupCover).mockResolvedValue('https://coverartarchive.org/release-group/rg-1/front-500');

    expect(await getAlbumImage('Confessions', 'Usher')).toBe('https://coverartarchive.org/release-group/rg-1/front-500');
    expect(mbGetReleaseGroupCover).toHaveBeenCalledWith('rg-1');
    expect(jest.mocked(upsertAlbumCache).mock.calls[0][3]).toBeNull();
  });

  it('takes the release group the files name without searching MusicBrainz', async () => {
    const GROUP = '72087170-41c6-4371-a87c-47061feeda10';
    const groupCover = `https://coverartarchive.org/release-group/${GROUP}/front-500`;
    jest.mocked(mbGetReleaseGroupCover).mockResolvedValue(groupCover);

    expect(await getAlbumImage('Confessions', 'Usher', null, GROUP)).toBe(groupCover);
    expect(mbSearchReleaseGroup).not.toHaveBeenCalled();

    // A release without a cover of its own falls back to its group's.
    jest.mocked(mbGetAlbumCover).mockResolvedValue(null);
    expect(await getAlbumImage('Confessions', 'Usher', RELEASE, GROUP)).toBe(groupCover);
    expect(mbGetAlbumCover).toHaveBeenCalledWith(RELEASE);
    expect(mbSearchReleaseGroup).not.toHaveBeenCalled();
  });

  it('looks nothing up with an empty list', async () => {
    priority({ albumArt: [] });

    expect(await getAlbumImage('Confessions', 'Usher', RELEASE)).toBeUndefined();
    expect(mbGetAlbumCover).not.toHaveBeenCalled();
    expect(lastFmAlbumInfo).not.toHaveBeenCalled();
  });
});

describe('TheAudioDB and fanart.tv', () => {
  const MBID = 'cc197bad-dc9c-440d-a5b5-d52ba2e14234';
  const tadb = {
    strArtist: 'Coldplay',
    strArtistThumb: 'https://r2.theaudiodb.com/images/media/artist/thumb/a.jpg',
    strArtistFanart: 'https://r2.theaudiodb.com/images/media/artist/fanart/b.jpg',
    strBiography: 'TheAudioDB bio.',
    strGenre: 'Alternative Rock',
    strMood: 'Happy',
    strWebsite: 'www.coldplay.com',
    strTwitter: '1',
    strCountry: 'London, England',
    strCountryCode: 'GB',
    intFormedYear: '1996',
    strMusicBrainzID: MBID,
  };
  const fanart = {
    name: 'Coldplay',
    artistthumb: [{ url: 'https://assets.fanart.tv/fanart/music/x/artistthumb/t.jpg', likes: '1' }],
    artistbackground: [
      { url: 'https://assets.fanart.tv/fanart/music/x/artistbackground/low.jpg', likes: '1' },
      { url: 'https://assets.fanart.tv/fanart/music/x/artistbackground/top.jpg', likes: '9' },
    ],
  };

  beforeEach(() => {
    Object.assign(settings, { theAudioDbApiKey: '123', fanartTvApiKey: 'fanart-key' });
    for (const mock of [tadbArtistByMbid, tadbSearchArtist, fanartArtist, fanartAlbum]) jest.mocked(mock).mockResolvedValue(null);
    jest.mocked(tadbSearchAlbum).mockResolvedValue([]);
    jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [] } } as never);
  });

  it('takes the banner from fanart.tv by the files’ MusicBrainz id, the most liked one', async () => {
    priority({ artistBanner: ['fanarttv', 'theaudiodb'] });
    jest.mocked(fanartArtist).mockResolvedValue(fanart);
    jest.mocked(tadbArtistByMbid).mockResolvedValue(tadb);

    const data = await getArtistData('Coldplay', MBID);

    expect(fanartArtist).toHaveBeenCalledWith(MBID, 'fanart-key');
    expect(data.artworkUrl).toBe('https://assets.fanart.tv/fanart/music/x/artistbackground/top.jpg');
  });

  it('falls back to TheAudioDB’s fanart, then uses its picture and bio where it ranks first', async () => {
    priority({ artistImage: ['theaudiodb'], artistBanner: ['fanarttv', 'theaudiodb'], artistBio: ['theaudiodb', 'lastfm'] });
    jest.mocked(tadbArtistByMbid).mockResolvedValue(tadb);

    const data = await getArtistData('Coldplay', MBID);

    expect(data).toMatchObject({ imageUrl: tadb.strArtistThumb, artworkUrl: tadb.strArtistFanart, bio: 'TheAudioDB bio.' });
  });

  it('treats Genius’s stock picture as no picture and goes on to the next provider', async () => {
    const stock = 'https://assets.genius.com/images/default_cover_image.png?1700000000';
    priority({ artistImage: ['genius', 'theaudiodb', 'lastfm'], artistBanner: ['genius'] });
    jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [songBy({ id: 7, name: 'Coldplay', image_url: stock })] } } as never);
    jest.mocked(geniusGetArtist).mockResolvedValue({ response: { artist: { image_url: stock, header_image_url: stock } } } as never);
    jest.mocked(tadbArtistByMbid).mockResolvedValue(tadb);

    const data = await getArtistData('Coldplay', MBID);

    expect(data.imageUrl).toBe(tadb.strArtistThumb);
    expect(data.artworkUrl).toBeUndefined();
  });

  it('looks again for an artist whose stored picture is Genius’s stock picture', async () => {
    jest.mocked(getCachedArtist).mockResolvedValueOnce({
      name: 'Coldplay', mbid: MBID, last_updated: Math.floor(Date.now() / 1000),
      image_url: 'https://assets.genius.com/images/default_cover_image.png',
    });
    priority({ artistImage: ['theaudiodb'] });
    jest.mocked(tadbArtistByMbid).mockResolvedValue(tadb);

    expect((await getArtistData('Coldplay', MBID)).imageUrl).toBe(tadb.strArtistThumb);
  });

  it('asks TheAudioDB for its facts even when nothing else needs it, filling what MusicBrainz lacks', async () => {
    jest.mocked(tadbArtistByMbid).mockResolvedValue(tadb);

    const data = await getArtistData('Coldplay', MBID);

    expect(tadbArtistByMbid).toHaveBeenCalledWith(MBID, '123');
    expect(data.area).toBe('London, England');
    expect(data.lifeSpan).toEqual({ begin: '1996', end: undefined });
    expect(data.links).toEqual([{ url: 'https://www.coldplay.com/', type: 'official homepage' }]);
    expect(data.communityTags?.map((t) => [t.name, t.providers])).toEqual([['Alternative Rock', ['theaudiodb']], ['Happy', ['theaudiodb']]]);
    expect(jest.mocked(upsertArtistCache).mock.calls[0][5]).toMatchObject({ country: 'GB', area: 'London, England' });
  });

  it('keeps MusicBrainz’s facts over TheAudioDB’s', async () => {
    Object.assign(settings, { musicBrainzEnabled: true });
    jest.mocked(mbGetArtist).mockResolvedValue({ area: { name: 'United Kingdom' }, country: 'GB', 'life-span': { begin: '1997' } } as never);
    jest.mocked(tadbArtistByMbid).mockResolvedValue(tadb);

    const data = await getArtistData('Coldplay', MBID);

    expect(data.area).toBe('United Kingdom');
    expect(data.lifeSpan?.begin).toBe('1997');
  });

  it('without a MusicBrainz id, uses a same-name TheAudioDB hit’s id for fanart.tv but never stores it', async () => {
    priority({ artistBanner: ['fanarttv'] });
    jest.mocked(tadbSearchArtist).mockResolvedValue(tadb);
    jest.mocked(fanartArtist).mockResolvedValue(fanart);

    const data = await getArtistData('Coldplay');

    expect(jest.mocked(tadbSearchArtist).mock.invocationCallOrder[0]).toBeLessThan(jest.mocked(fanartArtist).mock.invocationCallOrder[0]);
    expect(fanartArtist).toHaveBeenCalledWith(MBID, expect.anything());
    expect(data.artworkUrl).toBe('https://assets.fanart.tv/fanart/music/x/artistbackground/top.jpg');
    expect(jest.mocked(upsertArtistCache).mock.calls[0][3]).toBeNull(); // the mbid argument
  });

  it('ignores a TheAudioDB name hit for another artist', async () => {
    priority({ artistImage: ['theaudiodb'], artistBanner: ['fanarttv'] });
    jest.mocked(tadbSearchArtist).mockResolvedValue({ ...tadb, strArtist: 'Coldplay Tribute Band' });

    const data = await getArtistData('Coldplay');

    expect(data.imageUrl).toBeUndefined();
    expect(data.area).toBeUndefined();
    expect(fanartArtist).not.toHaveBeenCalled();
  });

  it('finds an album cover on TheAudioDB by name, and on fanart.tv by the release group of the files’ release', async () => {
    const RELEASE = '0b2c7a3e-6f0e-4d3c-9b8e-1a2b3c4d5e6f';
    const GROUP = '72087170-41c6-4371-a87c-47061feeda10';
    Object.assign(settings, { musicBrainzEnabled: true });

    priority({ albumArt: ['theaudiodb'] });
    jest.mocked(tadbSearchAlbum).mockResolvedValue([{ strAlbum: 'Parachutes', strAlbumThumb: 'https://r2.theaudiodb.com/images/media/album/thumb/p.jpg' }]);
    expect(await getAlbumImage('parachutes', 'Coldplay', RELEASE)).toBe('https://r2.theaudiodb.com/images/media/album/thumb/p.jpg');

    priority({ albumArt: ['fanarttv'] });
    jest.mocked(mbReleaseGroupOfRelease).mockResolvedValue(GROUP);
    jest.mocked(fanartAlbum).mockResolvedValue({ albums: { [GROUP]: { albumcover: [{ url: 'https://assets.fanart.tv/fanart/music/x/albumcover/c.jpg', likes: '2' }] } } });
    expect(await getAlbumImage('Parachutes', 'Coldplay', RELEASE)).toBe('https://assets.fanart.tv/fanart/music/x/albumcover/c.jpg');
    expect(mbReleaseGroupOfRelease).toHaveBeenCalledWith(RELEASE);
  });

  it('asks fanart.tv by the files’ own release group, with no MusicBrainz call', async () => {
    const GROUP = '72087170-41c6-4371-a87c-47061feeda10';
    const cover = 'https://assets.fanart.tv/fanart/music/x/albumcover/c.jpg';
    Object.assign(settings, { musicBrainzEnabled: false });
    priority({ albumArt: ['fanarttv'] });
    jest.mocked(fanartAlbum).mockResolvedValue({ albums: { [GROUP]: { albumcover: [{ url: cover, likes: '2' }] } } });

    // Passed in by the art routes (the track's tag)…
    expect(await getAlbumImage('Parachutes', 'Coldplay', '0b2c7a3e-6f0e-4d3c-9b8e-1a2b3c4d5e6f', GROUP)).toBe(cover);
    // …or read off the album row, for the app's album-art lookup by name.
    jest.mocked(getCachedAlbum).mockResolvedValueOnce({ mb_release_group_id: GROUP, last_updated: null });
    expect(await getAlbumImage('Parachutes', 'Coldplay')).toBe(cover);

    expect(fanartAlbum).toHaveBeenCalledTimes(2);
    expect(fanartAlbum).toHaveBeenCalledWith(GROUP, expect.anything());
    expect(mbReleaseGroupOfRelease).not.toHaveBeenCalled();
    expect(tadbSearchAlbum).not.toHaveBeenCalled();
  });
});

describe('disc art for the rolling disc', () => {
  const GROUP = '1dc4c347-a1db-32aa-b14f-bc9cc507b843';
  const parachutes = { title: 'Parachutes', artist: 'Coldplay', releaseGroupId: GROUP };
  const cdart = (url: string, disc: string, likes: string) => ({ url, disc, likes });

  beforeEach(() => {
    clearDiscArtCacheForTests();
    Object.assign(settings, { theAudioDbApiKey: '123', fanartTvApiKey: 'fanart-key' });
    jest.mocked(fanartAlbum).mockResolvedValue(null);
    jest.mocked(tadbAlbumByReleaseGroup).mockResolvedValue(null);
    jest.mocked(tadbSearchAlbum).mockResolvedValue([]);
  });

  it('asks the Album art providers in order, and only those listed', async () => {
    priority({ albumArt: ['theaudiodb', 'fanarttv'] });
    jest.mocked(tadbAlbumByReleaseGroup).mockResolvedValue({ strAlbumCDart: 'https://r2.theaudiodb.com/images/media/album/cdart/p.png' });
    expect(await getAlbumDiscArt(parachutes)).toBe('https://r2.theaudiodb.com/images/media/album/cdart/p.png');
    expect(fanartAlbum).not.toHaveBeenCalled();

    clearDiscArtCacheForTests();
    priority({ albumArt: ['musicbrainz', 'lastfm'] });
    expect(await getAlbumDiscArt(parachutes)).toBeNull();
    expect(tadbAlbumByReleaseGroup).toHaveBeenCalledTimes(1);
  });

  it('takes fanart.tv’s picture of this disc, the most liked', async () => {
    priority({ albumArt: ['fanarttv'] });
    jest.mocked(fanartAlbum).mockResolvedValue({ albums: { [GROUP]: { cdart: [
      cdart('https://assets.fanart.tv/fanart/one-low.png', '1', '0'),
      cdart('https://assets.fanart.tv/fanart/one-top.png', '1', '5'),
      cdart('https://assets.fanart.tv/fanart/two.png', '2', '1'),
    ] } } });
    expect(await getAlbumDiscArt(parachutes)).toBe('https://assets.fanart.tv/fanart/one-top.png');
    expect(await getAlbumDiscArt({ ...parachutes, discIndex: 1 })).toBe('https://assets.fanart.tv/fanart/two.png');
    expect(fanartAlbum).toHaveBeenCalledWith(GROUP, 'fanart-key');
  });

  it('remembers what it found, but not a failed lookup', async () => {
    priority({ albumArt: ['theaudiodb'] });
    jest.mocked(tadbAlbumByReleaseGroup).mockRejectedValueOnce(new ProviderError('theaudiodb', 'HTTP 503', 503));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await getAlbumDiscArt(parachutes)).toBeNull();
    jest.mocked(tadbAlbumByReleaseGroup).mockResolvedValue({ strAlbumCDart: 'https://r2.theaudiodb.com/images/media/album/cdart/p.png' });
    expect(await getAlbumDiscArt(parachutes)).toBe('https://r2.theaudiodb.com/images/media/album/cdart/p.png');
    expect(await getAlbumDiscArt(parachutes)).toBe('https://r2.theaudiodb.com/images/media/album/cdart/p.png');
    expect(tadbAlbumByReleaseGroup).toHaveBeenCalledTimes(2);
  });

  it('finds TheAudioDB’s album by name without a release group', async () => {
    priority({ albumArt: ['theaudiodb'] });
    jest.mocked(tadbSearchAlbum).mockResolvedValue([{ strAlbum: 'Parachutes', strAlbumCDart: 'https://r2.theaudiodb.com/c.png' }]);
    expect(await getAlbumDiscArt({ title: 'Parachutes', artist: 'Coldplay' })).toBe('https://r2.theaudiodb.com/c.png');
    expect(tadbAlbumByReleaseGroup).not.toHaveBeenCalled();
  });
});

describe('where an album was recorded', () => {
  const RELEASE = 'f037f8ba-5263-497a-b36c-f83bf4dc0817';
  const village = { name: 'The Village', area: 'Los Angeles', tracks: 6 };

  beforeEach(() => {
    Object.assign(settings, { musicBrainzEnabled: true });
    jest.mocked(getRepresentativeReleaseMbid).mockResolvedValue(RELEASE);
  });

  it('asks MusicBrainz the first time and keeps the answer', async () => {
    jest.mocked(getStoredRecordingPlaces).mockResolvedValue({ places: null, readAt: null });
    jest.mocked(mbReleaseRecordingPlaces).mockResolvedValue([village]);
    expect(await getAlbumRecordingPlaces('al1')).toEqual([village]);
    expect(mbReleaseRecordingPlaces).toHaveBeenCalledWith(RELEASE);
    expect(storeRecordingPlaces).toHaveBeenCalledWith('al1', [village]);
  });

  it('answers from the album while the answer is fresh, and asks again after 90 days', async () => {
    jest.mocked(getStoredRecordingPlaces).mockResolvedValue({ places: [village], readAt: new Date() });
    expect(await getAlbumRecordingPlaces('al1')).toEqual([village]);
    expect(mbReleaseRecordingPlaces).not.toHaveBeenCalled();

    jest.mocked(getStoredRecordingPlaces).mockResolvedValue({ places: [], readAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000) });
    jest.mocked(mbReleaseRecordingPlaces).mockResolvedValue([village]);
    expect(await getAlbumRecordingPlaces('al1')).toEqual([village]);
  });

  it('keeps "none" without a release to ask about, asks nothing with MusicBrainz off, and keeps no failure', async () => {
    jest.mocked(getStoredRecordingPlaces).mockResolvedValue({ places: null, readAt: null });
    jest.mocked(getRepresentativeReleaseMbid).mockResolvedValue(null);
    expect(await getAlbumRecordingPlaces('al1')).toEqual([]);
    expect(storeRecordingPlaces).toHaveBeenCalledWith('al1', []);

    Object.assign(settings, { musicBrainzEnabled: false });
    expect(await getAlbumRecordingPlaces('al1')).toBeNull();

    Object.assign(settings, { musicBrainzEnabled: true });
    jest.mocked(getRepresentativeReleaseMbid).mockResolvedValue(RELEASE);
    jest.mocked(storeRecordingPlaces).mockClear();
    jest.mocked(mbReleaseRecordingPlaces).mockRejectedValueOnce(new ProviderError('musicbrainz', 'HTTP 503', 503));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await getAlbumRecordingPlaces('al1')).toBeNull();
    expect(storeRecordingPlaces).not.toHaveBeenCalled();
    expect(mbReleaseRecordingPlaces).toHaveBeenCalledTimes(1);
  });
});

describe('shared Last.fm ranking', () => {
  const tracks = [{ name: 'First' }];
  it('reads a fresh database entry without a provider request', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ tracks, fetched_at: new Date() }] });
    jest.mocked(initDB).mockResolvedValue({ query } as never);
    expect(await getArtistTopTracks('Artist')).toEqual(tracks);
    expect(lastFmArtistTopTracks).not.toHaveBeenCalled();
  });

  it('serves expired data during a single refresh and retains it on provider failure', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ tracks, fetched_at: new Date(0) }] });
    jest.mocked(initDB).mockResolvedValue({ query } as never);
    let fail!: (reason: Error) => void;
    jest.mocked(lastFmArtistTopTracks).mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    expect(await Promise.all([getArtistTopTracks('Same'), getArtistTopTracks('same')])).toEqual([tracks, tracks]);
    expect(lastFmArtistTopTracks).toHaveBeenCalledTimes(1);
    fail(new Error('provider offline'));
    await new Promise(resolve => setImmediate(resolve));
    expect(await getArtistTopTracks('Same')).toEqual(tracks);
    expect(lastFmArtistTopTracks).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
  });
});
