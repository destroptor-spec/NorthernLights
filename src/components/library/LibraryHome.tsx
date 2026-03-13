import React, { useMemo, useState, useEffect } from 'react';
import { usePlayerStore } from '../../store/index';
import { TrackInfo } from '../../utils/fileSystem';
import { AlbumArt } from '../AlbumArt';
import { AlbumCard } from './AlbumCard';
import { fetchArtistData, fetchGenreImage } from '../../utils/externalImagery';

const GenreCard: React.FC<{ genre: string, onClick: () => void }> = ({ genre, onClick }) => {
    const [imageUrl, setImageUrl] = useState<string | undefined>();

    useEffect(() => {
        let mounted = true;
        fetchGenreImage(genre).then(url => {
            if (mounted && url) setImageUrl(url);
        });
        return () => { mounted = false; };
    }, [genre]);

    return (
        <div
            onClick={onClick}
            className="genre-card group flex flex-col items-center justify-center cursor-pointer transition-transform duration-300 hover:scale-105 relative overflow-hidden rounded-2xl aspect-video md:aspect-square bg-[var(--glass-bg)] border border-[var(--glass-border)] shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)]"
        >
            {imageUrl && (
                <div className="absolute inset-0 z-0">
                    <img src={imageUrl} alt={genre} className="w-full h-full object-cover opacity-40 transition-transform duration-500 group-hover:scale-110" />
                    <div className="absolute inset-0 bg-black/40 mix-blend-multiply" />
                </div>
            )}
            <div className="relative z-10 p-4 w-full flex items-center justify-center h-full">
                <div className="font-bold text-xl md:text-2xl text-[var(--color-primary)] text-center shadow-black drop-shadow-lg filter group-hover:scale-110 transition-transform">{genre}</div>
            </div>
        </div>
    );
};

const ArtistCard: React.FC<{ artist: string, onClick: () => void }> = ({ artist, onClick }) => {
    const [imageUrl, setImageUrl] = useState<string | undefined>();

    useEffect(() => {
        let mounted = true;
        fetchArtistData(artist).then(data => {
            if (mounted && data.imageUrl) setImageUrl(data.imageUrl);
        });
        return () => { mounted = false; };
    }, [artist]);

    return (
        <div
            onClick={onClick}
            className="artist-card group flex flex-col items-center cursor-pointer transition-transform duration-300 hover:scale-105"
        >
            <div className="w-full aspect-square rounded-full overflow-hidden shadow-[var(--shadow-sm)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)] mb-4 flex items-center justify-center transition-all duration-300 group-hover:border-[var(--color-primary)] group-hover:shadow-[var(--shadow-md)]">
                {imageUrl ? (
                    <img src={imageUrl} alt={artist} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" />
                ) : (
                    <span className="text-4xl md:text-5xl text-[var(--color-primary)] opacity-50 group-hover:opacity-100 transition-opacity">{artist.charAt(0)}</span>
                )}
            </div>
            <div className="font-bold text-base md:text-lg text-center text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors truncate w-full px-2">{artist}</div>
        </div>
    );
};

export const LibraryHome: React.FC = () => {
    const library = usePlayerStore(state => state.library);
    const navigateView = usePlayerStore(state => state.navigateView);
    const setPlaylist = usePlayerStore(state => state.setPlaylist);

    const currentView = usePlayerStore(state => state.currentView);

    // Derive unique Albums, Artists, and Genres from the library
    const { albums, artists, genres } = useMemo(() => {
        const albumMap = new Map<string, { title: string, artist: string, artUrl?: string, trackCount: number }>();
        const artistSet = new Set<string>();
        const genreSet = new Set<string>();

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
                } else {
                    albumMap.get(key)!.trackCount++;
                }
            }

            // Artist
            if (track.artists && Array.isArray(track.artists)) {
                track.artists.forEach(a => artistSet.add(a));
            } else if (track.artist) {
                artistSet.add(track.artist);
            }

            // Genre
            // Extract from any generic property if added later, falling back to empty for now
            if ((track as any).genre) {
                genreSet.add((track as any).genre);
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

    return (
        <div className="library-home p-4 md:p-8 lg:p-12 overflow-y-auto flex-1">
            
            <div className="flex gap-3 mb-8 md:mb-10">
                {['artists', 'albums', 'genres'].map(tab => {
                    const isActive = currentView === tab;
                    return (
                        <button
                            key={tab}
                            onClick={() => navigateView(tab as any)}
                            className={`
                                capitalize font-semibold text-sm px-5 py-2 rounded-full
                                border backdrop-blur-md
                                transition-all duration-200 cursor-pointer
                                active:scale-95
                                ${isActive
                                    ? 'text-white border-purple-500/50 shadow-[0_0_18px_rgba(139,92,246,0.4)] hover:shadow-[0_0_24px_rgba(139,92,246,0.55)] hover:brightness-110'
                                    : 'text-[var(--color-text-secondary)] border-[var(--color-border)] bg-black/5 dark:bg-white/[0.06] hover:bg-black/10 dark:hover:bg-white/[0.12] hover:text-[var(--color-text-primary)] hover:border-[var(--glass-border-hover)]'
                                }
                            `}
                            style={isActive ? {
                                background: 'linear-gradient(145deg, rgba(139, 92, 246, 0.85), rgba(109, 40, 217, 0.9))',
                                border: '1px solid rgba(168, 85, 247, 0.5)',
                                boxShadow: '0 0 18px rgba(139, 92, 246, 0.4), inset 0 1px 0 rgba(255,255,255,0.15)',
                            } : {}}
                        >
                            {tab}
                        </button>
                    );
                })}
            </div>

            <div className="library-sections">
                {(currentView === 'albums' || currentView === 'home') && (
                    <section className="library-section mb-8 md:mb-12">
                        <div className="album-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6">
                            {albums.map(album => {
                                const albumTracks = library.filter(t =>
                                    t.album === album.title && (t.albumArtist || t.artist) === album.artist
                                ).sort((a, b) => (a.trackNumber ?? 999) - (b.trackNumber ?? 999));
                                return (
                                    <AlbumCard
                                        key={`${album.title}-${album.artist}`}
                                        title={album.title}
                                        artist={album.artist}
                                        artUrl={album.artUrl}
                                        subtitle={album.artist}
                                        onOpen={() => navigateView('album', `${album.title}::::${album.artist}`)}
                                        onPlay={(e) => { if (albumTracks.length) setPlaylist(albumTracks, 0); }}
                                    />
                                );
                            })}
                        </div>
                    </section>
                )}

                {(currentView === 'artists') && (
                    <section className="library-section mb-8 md:mb-12">
                        <div className="artist-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6">
                            {artists.map(artist => (
                                <ArtistCard key={artist} artist={artist} onClick={() => navigateView('artist', artist)} />
                            ))}
                        </div>
                    </section>
                )}

                {(currentView === 'genres') && (
                    <section className="library-section">
                        {genres.length === 0 ? (
                           <p style={{ color: 'var(--color-text-muted)' }}>No genres found in your library.</p> 
                        ) : (
                            <div className="genre-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6">
                                {genres.map(genre => (
                                    <GenreCard key={genre} genre={genre} onClick={() => navigateView('genre', genre)} />
                                ))}
                            </div>
                        )}
                    </section>
                )}
            </div>
        </div>
    );
};
