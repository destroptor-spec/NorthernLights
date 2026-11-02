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

/** Health polls (10 s apart) without an answer before a connected app says it can't reach the server. */
export const UNREACHABLE_POLLS_BEFORE_NOTICE = 3;

export interface PollState {
  /** What the server last said about its database; null until it has answered. */
  connected: boolean | null;
  /** False once the server has stopped answering; the app then runs as it does offline. */
  reachable: boolean;
  unreachableStreak: number;
}

/**
 * What the background poller makes of one result. A server that says its
 * database is down is believed at once. A poll that got no answer says
 * nothing about the database, so it never turns into the database recovery
 * screen: prod 2026-11-02, a one-minute outage between Cloudflare and the
 * server put "no database" on screen while Postgres ran fine. A connected app
 * keeps going through a few unanswered polls (prod 2026-10-18: two slow
 * answers in a row), then runs as it does offline until the server answers.
 */
export function pollDecision(
  health: ServerHealth,
  previous: Pick<PollState, 'connected' | 'unreachableStreak'>,
): PollState {
  if (health === 'connected') return { connected: true, reachable: true, unreachableStreak: 0 };
  if (health === 'down') return { connected: false, reachable: true, unreachableStreak: 0 };
  const unreachableStreak = previous.unreachableStreak + 1;
  const holdOn = previous.connected === true && unreachableStreak < UNREACHABLE_POLLS_BEFORE_NOTICE;
  return { connected: previous.connected, reachable: holdOn, unreachableStreak };
}
