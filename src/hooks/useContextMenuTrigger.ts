import { useEffect, useMemo, useRef } from 'react';
import type React from 'react';

/** How long a finger rests on a row before its menu opens. */
export const LONG_PRESS_MS = 500;
/** A press that moves further than this is a scroll or a drag, not a long press. */
const MOVE_TOLERANCE_PX = 10;
/** The click a browser sends when the finger lifts after a long press is swallowed for this long. */
const SWALLOW_CLICK_MS = 400;

interface Press {
  pointerId: number;
  x: number;
  y: number;
  timer: number;
  opened: boolean;
}

export interface ContextMenuTriggerProps {
  'data-context-menu': true;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
  onTouchEnd: (event: React.TouchEvent<HTMLElement>) => void;
  onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
}

/**
 * Opens an item's context menu (the one its ⋯ button opens) by right-click,
 * the keyboard's menu key or Shift+F10, and a long press on touch screens.
 * Spread the result on the row or card.
 *
 * iOS never sends `contextmenu` for a long press, so a touch press runs its
 * own timer; Android does send it, and whichever comes first opens the menu
 * once. The tap that ends a long press doesn't also play the row. Right-click
 * on a link keeps the browser's own menu (open in a new tab); elements marked
 * `data-no-long-press` (drag handles) never start a long press.
 */
export function useContextMenuTrigger(open: (x: number, y: number) => void): ContextMenuTriggerProps {
  const openRef = useRef(open);
  openRef.current = open;
  const press = useRef<Press | null>(null);
  const swallowClickUntil = useRef(0);

  useEffect(() => () => {
    if (press.current) window.clearTimeout(press.current.timer);
  }, []);

  return useMemo(() => {
    const clear = () => {
      if (press.current) window.clearTimeout(press.current.timer);
      press.current = null;
    };
    const openFromPress = (current: Press) => {
      if (current.opened) return;
      current.opened = true;
      window.clearTimeout(current.timer);
      navigator.vibrate?.(10);
      openRef.current(current.x, current.y);
    };

    return {
      'data-context-menu': true,
      onContextMenu(event) {
        const current = press.current;
        if (current) {
          // Android's own long press: open once, where the finger is.
          event.preventDefault();
          openFromPress(current);
          return;
        }
        const target = event.target as Element;
        if (target.closest('a[href]')) return;
        event.preventDefault();
        let { clientX: x, clientY: y } = event;
        if (x === 0 && y === 0) {
          // From the keyboard: open by the row itself.
          const rect = event.currentTarget.getBoundingClientRect();
          x = rect.left + Math.min(rect.width / 2, 48);
          y = rect.top + rect.height / 2;
        }
        openRef.current(x, y);
      },
      onPointerDown(event) {
        if (event.pointerType !== 'touch' || !event.isPrimary) return;
        if ((event.target as Element).closest('[data-no-long-press]')) return;
        clear();
        const current: Press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, timer: 0, opened: false };
        current.timer = window.setTimeout(() => openFromPress(current), LONG_PRESS_MS);
        press.current = current;
      },
      onPointerMove(event) {
        const current = press.current;
        if (!current || current.opened || event.pointerId !== current.pointerId) return;
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > MOVE_TOLERANCE_PX) clear();
      },
      onPointerUp(event) {
        const current = press.current;
        if (!current || event.pointerId !== current.pointerId) return;
        if (current.opened) swallowClickUntil.current = Date.now() + SWALLOW_CLICK_MS;
        clear();
      },
      onPointerCancel: clear,
      onTouchEnd(event) {
        // Stops the tap a long press ends with: it would play the row, or
        // land on the menu if it opened under the finger.
        if (Date.now() < swallowClickUntil.current && event.cancelable) event.preventDefault();
      },
      onClickCapture(event) {
        if (Date.now() < swallowClickUntil.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
    };
  }, []);
}
