import { getUserSetting, initDB } from '../database';
import { scrobbleTracks as scrobbleLastFmTracks, updateNowPlaying as updateLastFmNowPlaying, type LfmTrack } from './lastfm.service';
import { scrobbleTracks as scrobbleListenBrainzTracks, updateNowPlaying as updateListenBrainzNowPlaying, type LbTrack } from './listenbrainz.service';

/**
 * Scrobbles and now-playing updates sent by the server, to the providers a
 * user has connected and switched on (Settings → Scrobbling). Shared by the
 * Subsonic bridge (/rest/scrobble) and the playback-session listener, which
 * counts listens from the playing device's reports.
 */
export type ProviderScrobbleTrack = LfmTrack & LbTrack;

function settingEnabled(value: unknown): boolean {
  return value === true || value === 'true';
}

function positiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

/** A `tracks` row as a provider payload; null without an artist and a title. */
export function trackRowToProviderScrobble(track: any, timestamp?: number): ProviderScrobbleTrack | null {
  const artist = String(track.artist || '').trim();
  const title = String(track.title || '').trim();
  if (!artist || !title) return null;
  return {
    artist,
    track: title,
    album: String(track.album || '').trim() || undefined,
    albumArtist: String(track.album_artist || '').trim() || undefined,
    duration: positiveInt(track.duration),
    trackNumber: positiveInt(track.track_number),
    timestamp,
    mbid: String(track.mb_recording_id || track.mb_track_id || '').trim() || undefined,
  };
}

/**
 * Sends to every provider the user has connected and switched on. Never
 * throws: scrobbling is best-effort, and each failure goes to `log`.
 */
export async function sendToScrobbleProviders(
  userId: string,
  tracks: ProviderScrobbleTrack[],
  submission: boolean,
  log: (message: string) => void = (message) => console.warn(`[Scrobble] ${message}`),
): Promise<void> {
  const action = submission ? 'scrobble' : 'now-playing';
  try {
    if (tracks.length === 0) return;
    const [lastFmConnected, lastFmScrobbleEnabled, listenBrainzConnected, listenBrainzScrobbleEnabled] = await Promise.all([
      getUserSetting(userId, 'lastFmConnected'),
      getUserSetting(userId, 'lastFmScrobbleEnabled'),
      getUserSetting(userId, 'listenBrainzConnected'),
      getUserSetting(userId, 'listenBrainzScrobbleEnabled'),
    ]);

    const jobs: Array<{ provider: string; run: () => Promise<unknown> }> = [];
    if (settingEnabled(lastFmConnected) && settingEnabled(lastFmScrobbleEnabled)) {
      jobs.push({
        provider: 'lastfm',
        run: () => submission ? scrobbleLastFmTracks(userId, tracks) : updateLastFmNowPlaying(userId, tracks[tracks.length - 1]),
      });
    }
    if (settingEnabled(listenBrainzConnected) && settingEnabled(listenBrainzScrobbleEnabled)) {
      jobs.push({
        provider: 'listenbrainz',
        run: () => submission ? scrobbleListenBrainzTracks(userId, tracks) : updateListenBrainzNowPlaying(userId, tracks[tracks.length - 1]),
      });
    }

    const results = await Promise.allSettled(jobs.map((job) => job.run()));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        log(`provider_error provider=${jobs[index].provider} action=${action} count=${tracks.length} message=${String(result.reason?.message || result.reason).slice(0, 240)}`);
      }
    });
  } catch (error: any) {
    log(`provider_error provider=settings action=${action} count=${tracks.length} message=${String(error?.message || error).slice(0, 240)}`);
  }
}

/**
 * When a reported listen started, in seconds: the report's time (the
 * server's receipt time unless the client sent `occurredAt`) minus the
 * position it was reported at, the way session listens are timed.
 */
export function reportedListenStartS(nowMs: number, occurredAt?: string, positionMs?: number): number {
  const at = occurredAt ? Date.parse(occurredAt) : nowMs;
  return Math.floor((at - (positionMs ?? 0)) / 1000);
}

async function loadTrackRow(trackId: string): Promise<Record<string, unknown> | null> {
  const db = await initDB();
  const result = await db.query('SELECT * FROM tracks WHERE id = $1', [trackId]);
  return result.rows[0] || null;
}

/**
 * Scrobbling for API v1 playback reports (`POST /api/v1/playback/reports`),
 * so a client playing outside a playback session needs no provider
 * credentials and no route of its own: `nowPlaying` sends "now playing",
 * `played` scrobbles. Never throws.
 */
export async function scrobblePlaybackReport(
  userId: string,
  trackId: string,
  kind: 'nowPlaying' | 'played',
  startedAtS: number,
  loadTrack: (trackId: string) => Promise<Record<string, unknown> | null> = loadTrackRow,
  send: typeof sendToScrobbleProviders = sendToScrobbleProviders,
): Promise<void> {
  try {
    const track = await loadTrack(trackId);
    const payload = track ? trackRowToProviderScrobble(track, kind === 'played' ? startedAtS : undefined) : null;
    if (payload) await send(userId, [payload], kind === 'played');
  } catch (error: any) {
    console.warn(`[Scrobble] provider_error provider=report action=${kind} count=1 message=${String(error?.message || error).slice(0, 240)}`);
  }
}
