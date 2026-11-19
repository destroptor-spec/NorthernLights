import { auroraApiRequest, type Track } from '../api/auroraApi';
import { toPlayableTracks } from './playableTracks';
import type { TrackInfo } from './fileSystem';

type AlbumOrderTrack = Pick<TrackInfo, 'discNumber' | 'trackNumber' | 'title' | 'path'>;

/** Album order: disc, then track number, then title (tracks without a number last). */
export function compareAlbumOrder(a: AlbumOrderTrack, b: AlbumOrderTrack): number {
  const discA = a.discNumber ?? 1;
  const discB = b.discNumber ?? 1;
  if (discA !== discB) return discA - discB;
  if (a.trackNumber != null && b.trackNumber != null) return a.trackNumber - b.trackNumber;
  if (a.trackNumber != null) return -1;
  if (b.trackNumber != null) return 1;
  const aName = a.title || a.path.split(/[\\/]/).pop() || '';
  const bName = b.title || b.path.split(/[\\/]/).pop() || '';
  return aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' });
}

/** An album's tracks from API v1, playable and in album order. */
export async function fetchAlbumTracks(albumId: string, authHeader: Record<string, string>): Promise<TrackInfo[]> {
  const album = await auroraApiRequest<{ tracks: Track[] }>(`/albums/${encodeURIComponent(albumId)}`, authHeader);
  return toPlayableTracks(album.tracks || []).sort(compareAlbumOrder);
}
