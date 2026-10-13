# Database Export and Import

**Status:** Proposed, 2026-10-13. Prerequisite for Phase 1 of
[playback_sessions.md](playback_sessions.md), whose schema changes will reach a
database that prod and the Cast dev channel share.

## Why

- **Move a server to a new host** without rescanning and re-analysing the
  library. On prod the audio analysis (`track_features`) alone is hours of CPU.
- **Take backups at known points**, above all right before a deploy that
  changes the schema, so a bad migration can be undone.
- **Rehearse a schema change** against a real copy of prod in a second
  container before it ever touches prod.

Today the only documented backup is stopping Aurora and tarring the Postgres
data directory ([production_guide.md § Backups](production_guide.md#backups)).
That ties the backup to one Postgres major version and one disk layout, and it
needs downtime.

## Facts that shape the design

From prod on 2026-10-13: the database is 982 MB on disk.

| Table | Total | Of which indexes |
| --- | --- | --- |
| `track_features` | 504 MB | 301 MB (pgvector HNSW) |
| `track_artist_credits` | 177 MB | 106 MB |
| `tracks` | 118 MB | 54 MB |
| `artists` | 75 MB | 34 MB |
| everything else | about 110 MB | |

- **Size:** indexes are about 540 MB and are rebuilt on restore rather than
  exported. A compressed `pg_dump` of the remaining data is expected around
  150–250 MB. That is too large to upload through Cloudflare (100 MB per
  request on the free plan), so import cannot rely on a browser upload to
  `aurora.onecloud.dk`. Downloads through Cloudflare are fine.
- **Restore time** is dominated by rebuilding the HNSW index on
  `track_features`, so an import is a background job with progress, never a
  request held open.
- **Nothing large is derived enough to skip.** The art cache lives outside the
  database and rebuilds itself; it is not exported.
- **The database may not be local.** Aurora usually manages its own container
  (`pgvector/pgvector:pg16`, `DB_CONTAINER_NAME`), but `DB_HOST` can point at
  an external Postgres. Export runs `pg_dump` inside the managed container
  when there is one, otherwise a host `pg_dump` when installed. If neither is
  available, it says so up front instead of failing halfway.
- **A track's ID is derived from its file path** (`id = base64(path)`), and
  ten foreign keys reference `tracks.id`, none with `ON UPDATE CASCADE`.
  Remapping library paths on a new host would therefore re-key every track,
  every table that references it, and every ID cached by API and Subsonic
  clients. That is the same unsolved problem as file renames (move detection),
  so **version 1 does not remap paths**. See [Library paths](#library-paths).
- **The dump contains secrets.** `system_settings` holds the JWT secret, API
  keys and the Turnstile keys. A migration needs them, because sessions and
  paired apps keep working. A test copy must not share them, or tokens would be
  valid on both servers.

## Export

**Where it runs:** one service, `server/services/databaseExport.service.ts`,
used by both an admin route and a command line (`npm run db:export`).

**What it does:**
- Runs `pg_dump --format=custom` of the whole database. `pg_dump` takes a
  consistent snapshot, so Aurora keeps running and the scanner may keep
  writing.
- Writes `backups/aurora-<UTC timestamp>-<short commit>.dump` next to a
  `.json` manifest:
  - format version;
  - app version and commit;
  - schema fingerprint (a hash of `information_schema` columns);
  - Postgres server version and pgvector version;
  - row count per table;
  - library roots (`directories.path`);
  - dump size and SHA-256.
- Keeps the newest **10** exports (`DB_EXPORT_KEEP`) and deletes older ones
  only after a new export has completed.

**Admin surface (Settings → Database):**
- **Export now** runs in the background. No status text is shown while it
  runs; the button's spinner is the feedback, and text appears only on
  failure.
- A list of exports, each with size, time, schema fingerprint and Download.
- Delete.
- Who can use it: admins only (`requireAdmin`), through the existing admin
  rate limits.
- Downloads stream the file. The manifest is never served to non-admins.

**Command line:**
- `npm run db:export [-- --label pre-phase-1]`
- Prints the dump path and manifest. Exits non-zero on any failure, so the
  local deploy script can refuse to deploy without a fresh export.

## Import

Import is a command-line step, run on the target host with Aurora **stopped**:
`npm run db:import -- <dump> [--rotate-secrets] [--target musicdb]`. A browser
upload may come later for small installs and LAN use, but it is not the
migration path.

**Steps:**
1. **Check the dump:** the manifest must be present, the SHA-256 must match,
   the format version must be supported, and the target Postgres must be at
   the same or a newer major version, with pgvector available.
2. **Library roots:** every `directories.path` in the manifest must exist and
   be readable on this host. If one is missing, the import stops before
   writing anything and explains how to make the path exist: mount or symlink
   the library at the same path. This keeps a scan from treating every track
   as deleted, which would cascade away playlists, loves and play stats.
3. **Restore into a new database**, never over the live one:
   `CREATE DATABASE <target>_import_<timestamp>`, then `pg_restore` into it,
   with progress reported per table and while indexes build.
4. **Verify** each table's row count against the manifest.
5. **With `--rotate-secrets`:** replace the JWT secret (signing out every
   session and token) and clear Turnstile keys and API keys that belong to the
   old host. Without it, secrets are kept, which is what a migration wants.
   The command asks each time and defaults to keep.
6. **Switch**, only after a confirmation prompt:
   - rename the current database to `<target>_prev_<timestamp>`;
   - rename the imported one to `<target>`;
   - keep the previous database until it is deleted by hand.

   On a fresh host with an empty database this step simply replaces the empty
   one.
7. **Start Aurora.** The usual boot-time schema statements bring an older
   dump up to the current schema; they are idempotent.

**Rollback:** stop Aurora, rename `<target>_prev_<timestamp>` back, and start
it again.

## Library paths

**Version 1** requires the music at the same absolute paths on the new host.
Containers and bind mounts make that easy. A later version may remap paths by
re-keying tracks inside one transaction: updating every table that references
`tracks.id`, and recording an old-to-new ID map for API and Subsonic clients.
It belongs with move detection, which needs the same machinery.

## A second container

There is no separate feature for this; it is the same import with a different
target:
- `--target` names a database in another container (for example a
  `music-postgres-staging` container created through the existing container
  controls on another port);
- or a whole second Aurora instance points at it.

It is used to rehearse a schema change against a copy of prod, and to test a
migration before switching the real host.

## Safety net for Phase 1

- **Schema changes are additive** while the dev channel shares prod's
  database: new tables and nullable columns are fine, renames and drops wait
  for a later release. The previous build then still runs against the new
  schema, so `deploy-prod.sh --rollback` alone undoes a bad deploy.
- **Before deploying a build whose schema fingerprint differs from prod's,**
  the local deploy script runs `npm run db:export -- --label pre-<commit>` on
  prod and refuses to continue if the export fails.
- **A migration that cannot be additive** is rehearsed first on an import into
  a second container.

## Delivery

1. **Export:** service, manifest, retention, command line, and admin list,
   download and delete in Settings → Database. Tests use a fake runner for
   `pg_dump`, plus a manual run against the dev database and then prod.
2. **Import from the command line:** checks, library-root guard, restore into
   a new database, verification, secret rotation, and the confirmed switch.
   Rehearsed by importing a prod export into a container on the dev box.
3. **Deploy guard:** the deploy script's schema-fingerprint check, with an
   export before any schema change.
4. **Later:** browser upload for small installs; path remapping with move
   detection.
