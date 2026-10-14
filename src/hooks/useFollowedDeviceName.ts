import { usePlayerStore } from '../store/index';
import { isFollowedOutputPlaying } from '../utils/sessionFollow';

/**
 * The device playing the user's session while this one follows it ("NAD
 * Forstærker"), or null. Shown whether it plays or is paused, since the line
 * is also the chip that chooses where actions go.
 */
export function useFollowedDeviceName(): string | null {
  return usePlayerStore((s) => s.sessionFollow?.name ?? null);
}

/** "Playing on NAD Forstærker" or "Paused on NAD Forstærker", or null. */
export function useFollowedDeviceLabel(): string | null {
  return usePlayerStore((s) => {
    const follow = s.sessionFollow;
    if (!follow) return null;
    if (follow.silent) return `${follow.name} isn't responding`;
    return `${isFollowedOutputPlaying(follow) ? 'Playing' : 'Paused'} on ${follow.name}`;
  });
}
