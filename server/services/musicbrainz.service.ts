import { getSystemSetting } from '../database';

const MB_USER_AGENT = 'AuroraMediaServer/1.0 (https://github.com/aurora-music)';
const MB_CLIENT_ID = 'aurora-1.0.0beta3';
const MB_API_ORIGIN = 'https://musicbrainz.org';
const MB_API_PATH_PREFIX = '/ws/2/';

let mbLastRequest = 0;
const mbQueue: { fn: () => Promise<any>; resolve: (val: any) => void; reject: (err: any) => void }[] = [];
let mbQueueRunning = false;

async function getMbAccessToken(): Promise<string | null> {
  try {
    const token = await getSystemSetting('musicBrainzAccessToken');
    if (!token) return null;
    const expiresAt = await getSystemSetting('musicBrainzTokenExpiresAt');
    if (expiresAt && Date.now() / 1000 > Number(expiresAt) - 60) {
      return refreshMbToken();
    }
    return token;
  } catch { return null; }
}

export async function refreshMbToken(): Promise<string | null> {
  try {
    const refreshToken = await getSystemSetting('musicBrainzRefreshToken');
    const clientId = await getSystemSetting('musicBrainzClientId');
    const clientSecret = await getSystemSetting('musicBrainzClientSecret');
    if (!refreshToken || !clientId || !clientSecret) return null;

    const res = await fetch('https://musicbrainz.org/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const { setSystemSetting } = await import('../database');
    await setSystemSetting('musicBrainzAccessToken', data.access_token);
    if (data.refresh_token) {
      await setSystemSetting('musicBrainzRefreshToken', data.refresh_token);
    }
    await setSystemSetting('musicBrainzTokenExpiresAt', Math.floor(Date.now() / 1000) + data.expires_in);
    return data.access_token;
  } catch { return null; }
}

async function processMbQueue() {
  if (mbQueueRunning) return;
  mbQueueRunning = true;
  while (mbQueue.length > 0) {
    const now = Date.now();
    const wait = Math.max(0, 1000 - (now - mbLastRequest));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const item = mbQueue.shift()!;
    mbLastRequest = Date.now();
    try {
      item.resolve(await item.fn());
    } catch (err) {
      item.reject(err);
    }
  }
  mbQueueRunning = false;
}

const MB_FETCH_TIMEOUT_MS = 15_000;

export async function mbFetch(url: string, signal?: AbortSignal): Promise<any> {
  signal?.throwIfAborted();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid MusicBrainz URL');
  }

  if (
    parsed.origin !== MB_API_ORIGIN ||
    !parsed.pathname.startsWith(MB_API_PATH_PREFIX) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error('MusicBrainz URL not allowed');
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    mbQueue.push({
      fn: async () => {
        signal?.throwIfAborted();
        const headers: Record<string, string> = {
          'User-Agent': MB_USER_AGENT,
          'Accept': 'application/json'
        };
        const token = await getMbAccessToken();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        // Requests run one at a time, so a connection that never answers
        // would hold up every MusicBrainz lookup behind it.
        const timeout = AbortSignal.timeout(MB_FETCH_TIMEOUT_MS);
        const res = await fetch(parsed.toString(), { headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
        return res.json();
      },
      resolve: value => { cleanup(); resolve(value); },
      reject: error => { cleanup(); reject(error); }
    });
    processMbQueue();
  });
}

export async function submitMbRecordingRating(recordingMbid: string, rating: 0 | 20 | 40 | 60 | 80 | 100): Promise<void> {
  if (!recordingMbid) return;

  await new Promise<void>((resolve, reject) => {
    mbQueue.push({
      fn: async () => {
        const token = await getMbAccessToken();
        if (!token) throw new Error('MusicBrainz OAuth token not available');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata xmlns="http://musicbrainz.org/ns/mmd-2.0#">
  <recording-list>
    <recording id="${recordingMbid}">
      <user-rating>${rating}</user-rating>
    </recording>
  </recording-list>
</metadata>`;

        const res = await fetch(`https://musicbrainz.org/ws/2/rating?client=${encodeURIComponent(MB_CLIENT_ID)}`, {
          method: 'POST',
          headers: {
            'User-Agent': MB_USER_AGENT,
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/xml; charset=utf-8',
          },
          body: xml,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`MusicBrainz rating HTTP ${res.status}${text ? `: ${text}` : ''}`);
        }
      },
      resolve: (_val: any) => resolve(),
      reject
    });
    processMbQueue();
  });
}

export async function checkMbEnabled(): Promise<boolean> {
  const enabled = await getSystemSetting('musicBrainzEnabled');
  return enabled === true || enabled === 'true';
}
