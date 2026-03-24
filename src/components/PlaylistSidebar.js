import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import React from 'react';
import { usePlayerStore } from '../store';
import { GripVertical, MoreHorizontal } from 'lucide-react';
import { parseArtists } from '../utils/artistUtils';
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
    const [dragOverIndex, setDragOverIndex] = React.useState(null);
    const playlist = usePlayerStore(state => state.playlist);
    const removeFromPlaylist = usePlayerStore(state => state.removeFromPlaylist);
    const moveInPlaylist = usePlayerStore(state => state.moveInPlaylist);
    const playAtIndex = usePlayerStore(state => state.playAtIndex);
    const currentIndex = usePlayerStore(state => state.currentIndex);
    const navigateView = usePlayerStore(state => state.navigateView);
    const currentView = usePlayerStore(state => state.currentView);
    const selectedItem = usePlayerStore(state => state.selectedItem);
    const openContextMenu = usePlayerStore(state => state.openContextMenu);
    const handleDragStart = (e, index) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', index.toString());
        setTimeout(() => setDraggingIndex(index), 0);
    };
    const handleDragEnd = () => {
        setDraggingIndex(null);
        setDragOverIndex(null);
    };
    const handleDragEnter = (e, index) => {
        e.preventDefault();
        setDragOverIndex(index);
    };
    const handleDragOver = (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    };
    const handleDrop = (e, toIndex) => {
        e.preventDefault();
        const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!isNaN(fromIndex) && fromIndex !== toIndex) {
            moveInPlaylist(fromIndex, toIndex);
        }
        setDraggingIndex(null);
        setDragOverIndex(null);
    };
    const handleDelete = (index) => {
        removeFromPlaylist(index);
    };
    return (_jsx(_Fragment, { children: _jsx("div", { className: "w-80 border-r border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-3xl flex flex-col h-full bg-opacity-80", children: _jsx("div", { className: "flex-1 overflow-y-auto overflow-x-hidden hide-scrollbar", children: _jsxs("div", { className: "pl-4 pr-8 py-2 mt-4 space-y-1", children: [_jsxs("h3", { className: "text-xs font-bold text-[var(--color-text-secondary)] px-4 mb-2 uppercase tracking-wider", children: ["Play Queue (", playlist.length, ")"] }), _jsx("ul", { className: "playlist-list", children: playlist.map((t, idx) => (_jsxs("li", { draggable: true, onDragStart: (e) => handleDragStart(e, idx), onDragEnd: handleDragEnd, onDragEnter: (e) => handleDragEnter(e, idx), onDragOver: handleDragOver, onDrop: (e) => handleDrop(e, idx), onDoubleClick: () => playAtIndex(idx), className: `playlist-item group ${currentIndex === idx ? 'active' : ''} ${draggingIndex === idx ? 'dragging' : ''}`, style: {
                                    opacity: draggingIndex === idx ? 0.35 : (t.isInfinity && (currentIndex === null || idx > currentIndex)) ? 0.6 : 1,
                                    transition: 'opacity 0.15s ease, border-color 0.1s ease',
                                    borderTop: dragOverIndex === idx && draggingIndex !== idx
                                        ? '2px solid var(--color-primary)'
                                        : '2px solid transparent',
                                    boxShadow: dragOverIndex === idx && draggingIndex !== idx
                                        ? '0 -1px 0 0 var(--color-primary)'
                                        : 'none',
                                }, children: [_jsx("span", { className: "shrink-0 cursor-grab active:cursor-grabbing text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 pl-1 pr-0.5 select-none", style: { fontSize: '1rem', lineHeight: 1 }, title: "Drag to reorder", children: _jsx(GripVertical, { size: 14 }) }), _jsx(AlbumArt, { artUrl: t.artUrl, artist: t.artist, size: 48, className: "playlist-item-art" }), _jsxs("div", { className: "playlist-item-info", children: [_jsx("div", { className: "playlist-item-title", children: t.title ?? t.path.split(/[\\\/]/).pop() }), t.artist && (_jsx("div", { className: "playlist-item-artist", children: parseArtists(t.artist).map((a, i) => (_jsxs(React.Fragment, { children: [i > 0 && ', ', _jsx("span", { className: "hover:text-[var(--color-primary)] cursor-pointer transition-colors", onClick: (e) => { e.stopPropagation(); navigateView('artist', a); }, children: a })] }, a))) })), t.duration !== undefined && _jsx("div", { className: "playlist-item-duration", children: formatTime(t.duration) })] }), _jsxs("div", { className: "flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity", children: [_jsx("button", { "aria-label": "More options", onClick: (e) => {
                                                    e.stopPropagation();
                                                    openContextMenu(t, e.clientX, e.clientY);
                                                }, className: "player-control-btn hover:text-[var(--color-primary)]", style: { width: 28, height: 28, padding: 0, background: 'transparent', border: 'none', color: 'var(--color-text-muted)' }, children: _jsx(MoreHorizontal, { size: 16 }) }), _jsx("button", { "aria-label": `Remove track ${t.title ?? t.path}`, onClick: (e) => {
                                                    e.stopPropagation();
                                                    handleDelete(idx);
                                                }, className: "player-control-btn hover:text-red-400", style: { width: 28, height: 28, padding: 0, fontSize: '0.8rem', background: 'transparent', border: 'none', color: 'var(--color-text-muted)' }, children: "\u2715" })] })] }, t.id + idx))) })] }) }) }) }));
};
