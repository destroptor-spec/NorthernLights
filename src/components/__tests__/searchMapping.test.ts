import { hydrateRankedResults } from '../SearchResultsPage';
import { mapQuickSearchResults } from '../GlobalSearch';
import { usePlayerStore } from '../../store';
import type { AlbumSummary, ArtistSummary, Track } from '../../api/auroraApi';

/**
 * Both search screens now read API v1 DTOs. Their cards were written against
 * the legacy rows (artist_name, image_url), so these mappings carry the
 * renamed fields across — a wrong name renders as "Unknown Artist" or a
 * missing cover, with no error anywhere.
 */
const track = (id: string): Track => ({
  id, title: `Track ${id}`, artist: 'Tove Lo', albumArtist: null, artists: ['Tove Lo'], album: 'Album',
  genre: null, genres: [], durationSeconds: 100, trackNumber: null, discNumber: null, year: null,
  releaseType: null, compilation: false, bitrate: null, format: 'FLAC', lossless: true, fileSize: null,
  mediaEtag: null, artistId: null, albumId: null, genreId: null, loved: false, rating: 0, playCount: 0,
  lastPlayedAt: null, artworkId: null, artworkUrl: null,
  musicBrainz: { recordingId: null, trackId: null, albumId: null, artistId: null, albumArtistId: null, releaseGroupId: null, workId: null },
});
const artist = { id: 'a1', name: 'Tove Lo', imageUrl: 'https://img/a1' } as ArtistSummary;
const album = { id: 'b1', title: 'Queen of the Clouds', artistName: 'Tove Lo', imageUrl: 'https://img/b1' } as AlbumSummary;

beforeEach(() => usePlayerStore.setState({ mediaAccessToken: 'media', authToken: 'jwt', streamingQuality: 'auto' } as never));

describe('quick search dropdown', () => {
  it('maps v1 artists, albums and tracks into the dropdown shapes', () => {
    const out = mapQuickSearchResults({ artists: [artist], albums: [album], tracks: [track('t1')] });
    expect(out.matchedArtists).toEqual([{ name: 'Tove Lo', id: 'a1' }]);
    expect(out.matchedAlbums).toEqual([{ title: 'Queen of the Clouds', artist: 'Tove Lo', id: 'b1', artUrl: 'https://img/b1' }]);
    expect(out.matchedTracks.map((t) => t.id)).toEqual(['t1']);
    expect(out.matchedTracks[0].url).toContain('media');
  });

  it('falls back when an album lacks a title, artist or cover', () => {
    const out = mapQuickSearchResults({ albums: [{ id: 'b2', title: '', artistName: '', imageUrl: null } as unknown as AlbumSummary] });
    expect(out.matchedAlbums[0]).toEqual({ title: 'Unknown Album', artist: 'Unknown Artist', id: 'b2', artUrl: undefined });
  });

  it('copes with missing sections', () => {
    expect(mapQuickSearchResults({})).toEqual({ matchedArtists: [], matchedAlbums: [], matchedTracks: [] });
  });
});

describe('full search results page', () => {
  it('keeps the order and converts each kind for its card', () => {
    const out = hydrateRankedResults([
      { type: 'track', relevance: 90, item: track('t1') },
      { type: 'artist', relevance: 80, item: artist },
      { type: 'album', relevance: 70, item: album },
    ]);
    expect(out.map((r) => `${r.type}:${r.item.id}`)).toEqual(['track:t1', 'artist:a1', 'album:b1']);
    expect(out[1].item).toEqual({ id: 'a1', name: 'Tove Lo', image_url: 'https://img/a1' });
    expect(out[2].item).toEqual({ id: 'b1', title: 'Queen of the Clouds', artist_name: 'Tove Lo', image_url: 'https://img/b1' });
    expect((out[0].item as { url?: string }).url).toContain('media');
  });

  it('skips malformed hits instead of rendering broken cards', () => {
    const out = hydrateRankedResults([
      { type: 'artist', relevance: 1, item: { id: 'a2' } as unknown as ArtistSummary },
      { type: 'album', relevance: 1, item: undefined as unknown as AlbumSummary },
    ]);
    expect(out).toEqual([]);
  });
});
