// NOTE: dotenv.config() must run before any import that reads process.env
// at module-top level (e.g. route files capturing env vars into `const`s).
// If it runs later, those modules see `undefined` and silently break —
// that bug caused OAuth callbacks to use http://localhost:3001 instead of
// the configured SERVER_URL.
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import fs from 'fs';
import path from 'path';
import dns from 'dns';
import crypto from 'crypto';
import { spawn } from 'child_process';

// Force IPv4 locally to prevent Last.fm IPv6 blackholing hangs
dns.setDefaultResultOrder('ipv4first');
import { requireAuth as jwtAuthMiddleware } from './middleware/auth';
import { createRateLimiter } from './middleware/rateLimit';
import { initDatabaseConnection, getSessionHistory } from './state';
import { calculateNextInfinityTrack } from './services/recommendation.service';
import {
  getConfiguredAllowedOrigins,
  isCorsOriginAllowed,
  normalizeAllowedOrigins,
  parseBareOrigin,
} from './utils/corsOrigin';

// Route imports
import authRoutes from './routes/auth.routes';
import adminRoutes from './routes/admin.routes';
import libraryRoutes from './routes/library.routes';
import playbackRoutes from './routes/playback.routes';
import settingsRoutes from './routes/settings.routes';
import hubRoutes from './routes/hub.routes';
import playlistsRoutes from './routes/playlists.routes';
import publicRoutes from './routes/public.routes';
import artistsRoutes from './routes/artists.routes';
import albumsRoutes from './routes/albums.routes';
import genresRoutes from './routes/genres.routes';
import mediaRoutes from './routes/media.routes';
import providersRoutes from './routes/providers.routes';
import concertsRoutes from './routes/concerts.routes';
import filterRoutes from './routes/filter.routes';
import subsonicRoutes from './routes/subsonic.routes';

const app = express();
const port = process.env.PORT || 3001;
const isProduction = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Honor X-Forwarded-Proto / X-Forwarded-Host from reverse proxies (nginx,
// Traefik, Caddy, cloud load balancers) so req.protocol + req.get('host')
// reflect the public-facing URL. Required for OAuth callback URL construction.
// NOTE: this also makes req.ip the client-controlled left-most X-Forwarded-For
// entry — security decisions (rate limiting, auth logging) must use
// getTrustedClientIp from middleware/clientIp.ts (TRUSTED_PROXY_MODE) instead.
app.set('trust proxy', true);

// Allowed origins setup
const allowedOrigins = getConfiguredAllowedOrigins(process.env.ALLOWED_ORIGINS, port);
// If a custom Cast receiver origin is set, add it to CORS whitelist so
// the receiver can fetch HLS segments from our media server
if (process.env.CAST_RECEIVER_ORIGIN && !allowedOrigins.includes(process.env.CAST_RECEIVER_ORIGIN)) {
  allowedOrigins.push(process.env.CAST_RECEIVER_ORIGIN);
}

const normalizedAllowedOrigins = normalizeAllowedOrigins(allowedOrigins);

function isAllowedCorsOrigin(origin: string): boolean {
  return isCorsOriginAllowed(origin, normalizedAllowedOrigins);
}

// A browser cannot read a normal CORS rejection, so expose one non-sensitive
// boot probe before the global CORS gate. It tells the app only whether its own
// origin is configured, without exposing the rest of the allow-list. Reflecting
// the request Origin is safe here because blocked callers receive no application
// data, only the reason all subsequent API calls would be denied.
app.get('/api/origin-status', (req, res) => {
  const headerOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
  const queryOrigin = typeof req.query.origin === 'string' ? req.query.origin : null;
  const candidate = headerOrigin || queryOrigin || `${req.protocol}://${req.get('host')}`;
  const parsedOrigin = parseBareOrigin(candidate);

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (headerOrigin) {
    const parsedHeaderOrigin = parseBareOrigin(headerOrigin);
    if (parsedHeaderOrigin) {
      res.setHeader('Access-Control-Allow-Origin', parsedHeaderOrigin.origin);
      res.setHeader('Vary', 'Origin');
    }
  }

  if (!parsedOrigin) {
    return res.status(400).json({
      allowed: false,
      origin: null,
      code: 'INVALID_ORIGIN',
    });
  }

  const origin = parsedOrigin.origin;
  const allowed = isAllowedCorsOrigin(origin);
  return res.status(allowed ? 200 : 403).json({
    allowed,
    origin,
    code: allowed ? 'ORIGIN_ALLOWED' : 'ORIGIN_NOT_ALLOWED',
  });
});

app.use(cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || isAllowedCorsOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  allowedHeaders: ['Content-Type', 'Range', 'Accept-Encoding', 'Authorization'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']
}));
// gzip JSON/text responses. The library/playlist/hub payloads are large,
// highly compressible JSON; without this they ship raw (e.g. /api/library is
// ~26MB), holding a connection slot for its whole download and — under the
// HTTP/1.1 6-connections-per-origin cap — queueing every other request behind
// it. zlib runs on the libuv threadpool, so this doesn't block the event loop.
// Range requests (audio streaming) are skipped by compression automatically.
app.use(compression({
  filter: (req, res) => {
    // Never compress Server-Sent Events: compression buffers the stream and
    // would stall real-time scan/progress updates (text/event-stream otherwise
    // matches the default text/* compressible rule).
    if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));
// Content-Security-Policy (enforcing). The only inline scripts we serve are
// index.html's Cast bootstrap plus the optional window.__CAST_APP_ID injection,
// so script-src drops 'unsafe-inline' in favour of sha256 hashes computed from the
// exact served HTML at startup (see the dist block below).
//
// The Cast receiver page (receiver.html / /cast-receiver) is served with NO CSP
// at all. It only ever runs inside a Cast device's runtime, whose media player
// needs its own inline bootstrap script AND eval/WebAssembly at media-load time —
// under the app CSP the receiver either fails to boot (SESSION_START_FAILED) or
// boots and then fails every LOAD with a bare error 905. It is a static page with
// no user-generated content, so a CSP buys nothing there.
// External script hosts:
//   - www.gstatic.com (scheme-less, NOT https://): the Cast SDK lazy-loads its
//     framework over http:// on insecure origins (http://localhost / LAN IP). A
//     scheme-less host matches the page's scheme, so it allows http+https on an
//     http origin but stays https-only on a real HTTPS deployment.
//   - youtube + s.ytimg.com: YouTube IFrame API loader + its widget script
//     (served from either host depending on YouTube's rollout)
// Other directives:
//   - frame youtube/youtube-nocookie: Music Videos rail embeds
//   - connect nominatim.openstreetmap.org: Live Music location lookup (client fetch);
//     connect gstatic: Cast SDK. The service worker is served by us so it inherits
//     this CSP, and its Workbox runtime-caching fetch()es Google Fonts — so the font
//     hosts must be in connect-src too, not just style-src/font-src (which only cover
//     the <link>). style/font: Google Fonts.
//   - img https:/data:/blob: cover art (local + Cover Art Archive + providers), canvases
//   - media/worker blob: HLS via hls.js (MSE) + the service worker
//   - the ogl WebGL aurora renders to a canvas and needs no extra directives.
// style-src KEEPS 'unsafe-inline': React sets dynamic inline style="" attributes
// (theming CSS vars, cover-art colours, the aurora) that can't be hashed, and
// style-src-attr isn't reliable cross-browser. Style injection is low-risk versus
// the script injection these hashes lock down.
const sha256Base64 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('base64');

// inlineScriptSources are sha256 hashes (or a keyword like 'unsafe-inline') allowed
// to run as inline scripts.
const buildCsp = (inlineScriptSources: string[]) => [
  "default-src 'self'",
  // challenges.cloudflare.com hosts the Turnstile sign-in captcha (script,
  // challenge iframe, and its XHR). Allowed unconditionally — CSP is computed
  // at startup, and the extra host is inert while the captcha is disabled.
  `script-src ${["'self'", ...inlineScriptSources, 'www.gstatic.com', 'https://www.youtube.com', 'https://s.ytimg.com', 'https://challenges.cloudflare.com'].join(' ')}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: data:",
  "connect-src 'self' www.gstatic.com https://nominatim.openstreetmap.org https://fonts.googleapis.com https://fonts.gstatic.com https://challenges.cloudflare.com",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

// sha256 of every inline <script> (one without a src attribute) in the served HTML,
// so exactly those scripts are allowed and any injected inline script is blocked.
const inlineScriptHashes = (html: string): string[] => {
  const hashes: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (/\bsrc\s*=/i.test(m[1] || '')) continue; // external script — host-allowlisted, not inline
    hashes.push(`'sha256-${sha256Base64(m[2])}'`);
  }
  return hashes;
};

// Default retains 'unsafe-inline' as a safe fallback (dev with no dist build, or an
// index.html read failure). Production tightens this to the script hashes in the
// dist block below, once the exact served HTML is known.
let cspHeader = buildCsp(["'unsafe-inline'"]);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', cspHeader);
  if (isProduction && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve static files from the 'dist' directory in production
const distPath = path.join(__dirname, '../dist');
if (fs.existsSync(distPath)) {
  console.log(`[Server] Serving static files from ${distPath}`);

  // The Cast receiver page gets NO CSP (see the CSP comment above): the Cast
  // runtime's media player needs eval/WebAssembly and its own inline script, and
  // an app CSP on this page has broken casting twice (boot, then every LOAD).
  const receiverPath = path.join(distPath, 'receiver.html');

  app.use(express.static(distPath, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath === receiverPath) {
        res.removeHeader('Content-Security-Policy');
      }
    },
  }));

  // Serve custom Cast receiver HTML at /cast-receiver
  if (fs.existsSync(receiverPath)) {
    app.get('/cast-receiver', (_req, res) => {
      res.removeHeader('Content-Security-Policy');
      res.sendFile(receiverPath);
    });
    console.log('[Server] Cast receiver available at /cast-receiver');
  }

  // Pre-cache index.html with optional Cast app ID injection
  const castAppId = process.env.CAST_RECEIVER_APP_ID || '';
  let cachedIndexHtml: string | null = null;
  try {
    const rawHtml = fs.readFileSync(path.join(distPath, 'index.html'), 'utf8');
    if (castAppId) {
      // Inject the Cast app ID synchronously before any scripts load
      cachedIndexHtml = rawHtml.replace(
        '</head>',
        `  <script>window.__CAST_APP_ID = ${JSON.stringify(castAppId)};</script>\n  </head>`
      );
      console.log(`[Server] Custom Cast receiver enabled (app ID: ${castAppId.slice(0, 6)}…)`);
    } else {
      cachedIndexHtml = rawHtml;
    }
    // Now that we know the exact HTML we serve, lock script-src to its inline
    // scripts (Cast bootstrap + optional app-ID injection) and drop 'unsafe-inline'.
    const hashes = inlineScriptHashes(cachedIndexHtml);
    cspHeader = buildCsp(hashes);
    console.log(`[Server] CSP script-src locked to ${hashes.length} inline hash(es)`);
  } catch (e) {
    console.warn('[Server] Failed to pre-cache index.html, will read on each request');
  }

  // ── Invite page: inject OG / Twitter card meta tags for social previews ──
  // Social crawlers don't execute JS, so we inject the meta tags server-side
  // for /invite/:token before the generic SPA catch-all handles it.
  // Public, pre-auth endpoint that performs DB lookups to build a social
  // preview — rate-limit by IP to prevent invite-token probing / abuse.
  const invitepreviewRateLimit = createRateLimiter({
    keyPrefix: 'invite-preview',
    windowMs: 60 * 1000,
    max: 60,
    message: 'Too many requests. Try again later.',
  });
  app.get('/invite/:token', invitepreviewRateLimit, async (req, res) => {
    const token = String(req.params.token);
    const origin = `${req.protocol}://${req.get('host')}`;

    // Try to resolve inviter name for a personalised preview
    let inviterName = 'someone';
    try {
      const { getInvite, getUserById, isInviteValid } = await import('./database');
      const valid = await isInviteValid(token);
      if (valid) {
        const invite = await getInvite(token);
        if (invite?.created_by) {
          const inviter = await getUserById(invite.created_by);
          if (inviter?.username) inviterName = inviter.username;
        }
      }
    } catch (_) {
      // Non-fatal — fall back to generic copy
    }

    const safeInviterName = escapeHtml(inviterName);
    const title = `${safeInviterName} invited you to Aurora`;
    const description = `Join ${safeInviterName}'s Aurora music library — your own private, AI-powered music player.`;
    const imageUrl = `${origin}/apple-touch-icon.png`;
    const inviteUrl = `${origin}/invite/${encodeURIComponent(token)}`;
    const safeImageUrl = escapeHtml(imageUrl);
    const safeInviteUrl = escapeHtml(inviteUrl);

    const metaInjection = `
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${safeInviteUrl}" />
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:image" content="${safeImageUrl}" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${safeImageUrl}" />
    <title>${title}</title>`;

    const baseHtml = cachedIndexHtml || (fs.existsSync(path.join(distPath, 'index.html'))
      ? fs.readFileSync(path.join(distPath, 'index.html'), 'utf8')
      : null);

    if (!baseHtml) return res.status(500).send('Server error');

    const html = baseHtml.replace('</head>', `${metaInjection}\n  </head>`);
    res.type('html').send(html);
  });

  // Catch-all route to serve index.html for React SPA routing
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/rest')) {
      return next();
    }
    if (cachedIndexHtml) {
      res.type('html').send(cachedIndexHtml);
    } else {
      res.sendFile(path.join(distPath, 'index.html'));
    }
  });
}


// Public runtime config consumed by the client at boot/runtime.
// This must stay outside JWT auth so PWA-served or cached shells can still
// discover the active Cast receiver configuration deterministically.
app.get('/api/client-config', (_req, res) => {
  res.json({
    castReceiverAppId: (process.env.CAST_RECEIVER_APP_ID || '').trim(),
  });
});

// OpenSubsonic clients authenticate with Aurora-managed API keys, not JWTs.
// Mount /rest before the global JWT middleware so third-party clients can
// reach it without Aurora browser session tokens.
app.use('/rest', subsonicRoutes);

// Public, unauthenticated routes (e.g. shared playlist snapshots). Mounted before
// the global JWT middleware; the module is self-contained and read-only.
app.use('/api/public', publicRoutes);

// Apply JWT auth middleware to all API routes
app.use(jwtAuthMiddleware);

// ─── Mount Route Modules ──────────────────────────────────────────────

// Auth & Setup (auth routes at /api/auth/*, setup routes at /api/setup/*)
app.use('/api/auth', authRoutes); // mounts /api/auth/login, /api/auth/register, etc.
app.use('/api', authRoutes);      // mounts /api/setup/status, /api/setup/complete

// Admin (users, invites, db control)
app.use('/api/admin', adminRoutes);

// Library (scan, add, remove, list)
app.use('/api/library', libraryRoutes);

// Playback (history, record, skip, recommend)
app.use('/api/playback', playbackRoutes);

// Settings & Genre Matrix
app.use('/api', settingsRoutes);

// Hub (LLM playlists)
app.use('/api/hub', hubRoutes);

// Playlists
app.use('/api/playlists', playlistsRoutes);

// Entities (artists, albums, genres)
app.use('/api/artists', artistsRoutes);
app.use('/api/albums', albumsRoutes);
app.use('/api/genres', genresRoutes);

// Media (stream, art)
app.use('/api', mediaRoutes);

// Providers (Genius proxy)
app.use('/api', providersRoutes);

// Concerts / Jambase
app.use('/api', concertsRoutes);
app.use('/api/filter', filterRoutes);

// Recommend (Infinity Mode next track)
app.post('/api/recommend', async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { sessionHistoryTrackIds: clientHistory, settings } = req.body;

    const history = userId
      ? getSessionHistory(userId)
      : (clientHistory || []);

    const nextTrack = await calculateNextInfinityTrack(
      history,
      settings || {}
    );
    res.json({ track: nextTrack });
  } catch (error) {
    console.error('Infinity recommendation error:', error);
    res.status(500).json({ error: 'Failed to compute next track' });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  const { dbConnected } = require('./state');
  const { initDB } = require('./database');
  const { getContainerStatus, getConfiguredDatabaseInfo } = require('./services/containerControl.service');
  
  let dbLatency = -1;
  let dbLiveness = false;
  let containerStatus = null;

  if (dbConnected) {
    try {
      const start = Date.now();
      const db = await initDB();
      await db.query('SELECT 1');
      dbLatency = Date.now() - start;
      dbLiveness = true;
    } catch (e) {
      dbLiveness = false;
    }
  }

  try {
    const config = getConfiguredDatabaseInfo();
    containerStatus = await getContainerStatus(config.name);
  } catch (e) {}

  res.json({ 
    status: 'ok', 
    dbConnected, 
    dbLiveness,
    dbLatency: dbLatency !== -1 ? `${dbLatency}ms` : 'N/A',
    container: containerStatus ? {
      status: containerStatus.status,
      runtime: require('./services/containerControl.service').containerRuntime || 'unknown',
      image: containerStatus.image
    } : null,
    message: 'Aurora Media Server is running!' 
  });
});

// Pre-flight check: warn at startup if FFmpeg is missing
function checkFfmpegAvailability() {
  const test = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
  test.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn('[Startup] FFmpeg not found in PATH. WMA files will not play. Install FFmpeg to enable transcoding.');
    }
  });
  test.on('exit', (code) => {
    if (code !== 0) {
      console.warn('[Startup] FFmpeg exited abnormally. WMA transcoding may not work.');
    }
  });
}

// Start server
checkFfmpegAvailability();

// Clean up HLS sessions on shutdown
import { cleanupAllSessions as cleanupHlsSessions } from './services/hlsStream.service';
import { cleanupAllAdaptiveHlsSessions } from './services/adaptiveHlsStream.service';
const cleanupStreamingSessions = () => {
  cleanupHlsSessions();
  cleanupAllAdaptiveHlsSessions();
};
process.on('SIGINT', cleanupStreamingSessions);
process.on('SIGTERM', cleanupStreamingSessions);

// Start container health monitoring (background)
import { startHealthMonitoring, containerEvents } from './services/containerControl.service';
startHealthMonitoring();

// Listen for container restarts to trigger DB reconnection automatically
containerEvents.on('containerRestarted', ({ name }) => {
  console.log(`[Server] Container ${name} restarted. Triggering database reconnection...`);
  initDatabaseConnection();
});

app.listen(port, () => {
  console.log(`Aurora Media Server listening at http://localhost:${port}`);
});

// Download ML models in background (non-blocking) — skips if already cached
import('./services/downloadModels').then(({ downloadModels }) => {
  downloadModels().catch(err => console.warn('[Models] Initial download failed:', err.message));
});

// Initial DB connection attempt
initDatabaseConnection();

// ─── Auto-Walk Scheduler ────────────────────────────────────────────
// When the 'autoFolderWalk' setting is enabled, re-walk all mapped folders
// every 30 minutes to detect renamed/deleted/added files automatically.
const AUTO_WALK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function runAutoWalk() {
  try {
    const { getSystemSetting, getDirectories } = await import('./database');
    const { scanStatus } = await import('./state');
    const { runSyncWalk } = await import('./routes/library.routes');

    const enabled = await getSystemSetting('autoFolderWalk');
    if (enabled !== true && enabled !== 'true') return;

    if (scanStatus.isScanning) {
      console.log('[Auto-Walk] Skipping — scan already in progress');
      return;
    }

    const dirs = await getDirectories();
    if (dirs.length === 0) return;

    console.log(`[Auto-Walk] Starting scheduled walk of ${dirs.length} folder(s)...`);
    const { broadcastScanStatus, scanStatus: ss } = await import('./state');

    ss.isScanning = true;
    ss.phase = 'walk';
    ss.scannedFiles = 0;
    ss.totalFiles = 0;
    ss.activeFiles = [];
    ss.activeWorkers = 0;
    ss.libraryChanged = false;
    broadcastScanStatus(true);

    let totalAdded = 0;
    let totalRemoved = 0;
    for (const dir of dirs) {
      try {
        const { added, removed } = await runSyncWalk(dir);
        totalAdded += added;
        totalRemoved += removed;
      } catch (e) {
        console.error(`[Auto-Walk] Failed for ${dir}:`, e);
      }
    }

    ss.isScanning = false;
    ss.phase = 'idle';
    ss.currentFile = '';
    ss.activeFiles = [];
    ss.activeWorkers = 0;
    ss.libraryChanged = totalAdded > 0 || totalRemoved > 0;
    broadcastScanStatus(true);

    console.log(`[Auto-Walk] Complete: +${totalAdded} added, -${totalRemoved} removed`);
  } catch (e) {
    console.error('[Auto-Walk] Scheduler error:', e);
  }
}

// Delay initial run to give DB time to connect on startup
setTimeout(() => {
  runAutoWalk();
  setInterval(runAutoWalk, AUTO_WALK_INTERVAL_MS);
}, 60_000);
