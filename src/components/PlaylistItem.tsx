import React, { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Link } from 'react-router-dom';
import { GripVertical, ChevronUp, ChevronDown, MoreHorizontal } from 'lucide-react';
import { formatTime } from '../utils/formatTime';
import { AlbumArt } from './AlbumArt';
import { LoveButton } from './LoveButton';
import type { TrackInfo } from '../utils/fileSystem';

export interface PlaylistItemProps {
  id: string; // The dnd-kit unique identifier (instance ID)
  track: TrackInfo;
  index: number;
  isActive: boolean;
  isSidebarCollapsed: boolean;
  totalTracks: number;
  opacity?: number;
  /**
   * The mobile Now Playing queue: no hover, so nothing hides behind it. A
   * 44px drag handle and an always-visible menu button; artists are plain
   * text (a tap on the row plays it); remove and love live in the menu.
   */
  touch?: boolean;

  onPlay: (index: number) => void;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
  onContextMenu: (track: TrackInfo, x: number, y: number) => void;
  getArtistLink: (artistName: string) => string | null;
  parseArtists: (artistString: string) => string[];
}

export const PlaylistItem = memo(({
  id, track, index, isActive, isSidebarCollapsed, totalTracks, opacity = 1, touch = false,
  onPlay, onRemove, onMove, onContextMenu, getArtistLink, parseArtists
}: PlaylistItemProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : opacity,
    zIndex: isDragging ? 10 : 1,
  };
  const title = track.title ?? track.path.split(/[\\\/]/).pop();

  if (touch) {
    return (
      <li
        ref={setNodeRef}
        style={style}
        className={`queue-row-touch flex items-center gap-3 py-1.5 pl-2 my-[2px] rounded-lg border select-none
          ${isActive ? 'bg-emerald-500/10 border-emerald-500/20' : 'border-transparent'}
          ${isDragging ? 'bg-[var(--glass-bg)] shadow-lg' : ''}`}
        onClick={() => onPlay(index)}
        // A long press opens the menu, like the ⋯ button.
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(track, e.clientX, e.clientY); }}
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
        <span
          {...attributes}
          {...listeners}
          className="queue-row-touch-btn queue-row-drag-handle"
          aria-label={`Reorder ${title}`}
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical size={18} />
        </span>
      </li>
    );
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`group flex items-center gap-3 p-2 my-[2px] rounded-lg transition-colors border border-transparent select-none cursor-default
        ${isActive 
          ? 'bg-emerald-500/10 border-emerald-500/20 dark:bg-emerald-500/10 dark:border-emerald-500/20' 
          : 'hover:bg-black/5 hover:border-black/5 dark:hover:bg-white/5 dark:hover:border-white/5'}
        ${isSidebarCollapsed ? 'justify-center p-2' : ''}`}
      onClick={() => onPlay(index)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPlay(index);
        }
      }}
    >
      {!isSidebarCollapsed && (
        <span
          {...attributes}
          {...listeners}
          className="shrink-0 cursor-grab active:cursor-grabbing text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 px-1 hidden md:inline-flex"
          title="Drag to reorder"
          aria-label="Drag to reorder"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical size={14} />
        </span>
      )}

      {/* Mobile reorder arrows */}
      {!isSidebarCollapsed && (
        <span className="shrink-0 flex flex-col md:hidden text-[var(--color-text-muted)]">
          <button
            aria-label="Move up"
            onClick={(e) => { e.stopPropagation(); if (index > 0) onMove(index, index - 1); }}
            className="leading-none p-0.5 hover:text-[var(--color-text-primary)] active:scale-90 transition-transform disabled:opacity-20"
            disabled={index === 0}
          >
            <ChevronUp size={14} />
          </button>
          <button
            aria-label="Move down"
            onClick={(e) => { e.stopPropagation(); if (index < totalTracks - 1) onMove(index, index + 1); }}
            className="leading-none p-0.5 hover:text-[var(--color-text-primary)] active:scale-90 transition-transform disabled:opacity-20"
            disabled={index === totalTracks - 1}
          >
            <ChevronDown size={14} />
          </button>
        </span>
      )}

      <AlbumArt
        artUrl={track.artUrl}
        artist={track.artist}
        className={`w-12 h-12 rounded-sm ${isSidebarCollapsed ? 'm-0' : ''}`}
      />

      {!isSidebarCollapsed && (
        <>
          <div className="flex-1 min-w-0">
            <div className={`text-[0.85rem] whitespace-nowrap overflow-hidden text-ellipsis transition-colors ${isActive ? 'text-[var(--color-primary)] font-semibold' : 'text-[var(--color-text-secondary)] font-normal'}`}>
              {track.title ?? track.path.split(/[\\\/]/).pop()}
            </div>
            {track.artist && (
              <div className="text-[0.72rem] text-[var(--color-text-muted)] font-light mt-[2px]">
                {parseArtists(track.artist).map((a, i) => {
                  const link = getArtistLink(a);
                  return (
                    <React.Fragment key={a}>
                      {i > 0 && ', '}
                      {link ? (
                        <Link
                          to={link}
                          onClick={(e) => e.stopPropagation()}
                          className="hover:text-[var(--color-primary)] transition-colors no-underline text-inherit"
                        >{a}</Link>
                      ) : (
                        <span>{a}</span>
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            )}
            {track.duration !== undefined && <div className="text-[0.72rem] text-[var(--color-text-muted)] tabular-nums">{formatTime(track.duration)}</div>}
          </div>
          
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <LoveButton track={track} size={15} className="p-1" />
            <button
              aria-label="More options"
              onClick={(e) => {
                e.stopPropagation();
                onContextMenu(track, e.clientX, e.clientY);
              }}
              className="flex items-center justify-center p-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-black/5 dark:hover:bg-white/5 transition-ui"
            >
              <MoreHorizontal size={16} />
            </button>
            {/* The track that plays is not queued any more: Skip moves past it. */}
            {!isActive && (
              <button
                aria-label={`Remove track ${track.title ?? track.path}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(index);
                }}
                className="flex items-center justify-center p-1 rounded-md text-[var(--color-text-muted)] hover:text-rose-400 hover:bg-black/5 dark:hover:bg-white/5 transition-ui"
              >
                <span className="text-[0.8rem]">✕</span>
              </button>
            )}
          </div>
        </>
      )}
    </li>
  );
});
