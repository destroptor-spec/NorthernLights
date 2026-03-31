import React, { useMemo, useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { TrackInfo } from '../../utils/fileSystem';
import { AlbumCard } from './AlbumCard';
import { BackButton } from './BackButton';
import { FadedHeroImage } from './FadedHeroImage';
import { useExternalImage } from '../../hooks/useExternalImage';
import { fetchGenreImage, fetchGenreInfo } from '../../utils/externalImagery';

export const GenreDetail: React.FC = () => {
    const { genreId } = useParams<{ genreId: string }>();
    const navigate = useNavigate();
    const { library, genres, setPlaylist } = usePlayerStore();

    // Find genre info from entity list
    const genreInfo = useMemo(() => genres.find(g => g.id === genreId), [genres, genreId]);
    const genreName = genreInfo?.name || '';

    const { imageUrl } = useExternalImage(() => genreName ? fetchGenreImage(genreName) : Promise.resolve(undefined), [genreName]);

    const [genreSummary, setGenreSummary] = useState<string | undefined>();

    useEffect(() => {
        if (genreName) {
            setGenreSummary(undefined);
            fetchGenreInfo(genreName)
                .then(data => { if (data?.summary) setGenreSummary(data.summary); })
                .catch(() => {});
        }
    }, [genreName]);

    const genreTracks = useMemo(() => {
        if (!genreId) return [];
        return library.filter(t => t.genreId === genreId);
    }, [library, genreId]);

    // Group genre tracks by album
    const albums = useMemo(() => {
        const albumMap = new Map<string, { title: string, artist: string, artUrl?: string, albumId?: string, tracks: TrackInfo[] }>();

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
            albumMap.get(key)!.tracks.push(track);
        });

        return Array.from(albumMap.values()).sort((a, b) => a.title.localeCompare(b.title));
    }, [genreTracks]);

    if (!genreName || genreTracks.length === 0) return <div>Genre not found or empty.</div>;

    return (
        <div className="genre-detail page-container relative">
            {imageUrl && <FadedHeroImage src={imageUrl} />}
            <div className="relative z-10">
                <BackButton onClick={() => navigate(-1)} />

                <h1 className="font-bold text-4xl md:text-5xl lg:text-7xl tracking-tight mb-4 md:mb-6 text-[var(--color-primary)] shadow-black drop-shadow-md">
                    {genreName}
                </h1>
                {genreSummary && (
                    <p className="text-sm md:text-base text-[var(--color-text-secondary)] leading-relaxed max-w-3xl mb-6 md:mb-8 line-clamp-4 hover:line-clamp-none transition-all duration-300">
                        {genreSummary}
                    </p>
                )}

                <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2">Albums in this Genre</h3>
                <div className="album-grid">
                    {albums.map(album => (
                        <AlbumCard
                            key={album.albumId || `${album.title}-${album.artist}`}
                            title={album.title}
                            artist={album.artist}
                            artUrl={album.artUrl}
                            subtitle={`${album.artist} · ${album.tracks.length} tracks`}
                            linkTo={album.albumId ? `/library/album/${album.albumId}` : undefined}
                            onPlay={() => setPlaylist(album.tracks, 0)}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
};
