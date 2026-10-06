import { Router } from 'express';
import { createRateLimiter } from '../middleware/rateLimit';
import { randomBytes } from 'crypto';
import { getSystemSetting, setSystemSetting, getUserSetting, setUserSetting, getRepresentativeReleaseMbid, getArtistVideosCache } from '../database';
import { caaGetReleaseImages, pickMediumImage, pickFrontImage } from '../services/metadata/providers/musicbrainz';
import { lfmFetch, scrobbleTracks, updateNowPlaying, loveTrack, unloveTrack } from '../services/lastfm.service';
import {
  validateToken as validateLbToken,
  scrobbleTracks as lbScrobbleTracks,
  updateNowPlaying as lbUpdateNowPlaying,
} from '../services/listenbrainz.service';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { mbFetch, checkMbEnabled, refreshMbToken } from '../services/musicbrainz.service';
import { writeDebugLog } from '../services/debugLogger.service';
import { enrichArtistImagesInBackground } from '../services/artistImageEnrichment.service';
import {
  getArtistData,
  getArtistTopTracks,
  getAlbumData,
  getAlbumImage,
  getGenreImage,
  getGenreInfo,
  getLyrics,
  testLastFm,
  clearExternalCache,
  RateLimitError,
  ProviderError,
} from '../services/metadata';
import {
  isYouTubeEnabled,
  refreshArtistVideosIfStale,
  testYouTubeConnection,
  getMusicVideosForArtist,
  getMusicVideoForTrack,
  getCurrentDayUsage as getYoutubeDayUsage,
  YoutubeBudgetError,
  YoutubeConfigError,
} from '../services/youtube.service';

const router = Router();

// Provider routes proxy external services (Last.fm, Genius, MusicBrainz,
// image proxy). Apply a per-user/IP rate limit across every route here.
router.use(createRateLimiter({
  keyPrefix: 'providers',
  windowMs: 60 * 1000,
  max: 240,
  message: 'Too many provider requests. Try again later.',
}));

// Derive the public-facing origin of the backend.
//
// Read env lazily: this module may be imported before dotenv.config() runs,
// so capturing `process.env.SERVER_URL` into a module-top-level const would
// freeze in `undefined` and silently break all OAuth callbacks.
//
// Order of precedence:
//   1. SERVER_URL env var (explicit override for odd proxy setups)
//   2. req.protocol + req.get('host') — with `trust proxy` enabled in
//      server/index.ts these reflect X-Forwarded-Proto/X-Forwarded-Host
//      from the reverse proxy, giving the public HTTPS origin.
//   3. Final fallback for safety.
function getServerOrigin(req: import('express').Request): string {
  const envOverride = (process.env.SERVER_URL || '').trim();
  if (envOverride) return envOverride.replace(/\/+$/, '');
  const host = req.get('host');
  if (host) return `${req.protocol}://${host}`;
  return 'http://localhost:3001';
}

// ─── MusicBrainz OAuth2 Helpers ─────────────────────────────────────

// The redirect URI must exactly match what is registered in the MusicBrainz
// OAuth application. Allow an admin-supplied override so the app can work
// across dev (localhost:3000 via Vite), prod, and reverse-proxied deployments
// without code changes.
async function getMbRedirectUri(req: import('express').Request): Promise<string> {
  const override = (await getSystemSetting('musicBrainzRedirectUri')) as string | null;
  if (override && typeof override === 'string' && override.trim().length > 0) {
    return override.trim();
  }
  return `${getServerOrigin(req)}/api/providers/musicbrainz/callback`;
}

function getLastFmCallbackUri(req: import('express').Request): string {
  return `${getServerOrigin(req)}/api/providers/lastfm/callback`;
}

function maskLastFmApiKey(value: unknown): string {
  if (typeof value !== 'string' || value.length < 8) return 'missing';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function sanitizeProviderLogValue(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/([?&](?:token|code|state|cb_state|api_key|api_sig|client_secret|access_token|refresh_token|session_key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(?:token|code|state|cb_state|apiKey|api_key|apiSig|api_sig|clientSecret|client_secret|sharedSecret|shared_secret|sessionKey|session_key|accessToken|access_token|refreshToken|refresh_token|key)=\S+/gi, (match) => {
      const separator = match.includes('=') ? '=' : ':';
      return `${match.split(separator)[0]}${separator}[redacted]`;
    })
    .replace(/"((?:token|code|state|cb_state|apiKey|api_key|apiSig|api_sig|clientSecret|client_secret|sharedSecret|shared_secret|sessionKey|session_key|accessToken|access_token|refreshToken|refresh_token|key))"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt-redacted]')
    .slice(0, 1000);
}

function logLastFmOAuth(line: string) {
  const safeLine = sanitizeProviderLogValue(line);
  console.log(`[Last.fm OAuth] ${safeLine}`);
  try {
    writeDebugLog('lastfm-oauth.log', safeLine);
  } catch {}
}

function isPositiveIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

function isAllowedProxyImageUrl(parsed: URL): boolean {
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return false;
  }

  // Only allow known external image domains. Match exact hosts or real
  // subdomains with a dot boundary so lookalikes like evilcoverartarchive.org
  // cannot pass the suffix check.
  const allowedHosts = [
    'lastfm.freetls.fastly.net',
    'images.genius.com',
    'filepicker-images.genius.com',
    'assets.genius.com',
    'coverartarchive.org',
    'e.snmc.io',
    'is1-ssl.mzstatic.com',
    'is2-ssl.mzstatic.com',
    'is3-ssl.mzstatic.com',
    'is4-ssl.mzstatic.com',
    'is5-ssl.mzstatic.com',
    'ytimg.com', // YouTube video thumbnails (i.ytimg.com, i9.ytimg.com, …)
  ];

  const hostname = parsed.hostname.toLowerCase();
  return allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
}

// Scrobbling / now-playing are best-effort. A provider or transport failure
// (e.g. the origin can't reach the provider API — UND_ERR_SOCKET, timeout, 5xx)
// must not surface as a gateway 502 or block playback telemetry. Log with the
// underlying cause and soft-fail with 200 so the client — and any CDN in front —
// see a clean response instead of a scary error page.
function scrobbleSoftFail(res: import('express').Response, tag: string, err: any) {
  console.error(`${tag} error:`, err?.message, '| cause:', err?.cause?.code || err?.cause?.message || 'n/a');
  res.status(200).json({ ok: false, error: err?.message || 'request failed' });
}

function finishLastFmCallback(
  res: import('express').Response,
  returnBase: string,
  ok: boolean,
  error: string | null = null
) {
  if (ok) {
    res.redirect(`${returnBase}/?lfm_connected=1`);
  } else {
    res.redirect(`${returnBase}/?lfm_error=${encodeURIComponent(error || 'unknown')}`);
  }
}

// Sanitize a user-supplied app origin (http[s]://host[:port]). Returns null if invalid.
// Used to redirect the browser back to the frontend origin after OAuth callbacks,
// since in dev the frontend runs on a different port from the backend.
function sanitizeOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
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
    const redirectUri = await getMbRedirectUri(req);

    // Remember where the user came from for the post-callback redirect
    const appOrigin = sanitizeOrigin(req.query.origin);
    if (appOrigin) {
      await setSystemSetting('musicBrainzAppOrigin', appOrigin);
    }

    const url = new URL('https://musicbrainz.org/oauth2/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    // `profile` is required for the /oauth2/userinfo call that resolves the
    // username; `access_type=offline` is required for MusicBrainz to return a
    // refresh_token (it defaults to `online`, which issues an access token that
    // expires in ~1h with no way to refresh, silently breaking the connection).
    url.searchParams.set('scope', 'profile tag rating collection');
    url.searchParams.set('access_type', 'offline');
    // Encode userId in state so the unauthenticated callback can identify the user
    url.searchParams.set('state', userId ? `uid:${userId}` : 'aurora');

    res.json({ url: url.toString() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/providers/musicbrainz/callback', async (req, res) => {
  try {
    const appOrigin = (await getSystemSetting('musicBrainzAppOrigin')) as string | null;
    const returnBase = (appOrigin && typeof appOrigin === 'string' && appOrigin.trim()) ? appOrigin.trim() : getServerOrigin(req);

    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(`${returnBase}/?mb_error=${encodeURIComponent(error as string)}`);
    }

    if (!code) {
      return res.redirect(`${returnBase}/?mb_error=missing_code`);
    }

    const clientId = await getSystemSetting('musicBrainzClientId');
    const clientSecret = await getSystemSetting('musicBrainzClientSecret');
    if (!clientId || !clientSecret) {
      return res.redirect(`${returnBase}/?mb_error=credentials_not_configured`);
    }

    const redirectUri = await getMbRedirectUri(req);

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
      console.error('[MusicBrainz OAuth] Token exchange failed:', tokenRes.status, sanitizeProviderLogValue(errText));
      return res.redirect(`${returnBase}/?mb_error=token_exchange_failed`);
    }

    const tokenData = await tokenRes.json();

    await setSystemSetting('musicBrainzAccessToken', tokenData.access_token ?? '');
    await setSystemSetting('musicBrainzRefreshToken', tokenData.refresh_token ?? '');
    await setSystemSetting('musicBrainzTokenExpiresAt', Math.floor(Date.now() / 1000) + (tokenData.expires_in ?? 3600));
    await setSystemSetting('musicBrainzConnected', true);

    // Fetch username for display. Non-fatal: the connection is already
    // established above, so a userinfo failure must not abort the callback.
    // We still log it — a 403 here almost always means the `profile` scope
    // was missing from the authorize request.
    try {
      const meRes = await fetch('https://musicbrainz.org/oauth2/userinfo', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` },
      });
      if (meRes.ok) {
        const meData = await meRes.json();
        await setSystemSetting('musicBrainzUsername', meData.sub || 'Connected');
      } else {
        const errText = await meRes.text().catch(() => '');
        console.warn('[MusicBrainz OAuth] userinfo fetch failed:', meRes.status, sanitizeProviderLogValue(errText));
        await setSystemSetting('musicBrainzUsername', 'Connected');
      }
    } catch (err: any) {
      console.warn('[MusicBrainz OAuth] userinfo fetch error:', sanitizeProviderLogValue(err?.message));
      await setSystemSetting('musicBrainzUsername', 'Connected');
    }

    res.redirect(`${returnBase}/?mb_connected=1`);
  } catch (err: any) {
    console.error('[MusicBrainz OAuth] Callback error:', err.message);
    res.redirect(`${getServerOrigin(req)}/?mb_error=internal_error`);
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
    const redirectUri = await getMbRedirectUri(req);

    res.json({
      connected: connected === true || connected === 'true',
      username: username || null,
      expiresAt: expiresAt ? Number(expiresAt) : null,
      redirectUri,
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
    if (!isPositiveIntegerString(id)) {
      return res.status(400).json({ error: 'Invalid artist id' });
    }

    const apiKey = req.body.apiKey || await getSystemSetting('geniusApiKey');
    if (!apiKey) return res.status(400).json({ error: 'Genius API key not configured' });

    const geniusRes = await fetch(`https://api.genius.com/artists/${encodeURIComponent(id)}`, {
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
    const sharedSecret = (await getSystemSetting('lastFmSharedSecret')) || '';
    if (!apiKey) return res.status(400).json({ error: 'Last.fm API key not configured' });
    if (!sharedSecret) return res.status(400).json({ error: 'Last.fm Shared Secret not configured' });

    // Last.fm callback redirects proved unreliable in production, so the
    // connect flow uses Last.fm's token authorization: get a request token,
    // send the user to approve it, then poll auth.getSession until authorized.
    // Keep state for compatibility with the callback route and diagnostics.
    const pendingState = randomBytes(16).toString('hex');
    await setUserSetting(userId, 'lastFmPendingState', pendingState);

    // Remember where the user came from so we can redirect back to the frontend
    // after the callback (in dev the backend and frontend run on different ports).
    const appOrigin = sanitizeOrigin(req.query.origin);
    if (appOrigin) {
      await setUserSetting(userId, 'lastFmAppOrigin', appOrigin);
    }

    const tokenRes = await lfmFetch(userId, 'auth.getToken', {}, { apiKey, sharedSecret, sessionKey: '' });
    const requestToken = tokenRes.token;
    if (!requestToken || typeof requestToken !== 'string') {
      logLastFmOAuth(`authorize_error user=${userId} reason=missing_request_token response=${JSON.stringify(tokenRes).slice(0, 300)}`);
      return res.status(502).json({ error: 'Last.fm did not return an authorization token' });
    }

    await setUserSetting(userId, 'lastFmPendingToken', requestToken);

    const callbackUrl = `${getLastFmCallbackUri(req)}?cb_user=${encodeURIComponent(userId)}&cb_state=${encodeURIComponent(pendingState)}`;
    const authUrl = `https://www.last.fm/api/auth?api_key=${apiKey}&token=${encodeURIComponent(requestToken)}`;
    logLastFmOAuth(`authorize user=${userId} apiKey=${maskLastFmApiKey(apiKey)} mode=token callback=${callbackUrl} appOrigin=${appOrigin || 'none'}`);
    res.json({ url: authUrl, mode: 'token' });
  } catch (err: any) {
    console.error('[Last.fm] authorize error:', err.message);
    logLastFmOAuth(`authorize_error error=${err.message || 'unknown'}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers/lastfm/complete', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const requestToken = await getUserSetting(userId, 'lastFmPendingToken');
    if (!requestToken || typeof requestToken !== 'string') {
      logLastFmOAuth(`complete_reject user=${userId} reason=missing_pending_token`);
      return res.status(400).json({ error: 'No pending Last.fm authorization token' });
    }

    const apiKey = await getSystemSetting('lastFmApiKey');
    const sharedSecret = (await getSystemSetting('lastFmSharedSecret')) || '';
    if (!apiKey) return res.status(400).json({ error: 'Last.fm API key not configured' });
    if (!sharedSecret) return res.status(400).json({ error: 'Last.fm Shared Secret not configured' });

    let sessionRes: any;
    try {
      sessionRes = await lfmFetch(userId, 'auth.getSession', { token: requestToken }, { apiKey, sharedSecret, sessionKey: '' });
    } catch (err: any) {
      const message = err.message || 'session_exchange_failed';
      if (message.includes('Last.fm error 14')) {
        logLastFmOAuth(`complete_pending user=${userId}`);
        return res.status(202).json({ status: 'pending' });
      }

      logLastFmOAuth(`complete_reject user=${userId} reason=session_exchange_failed apiKey=${maskLastFmApiKey(apiKey)} error=${message}`);
      return res.status(400).json({ error: message });
    }

    if (!sessionRes.session?.key) {
      logLastFmOAuth(`complete_reject user=${userId} reason=session_failed response=${JSON.stringify(sessionRes).slice(0, 300)}`);
      return res.status(400).json({ error: 'Last.fm session exchange failed' });
    }

    await setUserSetting(userId, 'lastFmSessionKey', sessionRes.session.key);
    await setUserSetting(userId, 'lastFmUsername', sessionRes.session.name || '');
    await setUserSetting(userId, 'lastFmConnected', true);
    await setUserSetting(userId, 'lastFmPendingState', '');
    await setUserSetting(userId, 'lastFmPendingToken', '');

    logLastFmOAuth(`complete_success user=${userId} lastFmUser=${sessionRes.session.name || 'unknown'}`);
    res.json({ status: 'ok', username: sessionRes.session.name || '' });
  } catch (err: any) {
    console.error('[Last.fm] complete error:', err.message);
    logLastFmOAuth(`complete_error error=${err.message || 'unknown'}`);
    res.status(500).json({ error: err.message || 'Failed to complete Last.fm authorization' });
  }
});

router.get('/providers/lastfm/callback', async (req, res) => {
  try {
    const userId = req.query.cb_user as string;
    const callbackState = req.query.cb_state as string;
    const appOrigin = userId ? (await getUserSetting(userId, 'lastFmAppOrigin')) as string | null : null;
    const returnBase = (appOrigin && typeof appOrigin === 'string' && appOrigin.trim()) ? appOrigin.trim() : getServerOrigin(req);
    const hasToken = typeof req.query.token === 'string' && req.query.token.length > 0;
    logLastFmOAuth(`callback_hit user=${userId || 'missing'} hasState=${callbackState ? 'yes' : 'no'} hasToken=${hasToken ? 'yes' : 'no'} returnBase=${returnBase}`);

    if (!userId) {
      logLastFmOAuth('callback_reject reason=missing_user');
      return finishLastFmCallback(res, returnBase, false, 'missing_user');
    }
    if (!callbackState) {
      logLastFmOAuth(`callback_reject user=${userId} reason=missing_state`);
      return finishLastFmCallback(res, returnBase, false, 'missing_state');
    }

    const { token, error } = req.query;

    if (error) {
      logLastFmOAuth(`callback_reject user=${userId} reason=lastfm_error error=${error as string}`);
      return finishLastFmCallback(res, returnBase, false, error as string);
    }

    if (!token) {
      logLastFmOAuth(`callback_reject user=${userId} reason=missing_token`);
      return finishLastFmCallback(res, returnBase, false, 'missing_token');
    }

    // Verify the callback belongs to the auth flow we initiated for this user.
    const pendingState = await getUserSetting(userId, 'lastFmPendingState');
    if (!pendingState || pendingState !== callbackState) {
      logLastFmOAuth(`callback_reject user=${userId} reason=state_mismatch pending=${pendingState ? 'yes' : 'no'}`);
      return finishLastFmCallback(res, returnBase, false, 'state_mismatch');
    }

    const apiKey = await getSystemSetting('lastFmApiKey');
    const sharedSecret = (await getSystemSetting('lastFmSharedSecret')) || '';

    if (!apiKey) {
      logLastFmOAuth(`callback_reject user=${userId} reason=no_api_key`);
      return finishLastFmCallback(res, returnBase, false, 'no_api_key');
    }

    // Exchange token for session key
    let sessionRes: any;
    try {
      sessionRes = await lfmFetch(userId, 'auth.getSession', { token: token as string }, { apiKey, sharedSecret, sessionKey: '' });
    } catch (err: any) {
      logLastFmOAuth(`callback_reject user=${userId} reason=session_exchange_failed apiKey=${maskLastFmApiKey(apiKey)} error=${err.message || 'unknown'}`);
      return finishLastFmCallback(res, returnBase, false, err.message || 'session_exchange_failed');
    }

    if (!sessionRes.session?.key) {
      logLastFmOAuth(`callback_reject user=${userId} reason=session_failed response=${JSON.stringify(sessionRes).slice(0, 300)}`);
      return finishLastFmCallback(res, returnBase, false, 'session_failed');
    }

    await setUserSetting(userId, 'lastFmSessionKey', sessionRes.session.key);
    await setUserSetting(userId, 'lastFmUsername', sessionRes.session.name || '');
    await setUserSetting(userId, 'lastFmConnected', true);
    await setUserSetting(userId, 'lastFmPendingState', '');
    await setUserSetting(userId, 'lastFmPendingToken', '');

    logLastFmOAuth(`callback_success user=${userId} lastFmUser=${sessionRes.session.name || 'unknown'}`);
    finishLastFmCallback(res, returnBase, true);
  } catch (err: any) {
    console.error('[Last.fm] callback error:', err.message);
    const userId = req.query.cb_user as string;
    const appOrigin = userId ? (await getUserSetting(userId, 'lastFmAppOrigin')) as string | null : null;
    const returnBase = (appOrigin && typeof appOrigin === 'string' && appOrigin.trim()) ? appOrigin.trim() : getServerOrigin(req);
    logLastFmOAuth(`callback_error user=${userId || 'missing'} error=${err.message || 'unknown'}`);
    finishLastFmCallback(res, returnBase, false, 'internal_error');
  }
});

router.post('/providers/lastfm/disconnect', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    await setUserSetting(userId, 'lastFmSessionKey', '');
    await setUserSetting(userId, 'lastFmUsername', '');
    await setUserSetting(userId, 'lastFmConnected', false);
    await setUserSetting(userId, 'lastFmPendingState', '');
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
    const callbackUri = getLastFmCallbackUri(req);

    res.json({
      connected: connected === true || connected === 'true',
      username: username || null,
      scrobbleEnabled: scrobbleEnabled === true || scrobbleEnabled === 'true',
      hasApiKey,
      callbackUri,
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
    scrobbleSoftFail(res, '[Last.fm] scrobble', err);
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
    scrobbleSoftFail(res, '[Last.fm] now-playing', err);
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
router.post('/providers/lastfm/test', async (req, res) => {
  try {
    const apiKey = req.body.apiKey || await getSystemSetting('lastFmApiKey') || '';
    const sharedSecret = req.body.sharedSecret || await getSystemSetting('lastFmSharedSecret') || '';
    const result = await testLastFm(apiKey, sharedSecret);
    if (result.status === 'ok') {
      res.json(result);
    } else {
      res.status(result.error === 'No API key configured' ? 400 : 502).json(result);
    }
  } catch (err: any) {
    res.status(502).json({ status: 'error', error: err.message || 'Network error' });
  }
});

// ─── ListenBrainz Routes (per-user token-based scrobbling) ──────────

router.post('/providers/listenbrainz/connect', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Missing token' });
    }

    const result = await validateLbToken(token.trim());
    if (!result.valid) {
      return res.status(400).json({ error: result.message || 'Invalid ListenBrainz token' });
    }

    await setUserSetting(userId, 'listenBrainzUserToken', token.trim());
    await setUserSetting(userId, 'listenBrainzUsername', result.username || '');
    await setUserSetting(userId, 'listenBrainzConnected', true);

    res.json({ status: 'ok', username: result.username || null });
  } catch (err: any) {
    console.error('[ListenBrainz] connect error:', err.message);
    res.status(502).json({ error: err.message || 'Network error' });
  }
});

router.post('/providers/listenbrainz/disconnect', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    await setUserSetting(userId, 'listenBrainzUserToken', '');
    await setUserSetting(userId, 'listenBrainzUsername', '');
    await setUserSetting(userId, 'listenBrainzConnected', false);

    res.json({ status: 'ok' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/providers/listenbrainz/status', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const connected = await getUserSetting(userId, 'listenBrainzConnected');
    const username = await getUserSetting(userId, 'listenBrainzUsername');
    const scrobbleEnabled = await getUserSetting(userId, 'listenBrainzScrobbleEnabled');

    res.json({
      connected: connected === true || connected === 'true',
      username: username || null,
      scrobbleEnabled: scrobbleEnabled === true || scrobbleEnabled === 'true',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers/listenbrainz/scrobble', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const connected = await getUserSetting(userId, 'listenBrainzConnected');
    if (connected !== true && connected !== 'true') {
      return res.status(400).json({ error: 'ListenBrainz not connected' });
    }

    const { tracks } = req.body;
    if (!tracks || !Array.isArray(tracks) || tracks.length === 0) {
      return res.status(400).json({ error: 'Missing tracks array' });
    }

    const result = await lbScrobbleTracks(userId, tracks);
    res.json(result);
  } catch (err: any) {
    scrobbleSoftFail(res, '[ListenBrainz] scrobble', err);
  }
});

router.post('/providers/listenbrainz/now-playing', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const connected = await getUserSetting(userId, 'listenBrainzConnected');
    if (connected !== true && connected !== 'true') {
      return res.status(400).json({ error: 'ListenBrainz not connected' });
    }

    const { artist, track, album, duration, trackNumber, mbid } = req.body;
    if (!artist || !track) return res.status(400).json({ error: 'Missing artist or track' });

    const result = await lbUpdateNowPlaying(userId, { artist, track, album, duration, trackNumber, mbid });
    res.json(result);
  } catch (err: any) {
    scrobbleSoftFail(res, '[ListenBrainz] now-playing', err);
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

router.get('/providers/external/artist-top-tracks', requireAuth, async (req, res) => {
  try {
    const name = req.query.name as string;
    if (!name) return res.status(400).json({ error: 'Missing name parameter' });
    const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 25;
    const tracks = await getArtistTopTracks(name, Number.isFinite(limit) ? limit : 25);
    res.json({ tracks });
  } catch (err: any) {
    console.error('[ExternalMeta] artist top tracks error:', err.message);
    res.status(502).json({ error: 'Failed to fetch artist top tracks' });
  }
});

router.get('/providers/external/album', requireAuth, async (req, res) => {
  try {
    const album = req.query.album as string;
    const artist = req.query.artist as string;
    if (!album || !artist) return res.status(400).json({ error: 'Missing album or artist parameter' });
    const mbid = (req.query.mbid as string) || undefined;
    const data = await getAlbumData(album, artist, mbid);
    res.json(data);
  } catch (err: any) {
    console.error('[ExternalMeta] album error:', err.message);
    res.status(502).json({ error: 'Failed to fetch album data' });
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

// Cover Art Archive disc/label art for the album disc view. Resolves the
// release MBID from the album's tracks (tracks.mb_album_id) — the only
// reliable release MBID in the library — then returns the typed Medium
// (disc) and Front images. Both null is normal; the client renders a
// procedural label from local cover art in that case.
router.get('/providers/album/media-image', requireAuth, async (req, res) => {
  try {
    const albumId = req.query.albumId as string;
    if (!albumId) return res.status(400).json({ error: 'Missing albumId parameter' });
    if (!(await checkMbEnabled())) return res.json({ releaseMbid: null, mediumUrl: null, frontUrl: null });

    const discIndex = Number(req.query.discIndex) || 0;
    const releaseMbid = await getRepresentativeReleaseMbid(albumId);
    if (!releaseMbid) return res.json({ releaseMbid: null, mediumUrl: null, frontUrl: null });

    const images = await caaGetReleaseImages(releaseMbid);
    const medium = pickMediumImage(images, discIndex);
    const front = pickFrontImage(images);
    res.json({
      releaseMbid,
      // 500px is ample for the hero disc (~240px, retina) and far lighter
      // than the full-res scan; fall back up the ladder when absent.
      mediumUrl: medium?.thumbnails?.['500'] || medium?.thumbnails?.['1200'] || medium?.image || null,
      frontUrl: front?.thumbnails?.['500'] || front?.image || null,
    });
  } catch (err: any) {
    console.error('[ExternalMeta] media-image error:', err.message);
    res.status(502).json({ error: 'Failed to fetch disc art' });
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

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    // Some providers (notably the Cover Art Archive API) return http:// image
    // URLs. Upgrade to https before the allowlist check and fetch: every allowed
    // host serves https, and we never want to pull cover art over plaintext. This
    // is why the disc/medium art (raw CAA API URLs) 403'd while the front cover
    // (built as an https URL) worked.
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
    }
    if (!isAllowedProxyImageUrl(parsed)) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }

    const imageRes = await fetch(parsed.toString(), {
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
    // The Artists grid renders from the cached artists.image_url (no per-card
    // refetch), so after wiping the cache we must repopulate it or the grid
    // would fall back to initials forever. Bounded + throttled, and a no-op when
    // no provider is configured (library is canon).
    enrichArtistImagesInBackground();
    res.json({ status: 'ok', message: 'External metadata cache cleared' });
  } catch (err: any) {
    console.error('[ExternalMeta] refresh error:', err.message);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// ─── YouTube Music Videos ─────────────────────────────────────────────

// Artist-page rail. Mirrors the concerts artist route: serve cached matches
// always; refresh from YouTube only when enabled and the cache is stale.
router.get('/providers/external/artist-videos/:artistId', requireAuth, async (req, res) => {
  try {
    const artistId = String(req.params.artistId);

    if (!(await isYouTubeEnabled())) {
      const videos = await getMusicVideosForArtist(artistId, 30);
      return res.json({ videos, refreshed: false, stale: false, disabled: true, lastFetchedAt: null });
    }

    let refreshed = false;
    let stale = false;
    try {
      const r = await refreshArtistVideosIfStale(artistId);
      refreshed = r.refreshed;
    } catch (err) {
      if (err instanceof YoutubeBudgetError) {
        stale = true;
      } else if (err instanceof YoutubeConfigError) {
        // No key — fall back to whatever cache exists.
      } else {
        // Don't fail the request; serve cache and signal staleness.
        stale = true;
      }
    }

    const videos = await getMusicVideosForArtist(artistId, 30);
    const cache = await getArtistVideosCache(artistId);
    res.json({
      videos,
      refreshed,
      stale,
      lastFetchedAt: cache?.fetched_at || null,
    });
  } catch (err: any) {
    console.error('[YouTube] artist-videos error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Mobile background lookup. Reuse a match or populate the artist cache using
// the same freshness, concurrency and quota limits as the artist-page rail.
router.get('/providers/external/track-video/:trackId', requireAuth, async (req, res) => {
  try {
    const video = await getMusicVideoForTrack(String(req.params.trackId));
    res.json({ video: video || null });
  } catch (err: any) {
    console.error('[YouTube] track-video error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/providers/youtube/status', requireAdmin, async (_req, res) => {
  try {
    const apiKey = await getSystemSetting('youtubeApiKey');
    const enabled = await getSystemSetting('youtubeEnabled');
    const usage = await getYoutubeDayUsage();
    res.json({ hasKey: !!apiKey, enabled: !!enabled, usage });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers/youtube/test', requireAdmin, async (_req, res) => {
  try {
    const result = await testYouTubeConnection();
    if (result.ok) {
      res.json({ status: 'ok', sample: result.sample });
    } else {
      res.status(400).json({ status: 'error', error: result.error });
    }
  } catch (err: any) {
    res.status(502).json({ status: 'error', error: err.message || 'Network error' });
  }
});

export default router;
