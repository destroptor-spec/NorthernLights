import type { TrackInfo } from './fileSystem';
import { normalizeArtistIdentityKey, parseArtists, parseArtistsForDisplay } from './artistUtils';

interface ArtistLinkEntity {
  id: string;
  name?: string;
}

function setArtistLink(links: Map<string, string>, name: string | undefined, path: string): void {
  const cleanName = name?.trim();
  if (!cleanName) return;
  links.set(cleanName.toLowerCase(), path);
  const identityKey = normalizeArtistIdentityKey(cleanName);
  if (identityKey) links.set(identityKey, path);
}

export function buildArtistLinkMap(artists: ArtistLinkEntity[]): Map<string, string>;
export function buildArtistLinkMap(tracks: TrackInfo[], artists: ArtistLinkEntity[]): Map<string, string>;
export function buildArtistLinkMap(
  tracksOrArtists: TrackInfo[] | ArtistLinkEntity[],
  canonicalArtists?: ArtistLinkEntity[],
): Map<string, string> {
  const links = new Map<string, string>();
  const tracks = canonicalArtists ? tracksOrArtists as TrackInfo[] : [];
  const artists = canonicalArtists || tracksOrArtists as ArtistLinkEntity[];

  for (const track of tracks) {
    if (!track.artistId) continue;
    const isCompilation = track.isCompilation === true
      || track.isCompilation === 1
      || (track.releaseType || '').toLowerCase().includes('compilation');
    const arrayPrimary = Array.isArray(track.artists) ? track.artists[0] : undefined;
    const parsedPrimary = parseArtists(track.artist)[0];
    const linkedName = isCompilation
      ? arrayPrimary || parsedPrimary || track.artist
      : track.albumArtist || parsedPrimary || track.artist;
    setArtistLink(links, linkedName, `/library/artist/${encodeURIComponent(track.artistId)}`);
  }

  // Canonical entities win over track-derived fallbacks when stale track IDs
  // disagree with the current merged artist identity.
  for (const artist of artists) {
    if (!artist.id) continue;
    setArtistLink(links, artist.name, `/library/artist/${encodeURIComponent(artist.id)}`);
  }
  return links;
}

export function getTrackArtistDisplayNames(track: TrackInfo, knownArtistKeys: Set<string>): string[] {
  const raw = Array.isArray(track.artists) && track.artists.length > 0
    ? track.artists
    : parseArtistsForDisplay(
        (typeof track.artists === 'string' ? track.artists : '') || track.artist || track.albumArtist || '',
        knownArtistKeys,
      );
  return raw.flatMap(name => parseArtistsForDisplay(name, knownArtistKeys));
}

export function resolveTrackArtistLink(
  artistName: string,
  artistIndex: number,
  track: TrackInfo,
  artistLinkMap: ReadonlyMap<string, string>,
): string | null {
  const entityLink = resolveArtistLink(artistName, artistLinkMap);
  if (entityLink) return entityLink;
  if (artistIndex === 0 && track.artistId) {
    return `/library/artist/${encodeURIComponent(track.artistId)}`;
  }
  return null;
}

export function resolveArtistLink(
  artistName: string,
  artistLinkMap: ReadonlyMap<string, string>,
): string | null {
  return artistLinkMap.get(normalizeArtistIdentityKey(artistName))
    || artistLinkMap.get(artistName.toLowerCase())
    || null;
}
