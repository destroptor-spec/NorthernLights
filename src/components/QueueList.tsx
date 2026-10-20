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
}

// The virtualized queue rows plus their drag-reorder and remove-with-undo
// wiring, extracted from PlaylistSidebar so the mobile now-playing sheet can
// embed the same queue surface. PlaylistItem calls useSortable internally, so
// the Dnd contexts always wrap the list; on touch layouts the drag handle is
// hidden and reordering uses the rows' chevron buttons instead.
export const QueueList = forwardRef<QueueListHandle, QueueListProps>(function QueueList(
  { getScrollElement, scrollMargin = 0, collapsed = false, listClassName = '', touch = false },
  ref,
) {
  const playlist = usePlayerStore(state => state.playlist);
  const currentIndex = usePlayerStore(state => state.currentIndex);
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

  // Maintain stability of item heights using estimateSize
  const virtualizer = useVirtualizer({
    count: playlist.length,
    getScrollElement,
    estimateSize: () => (collapsed ? 80 : touch ? 62 : 70),
    overscan: 10,
    scrollMargin,
  });

  useImperativeHandle(ref, () => ({
    scrollToIndex: (index, options) => virtualizer.scrollToIndex(index, options),
  }), [virtualizer]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Queue entry IDs are unique and stay with a row when it moves, so a drag
  // animates the row itself; position-based IDs only for entries without one.
  const sortableItems = useMemo(() => playlist.map((t, idx) => t.queueEntryId || `${t.id}-${idx}`), [playlist]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = sortableItems.indexOf(active.id as string);
      const newIndex = sortableItems.indexOf(over.id as string);
      if (oldIndex !== -1 && newIndex !== -1) {
        moveInPlaylist(oldIndex, newIndex);
      }
    }
  }, [sortableItems, moveInPlaylist]);

  const handleRemoveFromQueue = useRemoveFromQueueWithUndo();

  return (
    <div className={listClassName}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[verticalOnly]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={sortableItems}
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
              const idx = virtualRow.index;
              const t = playlist[idx];
              const itemId = sortableItems[idx];

              return (
                <div
                  key={itemId}
                  data-index={idx}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    // With an external scroller, row offsets include the
                    // list's scrollMargin — subtract it to position within
                    // the list itself.
                    transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                  }}
                >
                  <PlaylistItem
                    id={itemId}
                    track={t}
                    index={idx}
                    isActive={currentIndex === idx}
                    isSidebarCollapsed={collapsed}
                    totalTracks={playlist.length}
                    onPlay={playAtIndex}
                    onRemove={handleRemoveFromQueue}
                    onMove={moveInPlaylist}
                    onContextMenu={openRowMenu}
                    getArtistLink={getArtistLink}
                    parseArtists={parseArtists}
                    opacity={(t.isInfinity && (currentIndex === null || idx > currentIndex)) ? 0.6 : 1}
                    touch={touch}
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
