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

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Allowed origins setup
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'];
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
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Type']
}));
app.use(express.json());

// Serve static files from the 'dist' directory in production
const distPath = path.join(__dirname, '../dist');
if (fs.existsSync(distPath)) {
  console.log(`[Server] Serving static files from ${distPath}`);
  app.use(express.static(distPath));

  // Catch-all route to serve index.html for React SPA routing
  app.get('/{*splat}', (req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// Apply JWT auth middleware to all API routes
app.use(jwtAuthMiddleware);

// ─── Mount Route Modules ──────────────────────────────────────────────

// Auth & Setup (auth routes at /api/auth/*, setup routes at /api/setup/*)
app.use('/api', authRoutes); // mounts /api/auth/* and /api/setup/* from the same router

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
app.get('/api/health', (req, res) => {
  const { dbConnected } = require('./state');
  res.json({ status: 'ok', dbConnected, message: 'Aurora Media Server is running!' });
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
app.listen(port, () => {
  console.log(`Aurora Media Server listening at http://localhost:${port}`);
});

// Initial DB connection attempt
initDatabaseConnection();

// Background check for MFCC transition or missing features
setTimeout(async () => {
  try {
    const { getTracksWithoutFeatures } = await import('./database');
    const tracks = await getTracksWithoutFeatures();
    if (tracks.length > 0) {
      console.log(`[Startup] Found ${tracks.length} tracks missing audio features (or entering 13D MFCC transition). Auto-starting background analysis...`);
      const { runBackgroundAnalysis } = await import('./routes/library.routes');
      runBackgroundAnalysis(false).catch(console.error);
    }
  } catch(e) {
    console.error('[Startup] Failed to check for missing audio features:', e);
  }
}, 5000);
