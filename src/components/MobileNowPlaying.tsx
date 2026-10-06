import { usePlayerStore } from '../store/index';
import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { X, Infinity as InfinityIcon, ListMusic, ListX, ChevronUp, FileText, Speaker } from 'lucide-react';
import ProgressBar from './ProgressBar';
import { useSwipe } from '../hooks/useSwipe';
import { castManager } from '../utils/CastManager';
import { LyricsPanel } from './LyricsPanel';
import { LoveButton } from './LoveButton';
import { CastButton } from './cast/CastButton';
import { IconNext, IconPause, IconPlay, IconPrev, IconRepeatAll, IconRepeatOne, IconShuffle } from './icons/PlayerIcons';
import { useDominantColor, NOW_PLAYING_PALETTE_QUALITY } from '../hooks/useDominantColor';
import { buildBloomGradient } from '../utils/coverGradient';
import { useTrackMusicVideo } from '../hooks/useTrackMusicVideo';
import MobileNowPlayingVideo, { type VideoPhase } from './MobileNowPlayingVideo';
import { QueueList, useClearQueueWithUndo, type QueueListHandle } from './QueueList';
import { hardwareKeysControlCastVolume } from '../utils/castVolumeKeys';

interface MobileNowPlayingProps {
  onClose: () => void;
  isOpen?: boolean;
}

type CrossfadeLayer = { key: number; value: string; animate: boolean };

// Stacked-layer cross-fade: when `value` changes, fade a new layer in over the
// previous ones so a backdrop morphs from track to track instead of hard-cutting.
// The first layer shows instantly; `prune(key)` drops the covered layers once
// the incoming one is fully faded in.
//
// Invariants that keep the backdrop from ever popping:
// - layers[0] is always fully opaque (the initial instant layer, or a layer
//   whose fade-in completed). It never leaves until a newer layer has fully
//   faded in over it.
// - A change mid-fade STACKS ([base, oldest-fading, newcomer] max) instead of
//   discarding the fading layer — discarding hard-cut its partial opacity away
//   (visible when skipping a track and straight back). When a fourth value
//   lands, the NEWEST intermediate is the one replaced: it has barely faded in,
//   while the oldest fading layer may be near-opaque.
// - prune ignores keys that are no longer mounted: an animationend can race a
//   value change within one React batch, and blindly filtering by key could
//   strip the opaque base from under a barely-visible newcomer — the whole
//   surface (e.g. the bottom scrim) blinked away, then slowly faded back.
function useCrossfadeLayers(value: string | null | undefined) {
  const keyRef = useRef(0);
  const lastRef = useRef(value);
  const [layers, setLayers] = useState<CrossfadeLayer[]>(
    () => (value ? [{ key: 0, value, animate: false }] : []),
  );
  useEffect(() => {
    if (lastRef.current === value) return; // initial mount / no change
    lastRef.current = value;
    if (!value) { setLayers([]); return; }
    keyRef.current += 1;
    const key = keyRef.current;
    setLayers((prev) => {
      // First layer ever (e.g. art arrives after mount) is an instant, opaque base.
      if (prev.length === 0) return [{ key, value, animate: false }];
      // Opaque base and the oldest still-fading layer stay put (their animations
      // keep running — same keys, so React preserves the elements); the newcomer
      // fades in on top. Any newer intermediate (prev[2]) is the one replaced.
      return [...prev.slice(0, 2), { key, value, animate: true }];
    });
  }, [value]);
  const prune = (key: number) =>
    setLayers((prev) => {
      // Stale event for a layer that was replaced mid-fade — never prune by a
      // key that isn't mounted, it could drop the opaque base under a
      // just-mounted transparent newcomer.
      if (!prev.some((l) => l.key === key)) return prev;
      return prev.filter((l) => l.key >= key);
    });
  return [layers, prune] as const;
}

// How long a track must stay current before the backdrop starts morphing to
// its colors. Rapid skips reset the hold, so no cross-fade even begins until
// the user settles — the slow cinematic morph never has to survive skipping.
const BLOOM_HOLD_MS = 1000;

// Hold a changing value until it has been stable for `holdMs`. The initial
// value passes through immediately (the sheet paints its colors on the very
// first frame); later changes wait out the hold. The hold also absorbs the
// async palette landing a beat after a cold (never-extracted) cover.
function useSettledValue<T>(value: T, holdMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(value, settled)) return;
    const timer = window.setTimeout(() => setSettled(value), holdMs);
    return () => window.clearTimeout(timer);
  }, [value, settled, holdMs]);
  return settled;
}

// The bloom cross-fades art + glows together as ONE layer, so both travel in a
// single string value. artUrl never contains a newline; the gradient is a
// single-line CSS string.
function packBloomValue(artUrl: string, gradient: string): string {
  return `${artUrl}\n${gradient}`;
}

function unpackBloomValue(value: string): [artUrl: string, gradient: string] {
  const split = value.indexOf('\n');
  return [value.slice(0, split), value.slice(split + 1)];
}

const MobileNowPlaying: React.FC<MobileNowPlayingProps> = ({ onClose, isOpen = true }) => {
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const playbackState = usePlayerStore((s) => s.playbackState);
  const isBuffering = usePlayerStore((s) => s.isBuffering);
  const pause = usePlayerStore((s) => s.pause);
  const resume = usePlayerStore((s) => s.resume);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);
  const isInfinityMode = usePlayerStore((s) => s.isInfinityMode);
  const toggleInfinityMode = usePlayerStore((s) => s.toggleInfinityMode);
  const audioOutputSupported = usePlayerStore((s) => s.audioOutputSupported);
  const audioOutputActive = usePlayerStore((s) => s.audioOutputActive);
  const audioOutputDeviceLabel = usePlayerStore((s) => s.audioOutputDeviceLabel);
  const audioOutputSelecting = usePlayerStore((s) => s.audioOutputSelecting);
  const selectAudioOutput = usePlayerStore((s) => s.selectAudioOutput);
  const volume = usePlayerStore((s) => s.volume);
  const setVolume = usePlayerStore((s) => s.setVolume);

  const [castConnected, setCastConnected] = useState(castManager.isConnected());
  const [castDeviceName, setCastDeviceName] = useState(() => castManager.isConnected() ? castManager.getCastDeviceName() : '');
  const [showLyrics, setShowLyrics] = useState(false);
  const currentTrack = currentIndex !== null ? playlist[currentIndex] : null;
  const trackIdentity = currentTrack?.queueEntryId || currentTrack?.id || currentTrack?.path || 'current-track';
  const colorSeedTracks = useMemo(() => currentTrack ? [currentTrack] : [], [currentTrack]);
  const { bgColor, colors } = useDominantColor(colorSeedTracks, { quality: NOW_PLAYING_PALETTE_QUALITY });

  // The one animated colored surface: blurred cover art + palette glows, packed
  // into a single value so they always morph together. Held for BLOOM_HOLD_MS
  // after a track change, then cross-faded once as a whole opaque layer.
  const bloomValue = useMemo(
    () => packBloomValue(currentTrack?.artUrl ?? '', buildBloomGradient(trackIdentity, colors, bgColor)),
    [currentTrack?.artUrl, trackIdentity, colors, bgColor],
  );
  const settledBloom = useSettledValue(bloomValue, BLOOM_HOLD_MS);
  const [bloomLayers, pruneBloom] = useCrossfadeLayers(settledBloom);

  // Matched YouTube music video for the current track (mobile-only, gated).
  const { videoId } = useTrackMusicVideo(currentTrack);
  const [videoPhase, setVideoPhase] = useState<VideoPhase>('none');
  // New track → drop back to the cover until its video (if any) buffers in.
  useEffect(() => { setVideoPhase('none'); }, [trackIdentity]);

  useEffect(() => {
    const unsubscribe = castManager.addStateChangeListener((state) => {
      const connected = state === 'CONNECTED';
      setCastConnected(connected);
      if (connected) {
        setCastDeviceName(castManager.getCastDeviceName());
      } else {
        setCastDeviceName('');
      }
    });
    return unsubscribe;
  }, []);

  // On modern Android the phone's hardware volume keys reach the receiver, so
  // the sheet stays sliderless while casting. Everywhere else (older/unpatched
  // Android, no UA-CH, desktop) show an on-screen cast volume slider.
  const [showCastVolume, setShowCastVolume] = useState(false);
  useEffect(() => {
    if (!castConnected) {
      setShowCastVolume(false);
      return;
    }
    let cancelled = false;
    void hardwareKeysControlCastVolume().then((keysWork) => {
      if (!cancelled) setShowCastVolume(!keysWork);
    });
    return () => { cancelled = true; };
  }, [castConnected]);

  const isPlaying = playbackState === 'playing';

  const handlePlayPause = () => {
    if (playlist.length === 0) return;
    if (isPlaying) pause();
    else if (currentIndex === null) usePlayerStore.getState().playAtIndex(0);
    else resume();
  };

  // The sheet's content is a two-page scroller: page 1 = now playing, page 2 =
  // the queue panel below the fold. The swipe-down-to-close gesture only fires
  // while the scroller sits at its top page — inside the queue a downward
  // flick is a scroll, never a dismiss.
  const scrollerRef = useSwipe<HTMLDivElement>({
    onSwipeDown: () => {
      if ((scrollerRef.current?.scrollTop ?? 0) <= 8) onClose();
    },
    threshold: 80,
  });
  const pageRef = useRef<HTMLDivElement>(null);
  const queueListWrapRef = useRef<HTMLDivElement>(null);
  const queueListRef = useRef<QueueListHandle>(null);
  const clearQueue = useClearQueueWithUndo();

  // Offset of the queue list inside the scroller (≈ page 1's height) — the
  // virtualizer needs it as scrollMargin. Re-measure when page 1 resizes
  // (rotation, short screens where the controls overflow one viewport).
  const [queueOffset, setQueueOffset] = useState(0);
  useLayoutEffect(() => {
    const measure = () => setQueueOffset(queueListWrapRef.current?.offsetTop ?? 0);
    measure();
    const page = pageRef.current;
    if (!page || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    return () => observer.disconnect();
  }, []);

  const prefersReducedMotion = () =>
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const scrollToNowPlaying = () => {
    scrollerRef.current?.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  // Queue button: jump between the two pages. Landing centers the current
  // track so it clears the queue panel's sticky header.
  const handleQueueButton = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
    if (scroller.scrollTop > scroller.clientHeight / 2) {
      scroller.scrollTo({ top: 0, behavior });
    } else if (currentIndex !== null) {
      queueListRef.current?.scrollToIndex(currentIndex, { align: 'center', behavior });
    } else {
      scroller.scrollTo({ top: queueOffset, behavior });
    }
  };

  if (!currentTrack) return null;

  return (
    <div
      className="mobile-now-playing-shell md:hidden"
      data-playing={isPlaying}
      data-buffering={isBuffering}
      data-state={isOpen ? 'open' : 'closing'}
      data-video={videoId ? videoPhase : 'none'}
    >
      {/* Two-page scroller: the now-playing page fills the frame; the queue
          panel sits below the fold and is revealed by scrolling down. The
          backdrop (bloom, video, scrim) lives inside page 1, so the whole
          page-1 visual slides up as one unit. */}
      <div ref={scrollerRef} className="mobile-now-scroll">
        <div ref={pageRef} className="mobile-now-page">

      {/* Aurora bloom — the one animated colored surface: blurred cover art
          with palette glows, cross-faded as whole opaque layers once per
          settled track. The container's fixed envelope opacity plus the static
          neutral scrim (page ::after) bound its intensity, so no cover can
          break text contrast. Rides inside page 1 and scrolls away with the
          controls. */}
      <div className="mobile-now-bloom" aria-hidden="true">
        {bloomLayers.map((layer) => {
          const [artUrl, gradient] = unpackBloomValue(layer.value);
          return (
            <div
              key={layer.key}
              className={`mobile-now-bloom-layer${layer.animate ? ' mobile-now-bloom-layer--fade' : ''}`}
              // Once a faded-in layer is fully opaque, drop everything beneath
              // it (each layer is an opaque composite, so covered layers are
              // invisible; pruning frees their compositor textures).
              onAnimationEnd={() => pruneBloom(layer.key)}
            >
              {artUrl && <img src={artUrl} alt="" className="mobile-now-bloom-art" />}
              <div className="mobile-now-bloom-tint" style={{ background: gradient }} />
            </div>
          );
        })}
      </div>

      {/* Muted background music video (fades in when buffered); scrolls with
          page 1 like the bloom. */}
      {videoId && (
        <div className="mobile-now-video" aria-hidden="true">
          <MobileNowPlayingVideo key={trackIdentity} videoId={videoId} onPhaseChange={setVideoPhase} />
        </div>
      )}

      {/* Safe area top spacer */}
      <div style={{ height: 'var(--safe-area-top)' }} />

      {/* Header */}
      <div className="mobile-now-playing-header">
        <button
          type="button"
          onClick={onClose}
          className="mobile-player-control-btn mobile-player-control-btn-sm"
          aria-label="Close now playing"
        >
          <X size={18} />
        </button>
        {/* The heading carries the playback target: plain "Now Playing"
            locally, "on {device}" when casting or on a selected output. */}
        <div className="mobile-now-playing-heading">
          <span className="mobile-now-heading-line">
            {castConnected && <span className="mobile-now-heading-dot" aria-hidden="true" />}
            Now Playing
            {castConnected && castDeviceName && (
              <span className="mobile-now-heading-device"> on {castDeviceName}</span>
            )}
            {!castConnected && audioOutputActive && (
              <span className="mobile-now-heading-device"> on {audioOutputDeviceLabel || 'selected output'}</span>
            )}
          </span>
        </div>
        {currentTrack ? (
          <LoveButton track={currentTrack} size={18} className="mobile-player-control-btn mobile-player-control-btn-sm mobile-player-love-btn" />
        ) : (
          <div className="w-9" />
        )}
      </div>

      {/* Main content */}
      <div className="mobile-now-playing-content">
        {/* Album Art or Lyrics */}
        {showLyrics ? (
          <div className="mobile-now-lyrics-card" key={`lyrics-${trackIdentity}`}>
            <LyricsPanel
              trackName={currentTrack.title || currentTrack.path.split(/[\\/]/).pop() || ''}
              artistName={currentTrack.artist || ''}
              isVisible={showLyrics}
              onClose={() => setShowLyrics(false)}
            />
          </div>
        ) : (
          <div className="mobile-now-art" key={`art-${trackIdentity}`}>
            {currentTrack.artUrl ? (
              <img
                src={currentTrack.artUrl}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-[var(--color-text-muted)]">
                <IconPlay />
              </div>
            )}
          </div>
        )}

        {/* Track Info */}
        <div className="mobile-now-track-info" key={`info-${trackIdentity}`}>
          <h2 className="mobile-now-title">
            {currentTrack.title || currentTrack.path.split(/[\\/]/).pop()}
          </h2>
          <p className="mobile-now-artist">
            {currentTrack.artist || 'Unknown Artist'}
          </p>
          {currentTrack.album && (
            <p className="mobile-now-album">
              {currentTrack.album}
            </p>
          )}
        </div>

        {/* Progress Bar */}
        <div className="mobile-now-progress">
          <ProgressBar />
        </div>

        {/* Cast volume: on modern Android the hardware volume keys reach the
            receiver (external changes sync back via CastManager's
            VOLUME_LEVEL_CHANGED listener), so no on-screen control renders.
            Platforms without that routing get this slider instead. */}
        {castConnected && showCastVolume && (
          <div className="mobile-now-volume">
            <div className="mobile-now-volume-label">
              <span>Cast volume</span>
              <span className="text-[var(--color-primary)]">{Math.round(volume * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(event) => setVolume(parseFloat(event.target.value))}
              className="mobile-now-volume-slider"
              aria-label="Cast volume"
            />
          </div>
        )}

        {/* Transport Controls */}
        <div className="mobile-now-transport">
          <button
            type="button"
            onClick={toggleShuffle}
            aria-label={shuffle ? 'Turn shuffle off' : 'Turn shuffle on'}
            aria-pressed={shuffle}
            className={`mobile-player-control-btn mobile-player-control-btn-md ${shuffle ? 'is-active' : ''}`}
          >
            <IconShuffle />
          </button>

          <button
            type="button"
            onClick={prevTrack}
            aria-label="Previous track"
            className="mobile-player-control-btn mobile-player-control-btn-lg"
          >
            <IconPrev />
          </button>

          <button
            type="button"
            onClick={handlePlayPause}
            aria-label={isBuffering ? 'Loading' : isPlaying ? 'Pause' : 'Play'}
            className="mobile-player-play-btn mobile-player-play-btn-lg"
            disabled={isBuffering}
          >
            {isBuffering ? (
              <svg className="mobile-player-spinner" width="28" height="28" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            ) : isPlaying ? <IconPause /> : <IconPlay />}
          </button>

          <button
            type="button"
            onClick={() => void nextTrack()}
            aria-label="Next track"
            className="mobile-player-control-btn mobile-player-control-btn-lg"
          >
            <IconNext />
          </button>

          <button
            type="button"
            onClick={cycleRepeat}
            aria-label={repeat === 'one' ? 'Repeat one is on. Cycle repeat' : repeat === 'all' ? 'Repeat all is on. Cycle repeat' : 'Repeat is off. Cycle repeat'}
            aria-pressed={repeat !== 'none'}
            className={`mobile-player-control-btn mobile-player-control-btn-md ${repeat !== 'none' ? 'is-active' : ''}`}
          >
            {repeat === 'one' ? <IconRepeatOne /> : <IconRepeatAll />}
          </button>
        </div>

        {/* Secondary controls row */}
        <div className="mobile-now-secondary-controls">
          <button
            type="button"
            onClick={handleQueueButton}
            aria-label="Show play queue"
            className="mobile-player-control-btn mobile-player-control-btn-sm"
          >
            <ListMusic size={20} />
          </button>

          <button
            type="button"
            onClick={() => setShowLyrics(!showLyrics)}
            aria-label={showLyrics ? 'Hide lyrics' : 'Show lyrics'}
            aria-pressed={showLyrics}
            className={`mobile-player-pill-btn ${showLyrics ? 'is-active' : ''}`}
          >
            <FileText size={16} />
            Lyrics
          </button>

          <button
            type="button"
            onClick={toggleInfinityMode}
            aria-label={isInfinityMode ? 'Turn Infinity Mode off' : 'Turn Infinity Mode on'}
            aria-pressed={isInfinityMode}
            className={`mobile-player-pill-btn ${isInfinityMode ? 'is-active' : ''}`}
          >
            <InfinityIcon size={16} />
            Infinity
          </button>

          {audioOutputSupported && (
            <button
              type="button"
              onClick={() => { void selectAudioOutput(); }}
              disabled={castConnected || audioOutputSelecting}
              aria-label={audioOutputActive ? `Playing on ${audioOutputDeviceLabel || 'selected output'}` : 'Choose audio output'}
              className={`mobile-player-control-btn mobile-player-control-btn-sm ${audioOutputActive ? 'is-active' : ''}`}
              title={audioOutputActive ? `Playing on ${audioOutputDeviceLabel || 'selected output'}` : 'Choose audio output'}
            >
              <Speaker size={22} />
            </button>
          )}

          <CastButton size="sm" showIntro={false} className="mobile-now-cast-control" />
        </div>
      </div>

      {/* Safe area bottom spacer */}
      <div style={{ height: 'var(--safe-area-bottom)' }} />

        </div>

        {/* Queue panel below the fold: an opaque panel that follows page 1
            (and its backdrop) up from below the fold (snap settles on either
            page). Virtualized against the outer scroller so long queues stay
            cheap. */}
        <section className="mobile-now-queue" aria-label="Play queue">
          <div className="mobile-now-queue-header">
            <button
              type="button"
              onClick={scrollToNowPlaying}
              className="mobile-player-control-btn mobile-player-control-btn-sm"
              aria-label="Back to now playing"
            >
              <ChevronUp size={18} />
            </button>
            <div className="mobile-now-playing-heading">
              <span>Up Next ({playlist.length})</span>
            </div>
            <button
              type="button"
              onClick={clearQueue}
              disabled={playlist.length === 0}
              className="mobile-player-control-btn mobile-player-control-btn-sm"
              aria-label="Clear queue"
            >
              <ListX size={18} />
            </button>
          </div>
          <div ref={queueListWrapRef}>
            <QueueList
              ref={queueListRef}
              getScrollElement={() => scrollerRef.current}
              scrollMargin={queueOffset}
              listClassName="px-3 pb-2"
            />
          </div>
        </section>
      </div>
    </div>
  );
};

export default MobileNowPlaying;
