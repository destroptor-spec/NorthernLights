import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useMemo } from 'react';
import { usePlayerStore } from '../../store/index';
import { AlbumArt } from '../AlbumArt';
import { parseArtists } from '../../utils/artistUtils';
export const AlbumDetail = () => {
    const { library, selectedItem, setPlaylist, navigateView } = usePlayerStore();
    const [albumTitle, albumArtist] = (selectedItem || '').split('::::');
    // Filter tracks to just this album
    const albumTracks = useMemo(() => {
        return library.filter(t => t.album === albumTitle && ((t.albumArtist || t.artist || 'Unknown Artist') === albumArtist));
    }, [library, albumTitle, albumArtist]);
    // Note: we need to parse track numbers from the track titles, or fall back to name sorting since TrackInfo currently lacks track Number.
    // We'll update extractMetadata to grab track number soon. For now we just use the name to guarantee deterministic sorting.
    const sortedTracks = useMemo(() => {
        return [...albumTracks].sort((a, b) => {
            // By metadata ID3 title/filename
            const aName = a.title || a.path.split(/[\\/]/).pop() || '';
            const bName = b.title || b.path.split(/[\\/]/).pop() || '';
            return aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' });
        });
    }, [albumTracks]);
    if (!selectedItem || albumTracks.length === 0) {
        return _jsx("div", { children: "Album not found." });
    }
    const artUrl = albumTracks.find(t => t.artUrl)?.artUrl;
    // Pick genre from the first track that has one
    const albumGenre = albumTracks.find(t => t.genre)?.genre;
    // Parse album-level artists for the header
    const headerArtists = parseArtists(albumArtist);
    const handlePlayAll = () => {
        setPlaylist(sortedTracks, 0);
    };
    const handlePlayTrack = (index) => {
        setPlaylist(sortedTracks, index);
    };
    return (_jsxs("div", { className: "album-detail p-4 md:p-8 lg:p-12 overflow-y-auto flex-1 flex flex-col", children: [_jsx("button", { onClick: () => navigateView('home'), className: "font-medium text-sm md:text-base text-[var(--color-primary)] hover:text-[var(--color-primary-dark)] px-4 py-2 w-fit flex items-center gap-2 mb-8 md:mb-12 transition-all duration-200", children: "\u2190 Back to Library" }), _jsxs("div", { className: "album-header flex flex-col md:flex-row gap-6 md:gap-8 mb-8 md:mb-12 items-center md:items-end text-center md:text-left", children: [_jsx("div", { className: "w-48 h-48 md:w-60 md:h-60 shrink-0 rounded-2xl border border-[var(--glass-border)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)] relative overflow-hidden backdrop-blur-md", children: _jsx(AlbumArt, { artUrl: artUrl, artist: albumArtist, size: 240, className: "w-full h-full object-cover" }) }), _jsxs("div", { className: "flex flex-col justify-end", children: [_jsx("div", { className: "font-semibold text-sm tracking-wider uppercase text-[var(--color-primary)]", children: "Album" }), _jsx("h1", { className: "font-bold text-4xl md:text-5xl lg:text-6xl tracking-tight my-2 leading-tight text-[var(--color-text-primary)]", children: albumTitle }), _jsxs("h2", { className: "text-xl text-[var(--color-text-secondary)] mb-1", children: [headerArtists.map((a, i) => (_jsxs(React.Fragment, { children: [i > 0 && ' · ', _jsx("span", { className: "hover:text-[var(--color-primary)] cursor-pointer transition-colors", onClick: (e) => { e.stopPropagation(); navigateView('artist', a); }, children: a })] }, a))), ' ', " \u2022 ", albumTracks.length, " track", albumTracks.length !== 1 ? 's' : ''] }), albumGenre && (_jsx("span", { className: "inline-block mt-1 mb-3 text-xs font-semibold uppercase tracking-widest px-3 py-1 rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-primary)] w-fit backdrop-blur-sm", children: albumGenre })), _jsx("div", { className: "mt-4 flex justify-center md:justify-start", children: _jsx("button", { onClick: handlePlayAll, className: "btn bg-[var(--color-primary)] text-white hover:text-white border-transparent", children: "PLAY ALBUM" }) })] })] }), _jsxs("div", { className: "album-tracks mt-4", children: [_jsxs("div", { className: "grid grid-cols-[40px_1fr_100px] px-4 py-3 border-b border-[var(--glass-border)] font-semibold text-xs uppercase tracking-wider text-[var(--color-text-muted)]", children: [_jsx("div", { children: "#" }), _jsx("div", { children: "Title" }), _jsx("div", { className: "text-right", children: "Time" })] }), sortedTracks.map((track, i) => (_jsxs("div", { onClick: () => handlePlayTrack(i), className: "grid grid-cols-[40px_1fr_100px] px-4 py-3 border-b border-[var(--glass-border)] cursor-pointer items-center transition-all duration-200 hover:bg-[var(--glass-bg-hover)] rounded-lg my-1 group", children: [_jsx("div", { className: "text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors", children: i + 1 }), _jsxs("div", { className: "font-medium truncate text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors", children: [_jsx("span", { children: track.title || track.path.split(/[\/\\]/).pop() }), ((track.artists && Array.isArray(track.artists) && track.artists.length > 0) || (track.artist && parseArtists(track.artist).length > 0)) && (_jsx("span", { className: "block text-xs text-[var(--color-text-muted)] mt-0.5", children: (Array.isArray(track.artists) && track.artists.length > 0 ? track.artists : parseArtists(track.artist || '')).map((a, i) => (_jsxs(React.Fragment, { children: [i > 0 && ' · ', _jsx("span", { className: "hover:text-[var(--color-primary)] cursor-pointer transition-colors", onClick: (e) => { e.stopPropagation(); navigateView('artist', a); }, children: a })] }, a))) }))] }), _jsx("div", { className: "text-[var(--color-text-muted)] text-right group-hover:text-[var(--color-text-primary)] transition-colors", children: track.duration ? `${Math.floor(track.duration / 60)}:${Math.floor(track.duration % 60).toString().padStart(2, '0')}` : '--:--' })] }, track.id)))] })] }));
};
