import { usePlayerStore } from '../store/index';
import { toLegacyTrack, type Track } from '../api/auroraApi';
import type { TrackInfo } from './fileSystem';

/**
 * Turn API v1 tracks into playable TrackInfo with the current media token and
 * streaming quality — the same conversion the store applies to playlist
 * tracks. Shared by every view that reads tracks from v1.
 */
export function toPlayableTracks(tracks: Track[]): TrackInfo[] {
  const { mediaAccessToken, authToken, streamingQuality } = usePlayerStore.getState();
  const token = mediaAccessToken || authToken || '';
  return tracks.map((track) => toLegacyTrack(track, token, streamingQuality));
}
