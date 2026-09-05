import { Router } from 'express';
import { listUsers, createUser, getUserByUsername, updateUser, deleteUser, listInvites, createInvite, getInvite, deleteInvite, cleanupOrphanedPlaylists, getDatabaseStats, getPoolStats } from '../database';
import { hashPassword } from '../services/auth.service';
import { requireAdmin } from '../middleware/auth';
import { getContainerStatus, startContainer, stopContainer, createContainer, recreateContainer, getConfiguredDatabaseInfo, ContainerConfig } from '../services/containerControl.service';
import { dbConnected, setDbConnected, initDatabaseConnection, mbdbStatus, mbdbClients } from '../state';
import { mbdbService } from '../services/mbdb.service';
import { verifyToken } from '../services/auth.service';
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { createRateLimiter } from '../middleware/rateLimit';

const router = Router();
const MIN_PASSWORD_LENGTH = 12;
const adminReadRateLimit = createRateLimiter({
  keyPrefix: 'admin:read',
  windowMs: 60 * 1000,
  max: 240,
  message: 'Too many admin requests. Try again later.',
});
const adminMutationRateLimit = createRateLimiter({
  keyPrefix: 'admin:mutation',
  windowMs: 15 * 60 * 1000,
  max: 80,
  message: 'Too many admin changes. Try again later.',
});
const dbRecoveryRateLimit = createRateLimiter({
  keyPrefix: 'admin:db-recovery',
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many database recovery requests. Try again later.',
});

function getRecoveryTokenFromRequest(req: Request): string | null {
  const header = req.get('x-aurora-recovery-token') || req.get('x-db-recovery-token');
  if (header) return header.trim();
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Recovery ')) return authHeader.substring('Recovery '.length).trim();
  return null;
}

function isValidRecoveryToken(candidate: string | null): boolean {
  const expected = (process.env.AURORA_DB_RECOVERY_TOKEN || process.env.DB_RECOVERY_TOKEN || '').trim();
  if (!expected || !candidate) return false;

  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  return expectedBuffer.length === candidateBuffer.length && crypto.timingSafeEqual(expectedBuffer, candidateBuffer);
}

// Database control must remain authenticated even when the database is down.
// Normal admin JWTs work while the DB is healthy. If the DB is unavailable,
// use AURORA_DB_RECOVERY_TOKEN from the server environment as an out-of-band
// recovery credential instead of trusting any unauthenticated request.
const requireAdminOrDbRecovery = async (req: Request, res: Response, next: NextFunction) => {
  let token: string | undefined;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query.token) {
    token = req.query.token as string;
  }

  if (token) {
    const payload = await verifyToken(token);
    if (payload?.role === 'admin') {
      (req as any).user = payload;
      return next();
    }
  }

  if (dbConnected === false) {
    if (isValidRecoveryToken(getRecoveryTokenFromRequest(req))) {
      return next();
    }

    return res.status(401).json({
      error: process.env.AURORA_DB_RECOVERY_TOKEN || process.env.DB_RECOVERY_TOKEN
        ? 'Database recovery token required'
        : 'Database is down and no recovery token is configured',
    });
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  return res.status(403).json({ error: 'Admin access required' });
};

// ─── User Management ────────────────────────────────────────────────

router.get('/users', adminReadRateLimit, requireAdmin, async (req, res) => {
  try {
    const users = await listUsers();
    res.json({ users });
  } catch (error) {
    console.error('Users list error:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

router.post('/users', adminMutationRateLimit, requireAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (username.length < 3 || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Username 3+ chars, password ${MIN_PASSWORD_LENGTH}+ chars` });
    }
    if (role && role !== 'admin' && role !== 'user') {
      return res.status(400).json({ error: 'Role must be admin or user' });
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

router.put('/users/:id', adminMutationRateLimit, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { username, password, role } = req.body;

    const fields: any = {};
    if (username) fields.username = username;
    if (password) {
      if (password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ error: `Password must be ${MIN_PASSWORD_LENGTH}+ characters` });
      }
      fields.passwordHash = await hashPassword(password);
    }
    if (role) {
      if (role !== 'admin' && role !== 'user') {
        return res.status(400).json({ error: 'Role must be admin or user' });
      }
      fields.role = role;
    }

    await updateUser(id as string, fields);
    res.json({ status: 'updated' });
  } catch (error) {
    console.error('User update error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

router.delete('/users/:id', adminMutationRateLimit, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
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

// ─── Invite Management ──────────────────────────────────────────────

router.get('/invites', adminReadRateLimit, requireAdmin, async (req, res) => {
  try {
    const invites = await listInvites();
    res.json({ invites });
  } catch (error) {
    console.error('Invites list error:', error);
    res.status(500).json({ error: 'Failed to list invites' });
  }
});

router.post('/invites', adminMutationRateLimit, requireAdmin, async (req, res) => {
  try {
    const { role, maxUses, expiresIn, expiresInDays } = req.body;
    // The admin UI sends expiresInDays; expiresIn (seconds) stays accepted for
    // any caller that already used it. Reading only expiresIn silently dropped
    // every expiry, so every invite ever issued is permanent.
    const ttlSeconds = expiresInDays != null
      ? Number(expiresInDays) * 24 * 60 * 60
      : expiresIn != null ? Number(expiresIn) : null;
    if (ttlSeconds != null && (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)) {
      return res.status(400).json({ error: 'Invite expiry must be a positive number of days.' });
    }
    const expiresAt = ttlSeconds == null ? null : Date.now() + ttlSeconds * 1000;
    const invite = await createInvite(req.user!.userId, role || 'user', maxUses || 1, expiresAt);

    const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
    const inviteUrl = `${origin}/invite/${invite.token}`;

    res.json({ invite, inviteUrl });
  } catch (error) {
    console.error('Invite create error:', error);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

router.delete('/invites/:token', adminMutationRateLimit, requireAdmin, async (req, res) => {
  try {
    await deleteInvite(req.params.token as string);
    res.json({ status: 'revoked' });
  } catch (error) {
    console.error('Invite delete error:', error);
    res.status(500).json({ error: 'Failed to revoke invite' });
  }
});

// Cleanup orphaned playlists
router.post('/cleanup-playlists', adminMutationRateLimit, requireAdmin, async (req, res) => {
  try {
    const deletedCount = await cleanupOrphanedPlaylists();
    res.json({ status: 'ok', deletedCount });
  } catch (error) {
    console.error('Cleanup orphaned playlists error:', error);
    res.status(500).json({ error: 'Failed to cleanup orphaned playlists' });
  }
});

// ─── Database Container Control ─────────────────────────────────────

router.get('/db/status', dbRecoveryRateLimit, requireAdminOrDbRecovery, async (req, res) => {
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

router.get('/db/stats', dbRecoveryRateLimit, requireAdminOrDbRecovery, async (req, res) => {
  try {
    const stats = await getDatabaseStats();
    const poolStats = await getPoolStats();
    res.json({ ...stats, pool: poolStats });
  } catch (error: any) {
    console.error('DB stats error:', error);
    res.status(500).json({ error: error.message || 'Failed to get database statistics' });
  }
});

router.post('/db/start', dbRecoveryRateLimit, requireAdminOrDbRecovery, async (req, res) => {
  try {
    const containerName = process.env.DB_CONTAINER_NAME || 'music-postgres';
    const result = await startContainer(containerName);
    initDatabaseConnection();
    res.json(result);
  } catch (error: any) {
    console.error('DB start error:', error);
    res.status(500).json({ error: error.message || 'Failed to start database' });
  }
});

router.post('/db/stop', adminMutationRateLimit, requireAdmin, async (req, res) => {
  try {
    const containerName = process.env.DB_CONTAINER_NAME || 'music-postgres';
    const result = await stopContainer(containerName);
    setDbConnected(false);
    res.json(result);
  } catch (error: any) {
    console.error('DB stop error:', error);
    res.status(500).json({ error: error.message || 'Failed to stop database' });
  }
});

router.post('/db/create', dbRecoveryRateLimit, requireAdminOrDbRecovery, async (req, res) => {
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
    initDatabaseConnection();
    res.json(result);
  } catch (error: any) {
    console.error('DB create error:', error);
    res.status(500).json({ error: error.message || 'Failed to create database' });
  }
});

router.post('/db/recreate', dbRecoveryRateLimit, requireAdminOrDbRecovery, async (req, res) => {
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
    initDatabaseConnection();
    res.json(result);
  } catch (error: any) {
    console.error('DB recreate error:', error);
    res.status(500).json({ error: error.message || 'Failed to recreate database' });
  }
});

// ─── MBDB Endpoints ───────────────────────────────────────────────────

router.get('/mbdb/status', adminReadRateLimit, requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (mbdbClients) mbdbClients.add(res);
  res.write(`data: ${JSON.stringify(mbdbStatus)}\n\n`);

  req.on('close', () => {
    if (mbdbClients) mbdbClients.delete(res);
  });
});

router.post('/mbdb/import', adminMutationRateLimit, requireAdmin, async (req, res) => {
  if (mbdbStatus.isImporting) {
    return res.status(400).json({ error: 'Import already in progress' });
  }
  
  // Fire and forget, client listens via SSE
  mbdbService.importDatabase().catch(err => console.error('MBDB Import failed:', err));
  
  res.json({ message: 'MBDB Import started' });
});

router.post('/mbdb/cancel', adminMutationRateLimit, requireAdmin, async (req, res) => {
  if (!mbdbStatus.isImporting) {
    return res.status(400).json({ error: 'No import in progress' });
  }
  
  mbdbService.cancelImport();
  res.json({ message: 'Import cancellation requested' });
});

router.get('/mbdb/check-update', adminReadRateLimit, requireAdmin, async (req, res) => {
  try {
    const latestResponse = await fetch('https://data.metabrainz.org/pub/musicbrainz/data/fullexport/LATEST');
    const latestTag = (await latestResponse.text()).trim();
    
    // Get last import info
    const { queryWithRetry } = await import('../utils/db');
    let lastImport = null;
    try {
      const result = await queryWithRetry("SELECT value FROM system_settings WHERE key = 'mbdbLastImport'");
      if (result.rows.length > 0) {
        lastImport = JSON.parse(result.rows[0].value);
      }
    } catch (e) {}
    
    // Ensure lastImport has a consistent structure for the frontend
    const serializedLastImport = lastImport ? {
      ...lastImport,
      counts: lastImport.counts || { genres: 0, aliases: 0, links: 0 }
    } : null;
    
    res.json({
      latestTag,
      lastImportTag: lastImport?.tag || null,
      lastImportTimestamp: lastImport?.timestamp || null,
      updateAvailable: lastImport ? latestTag !== lastImport.tag : true,
      lastImport: serializedLastImport
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Unified Health Endpoint ──────────────────────────────────────────

router.get('/health', adminReadRateLimit, requireAdmin, async (req, res) => {
  try {
    const containerName = process.env.DB_CONTAINER_NAME || 'music-postgres';
    const containerStatus = await getContainerStatus(containerName);
    const poolStats = getPoolStats();
    const { scanStatus, mbdbStatus } = await import('../state');
    const { queryWithRetry } = await import('../utils/db');
    
    // Check MBDB record count for better "Import correct" feedback
    let mbdbCount = 0;
    if (dbConnected) {
      try {
        const mbdbCountRes = await queryWithRetry('SELECT COUNT(*) as count FROM genre_tree_paths');
        mbdbCount = parseInt((mbdbCountRes.rows[0] as any).count, 10);
      } catch (e) {
        console.warn('[Admin Health] Could not fetch MBDB count (DB likely down or uninitialized)');
      }
    }

    res.json({
      status: 'ok',
      database: {
        connected: dbConnected,
        pool: poolStats,
        mbdb_records: mbdbCount
      },
      container: containerStatus,
      scanner: scanStatus,
      mbdb: mbdbStatus
    });
  } catch (error: any) {
    console.error('Admin health check error:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch health metrics' });
  }
});

// ─── Service / Runtime Status ──────────────────────────────────────────
// Detects whether this Node process is currently being managed by pm2 or
// systemd (via well-known env vars set by each supervisor). Also reports
// filesystem presence of known config files so we can show "Configured"
// even when the user is currently running manually.
router.get('/service/status', adminReadRateLimit, requireAdmin, async (_req, res) => {
  const env = process.env;
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');

  const pm2Active = !!(env.pm_id || env.PM_ID || env.PM2_HOME || env.pm2_id);
  const systemdActive = !!(env.INVOCATION_ID || env.JOURNAL_STREAM);

  let pm2Configured = false;
  try {
    const dumpPath = path.join(os.homedir(), '.pm2', 'dump.pm2');
    if (fs.existsSync(dumpPath)) {
      const dump = fs.readFileSync(dumpPath, 'utf8');
      if (/aurora/i.test(dump)) pm2Configured = true;
    }
  } catch { /* ignore */ }

  let systemdConfigured = false;
  let systemdUnitPath: string | null = null;
  try {
    const candidates = [
      path.join(os.homedir(), '.config', 'systemd', 'user', 'aurora.service'),
      '/etc/systemd/system/aurora.service',
      '/lib/systemd/system/aurora.service',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) { systemdConfigured = true; systemdUnitPath = p; break; }
    }
  } catch { /* ignore */ }

  const runtime: 'pm2' | 'systemd' | 'manual' = pm2Active
    ? 'pm2'
    : systemdActive
      ? 'systemd'
      : 'manual';

  res.json({
    runtime,
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    pm2: {
      active: pm2Active,
      configured: pm2Configured,
      processName: env.name || env.PM2_NAME || null,
      pmId: env.pm_id || env.PM_ID || null,
      instance: env.NODE_APP_INSTANCE || null,
    },
    systemd: {
      active: systemdActive,
      configured: systemdConfigured,
      unitPath: systemdUnitPath,
      invocationId: env.INVOCATION_ID || null,
    },
  });
});

export default router;
