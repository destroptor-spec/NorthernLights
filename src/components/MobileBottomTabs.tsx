import { NavLink, useLocation } from 'react-router-dom';
import { Home, ListMusic, Mic2, Disc3, Palette } from 'lucide-react';

const TAB_CONFIG = [
  { path: '/library', label: 'Hub', icon: Home, end: true },
  { path: '/playlists', label: 'Playlists', icon: ListMusic },
  { path: '/library/artists', label: 'Artists', icon: Mic2 },
  { path: '/library/albums', label: 'Albums', icon: Disc3 },
  { path: '/library/genres', label: 'Genres', icon: Palette },
];

const getActiveTab = (path: string): string => {
  if (path === '/library' || path === '/') return '/library';
  if (path.startsWith('/library/artist')) return '/library/artists';
  if (path.startsWith('/library/album')) return '/library/albums';
  if (path.startsWith('/library/genre')) return '/library/genres';
  if (path.startsWith('/playlists')) return '/playlists';
  return '/library';
};

const MobileBottomTabs: React.FC = () => {
  const location = useLocation();
  const activeTab = getActiveTab(location.pathname);

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-[var(--glass-bg)] backdrop-blur-2xl border-t border-[var(--glass-border)] safe-area-bottom">
      <div className="flex items-center justify-around px-1 pt-1.5 pb-1">
        {TAB_CONFIG.map(tab => {
          const isActive = activeTab === tab.path;
          const Icon = tab.icon;
          return (
            <NavLink
              key={tab.path}
              to={tab.path}
              end={tab.end}
              className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg transition-colors duration-150 no-underline min-w-[52px] ${
                isActive
                  ? 'text-[var(--color-primary)]'
                  : 'text-[var(--color-text-muted)]'
              }`}
            >
              <Icon size={20} strokeWidth={isActive ? 2.2 : 1.8} />
              <span className="text-[10px] font-medium leading-none">{tab.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
};

export default MobileBottomTabs;
