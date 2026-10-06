export const SERVER_LOGGING_SETTINGS = {
  hlsLoggingEnabled: 'hls',
  ffmpegLoggingEnabled: 'ffmpeg',
  scannerLoggingEnabled: 'scanner',
  analyzerLoggingEnabled: 'analyzer',
  loudnessLoggingEnabled: 'loudness',
} as const;

export type ServerLoggingSetting = keyof typeof SERVER_LOGGING_SETTINGS;
export type ProcessingLogChannel = 'scanner' | 'analyzer' | 'loudness';
