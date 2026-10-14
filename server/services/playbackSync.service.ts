import { getSystemSetting, getUserSetting, initDB } from '../database';
import { isPlaybackSyncEnabled, parsePlaybackSyncMode } from '../../shared/playbackSync';
import { publishApiV1Event } from './apiV1Events.service';

/**
 * Whether "Sync playback across devices" is on for this user: the admin's
 * `playbackSyncMode`, and with `user` the user's own `playbackSyncEnabled`.
 * The playback-session API follows it for every API v1 client alike.
 */
export async function isPlaybackSyncEnabledFor(userId: string): Promise<boolean> {
  const mode = parsePlaybackSyncMode(await getSystemSetting('playbackSyncMode'));
  if (mode !== 'user') return mode === 'on';
  return isPlaybackSyncEnabled(mode, (await getUserSetting(userId, 'playbackSyncEnabled')) === true);
}

/**
 * Tells clients whether the session API now works for them
 * (`playbackSync.changed`): one user after their own choice changed, every
 * user after the admin's mode changed.
 */
export async function publishPlaybackSyncChanged(userId?: string) {
  try {
    const userIds = userId ? [userId] : (await (await initDB()).query('SELECT id FROM users')).rows.map((row) => String(row.id));
    for (const id of userIds) {
      publishApiV1Event(id, 'playbackSync.changed', { enabled: await isPlaybackSyncEnabledFor(id) });
    }
  } catch (error) {
    // Best-effort: clients also re-check when they return to the foreground,
    // and a refused session call says the same.
    console.error('[API v1] failed to publish playback sync change:', error);
  }
}
