import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { usePlayerStore } from '../store/index';
import { playbackManager } from '../utils/PlaybackManager';
import { WaveformProgressBar } from './WaveformProgressBar';
import { formatTime } from '../utils/formatTime';
const ProgressBar = () => {
    const currentTime = usePlayerStore((state) => state.currentTime);
    const duration = usePlayerStore((state) => state.duration);
    const playlist = usePlayerStore((state) => state.playlist);
    const currentIndex = usePlayerStore((state) => state.currentIndex);
    const currentTrack = currentIndex !== null ? playlist[currentIndex] : null;
    // WMA files are transcoded on-the-fly — the browser cannot decode the raw stream
    // for waveform analysis, and duration will be Infinity. Use DB duration as fallback.
    const isTranscoded = currentTrack?.format?.toUpperCase().includes('WMA') ||
        currentTrack?.path?.toLowerCase().endsWith('.wma');
    const dbDuration = currentTrack?.duration; // duration in seconds from DB scan
    const displayDuration = (!isFinite(duration) || duration === 0) && dbDuration
        ? dbDuration
        : duration;
    const handleSeek = (time) => {
        playbackManager.seek(time);
    };
    return (_jsxs("div", { className: "progress-bar-container", children: [_jsx("span", { className: "progress-time", children: formatTime(currentTime) }), currentTrack?.url ? (_jsx(WaveformProgressBar, { audioUrl: currentTrack.url, currentTime: currentTime, duration: displayDuration, onSeek: handleSeek, dbDuration: dbDuration, allowWaveformDecode: !isTranscoded })) : (
            // Fallback plain bar if no URL
            _jsx("div", { className: "progress-track", onClick: (e) => {
                    if (!displayDuration)
                        return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    handleSeek((e.clientX - rect.left) / rect.width * displayDuration);
                }, children: _jsx("div", { className: "progress-fill", style: { width: `${displayDuration ? (currentTime / displayDuration) * 100 : 0}%` } }) })), _jsx("span", { className: "progress-time", children: formatTime(displayDuration) })] }));
};
export default ProgressBar;
