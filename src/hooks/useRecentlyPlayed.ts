import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePlayerStore } from '../store/index';
import { auroraApiPage, type Track } from '../api/auroraApi';
import { toPlayableTracks } from '../utils/playableTracks';
import type { TrackInfo } from '../utils/fileSystem';

export const RECENTLY_PLAYED_PAGE = 30;

interface RecentlyPlayedState {
  tracks: TrackInfo[];
  /** The next page's cursor; null once everything is loaded. */
  cursor: string | null;
  loading: boolean;
  failed: boolean;
  /** At least the first page has come back. */
  loaded: boolean;
}

const EMPTY: RecentlyPlayedState = { tracks: [], cursor: null, loading: false, failed: false, loaded: false };

/**
 * The user's recently played tracks (GET /api/v1/me/recently-played), newest
 * first, RECENTLY_PLAYED_PAGE at a time: `loadMore` fetches the next page.
 * Starts over each time `active` turns on, so plays since the last look show.
 */
export function useRecentlyPlayed(active: boolean) {
  const [state, setState] = useState<RecentlyPlayedState>(EMPTY);
  const request = useRef<AbortController | null>(null);

  const fetchPage = useCallback(async (cursor: string | null, reset: boolean) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState((s) => ({ ...(reset ? { ...s, cursor: null } : s), loading: true, failed: false }));
    const query = new URLSearchParams({ limit: String(RECENTLY_PLAYED_PAGE) });
    if (cursor) query.set('cursor', cursor);
    try {
      const page = await auroraApiPage<Track[]>(
        `/me/recently-played?${query}`,
        usePlayerStore.getState().getAuthHeader(),
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const tracks = toPlayableTracks(page.data || []);
      setState((s) => ({
        tracks: reset ? tracks : [...s.tracks, ...tracks],
        cursor: page.page.nextCursor,
        loading: false,
        failed: false,
        loaded: true,
      }));
    } catch {
      if (controller.signal.aborted) return;
      setState((s) => ({ ...s, loading: false, failed: true }));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void fetchPage(null, true);
    return () => request.current?.abort();
  }, [active, fetchPage]);

  const loadMore = useCallback(() => {
    if (state.loading || !state.cursor || state.failed) return;
    void fetchPage(state.cursor, false);
  }, [fetchPage, state.cursor, state.loading, state.failed]);

  const retry = useCallback(() => {
    void fetchPage(state.loaded ? state.cursor : null, !state.loaded);
  }, [fetchPage, state.cursor, state.loaded]);

  // Hearts toggled since the tracks were read.
  const lovedOverlay = usePlayerStore((s) => s.lovedOverlay);
  const tracks = useMemo(
    () => state.tracks.map((t) => (t.id in lovedOverlay ? { ...t, isLoved: lovedOverlay[t.id] } : t)),
    [state.tracks, lovedOverlay],
  );

  return { ...state, tracks, hasMore: !!state.cursor, loadMore, retry };
}
