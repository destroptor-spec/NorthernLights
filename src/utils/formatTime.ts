export const formatTime = (seconds: number | undefined | null, fallback = '0:00'): string => {
  if (seconds === undefined || seconds === null || !isFinite(seconds) || seconds < 0) return fallback;
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};
