# Legacy listener routes

The web app gets every listener feature (Hub, playlists, playback reports, Infinity, library browsing, search, loves, scrobbling) from API v1 (`/api/v1`). The routes below were its older `/api` versions. Nothing in this repository calls them any more, but an old cached copy of the web app or someone's own script might. Since 17 Nov 2026 every call to them is logged, so they can be removed once the logs show nothing uses them.

Admin and settings routes stay on `/api`, and the Subsonic API (`/rest`) stays as it is. Neither is part of this.

## How calls are recorded

`server/middleware/deprecatedRoute.ts` marks the routes. A call to one:

- gets a `Deprecation: @1794873600` response header (RFC 9745, 17 Nov 2026);
- writes a warning to the console, which also lands in `production.log`, whatever the log level. The first call to a route is logged at once, then at most one line an hour per route, counting the calls since the last line:

```
[Deprecated API] GET /api/playlists/:id: 3 calls since 2026-11-17T12:00:00.000Z (last: 200, user listener, client "Mozilla/5.0 …"). Use the /api/v1/playlists routes.
```

The line names the route as declared (never the ids in the URL), the last status code, the user and the client's user agent, so a caller can be traced. A call without a valid login is turned away before it reaches the route, so it isn't logged; such a call doesn't work anyway.

## The routes

| Route | Use instead |
| --- | --- |
| `POST /api/playback/history`, `/record`, `/skip` | `POST /api/v1/playback/reports` |
| `POST /api/recommend` | `POST /api/v1/recommendations/next` |
| `GET /api/artists`, `GET /api/artists/:id` | `GET /api/v1/artists`, `GET /api/v1/artists/:id` |
| `GET /api/albums`, `GET /api/albums/:id` | `GET /api/v1/albums`, `GET /api/v1/albums/:id` |
| `GET /api/genres`, `GET /api/genres/:id` | `GET /api/v1/genres`, `GET /api/v1/genres/:id` |
| `GET /api/library/search` | `GET /api/v1/search` |
| `POST /api/library/love` | `PUT /api/v1/tracks/:id/loved` |
| `POST /api/providers/lastfm/scrobble`, `/now-playing` | `POST /api/v1/playback/reports` (the server scrobbles) |
| `POST /api/providers/lastfm/love`, `/unlove` | `PUT /api/v1/tracks/:id/loved` (the server syncs Last.fm) |
| `POST /api/providers/listenbrainz/scrobble`, `/now-playing` | `POST /api/v1/playback/reports` |
| `GET /api/providers/listenbrainz/status` | nothing; Settings → Scrobbling has its own status |

The other routes in `artists`, `albums`, `genres`, `library` and `providers` (similar artists, credits, editions, merges, the genre taxonomy, connecting and testing providers) are still used by the web app and are not marked.

## Removed

The week of 17–24 Nov 2026 logged no calls to any of the 41 routes (`production.log` covered the whole week, from 15 Nov, and held 1,397 other warnings). They're removed one route file at a time:

| Removed | Routes | Use instead |
| --- | --- | --- |
| 24 Nov 2026 | Every route under `/api/hub` (10) | `/api/v1/hub`, `/api/v1/hub/smart`, `/api/v1/hub/regenerate`, `/api/v1/hub/custom`, `/api/v1/hub/artist-radio` and its `/eligibility` |
| 24 Nov 2026 | Every route under `/api/playlists` (11) | the `/api/v1/playlists` routes |

## Checking

On the server, after at least a week with the logging deployed:

```
ssh <prod-user>@<prod-host> 'cd ~/NorthernLights && grep -h "\[Deprecated API\]" logs/production.log* | sort'
```

Use `LOG_DIR` instead of `logs/` if it's set. Logs are kept for 30 days.

- **No lines:** nothing called them. Remove the routes, one PR per route file, and their sections in `docs/API.md`.
- **Lines:** the user and client say who still calls them. Move that caller to API v1 first, then wait another week.
