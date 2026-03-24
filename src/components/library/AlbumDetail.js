import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { AlbumArt } from '../AlbumArt';
import { parseArtists } from '../../utils/artistUtils';
import { formatTime } from '../../utils/formatTime';
import { BackButton } from './BackButton';
import { MoreHorizontal } from 'lucide-react';
export const AlbumDetail = () => {
    const { albumId } = useParams();
    const navigate = useNavigate();
    const { library, albums, artists, setPlaylist, openContextMenu } = usePlayerStore();
    // Find album info from the entity list
    const albumInfo = useMemo(() => albums.find(a => a.id === albumId), [albums, albumId]);
    // Filter tracks by album_id
    const albumTracks = useMemo(() => {
        if (!albumId)
            return [];
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
        return _jsx("div", { children: "Album not found." });
    }
    const albumTitle = albumInfo?.title || albumTracks[0]?.album || 'Unknown Album';
    const albumArtist = albumInfo?.artist_name || albumTracks[0]?.albumArtist || albumTracks[0]?.artist || 'Unknown Artist';
    const artUrl = albumTracks.find(t => t.artUrl)?.artUrl;
    const albumGenre = albumTracks.find(t => t.genre)?.genre;
    const headerArtists = parseArtists(albumArtist);
    // Build artist name -> ID lookup from entity list, with fallback to track data
    const getArtistLink = (artistName) => {
        // First try entity list (case-insensitive)
        const entity = artists.find((a) => a.name?.toLowerCase() === artistName.toLowerCase());
        if (entity)
            return `/library/artist/${entity.id}`;
        // Fallback: find a track where this artist is the album artist (has artistId)
        const track = albumTracks.find(t => (t.albumArtist || t.artist || '').toLowerCase() === artistName.toLowerCase());
        if (track?.artistId)
            return `/library/artist/${track.artistId}`;
        return null;
    };
    const handlePlayAll = () => {
        setPlaylist(sortedTracks, 0);
    };
    const handlePlayTrack = (index) => {
        setPlaylist(sortedTracks, index);
    };
    return (_jsxs("div", { className: "album-detail flex flex-col overflow-hidden p-4 md:p-8 lg:p-12 flex-1", children: [_jsx("div", { className: "shrink-0", children: _jsx(BackButton, { onClick: () => navigate(-1) }) }), _jsxs("div", { className: "album-header shrink-0 flex flex-col md:flex-row gap-6 md:gap-8 mb-8 md:mb-12 items-center md:items-end text-center md:text-left", children: [_jsx("div", { className: "w-48 h-48 md:w-60 md:h-60 shrink-0 rounded-2xl border border-[var(--glass-border)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)] relative overflow-hidden backdrop-blur-md", children: _jsx(AlbumArt, { artUrl: artUrl, artist: albumArtist, size: 240, className: "w-full h-full object-cover" }) }), _jsxs("div", { className: "flex flex-col justify-end", children: [_jsx("div", { className: "font-semibold text-sm tracking-wider uppercase text-[var(--color-primary)]", children: "Album" }), _jsx("h1", { className: "font-bold text-4xl md:text-5xl lg:text-6xl tracking-tight my-2 leading-tight text-[var(--color-text-primary)]", children: albumTitle }), _jsxs("h2", { className: "text-xl text-[var(--color-text-secondary)] mb-1", children: [headerArtists.map((a, i) => {
                                        const link = getArtistLink(a);
                                        return (_jsxs(React.Fragment, { children: [i > 0 && ' · ', link ? (_jsx(Link, { to: link, className: "hover:text-[var(--color-primary)] transition-colors no-underline text-inherit", children: a })) : (_jsx("span", { children: a }))] }, a));
                                    }), ' ', " \u2022 ", albumTracks.length, " track", albumTracks.length !== 1 ? 's' : ''] }), albumGenre && (_jsx("span", { className: "inline-block mt-1 mb-3 text-xs font-semibold uppercase tracking-widest px-3 py-1 rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-primary)] w-fit backdrop-blur-sm", children: albumGenre })), _jsx("div", { className: "mt-4 flex justify-center md:justify-start", children: _jsx("button", { onClick: handlePlayAll, className: "btn bg-[var(--color-primary)] text-white hover:text-white border-transparent", children: "PLAY ALBUM" }) })] })] }), _jsxs("div", { className: "album-tracks mt-4 overflow-y-auto flex-1 min-h-0", children: [_jsxs("div", { className: "grid grid-cols-[40px_1fr_100px] px-4 py-3 border-b border-[var(--glass-border)] font-semibold text-xs uppercase tracking-wider text-[var(--color-text-muted)]", children: [_jsx("div", { children: "#" }), _jsx("div", { children: "Title" }), _jsx("div", { className: "text-right", children: "Time" })] }), sortedTracks.map((track, i) => (_jsxs("div", { onClick: () => handlePlayTrack(i), className: "grid grid-cols-[40px_1fr_100px] px-4 py-3 border-b border-[var(--glass-border)] cursor-pointer items-center transition-all duration-200 hover:bg-[var(--glass-bg-hover)] rounded-lg my-1 group", children: [_jsx("div", { className: "text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors", children: i + 1 }), _jsxs("div", { className: "font-medium truncate text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors", children: [_jsx("span", { children: track.title || track.path.split(/[\/\\]/).pop() }), ((track.artists && Array.isArray(track.artists) && track.artists.length > 0) || (track.artist && parseArtists(track.artist).length > 0)) && (_jsx("span", { className: "block text-xs text-[var(--color-text-muted)] mt-0.5", children: (Array.isArray(track.artists) && track.artists.length > 0 ? track.artists : parseArtists(track.artist || '')).map((a, i) => {
                                            const link = getArtistLink(a);
                                            return (_jsxs(React.Fragment, { children: [i > 0 && ' · ', link ? (_jsx(Link, { to: link, onClick: (e) => e.stopPropagation(), className: "hover:text-[var(--color-primary)] transition-colors no-underline text-inherit", children: a })) : (_jsx("span", { children: a }))] }, a));
                                        }) }))] }), _jsxs("div", { className: "text-[var(--color-text-muted)] text-right group-hover:text-[var(--color-text-primary)] transition-colors flex items-center justify-end gap-3", children: [_jsx("span", { className: "w-12 text-right", children: formatTime(track.duration, '--:--') }), _jsx("button", { "aria-label": "More options", onClick: (e) => {
                                            e.stopPropagation();
                                            openContextMenu(track, e.clientX, e.clientY);
                                        }, className: "opacity-0 group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition-all p-1", children: _jsx(MoreHorizontal, { size: 16 }) })] })] }, track.id)))] })] }));
};
