/**
 * @jest-environment node
 *
 * The invite write path failed silently in production. Two defects, both
 * invisible to any test that doesn't talk to Postgres:
 *
 *   1. getInvite matched `lower(trim(token))` while incrementInviteUses and
 *      deleteInvite matched `token = $1`. A link that picked up a capital or a
 *      stray space on its way through a chat app resolved, registered a user,
 *      and then consumed nothing — `UPDATE 0`, no error. The invite stayed
 *      reusable forever and "Revoke" did nothing.
 *   2. expires_at is TIMESTAMPTZ but every caller treats it as epoch ms.
 *      Writing a raw number threw `date/time field value out of range`, and
 *      reading one back gave a Date that JSON-serializes to an ISO string —
 *      so `expires_at < Date.now()` in the admin UI was always false.
 *
 * These assert the lifecycle end to end against the real schema, because both
 * bugs live in the gap between what the SQL matches and what the JS assumes.
 *
 * Gated on AURORA_DB_TESTS=1, like readQueries.pg.test.ts. When the gate is on
 * and Postgres is unreachable these FAIL rather than skip.
 */
import { Pool } from 'pg';

const ENABLED = process.env.AURORA_DB_TESTS === '1';
const describeDb = ENABLED ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;
const DB_NAME = `aurora_invite_test_${process.pid}_${Date.now().toString(36)}`;
const ADMIN = { user: process.env.DB_USER || 'musicuser', password: process.env.DB_PASSWORD || 'musicpass', host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432) };

let admin: Pool;
let db: typeof import('../index');
let pool: Pool;

/** What a messaging app can do to a pasted link: pad it, capitalise the start. */
const mangle = (token: string) => `  ${token[0].toUpperCase()}${token.slice(1)}  `;

describeDb('invite lifecycle', () => {
  jest.setTimeout(120_000);

  beforeAll(async () => {
    admin = new Pool({ ...ADMIN, database: 'postgres', connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    process.env.DB_NAME = DB_NAME;
    db = await import('../index');
    pool = await db.initDB();
  });

  afterAll(async () => {
    try { if (pool) await pool.end(); } catch { /* already closed */ }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });

  describe('expiry survives the round trip', () => {
    it('accepts an epoch-ms expiry against the TIMESTAMPTZ column', async () => {
      const expiresAt = Date.now() + 7 * DAY_MS;
      const invite = await db.createInvite(null, 'user', 1, expiresAt);
      expect(invite.expires_at).toBeCloseTo(expiresAt, -3);
    });

    it('reads expires_at back as a number the UI can compare to Date.now()', async () => {
      const invite = await db.createInvite(null, 'user', 1, Date.now() + 7 * DAY_MS);
      const listed = (await db.listInvites()).find((row: any) => row.token === invite.token);
      expect(typeof listed.expires_at).toBe('number');
      expect(listed.expires_at > Date.now()).toBe(true);
    });

    it('flags an expired invite as expired', async () => {
      const invite = await db.createInvite(null, 'user', 5, Date.now() - DAY_MS);
      expect(await db.isInviteValid(invite.token)).toBe(false);
      const listed = (await db.listInvites()).find((row: any) => row.token === invite.token);
      expect(listed.expires_at < Date.now()).toBe(true);
    });

    it('still allows an invite with no expiry', async () => {
      const invite = await db.createInvite(null, 'user', 1, null);
      expect(invite.expires_at).toBeNull();
      expect(await db.isInviteValid(invite.token)).toBe(true);
    });
  });

  describe('a mangled token resolves and consumes the same row', () => {
    it('reads through getInvite and isInviteValid', async () => {
      const invite = await db.createInvite(null, 'user', 1, null);
      expect((await db.getInvite(mangle(invite.token)))?.token).toBe(invite.token);
      expect(await db.isInviteValid(mangle(invite.token))).toBe(true);
    });

    it('actually consumes the invite', async () => {
      const invite = await db.createInvite(null, 'user', 1, null);
      await db.incrementInviteUses(mangle(invite.token));

      const after = await db.getInvite(invite.token);
      expect(Number(after.uses)).toBe(1);
      // The whole point: a single-use invite must be spent, not reusable.
      expect(await db.isInviteValid(invite.token)).toBe(false);
    });

    it('revokes the invite', async () => {
      const invite = await db.createInvite(null, 'user', 1, null);
      await db.deleteInvite(mangle(invite.token));
      expect(await db.getInvite(invite.token)).toBeNull();
    });
  });

  it('reports zero uses per use, so a no-op consume can never be silent again', async () => {
    const invite = await db.createInvite(null, 'user', 2, null);
    expect(await db.incrementInviteUses(invite.token)).toBe(1);
    expect(await db.incrementInviteUses('not-a-real-token')).toBe(0);
  });
});
