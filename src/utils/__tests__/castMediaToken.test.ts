import { CAST_MEDIA_TOKEN_RENEW_BEFORE_MS, CastMediaToken, withCastToken } from '../castMediaToken';

/**
 * 6a-2 (docs/listen-together.md): Cast URLs carry a 12-hour token of their
 * own, never the login's 30-day media token.
 */
const HOUR = 3_600_000;

type Minted = { token: string; expiresAt: string };
function store(now: { value: number }, given?: jest.Mock<Promise<Minted>, []>) {
  let minted = 0;
  const mint = given ?? jest.fn(async (): Promise<Minted> => ({ token: `cast-${++minted}`, expiresAt: new Date(now.value + 12 * HOUR).toISOString() }));
  return { token: new CastMediaToken({ mint, now: () => now.value }), mint };
}

it('mints once, and hands out the same token until it is due for renewal', async () => {
  const now = { value: Date.parse('2026-10-27T12:00:00Z') };
  const { token, mint } = store(now);
  expect(token.current()).toBeNull();
  await expect(Promise.all([token.ensure(), token.ensure()])).resolves.toEqual(['cast-1', 'cast-1']);
  expect(mint).toHaveBeenCalledTimes(1);
  now.value += 12 * HOUR - CAST_MEDIA_TOKEN_RENEW_BEFORE_MS - 1;
  await expect(token.ensure()).resolves.toBe('cast-1');
  now.value += 2;
  await expect(token.ensure()).resolves.toBe('cast-2');
  expect(token.renewAt()).toBe(now.value + 12 * HOUR - CAST_MEDIA_TOKEN_RENEW_BEFORE_MS);
});

it('keeps the token it has while a renewal fails, and has none once it has run out', async () => {
  const now = { value: Date.parse('2026-10-27T12:00:00Z') };
  const mint = jest.fn(async (): Promise<Minted> => ({ token: 'cast-1', expiresAt: new Date(now.value + 12 * HOUR).toISOString() }));
  const { token } = store(now, mint);
  await token.ensure();
  mint.mockRejectedValue(new Error('offline'));
  now.value += 11 * HOUR;
  await expect(token.ensure()).resolves.toBe('cast-1');
  now.value += 2 * HOUR;
  await expect(token.ensure()).resolves.toBeNull();
  expect(token.current()).toBeNull();
});

it('a mint that throws at once answers null instead of throwing', async () => {
  const token = new CastMediaToken({ mint: () => { throw new Error('no store'); }, now: () => 0 });
  await expect(token.ensure()).resolves.toBeNull();
});

it('swaps the token in a URL that has one, and leaves others alone', () => {
  expect(withCastToken('https://a.example/api/stream/t/playlist.m3u8?quality=128k&token=login-30d', 'cast-1'))
    .toBe('https://a.example/api/stream/t/playlist.m3u8?quality=128k&token=cast-1');
  expect(withCastToken('https://a.example/api/v1/artwork/h1', 'cast-1')).toBe('https://a.example/api/v1/artwork/h1');
  expect(withCastToken('https://a.example/x?token=login', null)).toBe('https://a.example/x?token=login');
});
