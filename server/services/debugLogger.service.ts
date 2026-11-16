import path from 'path';
import { redactLogSecrets } from '../../shared/logRedaction';
import { isHlsLoggingEnabled, isFfmpegLoggingEnabled } from './loggingConfig';
import { BoundedDiagnosticLog } from './boundedDiagnosticLog';
import { logFile, logPolicy } from './logFiles';

// The log folder and retention come from the log policy (LOG_DIR, LOG_RETENTION_DAYS);
// HLS session files keep their own size limits (one file per session, 100 MB in all).
const LOGS_DIR = logPolicy.dir;
const hlsLog = new BoundedDiagnosticLog(LOGS_DIR, undefined, undefined, logPolicy.retentionMs);
export type HlsLogDetail = 'normal' | 'detailed' | 'ffmpeg';

function enabled(detail: HlsLogDetail) {
  return detail === 'normal' || (detail === 'detailed' ? isHlsLoggingEnabled() : isFfmpegLoggingEnabled());
}

function timestamp() {
  return new Date().toISOString();
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'unknown';
}

/** One line in one of Aurora's rotating log files (logFiles.ts), redacted and on one line. */
function appendLine(name: string, line: string) {
  const clean = redactLogSecrets(line).replace(/[\r\n]+/g, ' ').slice(0, 16384);
  logFile(name).write(`[${timestamp()}] ${clean}`);
}

export function writeDebugLog(name: string, line: string) {
  appendLine(name, line);
}

export function writeHlsServerLog(line: string, detail: HlsLogDetail = 'normal') {
  if (enabled(detail)) appendLine('hls-server.log', line);
}

export function writeCastReceiverLog(line: string) {
  appendLine('cast-receiver.log', line);
}

export function writeHlsSessionLog(trackId: string, quality: string, codec: string, line: string, detail: HlsLogDetail = 'normal') {
  if (!enabled(detail)) return;
  const fileName = `${sanitizeSegment(trackId)}--${sanitizeSegment(quality)}--${sanitizeSegment(codec)}.log`;
  hlsLog.append(path.join('hls-sessions', fileName), line);
}
