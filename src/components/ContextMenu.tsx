import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function useIsMobile(breakpoint = 640) {
    const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint);

    useEffect(() => {
        const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
        const handler = (event: MediaQueryListEvent) => setIsMobile(event.matches);
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [breakpoint]);

    return isMobile;
}

export const ContextMenuDivider: React.FC = () => (
    <div className="h-px bg-[var(--glass-border)] my-1.5 mx-3" />
);

export const ContextMenuFrame = React.forwardRef<HTMLDivElement, {
    children: React.ReactNode;
    isMobile?: boolean;
    widthClassName?: string;
    className?: string;
}>(({ children, isMobile = false, widthClassName = 'w-[248px]', className = '' }, ref) => (
    <div
        ref={ref}
        className={`relative overflow-hidden bg-[var(--glass-bg)] backdrop-blur-3xl border border-[var(--glass-border)] rounded-2xl shadow-2xl ${isMobile ? 'w-full rounded-b-none' : widthClassName} ${className}`}
        onContextMenu={(event) => event.preventDefault()}
    >
        {children}
    </div>
));

ContextMenuFrame.displayName = 'ContextMenuFrame';

export const ContextMenuHeader: React.FC<{
    title: React.ReactNode;
    subtitle?: React.ReactNode;
}> = ({ title, subtitle }) => (
    <div className="px-4 py-3 border-b border-[var(--glass-border)]">
        <div className="text-sm font-semibold text-[var(--color-text-primary)] truncate">
            {title}
        </div>
        {subtitle && (
            <div className="text-xs text-[var(--color-text-muted)] truncate mt-0.5">
                {subtitle}
            </div>
        )}
    </div>
);

export const ContextMenuList: React.FC<{
    children: React.ReactNode;
    className?: string;
}> = ({ children, className = '' }) => (
    <div className={`py-1.5 ${className}`}>
        {children}
    </div>
);

export const ContextMenuButton: React.FC<{
    icon: React.ReactNode;
    label: React.ReactNode;
    onClick: () => void;
    trailingIcon?: React.ReactNode;
    danger?: boolean;
}> = ({ icon, label, onClick, trailingIcon, danger }) => (
    <button
        onClick={onClick}
        className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors active:bg-white/10 ${
            danger
                ? 'text-rose-500 hover:bg-rose-500/10'
                : 'text-[var(--color-text-primary)] hover:bg-white/5'
        }`}
    >
        <span className={`flex-shrink-0 ${danger ? 'text-rose-500' : 'text-[var(--color-text-secondary)]'}`}>
            {icon}
        </span>
        <span className="flex-1 text-left truncate">{label}</span>
        {trailingIcon && (
            <span className="text-[var(--color-text-muted)] flex-shrink-0">{trailingIcon}</span>
        )}
    </button>
);

export const ContextMenuLink: React.FC<{
    href: string;
    icon: React.ReactNode;
    label: React.ReactNode;
    secondary?: React.ReactNode;
    onClick?: () => void;
}> = ({ href, icon, label, secondary, onClick }) => (
    <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        role="menuitem"
        onClick={onClick}
        className={`flex w-full gap-3 px-4 py-2.5 text-sm text-[var(--color-text-primary)] transition-colors hover:bg-white/5 focus:bg-white/5 focus:outline-none active:bg-white/10 motion-reduce:transition-none ${secondary ? 'items-start' : 'items-center'}`}
    >
        <span className={`flex-shrink-0 text-[var(--color-text-secondary)] ${secondary ? 'mt-0.5' : ''}`}>{icon}</span>
        <span className="min-w-0 flex-1 text-left">
            <span className="block truncate">{label}</span>
            {secondary && (
                <span className="mt-0.5 block truncate text-xs text-[var(--color-text-muted)]">
                    {secondary}
                </span>
            )}
        </span>
    </a>
);

export const ContextMenuPortal: React.FC<{
    open: boolean;
    onClose: () => void;
    children: (context: { isMobile: boolean }) => React.ReactNode;
    anchorRef?: React.RefObject<HTMLElement | null>;
    position?: { x: number; y: number };
    desktopWidth?: number;
    desktopHeight?: number;
    /**
     * How to align the popover horizontally against `anchorRef`:
     * - 'right' (default): menu's right edge = anchor's right edge.
     *   Best when the anchor sits in the top-right corner.
     * - 'left': menu's left edge = anchor's left edge. Best when the
     *   anchor is one of several adjacent icon buttons in a row, so the
     *   menu hangs directly below its own button instead of stretching
     *   across siblings to its left.
     */
    menuAlign?: 'left' | 'right';
}> = ({
    open,
    onClose,
    children,
    anchorRef,
    position,
    desktopWidth = 248,
    desktopHeight = 320,
    menuAlign = 'right',
}) => {
    const isMobile = useIsMobile();
    const menuRef = useRef<HTMLDivElement>(null);
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        if (open) requestAnimationFrame(() => setIsVisible(true));
        else setIsVisible(false);
    }, [open]);

    useEffect(() => {
        if (!open) return;

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') onClose();
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [open, onClose]);

    useEffect(() => {
        if (!open || isMobile) return;

        const handlePointerDown = (event: MouseEvent | TouchEvent) => {
            const target = event.target as Node;
            if (menuRef.current?.contains(target)) return;
            if (anchorRef?.current?.contains(target)) return;
            onClose();
        };

        document.addEventListener('mousedown', handlePointerDown);
        document.addEventListener('touchstart', handlePointerDown);

        return () => {
            document.removeEventListener('mousedown', handlePointerDown);
            document.removeEventListener('touchstart', handlePointerDown);
        };
    }, [anchorRef, isMobile, onClose, open]);

    if (!open) return null;

    if (isMobile) {
        return createPortal(
            <>
                <div
                    className="fixed inset-0 z-[9998] transition-opacity duration-200"
                    style={{
                        background: 'rgba(0,0,0,0.55)',
                        opacity: isVisible ? 1 : 0,
                        backdropFilter: 'blur(4px)',
                        WebkitBackdropFilter: 'blur(4px)',
                    }}
                    onClick={onClose}
                />
                <div
                    className="fixed bottom-0 left-0 right-0 z-[9999] transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
                    style={{ transform: isVisible ? 'translateY(0)' : 'translateY(100%)' }}
                >
                    <div ref={menuRef}>
                        {children({ isMobile })}
                    </div>
                    <div className="h-[env(safe-area-inset-bottom,0px)] bg-[var(--glass-bg)] border-x border-[var(--glass-border)]" />
                </div>
            </>,
            document.body
        );
    }

    const rect = anchorRef?.current?.getBoundingClientRect();
    const rectAlignedX = rect
        ? (menuAlign === 'left' ? rect.left : rect.right - desktopWidth)
        : 16;
    const rawX = position?.x ?? rectAlignedX;
    const rawY = position?.y ?? (rect ? rect.bottom + 8 : 16);
    const left = Math.max(16, Math.min(rawX, window.innerWidth - desktopWidth - 16));
    const top = Math.max(16, Math.min(rawY, window.innerHeight - desktopHeight - 16));

    return createPortal(
        <div
            ref={menuRef}
            className="fixed z-[9999]"
            style={{
                top,
                left,
                opacity: isVisible ? 1 : 0,
                transform: isVisible ? 'scale(1) translateY(0)' : 'scale(0.95) translateY(-4px)',
                transition: 'opacity 0.15s, transform 0.15s',
                transformOrigin: 'top left',
            }}
        >
            {children({ isMobile })}
        </div>,
        document.body
    );
};
