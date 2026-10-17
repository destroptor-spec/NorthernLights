import { useEffect, useRef } from 'react';
import { usePlayerStore } from '../store/index';
import { usePlaybackTimeStore } from '../store/playbackTime';
import { loadYouTubeIframeApi, type YTPlayer } from '../utils/youtubeIframeApi';
import { recordMusicVideoEvent } from '../store/musicVideoDiagnostics';

export type VideoPhase = 'none' | 'buffering' | 'visible' | 'ended';

interface Props {
  videoId: string;
  onPhaseChange: (phase: VideoPhase) => void;
}

// How far video time may drift from audio time before we re-sync (seconds).
// Correct timestamp drift without repeatedly seeking while YouTube buffers.
const DRIFT_THRESHOLD_SECONDS = 0.75;
const DRIFT_CHECK_INTERVAL_MS = 1000;
const SEEK_COOLDOWN_MS = 2000;
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
    let ended = false;
    let lastSeekAt = -Infinity;
    let player: YTPlayer | null = null;
    let driftTimer: number | undefined;
    let revealTimer: number | undefined;
    let readyTimer: number | undefined;
    let unsubPlayback: (() => void) | undefined;
    let unsubTime: (() => void) | undefined;

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

    const syncPosition = (force = false) => {
      if (cancelled || failed || !ready || !player || document.visibilityState !== 'visible') return;
      const time = usePlaybackTimeStore.getState().currentTime;
      if (!Number.isFinite(time) || time < 0) return;
      const duration = player.getDuration();
      if (duration > 0 && time >= duration) {
        if (!ended) player.pauseVideo();
        ended = true;
        revealed = false;
        setPhase('ended');
        return;
      }
      if (ended && !force) return;
      ended = false;
      const drift = Math.abs(time - player.getCurrentTime());
      if (force || (drift > DRIFT_THRESHOLD_SECONDS && Date.now() - lastSeekAt >= SEEK_COOLDOWN_MS)) {
        lastSeekAt = Date.now();
        player.seekTo(time, true);
      }
    };
    const mirrorPlayback = () => {
      if (cancelled || failed || !ready || !player) return;
      player.mute();
      // seekTo can itself start playback. Mute before both seek and play.
      syncPosition(true);
      if (document.visibilityState === 'visible' && !ended && usePlayerStore.getState().playbackState === 'playing') {
        autoplayBlocked = false;
        player.playVideo();
      } else player.pauseVideo();
    };
    const retryAutoplay = () => {
      if (cancelled || failed || !ready || !autoplayBlocked || !player) return;
      if (usePlayerStore.getState().playbackState !== 'playing') return;
      recordMusicVideoEvent('gesture-retry');
      mirrorPlayback();
    };
    const surface = host.closest('.mobile-now-playing-shell') ?? host;
    surface.addEventListener('pointerup', retryAutoplay);
    const noteVisibility = () => {
      recordMusicVideoEvent(document.visibilityState === 'visible' ? 'visible' : 'hidden');
      mirrorPlayback();
    };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) mirrorPlayback(); };
    document.addEventListener('visibilitychange', noteVisibility);
    window.addEventListener('pageshow', onPageShow);

    const reveal = () => {
      if (cancelled || failed || !ready || document.visibilityState !== 'visible') return;
      syncPosition();
      if (ended) return;
      if (!revealed) {
        revealed = true;
        setPhase('visible');
      }
    };

    setPhase('buffering');
    recordMusicVideoEvent('api-loading');

    loadYouTubeIframeApi()
      .then((YT) => {
        if (cancelled) return;

        recordMusicVideoEvent('player-loading');
        readyTimer = window.setTimeout(() => {
          if (!cancelled && !ready && !failed) recordMusicVideoEvent('player-timeout');
        }, 20000);

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
              window.clearTimeout(readyTimer);
              recordMusicVideoEvent('ready');
              player = e.target;
              mirrorPlayback();
            },
            onStateChange: (e) => {
              if (cancelled || failed) return;
              recordMusicVideoEvent('state', e.data);
              if (e.data === YT.PlayerState.PLAYING) {
                autoplayBlocked = false;
                if (document.visibilityState !== 'visible' || usePlayerStore.getState().playbackState !== 'playing') {
                  e.target.pauseVideo();
                  return;
                }
                reveal();
              } else if (e.data === YT.PlayerState.ENDED) {
                // Video finished before the track did → fade back to cover art.
                setPhase('ended');
                revealed = false;
                ended = true;
              }
            },
            // Non-embeddable / age-restricted / removed video → silent cover fallback.
            onError: (e) => {
              if (cancelled) return;
              failed = true;
              window.clearTimeout(readyTimer);
              recordMusicVideoEvent('embed-error', e.data);
              setPhase('none');
              window.clearInterval(revealTimer);
              window.clearInterval(driftTimer);
            },
            onAutoplayBlocked: () => {
              if (cancelled || failed) return;
              recordMusicVideoEvent('autoplay-blocked');
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
          mirrorPlayback();
        });

        let lastSeek = usePlaybackTimeStore.getState().seekRevision;
        unsubTime = usePlaybackTimeStore.subscribe(state => {
          if (state.seekRevision === lastSeek) return;
          lastSeek = state.seekRevision;
          mirrorPlayback();
        });

        // Safety-net reveal: poll for the player actually playing, in case the
        // onStateChange PLAYING event is missed.
        revealTimer = window.setInterval(() => {
          if (revealed || !player || !ready || failed || autoplayBlocked) return;
          if (player.getPlayerState?.() === YT.PlayerState.PLAYING) reveal();
        }, REVEAL_POLL_INTERVAL_MS);

        // Check once per second; corrections have a separate seek cooldown.
        driftTimer = window.setInterval(() => {
          if (!player || !ready || !revealed || failed) return;
          if (usePlayerStore.getState().playbackState !== 'playing') return;
          if (player.getPlayerState() === YT.PlayerState.PLAYING) syncPosition();
        }, DRIFT_CHECK_INTERVAL_MS);
      })
      .catch(() => {
        if (cancelled) return;
        window.clearTimeout(readyTimer);
        recordMusicVideoEvent('api-failed');
        setPhase('none');
      });

    return () => {
      cancelled = true;
      window.clearTimeout(readyTimer);
      if (driftTimer) window.clearInterval(driftTimer);
      if (revealTimer) window.clearInterval(revealTimer);
      unsubPlayback?.();
      unsubTime?.();
      surface.removeEventListener('pointerup', retryAutoplay);
      document.removeEventListener('visibilitychange', noteVisibility);
      window.removeEventListener('pageshow', onPageShow);
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
