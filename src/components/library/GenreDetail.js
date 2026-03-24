import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { AlbumCard } from './AlbumCard';
import { BackButton } from './BackButton';
import { FadedHeroImage } from './FadedHeroImage';
import { useExternalImage } from '../../hooks/useExternalImage';
import { fetchGenreImage } from '../../utils/externalImagery';
export const GenreDetail = () => {
    const { genreId } = useParams();
    const navigate = useNavigate();
    const { library, genres, setPlaylist } = usePlayerStore();
    // Find genre info from entity list
    const genreInfo = useMemo(() => genres.find(g => g.id === genreId), [genres, genreId]);
    const genreName = genreInfo?.name || '';
    const imageUrl = useExternalImage(() => genreName ? fetchGenreImage(genreName) : Promise.resolve(undefined), [genreName]);
    const genreTracks = useMemo(() => {
        if (!genreId)
            return [];
        return library.filter(t => t.genreId === genreId);
    }, [library, genreId]);
    // Group genre tracks by album
    const albums = useMemo(() => {
        const albumMap = new Map();
        genreTracks.forEach(track => {
            const albumTitle = track.album || 'Unknown Album';
            const albumOwner = track.albumArtist || track.artist || 'Unknown Artist';
            const key = track.albumId || `${albumTitle}::::${albumOwner}`;
            if (!albumMap.has(key)) {
                albumMap.set(key, {
                    title: albumTitle,
                    artist: albumOwner,
                    artUrl: track.artUrl,
                    albumId: track.albumId,
                    tracks: []
                });
            }
            albumMap.get(key).tracks.push(track);
        });
        return Array.from(albumMap.values()).sort((a, b) => a.title.localeCompare(b.title));
    }, [genreTracks]);
    if (!genreName || genreTracks.length === 0)
        return _jsx("div", { children: "Genre not found or empty." });
    return (_jsxs("div", { className: "genre-detail page-container relative", children: [imageUrl && _jsx(FadedHeroImage, { src: imageUrl }), _jsxs("div", { className: "relative z-10", children: [_jsx(BackButton, { onClick: () => navigate(-1) }), _jsx("h1", { className: "font-bold text-4xl md:text-5xl lg:text-7xl tracking-tight mb-8 md:mb-12 text-[var(--color-primary)] shadow-black drop-shadow-md", children: genreName }), _jsx("h3", { className: "font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2", children: "Albums in this Genre" }), _jsx("div", { className: "album-grid", children: albums.map(album => (_jsx(AlbumCard, { title: album.title, artist: album.artist, artUrl: album.artUrl, subtitle: `${album.artist} · ${album.tracks.length} tracks`, linkTo: album.albumId ? `/library/album/${album.albumId}` : undefined, onPlay: () => setPlaylist(album.tracks, 0) }, album.albumId || `${album.title}-${album.artist}`))) })] })] }));
};
