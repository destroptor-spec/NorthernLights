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

  it('drops the display credit when a tagger lists it first among the people', () => {
    const dua = '6f1a58bf-9b1b-49cf-a44a-6cefad7ae04f';
    const tbm = '3f351696-75a2-4167-86b1-c5cd37770600';
    const gwen = '2e41ae9c-afd2-4f20-8f1e-17281ce9b472';
    const credit = 'Dua Lipa & the Blessed Madonna Feat. Gwen Stefani';
    expect(people({
      common: { artist: credit, artists: [credit, 'Dua Lipa', 'The Blessed Madonna', 'Gwen Stefani'], musicbrainz_artistid: [dua, tbm, gwen] },
    }).track).toEqual([
      { name: 'Dua Lipa', mbid: dua },
      { name: 'The Blessed Madonna', mbid: tbm },
      { name: 'Gwen Stefani', mbid: gwen },
    ]);
    // Without ids: the people after it are named in the credit.
    expect(people({
      common: { artist: 'Michael Jackson & the Jackson 5', artists: ['Michael Jackson & the Jackson 5', 'Michael Jackson', 'The Jackson 5'] },
    }).track?.map((p) => p.name)).toEqual(['Michael Jackson', 'The Jackson 5']);
  });

  it('drops a first entry naming the people after it when the ids line up with them', () => {
    const credit = 'María De Medeiros and Bruce Willis / the Centurions';
    expect(people({
      common: { artist: 'María De Medeiros and Bruce Willis', artists: [credit, 'María De Medeiros', 'Bruce Willis', 'The Centurions'], musicbrainz_artistid: [TONY, DIANA, GAGA] },
    }).track?.map((p) => p.name)).toEqual(['María De Medeiros', 'Bruce Willis', 'The Centurions']);
  });

  it('drops a mangled copy of the people and keeps a real act that shares the list', () => {
    const credit = '植松伸夫 & 河盛慶次';
    expect(people({ common: { artist: credit, artists: [credit, '植松伸夫', '河盛慶次', '???? & ????'] } }).track?.map((p) => p.name))
      .toEqual(['植松伸夫', '河盛慶次']);
    expect(people({ common: { artist: 'Riggi & Piros', artists: ['Riggi & Piros', 'Dani Poppitt'] } }).track?.map((p) => p.name))
      .toEqual(['Riggi & Piros', 'Dani Poppitt']);
    expect(people({ common: { artist: 'Above & Beyond', artists: ['Above & Beyond'] } }).track?.map((p) => p.name))
      .toEqual(['Above & Beyond']);
  });

  it('splits an ARTISTS tag that only copies a featuring credit at the marker', () => {
    const credit = 'Wale feat. Major Lazer, WizKid & Dua Lipa';
    expect(people({ common: { artist: credit, artists: [credit] } }).track?.map((p) => p.name)).toEqual(['Wale', 'Major Lazer', 'WizKid', 'Dua Lipa']);
    // The main act stays whole, comma and all; a lone id isn't trusted for anyone.
    const ecstasy = 'Ecstasy, Passion and Pain featuring Barbara Roy';
    expect(people({ common: { artist: ecstasy, artists: [ecstasy], musicbrainz_artistid: ['3a257121-867a-47cf-bc4f-ee7b835adddb'] } }).track).toEqual([
      { name: 'Ecstasy, Passion and Pain', mbid: null },
      { name: 'Barbara Roy', mbid: null },
    ]);
    // One act, or a featuring credit the tag doesn't merely copy, is still read.
    expect(people({ common: { artist: 'Above & Beyond', artists: ['Above & Beyond'] } }).track?.map((p) => p.name)).toEqual(['Above & Beyond']);
    expect(people({ common: { artist: 'Timbaland Feat. Magoo', artists: ['Timbaland', 'Magoo'] } }).track?.map((p) => p.name)).toEqual(['Timbaland', 'Magoo']);
  });

  it("puts back the album's own act when ARTISTS leaves it out but keeps its id first", () => {
    const shm = '99075985-0d80-4692-a15e-b16f78831792';
    const connie = '278161b3-eb37-45cc-b62e-8d124055c374';
    const ty = '7bd66c18-cb33-49aa-9279-140acedbdb49';
    const shake = '741dbc8e-1cd5-4a66-b2b8-43bbad87ae12';
    const album = { albumartist: 'Swedish House Mafia', musicbrainz_albumartistid: [shm] };
    expect(people({
      common: { ...album, artist: 'Swedish House Mafia & Connie Constance', artists: ['Connie Constance'], musicbrainz_artistid: [shm, connie] },
    }).track).toEqual([{ name: 'Swedish House Mafia', mbid: shm }, { name: 'Connie Constance', mbid: connie }]);
    expect(people({
      common: { ...album, artist: 'Swedish House Mafia feat. Ty Dolla $ign & 070 Shake', artists: ['Ty Dolla $ign', '070 Shake'], musicbrainz_artistid: [shm, ty, shake] },
    }).track?.map((p) => p.name)).toEqual(['Swedish House Mafia', 'Ty Dolla $ign', '070 Shake']);
    // The album-artist tag can be a credit itself; the act is named from the track credit.
    const armin = '477b8c0c-c5fc-4ad2-b5b2-191f0bf2a9df';
    expect(people({
      common: { albumartist: 'Armin van Buuren & Olive Anguz', musicbrainz_albumartistid: [armin], artist: 'Armin van Buuren & XiJaro & Pitch', artists: ['XiJaro & Pitch'], musicbrainz_artistid: [armin, connie] },
    }).track).toEqual([{ name: 'Armin van Buuren', mbid: armin }, { name: 'XiJaro & Pitch', mbid: connie }]);
    // Nothing left of the credit once the listed people are out: names only.
    expect(people({
      common: { albumartist: 'Beyoncé featuring Slim Thug', musicbrainz_albumartistid: [shm], artist: 'Beyoncé featuring Slim Thug', artists: ['Beyoncé', 'Slim Thug'], musicbrainz_artistid: [shm, ty, shake] },
    }).track?.map((p) => p.name)).toEqual(['Beyoncé', 'Slim Thug']);
    // Not the album's act (a compilation): still the act the credit names first.
    expect(people({
      common: { albumartist: 'Various Artists', musicbrainz_albumartistid: [VA], artist: 'Need for Mirrors feat. Onallee', artists: ['Onallee'], musicbrainz_artistid: [TONY, connie] },
    }).track).toEqual([{ name: 'Need for Mirrors', mbid: TONY }, { name: 'Onallee', mbid: connie }]);
    // The listed person comes first in the credit: nothing to put ahead of them.
    expect(people({
      common: { artist: 'Onallee (Need for Mirrors Remix)', artists: ['Onallee'], musicbrainz_artistid: [TONY, connie] },
    }).track).toEqual([{ name: 'Onallee', mbid: null }]);
  });

  it("keeps the album artist's id for them when extra ids follow (a band's members)", () => {
    const ffdp = '7e8571b1-7c5a-4739-bc51-73d422ee9d74';
    expect(people({
      common: { albumartist: 'Five Finger Death Punch', musicbrainz_albumartistid: [ffdp, TONY], artist: 'Five Finger Death Punch', artists: ['Five Finger Death Punch'], musicbrainz_artistid: [ffdp, TONY, DIANA] },
    }).track).toEqual([{ name: 'Five Finger Death Punch', mbid: ffdp }]);
    // Not the album artist: no id.
    expect(people({
      common: { albumartist: 'Various Artists', musicbrainz_albumartistid: [VA], artist: 'Someone', artists: ['Someone'], musicbrainz_artistid: [VA, TONY] },
    }).track).toEqual([{ name: 'Someone', mbid: null }]);
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
