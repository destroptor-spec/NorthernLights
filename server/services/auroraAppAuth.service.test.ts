jest.mock('../database', () => ({ initDB: jest.fn() }));

import { initDB } from '../database';
import { createAuroraAppKey, verifyAuroraAppKey, __testing } from './auroraAppAuth.service';
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

/**
 * Pairing codes are read aloud and typed by hand, so the alphabet is small and
 * likely to be edited (dropping a character that looks like another). The old
 * implementation indexed with `randomBytes[i] % alphabet.length`, which is only
 * unbiased because 32 divides 256 exactly — an invisible dependency on the
 * alphabet's size. These tests pin the properties that must survive such an edit.
 */
describe('pairing user codes', () => {
  const { userCode, USER_CODE_ALPHABET, USER_CODE_LENGTH } = __testing;

  it('is formatted as two readable groups', () => {
    for (let i = 0; i < 50; i++) {
      expect(userCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  });

  it('draws only from the alphabet', () => {
    for (let i = 0; i < 200; i++) {
      for (const char of userCode().replace('-', '')) {
        expect(USER_CODE_ALPHABET).toContain(char);
      }
    }
  });

  it('excludes characters that are easy to misread', () => {
    for (const ambiguous of ['I', 'O', '0', '1']) {
      expect(USER_CODE_ALPHABET).not.toContain(ambiguous);
    }
  });

  it('has no repeated characters, so every symbol is equally reachable', () => {
    expect(new Set(USER_CODE_ALPHABET).size).toBe(USER_CODE_ALPHABET.length);
  });

  // Deterministic guard on the actual invariant: characters must come from the
  // unbiased API, never from modulo on raw bytes.
  it('draws each character with crypto.randomInt, not modulo on raw bytes', () => {
    const randomInt = jest.spyOn(crypto, 'randomInt');
    const randomBytes = jest.spyOn(crypto, 'randomBytes');
    try {
      userCode();
      expect(randomInt).toHaveBeenCalledTimes(USER_CODE_LENGTH);
      for (const call of randomInt.mock.calls) {
        expect(call[0]).toBe(USER_CODE_ALPHABET.length);
      }
      expect(randomBytes).not.toHaveBeenCalled();
    } finally {
      randomInt.mockRestore();
      randomBytes.mockRestore();
    }
  });

  // Statistical backstop, sized to discriminate rather than to look reassuring.
  // Measured against real generators at this sample size: the current
  // implementation deviates ~3%, while modulo indexing over a 31-character
  // alphabet — one ambiguous character removed — deviates ~11%. A 6% band sits
  // between them at roughly 4.8 sigma per symbol, so it catches the regression
  // without flaking. A looser band would pass the very bug it guards against.
  it('stays flat enough to rule out modulo bias', () => {
    const codes = 25_000;
    const counts = new Map<string, number>();
    for (let i = 0; i < codes; i++) {
      for (const char of userCode().replace('-', '')) {
        counts.set(char, (counts.get(char) || 0) + 1);
      }
    }

    const expected = (codes * USER_CODE_LENGTH) / USER_CODE_ALPHABET.length;
    for (const char of USER_CODE_ALPHABET) {
      const seen = counts.get(char) || 0;
      expect(Math.abs(seen - expected) / expected).toBeLessThan(0.06);
    }
  });
});
