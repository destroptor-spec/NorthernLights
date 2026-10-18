/**
 * @jest-environment node
 */
import { enrichArtistImages } from './artistImageEnrichment.service';
import { getArtistsNeedingImage, getSystemSetting } from '../database';
import { getArtistData } from './metadata';

jest.mock('../database', () => ({ getArtistsNeedingImage: jest.fn(), getSystemSetting: jest.fn() }));
jest.mock('./metadata', () => ({ getArtistData: jest.fn() }));

const artists = ['A', 'B', 'C'].map((name) => ({ id: `id-${name}`, name, mbid: null }));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.mocked(getSystemSetting).mockImplementation(async (key: string) => (key === 'geniusApiKey' ? 'key' : null));
});

afterEach(() => jest.restoreAllMocks());

it('stops the run at the first failed lookup instead of marking the rest as having no image', async () => {
  jest.mocked(getArtistsNeedingImage).mockResolvedValue(artists);
  jest.mocked(getArtistData)
    .mockResolvedValueOnce({ imageUrl: 'https://images.genius.com/a.png' })
    .mockResolvedValueOnce({ bio: 'B bio', error: 'genius: HTTP 503' });

  const result = await enrichArtistImages();

  expect(getArtistData).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ attempted: 2, succeeded: 1, noImage: 0, failed: 1, stoppedOnError: 'genius: HTTP 503' });
});

it('still treats a rate limit as running out of quota', async () => {
  jest.mocked(getArtistsNeedingImage).mockResolvedValue(artists);
  jest.mocked(getArtistData).mockResolvedValueOnce({ error: 'Rate limited by Genius' });

  const result = await enrichArtistImages();

  expect(result).toMatchObject({ attempted: 1, ranOutOfQuota: true });
  expect(result.stoppedOnError).toBeUndefined();
});

it('fetches each artist at most once per run even if it stays selectable', async () => {
  // An artist the provider answered without stamping (e.g. a partial rate limit)
  // is still returned by the selector; the run must not loop on it.
  jest.mocked(getArtistsNeedingImage).mockResolvedValue(artists);
  jest.mocked(getArtistData).mockResolvedValue({});

  const result = await enrichArtistImages();

  expect(getArtistData).toHaveBeenCalledTimes(3);
  expect(result).toMatchObject({ attempted: 3, noImage: 3, failed: 0 });
});
