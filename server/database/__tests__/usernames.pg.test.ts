/**
 * @jest-environment node
 *
 * Usernames are case-insensitive: "Andreas" and "andreas" are one account.
 * Lookups ignore case, a unique index on lower(username) keeps a second
 * account in other capitals out, and a database that already holds such a
 * pair still starts (with a warning) instead of failing the schema step.
 *
 * Gated on AURORA_DB_TESTS=1 like the other *.pg tests; with the gate on and
 * Postgres unreachable they FAIL rather than skip.
 */
import { Pool } from 'pg';

const ENABLED = process.env.AURORA_DB_TESTS === '1';
const describeDb = ENABLED ? describe : describe.skip;
const ADMIN = { user: process.env.DB_USER || 'musicuser', password: process.env.DB_PASSWORD || 'musicpass', host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432) };
const suffix = `${process.pid}_${Date.now().toString(36)}`;

describeDb('case-insensitive usernames', () => {
  jest.setTimeout(120_000);
  const DB_NAME = `aurora_usernames_test_${suffix}`;
  const CLASH_DB = `aurora_usernames_clash_${suffix}`;
  let admin: Pool;
  let db: typeof import('../index');
  let pool: Pool;

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
      await admin.query(`DROP DATABASE IF EXISTS ${CLASH_DB} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });
  beforeEach(async () => { await pool.query('DELETE FROM users'); });

  it('finds an account whatever the case it is typed in, keeping its own casing', async () => {
    await db.createUser('Andreas', 'x', 'admin');
    for (const typed of ['Andreas', 'andreas', 'ANDREAS', 'aNdReAs']) {
      expect((await db.getUserByUsername(typed))?.username).toBe('Andreas');
    }
    expect(await db.getUserByUsername('andrea')).toBeNull();
  });

  it('refuses a second account that differs only in case', async () => {
    await db.createUser('D0Tch', 'x', 'user');
    await expect(db.createUser('d0tch', 'x', 'user')).rejects.toMatchObject({ code: '23505' });
    const index = await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'users_username_lower_idx'`);
    expect(index.rows[0]?.indexdef).toMatch(/UNIQUE INDEX .* \(lower\(username\)\)/);
  });

  it('a database that already has a case clash still starts, warns, and prefers the exact spelling', async () => {
    // Build the clash before this schema version ever ran on the database.
    await admin.query(`CREATE DATABASE ${CLASH_DB}`);
    const clash = new Pool({ ...ADMIN, database: CLASH_DB });
    await clash.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await clash.query(`CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_login_at TIMESTAMPTZ)`);
    await clash.query(`INSERT INTO users (username, password_hash, role, created_at) VALUES
      ('Andreas', 'x', 'admin', NOW() - interval '1 day'), ('andreas', 'x', 'user', NOW())`);
    await clash.end();

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let clashPool: Pool | undefined;
    try {
      process.env.DB_NAME = CLASH_DB;
      let fresh!: typeof import('../index');
      jest.isolateModules(() => { fresh = require('../index'); });
      clashPool = await fresh.initDB();
      expect(warn.mock.calls.map(([line]) => String(line))).toContainEqual(
        expect.stringContaining('Usernames that differ only in case: Andreas / andreas'),
      );
      expect((await fresh.getUserByUsername('andreas'))?.role).toBe('user');
      expect((await fresh.getUserByUsername('Andreas'))?.role).toBe('admin');
      expect((await fresh.getUserByUsername('ANDREAS'))?.role).toBe('admin'); // oldest when neither matches exactly
      const index = await clashPool.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'users_username_lower_idx'`);
      expect(index.rowCount).toBe(0);
    } finally {
      warn.mockRestore();
      process.env.DB_NAME = DB_NAME;
      if (clashPool) await clashPool.end();
    }
  });
});
