import React, { useRef, useCallback, useState } from 'react';
import { saveQueueAsPlaylist } from '../utils/saveQueueAsPlaylist';
import { usePlayerStore } from '../store';
import { ChevronLeft, History, ListMusic } from 'lucide-react';
import { QueueList, useClearQueueWithUndo } from './QueueList';
import { PromptModal } from './PromptModal';
import { QueueSidebarHeader } from './QueueSidebarHeader';
import { RecentlyPlayedList } from './RecentlyPlayedList';
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
  const getScrollElement = useCallback(() => parentRef.current, []);
  // The tabs at the bottom: the queue, or the user's recently played tracks.
  const [tab, setTab] = useState<'queue' | 'recent'>('queue');
  const showRecent = tab === 'recent' && !isSidebarCollapsed;
  const chooseTab = (next: 'queue' | 'recent') => {
    if (next === tab) return;
    setTab(next);
    parentRef.current?.scrollTo({ top: 0 });
  };

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
      <div className="queue-sidebar w-full border-r border-black/5 dark:border-white/5 flex flex-col h-full relative bg-white/40 dark:bg-black/20 backdrop-blur-3xl">
        {isSidebarCollapsed ? (
          <div className="flex items-center justify-center px-2 py-3 mt-4">
            <button
              onClick={() => setIsSidebarCollapsed(false)}
              className="p-2 rounded-xl bg-white/50 dark:bg-black/30 border border-black/5 dark:border-white/5 hover:bg-black/5 dark:hover:bg-white/10 text-[var(--color-primary)] transition-ui shadow-sm flex items-center justify-center"
              title={`Expand Queue (${playlist.length})`}
              aria-label="Expand Queue"
            >
              <ChevronLeft size={20} />
            </button>
          </div>
        ) : (
          <QueueSidebarHeader
            onSave={() => setIsSavePromptOpen(true)}
            saving={isSavingQueue}
            onClear={handleClearQueue}
            onCollapse={() => setIsSidebarCollapsed(true)}
          />
        )}

        <div
          ref={parentRef}
          className="flex-1 overflow-y-auto overflow-x-hidden hide-scrollbar"
        >
          {showRecent ? (
            <RecentlyPlayedList active getScrollElement={getScrollElement} />
          ) : (
            <QueueList
              getScrollElement={getScrollElement}
              collapsed={isSidebarCollapsed}
              sections
              listClassName={`${isSidebarCollapsed ? 'px-2' : 'px-3'} pt-1 pb-4`}
            />
          )}
        </div>

        {!isSidebarCollapsed && (
          <div className="queue-tabs" role="tablist" aria-label="Queue or recently played">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'queue'}
              className="queue-tab"
              onClick={() => chooseTab('queue')}
            >
              <ListMusic size={15} aria-hidden="true" />
              Queue
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'recent'}
              className="queue-tab"
              onClick={() => chooseTab('recent')}
            >
              <History size={15} aria-hidden="true" />
              Recently played
            </button>
          </div>
        )}
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
