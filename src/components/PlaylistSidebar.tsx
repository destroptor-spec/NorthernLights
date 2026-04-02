import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePlayerStore } from '../store';
import { Home, Library, Settings as SettingsIcon, Search as SearchIcon, X, PlusCircle, GripVertical, MoreHorizontal, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, ListMusic } from 'lucide-react';
import { parseArtists } from '../utils/artistUtils';
import { AlbumArt } from './AlbumArt';
import { formatTime } from '../utils/formatTime';

export const PlaylistSidebar: React.FC = () => {
  const [draggingIndex, setDraggingIndex] = React.useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = React.useState<number | null>(null);

  const playlist = usePlayerStore(state => state.playlist);
  const removeFromPlaylist = usePlayerStore(state => state.removeFromPlaylist);
  const moveInPlaylist = usePlayerStore(state => state.moveInPlaylist);
  const playAtIndex = usePlayerStore(state => state.playAtIndex);
  const currentIndex = usePlayerStore(state => state.currentIndex);
  const openContextMenu = usePlayerStore(state => state.openContextMenu);
  const isSidebarCollapsed = usePlayerStore(state => state.isSidebarCollapsed);
  const setIsSidebarCollapsed = usePlayerStore(state => state.setIsSidebarCollapsed);

  // Build artist name -> ID lookup from entity list
  const artists = usePlayerStore(state => state.artists);
  const getArtistLink = (artistName: string): string | null => {
    const entity = artists.find((a: any) => a.name?.toLowerCase() === artistName.toLowerCase());
    return entity ? `/library/artist/${entity.id}` : null;
  };

  const handleDragStart = (e: React.DragEvent<HTMLLIElement>, index: number) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
    setTimeout(() => setDraggingIndex(index), 0);
  };

  const handleDragEnd = () => {
    setDraggingIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnter = (e: React.DragEvent<HTMLLIElement>, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent<HTMLLIElement>, toIndex: number) => {
    e.preventDefault();
    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
    if (!isNaN(fromIndex) && fromIndex !== toIndex) {
      moveInPlaylist(fromIndex, toIndex);
    }
    setDraggingIndex(null);
    setDragOverIndex(null);
  };

  const handleDelete = (index: number) => {
    removeFromPlaylist(index);
  };

  return (
    <>
      <div className="w-full border-r border-[var(--glass-border)] flex flex-col h-full relative group/sidebar">
            <div className={`flex items-center py-3 mt-4 ${isSidebarCollapsed ? 'justify-center px-2' : 'justify-between pl-4 pr-8'}`}>
              {!isSidebarCollapsed ? (
                <>
                  <h3 className="text-xs font-bold text-[var(--color-text-secondary)] uppercase tracking-wider">Play Queue ({playlist.length})</h3>
                  <button 
                    onClick={() => setIsSidebarCollapsed(true)}
                    className="hidden md:flex p-1.5 rounded-lg hover:bg-[var(--glass-bg-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-all"
                    title="Collapse Queue"
                  >
                    <ChevronRight size={16} />
                  </button>
                </>
              ) : (
                <button 
                  onClick={() => setIsSidebarCollapsed(false)}
                  className="p-2 rounded-xl bg-[var(--glass-bg)] border border-[var(--glass-border)] hover:bg-[var(--glass-bg-hover)] text-[var(--color-primary)] transition-all shadow-sm flex items-center justify-center"
                  title={`Expand Queue (${playlist.length})`}
                >
                  <ChevronLeft size={20} />
                </button>
              )}
            </div>
            <div className="flex-1 overflow-y-auto overflow-x-hidden hide-scrollbar">
              <div className={`${isSidebarCollapsed ? 'px-2' : 'pl-4 pr-8'} py-2 space-y-1`}>
            <ul className="playlist-list">
              {playlist.map((t, idx) => (
                <li
                  key={t.id + idx}
                  draggable
                  onDragStart={(e) => handleDragStart(e, idx)}
                  onDragEnd={handleDragEnd}
                  onDragEnter={(e) => handleDragEnter(e, idx)}
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(e, idx)}
                  onClick={() => playAtIndex(idx)}
                  className={`playlist-item group ${currentIndex === idx ? 'active' : ''} ${draggingIndex === idx ? 'dragging' : ''} ${isSidebarCollapsed ? 'justify-center p-2' : ''}`}
                  style={{
                    opacity: draggingIndex === idx ? 0.35 : (t.isInfinity && (currentIndex === null || idx > currentIndex)) ? 0.6 : 1,
                    transition: 'opacity 0.15s ease, border-color 0.1s ease',
                    borderTop: dragOverIndex === idx && draggingIndex !== idx
                      ? '2px solid var(--color-primary)'
                      : '2px solid transparent',
                    boxShadow: dragOverIndex === idx && draggingIndex !== idx
                      ? '0 -1px 0 0 var(--color-primary)'
                      : 'none',
                  }}
                >
                  {/* Drag handle — desktop only */}
                  {!isSidebarCollapsed && (
                    <span
                      className="shrink-0 cursor-grab active:cursor-grabbing text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 pl-1 pr-0.5 select-none hidden md:inline-flex"
                      style={{ fontSize: '1rem', lineHeight: 1 }}
                      title="Drag to reorder"
                    >
                      <GripVertical size={14} />
                    </span>
                  )}

                  {/* Mobile reorder arrows */}
                  {!isSidebarCollapsed && (
                    <span className="shrink-0 flex flex-col md:hidden text-[var(--color-text-muted)]">
                      <button
                        aria-label="Move up"
                        onClick={(e) => { e.stopPropagation(); if (idx > 0) moveInPlaylist(idx, idx - 1); }}
                        className="leading-none p-0.5 hover:text-[var(--color-text-primary)] active:scale-90 transition-transform disabled:opacity-20"
                        disabled={idx === 0}
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        aria-label="Move down"
                        onClick={(e) => { e.stopPropagation(); if (idx < playlist.length - 1) moveInPlaylist(idx, idx + 1); }}
                        className="leading-none p-0.5 hover:text-[var(--color-text-primary)] active:scale-90 transition-transform disabled:opacity-20"
                        disabled={idx === playlist.length - 1}
                      >
                        <ChevronDown size={14} />
                      </button>
                    </span>
                  )}

                  <AlbumArt
                    artUrl={t.artUrl}
                    artist={t.artist}
                    size={isSidebarCollapsed ? 56 : 48}
                    className={`playlist-item-art ${isSidebarCollapsed ? 'm-0' : ''}`}
                  />

                  {!isSidebarCollapsed && (
                    <>
                      <div className="playlist-item-info">
                        <div className="playlist-item-title">{t.title ?? t.path.split(/[\\\/]/).pop()}</div>
                        {t.artist && (
                          <div className="playlist-item-artist">
                            {parseArtists(t.artist).map((a, i) => {
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
                        {t.duration !== undefined && <div className="playlist-item-duration">{formatTime(t.duration)}</div>}
                      </div>
                      
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          aria-label="More options"
                          onClick={(e) => {
                            e.stopPropagation();
                            openContextMenu(t, e.clientX, e.clientY);
                          }}
                          className="player-control-btn hover:text-[var(--color-primary)]"
                          style={{ width: 28, height: 28, padding: 0, background: 'transparent', border: 'none', color: 'var(--color-text-muted)' }}
                        >
                          <MoreHorizontal size={16} />
                        </button>
                        <button
                          aria-label={`Remove track ${t.title ?? t.path}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(idx);
                          }}
                          className="player-control-btn hover:text-red-400"
                          style={{ width: 28, height: 28, padding: 0, fontSize: '0.8rem', background: 'transparent', border: 'none', color: 'var(--color-text-muted)' }}
                        >
                          ✕
                        </button>
                      </div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </>
  );
};
