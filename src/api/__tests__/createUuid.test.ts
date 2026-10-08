import { createUuid } from '../auroraApi';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * API v1 validates a playback report's eventId as a UUID. crypto.randomUUID
 * exists only in secure contexts, and the old fallback produced `web-…`, so a
 * client on plain http would have had every play report rejected.
 */
describe('createUuid', () => {
  const original = globalThis.crypto;
  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
  });

  it('produces a v4 UUID through getRandomValues when randomUUID is missing', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: (b: Uint8Array) => { for (let i = 0; i < b.length; i++) b[i] = (i * 37 + 11) & 0xff; return b; } },
      configurable: true,
    });
    const id = createUuid();
    expect(id).toMatch(UUID_V4);
  });

  it('still produces a v4 UUID with no crypto at all', () => {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    for (let i = 0; i < 50; i++) expect(createUuid()).toMatch(UUID_V4);
  });

  it('uses randomUUID when the context provides it', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: () => '123e4567-e89b-42d3-a456-426614174000' },
      configurable: true,
    });
    expect(createUuid()).toBe('123e4567-e89b-42d3-a456-426614174000');
  });

  it('does not repeat', () => {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    const ids = new Set(Array.from({ length: 1000 }, () => createUuid()));
    expect(ids.size).toBe(1000);
  });
});
