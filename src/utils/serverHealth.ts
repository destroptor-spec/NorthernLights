import { fetchWithTimeout } from './fetchWithTimeout';

const SERVER_HEALTH_TIMEOUT_MS = 8_000;

interface HealthResponse {
  dbConnected?: unknown;
}

/**
 * connected: the server answered and its database is up. down: the server
 * answered that it is not. unreachable: no usable answer (timeout, network,
 * an error page from the proxy), which says nothing about the database.
 */
export type ServerHealth = 'connected' | 'down' | 'unreachable';

export async function getServerDatabaseHealth(): Promise<ServerHealth> {
  try {
    const response = await fetchWithTimeout('/api/health', {
      cache: 'no-store',
      credentials: 'same-origin',
    }, SERVER_HEALTH_TIMEOUT_MS);
    if (!response.ok) return 'unreachable';

    const data: unknown = await response.json();
    return data && typeof data === 'object' && (data as HealthResponse).dbConnected === true ? 'connected' : 'down';
  } catch {
    return 'unreachable';
  }
}

export async function isServerDatabaseConnected(): Promise<boolean> {
  return (await getServerDatabaseHealth()) === 'connected';
}

/** Health polls (10 s apart) without an answer before a connected app shows the recovery screen. */
export const UNREACHABLE_POLLS_BEFORE_RECOVERY = 3;

/**
 * What the background poller makes of one result. A server that says its
 * database is down is believed at once. A poll that got no answer is not a
 * database outage: a connected app stays as it is until that has happened
 * UNREACHABLE_POLLS_BEFORE_RECOVERY times in a row. Prod 2026-10-18: two slow
 * health answers in a row put the app on the recovery screen mid-song.
 */
export function pollDecision(
  health: ServerHealth,
  previous: { connected: boolean | null; unreachableStreak: number },
): { connected: boolean; unreachableStreak: number } {
  if (health === 'connected') return { connected: true, unreachableStreak: 0 };
  if (health === 'down') return { connected: false, unreachableStreak: 0 };
  const unreachableStreak = previous.unreachableStreak + 1;
  const holdOn = previous.connected === true && unreachableStreak < UNREACHABLE_POLLS_BEFORE_RECOVERY;
  return { connected: holdOn, unreachableStreak };
}
