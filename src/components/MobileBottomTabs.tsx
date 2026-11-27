import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { Home, ListMusic, Mic2, Disc3, Palette } from 'lucide-react';
import { prefetchForTabPath } from '../utils/routePrefetch';
import { getActiveTab } from '../utils/tabRouting';

const TAB_CONFIG = [
  { path: '/library', label: 'Hub', icon: Home, end: true },
  { path: '/playlists', label: 'Playlists', icon: ListMusic },
  { path: '/library/artists', label: 'Artists', icon: Mic2 },
  { path: '/library/albums', label: 'Albums', icon: Disc3 },
  { path: '/library/genres', label: 'Genres', icon: Palette },
];

const MobileBottomTabs: React.FC = () => {
  const location = useLocation();
  const activeTab = getActiveTab(location.pathname);

  // React Router v7 wraps navigation in startTransition, so `location` (and
  // thus `activeTab`) doesn't update until the destination route's render has
  // fully committed — 1-2s on mobile for the heavier library pages. That left
  // the tap with no visual acknowledgement ("did I hit the button?"). Track the
  // just-tapped tab locally and highlight it immediately, independent of the
  // lagging router location; drop the override once location catches up.
  const [pendingTab, setPendingTab] = useState<string | null>(null);
  const displayTab = pendingTab ?? activeTab;

  useEffect(() => {
    if (pendingTab && activeTab === pendingTab) setPendingTab(null);
  }, [activeTab, pendingTab]);

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-[var(--glass-bg)] backdrop-blur-2xl border-t border-[var(--glass-border)] safe-area-bottom">
      <div className="flex items-center justify-around px-1 pt-1.5 pb-1">
        {TAB_CONFIG.map(tab => {
          const isActive = displayTab === tab.path;
          const Icon = tab.icon;
          return (
            <NavLink
              key={tab.path}
              to={tab.path}
              end={tab.end}
              onPointerEnter={() => prefetchForTabPath(tab.path)}
              onPointerDown={() => prefetchForTabPath(tab.path)}
              onClick={() => setPendingTab(tab.path)}
              onFocus={() => prefetchForTabPath(tab.path)}
              className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg transition-colors duration-150 no-underline min-w-[52px] ${
                isActive
                  ? 'text-[var(--color-primary)]'
                  : 'text-[var(--color-text-muted)]'
              }`}
            >
              <Icon size={20} strokeWidth={isActive ? 2.2 : 1.8} />
              <span className="text-[11px] font-medium leading-none">{tab.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
};

export default MobileBottomTabs;
