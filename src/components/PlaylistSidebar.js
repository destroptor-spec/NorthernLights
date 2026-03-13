import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useState } from 'react';
import { usePlayerStore } from '../store/index';
import { parseArtists } from '../utils/artistUtils';
import { SettingsModal } from './SettingsModal';
import { AlbumArt } from './AlbumArt';
const formatTime = (seconds) => {
    if (seconds === undefined || !isFinite(seconds) || seconds < 0)
        return '';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
};
export const PlaylistSidebar = () => {
    const [draggingIndex, setDraggingIndex] = React.useState(null);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const handleDragStart = (e, index) => {
        e.dataTransfer.setData('text/plain', index.toString());
        setDraggingIndex(index);
    };
    const handleDragEnd = () => {
        setDraggingIndex(null);
    };
    const handleDragOver = (e) => {
        e.preventDefault();
    };
    const handleDrop = (e) => {
        const fromIndexStr = e.dataTransfer.getData('text/plain');
        if (!fromIndexStr)
            return;
        const toIndex = Array.from(e.currentTarget.children).indexOf(e.target);
        if (toIndex >= 0) {
            moveInPlaylist(parseInt(fromIndexStr), toIndex);
        }
        setDraggingIndex(null);
    };
    const playlist = usePlayerStore(state => state.playlist);
    const removeFromPlaylist = usePlayerStore(state => state.removeFromPlaylist);
    const moveInPlaylist = usePlayerStore(state => state.moveInPlaylist);
    const playAtIndex = usePlayerStore(state => state.playAtIndex);
    const currentIndex = usePlayerStore(state => state.currentIndex);
    const navigateView = usePlayerStore(state => state.navigateView);
    const handleDelete = (index, title) => {
        if (window.confirm(`Remove track ${title ?? 'Unknown'} from playlist?`)) {
            removeFromPlaylist(index);
        }
    };
    return (_jsxs(_Fragment, { children: [_jsxs("aside", { className: "playlist-sidebar", children: [_jsxs("div", { className: "playlist-header", children: [_jsxs("span", { children: ["Play Queue (", playlist.length, ")"] }), _jsx("button", { className: "icon-btn", onClick: () => setIsSettingsOpen(true), title: "Library Settings", children: _jsxs("svg", { width: "18", height: "18", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", children: [_jsx("circle", { cx: "12", cy: "12", r: "3" }), _jsx("path", { d: "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" })] }) })] }), _jsx("ul", { className: "playlist-list", "data-dragging-index": draggingIndex ?? undefined, onDragOver: handleDragOver, onDrop: handleDrop, children: playlist.map((t, idx) => (_jsxs("li", { className: `playlist-item ${currentIndex === idx ? 'active' : ''} ${draggingIndex === idx ? 'dragging' : ''}`, draggable: true, onDragStart: (e) => handleDragStart(e, idx), onDragEnd: handleDragEnd, onDoubleClick: () => playAtIndex(idx), children: [_jsx(AlbumArt, { artUrl: t.artUrl, artist: t.artist, size: 48, className: "playlist-item-art" }), _jsxs("div", { className: "playlist-item-info", children: [_jsx("div", { className: "playlist-item-title", children: t.title ?? t.path.split(/[\\/]/).pop() }), t.artist && (_jsx("div", { className: "playlist-item-artist", children: parseArtists(t.artist).map((a, i) => (_jsxs(React.Fragment, { children: [i > 0 && ', ', _jsx("span", { className: "hover:text-[var(--color-primary)] cursor-pointer transition-colors", onClick: (e) => { e.stopPropagation(); navigateView('artist', a); }, children: a })] }, a))) })), t.duration !== undefined && _jsx("div", { className: "playlist-item-duration", children: formatTime(t.duration) })] }), _jsx("button", { "aria-label": `Remove track ${t.title ?? t.path}`, onClick: (e) => {
                                        e.stopPropagation();
                                        handleDelete(idx, t.title);
                                    }, onKeyDown: (e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            handleDelete(idx, t.title);
                                        }
                                    }, className: "player-control-btn", style: { width: 28, height: 28, padding: 0, fontSize: '0.8rem', background: 'transparent', border: 'none', color: 'var(--color-text-muted)' }, children: "\u2715" })] }, t.id + idx))) })] }), isSettingsOpen && (_jsx(SettingsModal, { onClose: () => setIsSettingsOpen(false) }))] }));
};
