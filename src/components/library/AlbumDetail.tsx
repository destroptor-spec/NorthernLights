import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { AlbumArt } from '../AlbumArt';
import { AlbumCoverDisc } from './AlbumCoverDisc';
import { useEntityTracks } from '../../hooks/useEntityTracks';
import { parseArtistsForDisplay } from '../../utils/artistUtils';
import { useKnownArtistKeys } from '../../hooks/useKnownArtistKeys';
import { formatTime } from '../../utils/formatTime';
import { buildArtistLinkMap } from '../../utils/artistLinks';
import { BackButton } from './BackButton';
import { useAlbumData } from '../../hooks/useAlbumData';
import { LoveButton } from '../LoveButton';
import { ContextMenuFrame, ContextMenuHeader, ContextMenuLink, ContextMenuList, ContextMenuPortal, ContextMenuButton, ContextMenuDivider } from '../ContextMenu';
import type { TrackInfo } from '../../utils/fileSystem';
import { useIsCurrentCollection, useIsCurrentTrack, useNowPlayingState } from '../../hooks/useNowPlaying';
import { NowPlayingBadge } from '../now-playing/NowPlayingBadge';
import { NowPlayingBars } from '../now-playing/NowPlayingBars';

import { MoreHorizontal, Play, Clock, ExternalLink, Headphones, BarChart2, Link2, Music2, Calendar, Gauge, Disc3, X, Search, Plus, Users, Layers, Settings } from 'lucide-react';
import type { AlbumInfo, TrackCredit } from '../../store/index';
import { readAlbumHeroState, type AlbumHeroState } from '../../utils/heroState';

interface EditionRow extends AlbumInfo {
    track_count?: number;
    // Modal tracks.mb_album_id for this edition — the real release MBID from
    // file tags. albums.mbid is never populated, so this is the only usable
    // release id for Cover Art Archive lookups.
    representative_release_mbid?: string | null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m} min`;
}

function formatQuality(format: string | undefined, bitrate: number | undefined, lossless?: boolean): string | null {
    if (!format) return null;
    const fmt = format.toUpperCase();
    // Prefer the authoritative flag (correctly identifies ALAC, whose container
    // string is just "M4A/…"); fall back to the format-name heuristic when unknown
    // (null/undefined — e.g. rows not yet rescanned/backfilled).
    const isLossless = lossless === true
        || (lossless == null && ['FLAC', 'ALAC', 'WAV', 'AIFF', 'APE', 'WV'].includes(fmt));
    if (isLossless) return `${fmt} · Lossless`;
    if (bitrate && bitrate > 0) return `${fmt} · ${Math.round(bitrate / 1000)}kbps`;
    return fmt;
}

function formatCount(raw: string | undefined): string | null {
    if (!raw) return null;
    const n = parseInt(raw, 10);
    if (isNaN(n)) return null;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
    return n.toLocaleString();
}

function getLinkLabel(url: string, type: string): string {
    const u = url.toLowerCase();
    if (u.includes('spotify.com')) return 'Spotify';
    if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
    if (u.includes('bandcamp.com')) return 'Bandcamp';
    if (u.includes('soundcloud.com')) return 'SoundCloud';
    if (u.includes('discogs.com')) return 'Discogs';
    if (u.includes('allmusic.com')) return 'AllMusic';
    if (u.includes('wikipedia.org')) return 'Wikipedia';
    if (u.includes('last.fm') || u.includes('lastfm.')) return 'Last.fm';
    if (u.includes('apple.com') || u.includes('music.apple')) return 'Apple Music';
    if (u.includes('tidal.com')) return 'Tidal';
    if (u.includes('deezer.com')) return 'Deezer';
    if (u.includes('musicbrainz.org')) return 'MusicBrainz';
    if (type === 'official homepage' || type === 'official audio source') return 'Official Site';
    return type || 'Link';
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

const TrackRowSkeleton: React.FC = () => (
    <div className="grid grid-cols-[30px_1fr_40px] md:grid-cols-[40px_1fr_100px] gap-2 px-2 md:px-4 py-2.5 animate-pulse">
        <div className="flex justify-center md:justify-start">
            <div className="h-4 w-4 rounded bg-[var(--color-surface-variant)]" />
        </div>
        <div className="space-y-1.5">
            <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)]" />
            <div className="h-3 w-1/2 rounded bg-[var(--color-surface-variant)] md:hidden" />
        </div>
        <div className="hidden md:flex justify-end">
            <div className="h-4 w-10 rounded bg-[var(--color-surface-variant)]" />
        </div>
    </div>
);

const AlbumDetailSkeleton: React.FC<{ onBack: () => void; hero?: AlbumHeroState }> = ({ onBack, hero }) => {
    const hasHero = !!hero && (!!hero.title || !!hero.artUrl);
    return (
        <div className="flex flex-col overflow-hidden p-4 md:p-8 lg:p-12 flex-1">
            <div className="shrink-0 mb-6"><BackButton onClick={onBack} /></div>
            <div className="flex flex-col md:flex-row gap-6 md:gap-8 mb-8 md:mb-12 items-center md:items-end text-center md:text-left">
                {hasHero ? (
                    <div
                        className="w-48 h-48 md:w-60 md:h-60 shrink-0 rounded-2xl border border-black/10 dark:border-white/10 shadow-2xl relative overflow-hidden bg-black/10 dark:bg-white/5"
                    >
                        <AlbumArt artUrl={hero?.artUrl} artist={hero?.artist} size={640} className="w-full h-full object-cover rounded-2xl" />
                    </div>
                ) : (
                    <div
                        className="w-48 h-48 md:w-60 md:h-60 shrink-0 rounded-2xl bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none"
                    />
                )}
                <div className="flex-1 space-y-3">
                    {hasHero ? (
                        <>
                            <div className="font-semibold text-sm tracking-wider uppercase text-[var(--color-primary)]">Album</div>
                            <h1 className="font-bold text-4xl md:text-5xl lg:text-6xl tracking-tight leading-tight text-[var(--color-text-primary)] line-clamp-2" title={hero?.title}>
                                {hero?.title}
                            </h1>
                            {hero?.artist && (
                                <div className="text-base md:text-xl text-[var(--color-text-secondary)]">{hero.artist}</div>
                            )}
                            {hero?.subtitle && (
                                <div className="text-xs text-[var(--color-text-muted)]">{hero.subtitle}</div>
                            )}
                        </>
                    ) : (
                        <>
                            <div className="h-4 w-16 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                            <div className="h-10 w-3/4 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                            <div className="h-5 w-1/2 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" />
                            <div className="h-10 w-32 rounded-full bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none mt-4" />
                        </>
                    )}
                </div>
            </div>
            <div className="space-y-0.5">
                {Array.from({ length: 8 }).map((_, i) => <TrackRowSkeleton key={i} />)}
            </div>
        </div>
    );
};

interface AlbumDiscHeaderRow {
    type: 'disc';
    disc: number;
}

interface AlbumTrackListRow {
    type: 'track';
    track: TrackInfo;
    index: number;
}

type AlbumListRow = AlbumDiscHeaderRow | AlbumTrackListRow;

interface AlbumTrackRowProps {
    track: TrackInfo;
    index: number;
    displayNumber: number;
    getArtistLink: (artistName: string) => string | null;
    onPlay: (index: number) => void;
    onContextMenu: (track: TrackInfo, x: number, y: number) => void;
    playbackState: 'playing' | 'paused' | 'stopped';
    inlineCredits?: Array<{ role: string; name: string; artistId: string }>;
}

// Headline roles surfaced on the track row. Ordering precedence when
// more than two are tagged: remixer > composer > producer > conductor
// > lyricist. The genre-driven tagging conventions almost never collide
// in practice (a trance track has no composer; a Brahms track has no
// remixer) so this ordering serves both audiences cleanly.
const INLINE_ROLE_ORDER = ['remixer', 'composer', 'producer', 'conductor', 'lyricist'] as const;
type InlineRole = typeof INLINE_ROLE_ORDER[number];
const INLINE_ROLE_SET = new Set<string>(INLINE_ROLE_ORDER);

const AlbumDiscHeader = memo(({ disc }: { disc: number }) => (
    <div className="px-2 md:px-4 pt-4 pb-1 text-xs font-semibold uppercase tracking-widest text-[var(--color-primary)] border-b border-black/5 dark:border-white/10 mb-1">
        Disc {disc}
    </div>
));

AlbumDiscHeader.displayName = 'AlbumDiscHeader';

const AlbumTrackRow = memo(({
    track,
    index,
    displayNumber,
    getArtistLink,
    onPlay,
    onContextMenu,
    playbackState,
    inlineCredits,
}: AlbumTrackRowProps) => {
    const knownArtistKeys = useKnownArtistKeys();
    const isCurrent = useIsCurrentTrack(track.id);
    const artistNames = useMemo(() => {
        const raw = Array.isArray(track.artists) && track.artists.length > 0
            ? track.artists
            : parseArtistsForDisplay(track.artist || '', knownArtistKeys);
        // Re-explode each entry so a single-element array like
        // ["Tony Bennett & Lady Gaga"] becomes ["Tony Bennett", "Lady Gaga"]
        // when both halves resolve to known artists.
        return raw.flatMap(n => parseArtistsForDisplay(n, knownArtistKeys));
    }, [track.artists, track.artist, knownArtistKeys]);

    return (
        <div
            onClick={() => onPlay(index)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onPlay(index);
                }
            }}
            className={`grid grid-cols-[30px_1fr_40px] md:grid-cols-[40px_1fr_100px] gap-2 px-2 md:px-4 py-2 border-b border-black/5 dark:border-white/5 cursor-pointer items-center transition-ui duration-200 hover:bg-black/5 dark:hover:bg-white/5 focus-visible:bg-black/5 dark:focus-visible:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] rounded-lg my-0.5 group ${isCurrent ? 'bg-primary/5' : ''}`}
        >
            <div className="flex items-center justify-center md:justify-start text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors text-sm tabular-nums">
                {isCurrent && playbackState !== 'stopped' ? (
                    <NowPlayingBars state={playbackState === 'playing' ? 'playing' : 'paused'} />
                ) : (
                    displayNumber
                )}
            </div>
            <div className="font-medium truncate text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors min-w-0">
                <span className="block truncate text-sm md:text-base">{track.title || track.path.split(/[\/\\]/).pop()}</span>
                {(artistNames.length > 0 || (inlineCredits && inlineCredits.length > 0)) && (
                    <span className="block text-xs text-[var(--color-text-muted)] mt-0.5 truncate">
                        {artistNames.map((a, j) => {
                            const link = getArtistLink(a);
                            return (
                                <React.Fragment key={`${a}-${j}`}>
                                    {j > 0 && ' · '}
                                    {link ? (
                                        <Link
                                            to={link}
                                            state={{ backLabel: 'Back to Album' }}
                                            onClick={(e) => e.stopPropagation()}
                                            className="hover:text-[var(--color-primary)] transition-colors no-underline text-inherit"
                                        >{a}</Link>
                                    ) : (
                                        <span>{a}</span>
                                    )}
                                </React.Fragment>
                            );
                        })}
                        {/* Per-track headline credits (remixer / composer /
                            producer / conductor / lyricist) appended to the
                            artists line, each followed by a small lowercase
                            role suffix. Suppression rules in the parent stop
                            the primary artist from duplicating themselves. */}
                        {inlineCredits && inlineCredits.map((c, i) => {
                            const link = getArtistLink(c.name) || (c.artistId ? `/library/artist/${c.artistId}` : null);
                            const needsSep = artistNames.length > 0 || i > 0;
                            return (
                                <React.Fragment key={`cred-${c.role}-${c.name}-${i}`}>
                                    {needsSep && ' · '}
                                    {link ? (
                                        <Link
                                            to={link}
                                            state={{ backLabel: 'Back to Album' }}
                                            onClick={(e) => e.stopPropagation()}
                                            className="hover:text-[var(--color-primary)] transition-colors no-underline text-inherit"
                                        >{c.name}</Link>
                                    ) : (
                                        <span>{c.name}</span>
                                    )}
                                    <span className="opacity-60"> ({c.role})</span>
                                </React.Fragment>
                            );
                        })}
                    </span>
                )}
            </div>
            <div className="text-[var(--color-text-muted)] text-right group-hover:text-[var(--color-text-primary)] transition-colors flex flex-row items-center justify-end md:gap-3">
                <LoveButton
                    track={track}
                    size={16}
                    className="p-1.5 opacity-50 md:opacity-0 md:group-hover:opacity-100 focus:opacity-100"
                />
                <span className="w-12 text-right hidden md:inline text-sm tabular-nums">
                    {formatTime(track.duration, '--:--')}
                </span>
                <button
                    aria-label="More options"
                    onClick={(e) => {
                        e.stopPropagation();
                        onContextMenu(track, e.clientX, e.clientY);
                    }}
                    className="opacity-50 md:opacity-0 md:group-hover:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-black/5 dark:hover:bg-white/10 rounded-md transition-ui p-1.5 focus:opacity-100"
                >
                    <MoreHorizontal size={18} />
                </button>
            </div>
        </div>
    );
});

AlbumTrackRow.displayName = 'AlbumTrackRow';

// ─── Per-edition cover art (Cover Art Archive when MB is connected) ─────────
// Thumbnail in the "Other editions" strip prefers the per-release cover
// from the Cover Art Archive over the album row's image_url, since CAA
// reliably differentiates editions (remaster, deluxe, etc.) that often
// share an album-level image_url cached from another provider. The
// network request only fires when the user has opted into MusicBrainz —
// per Aurora's "usable without 3rd-party integrations" constraint.

interface EditionArtProps {
    mbReleaseId?: string | null;
    fallbackArtUrl?: string;
    artist: string;
    title: string;
}

const EditionArt: React.FC<EditionArtProps> = ({ mbReleaseId, fallbackArtUrl, artist, title }) => {
    const mbConnected = usePlayerStore(state => state.musicBrainzConnected);
    const [caaFailed, setCaaFailed] = useState(false);

    useEffect(() => { setCaaFailed(false); }, [mbReleaseId]);

    const caaUrl = mbConnected && mbReleaseId
        ? `https://coverartarchive.org/release/${encodeURIComponent(mbReleaseId)}/front-250`
        : null;

    if (caaUrl && !caaFailed) {
        return (
            <img
                src={caaUrl}
                alt=""
                loading="lazy"
                onError={() => setCaaFailed(true)}
                className="w-full h-full object-cover"
            />
        );
    }

    return (
        <AlbumArt
            artUrl={fallbackArtUrl}
            artist={artist}
            album={title}
            size={64}
            className="w-full h-full object-cover"
        />
    );
};

// ─── Manage editions modal ────────────────────────────────────────────────────
// Lets an admin pull another album into this album's release-group (merge)
// or split an edition out of the current group (unmerge). Server endpoints
// pin manual_group_override = TRUE so future rescans don't undo the call.

interface ManageEditionsModalProps {
    open: boolean;
    onClose: () => void;
    sourceAlbumId: string;
    sourceArtist: string;
    sourceTitle: string;
    editions: EditionRow[];
    onChanged: () => void;
    getAuthHeader: () => Record<string, string>;
}

const ManageEditionsModal: React.FC<ManageEditionsModalProps> = ({
    open, onClose, sourceAlbumId, sourceArtist, sourceTitle, editions, onChanged, getAuthHeader,
}) => {
    const allAlbums = usePlayerStore(state => state.albums);
    const [query, setQuery] = useState('');
    const [busy, setBusy] = useState(false);

    // Candidate list: same artist as the current album, not already in this
    // release-group. We don't restrict by normalized title — the whole point
    // of manual merge is to catch cases the heuristic missed.
    const candidates = useMemo(() => {
        const inGroup = new Set(editions.map(e => e.id));
        const q = query.trim().toLowerCase();
        const sameArtist = allAlbums.filter(al =>
            !inGroup.has(al.id) &&
            (al.artist_name || '').toLowerCase() === sourceArtist.toLowerCase() &&
            (q === '' || (al.title || '').toLowerCase().includes(q)),
        );
        return sameArtist.slice(0, 20);
    }, [allAlbums, editions, sourceArtist, query]);

    const handleMerge = async (targetAlbumId: string) => {
        if (busy) return;
        setBusy(true);
        try {
            const res = await fetch(`/api/albums/${targetAlbumId}/merge-into`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                body: JSON.stringify({ targetAlbumId: sourceAlbumId }),
            });
            if (res.ok) onChanged();
        } finally {
            setBusy(false);
        }
    };

    const handleUnmerge = async (albumIdToSplit: string) => {
        if (busy) return;
        setBusy(true);
        try {
            const res = await fetch(`/api/albums/${albumIdToSplit}/unmerge`, {
                method: 'POST',
                headers: getAuthHeader(),
            });
            if (res.ok) onChanged();
        } finally {
            setBusy(false);
        }
    };

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label="Manage editions"
        >
            <div
                className="w-full max-w-lg max-h-[80vh] flex flex-col rounded-2xl border border-[var(--glass-border)] bg-[var(--color-surface)] shadow-2xl overflow-hidden"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--glass-border)]">
                    <div>
                        <h2 className="font-semibold text-lg text-[var(--color-text-primary)]">manage editions</h2>
                        <p className="text-xs text-[var(--color-text-muted)] mt-0.5 truncate">{sourceTitle} · {sourceArtist}</p>
                    </div>
                    <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-md hover:bg-black/5 dark:hover:bg-white/10 text-[var(--color-text-muted)]">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
                    <section>
                        <h3 className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-2">in this group</h3>
                        <div className="space-y-1.5">
                            {editions.map(ed => (
                                <div key={ed.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5">
                                    <div className="min-w-0">
                                        <div className="text-sm text-[var(--color-text-primary)] truncate">{ed.title}</div>
                                        <div className="text-xs text-[var(--color-text-muted)] truncate">
                                            {ed.edition_label ? `${ed.edition_label.toLowerCase()} · ` : ''}
                                            {ed.release_year || ''}
                                            {typeof ed.track_count === 'number' ? ` · ${ed.track_count} track${ed.track_count !== 1 ? 's' : ''}` : ''}
                                        </div>
                                    </div>
                                    {editions.length > 1 && (
                                        <button
                                            type="button"
                                            disabled={busy}
                                            onClick={() => handleUnmerge(ed.id)}
                                            className="text-xs px-2 py-1 rounded-md border border-[var(--glass-border)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] text-[var(--color-text-secondary)] transition-ui disabled:opacity-50"
                                        >
                                            split out
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    </section>

                    <section>
                        <h3 className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-2">add another edition</h3>
                        <div className="relative mb-2">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                            <input
                                type="text"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder={`Search ${sourceArtist}'s albums…`}
                                className="w-full pl-8 pr-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-[var(--glass-border)] text-sm focus:outline-none focus:border-[var(--color-primary)] text-[var(--color-text-primary)]"
                            />
                        </div>
                        <div className="space-y-1.5 max-h-60 overflow-y-auto">
                            {candidates.length === 0 && (
                                <div className="text-xs text-[var(--color-text-muted)] px-3 py-2">No matching albums.</div>
                            )}
                            {candidates.map(c => (
                                <button
                                    key={c.id}
                                    type="button"
                                    disabled={busy}
                                    onClick={() => handleMerge(c.id)}
                                    className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-ui text-left disabled:opacity-50"
                                >
                                    <div className="min-w-0">
                                        <div className="text-sm text-[var(--color-text-primary)] truncate">{c.title}</div>
                                        <div className="text-xs text-[var(--color-text-muted)] truncate">
                                            {c.edition_label ? `${c.edition_label.toLowerCase()} · ` : ''}
                                            {c.release_year || ''}
                                        </div>
                                    </div>
                                    <Plus className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />
                                </button>
                            ))}
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
};

// ─── Component ───────────────────────────────────────────────────────────────

export const AlbumDetail: React.FC = () => {
    const { albumId } = useParams<{ albumId: string }>();
    const navigate = useNavigate();
    const location = useLocation();
    const heroState = useMemo(() => readAlbumHeroState(location.state), [location.state]);

    // Album tracks come from the per-album endpoint instead of filtering the
    // in-memory library, so the album view no longer depends on the full track set.
    const { tracks: albumTracks, loading: albumTracksLoading } = useEntityTracks(
        albumId ? `/api/albums/${encodeURIComponent(albumId)}` : null,
    );
    const albums = usePlayerStore(state => state.albums);
    const artists = usePlayerStore(state => state.artists);
    const setPlaylist = usePlayerStore(state => state.setPlaylist);
    const setLastOpenedAlbum = usePlayerStore(state => state.setLastOpenedAlbum);
    const openContextMenu = usePlayerStore(state => state.openContextMenu);
    const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
    const currentUser = usePlayerStore(state => state.currentUser);
    const knownArtistKeys = useKnownArtistKeys();
    const [linksMenuOpen, setLinksMenuOpen] = useState(false);
    const [editions, setEditions] = useState<EditionRow[]>([]);
    const [editionsModalOpen, setEditionsModalOpen] = useState(false);
    // Album-wide credits keyed by track_id. Loaded lazily on album open
    // so the main library payload stays lean; consequences for cold-open
    // latency are minimal because the credits panel and per-track chips
    // only render after this resolves.
    const [albumCredits, setAlbumCredits] = useState<Record<string, TrackCredit[]>>({});
    const [creditsPanelOpen, setCreditsPanelOpen] = useState(false);
    const isAlbumPlaying = useIsCurrentCollection({ albumId: albumId ?? undefined });
    const playbackState = useNowPlayingState();
    const linksButtonRef = useRef<HTMLButtonElement>(null);
    const creditsButtonRef = useRef<HTMLButtonElement>(null);
    const editionsButtonRef = useRef<HTMLButtonElement>(null);
    const [editionsMenuOpen, setEditionsMenuOpen] = useState(false);
    const trackListRef = useRef<HTMLDivElement>(null);

    const albumInfo = useMemo(() => albums.find(a => a.id === albumId), [albums, albumId]);

    // Record this album as the "last opened" so the Hub can offer a "jump back
    // into browsing" fallback when there's no fresh resumable queue.
    useEffect(() => {
        if (!albumId) return;
        const title = heroState?.title || albumInfo?.title || albumInfo?.name;
        if (!title) return;
        setLastOpenedAlbum({
            id: albumId,
            title,
            artist: heroState?.artist || albumInfo?.artist_name,
            artUrl: heroState?.artUrl || albumTracks[0]?.artUrl,
        });
    }, [albumId, heroState, albumInfo, albumTracks, setLastOpenedAlbum]);

    // Fetch sibling editions whenever the visible album changes. Editions
    // are albums that share this album's release_group_id; the canonical
    // entry (most tracks, earliest year) is always first in the list.
    useEffect(() => {
        if (!albumId) { setEditions([]); return; }
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/albums/${albumId}/editions`, { headers: getAuthHeader() });
                if (!res.ok) return;
                const data = await res.json();
                if (!cancelled) setEditions(Array.isArray(data.editions) ? data.editions : []);
            } catch {
                if (!cancelled) setEditions([]);
            }
        })();
        return () => { cancelled = true; };
    }, [albumId, getAuthHeader]);

    const otherEditions = useMemo(
        () => editions.filter(e => e.id !== albumId),
        [editions, albumId],
    );

    // Pull multi-role credits for the whole album in one request. Per-track
    // chips and the expanded credits panel both read from this map.
    useEffect(() => {
        if (!albumId) { setAlbumCredits({}); return; }
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/albums/${albumId}/credits`, { headers: getAuthHeader() });
                if (!res.ok) return;
                const data = await res.json();
                if (!cancelled) setAlbumCredits(data?.credits || {});
            } catch {
                if (!cancelled) setAlbumCredits({});
            }
        })();
        return () => { cancelled = true; };
    }, [albumId, getAuthHeader]);

    // Picks at most two headline credits per track, applying the
    // suppression guards from the plan:
    //   - never show a credit that matches the primary artist (catches
    //     DJ-self-producer, singer-songwriter, band-wrote-it-themselves).
    //   - remixer always shows when present (the original artist is by
    //     definition different from the remixer).
    //   - composer only shows when it adds info beyond the primary artist.
    const selectInlineCredits = useCallback((track: TrackInfo): Array<{ role: string; name: string; artistId: string }> => {
        const list = albumCredits[track.id];
        if (!list || list.length === 0) return [];
        const primaryNameKey = (track.artist || track.albumArtist || '').trim().toLowerCase();
        const matchesPrimary = (c: TrackCredit) =>
            c.artistName.trim().toLowerCase() === primaryNameKey;

        const byRole = new Map<string, TrackCredit[]>();
        for (const c of list) {
            if (!INLINE_ROLE_SET.has(c.role)) continue;
            if (matchesPrimary(c) && c.role !== 'remixer') continue;
            const arr = byRole.get(c.role) || [];
            arr.push(c);
            byRole.set(c.role, arr);
        }

        const picked: Array<{ role: string; name: string; artistId: string }> = [];
        for (const role of INLINE_ROLE_ORDER) {
            const credits = byRole.get(role);
            if (!credits || credits.length === 0) continue;
            // Use the first (lowest position) credit per role; if a track
            // is co-composed, the second composer surfaces in the panel.
            const first = credits[0];
            picked.push({ role, name: first.artistName, artistId: first.artistId });
            if (picked.length >= 2) break;
        }
        return picked;
    }, [albumCredits]);

    // Album-wide credits aggregated for the "view credits" panel.
    // Ordered: performer · composer · conductor · lyricist · producer ·
    // remixer · arranger · engineer · mixer · dj-mixer · writer ·
    // original-artist (per the plan's E2.2 spec).
    const albumCreditRoleOrder = useMemo(() => [
        'performer', 'composer', 'conductor', 'lyricist', 'producer', 'remixer',
        'arranger', 'engineer', 'mixer', 'dj-mixer', 'writer', 'original-artist',
    ], []);
    const albumCreditsGrouped = useMemo(() => {
        const byRole = new Map<string, Map<string, { name: string; artistId: string; details: Set<string> }>>();
        for (const credits of Object.values(albumCredits)) {
            for (const c of credits) {
                if (!byRole.has(c.role)) byRole.set(c.role, new Map());
                const inner = byRole.get(c.role)!;
                const key = c.artistId;
                if (!inner.has(key)) inner.set(key, { name: c.artistName, artistId: c.artistId, details: new Set() });
                if (c.detail) inner.get(key)!.details.add(c.detail);
            }
        }
        const out: Array<{ role: string; people: Array<{ name: string; artistId: string; details: string[] }> }> = [];
        for (const role of albumCreditRoleOrder) {
            const inner = byRole.get(role);
            if (!inner) continue;
            out.push({
                role,
                people: Array.from(inner.values()).map(p => ({
                    name: p.name,
                    artistId: p.artistId,
                    details: Array.from(p.details),
                })),
            });
        }
        // Any unrecognized roles tail-append (shouldn't happen given the
        // server-side canonicalization, but defensive in case enrichment
        // ever writes a new role we didn't preregister).
        for (const [role, inner] of byRole) {
            if (albumCreditRoleOrder.includes(role)) continue;
            out.push({
                role,
                people: Array.from(inner.values()).map(p => ({
                    name: p.name, artistId: p.artistId, details: Array.from(p.details),
                })),
            });
        }
        return out;
    }, [albumCredits, albumCreditRoleOrder]);

    const sortedTracks = useMemo(() => {
        return [...albumTracks].sort((a, b) => {
            const discA = a.discNumber ?? 1;
            const discB = b.discNumber ?? 1;
            if (discA !== discB) return discA - discB;
            if (a.trackNumber != null && b.trackNumber != null) return a.trackNumber - b.trackNumber;
            if (a.trackNumber != null) return -1;
            if (b.trackNumber != null) return 1;
            const aName = a.title || a.path.split(/[\\/]/).pop() || '';
            const bName = b.title || b.path.split(/[\\/]/).pop() || '';
            return aName.localeCompare(bName, undefined, { numeric: true, sensitivity: 'base' });
        });
    }, [albumTracks]);

    const isMultiDisc = useMemo(() =>
        new Set(sortedTracks.map(t => t.discNumber ?? 1)).size > 1,
    [sortedTracks]);

    const albumListRows = useMemo<AlbumListRow[]>(() => {
        const rows: AlbumListRow[] = [];
        let lastDisc: number | null = null;

        sortedTracks.forEach((track, index) => {
            const disc = track.discNumber ?? 1;
            if (isMultiDisc && disc !== lastDisc) {
                lastDisc = disc;
                rows.push({ type: 'disc', disc });
            }
            rows.push({ type: 'track', track, index });
        });

        return rows;
    }, [isMultiDisc, sortedTracks]);

    const shouldVirtualizeAlbumRows = albumListRows.length > 50;
    const albumRowsVirtualizer = useVirtualizer({
        count: albumListRows.length,
        getScrollElement: () => trackListRef.current,
        estimateSize: (index) => albumListRows[index]?.type === 'disc' ? 34 : 52,
        overscan: 8,
        enabled: shouldVirtualizeAlbumRows,
    });

    const artistLinkByName = useMemo(
        () => buildArtistLinkMap(albumTracks, artists),
        [albumTracks, artists]
    );

    const getArtistLink = useCallback((artistName: string): string | null => {
        return artistLinkByName.get(artistName.toLowerCase()) || null;
    }, [artistLinkByName]);

    const handlePlayAll = useCallback(() => setPlaylist(sortedTracks, 0, albumId ? { kind: 'album', id: albumId } : null), [setPlaylist, sortedTracks, albumId]);
    const handlePlayTrack = useCallback((index: number) => setPlaylist(sortedTracks, index, albumId ? { kind: 'album', id: albumId } : null), [setPlaylist, sortedTracks, albumId]);
    const handleTrackContextMenu = useCallback(
        (track: TrackInfo, x: number, y: number) => openContextMenu(track, x, y),
        [openContextMenu]
    );

    // ── Derived metadata ───────────────────────────────────────────────────

    const totalDuration = useMemo(() =>
        sortedTracks.reduce((sum, t) => sum + (t.duration || 0), 0),
    [sortedTracks]);

    const releaseType = useMemo(() => {
        const raw = (sortedTracks[0]?.releaseType || '').toLowerCase();
        if (sortedTracks[0]?.isCompilation || raw.includes('compilation')) return 'Compilation';
        if (raw.includes('ep')) return 'EP';
        if (raw.includes('single')) return 'Single';
        if (raw.includes('album')) return 'Album';
        return 'Album';
    }, [sortedTracks]);

    const qualityLabel = useMemo(() => {
        // Pick the most common format; prefer lossless if mixed
        const counts = new Map<string, number>();
        let maxBitrate = 0;
        let dominantFormat = '';
        for (const t of sortedTracks) {
            const fmt = (t.format || '').toUpperCase();
            if (!fmt) continue;
            counts.set(fmt, (counts.get(fmt) || 0) + 1);
            if ((t.bitrate || 0) > maxBitrate) maxBitrate = t.bitrate || 0;
        }
        const lossless = ['FLAC', 'ALAC', 'WAV', 'AIFF', 'APE', 'WV'];
        for (const fmt of lossless) {
            if (counts.has(fmt)) { dominantFormat = fmt; break; }
        }
        if (!dominantFormat && counts.size > 0) {
            dominantFormat = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        // Authoritative flag wins (catches ALAC, stored as an "M4A/…" format string).
        const anyLossless = sortedTracks.some((t) => t.lossless === true);
        return dominantFormat ? formatQuality(dominantFormat, maxBitrate, anyLossless ? true : undefined) : null;
    }, [sortedTracks]);

    const allGenres = useMemo(() => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const t of sortedTracks) {
            const genres = Array.isArray(t.genres) && t.genres.length > 0
                ? t.genres as string[]
                : t.genre ? [t.genre] : [];
            for (const g of genres) {
                const clean = g.trim();
                if (clean && !seen.has(clean.toLowerCase())) {
                    seen.add(clean.toLowerCase());
                    result.push(clean);
                }
            }
        }
        return result.slice(0, 6);
    }, [sortedTracks]);

    // External album data (Last.fm description, tags, stats)
    const primaryAlbumTitle = albumInfo?.title || sortedTracks[0]?.album || '';
    const primaryArtist = albumInfo?.artist_name || sortedTracks[0]?.albumArtist || sortedTracks[0]?.artist || '';
    const albumMbid = (albumInfo as any)?.mbid || null;
    const {
        description: lfmDescription,
        tags: lfmTags,
        listeners: lfmListeners,
        playcount: lfmPlaycount,
    } = useAlbumData(primaryAlbumTitle, primaryArtist, albumMbid, {
        enabled: !!(primaryAlbumTitle && primaryArtist),
    });

    // Aggregate file-embedded URLs from all tracks, deduplicated
    const fileLinks = useMemo(() => {
        const seen = new Set<string>();
        const result: { url: string; type: string }[] = [];
        for (const t of sortedTracks) {
            for (const link of (t.rawUrls || [])) {
                if (!seen.has(link.url)) {
                    seen.add(link.url);
                    result.push(link);
                }
            }
        }
        return result;
    }, [sortedTracks]);

    // ── Navigation helpers ─────────────────────────────────────────────────

    if (!albumId || (albumTracksLoading && albumTracks.length === 0)) {
        return <AlbumDetailSkeleton onBack={() => navigate(-1)} hero={heroState} />;
    }

    if (albumTracks.length === 0) {
        if (heroState && (heroState.title || heroState.artUrl)) {
            return <AlbumDetailSkeleton onBack={() => navigate(-1)} hero={heroState} />;
        }
        return <div className="flex-1 flex justify-center items-center text-[var(--color-text-muted)]">Album not found.</div>;
    }

    const albumTitle = albumInfo?.title || albumTracks[0]?.album || 'Unknown Album';
    const albumArtist = albumInfo?.artist_name || albumTracks[0]?.albumArtist || albumTracks[0]?.artist || 'Unknown Artist';
    const artUrl = albumTracks.find(t => t.artUrl)?.artUrl;
    const albumYear = albumTracks.find(t => t.year)?.year;
    const headerArtists = parseArtistsForDisplay(albumArtist, knownArtistKeys);

    return (
        <div className="relative flex flex-col overflow-hidden p-4 md:p-8 lg:p-12 flex-1">

            <div className="shrink-0 mb-6"><BackButton onClick={() => navigate(-1)} /></div>

            <div className="shrink-0 flex flex-col md:flex-row gap-6 md:gap-8 mb-8 md:mb-12 items-center md:items-end text-center md:text-left">
                <AlbumCoverDisc albumId={albumId} artUrl={artUrl} artist={albumArtist} album={albumTitle} />
                {/* isolate lifts the title above the disc that rolls out from
                    behind the cover, without becoming the positioning anchor
                    for the absolutely-positioned action buttons inside it —
                    those must still anchor to the panel (top-right) on mobile. */}
                <div className="isolate flex flex-col justify-end items-center md:items-start max-w-full">
                    {/* Release type label — dynamic */}
                    <div className="font-semibold text-sm tracking-wider uppercase text-[var(--color-primary)]">{releaseType}</div>

                    <div className="flex flex-wrap items-center gap-3 my-2">
                        <h1 className="font-bold text-4xl md:text-5xl lg:text-6xl tracking-tight leading-tight text-[var(--color-text-primary)] line-clamp-2" title={albumTitle}>{albumTitle}</h1>
                        {isAlbumPlaying && playbackState !== 'stopped' && (
                            <NowPlayingBadge state={playbackState === 'playing' ? 'playing' : 'paused'} className="self-center shrink-0" />
                        )}
                    </div>

                    <div className="text-base md:text-xl text-[var(--color-text-secondary)] flex flex-wrap justify-center md:justify-start items-center gap-2 mb-3 w-full">
                        {headerArtists.map((a, i) => {
                            const link = getArtistLink(a);
                            return (
                                <React.Fragment key={a}>
                                    {i > 0 && ' · '}
                                    {link ? (
                                        <Link
                                            to={link}
                                            state={{ backLabel: 'Back to Album' }}
                                            className="hover:text-[var(--color-primary)] transition-colors no-underline text-inherit"
                                        >{a}</Link>
                                    ) : (
                                        <span>{a}</span>
                                    )}
                                </React.Fragment>
                            );
                        })}
                    </div>

                    <div className="flex flex-wrap justify-center md:justify-start gap-3 mb-3 text-xs text-[var(--color-text-muted)]">
                        <span className="inline-flex items-center gap-1">
                            <Music2 className="w-3 h-3" />
                            {albumTracks.length} track{albumTracks.length !== 1 ? 's' : ''}
                        </span>
                        {albumYear && (
                            <span className="inline-flex items-center gap-1">
                                <Calendar className="w-3 h-3" />
                                {albumYear}
                            </span>
                        )}
                        {totalDuration > 0 && (
                            <span className="inline-flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {formatDuration(totalDuration)}
                            </span>
                        )}
                        {qualityLabel && (
                            <span className="inline-flex items-center gap-1">
                                <Gauge className="w-3 h-3" />
                                {qualityLabel}
                            </span>
                        )}
                        {(lfmListeners || lfmPlaycount) && (
                            <>
                            {lfmListeners && (
                                <span className="inline-flex items-center gap-1">
                                    <Headphones className="w-3 h-3" />
                                    {formatCount(lfmListeners)} listeners
                                </span>
                            )}
                            {lfmPlaycount && (
                                <span className="inline-flex items-center gap-1">
                                    <BarChart2 className="w-3 h-3" />
                                    {formatCount(lfmPlaycount)} plays
                                </span>
                            )}
                            </>
                        )}
                    </div>

                    <div className="mt-2 flex flex-wrap justify-center md:justify-start gap-3 w-full md:w-auto">
                        <button
                            onClick={handlePlayAll}
                            className="flex items-center justify-center gap-2 px-8 py-3.5 bg-[var(--color-primary)] hover:bg-[var(--color-primary-dark)] text-white font-bold text-sm tracking-widest uppercase rounded-full shadow-[0_4px_24px_rgba(16,185,129,0.3)] hover:shadow-[0_8px_32px_rgba(16,185,129,0.4)] hover:scale-105 active:scale-95 motion-reduce:transition-none motion-reduce:hover:scale-100 transition-ui duration-300 w-full md:w-auto"
                        >
                            <Play size={18} fill="currentColor" className="ml-1" />
                            PLAY {releaseType.toUpperCase()}
                        </button>

                        {/* Icon-button group — sits pinned top-right on mobile
                            and inline next to the play button on desktop, so
                            links, credits, and editions stay together at every
                            breakpoint instead of just the links button. */}
                        <div className="absolute right-4 top-4 z-20 flex gap-2 md:static md:z-auto md:flex md:gap-3">
                        <button
                            ref={linksButtonRef}
                            type="button"
                            onClick={() => setLinksMenuOpen(open => !open)}
                            disabled={fileLinks.length === 0}
                            aria-label="Album links"
                            aria-haspopup="menu"
                            aria-expanded={linksMenuOpen}
                            title={fileLinks.length > 0 ? 'Album links' : 'No album links available'}
                            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-text-secondary)] shadow-[var(--shadow-sm)] transition-ui hover:border-[var(--glass-border-hover)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--color-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none md:h-12 md:w-12"
                        >
                            <Link2 className="w-5 h-5" />
                        </button>

                        <ContextMenuPortal
                            open={linksMenuOpen && fileLinks.length > 0}
                            onClose={() => setLinksMenuOpen(false)}
                            anchorRef={linksButtonRef}
                            desktopWidth={248}
                            desktopHeight={320}
                            menuAlign="left"
                        >
                            {({ isMobile }) => (
                                <ContextMenuFrame isMobile={isMobile}>
                                    <ContextMenuHeader
                                        title="Album links"
                                        subtitle={`${fileLinks.length} ${fileLinks.length === 1 ? 'link' : 'links'}`}
                                    />
                                    <ContextMenuList className="max-h-64 overflow-y-auto">
                                        {fileLinks.map((link, i) => (
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

                        {/* Credits button — same circular treatment as the
                            links button. Disabled when the album has no
                            credits at all (tag-derived or provider-enriched). */}
                        <button
                            ref={creditsButtonRef}
                            type="button"
                            onClick={() => setCreditsPanelOpen(open => !open)}
                            disabled={albumCreditsGrouped.length === 0}
                            aria-label="Album credits"
                            aria-haspopup="menu"
                            aria-expanded={creditsPanelOpen}
                            title={albumCreditsGrouped.length > 0 ? 'Album credits' : 'No credits available'}
                            className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-text-secondary)] shadow-[var(--shadow-sm)] transition-ui hover:border-[var(--glass-border-hover)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--color-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none md:h-12 md:w-12"
                        >
                            <Users className="w-5 h-5" />
                        </button>

                        <ContextMenuPortal
                            open={creditsPanelOpen && albumCreditsGrouped.length > 0}
                            onClose={() => setCreditsPanelOpen(false)}
                            anchorRef={creditsButtonRef}
                            desktopWidth={320}
                            desktopHeight={420}
                            menuAlign="left"
                        >
                            {({ isMobile }) => (
                                <ContextMenuFrame isMobile={isMobile}>
                                    <ContextMenuHeader
                                        title="Album credits"
                                        subtitle={`${albumCreditsGrouped.reduce((n, g) => n + g.people.length, 0)} credit${albumCreditsGrouped.reduce((n, g) => n + g.people.length, 0) === 1 ? '' : 's'} · ${albumCreditsGrouped.length} role${albumCreditsGrouped.length === 1 ? '' : 's'}`}
                                    />
                                    <ContextMenuList className="max-h-[60vh] overflow-y-auto py-1">
                                        {albumCreditsGrouped.map(group => (
                                            <div key={group.role} className="px-4 py-2">
                                                <div className="text-[10px] font-bold uppercase tracking-[0.15em] text-[var(--color-text-muted)] mb-1">
                                                    {group.role}
                                                </div>
                                                <div className="space-y-0.5">
                                                    {group.people.map((p, i) => (
                                                        <Link
                                                            key={p.artistId + i}
                                                            to={`/library/artist/${p.artistId}`}
                                                            state={{ backLabel: 'Back to Album' }}
                                                            onClick={() => setCreditsPanelOpen(false)}
                                                            className="block text-sm text-[var(--color-text-primary)] hover:text-[var(--color-primary)] transition-colors no-underline truncate"
                                                        >
                                                            {p.name}
                                                            {p.details.length > 0 && (
                                                                <span className="text-[var(--color-text-muted)]"> — {p.details.join(', ')}</span>
                                                            )}
                                                        </Link>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}
                                    </ContextMenuList>
                                </ContextMenuFrame>
                            )}
                        </ContextMenuPortal>

                        {/* Editions button — circular icon button matching
                            links/credits. Opens a context menu listing the
                            other editions in this release group, with an
                            admin-only "Manage editions…" entry at the bottom
                            that opens the existing merge/split modal. */}
                        {(otherEditions.length > 0 || currentUser?.role === 'admin') && (
                            <>
                                <button
                                    ref={editionsButtonRef}
                                    type="button"
                                    onClick={() => setEditionsMenuOpen(open => !open)}
                                    aria-label="Other editions"
                                    aria-haspopup="menu"
                                    aria-expanded={editionsMenuOpen}
                                    title={otherEditions.length > 0 ? `${otherEditions.length + 1} editions` : 'Manage editions'}
                                    className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-[var(--glass-border)] bg-[var(--glass-bg)] text-[var(--color-text-secondary)] shadow-[var(--shadow-sm)] transition-ui hover:border-[var(--glass-border-hover)] hover:bg-[var(--glass-bg-hover)] hover:text-[var(--color-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)] motion-reduce:transition-none md:h-12 md:w-12"
                                >
                                    <Layers className="w-5 h-5" />
                                </button>

                                <ContextMenuPortal
                                    open={editionsMenuOpen}
                                    onClose={() => setEditionsMenuOpen(false)}
                                    anchorRef={editionsButtonRef}
                                    desktopWidth={296}
                                    desktopHeight={360}
                                    menuAlign="left"
                                >
                                    {({ isMobile }) => (
                                        <ContextMenuFrame isMobile={isMobile}>
                                            <ContextMenuHeader
                                                title="Other editions"
                                                subtitle={otherEditions.length > 0
                                                    ? `${otherEditions.length} other ${otherEditions.length === 1 ? 'edition' : 'editions'}`
                                                    : 'No other editions'}
                                            />
                                            <ContextMenuList className="max-h-[60vh] overflow-y-auto">
                                                {otherEditions.map(ed => (
                                                    <Link
                                                        key={ed.id}
                                                        to={`/library/album/${ed.id}`}
                                                        state={{ backLabel: 'Back to Album' }}
                                                        onClick={() => setEditionsMenuOpen(false)}
                                                        role="menuitem"
                                                        className="flex w-full items-center gap-3 px-4 py-2.5 text-sm text-[var(--color-text-primary)] transition-colors hover:bg-white/5 focus:bg-white/5 focus:outline-none no-underline"
                                                    >
                                                        <span className="relative w-8 h-8 shrink-0 overflow-hidden rounded-sm bg-black/10 dark:bg-white/5">
                                                            <EditionArt
                                                                mbReleaseId={ed.representative_release_mbid ?? ed.mbid}
                                                                fallbackArtUrl={(ed as any).image_url}
                                                                artist={ed.artist_name || ''}
                                                                title={ed.title || ''}
                                                            />
                                                        </span>
                                                        <span className="min-w-0 flex-1">
                                                            <span className="block truncate">
                                                                {ed.edition_label || ed.title}
                                                            </span>
                                                            <span className="block truncate text-xs text-[var(--color-text-muted)]">
                                                                {[ed.release_year, (ed as any).track_count
                                                                    ? `${(ed as any).track_count} track${(ed as any).track_count === 1 ? '' : 's'}`
                                                                    : null].filter(Boolean).join(' · ')}
                                                            </span>
                                                        </span>
                                                    </Link>
                                                ))}
                                                {currentUser?.role === 'admin' && (
                                                    <>
                                                        {otherEditions.length > 0 && <ContextMenuDivider />}
                                                        <ContextMenuButton
                                                            icon={<Settings className="w-[15px] h-[15px]" />}
                                                            label="Manage editions…"
                                                            onClick={() => {
                                                                setEditionsMenuOpen(false);
                                                                setEditionsModalOpen(true);
                                                            }}
                                                        />
                                                    </>
                                                )}
                                            </ContextMenuList>
                                        </ContextMenuFrame>
                                    )}
                                </ContextMenuPortal>
                            </>
                        )}
                        </div>
                    </div>
                </div>
            </div>

            {lfmDescription && (
                <p className="shrink-0 text-sm text-[var(--color-text-secondary)] leading-relaxed mb-4 mt-2 line-clamp-3 max-w-3xl">
                    {lfmDescription}
                </p>
            )}

            {(allGenres.length > 0 || (lfmTags && lfmTags.length > 0)) && (
                <div className="shrink-0 mb-4 space-y-2">
                    {allGenres.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            {allGenres.map(g => (
                                <span key={g} className="inline-block text-xs font-semibold uppercase tracking-widest px-3 py-1 rounded-full border border-[var(--glass-border)] bg-[var(--color-surface-variant)] text-[var(--color-primary)] backdrop-blur-sm">
                                    {g}
                                </span>
                            ))}
                        </div>
                    )}

                    {lfmTags && lfmTags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            {lfmTags.slice(0, 5).map(tag => (
                                <span key={tag} className="inline-block text-xs font-semibold uppercase tracking-widest px-3 py-1 rounded-full border border-[var(--glass-border)] bg-[var(--color-surface-variant)] text-[var(--color-text-secondary)] backdrop-blur-sm">
                                    {tag}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            )}

            <div className="mt-4 flex-1 min-h-0 flex flex-col pb-6">
                <div className="grid grid-cols-[30px_1fr_40px] md:grid-cols-[40px_1fr_100px] px-2 md:px-4 py-3 border-b border-black/5 dark:border-white/10 font-semibold text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                    <div className="text-center md:text-left">#</div>
                    <div>Title</div>
                    <div className="text-right hidden md:block">Time</div>
                </div>
                <div ref={trackListRef} className="overflow-y-auto flex-1 min-h-0 hide-scrollbar">
                    {shouldVirtualizeAlbumRows ? (
                        <div
                            style={{
                                height: `${albumRowsVirtualizer.getTotalSize()}px`,
                                position: 'relative',
                                width: '100%',
                            }}
                        >
                            {albumRowsVirtualizer.getVirtualItems().map((virtualRow) => {
                                const row = albumListRows[virtualRow.index];
                                if (!row) return null;

                                return (
                                    <div
                                        key={row.type === 'disc' ? `disc-${row.disc}` : row.track.id}
                                        data-index={virtualRow.index}
                                        ref={albumRowsVirtualizer.measureElement}
                                        style={{
                                            position: 'absolute',
                                            top: 0,
                                            left: 0,
                                            width: '100%',
                                            transform: `translateY(${virtualRow.start}px)`,
                                        }}
                                    >
                                        {row.type === 'disc' ? (
                                            <AlbumDiscHeader disc={row.disc} />
                                        ) : (
                                            <AlbumTrackRow
                                                track={row.track}
                                                index={row.index}
                                                displayNumber={row.track.trackNumber ?? row.index + 1}
                                                getArtistLink={getArtistLink}
                                                onPlay={handlePlayTrack}
                                                onContextMenu={handleTrackContextMenu}
                                                playbackState={playbackState}
                                                inlineCredits={selectInlineCredits(row.track)}
                                            />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        albumListRows.map((row) => row.type === 'disc' ? (
                            <AlbumDiscHeader key={`disc-${row.disc}`} disc={row.disc} />
                        ) : (
                            <AlbumTrackRow
                                key={row.track.id}
                                track={row.track}
                                index={row.index}
                                displayNumber={row.track.trackNumber ?? row.index + 1}
                                getArtistLink={getArtistLink}
                                onPlay={handlePlayTrack}
                                onContextMenu={handleTrackContextMenu}
                                playbackState={playbackState}
                                inlineCredits={selectInlineCredits(row.track)}
                            />
                        ))
                    )}
                </div>
            </div>

            <ManageEditionsModal
                open={editionsModalOpen}
                onClose={() => setEditionsModalOpen(false)}
                sourceAlbumId={albumId!}
                sourceArtist={albumArtist}
                sourceTitle={albumTitle}
                editions={editions}
                getAuthHeader={getAuthHeader}
                onChanged={() => {
                    // Re-fetch editions; modal stays open so admin can stack
                    // multiple merge/split actions in one pass.
                    if (!albumId) return;
                    fetch(`/api/albums/${albumId}/editions`, { headers: getAuthHeader() })
                        .then(r => r.ok ? r.json() : null)
                        .then(d => { if (d?.editions) setEditions(d.editions); });
                }}
            />
        </div>
    );
};
