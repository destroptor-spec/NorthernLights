import { describeOriginFilter, originFilterOf, withinCoverage } from './recommendation.service';

/**
 * A custom playlist's hard filters ("Dansk rap fra 90'erne") come from the
 * model as it writes them; they must reach SQL as ISO codes and years, or not
 * at all.
 */
describe('originFilterOf', () => {
  it('turns a Danish request into DK, Danish and the 90s', () => {
    expect(originFilterOf({ countries: ['DK'], languages: ['da'], year_from: 1990, year_to: 1999 }))
      .toEqual({ countries: ['DK'], languages: ['da'], yearFrom: 1990, yearTo: 1999, vocals: null, moods: [] });
  });

  it('reads vocals and moods in any spelling; moods alone still make a filter, which only leans', () => {
    expect(originFilterOf({ vocals: 'kvindelig vokal', moods: ['chillout', 'trist', 'banana'] }))
      .toEqual({ countries: [], languages: [], yearFrom: null, yearTo: null, vocals: 'female', moods: ['chill', 'melancholic'] });
    expect(describeOriginFilter({ countries: [], languages: [], yearFrom: null, yearTo: null, vocals: 'female', moods: ['chill'] }))
      .toBe('female vocals, leaning chill');
  });

  it('accepts names and other spellings, and drops what it cannot place', () => {
    expect(originFilterOf({ countries: ['Denmark', 'dansk', 'Scandinavia'], languages: ['dan', 'Danish', 'Klingon'] }))
      .toEqual({ countries: ['DK'], languages: ['da'], yearFrom: null, yearTo: null, vocals: null, moods: [] });
  });

  it('keeps one bound of a year range, swaps a reversed one, and ignores nonsense', () => {
    expect(originFilterOf({ year_from: 2010 })).toEqual({ countries: [], languages: [], yearFrom: 2010, yearTo: null, vocals: null, moods: [] });
    expect(originFilterOf({ year_from: 1999, year_to: 1990 })).toMatchObject({ yearFrom: 1990, yearTo: 1999 });
    expect(originFilterOf({ year_from: 'the nineties', year_to: 12 })).toBeNull();
  });

  it('is null when nothing is asked for, so ordinary playlists are unfiltered', () => {
    expect(originFilterOf({})).toBeNull();
    expect(originFilterOf({ countries: [], languages: null })).toBeNull();
  });

  it('describes itself for the log', () => {
    expect(describeOriginFilter({ countries: ['DK'], languages: ['da'], yearFrom: 1990, yearTo: 1999, vocals: null, moods: [] }))
      .toBe('from DK or language da, years 1990–1999');
  });
});

/**
 * Without Last.fm or MusicBrainz there are no artist tags, so no track has
 * vocals or moods; a request for them must not filter everything away.
 */
describe('withinCoverage', () => {
  const asked = { countries: ['DK'], languages: ['da'], yearFrom: 1990, yearTo: 1999, vocals: 'female', moods: ['chill'] };

  it('keeps every part the library has data for', () => {
    expect(withinCoverage(asked, { places: true, years: true, vocals: true, moods: true })).toEqual({ filter: asked, dropped: [] });
  });

  it('drops vocals and moods in a library without artist tags, and keeps places and years from the files', () => {
    expect(withinCoverage(asked, { places: true, years: true, vocals: false, moods: false })).toEqual({
      filter: { ...asked, vocals: null, moods: [] }, dropped: ['vocals', 'moods'] });
  });

  it('is null when nothing the request asked for can be honoured', () => {
    expect(withinCoverage({ ...asked, countries: [], languages: [], yearFrom: null, yearTo: null }, { places: true, years: true, vocals: false, moods: false }))
      .toEqual({ filter: null, dropped: ['vocals', 'moods'] });
  });
});
