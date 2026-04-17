import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { spawn } from 'child_process';
import { requireAuth as jwtAuthMiddleware } from './middleware/auth';
import { initDatabaseConnection, getSessionHistory } from './state';
import { calculateNextInfinityTrack } from './services/recommendation.service';

// Route imports
import authRoutes from './routes/auth.routes';
import adminRoutes from './routes/admin.routes';
import libraryRoutes from './routes/library.routes';
import playbackRoutes from './routes/playback.routes';
import settingsRoutes from './routes/settings.routes';
import hubRoutes from './routes/hub.routes';
import playlistsRoutes from './routes/playlists.routes';
import artistsRoutes from './routes/artists.routes';
import albumsRoutes from './routes/albums.routes';
import genresRoutes from './routes/genres.routes';
import mediaRoutes from './routes/media.routes';
import providersRoutes from './routes/providers.routes';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Allowed origins setup
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'];
// If a custom Cast receiver origin is set, add it to CORS whitelist so
// the receiver can fetch HLS segments from our media server
if (process.env.CAST_RECEIVER_ORIGIN && !allowedOrigins.includes(process.env.CAST_RECEIVER_ORIGIN)) {
  allowedOrigins.push(process.env.CAST_RECEIVER_ORIGIN);
}
app.use(cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (
      !origin ||
      allowedOrigins.includes(origin) ||
      origin.startsWith('https://www.gstatic.com') ||
      origin.startsWith('https://cast.google.com') ||
      origin.startsWith('chrome-extension://')
    ) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  allowedHeaders: ['Content-Type', 'Range', 'Accept-Encoding', 'Authorization'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']
}));
app.use(express.json());

// Serve static files from the 'dist' directory in production
const distPath = path.join(__dirname, '../dist');
if (fs.existsSync(distPath)) {
  console.log(`[Server] Serving static files from ${distPath}`);
  app.use(express.static(distPath, { index: false }));

  // Serve custom Cast receiver HTML at /cast-receiver
  const receiverPath = path.join(distPath, 'receiver.html');
  if (fs.existsSync(receiverPath)) {
    app.get('/cast-receiver', (_req, res) => {
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
  } catch (e) {
    console.warn('[Server] Failed to pre-cache index.html, will read on each request');
  }

  // Catch-all route to serve index.html for React SPA routing
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    if (cachedIndexHtml) {
      res.type('html').send(cachedIndexHtml);
    } else {
      res.sendFile(path.join(distPath, 'index.html'));
    }
  });
}

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
process.on('SIGINT', () => { cleanupHlsSessions(); });
process.on('SIGTERM', () => { cleanupHlsSessions(); });

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
    if (enabled !== 'true') return;

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

