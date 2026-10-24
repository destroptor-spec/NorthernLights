/**
 * Pieces of GET /api/health that must stay fast. Every open client polls it
 * every 10 s, and two slow answers in a row put the app on the database
 * recovery screen, even while music plays (prod 2026-10-18). So the database
 * probe has its own deadline, the container status is cached, and a failed
 * probe is logged: it used to be swallowed, leaving nothing in the log.
 */

export const DB_PROBE_TIMEOUT_MS = 2_000;
export const CONTAINER_STATUS_TTL_MS = 30_000;
const FAILURE_LOG_INTERVAL_MS = 60_000;

export type DatabaseProbe = { ok: true; latencyMs: number } | { ok: false; latencyMs: number; error: string };

let lastFailureLoggedAt = -Infinity;

/** Runs `query` (a `SELECT 1`), failing after `timeoutMs`. */
export async function probeDatabase(
  query: () => Promise<unknown>,
  { timeoutMs = DB_PROBE_TIMEOUT_MS, now = Date.now, log = (message: string) => console.warn(message) } = {},
): Promise<DatabaseProbe> {
  const start = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      query(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs}ms`)), timeoutMs); }),
    ]);
    return { ok: true, latencyMs: now() - start };
  } catch (error) {
    const latencyMs = now() - start;
    const message = error instanceof Error ? error.message : String(error);
    // At most once a minute: every client polls, and an outage would flood the log.
    if (now() - lastFailureLoggedAt >= FAILURE_LOG_INTERVAL_MS) {
      lastFailureLoggedAt = now();
      log(`[Health] database probe failed after ${latencyMs}ms: ${message}`);
    }
    return { ok: false, latencyMs, error: message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Remembers a status lookup for `ttlMs`; concurrent callers share one lookup, and a failed one is not kept. */
export function cachedLookup<T>(lookup: (key: string) => Promise<T>, { ttlMs = CONTAINER_STATUS_TTL_MS, now = Date.now } = {}) {
  const cache = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string): Promise<T> => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = lookup(key);
    cache.set(key, { at: now(), value });
    value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
    return value;
  };
}

/** For tests. */
export function resetHealthCheckState() {
  lastFailureLoggedAt = -Infinity;
}
