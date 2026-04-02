import { createHash } from 'crypto';
import { getUserSetting, setUserSetting, getSystemSetting } from '../database';

const LFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';

export interface LfmTrack {
  artist: string;
  track: string;
  album?: string;
  albumArtist?: string;
  duration?: number;
  trackNumber?: number;
  timestamp?: number;
  mbid?: string;
  chosenByUser?: boolean;
}

/**
 * Get user's Last.fm credentials. API key + shared secret are system-level,
 * session key is per-user.
 */
async function getUserLfmCreds(userId: string): Promise<{ apiKey: string; sharedSecret: string; sessionKey: string }> {
  const apiKey = (await getSystemSetting('lastFmApiKey')) || '';
  const sharedSecret = (await getSystemSetting('lastFmSharedSecret')) || '';
  const sessionKey = (await getUserSetting(userId, 'lastFmSessionKey')) || '';
  return { apiKey, sharedSecret, sessionKey };
}

/**
 * Build Last.fm API signature (MD5 of sorted key-value pairs + shared secret).
 * Excludes 'format' and 'callback' params from signature.
 */
export function buildSignature(params: Record<string, string>, secret: string): string {
  const filtered = Object.entries(params)
    .filter(([key]) => key !== 'format' && key !== 'callback')
    .sort(([a], [b]) => a.localeCompare(b));

  let sigString = '';
  for (const [key, value] of filtered) {
    sigString += key + value;
  }
  sigString += secret;

  return createHash('md5').update(sigString, 'utf8').digest('hex');
}

/**
 * Make an authenticated Last.fm API call (POST with signature) for a specific user.
 */
export async function lfmFetch(
  userId: string,
  method: string,
  params: Record<string, string>,
  overrides?: { apiKey?: string; sharedSecret?: string; sessionKey?: string }
): Promise<any> {
  const creds = await getUserLfmCreds(userId);
  const apiKey = overrides?.apiKey || creds.apiKey;
  const sharedSecret = overrides?.sharedSecret || creds.sharedSecret;
  const sessionKey = overrides?.sessionKey || creds.sessionKey;

  const allParams: Record<string, string> = {
    method,
    api_key: apiKey,
    format: 'json',
    ...params,
  };

  if (sessionKey) {
    allParams.sk = sessionKey;
  }

  // Build signature (sk is included if present)
  const sigString = Object.entries(allParams)
    .filter(([key]) => key !== 'format' && key !== 'callback')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + value)
    .join('') + sharedSecret;

  allParams.api_sig = createHash('md5').update(sigString, 'utf8').digest('hex');

  const body = new URLSearchParams(allParams);

  const res = await fetch(LFM_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const json = await res.json();

  if (json.error) {
    throw new Error(`Last.fm error ${json.error}: ${json.message}`);
  }

  return json;
}

/**
 * Scrobble tracks to Last.fm for a user (batch up to 50 per request).
 */
export async function scrobbleTracks(userId: string, tracks: LfmTrack[]): Promise<any> {
  if (tracks.length === 0) return { scrobbles: [] };

  const results: any[] = [];

  // Batch in groups of 50
  for (let i = 0; i < tracks.length; i += 50) {
    const batch = tracks.slice(i, i + 50);
    const params: Record<string, string> = {};

    batch.forEach((t, idx) => {
      params[`artist[${idx}]`] = t.artist;
      params[`track[${idx}]`] = t.track;
      params[`timestamp[${idx}]`] = String(t.timestamp || Math.floor(Date.now() / 1000));
      if (t.album) params[`album[${idx}]`] = t.album;
      if (t.albumArtist) params[`albumArtist[${idx}]`] = t.albumArtist;
      if (t.duration) params[`duration[${idx}]`] = String(t.duration);
      if (t.trackNumber) params[`trackNumber[${idx}]`] = String(t.trackNumber);
      if (t.mbid) params[`mbid[${idx}]`] = t.mbid;
      params[`chosenByUser[${idx}]`] = t.chosenByUser !== false ? '1' : '0';
    });

    const result = await lfmFetch(userId, 'track.scrobble', params);
    results.push(result);
  }

  return results.length === 1 ? results[0] : results;
}

/**
 * Update Now Playing on Last.fm for a user.
 */
export async function updateNowPlaying(userId: string, track: LfmTrack): Promise<any> {
  const params: Record<string, string> = {
    artist: track.artist,
    track: track.track,
  };
  if (track.album) params.album = track.album;
  if (track.albumArtist) params.albumArtist = track.albumArtist;
  if (track.duration) params.duration = String(track.duration);
  if (track.trackNumber) params.trackNumber = String(track.trackNumber);
  if (track.mbid) params.mbid = track.mbid;

  return lfmFetch(userId, 'track.updateNowPlaying', params);
}

/**
 * Love a track on Last.fm for a user.
 */
export async function loveTrack(userId: string, artist: string, track: string): Promise<any> {
  return lfmFetch(userId, 'track.love', { artist, track });
}

/**
 * Unlove a track on Last.fm for a user.
 */
export async function unloveTrack(userId: string, artist: string, track: string): Promise<any> {
  return lfmFetch(userId, 'track.unlove', { artist, track });
}
