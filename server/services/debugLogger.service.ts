import fs from 'fs';
import path from 'path';
import { redactLogSecrets } from '../../shared/logRedaction';
import { isHlsLoggingEnabled, isFfmpegLoggingEnabled } from './loggingConfig';
import { BoundedDiagnosticLog } from './boundedDiagnosticLog';

const LOGS_DIR = path.join(__dirname, '../../logs');
const hlsLog = new BoundedDiagnosticLog(LOGS_DIR);
export type HlsLogDetail = 'normal' | 'detailed' | 'ffmpeg';

function enabled(detail: HlsLogDetail) {
  return detail === 'normal' || (detail === 'detailed' ? isHlsLoggingEnabled() : isFfmpegLoggingEnabled());
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function timestamp() {
  return new Date().toISOString();
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'unknown';
}

function appendLine(filePath: string, line: string) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `[${timestamp()}] ${redactLogSecrets(line)}\n`, 'utf8');
}

export function getLogFilePath(name: string): string {
  ensureDir(LOGS_DIR);
  return path.join(LOGS_DIR, name);
}

export function writeDebugLog(name: string, line: string) {
  appendLine(getLogFilePath(name), line);
}

export function writeHlsServerLog(line: string, detail: HlsLogDetail = 'normal') {
  if (enabled(detail)) hlsLog.append('hls-server.log', line);
}

export function writeCastReceiverLog(line: string) {
  appendLine(getLogFilePath('cast-receiver.log'), line);
}

export function writeHlsSessionLog(trackId: string, quality: string, codec: string, line: string, detail: HlsLogDetail = 'normal') {
  if (!enabled(detail)) return;
  const fileName = `${sanitizeSegment(trackId)}--${sanitizeSegment(quality)}--${sanitizeSegment(codec)}.log`;
  hlsLog.append(path.join('hls-sessions', fileName), line);
}
