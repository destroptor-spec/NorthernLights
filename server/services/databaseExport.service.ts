import { spawn, spawnSync } from 'child_process';
import { Client, type ClientConfig } from 'pg';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getContainerRuntime, getContainerStatus } from './containerControl.service';

/**
 * Database export: a consistent `pg_dump --format=custom` of the whole
 * database plus a manifest an import can verify against.
 * See docs/database_export_import.md.
 */

export const EXPORT_FORMAT_VERSION = 1;

export function getExportDir(): string {
  return path.resolve(process.env.DB_EXPORT_DIR || './backups');
}

export function getExportKeep(): number {
  const keep = Number.parseInt(process.env.DB_EXPORT_KEEP || '', 10);
  return Number.isInteger(keep) && keep > 0 ? keep : 10;
}

const EXPORT_NAME = /^aurora-\d{8}T\d{6}Z-[0-9a-z]{1,12}(?:-[a-z0-9-]{1,40})?\.dump$/;

export function isExportName(name: unknown): name is string {
  return typeof name === 'string' && EXPORT_NAME.test(name);
}

/** Resolve an export file inside the export directory, refusing anything else. */
export function resolveExportFile(name: string, dir = getExportDir()): string {
  if (!isExportName(name)) throw new Error('Invalid export name');
  const root = path.resolve(dir);
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep)) throw new Error('Export path escapes the export directory');
  return file;
}

export function sanitizeLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  // Cap the input before any pattern runs, and trim dashes without a
  // backtracking pattern (CodeQL js/polynomial-redos on `-+$`).
  let cleaned = label.slice(0, 200).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  let start = 0;
  let end = cleaned.length;
  while (start < end && cleaned[start] === '-') start++;
  while (end > start && cleaned[end - 1] === '-') end--;
  cleaned = cleaned.slice(start, end);
  while (cleaned.includes('--')) cleaned = cleaned.split('--').join('-');
  return cleaned.slice(0, 40) || null;
}

export function exportNameFor(date: Date, commit: string, label: string | null): string {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const safeCommit = /^[0-9a-z]{1,12}$/.test(commit) ? commit : 'unknown';
  return `aurora-${stamp}-${safeCommit}${label ? `-${label}` : ''}.dump`;
}

export interface ExportManifest {
  formatVersion: number;
  name: string;
  label: string | null;
  createdAt: string;
  app: { version: string; commit: string };
  database: { name: string; serverVersion: string; pgvector: string | null };
  schemaFingerprint: string;
  rowCounts: Record<string, number>;
  libraryRoots: string[];
  dump: { bytes: number; sha256: string; method: DumpMethod };
}

export type DumpMethod = 'container' | 'host';

export interface DumpPlan {
  method: DumpMethod;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** Only what the export needs from a pg client: a query on one connection. */
export interface QueryClient {
  query<R = any>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export interface DumpProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: 'close', listener: (code: number | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export type DumpRunner = (plan: DumpPlan) => DumpProcess;

const defaultRunner: DumpRunner = (plan) =>
  spawn(plan.command, plan.args, { env: plan.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });

/** Aurora's database connection settings, the same defaults as server/database. */
export function dbSettings() {
  return {
    user: process.env.DB_USER || 'musicuser',
    password: process.env.DB_PASSWORD || 'musicpass',
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || '5432',
    name: process.env.DB_NAME || 'musicdb',
    container: process.env.DB_CONTAINER_NAME || 'music-postgres',
  };
}

export interface ConnectableClient extends QueryClient {
  connect(): Promise<unknown>;
  end(): Promise<void>;
}

/**
 * Connect a command-line client with Aurora's settings. When the host is
 * "localhost" and the connection fails, retry once on 127.0.0.1: Node resolves
 * localhost to ::1 first, and rootless Podman publishes the database port on
 * IPv4 only, so the IPv6 connection is accepted by the port forwarder and then
 * dropped ("Connection terminated unexpectedly"; prod 2026-10-13).
 */
export async function connectDatabase(
  database = dbSettings().name,
  makeClient: (config: ClientConfig) => ConnectableClient = (config) => new Client(config) as unknown as ConnectableClient,
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<ConnectableClient> {
  const db = dbSettings();
  const config: ClientConfig = { user: db.user, password: db.password, host: db.host, port: Number.parseInt(db.port, 10), database };
  const first = makeClient(config);
  try {
    await first.connect();
    return first;
  } catch (error) {
    await first.end().catch(() => undefined);
    if (db.host !== 'localhost') throw error;
    const fallback = makeClient({ ...config, host: '127.0.0.1' });
    await fallback.connect();
    warn(`Connected via 127.0.0.1: "localhost" (IPv6 first) did not reach the database (${error instanceof Error ? error.message : String(error)}). Set DB_HOST=127.0.0.1 to skip this.`);
    return fallback;
  }
}

/**
 * How pg_dump can run here: inside Aurora's managed container (its tools match
 * the server exactly), else a host pg_dump. `null` with a reason when neither.
 */
export async function planDump(snapshot?: string): Promise<{ plan: DumpPlan } | { plan: null; reason: string }> {
  const db = dbSettings();
  const common = ['--format=custom', '--no-owner', ...(snapshot ? [`--snapshot=${snapshot}`] : [])];
  const runtime = getContainerRuntime();
  if (runtime) {
    try {
      const status = await getContainerStatus(db.container);
      if (status.status === 'running') {
        return { plan: { method: 'container', command: runtime.bin, args: ['exec', db.container, 'pg_dump', ...common, '-U', db.user, db.name] } };
      }
    } catch {
      // fall through to a host pg_dump
    }
  }
  const probe = spawnSync('pg_dump', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (probe.status === 0) {
    return {
      plan: {
        method: 'host', command: 'pg_dump',
        args: [...common, '-h', db.host, '-p', db.port, '-U', db.user, db.name],
        env: { ...process.env, PGPASSWORD: db.password },
      },
    };
  }
  return { plan: null, reason: `No running database container named "${db.container}" and no pg_dump on this host.` };
}

function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function readCommit(): string {
  const fromEnv = (process.env.AURORA_COMMIT || '').trim().toLowerCase();
  if (/^[0-9a-f]{7,12}$/.test(fromEnv)) return fromEnv;
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
  const commit = (git.stdout || '').trim().toLowerCase();
  return git.status === 0 && /^[0-9a-f]{7,12}$/.test(commit) ? commit : 'unknown';
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Everything in the manifest that comes from the database, read inside the dump's snapshot. */
async function describeDatabase(client: QueryClient) {
  // One connection runs one query at a time; these stay sequential.
  const { rows: version } = await client.query<{ server_version: string }>('SHOW server_version');
  const { rows: vector } = await client.query<{ extversion: string }>("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
  const { rows: fingerprint } = await client.query<{ fingerprint: string }>(`
    SELECT md5(coalesce(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable, ','
      ORDER BY table_name, column_name), '')) AS fingerprint
    FROM information_schema.columns WHERE table_schema = 'public'`);
  const { rows: tables } = await client.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  const rowCounts: Record<string, number> = {};
  for (const { table_name } of tables) {
    const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM public.${quoteIdent(table_name)}`);
    rowCounts[table_name] = Number(rows[0]?.n ?? 0);
  }
  let libraryRoots: string[] = [];
  if ('directories' in rowCounts) {
    const { rows } = await client.query<{ path: string }>('SELECT path FROM directories ORDER BY path');
    libraryRoots = rows.map(row => row.path).filter(Boolean);
  }
  return {
    serverVersion: version[0]?.server_version ?? 'unknown',
    pgvector: vector[0]?.extversion ?? null,
    schemaFingerprint: fingerprint[0]?.fingerprint ?? '',
    rowCounts,
    libraryRoots,
  };
}

export class ExportUnavailableError extends Error {}

export interface RunExportOptions {
  /** A dedicated connection; the export holds a transaction open on it for the dump's duration. */
  client: QueryClient;
  label?: unknown;
  dir?: string;
  keep?: number;
  runner?: DumpRunner;
  plan?: (snapshot: string) => Promise<{ plan: DumpPlan } | { plan: null; reason: string }>;
  now?: () => Date;
}

/**
 * Dump the database into the export directory and write its manifest.
 *
 * Row counts and the dump share one snapshot: a REPEATABLE READ transaction
 * exports its snapshot to pg_dump, so the manifest describes exactly the data
 * in the file even while the scanner writes.
 */
export async function runExport(options: RunExportOptions): Promise<ExportManifest> {
  const dir = path.resolve(options.dir ?? getExportDir());
  const label = sanitizeLabel(options.label);
  const commit = readCommit();
  const name = exportNameFor((options.now ?? (() => new Date()))(), commit, label);
  const file = resolveExportFile(name, dir);
  const partial = `${file}.partial`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const { client } = options;
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const { rows } = await client.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot');
    const snapshot = rows[0]?.snapshot;
    if (!snapshot) throw new Error('Could not export a database snapshot');
    const planned = await (options.plan ?? planDump)(snapshot);
    if (!planned.plan) throw new ExportUnavailableError(planned.reason);
    const described = await describeDatabase(client);
    const dump = await writeDump(planned.plan, partial, options.runner ?? defaultRunner);

    const manifest: ExportManifest = {
      formatVersion: EXPORT_FORMAT_VERSION,
      name,
      label,
      createdAt: new Date().toISOString(),
      app: { version: readAppVersion(), commit },
      database: { name: dbSettings().name, serverVersion: described.serverVersion, pgvector: described.pgvector },
      schemaFingerprint: described.schemaFingerprint,
      rowCounts: described.rowCounts,
      libraryRoots: described.libraryRoots,
      dump: { ...dump, method: planned.plan.method },
    };
    fs.renameSync(partial, file);
    fs.writeFileSync(`${file.slice(0, -'.dump'.length)}.json`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    pruneExports(dir, options.keep ?? getExportKeep());
    return manifest;
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  } finally {
    await client.query('COMMIT').catch(() => undefined);
  }
}

function writeDump(plan: DumpPlan, target: string, runner: DumpRunner): Promise<{ bytes: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let bytes = 0;
    let stderr = '';
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      // Reject only once the file stream has closed: it opens and flushes
      // asynchronously, and could otherwise recreate the .partial file after
      // the caller has removed it (seen as a flaky test in CI).
      if (out.closed) {
        reject(error);
        return;
      }
      out.once('close', () => reject(error));
      out.destroy();
    };
    const out = fs.createWriteStream(target, { mode: 0o600 });
    const child = runner(plan);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    child.stdout.pipe(out);
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });
    child.on('error', fail);
    out.on('error', fail);
    child.on('close', (code) => {
      if (code !== 0) {
        fail(new Error(`pg_dump exited with code ${code}: ${stderr.trim().slice(0, 500) || 'no output'}`));
        return;
      }
      out.end(() => {
        if (settled) return;
        if (bytes === 0) {
          fail(new Error('pg_dump produced no output'));
          return;
        }
        settled = true;
        resolve({ bytes, sha256: hash.digest('hex') });
      });
    });
  });
}

export function listExports(dir = getExportDir()): ExportManifest[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const manifests: ExportManifest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const name = `${entry.slice(0, -'.json'.length)}.dump`;
    if (!isExportName(name)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8')) as ExportManifest;
      if (manifest?.name === name && fs.existsSync(resolveExportFile(name, dir))) manifests.push(manifest);
    } catch {
      // an unreadable manifest is not an export
    }
  }
  return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function deleteExport(name: string, dir = getExportDir()): void {
  const file = resolveExportFile(name, dir);
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file.slice(0, -'.dump'.length)}.json`, { force: true });
}

export function pruneExports(dir: string, keep: number): string[] {
  const removed = listExports(dir).slice(keep).map(manifest => manifest.name);
  for (const name of removed) deleteExport(name, dir);
  return removed;
}

/** One export at a time, with its state for the admin UI. */
export interface ExportJob {
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  name?: string;
  error?: string;
}

let currentJob: ExportJob | null = null;

export function getExportJob(): ExportJob | null {
  return currentJob;
}

export function startExportJob(run: () => Promise<ExportManifest>): ExportJob {
  if (currentJob?.state === 'running') return currentJob;
  const job: ExportJob = { state: 'running', startedAt: new Date().toISOString() };
  currentJob = job;
  void run().then(
    (manifest) => Object.assign(job, { state: 'done', name: manifest.name, finishedAt: new Date().toISOString() }),
    (error: unknown) => Object.assign(job, {
      state: 'failed', error: error instanceof Error ? error.message : String(error), finishedAt: new Date().toISOString(),
    }),
  );
  return job;
}

/** Single-use, short-lived download tickets, so no login token goes into a URL. */
const tickets = new Map<string, { name: string; expiresAt: number }>();
const TICKET_TTL_MS = 60_000;

export function issueDownloadTicket(name: string, now = Date.now()): string {
  resolveExportFile(name);
  for (const [ticket, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(ticket);
  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(ticket, { name, expiresAt: now + TICKET_TTL_MS });
  return ticket;
}

export function redeemDownloadTicket(ticket: unknown, now = Date.now()): string | null {
  if (typeof ticket !== 'string' || !/^[0-9a-f]{64}$/.test(ticket)) return null;
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  return entry && entry.expiresAt > now ? entry.name : null;
}
