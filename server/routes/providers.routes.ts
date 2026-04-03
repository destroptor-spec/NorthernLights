import { Router } from 'express';
import { getSystemSetting, setSystemSetting, getUserSetting, setUserSetting } from '../database';
import { lfmFetch, scrobbleTracks, updateNowPlaying, loveTrack, unloveTrack } from '../services/lastfm.service';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { mbFetch, checkMbEnabled, refreshMbToken } from '../services/musicbrainz.service';
import {
  getArtistData,
  getAlbumImage,
  getGenreImage,
  getGenreInfo,
  getLyrics,
  testLastFm,
  clearExternalCache,
} from '../services/externalMetadata.service';

const router = Router();

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3001';

// ─── MusicBrainz OAuth2 Helpers ─────────────────────────────────────

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
    // Test basic API access (works anonymously)
    const json = await mbFetch('https://musicbrainz.org/ws/2/artist/?query=radiohead&limit=1&fmt=json');
    if (!json.artists) {
      return res.status(502).json({ status: 'error', error: 'Unexpected response' });
    }

    // If OAuth token exists, validate it via userinfo endpoint
    const accessToken = await getSystemSetting('musicBrainzAccessToken');
    if (accessToken) {
      try {
        const meRes = await fetch('https://musicbrainz.org/oauth2/userinfo', {
          headers: { 'Authorization': `Bearer ${accessToken}` },
        });
        if (meRes.ok) {
          const meData = await meRes.json();
          return res.json({ status: 'ok', mode: 'authenticated', username: meData.sub || 'Connected' });
        }
      } catch { /* token validation failed, fall through to anonymous */ }
    }

    res.json({ status: 'ok', mode: 'anonymous' });
  } catch (err: any) {
    res.status(502).json({ status: 'error', error: err.message || 'Network error' });
  }
});

// ─── MusicBrainz OAuth2 Routes ────────────────────────────────────────

router.get('/providers/musicbrainz/authorize', async (req, res) => {
  try {
    const clientId = await getSystemSetting('musicBrainzClientId');
    if (!clientId) return res.status(400).json({ error: 'MusicBrainz Client ID not configured' });

    const userId = req.user?.userId;
    const redirectUri = `${SERVER_URL}/api/providers/musicbrainz/callback`;
    const url = new URL('https://musicbrainz.org/oauth2/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'tag rating collection');
    // Encode userId in state so the unauthenticated callback can identify the user
    url.searchParams.set('state', userId ? `uid:${userId}` : 'aurora');

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
      const data = await geniusRes.json();
      const artist = data.response?.hits?.[0]?.result?.primary_artist?.name;
      res.json({ status: 'ok', artist });
    } else if (geniusRes.status === 401) {
      res.status(401).json({ status: 'error', error: 'Invalid API Key' });
    } else {
      res.status(geniusRes.status).json({ status: 'error', error: `Genius API error: HTTP ${geniusRes.status}` });
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

    const apiKey = await getSystemSetting('lastFmApiKey');
    if (!apiKey) return res.status(400).json({ error: 'Last.fm API key not configured' });

    // Fetch a request token (no signature needed for auth.getToken)
    const sharedSecret = (await getSystemSetting('lastFmSharedSecret')) || '';
    const tokenRes = await lfmFetch(userId, 'auth.getToken', {}, { apiKey, sharedSecret, sessionKey: '' });

    if (!tokenRes.token) {
      return res.status(502).json({ error: 'Failed to get Last.fm auth token' });
    }

    // Store the temporary token so the callback can use it
    await setUserSetting(userId, 'lastFmPendingToken', tokenRes.token);

    // Encode userId in callback URL so the unauthenticated callback can identify the user
    const cbUrl = `${SERVER_URL}/api/providers/lastfm/callback?cb_state=${encodeURIComponent(userId)}`;
    const authUrl = `https://www.last.fm/api/auth/?api_key=${apiKey}&token=${tokenRes.token}&cb=${encodeURIComponent(cbUrl)}`;
    res.json({ url: authUrl });
  } catch (err: any) {
    console.error('[Last.fm] authorize error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/providers/lastfm/callback', async (req, res) => {
  try {
    // userId is passed via the callback URL's cb_state param (set in authorize)
    const userId = req.query.cb_state as string;
    if (!userId) return res.redirect(`${SERVER_URL}/?lfm_error=missing_state`);

    const { token, error } = req.query;

    if (error) {
      return res.redirect(`${SERVER_URL}/?lfm_error=${encodeURIComponent(error as string)}`);
    }

    if (!token) {
      return res.redirect(`${SERVER_URL}/?lfm_error=missing_token`);
    }

    // Verify the token matches what we stored for this user
    const pendingToken = await getUserSetting(userId, 'lastFmPendingToken');
    if (!pendingToken || pendingToken !== token) {
      return res.redirect(`${SERVER_URL}/?lfm_error=token_mismatch`);
    }

    const apiKey = await getSystemSetting('lastFmApiKey');
    const sharedSecret = (await getSystemSetting('lastFmSharedSecret')) || '';

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
    const hasApiKey = !!(await getSystemSetting('lastFmApiKey'));

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

// ─── Last.fm Test (server-side, consistent with Genius/MusicBrainz) ──
router.get('/providers/lastfm/test', async (req, res) => {
  try {
    const result = await testLastFm();
    if (result.status === 'ok') {
      res.json(result);
    } else {
      res.status(result.error === 'No API key configured' ? 400 : 502).json(result);
    }
  } catch (err: any) {
    res.status(502).json({ status: 'error', error: err.message || 'Network error' });
  }
});

// ─── External Metadata Routes (cached, server-side fetching) ────────

router.get('/providers/external/artist', requireAuth, async (req, res) => {
  try {
    const name = req.query.name as string;
    if (!name) return res.status(400).json({ error: 'Missing name parameter' });
    const mbid = (req.query.mbid as string) || undefined;
    const data = await getArtistData(name, mbid);
    res.json(data);
  } catch (err: any) {
    console.error('[ExternalMeta] artist error:', err.message);
    res.status(502).json({ error: 'Failed to fetch artist data' });
  }
});

router.get('/providers/external/album-art', requireAuth, async (req, res) => {
  try {
    const album = req.query.album as string;
    const artist = req.query.artist as string;
    if (!album || !artist) return res.status(400).json({ error: 'Missing album or artist parameter' });
    const mbid = (req.query.mbid as string) || undefined;
    const imageUrl = await getAlbumImage(album, artist, mbid);
    res.json({ imageUrl: imageUrl || null });
  } catch (err: any) {
    console.error('[ExternalMeta] album-art error:', err.message);
    res.status(502).json({ error: 'Failed to fetch album art' });
  }
});

router.get('/providers/external/genre-image', requireAuth, async (req, res) => {
  try {
    const genre = req.query.genre as string;
    if (!genre) return res.status(400).json({ error: 'Missing genre parameter' });
    const imageUrl = await getGenreImage(genre);
    res.json({ imageUrl: imageUrl || null });
  } catch (err: any) {
    console.error('[ExternalMeta] genre-image error:', err.message);
    res.status(502).json({ error: 'Failed to fetch genre image' });
  }
});

router.get('/providers/external/genre-info', requireAuth, async (req, res) => {
  try {
    const genre = req.query.genre as string;
    if (!genre) return res.status(400).json({ error: 'Missing genre parameter' });
    const info = await getGenreInfo(genre);
    res.json(info || {});
  } catch (err: any) {
    console.error('[ExternalMeta] genre-info error:', err.message);
    res.status(502).json({ error: 'Failed to fetch genre info' });
  }
});

router.get('/providers/external/lyrics', requireAuth, async (req, res) => {
  try {
    const track = req.query.track as string;
    const artist = req.query.artist as string;
    if (!track || !artist) return res.status(400).json({ error: 'Missing track or artist parameter' });
    const lyrics = await getLyrics(track, artist);
    res.json(lyrics || null);
  } catch (err: any) {
    console.error('[ExternalMeta] lyrics error:', err.message);
    res.status(502).json({ error: 'Failed to fetch lyrics' });
  }
});

// Image proxy — fetches external images server-side, streams back to avoid CORS
// No auth required — endpoint validates domain allowlist internally
router.get('/providers/external/proxy-image', async (req, res) => {
  try {
    const url = req.query.url as string;
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });

    // Only allow known external image domains
    const allowed = ['lastfm.freetls.fastly.net', 'images.genius.com', 'filepicker-images.genius.com', 'assets.genius.com', 'coverartarchive.org',
      'e.snmc.io', 'is1-ssl.mzstatic.com', 'is2-ssl.mzstatic.com', 'is3-ssl.mzstatic.com',
      'is4-ssl.mzstatic.com', 'is5-ssl.mzstatic.com'];
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    if (!allowed.some(d => parsed.hostname.endsWith(d) || parsed.hostname === d)) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }

    const imageRes = await fetch(url, {
      headers: { 'User-Agent': 'AuroraMediaServer/1.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!imageRes.ok) {
      return res.status(imageRes.status).send('Image not found');
    }

    const contentType = imageRes.headers.get('content-type') || 'image/jpeg';
    const cacheControl = 'public, max-age=2592000'; // 30 days
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', cacheControl);

    if (imageRes.body) {
      const reader = imageRes.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          res.write(value);
        }
      };
      await pump();
    } else {
      const buf = Buffer.from(await imageRes.arrayBuffer());
      res.send(buf);
    }
  } catch (err: any) {
    console.error('[ExternalMeta] proxy-image error:', err.message);
    res.status(502).json({ error: 'Failed to proxy image' });
  }
});

// Cache management (admin only)
router.post('/providers/external/refresh', requireAdmin, async (req, res) => {
  try {
    await clearExternalCache();
    res.json({ status: 'ok', message: 'External metadata cache cleared' });
  } catch (err: any) {
    console.error('[ExternalMeta] refresh error:', err.message);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

export default router;
