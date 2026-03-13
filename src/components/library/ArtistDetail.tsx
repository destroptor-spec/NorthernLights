import React, { useMemo, useState, useEffect } from 'react';
import { usePlayerStore } from '../../store/index';
import { TrackInfo } from '../../utils/fileSystem';
import { trackMatchesArtist } from '../../utils/artistUtils';
import { fetchArtistData } from '../../utils/externalImagery';
import { AlbumArt } from '../AlbumArt';
import { AlbumCard } from './AlbumCard';

export const ArtistDetail: React.FC = () => {
    const { library, selectedItem, navigateView, setPlaylist } = usePlayerStore();
    const artist = selectedItem;
    const [artistData, setArtistData] = useState<{imageUrl?: string, bio?: string}>({});

    useEffect(() => {
        if (artist) {
            setArtistData({}); // clear old
            fetchArtistData(artist).then(data => setArtistData(data));
        }
    }, [artist]);

    // Tracks where this artist is the PRIMARY / album artist
    const primaryTracks = useMemo(() => {
        return library.filter(t => {
            const albumOwner = (t.albumArtist || t.artist || '').toLowerCase();
            return albumOwner === (artist || '').toLowerCase();
        });
    }, [library, artist]);

    // Tracks where this artist APPEARS but is NOT the album owner
    const featuredTracks = useMemo(() => {
        const artistLower = (artist || '').toLowerCase();
        return library.filter(t => {
            const albumOwner = (t.albumArtist || t.artist || '').toLowerCase();
            if (albumOwner === artistLower) return false; // already in primary
            // Check if artist appears in the track's artists array or artist string
            if (Array.isArray(t.artists)) {
                return t.artists.some(a => a.toLowerCase() === artistLower);
            }
            return trackMatchesArtist(t.artist, artist || '');
        });
    }, [library, artist]);

    const buildReleaseGroups = (tracks: TrackInfo[]) => {
        const albumMap = new Map<string, { title: string, artist: string, artUrl?: string, type: 'Album' | 'EP' | 'Single' | 'Compilation', tracks: TrackInfo[] }>();

        tracks.forEach(track => {
            const albumTitle = track.album || 'Unknown Album';
            const albumOwner = track.albumArtist || track.artist || 'Unknown Artist';
            const key = `${albumTitle}::::${albumOwner}`;
            if (!albumMap.has(key)) {
                let rType: 'Album' | 'EP' | 'Single' | 'Compilation' = 'Album';
                const rawType = (track.releaseType || '').toLowerCase();
                if (track.isCompilation || rawType.includes('compilation')) rType = 'Compilation';
                else if (rawType.includes('ep')) rType = 'EP';
                else if (rawType.includes('single')) rType = 'Single';

                albumMap.set(key, {
                    title: albumTitle,
                    artist: albumOwner,
                    artUrl: track.artUrl,
                    type: rType,
                    tracks: []
                });
            }
            albumMap.get(key)!.tracks.push(track);
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

    // Combined for empty check
    const hasAnyContent = primaryTracks.length > 0 || featuredTracks.length > 0;

    if (!artist || !hasAnyContent) return <div>Artist not found.</div>;

    return (
        <div className="artist-detail p-4 md:p-8 lg:p-12 overflow-y-auto flex-1 relative">
            {artistData.imageUrl && (
                <div 
                    className="absolute top-0 left-0 w-full h-[300px] md:h-[400px] z-0 opacity-40 mix-blend-overlay pointer-events-none"
                    style={{ background: `url(${artistData.imageUrl}) center/cover no-repeat`, maskImage: 'linear-gradient(to bottom, black 0%, transparent 100%)', WebkitMaskImage: 'linear-gradient(to bottom, black 0%, transparent 100%)' }}
                />
            )}
            <div className="relative z-10">
                <button
                    onClick={() => navigateView('home')}
                    className="font-medium text-sm md:text-base text-[var(--color-primary)] hover:text-[var(--color-primary-dark)] px-4 py-2 w-fit flex items-center gap-2 mb-8 md:mb-12 transition-all duration-200"
                >
                    ← Back to Library
                </button>

                <div className="flex flex-col md:flex-row gap-8 items-start mb-8 md:mb-12">
                    {artistData.imageUrl ? (
                        <div className="w-48 h-48 md:w-64 md:h-64 rounded-full overflow-hidden shrink-0 shadow-[var(--shadow-md)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)]">
                            <img src={artistData.imageUrl} alt={artist} className="w-full h-full object-cover" />
                        </div>
                    ) : (
                        <div className="w-48 h-48 md:w-64 md:h-64 rounded-full overflow-hidden shrink-0 shadow-[var(--shadow-md)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)] flex items-center justify-center">
                            <span className="text-4xl md:text-6xl text-[var(--color-primary)] opacity-50">{artist.charAt(0)}</span>
                        </div>
                    )}
                    
                    <div className="flex-1">
                        <h1 className="font-bold text-4xl md:text-6xl lg:text-7xl tracking-tight mb-4 text-[var(--color-text-primary)]">
                            {artist}
                        </h1>
                        {artistData.bio && (
                            <p className="text-sm md:text-base text-[var(--color-text-secondary)] leading-relaxed max-w-3xl line-clamp-4 hover:line-clamp-none transition-all duration-300">
                                {artistData.bio}
                            </p>
                        )}
                    </div>
                </div>

                {/* Primary Releases */}
            {[
                { title: 'Albums', data: releaseGroups.albums },
                { title: 'EPs', data: releaseGroups.eps },
                { title: 'Singles', data: releaseGroups.singles },
                { title: 'Compilations', data: releaseGroups.compilations }
            ].map((section) => section.data.length > 0 && (
                <div key={section.title} className="mb-12">
                    <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2">{section.title}</h3>
                    <div className="album-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6">
                        {section.data.map(album => (
                            <AlbumCard
                                key={`${album.title}-${album.artist}`}
                                title={album.title}
                                artist={album.artist}
                                artUrl={album.artUrl}
                                subtitle={`${album.tracks.length} track${album.tracks.length !== 1 ? 's' : ''}`}
                                onOpen={() => navigateView('album', `${album.title}::::${album.artist}`)}
                                onPlay={() => setPlaylist(album.tracks, 0)}
                            />
                        ))}
                    </div>
                </div>
            ))}

            {/* Also Appears On */}
            {[
                ...featuredGroups.albums,
                ...featuredGroups.eps,
                ...featuredGroups.singles,
                ...featuredGroups.compilations,
            ].length > 0 && (
                <div className="mb-12">
                    <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2 flex items-center gap-2">
                        <span className="text-[var(--color-primary)] opacity-60">✦</span> Also appears on
                    </h3>
                    <div className="album-grid grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 md:gap-6">
                        {[
                            ...featuredGroups.albums,
                            ...featuredGroups.eps,
                            ...featuredGroups.singles,
                            ...featuredGroups.compilations,
                        ].map(album => (
                            <AlbumCard
                                key={`feat-${album.title}-${album.artist}`}
                                title={album.title}
                                artist={album.artist}
                                artUrl={album.artUrl}
                                subtitle={album.artist}
                                onOpen={() => navigateView('album', `${album.title}::::${album.artist}`)}
                                onPlay={() => setPlaylist(album.tracks, 0)}
                            />
                        ))}
                    </div>
                </div>
            )}
            </div>
        </div>
    );
};
