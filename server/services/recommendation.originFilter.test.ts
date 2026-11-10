import { describeOriginFilter, originFilterOf } from './recommendation.service';

/**
 * A custom playlist's hard filters ("Dansk rap fra 90'erne") come from the
 * model as it writes them; they must reach SQL as ISO codes and years, or not
 * at all.
 */
describe('originFilterOf', () => {
  it('turns a Danish request into DK, Danish and the 90s', () => {
    expect(originFilterOf({ countries: ['DK'], languages: ['da'], year_from: 1990, year_to: 1999 }))
      .toEqual({ countries: ['DK'], languages: ['da'], yearFrom: 1990, yearTo: 1999 });
  });

  it('accepts names and other spellings, and drops what it cannot place', () => {
    expect(originFilterOf({ countries: ['Denmark', 'dansk', 'Scandinavia'], languages: ['dan', 'Danish', 'Klingon'] }))
      .toEqual({ countries: ['DK'], languages: ['da'], yearFrom: null, yearTo: null });
  });

  it('keeps one bound of a year range, swaps a reversed one, and ignores nonsense', () => {
    expect(originFilterOf({ year_from: 2010 })).toEqual({ countries: [], languages: [], yearFrom: 2010, yearTo: null });
    expect(originFilterOf({ year_from: 1999, year_to: 1990 })).toMatchObject({ yearFrom: 1990, yearTo: 1999 });
    expect(originFilterOf({ year_from: 'the nineties', year_to: 12 })).toBeNull();
  });

  it('is null when nothing is asked for, so ordinary playlists are unfiltered', () => {
    expect(originFilterOf({})).toBeNull();
    expect(originFilterOf({ countries: [], languages: null })).toBeNull();
  });

  it('describes itself for the log', () => {
    expect(describeOriginFilter({ countries: ['DK'], languages: ['da'], yearFrom: 1990, yearTo: 1999 }))
      .toBe('from DK or language da, years 1990–1999');
  });
});
