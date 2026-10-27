import { storedSignInLacksUrlTokens } from '../urlTokens';

// 6a-2 (docs/listen-together.md): the login token never goes in a URL.
it('signs in again when a scoped token is missing or is the login token itself', () => {
  const ok = { authToken: 'login', mediaAccessToken: 'media', sseAccessToken: 'sse' };
  expect(storedSignInLacksUrlTokens(ok)).toBe(false);
  expect(storedSignInLacksUrlTokens({ ...ok, mediaAccessToken: null })).toBe(true);
  expect(storedSignInLacksUrlTokens({ ...ok, mediaAccessToken: 'login' })).toBe(true);
  expect(storedSignInLacksUrlTokens({ ...ok, sseAccessToken: 'login' })).toBe(true);
  expect(storedSignInLacksUrlTokens({ authToken: null, mediaAccessToken: null, sseAccessToken: null })).toBe(false);
});
