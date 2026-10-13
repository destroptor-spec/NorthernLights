import { usePlayerStore } from '../store/index';
import { selectDisplayedPlaying } from '../utils/sessionFollow';

/**
 * Whether the Play/Pause button shows "playing": the device this one
 * controls, when it controls one ("Play where?" → that device), else this
 * device's own playback.
 */
export function useDisplayedPlaying(): boolean {
  return usePlayerStore(selectDisplayedPlaying);
}
