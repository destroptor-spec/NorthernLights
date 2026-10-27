/**
 * The login token never goes in a URL: stream, artwork and event URLs carry
 * their own scoped tokens (media, sse). A stored sign-in without them, or
 * whose scoped token is the login token itself (a fallback stored it before
 * 2026-10-27), would put the login token in URLs, so it signs in again.
 */
export function storedSignInLacksUrlTokens(auth: { authToken: string | null; mediaAccessToken: string | null; sseAccessToken: string | null }): boolean {
  if (!auth.authToken) return false;
  return !auth.mediaAccessToken || auth.mediaAccessToken === auth.authToken
    || !auth.sseAccessToken || auth.sseAccessToken === auth.authToken;
}
