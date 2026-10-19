import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePlayerStore } from '../store/index';
import { selectDisplayedPlaying } from '../utils/sessionFollow';
import { useFollowedDeviceLabel } from '../hooks/useFollowedDeviceName';
import { useDisplayedPlaying } from '../hooks/useDisplayedPlaying';
import { hasNextTrack } from '../utils/queue';
import { usePlaybackTimeStore } from '../store/playbackTime';
import { useVolumeSync } from '../hooks/useVolumeSync';
import { Infinity, FileText, Waypoints } from 'lucide-react';
import { LyricsPanel } from './LyricsPanel';
import { LoveButton } from './LoveButton';
import { CastButton } from './cast/CastButton';
import { WaveformProgressBar } from './WaveformProgressBar';
import { castManager } from '../utils/CastManager';
import { formatTime } from '../utils/formatTime';
import { playbackManager } from '../utils/PlaybackManager';
import { usePlayerPlacement } from '../hooks/usePlayerPlacement';
import type { PlaybackLoadPath } from '../store/index';
import type { StreamingQualityPreset } from '../utils/streaming';
import {
  IconPrev,
  IconPlay,
  IconPause,
  IconNext,
  IconShuffle,
  IconSequential,
  IconRepeatAll,
  IconRepeatOne,
  IconVolume,
} from './icons/PlayerIcons';

// ──────────────────────────────────────────────────────────────────────────
// Visual primitives shared inside the bar
// ──────────────────────────────────────────────────────────────────────────

const auxBtnClass =
  'player-aux-btn flex items-center justify-center w-9 h-9 rounded-full text-[var(--color-text-muted)] ' +
  'hover:text-[var(--color-text-primary)] hover:bg-black/5 dark:hover:bg-white/10 ' +
  'transition-ui duration-150';

const transportBtnClass =
  'flex items-center justify-center w-9 h-9 rounded-full border border-black/10 bg-black/5 ' +
  'text-black/65 hover:text-black/95 hover:border-black/20 hover:bg-black/10 ' +
  'dark:border-white/10 dark:bg-white/5 dark:text-white/75 dark:hover:text-white ' +
  'dark:hover:border-white/20 dark:hover:bg-white/10 active:scale-95 transition-ui duration-150 ' +
  'disabled:opacity-40 disabled:cursor-default disabled:pointer-events-none';

const playBtnClass =
  'flex items-center justify-center w-11 h-11 rounded-full border border-emerald-500/40 ' +
  'bg-gradient-to-br from-emerald-500/85 to-emerald-600/90 text-white ' +
  'shadow-[0_0_18px_rgba(16,185,129,0.32),inset_0_1px_0_rgba(255,255,255,0.2)] ' +
  'hover:from-emerald-400/90 hover:to-emerald-500/95 hover:border-emerald-300/60 ' +
  'hover:shadow-[0_0_28px_rgba(16,185,129,0.55),inset_0_1px_0_rgba(255,255,255,0.25)] ' +
  'hover:scale-105 active:scale-95 transition-ui duration-200';

// ──────────────────────────────────────────────────────────────────────────
// Title ticker — ping-pong scroll when text overflows (float mode only)
// ──────────────────────────────────────────────────────────────────────────

interface TitleTickerProps {
  text: string;
}

const TitleTicker: React.FC<TitleTickerProps> = ({ text }) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      const w = wrapperRef.current;
      const i = innerRef.current;
      if (!w || !i) return;
      const diff = i.scrollWidth - w.clientWidth;
      setOverflow(diff > 1 ? diff : 0);
    };
    measure();

    const ro = new ResizeObserver(measure);
    if (wrapperRef.current) ro.observe(wrapperRef.current);
    if (innerRef.current) ro.observe(innerRef.current);
    return () => ro.disconnect();
  }, [text]);

  // Scale the duration with the overflow distance so long titles don't fly
  // by. ~28px per second feels calm; clamp to [10s, 22s].
  const duration = overflow > 0
    ? Math.min(22, Math.max(10, overflow / 28 * 2 + 4))
    : 0;

  const styleVar: React.CSSProperties = {
    // Negative shift, applied via CSS variable on the inner span.
    ['--ticker-shift' as never]: `${-overflow}px`,
    ['--ticker-duration' as never]: `${duration}s`,
  };

  return (
    <div
      ref={wrapperRef}
      className={`player-title-ticker ${overflow > 0 ? 'is-overflow' : ''}`}
      title={text}
      style={styleVar}
    >
      <span ref={innerRef} className="player-title-ticker-inner">
        {text}
      </span>
    </div>
  );
};

// ──────────────────────────────────────────────────────────────────────────
// Signal-chain chip
// ──────────────────────────────────────────────────────────────────────────

type ChainNode = { label: string; sub?: string };

const formatBitrate = (bitrate?: number) =>
  bitrate && bitrate > 0 ? `${Math.round(bitrate / 1000)} kbps` : null;

const outputCodecForLoadPath = (
  loadPath: PlaybackLoadPath,
  streamingQuality: StreamingQualityPreset,
  adaptiveActiveBitrateKbps: number | null,
): string | null => {
  switch (loadPath) {
    case 'direct':
      return null;
    case 'prepared-hls':
    case 'fallback-hls':
      if (streamingQuality === 'auto') {
        return adaptiveActiveBitrateKbps
          ? `Auto · ${adaptiveActiveBitrateKbps} kbps`
          : 'Auto';
      }
      return 'HLS · AAC';
    case 'cast':
      return 'HLS · AAC';
    default:
      return null;
  }
};

interface SignalChainProps {
  sourceFormat: string | null;
  sourceBitrate: string | null;
  outputCodec: string | null;
  deviceLabel: string;
}

const SignalChain: React.FC<SignalChainProps> = ({
  sourceFormat,
  sourceBitrate,
  outputCodec,
  deviceLabel,
}) => {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  const handleEnter = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const handleLeave = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 80);
  };

  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  const nodes: ChainNode[] = useMemo(() => {
    const result: ChainNode[] = [];
    if (sourceFormat) {
      result.push({ label: sourceFormat, sub: sourceBitrate ?? undefined });
    }
    if (outputCodec) {
      result.push({ label: outputCodec });
    }
    result.push({ label: deviceLabel });
    return result;
  }, [sourceFormat, sourceBitrate, outputCodec, deviceLabel]);

  return (
    <span
      className="player-chain"
      onPointerEnter={handleEnter}
      onPointerLeave={handleLeave}
      onFocus={handleEnter}
      onBlur={handleLeave}
    >
      <button
        ref={chipRef}
        type="button"
        className="player-chain-chip"
        aria-expanded={open}
        aria-label={`Listening on ${deviceLabel}. Show signal chain`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <span className="player-chain-icon" aria-hidden="true">
          <Waypoints size={14} strokeWidth={1.8} />
        </span>
        <span className="player-chain-content" aria-hidden={!open}>
          {nodes.map((node, i) => (
            <React.Fragment key={`${node.label}-${i}`}>
              <span className="player-chain-node">
                <span className="player-chain-node-label">{node.label}</span>
                {node.sub && <span className="player-chain-node-sub">{node.sub}</span>}
              </span>
              {i < nodes.length - 1 && (
                <span className="player-chain-arrow" aria-hidden="true">→</span>
              )}
            </React.Fragment>
          ))}
        </span>
      </button>
    </span>
  );
};

// ──────────────────────────────────────────────────────────────────────────
// Inline waveform with trailing time label
// ──────────────────────────────────────────────────────────────────────────

const InlineWaveformImpl: React.FC = () => {
  const castPlaybackStatus = usePlayerStore((state) => state.castPlaybackStatus);
  const currentTime = usePlaybackTimeStore((s) => s.currentTime);
  const duration = usePlaybackTimeStore((s) => s.duration);
  const playlist = usePlayerStore((s) => s.playlist);
  const currentIndex = usePlayerStore((s) => s.currentIndex);
  const currentTrack = currentIndex !== null ? playlist[currentIndex] : null;
  const [placement] = usePlayerPlacement();

  const isTranscoded =
    currentTrack?.format?.toUpperCase().includes('WMA') ||
    currentTrack?.path?.toLowerCase().endsWith('.wma');

  const dbDuration = currentTrack?.duration;
  const displayDuration =
    (!isFinite(duration) || duration === 0) && dbDuration ? dbDuration : duration;

  const handleSeek = React.useCallback((time: number) => {
    usePlayerStore.getState().seekTo(time);
  }, []);

  // The WaveformProgressBar internally handles container resize via
  // ResizeObserver, so dock/undock will redraw the existing peaks at the
  // new width without a full remount + re-decode (which previously broke
  // rendering when combined with strict-mode double-mount).
  const audioUrl = currentTrack?.rawUrl || currentTrack?.url || '';

  // A start in progress shows the normal bar (the play button spins); only
  // a start that failed after its retry replaces it.
  if (castPlaybackStatus === 'unconfirmed') {
    return <div className="player-waveform" role="status" aria-live="polite">
      Playback not confirmed
    </div>;
  }

  return (
    <div className="player-waveform" data-placement={placement}>
      <div className="player-waveform-canvas">
        {currentTrack?.url ? (
          <WaveformProgressBar
            audioUrl={audioUrl}
            duration={displayDuration}
            onSeek={handleSeek}
            dbDuration={dbDuration}
            allowWaveformDecode={!isTranscoded}
          />
        ) : (
          <div className="player-waveform-empty" />
        )}
      </div>
      <span className="player-waveform-times" aria-hidden="true">
        <span className="player-waveform-current">{formatTime(currentTime)}</span>
        <span className="player-waveform-sep">/</span>
        <span className="player-waveform-total">{formatTime(displayDuration)}</span>
      </span>
    </div>
  );
};

// Memoized: takes no props, so parent (PlayerControls) re-renders for unrelated
// state no longer reconcile the waveform subtree. Its own currentTime
// subscription still updates the time label per tick.
const InlineWaveform = React.memo(InlineWaveformImpl);

// ──────────────────────────────────────────────────────────────────────────
// PlayerControls
// ──────────────────────────────────────────────────────────────────────────

export const PlayerControls: React.FC = () => {
  const playbackState = usePlayerStore((state) => state.playbackState);
  const isBuffering = usePlayerStore((state) => state.isBuffering);
  const volume = usePlayerStore((state) => state.volume);
  const shuffle = usePlayerStore((state) => state.shuffle);
  const repeat = usePlayerStore((state) => state.repeat);
  const isInfinityMode = usePlayerStore((state) => state.isInfinityMode);

  const currentTrack = usePlayerStore((state) =>
    state.currentIndex !== null ? state.playlist[state.currentIndex] : null
  );
  const queueSource = usePlayerStore((state) => state.queueSource);

  // Destination for the now-playing title: where the queue was started from.
  // album/playlist → that page; artist-top (Last.fm popular list) → the artist;
  // artist radio or no known source → the current track's album.
  const nowPlayingLink = useMemo<{ href: string; label: string } | null>(() => {
    if (queueSource) {
      if (queueSource.kind === 'album') return { href: `/library/album/${queueSource.id}`, label: 'album' };
      if (queueSource.kind === 'playlist') return { href: `/playlists/${queueSource.id}`, label: 'playlist' };
      if (queueSource.kind === 'artist-top') return { href: `/library/artist/${queueSource.id}`, label: 'artist' };
    }
    if (currentTrack?.albumId) return { href: `/library/album/${currentTrack.albumId}`, label: 'album' };
    return null;
  }, [queueSource, currentTrack]);

  const loadPath = usePlayerStore((state) => state.playbackTelemetry.loadPath);
  const adaptiveActiveBitrateKbps = usePlayerStore((state) => state.playbackTelemetry.adaptiveActiveBitrateKbps);
  const streamingQuality = usePlayerStore((state) => state.streamingQuality);
  const castConnected = usePlayerStore((state) => state.castConnected);
  const audioOutputActive = usePlayerStore((state) => state.audioOutputActive);
  const audioOutputDeviceLabel = usePlayerStore((state) => state.audioOutputDeviceLabel);

  const setVolume = usePlayerStore((state) => state.setVolume);
  const nextTrackAction = usePlayerStore((state) => state.nextTrack);
  const canSkipNext = usePlayerStore(hasNextTrack);
  const prevTrackAction = usePlayerStore((state) => state.prevTrack);
  const toggleShuffle = usePlayerStore((state) => state.toggleShuffle);
  const cycleRepeatAction = usePlayerStore((state) => state.cycleRepeat);
  const toggleInfinityMode = usePlayerStore((state) => state.toggleInfinityMode);

  const isPlaying = useDisplayedPlaying();

  const togglePlay = React.useCallback(() => {
    const state = usePlayerStore.getState();
    if (state.playlist.length === 0) return;
    if (selectDisplayedPlaying(state)) {
      state.pause();
    } else if (state.currentIndex === null) {
      state.playAtIndex(0);
    } else {
      state.resume();
    }
  }, []);

  const handleVolumeWheel = React.useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const state = usePlayerStore.getState();
    const delta = e.deltaY > 0 ? -0.05 : 0.05;
    state.setVolume(Math.min(1, Math.max(0, state.volume + delta)));
  }, []);

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
          state.setVolume(Math.max(0, state.volume - 0.05));
          break;
        case 'Comma':
          state.setVolume(Math.min(1, state.volume + 0.05));
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

  const [showLyrics, setShowLyrics] = useState(false);
  const [castDeviceName, setCastDeviceName] = useState(castManager.getCastDeviceName());
  const followedDeviceLabel = useFollowedDeviceLabel();

  useEffect(() => {
    const unsub = castManager.addStateChangeListener((state) => {
      setCastDeviceName(state === 'CONNECTED' ? castManager.getCastDeviceName() : '');
    });
    return unsub;
  }, []);

  // ── Signal-chain data derivation ──────────────────────────────────────
  const sourceFormat = currentTrack?.format?.toUpperCase() ?? null;
  const sourceBitrate = formatBitrate(currentTrack?.bitrate);
  const outputCodec = outputCodecForLoadPath(loadPath, streamingQuality, adaptiveActiveBitrateKbps);

  let deviceLabel = 'Browser';
  if (castConnected && castDeviceName) {
    deviceLabel = castDeviceName;
  } else if (audioOutputActive && audioOutputDeviceLabel) {
    deviceLabel = audioOutputDeviceLabel;
  }

  return (
    <div className="player-bar-row" aria-live="polite">
      {/* LEFT: cover + metadata + signal chain */}
      <div className="player-left">
        {currentTrack?.artUrl ? (
          <img
            src={currentTrack.artUrl}
            alt=""
            className="player-cover"
            loading="lazy"
          />
        ) : (
          <div className="player-cover player-cover-empty" aria-hidden="true">
            <IconPlay />
          </div>
        )}

        {currentTrack ? (
          <div className="player-metadata">
            <div className="player-title">
              {nowPlayingLink ? (
                <Link
                  to={nowPlayingLink.href}
                  className="player-title-link"
                  aria-label={`Go to ${nowPlayingLink.label}`}
                  title={`Go to ${nowPlayingLink.label}`}
                >
                  <TitleTicker
                    text={currentTrack.title || currentTrack.path.split(/[\\/]/).pop() || ''}
                  />
                </Link>
              ) : (
                <TitleTicker
                  text={currentTrack.title || currentTrack.path.split(/[\\/]/).pop() || ''}
                />
              )}
            </div>
            <div className="player-subline">
              {currentTrack.artistId ? (
                <Link
                  to={`/library/artist/${currentTrack.artistId}`}
                  className="player-artist player-artist-link"
                  title={currentTrack.artist || 'Unknown Artist'}
                >
                  {currentTrack.artist || 'Unknown Artist'}
                </Link>
              ) : (
                <span className="player-artist" title={currentTrack.artist || 'Unknown Artist'}>
                  {currentTrack.artist || 'Unknown Artist'}
                </span>
              )}
              {/* While another device plays, the device strip says where
                  (DeviceStrip); this device's own signal chain says nothing. */}
              {!followedDeviceLabel && (sourceFormat || castConnected || audioOutputActive) && (
                <SignalChain
                  sourceFormat={sourceFormat}
                  sourceBitrate={sourceBitrate}
                  outputCodec={outputCodec}
                  deviceLabel={deviceLabel}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="player-metadata">
            <div className="player-title player-title-empty">Nothing playing</div>
          </div>
        )}
      </div>

      {/* CENTER: waveform (fixed width) */}
      <div className="player-center">
        <InlineWaveform />
      </div>

      {/* RIGHT group: transport + volume + far cluster.
          Wrapped together so it reaches the slab's right edge in dock mode
          (grid template puts this group in column 3 with justify-self: end). */}
      <div className="player-right">

      {/* TRANSPORT cluster */}
      <div className="player-transport">
        <button
          onClick={toggleShuffle}
          aria-label={shuffle ? 'Shuffle on' : 'Shuffle off'}
          aria-pressed={shuffle}
          className={transportBtnClass}
          style={{ opacity: shuffle ? 1 : 0.4 }}
        >
          {shuffle ? <IconShuffle /> : <IconSequential />}
        </button>

        <button
          onClick={prevTrackAction}
          aria-label="Previous track"
          className={transportBtnClass}
        >
          <IconPrev />
        </button>

        <button
          onClick={togglePlay}
          aria-label={isBuffering ? 'Loading' : isPlaying ? 'Pause' : 'Play'}
          className={playBtnClass}
          disabled={isBuffering}
        >
          {isBuffering ? (
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              style={{ animation: 'spin 0.8s linear infinite' }}
            >
              <circle
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                opacity="0.25"
              />
              <path
                d="M12 2a10 10 0 0 1 10 10"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
          ) : isPlaying ? (
            <IconPause />
          ) : (
            <IconPlay />
          )}
        </button>

        <button
          onClick={() => void nextTrackAction()}
          disabled={!canSkipNext}
          aria-label="Next track"
          className={transportBtnClass}
        >
          <IconNext />
        </button>

        <button
          onClick={cycleRepeatAction}
          aria-label={repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat off'}
          aria-pressed={repeat !== 'none'}
          className={transportBtnClass}
          style={{ opacity: repeat === 'none' ? 0.4 : 1 }}
        >
          {repeat === 'one' ? <IconRepeatOne /> : <IconRepeatAll />}
        </button>
      </div>

      {/* VOLUME (hover-revealed slider) */}
      <div className="player-volume" onWheel={handleVolumeWheel}>
        <span className="player-volume-icon" aria-hidden="true">
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
          className="player-volume-slider"
          aria-label="Volume control"
        />
      </div>

      {/* FAR RIGHT: infinity, love, lyrics, cast */}
      <div className="player-far">
        <button
          onClick={toggleInfinityMode}
          aria-label={isInfinityMode ? 'Infinity Mode on' : 'Infinity Mode off'}
          aria-pressed={isInfinityMode}
          className={auxBtnClass}
          style={{
            opacity: isInfinityMode ? 1 : 0.55,
            color: isInfinityMode ? 'var(--color-primary)' : undefined,
            filter: isInfinityMode ? 'drop-shadow(0 0 6px var(--color-primary))' : 'none',
          }}
        >
          <Infinity size={18} strokeWidth={2} />
        </button>

        {currentTrack && (
          <LoveButton track={currentTrack} size={16} className={auxBtnClass} />
        )}

        {currentTrack && (
          <button
            onClick={() => setShowLyrics((v) => !v)}
            className={auxBtnClass}
            style={{ color: showLyrics ? 'var(--color-primary)' : undefined }}
            title="Lyrics"
            aria-label="Open lyrics"
            aria-pressed={showLyrics}
          >
            <FileText size={16} />
          </button>
        )}

        <CastButton showDeviceName={false} showIntro showStopAction={false} size="sm" />

        {showLyrics && currentTrack && (
          <div className="player-lyrics-popup">
            <LyricsPanel
              trackName={currentTrack.title || currentTrack.path.split(/[\\/]/).pop() || ''}
              artistName={currentTrack.artist || ''}
              isVisible={showLyrics}
              onClose={() => setShowLyrics(false)}
            />
          </div>
        )}
      </div>

      </div>
    </div>
  );
};

export default PlayerControls;
