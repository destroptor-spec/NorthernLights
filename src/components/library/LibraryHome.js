import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState, useEffect } from 'react';
import { usePlayerStore } from '../../store/index';
import { AlbumCard } from './AlbumCard';
import { fetchArtistData, fetchGenreImage } from '../../utils/externalImagery';
const GenreCard = ({ genre, onClick }) => {
    const [imageUrl, setImageUrl] = useState();
    useEffect(() => {
        let mounted = true;
        fetchGenreImage(genre).then(url => {
            if (mounted && url)
                setImageUrl(url);
        });
        return () => { mounted = false; };
    }, [genre]);
    return (_jsxs("div", { onClick: onClick, className: "genre-card group flex flex-col items-center justify-center cursor-pointer transition-transform duration-300 hover:scale-105 relative overflow-hidden rounded-2xl aspect-video md:aspect-square bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)]", children: [imageUrl && (_jsxs("div", { className: "absolute inset-0 z-0", children: [_jsx("img", { src: imageUrl, alt: genre, className: "w-full h-full object-cover opacity-40 transition-transform duration-500 group-hover:scale-110" }), _jsx("div", { className: "absolute inset-0 bg-black/40 mix-blend-multiply" })] })), _jsx("div", { className: "relative z-10 p-4 w-full flex items-center justify-center h-full", children: _jsx("div", { className: "font-bold text-xl md:text-2xl text-[var(--color-primary)] text-center shadow-black drop-shadow-lg filter group-hover:scale-110 transition-transform", children: genre }) })] }));
};
const ArtistCard = ({ artist, onClick }) => {
    const [imageUrl, setImageUrl] = useState();
    useEffect(() => {
        let mounted = true;
        fetchArtistData(artist).then(data => {
            if (mounted && data.imageUrl)
                setImageUrl(data.imageUrl);
        });
        return () => { mounted = false; };
    }, [artist]);
    return (_jsxs("div", { onClick: onClick, className: "artist-card group flex flex-col items-center cursor-pointer transition-transform duration-300 hover:scale-105", children: [_jsx("div", { className: "w-full aspect-square rounded-full overflow-hidden shadow-[var(--shadow-sm)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)] mb-4 flex items-center justify-center transition-all duration-300 group-hover:border-[var(--color-primary)] group-hover:shadow-[var(--shadow-md)]", children: imageUrl ? (_jsx("img", { src: imageUrl, alt: artist, className: "w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" })) : (_jsx("span", { className: "text-4xl md:text-5xl text-[var(--color-primary)] opacity-50 group-hover:opacity-100 transition-opacity", children: artist.charAt(0) })) }), _jsx("div", { className: "font-bold text-base md:text-lg text-center text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors truncate w-full px-2", children: artist })] }));
};
export const LibraryHome = () => {
    const library = usePlayerStore(state => state.library);
    const navigateView = usePlayerStore(state => state.navigateView);
    const setPlaylist = usePlayerStore(state => state.setPlaylist);
    const currentView = usePlayerStore(state => state.currentView);
    // Derive unique Albums, Artists, and Genres from the library
    const { albums, artists, genres } = useMemo(() => {
        const albumMap = new Map();
        const artistSet = new Set();
        const genreSet = new Set();
        library.forEach((track) => {
            // Album
            if (track.album) {
                const albumArtist = track.albumArtist || track.artist || 'Unknown Artist';
                const key = `${track.album}-${albumArtist}`;
                if (!albumMap.has(key)) {
                    albumMap.set(key, {
                        title: track.album,
                        artist: albumArtist,
                        artUrl: track.artUrl,
                        trackCount: 1
                    });
                }
                else {
                    albumMap.get(key).trackCount++;
                }
            }
            // Artist
            if (track.artists && Array.isArray(track.artists)) {
                track.artists.forEach(a => artistSet.add(a));
            }
            else if (track.artist) {
                artistSet.add(track.artist);
            }
            // Genre
            // Extract from any generic property if added later, falling back to empty for now
            if (track.genre) {
                genreSet.add(track.genre);
            }
        });
        return {
            albums: Array.from(albumMap.values()).sort((a, b) => a.title.localeCompare(b.title)),
            artists: Array.from(artistSet).sort((a, b) => a.localeCompare(b)),
            genres: Array.from(genreSet).sort(),
        };
    }, [library]);
    if (library.length === 0) {
        return null; // Handled by App.tsx empty state
    }
    return (_jsxs("div", { className: "library-home p-4 md:p-8 lg:p-12 overflow-y-auto flex-1", children: [_jsx("div", { className: "flex gap-3 mb-8 md:mb-10", children: ['artists', 'albums', 'genres'].map(tab => {
                    const isActive = currentView === tab;
                    return (_jsx("button", { onClick: () => navigateView(tab), className: `
                                capitalize font-semibold text-sm px-5 py-2 rounded-full
                                border backdrop-blur-md
                                transition-all duration-200 cursor-pointer
                                active:scale-95
                                ${isActive
                            ? 'text-white border-purple-500/50 shadow-[0_0_18px_rgba(139,92,246,0.4)] hover:shadow-[0_0_24px_rgba(139,92,246,0.55)] hover:brightness-110'
                            : 'text-[var(--color-text-secondary)] border-[var(--color-border)] bg-black/5 dark:bg-white/[0.06] hover:bg-black/10 dark:hover:bg-white/[0.12] hover:text-[var(--color-text-primary)] hover:border-[var(--glass-border-hover)]'}
                            `, style: isActive ? {
                            background: 'linear-gradient(145deg, rgba(139, 92, 246, 0.85), rgba(109, 40, 217, 0.9))',
                            border: '1px solid rgba(168, 85, 247, 0.5)',
                            boxShadow: '0 0 18px rgba(139, 92, 246, 0.4), inset 0 1px 0 rgba(255,255,255,0.15)',
                        } : {}, children: tab }, tab));
                }) }), _jsxs("div", { className: "library-sections", children: [(currentView === 'albums' || currentView === 'home') && (_jsx("section", { className: "library-section mb-8 md:mb-12", children: _jsx("div", { className: "album-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6", children: albums.map(album => {
                                const albumTracks = library.filter(t => t.album === album.title && (t.albumArtist || t.artist) === album.artist).sort((a, b) => (a.trackNumber ?? 999) - (b.trackNumber ?? 999));
                                return (_jsx(AlbumCard, { title: album.title, artist: album.artist, artUrl: album.artUrl, subtitle: album.artist, onOpen: () => navigateView('album', `${album.title}::::${album.artist}`), onPlay: (e) => { if (albumTracks.length)
                                        setPlaylist(albumTracks, 0); } }, `${album.title}-${album.artist}`));
                            }) }) })), (currentView === 'artists') && (_jsx("section", { className: "library-section mb-8 md:mb-12", children: _jsx("div", { className: "artist-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6", children: artists.map(artist => (_jsx(ArtistCard, { artist: artist, onClick: () => navigateView('artist', artist) }, artist))) }) })), (currentView === 'genres') && (_jsx("section", { className: "library-section", children: genres.length === 0 ? (_jsx("p", { style: { color: 'var(--color-text-muted)' }, children: "No genres found in your library." })) : (_jsx("div", { className: "genre-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6", children: genres.map(genre => (_jsx(GenreCard, { genre: genre, onClick: () => navigateView('genre', genre) }, genre))) })) }))] })] }));
};
