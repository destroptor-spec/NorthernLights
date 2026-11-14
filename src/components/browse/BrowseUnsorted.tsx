import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Shuffle } from 'lucide-react';
import { usePlayerStore } from '../../store/index';
import { fetchBrowseUnsorted } from '../../api/browse';
import { BackButton } from '../library/BackButton';
import { BrowseError, useBrowsePlayer } from './browseParts';
import { DisputedTags } from './DisputedTags';
import type { BrowseUnsorted as Unsorted } from '../../../shared/api/v1';

/**
 * Tracks without a genre: their genre tags match no genre or style, and
 * neither their sound nor their artist's tags were clear enough. They stay
 * playable; an admin can map a tag in Settings → Library Entities → Genres.
 * Admins also review disputed tags here (DisputedTags).
 */
export const BrowseUnsorted: React.FC = () => {
  const navigate = useNavigate();
  const isAdmin = usePlayerStore(s => s.currentUser?.role === 'admin');
  const [data, setData] = useState<Unsorted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, playFilter } = useBrowsePlayer();

  const load = useCallback(() => {
    setError(null);
    fetchBrowseUnsorted(usePlayerStore.getState().getAuthHeader())
      .then(setData)
      .catch(() => setError('Could not load unsorted tracks.'));
  }, []);
  useEffect(load, [load]);

  const total = data ? data.tags.reduce((n, t) => n + t.trackCount, 0) + data.untaggedTrackCount : 0;

  return (
    <div className="genre-detail page-container browse">
      <BackButton onClick={() => navigate(-1)} />
      <header className="browse-hero">
        <h1 className="browse-hero__title">Unsorted</h1>
        <p className="browse-hero__lede">
          Tracks Aurora hasn't placed in a genre yet. Their genre tags don't match a genre or style, and their sound
          and artist tags weren't clear enough to decide.
          {isAdmin && ' Map a tag in Settings → Library Entities → Genres to sort its tracks.'}
        </p>
      </header>

      {error && <BrowseError message={error} onRetry={load} />}
      {!data && !error && <div className="h-40 rounded-xl bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none" aria-hidden="true" />}

      {data && (total === 0
        ? <p className="browse-empty">Every track has a genre.</p>
        : (
          <ul className="browse-index browse-index--single">
            {data.tags.map(t => {
              const key = `tag:${t.tag}`;
              return (
                <li key={t.tag}>
                  <button
                    type="button"
                    className="browse-index__row browse-index__row--plain"
                    onClick={() => playFilter(key, { unsorted: true, tag: t.tag })}
                    disabled={busy === key}
                    aria-label={`Shuffle tracks tagged ${t.tag}, ${t.trackCount} tracks`}
                  >
                    <span className="browse-index__name">
                      {busy === key ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Shuffle size={13} aria-hidden="true" />}
                      {t.tag}
                    </span>
                    <span className="browse-index__count">{t.trackCount.toLocaleString()}</span>
                  </button>
                </li>
              );
            })}
            {data.untaggedTrackCount > 0 && (
              <li>
                <button
                  type="button"
                  className="browse-index__row browse-index__row--plain"
                  onClick={() => playFilter('untagged', { unsorted: true })}
                  disabled={busy === 'untagged'}
                  aria-label={`Shuffle every unsorted track, ${total} tracks, ${data.untaggedTrackCount} of them without a genre tag`}
                >
                  <span className="browse-index__name">
                    {busy === 'untagged' ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Shuffle size={13} aria-hidden="true" />}
                    All unsorted, including {data.untaggedTrackCount.toLocaleString()} without a genre tag
                  </span>
                  <span className="browse-index__count">{total.toLocaleString()}</span>
                </button>
              </li>
            )}
          </ul>
        ))}

      {isAdmin && <DisputedTags />}
    </div>
  );
};
