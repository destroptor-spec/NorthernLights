import { useEffect, useState } from 'react';
import { fetchArtistTopTracks, peekArtistTopTracks, type ArtistTopTrackData } from '../utils/externalImagery';

const emptyTracks: ArtistTopTrackData[] = [];

export const useArtistTopTracks = (
  artistName: string,
  options?: { enabled?: boolean; limit?: number }
) => {
  const enabled = options?.enabled !== false;
  const limit = options?.limit ?? 25;
  const eligible = enabled && !!artistName && artistName !== 'Unknown Artist';
  const [result, setResult] = useState<{
    artistName: string; limit: number; tracks: ArtistTopTrackData[]; error?: string;
  }>();

  useEffect(() => {
    if (!eligible) {
      setResult(undefined);
      return;
    }
    let active = true;
    fetchArtistTopTracks(artistName, limit).then(tracks => {
      if (active) setResult({ artistName, limit, tracks });
    }).catch((err: unknown) => {
      if (active) setResult({ artistName, limit, tracks: [], error: err instanceof Error ? err.message : 'Failed to load popular tracks' });
    });
    return () => {
      active = false;
    };
  }, [artistName, eligible, limit]);

  const current = eligible && result?.artistName === artistName && result.limit === limit ? result : undefined;
  const cached = eligible ? peekArtistTopTracks(artistName, limit) : undefined;
  return { tracks: cached ?? current?.tracks ?? emptyTracks, isLoading: eligible && !current && !cached, error: current?.error };
};
