# Legacy listener routes (removed)

The web app gets every listener feature (Hub, playlists, playback reports, Infinity, library browsing, search, loves, scrobbling) from API v1 (`/api/v1`). Its 41 older `/api` versions were marked deprecated on 17 Nov 2026 (#241) and every call was logged. A week of logs showed no calls, so all 41 were removed on 24 Nov 2026, one route file per PR (#267–#275).

Admin and settings routes stay on `/api`, and the Subsonic API (`/rest`) stays as it is. Neither was part of this. New listener features go in `/api/v1`.

## How calls were recorded

`server/middleware/deprecatedRoute.ts` marked the routes, and stays for the next route on its way out. A call to a marked route:

- gets a `Deprecation: @1794873600` response header (RFC 9745, 17 Nov 2026);
- writes a warning to the console, which also lands in `production.log`, whatever the log level. The first call to a route is logged at once, then at most one line an hour per route, counting the calls since the last line:

```
[Deprecated API] GET /api/playlists/:id: 3 calls since 2026-11-17T12:00:00.000Z (last: 200, user listener, client "Mozilla/5.0 …"). Use the /api/v1/playlists routes.
```

The line names the route as declared (never the ids in the URL), the last status code, the user and the client's user agent, so a caller can be traced. A call without a valid login is turned away before it reaches the route, so it isn't logged; such a call doesn't work anyway.

## Removed

The week of 17–24 Nov 2026 logged no calls to any of the 41 routes (`production.log` covered the whole week, from 15 Nov, and held 1,397 other warnings). The other routes in the same files (similar artists, credits, editions, merges, the genre taxonomy, connecting and testing providers) are still used by the web app and stay.

| Removed | Routes | Use instead |
| --- | --- | --- |
| 24 Nov 2026 | Every route under `/api/hub` (10) | `/api/v1/hub`, `/api/v1/hub/smart`, `/api/v1/hub/regenerate`, `/api/v1/hub/custom`, `/api/v1/hub/artist-radio` and its `/eligibility` |
| 24 Nov 2026 | Every route under `/api/playlists` (11) | the `/api/v1/playlists` routes |
| 24 Nov 2026 | `POST /api/playback/history`, `/record`, `/skip` | `POST /api/v1/playback/reports` |
| 24 Nov 2026 | `POST /api/recommend` | `POST /api/v1/recommendations/next` |
| 24 Nov 2026 | `GET /api/artists`, `GET /api/artists/:id` | `GET /api/v1/artists`, `GET /api/v1/artists/:id` |
| 24 Nov 2026 | `GET /api/albums`, `GET /api/albums/:id` | `GET /api/v1/albums`, `GET /api/v1/albums/:id` |
| 24 Nov 2026 | `GET /api/genres`, `GET /api/genres/:id` | `GET /api/v1/genres`, `GET /api/v1/genres/:id` |
| 24 Nov 2026 | `GET /api/library/search`, `POST /api/library/love` | `GET /api/v1/search` (and `/search/ranked`), `PUT /api/v1/tracks/:id/loved` |
| 24 Nov 2026 | `POST /api/providers/lastfm/scrobble`, `/now-playing`; `POST /api/providers/listenbrainz/scrobble`, `/now-playing` | `POST /api/v1/playback/reports` (the server scrobbles) |
| 24 Nov 2026 | `POST /api/providers/lastfm/love`, `/unlove` | `PUT /api/v1/tracks/:id/loved` (the server syncs Last.fm) |
| 24 Nov 2026 | `GET /api/providers/listenbrainz/status` | nothing; Settings → Scrobbling has its own status |

## Checking (for the next deprecation)

On the server, after at least a week with the logging deployed:

```
ssh <prod-user>@<prod-host> 'cd ~/NorthernLights && grep -h "\[Deprecated API\]" logs/production.log* | sort'
```

Use `LOG_DIR` instead of `logs/` if it's set. Logs are kept for 30 days.

- **No lines:** nothing called them. Remove the routes, one PR per route file, and their sections in `docs/API.md`. Check that `production.log*` reaches back to the start of the week (the first line's date) and holds other warnings, so an empty result means no calls rather than lost logs.
- **Lines:** the user and client say who still calls them. Move that caller to API v1 first, then wait another week.
