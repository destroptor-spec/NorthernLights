import { usePlayerStore } from '../store/index';
import { isFollowedOutputPlaying } from '../utils/sessionFollow';

/**
 * The device playing the user's session while this one follows it ("Playing
 * on NAD Forstærker"), or null. Only while it plays: a paused session simply
 * shows its track here.
 */
export function useFollowedDeviceName(): string | null {
  return usePlayerStore((s) => (isFollowedOutputPlaying(s.sessionFollow) ? s.sessionFollow!.name : null));
}
