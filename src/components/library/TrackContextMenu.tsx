import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../../store';
import type { TrackCredit } from '../../store';
import {
    Play, Plus, ListPlus, Check,
    ChevronRight, ChevronLeft,
    Search, X, Disc3, Mic2, ListMinus,
    Heart, Users, ListX,
} from 'lucide-react';
import {
    ContextMenuButton,
    ContextMenuDivider,
    ContextMenuFrame,
    ContextMenuHeader,
    ContextMenuList,
    useIsMobile,
} from '../ContextMenu';
import { useRemoveFromQueueWithUndo } from '../QueueList';

// ─── helpers ──────────────────────────────────────────────────────────────────

// Normalise track.artists → string[]
function getArtistNames(track: any): string[] {
    if (Array.isArray(track.artists) && track.artists.length > 0) return track.artists;
    if (typeof track.artists === 'string' && track.artists.trim()) {
        try { return JSON.parse(track.artists); } catch { return [track.artists]; }
    }
    if (track.artist) return [track.artist];
    return [];
}

// ─── Navigation stack hook ────────────────────────────────────────────────────
// `stack` is a list of panel IDs; empty means "main" is shown.
// push / pop are the only mutations; each sub-panel just calls pop() to go back.

function useMenuNav() {
    const [stack, setStack] = useState<string[]>([]);
    const push  = useCallback((id: string) => setStack(s => [...s, id]), []);
    const pop   = useCallback(() => setStack(s => s.slice(0, -1)), []);
    const reset = useCallback(() => setStack([]), []);
    const current = stack[stack.length - 1] ?? null; // null → main visible
    return { stack, current, push, pop, reset };
}

// ─── Generic filterable-list sub-panel ───────────────────────────────────────
// Self-contained: owns its filter input ref and state.
// isActive = this panel is the top of the stack (fully visible).
// isPast   = this panel is in the stack but not on top (hidden behind next panel).

interface FilterableListPanelProps {
    title: string;
    placeholder: string;
    items: { id: string; label: string; icon?: React.ReactNode }[];
    onSelect: (id: string, label: string) => void;
    onBack: () => void;
    isActive: boolean;
    isMobile: boolean;
    emptyText?: string;
}

const FilterableListPanel: React.FC<FilterableListPanelProps> = ({
    title, placeholder, items, onSelect, onBack, isActive, isMobile, emptyText = 'No results',
}) => {
    const [filter, setFilter] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    // Reset filter whenever this panel becomes active
    useEffect(() => {
        if (isActive) {
            setFilter('');
            setTimeout(() => inputRef.current?.focus(), 140);
        }
    }, [isActive]);

    const filtered = items.filter(i =>
        i.label.toLowerCase().includes(filter.toLowerCase().trim())
    );

    return (
        <div
            className="absolute inset-0 flex flex-col bg-[var(--glass-bg)]"
            style={{
                transform: isActive ? 'translateX(0)' : 'translateX(100%)',
                transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1)',
                // Keep panel in DOM so transition plays nicely; it's visually hidden when off-screen
                pointerEvents: isActive ? 'auto' : 'none',
            }}
        >
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--glass-border)] flex-shrink-0">
                <button
                    onClick={onBack}
                    className="p-1 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors active:scale-90"
                    aria-label="Back"
                >
                    <ChevronLeft size={18} />
                </button>
                <span className="text-sm font-semibold text-[var(--color-text-primary)] flex-1 truncate">
                    {title}
                </span>
            </div>

            {/* Filter */}
            <div className="px-3 py-2 border-b border-[var(--glass-border)] flex-shrink-0">
                <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 bg-black/10 dark:bg-white/5 border border-[var(--color-border)]">
                    <Search size={13} className="text-[var(--color-text-muted)] flex-shrink-0" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        placeholder={placeholder}
                        className="flex-1 bg-transparent border-none outline-none text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)]"
                    />
                    {filter && (
                        <button
                            onClick={() => setFilter('')}
                            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] active:scale-90 transition-ui"
                        >
                            <X size={12} />
                        </button>
                    )}
                </div>
            </div>

            {/* List */}
            <div className="overflow-y-auto flex-1 py-1.5" style={{ maxHeight: isMobile ? '60vh' : '260px' }}>
                {filtered.length === 0 ? (
                    <div className="text-center text-[var(--color-text-muted)] text-xs py-6">{emptyText}</div>
                ) : (
                    filtered.map(item => (
                        <button
                            key={item.id}
                            onClick={() => onSelect(item.id, item.label)}
                            className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[var(--color-text-primary)] hover:bg-white/5 active:bg-white/10 transition-colors text-left"
                        >
                            {item.icon && (
                                <span className="text-[var(--color-text-secondary)] flex-shrink-0">
                                    {item.icon}
                                </span>
                            )}
                            <span className="truncate">{item.label}</span>
                        </button>
                    ))
                )}
            </div>
        </div>
    );
};

// ─── Credits sub-panel ────────────────────────────────────────────────────────
// Role-grouped view of every credit on a single track. Same slide-in
// shell as FilterableListPanel but no filter input — credit lists are
// short by nature and grouping matters more than search.

const CREDITS_ROLE_ORDER = [
    'performer', 'composer', 'conductor', 'lyricist', 'producer', 'remixer',
    'arranger', 'engineer', 'mixer', 'dj-mixer', 'writer', 'original-artist',
] as const;

interface CreditsPanelProps {
    isActive: boolean;
    isMobile: boolean;
    loading: boolean;
    credits: TrackCredit[];
    onBack: () => void;
    onSelectArtist: (artistId: string) => void;
}

const CreditsPanel: React.FC<CreditsPanelProps> = ({ isActive, isMobile, loading, credits, onBack, onSelectArtist }) => {
    const grouped = React.useMemo(() => {
        const byRole = new Map<string, TrackCredit[]>();
        for (const c of credits) {
            const arr = byRole.get(c.role) || [];
            arr.push(c);
            byRole.set(c.role, arr);
        }
        const ordered: Array<{ role: string; credits: TrackCredit[] }> = [];
        for (const role of CREDITS_ROLE_ORDER) {
            const arr = byRole.get(role);
            if (arr && arr.length > 0) ordered.push({ role, credits: arr });
        }
        for (const [role, arr] of byRole) {
            if ((CREDITS_ROLE_ORDER as readonly string[]).includes(role)) continue;
            ordered.push({ role, credits: arr });
        }
        return ordered;
    }, [credits]);

    return (
        <div
            className="absolute inset-0 flex flex-col bg-[var(--glass-bg)]"
            style={{
                transform: isActive ? 'translateX(0)' : 'translateX(100%)',
                transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1)',
                pointerEvents: isActive ? 'auto' : 'none',
            }}
        >
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--glass-border)] flex-shrink-0">
                <button
                    onClick={onBack}
                    className="p-1 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors active:scale-90"
                    aria-label="Back"
                >
                    <ChevronLeft size={18} />
                </button>
                <span className="text-sm font-semibold text-[var(--color-text-primary)] flex-1 truncate">credits</span>
            </div>

            <div className="overflow-y-auto flex-1 py-1.5" style={{ maxHeight: isMobile ? '60vh' : '300px' }}>
                {loading ? (
                    <div className="text-center text-[var(--color-text-muted)] text-xs py-6">Loading…</div>
                ) : grouped.length === 0 ? (
                    <div className="text-center text-[var(--color-text-muted)] text-xs py-6">No credits on this track.</div>
                ) : (
                    grouped.map(group => (
                        <div key={group.role} className="mb-2">
                            <div className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--color-text-muted)]">
                                {group.role}
                            </div>
                            {group.credits.map((c, i) => (
                                <button
                                    key={`${c.artistId}-${i}`}
                                    onClick={() => onSelectArtist(c.artistId)}
                                    className="w-full flex items-center gap-3 px-4 py-2 text-sm text-[var(--color-text-primary)] hover:bg-white/5 active:bg-white/10 transition-colors text-left"
                                >
                                    <Mic2 size={14} className="text-[var(--color-text-secondary)] flex-shrink-0" />
                                    <span className="truncate flex-1">
                                        {c.artistName}
                                        {c.detail && (
                                            <span className="text-[var(--color-text-muted)]"> — {c.detail}</span>
                                        )}
                                    </span>
                                </button>
                            ))}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
};

// ─── Main component ───────────────────────────────────────────────────────────

export const TrackContextMenu: React.FC = () => {
    const {
        contextMenu, closeContextMenu,
        playlists, artists: artistEntities,
        addTracksToUserPlaylist, replaceTracksInUserPlaylist,
        addTrackToPlaylist, playNext, setPlaylist, toggleTrackLove,
    } = usePlayerStore();

    const navigate  = useNavigate();
    const menuRef   = useRef<HTMLDivElement>(null);
    const isMobile  = useIsMobile();
    const nav       = useMenuNav();

    const [addedStatus, setAddedStatus] = useState<string | null>(null);
    const [isVisible,   setIsVisible]   = useState(false);
    // Lazily-loaded credits for the focused track. The sub-panel opens on
    // demand and fetches on first activation so the cold context-menu
    // render stays as cheap as it is today.
    const [trackCredits, setTrackCredits] = useState<TrackCredit[]>([]);
    const [creditsLoading, setCreditsLoading] = useState(false);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const removeFromQueue = useRemoveFromQueueWithUndo();
    // The track that plays is skipped, not removed, so its menu has no Remove.
    const playingEntryId = usePlayerStore(state => state.currentIndex !== null ? state.playlist[state.currentIndex]?.queueEntryId : undefined);

    // ── open/close lifecycle ──────────────────────────────────────────────────
    useEffect(() => {
        if (contextMenu) {
            setAddedStatus(null);
            nav.reset();
            setTrackCredits([]);
            requestAnimationFrame(() => setIsVisible(true));
        } else {
            setIsVisible(false);
        }
    }, [contextMenu]); // eslint-disable-line react-hooks/exhaustive-deps

    // Fetch credits only when the credits sub-panel is opened. One request
    // per credits-panel visit per menu instance — sufficient given the
    // menu's short lifecycle and the per-track scope.
    useEffect(() => {
        if (nav.current !== 'credits') return;
        if (!contextMenu) return;
        const trackId = contextMenu.track.id;
        if (!trackId) return;
        let cancelled = false;
        setCreditsLoading(true);
        fetch(`/api/albums/track/${encodeURIComponent(trackId)}/credits`, { headers: getAuthHeader() })
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (!cancelled) setTrackCredits(Array.isArray(data?.credits) ? data.credits : []);
            })
            .catch(() => { if (!cancelled) setTrackCredits([]); })
            .finally(() => { if (!cancelled) setCreditsLoading(false); });
        return () => { cancelled = true; };
    }, [nav.current, contextMenu, getAuthHeader]);

    // ── Escape: pop panel or close ────────────────────────────────────────────
    useEffect(() => {
        if (!contextMenu) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            if (nav.current) nav.pop();
            else closeContextMenu();
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [contextMenu, nav, closeContextMenu]);

    // ── desktop: click outside closes ────────────────────────────────────────
    useEffect(() => {
        if (!contextMenu || isMobile) return;
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                closeContextMenu();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [contextMenu, isMobile, closeContextMenu]);

    if (!contextMenu) return null;
    const { track, x, y, playlistId: contextPlaylistId, playlistTrackIndex, queueEntryId } = contextMenu;

    // ── desktop position ──────────────────────────────────────────────────────
    const menuW = 248, menuH = 340;
    const posX = Math.min(x, window.innerWidth  - menuW - 16);
    const posY = Math.min(y, window.innerHeight - menuH - 16);

    // ── derived data ──────────────────────────────────────────────────────────
    const artistNames    = getArtistNames(track);
    const multiArtist    = artistNames.length > 1;

    const resolveArtistId = (name: string) =>
        artistEntities.find((a: any) => a.name?.toLowerCase() === name.toLowerCase())?.id ?? null;

    // ── actions ───────────────────────────────────────────────────────────────
    const done = (msg: string) => {
        nav.reset();
        setAddedStatus(msg);
        setTimeout(() => closeContextMenu(), 900);
    };

    const handlePlayNow  = () => { setPlaylist([track], 0); closeContextMenu(); };
    const handlePlayNext = () => {
        playNext(track, { notify: true, undo: true });
        done('Queued next');
    };
    const handleAddToQueue = () => {
        addTrackToPlaylist(track, { notify: true, undo: true });
        done('Added to queue');
    };
    const handleToggleLove = async () => {
        try {
            await toggleTrackLove(track);
            done(track.isLoved ? 'Removed like' : 'Liked track');
        } catch {
            setAddedStatus(null);
        }
    };

    const handleAddToPlaylist = async (playlistId: string) => {
        try { await addTracksToUserPlaylist(playlistId, [track.id]); done('Added to playlist'); }
        catch { setAddedStatus(null); }
    };

    const handleRemoveFromPlaylist = async () => {
        if (!contextPlaylistId || playlistTrackIndex === undefined) return;
        const pl = playlists.find(p => p.id === contextPlaylistId);
        if (!pl) return;
        const nextTrackIds = pl.tracks
            .filter((_, i) => i !== playlistTrackIndex)
            .map(t => t.id);
        try {
            await replaceTracksInUserPlaylist(contextPlaylistId, nextTrackIds);
            done('Removed from playlist');
        } catch { setAddedStatus(null); }
    };

    const handleGoToAlbum = () => {
        if (track.albumId) navigate(`/library/album/${track.albumId}`);
        closeContextMenu();
    };

    const handleGoToArtist = (name: string) => {
        const id = resolveArtistId(name);
        if (id) navigate(`/library/artist/${id}`);
        closeContextMenu();
    };

    // ── panel item lists ──────────────────────────────────────────────────────
    const playlistItems = playlists.map(pl => ({
        id: pl.id,
        label: pl.title,
        icon: <ListPlus size={14} />,
    }));

    const artistItems = artistNames.map(name => ({
        id: name,
        label: name,
        icon: <Mic2 size={14} />,
    }));

    // ── Whether any sub-panel is open (main slides left) ─────────────────────
    const subPanelOpen = nav.current !== null;

    // ── inner shell — contains main + all sub-panels stacked absolutely ───────
    const inner = (
        <ContextMenuFrame
            ref={menuRef}
            isMobile={isMobile}
        >
            {/* ── MAIN PANEL ── fades out when a sub-panel is active ───────── */}
            <div
                style={{
                    transition: 'opacity 0.2s',
                    opacity:   subPanelOpen ? 0 : 1,
                    pointerEvents: subPanelOpen ? 'none' : 'auto',
                }}
            >
                {/* Track header */}
                <ContextMenuHeader
                    title={track.title}
                    subtitle={artistNames.join(', ') || track.artist}
                />

                {addedStatus ? (
                    <div className="p-5 flex items-center justify-center gap-2 text-[var(--color-primary)] text-sm font-medium">
                        <Check size={16} /> {addedStatus}
                    </div>
                ) : (
                    <ContextMenuList>
                        <ContextMenuButton icon={<Play size={15} />} label="Play Now"  onClick={handlePlayNow}  />
                        <ContextMenuButton icon={<Plus size={15} />} label="Play Next" onClick={handlePlayNext} />
                        <ContextMenuButton icon={<ListPlus size={15} />} label="Add to Queue" onClick={handleAddToQueue} />
                        <ContextMenuButton
                            icon={<Heart size={15} fill={track.isLoved ? 'currentColor' : 'none'} />}
                            label={track.isLoved ? 'Unlike' : 'Like'}
                            onClick={() => void handleToggleLove()}
                        />

                        {/* Go to Album */}
                        {track.albumId && (
                            <>
                                <ContextMenuDivider />
                                <ContextMenuButton icon={<Disc3 size={15} />} label="Go to Album" onClick={handleGoToAlbum} />
                            </>
                        )}

                        {/* Go to Artist — direct if single, sub-panel if multiple */}
                        {artistNames.length === 1 && (
                            <ContextMenuButton
                                icon={<Mic2 size={15} />}
                                label="Go to Artist"
                                onClick={() => handleGoToArtist(artistNames[0])}
                            />
                        )}
                        {multiArtist && (
                            <ContextMenuButton
                                icon={<Mic2 size={15} />}
                                label="Go to Artist"
                                onClick={() => nav.push('artists')}
                                trailingIcon={<ChevronRight size={15} />}
                            />
                        )}

                        {/* View credits — opens a role-grouped sub-panel.
                            Always offered; the panel itself says "no credits"
                            when the track has none rather than us probing
                            ahead of time. */}
                        <ContextMenuButton
                            icon={<Users size={15} />}
                            label="View Credits"
                            onClick={() => nav.push('credits')}
                            trailingIcon={<ChevronRight size={15} />}
                        />

                        {/* Add to Playlist */}
                        {playlists.length > 0 && (
                            <>
                                <ContextMenuDivider />
                                <ContextMenuButton
                                    icon={<ListPlus size={15} />}
                                    label="Add to Playlist"
                                    onClick={() => nav.push('playlists')}
                                    trailingIcon={<ChevronRight size={15} />}
                                />
                            </>
                        )}

                        {/* Remove from queue — only when opened on a queue row that isn't playing */}
                        {queueEntryId && queueEntryId !== playingEntryId && (
                            <>
                                <ContextMenuDivider />
                                <ContextMenuButton
                                    icon={<ListX size={15} />}
                                    label="Remove from Queue"
                                    onClick={() => { closeContextMenu(); removeFromQueue(queueEntryId); }}
                                    danger
                                />
                            </>
                        )}

                        {/* Remove from Playlist — only when opened from within a playlist */}
                        {contextPlaylistId && playlistTrackIndex !== undefined && (
                            <>
                                <ContextMenuDivider />
                                <ContextMenuButton
                                    icon={<ListMinus size={15} />}
                                    label="Remove from Playlist"
                                    onClick={() => void handleRemoveFromPlaylist()}
                                    danger
                                />
                            </>
                        )}
                    </ContextMenuList>
                )}
            </div>

            {/* ── SUB-PANELS — absolutely overlaid, each slides in independently ── */}

            <FilterableListPanel
                title="Add to Playlist"
                placeholder="Filter playlists…"
                items={playlistItems}
                onSelect={(id) => void handleAddToPlaylist(id)}
                onBack={nav.pop}
                isActive={nav.current === 'playlists'}
                isMobile={isMobile}
                emptyText="No playlists found"
            />

            <FilterableListPanel
                title="Go to Artist"
                placeholder="Filter artists…"
                items={artistItems}
                onSelect={(_id, label) => handleGoToArtist(label)}
                onBack={nav.pop}
                isActive={nav.current === 'artists'}
                isMobile={isMobile}
                emptyText="No artists found"
            />

            <CreditsPanel
                isActive={nav.current === 'credits'}
                isMobile={isMobile}
                loading={creditsLoading}
                credits={trackCredits}
                onBack={nav.pop}
                onSelectArtist={(artistId) => {
                    navigate(`/library/artist/${artistId}`);
                    closeContextMenu();
                }}
            />

            {/*
             * ── Adding a new sub-panel in the future is this simple: ───────────
             *
             * <FilterableListPanel
             *     title="My New Panel"
             *     placeholder="Filter…"
             *     items={myItems}
             *     onSelect={(id) => handleMyAction(id)}
             *     onBack={nav.pop}
             *     isActive={nav.current === 'my-panel'}
             *     isMobile={isMobile}
             * />
             *
             * Then add a MenuButton in the main panel:
             *     <MenuButton ... onClick={() => nav.push('my-panel')} trailingIcon={<ChevronRight size={15} />} />
             */}
        </ContextMenuFrame>
    );

    // ── MOBILE: bottom-sheet ──────────────────────────────────────────────────
    if (isMobile) {
        return createPortal(
            <>
                <div
                    className="fixed inset-0 z-[9998] transition-opacity duration-200"
                    style={{
                        background: 'rgba(0,0,0,0.55)',
                        opacity: isVisible ? 1 : 0,
                        backdropFilter: 'blur(4px)',
                        WebkitBackdropFilter: 'blur(4px)',
                    }}
                    onClick={closeContextMenu}
                />
                <div
                    className="fixed bottom-0 left-0 right-0 z-[9999] transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
                    style={{ transform: isVisible ? 'translateY(0)' : 'translateY(100%)' }}
                >
                    {inner}
                    <div className="h-[env(safe-area-inset-bottom,0px)] bg-[var(--glass-bg)] border-x border-[var(--glass-border)]" />
                </div>
            </>,
            document.body
        );
    }

    // ── DESKTOP: positioned dropdown ──────────────────────────────────────────
    return createPortal(
        <div
            className="fixed z-[9999]"
            style={{
                top: posY, left: posX,
                opacity: isVisible ? 1 : 0,
                transform: isVisible ? 'scale(1) translateY(0)' : 'scale(0.95) translateY(-4px)',
                transition: 'opacity 0.15s, transform 0.15s',
                transformOrigin: 'top left',
            }}
        >
            {inner}
        </div>,
        document.body
    );
};
