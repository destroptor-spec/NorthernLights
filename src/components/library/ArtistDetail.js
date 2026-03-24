import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo, useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { trackMatchesArtist } from '../../utils/artistUtils';
import { fetchArtistData } from '../../utils/externalImagery';
import { AlbumCard } from './AlbumCard';
import { BackButton } from './BackButton';
import { FadedHeroImage } from './FadedHeroImage';
import { ArtistInitial } from './ArtistInitial';
export const ArtistDetail = () => {
    const { artistId } = useParams();
    const navigate = useNavigate();
    const { library, artists, setPlaylist } = usePlayerStore();
    // Find artist info from entity list
    const artistInfo = useMemo(() => artists.find(a => a.id === artistId), [artists, artistId]);
    const artistName = artistInfo?.name || '';
    const [artistData, setArtistData] = useState({});
    useEffect(() => {
        if (artistName) {
            setArtistData({});
            fetchArtistData(artistName).then(data => setArtistData(data));
        }
    }, [artistName]);
    // Tracks where this artist is the PRIMARY / album artist
    const primaryTracks = useMemo(() => {
        if (!artistName)
            return [];
        return library.filter(t => t.artistId === artistId);
    }, [library, artistId, artistName]);
    // Tracks where this artist APPEARS but is NOT the album owner
    const featuredTracks = useMemo(() => {
        if (!artistName)
            return [];
        const artistLower = artistName.toLowerCase();
        return library.filter(t => {
            const albumOwner = (t.albumArtist || t.artist || '').toLowerCase();
            if (albumOwner === artistLower)
                return false;
            if (Array.isArray(t.artists)) {
                return t.artists.some(a => a.toLowerCase() === artistLower);
            }
            return trackMatchesArtist(t.artist, artistName);
        });
    }, [library, artistName]);
    const buildReleaseGroups = (tracks) => {
        const albumMap = new Map();
        tracks.forEach(track => {
            const albumTitle = track.album || 'Unknown Album';
            const albumOwner = track.albumArtist || track.artist || 'Unknown Artist';
            const key = track.albumId || `${albumTitle}::::${albumOwner}`;
            if (!albumMap.has(key)) {
                let rType = 'Album';
                const rawType = (track.releaseType || '').toLowerCase();
                if (track.isCompilation || rawType.includes('compilation'))
                    rType = 'Compilation';
                else if (rawType.includes('ep'))
                    rType = 'EP';
                else if (rawType.includes('single'))
                    rType = 'Single';
                albumMap.set(key, {
                    title: albumTitle,
                    artist: albumOwner,
                    artUrl: track.artUrl,
                    albumId: track.albumId,
                    type: rType,
                    tracks: []
                });
            }
            albumMap.get(key).tracks.push(track);
        });
        const all = Array.from(albumMap.values()).sort((a, b) => a.title.localeCompare(b.title));
        return {
            albums: all.filter(r => r.type === 'Album'),
            eps: all.filter(r => r.type === 'EP'),
            singles: all.filter(r => r.type === 'Single'),
            compilations: all.filter(r => r.type === 'Compilation'),
        };
    };
    const releaseGroups = useMemo(() => buildReleaseGroups(primaryTracks), [primaryTracks]);
    const featuredGroups = useMemo(() => buildReleaseGroups(featuredTracks), [featuredTracks]);
    const hasAnyContent = primaryTracks.length > 0 || featuredTracks.length > 0;
    if (!artistName || !hasAnyContent)
        return _jsx("div", { children: "Artist not found." });
    return (_jsxs("div", { className: "artist-detail page-container relative", children: [artistData.imageUrl && _jsx(FadedHeroImage, { src: artistData.imageUrl }), _jsxs("div", { className: "relative z-10", children: [_jsx(BackButton, { onClick: () => navigate(-1) }), _jsxs("div", { className: "flex flex-col md:flex-row gap-8 items-start mb-8 md:mb-12", children: [artistData.imageUrl ? (_jsx("div", { className: "w-48 h-48 md:w-64 md:h-64 rounded-full overflow-hidden shrink-0 shadow-[var(--shadow-md)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)]", children: _jsx("img", { src: artistData.imageUrl, alt: artistName, className: "w-full h-full object-cover" }) })) : (_jsx("div", { className: "w-48 h-48 md:w-64 md:h-64 rounded-full overflow-hidden shrink-0 shadow-[var(--shadow-md)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)] flex items-center justify-center", children: _jsx(ArtistInitial, { name: artistName }) })), _jsxs("div", { className: "flex-1", children: [_jsx("h1", { className: "font-bold text-4xl md:text-6xl lg:text-7xl tracking-tight mb-4 text-[var(--color-text-primary)]", children: artistName }), artistData.bio && (_jsx("p", { className: "text-sm md:text-base text-[var(--color-text-secondary)] leading-relaxed max-w-3xl line-clamp-4 hover:line-clamp-none transition-all duration-300", children: artistData.bio }))] })] }), [
                        { title: 'Albums', data: releaseGroups.albums },
                        { title: 'EPs', data: releaseGroups.eps },
                        { title: 'Singles', data: releaseGroups.singles },
                        { title: 'Compilations', data: releaseGroups.compilations }
                    ].map((section) => section.data.length > 0 && (_jsxs("div", { className: "mb-12", children: [_jsx("h3", { className: "font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2", children: section.title }), _jsx("div", { className: "album-grid", children: section.data.map(album => (_jsx(AlbumCard, { title: album.title, artist: album.artist, artUrl: album.artUrl, subtitle: `${album.tracks.length} track${album.tracks.length !== 1 ? 's' : ''}`, linkTo: album.albumId ? `/library/album/${album.albumId}` : undefined, onPlay: () => setPlaylist(album.tracks, 0) }, album.albumId || `${album.title}-${album.artist}`))) })] }, section.title))), [
                        ...featuredGroups.albums,
                        ...featuredGroups.eps,
                        ...featuredGroups.singles,
                        ...featuredGroups.compilations,
                    ].length > 0 && (_jsxs("div", { className: "mb-12", children: [_jsxs("h3", { className: "font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2 flex items-center gap-2", children: [_jsx("span", { className: "text-[var(--color-primary)] opacity-60", children: "\u2726" }), " Also appears on"] }), _jsx("div", { className: "album-grid", children: [
                                    ...featuredGroups.albums,
                                    ...featuredGroups.eps,
                                    ...featuredGroups.singles,
                                    ...featuredGroups.compilations,
                                ].map(album => (_jsx(AlbumCard, { title: album.title, artist: album.artist, artUrl: album.artUrl, subtitle: album.artist, linkTo: album.albumId ? `/library/album/${album.albumId}` : undefined, onPlay: () => setPlaylist(album.tracks, 0) }, `feat-${album.albumId || `${album.title}-${album.artist}`}`))) })] }))] })] }));
};
