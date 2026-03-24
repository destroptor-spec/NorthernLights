import { usePlayerStore } from '../store/index';
import { useVolumeSync } from '../hooks/useVolumeSync';
import React from 'react';

/* ─── Inline SVG Icons ─── */
const IconPrev = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 6h2v12H6V6zm3.5 6 8.5 6V6l-8.5 6z" />
  </svg>
);

const IconPlay = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M8 5v14l11-7L8 5z" />
  </svg>
);

const IconPause = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
  </svg>
);

const IconNext = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z" />
  </svg>
);

const IconShuffle = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" />
  </svg>
);

const IconSequential = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M14 16v-4l8 5-8 5v-4H2v-2h12zM10 8V4L2 9l8 5v-4h12V8H10z" opacity="0.5" />
  </svg>
);

const IconRepeatAll = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
  </svg>
);

const IconRepeatOne = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H13z" />
  </svg>
);

const IconVolume = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
  </svg>
);

const IconInfinity = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
    <path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 1 0 0-8c-2 0-4 1.33-6 4Z"/>
  </svg>
);

const PlayerControls = () => {
  const playbackState = usePlayerStore((state) => state.playbackState);
  const isPlaying = playbackState === 'playing';
  const pause = usePlayerStore((state) => state.pause);
  const resume = usePlayerStore((state) => state.resume);
  const nextTrackAction = usePlayerStore((state) => state.nextTrack);
  const prevTrackAction = usePlayerStore((state) => state.prevTrack);
  const volume = usePlayerStore((state) => state.volume);
  const setVolume = usePlayerStore((state) => state.setVolume);
  const shuffle = usePlayerStore((state) => state.shuffle);
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle);
  const repeat = usePlayerStore((state) => state.repeat);
  const cycleRepeatAction = usePlayerStore((state) => state.cycleRepeat);
  const isInfinityMode = usePlayerStore((state) => state.isInfinityMode);
  const toggleInfinityMode = usePlayerStore((state) => state.toggleInfinityMode);
  const playlist = usePlayerStore((state) => state.playlist);
  const currentIndex = usePlayerStore((state) => state.currentIndex);

  const togglePlay = React.useCallback(() => {
    if (playlist.length === 0) return;
    if (isPlaying) {
      pause();
    } else {
      if (currentIndex === null) {
        usePlayerStore.getState().playAtIndex(0);
      } else {
        resume();
      }
    }
  }, [playlist.length, isPlaying, pause, currentIndex, resume]);

  // Keyboard shortcuts
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowRight':
          nextTrackAction();
          break;
        case 'ArrowLeft':
          prevTrackAction();
          break;
        case 'KeyM':
          setVolume(Math.min(1, volume + 0.05));
          break;
        case 'Comma':
          setVolume(Math.max(0, volume - 0.05));
          break;
        case 'KeyS':
          toggleShuffle();
          break;
        case 'KeyR':
          cycleRepeatAction();
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, nextTrackAction, prevTrackAction, setVolume, volume, toggleShuffle, cycleRepeatAction]);

  useVolumeSync();

  const volumePercent = Math.round(volume * 100);

  return (
    <div className="player-controls">
      <button onClick={toggleShuffle} aria-label="Toggle shuffle" className="player-control-btn"
        style={{ opacity: shuffle ? 1 : 0.4 }}>
        {shuffle ? <IconShuffle /> : <IconSequential />}
      </button>

      <button onClick={prevTrackAction} aria-label="Previous track" className="player-control-btn">
        <IconPrev />
      </button>

      <button onClick={togglePlay} aria-label={isPlaying ? "Pause" : "Play"} className="player-control-btn play-btn-main">
        {isPlaying ? <IconPause /> : <IconPlay />}
      </button>

      <button onClick={nextTrackAction} aria-label="Next track" className="player-control-btn">
        <IconNext />
      </button>

      <div className="repeat-toggle">
        <button onClick={cycleRepeatAction} aria-label="Cycle repeat mode" className="player-control-btn"
          style={{ opacity: repeat === 'none' ? 0.4 : 1 }}>
          {repeat === 'one' ? <IconRepeatOne /> : <IconRepeatAll />}
        </button>
      </div>

      <div className="infinity-toggle" style={{ marginLeft: '12px' }}>
        <button onClick={toggleInfinityMode} aria-label="Toggle Infinity Mode" className="player-control-btn"
          style={{ 
            opacity: isInfinityMode ? 1 : 0.4, 
            color: isInfinityMode ? 'var(--aurora-purple)' : 'inherit',
            filter: isInfinityMode ? 'drop-shadow(0 0 6px var(--aurora-purple))' : 'none',
            transition: 'all 0.3s ease'
          }}>
          <IconInfinity />
        </button>
      </div>

      <div className="volume-control" style={{ marginLeft: 'auto' }}>
        <span className="volume-icon"><IconVolume /></span>
        <input
          id="volume-slider"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          className="volume-slider"
        />
        <span style={{ minWidth: 28, fontSize: '0.68rem', color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
          {volumePercent}%
        </span>
      </div>
    </div>
  );
};

export default PlayerControls;
