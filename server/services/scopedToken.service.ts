import jwt from 'jsonwebtoken';
import { getJwtSecret, getTokenExpiry, JwtPayload } from './auth.service';

// 'receiver' is for a Cast receiver keeping its own queue fed with no sender
// attached. Its capability set is enumerated in middleware/apiV1Auth.ts.
export type ScopedTokenScope = 'media' | 'sse' | 'receiver';

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
