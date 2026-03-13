import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { usePlayerStore } from '../store/index';
import { playbackManager } from '../utils/PlaybackManager';
import { WaveformProgressBar } from './WaveformProgressBar';
const formatTime = (seconds) => {
    if (!isFinite(seconds) || seconds < 0)
        return '0:00';
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
    const handleSeek = (time) => {
        playbackManager.seek(time);
    };
    return (_jsxs("div", { className: "progress-bar-container", children: [_jsx("span", { className: "progress-time", children: formatTime(currentTime) }), currentTrack?.url ? (_jsx(WaveformProgressBar, { audioUrl: currentTrack.url, currentTime: currentTime, duration: duration, onSeek: handleSeek })) : (
            // Fallback plain bar if no URL
            _jsx("div", { className: "progress-track", onClick: (e) => {
                    if (!duration)
                        return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    handleSeek((e.clientX - rect.left) / rect.width * duration);
                }, children: _jsx("div", { className: "progress-fill", style: { width: `${duration ? (currentTime / duration) * 100 : 0}%` } }) })), _jsx("span", { className: "progress-time", children: formatTime(duration) })] }));
};
export default ProgressBar;
