import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../store';
import { Search as SearchIcon, X, Play, MoreHorizontal } from 'lucide-react';
import { AlbumArt } from './AlbumArt';
import { ArtistInitial } from './library/ArtistInitial';
export const GlobalSearch = () => {
    const library = usePlayerStore((state) => state.library);
    const artists = usePlayerStore((state) => state.artists);
    const albums = usePlayerStore((state) => state.albums);
    const setPlaylist = usePlayerStore((state) => state.setPlaylist);
    const openContextMenu = usePlayerStore((state) => state.openContextMenu);
    const navigate = useNavigate();
    const [isExpanded, setIsExpanded] = useState(false);
    const [query, setQuery] = useState('');
    const [dropdownStyle, setDropdownStyle] = useState({});
    const inputRef = useRef(null);
    const containerRef = useRef(null);
    const dropdownRef = useRef(null);
    // Expand search onClick
    const handleExpand = () => {
        setIsExpanded(true);
        setTimeout(() => inputRef.current?.focus(), 50);
    };
    // Close on outside click or escape
    useEffect(() => {
        const handleClickOutside = (e) => {
            const isOutsideContainer = containerRef.current && !containerRef.current.contains(e.target);
            const isOutsideDropdown = dropdownRef.current && !dropdownRef.current.contains(e.target);
            if (isOutsideContainer && isOutsideDropdown) {
                setIsExpanded(false);
            }
        };
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                setIsExpanded(false);
                inputRef.current?.blur();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, []);
    // Update portal position dynamically to anchor directly under the search pill
    useEffect(() => {
        if (!isExpanded || !containerRef.current)
            return;
        const updatePosition = () => {
            if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect();
                setDropdownStyle({
                    top: `${rect.bottom + 12}px`,
                    right: `${window.innerWidth - rect.right}px`
                });
            }
        };
        // Initial update and listeners
        updatePosition();
        window.addEventListener('resize', updatePosition);
        // Listen to parent container scrolling so the dropdown moves nicely if the pill scrolls
        const scrollParent = containerRef.current.closest('.overflow-x-auto');
        if (scrollParent) {
            scrollParent.addEventListener('scroll', updatePosition);
        }
        return () => {
            window.removeEventListener('resize', updatePosition);
            if (scrollParent) {
                scrollParent.removeEventListener('scroll', updatePosition);
            }
        };
    }, [isExpanded]);
    // Filter Logic
    const q = query.toLowerCase().trim();
    const hasQuery = q.length > 0;
    let matchedArtists = [];
    let matchedAlbums = [];
    let matchedTracks = [];
    if (hasQuery) {
        // Search artists from entity list
        matchedArtists = artists
            .filter((a) => a.name?.toLowerCase().includes(q))
            .slice(0, 5)
            .map((a) => ({ name: a.name, id: a.id }));
        // Search albums from entity list, resolving art from tracks
        const albumMatches = albums
            .filter((a) => a.title?.toLowerCase().includes(q) || a.artist_name?.toLowerCase().includes(q))
            .slice(0, 5);
        matchedAlbums = albumMatches.map((a) => {
            const track = library.find((t) => t.albumId === a.id);
            return {
                title: a.title,
                artist: a.artist_name || 'Unknown Artist',
                id: a.id,
                artUrl: track?.artUrl
            };
        });
        // Search tracks by title
        const tracksSet = new Set();
        library.forEach((track) => {
            if (track.title?.toLowerCase().includes(q) || track.path.toLowerCase().includes(q)) {
                if (!tracksSet.has(track.id)) {
                    matchedTracks.push(track);
                    tracksSet.add(track.id);
                }
            }
        });
        // Also add tracks where artist matches (but only if not already found by artist entity search)
        if (matchedArtists.length > 0) {
            const matchedArtistNames = new Set(matchedArtists.map((a) => a.name.toLowerCase()));
            library.forEach((track) => {
                if (tracksSet.has(track.id))
                    return;
                const tArtists = Array.isArray(track.artists) ? track.artists : [];
                if (tArtists.some(a => matchedArtistNames.has(a.toLowerCase()))) {
                    matchedTracks.push(track);
                    tracksSet.add(track.id);
                }
            });
        }
        matchedTracks = matchedTracks.slice(0, 10);
    }
    // Handlers
    const handleArtistClick = (artistId) => {
        navigate(`/library/artist/${artistId}`);
        setIsExpanded(false);
        setQuery('');
    };
    const handleAlbumClick = (albumId) => {
        navigate(`/library/album/${albumId}`);
        setIsExpanded(false);
        setQuery('');
    };
    const handleTrackPlay = (track) => {
        if (!track)
            return;
        setPlaylist([track], 0);
        setIsExpanded(false);
        setQuery('');
    };
    return (_jsxs("div", { ref: containerRef, className: "relative z-[60] flex items-center ml-auto", children: [_jsxs("div", { className: `
                flex items-center rounded-full border backdrop-blur-md transition-all duration-300 overflow-hidden
                ${isExpanded
                    ? 'w-64 sm:w-80 bg-[var(--glass-bg)] border-[var(--color-primary)] shadow-[0_0_12px_rgba(139,92,246,0.2)]'
                    : 'w-[104px] bg-black/5 dark:bg-white/[0.06] border-[var(--color-border)] hover:bg-black/10 dark:hover:bg-white/[0.12] hover:border-[var(--glass-border-hover)] cursor-pointer'}
            `, onClick: !isExpanded ? handleExpand : undefined, children: [_jsx("div", { className: "pl-4 pr-2 py-2 flex items-center justify-center text-[var(--color-text-secondary)]", children: _jsx(SearchIcon, { size: 16 }) }), isExpanded ? (_jsx("input", { ref: inputRef, type: "text", value: query, onChange: e => setQuery(e.target.value), placeholder: "Search library...", className: "flex-1 bg-transparent border-none outline-none text-sm text-[var(--color-text-primary)] py-2 pr-4 placeholder-[var(--color-text-muted)]" })) : (_jsx("span", { className: "text-sm font-semibold pr-4 text-[var(--color-text-secondary)] select-none", children: "Search" })), isExpanded && hasQuery && (_jsx("button", { onClick: () => setQuery(''), className: "pr-3 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]", children: _jsx(X, { size: 14 }) }))] }), isExpanded && hasQuery && createPortal(_jsxs("div", { ref: dropdownRef, style: dropdownStyle, className: "fixed w-[calc(100vw-2rem)] sm:w-[400px] max-h-[70vh] overflow-y-auto bg-[var(--glass-bg)] backdrop-blur-3xl border border-[var(--glass-border)] rounded-2xl shadow-[var(--shadow-2xl)] p-4 flex flex-col gap-6 animate-in fade-in slide-in-from-top-4 duration-200 z-[100]", children: [matchedArtists.length === 0 && matchedAlbums.length === 0 && matchedTracks.length === 0 && (_jsxs("div", { className: "text-center text-[var(--color-text-muted)] py-8 text-sm", children: ["No results found for \"", query, "\""] })), matchedArtists.length > 0 && (_jsxs("div", { className: "space-y-2", children: [_jsx("h4", { className: "text-xs font-bold tracking-wider uppercase text-[var(--color-text-muted)] mx-2", children: "Artists" }), _jsx("div", { className: "grid grid-cols-1 gap-1", children: matchedArtists.map(artist => (_jsxs("button", { onClick: () => handleArtistClick(artist.id), className: "flex items-center gap-3 w-full text-left p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors", children: [_jsx("div", { className: "w-10 h-10 rounded-full bg-[var(--color-primary)]/20 flex items-center justify-center flex-shrink-0 text-[var(--color-primary)] font-bold", children: _jsx(ArtistInitial, { name: artist.name, className: "text-base" }) }), _jsx("span", { className: "font-medium text-[var(--color-text-primary)] truncate", children: artist.name })] }, artist.id))) })] })), matchedAlbums.length > 0 && (_jsxs("div", { className: "space-y-2", children: [_jsx("h4", { className: "text-xs font-bold tracking-wider uppercase text-[var(--color-text-muted)] mx-2", children: "Albums" }), _jsx("div", { className: "grid grid-cols-1 gap-1", children: matchedAlbums.map(album => (_jsxs("button", { onClick: () => handleAlbumClick(album.id), className: "flex items-center gap-3 w-full text-left p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors", children: [album.artUrl ? (_jsx("img", { src: album.artUrl, className: "w-10 h-10 rounded-md object-cover shadow-sm flex-shrink-0", alt: "" })) : (_jsx("div", { className: "w-10 h-10 flex-shrink-0 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center", children: _jsx("span", { className: "text-[var(--color-text-muted)] text-[8px] uppercase", children: "No Art" }) })), _jsxs("div", { className: "flex flex-col overflow-hidden text-left flex-1 min-w-0", children: [_jsx("span", { className: "font-medium text-[var(--color-text-primary)] truncate", children: album.title }), _jsx("span", { className: "text-xs text-[var(--color-text-secondary)] truncate", children: album.artist })] })] }, album.id))) })] })), matchedTracks.length > 0 && (_jsxs("div", { className: "space-y-2", children: [_jsx("h4", { className: "text-xs font-bold tracking-wider uppercase text-[var(--color-text-muted)] mx-2", children: "Tracks" }), _jsx("div", { className: "grid grid-cols-1 gap-1", children: matchedTracks.map((track, i) => (_jsxs("div", { className: "group flex items-center gap-3 w-full text-left p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors", children: [_jsxs("div", { className: "relative w-10 h-10 flex-shrink-0 cursor-pointer", onClick: () => handleTrackPlay(track), children: [_jsx(AlbumArt, { artUrl: track.artUrl, artist: track.artist, size: 40, className: "w-full h-full rounded-md object-cover shadow-sm" }), _jsx("div", { className: "absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 rounded-md transition-opacity flex items-center justify-center", children: _jsx(Play, { size: 16, className: "text-white ml-0.5" }) })] }), _jsxs("div", { className: "flex flex-col flex-1 overflow-hidden min-w-0 text-left", children: [_jsx("span", { className: "font-medium text-[var(--color-text-primary)] truncate", children: track.title || track.path.split(/[\\/]/).pop() }), _jsx("span", { className: "text-xs text-[var(--color-text-secondary)] truncate", children: typeof track.artists === 'string' ? track.artists : track.artists?.join(', ') || track.artist || 'Unknown Artist' })] }), _jsx("button", { "aria-label": "More options", onClick: (e) => {
                                                e.stopPropagation();
                                                openContextMenu(track, e.clientX, e.clientY);
                                            }, className: "opacity-0 group-hover:opacity-100 p-2 text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition-all flex-shrink-0", children: _jsx(MoreHorizontal, { size: 16 }) })] }, track.id || i))) })] }))] }), document.body)] }));
};
