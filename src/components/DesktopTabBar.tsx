import React from 'react';
import { NavLink } from 'react-router-dom';
import { Settings as SettingsIcon } from 'lucide-react';
import { usePlayerStore } from '../store/index';
import { UserMenu } from './UserMenu';
import { GlobalSearchSlot } from './GlobalSearchSlot';
import { prefetchForTabPath } from '../utils/routePrefetch';

interface DesktopTabBarProps {
  onOpenSettings: () => void;
  isScannerVisible: boolean;
  onToggleScanner: () => void;
}

const TAB_CONFIG = [
  { path: '/library', label: 'Hub', end: true },
  { path: '/playlists', label: 'Playlists' },
  { path: '/library/artists', label: 'Artists' },
  { path: '/library/albums', label: 'Albums' },
  { path: '/library/genres', label: 'Genres' },
];

// Desktop top tab bar. The NavLinks self-style via react-router's `({ isActive })`
// render-prop and subscribe to location internally, so this component needs no
// `useLocation` of its own — and it's memoized so navigation re-renders only the
// NavLinks, never the whole bar.
const DesktopTabBarInner: React.FC<DesktopTabBarProps> = ({ onOpenSettings, isScannerVisible, onToggleScanner }) => {
  const isAdmin = usePlayerStore(s => s.currentUser?.role === 'admin');
  const isScanningGlobal = usePlayerStore(s => s.isScanning);

  return (
    <div className="hidden md:flex items-center flex-none gap-3 overflow-x-auto hide-scrollbar z-20 w-full py-3 px-4 md:px-8 lg:px-12">
      {TAB_CONFIG.map(tab => (
        <NavLink
          key={tab.path}
          to={tab.path}
          end={tab.end}
          onPointerEnter={() => prefetchForTabPath(tab.path)}
          onPointerDown={() => prefetchForTabPath(tab.path)}
          onFocus={() => prefetchForTabPath(tab.path)}
          className={({ isActive }) => `
            capitalize font-semibold text-sm px-5 py-2 rounded-full
            border backdrop-blur-md whitespace-nowrap
            transition-ui duration-200 cursor-pointer
            active:scale-95 no-underline
            ${isActive ? 'btn-aurora shadow-aurora' : 'header-pill'}
          `}
        >
          {tab.label}
        </NavLink>
      ))}
      <div className="flex items-center gap-2 ml-auto">
        <GlobalSearchSlot />
        <UserMenu onOpenSettings={onOpenSettings} />
        {isAdmin && isScanningGlobal && (
          <button
            onClick={onToggleScanner}
            className="scan-indicator-btn"
            title={isScannerVisible ? 'Hide scan progress' : 'Show scan progress'}
          >
            <div className="scan-indicator-dot" />
            <span>Scanning</span>
          </button>
        )}
        <button
          onClick={onOpenSettings}
          className="header-pill w-[2.375rem] justify-center"
          title="Settings"
        >
          <SettingsIcon className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
};

export const DesktopTabBar = React.memo(DesktopTabBarInner);
export default DesktopTabBar;
