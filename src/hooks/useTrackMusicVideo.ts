import { useEffect, useState } from 'react';
import { usePlayerStore } from '../store/index';
import type { TrackInfo } from '../utils/fileSystem';

// Resolves the YouTube video id matched to the current track, for the mobile
// now-playing background. The server reuses cached matches and refreshes the
// artist's matches when needed, within its TTL and quota limits.
// Gated on the user setting, YouTube being enabled, and not casting —
// when those don't hold we never fetch and report no video.

export function useTrackMusicVideo(track: TrackInfo | null): { videoId: string | null } {
  const youtubeEnabled = usePlayerStore((s) => s.youtubeEnabled);
  const mobileVideoBackgrounds = usePlayerStore((s) => s.mobileVideoBackgrounds);
  const castConnected = usePlayerStore((s) => s.castConnected);
  const getAuthHeader = usePlayerStore((s) => s.getAuthHeader);

  const trackId = track?.id ?? null;
  const enabled = youtubeEnabled && mobileVideoBackgrounds && !castConnected && !!trackId;

  // Keep the result tied to its track. Never render the previous track's video
  // while a new lookup is pending, or retain a missing match across visits.
  const [match, setMatch] = useState<{ trackId: string; videoId: string | null } | null>(null);

  useEffect(() => {
    if (!enabled || !trackId) {
      setMatch(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(`/api/providers/external/track-video/${encodeURIComponent(trackId)}`, {
          headers: getAuthHeader(),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`track-video ${res.status}`);
        const data = await res.json();
        const id: string | null = data?.video?.video_id || null;
        if (!cancelled) setMatch({ trackId, videoId: id });
      } catch (err) {
        if (cancelled || (err as Error)?.name === 'AbortError') return;
        // Treat lookup failures as "no video" — the cover background is the fallback.
        setMatch(null);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, trackId, getAuthHeader]);

  return { videoId: enabled && match?.trackId === trackId ? match.videoId : null };
}
