import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Loader2, Shuffle } from 'lucide-react';
import { usePlayerStore } from '../../store/index';
import { fetchBrowseGenre, stylePath } from '../../api/browse';
import { BackButton } from '../library/BackButton';
import { AuroraCard } from './AuroraCard';
import {
  BrowseAlbumGrid,
  BrowseArtistGrid,
  BrowseError,
  BrowseGridSkeleton,
  DecadeButtons,
  ShuffleButton,
  useBrowsePlayer,
} from './browseParts';
import type { BrowseGenreDetail } from '../../../shared/api/v1';

/** The biggest styles get tiles; every style is listed in the index below. */
const FEATURED_STYLES = 6;
/** Index rows before "Show all", so albums and artists stay in reach. */
const INDEX_PREVIEW = 18;

/**
 * One genre: its biggest styles as tiles, an index of every style (and the
 * tracks without a style), then the albums and artists most in it.
 */
export const BrowseGenrePage: React.FC = () => {
  const { genre: rawGenre = '' } = useParams<{ genre: string }>();
  const genre = decodeURIComponent(rawGenre);
  const navigate = useNavigate();
  const [detail, setDetail] = useState<BrowseGenreDetail | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const { busy, playFilter, playAlbum } = useBrowsePlayer();
  const [showAllStyles, setShowAllStyles] = useState(false);

  const load = useCallback(() => {
    setError(null);
    setDetail(null);
    fetchBrowseGenre(usePlayerStore.getState().getAuthHeader(), genre)
      .then(setDetail)
      .catch((e: { status?: number }) => setError(e?.status === 404
        ? { message: `There is no genre called “${genre}”.`, missing: true }
        : { message: 'Could not load this genre.', missing: false }));
  }, [genre]);
  useEffect(load, [load]);

  const filter = useMemo(() => ({ genre }), [genre]);
  const backLabel = `Back to ${genre}`;
  const featured = detail?.styles.slice(0, FEATURED_STYLES) || [];
  const indexed = detail?.styles.slice(FEATURED_STYLES) || [];
  const indexShown = showAllStyles ? indexed : indexed.slice(0, INDEX_PREVIEW);

  return (
    <div className="genre-detail page-container browse">
      <BackButton onClick={() => navigate(-1)} />

      {error && (error.missing
        ? <p className="browse-empty">{error.message}</p>
        : <BrowseError message={error.message} onRetry={load} />)}

      {!detail && !error && (
        <>
          <div className="h-14 md:h-20 w-2/3 max-w-lg rounded bg-[var(--color-surface-variant)] animate-pulse motion-reduce:animate-none mb-6" />
          <BrowseGridSkeleton count={6} />
        </>
      )}

      {detail && (
        <>
          <header className="browse-hero">
            <h1 className="browse-hero__title">{detail.genre.name}</h1>
            <p className="browse-hero__meta">
              {detail.genre.trackCount.toLocaleString()} tracks
              {detail.styles.length > 0 && ` · ${detail.styles.length} ${detail.styles.length === 1 ? 'style' : 'styles'}`}
            </p>
            <div className="browse-hero__actions">
              <ShuffleButton busy={busy === 'genre'} onClick={() => playFilter('genre', filter)} label={`Shuffle ${detail.genre.name}`} />
              <DecadeButtons
                decades={detail.decades}
                busyKey={busy}
                keyPrefix="decade"
                name={detail.genre.name}
                onPlay={decade => playFilter(`decade:${decade}`, { genre, decade })}
              />
            </div>
          </header>

          {featured.length > 0 && (
            <section className="browse-section" aria-label="Biggest styles">
              <h2 className="browse-section__title">Styles</h2>
              <div className="browse-card-grid">
                {featured.map(style => (
                  <AuroraCard
                    key={style.id}
                    name={style.name}
                    meta={`${style.trackCount.toLocaleString()} ${style.trackCount === 1 ? 'track' : 'tracks'}`}
                    to={stylePath(style.id)}
                    backLabel={backLabel}
                    onPlay={() => playFilter(`style:${style.id}`, { style: style.id })}
                    busy={busy === `style:${style.id}`}
                  />
                ))}
              </div>
            </section>
          )}

          {(detail.styles.length > FEATURED_STYLES || detail.noStyleTrackCount > 0) && (
            <section className="browse-section" aria-label="Every style">
              <h2 className="browse-section__title">{detail.styles.length > FEATURED_STYLES ? 'Every style' : 'Without a style'}</h2>
              <ul className="browse-index">
                {indexShown.map(style => (
                  <li key={style.id}>
                    <Link to={stylePath(style.id)} state={{ backLabel }} className="browse-index__row">
                      <span className="browse-index__name">{style.name}</span>
                      <span className="browse-index__count">{style.trackCount.toLocaleString()}</span>
                    </Link>
                  </li>
                ))}
                {detail.noStyleTrackCount > 0 && (
                  <li>
                    <button
                      type="button"
                      className="browse-index__row browse-index__row--plain"
                      onClick={() => playFilter('nostyle', { genre, noStyle: true })}
                      disabled={busy === 'nostyle'}
                      aria-label={`Shuffle ${detail.genre.name} without a specific style, ${detail.noStyleTrackCount} tracks`}
                    >
                      <span className="browse-index__name">
                        {busy === 'nostyle'
                          ? <Loader2 size={13} className="animate-spin" aria-hidden="true" />
                          : <Shuffle size={13} aria-hidden="true" />}
                        {detail.genre.name}, no specific style
                      </span>
                      <span className="browse-index__count">{detail.noStyleTrackCount.toLocaleString()}</span>
                    </button>
                  </li>
                )}
              </ul>
              {indexed.length > INDEX_PREVIEW && (
                <button type="button" className="btn btn-ghost btn-sm browse-more" aria-expanded={showAllStyles} onClick={() => setShowAllStyles(v => !v)}>
                  {showAllStyles ? 'Show fewer styles' : `Show all ${indexed.length} styles`}
                </button>
              )}
            </section>
          )}

          <BrowseAlbumGrid filter={filter} initial={detail.albums} title="Albums" backLabel={backLabel} onPlay={playAlbum} />
          <BrowseArtistGrid filter={filter} initial={detail.artists} title="Artists" backLabel={backLabel} name={detail.genre.name} />
        </>
      )}
    </div>
  );
};
