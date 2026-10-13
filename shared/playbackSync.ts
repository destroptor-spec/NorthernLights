// "Sync playback across devices" is decided on the server
// (docs/playback_sessions.md, Phase 2). The admin sets `playbackSyncMode`:
// off for everyone, on for everyone, or `user` to let each listener choose
// with their own `playbackSyncEnabled`. Both are stored server-side, so the
// result is the same on every device of a user.

export const PLAYBACK_SYNC_MODES = ['off', 'on', 'user'] as const;
export type PlaybackSyncMode = typeof PLAYBACK_SYNC_MODES[number];

export function parsePlaybackSyncMode(value: unknown): PlaybackSyncMode {
  return PLAYBACK_SYNC_MODES.includes(value as PlaybackSyncMode) ? value as PlaybackSyncMode : 'off';
}

export function isPlaybackSyncEnabled(mode: PlaybackSyncMode, userEnabled: boolean): boolean {
  return mode === 'on' || (mode === 'user' && userEnabled);
}
