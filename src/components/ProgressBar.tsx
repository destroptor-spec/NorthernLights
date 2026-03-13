import { usePlayerStore } from '../store/index';
import { playbackManager } from '../utils/PlaybackManager';
import { WaveformProgressBar } from './WaveformProgressBar';
import React from 'react';

const formatTime = (seconds: number): string => {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const ProgressBar = () => {
  const currentTime = usePlayerStore((state) => state.currentTime);
  const duration = usePlayerStore((state) => state.duration);
  const playlist = usePlayerStore((state) => state.playlist);
  const currentIndex = usePlayerStore((state) => state.currentIndex);

  const currentTrack = currentIndex !== null ? playlist[currentIndex] : null;

  const handleSeek = (time: number) => {
    playbackManager.seek(time);
  };

  return (
    <div className="progress-bar-container">
      <span className="progress-time">{formatTime(currentTime)}</span>
      {currentTrack?.url ? (
        <WaveformProgressBar
          audioUrl={currentTrack.url}
          currentTime={currentTime}
          duration={duration}
          onSeek={handleSeek}
        />
      ) : (
        // Fallback plain bar if no URL
        <div
          className="progress-track"
          onClick={(e: React.MouseEvent<HTMLDivElement>) => {
            if (!duration) return;
            const rect = e.currentTarget.getBoundingClientRect();
            handleSeek((e.clientX - rect.left) / rect.width * duration);
          }}
        >
          <div className="progress-fill" style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }} />
        </div>
      )}
      <span className="progress-time">{formatTime(duration)}</span>
    </div>
  );
};

export default ProgressBar;
