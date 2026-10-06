import type { ProcessingLogChannel } from '../../shared/logging';
import { logProcessing } from './loggingConfig';

export function forwardWorkerLog(channel: ProcessingLogChannel, line: string) {
  try {
    const value = JSON.parse(line);
    if (value?.kind === 'aurora-worker-log' && typeof value.message === 'string') {
      if (value.level === 'debug') logProcessing(channel, value.message);
      else if (value.level === 'warn') console.warn(value.message);
      else if (value.level === 'error') console.error(value.message);
      else throw new Error('Unknown worker log level');
      return;
    }
  } catch { /* Unexpected stderr (e.g. a Node crash) must remain visible. */ }
  if (line.trim()) console.error(`[${channel} worker] ${line}`);
}
