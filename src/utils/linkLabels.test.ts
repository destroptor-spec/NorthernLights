import { getLinkLabel, isArtistLevelUrl, isArtistPageUrl } from './linkLabels';

describe('isArtistPageUrl (left off the album page)', () => {
  it.each([
    ['https://www.discogs.com/artist/4357593', true],
    ['https://www.discogs.com/release/17995570', false],
    ['https://www.discogs.com/master/1705638', false],
    ['https://www.allmusic.com/artist/mn0003426731', true],
    ['https://www.allmusic.com/album/mw0003359848', false],
    ['https://www.last.fm/music/Pendulum', true],
    ['https://www.last.fm/music/Pendulum/Hold+Your+Colour', false],
    ['https://gretavanfleetmusic.bandcamp.com/', true],
    ['https://gretavanfleetmusic.bandcamp.com/album/starcatcher', false],
    ['https://www.instagram.com/pendulum', true],
    ['https://open.spotify.com/album/abc', false],
    ['https://www.wikidata.org/wiki/Q21914464', false], // could be either: shown on both pages
  ])('%s → %s', (url, expected) => {
    expect(isArtistPageUrl(url)).toBe(expected);
  });
});

it('keeps release links off the artist page, as before', () => {
  expect(isArtistLevelUrl('https://www.discogs.com/release/17995570')).toBe(false);
  expect(isArtistLevelUrl('https://www.wikidata.org/wiki/Q21914464')).toBe(true);
});

it('labels links by their site', () => {
  expect(getLinkLabel('https://www.wikidata.org/wiki/Q1', 'wikidata')).toBe('Wikidata');
  expect(getLinkLabel('https://www.allmusic.com/album/x', 'allmusic')).toBe('AllMusic');
});
