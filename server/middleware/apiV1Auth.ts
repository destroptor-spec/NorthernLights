import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { verifyToken } from '../services/auth.service';
import { verifyAuroraAppKey } from '../services/auroraAppAuth.service';
import {
  verifyOutputCredential,
  verifyReceiverCredential,
  verifyScopedToken,
  type OutputGrantClaims,
  type ReceiverCredentialPayload,
  type ScopedTokenScope,
} from '../services/scopedToken.service';

export interface ApiV1Principal {
  userId: string;
  username: string;
  role: string;
  clientId: string;
  clientName: string;
  authKind: 'jwt' | 'appKey' | 'scoped';
  scope?: ScopedTokenScope;
  keyId?: string;
  /** Set for an output or receiver credential: the one grant it proves. */
  outputGrant?: OutputGrantClaims;
  /** Receiver credentials only: epoch seconds no renewal reaches beyond. */
  receiverCap?: number;
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
const OUTPUT_REPORT_PATH = /^\/playback-sessions\/([^/]+)\/reports$/;
/** A receiver's own session, which it reads, reports to and renews its credential for. */
const RECEIVER_SESSION_PATHS: Array<[method: string, path: RegExp]> = [
  ['GET', /^\/playback-sessions\/([^/]+)$/],
  ['POST', OUTPUT_REPORT_PATH],
  ['POST', /^\/playback-sessions\/([^/]+)\/output\/renew$/],
];

/** The session a receiver-session path names, or null for any other path. */
function receiverSessionInPath(method: string, path: string): string | null {
  for (const [allowedMethod, pattern] of RECEIVER_SESSION_PATHS) {
    const match = method === allowedMethod ? pattern.exec(path) : null;
    if (match) return match[1];
  }
  return null;
}

const SCOPE_ALLOWED_ENDPOINTS: Record<string, (method: string, path: string) => boolean> = {
  media: (_method, path) => path.startsWith('/artwork/'),
  sse: (_method, path) => path === '/events',
  // A receiver credential (docs/cast-receiver-output.md, PR B): a Cast
  // receiver playing one session on its own. It follows that session (read it,
  // its events, report, renew its credential; the session is checked below,
  // where the claims are known), resolves playable URLs, asks for a track for
  // Infinity, reports what it played so history advances, and reads the
  // played-threshold preference. Notably NOT: other sessions, changing any
  // session, preferences, playlists, loved/rating, or anything under /app-keys.
  receiver: (method, path) => (
    (method === 'POST' && path === '/recommendations/next')
    || (method === 'POST' && /^\/tracks\/[^/]+\/playback$/.test(path))
    || (method === 'POST' && path === '/playback/reports')
    || (method === 'GET' && path === '/preferences')
    || (method === 'GET' && path === '/events')
    || receiverSessionInPath(method, path) !== null
  ),
  // An output credential proves one session's output grant, and reporting is
  // all it is for. The session in the path must be the credential's own; that
  // is checked below, where the claims are known.
  output: (method, path) => method === 'POST' && OUTPUT_REPORT_PATH.test(path),
};

const SCOPE_CLIENT_NAMES: Record<string, string> = {
  media: 'Aurora artwork',
  sse: 'Aurora event stream',
  receiver: 'Aurora Cast receiver',
  output: 'Aurora playback output',
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
      // A receiver's EventSource cannot send headers either.
      const receiver = await verifyReceiverCredential(req.query.token);
      if (receiver) {
        setReceiverPrincipal(req, receiver);
        return next();
      }
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
      if (allowedScope === 'output') {
        const grant = await verifyOutputCredential(token);
        if (!grant) return sendApiV1Error(req, res, 401, 'INVALID_SCOPED_TOKEN', 'The scoped token is invalid or expired.');
        if (OUTPUT_REPORT_PATH.exec(req.path)?.[1] !== grant.sid) {
          return sendApiV1Error(req, res, 403, 'SCOPED_TOKEN_NOT_ALLOWED', 'This scoped token cannot authenticate the requested endpoint.');
        }
        req.apiV1 = {
          userId: grant.userId,
          username: grant.username,
          role: grant.role,
          clientId: grant.oid,
          clientName: SCOPE_CLIENT_NAMES.output,
          authKind: 'scoped',
          scope: 'output',
          outputGrant: { sid: grant.sid, oid: grant.oid, gen: grant.gen },
        };
        req.user = { userId: grant.userId, username: grant.username, role: grant.role };
        return next();
      }
      if (allowedScope === 'receiver') {
        // Only a credential bound to a grant: the unbound receiver tokens
        // POST /auth/scoped-token once minted are refused.
        const receiver = await verifyReceiverCredential(token);
        if (!receiver) return sendApiV1Error(req, res, 401, 'INVALID_SCOPED_TOKEN', 'The scoped token is invalid or expired.');
        const pathSession = receiverSessionInPath(req.method, req.path);
        if (pathSession !== null && pathSession !== receiver.sid) {
          return sendApiV1Error(req, res, 403, 'SCOPED_TOKEN_NOT_ALLOWED', 'This scoped token cannot authenticate the requested endpoint.');
        }
        setReceiverPrincipal(req, receiver);
        return next();
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

function setReceiverPrincipal(req: Request, receiver: ReceiverCredentialPayload) {
  req.apiV1 = {
    userId: receiver.userId,
    username: receiver.username,
    role: receiver.role,
    clientId: receiver.oid,
    clientName: SCOPE_CLIENT_NAMES.receiver,
    authKind: 'scoped',
    scope: 'receiver',
    outputGrant: { sid: receiver.sid, oid: receiver.oid, gen: receiver.gen },
    receiverCap: receiver.cap,
  };
  req.user = { userId: receiver.userId, username: receiver.username, role: receiver.role };
}

export function requireApiV1WebSession(req: Request, res: Response, next: NextFunction) {
  if (req.apiV1?.authKind !== 'jwt') {
    return sendApiV1Error(req, res, 403, 'WEB_SESSION_REQUIRED', 'Manage app access from an authenticated Aurora web session.');
  }
  next();
}
