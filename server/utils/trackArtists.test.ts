import { resolveTrackArtists } from './trackArtists';

const TONY = '8be0594f-8c13-46bb-ab06-f93ffba5c776';
const DIANA = '67d2cb7a-9ddb-4a7f-82bf-5a2d1a038e98';

describe('resolveTrackArtists', () => {
  it('gives the track to its first performer, each person with their own MusicBrainz id', () => {
    const artistPeople = [{ name: 'Tony Bennett', mbid: TONY }, { name: 'Diana Krall', mbid: DIANA }];
    expect(resolveTrackArtists({
      artistPeople,
      artists: ['Tony Bennett', 'Diana Krall'],
      artist: 'Tony Bennett & Diana Krall With Bill Charlap Trio',
      mbArtistId: TONY,
    })).toEqual({ people: artistPeople, primary: artistPeople[0] });
  });

  it('keeps a solo track with its performer, not the album credit', () => {
    expect(resolveTrackArtists({ artistPeople: [{ name: 'Diana Krall', mbid: DIANA }], artist: 'Diana Krall' }).primary)
      .toEqual({ name: 'Diana Krall', mbid: DIANA });
  });

  describe('files without per-person tags', () => {
    it('splits the display credit and trusts the first id only for a single artist', () => {
      expect(resolveTrackArtists({ artist: 'Eminem', mbArtistId: 'b95ce3ff-3d05-4e87-9e01-c97b66af13d4' })).toEqual({
        people: [{ name: 'Eminem', mbid: 'b95ce3ff-3d05-4e87-9e01-c97b66af13d4' }],
        primary: { name: 'Eminem', mbid: 'b95ce3ff-3d05-4e87-9e01-c97b66af13d4' },
      });
      expect(resolveTrackArtists({ artist: 'Reel 2 Real feat. The Mad Stuntman', mbArtistId: TONY })).toEqual({
        people: [{ name: 'Reel 2 Real', mbid: null }, { name: 'The Mad Stuntman', mbid: null }],
        primary: { name: 'Reel 2 Real', mbid: null },
      });
    });

    it('uses a legacy name list when there is one', () => {
      expect(resolveTrackArtists({ artists: ['Snoop Dogg feat. Kaan'], artist: 'ignored' }).people.map((p) => p.name))
        .toEqual(['Snoop Dogg', 'Kaan']);
    });

    it('returns no primary when the file names no artist', () => {
      expect(resolveTrackArtists({})).toEqual({ people: [], primary: null });
      expect(resolveTrackArtists({ artistPeople: [], artist: '  ' })).toEqual({ people: [], primary: null });
    });
  });
});
