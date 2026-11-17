import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Legacy listener routes the web app no longer calls: it uses /api/v1 for all
 * of them. Each call is logged as a warning (so it always reaches
 * production.log) to find out whether anything else still does. Once a week
 * of logs shows no calls, the routes can go (docs/legacy-listener-routes.md).
 *
 * The first call to a route is logged at once; after that at most one line an
 * hour per route, with the number of calls since the last line.
 */

/** 17 Nov 2026, sent as the Deprecation header (RFC 9745). */
export const LEGACY_ROUTES_DEPRECATED_AT = Date.UTC(2026, 10, 17) / 1000;

const LOG_EVERY_MS = 60 * 60 * 1000;

interface Tally {
  calls: number;
  since: number;
  lastLogged: number;
}

const tallies = new Map<string, Tally>();

/** "GET /api/playlists/:id": the route as declared, not the URL it was called with. */
function routeOf(req: Request<unknown>, base: string): string {
  const declared = typeof req.route?.path === 'string' ? req.route.path : req.path;
  const path = `${base}${declared === '/' ? '' : declared}` || '/';
  return `${req.method} ${path}`;
}

function clientOf(req: Request<unknown>): string {
  const agent = String(req.get('user-agent') || 'no user agent');
  return agent.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
}

function note(req: Request<unknown>, res: Response, base: string, replacement: string, now: number): void {
  const route = routeOf(req, base);
  const tally = tallies.get(route) ?? { calls: 0, since: now, lastLogged: 0 };
  tally.calls += 1;
  tallies.set(route, tally);
  if (tally.lastLogged && now - tally.lastLogged < LOG_EVERY_MS) return;

  const calls = tally.calls === 1 ? '1 call' : `${tally.calls} calls`;
  const user = req.user?.username ? `user ${req.user.username}` : 'no user';
  console.warn(
    `[Deprecated API] ${route}: ${calls} since ${new Date(tally.since).toISOString()} ` +
    `(last: ${res.statusCode}, ${user}, client "${clientOf(req)}"). Use ${replacement}.`,
  );
  tally.calls = 0;
  tally.since = now;
  tally.lastLogged = now;
}

/**
 * Marks a route, or every route of a router (`router.use(...)`), as a legacy
 * listener route. `replacement` names what to call instead. Generic so a route
 * keeps its own typed params when this is put in front of its handler.
 */
export function deprecatedRoute<P = Record<string, string>>(replacement: string): RequestHandler<P> {
  return (req: Request<P>, res: Response, next: NextFunction) => {
    // The mount point as seen here; Express may restore it before the
    // response finishes. The declared route is only known by then.
    const base = req.baseUrl;
    res.setHeader('Deprecation', `@${LEGACY_ROUTES_DEPRECATED_AT}`);
    res.on('finish', () => note(req, res, base, replacement, Date.now()));
    next();
  };
}

/** Calls counted since each route's last log line (tests, diagnostics). */
export function legacyRouteTallies(): Record<string, number> {
  return Object.fromEntries([...tallies].map(([route, tally]) => [route, tally.calls]));
}

export function resetLegacyRouteTallies(): void {
  tallies.clear();
}
