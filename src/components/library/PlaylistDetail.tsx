import React, { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronDown,
  ChevronUp,
  Clock,
  Disc3,
  GripVertical,
  Loader2,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Pin,
  Play,
  Plus,
  Share2,
  Sparkles,
} from 'lucide-react';
import { AlbumArt } from '../AlbumArt';
import { AuroraCover, wrappedCoverLabel } from './AuroraCover';
import { LoveButton } from '../LoveButton';
import { BackButton } from './BackButton';
import { useToast } from '../../hooks/useToast';
import { usePlayerStore } from '../../store';
import { formatDuration, formatTime } from '../../utils/formatTime';
import { parseArtistsForDisplay } from '../../utils/artistUtils';
import { useKnownArtistKeys } from '../../hooks/useKnownArtistKeys';
import type { TrackInfo } from '../../utils/fileSystem';
import { getSuggestedPlaylistTracks } from '../../utils/playlistSuggestions';
import { useEntityTracks } from '../../hooks/useEntityTracks';
import { useNowPlayingState } from '../../hooks/useNowPlaying';
import { NowPlayingBadge } from '../now-playing/NowPlayingBadge';
import { NowPlayingBars } from '../now-playing/NowPlayingBars';
import { readPlaylistHeroState, type PlaylistHeroState } from '../../utils/heroState';

function formatPlaylistAddedDate(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '--';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(timestamp);
}

function reorderTracks(tracks: TrackInfo[], fromIndex: number, toIndex: number): TrackInfo[] {
  const nextTracks = [...tracks];
  const [moved] = nextTracks.splice(fromIndex, 1);
  if (!moved) return tracks;
  nextTracks.splice(toIndex, 0, moved);
  return nextTracks;
}

function buildBackdropTiles(artUrls: string[]): Array<string | null> {
  const count = artUrls.length > 0 ? 30 : 18;
  if (artUrls.length === 0) {
    return Array.from({ length: count }, () => null);
  }

  return Array.from({ length: count }, (_, index) => artUrls[(index * 5 + Math.floor(index / 4)) % artUrls.length]);
}

function getSmartPlaylistPreparationUrl(playlistId: string): string | null {
  if (playlistId.startsWith('smart_daylist_')) return '/api/hub/daylist';
  if (playlistId.startsWith('smart_on-repeat_')) return '/api/hub/on-repeat';
  if (playlistId.startsWith('smart_repeat-rewind_')) return '/api/hub/repeat-rewind';
  if (playlistId.startsWith('smart_seasonal-rewind_') || playlistId.startsWith('smart_year-rewind_')) {
    return '/api/hub/smart';
  }
  return null;
}

interface InlineEditableTextProps {
  /** The raw, editable value (may be empty even when a placeholder is displayed). */
  value: string;
  /** Persist a trimmed, changed value. Not called when unchanged (or emptied when allowEmpty is false). */
  onSave: (next: string) => void;
  ariaLabel: string;
  placeholder?: string;
  /** Font/colour classes for the text. */
  textClassName: string;
  /**
   * Width/flex utilities for the wrapper, controlling how the field sizes within
   * its parent — e.g. `'w-full'` (block) or `'flex-1 min-w-0'` (flex row). The
   * field itself is always `w-full` of this wrapper.
   */
  fieldClassName?: string;
  /** Allow saving an empty value (description). When false (title), emptying reverts. */
  allowEmpty?: boolean;
  pencilSize?: number;
  /**
   * Center the text below the `md` breakpoint and left-align at `md`+, to match
   * a hero that is centered on mobile. Also mirrors the pencil's right gutter on
   * the left below `md` so the centered text is truly centered, not offset.
   */
  centered?: boolean;
}

/**
 * Hover-to-reveal inline editor. ONE <textarea> stays mounted and just toggles
 * readOnly between view and edit — using the same element for both makes the
 * box (width, wrapping, height, text position) identical, so entering edit mode
 * feels like editing the text in place with no layout shift. The textarea
 * soft-wraps to follow its container width; Enter commits (no newlines), Escape
 * cancels, blur commits. Used for the playlist name and description.
 */
const InlineEditableText: React.FC<InlineEditableTextProps> = ({
  value,
  onSave,
  ariaLabel,
  placeholder,
  textClassName,
  fieldClassName = 'w-full',
  allowEmpty = false,
  pencilSize = 16,
  centered = false,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Keep the draft in sync with external changes while not actively editing.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const autosize = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Auto-size to content in both read-only and edit states so the box height is
  // identical whether or not you're editing.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el) autosize(el);
  }, [value, draft, editing, autosize]);

  const commit = useCallback(() => {
    setEditing(false);
    const next = draft.trim();
    if (next === value || (!allowEmpty && next.length === 0)) {
      setDraft(value);
      return;
    }
    onSave(next);
  }, [draft, value, allowEmpty, onSave]);

  const cancel = useCallback(() => {
    setDraft(value);
    setEditing(false);
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <div className={`group/edit relative ${fieldClassName}`}>
      <textarea
        ref={inputRef}
        value={editing ? draft : value}
        readOnly={!editing}
        rows={1}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(e) => { setDraft(e.target.value); autosize(e.target); }}
        onMouseDown={() => { if (!editing) setEditing(true); }}
        onFocus={() => { if (!editing) setEditing(true); }}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        // `pr-9` reserves the gutter the pencil floats in; `py-0 pl-0` strips the
        // control's intrinsic padding; the focus-visible overrides drop the
        // global green focus outline, leaving only the bottom border. When
        // `centered`, mirror the pr-9 gutter with pl-9 below md so the centered
        // text is truly centered (md+ stays flush-left with pl-0).
        className={`${textClassName} block w-full pr-9 py-0 ${centered ? 'pl-9 md:pl-0 text-center md:text-left' : 'pl-0'} bg-transparent border-b-2 outline-none focus:outline-none focus-visible:outline-none resize-none overflow-hidden cursor-text placeholder:italic placeholder:text-[var(--color-text-muted)] ${editing ? 'border-[var(--color-primary)]' : 'border-transparent'}`}
      />
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={(e) => { e.stopPropagation(); setEditing(true); inputRef.current?.focus(); }}
        className="absolute right-0 top-1.5 shrink-0 rounded-md p-1.5 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-black/5 hover:text-[var(--color-primary)] focus-visible:opacity-100 group-hover/edit:opacity-100 dark:hover:bg-white/10"
      >
        <Pencil size={pencilSize} />
      </button>
    </div>
  );
};

const PlaylistDetailSkeleton: React.FC<{ onBack: () => void; hero?: PlaylistHeroState }> = ({ onBack, hero }) => {
  const heroArt = (hero?.artUrls || []).slice(0, 4);
  const hasHero = !!hero && (!!hero.title || heroArt.length > 0);

  return (
    <div className="page-container relative overflow-x-hidden">
      <div className="relative z-10">
        <BackButton onClick={onBack}>Back to Playlists</BackButton>
        <div className="flex flex-col md:flex-row gap-6 md:gap-8 mb-8 md:mb-12 items-center md:items-end text-center md:text-left">
          {hasHero ? (
            <div
              className="w-48 h-48 md:w-60 md:h-60 shrink-0 rounded-2xl border border-black/10 dark:border-white/10 shadow-2xl relative overflow-hidden bg-black/10 dark:bg-white/5"
            >
              <div className="grid h-full w-full grid-cols-2 gap-0.5">
                {(heroArt.length > 0 ? heroArt : [null, null, null, null]).map((artUrl, index) => (
                  <div key={`${artUrl || 'fallback'}-${index}`} className="overflow-hidden bg-black/10 dark:bg-white/10">
                    {artUrl ? (
                      <img src={artUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <Disc3 className="h-8 w-8 text-[var(--color-text-muted)] opacity-40" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div
              className="w-48 h-48 md:w-60 md:h-60 shrink-0 rounded-2xl bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none"
            />
          )}

          <div className="flex-1 w-full space-y-3">
            {hasHero ? (
              <>
                <div className="font-semibold text-sm tracking-wider uppercase text-[var(--color-primary)]">
                  {hero?.isSystem ? 'Curated for You' : hero?.isLlmGenerated ? 'AI Curated Playlist' : 'Playlist'}
                </div>
                <h1 className="font-bold text-4xl md:text-5xl lg:text-6xl tracking-tight leading-tight text-[var(--color-text-primary)] line-clamp-2" title={hero?.title}>
                  {hero?.title}
                </h1>
                {(typeof hero?.trackCount === 'number' || hero?.pinned) && (
                  <div className="text-sm md:text-xl text-[var(--color-text-muted)]">
                    {typeof hero?.trackCount === 'number' && (
                      <span>{hero.trackCount} track{hero.trackCount !== 1 ? 's' : ''}</span>
                    )}
                    {hero?.pinned && <span className="ml-1"> • <Pin className="w-3.5 h-3.5 inline" /> pinned</span>}
                  </div>
                )}
                {hero?.description && (
                  <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed line-clamp-3 max-w-3xl mx-auto md:mx-0">
                    {hero.description}
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="h-4 w-20 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none mx-auto md:mx-0" />
                <div className="h-10 w-3/4 max-w-xl rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none mx-auto md:mx-0" />
                <div className="h-5 w-56 rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none mx-auto md:mx-0" />
                <div className="h-10 w-32 rounded-full bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none mx-auto md:mx-0 mt-4" />
              </>
            )}
          </div>
        </div>
        <div className="space-y-0.5">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-[30px_44px_minmax(0,1fr)_40px] md:grid-cols-[34px_52px_minmax(0,1.4fr)_minmax(0,1fr)_120px_92px_40px] gap-2 md:gap-3 px-2 md:px-4 py-2 items-center animate-pulse motion-reduce:animate-none"
            >
              <div className="h-4 w-4 rounded bg-[var(--color-surface-variant)]" />
              <div className="h-11 w-11 md:h-13 md:w-13 rounded-lg md:rounded-xl bg-[var(--color-surface-variant)]" />
              <div className="space-y-2">
                <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)]" />
                <div className="h-3 w-1/2 rounded bg-[var(--color-surface-variant)]" />
              </div>
              <div className="hidden md:block h-4 w-2/3 rounded bg-[var(--color-surface-variant)]" />
              <div className="hidden md:block h-4 w-20 rounded bg-[var(--color-surface-variant)]" />
              <div className="hidden md:block h-4 w-12 rounded bg-[var(--color-surface-variant)]" />
              <div className="h-8 w-8 rounded-full bg-[var(--color-surface-variant)]" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

interface PlaylistTrackRowProps {
  id: string;
  track: TrackInfo;
  index: number;
  totalTracks: number;
  getArtistLink: (artistName: string, track: TrackInfo) => string | null;
  onPlay: (index: number) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onContextMenu: (track: TrackInfo, x: number, y: number, playlistId: string, playlistTrackIndex: number) => void;
  playlistId: string;
  readOnly?: boolean;
  currentTrackId: string | null;
  playbackState: 'playing' | 'paused' | 'stopped';
}

const PlaylistTrackRow = memo(({
  id,
  track,
  index,
  totalTracks,
  getArtistLink,
  onPlay,
  onMove,
  onContextMenu,
  playlistId,
  readOnly = false,
  currentTrackId,
  playbackState,
}: PlaylistTrackRowProps) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: readOnly });
  const knownArtistKeys = useKnownArtistKeys();
  const isCurrent = track.id === currentTrackId;
  const artistNames = useMemo(() => {
    const raw = Array.isArray(track.artists) && track.artists.length > 0
      ? track.artists
      : parseArtistsForDisplay(track.artist || track.albumArtist || '', knownArtistKeys);
    return raw.flatMap(n => parseArtistsForDisplay(n, knownArtistKeys));
  }, [track.artists, track.artist, track.albumArtist, knownArtistKeys]);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.55 : 1,
        zIndex: isDragging ? 10 : 1,
      }}
      className={`grid grid-cols-[30px_44px_minmax(0,1fr)_40px] md:grid-cols-[34px_52px_minmax(0,1.4fr)_minmax(0,1fr)_120px_92px_40px] gap-2 md:gap-3 px-2 md:px-4 py-2 border-b border-black/5 dark:border-white/5 cursor-pointer items-center transition-ui duration-200 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg my-0.5 group ${isCurrent ? 'bg-primary/5' : ''}`}
    >
      <div
        className="flex items-center justify-center md:justify-start text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors text-sm tabular-nums"
        onClick={() => onPlay(index)}
      >
        {isCurrent && playbackState !== 'stopped' ? (
          <NowPlayingBars state={playbackState === 'playing' ? 'playing' : 'paused'} />
        ) : (
          index + 1
        )}
      </div>

      <div className="w-11 h-11 md:w-13 md:h-13 shrink-0 overflow-hidden rounded-lg md:rounded-xl border border-black/10 dark:border-white/10 bg-black/10 dark:bg-white/10">
        {track.artUrl ? (
          <img src={track.artUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Disc3 className="h-5 w-5 text-[var(--color-text-muted)] opacity-40" />
          </div>
        )}
      </div>

      <div className="min-w-0" onClick={() => onPlay(index)}>
        <span className="block truncate text-sm md:text-base font-medium text-[var(--color-text-primary)] group-hover:text-[var(--color-primary)] transition-colors">
          {track.title || track.path.split(/[\\/]/).pop()}
        </span>
        <span className="block text-xs text-[var(--color-text-muted)] mt-0.5 truncate">
          {artistNames.length > 0 ? artistNames.map((artistName, artistIndex) => {
            const artistLink = getArtistLink(artistName, track);
            return (
              <React.Fragment key={`${artistName}-${artistIndex}`}>
                {artistIndex > 0 && ' · '}
                {artistLink ? (
                  <Link
                    to={artistLink}
                    state={{ backLabel: 'Back to Playlist' }}
                    onClick={(event) => event.stopPropagation()}
                    className="hover:text-[var(--color-primary)] transition-colors no-underline text-inherit"
                  >
                    {artistName}
                  </Link>
                ) : (
                  <span>{artistName}</span>
                )}
              </React.Fragment>
            );
          }) : 'Unknown Artist'}
        </span>
      </div>

      <div className="hidden md:block min-w-0">
        <span className="block truncate text-sm text-[var(--color-text-secondary)]">
          {track.album || '--'}
        </span>
      </div>

      <div className="hidden md:block text-sm text-[var(--color-text-muted)] tabular-nums">
        {formatPlaylistAddedDate(track.playlistAddedAt)}
      </div>

      <div className="hidden text-[var(--color-text-muted)] md:flex md:flex-row md:items-center md:justify-start md:gap-2">
        <span className="w-12 text-right md:text-left hidden md:inline text-sm tabular-nums">
          {formatTime(track.duration, '--:--')}
        </span>
      </div>

      <div className="text-[var(--color-text-muted)] flex flex-row items-center justify-end md:gap-2">
        {!readOnly && (
          <div className="flex flex-col md:hidden mr-1">
            <button
              aria-label="Move up"
              onClick={(event) => {
                event.stopPropagation();
                if (index > 0) onMove(index, index - 1);
              }}
              disabled={index === 0}
              className="p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-30"
            >
              <ChevronUp size={14} />
            </button>
            <button
              aria-label="Move down"
              onClick={(event) => {
                event.stopPropagation();
                if (index < totalTracks - 1) onMove(index, index + 1);
              }}
              disabled={index === totalTracks - 1}
              className="p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] disabled:opacity-30"
            >
              <ChevronDown size={14} />
            </button>
          </div>
        )}

        <div className="opacity-100 md:opacity-0 md:group-hover:opacity-100 flex items-center transition-opacity">
          <LoveButton track={track} size={16} className="p-1.5" />
          {!readOnly && (
            <button
              {...attributes}
              {...listeners}
              aria-label="Drag to reorder"
              onClick={(event) => event.stopPropagation()}
              className="hidden md:flex cursor-grab text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-black/5 dark:hover:bg-white/10 rounded-md p-1.5 active:cursor-grabbing"
            >
              <GripVertical size={18} />
            </button>
          )}
          <button
            aria-label="More options"
            onClick={(event) => {
              event.stopPropagation();
              // For read-only playlists, omit playlistId so "Remove from Playlist" is hidden.
              if (readOnly) {
                onContextMenu(track, event.clientX, event.clientY, undefined as any, undefined as any);
              } else {
                onContextMenu(track, event.clientX, event.clientY, playlistId, index);
              }
            }}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-black/5 dark:hover:bg-white/10 rounded-md p-1.5"
          >
            <MoreHorizontal size={18} />
          </button>
        </div>
      </div>
    </div>
  );
});

PlaylistTrackRow.displayName = 'PlaylistTrackRow';

export const PlaylistDetail: React.FC = () => {
  const { playlistId } = useParams<{ playlistId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const heroState = useMemo(() => readPlaylistHeroState(location.state), [location.state]);
  const { addToast } = useToast();
  const [hasCheckedPlaylist, setHasCheckedPlaylist] = useState(false);
  const [isPreparingGeneratedPlaylist, setIsPreparingGeneratedPlaylist] = useState(false);

  const playlists = usePlayerStore((state) => state.playlists);
  // Suggestion candidates come from a bounded server pool (tracks related to
  // this playlist by artist/genre/album-artist) instead of the full in-memory
  // library; the overlap scoring below ranks them the same way.
  const { tracks: suggestionPool } = useEntityTracks(
    playlistId ? `/api/playlists/${encodeURIComponent(playlistId)}/suggestions` : null,
  );
  const artists = usePlayerStore((state) => state.artists);
  const setPlaylist = usePlayerStore((state) => state.setPlaylist);
  const playNext = usePlayerStore((state) => state.playNext);
  const openContextMenu = usePlayerStore((state) => state.openContextMenu);
  const replaceTracksInUserPlaylist = usePlayerStore((state) => state.replaceTracksInUserPlaylist);
  const updatePlaylistMeta = usePlayerStore((state) => state.updatePlaylistMeta);
  const togglePlaylistPrivacy = usePlayerStore((state) => state.togglePlaylistPrivacy);
  const addTracksToUserPlaylist = usePlayerStore((state) => state.addTracksToUserPlaylist);
  const fetchPlaylistsFromServer = usePlayerStore((state) => state.fetchPlaylistsFromServer);
  const fetchPlaylistFromServer = usePlayerStore((state) => state.fetchPlaylistFromServer);
  const isPlaylistsLoading = usePlayerStore((state) => state.isPlaylistsLoading);
  const getAuthHeader = usePlayerStore((state) => state.getAuthHeader);
  const currentTrackId = usePlayerStore((state) => state.currentIndex !== null ? state.playlist[state.currentIndex]?.id ?? null : null);
  const playbackState = useNowPlayingState();

  const playlist = useMemo(
    () => playlists.find((entry) => entry.id === playlistId),
    [playlists, playlistId]
  );

  useEffect(() => {
    let cancelled = false;

    if (!playlistId) return;
    if (playlist) {
      setHasCheckedPlaylist(true);
      return;
    }

    setHasCheckedPlaylist(false);
    setIsPreparingGeneratedPlaylist(false);

    const loadPlaylist = async () => {
      // Cheap path: just this one playlist. Falls back to the bulk fetch
      // only when the server says the playlist doesn't exist yet (e.g. a
      // generated smart playlist that needs a preparation call first).
      let found = await fetchPlaylistFromServer(playlistId);
      if (cancelled) return;

      const preparationUrl = getSmartPlaylistPreparationUrl(playlistId);

      if (!found && preparationUrl) {
        setIsPreparingGeneratedPlaylist(true);
        try {
          await fetch(preparationUrl, { headers: getAuthHeader() });
          if (!cancelled) {
            found = await fetchPlaylistFromServer(playlistId);
          }
        } catch (error) {
          console.error('Failed to prepare generated playlist', error);
        } finally {
          if (!cancelled) setIsPreparingGeneratedPlaylist(false);
        }
      }

      if (!found && !cancelled) {
        // Last-resort: refresh the whole list. Covers cases where the
        // server has the playlist but our single-id route reported 404
        // due to a transient permission/scoping mismatch.
        await fetchPlaylistsFromServer();
      }

      if (!cancelled) setHasCheckedPlaylist(true);
    };

    void loadPlaylist();

    return () => {
      cancelled = true;
    };
  }, [fetchPlaylistFromServer, fetchPlaylistsFromServer, getAuthHeader, playlist, playlistId]);

  const isSystemPlaylist = !!playlist?.isSystem;
  // Ownership mirrors the Playlists tab: a playlist is the current user's unless
  // the server explicitly flagged it isOwner:false. Every playlist from
  // GET /api/playlists is the user's own by construction (so isOwner is absent
  // there); only discovered playlists from other users carry isOwner:false. This
  // avoids depending on currentUser.id being populated/matching, which broke
  // editing your own playlists. The backend still enforces owner-only writes.
  const isOwner = !!playlist && playlist.isOwner !== false;
  // Anyone may listen; only the owner of a non-system playlist may edit it.
  const canEdit = isOwner && !isSystemPlaylist;
  const playlistTracks = playlist?.tracks || [];
  const trackListRef = useRef<HTMLDivElement>(null);
  const deferredPlaylistTracks = useDeferredValue(playlistTracks);

  const heroArtUrls = useMemo(
    () => Array.from(new Set(playlistTracks.map((track) => track.artUrl).filter(Boolean) as string[])).slice(0, 8),
    [playlistTracks]
  );

  const backdropTiles = useMemo(
    () => buildBackdropTiles(heroArtUrls),
    [heroArtUrls]
  );

  const sortableItems = useMemo(
    () => playlistTracks.map((track, index) => `${track.id}-${index}`),
    [playlistTracks]
  );

  const shouldVirtualizePlaylistRows = playlistTracks.length > 50;
  const playlistRowsVirtualizer = useVirtualizer({
    count: playlistTracks.length,
    getScrollElement: () => trackListRef.current,
    estimateSize: () => 68,
    overscan: 8,
    enabled: shouldVirtualizePlaylistRows,
  });

  const totalDuration = useMemo(
    () => playlistTracks.reduce((sum, track) => sum + (track.duration || 0), 0),
    [playlistTracks]
  );

  const knownArtistKeys = useKnownArtistKeys();
  const artistCount = useMemo(() => {
    const seen = new Set<string>();
    for (const track of playlistTracks) {
      const raw = Array.isArray(track.artists) && track.artists.length > 0
        ? track.artists
        : parseArtistsForDisplay(track.artist || track.albumArtist || '', knownArtistKeys);
      const names = raw.flatMap(n => parseArtistsForDisplay(n, knownArtistKeys));
      for (const name of names) {
        if (name) seen.add(name.toLowerCase());
      }
    }
    return seen.size;
  }, [playlistTracks, knownArtistKeys]);

  const suggestionEntries = useMemo(
    () => getSuggestedPlaylistTracks(suggestionPool, deferredPlaylistTracks, 8),
    [suggestionPool, deferredPlaylistTracks]
  );

  const [saveLabel, setSaveLabel] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const setSavingState = useCallback((label: string | null, saving: boolean) => {
    setSaveLabel(label);
    setIsSaving(saving);
  }, []);

  const artistLinkByName = useMemo(() => {
    const links = new Map<string, string>();
    for (const entity of artists) {
      if (entity.name && entity.id) {
        links.set(entity.name.toLowerCase(), `/library/artist/${entity.id}`);
      }
    }
    return links;
  }, [artists]);

  const getArtistLink = useCallback((artistName: string, track: TrackInfo): string | null => {
    const entityLink = artistLinkByName.get(artistName.toLowerCase());
    if (entityLink) return entityLink;
    if (track.artistId) return `/library/artist/${track.artistId}`;
    return null;
  }, [artistLinkByName]);

  const persistTracks = useCallback(
    async (nextTracks: TrackInfo[], pendingLabel: string, successMessage: string) => {
      if (!playlist) return;

      setSavingState(pendingLabel, true);
      try {
        await replaceTracksInUserPlaylist(playlist.id, nextTracks.map((track) => track.id));
        setSavingState(successMessage, false);
        window.setTimeout(() => {
          setSaveLabel((current) => (current === successMessage ? null : current));
        }, 1200);
      } catch {
        setSavingState(null, false);
        addToast('Failed to update playlist.', 'error');
      }
    },
    [addToast, playlist, replaceTracksInUserPlaylist, setSavingState]
  );

  const handlePlayFromIndex = useCallback((startIndex: number) => {
    if (playlistTracks.length === 0) return;
    void setPlaylist(playlistTracks, startIndex, playlistId ? { kind: 'playlist', id: playlistId } : null);
  }, [playlistTracks, setPlaylist]);

  const handleMoveTrack = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    const nextTracks = reorderTracks(playlistTracks, fromIndex, toIndex);
    void persistTracks(nextTracks, 'Saving order...', 'Order saved');
  }, [persistTracks, playlistTracks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = active.id as string;
    const overId = over.id as string;
    const fromIndex = sortableItems.indexOf(activeId);
    const toIndex = sortableItems.indexOf(overId);

    if (fromIndex !== -1 && toIndex !== -1) {
      const nextTracks = reorderTracks(playlistTracks, fromIndex, toIndex);
      void persistTracks(nextTracks, 'Saving order...', 'Order saved');
    }
  }, [persistTracks, playlistTracks, sortableItems]);

  const handleAddSuggestion = useCallback(async (track: TrackInfo) => {
    if (!playlist) return;

    setSavingState('Adding track...', true);
    try {
      await addTracksToUserPlaylist(playlist.id, [track.id]);
      setSavingState('Track added', false);
      window.setTimeout(() => {
        setSaveLabel((current) => (current === 'Track added' ? null : current));
      }, 1200);
    } catch {
      setSavingState(null, false);
      addToast('Failed to add track to playlist.', 'error');
    }
  }, [addToast, addTracksToUserPlaylist, playlist, setSavingState]);

  const handleShare = useCallback(async () => {
    if (!playlist?.id) return;
    const share = (enable: boolean) =>
      fetch(`/api/playlists/${playlist.id}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
        body: JSON.stringify({ enable }),
      });
    try {
      const res = await share(true);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.sharePath) throw new Error('No share path');
      const url = `${window.location.origin}${data.sharePath}`;
      try { await navigator.clipboard.writeText(url); } catch { /* clipboard blocked — toast still shows the action */ }
      addToast('Public link copied to clipboard.', 'success', {
        actionLabel: 'Stop sharing',
        duration: 8000,
        onAction: async () => {
          try {
            const off = await share(false);
            if (!off.ok) throw new Error(`HTTP ${off.status}`);
            addToast('Sharing disabled.', 'info');
          } catch {
            addToast('Failed to disable sharing.', 'error');
          }
        },
      });
    } catch {
      addToast('Failed to create share link.', 'error');
    }
  }, [playlist, getAuthHeader, addToast]);

  const handleSaveMeta = useCallback(
    async (updates: { title?: string; description?: string }) => {
      if (!playlist?.id) return;
      try {
        await updatePlaylistMeta(playlist.id, updates);
      } catch {
        addToast('Failed to save changes.', 'error');
      }
    },
    [playlist?.id, updatePlaylistMeta, addToast]
  );

  const handleTogglePrivacy = useCallback(async () => {
    if (!playlist?.id) return;
    const nextPrivate = !playlist.isPrivate;
    try {
      await togglePlaylistPrivacy(playlist.id, nextPrivate);
      addToast(
        nextPrivate ? 'Playlist hidden from others.' : 'Playlist is now discoverable.',
        'info'
      );
    } catch {
      addToast('Failed to update privacy.', 'error');
    }
  }, [playlist?.id, playlist?.isPrivate, togglePlaylistPrivacy, addToast]);

  const renderPlaylistTrackRow = useCallback((track: TrackInfo, index: number, readOnly = !canEdit) => {
    const itemId = sortableItems[index];
    if (!playlist || !itemId) return null;

    return (
      <PlaylistTrackRow
        key={itemId}
        id={itemId}
        track={track}
        index={index}
        totalTracks={playlistTracks.length}
        getArtistLink={getArtistLink}
        onPlay={handlePlayFromIndex}
        onMove={handleMoveTrack}
        onContextMenu={openContextMenu}
        playlistId={playlist.id}
        readOnly={readOnly}
        currentTrackId={currentTrackId}
        playbackState={playbackState}
      />
    );
  }, [
    currentTrackId,
    getArtistLink,
    handleMoveTrack,
    handlePlayFromIndex,
    canEdit,
    openContextMenu,
    playbackState,
    playlist,
    playlistTracks.length,
    sortableItems,
  ]);

  if (!playlistId) {
    return <div className="page-container">Playlist not found.</div>;
  }

  if (!playlist) {
    if (isPlaylistsLoading || isPreparingGeneratedPlaylist || !hasCheckedPlaylist) {
      return <PlaylistDetailSkeleton onBack={() => navigate('/playlists')} hero={heroState} />;
    }

    return (
      <div className="page-container">
        <BackButton onClick={() => navigate('/playlists')}>Back to Playlists</BackButton>
        <div className="text-[var(--color-text-muted)]">Playlist not found.</div>
      </div>
    );
  }

  return (
    <div className="page-container relative overflow-x-hidden">
      <div className="pointer-events-none absolute left-1/2 top-0 h-[32rem] md:h-[44rem] w-screen -translate-x-1/2 overflow-hidden z-0">
        <div
          className="absolute left-1/2 top-[-4%] grid w-[165vw] md:w-[138vw] lg:w-[118vw] grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-3 opacity-20 md:opacity-25"
          style={{
            transform: 'translateX(-50%) rotate(-18deg) scale(1.1)',
            WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.88) 10%, rgba(0,0,0,0.56) 18%, rgba(0,0,0,0.26) 24%, rgba(0,0,0,0.10) 30%, rgba(0,0,0,0.03) 36%, transparent 42%)',
            maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.88) 10%, rgba(0,0,0,0.56) 18%, rgba(0,0,0,0.26) 24%, rgba(0,0,0,0.10) 30%, rgba(0,0,0,0.03) 36%, transparent 42%)',
          }}
        >
          {backdropTiles.map((tile, index) => (
            <div
              key={`${tile || 'empty'}-${index}`}
              className="aspect-square overflow-hidden rounded-[1.4rem] border border-white/10 bg-black/5 shadow-xl dark:bg-white/5"
            >
              {tile ? (
                <img src={tile} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <Disc3 className="h-8 w-8 text-[var(--color-text-muted)] opacity-30" />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="relative z-10">
        <BackButton onClick={() => navigate('/playlists')}>Back to Playlists</BackButton>

        <div className="flex flex-col md:flex-row gap-6 md:gap-8 mb-8 md:mb-12 items-center md:items-end text-center md:text-left">
          <div
            className="w-48 h-48 md:w-60 md:h-60 shrink-0 rounded-2xl border border-black/10 dark:border-white/10 shadow-2xl relative overflow-hidden bg-black/10 dark:bg-white/5"
          >
            {playlist.generationSource === 'wrapped' ? (
              // Wrapped identity carries into the detail page (the art backdrop
              // above still shows the recap's actual content).
              <AuroraCover
                variant="wrapped"
                seed={playlist.id || playlist.title}
                title={playlist.title}
                label={wrappedCoverLabel(playlist.title) || undefined}
              />
            ) : (
              <div className="grid h-full w-full grid-cols-2 gap-0.5">
                {(heroArtUrls.length > 0 ? heroArtUrls.slice(0, 4) : [null, null, null, null]).map((artUrl, index) => (
                  <div key={`${artUrl || 'fallback'}-${index}`} className="overflow-hidden bg-black/10 dark:bg-white/10">
                    {artUrl ? (
                      <img src={artUrl} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <Disc3 className="h-8 w-8 text-[var(--color-text-muted)] opacity-40" />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col justify-end items-center md:items-start max-w-full">
            <div className="font-semibold text-sm tracking-wider uppercase text-[var(--color-primary)]">
              {playlist.isSystem
                ? 'Curated for You'
                : playlist.isLlmGenerated
                  ? 'AI Curated Playlist'
                  : isOwner
                    ? 'Playlist by You'
                    : `Playlist by ${playlist.ownerUsername || 'another listener'}`}
            </div>

            <div className="flex flex-wrap items-center gap-3 my-2">
              {canEdit ? (
                <InlineEditableText
                  value={playlist.title}
                  ariaLabel="Edit playlist name"
                  placeholder="Playlist name"
                  fieldClassName="flex-1 min-w-0"
                  textClassName="font-bold text-4xl md:text-5xl lg:text-6xl tracking-tight leading-tight text-[var(--color-text-primary)]"
                  centered
                  pencilSize={20}
                  onSave={(next) => handleSaveMeta({ title: next })}
                />
              ) : (
                <h1 className="font-bold text-4xl md:text-5xl lg:text-6xl tracking-tight leading-tight text-[var(--color-text-primary)] line-clamp-2" title={playlist.title}>
                  {playlist.title}
                </h1>
              )}
              {currentTrackId && playlistTracks.some(t => t.id === currentTrackId) && playbackState !== 'stopped' && (
                <NowPlayingBadge state={playbackState === 'playing' ? 'playing' : 'paused'} className="self-center shrink-0" />
              )}
            </div>

            <h2 className="text-xl text-[var(--color-text-secondary)] flex flex-wrap justify-center md:justify-start items-center gap-2 mb-2 w-full truncate">
              <span className="shrink-0 text-sm md:text-xl text-[var(--color-text-muted)]">
                {playlistTracks.length} track{playlistTracks.length !== 1 ? 's' : ''}
                {totalDuration > 0 && (
                  <span className="inline-flex items-center gap-1 ml-1">
                    • <Clock className="w-3.5 h-3.5 inline" /> {formatDuration(totalDuration)}
                  </span>
                )}
                {artistCount > 0 && <span className="ml-1"> • {artistCount} artist{artistCount !== 1 ? 's' : ''}</span>}
                {playlist.pinned && <span className="ml-1"> • <Pin className="w-3.5 h-3.5 inline" /> pinned</span>}
              </span>
            </h2>

            {canEdit ? (
              <div className="mb-4 mt-2 w-full max-w-3xl">
                <InlineEditableText
                  value={playlist.description || ''}
                  allowEmpty
                  ariaLabel="Edit playlist description"
                  placeholder="Add a description…"
                  fieldClassName="w-full"
                  textClassName="text-sm text-[var(--color-text-secondary)] leading-relaxed"
                  pencilSize={14}
                  onSave={(next) => handleSaveMeta({ description: next })}
                />
              </div>
            ) : (
              (playlist.description || isSystemPlaylist) && (
                <p className="shrink-0 text-sm text-[var(--color-text-secondary)] leading-relaxed mb-4 mt-2 line-clamp-3 max-w-3xl">
                  {playlist.description || 'Refreshed automatically based on your listening.'}
                </p>
              )
            )}

            <div className="mt-2 flex flex-wrap justify-center md:justify-start items-center gap-3 w-full md:w-auto">
              <button
                onClick={() => handlePlayFromIndex(0)}
                disabled={playlistTracks.length === 0}
                className="btn btn-primary btn-lg"
              >
                <span className="inline-flex items-center gap-2">
                  <Play size={18} fill="currentColor" />
                  Play Playlist
                </span>
              </button>
              {canEdit && playlist.id && (
                <button
                  onClick={handleShare}
                  className="btn btn-ghost btn-lg"
                  aria-label="Create a public share link"
                >
                  <span className="inline-flex items-center gap-2">
                    <Share2 size={18} />
                    Share
                  </span>
                </button>
              )}
              {canEdit && playlist.id && (
                <button
                  onClick={handleTogglePrivacy}
                  className="btn btn-ghost btn-lg"
                  aria-label={playlist.isPrivate ? 'Make this playlist discoverable' : 'Hide this playlist from others'}
                  title={playlist.isPrivate
                    ? 'Private — only you can see this playlist'
                    : 'Discoverable — other listeners can find and play this playlist'}
                >
                  <span className="inline-flex items-center gap-2">
                    {playlist.isPrivate ? <Lock size={18} /> : <LockOpen size={18} />}
                    {playlist.isPrivate ? 'Private' : 'Discoverable'}
                  </span>
                </button>
              )}
              {saveLabel && (
                <div className="inline-flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                  {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 text-[var(--color-primary)]" />}
                  <span>{saveLabel}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mb-8">
          <div className="grid grid-cols-[30px_44px_minmax(0,1fr)_40px] md:grid-cols-[34px_52px_minmax(0,1.4fr)_minmax(0,1fr)_120px_92px_40px] gap-2 md:gap-3 px-2 md:px-4 py-3 border-b border-black/5 dark:border-white/10 font-semibold text-xs uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
            <div className="text-center md:text-left">#</div>
            <div aria-hidden="true" />
            <div>Title</div>
            <div className="hidden md:block">Album</div>
            <div className="hidden md:block">Date Added</div>
            <div className="hidden md:block md:text-left">Time</div>
            <div aria-hidden="true" />
          </div>

          {playlistTracks.length === 0 ? (
            <div className="px-6 py-12 text-center text-[var(--color-text-secondary)] border-b border-black/5 dark:border-white/5">
              {canEdit
                ? 'Add tracks from the library to start shaping this playlist.'
                : isSystemPlaylist
                  ? 'No tracks yet — listen to a few songs and check back soon.'
                  : 'This playlist is empty.'}
            </div>
          ) : !canEdit ? (
            <div
              ref={trackListRef}
              className={shouldVirtualizePlaylistRows ? 'max-h-[70vh] overflow-y-auto overflow-x-hidden hide-scrollbar pr-1' : undefined}
            >
              {shouldVirtualizePlaylistRows ? (
                <div
                  style={{
                    height: `${playlistRowsVirtualizer.getTotalSize()}px`,
                    position: 'relative',
                    width: '100%',
                  }}
                >
                  {playlistRowsVirtualizer.getVirtualItems().map((virtualRow) => {
                    const track = playlistTracks[virtualRow.index];
                    const itemId = sortableItems[virtualRow.index];
                    if (!track || !itemId) return null;

                    return (
                      <div
                        key={itemId}
                        data-index={virtualRow.index}
                        ref={playlistRowsVirtualizer.measureElement}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        {renderPlaylistTrackRow(track, virtualRow.index, true)}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-0.5">
                  {playlistTracks.map((track, index) => renderPlaylistTrackRow(track, index, true))}
                </div>
              )}
            </div>
          ) : (
            <div
              ref={trackListRef}
              className={shouldVirtualizePlaylistRows ? 'max-h-[70vh] overflow-y-auto overflow-x-hidden hide-scrollbar pr-1' : undefined}
            >
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
                  {shouldVirtualizePlaylistRows ? (
                    <div
                      style={{
                        height: `${playlistRowsVirtualizer.getTotalSize()}px`,
                        position: 'relative',
                        width: '100%',
                      }}
                    >
                      {playlistRowsVirtualizer.getVirtualItems().map((virtualRow) => {
                        const track = playlistTracks[virtualRow.index];
                        const itemId = sortableItems[virtualRow.index];
                        if (!track || !itemId) return null;

                        return (
                          <div
                            key={itemId}
                            data-index={virtualRow.index}
                            ref={playlistRowsVirtualizer.measureElement}
                            style={{
                              position: 'absolute',
                              top: 0,
                              left: 0,
                              width: '100%',
                              transform: `translateY(${virtualRow.start}px)`,
                            }}
                          >
                            {renderPlaylistTrackRow(track, virtualRow.index, false)}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="space-y-0.5">
                      {playlistTracks.map((track, index) => renderPlaylistTrackRow(track, index, false))}
                    </div>
                  )}
                </SortableContext>
              </DndContext>
            </div>
          )}
        </div>

        {canEdit && suggestionEntries.length > 0 && (
          <div className="pt-2">
            <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)]">Suggested Tracks</h3>
                <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                  Nearby picks from your library based on the artists, albums, and genre clusters already in this playlist.
                </p>
              </div>
              <div className="rounded-full border border-[var(--glass-border)] bg-black/5 px-3 py-2 text-xs font-semibold uppercase tracking-widest text-[var(--color-text-muted)] dark:bg-white/5 shrink-0">
                {suggestionEntries.length} suggestions
              </div>
            </div>

            <div className="space-y-3">
              {suggestionEntries.map(({ track, reason }) => (
                <div
                  key={track.id}
                  className="flex items-center gap-3 rounded-2xl border border-black/5 dark:border-white/10 bg-black/[0.03] dark:bg-white/[0.03] px-3 py-3"
                >
                  <AlbumArt
                    artUrl={track.artUrl}
                    artist={track.artist}
                    album={track.album}
                    className="w-14 h-14 rounded-xl shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm md:text-base font-medium text-[var(--color-text-primary)]">
                      {track.title || track.path.split(/[\\/]/).pop()}
                    </div>
                    <div className="truncate text-xs md:text-sm text-[var(--color-text-secondary)]">
                      {track.artist || track.albumArtist || 'Unknown Artist'}
                    </div>
                    <div className="truncate text-xs text-[var(--color-text-muted)] mt-1">
                      {reason}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => playNext(track, { notify: true, undo: true })}
                      className="btn btn-ghost btn-sm hidden sm:inline-flex"
                    >
                      Play Next
                    </button>
                    <button
                      onClick={() => void handleAddSuggestion(track)}
                      className="btn btn-primary btn-sm"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <Plus className="w-3.5 h-3.5" />
                        Add
                      </span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
