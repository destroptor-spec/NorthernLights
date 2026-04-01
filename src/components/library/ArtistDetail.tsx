import React, { useMemo } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { TrackInfo } from '../../utils/fileSystem';
import { trackMatchesArtist } from '../../utils/artistUtils';
import { useArtistData } from '../../hooks/useArtistData';
import { AlbumArt } from '../AlbumArt';
import { AlbumCard } from './AlbumCard';
import { BackButton } from './BackButton';
import { FadedHeroImage } from './FadedHeroImage';
import { ArtistInitial } from './ArtistInitial';
import { ExternalLink, Globe, Users, Mic2, Calendar } from 'lucide-react';

export const ArtistDetail: React.FC = () => {
    const { artistId } = useParams<{ artistId: string }>();
    const navigate = useNavigate();
    const { library, artists, setPlaylist } = usePlayerStore();

    // Find artist info from entity list
    const artistInfo = useMemo(() => artists.find(a => a.id === artistId), [artists, artistId]);
    const artistName = artistInfo?.name || '';

    // Get MusicBrainz artist ID from the first track that has one
    const mbArtistId = useMemo(() => {
        if (!artistId) return null;
        const track = library.find(t => t.artistId === artistId && t.mbArtistId);
        return track?.mbArtistId || null;
    }, [library, artistId]);

    const { imageUrl, bio, disambiguation, area, type, lifeSpan, links, genres, isLoading: artistLoading } = useArtistData(artistName, mbArtistId);

    // Tracks where this artist is the PRIMARY / album artist
    const primaryTracks = useMemo(() => {
        if (!artistName) return [];
        return library.filter(t => t.artistId === artistId);
    }, [library, artistId, artistName]);

    // Tracks where this artist APPEARS but is NOT the album owner
    const featuredTracks = useMemo(() => {
        if (!artistName) return [];
        const artistLower = artistName.toLowerCase();
        return library.filter(t => {
            const albumOwner = (t.albumArtist || t.artist || '').toLowerCase();
            if (albumOwner === artistLower) return false;
            if (Array.isArray(t.artists)) {
                return t.artists.some(a => a.toLowerCase() === artistLower);
            }
            return trackMatchesArtist(t.artist, artistName);
        });
    }, [library, artistName]);

    const buildReleaseGroups = (tracks: TrackInfo[]) => {
        const albumMap = new Map<string, { title: string, artist: string, artUrl?: string, albumId?: string, type: 'Album' | 'EP' | 'Single' | 'Compilation', tracks: TrackInfo[] }>();

        tracks.forEach(track => {
            const albumTitle = track.album || 'Unknown Album';
            const albumOwner = track.albumArtist || track.artist || 'Unknown Artist';
            const key = track.albumId || `${albumTitle}::::${albumOwner}`;
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
                    albumId: track.albumId,
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

    const hasAnyContent = primaryTracks.length > 0 || featuredTracks.length > 0;

    if (!artistName || !hasAnyContent) return <div>Artist not found.</div>;

    return (
        <div className="artist-detail page-container relative">
            {imageUrl && <FadedHeroImage src={imageUrl} />}
            <div className="relative z-10">
                <BackButton onClick={() => navigate(-1)} />

                <div className="flex flex-col md:flex-row gap-8 items-start mb-8 md:mb-12">
                    {imageUrl ? (
                        <div className="w-48 h-48 md:w-64 md:h-64 rounded-full overflow-hidden shrink-0 shadow-[var(--shadow-md)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)]">
                            <img src={imageUrl} alt={artistName} className="w-full h-full object-cover" />
                        </div>
                    ) : (
                        <div className={`w-48 h-48 md:w-64 md:h-64 rounded-full overflow-hidden shrink-0 shadow-[var(--shadow-md)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)] flex items-center justify-center ${artistLoading ? 'animate-pulse' : ''}`}>
                            <ArtistInitial name={artistName} />
                        </div>
                    )}
                    
                    <div className="flex-1">
                        <h1 className="font-bold text-4xl md:text-6xl lg:text-7xl tracking-tight mb-2 text-[var(--color-text-primary)]">
                            {artistName}
                        </h1>
                        {/* MusicBrainz metadata badges */}
                        {(disambiguation || type || area || lifeSpan?.begin) && (
                            <div className="flex flex-wrap items-center gap-2 mb-3">
                                {disambiguation && (
                                    <span className="text-sm text-[var(--color-text-muted)] italic">{disambiguation}</span>
                                )}
                                {type && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--color-primary)]/10 text-[var(--color-primary)] border border-[var(--color-primary)]/20">
                                        {type === 'Group' ? <Users className="w-3 h-3" /> : type === 'Person' ? <Mic2 className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
                                        {type}
                                    </span>
                                )}
                                {area && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                                        <Globe className="w-3 h-3" />
                                        {area}
                                    </span>
                                )}
                                {lifeSpan?.begin && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] border border-[var(--color-border)]">
                                        <Calendar className="w-3 h-3" />
                                        {lifeSpan.begin}{lifeSpan.end ? ` – ${lifeSpan.end}` : ' – present'}
                                    </span>
                                )}
                            </div>
                        )}
                        {/* Genre tags */}
                        {genres && genres.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mb-3">
                                {genres.slice(0, 8).map(g => (
                                    <span key={g} className="px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--color-bg-tertiary)]/80 text-[var(--color-text-muted)] border border-[var(--color-border)]/50">
                                        {g}
                                    </span>
                                ))}
                            </div>
                        )}
                        {bio && (
                            <p className="text-sm md:text-base text-[var(--color-text-secondary)] leading-relaxed max-w-3xl line-clamp-4 hover:line-clamp-none transition-all duration-300">
                                {bio}
                            </p>
                        )}
                        {/* Official links */}
                        {links && links.length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-3">
                                {links
                                    .filter(l => !l.url.includes('wikipedia') && !l.url.includes('wikidata'))
                                    .slice(0, 6)
                                    .map((link, i) => (
                                        <a
                                            key={i}
                                            href={link.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-[var(--color-text-muted)] hover:text-[var(--color-primary)] bg-[var(--color-bg-tertiary)]/50 hover:bg-[var(--color-primary)]/10 border border-[var(--color-border)]/50 transition-colors"
                                        >
                                            <ExternalLink className="w-3 h-3" />
                                            {link.type === 'official homepage' ? 'Official Site' :
                                             link.type === 'social network' ? 'Social' :
                                             link.type === 'streaming' ? 'Stream' :
                                             link.type === 'youtube' ? 'YouTube' :
                                             link.type === 'spotify' ? 'Spotify' :
                                             link.type === 'discogs' ? 'Discogs' :
                                             link.type === 'allmusic' ? 'AllMusic' :
                                             link.type}
                                        </a>
                                    ))}
                            </div>
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
                    <div className="album-grid">
                        {section.data.map(album => (
                            <AlbumCard
                                key={album.albumId || `${album.title}-${album.artist}`}
                                title={album.title}
                                artist={album.artist}
                                artUrl={album.artUrl}
                                subtitle={`${album.tracks.length} track${album.tracks.length !== 1 ? 's' : ''}`}
                                linkTo={album.albumId ? `/library/album/${album.albumId}` : undefined}
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
                    <div className="album-grid">
                        {[
                            ...featuredGroups.albums,
                            ...featuredGroups.eps,
                            ...featuredGroups.singles,
                            ...featuredGroups.compilations,
                        ].map(album => (
                            <AlbumCard
                                key={`feat-${album.albumId || `${album.title}-${album.artist}`}`}
                                title={album.title}
                                artist={album.artist}
                                artUrl={album.artUrl}
                                subtitle={album.artist}
                                linkTo={album.albumId ? `/library/album/${album.albumId}` : undefined}
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
