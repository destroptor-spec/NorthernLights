import React, { useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { AlbumArt } from '../AlbumArt';
import { parseArtists } from '../../utils/artistUtils';
import { formatTime } from '../../utils/formatTime';
import { BackButton } from './BackButton';

import { MoreHorizontal } from 'lucide-react';

export const AlbumDetail: React.FC = () => {
    const { albumId } = useParams<{ albumId: string }>();
    const navigate = useNavigate();
    const { library, albums, artists, setPlaylist, openContextMenu } = usePlayerStore();

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


    if (!albumId || albumTracks.length === 0) {
        return <div>Album not found.</div>;
    }

    const albumTitle = albumInfo?.title || albumTracks[0]?.album || 'Unknown Album';
    const albumArtist = albumInfo?.artist_name || albumTracks[0]?.albumArtist || albumTracks[0]?.artist || 'Unknown Artist';
    const artUrl = albumTracks.find(t => t.artUrl)?.artUrl;
    const albumGenre = albumTracks.find(t => t.genre)?.genre;
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
        <div className="album-detail flex flex-col overflow-hidden p-4 md:p-8 lg:p-12 flex-1">

            <div className="shrink-0"><BackButton onClick={() => navigate(-1)} /></div>

            <div className="album-header shrink-0 flex flex-col md:flex-row gap-6 md:gap-8 mb-8 md:mb-12 items-center md:items-end text-center md:text-left">
                <div className="w-48 h-48 md:w-60 md:h-60 shrink-0 rounded-2xl border border-[var(--glass-border)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)] relative overflow-hidden backdrop-blur-md">
                    <AlbumArt artUrl={artUrl} artist={albumArtist} size={240} className="w-full h-full object-cover" />
                </div>
                <div className="flex flex-col justify-end">
                    <div className="font-semibold text-sm tracking-wider uppercase text-[var(--color-primary)]">Album</div>
                    <h1 className="font-bold text-4xl md:text-5xl lg:text-6xl tracking-tight my-2 leading-tight text-[var(--color-text-primary)]">{albumTitle}</h1>
                    <h2 className="text-xl text-[var(--color-text-secondary)] mb-1">
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
                        {' '} • {albumTracks.length} track{albumTracks.length !== 1 ? 's' : ''}
                    </h2>
                    {albumGenre && (
                        <span className="inline-block mt-1 mb-3 text-xs font-semibold uppercase tracking-widest px-3 py-1 rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-primary)] w-fit backdrop-blur-sm">
                            {albumGenre}
                        </span>
                    )}

                    <div className="mt-4 flex justify-center md:justify-start">
                        <button
                            onClick={handlePlayAll}
                            className="btn bg-[var(--color-primary)] text-white hover:text-white border-transparent"
                        >
                            PLAY ALBUM
                        </button>
                    </div>
                </div>
            </div>

            <div className="album-tracks mt-4 overflow-y-auto flex-1 min-h-0">
                <div className="grid grid-cols-[40px_1fr_100px] px-4 py-3 border-b border-[var(--glass-border)] font-semibold text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
                    <div>#</div>
                    <div>Title</div>
                    <div className="text-right">Time</div>
                </div>
                {sortedTracks.map((track, i) => (
                    <div
                        key={track.id}
                        onClick={() => handlePlayTrack(i)}
                        className="grid grid-cols-[40px_1fr_100px] px-4 py-3 border-b border-[var(--glass-border)] cursor-pointer items-center transition-all duration-200 hover:bg-[var(--glass-bg-hover)] rounded-lg my-1 group"
                    >
                        <div className="text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors">{i + 1}</div>
                        <div className="font-medium truncate text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors">
                            <span>{track.title || track.path.split(/[\/\\]/).pop()}</span>
                            {((track.artists && Array.isArray(track.artists) && track.artists.length > 0) || (track.artist && parseArtists(track.artist).length > 0)) && (
                                <span className="block text-xs text-[var(--color-text-muted)] mt-0.5">
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
                        <div className="text-[var(--color-text-muted)] text-right group-hover:text-[var(--color-text-primary)] transition-colors flex items-center justify-end gap-3">
                            <span className="w-12 text-right">
                                {formatTime(track.duration, '--:--')}
                            </span>
                            <button
                                aria-label="More options"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    openContextMenu(track, e.clientX, e.clientY);
                                }}
                                className="opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition-all p-1"
                            >
                                <MoreHorizontal size={16} />
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
