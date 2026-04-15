import { useState } from 'react';
import { usePlayerStore } from '../store/index';
import { Play, Pause, SkipForward, Cast } from 'lucide-react';
import { useSwipe } from '../hooks/useSwipe';
import MobileNowPlaying from './MobileNowPlaying';

const MobileMiniPlayer = () => {
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const playbackState = usePlayerStore((s) => s.playbackState);
  const pause = usePlayerStore((s) => s.pause);
  const resume = usePlayerStore((s) => s.resume);
  const nextTrack = usePlayerStore((s) => s.nextTrack);
  const prevTrack = usePlayerStore((s) => s.prevTrack);
  const castConnected = usePlayerStore((s) => s.castConnected);

  const currentTrack = currentIndex !== null ? playlist[currentIndex] : null;
  const isPlaying = playbackState === 'playing';

  const [expanded, setExpanded] = useState(false);
  const [swipeDir, setSwipeDir] = useState<'left' | 'right' | null>(null);

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

  const flashSwipe = (dir: 'left' | 'right') => {
    setSwipeDir(dir);
    setTimeout(() => setSwipeDir(null), 200);
  };

  const swipeRef = useSwipe<HTMLDivElement>({
    onSwipeLeft: () => {
      flashSwipe('left');
      nextTrack();
    },
    onSwipeRight: () => {
      flashSwipe('right');
      prevTrack();
    },
    threshold: 40,
  });

  if (!currentTrack) return null;

  return (
    <>
      {expanded && <MobileNowPlaying onClose={() => setExpanded(false)} />}

      <div
        ref={swipeRef}
        className={`md:hidden fixed left-0 right-0 z-40 bg-[var(--glass-bg)] backdrop-blur-2xl border-t border-[var(--glass-border)] transition-transform duration-200 ${
          swipeDir === 'left' ? '-translate-x-2' : swipeDir === 'right' ? 'translate-x-2' : 'translate-x-0'
        }`}
        style={{ bottom: 'calc(3.5rem + var(--safe-area-bottom))' }}
      >
        {/* Tap area to expand — everything except the control buttons */}
        <div
          className="flex items-center gap-3 px-4 py-2.5 active:bg-white/5 transition-colors"
          onClick={() => setExpanded(true)}
        >
          {/* Album Art */}
          <div className="w-10 h-10 rounded-lg flex-shrink-0 overflow-hidden bg-[var(--color-surface)] border border-[var(--glass-border)]">
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
              <span className="text-sm font-medium text-[var(--color-text-primary)] truncate leading-tight">
                {currentTrack.title || currentTrack.path.split(/[\\/]/).pop()}
              </span>
              {castConnected && (
                <Cast size={14} className="flex-shrink-0 text-[var(--color-primary)]" style={{ filter: 'drop-shadow(0 0 3px var(--color-primary))' }} />
              )}
            </div>
            <div className="text-xs text-[var(--color-text-muted)] truncate leading-tight mt-0.5">
              {currentTrack.artist || 'Unknown Artist'}
            </div>
          </div>

          {/* Controls — stop propagation so they don't trigger expand */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={handlePlayPause}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              className="w-10 h-10 flex items-center justify-center rounded-full text-[var(--color-text-primary)] active:scale-90 transition-transform"
            >
              {isPlaying ? <Pause size={22} /> : <Play size={22} fill="currentColor" />}
            </button>
            <button
              onClick={handleNext}
              aria-label="Next track"
              className="w-10 h-10 flex items-center justify-center rounded-full text-[var(--color-text-secondary)] active:scale-90 transition-transform"
            >
              <SkipForward size={20} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default MobileMiniPlayer;
