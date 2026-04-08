import React, { useRef, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { usePlayerStore } from '../store';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { parseArtists } from '../utils/artistUtils';
import { PlaylistItem } from './PlaylistItem';

export const PlaylistSidebar: React.FC = () => {
  const playlist = usePlayerStore(state => state.playlist);
  const removeFromPlaylist = usePlayerStore(state => state.removeFromPlaylist);
  const moveInPlaylist = usePlayerStore(state => state.moveInPlaylist);
  const playAtIndex = usePlayerStore(state => state.playAtIndex);
  const currentIndex = usePlayerStore(state => state.currentIndex);
  const openContextMenu = usePlayerStore(state => state.openContextMenu);
  
  const isSidebarCollapsed = usePlayerStore(state => state.isSidebarCollapsed);
  const setIsSidebarCollapsed = usePlayerStore(state => state.setIsSidebarCollapsed);

  const getArtistLink = usePlayerStore(state => (artistName: string) => {
    const entity = state.artists.find((a: any) => a.name?.toLowerCase() === artistName.toLowerCase());
    return entity ? `/library/artist/${entity.id}` : null;
  });

  const parentRef = useRef<HTMLDivElement>(null);

  // Maintain stability of item heights using estimateSize
  const virtualizer = useVirtualizer({
    count: playlist.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => isSidebarCollapsed ? 80 : 70, 
    overscan: 10,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // We map IDs to track IDs, using an index modifier to ensure duplicates don't conflict
  const sortableItems = useMemo(() => playlist.map((t, idx) => `${t.id}-${idx}`), [playlist]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const activeStr = active.id as string;
      const overStr = over.id as string;
      
      const oldIndex = sortableItems.indexOf(activeStr);
      const newIndex = sortableItems.indexOf(overStr);
      
      if (oldIndex !== -1 && newIndex !== -1) {
        moveInPlaylist(oldIndex, newIndex);
      }
    }
  }, [sortableItems,  moveInPlaylist]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    // Optionally handle any visual lock-ins or z-index updates during drag sequence manually
    // The PlaylistItem useSortable handles styling and opacity for us
  }, []);

  return (
    <>
      <div className="w-full border-r border-black/5 dark:border-white/5 flex flex-col h-full relative group/sidebar bg-white/40 dark:bg-black/20 backdrop-blur-3xl">
        <div className={`flex items-center py-3 mt-4 ${isSidebarCollapsed ? 'justify-center px-2' : 'justify-between pl-4 pr-8'}`}>
          {!isSidebarCollapsed ? (
            <>
              <h3 className="text-xs font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">Play Queue ({playlist.length})</h3>
              <button 
                onClick={() => setIsSidebarCollapsed(true)}
                className="hidden md:flex p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-all"
                title="Collapse Queue"
                aria-label="Collapse Queue"
              >
                <ChevronRight size={16} />
              </button>
            </>
          ) : (
            <button 
              onClick={() => setIsSidebarCollapsed(false)}
              className="p-2 rounded-xl bg-white/50 dark:bg-black/30 border border-black/5 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/10 text-[var(--color-primary)] transition-all shadow-sm flex items-center justify-center"
              title={`Expand Queue (${playlist.length})`}
              aria-label="Expand Queue"
            >
              <ChevronLeft size={20} />
            </button>
          )}
        </div>

        <div 
          ref={parentRef}
          className="flex-1 overflow-y-auto overflow-x-hidden hide-scrollbar"
        >
          <div className={`${isSidebarCollapsed ? 'px-2' : 'pl-4 pr-8'} py-2 space-y-1`}>
            <DndContext 
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
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
                          transform: `translateY(${virtualRow.start}px)`,
                        }}
                      >
                        <PlaylistItem
                          id={itemId}
                          track={t}
                          index={idx}
                          isActive={currentIndex === idx}
                          isSidebarCollapsed={isSidebarCollapsed}
                          totalTracks={playlist.length}
                          onPlay={playAtIndex}
                          onRemove={removeFromPlaylist}
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
        </div>
      </div>
    </>
  );
};

