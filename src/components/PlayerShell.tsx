import React, { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import PlayerControls from './PlayerControls';
import { usePlayerPlacement } from '../hooks/usePlayerPlacement';

/**
 * Wraps PlayerControls in the floating / docked chrome and renders the
 * top-edge bend toggle. The placement choice is persisted via the
 * usePlayerPlacement hook.
 */
const PlayerShellInner: React.FC = () => {
  const [placement, , togglePlacement] = usePlayerPlacement();
  const [edgeHover, setEdgeHover] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const shownPlacement = useRef(placement);

  // The layout switches in one step; the bar then settles into its new place
  // with a composited slide (the 20px float gap) and fade, which also hides
  // the width change. `translate` composes with the float's centring transform.
  useLayoutEffect(() => {
    if (shownPlacement.current === placement) return;
    shownPlacement.current = placement;
    const shell = shellRef.current;
    if (!shell?.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
    shell.animate(
      [{ translate: `0 ${placement === 'dock' ? -20 : 20}px`, opacity: 0.4 }, { translate: '0 0', opacity: 1 }],
      { duration: 240, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    );
  }, [placement]);

  const handleEdgeEnter = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    setEdgeHover(true);
  };
  const handleEdgeLeave = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setEdgeHover(false), 120);
  };

  React.useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  const Chevron = placement === 'float' ? ChevronDown : ChevronUp;
  const tooltip = placement === 'float' ? 'Dock player' : 'Float player';

  return (
    <div
      ref={shellRef}
      className={`player-shell player-shell--${placement} ${edgeHover ? 'is-edge-hover' : ''}`}
      data-placement={placement}
    >
      {/* Top-edge hit region — invisible, intercepts pointer for the bend toggle */}
      <div
        className="player-shell-edge"
        onPointerEnter={handleEdgeEnter}
        onPointerLeave={handleEdgeLeave}
        aria-hidden="true"
      />

      {/* Chevron tab — visually "bends" out of the top edge on hover */}
      <button
        type="button"
        className="player-shell-bend"
        onPointerEnter={handleEdgeEnter}
        onPointerLeave={handleEdgeLeave}
        onClick={() => {
          togglePlacement();
          setEdgeHover(false);
        }}
        onFocus={handleEdgeEnter}
        onBlur={handleEdgeLeave}
        aria-label={tooltip}
        title={tooltip}
      >
        <Chevron size={14} strokeWidth={2} />
      </button>

      <div className="player-shell-inner">
        <PlayerControls />
      </div>
    </div>
  );
};

// Memoized so it doesn't reconcile (and re-render PlayerControls) on every
// navigation — App re-renders on each route change but passes no props here.
export const PlayerShell = React.memo(PlayerShellInner);

export default PlayerShell;
