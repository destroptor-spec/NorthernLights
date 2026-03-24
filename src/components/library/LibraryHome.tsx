import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { TrackInfo } from '../../utils/fileSystem';
import { AlbumArt } from '../AlbumArt';
import { AlbumCard } from './AlbumCard';
import { ArtistInitial } from './ArtistInitial';
import { useExternalImage } from '../../hooks/useExternalImage';
import { fetchArtistData, fetchGenreImage } from '../../utils/externalImagery';

const GenreCard: React.FC<{ genre: string }> = ({ genre }) => {
    const imageUrl = useExternalImage(() => fetchGenreImage(genre), [genre]);

    return (
        <div
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

const ArtistCard: React.FC<{ artist: string }> = ({ artist }) => {
    const imageUrl = useExternalImage(() => fetchArtistData(artist).then(d => d.imageUrl), [artist]);

    return (
        <div
            className="artist-card group flex flex-col items-center cursor-pointer transition-transform duration-300 hover:scale-105"
        >
            <div className="w-full aspect-square rounded-full overflow-hidden shadow-[var(--shadow-sm)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)] mb-4 flex items-center justify-center transition-all duration-300 group-hover:border-[var(--color-primary)] group-hover:shadow-[var(--shadow-md)]">
                {imageUrl ? (
                    <img src={imageUrl} alt={artist} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" />
                ) : (
                    <ArtistInitial name={artist} className="text-4xl md:text-5xl text-[var(--color-primary)] opacity-50 group-hover:opacity-100 transition-opacity" />
                )}
            </div>
            <div className="font-bold text-base md:text-lg text-center text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors truncate w-full px-2">{artist}</div>
        </div>
    );
};

export const LibraryHome: React.FC<{ section?: 'artists' | 'albums' | 'genres' }> = ({ section }) => {
    const library = usePlayerStore(state => state.library);
    const artistEntities = usePlayerStore(state => state.artists);
    const albumEntities = usePlayerStore(state => state.albums);
    const genreEntities = usePlayerStore(state => state.genres);
    const setPlaylist = usePlayerStore(state => state.setPlaylist);

    // Derive unique Albums, Artists, and Genres from the library
    const { albums, artists, genres } = useMemo(() => {
        const albumGroups = new Map<string, TrackInfo[]>();
        const artistSet = new Set<string>();
        const genreSet = new Set<string>();

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
            } else if (track.artist) {
                artistSet.add(track.artist);
            }

            // Genre
            if ((track as any).genre) {
                genreSet.add((track as any).genre);
            }
        });

        // Album Grouping - Pass 2 (Partition by AlbumArtist, or collapse to Various Artists)
        const finalAlbums: { title: string, artist: string, artUrl?: string, trackCount: number }[] = [];

        for (const [albumTitle, tracks] of albumGroups.entries()) {
            const subAlbums = new Map<string, TrackInfo[]>();
            
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
                } else {
                    const uniqueArtists = new Set(subTracks.map(t => t.artist || 'Unknown Artist'));
                    if (uniqueArtists.size === 1) {
                        finalAlbums.push({
                            title: albumTitle,
                            artist: Array.from(uniqueArtists)[0],
                            artUrl: subTracks.find(t => t.artUrl)?.artUrl,
                            trackCount: subTracks.length
                        });
                    } else {
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

    return (
        <div className="library-home page-container">
            

            <div className="library-sections">
                {showAlbums && (
                    <section className="library-section mb-8 md:mb-12">
                        <div className="album-grid">
                            {albums.map(album => {
                                const albumTracks = library.filter(t => t.album === album.title);
                                // We don't need to filter by artist here because we pass the albumId which does the tight filtering in AlbumDetail.
                                // But for the direct play button on the card, we want just *this* album's tracks:
                                const explicitTracks = albumTracks.filter(t => {
                                    if (t.albumArtist) return t.albumArtist === album.artist;
                                    if (album.artist === 'Various Artists') return !t.albumArtist;
                                    return (t.artist || 'Unknown Artist') === album.artist && !t.albumArtist;
                                }).sort((a, b) => (a.trackNumber ?? 999) - (b.trackNumber ?? 999));

                                // Resolve album ID from entity list
                                const entity = albumEntities.find((a: any) => a.title === album.title && (a.artist_name || '') === (album.artist || ''));
                                const albumId = entity?.id;

                                return (
                                    <AlbumCard
                                        key={`${album.title}-${album.artist}`}
                                        title={album.title}
                                        artist={album.artist}
                                        artUrl={album.artUrl}
                                        subtitle={album.artist}
                                        onPlay={(e) => { if (explicitTracks.length) setPlaylist(explicitTracks, 0); }}
                                        linkTo={albumId ? `/library/album/${albumId}` : undefined}
                                    />
                                );
                            })}
                        </div>
                    </section>
                )}

                {showArtists && (
                    <section className="library-section mb-8 md:mb-12">
                        <div className="artist-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6">
                            {artists.map(artistName => {
                                const entity = artistEntities.find((a: any) => a.name?.toLowerCase() === artistName.toLowerCase());
                                if (!entity) return <ArtistCard key={artistName} artist={artistName} />;
                                return (
                                    <Link key={artistName} to={`/library/artist/${entity.id}`} className="no-underline">
                                        <ArtistCard artist={artistName} />
                                    </Link>
                                );
                            })}
                        </div>
                    </section>
                )}

                {showGenres && (
                    <section className="library-section">
                        {genres.length === 0 ? (
                           <p style={{ color: 'var(--color-text-muted)' }}>No genres found in your library.</p> 
                        ) : (
                            <div className="genre-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6">
                                {genres.map(genreName => {
                                    const entity = genreEntities.find((g: any) => g.name?.toLowerCase() === genreName.toLowerCase());
                                    if (!entity) return <GenreCard key={genreName} genre={genreName} />;
                                    return (
                                        <Link key={genreName} to={`/library/genre/${entity.id}`} className="no-underline">
                                            <GenreCard genre={genreName} />
                                        </Link>
                                    );
                                })}
                            </div>
                        )}
                    </section>
                )}
            </div>
        </div>
    );
};
