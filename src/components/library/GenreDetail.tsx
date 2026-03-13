import React, { useMemo, useState, useEffect } from 'react';
import { usePlayerStore } from '../../store/index';
import { TrackInfo } from '../../utils/fileSystem';
import { AlbumCard } from './AlbumCard';
import { fetchGenreImage } from '../../utils/externalImagery';

export const GenreDetail: React.FC = () => {
    const { library, selectedItem, navigateView, setPlaylist } = usePlayerStore();
    const genre = selectedItem;
    const [imageUrl, setImageUrl] = useState<string | undefined>();

    useEffect(() => {
        if (genre) {
            setImageUrl(undefined);
            fetchGenreImage(genre).then(url => {
                if (url) setImageUrl(url);
            });
        }
    }, [genre]);

    const genreTracks = useMemo(() => {
        return library.filter(t => (t as any).genre === genre);
    }, [library, genre]);

    // Group genre tracks by album
    const albums = useMemo(() => {
        const albumMap = new Map<string, { title: string, artist: string, artUrl?: string, tracks: TrackInfo[] }>();

        genreTracks.forEach(track => {
            const albumTitle = track.album || 'Unknown Album';
            const albumOwner = track.albumArtist || track.artist || 'Unknown Artist';
            const key = `${albumTitle}::::${albumOwner}`;
            if (!albumMap.has(key)) {
                albumMap.set(key, {
                    title: albumTitle,
                    artist: albumOwner,
                    artUrl: track.artUrl,
                    tracks: []
                });
            }
            albumMap.get(key)!.tracks.push(track);
        });

        return Array.from(albumMap.values()).sort((a, b) => a.title.localeCompare(b.title));
    }, [genreTracks]);

    if (!genre || genreTracks.length === 0) return <div>Genre not found or empty.</div>;

    return (
        <div className="genre-detail p-4 md:p-8 lg:p-12 overflow-y-auto flex-1 relative">
            {imageUrl && (
                <div 
                    className="absolute top-0 left-0 w-full h-[300px] md:h-[400px] z-0 opacity-40 mix-blend-overlay pointer-events-none"
                    style={{ background: `url(${imageUrl}) center/cover no-repeat`, maskImage: 'linear-gradient(to bottom, black 0%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 100%)' }}
                />
            )}
            <div className="relative z-10">
                <button
                    onClick={() => navigateView('home')}
                    className="font-medium text-sm md:text-base text-[var(--color-primary)] hover:text-[var(--color-primary-dark)] px-4 py-2 w-fit flex items-center gap-2 mb-8 md:mb-12 transition-all duration-200"
                >
                    ← Back to Library
                </button>

                <h1 className="font-bold text-4xl md:text-5xl lg:text-7xl tracking-tight mb-8 md:mb-12 text-[var(--color-primary)] shadow-black drop-shadow-md">
                    {genre}
                </h1>

                <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2">Albums in this Genre</h3>
                <div className="album-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6">
                    {albums.map(album => (
                        <AlbumCard
                            key={`${album.title}-${album.artist}`}
                            title={album.title}
                            artist={album.artist}
                            artUrl={album.artUrl}
                            subtitle={`${album.artist} · ${album.tracks.length} tracks`}
                            onOpen={() => navigateView('album', `${album.title}::::${album.artist}`)}
                            onPlay={() => setPlaylist(album.tracks, 0)}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
};
