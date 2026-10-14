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
}

// The virtualized queue rows plus their drag-reorder and remove-with-undo
// wiring, extracted from PlaylistSidebar so the mobile now-playing sheet can
// embed the same queue surface. PlaylistItem calls useSortable internally, so
// the Dnd contexts always wrap the list; on touch layouts the drag handle is
// hidden and reordering uses the rows' chevron buttons instead.
export const QueueList = forwardRef<QueueListHandle, QueueListProps>(function QueueList(
  { getScrollElement, scrollMargin = 0, collapsed = false, listClassName = '' },
  ref,
) {
  const playlist = usePlayerStore(state => state.playlist);
  const currentIndex = usePlayerStore(state => state.currentIndex);
  // A tap goes to the device that plays, when this one controls it.
  const playAtIndex = usePlayerStore(state => state.playQueueEntry);
  const moveInPlaylist = usePlayerStore(state => state.moveInPlaylist);
  const removeFromPlaylist = usePlayerStore(state => state.removeFromPlaylist);
  const restoreQueueSnapshot = usePlayerStore(state => state.restoreQueueSnapshot);
  const openContextMenu = usePlayerStore(state => state.openContextMenu);
  const { addToast } = useToast();

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
    estimateSize: () => (collapsed ? 80 : 70),
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

  // We map IDs to track IDs, using an index modifier so duplicates don't conflict
  const sortableItems = useMemo(() => playlist.map((t, idx) => `${t.id}-${idx}`), [playlist]);

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

  const handleRemoveFromQueue = useCallback((index: number) => {
    const removed = playlist[index];
    if (!removed) return;

    const snapshot = playlist.map((track) => ({ ...track }));
    const snapshotIndex = currentIndex;
    removeFromPlaylist(index);
    addToast(`Removed "${removed.title || 'track'}" from queue.`, 'info', {
      actionLabel: 'Undo',
      onAction: () => restoreQueueSnapshot(snapshot, snapshotIndex),
      duration: 6500,
    });
  }, [addToast, currentIndex, playlist, removeFromPlaylist, restoreQueueSnapshot]);

  return (
    <div className={listClassName}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
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
                    onContextMenu={openContextMenu}
                    getArtistLink={getArtistLink}
                    parseArtists={parseArtists}
                    opacity={(t.isInfinity && (currentIndex === null || idx > currentIndex)) ? 0.6 : 1}
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
