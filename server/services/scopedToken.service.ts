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

export interface ReceiverCredentialPayload extends ScopedTokenPayload, OutputGrantClaims {
  scope: 'receiver';
  jti: string;
  /** Epoch seconds: no renewal of this credential reaches beyond it. */
  cap: number;
}

/** One receiver credential lasts this long at most... */
export const RECEIVER_CREDENTIAL_TTL_SECONDS = 12 * 3600;
/** ...and renewals never reach beyond this long after a controller issued one. */
export const RECEIVER_CREDENTIAL_CAP_SECONDS = 24 * 3600;

/**
 * A Cast receiver's own credential (docs/cast-receiver-output.md, PR B): bound
 * to one session's output grant like an output credential, valid for up to
 * 12 h, and renewable by the receiver itself while it plays the session, up
 * to `cap`. A controller issuing one (a claim or a refresh) sets a new cap 24 h
 * ahead; the receiver's own renewals keep the cap it has. Never minted by
 * POST /auth/scoped-token.
 */
export async function generateReceiverCredential(
  user: JwtPayload,
  grant: OutputGrantClaims,
  capEpochSeconds?: number,
): Promise<{ token: string; expiresAt: string; cap: string } | null> {
  const now = Math.floor(Date.now() / 1000);
  const cap = capEpochSeconds ?? now + RECEIVER_CREDENTIAL_CAP_SECONDS;
  const expiresAt = Math.min(now + RECEIVER_CREDENTIAL_TTL_SECONDS, cap);
  if (expiresAt <= now) return null;
  const secret = await getJwtSecret();
  const payload: ReceiverCredentialPayload = {
    userId: user.userId,
    username: user.username,
    role: user.role,
    scope: 'receiver',
    sid: grant.sid,
    oid: grant.oid,
    gen: grant.gen,
    cap,
    jti: crypto.randomUUID(),
  };
  const token = jwt.sign({ ...payload, exp: expiresAt }, secret);
  return { token, expiresAt: new Date(expiresAt * 1000).toISOString(), cap: new Date(cap * 1000).toISOString() };
}

export async function verifyReceiverCredential(token: string): Promise<ReceiverCredentialPayload | null> {
  const decoded = await verifyScopedToken(token, 'receiver') as ReceiverCredentialPayload | null;
  if (!decoded) return null;
  if (typeof decoded.sid !== 'string' || typeof decoded.oid !== 'string' || !Number.isInteger(decoded.gen)) return null;
  if (!Number.isInteger(decoded.cap)) return null;
  return decoded;
}
