import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { usePlayerStore } from '../../store/index';
import { fetchBrowseGenres, genrePath, UNSORTED_PATH } from '../../api/browse';
import { GenreCard } from '../library/GenreCard';
import { BrowseError, BrowseSearch } from './browseParts';
import type { BrowseGenre, BrowseGenres } from '../../../shared/api/v1';

const GenreTileSkeleton: React.FC = () => (
  <div className="flex flex-col gap-2.5 animate-pulse motion-reduce:animate-none" aria-hidden="true">
    <div className="aspect-square w-full rounded-[var(--radius)] bg-[var(--color-surface-variant)]" />
    <div className="h-4 w-2/3 rounded bg-[var(--color-surface-variant)]" />
    <div className="h-3 w-5/6 rounded bg-[var(--color-surface-variant)]" />
  </div>
);

const GenreTile: React.FC<{ genre: BrowseGenre }> = ({ genre }) => (
  <Link to={genrePath(genre.name)} state={{ backLabel: 'Back to Genres' }} className="no-underline">
    <GenreCard
      genre={genre.name}
      meta={(
        <>
          <span className="genre-card__count">{genre.trackCount.toLocaleString()} tracks</span>
          {genre.styles.length > 0 && <span className="genre-card__styles">{genre.styles.map(s => s.name).join(' · ')}</span>}
        </>
      )}
    />
  </Link>
);

/**
 * Library → Genres with genre & style browse on: Aurora's genres as tiles,
 * biggest first, each with its 3 biggest styles; search for any genre or
 * style; hidden genres (Non-Music) behind a toggle; Unsorted last.
 */
export const BrowseHome: React.FC = () => {
  const [data, setData] = useState<BrowseGenres | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

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
      <div className="browse-home__head">
        <BrowseSearch />
      </div>

      {error && <BrowseError message={error} onRetry={load} />}

      {!data && !error && (
        <div className="genre-grid">{Array.from({ length: 12 }).map((_, i) => <GenreTileSkeleton key={i} />)}</div>
      )}

      {data && (
        <>
          {visible.length === 0
            ? <p className="browse-empty">No genres yet. They appear once the library has been scanned.</p>
            : <div className="genre-grid">{visible.map(g => <GenreTile key={g.name} genre={g} />)}</div>}

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
