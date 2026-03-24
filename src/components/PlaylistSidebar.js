import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import React from 'react';
import { Link } from 'react-router-dom';
import { usePlayerStore } from '../store';
import { GripVertical, MoreHorizontal, ChevronLeft, ChevronRight } from 'lucide-react';
import { parseArtists } from '../utils/artistUtils';
import { AlbumArt } from './AlbumArt';
import { formatTime } from '../utils/formatTime';
export const PlaylistSidebar = () => {
    const [draggingIndex, setDraggingIndex] = React.useState(null);
    const [dragOverIndex, setDragOverIndex] = React.useState(null);
    const playlist = usePlayerStore(state => state.playlist);
    const removeFromPlaylist = usePlayerStore(state => state.removeFromPlaylist);
    const moveInPlaylist = usePlayerStore(state => state.moveInPlaylist);
    const playAtIndex = usePlayerStore(state => state.playAtIndex);
    const currentIndex = usePlayerStore(state => state.currentIndex);
    const openContextMenu = usePlayerStore(state => state.openContextMenu);
    const isSidebarCollapsed = usePlayerStore(state => state.isSidebarCollapsed);
    const setIsSidebarCollapsed = usePlayerStore(state => state.setIsSidebarCollapsed);
    // Build artist name -> ID lookup from entity list
    const artists = usePlayerStore(state => state.artists);
    const getArtistLink = (artistName) => {
        const entity = artists.find((a) => a.name?.toLowerCase() === artistName.toLowerCase());
        return entity ? `/library/artist/${entity.id}` : null;
    };
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
    return (_jsx(_Fragment, { children: _jsx("div", { className: `${isSidebarCollapsed ? 'w-24' : 'w-96'} border-r border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-3xl flex flex-col h-full bg-opacity-80 transition-all duration-300 ease-in-out relative group/sidebar`, children: _jsx("div", { className: "flex-1 overflow-y-auto overflow-x-hidden hide-scrollbar", children: _jsxs("div", { className: `${isSidebarCollapsed ? 'px-2' : 'pl-4 pr-8'} py-2 mt-4 space-y-1`, children: [_jsx("div", { className: `flex items-center mb-4 ${isSidebarCollapsed ? 'justify-center' : 'justify-between px-2'}`, children: !isSidebarCollapsed ? (_jsxs(_Fragment, { children: [_jsxs("h3", { className: "text-xs font-bold text-[var(--color-text-secondary)] uppercase tracking-wider", children: ["Play Queue (", playlist.length, ")"] }), _jsx("button", { onClick: () => setIsSidebarCollapsed(true), className: "p-1.5 rounded-lg hover:bg-[var(--glass-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-all", title: "Collapse Queue", children: _jsx(ChevronRight, { size: 16 }) })] })) : (_jsx("button", { onClick: () => setIsSidebarCollapsed(false), className: "p-2 rounded-xl bg-[var(--glass-bg)] border border-[var(--glass-border)] hover:bg-[var(--glass-bg-hover)] text-[var(--color-primary)] transition-all shadow-sm flex items-center justify-center", title: `Expand Queue (${playlist.length})`, children: _jsx(ChevronLeft, { size: 20 }) })) }), _jsx("ul", { className: "playlist-list", children: playlist.map((t, idx) => (_jsxs("li", { draggable: true, onDragStart: (e) => handleDragStart(e, idx), onDragEnd: handleDragEnd, onDragEnter: (e) => handleDragEnter(e, idx), onDragOver: handleDragOver, onDrop: (e) => handleDrop(e, idx), onDoubleClick: () => playAtIndex(idx), className: `playlist-item group ${currentIndex === idx ? 'active' : ''} ${draggingIndex === idx ? 'dragging' : ''} ${isSidebarCollapsed ? 'justify-center p-2' : ''}`, style: {
                                    opacity: draggingIndex === idx ? 0.35 : (t.isInfinity && (currentIndex === null || idx > currentIndex)) ? 0.6 : 1,
                                    transition: 'opacity 0.15s ease, border-color 0.1s ease',
                                    borderTop: dragOverIndex === idx && draggingIndex !== idx
                                        ? '2px solid var(--color-primary)'
                                        : '2px solid transparent',
                                    boxShadow: dragOverIndex === idx && draggingIndex !== idx
                                        ? '0 -1px 0 0 var(--color-primary)'
                                        : 'none',
                                }, children: [!isSidebarCollapsed && (_jsx("span", { className: "shrink-0 cursor-grab active:cursor-grabbing text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 pl-1 pr-0.5 select-none", style: { fontSize: '1rem', lineHeight: 1 }, title: "Drag to reorder", children: _jsx(GripVertical, { size: 14 }) })), _jsx(AlbumArt, { artUrl: t.artUrl, artist: t.artist, size: isSidebarCollapsed ? 56 : 48, className: `playlist-item-art ${isSidebarCollapsed ? 'm-0' : ''}` }), !isSidebarCollapsed && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "playlist-item-info", children: [_jsx("div", { className: "playlist-item-title", children: t.title ?? t.path.split(/[\\\/]/).pop() }), t.artist && (_jsx("div", { className: "playlist-item-artist", children: parseArtists(t.artist).map((a, i) => {
                                                            const link = getArtistLink(a);
                                                            return (_jsxs(React.Fragment, { children: [i > 0 && ', ', link ? (_jsx(Link, { to: link, onClick: (e) => e.stopPropagation(), className: "hover:text-[var(--color-primary)] transition-colors no-underline text-inherit", children: a })) : (_jsx("span", { children: a }))] }, a));
                                                        }) })), t.duration !== undefined && _jsx("div", { className: "playlist-item-duration", children: formatTime(t.duration) })] }), _jsxs("div", { className: "flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity", children: [_jsx("button", { "aria-label": "More options", onClick: (e) => {
                                                            e.stopPropagation();
                                                            openContextMenu(t, e.clientX, e.clientY);
                                                        }, className: "player-control-btn hover:text-[var(--color-primary)]", style: { width: 28, height: 28, padding: 0, background: 'transparent', border: 'none', color: 'var(--color-text-muted)' }, children: _jsx(MoreHorizontal, { size: 16 }) }), _jsx("button", { "aria-label": `Remove track ${t.title ?? t.path}`, onClick: (e) => {
                                                            e.stopPropagation();
                                                            handleDelete(idx);
                                                        }, className: "player-control-btn hover:text-red-400", style: { width: 28, height: 28, padding: 0, fontSize: '0.8rem', background: 'transparent', border: 'none', color: 'var(--color-text-muted)' }, children: "\u2715" })] })] }))] }, t.id + idx))) })] }) }) }) }));
};
