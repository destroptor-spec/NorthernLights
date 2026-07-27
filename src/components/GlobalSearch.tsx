import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../store';
import { Search as SearchIcon, X, Play, MoreHorizontal, ArrowLeft } from 'lucide-react';
import { TrackInfo } from '../utils/fileSystem';
import { AlbumArt } from './AlbumArt';
import { ArtistInitial } from './library/ArtistInitial';
import { LoveButton } from './LoveButton';
import { useKnownArtistKeys } from '../hooks/useKnownArtistKeys';
import { buildArtistLinkMap, getTrackArtistDisplayNames, resolveArtistLink, resolveTrackArtistLink } from '../utils/artistLinks';

// ─── helpers ─────────────────────────────────────────────────────────────────

function useIsMobile(breakpoint = 640) {
    const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint);
    useEffect(() => {
        const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
        const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [breakpoint]);
    return isMobile;
}

// ─── shared result-list subcomponent ─────────────────────────────────────────

interface ResultsProps {
    query: string;
    matchedArtists: { name: string; id: string }[];
    matchedAlbums: { title: string; artist: string; id: string; artUrl?: string }[];
    matchedTracks: TrackInfo[];
    onArtistClick: (id: string) => void;
    onAlbumClick: (id: string) => void;
    onTrackPlay: (track: TrackInfo) => void;
    onTrackOpen: (track: TrackInfo) => void;
    artistLinkMap: ReadonlyMap<string, string>;
    knownArtistKeys: Set<string>;
    onNavigate: () => void;
    openContextMenu: (track: TrackInfo, x: number, y: number) => void;
}

interface SearchMatches {
    matchedArtists: { name: string; id: string }[];
    matchedAlbums: { title: string; artist: string; id: string; artUrl?: string }[];
    matchedTracks: TrackInfo[];
}

const EMPTY_SEARCH_MATCHES: SearchMatches = {
    matchedArtists: [],
    matchedAlbums: [],
    matchedTracks: [],
};

const SearchResults = React.memo(function SearchResults({
    query,
    matchedArtists,
    matchedAlbums,
    matchedTracks,
    onArtistClick,
    onAlbumClick,
    onTrackPlay,
    onTrackOpen,
    artistLinkMap,
    knownArtistKeys,
    onNavigate,
    openContextMenu,
}: ResultsProps) {
    const noResults =
        matchedArtists.length === 0 && matchedAlbums.length === 0 && matchedTracks.length === 0;

    return (
        <div className="global-search-results-list flex flex-col gap-6">
            {noResults && (
                <div className="text-center text-[var(--color-text-muted)] py-12 text-sm">
                    No results found for &ldquo;{query}&rdquo;
                </div>
            )}

            {matchedArtists.length > 0 && (
                <div className="space-y-2">
                    <h4 className="text-xs font-bold tracking-wider uppercase text-[var(--color-text-muted)] mx-2">
                        Artists
                    </h4>
                    <div className="grid grid-cols-1 gap-1">
                        {matchedArtists.map(artist => (
                            <button
                                key={artist.id}
                                onClick={() => onArtistClick(artist.id)}
                                className="global-search-result-row flex items-center gap-3 w-full text-left p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0 text-[var(--color-primary)] font-bold">
                                    <ArtistInitial name={artist.name} className="text-base" />
                                </div>
                                <span className="font-medium text-[var(--color-text-primary)] truncate">
                                    {artist.name}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {matchedAlbums.length > 0 && (
                <div className="space-y-2">
                    <h4 className="text-xs font-bold tracking-wider uppercase text-[var(--color-text-muted)] mx-2">
                        Albums
                    </h4>
                    <div className="grid grid-cols-1 gap-1">
                        {matchedAlbums.map(album => {
                            const artistLink = resolveArtistLink(album.artist, artistLinkMap);
                            return (
                                <div
                                    key={album.id}
                                    className="global-search-result-row flex items-center gap-3 w-full text-left p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                >
                                    <button
                                        type="button"
                                        aria-label={`Open album ${album.title}`}
                                        onClick={() => onAlbumClick(album.id)}
                                        className="w-10 h-10 flex-shrink-0 rounded-md overflow-hidden"
                                    >
                                        {album.artUrl ? (
                                            <img
                                                src={album.artUrl}
                                                className="w-full h-full object-cover shadow-sm"
                                                alt=""
                                            />
                                        ) : (
                                            <span className="w-full h-full bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center">
                                                <span className="text-[var(--color-text-muted)] text-[8px] uppercase">
                                                    No Art
                                                </span>
                                            </span>
                                        )}
                                    </button>
                                    <div className="flex flex-col overflow-hidden text-left flex-1 min-w-0">
                                        <button
                                            type="button"
                                            onClick={() => onAlbumClick(album.id)}
                                            className="font-medium text-[var(--color-text-primary)] truncate text-left"
                                        >
                                            {album.title}
                                        </button>
                                        <span className="text-xs text-[var(--color-text-secondary)] truncate">
                                            {artistLink ? (
                                                <Link
                                                    to={artistLink}
                                                    state={{ backLabel: 'Back to Search' }}
                                                    onClick={onNavigate}
                                                    className="search-result-artist-link"
                                                >
                                                    {album.artist}
                                                </Link>
                                            ) : album.artist}
                                        </span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {matchedTracks.length > 0 && (
                <div className="space-y-2">
                    <h4 className="text-xs font-bold tracking-wider uppercase text-[var(--color-text-muted)] mx-2">
                        Tracks
                    </h4>
                    <div className="grid grid-cols-1 gap-1">
                        {matchedTracks.map((track, i) => {
                            const artistNames = getTrackArtistDisplayNames(track, knownArtistKeys);
                            return (
                                <div
                                    key={track.id || i}
                                    className="global-search-result-row group flex items-center gap-3 w-full text-left p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                >
                                <button
                                    type="button"
                                    aria-label={`Play ${track.title || 'track'}`}
                                    className="relative w-10 h-10 flex-shrink-0 cursor-pointer"
                                    onClick={() => onTrackPlay(track)}
                                >
                                    <AlbumArt
                                        artUrl={track.artUrl}
                                        artist={track.artist}
                                        size={40}
                                        className="w-full h-full rounded-md object-cover shadow-sm"
                                    />
                                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 rounded-md transition-opacity flex items-center justify-center">
                                        <Play size={16} className="text-white ml-0.5" />
                                    </div>
                                </button>
                                <div className="global-search-track-link flex flex-col flex-1 overflow-hidden min-w-0 text-left">
                                    <button
                                        type="button"
                                        onClick={() => onTrackOpen(track)}
                                        disabled={!track.albumId}
                                        aria-label={track.albumId ? `Open ${track.album || 'album'} and highlight ${track.title || 'track'}` : undefined}
                                        className="font-medium text-[var(--color-text-primary)] truncate text-left"
                                    >
                                        {track.title || track.path.split(/[\\\/]/).pop()}
                                    </button>
                                    <span className="text-xs text-[var(--color-text-secondary)] truncate">
                                        {artistNames.length > 0 ? artistNames.map((artistName, artistIndex) => {
                                            const artistLink = resolveTrackArtistLink(artistName, artistIndex, track, artistLinkMap);
                                            return (
                                                <React.Fragment key={`${artistName}-${artistIndex}`}>
                                                    {artistIndex > 0 && ' · '}
                                                    {artistLink ? (
                                                        <Link
                                                            to={artistLink}
                                                            state={{ backLabel: 'Back to Search' }}
                                                            onClick={onNavigate}
                                                            className="search-result-artist-link"
                                                        >
                                                            {artistName}
                                                        </Link>
                                                    ) : artistName}
                                                </React.Fragment>
                                            );
                                        }) : 'Unknown Artist'}
                                    </span>
                                </div>
                                <button
                                    aria-label="More options"
                                    onClick={e => {
                                        e.stopPropagation();
                                        openContextMenu(track, e.clientX, e.clientY);
                                    }}
                                    className="search-result-context-action opacity-0 group-hover:opacity-100 p-2 text-[var(--color-text-muted)] transition-ui flex-shrink-0"
                                >
                                    <MoreHorizontal size={16} />
                                </button>
                                <LoveButton track={track} size={15} className="p-2 flex-shrink-0" />
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
});

// ─── main component ───────────────────────────────────────────────────────────

export const GlobalSearch: React.FC = () => {
    const setPlaylist = usePlayerStore((state: any) => state.setPlaylist);
    const openContextMenu = usePlayerStore((state: any) => state.openContextMenu);
    const artists = usePlayerStore(state => state.artists);
    const knownArtistKeys = useKnownArtistKeys();
    const navigate = useNavigate();
    const isMobile = useIsMobile();

    const [isExpanded, setIsExpanded] = useState(false);
    const [isClosing, setIsClosing] = useState(false);
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});

    const inputRef = useRef<HTMLInputElement>(null);
    const mobileInputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLFormElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const closeTimerRef = useRef<number | null>(null);

    useEffect(() => {
        if (!query.trim()) {
            setDebouncedQuery('');
            return;
        }

        const timer = window.setTimeout(() => {
            setDebouncedQuery(query);
        }, 150);

        return () => window.clearTimeout(timer);
    }, [query]);

    // ── open ──────────────────────────────────────────────────────────────────
    const handleExpand = () => {
        if (closeTimerRef.current) {
            window.clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }
        setIsClosing(false);
        setIsExpanded(true);
        if (isMobile) {
            // Lock body scroll while overlay is open
            document.body.style.overflow = 'hidden';
            setTimeout(() => mobileInputRef.current?.focus(), 80);
        } else {
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    };

    // ── close ─────────────────────────────────────────────────────────────────
    const handleClose = useCallback(() => {
        if (closeTimerRef.current) {
            window.clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
        }

        if (isMobile && isExpanded) {
            setIsClosing(true);
            closeTimerRef.current = window.setTimeout(() => {
                setIsExpanded(false);
                setIsClosing(false);
                setQuery('');
                document.body.style.overflow = '';
                closeTimerRef.current = null;
            }, 180);
            return;
        }

        setIsExpanded(false);
        setIsClosing(false);
        setQuery('');
        document.body.style.overflow = '';
    }, [isExpanded, isMobile]);

    useEffect(() => {
        return () => {
            if (closeTimerRef.current) {
                window.clearTimeout(closeTimerRef.current);
            }
        };
    }, []);

    // ── desktop: close on outside click / Escape ──────────────────────────────
    useEffect(() => {
        if (isMobile) return; // handled by overlay on mobile

        const handleClickOutside = (e: MouseEvent) => {
            const outside =
                containerRef.current && !containerRef.current.contains(e.target as Node);
            const outsideDD =
                dropdownRef.current && !dropdownRef.current.contains(e.target as Node);
            if (outside && outsideDD) handleClose();
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                handleClose();
                inputRef.current?.blur();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [isMobile, handleClose]);

    // ── mobile: Escape key ────────────────────────────────────────────────────
    useEffect(() => {
        if (!isMobile) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') handleClose();
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isMobile, handleClose]);

    // ── Restore scroll if breakpoint changes while overlay is open ────────────
    useEffect(() => {
        if (!isMobile && isExpanded) {
            document.body.style.overflow = '';
        }
    }, [isMobile, isExpanded]);

    // ── desktop: portal position ──────────────────────────────────────────────
    useEffect(() => {
        if (!isExpanded || isMobile || !containerRef.current) return;

        const updatePosition = () => {
            if (containerRef.current) {
                const rect = containerRef.current.getBoundingClientRect();
                setDropdownStyle({
                    top: `${rect.bottom + 12}px`,
                    right: `${window.innerWidth - rect.right}px`,
                });
            }
        };

        updatePosition();
        window.addEventListener('resize', updatePosition);
        const scrollParent = containerRef.current.closest('.overflow-x-auto');
        if (scrollParent) scrollParent.addEventListener('scroll', updatePosition);

        return () => {
            window.removeEventListener('resize', updatePosition);
            if (scrollParent) scrollParent.removeEventListener('scroll', updatePosition);
        };
    }, [isExpanded, isMobile]);

    // ── filter logic ──────────────────────────────────────────────────────────
    const rawQuery = query.trim();
    const q = debouncedQuery.toLowerCase().trim();
    const hasQuery = rawQuery.length > 0;
    const hasDebouncedQuery = q.length > 0;
    const canShowResults = hasQuery && hasDebouncedQuery;

    // Server-side search (trigram ILIKE) instead of scanning the in-memory
    // library — scales to large libraries and removes the last big reason to
    // hold every track client-side. Debounced via `debouncedQuery`; each
    // keystroke aborts the prior in-flight request.
    const [searchResults, setSearchResults] = useState<SearchMatches>(EMPTY_SEARCH_MATCHES);
    const [searchLoading, setSearchLoading] = useState(false);

    useEffect(() => {
        const term = debouncedQuery.trim();
        if (!term) { setSearchResults(EMPTY_SEARCH_MATCHES); setSearchLoading(false); return; }
        const ac = new AbortController();
        setSearchLoading(true);
        const authHeaders = usePlayerStore.getState().getAuthHeader();
        fetch(`/api/library/search?q=${encodeURIComponent(term)}&artistLimit=5&albumLimit=5&trackLimit=10`, { headers: authHeaders, signal: ac.signal })
            .then(r => (r.ok ? r.json() : null))
            .then(data => {
                if (!data) { setSearchResults(EMPTY_SEARCH_MATCHES); setSearchLoading(false); return; }
                const hydrate = usePlayerStore.getState().hydrateTracks;
                setSearchResults({
                    matchedArtists: (data.artists || []).map((a: any) => ({ name: a.name, id: a.id })),
                    matchedAlbums: (data.albums || []).map((a: any) => ({
                        title: a.title || 'Unknown Album',
                        artist: a.artist_name || 'Unknown Artist',
                        id: a.id,
                        artUrl: a.image_url || undefined,
                    })),
                    matchedTracks: hydrate(data.tracks || []),
                });
                setSearchLoading(false);
            })
            .catch(() => { if (!ac.signal.aborted) { setSearchResults(EMPTY_SEARCH_MATCHES); setSearchLoading(false); } });
        return () => ac.abort();
    }, [debouncedQuery]);

    const { matchedArtists, matchedAlbums, matchedTracks } = searchResults;
    const artistLinkMap = useMemo(() => buildArtistLinkMap(artists), [artists]);

    // ── shared handlers ───────────────────────────────────────────────────────
    const handleArtistClick = useCallback((artistId: string) => {
        navigate(`/library/artist/${artistId}`);
        handleClose();
    }, [handleClose, navigate]);
    const handleAlbumClick = useCallback((albumId: string) => {
        navigate(`/library/album/${albumId}`);
        handleClose();
    }, [handleClose, navigate]);
    const handleTrackPlay = useCallback((track: TrackInfo) => {
        if (!track) return;
        setPlaylist([track], 0);
        handleClose();
    }, [handleClose, setPlaylist]);
    const handleTrackOpen = useCallback((track: TrackInfo) => {
        if (!track.albumId) return;
        navigate(`/library/album/${encodeURIComponent(track.albumId)}?track=${encodeURIComponent(track.id)}`, {
            state: { backLabel: 'Back to Search' },
        });
        handleClose();
    }, [handleClose, navigate]);
    const handleSubmit = useCallback((event: React.FormEvent) => {
        event.preventDefault();
        const term = query.trim();
        if (!term) return;
        navigate(`/search?q=${encodeURIComponent(term)}`);
        handleClose();
    }, [handleClose, navigate, query]);

    const sharedResultsProps = useMemo<ResultsProps>(() => ({
        query: debouncedQuery.trim() || rawQuery,
        matchedArtists,
        matchedAlbums,
        matchedTracks,
        onArtistClick: handleArtistClick,
        onAlbumClick: handleAlbumClick,
        onTrackPlay: handleTrackPlay,
        onTrackOpen: handleTrackOpen,
        artistLinkMap,
        knownArtistKeys,
        onNavigate: handleClose,
        openContextMenu,
    }), [debouncedQuery, rawQuery, matchedArtists, matchedAlbums, matchedTracks, handleArtistClick, handleAlbumClick, handleTrackPlay, handleTrackOpen, artistLinkMap, knownArtistKeys, handleClose, openContextMenu]);

    // ── pill (trigger) ────────────────────────────────────────────────────────
    const pill = (
        <form ref={containerRef} onSubmit={handleSubmit} className={`global-search-root ${isMobile ? 'global-search-root--mobile' : ''}`}>
            <div
                className={`
                    global-search-pill
                    ${isMobile
                        ? 'global-search-pill--mobile'
                        : isExpanded
                            ? 'global-search-pill--expanded'
                            : 'global-search-pill--collapsed'
                    }
                `}
                onClick={!isExpanded || isMobile ? handleExpand : undefined}
            >
                <div className="global-search-icon-slot">
                    <SearchIcon size={16} />
                </div>

                {isExpanded && !isMobile ? (
                    <input
                        ref={inputRef}
                        type="search"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search library..."
                        autoComplete="off"
                        className="global-search-input"
                    />
                ) : (
                    <span className="global-search-label">
                        Search
                    </span>
                )}

                {isExpanded && !isMobile && hasQuery && (
                    <button
                        type="button"
                        aria-label="Clear search"
                        onClick={() => setQuery('')}
                        className="global-search-clear"
                    >
                        <X size={14} />
                    </button>
                )}
            </div>

            {/* Desktop dropdown portal */}
            {isExpanded && !isMobile && canShowResults &&
                createPortal(
                    <div
                        ref={dropdownRef}
                        style={dropdownStyle}
                        className="global-search-dropdown"
                    >
                        <SearchResults {...sharedResultsProps} />
                    </div>,
                    document.body
                )}
        </form>
    );

    // ── mobile full-screen overlay portal ────────────────────────────────────
    const mobileOverlay = isMobile && isExpanded &&
        createPortal(
            <div className={`global-search-mobile-overlay ${isClosing ? 'global-search-mobile-overlay--closing' : ''}`}>
                {/* Header bar */}
                <div className="global-search-mobile-header">
                    <button
                        type="button"
                        aria-label="Close search"
                        onClick={handleClose}
                        className="flex-shrink-0 p-1 -ml-1 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] active:scale-95 transition-ui"
                    >
                        <ArrowLeft size={22} />
                    </button>

                    {/* Input */}
                    <div className="global-search-mobile-field">
                        <SearchIcon size={16} className="text-[var(--color-text-muted)] flex-shrink-0" />
                        <input
                            ref={mobileInputRef}
                            type="search"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === 'Enter') handleSubmit(e);
                            }}
                            placeholder="Search library…"
                            autoComplete="off"
                            className="flex-1 bg-transparent border-none outline-none text-base text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)]"
                        />
                        {hasQuery && (
                            <button
                                type="button"
                                aria-label="Clear search"
                                onClick={() => setQuery('')}
                                className="global-search-mobile-clear"
                            >
                                <X size={16} />
                            </button>
                        )}
                    </div>
                </div>

                {/* Results scroll area */}
                <div className="global-search-mobile-results">
                    {canShowResults ? (
                        <SearchResults {...sharedResultsProps} />
                    ) : (
                        <div className="global-search-empty">
                            <SearchIcon size={40} strokeWidth={1.2} />
                            <p className="text-sm">Search artists, albums &amp; tracks</p>
                        </div>
                    )}
                </div>
            </div>,
            document.body
        );

    return (
        <>
            {pill}
            {mobileOverlay}
        </>
    );
};
