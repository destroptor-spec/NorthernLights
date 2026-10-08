import { useEffect, useMemo, useState } from 'react';
import { usePlayerStore } from '../store/index';
import { auroraApiRequest, type Track } from '../api/auroraApi';
import { toPlayableTracks } from '../utils/playableTracks';
import type { TrackInfo } from '../utils/fileSystem';

interface ApiV1TracksState<M> {
  tracks: TrackInfo[];
  meta: M | null;
  loading: boolean;
}

/**
 * Shared fetch for the hooks below: request an API v1 path (relative to
 * /api/v1), split the payload into tracks and metadata, and convert the tracks
 * to playable TrackInfo exactly as the store converts playlist tracks — media
 * token and streaming quality included. `split` must be a stable reference.
 */
function useApiV1Tracks<D, M>(
  path: string | null,
  split: (data: D) => { tracks: Track[]; meta: M },
): ApiV1TracksState<M> {
  const [state, setState] = useState<ApiV1TracksState<M>>({ tracks: [], meta: null, loading: !!path });

  useEffect(() => {
    if (!path) { setState({ tracks: [], meta: null, loading: false }); return; }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    auroraApiRequest<D>(path, usePlayerStore.getState().getAuthHeader())
      .then((data) => {
        if (cancelled) return;
        const { tracks, meta } = split(data);
        setState({ tracks: toPlayableTracks(tracks || []), meta, loading: false });
      })
      .catch(() => { if (!cancelled) setState({ tracks: [], meta: null, loading: false }); });
    return () => { cancelled = true; };
  }, [path, split]);

  // Optimistic loved-state toggles: these tracks live in component state, not
  // the store, so per-track hearts would otherwise wait for a refetch.
  const lovedOverlay = usePlayerStore((s) => s.lovedOverlay);
  const tracks = useMemo(
    () => state.tracks.map((t) => (t.id in lovedOverlay ? { ...t, isLoved: lovedOverlay[t.id] } : t)),
    [state.tracks, lovedOverlay],
  );
  return { ...state, tracks };
}

const splitTrackList = (tracks: Track[]) => ({ tracks, meta: null });

/** Fetch an API v1 endpoint that returns a bare track array. Pass null to fetch nothing. */
export function useApiV1TrackList(path: string | null): { tracks: TrackInfo[]; loading: boolean } {
  const { tracks, loading } = useApiV1Tracks<Track[], null>(path, splitTrackList);
  return { tracks, loading };
}

function splitEntity<M>({ tracks, ...meta }: { tracks: Track[] } & M) {
  return { tracks, meta: meta as M };
}

/**
 * Fetch an API v1 detail endpoint shaped `{ ...entity, tracks }` (e.g.
 * `/albums/:id`, `/artists/:id`). `meta` is everything except `tracks`.
 * The v1 counterpart of useEntityTracks. Pass null to fetch nothing.
 */
export function useApiV1EntityTracks<M>(path: string | null): ApiV1TracksState<M> {
  return useApiV1Tracks<{ tracks: Track[] } & M, M>(path, splitEntity);
}
