import { useEffect, useMemo, useState } from 'react';
import { usePlayerStore } from '../store/index';
import { auroraApiRequest, toLegacyTrack, type Track } from '../api/auroraApi';
import type { TrackInfo } from '../utils/fileSystem';

/**
 * Fetch a list of tracks from an API v1 endpoint (path relative to /api/v1)
 * and convert them to playable TrackInfo exactly as the store converts
 * playlist tracks — media token and streaming quality included.
 *
 * The v1 counterpart of useEntityTracks, which reads `{ ...meta, tracks }`
 * from the legacy routes. Pass null to fetch nothing.
 */
export function useApiV1TrackList(path: string | null): { tracks: TrackInfo[]; loading: boolean } {
  const [state, setState] = useState<{ tracks: TrackInfo[]; loading: boolean }>({ tracks: [], loading: !!path });

  useEffect(() => {
    if (!path) { setState({ tracks: [], loading: false }); return; }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const store = usePlayerStore.getState();
    auroraApiRequest<Track[]>(path, store.getAuthHeader())
      .then((tracks) => {
        if (cancelled) return;
        const { mediaAccessToken, authToken, streamingQuality } = usePlayerStore.getState();
        const token = mediaAccessToken || authToken || '';
        setState({ tracks: (tracks || []).map((track) => toLegacyTrack(track, token, streamingQuality)), loading: false });
      })
      .catch(() => { if (!cancelled) setState({ tracks: [], loading: false }); });
    return () => { cancelled = true; };
  }, [path]);

  // Optimistic loved-state toggles, as in useEntityTracks: these tracks live
  // in component state, not the store.
  const lovedOverlay = usePlayerStore((s) => s.lovedOverlay);
  const tracks = useMemo(
    () => state.tracks.map((t) => (t.id in lovedOverlay ? { ...t, isLoved: lovedOverlay[t.id] } : t)),
    [state.tracks, lovedOverlay],
  );
  return { tracks, loading: state.loading };
}
