import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getJwtSecret, getTokenExpiry, JwtPayload } from './auth.service';

// 'receiver' is for a Cast receiver keeping its own queue fed with no sender
// attached. 'output' is an output credential: proof that the bearer holds one
// session's current output grant. Capability sets are enumerated in
// middleware/apiV1Auth.ts.
export type ScopedTokenScope = 'media' | 'sse' | 'receiver' | 'output';

export interface ScopedTokenPayload extends JwtPayload {
  scope: ScopedTokenScope;
}

export async function generateScopedToken(scope: ScopedTokenScope, user: JwtPayload, rememberMe = true): Promise<string> {
  const secret = await getJwtSecret();
  const payload: ScopedTokenPayload = {
    userId: user.userId,
    username: user.username,
    role: user.role,
    scope,
  };
  return jwt.sign(payload, secret, { expiresIn: getTokenExpiry(rememberMe) });
}

/** Short-lived capability used by first-party clients for URL-only media/SSE transports. */
export async function generateEphemeralScopedToken(
  scope: ScopedTokenScope,
  user: JwtPayload,
  // 12h exists for a Cast receiver: a shorter token cannot survive "phone
  // asleep for four hours", and with the tab closed nobody can renew it.
  expiresIn: '5m' | '15m' | '1h' | '12h' = '15m',
): Promise<string> {
  const secret = await getJwtSecret();
  const payload: ScopedTokenPayload = {
    userId: user.userId,
    username: user.username,
    role: user.role,
    scope,
  };
  return jwt.sign(payload, secret, { expiresIn });
}

export async function verifyScopedToken(token: string, scope: ScopedTokenScope): Promise<ScopedTokenPayload | null> {
  try {
    const secret = await getJwtSecret();
    const decoded = jwt.verify(token, secret) as ScopedTokenPayload;
    if (decoded.scope !== scope) return null;
    if (!decoded.userId || !decoded.username || !decoded.role) return null;
    return decoded;
  } catch {
    return null;
  }
}

export interface OutputGrantClaims {
  /** Playback session ID. */
  sid: string;
  /** Output ID: the device the grant was issued to. */
  oid: string;
  /** Grant generation; only the session's current one is honoured. */
  gen: number;
}

export interface OutputCredentialPayload extends ScopedTokenPayload, OutputGrantClaims {
  scope: 'output';
  jti: string;
}

export const OUTPUT_CREDENTIAL_TTL_SECONDS = 3600;

/**
 * An output credential names exactly one grant. It is minted only by claiming
 * (or refreshing) a session's output, never by POST /auth/scoped-token, and
 * whoever checks it must also check `gen` against the session's current grant.
 */
export async function generateOutputCredential(user: JwtPayload, grant: OutputGrantClaims): Promise<{ token: string; expiresAt: string }> {
  const secret = await getJwtSecret();
  const payload: OutputCredentialPayload = {
    userId: user.userId,
    username: user.username,
    role: user.role,
    scope: 'output',
    sid: grant.sid,
    oid: grant.oid,
    gen: grant.gen,
    jti: crypto.randomUUID(),
  };
  const token = jwt.sign(payload, secret, { expiresIn: OUTPUT_CREDENTIAL_TTL_SECONDS });
  return { token, expiresAt: new Date(Date.now() + OUTPUT_CREDENTIAL_TTL_SECONDS * 1000).toISOString() };
}

export async function verifyOutputCredential(token: string): Promise<OutputCredentialPayload | null> {
  const decoded = await verifyScopedToken(token, 'output') as OutputCredentialPayload | null;
  if (!decoded) return null;
  if (typeof decoded.sid !== 'string' || typeof decoded.oid !== 'string' || !Number.isInteger(decoded.gen)) return null;
  return decoded;
}
