import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { fetchAlbumStyles, fetchArtistStyles, genrePath, stylePath } from '../../api/browse';
import type { StyleProfileEntry } from '../../../shared/api/v1';

/**
 * An album's or artist's genres and styles, summarised from its tracks (an
 * artist's with each album counted once), as links to their Browse pages.
 * Shown while genre & style browse is on; nothing when there's no profile.
 */
export const StyleProfileChips: React.FC<{ kind: 'album' | 'artist'; id: string | undefined; className?: string }> = ({ kind, id, className = '' }) => {
  const enabled = usePlayerStore(s => s.newBrowseEnabled);
  const [entries, setEntries] = useState<StyleProfileEntry[]>([]);

  useEffect(() => {
    setEntries([]);
    if (!enabled || !id) return;
    let live = true;
    const auth = usePlayerStore.getState().getAuthHeader();
    (kind === 'album' ? fetchAlbumStyles(auth, id) : fetchArtistStyles(auth, id))
      .then(profile => { if (live) setEntries(profile.entries); })
      .catch(() => {});
    return () => { live = false; };
  }, [enabled, kind, id]);

  if (!enabled || entries.length === 0) return null;
  return (
    <div className={`style-profile ${className}`.trim()}>
      <span className="style-profile__label">{kind === 'album' ? 'Genres and styles' : 'Genres and styles in your library'}</span>
      <ul className="rays-chips">
        {entries.map(e => (
          <li key={`${e.genre}|${e.styleId}`}>
            <Link to={e.styleId === null ? genrePath(e.genre) : stylePath(e.styleId)} className="rays-chip">
              {e.style ?? e.genre}
              {e.share < 0.995 && <span className="rays-chip__share">{Math.round(e.share * 100)} %</span>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
};
