import { useEffect, useMemo, useState } from 'react';
import { usePlayerStore } from '../store/index';
import type { TrackInfo } from '../utils/fileSystem';

interface EntityTracksState<M> {
  /** Hydrated tracks for the entity (stream/art URLs built). */
  tracks: TrackInfo[];
  /** Entity metadata returned alongside `tracks` (everything except `tracks`). */
  meta: M | null;
  loading: boolean;
}

/**
 * Fetches `{ ...meta, tracks }` from a per-entity endpoint (e.g.
 * `/api/albums/:id`, `/api/genres/:id`) and hydrates the tracks with stream/art
 * URLs. Replaces filtering the in-memory `library` array in detail views.
 */
export function useEntityTracks<M = Record<string, unknown>>(path: string | null): EntityTracksState<M> {
  const [state, setState] = useState<EntityTracksState<M>>({ tracks: [], meta: null, loading: !!path });

  useEffect(() => {
    if (!path) { setState({ tracks: [], meta: null, loading: false }); return; }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));

    const authHeaders = usePlayerStore.getState().getAuthHeader();
    fetch(path, { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        if (!data) { setState({ tracks: [], meta: null, loading: false }); return; }
        const { tracks: rawTracks, ...meta } = data as { tracks?: TrackInfo[] };
        const hydrate = usePlayerStore.getState().hydrateTracks;
        setState({ tracks: hydrate(rawTracks || []), meta: meta as M, loading: false });
      })
      .catch(() => { if (!cancelled) setState({ tracks: [], meta: null, loading: false }); });

    return () => { cancelled = true; };
  }, [path]);

  // Apply optimistic loved-state toggles so per-track hearts update without a
  // refetch (these tracks live in component state, not the store).
  const lovedOverlay = usePlayerStore((s) => s.lovedOverlay);
  const tracks = useMemo(
    () => state.tracks.map((t) => (t.id in lovedOverlay ? { ...t, isLoved: lovedOverlay[t.id] } : t)),
    [state.tracks, lovedOverlay],
  );

  return { ...state, tracks };
}
