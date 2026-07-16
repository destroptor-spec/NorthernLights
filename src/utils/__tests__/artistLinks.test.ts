import { buildArtistLinkMap } from '../artistLinks';

const tiesto = { id: 'artist-tiesto', name: 'Tiësto' };
const york = { id: 'artist-york', name: 'York' };

describe('buildArtistLinkMap', () => {
  it('keeps the album-artist link on the album artist for compilation tracks', () => {
    // Mixed DJ-mix compilation: every track carries albumArtist "Tiësto",
    // but each track's artistId is the per-track performer. The header's
    // "Tiësto" link must not be hijacked by a performer's artistId.
    const links = buildArtistLinkMap(
      [
        { id: 't1', path: 'a', artist: 'York', albumArtist: 'Tiësto', artistId: york.id, isCompilation: true },
        { id: 't2', path: 'b', artist: 'Lange', albumArtist: 'Tiësto', artistId: 'artist-lange', isCompilation: true },
      ],
      [tiesto, york],
    );

    expect(links.get('tiësto')).toBe(`/library/artist/${tiesto.id}`);
    expect(links.get('york')).toBe(`/library/artist/${york.id}`);
  });

  it('maps performer names, not the album artist, from compilation tracks before entities hydrate', () => {
    const links = buildArtistLinkMap(
      [{ id: 't1', path: 'a', artist: 'York', albumArtist: 'Tiësto', artistId: york.id, isCompilation: true }],
      [],
    );

    expect(links.get('york')).toBe(`/library/artist/${york.id}`);
    expect(links.has('tiësto')).toBe(false);
  });

  it('maps the album artist for normal album tracks, including feature-credit artist strings', () => {
    // On a non-compilation album, artistId IS the album artist even when the
    // track-level artist string carries a feature credit.
    const links = buildArtistLinkMap(
      [{ id: 't1', path: 'a', artist: 'Tiësto feat. BT', albumArtist: 'Tiësto', artistId: tiesto.id }],
      [],
    );

    expect(links.get('tiësto')).toBe(`/library/artist/${tiesto.id}`);
  });

  it('detects compilation context from releaseType', () => {
    const links = buildArtistLinkMap(
      [{ id: 't1', path: 'a', artist: 'York', albumArtist: 'Tiësto', artistId: york.id, releaseType: 'album; compilation' }],
      [],
    );

    expect(links.has('tiësto')).toBe(false);
    expect(links.get('york')).toBe(`/library/artist/${york.id}`);
  });

  it('prefers the artists-array primary credit over the display artist string on compilations', () => {
    const links = buildArtistLinkMap(
      [{
        id: 't1', path: 'a', artist: 'Libra Presents Taylor', artists: ['Libra'],
        albumArtist: 'Tiësto', artistId: 'artist-libra', isCompilation: true,
      }],
      [],
    );

    expect(links.get('libra')).toBe('/library/artist/artist-libra');
  });

  it('lets canonical entities win over track-derived fallbacks', () => {
    // A stale/divergent track mapping must not shadow the canonical entity.
    const links = buildArtistLinkMap(
      [{ id: 't1', path: 'a', artist: 'York', albumArtist: 'York', artistId: 'artist-stale' }],
      [york],
    );

    expect(links.get('york')).toBe(`/library/artist/${york.id}`);
  });
});
