import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function useIsMobile(breakpoint = 640) {
    const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint);

    useEffect(() => {
        // Not every environment has matchMedia (jsdom in tests): keep the width read at mount.
        if (typeof window.matchMedia !== 'function') return;
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

// ─── Desktop placement ───────────────────────────────────────────────────────

/** Space kept between a popover and the window's edges. */
export const MENU_EDGE_MARGIN = 16;
/** Gap between a popover and the button it hangs from. */
const ANCHOR_GAP = 8;

export interface MenuSize { width: number; height: number }

export interface MenuPlacement {
    left: number;
    top: number;
    /** Set only when the menu is taller than the window: it scrolls. */
    maxHeight?: number;
    /** Where it grows from, for the open animation: 'top left', 'bottom right'… */
    origin: string;
}

/**
 * Where a desktop popover goes so all of it is on screen, from its measured
 * size. At a point (a click or right-click) it opens down and to the right,
 * and flips up or left where there isn't room, as desktop menus do. On a
 * button it hangs below (or above), on the side with room. A menu taller than
 * the window is pinned to the top margin and scrolls.
 */
export function placeMenu({ size, viewport, point, anchor, align = 'right', placement = 'below' }: {
    size: MenuSize;
    viewport: { width: number; height: number };
    point?: { x: number; y: number };
    anchor?: { left: number; right: number; top: number; bottom: number };
    align?: 'left' | 'right';
    placement?: 'below' | 'above';
}): MenuPlacement {
    const m = MENU_EDGE_MARGIN;
    const maxLeft = Math.max(m, viewport.width - size.width - m);
    const roomy = viewport.height - 2 * m;
    const fitOrScroll = (top: number, originY: string, originX: string): MenuPlacement => (
        size.height > roomy
            ? { left: 0, top: m, maxHeight: roomy, origin: `top ${originX}` }
            : { left: 0, top: Math.min(Math.max(m, top), viewport.height - size.height - m), origin: `${originY} ${originX}` }
    );

    if (point) {
        const fitsRight = point.x + size.width <= viewport.width - m;
        const left = fitsRight ? point.x : Math.max(m, Math.min(point.x - size.width, maxLeft));
        const originX = fitsRight ? 'left' : 'right';
        const fitsBelow = point.y + size.height <= viewport.height - m;
        const fitsAbove = point.y - size.height >= m;
        const placed = fitsBelow || !fitsAbove
            ? fitOrScroll(point.y, 'top', originX)
            : fitOrScroll(point.y - size.height, 'bottom', originX);
        return { ...placed, left };
    }

    if (anchor) {
        const rawLeft = align === 'left' ? anchor.left : anchor.right - size.width;
        const left = Math.max(m, Math.min(rawLeft, maxLeft));
        const originX = align === 'left' ? 'left' : 'right';
        const below = anchor.bottom + ANCHOR_GAP;
        const above = anchor.top - ANCHOR_GAP - size.height;
        const fitsBelow = below + size.height <= viewport.height - m;
        const fitsAbove = above >= m;
        const goAbove = placement === 'above'
            ? fitsAbove || (!fitsBelow && anchor.top > viewport.height - anchor.bottom)
            : !fitsBelow && (fitsAbove || anchor.top > viewport.height - anchor.bottom);
        const placed = goAbove ? fitOrScroll(above, 'bottom', originX) : fitOrScroll(below, 'top', originX);
        return { ...placed, left };
    }

    return { left: m, top: m, origin: 'top left' };
}

/**
 * The popover's real size, measured before it paints and again whenever its
 * content changes size. `fallback` covers the first render (and test DOMs,
 * which measure 0).
 */
export function useMeasuredMenuSize(
    ref: React.RefObject<HTMLElement | null>,
    active: boolean,
    fallback: MenuSize,
): MenuSize {
    const [size, setSize] = useState<MenuSize>(fallback);
    useLayoutEffect(() => {
        if (!active) return;
        const el = ref.current;
        if (!el) return;
        const measure = () => {
            // scrollHeight is the full content height even while a cap makes it
            // scroll, but leaves out borders: add them back (offset − client).
            const width = el.offsetWidth;
            const height = el.scrollHeight + (el.offsetHeight - el.clientHeight);
            if (!width || !height) return;
            setSize(prev => (prev.width === width && prev.height === height ? prev : { width, height }));
        };
        measure();
        if (typeof ResizeObserver !== 'function') return;
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        if (el.firstElementChild) observer.observe(el.firstElementChild);
        return () => observer.disconnect();
    }, [active, ref]);
    return size;
}

/** How long closing takes: the popover fades back (as it opened), the phone's sheet slides down. */
export const POPOVER_CLOSE_MS = 150;
export const SHEET_CLOSE_MS = 300;

const prefersReducedMotion = () =>
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    /**
     * 'below' (default) hangs the menu under the anchor. 'above' attaches the
     * menu's bottom edge just above it, whatever the menu's height: for anchors
     * at the bottom of the screen, like the player bar.
     */
    placement?: 'below' | 'above';
}> = ({
    open,
    onClose,
    children,
    anchorRef,
    position,
    desktopWidth = 248,
    desktopHeight = 320,
    menuAlign = 'right',
    placement = 'below',
}) => {
    const isMobile = useIsMobile();
    const menuRef = useRef<HTMLDivElement>(null);
    const [isVisible, setIsVisible] = useState(false);
    const menuSize = useMeasuredMenuSize(menuRef, open && !isMobile, { width: desktopWidth, height: desktopHeight });
    // Re-place when the window changes size while open.
    const [, setViewportTick] = useState(0);
    useEffect(() => {
        if (!open || isMobile) return;
        const onResize = () => setViewportTick(tick => tick + 1);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [open, isMobile]);
    // Closing fades (or slides) away before it unmounts, showing what it
    // showed when it closed (lastContent), and takes no taps meanwhile.
    const lastContent = useRef<React.ReactNode>(null);
    const [, setClosed] = useState(0);
    const reduceMotion = prefersReducedMotion();

    useEffect(() => {
        if (open) {
            const frame = requestAnimationFrame(() => setIsVisible(true));
            return () => cancelAnimationFrame(frame);
        }
        setIsVisible(false);
        if (!lastContent.current) return;
        const timer = setTimeout(() => {
            lastContent.current = null;
            setClosed((count) => count + 1);
        }, prefersReducedMotion() ? 0 : isMobile ? SHEET_CLOSE_MS : POPOVER_CLOSE_MS);
        return () => clearTimeout(timer);
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- isMobile is read as it closes

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

    if (open) lastContent.current = children({ isMobile });
    if (!lastContent.current) return null;
    const content = lastContent.current;
    const blockWhileClosing: React.CSSProperties | undefined = open ? undefined : { pointerEvents: 'none' };

    if (isMobile) {
        return createPortal(
            <>
                <div
                    className="fixed inset-0 z-[9998] transition-opacity duration-200 motion-reduce:transition-none"
                    style={{
                        background: 'rgba(0,0,0,0.55)',
                        opacity: isVisible ? 1 : 0,
                        backdropFilter: 'blur(4px)',
                        WebkitBackdropFilter: 'blur(4px)',
                        ...blockWhileClosing,
                    }}
                    onClick={onClose}
                />
                <div
                    className="fixed bottom-0 left-0 right-0 z-[9999] transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none"
                    style={{ transform: isVisible ? 'translateY(0)' : 'translateY(100%)', ...blockWhileClosing }}
                >
                    <div ref={menuRef}>
                        {content}
                    </div>
                    <div className="h-[env(safe-area-inset-bottom,0px)] bg-[var(--glass-bg)] border-x border-[var(--glass-border)]" />
                </div>
            </>,
            document.body
        );
    }

    const rect = anchorRef?.current?.getBoundingClientRect();
    const placed = placeMenu({
        size: menuSize,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        point: position,
        anchor: !position && rect ? rect : undefined,
        align: menuAlign,
        placement,
    });
    const above = placed.origin.startsWith('bottom');

    return createPortal(
        <div
            ref={menuRef}
            className="fixed z-[9999]"
            style={{
                top: placed.top,
                left: placed.left,
                ...(placed.maxHeight ? { maxHeight: placed.maxHeight, overflowY: 'auto' as const } : {}),
                opacity: isVisible ? 1 : 0,
                transform: isVisible ? 'scale(1) translateY(0)' : `scale(0.95) translateY(${above ? 4 : -4}px)`,
                transition: reduceMotion ? 'none' : `opacity ${POPOVER_CLOSE_MS}ms, transform ${POPOVER_CLOSE_MS}ms`,
                transformOrigin: placed.origin,
                ...blockWhileClosing,
            }}
        >
            {content}
        </div>,
        document.body
    );
};
