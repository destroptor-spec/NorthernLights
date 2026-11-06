import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { genreAurora } from '../library/GenreCard';

/**
 * A genre or style in Browse: a 3:2 card filled with its own aurora (the
 * brand palette, the same signature per name everywhere), the name in the
 * display font, and one line of metadata under it. No hover effects; focus
 * shows the ring.
 */
export const AuroraCard: React.FC<{ name: string; meta: string; to: string; backLabel: string }> = ({ name, meta, to, backLabel }) => {
  const aurora = useMemo(() => genreAurora(name), [name]);
  return (
    <Link to={to} state={{ backLabel }} className="browse-card" style={aurora}>
      <span className="browse-card__title">{name}</span>
      <span className="browse-card__meta">{meta}</span>
    </Link>
  );
};

export const AuroraCardSkeleton: React.FC = () => (
  <div className="browse-card browse-card--skeleton animate-pulse motion-reduce:animate-none" aria-hidden="true" />
);
