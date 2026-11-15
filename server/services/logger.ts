/**
 * The server's log policy. Everything the server prints keeps going to the
 * console as before (pm2 or journald may capture it), and is also recorded
 * in Aurora's own rotating files (logFiles.ts):
 *
 *   level  what                                  console  production.log  area file
 *   error  failures                               always   always          always
 *   warn   actionable warnings                    always   always          always
 *   info   normal server messages                 ≥ info   ≥ info          —
 *   debug  console.debug                          debug    debug           —
 *   area   an area's detail (scanner, analyzer,   when that area's switch is on (Settings →
 *          loudness)                              System → Logging), whatever the level
 *
 * The level (Settings → System → Logging → Log level; LOG_LEVEL in .env as
 * the default) is the threshold for info and debug; errors and warnings are
 * recorded at every level. An area's file (scanner.log, analyzer.log,
 * loudness.log) gets its errors and warnings even while its switch is off.
 * A line belongs to an area by its prefix ("[Scanner] …"), or because the
 * caller says so (worker output, logChannel).
 */
import util from 'util';
import { redactLogSecrets } from '../../shared/logRedaction';
import { DEFAULT_LOG_LEVEL, isLogLevel, type LogLevel, type ProcessingLogChannel } from '../../shared/logging';
import { logFile, startLogExpiry } from './logFiles';

type Recorded = 'error' | 'warn' | 'info' | 'debug';
const RANK: Record<Recorded, number> = { error: 0, warn: 1, info: 2, debug: 3 };

let threshold: LogLevel = isLogLevel(process.env.LOG_LEVEL) ? process.env.LOG_LEVEL : DEFAULT_LOG_LEVEL;

export function setLogLevel(level: LogLevel) {
  threshold = level;
}

export function getLogLevel(): LogLevel {
  return threshold;
}

/** Errors and warnings always; info and debug from the threshold. */
export function isRecorded(level: Recorded, at: LogLevel = threshold): boolean {
  return RANK[level] <= Math.max(RANK.warn, RANK[at]);
}

const CHANNEL_FILES: Record<ProcessingLogChannel, string> = {
  scanner: 'scanner.log',
  analyzer: 'analyzer.log',
  loudness: 'loudness.log',
};

const CHANNEL_PREFIXES: Array<[RegExp, ProcessingLogChannel]> = [
  [/^\[(Scanner|Scan|Metadata)\b/, 'scanner'],
  [/^\[(Analysis|Analyzer|AudioExtract|Moods|analyzer worker)\b/, 'analyzer'],
  [/^\[Loudness\b/, 'loudness'],
];

/** The area a line belongs to, by its prefix. */
export function channelOf(text: string): ProcessingLogChannel | null {
  for (const [pattern, channel] of CHANNEL_PREFIXES) if (pattern.test(text)) return channel;
  return null;
}

const original = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

/** The console as it was before install (the live one until then, so tests' spies still see it). */
const out = (method: keyof typeof original) => (installed ? original[method] : console[method]);

function stamp(level: Recorded | 'area', text: string) {
  const clean = redactLogSecrets(text).replace(/\r?\n+$/, '');
  return `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${clean}`;
}

function recordFiles(level: Recorded | 'area', text: string, channel: ProcessingLogChannel | null) {
  const line = stamp(level, text);
  logFile('production.log').write(line);
  if (channel) logFile(CHANNEL_FILES[channel]).write(line);
}

/** An area's detail line: the caller has checked that area's switch. */
export function logChannelDetail(channel: ProcessingLogChannel, ...args: unknown[]) {
  out('log')(...args);
  if (installed) recordFiles('area', util.format(...args), channel);
}

/** An area's error or warning: recorded always, in its own file too. */
export function logChannel(channel: ProcessingLogChannel, level: 'warn' | 'error', ...args: unknown[]) {
  out(level)(...args);
  if (installed) recordFiles(level, util.format(...args), channel);
}

let installed = false;

/**
 * Starts recording the console into Aurora's files and the hourly expiry.
 * Called once, first thing in server/index.ts; tests and worker processes
 * never install it.
 */
export function installLogging() {
  if (installed) return;
  installed = true;
  const methods: Array<[keyof typeof original, Recorded]> = [
    ['log', 'info'], ['info', 'info'], ['debug', 'debug'], ['warn', 'warn'], ['error', 'error'],
  ];
  for (const [method, level] of methods) {
    console[method] = (...args: unknown[]) => {
      if (!isRecorded(level)) return;
      original[method](...args);
      const text = util.format(...args);
      // Info and debug stay out of the area files: an area's detail comes
      // through logChannelDetail, gated by its switch.
      recordFiles(level, text, level === 'error' || level === 'warn' ? channelOf(text) : null);
    };
  }
  startLogExpiry();
}
