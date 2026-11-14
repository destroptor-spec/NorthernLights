import { describeTheme, hasHardFilter, thinRequest } from './aiPlaylistSupport';

const none = { countries: [], languages: [], yearFrom: null, yearTo: null, vocals: null };

test('only where, language, years and vocals count as hard filters', () => {
  expect(hasHardFilter(null)).toBe(false);
  expect(hasHardFilter(none)).toBe(false);
  expect(hasHardFilter({ ...none, yearFrom: 1990 })).toBe(true);
  expect(hasHardFilter({ ...none, vocals: 'female' })).toBe(true);
});

test('the theme in words', () => {
  const danishRap = { ...none, countries: ['DK'], languages: ['da'], yearFrom: 1990, yearTo: 1999 };
  expect(describeTheme(['Hip Hop'], danishRap, 6)).toBe('Hip Hop tracks from Denmark or sung in Danish from the 1990s');
  expect(describeTheme(['Pop', 'Synth-pop'], { ...none, countries: ['DK', 'SE', 'NO'] }, 1)).toBe('Pop or Synth-pop track from Denmark, Sweden or Norway');
  expect(describeTheme(['Jazz'], { ...none, yearFrom: 2010, vocals: 'female' }, 3)).toBe('Jazz tracks from 2010 on with female vocals');
  expect(describeTheme(['Rock'], { ...none, yearFrom: 1975, yearTo: 1982 }, 3)).toBe('Rock tracks from 1975–1982');
});

test('the answer says how much there is, or that there is none', () => {
  const filter = { ...none, countries: ['DK'], yearFrom: 1990, yearTo: 1999 };
  expect(thinRequest(['Hip Hop'], filter, { songs: 6, artists: 3 }, 20)).toMatchObject({
    songs: 6, artists: 3, needed: 20,
    message: 'Your library has 6 Hip Hop tracks from Denmark from the 1990s, too few for a 20-track playlist.',
  });
  expect(thinRequest(['Hip Hop'], filter, { songs: 0, artists: 0 }, 20).message).toBe('Your library has no Hip Hop tracks from Denmark from the 1990s.');
});

test('a plain style request reads as the style alone', () => {
  const { thinRequest: thin, NO_HARD_FILTER: none2 } = jest.requireActual('./aiPlaylistSupport');
  expect(thin(['Jazz'], none2, { songs: 3, artists: 2 }, 20).message).toBe('Your library has 3 Jazz tracks, too few for a 20-track playlist.');
  expect(thin(['Jazz', 'Bossa Nova'], none2, { songs: 0, artists: 0 }, 20).message).toBe('Your library has no Jazz or Bossa Nova tracks.');
});
