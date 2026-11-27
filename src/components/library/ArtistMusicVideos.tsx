import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../../store/index';
import { Video, Play, X, AlertTriangle } from 'lucide-react';
import { HorizontalScrollRail } from '../HorizontalScrollRail';

// Route external thumbnails through the server image proxy (same convention as
// AlbumArt / AlbumCoverDisc) so the browser never hits ytimg.com directly.
function proxyImageUrl(externalUrl: string): string {
    return `/api/providers/external/proxy-image?url=${encodeURIComponent(externalUrl)}`;
}

export type MusicVideo = {
    video_id: string;
    artist_id: string;
    track_id: string | null;
    title: string | null;
    thumbnail_url: string | null;
    published_at: string | null;
    position: number | null;
    track_artist: string | null;
    track_artists: string | null;
};

type MusicVideosResp = {
    videos: MusicVideo[];
    refreshed: boolean;
    stale: boolean;
    disabled?: boolean;
    lastFetchedAt: string | null;
};

export function useArtistMusicVideos(artistId: string | undefined): {
    loading: boolean;
    videos: MusicVideo[];
    stale: boolean;
    disabled: boolean;
} {
    const getAuthHeader = usePlayerStore(s => s.getAuthHeader);
    const [state, setState] = useState<MusicVideosResp | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!artistId) { setLoading(false); return; }
        let cancelled = false;
        setLoading(true);
        (async () => {
            try {
                const res = await fetch(`/api/providers/external/artist-videos/${artistId}`, { headers: getAuthHeader() });
                if (res.ok) {
                    const data: MusicVideosResp = await res.json();
                    if (!cancelled) setState(data);
                }
            } catch {} finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [artistId, getAuthHeader]);

    return {
        loading,
        videos: state?.videos || [],
        stale: !!state?.stale,
        disabled: !!state?.disabled,
    };
}

// Credit line under each video — prefer the matched track's full artist list,
// falling back to its artist string.
function artistsLabel(video: MusicVideo): string {
    if (video.track_artists) {
        try {
            const parsed = JSON.parse(video.track_artists);
            if (Array.isArray(parsed) && parsed.length > 0) return parsed.filter(Boolean).join(', ');
        } catch { /* fall through */ }
    }
    return video.track_artist || '';
}

const VideoCard: React.FC<{ video: MusicVideo; onOpen: (v: MusicVideo) => void }> = ({ video, onOpen }) => {
    const credit = artistsLabel(video);
    return (
        <button
            type="button"
            onClick={() => onOpen(video)}
            className="group card-hover block w-full text-left"
            aria-label={`Play music video: ${video.title || 'Untitled'}`}
        >
            <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-[var(--glass-border)] bg-[var(--color-surface-variant)]">
                {video.thumbnail_url ? (
                    <img
                        src={proxyImageUrl(video.thumbnail_url)}
                        alt={video.title || ''}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                    />
                ) : (
                    <div className="flex h-full w-full items-center justify-center text-[var(--color-text-muted)]">
                        <Video className="h-8 w-8 opacity-50" />
                    </div>
                )}
                {/* Play: rises in on hover, as on the Hub cards (.card-play).
                    A span: the whole card is the button. */}
                <span className="btn-fab card-play pointer-events-none" aria-hidden="true">
                    <Play className="h-4 w-4 ml-0.5" fill="currentColor" />
                </span>
            </div>
            <div className="mt-2">
                <h4 className="line-clamp-1 text-sm font-semibold text-[var(--color-text-primary)] transition-colors group-hover:text-[var(--color-primary)]">
                    {video.title || 'Untitled'}
                </h4>
                {credit && (
                    <p className="line-clamp-1 text-xs text-[var(--color-text-muted)]">{credit}</p>
                )}
            </div>
        </button>
    );
};

const VideoModal: React.FC<{ video: MusicVideo; onClose: () => void }> = ({ video, onClose }) => {
    const pause = usePlayerStore(s => s.pause);
    const playbackState = usePlayerStore(s => s.playbackState);
    const dialogRef = useRef<HTMLDivElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        // Don't talk over the video: pause local audio while the player is open.
        // We intentionally do NOT auto-resume on close — the user closed the
        // video and can resume playback themselves.
        if (playbackState === 'playing') pause();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Esc to close + focus trap + focus restore, matching ConfirmModal.
    useEffect(() => {
        const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        closeButtonRef.current?.focus();

        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
            if (e.key !== 'Tab' || !dialogRef.current) return;
            const focusable = Array.from(
                dialogRef.current.querySelectorAll<HTMLElement>(
                    'button:not([disabled]), [href], iframe, [tabindex]:not([tabindex="-1"])'
                )
            );
            if (focusable.length === 0) return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('keydown', onKey);
            previouslyFocused?.focus();
        };
    }, [onClose]);

    return createPortal(
        <div
            className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
            onClick={onClose}
            role="dialog"
            aria-modal="true"
            aria-label={video.title || 'Music video'}
        >
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
            <div ref={dialogRef} className="relative z-10 w-full max-w-4xl" onClick={e => e.stopPropagation()}>
                <button
                    ref={closeButtonRef}
                    type="button"
                    onClick={onClose}
                    aria-label="Close video"
                    className="absolute -top-10 right-0 text-white/80 transition-colors hover:text-white"
                >
                    <X size={22} />
                </button>
                <div className="aspect-video w-full overflow-hidden rounded-xl bg-black shadow-2xl">
                    <iframe
                        className="h-full w-full"
                        src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.video_id)}?autoplay=1&rel=0`}
                        title={video.title || 'Music video'}
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                        allowFullScreen
                    />
                </div>
                {video.title && (
                    <div className="mt-3">
                        <h3 className="text-base font-semibold text-white line-clamp-1">{video.title}</h3>
                        {artistsLabel(video) && (
                            <p className="text-sm text-white/60 line-clamp-1">{artistsLabel(video)}</p>
                        )}
                    </div>
                )}
            </div>
        </div>,
        document.body
    );
};

interface MusicVideosProps {
    videos: MusicVideo[];
    loading: boolean;
    stale: boolean;
}

export const MusicVideos: React.FC<MusicVideosProps> = ({ videos, loading, stale }) => {
    const [active, setActive] = useState<MusicVideo | null>(null);

    if (loading) {
        return (
            <section className="mb-12">
                <div className="mb-4 flex items-center justify-between gap-4 border-b border-[var(--glass-border)] pb-2 md:mb-6">
                    <h3 className="flex items-center gap-2 text-xl font-semibold tracking-wide text-[var(--color-text-secondary)]">
                        Music videos
                    </h3>
                </div>
                <div className="flex gap-4 overflow-x-auto pb-1 hide-scrollbar">
                    {[0, 1, 2, 3].map(i => (
                        <div
                            key={i}
                            className="w-[70vw] shrink-0 animate-pulse motion-reduce:animate-none sm:w-[260px] md:w-[300px]"
                        >
                            <div className="aspect-video rounded-xl bg-[var(--color-surface-variant)]" />
                            <div className="mt-2 h-5 w-2/3 rounded bg-[var(--color-surface-variant)]" />
                        </div>
                    ))}
                </div>
            </section>
        );
    }

    if (videos.length === 0) return null;

    return (
        <section className="mb-12">
            <div className="mb-4 flex items-center justify-between gap-4 border-b border-[var(--glass-border)] pb-2 md:mb-6">
                <h3 className="flex items-center gap-2 text-xl font-semibold tracking-wide text-[var(--color-text-secondary)]">
                    Music videos
                    <span className="ml-1 text-xs font-normal tabular-nums text-[var(--color-text-muted)]">
                        ({videos.length})
                    </span>
                </h3>
                {stale && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                        <AlertTriangle size={12} />
                        May be out of date
                    </span>
                )}
            </div>
            <HorizontalScrollRail
                ariaLabel="Music videos"
                viewportClassName="flex gap-4 overflow-x-auto pb-1 snap-x snap-mandatory"
            >
                {videos.map(v => (
                    <div key={v.video_id} className="w-[70vw] shrink-0 snap-start sm:w-[260px] md:w-[300px]">
                        <VideoCard video={v} onOpen={setActive} />
                    </div>
                ))}
            </HorizontalScrollRail>

            {active && <VideoModal video={active} onClose={() => setActive(null)} />}
        </section>
    );
};
