import { getSystemSetting } from '../database';

const MB_USER_AGENT = 'AuroraMediaServer/1.0 (https://github.com/aurora-music)';

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

export async function mbFetch(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    mbQueue.push({
      fn: async () => {
        const headers: Record<string, string> = {
          'User-Agent': MB_USER_AGENT,
          'Accept': 'application/json'
        };
        const token = await getMbAccessToken();
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
        return res.json();
      },
      resolve,
      reject
    });
    processMbQueue();
  });
}

export async function checkMbEnabled(): Promise<boolean> {
  const enabled = await getSystemSetting('musicBrainzEnabled');
  return enabled === true || enabled === 'true';
}
