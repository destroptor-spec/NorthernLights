import { Router } from 'express';
import { getSystemSetting, setSystemSetting, getUserSetting, setUserSetting } from '../database';
import { lfmFetch, scrobbleTracks, updateNowPlaying, loveTrack, unloveTrack } from '../services/lastfm.service';

const router = Router();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';

// ─── MusicBrainz Rate Limiter (1 req/s) ──────────────────────────────
const MB_USER_AGENT = 'AuroraMediaServer/1.0 (https://github.com/aurora-music)';
let mbLastRequest = 0;
const mbQueue: { fn: () => Promise<any>; resolve: (val: any) => void; reject: (err: any) => void }[] = [];
let mbQueueRunning = false;

/**
 * Get a valid MusicBrainz access token, auto-refreshing if expired.
 */
async function getMbAccessToken(): Promise<string | null> {
  const token = await getSystemSetting('musicBrainzAccessToken');
  if (!token) return null;

  const expiresAt = await getSystemSetting('musicBrainzTokenExpiresAt');
  if (expiresAt && Date.now() / 1000 > Number(expiresAt) - 60) {
    // Token expired or about to expire, try to refresh
    return refreshMbToken();
  }

  return token;
}

async function refreshMbToken(): Promise<string | null> {
  const refreshToken = await getSystemSetting('musicBrainzRefreshToken');
  const clientId = await getSystemSetting('musicBrainzClientId');
  const clientSecret = await getSystemSetting('musicBrainzClientSecret');

  if (!refreshToken || !clientId || !clientSecret) return null;

  try {
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

    if (!res.ok) {
      console.error('[MusicBrainz OAuth] Token refresh failed:', res.status);
      await setSystemSetting('musicBrainzConnected', false);
      return null;
    }

    const data = await res.json();
    await setSystemSetting('musicBrainzAccessToken', data.access_token);
    if (data.refresh_token) {
      await setSystemSetting('musicBrainzRefreshToken', data.refresh_token);
    }
    await setSystemSetting('musicBrainzTokenExpiresAt', Math.floor(Date.now() / 1000) + data.expires_in);
    await setSystemSetting('musicBrainzConnected', true);

    return data.access_token;
  } catch (err: any) {
    console.error('[MusicBrainz OAuth] Token refresh error:', err.message);
    return null;
  }
}

async function mbFetch(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    mbQueue.push({ fn: async () => {
      const headers: Record<string, string> = {
        'User-Agent': MB_USER_AGENT,
        'Accept': 'application/json'
      };

      // Inject Bearer token if available
      const token = await getMbAccessToken();
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`MusicBrainz HTTP ${res.status}`);
      return res.json();
    }, resolve, reject });
    processMbQueue();
  });
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

async function checkMbEnabled(): Promise<boolean> {
  const enabled = await getSystemSetting('musicBrainzEnabled');
  return enabled === true || enabled === 'true';
}

// ─── MusicBrainz Proxy Routes ────────────────────────────────────────

router.get('/providers/musicbrainz/artist/:mbid', async (req, res) => {
  try {
    if (!await checkMbEnabled()) return res.status(404).json({ error: 'MusicBrainz not enabled' });
    const { mbid } = req.params;
    const inc = req.query.inc || 'url-rels+tags+genres+ratings';
    const json = await mbFetch(`https://musicbrainz.org/ws/2/artist/${mbid}?inc=${inc}&fmt=json`);
    res.json(json);
  } catch (err: any) {
    console.error('[MusicBrainz Proxy] artist error:', err.message);
    res.status(502).json({ error: 'MusicBrainz API request failed' });
  }
});

router.get('/providers/musicbrainz/release-group/:mbid', async (req, res) => {
  try {
    if (!await checkMbEnabled()) return res.status(404).json({ error: 'MusicBrainz not enabled' });
    const { mbid } = req.params;
    const inc = req.query.inc || 'genres+tags+ratings';
    const json = await mbFetch(`https://musicbrainz.org/ws/2/release-group/${mbid}?inc=${inc}&fmt=json`);
    res.json(json);
  } catch (err: any) {
    console.error('[MusicBrainz Proxy] release-group error:', err.message);
    res.status(502).json({ error: 'MusicBrainz API request failed' });
  }
});

router.get('/providers/musicbrainz/recording/:mbid', async (req, res) => {
  try {
    if (!await checkMbEnabled()) return res.status(404).json({ error: 'MusicBrainz not enabled' });
    const { mbid } = req.params;
    const json = await mbFetch(`https://musicbrainz.org/ws/2/recording/${mbid}?inc=artist-credits+isrcs+tags&fmt=json`);
    res.json(json);
  } catch (err: any) {
    console.error('[MusicBrainz Proxy] recording error:', err.message);
    res.status(502).json({ error: 'MusicBrainz API request failed' });
  }
});

router.get('/providers/musicbrainz/isrc/:isrc', async (req, res) => {
  try {
    if (!await checkMbEnabled()) return res.status(404).json({ error: 'MusicBrainz not enabled' });
    const { isrc } = req.params;
    const json = await mbFetch(`https://musicbrainz.org/ws/2/isrc/${isrc}?inc=artist-credits+tags&fmt=json`);
    res.json(json);
  } catch (err: any) {
    console.error('[MusicBrainz Proxy] isrc error:', err.message);
    res.status(502).json({ error: 'MusicBrainz API request failed' });
  }
});

router.get('/providers/musicbrainz/search/artist', async (req, res) => {
  try {
    if (!await checkMbEnabled()) return res.status(404).json({ error: 'MusicBrainz not enabled' });
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing query parameter q' });
    const limit = req.query.limit || '5';
    const json = await mbFetch(`https://musicbrainz.org/ws/2/artist/?query=${encodeURIComponent(query as string)}&limit=${limit}&fmt=json`);
    res.json(json);
  } catch (err: any) {
    console.error('[MusicBrainz Proxy] search error:', err.message);
    res.status(502).json({ error: 'MusicBrainz API request failed' });
  }
});

router.get('/providers/musicbrainz/search/release-group', async (req, res) => {
  try {
    if (!await checkMbEnabled()) return res.status(404).json({ error: 'MusicBrainz not enabled' });
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing query parameter q' });
    const limit = req.query.limit || '5';
    const json = await mbFetch(`https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(query as string)}&limit=${limit}&fmt=json`);
    res.json(json);
  } catch (err: any) {
    console.error('[MusicBrainz Proxy] search release-group error:', err.message);
    res.status(502).json({ error: 'MusicBrainz API request failed' });
  }
});

router.get('/providers/musicbrainz/test', async (req, res) => {
  try {
    const json = await mbFetch('https://musicbrainz.org/ws/2/artist/?query=radiohead&limit=1&fmt=json');
    if (json.artists) {
      res.json({ status: 'ok' });
    } else {
      res.status(502).json({ status: 'error', error: 'Unexpected response' });
    }
  } catch (err: any) {
    res.status(502).json({ status: 'error', error: err.message || 'Network error' });
  }
});

// ─── MusicBrainz OAuth2 Routes ────────────────────────────────────────

router.get('/providers/musicbrainz/authorize', async (req, res) => {
  try {
    const clientId = await getSystemSetting('musicBrainzClientId');
    if (!clientId) return res.status(400).json({ error: 'MusicBrainz Client ID not configured' });

    const redirectUri = `${SERVER_URL}/api/providers/musicbrainz/callback`;
    const url = new URL('https://musicbrainz.org/oauth2/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'tag rating collection');
    url.searchParams.set('state', 'aurora');

    res.json({ url: url.toString() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/providers/musicbrainz/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`${SERVER_URL}/?mb_error=${encodeURIComponent(error as string)}`);
    }

    if (!code) {
      return res.redirect(`${SERVER_URL}/?mb_error=missing_code`);
    }

    const clientId = await getSystemSetting('musicBrainzClientId');
    const clientSecret = await getSystemSetting('musicBrainzClientSecret');
    if (!clientId || !clientSecret) {
      return res.redirect(`${SERVER_URL}/?mb_error=credentials_not_configured`);
    }

    const redirectUri = `${SERVER_URL}/api/providers/musicbrainz/callback`;

    const tokenRes = await fetch('https://musicbrainz.org/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('[MusicBrainz OAuth] Token exchange failed:', tokenRes.status, errText);
      return res.redirect(`${SERVER_URL}/?mb_error=token_exchange_failed`);
    }

    const tokenData = await tokenRes.json();

    await setSystemSetting('musicBrainzAccessToken', tokenData.access_token);
    await setSystemSetting('musicBrainzRefreshToken', tokenData.refresh_token);
    await setSystemSetting('musicBrainzTokenExpiresAt', Math.floor(Date.now() / 1000) + tokenData.expires_in);
    await setSystemSetting('musicBrainzConnected', true);

    // Fetch username for display
    try {
      const meRes = await fetch('https://musicbrainz.org/oauth2/userinfo', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
      });
      if (meRes.ok) {
        const meData = await meRes.json();
        await setSystemSetting('musicBrainzUsername', meData.sub || 'Connected');
      }
    } catch {}

    res.redirect(`${SERVER_URL}/?mb_connected=1`);
  } catch (err: any) {
    console.error('[MusicBrainz OAuth] Callback error:', err.message);
    res.redirect(`${SERVER_URL}/?mb_error=internal_error`);
  }
});

router.post('/providers/musicbrainz/refresh', async (req, res) => {
  try {
    const token = await refreshMbToken();
    if (token) {
      res.json({ status: 'ok' });
    } else {
      res.status(400).json({ status: 'error', error: 'Failed to refresh token' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers/musicbrainz/disconnect', async (req, res) => {
  try {
    const token = await getSystemSetting('musicBrainzAccessToken');
    const clientId = await getSystemSetting('musicBrainzClientId');
    const clientSecret = await getSystemSetting('musicBrainzClientSecret');

    // Revoke token at MusicBrainz
    if (token && clientId && clientSecret) {
      try {
        await fetch('https://musicbrainz.org/oauth2/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token,
            client_id: clientId,
            client_secret: clientSecret,
          }),
        });
      } catch {}
    }

    await setSystemSetting('musicBrainzAccessToken', '');
    await setSystemSetting('musicBrainzRefreshToken', '');
    await setSystemSetting('musicBrainzTokenExpiresAt', '');
    await setSystemSetting('musicBrainzConnected', false);
    await setSystemSetting('musicBrainzUsername', '');

    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/providers/musicbrainz/status', async (req, res) => {
  try {
    const connected = await getSystemSetting('musicBrainzConnected');
    const username = await getSystemSetting('musicBrainzUsername');
    const expiresAt = await getSystemSetting('musicBrainzTokenExpiresAt');

    res.json({
      connected: connected === true || connected === 'true',
      username: username || null,
      expiresAt: expiresAt ? Number(expiresAt) : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Genius API proxy — avoids CORS issues in browser
router.post('/providers/genius/search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query' });

    const apiKey = req.body.apiKey || await getSystemSetting('geniusApiKey');
    if (!apiKey) return res.status(400).json({ error: 'Genius API key not configured' });

    const geniusRes = await fetch(`https://api.genius.com/search?q=${encodeURIComponent(query)}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    if (!geniusRes.ok) {
      return res.status(geniusRes.status).json({ error: `Genius API returned ${geniusRes.status}` });
    }
    const json = await geniusRes.json();
    res.status(geniusRes.status).json(json);
  } catch (err: any) {
    console.error('[Genius Proxy] search error:', err.message);
    res.status(502).json({ error: 'Genius API request failed' });
  }
});

router.post('/providers/genius/artist/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const apiKey = req.body.apiKey || await getSystemSetting('geniusApiKey');
    if (!apiKey) return res.status(400).json({ error: 'Genius API key not configured' });

    const geniusRes = await fetch(`https://api.genius.com/artists/${id}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    if (!geniusRes.ok) {
      return res.status(geniusRes.status).json({ error: `Genius API returned ${geniusRes.status}` });
    }
    const json = await geniusRes.json();
    res.status(geniusRes.status).json(json);
  } catch (err: any) {
    console.error('[Genius Proxy] artist error:', err.message);
    res.status(502).json({ error: 'Genius API request failed' });
  }
});

// Test endpoint — validates the configured key or one provided in body
router.post('/providers/genius/test', async (req, res) => {
  try {
    const apiKey = req.body.apiKey || await getSystemSetting('geniusApiKey');
    if (!apiKey) return res.status(400).json({ status: 'error', error: 'No API key configured' });

    const geniusRes = await fetch(`https://api.genius.com/search?q=test`, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    if (geniusRes.ok) {
      res.json({ status: 'ok' });
    } else if (geniusRes.status === 401) {
      res.status(401).json({ status: 'error', error: 'Invalid token' });
    } else {
      res.status(geniusRes.status).json({ status: 'error', error: `HTTP ${geniusRes.status}` });
    }
  } catch (err: any) {
    res.status(502).json({ status: 'error', error: err.message || 'Network error' });
  }
});

// ─── Last.fm Routes (per-user) ────────────────────────────────────────

router.get('/providers/lastfm/authorize', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const apiKey = await getUserSetting(userId, 'lastFmApiKey');
    if (!apiKey) return res.status(400).json({ error: 'Last.fm API key not configured' });

    // Fetch a request token
    const sharedSecret = await getUserSetting(userId, 'lastFmSharedSecret') || '';
    const tokenRes = await lfmFetch(userId, 'auth.getToken', {}, { apiKey, sharedSecret, sessionKey: '' });

    if (!tokenRes.token) {
      return res.status(502).json({ error: 'Failed to get Last.fm auth token' });
    }

    // Store the temporary token so the callback can use it
    await setUserSetting(userId, 'lastFmPendingToken', tokenRes.token);

    const authUrl = `https://www.last.fm/api/auth/?api_key=${apiKey}&token=${tokenRes.token}`;
    res.json({ url: authUrl });
  } catch (err: any) {
    console.error('[Last.fm] authorize error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/providers/lastfm/callback', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.redirect(`${SERVER_URL}/?lfm_error=not_authenticated`);

    const { token, error } = req.query;

    if (error) {
      return res.redirect(`${SERVER_URL}/?lfm_error=${encodeURIComponent(error as string)}`);
    }

    if (!token) {
      return res.redirect(`${SERVER_URL}/?lfm_error=missing_token`);
    }

    // Verify the token matches what we stored
    const pendingToken = await getUserSetting(userId, 'lastFmPendingToken');
    if (!pendingToken || pendingToken !== token) {
      return res.redirect(`${SERVER_URL}/?lfm_error=token_mismatch`);
    }

    const apiKey = await getUserSetting(userId, 'lastFmApiKey');
    const sharedSecret = await getUserSetting(userId, 'lastFmSharedSecret') || '';

    if (!apiKey) {
      return res.redirect(`${SERVER_URL}/?lfm_error=no_api_key`);
    }

    // Exchange token for session key
    const sessionRes = await lfmFetch(userId, 'auth.getSession', { token: token as string }, { apiKey, sharedSecret, sessionKey: '' });

    if (!sessionRes.session?.key) {
      return res.redirect(`${SERVER_URL}/?lfm_error=session_failed`);
    }

    await setUserSetting(userId, 'lastFmSessionKey', sessionRes.session.key);
    await setUserSetting(userId, 'lastFmUsername', sessionRes.session.name || '');
    await setUserSetting(userId, 'lastFmConnected', true);
    await setUserSetting(userId, 'lastFmPendingToken', '');

    res.redirect(`${SERVER_URL}/?lfm_connected=1`);
  } catch (err: any) {
    console.error('[Last.fm] callback error:', err.message);
    res.redirect(`${SERVER_URL}/?lfm_error=internal_error`);
  }
});

router.post('/providers/lastfm/disconnect', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    await setUserSetting(userId, 'lastFmSessionKey', '');
    await setUserSetting(userId, 'lastFmUsername', '');
    await setUserSetting(userId, 'lastFmConnected', false);
    await setUserSetting(userId, 'lastFmPendingToken', '');

    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/providers/lastfm/status', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const connected = await getUserSetting(userId, 'lastFmConnected');
    const username = await getUserSetting(userId, 'lastFmUsername');
    const scrobbleEnabled = await getUserSetting(userId, 'lastFmScrobbleEnabled');
    const hasApiKey = !!(await getUserSetting(userId, 'lastFmApiKey'));

    res.json({
      connected: connected === true || connected === 'true',
      username: username || null,
      scrobbleEnabled: scrobbleEnabled === true || scrobbleEnabled === 'true',
      hasApiKey,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers/lastfm/scrobble', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const connected = await getUserSetting(userId, 'lastFmConnected');
    if (connected !== true && connected !== 'true') {
      return res.status(400).json({ error: 'Last.fm not connected' });
    }

    const { tracks } = req.body;
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
      return res.status(400).json({ error: 'Missing tracks array' });
    }

    const result = await scrobbleTracks(userId, tracks);
    res.json(result);
  } catch (err: any) {
    console.error('[Last.fm] scrobble error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

router.post('/providers/lastfm/now-playing', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const connected = await getUserSetting(userId, 'lastFmConnected');
    if (connected !== true && connected !== 'true') {
      return res.status(400).json({ error: 'Last.fm not connected' });
    }

    const { artist, track, album, albumArtist, duration, trackNumber, mbid } = req.body;
    if (!artist || !track) return res.status(400).json({ error: 'Missing artist or track' });

    const result = await updateNowPlaying(userId, { artist, track, album, albumArtist, duration, trackNumber, mbid });
    res.json(result);
  } catch (err: any) {
    console.error('[Last.fm] now-playing error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

router.post('/providers/lastfm/love', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const connected = await getUserSetting(userId, 'lastFmConnected');
    if (connected !== true && connected !== 'true') {
      return res.status(400).json({ error: 'Last.fm not connected' });
    }

    const { artist, track } = req.body;
    if (!artist || !track) return res.status(400).json({ error: 'Missing artist or track' });

    const result = await loveTrack(userId, artist, track);
    res.json(result);
  } catch (err: any) {
    console.error('[Last.fm] love error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

router.post('/providers/lastfm/unlove', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const connected = await getUserSetting(userId, 'lastFmConnected');
    if (connected !== true && connected !== 'true') {
      return res.status(400).json({ error: 'Last.fm not connected' });
    }

    const { artist, track } = req.body;
    if (!artist || !track) return res.status(400).json({ error: 'Missing artist or track' });

    const result = await unloveTrack(userId, artist, track);
    res.json(result);
  } catch (err: any) {
    console.error('[Last.fm] unlove error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

export default router;
