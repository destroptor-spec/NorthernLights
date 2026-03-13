// This hook was used for browser-native FileSystem API processing, which is now deprecated in favor of our Express Backend.
export function useLoadLibrary() {
  return { loadLibrary: () => {}, loading: false, error: null };
}
