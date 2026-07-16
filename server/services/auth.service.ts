import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { getSystemSetting, setSystemSetting } from '../database';

const SALT_ROUNDS = 12;
// "Remember me on this device" issues long-lived tokens; otherwise the session
// is short-lived and the client keeps tokens out of persistent storage.
const TOKEN_EXPIRY_REMEMBERED = '30d';
const TOKEN_EXPIRY_SESSION = '12h';

let cachedSecret: string | null = null;

export async function getJwtSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;

  let secret = await getSystemSetting('jwtSecret');
  if (!secret) {
    // Generate a new secret on first use
    secret = crypto.randomBytes(64).toString('hex');
    await setSystemSetting('jwtSecret', secret);
    console.log('[Auth] Generated new JWT secret');
  }
  cachedSecret = secret;
  return secret;
}

export async function regenerateJwtSecret(): Promise<string> {
  const secret = crypto.randomBytes(64).toString('hex');
  await setSystemSetting('jwtSecret', secret);
  cachedSecret = secret;
  console.log('[Auth] Regenerated JWT secret — all existing tokens invalidated');
  return secret;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Unknown-username logins must cost the same as wrong-password ones, or the
// response time becomes a username-enumeration oracle. The dummy hash is
// generated (not hardcoded) so its cost factor always tracks SALT_ROUNDS.
let dummyHashPromise: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= bcrypt.hash(crypto.randomBytes(16).toString('hex'), SALT_ROUNDS);
  return dummyHashPromise;
}

// Pre-warm at module load so the first unknown-user login doesn't pay an
// extra hash on top of the compare.
void getDummyHash().catch(() => { dummyHashPromise = null; });

export async function verifyDummyPassword(password: string): Promise<false> {
  try {
    await bcrypt.compare(password, await getDummyHash());
  } catch {
    // Even a bcrypt failure must not distinguish this path from a real compare.
  }
  return false;
}

export interface JwtPayload {
  userId: string;
  username: string;
  role: string;
}

export function getTokenExpiry(rememberMe: boolean) {
  return rememberMe ? TOKEN_EXPIRY_REMEMBERED : TOKEN_EXPIRY_SESSION;
}

export async function generateToken(payload: JwtPayload, rememberMe = true): Promise<string> {
  const secret = await getJwtSecret();
  return jwt.sign(payload, secret, { expiresIn: getTokenExpiry(rememberMe) });
}

export async function verifyToken(token: string): Promise<JwtPayload | null> {
  try {
    const secret = await getJwtSecret();
    const decoded = jwt.verify(token, secret) as JwtPayload;
    return decoded;
  } catch {
    return null;
  }
}
