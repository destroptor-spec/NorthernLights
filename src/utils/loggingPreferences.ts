export function resolveLoggingPreferences(saved: {
  playbackDebugLogging?: unknown;
  castDebugLogging?: unknown;
}) {
  return {
    playbackDebugLogging: saved.playbackDebugLogging === true,
    // Migrate the former combined switch once; an explicit false stays false.
    castDebugLogging: typeof saved.castDebugLogging === 'boolean'
      ? saved.castDebugLogging
      : saved.playbackDebugLogging === true,
  };
}
