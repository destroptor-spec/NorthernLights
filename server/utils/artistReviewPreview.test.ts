import { applyNameChanges, previewArtistPages, type PreviewTrack } from './artistReviewPreview';

const keyOf = (name: string) => name.toLowerCase();
let nextId = 0;
const track = (owner: string, album: string, opts: Partial<PreviewTrack> = {}): PreviewTrack => ({
  id: `t${nextId++}`,
  albumId: album,
  albumTitle: album,
  year: 1982,
  isCompilation: false,
  owner,
  credited: [],
  albumOwners: [owner],
  ...opts,
});
const artist = (name: string) => ({ name, artistId: null, imageUrl: null });

describe('previewArtistPages', () => {
  const GF5 = 'Grandmaster Flash & The Furious Five';
  const library = [
    ...Array.from({ length: 3 }, () => track(GF5, 'The Message')),
    track('Grandmaster Flash', 'They Said It Couldn\'t Be Done'),
    track('Various Artists', 'Old School Hits', { owner: GF5, isCompilation: true, albumOwners: ['Various Artists'] }),
  ];
  const pages = [artist(GF5), artist('Grandmaster Flash'), artist('The Furious Five')];

  it('keeps every page as it is when nothing changes', () => {
    const result = previewArtistPages(pages, library, library, keyOf);
    expect(result.map(p => p.status)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(result[0]).toMatchObject({
      ownTracks: 4,
      releases: [{ title: 'The Message', tracks: 3, change: null }],
      appearances: [{ title: 'Old School Hits', tracks: 1, change: null }],
    });
  });

  it('shows a split: the first name owns the tracks, both own the album, the joined page goes', () => {
    const after = applyNameChanges(library, new Map([[keyOf(GF5), ['Grandmaster Flash', 'The Furious Five']]]), keyOf);
    const [joined, flash, five] = previewArtistPages(pages, library, after, keyOf);

    expect(joined).toMatchObject({ status: 'removed', ownTracks: 0, ownTracksBefore: 4 });
    expect(joined.releases).toEqual([expect.objectContaining({ title: 'The Message', change: 'removed' })]);

    expect(flash).toMatchObject({ status: 'changed', ownTracks: 5, ownTracksBefore: 1 });
    expect(flash.releases.map(r => [r.title, r.tracks, r.change])).toEqual([
      ['The Message', 3, 'added'],
      ["They Said It Couldn't Be Done", 1, null],
    ]);
    expect(flash.appearances.map(r => [r.title, r.change])).toEqual([['Old School Hits', 'added']]);

    // Credited on every track of an album it co-owns, a guest on the compilation.
    expect(five).toMatchObject({ status: 'changed', ownTracks: 0 });
    expect(five.releases.map(r => [r.title, r.tracks, r.change])).toEqual([['The Message', 3, 'added']]);
    expect(five.appearances.map(r => [r.title, r.change])).toEqual([['Old School Hits', 'added']]);
  });

  it('shows a merge: the kept artist gains the tracks and albums, the other page goes', () => {
    const spelling = [track('Tiesto', 'Kaleidoscope', { year: 2009 }), track('Tiësto', 'Elements of Life', { year: 2007 })];
    const after = applyNameChanges(spelling, new Map([[keyOf('Tiesto'), ['Tiësto']]]), keyOf);
    const [kept, folded] = previewArtistPages([artist('Tiësto'), artist('Tiesto')], spelling, after, keyOf);
    expect(kept).toMatchObject({ status: 'changed', ownTracks: 2, ownTracksBefore: 1 });
    expect(kept.releases.map(r => [r.title, r.change])).toEqual([['Kaleidoscope', 'added'], ['Elements of Life', null]]);
    expect(folded).toMatchObject({ status: 'removed', ownTracks: 0 });
  });
});
