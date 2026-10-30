import { usePlayerStore } from '../store/index';
import { selectDisplayedVolume, selectRemoteTarget, selectRemoteVolumeTarget } from '../utils/sessionFollow';
import { useGuestMay } from './useGuestMay';

/**
 * The volume slider: the device this one controls, when it controls one
 * (`remote`), else this device's own. `locked` (disabled, no text): a guest
 * below Playback Control, or a controlled device that reports no volume.
 */
export function useDisplayedVolume(): { volume: number; remote: boolean; locked: boolean } {
  const volume = usePlayerStore(selectDisplayedVolume);
  const remote = usePlayerStore((state) => !!selectRemoteVolumeTarget(state));
  const remoteWithoutVolume = usePlayerStore((state) => !!selectRemoteTarget(state) && !selectRemoteVolumeTarget(state));
  const mayTransport = useGuestMay('transport');
  return { volume, remote, locked: !mayTransport || remoteWithoutVolume };
}
