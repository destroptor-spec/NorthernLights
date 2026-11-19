import { useEffect, useState } from 'react';
import { usePlayerStore } from '../store/index';

/** "12:05", or "1:02:05" from an hour up. */
export function formatSleepRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** The running sleep timer, ticking once a second while it runs. */
export function useSleepTimerRemaining(): { active: boolean; remainingMs: number; label: string } {
  const endsAt = usePlayerStore((state) => state.sleepTimerEndsAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!endsAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [endsAt]);
  const remainingMs = endsAt ? Math.max(0, endsAt - now) : 0;
  return { active: !!endsAt, remainingMs, label: formatSleepRemaining(remainingMs) };
}
