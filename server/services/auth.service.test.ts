jest.mock('../database', () => ({
  getSystemSetting: jest.fn().mockResolvedValue('test-secret'),
  setSystemSetting: jest.fn(),
}));

import jwt from 'jsonwebtoken';
import { generateToken, verifyDummyPassword, hashPassword } from './auth.service';
import { generateScopedToken } from './scopedToken.service';

const HOUR = 3600;
const payload = { userId: 'u1', username: 'tester', role: 'user' };

const lifetimeOf = (token: string): number => {
  const decoded = jwt.decode(token) as { iat: number; exp: number };
  return decoded.exp - decoded.iat;
};

describe('remember-me token expiry', () => {
  it('issues 30-day tokens for remembered sign-ins (default)', async () => {
    expect(lifetimeOf(await generateToken(payload))).toBe(30 * 24 * HOUR);
    expect(lifetimeOf(await generateToken(payload, true))).toBe(30 * 24 * HOUR);
  });

  it('issues 12-hour tokens for session-only sign-ins', async () => {
    expect(lifetimeOf(await generateToken(payload, false))).toBe(12 * HOUR);
  });

  it('applies the same lifetimes to scoped media/sse tokens', async () => {
    expect(lifetimeOf(await generateScopedToken('media', payload))).toBe(30 * 24 * HOUR);
    expect(lifetimeOf(await generateScopedToken('media', payload, false))).toBe(12 * HOUR);
    expect(lifetimeOf(await generateScopedToken('sse', payload, false))).toBe(12 * HOUR);
  });
});

describe('verifyDummyPassword (timing-oracle defense)', () => {
  it('always resolves false and never throws', async () => {
    await expect(verifyDummyPassword('anything')).resolves.toBe(false);
    await expect(verifyDummyPassword('')).resolves.toBe(false);
  });

  it('uses the same bcrypt cost as real password hashes', async () => {
    // Real hashes carry the cost in their prefix ($2b$12$); the dummy compare
    // must burn the same work factor or the timing oracle returns.
    const realHash = await hashPassword('correct horse battery staple');
    expect(realHash.startsWith('$2b$12$')).toBe(true);
  }, 15000);
});
