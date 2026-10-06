import { SERVER_LOGGING_SETTINGS, type ProcessingLogChannel, type ServerLoggingSetting } from '../../shared/logging';

// Persisted admin settings override environment defaults at runtime.

function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const envHls = parseBoolEnv(process.env.LOG_HLS);
const envFfmpeg = parseBoolEnv(process.env.LOG_FFMPEG);

export const loggingFlags = {
  hls: envHls,
  ffmpeg: envFfmpeg,
  scanner: parseBoolEnv(process.env.LOG_SCANNER),
  analyzer: parseBoolEnv(process.env.LOG_ANALYZER),
  loudness: parseBoolEnv(process.env.LOG_LOUDNESS),
};

export function getLoggingSettings(): Record<ServerLoggingSetting, boolean> {
  return Object.fromEntries(Object.entries(SERVER_LOGGING_SETTINGS).map(([key, channel]) => [key, loggingFlags[channel]])) as Record<ServerLoggingSetting, boolean>;
}

export function applyLoggingSettings(settings: Record<string, unknown>) {
  for (const [key, channel] of Object.entries(SERVER_LOGGING_SETTINGS)) {
    if (typeof settings[key] === 'boolean') loggingFlags[channel] = settings[key];
  }
}

export function logProcessing(channel: ProcessingLogChannel, ...args: unknown[]) {
  if (loggingFlags[channel]) console.log(...args);
}

export const logScanner = (...args: unknown[]) => logProcessing('scanner', ...args);
export const logAnalyzer = (...args: unknown[]) => logProcessing('analyzer', ...args);
export const logLoudness = (...args: unknown[]) => logProcessing('loudness', ...args);

export function setHlsLogging(enabled: boolean) {
  loggingFlags.hls = !!enabled;
}

export function setFfmpegLogging(enabled: boolean) {
  loggingFlags.ffmpeg = !!enabled;
}

export function isHlsLoggingEnabled(): boolean {
  return loggingFlags.hls;
}

export function isFfmpegLoggingEnabled(): boolean {
  return loggingFlags.ffmpeg;
}

export function logHls(...args: any[]) {
  if (loggingFlags.hls) console.log(...args);
}

export function logFfmpeg(...args: any[]) {
  if (loggingFlags.ffmpeg) console.error(...args);
}

// Load persisted overrides from the DB. Call after the DB is connected.
// If a setting key is absent (null), keep the env-default already in place.
export async function loadLoggingSettingsFromDB() {
  try {
    const { getSystemSetting } = await import('../database');
    const entries = await Promise.all(Object.keys(SERVER_LOGGING_SETTINGS).map(async key => [key, await getSystemSetting(key)]));
    applyLoggingSettings(Object.fromEntries(entries));
  } catch {
    // ignore — env defaults stand
  }
}
