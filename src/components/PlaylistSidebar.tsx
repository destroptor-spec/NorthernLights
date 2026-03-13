import React, { useState } from 'react';
import { usePlayerStore } from '../store/index';
import { extractMetadata } from '../utils/fileSystem';
import { parseArtists } from '../utils/artistUtils';
import { SettingsModal } from './SettingsModal';
import { AlbumArt } from './AlbumArt';

const formatTime = (seconds?: number): string => {
  if (seconds === undefined || !isFinite(seconds) || seconds < 0) return '';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export const PlaylistSidebar: React.FC = () => {
  const [draggingIndex, setDraggingIndex] = React.useState<number | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const handleDragStart = (e: React.DragEvent<HTMLLIElement>, index: number) => {
    e.dataTransfer.setData('text/plain', index.toString());
    setDraggingIndex(index);
  };
  const handleDragEnd = () => {
    setDraggingIndex(null);
  };
  const handleDragOver = (e: React.DragEvent<HTMLUListElement>) => {
    e.preventDefault();
  };
  const handleDrop = (e: React.DragEvent<HTMLUListElement>) => {
    const fromIndexStr = e.dataTransfer.getData('text/plain');
    if (!fromIndexStr) return;
    const toIndex = Array.from(e.currentTarget.children).indexOf(e.target as HTMLElement);
    if (toIndex >= 0) {
      moveInPlaylist(parseInt(fromIndexStr), toIndex);
    }
    setDraggingIndex(null);
  };

  const playlist = usePlayerStore(state => state.playlist);
  const removeFromPlaylist = usePlayerStore(state => state.removeFromPlaylist);
  const moveInPlaylist = usePlayerStore(state => state.moveInPlaylist);
  const playAtIndex = usePlayerStore(state => state.playAtIndex);
  const currentIndex = usePlayerStore(state => state.currentIndex);
  const navigateView = usePlayerStore(state => state.navigateView);

  const handleDelete = (index: number, title?: string) => {
    if (window.confirm(`Remove track ${title ?? 'Unknown'} from playlist?`)) {
      removeFromPlaylist(index);
    }
  };

  return (
    <>
      <aside className="playlist-sidebar">
        <div className="playlist-header">
          <span>Play Queue ({playlist.length})</span>
          <button
            className="icon-btn"
            onClick={() => setIsSettingsOpen(true)}
            title="Library Settings"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
        </div>
        <ul
          className="playlist-list"
          data-dragging-index={draggingIndex ?? undefined}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {playlist.map((t, idx) => (
            <li
              key={t.id + idx}
              className={`playlist-item ${currentIndex === idx ? 'active' : ''} ${draggingIndex === idx ? 'dragging' : ''}`}
              draggable
              onDragStart={(e) => handleDragStart(e, idx)}
              onDragEnd={handleDragEnd}
              onDoubleClick={() => playAtIndex(idx)}
            >
              <AlbumArt
                artUrl={t.artUrl}
                artist={t.artist}
                size={48}
                className="playlist-item-art"
              />
              <div className="playlist-item-info">
                <div className="playlist-item-title">{t.title ?? t.path.split(/[\\/]/).pop()}</div>
                {t.artist && (
                  <div className="playlist-item-artist">
                    {parseArtists(t.artist).map((a, i) => (
                      <React.Fragment key={a}>
                        {i > 0 && ', '}
                        <span
                          className="hover:text-[var(--color-primary)] cursor-pointer transition-colors"
                          onClick={(e) => { e.stopPropagation(); navigateView('artist', a); }}
                        >{a}</span>
                      </React.Fragment>
                    ))}
                  </div>
                )}
                {t.duration !== undefined && <div className="playlist-item-duration">{formatTime(t.duration)}</div>}
              </div>
              <button
                aria-label={`Remove track ${t.title ?? t.path}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(idx, t.title);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    handleDelete(idx, t.title);
                  }
                }}
                className="player-control-btn"
                style={{ width: 28, height: 28, padding: 0, fontSize: '0.8rem', background: 'transparent', border: 'none', color: 'var(--color-text-muted)' }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {isSettingsOpen && (
        <SettingsModal onClose={() => setIsSettingsOpen(false)} />
      )}
    </>
  );
};
