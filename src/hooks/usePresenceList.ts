import { useEffect, useReducer, useRef } from 'react';

/** How long an item takes to fold open or shut (the Connect card's devices, .presence-fold). */
export const PRESENCE_MS = 220;

export interface PresenceEntry<T> {
  item: T;
  key: string;
  /** New since the last change: folds open (`.presence-fold.is-entering`). */
  entering: boolean;
  /** Gone: keeps its place, as it was, while it folds shut (`.is-leaving`). */
  leaving: boolean;
}

interface Tracked<T> {
  item: T;
  key: string;
  enteredAt: number;
  leftAt: number;
}

/**
 * A list whose items fold open when they appear and shut when they go, as
 * the Connect card's devices do. Worked out during render, so the list never
 * shows stale items for a frame; an item that went keeps its last place and
 * data until it has folded away. The first render and big changes (more than
 * `maxAnimated` items in or out, e.g. a new album in the queue) just switch.
 */
export function usePresenceList<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  { maxAnimated = Infinity, enabled = true }: { maxAnimated?: number; enabled?: boolean } = {},
): PresenceEntry<T>[] {
  const previous = useRef<Tracked<T>[] | null>(null);
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const now = Date.now();
  const before = previous.current;

  let tracked: Tracked<T>[];
  if (!before || !enabled) {
    tracked = items.map((item) => ({ item, key: keyOf(item), enteredAt: 0, leftAt: 0 }));
  } else {
    const was = new Map(before.filter((entry) => !entry.leftAt).map((entry) => [entry.key, entry]));
    const keys = new Set(items.map(keyOf));
    const added = items.reduce((count, item) => count + (was.has(keyOf(item)) ? 0 : 1), 0);
    const removed = [...was.keys()].reduce((count, key) => count + (keys.has(key) ? 0 : 1), 0);
    const animate = added + removed <= maxAnimated;
    // Recomputing with the same items gives the same result (a re-render, or
    // StrictMode's second render): the timestamps carry over.
    const appeared = new Map(before.map((entry) => [entry.key, entry]));
    tracked = items.map((item) => {
      const key = keyOf(item);
      const prior = appeared.get(key);
      const enteredAt = prior && !prior.leftAt ? prior.enteredAt : (animate ? now : 0);
      return { item, key, enteredAt, leftAt: 0 };
    });
    if (animate) {
      // What went keeps its place while it folds away.
      before.forEach((entry, index) => {
        if (keys.has(entry.key)) return;
        const leftAt = entry.leftAt || now;
        if (now - leftAt >= PRESENCE_MS) return;
        tracked.splice(Math.min(index, tracked.length), 0, { ...entry, leftAt });
      });
    }
  }
  previous.current = tracked;

  // Once the folds are done: clear the flags and drop what went.
  // One pending timer at a time, so frequent re-renders don't keep putting it off.
  const busy = tracked.some((entry) => entry.leftAt || (entry.enteredAt && now - entry.enteredAt < PRESENCE_MS));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!busy || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      refresh();
    }, PRESENCE_MS + 20);
  });
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return tracked.map((entry) => ({
    item: entry.item,
    key: entry.key,
    entering: !entry.leftAt && entry.enteredAt > 0 && now - entry.enteredAt < PRESENCE_MS,
    leaving: entry.leftAt > 0,
  }));
}
