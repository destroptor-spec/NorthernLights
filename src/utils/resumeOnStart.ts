// "Pick up where you left off" on a cold start (PlaybackManager
// .restoreFromContinuitySnapshot), with "Sync playback across devices" on:
// resume only when no other device plays the session now. Prod 2026-10-14
// 20:01:13: the phone, closed while playing, resumed on reopening and took
// playback from the desktop that had started playing meanwhile.

export async function shouldResumeOnStart(deps: {
  syncOn: boolean;
  /** Resolves once the session has been read (bounded by the caller). */
  sessionRead: () => Promise<void>;
  anotherDevicePlaying: () => boolean;
  log?: (resume: boolean) => void;
}): Promise<boolean> {
  if (!deps.syncOn) return true;
  await deps.sessionRead();
  const resume = !deps.anotherDevicePlaying();
  deps.log?.(resume);
  return resume;
}
