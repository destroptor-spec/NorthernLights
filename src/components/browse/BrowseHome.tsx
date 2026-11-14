import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { usePlayerStore } from '../../store/index';
import { fetchBrowseGenres, genrePath, UNSORTED_PATH } from '../../api/browse';
import { AuroraCard, AuroraCardSkeleton } from './AuroraCard';
import { BrowseError, useBrowsePlayer } from './browseParts';
import type { BrowseGenre, BrowseGenres } from '../../../shared/api/v1';

const genreMeta = (genre: BrowseGenre) => {
  const tracks = `${genre.trackCount.toLocaleString()} ${genre.trackCount === 1 ? 'track' : 'tracks'}`;
  return genre.styles[0] ? `${tracks} · ${genre.styles[0].name}` : tracks;
};

/**
 * Library → Genres with genre & style browse on: Aurora's genres as cards,
 * biggest first, each with its track count and biggest style; hidden genres
 * (Non-Music) behind a toggle; Unsorted last.
 */
export const BrowseHome: React.FC = () => {
  const [data, setData] = useState<BrowseGenres | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const { busy, playFilter } = useBrowsePlayer();

  const load = useCallback(() => {
    setError(null);
    fetchBrowseGenres(usePlayerStore.getState().getAuthHeader(), true)
      .then(setData)
      .catch(() => setError('Could not load genres.'));
  }, []);
  useEffect(load, [load]);

  const visible = data?.genres.filter(g => showHidden || !g.hidden) || [];
  const hidden = data?.genres.filter(g => g.hidden) || [];

  return (
    <div className="library-home page-container browse">
      {error && <BrowseError message={error} onRetry={load} />}

      {!data && !error && (
        <div className="browse-card-grid">{Array.from({ length: 12 }).map((_, i) => <AuroraCardSkeleton key={i} />)}</div>
      )}

      {data && (
        <>
          {visible.length === 0
            ? <p className="browse-empty">No genres yet. They appear once the library has been scanned.</p>
            : (
              <div className="browse-card-grid">
                {visible.map(g => (
                  <AuroraCard
                    key={g.name}
                    name={g.name}
                    meta={genreMeta(g)}
                    to={genrePath(g.name)}
                    backLabel="Back to Genres"
                    onPlay={() => playFilter(`genre:${g.name}`, { genre: g.name })}
                    busy={busy === `genre:${g.name}`}
                  />
                ))}
              </div>
            )}

          <div className="browse-home__foot">
            {data.unsorted.trackCount > 0 && (
              <Link to={UNSORTED_PATH} state={{ backLabel: 'Back to Genres' }} className="browse-row-link">
                <span>
                  <span className="browse-row-link__title">Unsorted</span>
                  <span className="browse-row-link__meta">
                    {data.unsorted.trackCount.toLocaleString()} {data.unsorted.trackCount === 1 ? 'track' : 'tracks'} without a genre yet
                  </span>
                </span>
                <ChevronRight size={18} aria-hidden="true" />
              </Link>
            )}
            {hidden.length > 0 && (
              <button type="button" className="btn btn-ghost btn-sm" aria-pressed={showHidden} onClick={() => setShowHidden(v => !v)}>
                {showHidden ? `Hide ${hidden.map(g => g.name).join(', ')}` : `Show ${hidden.map(g => g.name).join(', ')}`}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};
