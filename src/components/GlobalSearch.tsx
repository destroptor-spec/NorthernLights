import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../store';
import { Search as SearchIcon, X, Play, MoreHorizontal } from 'lucide-react';
import { TrackInfo } from '../utils/fileSystem';
import { AlbumArt } from './AlbumArt';
import { ArtistInitial } from './library/ArtistInitial';

export const GlobalSearch: React.FC = () => {
    const library = usePlayerStore((state: any) => state.library);
    const artists = usePlayerStore((state: any) => state.artists);
    const albums = usePlayerStore((state: any) => state.albums);
    const setPlaylist = usePlayerStore((state: any) => state.setPlaylist);
    const openContextMenu = usePlayerStore((state: any) => state.openContextMenu);
    const navigate = useNavigate();
    
    const [isExpanded, setIsExpanded] = useState(false);
    const [query, setQuery] = useState('');
    const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Expand search onClick
    const handleExpand = () => {
        setIsExpanded(true);
        setTimeout(() => inputRef.current?.focus(), 50);
    };

    // Close on outside click or escape
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const isOutsideContainer = containerRef.current && !containerRef.current.contains(e.target as Node);
            const isOutsideDropdown = dropdownRef.current && !dropdownRef.current.contains(e.target as Node);
            
            if (isOutsideContainer && isOutsideDropdown) {
                setIsExpanded(false);
            }
        };
        const handleKeyDown = (e: KeyboardEvent) => {
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
        if (!isExpanded || !containerRef.current) return;

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

    let matchedArtists: { name: string; id: string }[] = [];
    let matchedAlbums: { title: string; artist: string; id: string; artUrl?: string }[] = [];
    let matchedTracks: TrackInfo[] = [];

    if (hasQuery) {
        // Search artists from entity list
        matchedArtists = artists
            .filter((a: any) => a.name?.toLowerCase().includes(q))
            .slice(0, 5)
            .map((a: any) => ({ name: a.name, id: a.id }));

        // Search albums from entity list, resolving art from tracks
        const albumMatches = albums
            .filter((a: any) => a.title?.toLowerCase().includes(q) || a.artist_name?.toLowerCase().includes(q))
            .slice(0, 5);
        matchedAlbums = albumMatches.map((a: any) => {
            const track = library.find((t: TrackInfo) => t.albumId === a.id);
            return {
                title: a.title,
                artist: a.artist_name || 'Unknown Artist',
                id: a.id,
                artUrl: track?.artUrl
            };
        });

        // Search tracks by title
        const tracksSet = new Set<string>();
        library.forEach((track: TrackInfo) => {
            if (track.title?.toLowerCase().includes(q) || track.path.toLowerCase().includes(q)) {
                if (!tracksSet.has(track.id)) {
                    matchedTracks.push(track);
                    tracksSet.add(track.id);
                }
            }
        });

        // Also add tracks where artist matches (but only if not already found by artist entity search)
        if (matchedArtists.length > 0) {
            const matchedArtistNames = new Set(matchedArtists.map((a: any) => a.name.toLowerCase()));
            library.forEach((track: TrackInfo) => {
                if (tracksSet.has(track.id)) return;
                const tArtists: string[] = Array.isArray(track.artists) ? track.artists : [];
                if (tArtists.some(a => matchedArtistNames.has(a.toLowerCase()))) {
                    matchedTracks.push(track);
                    tracksSet.add(track.id);
                }
            });
        }

        matchedTracks = matchedTracks.slice(0, 10);
    }

    // Handlers
    const handleArtistClick = (artistId: string) => {
        navigate(`/library/artist/${artistId}`);
        setIsExpanded(false);
        setQuery('');
    };
    
    const handleAlbumClick = (albumId: string) => {
        navigate(`/library/album/${albumId}`);
        setIsExpanded(false);
        setQuery('');
    };

    const handleTrackPlay = (track: TrackInfo) => {
        if (!track) return;
        setPlaylist([track], 0);
        setIsExpanded(false);
        setQuery('');
    };

    return (
        <div ref={containerRef} className="relative z-[60] flex items-center ml-auto h-9">
            <div className={`
                flex items-center rounded-full border backdrop-blur-md transition-all duration-300 overflow-hidden
                ${isExpanded 
                    ? 'w-64 sm:w-80 bg-[var(--glass-bg)] border-[var(--color-primary)] shadow-[0_0_12px_rgba(34,201,131,0.2)]' 
                    : 'w-[104px] bg-black/5 dark:bg-white/[0.06] border-[var(--color-border)] hover:bg-black/10 dark:hover:bg-white/[0.12] hover:border-[var(--glass-border-hover)] cursor-pointer'
                }
            `}
            onClick={!isExpanded ? handleExpand : undefined}
            >
                <div className="pl-4 pr-2 py-2 flex items-center justify-center text-[var(--color-text-secondary)]">
                    <SearchIcon size={16} />
                </div>
                
                {isExpanded ? (
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Search library..."
                        className="flex-1 bg-transparent border-none outline-none text-sm text-[var(--color-text-primary)] py-2 pr-4 placeholder-[var(--color-text-muted)]"
                    />
                ) : (
                    <span className="text-sm font-semibold pr-4 text-[var(--color-text-secondary)] select-none">
                        Search
                    </span>
                )}

                {isExpanded && hasQuery && (
                    <button onClick={() => setQuery('')} className="pr-3 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
                        <X size={14} />
                    </button>
                )}
            </div>

            {/* Dropdown Results */}
            {isExpanded && hasQuery && createPortal(
                <div 
                    ref={dropdownRef}
                    style={dropdownStyle}
                    className="fixed w-[calc(100vw-2rem)] sm:w-[400px] max-h-[70vh] overflow-y-auto bg-[var(--glass-bg)] backdrop-blur-3xl border border-[var(--glass-border)] rounded-2xl shadow-[var(--shadow-2xl)] p-4 flex flex-col gap-6 animate-in fade-in slide-in-from-top-4 duration-200 z-[100]"
                >
                    
                    {matchedArtists.length === 0 && matchedAlbums.length === 0 && matchedTracks.length === 0 && (
                        <div className="text-center text-[var(--color-text-muted)] py-8 text-sm">
                            No results found for "{query}"
                        </div>
                    )}

                    {matchedArtists.length > 0 && (
                        <div className="space-y-2">
                            <h4 className="text-xs font-bold tracking-wider uppercase text-[var(--color-text-muted)] mx-2">Artists</h4>
                            <div className="grid grid-cols-1 gap-1">
                                {matchedArtists.map(artist => (
                                    <button 
                                        key={artist.id}
                                        onClick={() => handleArtistClick(artist.id)}
                                        className="flex items-center gap-3 w-full text-left p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                    >
                                        <div className="w-10 h-10 rounded-full bg-[var(--color-primary)]/20 flex items-center justify-center flex-shrink-0 text-[var(--color-primary)] font-bold">
                                            <ArtistInitial name={artist.name} className="text-base" />
                                        </div>
                                        <span className="font-medium text-[var(--color-text-primary)] truncate">{artist.name}</span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {matchedAlbums.length > 0 && (
                        <div className="space-y-2">
                            <h4 className="text-xs font-bold tracking-wider uppercase text-[var(--color-text-muted)] mx-2">Albums</h4>
                            <div className="grid grid-cols-1 gap-1">
                                {matchedAlbums.map(album => (
                                    <button 
                                        key={album.id}
                                        onClick={() => handleAlbumClick(album.id)}
                                        className="flex items-center gap-3 w-full text-left p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                    >
                                        {album.artUrl ? (
                                            <img src={album.artUrl} className="w-10 h-10 rounded-md object-cover shadow-sm flex-shrink-0" alt="" />
                                        ) : (
                                            <div className="w-10 h-10 flex-shrink-0 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] flex items-center justify-center">
                                                <span className="text-[var(--color-text-muted)] text-[8px] uppercase">No Art</span>
                                            </div>
                                        )}
                                        <div className="flex flex-col overflow-hidden text-left flex-1 min-w-0">
                                            <span className="font-medium text-[var(--color-text-primary)] truncate">{album.title}</span>
                                            <span className="text-xs text-[var(--color-text-secondary)] truncate">{album.artist}</span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {matchedTracks.length > 0 && (
                        <div className="space-y-2">
                            <h4 className="text-xs font-bold tracking-wider uppercase text-[var(--color-text-muted)] mx-2">Tracks</h4>
                            <div className="grid grid-cols-1 gap-1">
                                {matchedTracks.map((track, i) => (
                                    <div 
                                        key={track.id || i}
                                        className="group flex items-center gap-3 w-full text-left p-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                    >
                                        <div className="relative w-10 h-10 flex-shrink-0 cursor-pointer" onClick={() => handleTrackPlay(track)}>
                                            <AlbumArt artUrl={track.artUrl} artist={track.artist} size={40} className="w-full h-full rounded-md object-cover shadow-sm" />
                                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 rounded-md transition-opacity flex items-center justify-center">
                                                <Play size={16} className="text-white ml-0.5" />
                                            </div>
                                        </div>
                                        <div className="flex flex-col flex-1 overflow-hidden min-w-0 text-left">
                                            <span className="font-medium text-[var(--color-text-primary)] truncate">{track.title || track.path.split(/[\\/]/).pop()}</span>
                                            <span className="text-xs text-[var(--color-text-secondary)] truncate">{typeof track.artists === 'string' ? track.artists : track.artists?.join(', ') || track.artist || 'Unknown Artist'}</span>
                                        </div>
                                        <button
                                            aria-label="More options"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                openContextMenu(track, e.clientX, e.clientY);
                                            }}
                                            className="opacity-0 group-hover:opacity-100 p-2 text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition-all flex-shrink-0"
                                        >
                                            <MoreHorizontal size={16} />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>,
                document.body
            )}
        </div>
    );
};
