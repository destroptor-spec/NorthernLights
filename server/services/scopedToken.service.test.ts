/** @jest-environment node */
jest.mock('./auth.service', () => ({
  getJwtSecret: async () => 'test-secret',
  getTokenExpiry: () => '7d',
}));
import jwt from 'jsonwebtoken';
import {
  generateEphemeralScopedToken,
  generateOutputCredential,
  generateReceiverCredential,
  RECEIVER_CREDENTIAL_CAP_SECONDS,
  RECEIVER_CREDENTIAL_TTL_SECONDS,
  verifyOutputCredential,
  verifyReceiverCredential,
} from './scopedToken.service';

const user = { userId: 'user-1', username: 'alice', role: 'user' };
const grant = { sid: 's-1', oid: 'receiver:cast-77', gen: 3 };
const now = () => Math.floor(Date.now() / 1000);

describe('receiver credentials', () => {
  it('lasts 12 hours, renewable for 24, when a controller issues it', async () => {
    const before = now();
    const issued = (await generateReceiverCredential(user, grant))!;
    const claims = jwt.decode(issued.token) as Record<string, number>;
    expect(claims.exp - before).toBeGreaterThanOrEqual(RECEIVER_CREDENTIAL_TTL_SECONDS);
    expect(claims.exp - before).toBeLessThanOrEqual(RECEIVER_CREDENTIAL_TTL_SECONDS + 2);
    expect(claims.cap - before).toBeGreaterThanOrEqual(RECEIVER_CREDENTIAL_CAP_SECONDS);
    expect(Date.parse(issued.cap) / 1000).toBe(claims.cap);
    expect(Date.parse(issued.expiresAt) / 1000).toBe(claims.exp);
    expect(await verifyReceiverCredential(issued.token)).toMatchObject({ scope: 'receiver', ...grant, cap: claims.cap });
  });

  it('never lasts beyond its cap when renewed', async () => {
    const cap = now() + 3600;
    const renewed = (await generateReceiverCredential(user, grant, cap))!;
    const claims = jwt.decode(renewed.token) as Record<string, number>;
    expect(claims.exp).toBe(cap);
    expect(claims.cap).toBe(cap);
  });

  it('is not issued once the cap has passed', async () => {
    expect(await generateReceiverCredential(user, grant, now() - 1)).toBeNull();
    expect(await generateReceiverCredential(user, grant, now())).toBeNull();
  });

  it('is neither an output credential nor a plain receiver token', async () => {
    const receiver = (await generateReceiverCredential(user, grant))!;
    expect(await verifyOutputCredential(receiver.token)).toBeNull();

    const output = await generateOutputCredential(user, grant);
    expect(await verifyReceiverCredential(output.token)).toBeNull();

    // The unbound receiver tokens POST /auth/scoped-token once minted.
    const unbound = await generateEphemeralScopedToken('receiver', user, '12h');
    expect(await verifyReceiverCredential(unbound)).toBeNull();
  });

  it('is refused without a cap, or when forged', async () => {
    const noCap = jwt.sign({ ...user, scope: 'receiver', ...grant, jti: 'j' }, 'test-secret', { expiresIn: 60 });
    expect(await verifyReceiverCredential(noCap)).toBeNull();
    const forged = jwt.sign({ ...user, scope: 'receiver', ...grant, cap: now() + 60, jti: 'j' }, 'other-secret', { expiresIn: 60 });
    expect(await verifyReceiverCredential(forged)).toBeNull();
  });
});
