// Keep diagnostics on stderr, separate from the stdout job-result protocol.
// The parent applies current settings, even while a worker is busy.
export function workerLog(level: 'debug' | 'warn' | 'error', message: string) {
  process.stderr.write(JSON.stringify({ kind: 'aurora-worker-log', level, message }) + '\n');
}
