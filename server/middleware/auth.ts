import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '../services/auth.service';
import { ScopedTokenScope } from '../services/scopedToken.service';

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

  const scopedScope = getScopedTokenScopeForPath(path);

  // Extract token from Authorization header or query param
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
  if (payload) {
    // A scoped token is a narrow transport capability, not a session. It must
    // only satisfy the endpoint class it was minted for.
    //
    // `verifyToken` is deliberately scope-blind — it is the same function that
    // validates full sessions — and scoped tokens are signed with the same
    // secret, carrying nothing but a `scope` claim to distinguish them. So
    // returning here unconditionally let a `media` token (which travels in
    // every stream and artwork URL, and lives 30 days with "remember me")
    // satisfy every non-allowlisted /api route, `requireAdmin` included, since
    // that only inspects `role`. The mapping below was unreachable for any
    // valid token. docs/API.md already documented the behaviour implemented
    // here; /api/v1 has always enforced it (see middleware/apiV1Auth.ts).
    const tokenScope = (payload as { scope?: unknown }).scope;
    if (typeof tokenScope === 'string' && tokenScope !== '') {
      if (!scopedScope || tokenScope !== scopedScope) {
        return res.status(403).json({ error: 'Scoped token is not valid for this endpoint' });
      }
    }
    req.user = payload;
    return next();
  }

  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Admin-only middleware (must be used after requireAuth)
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function getScopedTokenScopeForPath(path: string): ScopedTokenScope | null {
  if (
    path.startsWith('/api/stream') ||
    path === '/api/art' ||
    path === '/api/cast/log'
  ) {
    return 'media';
  }

  if (
    path === '/api/library/scan/status' ||
    path === '/api/admin/mbdb/status' ||
    path === '/api/settings/models/progress'
  ) {
    return 'sse';
  }

  return null;
}
