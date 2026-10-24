// How a review outcome changes the artist pages involved, computed from the
// tracks on those pages today: rename the names the outcome changes, then lay
// each page out as the artist page does (own releases vs "Also appears on").
// Pure, so the preview and the page can be checked against each other.

import type { ArtistPagePreview, ReleasePreview } from '../../shared/artistReview';

export interface PreviewTrack {
  id: string;
  albumId: string | null;
  albumTitle: string;
  year: number | null;
  isCompilation: boolean;
  /** The performer the track belongs to. */
  owner: string;
  /** The other performers credited on it. */
  credited: string[];
  /** Who owns the album: its album-artist credit, or the artists it names. */
  albumOwners: string[];
}

export interface PreviewArtist {
  name: string;
  artistId: string | null;
  imageUrl: string | null;
}

/** Identity key of a name → the names it becomes. Merging B into A maps B to
 * [A]; splitting a joined credit maps it to its artists. */
export type NameChanges = Map<string, string[]>;

type KeyOf = (name: string) => string;

const uniqueBy = (names: string[], keyOf: KeyOf) => {
  const seen = new Set<string>();
  return names.filter(name => {
    const key = keyOf(name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export function applyNameChanges(tracks: PreviewTrack[], changes: NameChanges, keyOf: KeyOf): PreviewTrack[] {
  const rename = (name: string) => changes.get(keyOf(name)) || [name];
  return tracks.map(track => {
    const owners = rename(track.owner);
    const owner = owners[0];
    const credited = uniqueBy([...owners.slice(1), ...track.credited.flatMap(rename)], keyOf)
      .filter(name => keyOf(name) !== keyOf(owner));
    return { ...track, owner, credited, albumOwners: uniqueBy(track.albumOwners.flatMap(rename), keyOf) };
  });
}

interface PageLayout {
  ownTracks: number;
  releases: Map<string, ReleasePreview>;
  appearances: Map<string, ReleasePreview>;
}

const albumKeyOf = (track: PreviewTrack) => track.albumId || `title:${track.albumTitle.toLowerCase()}`;

function layoutPage(name: string, tracks: PreviewTrack[], keyOf: KeyOf): PageLayout {
  const key = keyOf(name);
  const albums = new Map<string, PreviewTrack[]>();
  for (const track of tracks) albums.set(albumKeyOf(track), [...(albums.get(albumKeyOf(track)) || []), track]);

  const layout: PageLayout = { ownTracks: 0, releases: new Map(), appearances: new Map() };
  for (const [albumKey, albumTracks] of albums) {
    const ownsAlbum = albumTracks.some(track => track.albumOwners.some(owner => keyOf(owner) === key));
    const owned = albumTracks.filter(track => keyOf(track.owner) === key);
    const onPage = albumTracks.filter(track => keyOf(track.owner) === key || track.credited.some(c => keyOf(c) === key));
    layout.ownTracks += owned.length;
    if (!ownsAlbum && onPage.length === 0) continue;
    // As on the artist page: a track the artist owns on someone else's
    // compilation, or a credit on someone else's album, is an appearance.
    const isCompilation = albumTracks.some(track => track.isCompilation);
    const own = ownsAlbum || (owned.length > 0 && !isCompilation);
    const first = albumTracks[0];
    (own ? layout.releases : layout.appearances).set(albumKey, {
      albumId: first.albumId,
      title: first.albumTitle,
      year: first.year,
      tracks: ownsAlbum ? albumTracks.length : onPage.length,
      change: null,
    });
  }
  return layout;
}

function compareReleases(before: Map<string, ReleasePreview>, after: Map<string, ReleasePreview>): ReleasePreview[] {
  const rows: ReleasePreview[] = [];
  for (const [key, release] of after) rows.push({ ...release, change: before.has(key) ? null : 'added' });
  for (const [key, release] of before) if (!after.has(key)) rows.push({ ...release, change: 'removed' });
  return rows.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));
}

const sameReleases = (a: Map<string, ReleasePreview>, b: Map<string, ReleasePreview>) =>
  a.size === b.size && [...a].every(([key, release]) => b.get(key)?.tracks === release.tracks);

/** Each artist's page with the outcome applied (`after`), compared with today (`before`). */
export function previewArtistPages(
  artists: PreviewArtist[],
  before: PreviewTrack[],
  after: PreviewTrack[],
  keyOf: KeyOf,
): ArtistPagePreview[] {
  return artists.map(artist => {
    const now = layoutPage(artist.name, before, keyOf);
    const next = layoutPage(artist.name, after, keyOf);
    const empty = next.ownTracks === 0 && next.releases.size === 0 && next.appearances.size === 0;
    const unchanged = now.ownTracks === next.ownTracks
      && sameReleases(now.releases, next.releases) && sameReleases(now.appearances, next.appearances);
    return {
      ...artist,
      status: unchanged ? 'unchanged' : empty ? 'removed' : 'changed',
      ownTracks: next.ownTracks,
      ownTracksBefore: now.ownTracks,
      releases: compareReleases(now.releases, next.releases),
      appearances: compareReleases(now.appearances, next.appearances),
    };
  });
}
