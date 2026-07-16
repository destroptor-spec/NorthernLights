import { writeDebugLog } from './debugLogger.service';

// Structured audit trail for authentication attempts: one JSON line per event
// to the console and to logs/auth.log. This is what makes brute-force attempts
// visible (and fail2ban-able) on a self-hosted install.

export type AuthLogEvent = 'login' | 'register' | 'setup';

export type AuthLogOutcome =
  | 'success'
  | 'unknown_user'
  | 'bad_password'
  | 'captcha_missing'
  | 'captcha_failed'
  | 'captcha_unavailable'
  | 'rate_limited';

export interface AuthLogEntry {
  event: AuthLogEvent;
  outcome: AuthLogOutcome;
  ip: string;
  username?: unknown;
}

export function logAuthEvent(entry: AuthLogEntry): void {
  // JSON.stringify neutralizes control chars / log injection in the username.
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    type: 'auth',
    event: entry.event,
    outcome: entry.outcome,
    ip: entry.ip,
    username: typeof entry.username === 'string' ? entry.username.slice(0, 80) : undefined,
  });

  if (entry.outcome === 'success') {
    console.log(line);
  } else {
    console.warn(line);
  }

  try {
    writeDebugLog('auth.log', line);
  } catch {
    // A full disk or unwritable logs/ dir must never block sign-in.
  }
}
