import fs from 'fs';
import path from 'path';
import { redactLogSecrets } from '../../shared/logRedaction';

export const HLS_LOG_FILE_BYTES = 5 * 1024 * 1024;
export const HLS_SESSION_LOG_BYTES = 100 * 1024 * 1024;
export const HLS_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** One rotated copy per file; session history is pruned at most once a minute. */
export class BoundedDiagnosticLog {
  private nextPruneAt = 0;

  constructor(private readonly root: string, private readonly fileBytes = HLS_LOG_FILE_BYTES,
    private readonly sessionBytes = HLS_SESSION_LOG_BYTES) {}

  append(name: string, message: string, now = Date.now()) {
    try {
      const file = path.join(this.root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Redact before truncating so a cut-off token cannot evade redaction.
      const clean = redactLogSecrets(message).replace(/[\r\n]+/g, ' ');
      const line = `[${new Date(now).toISOString()}] ${clean.slice(0, 16384)}\n`;
      if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(line) > this.fileBytes) {
        fs.rmSync(`${file}.1`, { force: true });
        fs.renameSync(file, `${file}.1`);
      }
      fs.appendFileSync(file, line, 'utf8');
      if (now >= this.nextPruneAt) {
        this.nextPruneAt = now + 60000;
        this.prune(now);
      }
    } catch {
      // Diagnostics must not turn a full disk or permissions error into failed playback.
    }
  }

  private prune(now: number) {
    const directory = path.join(this.root, 'hls-sessions');
    if (!fs.existsSync(directory)) return;
    const files = fs.readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && /\.log(?:\.1)?$/.test(entry.name))
      .map(entry => {
        const file = path.join(directory, entry.name);
        const stat = fs.statSync(file);
        return { file, size: stat.size, modified: stat.mtimeMs };
      }).sort((a, b) => a.modified - b.modified);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (now - file.modified > HLS_LOG_RETENTION_MS || total > this.sessionBytes) {
        fs.rmSync(file.file, { force: true });
        total -= file.size;
      }
    }
  }
}
