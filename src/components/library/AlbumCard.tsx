import React, { memo, useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlbumArt } from '../AlbumArt';
import { MoreHorizontal, Play } from 'lucide-react';
import { useContextMenuTrigger } from '../../hooks/useContextMenuTrigger';
import { AlbumContextMenu } from './AlbumContextMenu';
import { prefetchAlbumDetail } from '../../utils/routePrefetch';
import { readBackLabel, type AlbumHeroState } from '../../utils/heroState';

interface AlbumCardProps {
    title: string;
    artist: string;
    artUrl?: string;
    subtitle?: string;
    editionLabel?: string | null;
    onPlay: (e: React.MouseEvent) => void;
    onOpen?: () => void;
    linkTo?: string;
    linkState?: unknown;
    /** The album's ID: gives the card its menu (⋯, right-click, long press). */
    albumId?: string;
}

export const AlbumCardSkeleton: React.FC = () => (
    <div className="flex flex-col animate-pulse">
        <div className="aspect-square w-full mb-3 rounded-2xl bg-[var(--color-surface-variant)]" />
        <div className="px-1 space-y-1.5">
            <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)]" />
            <div className="h-3 w-1/2 rounded bg-[var(--color-surface-variant)]" />
        </div>
    </div>
);

const stopEvent = (event: React.SyntheticEvent) => event.stopPropagation();

export const AlbumCard: React.FC<AlbumCardProps> = memo(({ title, artist, artUrl, subtitle, editionLabel, onPlay, onOpen, linkTo, linkState, albumId }) => {
    const handlePrefetch = useCallback(() => {
        if (linkTo) prefetchAlbumDetail();
    }, [linkTo]);

    // The album's menu: Play album, Add to queue, Add to playlist.
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const menuTrigger = useContextMenuTrigger((x, y) => setMenu({ x, y }));
    const closeMenu = useCallback(() => setMenu(null), []);

    // Derive a hero placeholder from the card's own props so the detail view
    // can paint its hero before tracks hydrate. Preserve any caller-supplied
    // backLabel so the back button keeps its previous wording.
    const navState: AlbumHeroState | undefined = linkTo
        ? {
            kind: 'album',
            title,
            artist,
            artUrl,
            subtitle,
            backLabel: readBackLabel(linkState),
        }
        : undefined;

    return (
        <div
            {...(albumId ? menuTrigger : {})}
            className="group card-hover flex flex-col relative cursor-pointer"
            role={!linkTo ? "button" : undefined}
            tabIndex={!linkTo ? 0 : undefined}
            onClick={!linkTo ? onOpen : undefined}
            onPointerEnter={handlePrefetch}
            onPointerDown={(event) => {
                handlePrefetch();
                if (albumId) menuTrigger.onPointerDown(event);
            }}
            onFocus={handlePrefetch}
            onKeyDown={!linkTo ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (onOpen) onOpen();
                }
            } : undefined}
        >
            {/* Semantic Invisible Link Overlay */}
            {linkTo && (
                <Link
                    to={linkTo}
                    state={navState}
                    // The card itself: its menu opens on right-click too.
                    data-card-link
                    className="card-link absolute inset-0 z-10 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                    aria-label={`View album: ${title}`}
                />
            )}

            {/* Art container */}
            <div
                className="relative aspect-square w-full mb-3 rounded-2xl border border-black/5 dark:border-white/5 bg-white/5 dark:bg-black/20 shadow-md overflow-hidden">
                <AlbumArt
                    artUrl={artUrl}
                    artist={artist}
                    album={title}
                    size={256}
                    className="w-full h-full object-cover"
                />

                {/* Edition badge (matches Hub "Uniquely yours" pill) */}
                {editionLabel && (
                    <span className="absolute top-2.5 left-2.5 z-20 text-[10px] font-bold uppercase tracking-[0.15em] text-white/95 bg-black/35 backdrop-blur-sm px-2 py-0.5 rounded-full pointer-events-none">
                        {editionLabel.toLowerCase()}
                    </span>
                )}

                {/* Play: rises in on hover, as on the Hub cards (.card-play) */}
                <button
                    type="button"
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onPlay(e);
                    }}
                    aria-label={`Play ${title}`}
                    className="btn-fab card-play"
                >
                    <Play className="w-4 h-4 ml-0.5" fill="currentColor" />
                </button>

                {albumId && (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setMenu({ x: e.clientX, y: e.clientY });
                        }}
                        aria-label={`More options for ${title}`}
                        aria-haspopup="menu"
                        aria-expanded={menu !== null}
                        className="card-more"
                    >
                        <MoreHorizontal size={16} />
                    </button>
                )}
            </div>

            {/* Text */}
            <div className="flex flex-col px-1 relative z-10 pointer-events-none">
                <div className="font-semibold text-sm md:text-base tracking-wide truncate text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors motion-reduce:transition-none">
                    {title}
                </div>
                {subtitle && (
                    <div className="text-xs md:text-sm text-[var(--color-text-secondary)] truncate mt-0.5">{subtitle}</div>
                )}
            </div>
            {albumId && (
                // The menu is portalled to <body>, but React events still bubble
                // to this card: a click, key or right-click in it is the menu's own.
                <div
                    className="contents"
                    onClick={stopEvent}
                    onKeyDown={stopEvent}
                    onContextMenu={stopEvent}
                    onPointerDown={stopEvent}
                >
                    <AlbumContextMenu album={{ id: albumId, title, artist }} position={menu} onClose={closeMenu} />
                </div>
            )}
        </div>
    );
});

AlbumCard.displayName = 'AlbumCard';
