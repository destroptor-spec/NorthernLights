import React, { useEffect, useRef, useState } from 'react';
import { usePlayerStore } from '../../store';
import { Play, Plus, ListPlus, Check } from 'lucide-react';

export const TrackContextMenu: React.FC = () => {
    const { contextMenu, closeContextMenu, playlists, addTracksToUserPlaylist, playNext, setPlaylist } = usePlayerStore();
    const menuRef = useRef<HTMLDivElement>(null);
    const [addedStatus, setAddedStatus] = useState<string | null>(null);

    useEffect(() => {
        if (contextMenu) {
            setAddedStatus(null);
        }
    }, [contextMenu]);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                closeContextMenu();
            }
        };

        if (contextMenu) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [contextMenu, closeContextMenu]);

    if (!contextMenu) return null;

    const { track, x, y } = contextMenu;

    // Keep menu within screen bounds
    const screenW = window.innerWidth;
    const screenH = window.innerHeight;
    const menuW = 220; // Approx max width
    const menuH = 300; // Approx max height
    
    let adjustedX = x;
    let adjustedY = y;

    if (x + menuW > screenW) adjustedX = screenW - menuW - 16;
    if (y + menuH > screenH) adjustedY = screenH - menuH - 16;

    const handlePlayNext = () => {
        playNext(track);
        setAddedStatus('Added to queue');
        setTimeout(() => closeContextMenu(), 1000);
    };

    const handleAddToPlaylist = (playlistId: string) => {
        addTracksToUserPlaylist(playlistId, [track.id]);
        setAddedStatus('Added to playlist');
        setTimeout(() => closeContextMenu(), 1000);
    };

    const handlePlayNow = () => {
        setPlaylist([track], 0);
        closeContextMenu();
    };

    return (
        <div 
            ref={menuRef}
            className="fixed z-[9999] bg-[var(--glass-bg)] backdrop-blur-3xl border border-[var(--glass-border)] rounded-xl shadow-2xl py-2 w-56 flex flex-col overflow-hidden"
            style={{ top: adjustedY, left: adjustedX }}
            onContextMenu={e => e.preventDefault()}
        >
            <div className="px-3 py-2 border-b border-[var(--glass-border)] mb-1">
                <div className="text-sm font-semibold text-[var(--color-text-primary)] truncate">{track.title}</div>
                <div className="text-xs text-[var(--color-text-muted)] truncate">{track.artist}</div>
            </div>

            {addedStatus ? (
                <div className="p-4 flex items-center justify-center gap-2 text-[var(--color-primary)] text-sm font-medium">
                    <Check size={16} />
                    {addedStatus}
                </div>
            ) : (
                <div className="overflow-y-auto max-h-64 hide-scrollbar">
                    <button 
                        onClick={handlePlayNow}
                        className="w-full text-left px-4 py-2 text-sm text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--color-primary)] transition-colors flex items-center gap-3"
                    >
                        <Play size={16} />
                        Play Now
                    </button>
                    <button 
                        onClick={handlePlayNext}
                        className="w-full text-left px-4 py-2 text-sm text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--color-primary)] transition-colors flex items-center gap-3"
                    >
                        <Plus size={16} />
                        Play Next
                    </button>

                    {playlists.length > 0 && (
                        <>
                            <div className="h-px bg-[var(--glass-border)] my-1" />
                            <div className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                                Add to Playlist
                            </div>
                            {playlists.map(pl => (
                                <button
                                    key={pl.id}
                                    onClick={() => handleAddToPlaylist(pl.id)}
                                    className="w-full text-left px-4 py-2 text-sm text-[var(--color-text-primary)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--color-primary)] transition-colors flex items-center gap-3 truncate"
                                >
                                    <ListPlus size={16} className="shrink-0" />
                                    <span className="truncate">{pl.title}</span>
                                </button>
                            ))}
                        </>
                    )}
                </div>
            )}
        </div>
    );
};
