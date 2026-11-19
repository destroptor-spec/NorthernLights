import React, { useCallback, useRef, useState } from 'react';
import { usePlayerStore } from '../store/index';
import { LogOut, ChevronDown, Settings, Download, Moon, X } from 'lucide-react';
import { ownAvatar, UserAvatar } from './UserAvatar';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { useSleepTimerRemaining } from '../hooks/useSleepTimerRemaining';
import { SleepTimerModal } from './SleepTimerModal';
import {
  ContextMenuButton,
  ContextMenuDivider,
  ContextMenuFrame,
  ContextMenuHeader,
  ContextMenuList,
  ContextMenuPortal,
} from './ContextMenu';

interface UserMenuProps {
  onOpenSettings?: () => void;
}

/**
 * The user's menu in the header: the same pill as the row's other items
 * (.header-pill), and a menu in the context menus' design (frame, header,
 * rows; a sheet on phones). Settings (phones), Install, the sleep timer and
 * Sign out.
 */
export const UserMenu: React.FC<UserMenuProps> = ({ onOpenSettings }) => {
  const currentUser = usePlayerStore(state => state.currentUser);
  const clearAuthToken = usePlayerStore(state => state.clearAuthToken);
  const { canInstall, isInstalled, platform, install } = usePWAInstall();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // The sleep timer lives here: set in a modal, its countdown in the menu.
  const [sleepModalOpen, setSleepModalOpen] = useState(false);
  const sleep = useSleepTimerRemaining();
  const cancelSleepTimer = usePlayerStore(state => state.cancelSleepTimer);
  const close = useCallback(() => setIsOpen(false), []);

  if (!currentUser) return null;

  const installApp = () => {
    if (platform === 'native-prompt') {
      install();
    } else {
      // iOS — show instructions in a simple alert
      alert(
        'To install NorthernLights:\n\n' +
        '1. Tap the Share button (square with arrow)\n' +
        '2. Scroll down and tap "Add to Home Screen"\n' +
        '3. Tap "Add"'
      );
    }
    close();
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(open => !open)}
        className="header-pill gap-2 px-3"
        aria-haspopup="menu"
        aria-expanded={isOpen}
      >
        <UserAvatar avatar={ownAvatar(currentUser)} size="xs" />
        <span className="font-medium hidden md:inline">{currentUser.username}</span>
        <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
      </button>

      <ContextMenuPortal
        open={isOpen}
        onClose={close}
        anchorRef={buttonRef}
        menuAlign="right"
        desktopWidth={240}
        desktopHeight={220}
      >
        {({ isMobile }) => (
          <ContextMenuFrame isMobile={isMobile} widthClassName="w-60">
            <ContextMenuHeader title={currentUser.username} subtitle={<span className="capitalize">{currentUser.role}</span>} />
            <ContextMenuList>
              {onOpenSettings && (
                <div className="md:hidden">
                  <ContextMenuButton
                    icon={<Settings size={15} />}
                    label="Settings"
                    onClick={() => { onOpenSettings(); close(); }}
                  />
                </div>
              )}

              {canInstall && !isInstalled && (
                <ContextMenuButton icon={<Download size={15} />} label="Install App" onClick={installApp} />
              )}

              {/* Sleep timer: one at a time. While it runs, its countdown and a cancel. */}
              {sleep.active ? (
                <div className="w-full flex items-center gap-3 pl-4 pr-2 py-1.5 text-sm text-[var(--color-text-primary)]">
                  <span className="flex-shrink-0 text-[var(--color-primary)]"><Moon size={15} /></span>
                  <span className="flex-1 min-w-0 truncate">Sleep timer</span>
                  <span className="tabular-nums" role="timer" aria-label={`Sleep timer: ${sleep.label} left`}>{sleep.label}</span>
                  <button
                    type="button"
                    onClick={() => cancelSleepTimer()}
                    aria-label="Cancel sleep timer"
                    title="Cancel sleep timer"
                    className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-white/5 transition-colors"
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <ContextMenuButton
                  icon={<Moon size={15} />}
                  label="Sleep timer"
                  onClick={() => { setSleepModalOpen(true); close(); }}
                />
              )}

              <ContextMenuDivider />
              <ContextMenuButton
                icon={<LogOut size={15} />}
                label="Sign Out"
                onClick={() => { clearAuthToken(); close(); }}
                danger
              />
            </ContextMenuList>
          </ContextMenuFrame>
        )}
      </ContextMenuPortal>
      {sleepModalOpen && !sleep.active && <SleepTimerModal onClose={() => setSleepModalOpen(false)} />}
    </div>
  );
};
