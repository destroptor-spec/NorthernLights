import React, { memo } from 'react';
import { useContextMenuTrigger } from '../hooks/useContextMenuTrigger';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Link } from 'react-router-dom';
import { GripVertical, MoreHorizontal, SquareLetterQ } from 'lucide-react';
import { formatTime } from '../utils/formatTime';
import { AlbumArt } from './AlbumArt';
import type { TrackInfo } from '../utils/fileSystem';
import type { GigPerson } from '../hooks/useGigPeople';
import { UserAvatar } from './UserAvatar';

export interface PlaylistItemProps {
  id: string; // The dnd-kit unique identifier (instance ID)
  track: TrackInfo;
  index: number;
  isActive: boolean;
  isSidebarCollapsed: boolean;
  opacity?: number;
  /**
   * The mobile Now Playing queue: no hover, so nothing hides behind it. A
   * 44px drag handle and an always-visible menu button; artists are plain
   * text (a tap on the row plays it); remove and love live in the menu.
   */
  touch?: boolean;
  /** Not draggable, and nothing is dropped onto it (the sidebar's current track). */
  locked?: boolean;
  /** During a gig: who queued this track by hand (desktop sidebar). */
  queuedBy?: GigPerson;

  onPlay: (index: number) => void;
  onContextMenu: (track: TrackInfo, x: number, y: number) => void;
  getArtistLink: (artistName: string) => string | null;
  parseArtists: (artistString: string) => string[];
}

export const PlaylistItem = memo(({
  id, track, index, isActive, isSidebarCollapsed, opacity = 1, touch = false, locked = false, queuedBy,
  onPlay, onContextMenu, getArtistLink, parseArtists
}: PlaylistItemProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id, disabled: locked });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : opacity,
    zIndex: isDragging ? 10 : 1,
  };
  const title = track.title ?? track.path.split(/[\\\/]/).pop();
  // Right-click, or a long press on touch screens, opens the row's menu.
  const menuTrigger = useContextMenuTrigger((x, y) => onContextMenu(track, x, y));

  if (touch) {
    return (
      <li
        ref={setNodeRef}
        style={style}
        className={`queue-row-touch flex items-center gap-3 py-1.5 pl-2 my-[2px] rounded-lg border select-none
          ${isActive ? 'bg-emerald-500/10 border-emerald-500/20' : 'border-transparent'}
          ${isDragging ? 'bg-[var(--glass-bg)] shadow-lg' : ''}`}
        {...menuTrigger}
        onClick={() => onPlay(index)}
        role="button"
        tabIndex={0}
        aria-current={isActive ? 'true' : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onPlay(index);
          }
        }}
      >
        <AlbumArt artUrl={track.artUrl} artist={track.artist} className="w-12 h-12 rounded-sm shrink-0" />
        <div className="flex-1 min-w-0">
          <div className={`text-[0.9rem] truncate ${isActive ? 'text-[var(--color-primary)] font-semibold' : 'text-[var(--color-text-secondary)]'}`}>
            {/* Queued by hand (Play next, Add to queue): a Q as tall as the title. */}
            {track.queued && (
              <SquareLetterQ className="queue-mark" aria-label="Queued" role="img" />
            )}
            {title}
          </div>
          <div className="text-[0.75rem] text-[var(--color-text-muted)] truncate mt-[2px]">
            {track.artist && parseArtists(track.artist).join(', ')}
            {track.artist && track.duration !== undefined && ' · '}
            {track.duration !== undefined && <span className="tabular-nums">{formatTime(track.duration)}</span>}
          </div>
        </div>
        <button
          type="button"
          className="queue-row-touch-btn"
          aria-label={`More options for ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            onContextMenu(track, e.clientX, e.clientY);
          }}
        >
          <MoreHorizontal size={18} />
        </button>
        {!locked && <span
          {...attributes}
          {...listeners}
          className="queue-row-touch-btn queue-row-drag-handle"
          data-no-long-press
          aria-label={`Reorder ${title}`}
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical size={18} />
        </span>}
      </li>
    );
  }

  // The desktop queue sidebar (Andreas's design, 2026-11-18): cover, title and
  // artists. On hover the cover shows the drag handle and ⋯ fades in over the
  // text's end; remove, love and the rest are in the menu. The track that
  // plays is a tinted card. Collapsed: the cover only.
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`queue-row group${isActive ? ' is-current' : ''}${isSidebarCollapsed ? ' is-collapsed' : ''}${isDragging ? ' is-dragging' : ''}`}
      {...menuTrigger}
      onClick={() => onPlay(index)}
      role="button"
      tabIndex={0}
      aria-current={isActive ? 'true' : undefined}
      aria-label={isSidebarCollapsed ? title : undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPlay(index);
        }
      }}
    >
      <span className="queue-row-art">
        <AlbumArt artUrl={track.artUrl} artist={track.artist} className="h-full w-full" />
        {!isSidebarCollapsed && !locked && (
          <span
            {...attributes}
            {...listeners}
            className="queue-row-grip"
            title="Drag to reorder"
            data-no-long-press
            aria-label={`Reorder ${title}`}
            onClick={(e) => e.stopPropagation()}
          >
            <GripVertical size={14} aria-hidden="true" />
          </span>
        )}
      </span>

      {!isSidebarCollapsed && (
        <>
          <div className="queue-row-text">
            <div className="queue-row-title">{title}</div>
            {track.artist && (
              <div className="queue-row-artist">
                {parseArtists(track.artist).map((a, i) => {
                  const link = getArtistLink(a);
                  return (
                    <React.Fragment key={a}>
                      {i > 0 && ', '}
                      {link ? (
                        <Link to={link} onClick={(e) => e.stopPropagation()} className="queue-row-artist-link">{a}</Link>
                      ) : (
                        <span>{a}</span>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            )}
          </div>
          {queuedBy && (
            <span className="queue-row-by" title={queuedBy.name ? `Queued by ${queuedBy.name}` : undefined}>
              <UserAvatar avatar={queuedBy.avatar} size="xs" />
              {queuedBy.name && <span className="sr-only">Queued by {queuedBy.name}</span>}
            </span>
          )}
          <button
            type="button"
            aria-label={`More options for ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              onContextMenu(track, e.clientX, e.clientY);
            }}
            className="queue-row-more"
          >
            <MoreHorizontal size={16} />
          </button>
        </>
      )}
    </li>
  );
});
