import { usePlayerStore } from '../store/index';
import { usePlaybackTimeStore } from '../store/playbackTime';
import { playbackManager } from '../utils/PlaybackManager';
import { WaveformProgressBar } from './WaveformProgressBar';
import { formatTime } from '../utils/formatTime';
import React from 'react';

const ProgressBarImpl = () => {
  const castPlaybackStatus = usePlayerStore((state) => state.castPlaybackStatus);
  const currentTime = usePlaybackTimeStore((state) => state.currentTime);
  const duration = usePlaybackTimeStore((state) => state.duration);
  const playlist = usePlayerStore((state) => state.playlist);
  const currentIndex = usePlayerStore((state) => state.currentIndex);

  const currentTrack = currentIndex !== null ? playlist[currentIndex] : null;

  // WMA files are transcoded on-the-fly (WMA → MP3 in /api/stream) so the
  // waveform decoder can't get a finite-length buffer for peaks. music-metadata
  // labels the container as "ASF/Windows Media" (no literal "WMA"), so match
  // both. `path` is base64 on the client, so don't try to test its extension.
  const fmt = currentTrack?.format?.toUpperCase() || '';
  const isTranscoded = fmt.includes('WMA') || fmt.includes('ASF');

  const dbDuration = currentTrack?.duration; // duration in seconds from DB scan
  const displayDuration = (!isFinite(duration) || duration === 0) && dbDuration
    ? dbDuration
    : duration;

  const handleSeek = React.useCallback((time: number) => {
    usePlayerStore.getState().seekTo(time);
  }, []);

  // A start in progress shows the normal bar (the play button spins); only
  // a start that failed after its retry replaces it.
  if (castPlaybackStatus === 'unconfirmed') {
    return <div className="progress-bar-container" role="status" aria-live="polite">
      Playback not confirmed
    </div>;
  }

  return (
    <div className="progress-bar-container">
      <span className="progress-time">{formatTime(currentTime)}</span>
      {currentTrack?.url ? (
        <WaveformProgressBar
          audioUrl={currentTrack.rawUrl || currentTrack.url}
          duration={displayDuration}
          onSeek={handleSeek}
          dbDuration={dbDuration}
          allowWaveformDecode={!isTranscoded}
        />
      ) : (
        // Fallback plain bar if no URL
        <div
          className="progress-track"
          onClick={(e: React.MouseEvent<HTMLDivElement>) => {
            if (!displayDuration) return;
            const rect = e.currentTarget.getBoundingClientRect();
            handleSeek((e.clientX - rect.left) / rect.width * displayDuration);
          }}
        >
          <div className="progress-fill" style={{ width: `${displayDuration ? (currentTime / displayDuration) * 100 : 0}%` }} />
        </div>
      )}
      <span className="progress-time">{formatTime(displayDuration)}</span>
    </div>
  );
};

// Memoized: ProgressBar takes no props, so this prevents the parent
// (MobileNowPlaying / PlayerControls) re-rendering for unrelated reasons from
// reconciling this subtree. Its own currentTime subscription still updates it
// per tick, which is required to show elapsed time.
const ProgressBar = React.memo(ProgressBarImpl);

export default ProgressBar;
