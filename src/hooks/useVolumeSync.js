import { usePlayerStore } from '../store/index';
// The store now calls playbackManager.setVolume() synchronously when setVolume is called.
// If any other component needs to react to volume changes without setting it,
// they can simply use `usePlayerStore(state => state.volume)` directly.
// We keep this hook mainly to maintain backward compatibility or trigger side-effects if needed,
// but it doesn't need to manually sync to an audioRef anymore.
export const useVolumeSync = () => {
    const volume = usePlayerStore((state) => state.volume);
    // Custom side-effects (e.g., logging or UI things) could go here.
};
