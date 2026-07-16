import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { TrackInfo } from '../../utils/fileSystem';
import { normalizeArtistIdentityKey, parseArtistsForDisplay, trackMatchesArtist } from '../../utils/artistUtils';
import { useKnownArtistKeys } from '../../hooks/useKnownArtistKeys';
import { useEntityTracks } from '../../hooks/useEntityTracks';
import { useArtistData } from '../../hooks/useArtistData';
import { useArtistTopTracks } from '../../hooks/useArtistTopTracks';
import { AlbumArt } from '../AlbumArt';
import { AlbumCard, AlbumCardSkeleton } from './AlbumCard';
import { BackButton } from './BackButton';
import { FadedHeroImage } from './FadedHeroImage';
import { ArtistInitial } from './ArtistInitial';
import { formatTime } from '../../utils/formatTime';
import { ExternalLink, Globe, Users, Mic2, Calendar, Sparkles, Music2, Clock, BookOpen, Play, Headphones, Link2, Disc3, Radio, Tag } from 'lucide-react';
import { ContextMenuFrame, ContextMenuHeader, ContextMenuLink, ContextMenuList, ContextMenuPortal } from '../ContextMenu';
import { useArtistConcerts, OnTourSticker, UpcomingShows } from './ArtistConcerts';
import { useArtistMusicVideos, MusicVideos } from './ArtistMusicVideos';
import { useIsCurrentCollection, useNowPlayingState } from '../../hooks/useNowPlaying';
import { NowPlayingBadge } from '../now-playing/NowPlayingBadge';
import { NowPlayingBars } from '../now-playing/NowPlayingBars';
import { prefetchArtistDetail } from '../../utils/routePrefetch';
import { readArtistHeroState, type ArtistHeroState } from '../../utils/heroState';

// ─── Link label helpers ───────────────────────────────────────────────────────

/**
 * Returns false for URLs that clearly point to a specific release/album/track
 * rather than an artist page (e.g. discogs.com/master/…, allmusic.com/album/…).
 */
function isArtistLevelUrl(url: string): boolean {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.replace(/^www\./, '');
    const path = pathname.toLowerCase();

    if (host === 'discogs.com') return path.startsWith('/artist/');
    if (host === 'allmusic.com') return !path.startsWith('/album/') && !path.startsWith('/song/') && !path.startsWith('/composition/');
    if (host === 'open.spotify.com' || host === 'spotify.com') return path.startsWith('/artist/');
    if (host === 'last.fm' || host.endsWith('.last.fm')) {
      // /music/Artist → ok; /music/Artist/Album → release
      const segs = path.split('/').filter(Boolean);
      return !(segs[0] === 'music' && segs.length >= 3);
    }
    if (host === 'musicbrainz.org') return path.startsWith('/artist/');

    return true;
  } catch {
    return true;
  }
}

function getLinkLabel(url: string, type: string): string {
  const u = url.toLowerCase();
  if (u.includes('spotify.com')) return 'Spotify';
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
  if (u.includes('instagram.com')) return 'Instagram';
  if (u.includes('facebook.com') || u.includes('fb.com')) return 'Facebook';
  if (u.includes('twitter.com') || u.includes('x.com')) return 'X / Twitter';
  if (u.includes('tiktok.com')) return 'TikTok';
  if (u.includes('bandcamp.com')) return 'Bandcamp';
  if (u.includes('soundcloud.com')) return 'SoundCloud';
  if (u.includes('discogs.com')) return 'Discogs';
  if (u.includes('allmusic.com')) return 'AllMusic';
  if (u.includes('wikipedia.org')) return 'Wikipedia';
  if (u.includes('wikidata.org')) return 'Wikidata';
  if (u.includes('last.fm') || u.includes('lastfm.')) return 'Last.fm';
  if (u.includes('apple.com') || u.includes('music.apple')) return 'Apple Music';
  if (u.includes('tidal.com')) return 'Tidal';
  if (u.includes('deezer.com')) return 'Deezer';
  if (u.includes('genius.com')) return 'Genius';
  if (u.includes('rateyourmusic.com')) return 'RateYourMusic';
  if (u.includes('musicbrainz.org')) return 'MusicBrainz';

  if (type === 'official homepage') return 'Official Site';
  if (type === 'social network') return 'Social';
  if (type === 'streaming') return 'Streaming';
  if (type === 'official audio source') return 'Audio Source';
  if (type === 'discogs') return 'Discogs';
  if (type === 'youtube') return 'YouTube';
  if (type === 'spotify') return 'Spotify';
  if (type === 'soundcloud') return 'SoundCloud';
  if (type === 'bandcamp') return 'Bandcamp';
  if (type === 'wikipedia') return 'Wikipedia';
  return type || 'Link';
}

function formatListeners(raw: string): string {
  const n = parseInt(raw, 10);
  if (isNaN(n)) return raw;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M listeners`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K listeners`;
  return `${n} listeners`;
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function normalizePopularTitle(value: string | undefined | null): string {
  return (value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/\s*\[[^\]]*(remaster|remastered|version|edit|mono|stereo|explicit|clean)[^\]]*\]/gi, '')
    .replace(/\s*\([^)]*(remaster|remastered|version|edit|mono|stereo|explicit|clean)[^)]*\)/gi, '')
    .replace(/\s+(feat\.?|featuring|ft\.?)\s+.+$/i, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function formatCompactCount(raw?: string): string | null {
  if (!raw) return null;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value)) return null;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return value.toLocaleString();
}

type SimilarArtist = {
    id: string;
    name: string;
    imageUrl?: string;
    trackCount: number;
    albumCount: number;
    analyzedTracks: number;
    matchScore: number;
};

// Album row from `ownedAlbums` on /api/artists/:id — albums a VA
// pseudo-artist owns by album-artist name, shipped without their tracks.
type OwnedAlbumRow = {
    id: string;
    title?: string;
    artist_name?: string;
    image_url?: string | null;
    edition_label?: string | null;
    track_count?: number;
    art_hash?: string | null;
};

const SimilarArtistRow: React.FC<{ artist: SimilarArtist }> = ({ artist }) => {
    const href = `/library/artist/${artist.id}`;
    const heroState: ArtistHeroState = {
        kind: 'artist',
        name: artist.name,
        imageUrl: artist.imageUrl || undefined,
        backLabel: 'Back to Artist',
    };

    return (
        <Link
            to={href}
            state={heroState}
            onPointerEnter={prefetchArtistDetail}
            onPointerDown={prefetchArtistDetail}
            onFocus={prefetchArtistDetail}
            className="group rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface)] p-3 transition-ui hover:border-primary/40 hover:bg-[var(--glass-bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
        >
            <div className="flex items-start gap-3">
                <div
                    className="h-14 w-14 shrink-0 overflow-hidden rounded-full border border-black/10 bg-black/10 dark:border-white/10 dark:bg-white/10"
                >
                    {artist.imageUrl ? (
                        <img src={artist.imageUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                    ) : (
                        <div className="flex h-full w-full items-center justify-center">
                            <ArtistInitial name={artist.name} className="text-xl text-[var(--color-primary)] opacity-55" />
                        </div>
                    )}
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-[var(--color-text-primary)] transition-colors group-hover:text-[var(--color-primary)]">
                        {artist.name}
                    </div>
                    <div className="mt-1 text-xs text-[var(--color-text-muted)] tabular-nums">
                        {artist.matchScore}% match
                    </div>
                </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-[var(--color-text-muted)]">
                <span>{artist.trackCount} track{artist.trackCount !== 1 ? 's' : ''}</span>
                {artist.albumCount > 0 && <span>{artist.albumCount} album{artist.albumCount !== 1 ? 's' : ''}</span>}
            </div>
        </Link>
    );
};

const SimilarArtistsSection: React.FC<{ artists: SimilarArtist[]; loading: boolean }> = ({ artists, loading }) => {
    if (loading) {
        return (
            <section className="mb-12">
                <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2 flex items-center gap-2">
                    <Users className="w-4 h-4 text-[var(--color-primary)] opacity-60" />
                    Similar artists
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {[0, 1, 2, 3].map(i => (
                        <div key={i} className="h-[154px] rounded-xl bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                    ))}
                </div>
            </section>
        );
    }

    if (artists.length === 0) return null;

    return (
        <section className="mb-12">
            <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2 flex items-center gap-2">
                <Users className="w-4 h-4 text-[var(--color-primary)] opacity-60" />
                Similar artists
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {artists.map(artist => (
                    <SimilarArtistRow key={artist.id} artist={artist} />
                ))}
            </div>
        </section>
    );
};

const ArtistDetailSkeleton: React.FC<{ onBack: () => void; hero?: ArtistHeroState }> = ({ onBack, hero }) => {
    const hasHero = !!hero && (!!hero.name || !!hero.imageUrl);
    return (
        <div className="artist-detail page-container relative">
            <div className="relative z-10">
                <BackButton onClick={onBack} />
                <section className="flex flex-col md:flex-row items-center md:items-end gap-8 mb-10 md:mb-14">
                    {hasHero && hero?.imageUrl ? (
                        <div
                            className="w-48 h-48 md:w-64 md:h-64 rounded-full overflow-hidden shrink-0 shadow-[var(--shadow-md)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)]"
                        >
                            <img src={hero.imageUrl} alt={hero.name || ''} className="w-full h-full object-cover" />
                        </div>
                    ) : hasHero ? (
                        <div
                            className="w-48 h-48 md:w-64 md:h-64 rounded-full overflow-hidden shrink-0 shadow-[var(--shadow-md)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)] flex items-center justify-center"
                        >
                            <ArtistInitial name={hero.name || ''} />
                        </div>
                    ) : (
                        <div
                            className="w-48 h-48 md:w-64 md:h-64 rounded-full shrink-0 bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none"
                        />
                    )}
                    <div className="flex-1 w-full space-y-4 text-center md:text-left">
                        {hasHero ? (
                            <>
                                <h1 className="font-bold text-4xl md:text-5xl lg:text-6xl tracking-tight leading-tight text-[var(--color-text-primary)] line-clamp-2">
                                    {hero?.name}
                                </h1>
                                <div className="h-4 w-56 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none mx-auto md:mx-0" />
                            </>
                        ) : (
                            <>
                                <div className="h-12 md:h-16 w-3/4 max-w-xl rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none mx-auto md:mx-0" />
                                <div className="h-4 w-56 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none mx-auto md:mx-0" />
                                <div className="h-10 w-36 rounded-full bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none mx-auto md:mx-0" />
                            </>
                        )}
                    </div>
                </section>
                <div className="mb-12 max-w-3xl space-y-2">
                    <div className="h-4 w-full rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                    <div className="h-4 w-5/6 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                    <div className="h-4 w-2/3 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                </div>
                <div className="album-grid">
                    {Array.from({ length: 6 }).map((_, i) => <AlbumCardSkeleton key={i} />)}
                </div>
            </div>
        </div>
    );
};

// ─── Component ───────────────────────────────────────────────────────────────

export const ArtistDetail: React.FC = () => {
    const { artistId } = useParams<{ artistId: string }>();
    const navigate = useNavigate();
    const location = useLocation();
    const heroState = useMemo(() => readArtistHeroState(location.state), [location.state]);
    // Per-field selectors instead of a whole-store subscription, which re-rendered
    // this detail view on every unrelated store mutation (e.g. playback ticks).
    const library = usePlayerStore((s) => s.library);
    const artists = usePlayerStore((s) => s.artists);
    const albums = usePlayerStore((s) => s.albums);
    const setPlaylist = usePlayerStore((s) => s.setPlaylist);
    const hydrateTracks = usePlayerStore((s) => s.hydrateTracks);
    const getAuthHeader = usePlayerStore((s) => s.getAuthHeader);
    const isLibraryLoading = usePlayerStore((s) => s.isLibraryLoading);
    const mediaAccessToken = usePlayerStore((s) => s.mediaAccessToken);
    const authToken = usePlayerStore((s) => s.authToken);

    // The artist's own tracks come from the per-artist endpoint so the page
    // works without the full in-memory library. `library` is still used as a
    // fallback and for the cross-artist "appears on" list until that moves
    // server-side. Source for the album art/track maps below.
    // `ownedAlbums` is only populated for VA pseudo-artists: albums they own
    // as lean album rows, since shipping every VA comp track is untenable.
    const { tracks: artistTracks, meta: artistMeta, loading: artistTracksLoading } = useEntityTracks<{
        name?: string;
        ownedAlbums?: OwnedAlbumRow[];
    }>(
        artistId ? `/api/artists/${encodeURIComponent(artistId)}` : null,
    );
    // "Appears on" / collaborations — server-computed so it works without the
    // full library (falls back to the library-derived list below when empty).
    const { tracks: appearsOnTracks } = useEntityTracks(
        artistId ? `/api/artists/${encodeURIComponent(artistId)}/appears-on` : null,
    );
    const mapSourceTracks = library.length > 0 ? library : [...artistTracks, ...appearsOnTracks];

    // Map albumId → edition_label so each AlbumCard can render the "remaster",
    // "deluxe", etc. badge alongside the canonical edition (which has no label).
    const editionLabelByAlbumId = useMemo(() => {
        const map = new Map<string, string>();
        for (const al of albums) {
            if (al.id && al.edition_label) map.set(al.id, al.edition_label);
        }
        return map;
    }, [albums]);

    // Map albumId → a track's embedded artUrl so the role-filtered grid
    // (which gets album rows from the server, not tracks from the in-memory
    // library) can still surface cover art from the user's own files —
    // no external fetch required.
    const artUrlByAlbumId = useMemo(() => {
        const map = new Map<string, string>();
        for (const t of mapSourceTracks) {
            if (t.albumId && t.artUrl && !map.has(t.albumId)) {
                map.set(t.albumId, t.artUrl);
            }
        }
        return map;
    }, [mapSourceTracks]);

    // Same idea for albumId → list of tracks in that album. Lets the
    // role-filtered AlbumCard's play button actually queue something.
    const tracksByAlbumId = useMemo(() => {
        const map = new Map<string, TrackInfo[]>();
        for (const t of mapSourceTracks) {
            if (!t.albumId) continue;
            const arr = map.get(t.albumId) || [];
            arr.push(t);
            map.set(t.albumId, arr);
        }
        return map;
    }, [mapSourceTracks]);

    // Find artist info from entity list
    const artistInfo = useMemo(() => artists.find(a => a.id === artistId), [artists, artistId]);
    // Prefer the in-memory entity row, but fall back to the authoritative name
    // from /api/artists/:id. The endpoint resolves merged artists and includes
    // credit-only artists (composers, lyricists, …) that aren't in the in-memory
    // list, so credited-author links resolve instead of showing "Artist not found".
    const artistName = artistInfo?.name || artistMeta?.name || '';

    // Get MusicBrainz artist ID from the first track that has one. Only
    // trust tracks credited to this artist — the endpoint also returns
    // uncredited tracks from owned DJ-mix comps, whose mbArtistId belongs to
    // the per-track performer. On those the artist's own MBID is the
    // album-artist id, which covers artists with no performer credits at all.
    const mbArtistId = useMemo(() => {
        if (!artistId) return null;
        const credited = artistTracks.find(t => t.artistId === artistId && t.mbArtistId)
            || library.find(t => t.artistId === artistId && t.mbArtistId);
        if (credited?.mbArtistId) return credited.mbArtistId;
        const owned = artistTracks.find(t => t.artistId !== artistId && t.mbAlbumArtistId);
        return owned?.mbAlbumArtistId || null;
    }, [artistTracks, library, artistId]);

    const { imageUrl, artworkUrl, bio, disambiguation, area, type, lifeSpan, links, genres, communityTags, listeners, members, isLoading: artistLoading } = useArtistData(artistName, mbArtistId);
    const { onTour, events: upcomingEvents, loading: concertsLoading, stale: concertsStale } = useArtistConcerts(artistId);
    const { videos: musicVideos, loading: musicVideosLoading, stale: musicVideosStale } = useArtistMusicVideos(artistId);
    const { tracks: externalTopTracks } = useArtistTopTracks(artistName, {
        enabled: !!artistName,
        limit: 30,
    });
    const [bioExpanded, setBioExpanded] = useState(false);
    const [linksMenuOpen, setLinksMenuOpen] = useState(false);
    const [popularExpanded, setPopularExpanded] = useState(false);
    const [similarArtists, setSimilarArtists] = useState<SimilarArtist[]>([]);
    const [similarArtistsLoading, setSimilarArtistsLoading] = useState(false);
    const [radioLoading, setRadioLoading] = useState(false);
    // Whether a quality radio can actually be built for this artist. Fetched
    // async so the page renders immediately; the button stays disabled until
    // we know, then enables (eligible) or shows the reason as a tooltip.
    const [radioEligibility, setRadioEligibility] = useState<{ checking: boolean; eligible: boolean; reason?: string }>({
        checking: true,
        eligible: false,
    });
    // Credit-driven role browse state. `rolesInLibrary` is sorted by
    // frequency (most credits first) so the chip row leads with the
    // role this artist holds most often in *this* library: producer for
    // a trance act, composer for a classical writer, conductor for a
    // maestro, performer for everyone else.
    const [rolesInLibrary, setRolesInLibrary] = useState<Array<{ role: string; credits: number }>>([]);
    const [albumsByRole, setAlbumsByRole] = useState<Record<string, any[]>>({});
    const [creditsLoading, setCreditsLoading] = useState<boolean>(true);
    const [selectedRole, setSelectedRole] = useState<string>('all');
    const linksButtonRef = useRef<HTMLButtonElement>(null);
    const isArtistPlaying = useIsCurrentCollection({ artistId: artistId ?? undefined });
    const playbackState = useNowPlayingState();
    const currentTrackId = usePlayerStore((s) => s.currentIndex !== null ? s.playlist[s.currentIndex]?.id ?? null : null);

    const handlePlayArtistRadio = async () => {
        if (!artistId || radioLoading) return;
        setRadioLoading(true);
        try {
            const res = await fetch('/api/hub/artist-radio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                body: JSON.stringify({ artistId }),
            });
            if (!res.ok) throw new Error('Failed to load radio');
            const { playlist } = await res.json();
            // Hydrate the server tracks (builds stream + art URLs from path/artHash).
            // The in-memory `library` is empty in the main app, so mapping against
            // it would leave raw, art-less tracks in the queue until a reload
            // rebuilt them from the persisted snapshot.
            const tracks = hydrateTracks(playlist?.tracks || []);
            if (tracks.length > 0) setPlaylist(tracks, 0, artistId ? { kind: 'radio', id: artistId } : null);
        } catch (e) {
            console.error('[Artist Radio] Failed to start radio', e);
        } finally {
            setRadioLoading(false);
        }
    };

    useEffect(() => {
        if (!artistId) {
            setRadioEligibility({ checking: false, eligible: false });
            return;
        }
        let cancelled = false;
        setRadioEligibility({ checking: true, eligible: false });
        fetch(`/api/hub/artist-radio-eligibility?artistId=${encodeURIComponent(artistId)}`, { headers: getAuthHeader() })
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (cancelled) return;
                if (data) setRadioEligibility({ checking: false, eligible: !!data.eligible, reason: data.reason });
                else setRadioEligibility({ checking: false, eligible: false });
            })
            .catch(() => {
                if (!cancelled) setRadioEligibility({ checking: false, eligible: false });
            });
        return () => { cancelled = true; };
    }, [artistId]);

    useEffect(() => {
        if (!artistId) {
            setSimilarArtists([]);
            setSimilarArtistsLoading(false);
            return;
        }

        let cancelled = false;
        setSimilarArtistsLoading(true);
        fetch(`/api/artists/${artistId}/similar?limit=8`, { headers: getAuthHeader() })
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (!cancelled) setSimilarArtists(Array.isArray(data?.artists) ? data.artists : []);
            })
            .catch(() => {
                if (!cancelled) setSimilarArtists([]);
            })
            .finally(() => {
                if (!cancelled) setSimilarArtistsLoading(false);
            });

        return () => { cancelled = true; };
    }, [artistId, getAuthHeader]);

    // Fetch credit-derived roles + the albums where this artist holds each
    // role. One request per artist; the response carries every role's
    // album list so flipping chips is instant after the initial load.
    useEffect(() => {
        if (!artistId) {
            setRolesInLibrary([]);
            setAlbumsByRole({});
            setCreditsLoading(false);
            setSelectedRole('all');
            return;
        }
        let cancelled = false;
        setSelectedRole('all');
        setCreditsLoading(true);
        fetch(`/api/artists/${artistId}/credits`, { headers: getAuthHeader() })
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (cancelled || !data) return;
                setRolesInLibrary(Array.isArray(data.roles) ? data.roles : []);
                setAlbumsByRole(data.albumsByRole && typeof data.albumsByRole === 'object' ? data.albumsByRole : {});
            })
            .catch(() => {
                if (!cancelled) {
                    setRolesInLibrary([]);
                    setAlbumsByRole({});
                }
            })
            .finally(() => {
                if (!cancelled) setCreditsLoading(false);
            });
        return () => { cancelled = true; };
    }, [artistId, getAuthHeader]);

    // Tracks where this artist is the PRIMARY / album artist
    const primaryTracks = useMemo(() => {
        // Prefer the per-artist fetch; fall back to the library (background load
        // window) so this still works when both are available.
        if (artistTracks.length > 0) return artistTracks;
        if (!artistName) return [];
        return library.filter(t => t.artistId === artistId);
    }, [artistTracks, library, artistId, artistName]);

    const knownArtistKeys = useKnownArtistKeys();

    // Tracks where this artist APPEARS but is NOT the album owner.
    // Compares using canonical identity keys (so post-merge variants like
    // "N'to" / "NTO" match) AND artist-aware credit splitting (so a joined
    // entry like "Tony Bennett & Lady Gaga" in tracks.artists matches both
    // halves when both are known artists in the library).
    const otherCreditedTracks = useMemo(() => {
        // Prefer the server-computed appears-on list; fall back to the
        // library-derived (canonical-key) computation when it's empty.
        if (appearsOnTracks.length > 0) return appearsOnTracks;
        if (!artistName) return [];
        const artistKey = normalizeArtistIdentityKey(artistName);
        if (!artistKey) return [];
        const splitMatches = (raw: string | undefined) =>
            !!raw && parseArtistsForDisplay(raw, knownArtistKeys).some(a => normalizeArtistIdentityKey(a) === artistKey);
        return library.filter(t => {
            if (t.artistId === artistId) return false;
            const ownerSrc = t.albumArtist || t.artist || '';
            if (normalizeArtistIdentityKey(ownerSrc) === artistKey) return false;
            if (Array.isArray(t.artists) && t.artists.length > 0) {
                return t.artists.some(a => {
                    if (normalizeArtistIdentityKey(a) === artistKey) return true;
                    return splitMatches(a);
                });
            }
            return trackMatchesArtist(t.artist, artistName) || splitMatches(t.artist);
        });
    }, [appearsOnTracks, library, artistId, artistName, knownArtistKeys]);

    // Among the credited-but-not-owner tracks, identify whole albums where
    // this artist is a co-primary collaborator rather than a guest feature.
    // Heuristic: if the artist is credited on at least half of the album's
    // tracks in the library, the album is a collaboration (Tony Bennett &
    // Lady Gaga's "Cheek to Cheek") and should appear under primary releases
    // on both pages. Single-track guest features stay under "Also appears on".
    const COLLABORATION_TRACK_RATIO = 0.5;
    const { collaborationTracks, featuredTracks } = useMemo(() => {
        if (otherCreditedTracks.length === 0) {
            return { collaborationTracks: [] as TrackInfo[], featuredTracks: [] as TrackInfo[] };
        }
        const artistKey = normalizeArtistIdentityKey(artistName);
        if (!artistKey) {
            return { collaborationTracks: [] as TrackInfo[], featuredTracks: otherCreditedTracks };
        }

        const albumKeyOf = (t: TrackInfo) =>
            t.albumId || (t.album ? `${t.album}::::${t.albumArtist || t.artist || ''}` : '');

        const tracksByAlbum = new Map<string, TrackInfo[]>();
        for (const t of library) {
            const k = albumKeyOf(t);
            if (!k) continue;
            tracksByAlbum.set(k, [...(tracksByAlbum.get(k) || []), t]);
        }

        const collaborationKeys = new Set<string>();
        const checked = new Set<string>();
        for (const t of otherCreditedTracks) {
            const k = albumKeyOf(t);
            if (!k || checked.has(k)) continue;
            checked.add(k);
            const allOnAlbum = tracksByAlbum.get(k) || [];
            if (allOnAlbum.length === 0) continue;
            const credited = allOnAlbum.filter(at => {
                const splitHit = (raw: string | undefined) =>
                    !!raw && parseArtistsForDisplay(raw, knownArtistKeys).some(a => normalizeArtistIdentityKey(a) === artistKey);
                if (Array.isArray(at.artists) && at.artists.length > 0) {
                    return at.artists.some(a => normalizeArtistIdentityKey(a) === artistKey || splitHit(a));
                }
                return trackMatchesArtist(at.artist, artistName) || splitHit(at.artist);
            }).length;
            if (credited / allOnAlbum.length >= COLLABORATION_TRACK_RATIO) {
                collaborationKeys.add(k);
            }
        }

        const collab: TrackInfo[] = [];
        const feat: TrackInfo[] = [];
        for (const t of otherCreditedTracks) {
            (collaborationKeys.has(albumKeyOf(t)) ? collab : feat).push(t);
        }
        return { collaborationTracks: collab, featuredTracks: feat };
    }, [library, otherCreditedTracks, artistName, knownArtistKeys]);

    // Aggregate file-embedded URLs from the artist's credited tracks,
    // deduplicated. Uncredited owned-comp tracks are excluded — their
    // embedded URLs belong to the per-track performers.
    const fileLinks = useMemo(() => {
        const seen = new Set<string>();
        const result: { url: string; type: string }[] = [];
        for (const track of primaryTracks) {
            if (artistId && track.artistId && track.artistId !== artistId) continue;
            for (const link of (track.rawUrls || [])) {
                if (!seen.has(link.url)) {
                    seen.add(link.url);
                    result.push(link);
                }
            }
        }
        return result;
    }, [primaryTracks, artistId]);

    // Merge file links + MusicBrainz links, preferring file links (deduplicate by URL)
    const allLinks = useMemo(() => {
        const seen = new Set<string>();
        const result: { url: string; type: string }[] = [];
        const add = (link: { url: string; type: string }) => {
            if (!seen.has(link.url) && isArtistLevelUrl(link.url)) {
                seen.add(link.url);
                result.push(link);
            }
        };
        fileLinks.forEach(add);
        (links || []).forEach(add);
        return result;
    }, [fileLinks, links]);

    // Local library stats
    const libraryStats = useMemo(() => {
        let totalTracks = primaryTracks.length;
        const albumSet = new Set<string>();
        let totalDuration = 0;
        for (const t of primaryTracks) {
            if (t.albumId) albumSet.add(t.albumId);
            else if (t.album) albumSet.add(t.album);
            totalDuration += t.duration || 0;
        }
        // Track-less owned-album rows (VA pseudo-artists) count too; their
        // durations aren't shipped, so totalDuration stays tracks-only.
        for (const al of artistMeta?.ownedAlbums || []) {
            if (al.id && !albumSet.has(al.id)) {
                albumSet.add(al.id);
                totalTracks += al.track_count || 0;
            }
        }
        return { totalTracks, totalAlbums: albumSet.size, totalDuration };
    }, [primaryTracks, artistMeta]);

    const buildReleaseGroups = (tracks: TrackInfo[]) => {
        // trackCount overrides tracks.length for card subtitles when the album
        // arrived as a track-less owned-album row (VA pseudo-artists).
        const albumMap = new Map<string, { title: string, artist: string, artUrl?: string, albumId?: string, editionLabel?: string, type: 'Album' | 'EP' | 'Single' | 'Compilation', tracks: TrackInfo[], trackCount?: number }>();

        tracks.forEach(track => {
            const albumTitle = track.album || 'Unknown Album';
            const albumOwner = track.albumArtist || track.artist || 'Unknown Artist';
            const key = track.albumId || `${albumTitle}::::${albumOwner}`;
            if (!albumMap.has(key)) {
                let rType: 'Album' | 'EP' | 'Single' | 'Compilation' = 'Album';
                const rawType = (track.releaseType || '').toLowerCase();
                if (rawType.includes('compilation') || track.isCompilation) rType = 'Compilation';
                else if (rawType.includes('ep')) rType = 'EP';
                else if (rawType.includes('single')) rType = 'Single';

                albumMap.set(key, {
                    title: albumTitle,
                    artist: albumOwner,
                    artUrl: track.artUrl,
                    albumId: track.albumId,
                    editionLabel: track.albumId ? editionLabelByAlbumId.get(track.albumId) : undefined,
                    type: rType,
                    tracks: []
                });
            }
            albumMap.get(key)!.tracks.push(track);
        });

        // Card play starts the album from the top: the endpoint returns
        // credited tracks before uncredited owned-comp tracks, and DB order
        // is arbitrary within each group.
        for (const entry of albumMap.values()) {
            entry.tracks.sort((a, b) =>
                ((a.discNumber || 1) - (b.discNumber || 1)) || ((a.trackNumber || 0) - (b.trackNumber || 0)));
        }

        const all = Array.from(albumMap.values()).sort((a, b) => a.title.localeCompare(b.title));
        return {
            albums: all.filter(r => r.type === 'Album'),
            eps: all.filter(r => r.type === 'EP'),
            singles: all.filter(r => r.type === 'Single'),
            compilations: all.filter(r => r.type === 'Compilation'),
        };
    };

    // A credited track only counts toward the artist's OWN releases when the
    // album is theirs (album artist matches). A credited track on a comp owned
    // by someone else — a VA "Dream Dance" volume, another DJ's mix — is a
    // guest appearance and belongs under "Also appears on" instead.
    const { ownReleaseTracks, guestCompilationTracks } = useMemo(() => {
        const artistKey = normalizeArtistIdentityKey(artistName);
        if (!artistKey) {
            return { ownReleaseTracks: primaryTracks, guestCompilationTracks: [] as TrackInfo[] };
        }
        const own: TrackInfo[] = [];
        const guest: TrackInfo[] = [];
        for (const t of primaryTracks) {
            const isComp = !!t.isCompilation
                || (t.releaseType || '').toLowerCase().includes('compilation');
            const ownerKey = normalizeArtistIdentityKey(t.albumArtist || t.artist || '');
            (isComp && ownerKey && ownerKey !== artistKey ? guest : own).push(t);
        }
        return { ownReleaseTracks: own, guestCompilationTracks: guest };
    }, [primaryTracks, artistName]);

    const primaryReleaseTracks = useMemo(
        () => [...ownReleaseTracks, ...collaborationTracks],
        [ownReleaseTracks, collaborationTracks]
    );
    const releaseGroups = useMemo(() => buildReleaseGroups(primaryReleaseTracks), [primaryReleaseTracks]);
    const featuredGroups = useMemo(
        () => buildReleaseGroups([...featuredTracks, ...guestCompilationTracks]),
        [featuredTracks, guestCompilationTracks]
    );

    // VA pseudo-artists own their comps by album-artist name only — the
    // endpoint ships those as lean album rows (ownedAlbums) instead of
    // thousands of tracks. Fold them into the Compilations section as
    // track-less cards; play uses whatever tracks the lazy library cache
    // already holds, and the subtitle uses the server-side track count.
    // Cover art builds a LOCAL /api/art URL from the row's representative
    // art_hash (like the Albums grid) so hundreds of cards don't stampede
    // the rate-limited external art proxy.
    const compilationReleases = useMemo(() => {
        const owned = artistMeta?.ownedAlbums || [];
        if (owned.length === 0) return releaseGroups.compilations;
        const token = mediaAccessToken || authToken || '';
        const artHashUrl = (al: OwnedAlbumRow) =>
            al.art_hash ? `/api/art?hash=${al.art_hash}${token ? `&token=${token}` : ''}` : undefined;
        const seen = new Set(releaseGroups.compilations.map(a => a.albumId).filter(Boolean));
        const extra = owned.filter(al => al.id && !seen.has(al.id)).map(al => ({
            title: al.title || 'Unknown Album',
            artist: al.artist_name || artistName,
            artUrl: artUrlByAlbumId.get(al.id) || artHashUrl(al) || al.image_url || undefined,
            albumId: al.id,
            editionLabel: al.edition_label || undefined,
            type: 'Compilation' as const,
            tracks: tracksByAlbumId.get(al.id) || [],
            trackCount: al.track_count,
        }));
        return [...releaseGroups.compilations, ...extra]
            .sort((a, b) => a.title.localeCompare(b.title));
    }, [releaseGroups.compilations, artistMeta, artistName, artUrlByAlbumId, tracksByAlbumId, mediaAccessToken, authToken]);

    const popularLibraryTracks = useMemo(() => {
        if (externalTopTracks.length === 0) return [];
        const localTracks = [...primaryTracks, ...collaborationTracks, ...featuredTracks];
        const byExactTitle = new Map<string, TrackInfo[]>();
        const byLooseTitle = new Map<string, TrackInfo[]>();

        for (const track of localTracks) {
            const displayTitle = track.title || track.path.split(/[\\/]/).pop() || '';
            const exactKey = normalizePopularTitle(displayTitle);
            const looseKey = normalizePopularTitle(displayTitle.replace(/\s*[-–—]\s*(remaster|remastered|version|edit|mono|stereo).*/i, ''));
            if (!exactKey) continue;
            byExactTitle.set(exactKey, [...(byExactTitle.get(exactKey) || []), track]);
            byLooseTitle.set(looseKey, [...(byLooseTitle.get(looseKey) || []), track]);
        }

        const seen = new Set<string>();
        return externalTopTracks.flatMap((topTrack, rank) => {
            const key = normalizePopularTitle(topTrack.name);
            const candidates = byExactTitle.get(key) || byLooseTitle.get(key) || [];
            const track = candidates
                .filter(candidate => !seen.has(candidate.id))
                .sort((a, b) => (b.playCount || 0) - (a.playCount || 0) || (a.album || '').localeCompare(b.album || ''))[0];

            if (!track) return [];
            seen.add(track.id);
            return [{
                track,
                rank: rank + 1,
                playcount: topTrack.playcount,
                listeners: topTrack.listeners,
            }];
        }).slice(0, 10);
    }, [externalTopTracks, primaryTracks, collaborationTracks, featuredTracks]);

    const hasPopularInLibrary = popularLibraryTracks.length > 0;
    const popularTrackQueue = useMemo(
        () => popularLibraryTracks.map(entry => entry.track),
        [popularLibraryTracks]
    );
    const handlePlayPopularTracks = useCallback((startIndex = 0) => {
        if (popularTrackQueue.length === 0) return;
        // "Popular in your library" is the Last.fm top-tracks list — treat it as the
        // artist itself so the now-playing title links back to the artist page.
        setPlaylist(popularTrackQueue, startIndex, artistId ? { kind: 'artist-top', id: artistId } : null);
    }, [popularTrackQueue, setPlaylist, artistId]);

    // Merged, deduplicated tags: communityTags take priority; plain genres fill in unique gaps
    const mergedTags = useMemo(() => {
        const result: Array<{ name: string; isCommunity: boolean; providers?: string[]; count?: number }> = [];
        const seen = new Set<string>();
        for (const tag of (communityTags || [])) {
            const key = tag.name.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                result.push({ name: tag.name, isCommunity: true, providers: tag.providers, count: tag.count });
            }
        }
        for (const g of (genres || [])) {
            const key = g.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                result.push({ name: g, isCommunity: false });
            }
        }
        return result.slice(0, 12);
    }, [genres, communityTags]);

    // Credit-only artists (e.g. a composer with no tracks they primarily perform)
    // have no primary/collab/featured tracks, but their page is still meaningful:
    // it shows the roles they hold and the albums they're credited on. Count that
    // as content so the page renders instead of falling through to "not found".
    const hasCreditContent = rolesInLibrary.length > 0 ||
        Object.values(albumsByRole).some(list => Array.isArray(list) && list.length > 0);
    const hasAnyContent = primaryTracks.length > 0 || collaborationTracks.length > 0 || featuredTracks.length > 0
        || (artistMeta?.ownedAlbums?.length || 0) > 0 || hasCreditContent;

    if ((isLibraryLoading || artistTracksLoading || creditsLoading) && (!artistName || !hasAnyContent)) {
        return <ArtistDetailSkeleton onBack={() => navigate(-1)} hero={heroState} />;
    }

    if (!artistName || !hasAnyContent) {
        if (heroState && (heroState.name || heroState.imageUrl)) {
            return <ArtistDetailSkeleton onBack={() => navigate(-1)} hero={heroState} />;
        }
        return (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
                <Users className="w-12 h-12 text-[var(--color-text-muted)] opacity-30 mb-4" />
                <p className="text-lg font-medium text-[var(--color-text-secondary)]">Artist not found</p>
                <p className="text-sm text-[var(--color-text-muted)] mt-1">This artist may not have any tracks in your library.</p>
            </div>
        );
    }

    return (
        <div className="artist-detail page-container relative">
            {artworkUrl && <FadedHeroImage src={artworkUrl} variant="wide" />}
            <div className="relative z-10">
                <BackButton onClick={() => navigate(-1)} />

                <div className="flex flex-col md:flex-row gap-8 items-start mb-8 md:mb-12">
                    {imageUrl ? (
                        <div
                            className="w-48 h-48 md:w-64 md:h-64 rounded-full overflow-hidden shrink-0 shadow-[var(--shadow-md)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)]"
                        >
                            <img src={imageUrl} alt={artistName} className="w-full h-full object-cover" />
                        </div>
                    ) : (
                        <div
                            className={`w-48 h-48 md:w-64 md:h-64 rounded-full overflow-hidden shrink-0 shadow-[var(--shadow-md)] border-4 border-[var(--glass-border)] bg-[var(--glass-bg)] flex items-center justify-center ${artistLoading ? 'animate-pulse motion-reduce:animate-none' : ''}`}
                        >
                            <ArtistInitial name={artistName} />
                        </div>
                    )}

                    <div className="flex-1">
                        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                            <h1 className="font-bold text-4xl md:text-6xl lg:text-7xl tracking-tight text-[var(--color-text-primary)]">
                                {artistName}
                            </h1>
                            <OnTourSticker visible={onTour} />
                            {isArtistPlaying && playbackState !== 'stopped' && (
                                <NowPlayingBadge state={playbackState === 'playing' ? 'playing' : 'paused'} className="self-end mb-1.5 shrink-0" />
                            )}
                        </div>

                        {/* Band members */}
                        {members && members.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1 mb-3">
                                <span className="text-xs text-[var(--color-text-muted)] mr-1">Members:</span>
                                {members.map((m, i) => (
                                    <span key={m} className="text-xs text-[var(--color-text-secondary)]">
                                        {m}{i < members.length - 1 ? ',' : ''}
                                    </span>
                                ))}
                            </div>
                        )}

                        {/* Artist meta line — roles from on-disk credits sit
                            alongside the MusicBrainz-sourced type / area /
                            lifespan items, in the same style. Roles take the
                            lead position so they sit right under the name. */}
                        {(rolesInLibrary.length > 1 || disambiguation || type || area || lifeSpan?.begin) && (
                            <div className="flex flex-wrap items-center gap-3 mb-3 text-xs text-[var(--color-text-muted)]">
                                {rolesInLibrary.length > 1 && (
                                    <span className="inline-flex items-center gap-1">
                                        <Tag className="w-3 h-3" />
                                        {rolesInLibrary.map(r => r.role).join(' · ')}
                                    </span>
                                )}
                                {type && (
                                    <span className="inline-flex items-center gap-1">
                                        {type === 'Group' ? <Users className="w-3 h-3" /> : type === 'Person' ? <Mic2 className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
                                        {type}
                                        {disambiguation && (
                                            <span className="italic text-[var(--color-text-muted)]">
                                                {' – '}{disambiguation}
                                            </span>
                                        )}
                                    </span>
                                )}
                                {!type && disambiguation && (
                                    <span className="italic text-[var(--color-text-muted)]">{disambiguation}</span>
                                )}
                                {area && (
                                    <span className="inline-flex items-center gap-1">
                                        <Globe className="w-3 h-3" />
                                        {area}
                                    </span>
                                )}
                                {lifeSpan?.begin && (
                                    <span className="inline-flex items-center gap-1">
                                        <Calendar className="w-3 h-3" />
                                        {lifeSpan.begin}{lifeSpan.end ? ` – ${lifeSpan.end}` : ' – present'}
                                    </span>
                                )}
                            </div>
                        )}

                        {/* Local library stats */}
                        {(libraryStats.totalTracks > 0 || listeners) && (
                            <div className="flex items-center gap-3 mb-3 text-xs text-[var(--color-text-muted)]">
                                {libraryStats.totalTracks > 0 && (
                                    <span className="inline-flex items-center gap-1">
                                        <Music2 className="w-3 h-3" />
                                        {libraryStats.totalTracks} track{libraryStats.totalTracks !== 1 ? 's' : ''}
                                    </span>
                                )}
                                {libraryStats.totalAlbums > 0 && (
                                    <span className="inline-flex items-center gap-1">
                                        <BookOpen className="w-3 h-3" />
                                        {libraryStats.totalAlbums} album{libraryStats.totalAlbums !== 1 ? 's' : ''}
                                    </span>
                                )}
                                {libraryStats.totalDuration > 60 && (
                                    <span className="inline-flex items-center gap-1">
                                        <Clock className="w-3 h-3" />
                                        {formatDuration(libraryStats.totalDuration)}
                                    </span>
                                )}
                                {listeners && (
                                    <span className="inline-flex items-center gap-1">
                                        <Headphones className="w-3 h-3" />
                                        {formatListeners(listeners)}
                                    </span>
                                )}
                            </div>
                        )}

                        <div className="mt-4 mb-4 flex flex-wrap items-center gap-3">
                            <button
                                type="button"
                                onClick={handlePlayArtistRadio}
                                disabled={!artistId || radioLoading || radioEligibility.checking || !radioEligibility.eligible}
                                title={
                                    radioLoading ? 'Building radio…'
                                    : radioEligibility.checking ? 'Checking radio…'
                                    : !radioEligibility.eligible ? (radioEligibility.reason || 'Radio not available for this artist')
                                    : 'Play a mix inspired by this artist'
                                }
                                aria-label={hasPopularInLibrary ? 'Play artist radio' : undefined}
                                className={`${hasPopularInLibrary ? 'h-12 w-12 px-0 shrink-0' : 'w-full px-8 sm:w-auto'} flex items-center justify-center gap-2 py-3.5 bg-[var(--color-primary)] text-white font-bold text-sm tracking-widest uppercase rounded-full shadow-[0_4px_24px_rgba(16,185,129,0.22)] hover:bg-[var(--color-primary-dark)] hover:scale-[1.02] active:scale-[0.98] disabled:opacity-55 disabled:cursor-not-allowed transition-ui`}
                            >
                                {radioLoading ? (
                                    <span className="w-[18px] h-[18px] rounded-full border-2 border-white/40 border-t-white animate-spin" />
                                ) : (
                                    <Radio size={18} />
                                )}
                                {!hasPopularInLibrary && (radioLoading ? 'Building…' : 'Play artist radio')}
                            </button>

                            {hasPopularInLibrary && (
                                <button
                                    type="button"
                                    onClick={() => handlePlayPopularTracks(0)}
                                    className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-[var(--color-primary)] px-6 py-3.5 text-sm font-bold uppercase tracking-widest text-white shadow-[0_4px_24px_rgba(16,185,129,0.22)] transition-ui hover:bg-[var(--color-primary-dark)] hover:scale-[1.02] active:scale-[0.98] sm:flex-none"
                                >
                                    <Play className="h-4 w-4 shrink-0" fill="currentColor" />
                                    <span className="truncate">Play {artistName}</span>
                                </button>
                            )}

                            <button
                                ref={linksButtonRef}
                                type="button"
                                onClick={() => setLinksMenuOpen(open => !open)}
                                disabled={allLinks.length === 0}
                                aria-label="Artist links"
                                aria-haspopup="menu"
                                aria-expanded={linksMenuOpen}
                                title={allLinks.length > 0 ? 'Artist links' : 'No artist links available'}
                                className="absolute right-0 top-0 z-20 inline-flex h-10 w-10 items-center justify-center rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-text-secondary)] shadow-[var(--shadow-sm)] transition-ui hover:border-[var(--glass-border-hover)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--color-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none md:static md:z-auto md:h-12 md:w-12"
                            >
                                <Link2 className="w-5 h-5" />
                            </button>

                            <ContextMenuPortal
                                open={linksMenuOpen && allLinks.length > 0}
                                onClose={() => setLinksMenuOpen(false)}
                                anchorRef={linksButtonRef}
                                desktopWidth={248}
                                desktopHeight={320}
                            >
                                {({ isMobile }) => (
                                    <ContextMenuFrame isMobile={isMobile}>
                                        <ContextMenuHeader
                                            title="Artist links"
                                            subtitle={`${allLinks.length} ${allLinks.length === 1 ? 'link' : 'links'}`}
                                        />
                                        <ContextMenuList className="max-h-64 overflow-y-auto">
                                            {allLinks.map((link, i) => (
                                                <ContextMenuLink
                                                    key={`${link.url}-${i}`}
                                                    href={link.url}
                                                    icon={<ExternalLink className="h-[15px] w-[15px]" />}
                                                    label={getLinkLabel(link.url, link.type)}
                                                    secondary={link.type || undefined}
                                                    onClick={() => setLinksMenuOpen(false)}
                                                />
                                            ))}
                                        </ContextMenuList>
                                    </ContextMenuFrame>
                                )}
                            </ContextMenuPortal>
                        </div>

                        {bio && (
                            <div className="mt-1">
                                <p className={`text-sm md:text-base text-[var(--color-text-secondary)] leading-relaxed max-w-3xl ${bioExpanded ? '' : 'line-clamp-4'}`}>
                                    {bio}
                                </p>
                                <button
                                    onClick={() => setBioExpanded(!bioExpanded)}
                                    className="text-xs font-medium text-[var(--color-primary)] hover:text-[var(--color-primary-dark)] mt-1 transition-colors motion-reduce:transition-none"
                                >
                                    {bioExpanded ? 'Show less' : 'Read more'}
                                </button>
                            </div>
                        )}
                        {artistLoading && !bio && (
                            <div className="mt-1 space-y-2 max-w-3xl">
                                <div className="h-4 w-full rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                                <div className="h-4 w-5/6 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                                <div className="h-4 w-2/3 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                            </div>
                        )}

                        {mergedTags.length > 0 && (
                            <div className="mt-4 flex flex-wrap gap-1.5">
                                {mergedTags.map(tag => (
                                    tag.isCommunity ? (
                                        <span
                                            key={tag.name}
                                            title={`From ${(tag.providers || []).map(p => p === 'lastfm' ? 'Last.fm' : 'MusicBrainz').join(' + ')}${tag.count ? ` · ${tag.count}` : ''}`}
                                            className="px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-[0.16em] bg-emerald-500/10 text-[var(--color-primary)] border border-emerald-500/20"
                                        >
                                            {tag.name}
                                        </span>
                                    ) : (
                                        <span
                                            key={tag.name}
                                            className="px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--color-surface-variant)] text-[var(--color-text-muted)] border border-[var(--glass-border)]"
                                        >
                                            {tag.name}
                                        </span>
                                    )
                                ))}
                            </div>
                        )}

                    </div>
                </div>

                {hasPopularInLibrary && (
                    <section className="mb-12">
                        <div className="flex items-center justify-between gap-4 mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2">
                            <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] flex items-center gap-2">
                                <Sparkles className="w-4 h-4 text-[var(--color-primary)] opacity-70" />
                                Popular in your library
                            </h3>
                        </div>

                        {/* Column headers */}
                        <div className="grid grid-cols-[24px_40px_minmax(0,1fr)] md:grid-cols-[34px_52px_minmax(0,1.7fr)_minmax(160px,1fr)_120px_56px] gap-2 md:gap-3 px-1.5 md:px-4 py-3 border-b border-black/5 dark:border-white/10 font-semibold text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                            <div className="text-center md:text-left">#</div>
                            <div aria-hidden="true" />
                            <div>Title</div>
                            <div className="hidden md:block">Album</div>
                            <div className="hidden md:block">Last.fm plays</div>
                            <div className="hidden md:block text-right">Time</div>
                        </div>

                        <div className="space-y-0.5">
                            {popularLibraryTracks.slice(0, popularExpanded ? 10 : 5).map(({ track, rank, playcount, listeners }, index) => {
                                const isCurrentPopular = track.id === currentTrackId;
                                return (
                                <div
                                    key={track.id}
                                    onClick={() => handlePlayPopularTracks(index)}
                                    className={`grid grid-cols-[24px_40px_minmax(0,1fr)] md:grid-cols-[34px_52px_minmax(0,1.7fr)_minmax(160px,1fr)_120px_56px] gap-2 md:gap-3 px-1.5 md:px-4 py-2 border-b border-black/5 dark:border-white/5 cursor-pointer items-center transition-ui duration-200 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg my-0.5 group ${isCurrentPopular ? 'bg-primary/5' : ''}`}
                                >
                                    {/* Rank */}
                                    <div className="flex items-center justify-center md:justify-start text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors text-sm tabular-nums">
                                        {isCurrentPopular && playbackState !== 'stopped' ? (
                                            <NowPlayingBars state={playbackState === 'playing' ? 'playing' : 'paused'} />
                                        ) : (
                                            rank
                                        )}
                                    </div>

                                    {/* Art */}
                                    <div className="h-10 w-10 md:h-11 md:w-11 shrink-0 overflow-hidden rounded-lg border border-black/10 dark:border-white/10 bg-black/10 dark:bg-white/10">
                                        {track.artUrl ? (
                                            <img src={track.artUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                                        ) : (
                                            <div className="flex h-full w-full items-center justify-center">
                                                <Disc3 className="h-5 w-5 text-[var(--color-text-muted)] opacity-40" />
                                            </div>
                                        )}
                                    </div>

                                    {/* Title + artist */}
                                    <div className="min-w-0">
                                        <span className="block truncate text-sm md:text-base font-medium text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors">
                                            {track.title || track.path.split(/[\\/]/).pop()}
                                        </span>
                                        <span className="block text-xs text-[var(--color-text-muted)] mt-0.5 truncate">
                                            {track.artist || track.albumArtist || 'Unknown Artist'}
                                        </span>
                                    </div>

                                    {/* Album */}
                                    <div className="hidden md:block min-w-0">
                                        <span className="block truncate text-sm text-[var(--color-text-secondary)]">
                                            {track.album || '--'}
                                        </span>
                                    </div>

                                    {/* Last.fm plays */}
                                    <div className="hidden md:flex items-center gap-1 text-sm text-[var(--color-text-muted)] tabular-nums">
                                        {(playcount || listeners) ? (
                                            <>
                                                <Headphones className="w-3.5 h-3.5 shrink-0" />
                                                <span>{formatCompactCount(playcount) || formatCompactCount(listeners)}</span>
                                                <span className="text-xs">{playcount ? 'plays' : 'listeners'}</span>
                                            </>
                                        ) : '--'}
                                    </div>

                                    {/* Duration */}
                                    <div className="hidden md:block text-[var(--color-text-muted)] text-sm tabular-nums text-right">
                                        {formatTime(track.duration, '--:--')}
                                    </div>
                                </div>
                                );
                            })}
                        </div>

                        {popularLibraryTracks.length > 5 && (
                            <button
                                onClick={() => setPopularExpanded(e => !e)}
                                className="mt-3 w-full py-2 text-xs font-semibold uppercase tracking-widest text-[var(--color-text-muted)] hover:text-[var(--color-primary)] transition-colors"
                            >
                                {popularExpanded
                                    ? 'See less'
                                    : `See ${popularLibraryTracks.length - 5} more`}
                            </button>
                        )}
                    </section>
                )}

                <MusicVideos
                    videos={musicVideos}
                    loading={musicVideosLoading}
                    stale={musicVideosStale}
                />

                <UpcomingShows
                    events={upcomingEvents}
                    loading={concertsLoading}
                    stale={concertsStale}
                />

                {/* Role-filter chip row. The chip order mirrors the
                    user's library: a producer-credited artist sees
                    `producer` first; a composer sees `composer` first.
                    The visual is the same lowercase pill we use for the
                    Hub "Uniquely yours" badges and the AlbumCard edition
                    label, keeping the chrome consistent. */}
                {rolesInLibrary.length > 1 && (
                    <div className="mb-6 flex flex-wrap items-center gap-2">
                        {[{ role: 'all', credits: 0 }, ...rolesInLibrary].map((r) => {
                            const isActive = selectedRole === r.role;
                            return (
                                <button
                                    key={r.role}
                                    type="button"
                                    onClick={() => setSelectedRole(r.role)}
                                    className={`text-[10px] font-bold uppercase tracking-[0.15em] px-2.5 py-1 rounded-full backdrop-blur-sm border transition-ui ${
                                        isActive
                                            ? 'bg-[var(--color-primary)] text-white border-[var(--color-primary)]'
                                            : 'bg-black/5 dark:bg-white/5 text-[var(--color-text-secondary)] border-[var(--glass-border)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]'
                                    }`}
                                    aria-pressed={isActive}
                                >
                                    {r.role}
                                    {r.role !== 'all' && (
                                        <span className="ml-1.5 opacity-60">{r.credits}</span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                )}

                {selectedRole === 'all' ? (
                    /* Default view: Albums / EPs / Singles / Compilations */
                    [
                        { title: 'Albums', data: releaseGroups.albums },
                        { title: 'EPs', data: releaseGroups.eps },
                        { title: 'Singles', data: releaseGroups.singles },
                        { title: 'Compilations', data: compilationReleases }
                    ].map((section) => section.data.length > 0 && (
                        <div key={section.title} className="mb-12">
                            <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2">{section.title}</h3>
                            <div className="album-grid">
                                {section.data.map(album => {
                                    const trackCount = album.trackCount ?? album.tracks.length;
                                    return (
                                        <AlbumCard
                                            key={album.albumId || `${album.title}-${album.artist}`}
                                            title={album.title}
                                            artist={album.artist}
                                            artUrl={album.artUrl}
                                            subtitle={`${trackCount} track${trackCount !== 1 ? 's' : ''}`}
                                            editionLabel={album.editionLabel}
                                            linkTo={album.albumId ? `/library/album/${album.albumId}` : undefined}
                                            linkState={{ backLabel: 'Back to Artist' }}
                                            onPlay={() => { if (album.tracks.length > 0) setPlaylist(album.tracks, 0); }}
                                        />
                                    );
                                })}
                            </div>
                        </div>
                    ))
                ) : (
                    /* Role-filtered view: a single section listing albums
                       where this artist holds the selected role. The
                       backend has already pre-sorted by year DESC, title. */
                    <div className="mb-12">
                        <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2">
                            {selectedRole} credits
                        </h3>
                        {(albumsByRole[selectedRole] || []).length === 0 ? (
                            <div className="text-sm text-[var(--color-text-muted)]">No albums with this credit.</div>
                        ) : (
                            <div className="album-grid">
                                {(albumsByRole[selectedRole] || []).map((al: any) => {
                                    // Prefer file-embedded art (works fully offline / no 3rd-party);
                                    // fall back to any cached external image_url on the album row.
                                    const localArt = artUrlByAlbumId.get(al.id);
                                    const albumTracks = tracksByAlbumId.get(al.id) || [];
                                    return (
                                        <AlbumCard
                                            key={al.id}
                                            title={al.title}
                                            artist={al.artist_name || artistName}
                                            artUrl={localArt || al.image_url || undefined}
                                            subtitle={al.credited_track_count
                                                ? `${al.credited_track_count} track${al.credited_track_count !== 1 ? 's' : ''}`
                                                : undefined}
                                            editionLabel={al.edition_label}
                                            linkTo={`/library/album/${al.id}`}
                                            linkState={{ backLabel: 'Back to Artist' }}
                                            onPlay={() => { if (albumTracks.length > 0) setPlaylist(albumTracks, 0); }}
                                        />
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

            {/* Also Appears On — hidden when a role filter is active, since
                the role-filtered view above already shows the role-relevant
                slice across primary + featured albums. */}
            {selectedRole === 'all' && [
                ...featuredGroups.albums,
                ...featuredGroups.eps,
                ...featuredGroups.singles,
                ...featuredGroups.compilations,
            ].length > 0 && (
                <div className="mb-12">
                    <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2 flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-[var(--color-primary)] opacity-60" /> Also appears on
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
                                editionLabel={album.editionLabel}
                                linkTo={album.albumId ? `/library/album/${album.albumId}` : undefined}
                                linkState={{ backLabel: 'Back to Artist' }}
                                onPlay={() => setPlaylist(album.tracks, 0)}
                            />
                        ))}
                    </div>
                </div>
            )}

            <SimilarArtistsSection artists={similarArtists} loading={similarArtistsLoading} />
            </div>
        </div>
    );
};
