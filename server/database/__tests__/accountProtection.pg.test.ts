/**
 * @jest-environment node
 *
 * The server owner (the setup account) and the last admin can't be deleted or
 * demoted — not by themselves, not by another admin — so a server is never
 * left without an administrator. The guard lives in SQL under a row lock, so
 * these run against the real schema.
 *
 * Gated on AURORA_DB_TESTS=1 like the other *.pg tests; with the gate on and
 * Postgres unreachable they FAIL rather than skip.
 */
import { Pool } from 'pg';

const ENABLED = process.env.AURORA_DB_TESTS === '1';
const describeDb = ENABLED ? describe : describe.skip;
const ADMIN = { user: process.env.DB_USER || 'musicuser', password: process.env.DB_PASSWORD || 'musicpass', host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432) };
const suffix = `${process.pid}_${Date.now().toString(36)}`;

describeDb('account protection', () => {
  jest.setTimeout(120_000);
  const DB_NAME = `aurora_owner_test_${suffix}`;
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
      await admin.end();
    }
  });
  beforeEach(async () => { await pool.query('DELETE FROM users'); });

  const exists = async (id: string) => (await pool.query('SELECT 1 FROM users WHERE id = $1', [id])).rowCount === 1;
  const roleOf = async (id: string) => (await pool.query('SELECT role FROM users WHERE id = $1', [id])).rows[0]?.role;

  it('makes the setup account the owner, once', async () => {
    const first = await db.createUser('owner', 'x', 'admin', { isOwner: true });
    const second = await db.createUser('late', 'x', 'admin', { isOwner: true });
    expect(first.is_owner).toBe(true);
    expect(second.is_owner).toBe(false);
    expect((await db.listUsers()).map((u: any) => [u.username, u.is_owner])).toEqual([['owner', true], ['late', false]]);
  });

  it('refuses to delete or demote the owner, even with other admins around', async () => {
    const owner = await db.createUser('owner', 'x', 'admin', { isOwner: true });
    await db.createUser('second', 'x', 'admin');
    expect(await db.getAccountProtection(owner.id)).toBe('owner');
    expect(await db.changeProtectedAccount(owner.id, 'delete')).toBe('owner');
    expect(await db.changeProtectedAccount(owner.id, 'demote')).toBe('owner');
    expect(await exists(owner.id)).toBe(true);
    expect(await roleOf(owner.id)).toBe('admin');
  });

  it('lets other admins and listeners go while the owner remains', async () => {
    await db.createUser('owner', 'x', 'admin', { isOwner: true });
    const second = await db.createUser('second', 'x', 'admin');
    const third = await db.createUser('third', 'x', 'admin');
    const listener = await db.createUser('listener', 'x', 'user');
    expect(await db.getAccountProtection(second.id)).toBeNull();
    expect(await db.changeProtectedAccount(second.id, 'demote')).toBe('done');
    expect(await roleOf(second.id)).toBe('user');
    expect(await db.changeProtectedAccount(third.id, 'delete')).toBe('done');
    expect(await db.changeProtectedAccount(listener.id, 'delete')).toBe('done');
    expect(await exists(third.id)).toBe(false);
  });

  it('protects the last admin when there is no owner flag', async () => {
    const only = await db.createUser('only', 'x', 'admin');
    await db.createUser('listener', 'x', 'user');
    expect(await db.getAccountProtection(only.id)).toBe('last-admin');
    expect(await db.changeProtectedAccount(only.id, 'delete')).toBe('last-admin');
    expect(await db.changeProtectedAccount(only.id, 'demote')).toBe('last-admin');
    expect(await roleOf(only.id)).toBe('admin');
  });

  it('never lets two admins removing each other at once leave none', async () => {
    const a = await db.createUser('a', 'x', 'admin');
    const b = await db.createUser('b', 'x', 'admin');
    // Hold the admin rows so both removals queue up and then start together:
    // without the guard's lock each would count two admins and both succeed.
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT id FROM users WHERE role = 'admin' FOR UPDATE`);
    const removals = Promise.all([db.changeProtectedAccount(a.id, 'delete'), db.changeProtectedAccount(b.id, 'delete')]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await holder.query('COMMIT');
    holder.release();
    const results = await removals;
    expect([...results].sort()).toEqual(['done', 'last-admin']);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'`)).rows[0].n).toBe(1);
  });

  it('treats demoting a listener as a no-op, and reports an unknown account', async () => {
    await db.createUser('owner', 'x', 'admin', { isOwner: true });
    const listener = await db.createUser('listener', 'x', 'user');
    expect(await db.changeProtectedAccount(listener.id, 'demote')).toBe('done');
    expect(await db.changeProtectedAccount('00000000-0000-4000-8000-000000000000', 'delete')).toBe('not-found');
  });

  it('allows only one owner', async () => {
    await db.createUser('owner', 'x', 'admin', { isOwner: true });
    const other = await db.createUser('other', 'x', 'admin');
    await expect(pool.query('UPDATE users SET is_owner = TRUE WHERE id = $1', [other.id])).rejects.toMatchObject({ code: '23505' });
  });
});

describeDb('owner backfill on an existing server', () => {
  jest.setTimeout(120_000);
  const DB_NAME = `aurora_owner_upgrade_${suffix}`;
  let admin: Pool;
  let pool: Pool;

  afterAll(async () => {
    try { if (pool) await pool.end(); } catch { /* already closed */ }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });

  it('makes the oldest admin the owner', async () => {
    admin = new Pool({ ...ADMIN, database: 'postgres', connectionTimeoutMillis: 5000 });
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    // The users table as it was before the owner flag existed.
    const seed = new Pool({ ...ADMIN, database: DB_NAME });
    await seed.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_login_at TIMESTAMPTZ
      );
      INSERT INTO users (username, password_hash, role, created_at) VALUES
        ('early-listener', 'x', 'user', '2026-01-01'),
        ('setup-admin', 'x', 'admin', '2026-02-01'),
        ('later-admin', 'x', 'admin', '2026-03-01');
    `);
    await seed.end();

    jest.resetModules();
    process.env.DB_NAME = DB_NAME;
    const db: typeof import('../index') = await import('../index');
    pool = await db.initDB();
    const owners = (await pool.query('SELECT username FROM users WHERE is_owner')).rows.map((r) => r.username);
    expect(owners).toEqual(['setup-admin']);
  });
});
