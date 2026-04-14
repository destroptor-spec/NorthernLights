import React, { useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { AlbumArt } from '../AlbumArt';
import { parseArtists } from '../../utils/artistUtils';
import { formatTime } from '../../utils/formatTime';
import { BackButton } from './BackButton';

import { MoreHorizontal, Play } from 'lucide-react';

const TrackRowSkeleton: React.FC = () => (
    <div className="grid grid-cols-[30px_1fr_40px] md:grid-cols-[40px_1fr_100px] gap-2 px-2 md:px-4 py-2.5 animate-pulse">
        <div className="flex justify-center md:justify-start">
            <div className="h-4 w-4 rounded bg-[var(--color-surface-variant)]" />
        </div>
        <div className="space-y-1.5">
            <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)]" />
            <div className="h-3 w-1/2 rounded bg-[var(--color-surface-variant)] md:hidden" />
        </div>
        <div className="hidden md:flex justify-end">
            <div className="h-4 w-10 rounded bg-[var(--color-surface-variant)]" />
        </div>
    </div>
);

export const AlbumDetail: React.FC = () => {
    const { albumId } = useParams<{ albumId: string }>();
    const navigate = useNavigate();
    
    // Select granularly to prevent full-store renders that kill performance on playback tick
    const library = usePlayerStore(state => state.library);
    const albums = usePlayerStore(state => state.albums);
    const artists = usePlayerStore(state => state.artists);
    const setPlaylist = usePlayerStore(state => state.setPlaylist);
    const openContextMenu = usePlayerStore(state => state.openContextMenu);

    // Find album info from the entity list
    const albumInfo = useMemo(() => albums.find(a => a.id === albumId), [albums, albumId]);

    // Filter tracks by album_id
    const albumTracks = useMemo(() => {
        if (!albumId) return [];
        return library.filter(t => t.albumId === albumId);
    }, [library, albumId]);

    const sortedTracks = useMemo(() => {
        return [...albumTracks].sort((a, b) => {
            // Sort by track number first, then by name
            if (a.trackNumber != null && b.trackNumber != null) {
                return a.trackNumber - b.trackNumber;
            }
            const aName = a.title || a.path.split(/[\\/]/).pop() || '';
            const bName = b.title || b.path.split(/[\\/]/).pop() || '';
            return aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' });
        });
    }, [albumTracks]);


    if (!albumId) {
        return (
            <div className="flex flex-col overflow-hidden p-4 md:p-8 lg:p-12 flex-1">
                <div className="shrink-0 mb-6"><BackButton onClick={() => navigate(-1)} /></div>
                <div className="flex flex-col md:flex-row gap-6 md:gap-8 mb-8 md:mb-12">
                    <div className="w-48 h-48 md:w-60 md:h-60 shrink-0 rounded-2xl bg-[var(--color-surface-variant)] animate-pulse" />
                    <div className="flex-1 space-y-3">
                        <div className="h-4 w-16 rounded bg-[var(--color-surface-variant)] animate-pulse" />
                        <div className="h-10 w-3/4 rounded bg-[var(--color-surface-variant)] animate-pulse" />
                        <div className="h-5 w-1/2 rounded bg-[var(--color-surface-variant)] animate-pulse" />
                        <div className="h-10 w-32 rounded-full bg-[var(--color-surface-variant)] animate-pulse mt-4" />
                    </div>
                </div>
                <div className="space-y-0.5">
                    {Array.from({ length: 8 }).map((_, i) => <TrackRowSkeleton key={i} />)}
                </div>
            </div>
        );
    }

    if (albumTracks.length === 0) {
        return <div className="flex-1 flex justify-center items-center text-[var(--color-text-muted)]">Album not found.</div>;
    }

    const albumTitle = albumInfo?.title || albumTracks[0]?.album || 'Unknown Album';
    const albumArtist = albumInfo?.artist_name || albumTracks[0]?.albumArtist || albumTracks[0]?.artist || 'Unknown Artist';
    const artUrl = albumTracks.find(t => t.artUrl)?.artUrl;
    const albumGenre = albumTracks.find(t => t.genre)?.genre;
    const albumYear = albumTracks.find(t => t.year)?.year;
    const headerArtists = parseArtists(albumArtist);

    // Build artist name -> ID lookup from entity list, with fallback to track data
    const getArtistLink = (artistName: string): string | null => {
        // First try entity list (case-insensitive)
        const entity = artists.find((a: any) => a.name?.toLowerCase() === artistName.toLowerCase());
        if (entity) return `/library/artist/${entity.id}`;
        // Fallback: find a track where this artist is the album artist (has artistId)
        const track = albumTracks.find(t => 
            (t.albumArtist || t.artist || '').toLowerCase() === artistName.toLowerCase()
        );
        if (track?.artistId) return `/library/artist/${track.artistId}`;
        return null;
    };

    const handlePlayAll = () => {
        setPlaylist(sortedTracks, 0);
    };

    const handlePlayTrack = (index: number) => {
        setPlaylist(sortedTracks, index);
    };

    return (
        <div className="flex flex-col overflow-hidden p-4 md:p-8 lg:p-12 flex-1">

            <div className="shrink-0 mb-6"><BackButton onClick={() => navigate(-1)} /></div>

            <div className="shrink-0 flex flex-col md:flex-row gap-6 md:gap-8 mb-8 md:mb-12 items-center md:items-end text-center md:text-left">
                <div className="w-48 h-48 md:w-60 md:h-60 shrink-0 rounded-2xl border border-black/10 dark:border-white/10 shadow-2xl relative overflow-hidden backdrop-blur-xl bg-black/10 dark:bg-white/5">
                    <AlbumArt artUrl={artUrl} artist={albumArtist} size={240} className="w-full h-full object-cover rounded-2xl" />
                </div>
                <div className="flex flex-col justify-end items-center md:items-start max-w-full">
                    <div className="font-semibold text-sm tracking-wider uppercase text-[var(--color-primary)]">Album</div>
                    <h1 className="font-bold text-4xl md:text-5xl lg:text-6xl tracking-tight my-2 leading-tight text-[var(--color-text-primary)] line-clamp-2" title={albumTitle}>{albumTitle}</h1>
                    <h2 className="text-xl text-[var(--color-text-secondary)] flex flex-wrap justify-center md:justify-start items-center gap-2 mb-2 w-full truncate">
                        <span className="truncate">
                        {headerArtists.map((a, i) => {
                            const link = getArtistLink(a);
                            return (
                                <React.Fragment key={a}>
                                    {i > 0 && ' · '}
                                    {link ? (
                                        <Link
                                            to={link}
                                            className="hover:text-[var(--color-primary)] transition-colors no-underline text-inherit"
                                        >{a}</Link>
                                    ) : (
                                        <span>{a}</span>
                                    )}
                                </React.Fragment>
                            );
                        })}
                        </span>
                        <span className="hidden md:inline shrink-0"> • </span>
                        <span className="shrink-0 text-sm md:text-xl text-[var(--color-text-muted)]">
                           {albumTracks.length} track{albumTracks.length !== 1 ? 's' : ''}
                           {albumYear && ` • ${albumYear}`}
                        </span>
                    </h2>
                    
                    {albumGenre && (
                        <span className="inline-block mt-2 mb-4 text-xs font-semibold uppercase tracking-widest px-3 py-1 rounded-full border border-black/10 dark:border-white/10 bg-black/5 dark:bg-white/5 text-[var(--color-primary)] w-fit backdrop-blur-sm">
                            {albumGenre}
                        </span>
                    )}

                    <div className="mt-4 flex justify-center md:justify-start w-full md:w-auto">
                        <button
                            onClick={handlePlayAll}
                            className="flex items-center justify-center gap-2 px-8 py-3.5 bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-bold text-sm tracking-widest uppercase rounded-full shadow-[0_4px_24px_rgba(16,185,129,0.3)] hover:shadow-[0_8px_32px_rgba(16,185,129,0.4)] hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100 transition-all duration-300 w-full md:w-auto"
                        >
                            <Play size={18} fill="currentColor" className="ml-1" />
                            PLAY ALBUM
                        </button>
                    </div>
                </div>
            </div>

            <div className="mt-4 overflow-y-auto flex-1 min-h-0 hide-scrollbar pb-6">
                <div className="grid grid-cols-[30px_1fr_40px] md:grid-cols-[40px_1fr_100px] px-2 md:px-4 py-3 border-b border-black/5 dark:border-white/10 font-semibold text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                    <div className="text-center md:text-left">#</div>
                    <div>Title</div>
                    <div className="text-right hidden md:block">Time</div>
                </div>
                {sortedTracks.map((track, i) => (
                    <div
                        key={track.id}
                        onClick={() => handlePlayTrack(i)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                handlePlayTrack(i);
                            }
                        }}
                        className="grid grid-cols-[30px_1fr_40px] md:grid-cols-[40px_1fr_100px] gap-2 px-2 md:px-4 py-2 border-b border-black/5 dark:border-white/5 cursor-pointer items-center transition-all duration-200 hover:bg-black/5 dark:hover:bg-white/5 focus-visible:bg-black/5 dark:focus-visible:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] rounded-lg my-0.5 group"
                    >
                        <div className="text-center md:text-left text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors text-sm">{i + 1}</div>
                        <div className="font-medium truncate text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors min-w-0">
                            <span className="block truncate text-sm md:text-base">{track.title || track.path.split(/[\/\\]/).pop()}</span>
                            {((track.artists && Array.isArray(track.artists) && track.artists.length > 0) || (track.artist && parseArtists(track.artist).length > 0)) && (
                                <span className="block text-xs text-[var(--color-text-muted)] mt-0.5 truncate">
                                    {(Array.isArray(track.artists) && track.artists.length > 0 ? track.artists : parseArtists(track.artist || '')).map((a, i) => {
                                        const link = getArtistLink(a);
                                        return (
                                            <React.Fragment key={a}>
                                                {i > 0 && ' · '}
                                                {link ? (
                                                    <Link
                                                        to={link}
                                                        onClick={(e) => e.stopPropagation()}
                                                        className="hover:text-[var(--color-primary)] transition-colors no-underline text-inherit"
                                                    >{a}</Link>
                                                ) : (
                                                    <span>{a}</span>
                                                )}
                                            </React.Fragment>
                                        );
                                    })}
                                </span>
                            )}
                        </div>
                        <div className="text-[var(--color-text-muted)] text-right group-hover:text-[var(--color-text-primary)] transition-colors flex flex-row items-center justify-end md:gap-3">
                            <span className="w-12 text-right hidden md:inline text-sm tabular-nums">
                                {formatTime(track.duration, '--:--')}
                            </span>
                            <button
                                aria-label="More options"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    openContextMenu(track, e.clientX, e.clientY);
                                }}
                                className="opacity-50 md:opacity-0 md:group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-black/5 dark:hover:bg-white/10 rounded-md transition-all p-1.5 focus:opacity-100"
                            >
                                <MoreHorizontal size={18} />
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
