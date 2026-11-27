import React from 'react';
import { Play } from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { usePlayerStore } from '../store';
import { BackButton } from './library/BackButton';

export const genreHeadingClass = 'font-bold text-4xl md:text-5xl lg:text-7xl tracking-tight mb-4 md:mb-6 text-[var(--color-primary)] drop-shadow-md';

export function GenreLoading() {
  const { genreId } = useParams();
  const name = usePlayerStore(s => s.genres.find(g => g.id === genreId)?.name);
  const navigate = useNavigate();
  return <div className="genre-detail page-container relative">
    <BackButton onClick={() => navigate(-1)} />
    <h1 className={genreHeadingClass}>{name || <span className="block w-48 rounded bg-[var(--color-surface-variant)]">&nbsp;</span>}</h1>
    <h3 className="font-semibold text-xl tracking-wide text-[var(--color-text-secondary)] mb-4 md:mb-6 border-b border-[var(--glass-border)] pb-2">Albums in this Genre</h3>
    <div className="album-grid" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => <div key={i}>
        <div className="aspect-square rounded-2xl mb-3 bg-[var(--color-surface-variant)]" />
        <div className="h-4 w-3/4 rounded bg-[var(--color-surface-variant)]" />
      </div>)}
    </div>
  </div>;
}

export function RaysLoading() {
  const { trackId } = useParams();
  const { state }: { state: { trackId?: string; title?: string; artist?: string; album?: string; year?: number; artUrl?: string } | null } = useLocation();
  const hero = state?.trackId === trackId ? state : undefined;
  const navigate = useNavigate();
  return <div className="genre-detail page-container browse rays relative">
    <div className="relative z-10">
      <BackButton onClick={() => navigate(-1)} />
      <header className="rays-hero">
        <div className="rays-hero__art">
          <div className="rays-hero__cover bg-[var(--color-surface-variant)]">
            {hero?.artUrl && <img src={hero.artUrl} alt="" className="h-full w-full object-cover" />}
          </div>
        </div>
        <div className="rays-hero__text">
          {hero?.title ? <h1 className="rays-title"><span className="rays-title__lead">Aurora rays from </span>{hero.title}</h1> : <div aria-hidden="true" className="h-16 w-56 max-w-full rounded bg-[var(--color-surface-variant)]" />}
          <p className="rays-hero__meta min-h-6">
            <span>{hero?.artist}</span>
            {hero?.album && <><span aria-hidden="true">·</span><span>{hero.album}</span></>}
            {hero?.year && <><span aria-hidden="true">·</span><span>{hero.year}</span></>}
          </p>
          <div className="browse-hero__actions" aria-hidden="true"><span className="btn btn-primary invisible"><Play size={16} />Play</span></div>
        </div>
      </header>
    </div>
  </div>;
}
