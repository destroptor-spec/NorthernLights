import { getSystemSetting, getTrackById, getUserSetting, setTrackLovedForUser } from '../database';
import { loveTrack, unloveTrack } from './lastfm.service';
import { submitMbRecordingRating } from './musicbrainz.service';
import { publishApiV1Event } from './apiV1Events.service';

export type ProviderSyncResult =
  | { provider: 'lastfm' | 'musicbrainz'; status: 'ok' }
  | { provider: 'lastfm' | 'musicbrainz'; status: 'skipped'; reason: string }
  | { provider: 'lastfm' | 'musicbrainz'; status: 'failed'; error: string };

function isOn(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Set a track's loved state for a user and mirror it to connected providers.
 *
 * The one implementation behind both the web route (`POST /api/library/love`)
 * and API v1 (`PUT /api/v1/tracks/:id/loved`). v1 used to store the flag and
 * stop there, so a client moved onto it would have silently stopped loving on
 * Last.fm and rating on MusicBrainz. The local write always lands first;
 * provider failures are reported per provider and never undo it.
 *
 * Returns null when the track does not exist.
 */
export async function setTrackLovedAndSync(
  userId: string,
  trackId: string,
  loved: boolean,
  options: {
    source?: string;
    /**
     * False stores the love locally and contacts no provider. OpenSubsonic
     * stars pass the listener's "Sync loved/liked songs across all platforms"
     * preference here; the web app and API v1 always sync.
     */
    syncProviders?: boolean;
  } = {},
): Promise<ProviderSyncResult[] | null> {
  const track = await getTrackById(trackId);
  if (!track) return null;

  await setTrackLovedForUser(userId, trackId, loved);
  publishApiV1Event(userId, 'annotation.changed', options.source
    ? { trackId, loved, source: options.source }
    : { trackId, loved });

  if (options.syncProviders === false) {
    return [
      { provider: 'lastfm', status: 'skipped', reason: 'sync_disabled' },
      { provider: 'musicbrainz', status: 'skipped', reason: 'sync_disabled' },
    ];
  }

  const jobs: Array<{ provider: 'lastfm' | 'musicbrainz'; run: (() => Promise<unknown>) | null; reason: string }> = [
    {
      provider: 'lastfm',
      run: isOn(await getUserSetting(userId, 'lastFmConnected')) && track.artist && track.title
        ? () => (loved ? loveTrack(userId, track.artist, track.title) : unloveTrack(userId, track.artist, track.title))
        : null,
      reason: 'not_connected_or_missing_metadata',
    },
    {
      provider: 'musicbrainz',
      run: isOn(await getSystemSetting('musicBrainzConnected')) && track.mbRecordingId
        ? () => submitMbRecordingRating(track.mbRecordingId, loved ? 100 : 0)
        : null,
      reason: 'not_connected_or_missing_recording_mbid',
    },
  ];

  return Promise.all(jobs.map(async ({ provider, run, reason }): Promise<ProviderSyncResult> => {
    if (!run) return { provider, status: 'skipped', reason };
    try {
      await run();
      return { provider, status: 'ok' };
    } catch (error) {
      return { provider, status: 'failed', error: (error as Error)?.message || 'Provider sync failed' };
    }
  }));
}
