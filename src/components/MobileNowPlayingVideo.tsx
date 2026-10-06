import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../store/index';
import { usePlaybackTimeStore } from '../store/playbackTime';
import { loadYouTubeIframeApi, type YTPlayer } from '../utils/youtubeIframeApi';

export type VideoPhase = 'none' | 'buffering' | 'visible' | 'ended';

interface Props {
  videoId: string;
  onPhaseChange: (phase: VideoPhase) => void;
}

// How far video time may drift from audio time before we re-sync (seconds).
// Kept coarse on purpose — the brief is "roughly matches", and tight per-frame
// syncing would cause visible stutter.
const DRIFT_THRESHOLD_SECONDS = 2.5;
const DRIFT_CHECK_INTERVAL_MS = 4000;
// How often we poll for the player reaching PLAYING (a reliable signal that it
// has buffered enough to render) before the cross-fade reveal.
const REVEAL_POLL_INTERVAL_MS = 250;

// Muted background music video occupying the top band of the mobile now-playing
// view. Mounted with key={trackIdentity}, so each track gets a fresh player and
// a clean teardown. The video is ALWAYS muted — audio always comes from the real
// track; this is purely for visual ambience.
function MobileNowPlayingVideo({ videoId, onPhaseChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Keep the latest callback without re-running the player effect.
  const onPhaseChangeRef = useRef(onPhaseChange);
  onPhaseChangeRef.current = onPhaseChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let revealed = false;
    let ready = false;
    let failed = false;
    let autoplayBlocked = false;
    let player: YTPlayer | null = null;
    let driftTimer: number | undefined;
    let revealTimer: number | undefined;
    let unsubPlayback: (() => void) | undefined;

    // YT.Player replaces the element it's given with an <iframe>. Give it a
    // throwaway child so React keeps owning `host` and there's no DOM conflict
    // when we destroy() on unmount.
    const target = document.createElement('div');
    target.style.width = '100%';
    target.style.height = '100%';
    host.appendChild(target);

    const setPhase = (phase: VideoPhase) => {
      if (!cancelled) onPhaseChangeRef.current(phase);
    };

    const retryAutoplay = () => {
      if (cancelled || failed || !ready || !autoplayBlocked || !player) return;
      if (usePlayerStore.getState().playbackState !== 'playing') return;
      autoplayBlocked = false;
      player.mute();
      player.playVideo();
    };
    // Retry inside a user gesture if the phone denied scripted playback.
    const surface = host.closest('.mobile-now-playing-shell') ?? host;
    surface.addEventListener('pointerup', retryAutoplay);

    const reveal = () => {
      if (revealed || cancelled || failed) return;
      revealed = true;
      if (revealTimer) window.clearInterval(revealTimer);
      // Correct the buffering-induced lag: the audio kept advancing while the
      // video buffered, so the onReady seek is now stale. Re-sync to the audio's
      // current position the moment we actually start showing the video.
      if (player) {
        const audioTime = usePlaybackTimeStore.getState().currentTime || 0;
        if (audioTime > 0) player.seekTo(audioTime, true);
      }
      setPhase('visible');
    };

    setPhase('buffering');

    loadYouTubeIframeApi()
      .then((YT) => {
        if (cancelled) return;

        player = new YT.Player(target, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            fs: 0,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            iv_load_policy: 3,
            mute: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (e) => {
              if (cancelled) return;
              ready = true;
              const p = e.target;
              p.mute(); // belt-and-braces: never play audio
              const audioTime = usePlaybackTimeStore.getState().currentTime || 0;
              if (audioTime > 0) p.seekTo(audioTime, true);
              // Only start buffering/playing if the track itself is playing.
              if (usePlayerStore.getState().playbackState === 'playing') p.playVideo();
            },
            onStateChange: (e) => {
              if (cancelled || failed) return;
              if (e.data === YT.PlayerState.PLAYING) {
                // Playing => buffered enough to render. Reveal with a cross-fade.
                reveal();
              } else if (e.data === YT.PlayerState.ENDED) {
                // Video finished before the track did → fade back to cover art.
                setPhase('ended');
                revealed = false;
              }
            },
            // Non-embeddable / age-restricted / removed video → silent cover fallback.
            onError: () => {
              failed = true;
              setPhase('none');
              window.clearInterval(revealTimer);
              window.clearInterval(driftTimer);
            },
            onAutoplayBlocked: () => {
              autoplayBlocked = true;
              revealed = false;
              setPhase('none');
            },
          },
        });

        // Mirror the audio engine's play/pause onto the video.
        let lastPlayback = usePlayerStore.getState().playbackState;
        unsubPlayback = usePlayerStore.subscribe((state) => {
          if (state.playbackState === lastPlayback) return;
          lastPlayback = state.playbackState;
          if (!player || !ready || failed) return;
          if (state.playbackState === 'playing') player.playVideo();
          else player.pauseVideo();
        });

        // Safety-net reveal: poll for the player actually playing, in case the
        // onStateChange PLAYING event is missed.
        revealTimer = window.setInterval(() => {
          if (revealed || !player || !ready || failed || autoplayBlocked) return;
          if (player.getPlayerState?.() === YT.PlayerState.PLAYING) reveal();
        }, REVEAL_POLL_INTERVAL_MS);

        // Coarse drift correction once the video is showing.
        driftTimer = window.setInterval(() => {
          if (!player || !ready || !revealed || failed) return;
          if (usePlayerStore.getState().playbackState !== 'playing') return;
          const audioTime = usePlaybackTimeStore.getState().currentTime || 0;
          const videoTime = player.getCurrentTime?.() ?? 0;
          if (Math.abs(audioTime - videoTime) > DRIFT_THRESHOLD_SECONDS) {
            player.seekTo(audioTime, true);
          }
        }, DRIFT_CHECK_INTERVAL_MS);
      })
      .catch(() => setPhase('none'));

    return () => {
      cancelled = true;
      if (driftTimer) window.clearInterval(driftTimer);
      if (revealTimer) window.clearInterval(revealTimer);
      unsubPlayback?.();
      surface.removeEventListener('pointerup', retryAutoplay);
      try {
        player?.destroy();
      } catch {
        /* player may already be torn down */
      }
      player = null;
      target.remove();
    };
  }, [videoId]);

  return <div ref={hostRef} className="mobile-now-video-player" aria-hidden="true" />;
}

export default MobileNowPlayingVideo;
