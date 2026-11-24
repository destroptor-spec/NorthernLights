/** @jest-environment node */
import { mergeLinks, sameArtistName, theAudioDbFacts, withDisplayTags } from './theAudioDbFacts';

const coldplay = {
  strArtist: 'Coldplay',
  strArtistAlternate: '',
  intFormedYear: '1996',
  intBornYear: '1996',
  intDiedYear: null,
  strDisbanded: null,
  strGenre: 'Alternative Rock',
  strStyle: 'Rock/Pop',
  strMood: 'Happy',
  strWebsite: 'www.coldplay.com',
  strFacebook: '',
  strTwitter: '1',
  strCountry: 'London, England',
  strCountryCode: 'GB',
};

describe('sameArtistName', () => {
  it('matches the name or an alternate name, ignoring case and spacing', () => {
    expect(sameArtistName(coldplay, 'coldplay')).toBe(true);
    expect(sameArtistName({ strArtist: 'Sigur Rós', strArtistAlternate: 'Sigur Ros, SR' }, 'sigur  ros')).toBe(true);
    expect(sameArtistName(coldplay, 'Coldplay Tribute')).toBe(false);
  });
});

describe('theAudioDbFacts', () => {
  it('takes area, country, years, real links and genre/style/mood', () => {
    const facts = theAudioDbFacts(coldplay);
    expect(facts.area).toBe('London, England');
    expect(facts.country).toBe('GB');
    expect(facts.lifeSpan).toEqual({ begin: '1996', end: undefined });
    // "1" in strTwitter is junk TheAudioDB returns; an empty Facebook is no link.
    expect(facts.links).toEqual([{ url: 'https://www.coldplay.com/', type: 'official homepage' }]);
    expect(facts.tags.map((t) => t.name)).toEqual(['Alternative Rock', 'Rock/Pop', 'Happy']);
    expect(facts.tags.every((t) => t.providers.join() === 'theaudiodb')).toBe(true);
  });

  it('gives nothing for an artist without facts', () => {
    expect(theAudioDbFacts({ strArtist: 'X' })).toEqual({ area: undefined, country: undefined, lifeSpan: undefined, links: [], tags: [] });
  });
});

describe('mergeLinks', () => {
  it('keeps MusicBrainz links and adds only the ones it lacks', () => {
    const mb = [{ url: 'https://coldplay.com', type: 'official homepage' }];
    expect(mergeLinks(mb, [
      { url: 'https://www.coldplay.com/', type: 'official homepage' },
      { url: 'https://facebook.com/coldplay', type: 'social network' },
    ])).toEqual([...mb, { url: 'https://facebook.com/coldplay', type: 'social network' }]);
  });
});

describe('withDisplayTags', () => {
  it('marks a tag both have and adds the rest after', () => {
    const tags = [{ name: 'alternative rock', count: 100, providers: ['lastfm' as const] }];
    expect(withDisplayTags(tags, theAudioDbFacts(coldplay).tags)).toEqual([
      { name: 'alternative rock', count: 100, providers: ['lastfm', 'theaudiodb'] },
      { name: 'Rock/Pop', count: 100, providers: ['theaudiodb'] },
      { name: 'Happy', count: 100, providers: ['theaudiodb'] },
    ]);
  });
});
