import { spawn, spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getContainerRuntime, getContainerStatus } from './containerControl.service';
import { dbSettings, EXPORT_FORMAT_VERSION, type ExportManifest, type QueryClient } from './databaseExport.service';

/**
 * Database import: restore an export into a NEW database, verify it against
 * its manifest, optionally give it a new identity, then switch only on
 * confirmation and keep the previous database. Run with Aurora stopped.
 * See docs/database_export_import.md.
 */

export class ImportRefusedError extends Error {}

export interface ClosableClient extends QueryClient {
  end(): Promise<void>;
}

export interface RestorePlan {
  method: 'container' | 'host';
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** The container reads the dump from stdin; a host pg_restore reads the file itself. */
  stdinFile?: string;
}

export interface RestoreProcess {
  stdin: NodeJS.WritableStream | null;
  stderr: NodeJS.ReadableStream;
  on(event: 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export type RestoreRunner = (plan: RestorePlan) => RestoreProcess;

const defaultRunner: RestoreRunner = (plan) =>
  spawn(plan.command, plan.args, { env: plan.env ?? process.env, stdio: [plan.stdinFile ? 'pipe' : 'ignore', 'ignore', 'pipe'] }) as unknown as RestoreProcess;

export async function planRestore(database: string, dumpPath: string): Promise<{ plan: RestorePlan } | { plan: null; reason: string }> {
  const db = dbSettings();
  const common = ['--no-owner', '--exit-on-error', '--verbose'];
  const runtime = getContainerRuntime();
  if (runtime) {
    try {
      const status = await getContainerStatus(db.container);
      if (status.status === 'running') {
        return {
          plan: {
            method: 'container', command: runtime.bin, stdinFile: dumpPath,
            args: ['exec', '-i', db.container, 'pg_restore', ...common, '-U', db.user, '-d', database],
          },
        };
      }
    } catch {
      // fall through to a host pg_restore
    }
  }
  const probe = spawnSync('pg_restore', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (probe.status === 0) {
    return {
      plan: {
        method: 'host', command: 'pg_restore',
        args: [...common, '-h', db.host, '-p', db.port, '-U', db.user, '-d', database, dumpPath],
        env: { ...process.env, PGPASSWORD: db.password },
      },
    };
  }
  return { plan: null, reason: `No running database container named "${db.container}" and no pg_restore on this host.` };
}

export function readManifest(dumpPath: string): ExportManifest {
  if (!dumpPath.endsWith('.dump')) throw new ImportRefusedError('The export file must end in .dump');
  const manifestPath = `${dumpPath.slice(0, -'.dump'.length)}.json`;
  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new ImportRefusedError(`Its manifest is missing or unreadable: ${manifestPath}`);
  }
  if (manifest.formatVersion !== EXPORT_FORMAT_VERSION) {
    throw new ImportRefusedError(`Unsupported export format ${manifest.formatVersion}; this Aurora reads format ${EXPORT_FORMAT_VERSION}.`);
  }
  if (manifest.name !== path.basename(dumpPath)) {
    throw new ImportRefusedError(`The manifest describes ${manifest.name}, not ${path.basename(dumpPath)}.`);
  }
  return manifest;
}

export function hashFile(file: string): Promise<{ bytes: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    fs.createReadStream(file)
      .on('data', (chunk: Buffer) => { bytes += chunk.length; hash.update(chunk); })
      .on('error', reject)
      .on('end', () => resolve({ bytes, sha256: hash.digest('hex') }));
  });
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const majorOf = (version: string) => Number.parseInt(String(version), 10);

/** Library roots that do not exist here. A scan of a library that "vanished" deletes every track in it. */
export function missingLibraryRoots(roots: string[], exists = (dir: string) => {
  try {
    fs.accessSync(dir, fs.constants.R_OK);
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}): string[] {
  return roots.filter(root => !exists(root));
}

/** Give a copy its own identity: nothing signed or issued by the original works on it. */
export async function rotateSecrets(client: QueryClient): Promise<string[]> {
  const done: string[] = [];
  const secret = crypto.randomBytes(64).toString('hex');
  await client.query(
    `INSERT INTO system_settings (key, value) VALUES ('jwtSecret', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(secret)],
  );
  done.push('new JWT secret: every session and token from the original is invalid here');
  for (const table of ['subsonic_api_keys', 'aurora_app_keys', 'aurora_pairing_requests']) {
    const { rows } = await client.query<{ n: string }>(`WITH gone AS (DELETE FROM ${table} RETURNING 1) SELECT count(*) AS n FROM gone`);
    done.push(`${table}: ${rows[0]?.n ?? 0} removed`);
  }
  await client.query(`
    INSERT INTO system_settings (key, value) VALUES ('turnstileEnabled', 'false')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await client.query("DELETE FROM system_settings WHERE key IN ('turnstileSiteKey', 'turnstileSecretKey')");
  done.push('Turnstile disabled and its keys cleared (they are bound to the original hostname)');
  return done;
}

export interface ImportOptions {
  dumpPath: string;
  /** The database Aurora uses; default DB_NAME. */
  target?: string;
  /** Connected to the maintenance database ("postgres"): creates, renames and checks activity. */
  admin: QueryClient;
  connectTo: (database: string) => Promise<ClosableClient>;
  rotate: boolean;
  confirmSwitch: (summary: { target: string; imported: string; previous: string | null }) => Promise<boolean>;
  log?: (line: string) => void;
  runner?: RestoreRunner;
  plan?: (database: string, dumpPath: string) => Promise<{ plan: RestorePlan } | { plan: null; reason: string }>;
  rootExists?: (dir: string) => boolean;
  now?: () => Date;
}

export interface ImportResult {
  manifest: ExportManifest;
  imported: string;
  switched: boolean;
  previous: string | null;
  rotated: string[];
}

export async function importDatabase(options: ImportOptions): Promise<ImportResult> {
  const log = options.log ?? (() => undefined);
  const dumpPath = path.resolve(options.dumpPath);
  const target = options.target || dbSettings().name;
  const { admin } = options;

  // 1. The file is what its manifest says it is.
  const manifest = readManifest(dumpPath);
  const actual = await hashFile(dumpPath);
  if (actual.bytes !== manifest.dump.bytes || actual.sha256 !== manifest.dump.sha256) {
    throw new ImportRefusedError('The export file does not match its manifest (size or SHA-256); it is incomplete or altered.');
  }
  log(`Export ${manifest.name}: ${manifest.rowCounts.tracks ?? 0} tracks, Aurora ${manifest.app.version} (${manifest.app.commit}), checksum OK`);

  // 2. The music is where the database says it is.
  const missing = missingLibraryRoots(manifest.libraryRoots, options.rootExists);
  if (missing.length) {
    throw new ImportRefusedError(
      `These library folders do not exist on this host:\n${missing.map(root => `  ${root}`).join('\n')}\n`
      + 'Track IDs are derived from file paths, so the music must be at the same paths here: mount or symlink it, '
      + 'then run the import again. Nothing has been changed.',
    );
  }

  // 3. This Postgres can take the dump.
  const { rows: versionRows } = await admin.query<{ server_version_num: string }>('SHOW server_version_num');
  const targetMajor = Math.floor(Number(versionRows[0]?.server_version_num) / 10000);
  const sourceMajor = majorOf(manifest.database.serverVersion);
  if (!Number.isFinite(targetMajor) || targetMajor < sourceMajor) {
    throw new ImportRefusedError(`The export is from Postgres ${sourceMajor}; this server runs ${targetMajor}. Restore into ${sourceMajor} or newer.`);
  }
  if (manifest.database.pgvector) {
    const { rows } = await admin.query("SELECT 1 FROM pg_available_extensions WHERE name = 'vector'");
    if (!rows.length) throw new ImportRefusedError('This Postgres has no pgvector extension; use the pgvector/pgvector image.');
  }

  // 4. Nothing is using the target (Aurora stopped), so the switch can rename it.
  const { rows: existing } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [target]);
  const targetExists = existing.length > 0;
  const assertIdle = async () => {
    if (!targetExists) return;
    const { rows } = await admin.query<{ n: string }>(
      'SELECT count(*) AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [target],
    );
    if (Number(rows[0]?.n) > 0) {
      throw new ImportRefusedError(`Something is connected to "${target}". Stop Aurora first (for example: pm2 stop aurora), then run the import again.`);
    }
  };
  await assertIdle();

  // 5. Restore into a new database, never over the live one.
  const stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const imported = `${target}_import_${stamp}`;
  const planned = await (options.plan ?? planRestore)(imported, dumpPath);
  if (!planned.plan) throw new ImportRefusedError(planned.reason);
  await admin.query(`CREATE DATABASE ${quoteIdent(imported)}`);
  log(`Restoring into new database "${imported}" (via ${planned.plan.method})…`);
  try {
    await runRestore(planned.plan, options.runner ?? defaultRunner, log);

    // 6. Every table has exactly the rows the export had.
    const client = await options.connectTo(imported);
    let rotated: string[] = [];
    try {
      const { rows: tables } = await client.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
      );
      const restored = new Set(tables.map(row => row.table_name));
      const problems: string[] = [];
      for (const [table, expected] of Object.entries(manifest.rowCounts)) {
        if (!restored.has(table)) { problems.push(`${table}: missing`); continue; }
        const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM public.${quoteIdent(table)}`);
        if (Number(rows[0]?.n) !== expected) problems.push(`${table}: ${rows[0]?.n} rows, expected ${expected}`);
      }
      if (problems.length) throw new Error(`The restored data does not match the export:\n  ${problems.join('\n  ')}`);
      log(`Verified ${Object.keys(manifest.rowCounts).length} tables against the manifest`);

      // 7. A copy gets its own identity; a migration keeps it.
      if (options.rotate) {
        rotated = await rotateSecrets(client);
        rotated.forEach(line => log(`Rotated: ${line}`));
      }
    } finally {
      await client.end();
    }

    // 8. Switch only on confirmation; keep the previous database.
    const previous = targetExists ? `${target}_prev_${stamp}` : null;
    if (!(await options.confirmSwitch({ target, imported, previous }))) {
      log(`Not switched. The verified copy stays in "${imported}".`);
      return { manifest, imported, switched: false, previous: null, rotated };
    }
    await assertIdle();
    if (previous) await admin.query(`ALTER DATABASE ${quoteIdent(target)} RENAME TO ${quoteIdent(previous)}`);
    try {
      await admin.query(`ALTER DATABASE ${quoteIdent(imported)} RENAME TO ${quoteIdent(target)}`);
    } catch (error) {
      if (previous) await admin.query(`ALTER DATABASE ${quoteIdent(previous)} RENAME TO ${quoteIdent(target)}`).catch(() => undefined);
      throw error;
    }
    log(previous ? `Switched: "${target}" is the import; the previous database is kept as "${previous}".` : `Switched: "${target}" is the import.`);
    return { manifest, imported, switched: true, previous, rotated };
  } catch (error) {
    // A failed or unverified restore never lingers as if it were usable.
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(imported)}`).catch(() => undefined);
    throw error;
  }
}

function runRestore(plan: RestorePlan, runner: RestoreRunner, log: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = runner(plan);
    let tail = '';
    let buffered = '';
    let tables = 0;
    let indexes = 0;
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-2000);
      buffered += text;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const data = line.match(/processing data for table "(?:public\.)?([^"]+)"/);
        if (data) { tables++; log(`  data: ${data[1]} (${tables})`); continue; }
        if (/creating (INDEX|CONSTRAINT|FK CONSTRAINT)/.test(line) && ++indexes % 25 === 0) log(`  indexes and constraints: ${indexes}`);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_restore exited with code ${code}: ${tail.trim().split('\n').slice(-5).join(' | ')}`));
    });
    if (plan.stdinFile && child.stdin) {
      fs.createReadStream(plan.stdinFile).on('error', reject).pipe(child.stdin);
    }
  });
}
