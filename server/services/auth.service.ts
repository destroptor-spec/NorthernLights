import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { getSystemSetting, setSystemSetting } from '../database';

const SALT_ROUNDS = 12;
const TOKEN_EXPIRY = '7d';

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

export interface JwtPayload {
  userId: string;
  username: string;
  role: string;
}

export async function generateToken(payload: JwtPayload): Promise<string> {
  const secret = await getJwtSecret();
  return jwt.sign(payload, secret, { expiresIn: TOKEN_EXPIRY });
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
