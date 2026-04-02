import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../services/auth.service';
import { getSystemSetting } from '../database';

// Extend Express Request to include user info
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// Check if setup is needed (no users exist yet)
async function checkNeedsSetup(): Promise<boolean> {
  const { hasUsers } = await import('../database');
  return !(await hasUsers());
}

// JWT authentication middleware
// Supports: Authorization: Bearer <token> or ?token=<token> query param
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const path = req.path;
  
  // Allow unprotected access to setup status, health, auth, and invite validation
  if (
    path === '/api/setup/status' ||
    path === '/api/health' ||
    path === '/api/auth/login' ||
    path === '/api/auth/register' ||
    path.startsWith('/api/invites/') ||
    path === '/api/admin/db/status' ||
    path === '/api/admin/db/stats' ||
    path === '/api/admin/db/start' ||
    path === '/api/admin/db/create' ||
    path === '/api/admin/db/recreate' ||
    path === '/api/providers/lastfm/callback' ||
    path === '/api/providers/musicbrainz/callback' ||
    path === '/api/providers/external/proxy-image'
  ) {
    return next();
  }

  // If no users exist yet, allow access to setup-complete
  if (req.path === '/api/setup/complete') {
    const needsSetup = await checkNeedsSetup();
    if (needsSetup) return next();
  }

  // Extract token from Authorization header or query param
  let token: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.query.token) {
    token = req.query.token as string;
  }

  // Fallback: Support legacy Basic Auth during transition
  if (!token && authHeader && authHeader.startsWith('Basic ')) {
    const b64auth = authHeader.split(' ')[1];
    const [username, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    if (username && password) {
      const { getUserByUsername } = await import('../database');
      const { verifyPassword: checkPassword } = await import('../services/auth.service');
      const user = await getUserByUsername(username);
      if (user && await checkPassword(password, user.password_hash)) {
        req.user = { userId: user.id, username: user.username, role: user.role };
        return next();
      }
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const payload = await verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = payload;
  next();
}

// Admin-only middleware (must be used after requireAuth)
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
