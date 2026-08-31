import crypto from 'crypto';
import type { Pool, PoolClient } from 'pg';
import { initDB } from '../database';

const APP_KEY_PREFIX = 'aurora_app_';
const APP_KEY_LOOKUP_LENGTH = APP_KEY_PREFIX.length + 8;
const PAIRING_TTL_MS = 10 * 60 * 1000;

export interface AuroraAppPrincipal {
  userId: string;
  username: string;
  role: string;
  clientId: string;
  clientName: string;
  authKind: 'appKey';
  keyId: string;
}

export interface AuroraAppKeyRecord {
  id: string;
  clientId: string;
  name: string;
  kind: 'desktop' | 'web';
  platform: string | null;
  scope: 'listener';
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function digest(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function createSecret() {
  const key = `${APP_KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  return {
    key,
    prefix: key.slice(0, APP_KEY_LOOKUP_LENGTH),
    hash: digest(key),
  };
}

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function serialize(row: any): AuroraAppKeyRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    kind: row.kind === 'web' ? 'web' : 'desktop',
    platform: row.platform || null,
    scope: 'listener',
    prefix: row.key_prefix,
    createdAt: iso(row.created_at)!,
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
  };
}

async function insertClientAndKey(
  db: Pool | PoolClient,
  userId: string,
  name: string,
  platform?: string,
): Promise<{ record: AuroraAppKeyRecord; key: string }> {
  const secret = createSecret();
  const client = await db.query(`
    INSERT INTO aurora_clients (user_id, name, kind, platform)
    VALUES ($1, $2, 'desktop', $3)
    RETURNING id
  `, [userId, name, platform || null]);
  const inserted = await db.query(`
    INSERT INTO aurora_app_keys (client_id, user_id, key_prefix, key_hash)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [client.rows[0].id, userId, secret.prefix, secret.hash]);
  return {
    record: serialize({ ...inserted.rows[0], client_id: client.rows[0].id, name, kind: 'desktop', platform: platform || null }),
    key: secret.key,
  };
}

export async function createAuroraAppKey(userId: string, name: string, platform?: string) {
  const db = await initDB();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await insertClientAndKey(client, userId, name, platform);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listAuroraAppKeys(userId: string): Promise<AuroraAppKeyRecord[]> {
  const db = await initDB();
  const result = await db.query(`
    SELECT k.id, k.client_id, k.key_prefix, k.scope, k.created_at, k.last_used_at, k.revoked_at,
           c.name, c.kind, c.platform
    FROM aurora_app_keys k
    JOIN aurora_clients c ON c.id = k.client_id
    WHERE k.user_id = $1
    ORDER BY k.created_at DESC
  `, [userId]);
  return result.rows.map(serialize);
}

export async function rotateAuroraAppKey(userId: string, keyId: string) {
  const db = await initDB();
  const secret = createSecret();
  const result = await db.query(`
    UPDATE aurora_app_keys
    SET key_prefix = $3, key_hash = $4, last_used_at = NULL
    WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
    RETURNING client_id
  `, [keyId, userId, secret.prefix, secret.hash]);
  return result.rows[0] ? { key: secret.key, clientId: result.rows[0].client_id as string } : null;
}

export async function revokeAuroraAppKey(userId: string, keyId: string): Promise<boolean> {
  const db = await initDB();
  const result = await db.query(`
    WITH revoked AS (
      UPDATE aurora_app_keys
      SET revoked_at = NOW()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING client_id
    )
    UPDATE aurora_clients c
    SET revoked_at = NOW()
    FROM revoked r
    WHERE c.id = r.client_id
    RETURNING c.id
  `, [keyId, userId]);
  return (result.rowCount || 0) > 0;
}

export async function deleteRevokedAuroraAppKey(userId: string, keyId: string): Promise<boolean> {
  const db = await initDB();
  const result = await db.query(`
    DELETE FROM aurora_clients c
    USING aurora_app_keys k
    WHERE k.id = $1 AND k.user_id = $2 AND k.revoked_at IS NOT NULL AND c.id = k.client_id
    RETURNING c.id
  `, [keyId, userId]);
  return (result.rowCount || 0) > 0;
}

export async function verifyAuroraAppKey(rawKey: string): Promise<AuroraAppPrincipal | null> {
  if (!rawKey.startsWith(APP_KEY_PREFIX) || rawKey.length < APP_KEY_LOOKUP_LENGTH + 16) return null;
  const db = await initDB();
  const prefix = rawKey.slice(0, APP_KEY_LOOKUP_LENGTH);
  const result = await db.query(`
    SELECT k.id, k.user_id, k.key_hash, k.client_id, c.name AS client_name, u.username, u.role
    FROM aurora_app_keys k
    JOIN aurora_clients c ON c.id = k.client_id
    JOIN users u ON u.id = k.user_id
    WHERE k.key_prefix = $1 AND k.revoked_at IS NULL AND c.revoked_at IS NULL
    LIMIT 1
  `, [prefix]);
  const row = result.rows[0];
  if (!row || !safeEqual(digest(rawKey), row.key_hash)) return null;

  void db.query(`
    UPDATE aurora_app_keys SET last_used_at = NOW()
    WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '5 minutes')
  `, [row.id]).catch(() => {});
  void db.query(`
    UPDATE aurora_clients SET last_seen_at = NOW()
    WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL '5 minutes')
  `, [row.client_id]).catch(() => {});

  return {
    userId: row.user_id,
    username: row.username,
    role: row.role,
    clientId: row.client_id,
    clientName: row.client_name,
    authKind: 'appKey',
    keyId: row.id,
  };
}

// Deliberately excludes characters that are easy to misread aloud or by eye:
// I, O, 0 and 1. Anything may be added or removed here without weakening the
// code — see userCode() for why that is now safe.
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const USER_CODE_LENGTH = 8;

/**
 * Human-readable pairing code, e.g. `A7K2-9QMX`.
 *
 * Uses crypto.randomInt rather than `randomBytes[i] % alphabet.length`. The
 * modulo form is only unbiased when the alphabet length divides 256, which the
 * 32 characters above happen to do — every byte value maps to a symbol exactly
 * 8 times. That is an invisible dependency on the alphabet's size: dropping one
 * ambiguous-looking character (S for 5, say) would leave 31 symbols, and the
 * first 8 of them would then come up ~3% more often than the rest, silently
 * shrinking the space an attacker has to guess. randomInt rejection-samples
 * internally, so it is unbiased for any alphabet length.
 */
function userCode(): string {
  let value = '';
  for (let index = 0; index < USER_CODE_LENGTH; index++) {
    value += USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)];
  }
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

export const __testing = { userCode, USER_CODE_ALPHABET, USER_CODE_LENGTH };

export async function createPairingRequest(input: {
  clientName: string;
  platform?: string;
  verifierChallenge: string;
}) {
  const db = await initDB();
  const requestSecret = crypto.randomBytes(32).toString('base64url');
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = userCode();
    try {
      const result = await db.query(`
        INSERT INTO aurora_pairing_requests
          (request_secret_hash, verifier_challenge, user_code, client_name, platform, expires_at)
        VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '10 minutes')
        RETURNING id, user_code, expires_at
      `, [digest(requestSecret), input.verifierChallenge, code, input.clientName, input.platform || null]);
      return {
        requestId: result.rows[0].id as string,
        requestSecret,
        userCode: result.rows[0].user_code as string,
        expiresAt: new Date(result.rows[0].expires_at).toISOString(),
        intervalSeconds: 3,
      };
    } catch (error: any) {
      if (error?.code !== '23505') throw error;
    }
  }
  throw new Error('Could not allocate pairing code');
}

export async function getPairingRequestForApproval(userCodeValue: string) {
  const db = await initDB();
  const result = await db.query(`
    SELECT id, user_code, client_name, platform, status, expires_at
    FROM aurora_pairing_requests
    WHERE user_code = $1
    LIMIT 1
  `, [userCodeValue.toUpperCase()]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    requestId: row.id as string,
    userCode: row.user_code as string,
    clientName: row.client_name as string,
    platform: (row.platform as string | null) || null,
    status: row.status as string,
    expiresAt: new Date(row.expires_at).toISOString(),
    expired: new Date(row.expires_at).getTime() <= Date.now(),
  };
}

export async function approvePairingRequest(userId: string, userCodeValue: string): Promise<boolean> {
  const db = await initDB();
  const result = await db.query(`
    UPDATE aurora_pairing_requests
    SET approved_by = $2, status = 'approved', approved_at = NOW()
    WHERE user_code = $1 AND status = 'pending' AND expires_at > NOW()
    RETURNING id
  `, [userCodeValue.toUpperCase(), userId]);
  return (result.rowCount || 0) > 0;
}

export async function cancelPairingRequest(userId: string, userCodeValue: string): Promise<boolean> {
  const db = await initDB();
  const result = await db.query(`
    UPDATE aurora_pairing_requests
    SET status = 'cancelled'
    WHERE user_code = $1 AND approved_by = $2 AND status = 'approved'
    RETURNING id
  `, [userCodeValue.toUpperCase(), userId]);
  return (result.rowCount || 0) > 0;
}

export type PairingExchangeResult =
  | { status: 'pending' }
  | { status: 'expired' | 'invalid' | 'cancelled' }
  | { status: 'ok'; key: string; record: AuroraAppKeyRecord };

export async function exchangePairingRequest(input: {
  requestId: string;
  requestSecret: string;
  verifier: string;
}): Promise<PairingExchangeResult> {
  const db = await initDB();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`
      SELECT * FROM aurora_pairing_requests WHERE id = $1 FOR UPDATE
    `, [input.requestId]);
    const row = result.rows[0];
    if (!row || !safeEqual(digest(input.requestSecret), row.request_secret_hash)) {
      await client.query('ROLLBACK');
      return { status: 'invalid' };
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return { status: 'expired' };
    }
    if (row.status === 'cancelled') {
      await client.query('ROLLBACK');
      return { status: 'cancelled' };
    }
    if (row.status !== 'approved' || !row.approved_by) {
      await client.query('ROLLBACK');
      return { status: row.status === 'pending' ? 'pending' : 'invalid' };
    }
    const verifierChallenge = crypto.createHash('sha256').update(input.verifier, 'utf8').digest('base64url');
    if (!safeEqual(verifierChallenge, row.verifier_challenge)) {
      await client.query('ROLLBACK');
      return { status: 'invalid' };
    }
    const created = await insertClientAndKey(client, row.approved_by, row.client_name, row.platform || undefined);
    await client.query(`
      UPDATE aurora_pairing_requests SET status = 'exchanged', exchanged_at = NOW() WHERE id = $1
    `, [row.id]);
    await client.query('COMMIT');
    return { status: 'ok', ...created };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export const auroraAppAuthConstants = {
  appKeyPrefix: APP_KEY_PREFIX,
  pairingTtlMs: PAIRING_TTL_MS,
};
