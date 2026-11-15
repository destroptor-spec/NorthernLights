import type { ProcessingLogChannel } from '../../shared/logging';
import { logProcessing } from './loggingConfig';
import { logChannel } from './logger';

/** A worker's log line: detail behind the area's switch; warnings and errors always, in the area's file too. */
export function forwardWorkerLog(channel: ProcessingLogChannel, line: string) {
  try {
    const value = JSON.parse(line);
    if (value?.kind === 'aurora-worker-log' && typeof value.message === 'string') {
      if (value.level === 'debug') logProcessing(channel, value.message);
      else if (value.level === 'warn') logChannel(channel, 'warn', value.message);
      else if (value.level === 'error') logChannel(channel, 'error', value.message);
      else throw new Error('Unknown worker log level');
      return;
    }
  } catch { /* Unexpected stderr (e.g. a Node crash) must remain visible. */ }
  if (line.trim()) logChannel(channel, 'error', `[${channel} worker] ${line}`);
}
