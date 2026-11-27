import React, { useMemo, useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { useApiV1EntityTracks } from '../../hooks/useApiV1TrackList';
import { TrackInfo } from '../../utils/fileSystem';
import { AlbumCard } from './AlbumCard';
import { BackButton } from './BackButton';
import { FadedHeroImage } from './FadedHeroImage';
import { useExternalImage } from '../../hooks/useExternalImage';
import { fetchGenreImage, fetchGenreInfo } from '../../utils/externalImagery';
import { Music } from 'lucide-react';

import { GenreLoading, genreHeadingClass } from '../DetailRouteLoading';

export const GenreDetail: React.FC = () => {
    const { genreId } = useParams<{ genreId: string }>();
    const navigate = useNavigate();
    const { genres, setPlaylist } = usePlayerStore();

    // Find genre info from entity list
    const genreInfo = useMemo(() => genres.find(g => g.id === genreId), [genres, genreId]);

    // Tracks come from the canonical primary + secondary association endpoint,
    // not from raw-tag substring matching or the in-memory library.
    const { tracks: genreTracks, meta, failure, retry, loading: genreTracksLoading } = useApiV1EntityTracks<{ genre: { name: string } }>(
        genreId ? `/genres/${encodeURIComponent(genreId)}` : null,
    );

    const genreName = genreInfo?.name || meta?.genre.name || '';
    const { imageUrl } = useExternalImage(() => genreName ? fetchGenreImage(genreName) : Promise.resolve(undefined), [genreName]);

    const [summary, setSummary] = useState<{ name: string; text: string }>();
    useEffect(() => {
        if (!genreName) return;
        let active = true;
        fetchGenreInfo(genreName).then(data => {
            if (active && data?.summary) setSummary({ name: genreName, text: data.summary });
        }).catch(() => {});
        return () => { active = false; };
    }, [genreName]);

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

    if (failure === 'failed') return (
        <div className="page-container">
            <BackButton onClick={() => navigate(-1)} />
            <p>Could not load this genre.</p>
            <button className="btn btn-ghost btn-sm mt-3" onClick={retry}>Retry</button>
        </div>
    );

    if (genreTracksLoading && genreTracks.length === 0) {
        return <GenreLoading />;
    }

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

                <h1 className={genreHeadingClass}>
                    {genreName}
                </h1>
                <h2 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2">
                    Albums in this Genre ({albums.length})
                </h2>
                <div className="album-grid">
                    {albums.map(album => (
                        <AlbumCard
                            key={album.albumId || `${album.title}-${album.artist}`}
                            title={album.title}
                            artist={album.artist}
                            artUrl={album.artUrl}
                            subtitle={`${album.artist} · ${album.tracks.length} tracks`}
                            linkTo={album.albumId ? `/library/album/${album.albumId}` : undefined}
                            albumId={album.albumId || undefined}
                            linkState={{ backLabel: 'Back to Genre' }}
                            onPlay={() => setPlaylist(album.tracks, 0)}
                        />
                    ))}
                </div>
                {summary?.name === genreName && (
                    <p className="mt-6 max-w-3xl text-sm md:text-base text-[var(--color-text-secondary)] leading-relaxed">
                        {summary.text}
                    </p>
                )}
            </div>
        </div>
    );
};
