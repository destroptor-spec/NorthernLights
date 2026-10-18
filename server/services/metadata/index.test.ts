/**
 * @jest-environment node
 */
import { getArtistData } from './index';
import { getSystemSetting } from '../../database';
import { getCachedArtist, upsertArtistCache } from './cache';
import { geniusSearch, geniusGetArtist } from './providers/genius';
import { lastFmArtistInfo, lastFmArtistTopTags, extractLastFmImage } from './providers/lastfm';
import { ProviderError, RateLimitError } from './errors';

jest.mock('../../database', () => ({ getSystemSetting: jest.fn() }));
jest.mock('./cache', () => ({
  getCachedArtist: jest.fn(),
  upsertArtistCache: jest.fn(async () => {}),
  isCacheFresh: jest.requireActual('./cache').isCacheFresh,
}));
jest.mock('./providers/genius', () => ({ geniusSearch: jest.fn(), geniusGetArtist: jest.fn() }));
jest.mock('./providers/lastfm', () => ({
  lastFmArtistInfo: jest.fn(),
  lastFmArtistTopTags: jest.fn(),
  extractLastFmImage: jest.fn(() => undefined),
}));
jest.mock('./providers/musicbrainz', () => ({
  mbGetArtist: jest.fn(),
  extractMbLinks: jest.fn(() => []),
  extractMbMembers: jest.fn(() => []),
}));

const settings: Record<string, unknown> = {
  lastFmApiKey: 'lastfm-key',
  geniusApiKey: 'genius-key',
  musicBrainzEnabled: false,
  providerArtistImage: 'genius',
  providerArtistArtwork: 'genius',
  providerArtistBio: 'lastfm',
};

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

it('does not borrow another artist from the first search hit', async () => {
  jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [songBy({ id: 9, name: 'Seed Nation', image_url: 'https://images.genius.com/seed.png' })] } } as never);

  const data = await getArtistData('Electrypnose');

  expect(data.imageUrl).toBeUndefined();
  expect(data.error).toBeUndefined();
  expect(geniusGetArtist).not.toHaveBeenCalled();
  expect(stamped()).toBe(true);
});

it('does not hold back the fetch stamp for a Last.fm failure when Last.fm is not the picture source', async () => {
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
    Object.assign(settings, { providerArtistImage: 'lastfm' });
    jest.mocked(extractLastFmImage).mockReturnValue('https://lastfm.freetls.fastly.net/i/u/usher.png');
    jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [songBy(usher)] } } as never);
    jest.mocked(geniusGetArtist).mockResolvedValue(geniusArtist as never);
    jest.mocked(lastFmArtistInfo).mockResolvedValue({ bio: { summary: 'A bio.' }, image: [{}] } as never);

    const data = await getArtistData('Usher');

    expect(data.imageUrl).toBe('https://lastfm.freetls.fastly.net/i/u/usher.png');
  });

  it('stops before Last.fm when Genius is the provider for both and supplied both', async () => {
    Object.assign(settings, { providerArtistBio: 'genius' });
    jest.mocked(geniusSearch).mockResolvedValue({ response: { hits: [songBy(usher)] } } as never);
    jest.mocked(geniusGetArtist).mockResolvedValue(geniusArtist as never);

    const data = await getArtistData('Usher');

    expect(data).toMatchObject({ imageUrl: usher.image_url, bio: 'Genius bio.' });
    expect(lastFmArtistInfo).not.toHaveBeenCalled();
  });
});
