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
        const albumGroups = new Map();
        const artistSet = new Set();
        const genreSet = new Set();
        library.forEach((track) => {
            // Album Grouping - Pass 1
            if (track.album) {
                const group = albumGroups.get(track.album) || [];
                group.push(track);
                albumGroups.set(track.album, group);
            }
            // Artist
            if (track.artists && Array.isArray(track.artists)) {
                track.artists.forEach(a => artistSet.add(a));
            }
            else if (track.artist) {
                artistSet.add(track.artist);
            }
            // Genre
            if (track.genre) {
                genreSet.add(track.genre);
            }
        });
        // Album Grouping - Pass 2 (Partition by AlbumArtist, or collapse to Various Artists)
        const finalAlbums = [];
        for (const [albumTitle, tracks] of albumGroups.entries()) {
            const subAlbums = new Map();
            tracks.forEach(track => {
                const explicitAA = track.albumArtist || '';
                const subGroup = subAlbums.get(explicitAA) || [];
                subGroup.push(track);
                subAlbums.set(explicitAA, subGroup);
            });
            for (const [explicitAA, subTracks] of subAlbums.entries()) {
                if (explicitAA !== '') {
                    finalAlbums.push({
                        title: albumTitle,
                        artist: explicitAA,
                        artUrl: subTracks.find(t => t.artUrl)?.artUrl,
                        trackCount: subTracks.length
                    });
                }
                else {
                    const uniqueArtists = new Set(subTracks.map(t => t.artist || 'Unknown Artist'));
                    if (uniqueArtists.size === 1) {
                        finalAlbums.push({
                            title: albumTitle,
                            artist: Array.from(uniqueArtists)[0],
                            artUrl: subTracks.find(t => t.artUrl)?.artUrl,
                            trackCount: subTracks.length
                        });
                    }
                    else {
                        finalAlbums.push({
                            title: albumTitle,
                            artist: 'Various Artists',
                            artUrl: subTracks.find(t => t.artUrl)?.artUrl,
                            trackCount: subTracks.length
                        });
                    }
                }
            }
        }
        return {
            albums: finalAlbums.sort((a, b) => a.title.localeCompare(b.title)),
            artists: Array.from(artistSet).sort((a, b) => a.localeCompare(b)),
            genres: Array.from(genreSet).sort(),
        };
    }, [library]);
    if (library.length === 0) {
        return null; // Handled by App.tsx empty state
    }
    return (_jsx("div", { className: "library-home p-4 md:p-8 lg:p-12 overflow-y-auto flex-1", children: _jsxs("div", { className: "library-sections", children: [(currentView === 'albums' || currentView === 'home') && (_jsx("section", { className: "library-section mb-8 md:mb-12", children: _jsx("div", { className: "album-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6", children: albums.map(album => {
                            const albumTracks = library.filter(t => t.album === album.title);
                            // We don't need to filter by artist here because we pass navigateView('album', ...) which does the tight filtering in AlbumDetail.
                            // But for the direct play button on the card, we want just *this* album's tracks:
                            const explicitTracks = albumTracks.filter(t => {
                                if (t.albumArtist)
                                    return t.albumArtist === album.artist;
                                if (album.artist === 'Various Artists')
                                    return !t.albumArtist;
                                return (t.artist || 'Unknown Artist') === album.artist && !t.albumArtist;
                            }).sort((a, b) => (a.trackNumber ?? 999) - (b.trackNumber ?? 999));
                            return (_jsx(AlbumCard, { title: album.title, artist: album.artist, artUrl: album.artUrl, subtitle: album.artist, onOpen: () => navigateView('album', `${album.title}::::${album.artist}`), onPlay: (e) => { if (explicitTracks.length)
                                    setPlaylist(explicitTracks, 0); } }, `${album.title}-${album.artist}`));
                        }) }) })), (currentView === 'artists') && (_jsx("section", { className: "library-section mb-8 md:mb-12", children: _jsx("div", { className: "artist-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6", children: artists.map(artist => (_jsx(ArtistCard, { artist: artist, onClick: () => navigateView('artist', artist) }, artist))) }) })), (currentView === 'genres') && (_jsx("section", { className: "library-section", children: genres.length === 0 ? (_jsx("p", { style: { color: 'var(--color-text-muted)' }, children: "No genres found in your library." })) : (_jsx("div", { className: "genre-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6", children: genres.map(genre => (_jsx(GenreCard, { genre: genre, onClick: () => navigateView('genre', genre) }, genre))) })) }))] }) }));
};
