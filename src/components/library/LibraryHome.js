import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { AlbumCard } from './AlbumCard';
import { ArtistInitial } from './ArtistInitial';
import { useExternalImage } from '../../hooks/useExternalImage';
import { fetchArtistData, fetchGenreImage } from '../../utils/externalImagery';
const GenreCard = ({ genre }) => {
    const imageUrl = useExternalImage(() => fetchGenreImage(genre), [genre]);
    return (_jsxs("div", { className: "genre-card group flex flex-col items-center justify-center cursor-pointer transition-transform duration-300 hover:scale-105 relative overflow-hidden rounded-2xl aspect-video md:aspect-square bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)]", children: [imageUrl && (_jsxs("div", { className: "absolute inset-0 z-0", children: [_jsx("img", { src: imageUrl, alt: genre, className: "w-full h-full object-cover opacity-40 transition-transform duration-500 group-hover:scale-110" }), _jsx("div", { className: "absolute inset-0 bg-black/40 mix-blend-multiply" })] })), _jsx("div", { className: "relative z-10 p-4 w-full flex items-center justify-center h-full", children: _jsx("div", { className: "font-bold text-xl md:text-2xl text-[var(--color-primary)] text-center shadow-black drop-shadow-lg filter group-hover:scale-110 transition-transform", children: genre }) })] }));
};
const ArtistCard = ({ artist }) => {
    const imageUrl = useExternalImage(() => fetchArtistData(artist).then(d => d.imageUrl), [artist]);
    return (_jsxs("div", { className: "artist-card group flex flex-col items-center cursor-pointer transition-transform duration-300 hover:scale-105", children: [_jsx("div", { className: "w-full aspect-square rounded-full overflow-hidden shadow-[var(--shadow-sm)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)] mb-4 flex items-center justify-center transition-all duration-300 group-hover:border-[var(--color-primary)] group-hover:shadow-[var(--shadow-md)]", children: imageUrl ? (_jsx("img", { src: imageUrl, alt: artist, className: "w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" })) : (_jsx(ArtistInitial, { name: artist, className: "text-4xl md:text-5xl text-[var(--color-primary)] opacity-50 group-hover:opacity-100 transition-opacity" })) }), _jsx("div", { className: "font-bold text-base md:text-lg text-center text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors truncate w-full px-2", children: artist })] }));
};
export const LibraryHome = ({ section }) => {
    const library = usePlayerStore(state => state.library);
    const artistEntities = usePlayerStore(state => state.artists);
    const albumEntities = usePlayerStore(state => state.albums);
    const genreEntities = usePlayerStore(state => state.genres);
    const setPlaylist = usePlayerStore(state => state.setPlaylist);
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
    // Determine which sections to show
    const showAlbums = !section || section === 'albums';
    const showArtists = section === 'artists';
    const showGenres = section === 'genres';
    return (_jsx("div", { className: "library-home page-container", children: _jsxs("div", { className: "library-sections", children: [showAlbums && (_jsx("section", { className: "library-section mb-8 md:mb-12", children: _jsx("div", { className: "album-grid", children: albums.map(album => {
                            const albumTracks = library.filter(t => t.album === album.title);
                            // We don't need to filter by artist here because we pass the albumId which does the tight filtering in AlbumDetail.
                            // But for the direct play button on the card, we want just *this* album's tracks:
                            const explicitTracks = albumTracks.filter(t => {
                                if (t.albumArtist)
                                    return t.albumArtist === album.artist;
                                if (album.artist === 'Various Artists')
                                    return !t.albumArtist;
                                return (t.artist || 'Unknown Artist') === album.artist && !t.albumArtist;
                            }).sort((a, b) => (a.trackNumber ?? 999) - (b.trackNumber ?? 999));
                            // Resolve album ID from entity list
                            const entity = albumEntities.find((a) => a.title === album.title && (a.artist_name || '') === (album.artist || ''));
                            const albumId = entity?.id;
                            return (_jsx(AlbumCard, { title: album.title, artist: album.artist, artUrl: album.artUrl, subtitle: album.artist, onPlay: (e) => { if (explicitTracks.length)
                                    setPlaylist(explicitTracks, 0); }, linkTo: albumId ? `/library/album/${albumId}` : undefined }, `${album.title}-${album.artist}`));
                        }) }) })), showArtists && (_jsx("section", { className: "library-section mb-8 md:mb-12", children: _jsx("div", { className: "artist-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6", children: artists.map(artistName => {
                            const entity = artistEntities.find((a) => a.name?.toLowerCase() === artistName.toLowerCase());
                            if (!entity)
                                return _jsx(ArtistCard, { artist: artistName }, artistName);
                            return (_jsx(Link, { to: `/library/artist/${entity.id}`, className: "no-underline", children: _jsx(ArtistCard, { artist: artistName }) }, artistName));
                        }) }) })), showGenres && (_jsx("section", { className: "library-section", children: genres.length === 0 ? (_jsx("p", { style: { color: 'var(--color-text-muted)' }, children: "No genres found in your library." })) : (_jsx("div", { className: "genre-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6", children: genres.map(genreName => {
                            const entity = genreEntities.find((g) => g.name?.toLowerCase() === genreName.toLowerCase());
                            if (!entity)
                                return _jsx(GenreCard, { genre: genreName }, genreName);
                            return (_jsx(Link, { to: `/library/genre/${entity.id}`, className: "no-underline", children: _jsx(GenreCard, { genre: genreName }) }, genreName));
                        }) })) }))] }) }));
};
