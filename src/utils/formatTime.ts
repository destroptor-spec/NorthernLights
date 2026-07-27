export const formatTime = (seconds: number | undefined | null, fallback = '0:00'): string => {
  if (seconds === undefined || seconds === null || !isFinite(seconds) || seconds < 0) return fallback;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

/**
 * Formats a total duration in seconds as a human-readable string, e.g.
 * "1h 5m" or "47 min". Used for album/artist/playlist running totals.
 */
export const formatDuration = (totalSeconds: number): string => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes} min`;
};
