import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { createServer } from 'http';
import path from 'path';
import dotenv from 'dotenv';
import { spawn } from 'child_process';
import { addDirectory, addTrack, getAllTracks, getDirectories, removeDirectory, removeTracksByDirectory, getOrCreateArtist, getOrCreateAlbum, getOrCreateGenre, migrateEntityIds, getArtistById, getAlbumById, getGenreById, getAllArtists, getAllAlbums, getAllGenres, getTracksByArtist, getTracksByAlbum, getTracksByGenre, hasUsers, createUser, getUserByUsername, updateUser, deleteUser, listUsers, updateLastLogin, createInvite, getInvite, listInvites, deleteInvite, incrementInviteUses, isInviteValid, recordPlaybackForUser, recordSkipForUser, getUserRecentTracks, getUserTopTracks, getUserSetting, setUserSetting, createPlaylist, getPlaylists, getPlaylistTracks, deletePlaylist, addTracksToPlaylist, deleteOldLlmPlaylists, getPlaylistOwner, cleanupOrphanedPlaylists, togglePlaylistPin } from './database';
import { extractAudioFeatures } from './services/audioExtraction.service';
import { generateHubConcepts, generateCustomPlaylist, HubCollection } from './services/llm.service';
import { getHubCollections, calculateNextInfinityTrack } from './services/recommendation.service';
import { genreMatrixService } from './services/genreMatrix.service';
import { getSystemSetting, setSystemSetting, getSubGenreMappings, getDatabaseStats } from './database';
import { hashPassword, verifyPassword, generateToken, verifyToken, regenerateJwtSecret, JwtPayload } from './services/auth.service';
import { requireAuth as jwtAuthMiddleware, requireAdmin } from './middleware/auth';
import { getContainerStatus, startContainer, stopContainer, createContainer, recreateContainer, listContainers, getConfiguredDatabaseInfo, ContainerConfig } from './services/containerControl.service';
import * as mm from 'music-metadata';
import OpenAI from 'openai';
import { Response, Request, NextFunction } from 'express';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Global DB connectivity flag
let dbConnected = false;

let isInitializing = false;
async function initDatabaseConnection(retries = 15, delay = 2000) {
  if (isInitializing) return;
  isInitializing = true;
  
  for (let i = 0; i < retries; i++) {
    try {
      await genreMatrixService.init();
      dbConnected = true;
      console.log('[DB] Connected and genre matrix initialized.');
      // Backfill entity IDs for existing tracks
      try {
        await migrateEntityIds();
      } catch (e: any) {
        console.error('[DB] Entity migration failed (non-fatal):', e.message || e);
      }
      isInitializing = false;
      return; 
    } catch (e: any) {
      dbConnected = false;
      console.error(`[DB] Connection attempt ${i + 1}/${retries} failed:`, e.message || e);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  isInitializing = false;
}

// Allowed origins setup
const allowedOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['http://localhost:3000'];
app.use(cors({
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // allow requests with no origin (like mobile apps or curl requests) or specific casting origins
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
    // If it's an API request that wasn't handled, let it fall through
    if (req.path.startsWith('/api')) {
      return next();
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// Server-side session history for Infinity Mode (per-user, in-memory, rolling 50 tracks)
const userSessionHistory = new Map<string, string[]>();

function addToSessionHistory(userId: string, trackId: string) {
  const history = userSessionHistory.get(userId) || [];
  history.push(trackId);
  if (history.length > 50) history.shift();
  userSessionHistory.set(userId, history);
}

function getSessionHistory(userId: string): string[] {
  return userSessionHistory.get(userId) || [];
}

// Security: Check if a raw-byte path Buffer resides within an allowed directory.
// Allowed dirs are typed as UTF-8 strings; file paths are raw byte Buffers.
async function isPathAllowed(requestedPathBuf: Buffer): Promise<boolean> {
  const allowedDirs = await getDirectories();
  for (const dir of allowedDirs) {
    // Convert the directory string to raw UTF-8 bytes for a byte-level prefix comparison.
    const dirBuf = Buffer.from(path.resolve(dir), 'utf8');
    // Ensure we match on a directory boundary (add sep if missing)
    const sep = Buffer.from(path.sep);
    const dirWithSep = dirBuf[dirBuf.length - 1] === sep[0]
      ? dirBuf
      : Buffer.concat([dirBuf, sep]);
    if (
      requestedPathBuf.length >= dirWithSep.length &&
      requestedPathBuf.slice(0, dirWithSep.length).equals(dirWithSep)
    ) {
      return true;
    }
  }
  return false;
}

// Convert a DB-stored Base64 path string back to the original raw byte Buffer.
// Base64 securely preserves all unencodable Linux bytes natively.
function pathToBuffer(p: string): Buffer {
  return Buffer.from(p, 'base64');
}

// Reverses the frontend's safeBtoa to recover the exact string sent by the client
function safeAtob(b64: string): string {
  // 1. Decode base64 to get the URI-encoded payload (e.g. "Some%20Name%C3%B7")
  const uriStr = Buffer.from(b64, 'base64').toString('latin1');
  
  // 2. We parse the %XX hex codes manually into a raw byte array.
  // We do not use decodeURIComponent() because it assumes the resulting bytes form a valid UTF-8 string, 
  // and throws URIError if it encounters raw ISO-8859-1 bytes (like from a DB latin1 string).
  const bytes: number[] = [];
  for (let i = 0; i < uriStr.length; i++) {
    if (uriStr[i] === '%' && i + 2 < uriStr.length) {
      bytes.push(parseInt(uriStr.substring(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(uriStr.charCodeAt(i));
    }
  }
  
  // 3. The raw bytes represent a UTF-8 encoded string (since the frontend called encodeURIComponent).
  // We decode those bytes as UTF-8 back to a standard Javascript String.
  return Buffer.from(bytes).toString('utf8');
}


// Apply JWT auth middleware to all API routes
app.use(jwtAuthMiddleware);

// Setup API Routes
app.get('/api/setup/status', async (req, res) => {
  try {
    const usersExist = await hasUsers();
    res.json({ needsSetup: !usersExist, dbConnected: true });
  } catch (error: any) {
    if (error.code === 'ECONNREFUSED') {
      return res.json({ needsSetup: null, dbConnected: false, error: 'Database unavailable' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/setup/complete', async (req, res) => {
  const needsSetup = !(await hasUsers());
  if (!needsSetup) {
    return res.status(403).json({ error: 'Setup is already complete.' });
  }

  const { username, password } = req.body;
  if (!username || !password || username.length < 3 || password.length < 5) {
    return res.status(400).json({ error: 'Invalid username or password. Ensure they are strong.' });
  }

  try {
    // Create first admin user in DB
    const passwordHash = await hashPassword(password);
    const user = await createUser(username, passwordHash, 'admin');

    // Generate JWT token for immediate login
    const token = await generateToken({ userId: user.id, username: user.username, role: user.role });

    res.json({ status: 'completed', token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('Failed to complete setup:', error);
    res.status(500).json({ error: 'Failed to create admin user.' });
  }
});

// ==========================================
// AUTH ENDPOINTS
// ==========================================

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = await getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await updateLastLogin(user.id);
    const token = await generateToken({ userId: user.id, username: user.username, role: user.role });

    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { inviteToken, username, password } = req.body;
    if (!inviteToken || !username || !password) {
      return res.status(400).json({ error: 'Invite token, username, and password required' });
    }

    if (username.length < 3 || password.length < 5) {
      return res.status(400).json({ error: 'Username must be 3+ chars, password 5+ chars' });
    }

    const valid = await isInviteValid(inviteToken);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid or expired invite' });
    }

    const invite = await getInvite(inviteToken);
    const existingUser = await getUserByUsername(username);
    if (existingUser) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const passwordHash = await hashPassword(password);
    const user = await createUser(username, passwordHash, invite.role);

    await incrementInviteUses(inviteToken);
    const token = await generateToken({ userId: user.id, username: user.username, role: user.role });

    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: req.user });
});

app.post('/api/auth/change-password', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password required' });
    if (newPassword.length < 5) return res.status(400).json({ error: 'New password must be 5+ characters' });

    const user = await getUserByUsername(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await hashPassword(newPassword);
    await updateUser(user.id, { passwordHash: newHash });
    res.json({ status: 'changed' });
  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

app.delete('/api/auth/delete-account', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password required to delete account' });

    const user = await getUserByUsername(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    // Don't allow deleting the last admin
    if (user.role === 'admin') {
      const users = await listUsers();
      const adminCount = users.filter((u: any) => u.role === 'admin').length;
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last admin account' });
      }
    }

    await deleteUser(user.id);
    res.json({ status: 'deleted' });
  } catch (error) {
    console.error('Account deletion error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// ==========================================
// ADMIN ENDPOINTS
// ==========================================

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await listUsers();
    res.json({ users });
  } catch (error) {
    console.error('Users list error:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (username.length < 3 || password.length < 5) {
      return res.status(400).json({ error: 'Username 3+ chars, password 5+ chars' });
    }

    const existing = await getUserByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const passwordHash = await hashPassword(password);
    const user = await createUser(username, passwordHash, role || 'user');
    res.json({ user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    console.error('User create error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, password, role } = req.body;

    const fields: any = {};
    if (username) fields.username = username;
    if (password) fields.passwordHash = await hashPassword(password);
    if (role) fields.role = role;

    await updateUser(id as string, fields);
    res.json({ status: 'updated' });
  } catch (error) {
    console.error('User update error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    // Prevent self-deletion
    if (id === req.user!.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    await deleteUser(id as string);
    res.json({ status: 'deleted' });
  } catch (error) {
    console.error('User delete error:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ==========================================
// INVITE ENDPOINTS
// ==========================================

app.get('/api/admin/invites', requireAdmin, async (req, res) => {
  try {
    const invites = await listInvites();
    res.json({ invites });
  } catch (error) {
    console.error('Invites list error:', error);
    res.status(500).json({ error: 'Failed to list invites' });
  }
});

app.post('/api/admin/invites', requireAdmin, async (req, res) => {
  try {
    const { role, maxUses, expiresIn } = req.body;
    const expiresAt = expiresIn ? Date.now() + (parseInt(expiresIn, 10) * 1000) : null;
    const invite = await createInvite(req.user!.userId, role || 'user', maxUses || 1, expiresAt);

    // Build the invite URL from the request
    const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
    const inviteUrl = `${origin}/invite/${invite.token}`;

    res.json({ invite, inviteUrl });
  } catch (error) {
    console.error('Invite create error:', error);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

app.delete('/api/admin/invites/:token', requireAdmin, async (req, res) => {
  try {
    await deleteInvite(req.params.token as string);
    res.json({ status: 'revoked' });
  } catch (error) {
    console.error('Invite delete error:', error);
    res.status(500).json({ error: 'Failed to revoke invite' });
  }
});

// API: Cleanup orphaned playlists (admin only)
app.post('/api/admin/cleanup-playlists', requireAdmin, async (req, res) => {
  try {
    const deletedCount = await cleanupOrphanedPlaylists();
    res.json({ status: 'ok', deletedCount });
  } catch (error) {
    console.error('Cleanup orphaned playlists error:', error);
    res.status(500).json({ error: 'Failed to cleanup orphaned playlists' });
  }
});

app.get('/api/invites/:token/validate', async (req, res) => {
  try {
    const valid = await isInviteValid(req.params.token);
    res.json({ valid });
  } catch (error) {
    res.json({ valid: false });
  }
});

// ==========================================
// DATABASE CONTAINER ENDPOINTS (Admin only)
// ==========================================

// Special middleware to allow DB control even if DB is down (bootstrap/emergency)
// If DB is up, require admin auth. If down, allow anyone to access status/start.
const requireAdminOrDbDown = async (req: Request, res: Response, next: NextFunction) => {
  if (dbConnected === false) {
    return next();
  }

  // DB is up, so we require a valid admin token. 
  // requireAuth might have skipped it to allow bootstrap access.
  let token: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query.token) {
    token = req.query.token as string;
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const payload = await verifyToken(token);
  if (!payload || payload.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  req.user = payload;
  next();
};

app.get('/api/admin/db/status', requireAdminOrDbDown, async (req, res) => {
  try {
    const containerName = process.env.DB_CONTAINER_NAME || 'music-postgres';
    const status = await getContainerStatus(containerName);
    const configuredData = getConfiguredDatabaseInfo();
    res.json({ ...status, configuredData });
  } catch (error: any) {
    console.error('DB status error:', error);
    res.status(500).json({ error: error.message || 'Failed to get database status' });
  }
});

app.get('/api/admin/db/stats', requireAdminOrDbDown, async (req, res) => {
  try {
    const stats = await getDatabaseStats();
    res.json(stats);
  } catch (error: any) {
    console.error('DB stats error:', error);
    res.status(500).json({ error: error.message || 'Failed to get database statistics' });
  }
});

app.post('/api/admin/db/start', requireAdminOrDbDown, async (req, res) => {
  try {
    const containerName = process.env.DB_CONTAINER_NAME || 'music-postgres';
    const result = await startContainer(containerName);
    
    // Trigger background initialization
    initDatabaseConnection();
    
    res.json(result);
  } catch (error: any) {
    console.error('DB start error:', error);
    res.status(500).json({ error: error.message || 'Failed to start database' });
  }
});

app.post('/api/admin/db/stop', requireAdmin, async (req, res) => {
  try {
    const containerName = process.env.DB_CONTAINER_NAME || 'music-postgres';
    const result = await stopContainer(containerName);
    dbConnected = false;
    res.json(result);
  } catch (error: any) {
    console.error('DB stop error:', error);
    res.status(500).json({ error: error.message || 'Failed to stop database' });
  }
});

app.post('/api/admin/db/create', requireAdminOrDbDown, async (req, res) => {
  try {
    const dbPort = process.env.DB_PORT || '5432';
    const dataDir = process.env.DB_DATA_DIR || './postgres-data';
    const config: ContainerConfig = {
      name: 'music-postgres',
      image: 'docker.io/pgvector/pgvector:pg16',
      environment: {
        POSTGRES_USER: process.env.DB_USER || 'musicuser',
        POSTGRES_PASSWORD: process.env.DB_PASSWORD || 'musicpass',
        POSTGRES_DB: process.env.DB_NAME || 'musicdb'
      },
      ports: { '5432': dbPort },
      volumes: { [dataDir]: '/var/lib/postgresql/data' },
      restartPolicy: 'no'
    };
    const result = await createContainer(config);
    // Trigger background initialization
    initDatabaseConnection();
    res.json(result);
  } catch (error: any) {
    console.error('DB create error:', error);
    res.status(500).json({ error: error.message || 'Failed to create database' });
  }
});

app.post('/api/admin/db/recreate', requireAdminOrDbDown, async (req, res) => {
  try {
    const dbPort = process.env.DB_PORT || '5432';
    const dataDir = process.env.DB_DATA_DIR || './postgres-data';
    const config: ContainerConfig = {
      name: 'music-postgres',
      image: 'docker.io/pgvector/pgvector:pg16',
      environment: {
        POSTGRES_USER: process.env.DB_USER || 'musicuser',
        POSTGRES_PASSWORD: process.env.DB_PASSWORD || 'musicpass',
        POSTGRES_DB: process.env.DB_NAME || 'musicdb'
      },
      ports: { '5432': dbPort },
      volumes: { [dataDir]: '/var/lib/postgresql/data' },
      restartPolicy: 'no'
    };
    const result = await recreateContainer(config);
    // Trigger background initialization
    initDatabaseConnection();
    res.json(result);
  } catch (error: any) {
    console.error('DB recreate error:', error);
    res.status(500).json({ error: error.message || 'Failed to recreate database' });
  }
});

// ==========================================
// SESSION HISTORY ENDPOINTS
// ==========================================

app.post('/api/playback/history', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  const { trackId } = req.body;
  if (!trackId) return res.status(400).json({ error: 'trackId required' });
  addToSessionHistory(req.user.userId, trackId);
  res.json({ status: 'recorded' });
});

// ==========================================
app.post('/api/health/llm', async (req, res) => {
  try {
    const { llmBaseUrl, llmApiKey } = req.body;
    const openai = new OpenAI({
      baseURL: llmBaseUrl || 'https://api.openai.com/v1',
      apiKey: llmApiKey || 'dummy-key',
    });
    // Just list models to test connection
    const modelsResponse = await openai.models.list();
    const models = modelsResponse.data.map((m: any) => m.id);
    res.json({ status: 'ok', models });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// API: Get settings (merged: server-wide + user-specific)
app.get('/api/settings', async (req, res) => {
  try {
    const userId = req.user?.userId;

    // Server-wide settings (from system_settings)
    const serverKeys = ['audioAnalysisCpu', 'hubGenerationSchedule', 'llmBaseUrl', 'llmApiKey', 'llmModelName', 'genreMatrixLastRun', 'genreMatrixLastResult', 'genreMatrixProgress'];
    const settings: Record<string, any> = {};
    for (const k of serverKeys) {
      settings[k] = await getSystemSetting(k);
    }

    // User-specific settings (from user_settings, fall back to system_settings)
    if (userId) {
      const userKeys = ['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit'];
      for (const k of userKeys) {
        const userVal = await getUserSetting(userId, k);
        if (userVal !== null) {
          settings[k] = userVal;
        } else {
          settings[k] = await getSystemSetting(k); // backward compat fallback
        }
      }
    } else {
      // No user context, fall back to system settings
      const fallbackKeys = ['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit'];
      for (const k of fallbackKeys) {
        settings[k] = await getSystemSetting(k);
      }
    }

    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// API: Update settings (user-specific go to user_settings, server-wide to system_settings)
app.post('/api/settings', async (req, res) => {
  try {
    const userId = req.user?.userId;
    const settings = req.body;

    // User-specific settings keys
    const userKeys = new Set(['discoveryLevel', 'genreStrictness', 'artistAmnesiaLimit']);
    // Server-wide settings that only admins can modify
    const serverKeys = new Set(['llmBaseUrl', 'llmApiKey', 'llmModelName', 'hubGenerationSchedule', 'audioAnalysisCpu']);

    for (const [k, v] of Object.entries(settings)) {
      if (userKeys.has(k) && userId) {
        await setUserSetting(userId, k, v);
      } else if (serverKeys.has(k)) {
        // Only admins can modify server-wide settings
        if (req.user?.role === 'admin') {
          await setSystemSetting(k, v);
        }
      } else {
        // Unknown keys go to system_settings (backward compat)
        await setSystemSetting(k, v);
      }
    }
    res.json({ status: 'updated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// API: Genre Matrix mappings
app.get('/api/genre-matrix/mappings', async (req, res) => {
  try {
    const mappings = await getSubGenreMappings();
    res.json(mappings);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch mappings' });
  }
});

// API: Full Re-mapping of all genres
app.post('/api/genre-matrix/remap-all', requireAdmin, async (req, res) => {
  try {
    // Non-blocking
    genreMatrixService.remapAll();
    res.json({ status: 'started' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start full remap' });
  }
});

// API: Stream Audio
// Supports HTTP Range requests for gapless playback, seeking, and Web Audio API
app.get('/api/stream', async (req, res) => {
  const b64Path = req.query.pathB64 as string;
  const rawPath = req.query.path as string;

  if (!b64Path && !rawPath) {
    return res.status(400).send('Missing path parameter');
  }

  // Recover original raw bytes: The client base64-encodes the latin1 string 
  // using safeBtoa to prevent Javascript's URL encoding from mangling raw bytes.
  // We reverse safeBtoa to get back the latin1 string, then convert to Buffer.
  let dbPathStr = rawPath;
  if (b64Path) {
    dbPathStr = safeAtob(b64Path);
  }
  
  const fileBuf = pathToBuffer(dbPathStr);

  // Security: Check if file exists AND path is allowed
  if (!fs.existsSync(fileBuf)) {
    return res.status(404).send('File not found');
  }

  const allowed = await isPathAllowed(fileBuf);
  if (!allowed) {
    return res.status(403).send('Forbidden: Path is outside allowed library directories');
  }

  const stat = fs.statSync(fileBuf);
  const fileSize = stat.size;
  const ext = path.extname(fileBuf.toString('utf8')).slice(1).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'audio/mpeg';

  if (mimeType === 'audio/x-ms-wma') {
    // Transcode WMA to MP3 on the fly for browser compatibility (Chrome/Linux)
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'none'); // Crucial for Chrome to play from the start of a stream
    
    // Note: We skip range requests for on-the-fly transcoding to keep things simple and reliable.
    // ffmpeg will pipe the MP3 stream directly to the response.
    const ffmpeg = spawn('ffmpeg', [
      '-i', fileBuf.toString('utf8'), // ffmpeg usually handles raw paths fine if passed as args
      '-map', '0:a:0', // Explicitly take only the first audio stream
      '-vn', // Disable video/images (like embedded MJPEG cover art) to prevent output corruption
      '-c:a', 'libmp3lame',
      '-b:a', '192k',
      '-id3v2_version', '3', // Older but highly compatible ID3 tags for browsers
      '-fflags', '+genpts', // Generate missing timestamps for better stream processing
      '-f', 'mp3',
      '-'
    ]);

    // MUST consume stderr, otherwise FFmpeg will hang when its internal buffer fills up
    ffmpeg.stderr.on('data', (data) => {
      console.error('[FFmpeg]', data.toString());
    });

    ffmpeg.stdout.pipe(res);

    req.on('close', () => {
      ffmpeg.kill('SIGKILL'); // Force kill if the user stops playback / skips track
    });

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg spawn error:', err);
      if (!res.headersSent) res.status(500).send('Transcoding error');
    });

    ffmpeg.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`FFmpeg process exited with code ${code} and signal ${signal}`);
      }
    });
    
    return;
  }

  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    const chunksize = (end - start) + 1;
    const file = fs.createReadStream(fileBuf, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': mimeType,
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
    };
    res.writeHead(200, head);
    fs.createReadStream(fileBuf).pipe(res);
  }
});



let scanStatus = {
  isScanning: false,
  phase: 'idle' as 'idle' | 'walk' | 'metadata',
  scannedFiles: 0,
  totalFiles: 0,
  activeFiles: [] as string[],
  activeWorkers: 0,
  currentFile: '' // kept for backwards-compat
};
const scanClients = new Set<Response>();

let lastBroadcastTime = 0;
function broadcastScanStatus(force = false) {
  const now = Date.now();
  if (!force && now - lastBroadcastTime < 100) return;
  lastBroadcastTime = now;
  const msg = `data: ${JSON.stringify(scanStatus)}\n\n`;
  scanClients.forEach(c => c.write(msg));
}

app.get('/api/library/scan/status', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  scanClients.add(res);
  res.write(`data: ${JSON.stringify(scanStatus)}\n\n`);

  req.on('close', () => {
    scanClients.delete(res);
  });
});

// Mime type map for parseStream
const MIME_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  wma: 'audio/x-ms-wma',
};

// ─── Phase 1: Recursive directory walk ──────────────────────────────────────
// Quickly collect all audio file path Buffers without doing any metadata work.
// Uses Buffer paths throughout to avoid encoding corruption.
async function collectAudioFiles(dirBuf: Buffer, results: Buffer[] = []): Promise<Buffer[]> {
  const sep = Buffer.from(path.sep);
  let entries: Buffer[];
  try {
    entries = await fs.promises.readdir(dirBuf, { encoding: 'buffer' });
  } catch {
    return results; // skip unreadable dirs silently
  }

  await Promise.all(entries.map(async (nameBuffer) => {
    const fullBuf = Buffer.concat([
      dirBuf,
      dirBuf[dirBuf.length - 1] === sep[0] ? Buffer.alloc(0) : sep,
      nameBuffer,
    ]);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fullBuf);
    } catch {
      return; // skip unstateable entries
    }
    if (stat.isDirectory()) {
      await collectAudioFiles(fullBuf, results);
    } else if (stat.isFile() && nameBuffer.toString('utf8').match(/\.(mp3|wav|ogg|flac|m4a|aac|wma)$/i)) {
      results.push(fullBuf);
    }
  }));

  return results;
}

// ─── Phase 2: Parallel metadata extraction ──────────────────────────────────
// Process up to CONCURRENCY files at the same time.
const SCAN_CONCURRENCY = 16;

async function processFileBatch(fileBufs: Buffer[]): Promise<void> {
  let index = 0;
  // Track which filenames are actively being processed right now.
  const activeSet = new Set<string>();

  async function worker() {
    scanStatus.activeWorkers++;
    broadcastScanStatus();
    try {
      while (true) {
        const i = index++;
        if (i >= fileBufs.length) return;

        const fullBuf = fileBufs[i];
        
        // Base64 securely encodes ANY sequence of bytes (including invalid UTF-8) 
        // into a string that is 100% safe for JSON, API transit, and PostgreSQL storage.
        const dbPath = fullBuf.toString('base64');
        
        // We use raw UTF-8 interpretation purely for extracting a human-readable title 
        // and extension string. If invalid characters become , that's fine for UI display!
        const utf8StringPath = fullBuf.toString('utf8');
        const nameStr = path.basename(utf8StringPath);

        activeSet.add(nameStr);
        scanStatus.activeFiles = Array.from(activeSet);
        scanStatus.currentFile = nameStr;
        scanStatus.scannedFiles++;
        broadcastScanStatus();

        try {
          const ext = nameStr.split('.').pop()?.toLowerCase() || '';
          const mimeType = MIME_TYPES[ext] || 'audio/mpeg';
          
          // Hack: music-metadata relies on string methods to extract the file extension,
          // but we MUST pass a raw Buffer to fs.open to handle unencodable Linux bytes.
          // By adding these methods to the Buffer instance, we satisfy music-metadata's parser
          // router while natively delivering the exact raw bytes to the filesystem for instant random-access.
          const fileBufHack = Buffer.from(fullBuf) as any;
          fileBufHack.lastIndexOf = (search: string) => nameStr.lastIndexOf(search);
          fileBufHack.substring = (start: number, end?: number) => nameStr.substring(start, end);
          fileBufHack.toLowerCase = () => nameStr.toLowerCase();

          const metadata = await mm.parseFile(fileBufHack);

          let artists: string[] | undefined;
          if (metadata.common.artists && metadata.common.artists.length > 0) {
            artists = metadata.common.artists;
          } else if (metadata.common.artist) {
            const splitRegex = /\s+(?:feat\.?|ft\.?|featuring|&)\s+(?!$)/i;
            const parts = metadata.common.artist.split(splitRegex).map(s => s.trim()).filter(Boolean);
            if (parts.length > 0) artists = parts;
          }

            let audioFeatures;
            try {
              // The backend extraction needs the actual raw bytes for files with special characters on Linux
              audioFeatures = await extractAudioFeatures(fullBuf);
            } catch (featureErr) {
              console.error(`[Scanner] Recommendation Engine: Failed to extract audio features for "${nameStr}". This track will have limited discovery/AI support.`, featureErr);
            }

            // Resolve entity UUIDs for navigation
            const albumArtistName = metadata.common.albumartist || metadata.common.artist || null;
            const albumTitle = metadata.common.album || null;
            const genreName = metadata.common.genre ? metadata.common.genre[0] : null;

            let artistId = null;
            let albumId = null;
            let genreId = null;
            try {
              if (albumArtistName) artistId = await getOrCreateArtist(albumArtistName);
            } catch (e) { /* skip */ }
            // Also create entities for all individual artists (including featured)
            if (artists) {
              for (const a of artists) {
                try { await getOrCreateArtist(a); } catch (e) { /* skip */ }
              }
            }
            try {
              if (albumTitle) albumId = await getOrCreateAlbum(albumTitle, albumArtistName);
            } catch (e) { /* skip */ }
            try {
              if (genreName) genreId = await getOrCreateGenre(genreName);
            } catch (e) { /* skip */ }

            await addTrack({
              path: dbPath,
              title: metadata.common.title || nameStr,
              artist: metadata.common.artist || metadata.common.albumartist || null,
              albumArtist: metadata.common.albumartist || null,
              artists: artists || null,
              album: albumTitle,
              genre: genreName,
              duration: metadata.format.duration || 0,
              trackNumber: metadata.common.track.no || null,
              year: metadata.common.year || null,
              releaseType: metadata.common.releasetype ? metadata.common.releasetype[0] : null,
              isCompilation: metadata.common.compilation || false,
              bitrate: metadata.format.bitrate ? Math.round(metadata.format.bitrate) : null,
              format: metadata.format.container || metadata.format.codec || null,
              audioFeatures,
              artistId,
              albumId,
              genreId
            });

            if (!metadata.common.genre || metadata.common.genre.length === 0) {
              console.warn(`[Scanner] Recommendation Engine: No genre found for "${nameStr}". Hop-cost logic will be restricted.`);
            }
        } catch (err) {
          console.warn(`Failed to parse metadata for ${nameStr}`, err);
          await addTrack({ path: dbPath, title: nameStr, bitrate: null, format: null });
        } finally {
          activeSet.delete(nameStr);
          scanStatus.activeFiles = Array.from(activeSet);
          broadcastScanStatus();
        }
      }
    } finally {
      scanStatus.activeWorkers--;
      broadcastScanStatus(true);
    }
  }

  // Spawn up to SCAN_CONCURRENCY workers (but no more than there are files).
  const workerCount = Math.min(SCAN_CONCURRENCY, fileBufs.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
}

// API: Add a mapped folder to the database without scanning
app.post('/api/library/add', async (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath || typeof dirPath !== 'string') {
    return res.status(400).json({ error: 'Missing absolute path parameter' });
  }
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return res.status(400).json({ error: 'Path does not exist or is not a directory' });
  }
  try {
    await addDirectory(dirPath);
    res.json({ status: 'added' });
  } catch (error) {
    console.error('Add mapping error:', error);
    res.status(500).json({ error: 'Failed to add directory mapping' });
  }
});

// API: Trigger a library scan for a given absolute directory path
app.post('/api/library/scan', async (req, res) => {
  console.log('Scan Request Received. Body:', JSON.stringify(req.body));
  const { path: dirPath } = req.body;
  if (!dirPath || typeof dirPath !== 'string') {
    console.log('Scan 400: Missing or invalid path', { dirPath, type: typeof dirPath });
    return res.status(400).json({ error: 'Missing absolute path parameter in body' });
  }

  if (!fs.existsSync(dirPath)) {
    console.log('Scan 400: Path does not exist', dirPath);
    return res.status(400).json({ error: 'Path does not exist' });
  }
  
  if (!fs.statSync(dirPath).isDirectory()) {
     console.log('Scan 400: Path is not a directory', dirPath);
     return res.status(400).json({ error: 'Path is not a directory' });
  }

  if (scanStatus.isScanning) {
    console.log('Scan 400: Scan already in progress');
    return res.status(400).json({ error: 'Scan already in progress' });
  }

  try {
    scanStatus.isScanning = true;
    scanStatus.scannedFiles = 0;
    scanStatus.totalFiles = 0;
    scanStatus.activeFiles = [];
    scanStatus.activeWorkers = 0;
    scanStatus.phase = 'walk';
    scanStatus.currentFile = `Walking ${path.basename(dirPath)}...`;
    broadcastScanStatus(true);

    await addDirectory(dirPath);

    // Phase 1: Fast recursive walk to collect all audio file paths.
    const dirBuf = Buffer.from(dirPath, 'utf8');
    const fileBufs = await collectAudioFiles(dirBuf);

    if (fileBufs.length === 0) {
      console.warn(`[Scanner] No audio files found in ${dirPath}. Check permissions or file extensions.`);
    }

    // Phase 2: Parse metadata in parallel across SCAN_CONCURRENCY workers.
    scanStatus.phase = 'metadata';
    scanStatus.totalFiles = fileBufs.length;
    scanStatus.scannedFiles = 0;
    scanStatus.currentFile = '';
    broadcastScanStatus(true);
    await processFileBatch(fileBufs);
    console.log(`[Scanner] Scan completed for ${dirPath}: ${fileBufs.length} files processed`);

    // Trigger Genre Matrix regeneration after scan (global, not per-user)
    // Hub regeneration is now per-user and triggered when users visit the Hub
    setImmediate(() => {
      genreMatrixService.runDiffAndGenerate()
        .catch(e => console.error('[Genre Matrix] Post-scan categorization failed:', e));
    });

    res.json({ status: 'completed', message: `Scan completed for ${dirPath}` });
  } catch (error) {
    console.error('Scan init error:', error);
    res.status(500).json({ error: 'Failed to complete scan' });
  } finally {
    scanStatus.isScanning = false;
    scanStatus.phase = 'idle';
    scanStatus.currentFile = '';
    scanStatus.activeFiles = [];
    scanStatus.activeWorkers = 0;
    broadcastScanStatus(true);
  }
});

// API: Remove a mapped folder and its tracks from the database
app.post('/api/library/remove', async (req, res) => {
  const { path: dirPath } = req.body;
  if (!dirPath || typeof dirPath !== 'string') {
    return res.status(400).json({ error: 'Missing absolute path parameter' });
  }

  try {
    await removeDirectory(dirPath);
    await removeTracksByDirectory(dirPath);
    console.log(`Removed directory and tracks for ${dirPath}`);
    res.json({ status: 'removed' });
  } catch (error) {
    console.error('Remove error:', error);
    res.status(500).json({ error: 'Failed to remove directory' });
  }
});

// API: Get entire library
app.get('/api/library', async (req, res) => {
  try {
    const tracks = await getAllTracks();
    const directories = await getDirectories();
    // Include entity lookup data for frontend navigation
    const artists = await getAllArtists();
    const albums = await getAllAlbums();
    const genres = await getAllGenres();
    res.json({ tracks, directories, artists, albums, genres });
  } catch (error) {
    console.error('DB fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch library' });
  }
});

// API: Get all User and LLM Playlists (user-scoped)
app.get('/api/playlists', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const playlists = await getPlaylists(userId);

    // Attach tracks to them for initial load
    const populated = await Promise.all(playlists.map(async (pl: any) => {
      const tracks = await getPlaylistTracks(pl.id);
      return { ...pl, tracks };
    }));

    res.json({ playlists: populated });
  } catch (error) {
    console.error('Playlist fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// API: Create new User Playlist (user-scoped)
app.post('/api/playlists', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { title, description } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });

    const id = `user_${Date.now()}`;
    await createPlaylist(id, title, description, false, userId);

    res.json({ id, title, description, isLlmGenerated: false, tracks: [] });
  } catch (error) {
    console.error('Playlist create error:', error);
    res.status(500).json({ error: 'Failed to create playlist' });
  }
});

// API: Save tracks to a playlist (owner check)
app.post('/api/playlists/:id/tracks', async (req, res) => {
  try {
    const { id } = req.params;
    const { trackIds } = req.body;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    if (!Array.isArray(trackIds)) return res.status(400).json({ error: 'trackIds must be an array' });

    // Check ownership
    const owner = await getPlaylistOwner(id as string);
    if (owner && owner !== userId && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Not your playlist' });
    }

    await addTracksToPlaylist(id as string, trackIds);

    res.json({ status: 'success' });
  } catch (error) {
    console.error('Playlist track update error:', error);
    res.status(500).json({ error: 'Failed to update playlist tracks' });
  }
});

// API: Delete a playlist (owner or admin)
app.delete('/api/playlists/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    // Admin can delete any playlist
    if (req.user?.role === 'admin') {
      await deletePlaylist(id as string);
    } else {
      await deletePlaylist(id as string, userId);
    }

    res.json({ status: 'deleted' });
  } catch (error) {
    console.error('Playlist delete error:', error);
    res.status(500).json({ error: 'Failed to delete playlist' });
  }
});

// API: Pin/unpin a playlist
app.patch('/api/playlists/:id/pin', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { pinned } = req.body;
    if (typeof pinned !== 'boolean') {
      return res.status(400).json({ error: 'pinned must be a boolean' });
    }

    const ok = await togglePlaylistPin(id, userId, pinned);
    if (!ok) return res.status(404).json({ error: 'Playlist not found' });
    res.json({ status: 'ok', pinned });
  } catch (error) {
    console.error('Playlist pin error:', error);
    res.status(500).json({ error: 'Failed to update pin status' });
  }
});

// API: Get Hub Data (READ-ONLY - assembles engine-driven + cached LLM collections)
// Per-user: each user gets personalized collections based on their playback stats
app.get('/api/hub', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const collections = await getHubCollections([], userId);
    res.json({ collections });
  } catch (error) {
    console.error('Hub fetch error:', error);
    res.status(500).json({ error: 'Failed to generate hub' });
  }
});

// Internal helper: generate LLM playlists if config is present and cache is stale
// Now per-user: generates playlists owned by the requesting user
async function runLlmHubRegeneration(userId: string, opts: { force?: boolean } = {}) {
  const llmBaseUrl = (await getSystemSetting('llmBaseUrl')) || process.env.LLM_BASE_URL || '';

  // Only skip if no base URL is configured at all — local LLMs don't need an API key
  if (!llmBaseUrl) {
    return { skipped: true, reason: 'No LLM base URL configured' };
  }

  // Cleanup stale LLM playlists for this user
  const maxAgeMs = opts.force ? 0 : 24 * 60 * 60 * 1000;
  const deletedCount = await deleteOldLlmPlaylists(maxAgeMs, userId);
  if (deletedCount && deletedCount > 0) {
    console.log(`[LLM Hub] ${opts.force ? 'Reset' : 'Cleaned up'} ${deletedCount} LLM playlist(s) for user ${userId}`);
  }

  // Check existing LLM playlists for this user
  const existingPlaylists = await getPlaylists(userId);

  // Determine age based on schedule
  const fourHoursMs = 4 * 60 * 60 * 1000;
  const hasRecentLlm = existingPlaylists.some((pl: any) =>
    pl.isLlmGenerated && (Date.now() - pl.createdAt) < fourHoursMs
  );

  if (hasRecentLlm && !opts.force) {
    return { skipped: true, reason: 'Recent LLM playlists exist (< 4h old)' };
  }

  // Build user-specific history summary for LLM context
  const recentTracks = await getUserRecentTracks(userId, 10);
  const historySummary = recentTracks.map((t: any) => `${t.title} by ${t.artist}`).join(', ');

  const timeOfDay = new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening';
  const concepts: HubCollection[] = await generateHubConcepts({ timeOfDay, historySummary });

  if (concepts.length > 0) {
    // This does the vector search and writes playlists to the database (user-scoped)
    await getHubCollections(concepts, userId);
  }

  console.log(`[LLM Hub] Generated and saved ${concepts.length} playlist(s) for user ${userId} (${timeOfDay})`);
  return { generated: concepts.length };
}

// API: Trigger LLM Hub Regeneration explicitly (per-user)
app.post('/api/hub/regenerate', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { force } = req.body;
    const result = await runLlmHubRegeneration(userId, { force: !!force });
    res.json(result);
  } catch (error) {
    console.error('Hub regeneration error:', error);
    res.status(500).json({ error: 'Failed to regenerate hub' });
  }
});

// API: Generate a single custom playlist from a user prompt
app.post('/api/hub/generate-custom', async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'A prompt is required' });
    }
    const concept = await generateCustomPlaylist(prompt.trim());
    if (!concept) {
      return res.status(503).json({ error: 'LLM did not return a valid playlist concept. Check your LLM configuration.' });
    }
    // Reuse the same vector search + DB write pipeline as automated playlists
    const saved = await getHubCollections([concept], userId);
    const playlist = saved.find(c => c.isLlmGenerated);
    res.json({ playlist });
  } catch (error) {
    console.error('Custom playlist generation error:', error);
    res.status(500).json({ error: 'Failed to generate custom playlist' });
  }
});


// API: Manually trigger genre matrix regeneration
app.post('/api/genre-matrix/regenerate', requireAdmin, async (req, res) => {
  try {
    await genreMatrixService.runDiffAndGenerate();
    const { getSystemSetting } = await import('./database');
    const lastRun = await getSystemSetting('genreMatrixLastRun');
    const lastResult = await getSystemSetting('genreMatrixLastResult');
    res.json({ status: 'ok', lastRun, lastResult });
  } catch (error) {
    console.error('Genre matrix regeneration error:', error);
    res.status(500).json({ error: 'Failed to regenerate genre matrix' });
  }
});

// Schedule: Re-run LLM hub regeneration periodically (per-user)
const LLM_HUB_INTERVAL_MS = 60 * 60 * 1000; // Check every hour
setInterval(async () => {
  const schedule = await getSystemSetting('hubGenerationSchedule') || 'Daily';
  if (schedule === 'Manual Only') return;

  console.log('[LLM Hub] Scheduled refresh check...');
  try {
    const users = await listUsers();
    for (const user of users) {
      try {
        await runLlmHubRegeneration(user.id);
      } catch (e) {
        console.error(`[LLM Hub] Scheduled refresh failed for user ${user.username}:`, e);
      }
    }
  } catch (e) {
    console.error('[LLM Hub] Scheduled refresh failed:', e);
  }
}, LLM_HUB_INTERVAL_MS);

// API: Request next infinity mode track (per-user session history)
app.post('/api/recommend', async (req, res) => {
  try {
    const userId = req.user?.userId;
    const { sessionHistoryTrackIds: clientHistory, settings } = req.body;

    // Prefer server-side session history, fall back to client-provided
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

// API: Record a successful playback (per-user)
app.post('/api/playback/record', async (req, res) => {
  try {
    const { trackId } = req.body;
    if (!trackId) return res.status(400).json({ error: 'trackId required' });
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    await recordPlaybackForUser(userId, trackId);
    // Also add to server-side session history
    addToSessionHistory(userId, trackId);
    res.json({ status: 'recorded' });
  } catch (err) {
    console.error('Playback record error:', err);
    res.status(500).json({ error: 'Failed to record playback' });
  }
});

// API: Record a track skip (per-user)
app.post('/api/playback/skip', async (req, res) => {
  try {
    const { trackId } = req.body;
    if (!trackId) return res.status(400).json({ error: 'trackId required' });
    const userId = req.user?.userId;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    await recordSkipForUser(userId, trackId);
    res.json({ status: 'recorded' });
  } catch (err) {
    console.error('Skip record error:', err);
    res.status(500).json({ error: 'Failed to record skip' });
  }
});

// API: Entity endpoints for UUID-based navigation

app.get('/api/artists', async (req, res) => {
  try {
    const artists = await getAllArtists();
    res.json(artists);
  } catch (error) {
    console.error('Artists fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch artists' });
  }
});

app.get('/api/artists/:id', async (req, res) => {
  try {
    const artist = await getArtistById(req.params.id);
    if (!artist) return res.status(404).json({ error: 'Artist not found' });
    const tracks = await getTracksByArtist(req.params.id);
    res.json({ ...artist, tracks });
  } catch (error) {
    console.error('Artist fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch artist' });
  }
});

app.get('/api/albums', async (req, res) => {
  try {
    const albums = await getAllAlbums();
    res.json(albums);
  } catch (error) {
    console.error('Albums fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch albums' });
  }
});

app.get('/api/albums/:id', async (req, res) => {
  try {
    const album = await getAlbumById(req.params.id);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    const tracks = await getTracksByAlbum(req.params.id);
    res.json({ ...album, tracks });
  } catch (error) {
    console.error('Album fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch album' });
  }
});

app.get('/api/genres', async (req, res) => {
  try {
    const genres = await getAllGenres();
    res.json(genres);
  } catch (error) {
    console.error('Genres fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch genres' });
  }
});

app.get('/api/genres/:id', async (req, res) => {
  try {
    const genre = await getGenreById(req.params.id);
    if (!genre) return res.status(404).json({ error: 'Genre not found' });
    const tracks = await getTracksByGenre(req.params.id);
    res.json({ ...genre, tracks });
  } catch (error) {
    console.error('Genre fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch genre' });
  }
});

// API: Get album art by track ID
app.get('/api/art', async (req, res) => {
  const b64Path = req.query.pathB64 as string;
  const rawPath = req.query.path as string;
  
  if (!b64Path && !rawPath) return res.status(404).send('Not found');

  let dbPathStr = rawPath;
  if (b64Path) {
    dbPathStr = safeAtob(b64Path);
  }

  // Recover the original byte Buffer from the latin1 DB path string.
  const fileBuf = pathToBuffer(dbPathStr);
  if (!fs.existsSync(fileBuf)) {
    return res.status(404).send('Not found');
  }

  const allowed = await isPathAllowed(fileBuf);
  if (!allowed) {
    return res.status(403).send('Forbidden: Path is outside allowed library directories');
  }

  try {
    const utf8Path = fileBuf.toString('utf8');
    const ext = utf8Path.split('.').pop()?.toLowerCase() || '';
    const mimeType = MIME_TYPES[ext] || 'audio/mpeg';

    // Same hack as scanner to read the file utilizing the raw Buffer correctly
    const fileBufHack = Buffer.from(fileBuf) as any;
    fileBufHack.lastIndexOf = (search: string) => utf8Path.lastIndexOf(search);
    fileBufHack.substring = (start: number, end?: number) => utf8Path.substring(start, end);
    fileBufHack.toLowerCase = () => utf8Path.toLowerCase();

    const metadata = await mm.parseFile(fileBufHack);
    const picture = metadata.common.picture && metadata.common.picture[0];

    if (picture) {
      res.setHeader('Content-Type', picture.format);
      res.send(picture.data);
    } else {
      res.status(404).send('No art found');
    }
  } catch (err) {
    res.status(500).send('Error reading metadata');
  }
});

// API: Check Health (reports DB connectivity)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', dbConnected, message: 'Aurora Media Server is running!' });
});

// Start server always, even if DB is unavailable.
app.listen(port, () => {
  console.log(`Aurora Media Server listening at http://localhost:${port}`);
});

// Initial connection attempt
initDatabaseConnection();

