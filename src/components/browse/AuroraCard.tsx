import React from 'react';
import { Link } from 'react-router-dom';

/**
 * The Hub's cover gradients (index.css: Daylist's times of day, On repeat,
 * Rewind, Wrapped). Theme-stable like all cover art, so a card looks the same
 * in light and dark.
 */
export const COVER_GRADIENTS = [
  '--gradient-daylist-late-night',
  '--gradient-daylist-morning',
  '--gradient-daylist-midday',
  '--gradient-daylist-evening',
  '--gradient-daylist-night',
  '--gradient-cover-on-repeat',
  '--gradient-cover-rewind',
  '--gradient-cover-wrapped',
] as const;

/** The same gradient for a name on every page and every visit. */
export function coverGradientFor(name: string): string {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
  return `var(${COVER_GRADIENTS[h % COVER_GRADIENTS.length]})`;
}

/**
 * A genre or style in Browse: a 3:2 card in one of the Hub's cover
 * gradients, the name in the display font and one line of metadata under
 * it. No hover effects; focus shows the ring.
 */
export const AuroraCard: React.FC<{ name: string; meta: string; to: string; backLabel: string }> = ({ name, meta, to, backLabel }) => (
  <Link to={to} state={{ backLabel }} className="browse-card" style={{ background: coverGradientFor(name) }}>
    <span className="browse-card__title">{name}</span>
    <span className="browse-card__meta">{meta}</span>
  </Link>
);

export const AuroraCardSkeleton: React.FC = () => (
  <div className="browse-card browse-card--skeleton animate-pulse motion-reduce:animate-none" aria-hidden="true" />
);
