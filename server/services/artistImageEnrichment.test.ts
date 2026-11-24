/**
 * @jest-environment node
 */
import { enrichArtistImages, requestArtistImages, resetArtistImageRequestsForTests } from './artistImageEnrichment.service';
import { getArtistImageStates, getArtistsNeedingImage, getSystemSetting } from '../database';
import { getArtistData } from './metadata';

jest.mock('../database', () => ({ getArtistsNeedingImage: jest.fn(), getSystemSetting: jest.fn(), getArtistImageStates: jest.fn(async () => []) }));
jest.mock('./metadata', () => ({ getArtistData: jest.fn(), ARTIST_NO_IMAGE_RECHECK_MS: 7 * 24 * 60 * 60 * 1000 }));

const artists = ['A', 'B', 'C'].map((name) => ({ id: `id-${name}`, name, mbid: null }));

beforeEach(() => {
  jest.clearAllMocks();
  resetArtistImageRequestsForTests();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.mocked(getSystemSetting).mockImplementation(async (key: string) => (key === 'geniusApiKey' ? 'key' : null));
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('paces a background run between artists', async () => {
  jest.useFakeTimers();
  jest.mocked(getArtistsNeedingImage).mockResolvedValue(artists);
  jest.mocked(getArtistData).mockResolvedValue({ imageUrl: 'https://images.genius.com/x.png' });

  const run = enrichArtistImages({ paceMs: 1500 });
  await jest.advanceTimersByTimeAsync(0);
  expect(getArtistData).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1499);
  expect(getArtistData).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(1);
  expect(getArtistData).toHaveBeenCalledTimes(2);
  await jest.advanceTimersByTimeAsync(1500);
  await expect(run).resolves.toMatchObject({ attempted: 3, succeeded: 3 });
});

it('stops the run at the first failed lookup instead of marking the rest as having no image', async () => {
  jest.mocked(getArtistsNeedingImage).mockResolvedValue(artists);
  jest.mocked(getArtistData)
    .mockResolvedValueOnce({ imageUrl: 'https://images.genius.com/a.png' })
    .mockResolvedValueOnce({ bio: 'B bio', error: 'genius: HTTP 503' });

  const result = await enrichArtistImages({ paceMs: 0 });

  expect(getArtistData).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ attempted: 2, succeeded: 1, noImage: 0, failed: 1, stoppedOnError: 'genius: HTTP 503' });
});

it('still treats a rate limit as running out of quota', async () => {
  jest.mocked(getArtistsNeedingImage).mockResolvedValue(artists);
  jest.mocked(getArtistData).mockResolvedValueOnce({ error: 'Rate limited by Genius' });

  const result = await enrichArtistImages({ paceMs: 0 });

  expect(result).toMatchObject({ attempted: 1, ranOutOfQuota: true });
  expect(result.stoppedOnError).toBeUndefined();
});

it('fetches each artist at most once per run even if it stays selectable', async () => {
  // An artist the provider answered without stamping (e.g. a partial rate limit)
  // is still returned by the selector; the run must not loop on it.
  jest.mocked(getArtistsNeedingImage).mockResolvedValue(artists);
  jest.mocked(getArtistData).mockResolvedValue({});

  const result = await enrichArtistImages({ paceMs: 0 });

  expect(getArtistData).toHaveBeenCalledTimes(3);
  expect(result).toMatchObject({ attempted: 3, noImage: 3, failed: 0 });
});

describe('pictures for artists on screen', () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  const row = (name: string, imageUrl: string | null, lastUpdated: number) => ({ id: `id-${name}`, name, mbid: null, imageUrl, lastUpdated });
  const lookedUpNames = () => jest.mocked(getArtistData).mock.calls.map((call) => call[0]);

  it('answers each name with its picture, a place in the queue, or why not', async () => {
    jest.mocked(getArtistsNeedingImage).mockResolvedValue([]);
    jest.mocked(getArtistData).mockResolvedValue({});
    jest.mocked(getArtistImageStates).mockResolvedValue([
      row('Found', 'https://images.genius.com/f.png', nowSeconds()),
      row('Stock', 'https://assets.genius.com/images/default_cover_image.png', nowSeconds()),
      row('Checked', null, nowSeconds()),
      row('Last month', null, nowSeconds() - 30 * 24 * 60 * 60),
      row('Never', null, 0),
    ]);

    const artists = await requestArtistImages(['Found', 'Stock', 'Checked', 'Last month', 'Never', 'Missing', ' Found ']);

    expect(artists).toEqual([
      { name: 'Found', status: 'found', imageUrl: 'https://images.genius.com/f.png' },
      { name: 'Stock', status: 'queued', imageUrl: null },
      { name: 'Checked', status: 'none', imageUrl: null },
      { name: 'Last month', status: 'queued', imageUrl: null },
      { name: 'Never', status: 'queued', imageUrl: null },
      { name: 'Missing', status: 'unknown', imageUrl: null },
    ]);
  });

  it('looks them up before the rest of the library, the latest asked first', async () => {
    jest.useFakeTimers();
    jest.mocked(getArtistsNeedingImage).mockResolvedValue([{ id: 'id-Library', name: 'Library', mbid: null }]);
    jest.mocked(getArtistData).mockResolvedValue({});
    jest.mocked(getArtistImageStates).mockImplementation(async (names: string[]) => names.map((name) => row(name, null, 0)));

    await requestArtistImages(['A', 'B']);
    await requestArtistImages(['C', 'A']); // A shown again: back to the front
    await jest.advanceTimersByTimeAsync(10_000);

    expect(lookedUpNames()).toEqual(['A', 'C', 'B', 'Library']);
  });

  it('queues nothing when no provider is set up', async () => {
    jest.mocked(getSystemSetting).mockResolvedValue(null);
    jest.mocked(getArtistImageStates).mockResolvedValue([row('A', null, 0)]);

    expect(await requestArtistImages(['A'])).toEqual([{ name: 'A', status: 'none', imageUrl: null }]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(getArtistData).not.toHaveBeenCalled();
  });

  it('waits five minutes before a run stopped by a rate limit is restarted from the screen', async () => {
    jest.useFakeTimers();
    jest.mocked(getArtistsNeedingImage).mockResolvedValue([]);
    jest.mocked(getArtistImageStates).mockImplementation(async (names: string[]) => names.map((name) => row(name, null, 0)));
    jest.mocked(getArtistData).mockResolvedValueOnce({ error: 'Rate limited by Genius' }).mockResolvedValue({});

    await requestArtistImages(['A']);
    await jest.advanceTimersByTimeAsync(1000);
    expect(lookedUpNames()).toEqual(['A']);

    await requestArtistImages(['A']);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(lookedUpNames()).toEqual(['A']);

    await jest.advanceTimersByTimeAsync(5 * 60_000);
    await requestArtistImages(['A']);
    await jest.advanceTimersByTimeAsync(1000);
    expect(lookedUpNames()).toEqual(['A', 'A']);
  });
});
