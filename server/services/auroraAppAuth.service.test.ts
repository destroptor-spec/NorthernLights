jest.mock('../database', () => ({ initDB: jest.fn() }));

import { initDB } from '../database';
import { createAuroraAppKey, verifyAuroraAppKey } from './auroraAppAuth.service';
import crypto from 'crypto';

const initDBMock = initDB as jest.MockedFunction<typeof initDB>;

describe('Aurora app-key authentication', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the secret once while storing only a digest and short lookup prefix', async () => {
    let storedHash = '';
    let storedPrefix = '';
    const client = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO aurora_clients')) return { rows: [{ id: 'client-1' }] };
        if (sql.includes('INSERT INTO aurora_app_keys')) {
          storedPrefix = String(params?.[2]);
          storedHash = String(params?.[3]);
          return { rows: [{ id: 'key-1', key_prefix: storedPrefix, created_at: new Date(), last_used_at: null, revoked_at: null }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn().mockResolvedValue(client) };
    initDBMock.mockResolvedValue(pool as any);

    const created = await createAuroraAppKey('user-1', 'Desktop', 'linux');
    expect(created.key).toMatch(/^aurora_app_[A-Za-z0-9_-]{40,}$/);
    expect(storedPrefix).toBe(created.key.slice(0, storedPrefix.length));
    expect(storedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(storedHash).not.toContain(created.key);
    expect(client.release).toHaveBeenCalled();
  });

  it('accepts a matching digest and returns a listener-scoped client principal', async () => {
    const key = 'aurora_app_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN';
    const keyHash = `sha256:${crypto.createHash('sha256').update(key).digest('hex')}`;
    const pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('SELECT k.id')) return { rows: [{
          id: 'key-1', user_id: 'user-1', key_hash: keyHash, client_id: 'client-1',
          client_name: 'Desktop', username: 'alice', role: 'user',
        }] };
        return { rows: [] };
      }),
    };
    initDBMock.mockResolvedValue(pool as any);

    await expect(verifyAuroraAppKey(key)).resolves.toEqual({
      userId: 'user-1', username: 'alice', role: 'user', clientId: 'client-1',
      clientName: 'Desktop', authKind: 'appKey', keyId: 'key-1',
    });
  });
});
