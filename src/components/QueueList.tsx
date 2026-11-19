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
}

/** A row of the list: a section heading, or the queue entry at `index`. */
type QueueRow = { type: 'heading'; key: string; label: string } | { type: 'track'; index: number };

// The virtualized queue rows plus their drag-reorder and remove-with-undo
// wiring, extracted from PlaylistSidebar so the mobile now-playing sheet can
// embed the same queue surface. PlaylistItem calls useSortable internally, so
// the Dnd contexts always wrap the list; on touch layouts the drag handle is
// hidden and reordering uses the rows' chevron buttons instead.
export const QueueList = forwardRef<QueueListHandle, QueueListProps>(function QueueList(
  { getScrollElement, scrollMargin = 0, collapsed = false, listClassName = '', touch = false, sections = false },
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

  const rows = useMemo<QueueRow[]>(() => {
    if (!sections) return playlist.map((_, index) => ({ type: 'track' as const, index }));
    const parts = queueSections(playlist, currentIndex);
    const out: QueueRow[] = [];
    const add = (key: string, label: string, indexes: number[]) => {
      if (indexes.length === 0) return;
      if (!collapsed) out.push({ type: 'heading', key, label });
      for (const index of indexes) out.push({ type: 'track', index });
    };
    if (parts.current !== null) add('current', 'Current track', [parts.current]);
    add('queued', 'Next in Queue', parts.queued);
    add('context', nextFromLabel(queueSource, parts.context.map((index) => playlist[index])), parts.context);
    add('infinity', 'Next from: Infinity', parts.infinity);
    return out;
  }, [sections, playlist, currentIndex, queueSource, collapsed]);

  // Maintain stability of item heights using estimateSize
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement,
    estimateSize: (i) => (rows[i]?.type === 'heading' ? 48 : collapsed ? 80 : touch ? 62 : sections ? 60 : 70),
    overscan: 10,
    scrollMargin,
  });

  useImperativeHandle(ref, () => ({
    // `index` is the queue entry's; in sections the rows include headings.
    scrollToIndex: (index, options) => {
      const row = rows.findIndex((entry) => entry.type === 'track' && entry.index === index);
      if (row >= 0) virtualizer.scrollToIndex(row, options);
    },
  }), [virtualizer, rows]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Queue entry IDs are unique and stay with a row when it moves, so a drag
  // animates the row itself; position-based IDs only for entries without one.
  const sortableItems = useMemo(() => playlist.map((t, idx) => t.queueEntryId || `${t.id}-${idx}`), [playlist]);
  // The rows that can be dragged, in the order they show.
  const visibleSortable = useMemo(
    () => rows.flatMap((row) => (row.type === 'track' ? [sortableItems[row.index]] : [])),
    [rows, sortableItems],
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = sortableItems.indexOf(active.id as string);
      const newIndex = sortableItems.indexOf(over.id as string);
      // In the sidebar, the track that plays stays put: a drop onto it snaps back.
      if (oldIndex !== -1 && newIndex !== -1 && (!sections || canMoveInSections(oldIndex, newIndex, currentIndex))) {
        moveInPlaylist(oldIndex, newIndex);
      }
    }
  }, [sortableItems, moveInPlaylist, sections, currentIndex]);

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
              const row = rows[virtualRow.index];
              if (!row) return null;
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
                    key={`heading-${row.key}`}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={rowStyle}
                    className="queue-section-heading"
                    role="presentation"
                  >
                    <h4>{row.label}</h4>
                  </li>
                );
              }
              const idx = row.index;
              const t = playlist[idx];
              const itemId = sortableItems[idx];

              return (
                <div
                  key={itemId}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={rowStyle}
                >
                  <PlaylistItem
                    id={itemId}
                    track={t}
                    index={idx}
                    isActive={currentIndex === idx}
                    isSidebarCollapsed={collapsed}
                    onPlay={playAtIndex}
                    onContextMenu={openRowMenu}
                    getArtistLink={getArtistLink}
                    parseArtists={parseArtists}
                    opacity={(t.isInfinity && (currentIndex === null || idx > currentIndex)) ? 0.6 : 1}
                    touch={touch}
                    // The sidebar's current track: neither dragged nor dropped onto.
                    locked={sections && currentIndex === idx}
                    queuedBy={sections && t.queuedBy ? gigPeople?.get(t.queuedBy) : undefined}
                  />
                </div>
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
});
