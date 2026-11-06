import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { usePlayerStore } from '../../store/index';
import { fetchBrowseStyle, genrePath } from '../../api/browse';
import { BackButton } from '../library/BackButton';
import {
  BrowseAlbumGrid,
  BrowseArtistGrid,
  BrowseError,
  BrowseGridSkeleton,
  DecadeButtons,
  ShuffleButton,
  useBrowsePlayer,
} from './browseParts';
import type { BrowseStyleDetail } from '../../../shared/api/v1';

/** One style: its genre, Shuffle, decades, and the albums and artists most in it. */
export const BrowseStylePage: React.FC = () => {
  const { styleId: rawId = '' } = useParams<{ styleId: string }>();
  const styleId = Number(rawId);
  const navigate = useNavigate();
  const [detail, setDetail] = useState<BrowseStyleDetail | null>(null);
  const [error, setError] = useState<{ message: string; missing: boolean } | null>(null);
  const { busy, playFilter, playAlbum } = useBrowsePlayer();

  const load = useCallback(() => {
    setError(null);
    setDetail(null);
    if (!Number.isInteger(styleId) || styleId <= 0) { setError({ message: 'There is no such style.', missing: true }); return; }
    fetchBrowseStyle(usePlayerStore.getState().getAuthHeader(), styleId)
      .then(setDetail)
      .catch((e: { status?: number }) => setError(e?.status === 404
        ? { message: 'There is no such style.', missing: true }
        : { message: 'Could not load this style.', missing: false }));
  }, [styleId]);
  useEffect(load, [load]);

  const filter = useMemo(() => ({ style: styleId }), [styleId]);
  const style = detail?.style;
  const backLabel = style ? `Back to ${style.name}` : 'Back';

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

      {detail && style && (
        <>
          <header className="browse-hero">
            <Link to={genrePath(style.genre)} state={{ backLabel }} className="browse-hero__eyebrow">{style.genre}</Link>
            <h1 className="browse-hero__title">{style.name}</h1>
            <p className="browse-hero__meta">{style.trackCount.toLocaleString()} {style.trackCount === 1 ? 'track' : 'tracks'}</p>
            <div className="browse-hero__actions">
              <ShuffleButton busy={busy === 'style'} onClick={() => playFilter('style', filter)} label={`Shuffle ${style.name}`} />
              <DecadeButtons
                decades={detail.decades}
                busyKey={busy}
                keyPrefix="decade"
                name={style.name}
                onPlay={decade => playFilter(`decade:${decade}`, { style: styleId, decade })}
              />
            </div>
          </header>

          <BrowseAlbumGrid filter={filter} initial={detail.albums} title="Albums" backLabel={backLabel} onPlay={playAlbum} />
          <BrowseArtistGrid filter={filter} initial={detail.artists} title="Artists" backLabel={backLabel} name={style.name} />
          {detail.albums.length === 0 && detail.artists.length === 0 && (
            <p className="browse-empty">No albums in this style yet.</p>
          )}
        </>
      )}
    </div>
  );
};
