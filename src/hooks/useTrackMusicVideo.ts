import { useEffect, useState } from 'react';
import { usePlayerStore } from '../store/index';
import type { TrackVideoLookup } from '../../shared/musicVideos';
import type { TrackInfo } from '../utils/fileSystem';
import { beginMusicVideoDiagnostics, recordMusicVideoEvent, useMusicVideoDiagnostics } from '../store/musicVideoDiagnostics';

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
      beginMusicVideoDiagnostics(trackId, !trackId ? 'no-track' : !youtubeEnabled ? 'integration-disabled'
        : !mobileVideoBackgrounds ? 'backgrounds-disabled' : 'casting');
      setMatch(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    beginMusicVideoDiagnostics(trackId, 'lookup');

    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let pendingRetry = false;
    let retryAt = 0;
    let inFlight = false;
    const scheduleRetry = (delay: number) => {
      if (attempts >= 4 || cancelled) return;
      pendingRetry = true;
      retryAt = Date.now() + delay;
      if (document.visibilityState === 'visible') retryTimer = setTimeout(() => void lookup(), delay);
    };
    const lookup = async () => {
      if (cancelled || inFlight || attempts >= 4 || document.visibilityState !== 'visible') return;
      clearTimeout(retryTimer);
      pendingRetry = false;
      inFlight = true;
      attempts++;
      try {
        const res = await fetch(`/api/providers/external/track-video/${encodeURIComponent(trackId)}`, {
          headers: getAuthHeader(), signal: controller.signal, cache: 'no-store',
        });
        if (cancelled) return;
        if (!res.ok) {
          recordMusicVideoEvent('lookup-failed', res.status);
          setMatch(null);
          if (res.status >= 500 || res.status === 429) scheduleRetry(5000);
          return;
        }
        const data: TrackVideoLookup = await res.json();
        if (cancelled) return;
        const id = data.video?.video_id || null;
        useMusicVideoDiagnostics.setState({ videoId: id });
        recordMusicVideoEvent(id ? 'matched' : data.status === 'pending' ? 'lookup' : data.status === 'temporary-error' ? 'lookup-failed' : 'no-match');
        setMatch({ trackId, videoId: id });
        if (!id && (data.status === 'pending' || data.status === 'temporary-error')) {
          const delay = Number.isFinite(data.retryAfterMs) ? Math.max(1000, Math.min(60000, data.retryAfterMs!)) : 2000;
          scheduleRetry(Math.max(delay, 2000 * 2 ** (attempts - 1)));
        }
      } catch (err) {
        if (cancelled || (err as Error)?.name === 'AbortError') return;
        recordMusicVideoEvent('lookup-failed');
        setMatch(null);
        scheduleRetry(5000);
      } finally { inFlight = false; }
    };
    const onVisible = () => {
      clearTimeout(retryTimer);
      if (document.visibilityState !== 'visible') return;
      if (pendingRetry) retryTimer = setTimeout(() => void lookup(), Math.max(0, retryAt - Date.now()));
      else if (attempts === 0) void lookup();
    };
    document.addEventListener('visibilitychange', onVisible);
    void lookup();

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, trackId, getAuthHeader, youtubeEnabled, mobileVideoBackgrounds, castConnected]);

  return { videoId: enabled && match?.trackId === trackId ? match.videoId : null };
}
