import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../../store';
import { Play, Plus, ListPlus, Check } from 'lucide-react';
export const TrackContextMenu = () => {
    const { contextMenu, closeContextMenu, playlists, addTracksToUserPlaylist, playNext, setPlaylist } = usePlayerStore();
    const menuRef = useRef(null);
    const [addedStatus, setAddedStatus] = useState(null);
    useEffect(() => {
        if (contextMenu) {
            setAddedStatus(null);
        }
    }, [contextMenu]);
    useEffect(() => {
        const handleClickOutside = (e) => {
            if (menuRef.current && !menuRef.current.contains(e.target)) {
                closeContextMenu();
            }
        };
        if (contextMenu) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [contextMenu, closeContextMenu]);
    if (!contextMenu)
        return null;
    const { track, x, y } = contextMenu;
    // Keep menu within screen bounds
    const screenW = window.innerWidth;
    const screenH = window.innerHeight;
    const menuW = 220; // Approx max width
    const menuH = 300; // Approx max height
    let adjustedX = x;
    let adjustedY = y;
    if (x + menuW > screenW)
        adjustedX = screenW - menuW - 16;
    if (y + menuH > screenH)
        adjustedY = screenH - menuH - 16;
    const handlePlayNext = () => {
        playNext(track);
        setAddedStatus('Added to queue');
        setTimeout(() => closeContextMenu(), 1000);
    };
    const handleAddToPlaylist = (playlistId) => {
        addTracksToUserPlaylist(playlistId, [track.id]);
        setAddedStatus('Added to playlist');
        setTimeout(() => closeContextMenu(), 1000);
    };
    const handlePlayNow = () => {
        setPlaylist([track], 0);
        closeContextMenu();
    };
    return (_jsxs("div", { ref: menuRef, className: "fixed z-[9999] bg-[var(--glass-bg)] backdrop-blur-3xl border border-[var(--glass-border)] rounded-xl shadow-2xl py-2 w-56 flex flex-col overflow-hidden", style: { top: adjustedY, left: adjustedX }, onContextMenu: e => e.preventDefault(), children: [_jsxs("div", { className: "px-3 py-2 border-b border-[var(--glass-border)] mb-1", children: [_jsx("div", { className: "text-sm font-semibold text-[var(--color-text-primary)] truncate", children: track.title }), _jsx("div", { className: "text-xs text-[var(--color-text-muted)] truncate", children: track.artist })] }), addedStatus ? (_jsxs("div", { className: "p-4 flex items-center justify-center gap-2 text-[var(--color-primary)] text-sm font-medium", children: [_jsx(Check, { size: 16 }), addedStatus] })) : (_jsxs("div", { className: "overflow-y-auto max-h-64 hide-scrollbar", children: [_jsxs("button", { onClick: handlePlayNow, className: "w-full text-left px-4 py-2 text-sm text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--color-primary)] transition-colors flex items-center gap-3", children: [_jsx(Play, { size: 16 }), "Play Now"] }), _jsxs("button", { onClick: handlePlayNext, className: "w-full text-left px-4 py-2 text-sm text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--color-primary)] transition-colors flex items-center gap-3", children: [_jsx(Plus, { size: 16 }), "Play Next"] }), playlists.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: "h-px bg-[var(--glass-border)] my-1" }), _jsx("div", { className: "px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]", children: "Add to Playlist" }), playlists.map(pl => (_jsxs("button", { onClick: () => handleAddToPlaylist(pl.id), className: "w-full text-left px-4 py-2 text-sm text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--color-primary)] transition-colors flex items-center gap-3 truncate", children: [_jsx(ListPlus, { size: 16, className: "shrink-0" }), _jsx("span", { className: "truncate", children: pl.title })] }, pl.id)))] }))] }))] }));
};
