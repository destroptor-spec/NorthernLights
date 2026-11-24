/**
 * @jest-environment node
 */
import { extractUrlTags, linkType } from './fileLinks';

describe('extractUrlTags', () => {
  it('reads Picard’s per-site link tags, not only the URL_* names', () => {
    const links = extractUrlTags({
      vorbis: [
        { id: 'DISCOGS.COM', value: 'https://www.discogs.com/release/17995570' },
        { id: 'ALLMUSIC.COM', value: 'https://www.allmusic.com/album/mw0003359848' },
        { id: 'WIKIDATA.ORG', value: 'https://www.wikidata.org/wiki/Q21914464' },
        { id: 'LAST.FM', value: 'https://www.last.fm/music/Pendulum' },
        { id: 'SOCIAL MEDIA', value: 'https://www.instagram.com/pendulum' },
        { id: 'URL_DISCOGS_ARTIST_PAGE', value: 'https://www.discogs.com/artist/4357593' },
        // Not links: left alone.
        { id: 'COMMENT', value: 'Visit https://example.com for more' },
        { id: 'LABEL', value: 'Warner Records' },
      ],
    });
    expect(links).toEqual([
      { url: 'https://www.discogs.com/release/17995570', type: 'discogs' },
      { url: 'https://www.allmusic.com/album/mw0003359848', type: 'allmusic' },
      { url: 'https://www.wikidata.org/wiki/Q21914464', type: 'wikidata' },
      { url: 'https://www.last.fm/music/Pendulum', type: 'last.fm' },
      { url: 'https://www.instagram.com/pendulum', type: 'social network' },
      { url: 'https://www.discogs.com/artist/4357593', type: 'discogs' },
    ]);
  });

  it('reads a link in an ID3 user text frame and in MP4 freeform tags', () => {
    expect(extractUrlTags({
      'ID3v2.4': [{ id: 'TXXX', value: { description: 'DISCOGS.COM', text: ['https://www.discogs.com/master/1705638'] } }],
      iTunes: [{ id: '----:com.apple.iTunes:ALLMUSIC.COM', value: 'https://www.allmusic.com/album/release/mr0005356055' }],
    })).toEqual([
      { url: 'https://www.discogs.com/master/1705638', type: 'discogs' },
      { url: 'https://www.allmusic.com/album/release/mr0005356055', type: 'allmusic' },
    ]);
  });

  it('keeps each link once', () => {
    expect(extractUrlTags({ vorbis: [
      { id: 'URL_DISCOGS_RELEASE_PAGE', value: 'https://www.discogs.com/release/1' },
      { id: 'DISCOGS.COM', value: 'https://www.discogs.com/release/1' },
    ] })).toHaveLength(1);
  });
});

it('names a link’s kind by its site', () => {
  expect(linkType('https://gretavanfleetmusic.bandcamp.com/')).toBe('bandcamp');
  expect(linkType('https://example.org/')).toBe('other');
  expect(linkType('not a url')).toBe('other');
});
