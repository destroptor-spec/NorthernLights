import React, { forwardRef, useCallback, useImperativeHandle, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { usePlayerStore } from '../store';
import { parseArtistsForDisplay } from '../utils/artistUtils';
import { useKnownArtistKeys } from '../hooks/useKnownArtistKeys';
import { PlaylistItem } from './PlaylistItem';
import { useToast } from '../hooks/useToast';
import type { TrackInfo } from '../utils/fileSystem';
import { canMoveInSections, nextFromLabel, queueSections } from '../utils/queueSections';
import { useGigPeople } from '../hooks/useGigPeople';
import { usePresenceList } from '../hooks/usePresenceList';

// Clear-with-undo, shared by the desktop sidebar header and the mobile
// now-playing queue header so the two surfaces never drift apart.
export function useClearQueueWithUndo() {
  const playlist = usePlayerStore(state => state.playlist);
  const currentIndex = usePlayerStore(state => state.currentIndex);
  const clearPlaylist = usePlayerStore(state => state.clearPlaylist);
  const restoreQueueSnapshot = usePlayerStore(state => state.restoreQueueSnapshot);
  const { addToast } = useToast();

  return useCallback(() => {
    if (!playlist.length) return;
    const snapshot = playlist.map((track) => ({ ...track }));
    const snapshotIndex = currentIndex;
    clearPlaylist();
    addToast(`Cleared ${snapshot.length} ${snapshot.length === 1 ? 'track' : 'tracks'} from queue.`, 'info', {
      actionLabel: 'Undo',
      onAction: () => restoreQueueSnapshot(snapshot, snapshotIndex),
      duration: 8000,
    });
  }, [addToast, clearPlaylist, currentIndex, playlist, restoreQueueSnapshot]);
}

// Remove-with-undo for one queue row, shared by the rows' ✕ and the track
// menu's "Remove from queue". Reads the queue when called, so a menu opened
// a while ago removes the entry it was opened on, wherever it is now.
export function useRemoveFromQueueWithUndo() {
  const { addToast } = useToast();
  return useCallback((queueEntryIdOrIndex: string | number) => {
    const { playlist, currentIndex, removeFromPlaylist, restoreQueueSnapshot } = usePlayerStore.getState();
    const index = typeof queueEntryIdOrIndex === 'number'
      ? queueEntryIdOrIndex
      : playlist.findIndex((track) => track.queueEntryId === queueEntryIdOrIndex);
    const removed = playlist[index];
    if (!removed || index === currentIndex) return; // the track that plays is skipped, not removed

    const snapshot = playlist.map((track) => ({ ...track }));
    removeFromPlaylist(index);
    addToast(`Removed "${removed.title || 'track'}" from queue.`, 'info', {
      actionLabel: 'Undo',
      onAction: () => restoreQueueSnapshot(snapshot, currentIndex),
      duration: 6500,
    });
  }, [addToast]);
}

// A queue is a vertical list: a dragged row moves up and down only, never
// sideways off the list (the touch queue in Now Playing let it wander).
export const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

export interface QueueListHandle {
  scrollToIndex: (
    index: number,
    options?: { align?: 'start' | 'center' | 'end' | 'auto'; behavior?: 'auto' | 'smooth' },
  ) => void;
}

interface QueueListProps {
  // The element that scrolls this list. The sidebar passes its own internal
  // scroll div; the mobile now-playing sheet passes its outer two-page
  // scroller, with `scrollMargin` = the list's offset inside that scroller.
  getScrollElement: () => HTMLElement | null;
  scrollMargin?: number;
  collapsed?: boolean;
  listClassName?: string;
  /** The mobile Now Playing queue: touch rows (see PlaylistItem `touch`). */
  touch?: boolean;
  /**
   * The desktop sidebar: the upcoming queue in sections (Current track, Next
   * in Queue, Next from: …, Infinity), played tracks left out. Headings only
   * when not collapsed. See utils/queueSections.
   */
  sections?: boolean;
  /**
   * The phone's Now Playing queue: one list from the track that plays down,
   * played tracks left out (they are in Recently played), no headings.
   */
  upcoming?: boolean;
}

/**
 * A row of the list: a section heading, or the queue entry at `index`, with
 * what it shows, so a row that went can still be drawn while it folds away.
 */
type QueueRow =
  | { type: 'heading'; key: string; label: string }
  | { type: 'track'; index: number; id: string; track: TrackInfo; active: boolean };

const rowKey = (row: QueueRow) => (row.type === 'heading' ? `heading-${row.key}` : row.id);
/** More rows in or out than this at once (a new album) just switches. */
const MAX_FOLDING_ROWS = 12;

// The virtualized queue rows plus their drag-reorder and remove-with-undo
// wiring, extracted from PlaylistSidebar so the mobile now-playing sheet can
// embed the same queue surface. PlaylistItem calls useSortable internally, so
// the Dnd contexts always wrap the list; on touch layouts the drag handle is
// hidden and reordering uses the rows' chevron buttons instead.
export const QueueList = forwardRef<QueueListHandle, QueueListProps>(function QueueList(
  { getScrollElement, scrollMargin = 0, collapsed = false, listClassName = '', touch = false, sections = false, upcoming = false },
  ref,
) {
  const playlist = usePlayerStore(state => state.playlist);
  const currentIndex = usePlayerStore(state => state.currentIndex);
  const queueSource = usePlayerStore(state => state.queueSource);
  // During a gig, who queued each track by hand (sidebar only).
  const gigPeople = useGigPeople();
  // A tap goes to the device that plays, when this one controls it.
  const playAtIndex = usePlayerStore(state => state.playQueueEntry);
  const moveInPlaylist = usePlayerStore(state => state.moveInPlaylist);
  const openContextMenu = usePlayerStore(state => state.openContextMenu);
  // The menu knows which queue entry it was opened on (Remove from queue).
  const openRowMenu = useCallback((track: TrackInfo, x: number, y: number) =>
    openContextMenu(track, x, y, undefined, undefined, track.queueEntryId), [openContextMenu]);

  const getArtistLink = usePlayerStore(state => (artistName: string) => {
    const entity = state.artists.find((a: any) => a.name?.toLowerCase() === artistName.toLowerCase());
    return entity ? `/library/artist/${entity.id}` : null;
  });

  const knownArtistKeys = useKnownArtistKeys();
  const parseArtists = useCallback(
    (str: string) => parseArtistsForDisplay(str, knownArtistKeys),
    [knownArtistKeys]
  );

  // Queue entry IDs are unique and stay with a row when it moves, so a drag
  // animates the row itself; position-based IDs only for entries without one.
  const sortableItems = useMemo(() => playlist.map((t, idx) => t.queueEntryId || `${t.id}-${idx}`), [playlist]);

  const rows = useMemo<QueueRow[]>(() => {
    const trackRow = (index: number): QueueRow => ({
      type: 'track', index, id: sortableItems[index], track: playlist[index], active: currentIndex === index,
    });
    if (upcoming && !sections) {
      const from = currentIndex !== null && currentIndex < playlist.length ? currentIndex : 0;
      return playlist.slice(from).map((_, offset) => trackRow(from + offset));
    }
    if (!sections) return playlist.map((_, index) => trackRow(index));
    const parts = queueSections(playlist, currentIndex);
    const out: QueueRow[] = [];
    const add = (key: string, label: string, indexes: number[]) => {
      if (indexes.length === 0) return;
      if (!collapsed) out.push({ type: 'heading', key, label });
      for (const index of indexes) out.push(trackRow(index));
    };
    if (parts.current !== null) add('current', 'Current track', [parts.current]);
    add('queued', 'Next in Queue', parts.queued);
    add('context', nextFromLabel(queueSource, parts.context.map((index) => playlist[index])), parts.context);
    add('infinity', 'Next from: Infinity', parts.infinity);
    return out;
  }, [sections, upcoming, playlist, sortableItems, currentIndex, queueSource, collapsed]);

  // In the sidebar, rows and headings fold open as they come and shut as they
  // go (a track queued, the played one leaving the top), as in the Connect card.
  const presence = usePresenceList(rows, rowKey, { enabled: sections, maxAnimated: MAX_FOLDING_ROWS });

  // Maintain stability of item heights using estimateSize
  const virtualizer = useVirtualizer({
    count: presence.length,
    // Sizes are remembered per row, not per position: rows move (a heading
    // comes or goes, a row folds away to 0 px), and a row that moved must not
    // take the size measured for whatever stood there before, which drew rows
    // on top of each other.
    getItemKey: (index) => presence[index]?.key ?? index,
    getScrollElement,
    estimateSize: (i) => (presence[i]?.item.type === 'heading' ? 48 : collapsed ? 80 : touch ? 62 : sections ? 60 : 70),
    overscan: 10,
    scrollMargin,
  });

  useImperativeHandle(ref, () => ({
    // `index` is the queue entry's; in sections the rows include headings.
    scrollToIndex: (index, options) => {
      const row = presence.findIndex((entry) => !entry.leaving && entry.item.type === 'track' && entry.item.index === index);
      if (row >= 0) virtualizer.scrollToIndex(row, options);
    },
  }), [virtualizer, presence]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // The rows that can be dragged, in the order they show (not those folding away).
  const visibleSortable = useMemo(
    () => presence.flatMap((entry) => (entry.item.type === 'track' && !entry.leaving ? [entry.item.id] : [])),
    [presence],
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = sortableItems.indexOf(active.id as string);
      const newIndex = sortableItems.indexOf(over.id as string);
      // Where played tracks are left out (sidebar, phone), the track that
      // plays stays put: a drop onto it snaps back.
      const fromPlaying = sections || upcoming;
      if (oldIndex !== -1 && newIndex !== -1 && (!fromPlaying || canMoveInSections(oldIndex, newIndex, currentIndex))) {
        moveInPlaylist(oldIndex, newIndex);
      }
    }
  }, [sortableItems, moveInPlaylist, sections, upcoming, currentIndex]);

  return (
    <div className={listClassName}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[verticalOnly]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={visibleSortable}
          strategy={verticalListSortingStrategy}
        >
          <ul
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
            className="list-none p-0 m-0"
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const entry = presence[virtualRow.index];
              if (!entry) return null;
              const row = entry.item;
              const fold = `presence-fold${entry.entering ? ' is-entering' : ''}${entry.leaving ? ' is-leaving' : ''}`;
              const rowStyle: React.CSSProperties = {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                // With an external scroller, row offsets include the
                // list's scrollMargin — subtract it to position within
                // the list itself.
                transform: `translateY(${virtualRow.start - scrollMargin}px)`,
              };
              if (row.type === 'heading') {
                return (
                  <li
                    key={entry.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={rowStyle}
                    className={fold}
                    role="presentation"
                    aria-hidden={entry.leaving || undefined}
                  >
                    <div className="presence-fold-inner">
                      <div className="queue-section-heading">
                        <h3>{row.label}</h3>
                      </div>
                    </div>
                  </li>
                );
              }
              // A row that went is drawn as it was (its index may be stale), and does nothing.
              const idx = row.index;
              const t = row.track;
              const itemId = row.id;

              return (
                <div
                  key={entry.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={rowStyle}
                  className={fold}
                  aria-hidden={entry.leaving || undefined}
                >
                  <div className="presence-fold-inner">
                  <PlaylistItem
                    id={itemId}
                    track={t}
                    index={idx}
                    isActive={row.active}
                    isSidebarCollapsed={collapsed}
                    onPlay={playAtIndex}
                    onContextMenu={openRowMenu}
                    getArtistLink={getArtistLink}
                    parseArtists={parseArtists}
                    opacity={(t.isInfinity && (currentIndex === null || idx > currentIndex)) ? 0.6 : 1}
                    touch={touch}
                    // The sidebar's current track: neither dragged nor dropped onto.
                    locked={entry.leaving || ((sections || upcoming) && currentIndex === idx)}
                    queuedBy={sections && t.queuedBy ? gigPeople?.get(t.queuedBy) : undefined}
                  />
                  </div>
                </div>
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
});
