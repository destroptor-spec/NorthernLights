import React from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Play } from 'lucide-react';

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
 * it. Play works like the Hub cards: on devices with hover it rises in on
 * hover or keyboard focus; on touch there is none, and a tap opens the page
 * (Shuffle is there). The button sits beside the link, never inside it.
 */
export const AuroraCard: React.FC<{
  name: string; meta: string; to: string; backLabel: string;
  onPlay?: () => void; busy?: boolean;
}> = ({ name, meta, to, backLabel, onPlay, busy = false }) => (
  <div className="browse-card-wrap" data-busy={busy ? 'true' : undefined}>
    <Link to={to} state={{ backLabel }} className="browse-card" style={{ background: coverGradientFor(name) }}>
      <span className="browse-card__title">{name}</span>
      <span className="browse-card__meta">{meta}</span>
    </Link>
    {onPlay && (
      <button
        type="button"
        className="btn-fab browse-card__play"
        onClick={onPlay}
        disabled={busy}
        aria-label={`Shuffle ${name}`}
      >
        {busy
          ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          : <Play className="w-4 h-4 ml-0.5" fill="currentColor" aria-hidden="true" />}
      </button>
    )}
  </div>
);

export const AuroraCardSkeleton: React.FC = () => (
  <div className="browse-card browse-card--skeleton animate-pulse motion-reduce:animate-none" aria-hidden="true" />
);
