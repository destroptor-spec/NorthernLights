import { Router } from 'express';
import { listUsers, createUser, getUserByUsername, updateUser, deleteUser, listInvites, createInvite, getInvite, deleteInvite, cleanupOrphanedPlaylists, getDatabaseStats } from '../database';
import { hashPassword } from '../services/auth.service';
import { requireAdmin } from '../middleware/auth';
import { getContainerStatus, startContainer, stopContainer, createContainer, recreateContainer, getConfiguredDatabaseInfo, ContainerConfig } from '../services/containerControl.service';
import { dbConnected, setDbConnected, initDatabaseConnection, mbdbStatus, mbdbClients } from '../state';
import { mbdbService } from '../services/mbdb.service';
import { verifyToken } from '../services/auth.service';
import { Request, Response, NextFunction } from 'express';

const router = Router();

// Special middleware to allow DB control even if DB is down (bootstrap/emergency)
const requireAdminOrDbDown = async (req: Request, res: Response, next: NextFunction) => {
  if (dbConnected === false) {
    return next();
  }

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

  (req as any).user = payload;
  next();
};

// ─── User Management ────────────────────────────────────────────────

router.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await listUsers();
    res.json({ users });
  } catch (error) {
    console.error('Users list error:', error);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

router.post('/users', requireAdmin, async (req, res) => {
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

router.put('/users/:id', requireAdmin, async (req, res) => {
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

router.delete('/users/:id', requireAdmin, async (req, res) => {
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

router.get('/invites', requireAdmin, async (req, res) => {
  try {
    const invites = await listInvites();
    res.json({ invites });
  } catch (error) {
    console.error('Invites list error:', error);
    res.status(500).json({ error: 'Failed to list invites' });
  }
});

router.post('/invites', requireAdmin, async (req, res) => {
  try {
    const { role, maxUses, expiresIn } = req.body;
    const expiresAt = expiresIn ? Date.now() + (parseInt(expiresIn, 10) * 1000) : null;
    const invite = await createInvite(req.user!.userId, role || 'user', maxUses || 1, expiresAt);

    const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
    const inviteUrl = `${origin}/invite/${invite.token}`;

    res.json({ invite, inviteUrl });
  } catch (error) {
    console.error('Invite create error:', error);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

router.delete('/invites/:token', requireAdmin, async (req, res) => {
  try {
    await deleteInvite(req.params.token as string);
    res.json({ status: 'revoked' });
  } catch (error) {
    console.error('Invite delete error:', error);
    res.status(500).json({ error: 'Failed to revoke invite' });
  }
});

// Cleanup orphaned playlists
router.post('/cleanup-playlists', requireAdmin, async (req, res) => {
  try {
    const deletedCount = await cleanupOrphanedPlaylists();
    res.json({ status: 'ok', deletedCount });
  } catch (error) {
    console.error('Cleanup orphaned playlists error:', error);
    res.status(500).json({ error: 'Failed to cleanup orphaned playlists' });
  }
});

// ─── Database Container Control ─────────────────────────────────────

router.get('/db/status', requireAdminOrDbDown, async (req, res) => {
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

router.get('/db/stats', requireAdminOrDbDown, async (req, res) => {
  try {
    const stats = await getDatabaseStats();
    res.json(stats);
  } catch (error: any) {
    console.error('DB stats error:', error);
    res.status(500).json({ error: error.message || 'Failed to get database statistics' });
  }
});

router.post('/db/start', requireAdminOrDbDown, async (req, res) => {
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

router.post('/db/stop', requireAdmin, async (req, res) => {
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

router.post('/db/create', requireAdminOrDbDown, async (req, res) => {
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

router.post('/db/recreate', requireAdminOrDbDown, async (req, res) => {
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

router.get('/mbdb/status', requireAdmin, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (mbdbClients) mbdbClients.add(res);
  res.write(`data: ${JSON.stringify(mbdbStatus)}\n\n`);

  req.on('close', () => {
    if (mbdbClients) mbdbClients.delete(res);
  });
});

router.post('/mbdb/import', requireAdmin, async (req, res) => {
  if (mbdbStatus.isImporting) {
    return res.status(400).json({ error: 'Import already in progress' });
  }
  
  // Fire and forget, client listens via SSE
  mbdbService.importDatabase().catch(err => console.error('MBDB Import failed:', err));
  
  res.json({ message: 'MBDB Import started' });
});

export default router;
