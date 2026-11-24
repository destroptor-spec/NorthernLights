import { artistSummary, type ArtistSummaryFacts } from './artistSummary';

const facts = (patch: Partial<ArtistSummaryFacts>): ArtistSummaryFacts => ({ name: 'Daysend', roles: [], tracks: 0, albums: 0, ...patch });

describe('artistSummary', () => {
  it('writes who, where and when, then the library, then Last.fm', () => {
    expect(artistSummary(facts({
      type: 'Group', area: 'Sydney, Australia', lifeSpan: { begin: '2002', end: '2011' },
      roles: ['performer', 'composer'], tracks: 11, albums: 1, duration: '46 min', listeners: '14K listeners',
    }))).toEqual([
      'Daysend is a group from Sydney, Australia, active from 2002 to 2011.',
      'Your library has 11 tracks from 1 album (46 min), where Daysend is credited as performer and composer.',
      'Last.fm counts 14K listeners.',
    ]);
  });

  it('words the years by kind: a group forms, a person is born', () => {
    expect(artistSummary(facts({ name: 'Muse', type: 'Group', area: 'Teignmouth', lifeSpan: { begin: '1994' } }))[0])
      .toBe('Muse is a group from Teignmouth, formed in 1994.');
    expect(artistSummary(facts({ name: 'Ferry Corsten', type: 'Person', area: 'Rotterdam', lifeSpan: { begin: '1973' } }))[0])
      .toBe('Ferry Corsten is an artist from Rotterdam, born in 1973.');
    expect(artistSummary(facts({ name: 'Tony Bennett', type: 'Person', lifeSpan: { begin: '1926', end: '2023' } }))[0])
      .toBe('Tony Bennett is an artist, born in 1926 and died in 2023.');
    expect(artistSummary(facts({ name: 'Berliner Philharmoniker', type: 'Orchestra', area: 'Berlin', lifeSpan: { begin: '1882' } }))[0])
      .toBe('Berliner Philharmoniker is an orchestra from Berlin, formed in 1882.');
  });

  it('leaves the years out when the kind is unknown: a year could be a birth or a founding', () => {
    expect(artistSummary(facts({ area: 'Sydney, Australia', lifeSpan: { begin: '2002' } }))).toEqual(['Daysend is from Sydney, Australia.']);
    expect(artistSummary(facts({ type: 'Other', lifeSpan: { begin: '2002' } }))).toEqual([]);
  });

  it('says "the" for countries named with it', () => {
    expect(artistSummary(facts({ name: 'Armin van Buuren', type: 'Person', area: 'Netherlands' }))[0])
      .toBe('Armin van Buuren is an artist from the Netherlands.');
    expect(artistSummary(facts({ name: 'Muse', type: 'Group', area: 'United Kingdom' }))[0]).toBe('Muse is a group from the United Kingdom.');
    expect(artistSummary(facts({ name: 'Ferry Corsten', type: 'Person', area: 'Rotterdam, Netherlands' }))[0])
      .toBe('Ferry Corsten is an artist from Rotterdam, Netherlands.');
  });

  it('names roles in words, caps a long list, and skips a single role', () => {
    expect(artistSummary(facts({ tracks: 3, albums: 1, roles: ['dj-mixer', 'original-artist'] }))[0])
      .toBe('Your library has 3 tracks from 1 album, where Daysend is credited as DJ mixer and original artist.');
    expect(artistSummary(facts({ tracks: 1, roles: ['writer', 'producer', 'performer', 'composer', 'engineer'] }))[0])
      .toBe('Your library has 1 track, where Daysend is credited as writer, producer, performer and composer, among other roles.');
    expect(artistSummary(facts({ tracks: 2, albums: 2, roles: ['performer'] }))[0]).toBe('Your library has 2 tracks from 2 albums.');
  });

  it('describes a credit-only artist by their credits alone', () => {
    expect(artistSummary(facts({ name: 'Max Martin', roles: ['writer', 'producer'] }))).toEqual(['In your library, Max Martin is credited as writer and producer.']);
  });

  it('says nothing without facts, nor the kind alone (it is under the name already)', () => {
    expect(artistSummary(facts({}))).toEqual([]);
    expect(artistSummary(facts({ name: 'Seven Lions', type: 'Person' }))).toEqual([]);
  });
});
