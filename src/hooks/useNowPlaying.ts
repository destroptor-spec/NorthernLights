import { useMemo } from 'react';
import { usePlayerStore } from '../store';
import type { TrackInfo } from '../utils/fileSystem';
import { selectDisplayedPlaybackState } from '../utils/sessionFollow';

export type NowPlayingState = 'playing' | 'paused' | 'stopped';

export function useCurrentTrack(): TrackInfo | null {
  return usePlayerStore((s) =>
    s.currentIndex !== null ? s.playlist[s.currentIndex] ?? null : null,
  );
}

/** This device's state, or the controlled device's when it controls one. */
export function useNowPlayingState(): NowPlayingState {
  return usePlayerStore(selectDisplayedPlaybackState);
}

export function useIsCurrentTrack(trackId: string | undefined): boolean {
  return usePlayerStore((s) => {
    if (!trackId || s.currentIndex === null) return false;
    return s.playlist[s.currentIndex]?.id === trackId;
  });
}

interface CollectionMatch {
  albumId?: string;
  artistId?: string;
}

export function useIsCurrentCollection(match: CollectionMatch): boolean {
  return usePlayerStore((s) => {
    const track = s.currentIndex !== null ? s.playlist[s.currentIndex] : null;
    if (!track) return false;
    if (match.albumId && track.albumId === match.albumId) return true;
    if (match.artistId && track.artistId === match.artistId) return true;
    return false;
  });
}

export interface ResumeContext {
  track: TrackInfo;
  index: number;
  totalTracks: number;
  remaining: number;
}

/**
 * Returns a resume context for the persisted queue, gated by the user's
 * resume-freshness preference (`resumeStalenessDays`): 0 = always resume;
 * otherwise resume is withheld once the last playback activity is older than
 * the configured window, so the Hub stops offering a stale queue.
 */
export function useResumeContext(): ResumeContext | null {
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const resumeStalenessDays = usePlayerStore((s) => s.resumeStalenessDays);
  const lastPlaybackActivityAt = usePlayerStore((s) => s.lastPlaybackActivityAt);

  return useMemo(() => {
    if (currentIndex === null || playlist.length === 0) return null;
    const track = playlist[currentIndex];
    if (!track) return null;
    // Freshness gate. 0 = "Always" (never expire). Otherwise hide the resume
    // once it's been longer than the window since playback last happened.
    if (resumeStalenessDays > 0) {
      if (!lastPlaybackActivityAt || Date.now() - lastPlaybackActivityAt > resumeStalenessDays * 86_400_000) {
        return null;
      }
    }
    return {
      track,
      index: currentIndex,
      totalTracks: playlist.length,
      remaining: Math.max(0, playlist.length - currentIndex - 1),
    };
  }, [playlist, currentIndex, resumeStalenessDays, lastPlaybackActivityAt]);
}
