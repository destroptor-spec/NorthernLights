// Session-only auth storage for sign-ins without "Remember me on this device".
// Tokens live in sessionStorage so a same-tab refresh keeps the session but
// closing the browser ends it; the zustand persist partialize excludes auth
// fields from localStorage while rememberDevice is false.

const SESSION_AUTH_KEY = 'aurora-session-auth';

export interface SessionAuth {
  authToken: string;
  mediaAccessToken: string | null;
  sseAccessToken: string | null;
  currentUser: { id: string; username: string; role: string } | null;
}

export function readSessionAuth(): SessionAuth | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.authToken !== 'string') return null;
    return parsed as SessionAuth;
  } catch {
    return null;
  }
}

export function writeSessionAuth(auth: SessionAuth): void {
  try {
    window.sessionStorage.setItem(SESSION_AUTH_KEY, JSON.stringify(auth));
  } catch {
    // Storage unavailable (private mode quota etc.) — the session then only
    // lasts until the next full page load.
  }
}

export function clearSessionAuth(): void {
  try {
    window.sessionStorage.removeItem(SESSION_AUTH_KEY);
  } catch {
    // ignore
  }
}
