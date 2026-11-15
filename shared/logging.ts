export const SERVER_LOGGING_SETTINGS = {
  hlsLoggingEnabled: 'hls',
  ffmpegLoggingEnabled: 'ffmpeg',
  scannerLoggingEnabled: 'scanner',
  analyzerLoggingEnabled: 'analyzer',
  loudnessLoggingEnabled: 'loudness',
} as const;

export type ServerLoggingSetting = keyof typeof SERVER_LOGGING_SETTINGS;

/**
 * The threshold for the server's normal and debug messages (server
 * services/logger.ts). Errors and warnings are recorded at every level, so
 * "warn" is the quietest.
 */
export const LOG_LEVELS = ['warn', 'info', 'debug'] as const;
export type LogLevel = typeof LOG_LEVELS[number];
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';
export const isLogLevel = (value: unknown): value is LogLevel => (LOG_LEVELS as readonly unknown[]).includes(value);
export type ProcessingLogChannel = 'scanner' | 'analyzer' | 'loudness';
