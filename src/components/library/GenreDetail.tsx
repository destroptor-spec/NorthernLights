import React, { useMemo, useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { TrackInfo } from '../../utils/fileSystem';
import { AlbumCard, AlbumCardSkeleton } from './AlbumCard';
import { BackButton } from './BackButton';
import { FadedHeroImage } from './FadedHeroImage';
import { useExternalImage } from '../../hooks/useExternalImage';
import { fetchGenreImage, fetchGenreInfo } from '../../utils/externalImagery';
import { Music } from 'lucide-react';

export const GenreDetail: React.FC = () => {
    const { genreId } = useParams<{ genreId: string }>();
    const navigate = useNavigate();
    const { library, genres, setPlaylist } = usePlayerStore();

    // Find genre info from entity list
    const genreInfo = useMemo(() => genres.find(g => g.id === genreId), [genres, genreId]);
    const genreName = genreInfo?.name || '';

    const { imageUrl } = useExternalImage(() => genreName ? fetchGenreImage(genreName) : Promise.resolve(undefined), [genreName]);

    const [genreSummary, setGenreSummary] = useState<string | undefined>();
    const [summaryLoading, setSummaryLoading] = useState(false);

    useEffect(() => {
        if (genreName) {
            setGenreSummary(undefined);
            setSummaryLoading(true);
            fetchGenreInfo(genreName)
                .then(data => { if (data?.summary) setGenreSummary(data.summary); })
                .catch(() => {})
                .finally(() => setSummaryLoading(false));
        }
    }, [genreName]);

    const genreTracks = useMemo(() => {
        if (!genreName || !genreId) return [];
        const genreNameLower = genreName.toLowerCase();
        
        return library.filter(t => {
            if (t.genreId === genreId) return true;
            if (Array.isArray(t.genres)) {
                return t.genres.some(g => g.toLowerCase() === genreNameLower);
            }
            return t.genre?.toLowerCase() === genreNameLower;
        });
    }, [library, genreId, genreName]);

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

    if (!genreName || genreTracks.length === 0) return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <Music className="w-12 h-12 text-[var(--color-text-muted)] opacity-30 mb-4" />
            <p className="text-lg font-medium text-[var(--color-text-secondary)]">Genre not found</p>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">This genre may not have any tracks in your library.</p>
        </div>
    );

    return (
        <div className="genre-detail page-container relative">
            {imageUrl && <FadedHeroImage src={imageUrl} />}
            <div className="relative z-10">
                <BackButton onClick={() => navigate(-1)} />

                <h1 className="font-bold text-4xl md:text-5xl lg:text-7xl tracking-tight mb-4 md:mb-6 text-[var(--color-primary)] drop-shadow-md">
                    {genreName}
                </h1>
                {summaryLoading && (
                    <div className="max-w-3xl mb-6 md:mb-8 space-y-2">
                        <div className="h-4 w-full rounded bg-[var(--color-bg-tertiary)] animate-pulse" />
                        <div className="h-4 w-4/5 rounded bg-[var(--color-bg-tertiary)] animate-pulse" />
                        <div className="h-4 w-3/5 rounded bg-[var(--color-bg-tertiary)] animate-pulse" />
                    </div>
                )}
                {!summaryLoading && genreSummary && (
                    <p className="text-sm md:text-base text-[var(--color-text-secondary)] leading-relaxed max-w-3xl mb-6 md:mb-8 line-clamp-4 hover:line-clamp-none transition-all duration-300 motion-reduce:transition-none">
                        {genreSummary}
                    </p>
                )}

                <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2">
                    Albums in this Genre ({albums.length})
                </h3>
                {albums.length === 0 && !summaryLoading ? (
                    <div className="album-grid">
                        {Array.from({ length: 6 }).map((_, i) => <AlbumCardSkeleton key={i} />)}
                    </div>
                ) : (
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
                )}
            </div>
        </div>
    );
};
