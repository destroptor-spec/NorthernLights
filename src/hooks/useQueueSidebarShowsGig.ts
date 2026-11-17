import { useEffect, useState } from 'react';
import { usePlayerStore } from '../store';

const DESKTOP = '(min-width: 768px)';

function matchesDesktop(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DESKTOP).matches;
}

/**
 * Whether the desktop queue sidebar shows the gig (Start Gig, then its
 * controls): on desktop with the sidebar expanded. The Connect card leaves its
 * own copy out then; on phones, or with the sidebar collapsed, the gig stays
 * in Connect. False where there is no matchMedia (tests).
 */
export function useQueueSidebarShowsGig(): boolean {
  const collapsed = usePlayerStore((state) => state.isSidebarCollapsed);
  const [desktop, setDesktop] = useState(matchesDesktop);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DESKTOP);
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return desktop && !collapsed;
}
