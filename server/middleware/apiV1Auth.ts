import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../services/auth.service';
import { verifyAuroraAppKey } from '../services/auroraAppAuth.service';
import { verifyScopedToken, type ScopedTokenScope } from '../services/scopedToken.service';

export interface ApiV1Principal {
  userId: string;
  username: string;
  role: string;
  clientId: string;
  clientName: string;
  authKind: 'jwt' | 'appKey' | 'scoped';
  scope?: ScopedTokenScope;
  keyId?: string;
}

declare global {
  namespace Express {
    interface Request {
      apiV1?: ApiV1Principal;
      requestId?: string;
    }
  }
}

function bearer(req: Request): string | null {
  const value = req.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice(7).trim() : null;
}

export function apiV1RequestContext(req: Request, res: Response, next: NextFunction) {
  const supplied = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].trim() : '';
  req.requestId = /^[A-Za-z0-9._:-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('X-Aurora-API-Version', '1');
  next();
}

export function sendApiV1Error(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return res.status(status).json({
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      requestId: req.requestId || crypto.randomUUID(),
    },
  });
}

/**
 * Scope → the endpoints that scope may authenticate.
 *
 * A scoped token is a narrow capability, not a session, so this is an allowlist
 * per scope rather than a guess at one scope per path. Anything not listed here
 * is refused with SCOPED_TOKEN_NOT_ALLOWED, which is the security guarantee
 * these tokens rest on — see the deny cases in apiV1Auth.test.ts.
 */
const SCOPE_ALLOWED_ENDPOINTS: Record<string, (method: string, path: string) => boolean> = {
  media: (_method, path) => path.startsWith('/artwork/'),
  sse: (_method, path) => path === '/events',
  // A Cast receiver feeding its own queue with no sender attached needs exactly
  // four things: ask for a track, resolve a playable URL for it, report what it
  // played so server-side history advances, and read the played-threshold
  // preference. Notably NOT: mutating preferences, playlists, loved/rating, or
  // anything under /app-keys.
  receiver: (method, path) => (
    (method === 'POST' && path === '/recommendations/next')
    || (method === 'POST' && /^\/tracks\/[^/]+\/playback$/.test(path))
    || (method === 'POST' && path === '/playback/reports')
    || (method === 'GET' && path === '/preferences')
  ),
};

const SCOPE_CLIENT_NAMES: Record<string, string> = {
  media: 'Aurora artwork',
  sse: 'Aurora event stream',
  receiver: 'Aurora Cast receiver',
};

export async function requireApiV1Auth(req: Request, res: Response, next: NextFunction) {
  try {
    let token = bearer(req);
    if (!token && req.path.startsWith('/artwork/') && typeof req.query.token === 'string') {
      const scoped = await verifyScopedToken(req.query.token, 'media');
      if (!scoped) return sendApiV1Error(req, res, 401, 'INVALID_MEDIA_TOKEN', 'The media token is invalid or expired.');
      req.apiV1 = {
        userId: scoped.userId,
        username: scoped.username,
        role: scoped.role,
        clientId: `media:${scoped.userId}`,
        clientName: 'Aurora artwork',
        authKind: 'scoped',
        scope: 'media',
      };
      req.user = { userId: scoped.userId, username: scoped.username, role: scoped.role };
      return next();
    }
    if (!token && req.path === '/events' && typeof req.query.token === 'string') {
      const scoped = await verifyScopedToken(req.query.token, 'sse');
      if (!scoped) return sendApiV1Error(req, res, 401, 'INVALID_EVENT_TOKEN', 'The event token is invalid or expired.');
      req.apiV1 = {
        userId: scoped.userId,
        username: scoped.username,
        role: scoped.role,
        clientId: `events:${scoped.userId}`,
        clientName: 'Aurora event stream',
        authKind: 'scoped',
        scope: 'sse',
      };
      req.user = { userId: scoped.userId, username: scoped.username, role: scoped.role };
      return next();
    }
    if (!token) return sendApiV1Error(req, res, 401, 'AUTHENTICATION_REQUIRED', 'Authentication required.');

    if (token.startsWith('aurora_app_')) {
      const principal = await verifyAuroraAppKey(token);
      if (!principal) return sendApiV1Error(req, res, 401, 'INVALID_APP_KEY', 'The Aurora app key is invalid or revoked.');
      req.apiV1 = principal;
      req.user = { userId: principal.userId, username: principal.username, role: principal.role };
      return next();
    }

    const payload = await verifyToken(token);
    if (!payload) return sendApiV1Error(req, res, 401, 'INVALID_SESSION', 'The Aurora session is invalid or expired.');
    const tokenScope = (payload as typeof payload & { scope?: unknown }).scope;
    if (tokenScope !== undefined) {
      const scopeName = typeof tokenScope === 'string' ? tokenScope : '';
      const matcher = SCOPE_ALLOWED_ENDPOINTS[scopeName];
      const allowedScope = matcher && matcher(req.method, req.path) ? (scopeName as ScopedTokenScope) : null;
      if (!allowedScope) {
        return sendApiV1Error(
          req,
          res,
          403,
          'SCOPED_TOKEN_NOT_ALLOWED',
          'This scoped token cannot authenticate the requested endpoint.',
        );
      }
      const scoped = await verifyScopedToken(token, allowedScope);
      if (!scoped) {
        return sendApiV1Error(req, res, 401, 'INVALID_SCOPED_TOKEN', 'The scoped token is invalid or expired.');
      }
      req.apiV1 = {
        userId: scoped.userId,
        username: scoped.username,
        role: scoped.role,
        clientId: `${allowedScope}:${scoped.userId}`,
        clientName: SCOPE_CLIENT_NAMES[allowedScope],
        authKind: 'scoped',
        scope: allowedScope,
      };
      req.user = { userId: scoped.userId, username: scoped.username, role: scoped.role };
      return next();
    }
    const headerClientId = typeof req.headers['x-aurora-client-id'] === 'string'
      ? req.headers['x-aurora-client-id'].trim()
      : '';
    const clientId = /^[A-Za-z0-9._:-]{8,128}$/.test(headerClientId) ? headerClientId : `web:${payload.userId}`;
    const clientName = typeof req.headers['x-aurora-client-name'] === 'string'
      ? req.headers['x-aurora-client-name'].trim().slice(0, 120)
      : 'Aurora Web';
    req.apiV1 = { ...payload, clientId, clientName, authKind: 'jwt' };
    req.user = payload;
    next();
  } catch (error) {
    console.error('[API v1] authentication error:', error);
    sendApiV1Error(req, res, 500, 'AUTHENTICATION_FAILED', 'Authentication could not be completed.');
  }
}

export function requireApiV1WebSession(req: Request, res: Response, next: NextFunction) {
  if (req.apiV1?.authKind !== 'jwt') {
    return sendApiV1Error(req, res, 403, 'WEB_SESSION_REQUIRED', 'Manage app access from an authenticated Aurora web session.');
  }
  next();
}
