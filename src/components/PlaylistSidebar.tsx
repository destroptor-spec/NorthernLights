import React, { useRef, useCallback, useState } from 'react';
import { saveQueueAsPlaylist } from '../utils/saveQueueAsPlaylist';
import { usePlayerStore } from '../store';
import { ChevronLeft, ChevronRight, ListPlus, ListX, Loader2 } from 'lucide-react';
import { QueueList, useClearQueueWithUndo } from './QueueList';
import { PromptModal } from './PromptModal';
import { useToast } from '../hooks/useToast';

function getDefaultQueuePlaylistName(): string {
  return `Queue ${new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date())}`;
}

const PlaylistSidebarInner: React.FC = () => {
  const playlist = usePlayerStore(state => state.playlist);
  const getAuthHeader = usePlayerStore(state => state.getAuthHeader);
  const fetchPlaylistsFromServer = usePlayerStore(state => state.fetchPlaylistsFromServer);
  const { addToast } = useToast();
  const [isSavePromptOpen, setIsSavePromptOpen] = useState(false);
  const [isSavingQueue, setIsSavingQueue] = useState(false);

  const isSidebarCollapsed = usePlayerStore(state => state.isSidebarCollapsed);
  const setIsSidebarCollapsed = usePlayerStore(state => state.setIsSidebarCollapsed);

  const parentRef = useRef<HTMLDivElement>(null);

  const handleClearQueue = useClearQueueWithUndo();

  const handleSaveQueue = useCallback(async (title: string) => {
    if (!playlist.some((track) => track.id)) {
      setIsSavePromptOpen(false);
      addToast('Queue is empty.', 'error');
      return;
    }

    setIsSavingQueue(true);
    try {
      await saveQueueAsPlaylist(title, playlist.map((track) => track.id), getAuthHeader());
      await fetchPlaylistsFromServer();
      setIsSavePromptOpen(false);
      addToast(`Saved "${title}" to playlists.`, 'success');
    } catch (error: any) {
      console.error('Failed to save queue as playlist', error);
      addToast(error?.message || 'Failed to save queue as playlist.', 'error');
    } finally {
      setIsSavingQueue(false);
    }
  }, [addToast, fetchPlaylistsFromServer, getAuthHeader, playlist]);

  return (
    <>
      <div className="w-full border-r border-black/5 dark:border-white/5 flex flex-col h-full relative group/sidebar bg-white/40 dark:bg-black/20 backdrop-blur-3xl">
        <div className={`flex items-center py-3 mt-4 ${isSidebarCollapsed ? 'justify-center px-2' : 'justify-between pl-4 pr-8'}`}>
          {!isSidebarCollapsed ? (
            <>
              <h3 className="text-xs font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">Play Queue ({playlist.length})</h3>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setIsSavePromptOpen(true)}
                  disabled={playlist.length === 0 || isSavingQueue}
                  className="btn btn-ghost btn-sm px-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Save queue as playlist"
                  aria-label="Save queue as playlist"
                >
                  {isSavingQueue ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ListPlus size={16} />
                  )}
                  <span className="hidden xl:inline">Save</span>
                </button>
                <button
                  onClick={handleClearQueue}
                  disabled={playlist.length === 0}
                  className="btn btn-ghost btn-sm px-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Clear queue"
                  aria-label="Clear queue"
                >
                  <ListX size={16} />
                  <span className="hidden xl:inline">Clear</span>
                </button>
                <button 
                  onClick={() => setIsSidebarCollapsed(true)}
                  className="hidden md:flex p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-ui"
                  title="Collapse Queue"
                  aria-label="Collapse Queue"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </>
          ) : (
            <button 
              onClick={() => setIsSidebarCollapsed(false)}
              className="p-2 rounded-xl bg-white/50 dark:bg-black/30 border border-black/5 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/10 text-[var(--color-primary)] transition-ui shadow-sm flex items-center justify-center"
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
          <QueueList
            getScrollElement={() => parentRef.current}
            collapsed={isSidebarCollapsed}
            listClassName={`${isSidebarCollapsed ? 'px-2' : 'pl-4 pr-8'} py-2`}
          />
        </div>
      </div>
      {isSavePromptOpen && (
        <PromptModal
          title="Save Queue"
          label={`${playlist.length} ${playlist.length === 1 ? 'track' : 'tracks'} will be saved as a new playlist.`}
          placeholder="Playlist name"
          defaultValue={getDefaultQueuePlaylistName()}
          onSubmit={handleSaveQueue}
          onCancel={() => {
            if (!isSavingQueue) setIsSavePromptOpen(false);
          }}
        />
      )}
    </>
  );
};

// Always mounted (mobile bottom-sheet / desktop right panel). Navigation never
// changes its data, so memoize it to stop the whole queue list reconciling on
// every tab tap — it re-renders only when its own store selectors change.
export const PlaylistSidebar = React.memo(PlaylistSidebarInner);
