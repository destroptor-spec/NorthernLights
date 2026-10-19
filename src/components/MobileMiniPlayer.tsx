import { memo, useEffect, useState } from 'react';
import { usePlayerStore } from '../store/index';

import { useDisplayedPlaying } from '../hooks/useDisplayedPlaying';
import { hasNextTrack } from '../utils/queue';
import { Play, Speaker } from 'lucide-react';
import { useSwipe } from '../hooks/useSwipe';
import MobileNowPlaying from './MobileNowPlaying';
import { CastButton } from './cast/CastButton';
import { castManager } from '../utils/CastManager';
import { prefetchPalette, NOW_PLAYING_PALETTE_QUALITY } from '../hooks/useDominantColor';
import { IconNext, IconPause, IconPlay } from './icons/PlayerIcons';

const MobileMiniPlayer = () => {
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const playbackState = usePlayerStore((s) => s.playbackState);
  const isBuffering = usePlayerStore((s) => s.isBuffering);
  const pause = usePlayerStore((s) => s.pause);
  const resume = usePlayerStore((s) => s.resume);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const canSkipNext = usePlayerStore(hasNextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);
  const castConnected = usePlayerStore((s) => s.castConnected);
  const castPlaybackStatus = usePlayerStore((s) => s.castPlaybackStatus);
  const audioOutputSupported = usePlayerStore((s) => s.audioOutputSupported);
  const audioOutputActive = usePlayerStore((s) => s.audioOutputActive);
  const audioOutputDeviceLabel = usePlayerStore((s) => s.audioOutputDeviceLabel);
  const audioOutputSelecting = usePlayerStore((s) => s.audioOutputSelecting);
  const selectAudioOutput = usePlayerStore((s) => s.selectAudioOutput);

  const currentTrack = currentIndex !== null ? playlist[currentIndex] : null;
  const isPlaying = useDisplayedPlaying();

  const [expanded, setExpanded] = useState(false);
  const [sheetMounted, setSheetMounted] = useState(false);
  const [swipeDir, setSwipeDir] = useState<'left' | 'right' | null>(null);
  const [castDeviceName, setCastDeviceName] = useState(castManager.getCastDeviceName());

  useEffect(() => {
    if (expanded) {
      setSheetMounted(true);
      return;
    }
    if (!sheetMounted) return;
    // Keep mounted slightly longer than the CSS exit (320ms) so the slide-down
    // animation can finish before unmount.
    const timer = setTimeout(() => setSheetMounted(false), 340);
    return () => clearTimeout(timer);
  }, [expanded, sheetMounted]);

  useEffect(() => {
    const unsubscribe = castManager.addStateChangeListener((state) => {
      setCastDeviceName(state === 'CONNECTED' ? castManager.getCastDeviceName() : '');
    });

    return unsubscribe;
  }, []);

  // Warm the cover-palette cache while the sheet is closed: the now-playing
  // sheet seeds its colors synchronously from this cache on mount, so opening
  // it paints the derived backdrop on the first frame instead of fading in
  // from the defaults.
  const currentArtUrl = currentTrack?.artUrl;
  useEffect(() => {
    if (currentArtUrl) prefetchPalette(currentArtUrl, { quality: NOW_PLAYING_PALETTE_QUALITY });
  }, [currentArtUrl]);

  const handlePlayPause = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (playlist.length === 0) return;
    if (isPlaying) pause();
    else if (currentIndex === null) usePlayerStore.getState().playAtIndex(0);
    else resume();
  };

  const handleNext = (e: React.MouseEvent) => {
    e.stopPropagation();
    nextTrack();
  };

  const handleAudioOutput = (e: React.MouseEvent) => {
    e.stopPropagation();
    void selectAudioOutput();
  };

  const handleExpandKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setExpanded(true);
  };

  const flashSwipe = (dir: 'left' | 'right') => {
    setSwipeDir(dir);
    setTimeout(() => setSwipeDir(null), 200);
  };

  const swipeRef = useSwipe<HTMLDivElement>({
    onSwipeLeft: () => {
      if (!canSkipNext) return;
      flashSwipe('left');
      nextTrack();
    },
    onSwipeRight: () => {
      flashSwipe('right');
      prevTrack();
    },
    onSwipeUp: () => setExpanded(true),
    threshold: 40,
  });

  if (!currentTrack) return null;

  // Only a failed Cast start changes the device line; a start in progress
  // shows the play button's spinner and nothing else.
  const castDeviceLabel = castDeviceName || 'Cast device';
  // Another device that plays is named by the device strip, not here.
  const secondaryLabel = !castConnected ? (currentTrack.artist || 'Unknown Artist')
    : castPlaybackStatus === 'unconfirmed' ? `Playback not confirmed on ${castDeviceLabel}`
    : castDeviceLabel;

  return (
    <>
      {sheetMounted && (
        <MobileNowPlaying onClose={() => setExpanded(false)} isOpen={expanded} />
      )}

      <div
        ref={swipeRef}
        className={`md:hidden fixed left-0 right-0 z-40 bg-[var(--glass-bg)] backdrop-blur-2xl border-t border-[var(--glass-border)] transition-transform duration-200 ${
          swipeDir === 'left' ? '-translate-x-2' : swipeDir === 'right' ? 'translate-x-2' : 'translate-x-0'
        }`}
        style={{ bottom: 'calc(3.5rem + var(--safe-area-bottom))' }}
      >
        {/* Tap area to expand — everything except the control buttons */}
        <div
          className="mobile-mini-player-row"
          onClick={() => setExpanded(true)}
          onKeyDown={handleExpandKeyDown}
          role="button"
          tabIndex={0}
          aria-label={`Open now playing for ${currentTrack.title || 'current track'}`}
        >
          {/* Album Art */}
          <div className="mobile-mini-art">
            {currentTrack.artUrl ? (
              <img
                src={currentTrack.artUrl}
                alt=""
                className="w-full h-full object-cover"
                loading="lazy"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-[var(--color-text-muted)]">
                <Play size={16} />
              </div>
            )}
          </div>

          {/* Artist + Title */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="mobile-mini-title">
                {currentTrack.title || currentTrack.path.split(/[\\/]/).pop()}
              </span>
              {!castConnected && audioOutputSupported && (
                <button
                  onClick={handleAudioOutput}
                  disabled={audioOutputSelecting}
                  className="flex-shrink-0 transition-colors disabled:opacity-50"
                  style={{
                    color: audioOutputActive ? 'var(--color-primary)' : 'var(--color-text-muted)',
                    filter: audioOutputActive ? 'drop-shadow(0 0 3px var(--color-primary))' : 'none',
                  }}
                  title={audioOutputActive ? `Playing on ${audioOutputDeviceLabel || 'selected output'}` : 'Choose audio output'}
                  aria-label={audioOutputActive ? `Playing on ${audioOutputDeviceLabel || 'selected output'}` : 'Choose audio output'}
                >
                  <Speaker size={14} />
                </button>
              )}
            </div>
            <div
              className={`text-xs truncate leading-tight mt-0.5 ${
                castConnected ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-muted)]'
              }`}
              {...(castConnected ? { role: 'status', 'aria-live': 'polite' as const } : {})}
            >
              {secondaryLabel}
            </div>
          </div>

          {/* Controls — stop propagation so they don't trigger expand */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <div onClick={(event) => event.stopPropagation()}>
              <CastButton size="sm" showIntro={false} className="mobile-mini-cast-control" />
            </div>
            <button
              type="button"
              onClick={handlePlayPause}
              aria-label={isBuffering ? 'Loading' : isPlaying ? 'Pause' : 'Play'}
              className="mobile-player-play-btn mobile-player-play-btn-sm"
              disabled={isBuffering}
            >
              {isBuffering ? (
                <svg className="mobile-player-spinner" width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.25" />
                  <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                </svg>
              ) : isPlaying ? <IconPause /> : <IconPlay />}
            </button>
            <button
              type="button"
              onClick={handleNext}
              disabled={!canSkipNext}
              aria-label="Next track"
              className="mobile-player-control-btn mobile-player-control-btn-sm"
            >
              <IconNext />
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

// Always mounted while a queue exists; navigation passes no props, so memoize
// to keep tab taps from re-rendering the mini player and its now-playing chrome.
export default memo(MobileMiniPlayer);
