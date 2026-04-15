import React, { useEffect, useState } from 'react';
import { usePlayerStore } from '../store/index';
import { useVolumeSync } from '../hooks/useVolumeSync';
import { Infinity, Cast, FileText } from 'lucide-react';
import { castManager } from '../utils/CastManager';
import { LyricsPanel } from './LyricsPanel';
import {
  IconPrev,
  IconPlay,
  IconPause,
  IconNext,
  IconShuffle,
  IconSequential,
  IconRepeatAll,
  IconRepeatOne,
  IconVolume
} from './icons/PlayerIcons';

const baseBtnClass = "flex items-center justify-center w-10 h-10 rounded-full border border-black/10 bg-black/5 backdrop-blur-md text-black/60 hover:text-black/90 hover:border-black/20 hover:bg-black/10 hover:shadow-[0_4px_16px_rgba(0,0,0,0.1),inset_0_1px_0_rgba(255,255,255,0.6)] active:scale-95 active:bg-black/10 dark:border-white/10 dark:bg-white/5 dark:text-white/75 dark:hover:text-white dark:hover:border-white/20 dark:hover:bg-white/10 dark:hover:shadow-[0_4px_16px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.12)] transition-all duration-150";

const playBtnClass = "flex items-center justify-center w-14 h-14 rounded-full border border-emerald-500/40 bg-gradient-to-br from-emerald-500/85 to-emerald-600/90 backdrop-blur-[20px] text-white shadow-[0_0_24px_rgba(16,185,129,0.35),inset_0_1px_0_rgba(255,255,255,0.2)] hover:from-emerald-400/90 hover:to-emerald-500/95 hover:border-emerald-300/60 hover:shadow-[0_0_36px_rgba(16,185,129,0.65),inset_0_1px_0_rgba(255,255,255,0.25)] hover:scale-105 active:scale-95 transition-all duration-200";

const volumeSliderClass = "w-20 h-1 appearance-none bg-black/5 dark:bg-white/5 rounded-full cursor-pointer outline-none transition-all hover:h-1.5 " +
  "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--color-text-secondary)] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-all " +
  "hover:[&::-webkit-slider-thumb]:bg-[var(--color-text-primary)] hover:[&::-webkit-slider-thumb]:scale-125 hover:[&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(16,185,129,0.3)]";

export const PlayerControls: React.FC = () => {
  const playbackState = usePlayerStore((state) => state.playbackState);
  const isBuffering = usePlayerStore((state) => state.isBuffering);
  const volume = usePlayerStore((state) => state.volume);
  const shuffle = usePlayerStore((state) => state.shuffle);
  const repeat = usePlayerStore((state) => state.repeat);
  const isInfinityMode = usePlayerStore((state) => state.isInfinityMode);
  
  // By avoiding mapping over the entire playlist slice, we stop mass re-renders on playlist appending
  const currentTrack = usePlayerStore((state) => 
    state.currentIndex !== null ? state.playlist[state.currentIndex] : null
  );

  const setVolume = usePlayerStore((state) => state.setVolume);
  const nextTrackAction = usePlayerStore((state) => state.nextTrack);
  const prevTrackAction = usePlayerStore((state) => state.prevTrack);
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle);
  const cycleRepeatAction = usePlayerStore((state) => state.cycleRepeat);
  const toggleInfinityMode = usePlayerStore((state) => state.toggleInfinityMode);

  const isPlaying = playbackState === 'playing';

  const togglePlay = React.useCallback(() => {
    const state = usePlayerStore.getState();
    if (state.playlist.length === 0) return;
    if (state.playbackState === 'playing') {
      state.pause();
    } else {
      if (state.currentIndex === null) {
        state.playAtIndex(0);
      } else {
        state.resume();
      }
    }
  }, []);

  // Optimized keyboard shortcuts logic capturing active state lazily 
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const state = usePlayerStore.getState();
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowRight':
          state.nextTrack();
          break;
        case 'ArrowLeft':
          state.prevTrack();
          break;
        case 'KeyM':
          state.setVolume(Math.min(1, state.volume + 0.05));
          break;
        case 'Comma':
          state.setVolume(Math.max(0, state.volume - 0.05));
          break;
        case 'KeyS':
          state.toggleShuffle();
          break;
        case 'KeyR':
          state.cycleRepeat();
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay]);

  useVolumeSync();

  const [castAvailable, setCastAvailable] = useState(false);
  const castConnected = usePlayerStore((s) => s.castConnected);
  const [castDeviceName, setCastDeviceName] = useState('');
  const [showLyrics, setShowLyrics] = useState(false);

  useEffect(() => {
    const handleCastReady = () => {
      setCastAvailable(true);
      if (castManager.isConnected()) {
        setCastDeviceName(castManager.getCastDeviceName());
      }
    };
    if ((window as any).cast?.framework) {
      handleCastReady();
    } else {
      window.addEventListener('castApiAvailable', handleCastReady);
    }

    // Update device name when cast state changes
    const unsubscribe = castManager.addStateChangeListener((state) => {
      if (state === 'CONNECTED') {
        setCastDeviceName(castManager.getCastDeviceName());
      } else {
        setCastDeviceName('');
      }
    });

    return () => {
      window.removeEventListener('castApiAvailable', handleCastReady);
      unsubscribe();
    };
  }, []);

  const volumePercent = Math.round(volume * 100);

  return (
    <div className="w-full flex items-center justify-between gap-6 px-2">
      {/* Left Column: Aux Controls */}
      <div className="flex-1 flex justify-start items-center pl-2 gap-2 relative">
        {castAvailable && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => castConnected ? castManager.disconnect() : castManager.requestSession()}
              className="transition-colors hover:scale-105"
              style={{ color: castConnected ? 'var(--color-primary)' : 'var(--color-text-muted)', filter: castConnected ? 'drop-shadow(0 0 4px var(--color-primary))' : 'none' }}
              title={castConnected ? 'Disconnect from cast' : 'Cast to device'}
              aria-label={castConnected ? 'Disconnect from cast' : 'Cast to device'}
            >
              <Cast size={20} />
            </button>
            {castConnected && castDeviceName && (
              <span className="text-xs text-[var(--color-primary)] font-medium truncate max-w-[120px]">
                {castDeviceName}
              </span>
            )}
          </div>
        )}
        {currentTrack && (
          <button
            onClick={() => setShowLyrics(!showLyrics)}
            className="transition-colors hover:scale-105"
            style={{ color: showLyrics ? 'var(--color-primary)' : 'var(--color-text-muted)' }}
            title="Lyrics"
            aria-label="Open Lyrics"
          >
            <FileText size={18} />
          </button>
        )}
        {showLyrics && currentTrack && (
          <div className="absolute bottom-full left-0 mb-3 w-64 bg-[var(--glass-bg)] backdrop-blur-2xl border border-[var(--glass-border)] rounded-2xl p-4 shadow-2xl z-50">
            <LyricsPanel
              trackName={currentTrack.title || currentTrack.path.split(/[\\/]/).pop() || ''}
              artistName={currentTrack.artist || ''}
              isVisible={showLyrics}
              onClose={() => setShowLyrics(false)}
            />
          </div>
        )}
      </div>

      {/* Center: Now Playing + Main Controls */}
      <div className="flex flex-col items-center gap-3 flex-[2] min-w-0" aria-live="polite">
        {/* Metadata Stack */}
        {currentTrack ? (
          <div className="flex flex-col items-center min-w-0 w-full animate-in fade-in slide-in-from-bottom-2 duration-500">
            <div className="text-sm font-bold text-[var(--color-text-primary)] truncate max-w-full tracking-tight" title={`${currentTrack.artist || 'Unknown Artist'} - ${currentTrack.title || currentTrack.path.split(/[\\/]/).pop()}`}>
              <span className="text-[var(--color-primary)]">{currentTrack.artist || 'Unknown Artist'}</span>
              <span className="text-[var(--color-text-muted)] mx-2 opacity-50">•</span>
              <span>{currentTrack.title || currentTrack.path.split(/[\\/]/).pop()}</span>
            </div>
            
            <div className="flex items-center justify-center gap-2 mt-1 flex-wrap">
              {currentTrack.bitrate && (
                <span className="text-[0.6rem] px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/10 text-[var(--color-text-secondary)] border border-[var(--glass-border)] whitespace-nowrap font-bold tracking-wider uppercase">
                  {Math.round(currentTrack.bitrate / 1000)} kbps
                </span>
              )}
              {currentTrack.format && (
                <span className="text-[0.6rem] px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/10 text-[var(--color-text-secondary)] border border-[var(--glass-border)] uppercase whitespace-nowrap font-bold tracking-wider">
                  {currentTrack.format}
                </span>
              )}
              {currentTrack.genre && (
                <span className="text-[0.6rem] px-2 py-0.5 rounded-full bg-black/5 dark:bg-white/10 text-[var(--color-text-secondary)] border border-[var(--glass-border)] whitespace-nowrap truncate max-w-[100px] font-bold tracking-wider uppercase">
                  {currentTrack.genre}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="h-10" /> /* Placeholder to keep layout stable */
        )}

        {/* Transport Buttons */}
        <div className="flex items-center justify-center gap-4">
          <button onClick={toggleShuffle} aria-label="Toggle shuffle" className={baseBtnClass}
            style={{ opacity: shuffle ? 1 : 0.4 }}>
            {shuffle ? <IconShuffle /> : <IconSequential />}
          </button>

          <button onClick={prevTrackAction} aria-label="Previous track" className={baseBtnClass}>
            <IconPrev />
          </button>

          <button onClick={togglePlay} aria-label={isBuffering ? "Loading" : isPlaying ? "Pause" : "Play"} className={playBtnClass} disabled={isBuffering}>
            {isBuffering ? (
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 0.8s linear infinite' }}>
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            ) : isPlaying ? <IconPause /> : <IconPlay />}
          </button>

          <button onClick={nextTrackAction} aria-label="Next track" className={baseBtnClass}>
            <IconNext />
          </button>

          <button onClick={cycleRepeatAction} aria-label={`Repeat mode: ${repeat}`} className={baseBtnClass}
            style={{ opacity: repeat === 'none' ? 0.4 : 1 }}>
            {repeat === 'one' ? <IconRepeatOne /> : <IconRepeatAll />}
          </button>

          <button onClick={toggleInfinityMode} aria-label="Toggle Infinity Mode" className={`${baseBtnClass} ml-3 border-transparent bg-transparent hover:bg-transparent shadow-none`}
            style={{ 
              opacity: isInfinityMode ? 1 : 0.4, 
              color: isInfinityMode ? 'var(--color-primary)' : 'inherit',
              filter: isInfinityMode ? 'drop-shadow(0 0 6px var(--color-primary))' : 'none',
              transform: isInfinityMode ? 'scale(1.1)' : 'scale(1)'
            }}>
            <Infinity size={20} strokeWidth={2} />
          </button>
        </div>
      </div>

      {/* Right Column: Aux Controls */}
      <div className="flex-1 flex justify-end items-center gap-4">
        <div className="flex items-center gap-1.5">
          <span className="text-[var(--color-text-muted)] text-[0.8rem] flex items-center" aria-hidden="true">
            <IconVolume />
          </span>
          <input
            id="volume-slider"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(e) => setVolume(parseFloat(e.target.value))}
            className={volumeSliderClass}
            aria-label="Volume Control"
          />
          <span className="min-w-[28px] text-[0.68rem] text-[var(--color-text-muted)] tracking-tighter" style={{ fontVariantNumeric: 'tabular-nums' }} aria-hidden="true">
            {volumePercent}%
          </span>
        </div>
      </div>
    </div>
  );
};

export default PlayerControls;
