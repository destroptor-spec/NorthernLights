import React, { useCallback, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, MoreHorizontal } from 'lucide-react';
import { usePlayerStore } from '../store';
import { useRecentlyPlayed } from '../hooks/useRecentlyPlayed';
import { useContextMenuTrigger } from '../hooks/useContextMenuTrigger';
import { useKnownArtistKeys } from '../hooks/useKnownArtistKeys';
import { parseArtistsForDisplay } from '../utils/artistUtils';
import { AlbumArt } from './AlbumArt';
import type { TrackInfo } from '../utils/fileSystem';

const RecentRow: React.FC<{
  track: TrackInfo;
  index: number;
  onPlay: (index: number) => void;
  onMenu: (track: TrackInfo, x: number, y: number) => void;
  artists: string[];
  artistLink: (name: string) => string | null;
}> = ({ track, index, onPlay, onMenu, artists, artistLink }) => {
  const title = track.title ?? track.path.split(/[\\/]/).pop();
  const menuTrigger = useContextMenuTrigger((x, y) => onMenu(track, x, y));
  return (
    <li
      className="queue-row group"
      {...menuTrigger}
      onClick={() => onPlay(index)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPlay(index);
        }
      }}
    >
      <span className="queue-row-art">
        <AlbumArt artUrl={track.artUrl} artist={track.artist} className="h-full w-full" />
      </span>
      <div className="queue-row-text">
        <div className="queue-row-title">{title}</div>
        {artists.length > 0 && (
          <div className="queue-row-artist">
            {artists.map((name, i) => {
              const link = artistLink(name);
              return (
                <React.Fragment key={name}>
                  {i > 0 && ', '}
                  {link ? (
                    <Link to={link} onClick={(e) => e.stopPropagation()} className="queue-row-artist-link">{name}</Link>
                  ) : (
                    <span>{name}</span>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label={`More options for ${title}`}
        className="queue-row-more"
        onClick={(e) => {
          e.stopPropagation();
          onMenu(track, e.clientX, e.clientY);
        }}
      >
        <MoreHorizontal size={16} />
      </button>
    </li>
  );
};

/**
 * The sidebar's Recently played tab: the user's plays on every device, newest
 * first, each track once. The next page loads as its end scrolls into view.
 * A tap plays the list from that track; ⋯ or right-click is the track menu.
 */
export const RecentlyPlayedList: React.FC<{
  active: boolean;
  getScrollElement: () => HTMLElement | null;
}> = ({ active, getScrollElement }) => {
  const { tracks, loading, failed, loaded, hasMore, loadMore, retry } = useRecentlyPlayed(active);
  const setPlaylist = usePlayerStore((state) => state.setPlaylist);
  const openContextMenu = usePlayerStore((state) => state.openContextMenu);
  const knownArtistKeys = useKnownArtistKeys();
  const artistLink = usePlayerStore((state) => (name: string) => {
    const entity = state.artists.find((a: { name?: string }) => a.name?.toLowerCase() === name.toLowerCase());
    return entity ? `/library/artist/${entity.id}` : null;
  });
  const endRef = useRef<HTMLDivElement>(null);

  const play = useCallback((index: number) => { void setPlaylist(tracks, index); }, [setPlaylist, tracks]);
  const menu = useCallback((track: TrackInfo, x: number, y: number) => openContextMenu(track, x, y), [openContextMenu]);

  // The next page, once the end of the list comes near.
  useEffect(() => {
    const end = endRef.current;
    if (!active || !end || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadMore(); },
      { root: getScrollElement(), rootMargin: '300px' },
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, [active, hasMore, loadMore, getScrollElement, tracks.length]);

  if (!active) return null;

  return (
    <div className="px-3 pt-3 pb-4">
      {loaded && tracks.length === 0 && !failed && (
        <p className="queue-empty">Nothing played yet.</p>
      )}
      {tracks.length > 0 && (
        <ul className="list-none p-0 m-0" aria-label="Recently played">
          {tracks.map((track, index) => (
            <RecentRow
              key={`${track.id}-${index}`}
              track={track}
              index={index}
              onPlay={play}
              onMenu={menu}
              artists={track.artist ? parseArtistsForDisplay(track.artist, knownArtistKeys) : []}
              artistLink={artistLink}
            />
          ))}
        </ul>
      )}
      {failed && (
        <p className="queue-empty">
          Couldn't load your recently played tracks.{' '}
          <button type="button" className="queue-empty-retry" onClick={retry}>Try again</button>
        </p>
      )}
      {loading && (
        <div className="flex justify-center py-3 text-[var(--color-text-muted)]" aria-hidden="true">
          <Loader2 size={16} className="animate-spin" />
        </div>
      )}
      <div ref={endRef} aria-hidden="true" />
    </div>
  );
};
