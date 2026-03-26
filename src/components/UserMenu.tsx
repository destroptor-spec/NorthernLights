import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { usePlayerStore } from '../store/index';
import { User, LogOut, ChevronDown } from 'lucide-react';

export const UserMenu: React.FC = () => {
  const currentUser = usePlayerStore(state => state.currentUser);
  const clearAuthToken = usePlayerStore(state => state.clearAuthToken);
  const [isOpen, setIsOpen] = useState(false);
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
        className="flex items-center gap-2 px-3 py-2 rounded-full bg-[var(--color-surface)] border border-[var(--glass-border)] hover:bg-[var(--color-surface-hover)] transition-all text-sm"
      >
        <div className="w-6 h-6 rounded-full bg-[var(--color-primary)]/20 text-[var(--color-primary)] flex items-center justify-center">
          <User className="w-3.5 h-3.5" />
        </div>
        <span className="text-[var(--color-text-primary)] font-medium hidden md:inline">{currentUser.username}</span>
        <ChevronDown className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
      </button>

      {isOpen && buttonRect && createPortal(
        <div
          ref={dropdownRef}
          className="fixed w-48 bg-[var(--glass-bg)] border border-[var(--glass-border)] rounded-xl shadow-2xl backdrop-blur-xl overflow-hidden z-[9999]"
          style={{ top: buttonRect.bottom + 8, right: window.innerWidth - buttonRect.right }}
        >
          <div className="p-3 border-b border-[var(--glass-border)]">
            <p className="font-semibold text-[var(--color-text-primary)] text-sm">{currentUser.username}</p>
            <p className="text-xs text-[var(--color-text-muted)] capitalize">{currentUser.role}</p>
          </div>

          <button
            onClick={() => { clearAuthToken(); setIsOpen(false); }}
            className="w-full px-4 py-2.5 text-left text-sm text-red-400 hover:bg-red-500/10 transition-colors flex items-center gap-2"
          >
            <LogOut className="w-4 h-4" /> Sign Out
          </button>
        </div>,
        document.body
      )}
    </div>
  );
};
