import { usePlayerStore } from '../store/index';
import { useState, useEffect } from 'react';
import { X, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Infinity as InfinityIcon, ListMusic, Cast, FileText } from 'lucide-react';
import ProgressBar from './ProgressBar';
import { useSwipe } from '../hooks/useSwipe';
import { castManager } from '../utils/CastManager';
import { LyricsPanel } from './LyricsPanel';

interface MobileNowPlayingProps {
  onClose: () => void;
}

const MobileNowPlaying: React.FC<MobileNowPlayingProps> = ({ onClose }) => {
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const playbackState = usePlayerStore((s) => s.playbackState);
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
  const setIsSidebarOpen = usePlayerStore((s) => s.setIsSidebarOpen);

  const [castConnected, setCastConnected] = useState(castManager.isConnected());
  const [showLyrics, setShowLyrics] = useState(false);
  useEffect(() => {
    const unsubscribe = castManager.addStateChangeListener((state) => {
      setCastConnected(state === 'CONNECTED');
    });
    return unsubscribe;
  }, []);

  const currentTrack = currentIndex !== null ? playlist[currentIndex] : null;
  const isPlaying = playbackState === 'playing';

  const handlePlayPause = () => {
    if (playlist.length === 0) return;
    if (isPlaying) pause();
    else if (currentIndex === null) usePlayerStore.getState().playAtIndex(0);
    else resume();
  };

  const swipeRef = useSwipe<HTMLDivElement>({
    onSwipeDown: onClose,
    threshold: 80,
  });

  if (!currentTrack) return null;

  return (
    <div className="md:hidden fixed inset-0 z-50 flex flex-col bg-[var(--color-bg-primary)] animate-slide-up">
      {/* Safe area top spacer */}
      <div style={{ height: 'var(--safe-area-top)' }} />

      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3">
        <button
          onClick={onClose}
          className="w-9 h-9 flex items-center justify-center rounded-full bg-white/10 text-[var(--color-text-secondary)] active:scale-90 transition-transform"
        >
          <X size={18} />
        </button>
        <span className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">Now Playing</span>
        <div className="w-9" /> {/* spacer */}
      </div>

      {/* Scrollable content */}
      <div ref={swipeRef} className="flex-1 flex flex-col items-center justify-center px-8 overflow-hidden">
        {/* Album Art or Lyrics */}
        {showLyrics ? (
          <div className="w-full max-w-sm flex-shrink-0 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-2xl p-5">
            <LyricsPanel
              trackName={currentTrack.title || currentTrack.path.split(/[\\/]/).pop() || ''}
              artistName={currentTrack.artist || ''}
              isVisible={showLyrics}
              onClose={() => setShowLyrics(false)}
            />
          </div>
        ) : (
          <div className="w-56 h-56 sm:w-64 sm:h-64 rounded-2xl overflow-hidden bg-[var(--color-surface)] border border-[var(--glass-border)] shadow-2xl flex-shrink-0">
            {currentTrack.artUrl ? (
              <img
                src={currentTrack.artUrl}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-[var(--color-text-muted)]">
                <Play size={48} />
              </div>
            )}
          </div>
        )}

        {/* Track Info */}
        <div className="mt-8 text-center w-full max-w-sm">
          <h2 className="text-xl font-bold text-[var(--color-text-primary)] truncate">
            {currentTrack.title || currentTrack.path.split(/[\\/]/).pop()}
          </h2>
          <p className="text-sm text-[var(--color-text-muted)] mt-1 truncate">
            {currentTrack.artist || 'Unknown Artist'}
          </p>
          {currentTrack.album && (
            <p className="text-xs text-[var(--aurora-extra-glow)] mt-0.5 truncate">
              {currentTrack.album}
            </p>
          )}
        </div>

        {/* Progress Bar */}
        <div className="w-full max-w-sm mt-8">
          <ProgressBar />
        </div>

        {/* Transport Controls */}
        <div className="flex items-center justify-center gap-6 mt-6">
          <button
            onClick={toggleShuffle}
            aria-label="Toggle shuffle"
            className="w-10 h-10 flex items-center justify-center rounded-full text-[var(--color-text-muted)] active:scale-90 transition-all"
            style={{ opacity: shuffle ? 1 : 0.4 }}
          >
            <Shuffle size={20} />
          </button>

          <button
            onClick={prevTrack}
            aria-label="Previous track"
            className="w-12 h-12 flex items-center justify-center rounded-full text-[var(--color-text-primary)] active:scale-90 transition-transform"
          >
            <SkipBack size={24} fill="currentColor" />
          </button>

          <button
            onClick={handlePlayPause}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            className="w-16 h-16 flex items-center justify-center rounded-full bg-[var(--color-primary)] text-white shadow-lg active:scale-90 transition-transform"
            style={{
              background: 'var(--aurora-play-gradient)',
              border: 'var(--aurora-play-border)',
              boxShadow: 'var(--aurora-play-glow)',
            }}
          >
            {isPlaying ? <Pause size={28} /> : <Play size={28} fill="currentColor" />}
          </button>

          <button
            onClick={nextTrack}
            aria-label="Next track"
            className="w-12 h-12 flex items-center justify-center rounded-full text-[var(--color-text-primary)] active:scale-90 transition-transform"
          >
            <SkipForward size={24} fill="currentColor" />
          </button>

          <button
            onClick={cycleRepeat}
            aria-label="Cycle repeat"
            className="w-10 h-10 flex items-center justify-center rounded-full text-[var(--color-text-muted)] active:scale-90 transition-all"
            style={{ opacity: repeat === 'none' ? 0.4 : 1 }}
          >
            {repeat === 'one' ? <Repeat1 size={20} /> : <Repeat size={20} />}
          </button>
        </div>

        {/* Secondary controls row */}
        <div className="flex items-center justify-center gap-8 mt-6">
          <button
            onClick={() => { setIsSidebarOpen(true); }}
            aria-label="Open play queue"
            className="w-9 h-9 flex items-center justify-center rounded-full text-[var(--color-text-muted)] active:scale-90 transition-transform"
          >
            <ListMusic size={20} />
          </button>

          <button
            onClick={() => setShowLyrics(!showLyrics)}
            aria-label="Toggle lyrics"
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border border-[var(--glass-border)] transition-all"
            style={{
              opacity: showLyrics ? 1 : 0.4,
              color: showLyrics ? 'var(--color-primary)' : 'var(--color-text-muted)',
            }}
          >
            <FileText size={16} />
            Lyrics
          </button>

          <button
            onClick={toggleInfinityMode}
            aria-label="Toggle Infinity Mode"
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border border-[var(--glass-border)] transition-all"
            style={{
              opacity: isInfinityMode ? 1 : 0.4,
              color: isInfinityMode ? 'var(--color-primary)' : 'var(--color-text-muted)',
              filter: isInfinityMode ? 'drop-shadow(0 0 4px var(--color-primary))' : 'none',
            }}
          >
            <InfinityIcon size={16} />
            Infinity
          </button>

          <button
            onClick={() => castConnected ? castManager.disconnect() : castManager.requestSession()}
            className="w-10 h-10 flex items-center justify-center rounded-full active:scale-90 transition-all"
            style={{
              color: castConnected ? 'var(--color-primary)' : 'var(--color-text-muted)',
              filter: castConnected ? 'drop-shadow(0 0 4px var(--color-primary))' : 'none',
            }}
            title={castConnected ? 'Disconnect from cast' : 'Cast to device'}
          >
            <Cast size={22} />
          </button>
        </div>
      </div>

      {/* Safe area bottom spacer */}
      <div style={{ height: 'var(--safe-area-bottom)' }} />
    </div>
  );
};

export default MobileNowPlaying;
