/**
 * Aurora's own log files: size-based rotation and age-based expiry, so logs
 * stay bounded however the server runs (pm2, systemd, a terminal, a
 * container) without relying on that process manager to rotate them.
 *
 * Policy (from .env, with defaults):
 *   LOG_DIR             where the files live (default: <app>/logs)
 *   LOG_MAX_FILE_MB     a file rotates when it would pass this size (50)
 *   LOG_KEEP_FILES      files kept per log, the current one included (5)
 *   LOG_RETENTION_DAYS  files not written for this long are deleted (30)
 *
 * Rotation: name.log → name.log.1 → … → name.log.(keep - 1); the oldest goes.
 * Expiry runs at start and hourly, and touches only the files Aurora writes
 * (AURORA_LOGS and their rotated copies, and hls-sessions/), never anything
 * else someone keeps in the folder.
 */
import fs from 'fs';
import path from 'path';

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

function positiveNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface LogPolicy {
  dir: string;
  maxFileBytes: number;
  keepFiles: number;
  retentionMs: number;
}

export function logPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): LogPolicy {
  return {
    dir: env.LOG_DIR ? path.resolve(env.LOG_DIR) : path.join(__dirname, '..', '..', 'logs'),
    maxFileBytes: positiveNumber(env.LOG_MAX_FILE_MB, 50) * MB,
    keepFiles: Math.max(1, Math.round(positiveNumber(env.LOG_KEEP_FILES, 5))),
    retentionMs: positiveNumber(env.LOG_RETENTION_DAYS, 30) * DAY_MS,
  };
}

export const logPolicy: LogPolicy = logPolicyFromEnv();

/** The files Aurora writes under the log folder (each may have rotated copies). */
export const AURORA_LOGS = [
  'production.log', 'scanner.log', 'analyzer.log', 'loudness.log', 'hls-server.log',
  'cast-receiver.log', 'auth.log', 'subsonic-api.log', 'lastfm-oauth.log',
] as const;

/** One log file that rotates by size. Writing never throws: logging must not break the app. */
export class RotatingLogFile {
  private fd: number | null = null;
  private size = 0;
  readonly file: string;

  constructor(name: string, private readonly policy: LogPolicy = logPolicy) {
    const root = path.resolve(policy.dir);
    const file = path.resolve(root, name);
    // Names are fixed or sanitized by callers; refuse anything outside the folder.
    if (!file.startsWith(root + path.sep)) throw new Error(`Log file outside the log folder: ${name}`);
    this.file = file;
  }

  write(line: string) {
    try {
      const text = line.endsWith('\n') ? line : `${line}\n`;
      const bytes = Buffer.byteLength(text);
      if (this.fd === null) this.open();
      if (this.size > 0 && this.size + bytes > this.policy.maxFileBytes) {
        this.rotate();
        this.open();
      }
      fs.writeSync(this.fd!, text);
      this.size += bytes;
    } catch {
      // A full disk or a permissions problem must not take playback down with it.
      this.close();
    }
  }

  close() {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd); } catch { /* already gone */ }
      this.fd = null;
    }
  }

  private open() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.fd = fs.openSync(this.file, 'a');
    this.size = fs.fstatSync(this.fd).size;
  }

  private rotate() {
    this.close();
    const keep = this.policy.keepFiles;
    fs.rmSync(`${this.file}.${keep - 1}`, { force: true });
    for (let n = keep - 2; n >= 1; n--) {
      if (fs.existsSync(`${this.file}.${n}`)) fs.renameSync(`${this.file}.${n}`, `${this.file}.${n + 1}`);
    }
    if (keep > 1) fs.renameSync(this.file, `${this.file}.1`);
    else fs.rmSync(this.file, { force: true });
  }
}

const ROTATED = /\.log(?:\.\d+)?$/;

/**
 * Deletes Aurora's log files not written within the retention period, and
 * rotated copies beyond the number kept (after LOG_KEEP_FILES was lowered).
 * Returns how many files went.
 */
export function pruneLogs(policy: LogPolicy = logPolicy, now = Date.now()): number {
  let removed = 0;
  const remove = (file: string) => {
    try { fs.rmSync(file, { force: true }); removed++; } catch { /* keep going */ }
  };
  let entries: string[] = [];
  try { entries = fs.readdirSync(policy.dir); } catch { return 0; }
  for (const name of AURORA_LOGS) {
    for (const entry of entries) {
      const match = entry === name ? 0 : entry.startsWith(`${name}.`) ? Number(entry.slice(name.length + 1)) : NaN;
      if (!Number.isInteger(match)) continue;
      const file = path.join(policy.dir, entry);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        if (now - stat.mtimeMs > policy.retentionMs || match >= policy.keepFiles) remove(file);
      } catch { /* vanished meanwhile */ }
    }
  }
  const sessions = path.join(policy.dir, 'hls-sessions');
  try {
    for (const entry of fs.readdirSync(sessions)) {
      if (!ROTATED.test(entry)) continue;
      const file = path.join(sessions, entry);
      const stat = fs.statSync(file);
      if (stat.isFile() && now - stat.mtimeMs > policy.retentionMs) remove(file);
    }
  } catch { /* no sessions yet */ }
  return removed;
}

let pruneTimer: NodeJS.Timeout | null = null;

/** Expiry at start and then hourly. */
export function startLogExpiry(policy: LogPolicy = logPolicy) {
  if (pruneTimer) return;
  pruneLogs(policy);
  pruneTimer = setInterval(() => pruneLogs(policy), 60 * 60 * 1000);
  pruneTimer.unref?.();
}

const files = new Map<string, RotatingLogFile>();

/** The shared writer for one of Aurora's log files. */
export function logFile(name: string): RotatingLogFile {
  let file = files.get(name);
  if (!file) {
    file = new RotatingLogFile(name);
    files.set(name, file);
  }
  return file;
}
