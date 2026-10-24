import { albumArtistPeople, trackArtistPeople, type TagSource } from './tagPeople';

// Ids and tag layouts copied from real library files.
const TONY = '8be0594f-8c13-46bb-ab06-f93ffba5c776';
const DIANA = '67d2cb7a-9ddb-4a7f-82bf-5a2d1a038e98';
const CHARLAP = '8586b4ce-49e8-42a5-80b6-0d4429f99850';
const GAGA = '650e7db6-b795-4eb5-a702-5ea2fc46c848';
const VA = '89ad4ac3-39f7-470e-963a-56509c546377';

// Real files carry the ARTISTS tag next to the common fields; add it like a tagger would.
const withArtistsTag = (source: TagSource): TagSource => {
  const names = Array.isArray(source.common.artists) ? source.common.artists as string[] : [];
  const tags = Object.values(source.native || {}).flat();
  return { ...source, native: { vorbis: [...tags, ...names.map((value) => ({ id: 'ARTISTS', value }))] } };
};
const people = (source: TagSource) => {
  const tagged = withArtistsTag(source);
  const track = trackArtistPeople(tagged);
  return { track, album: albumArtistPeople(tagged, track) };
};

describe('per-person credits from tags', () => {
  it('reads the performers and album artists of a duet album that repeats the people after the album credit', () => {
    const credit = 'Tony Bennett & Diana Krall With Bill Charlap Trio';
    const source: TagSource = {
      common: {
        artists: ['Tony Bennett', 'Diana Krall', 'Bill Charlap Trio'],
        musicbrainz_artistid: [TONY, DIANA, CHARLAP],
        albumartist: credit,
        musicbrainz_albumartistid: [TONY, DIANA, CHARLAP],
      },
      native: { vorbis: [credit, 'Tony Bennett', 'Diana Krall', 'Bill Charlap Trio'].map((value) => ({ id: 'ALBUMARTIST', value })) },
    };
    const expected = [
      { name: 'Tony Bennett', mbid: TONY },
      { name: 'Diana Krall', mbid: DIANA },
      { name: 'Bill Charlap Trio', mbid: CHARLAP },
    ];
    expect(people(source)).toEqual({ track: expected, album: expected });
  });

  it('keeps a solo track on that album with its own performer', () => {
    const credit = 'Tony Bennett & Diana Krall With Bill Charlap Trio';
    const { track, album } = people({
      common: { artists: ['Diana Krall'], musicbrainz_artistid: [DIANA], albumartist: credit, musicbrainz_albumartistid: [TONY, DIANA, CHARLAP] },
      native: { vorbis: [credit, 'Tony Bennett', 'Diana Krall', 'Bill Charlap Trio'].map((value) => ({ id: 'ALBUMARTIST', value })) },
    });
    expect(track).toEqual([{ name: 'Diana Krall', mbid: DIANA }]);
    expect(album?.map((p) => p.name)).toEqual(['Tony Bennett', 'Diana Krall', 'Bill Charlap Trio']);
  });

  it('uses an ALBUMARTISTS list when the file has one', () => {
    const { album } = people({
      common: { artists: ['Tony Bennett', 'Lady Gaga'], musicbrainz_artistid: [TONY, GAGA], albumartist: 'Tony Bennett & Lady Gaga', musicbrainz_albumartistid: [TONY, GAGA] },
      native: { vorbis: [{ id: 'ALBUMARTISTS', value: 'Tony Bennett' }, { id: 'ALBUMARTISTS', value: 'Lady Gaga' }] },
    });
    expect(album).toEqual([{ name: 'Tony Bennett', mbid: TONY }, { name: 'Lady Gaga', mbid: GAGA }]);
  });

  it('names album artists by matching their ids to the track performers', () => {
    const snoop = 'f90e8b26-9e52-4669-a5c9-e28529c47894';
    const dre = '5f6ab597-f57a-40da-be9e-adad48708203';
    const { album } = people({
      common: {
        artists: ['Snoop Dogg', 'Dr. Dre', 'Kaan'],
        musicbrainz_artistid: [snoop, dre, '870c3759-8e2a-4803-8cbf-644f3543830d'],
        albumartist: 'Snoop Dogg & Dr. Dre',
        musicbrainz_albumartistid: [snoop, dre],
      },
    });
    expect(album).toEqual([{ name: 'Snoop Dogg', mbid: snoop }, { name: 'Dr. Dre', mbid: dre }]);
  });

  it('reads people repeated after the credit in a NUL-separated ID3v2.3 album artist', () => {
    const blaes = '64f63cfd-367c-4c94-bd57-bd159281c1fc';
    const natasja = '6b678f17-c410-4027-8c74-e071de98b216';
    const { album } = people({
      common: {
        artists: ['Laura Bro', 'Natasja'],
        musicbrainz_artistid: ['48151ded-6837-4c6b-a622-6db915dd56c1', natasja],
        albumartist: 'Blæs Bukki Feat. Natasja\0Blæs Bukki\0Natasja',
        musicbrainz_albumartistid: [blaes, natasja],
      },
    });
    expect(album).toEqual([{ name: 'Blæs Bukki', mbid: blaes }, { name: 'Natasja', mbid: natasja }]);
  });

  it('treats a single album-artist id as one act named by the credit', () => {
    const above = '370bd5a3-4abf-4356-8576-3a8fc0c11d65';
    expect(people({
      common: { artists: ['Above & Beyond', 'Zoë Johnston'], musicbrainz_artistid: [above, '5509e5eb-67a4-49e9-992a-07d895500deb'], albumartist: 'Above & Beyond', musicbrainz_albumartistid: [above] },
    }).album).toEqual([{ name: 'Above & Beyond', mbid: above }]);
    expect(people({
      common: { artists: ['Bill Withers'], musicbrainz_artistid: ['fd1a2d9d-9bb6-44de-83a3-41560658aba9'], albumartist: 'Various Artists', musicbrainz_albumartistid: [VA] },
    }).album).toEqual([{ name: 'Various Artists', mbid: VA }]);
  });

  it('keeps a name with a comma as one person', () => {
    expect(people({ common: { artists: ['Tyler, the Creator', 'Daniel Caesar'] } }).track).toEqual([
      { name: 'Tyler, the Creator', mbid: null },
      { name: 'Daniel Caesar', mbid: null },
    ]);
  });

  it('gives names without ids when the id list does not line up, and drops malformed ids', () => {
    expect(people({ common: { artists: ['A', 'B'], musicbrainz_artistid: [TONY] } }).track).toEqual([
      { name: 'A', mbid: null },
      { name: 'B', mbid: null },
    ]);
    expect(people({ common: { artists: ['A'], musicbrainz_artistid: ['not-an-id'] } }).track).toEqual([{ name: 'A', mbid: null }]);
  });

  it('returns null when the file does not say who the people are', () => {
    const source: TagSource = { common: { artists: ['Riggi & Piros', 'Dani Poppitt'], albumartist: 'Various Artists' } };
    expect(people(source)).toEqual({
      track: [{ name: 'Riggi & Piros', mbid: null }, { name: 'Dani Poppitt', mbid: null }],
      album: null,
    });
    expect(trackArtistPeople({ common: { albumartist: 'Someone' } })).toBeNull();
  });

  it('does not trust common.artists when the file has no ARTISTS tag (music-metadata copies the display credit)', () => {
    expect(trackArtistPeople({
      common: { artists: ['Reel 2 Real Feat. The Mad Stuntman'], musicbrainz_artistid: ['00000000-0000-4000-8000-000000000001'] },
      native: { 'ID3v2.3': [{ id: 'TPE1', value: 'Reel 2 Real Feat. The Mad Stuntman' }] },
    })).toBeNull();
  });
});
