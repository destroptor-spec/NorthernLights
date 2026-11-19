import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../store/index';
import { LogOut, ChevronDown, Settings, Download, Moon, X } from 'lucide-react';
import { useSleepTimerRemaining } from '../hooks/useSleepTimerRemaining';
import { SleepTimerModal } from './SleepTimerModal';
import { ownAvatar, UserAvatar } from './UserAvatar';
import { usePWAInstall } from '../hooks/usePWAInstall';

interface UserMenuProps {
  onOpenSettings?: () => void;
}

export const UserMenu: React.FC<UserMenuProps> = ({ onOpenSettings }) => {
  const currentUser = usePlayerStore(state => state.currentUser);
  const clearAuthToken = usePlayerStore(state => state.clearAuthToken);
  const { canInstall, isInstalled, platform, install } = usePWAInstall();
  const [isOpen, setIsOpen] = useState(false);
  // The sleep timer lives here: set in a modal, its countdown in the menu.
  const [sleepModalOpen, setSleepModalOpen] = useState(false);
  const sleep = useSleepTimerRemaining();
  const cancelSleepTimer = usePlayerStore(state => state.cancelSleepTimer);
  const [buttonRect, setButtonRect] = useState<DOMRect | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      if (buttonRef.current) {
        setButtonRect(buttonRef.current.getBoundingClientRect());
      }
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  if (!currentUser) return null;

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 h-9 rounded-full bg-[var(--color-surface)] border border-[var(--glass-border)] hover:bg-[var(--color-surface-hover)] transition-ui text-sm"
      >
        <UserAvatar avatar={ownAvatar(currentUser)} size="xs" />
        <span className="text-[var(--color-text-primary)] font-medium hidden md:inline">{currentUser.username}</span>
        <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
      </button>

      {isOpen && buttonRect && createPortal(
        <div
          ref={dropdownRef}
          className="fixed w-56 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-xl shadow-2xl backdrop-blur-xl overflow-hidden z-[9999]"
          style={{ top: buttonRect.bottom + 8, right: window.innerWidth - buttonRect.right }}
        >
          <div className="p-3 border-b border-[var(--glass-border)]">
            <p className="font-semibold text-[var(--color-text-primary)] text-sm">{currentUser.username}</p>
            <p className="text-xs text-[var(--color-text-muted)] capitalize">{currentUser.role}</p>
          </div>

          {onOpenSettings && (
            <button
              onClick={() => { onOpenSettings(); setIsOpen(false); }}
              className="md:hidden w-full px-4 py-2.5 text-left text-sm text-[var(--color-text-secondary)] hover:bg-white/[0.06] transition-colors flex items-center gap-2"
            >
              <Settings className="w-4 h-4" /> Settings
            </button>
          )}

          {canInstall && !isInstalled && (
            <button
              onClick={() => {
                if (platform === 'native-prompt') {
                  install();
                  setIsOpen(false);
                } else {
                  // iOS — show instructions in a simple alert
                  alert(
                    'To install NorthernLights:\n\n' +
                    '1. Tap the Share button (square with arrow)\n' +
                    '2. Scroll down and tap "Add to Home Screen"\n' +
                    '3. Tap "Add"'
                  );
                  setIsOpen(false);
                }
              }}
              className="w-full px-4 py-2.5 text-left text-sm text-[var(--color-text-secondary)] hover:bg-white/[0.06] transition-colors flex items-center gap-2"
            >
              <Download className="w-4 h-4" /> Install App
            </button>
          )}

          {/* Sleep timer: one at a time. While it runs, its countdown and a cancel. */}
          {sleep.active ? (
            <div className="w-full pl-4 pr-2 py-1.5 text-sm text-[var(--color-text-secondary)] flex items-center gap-2">
              <Moon className="w-4 h-4 shrink-0 text-[var(--color-primary)]" />
              <span className="flex-1 min-w-0 truncate">Sleep timer</span>
              <span className="tabular-nums text-[var(--color-text-primary)]" aria-label={`Sleep timer: ${sleep.label} left`} role="timer">{sleep.label}</span>
              <button
                type="button"
                onClick={() => cancelSleepTimer()}
                aria-label="Cancel sleep timer"
                title="Cancel sleep timer"
                className="p-1.5 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-white/[0.06] transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => { setSleepModalOpen(true); setIsOpen(false); }}
              className="w-full px-4 py-2.5 text-left text-sm text-[var(--color-text-secondary)] hover:bg-white/[0.06] transition-colors flex items-center gap-2"
            >
              <Moon className="w-4 h-4" /> Sleep timer
            </button>
          )}

          <button
            onClick={() => { clearAuthToken(); setIsOpen(false); }}
            className="w-full px-4 py-2.5 text-left text-sm text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-2"
          >
            <LogOut className="w-4 h-4" /> Sign Out
          </button>
        </div>,
        document.body
      )}
      {sleepModalOpen && !sleep.active && <SleepTimerModal onClose={() => setSleepModalOpen(false)} />}
    </div>
  );
};
