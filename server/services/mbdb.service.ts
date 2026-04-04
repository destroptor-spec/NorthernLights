import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { initDB } from '../database';
import { mbdbStatus, broadcastMbdbStatus } from '../state';

export class MBDBService {
  private updateStatus(updates: Partial<typeof mbdbStatus>) {
    Object.assign(mbdbStatus, updates);
    broadcastMbdbStatus();
  }

  public async importDatabase(): Promise<void> {
    if (mbdbStatus.isImporting) throw new Error('MBDB import already in progress');
    
    this.updateStatus({
      isImporting: true,
      phase: 'downloading',
      progress: 0,
      message: 'Downloading and extracting MusicBrainz dump (this may take a while)...',
    });

    const workDir = '/tmp/mbdb_extract';
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

    // Precheck: ensure sufficient disk space before starting (~5GB needed: 3.5GB download + 1.5GB extracted TSV)
    await this.checkDiskSpace('/tmp', 5 * 1024 * 1024 * 1024);

    try {
      await this.downloadAndExtractStream(workDir);

      this.updateStatus({ phase: 'inserting', message: 'Inserting genre definitions into database...' });
      await this.insertTableData(workDir);

      this.updateStatus({ phase: 'inserting', message: 'Building Materialized Hierarchy View...' });
      await this.refreshMaterializedView();

      this.updateStatus({
        phase: 'complete',
        message: 'MusicBrainz Database import completed successfully.',
        isImporting: false,
      });

    } catch (err: any) {
      console.error('[MBDB] Import failed:', err);
      this.updateStatus({
        phase: 'error',
        message: 'Import failed: ' + err.message,
        isImporting: false,
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }

  private async checkDiskSpace(dir: string, requiredBytes: number): Promise<void> {
    return new Promise((resolve, reject) => {
      fs.statfs(dir, (err, stats) => {
        if (err) {
          console.warn(`[MBDB] Could not check disk space for ${dir}: ${err.message}. Proceeding anyway.`);
          return resolve(); // Non-fatal: don't block if we can't check
        }
        const freeBytes = stats.bfree * stats.bsize;
        const requiredGB = (requiredBytes / 1024 / 1024 / 1024).toFixed(1);
        const freeGB = (freeBytes / 1024 / 1024 / 1024).toFixed(1);
        console.log(`[MBDB] Disk space check: ${freeGB}GB free, ${requiredGB}GB required on ${dir}`);
        if (freeBytes < requiredBytes) {
          reject(new Error(
            `Not enough disk space on ${dir}: ${freeGB}GB available, but ${requiredGB}GB required. ` +
            `Free up space and try again.`
          ));
        } else {
          resolve();
        }
      });
    });
  }

  private async downloadAndExtractStream(workDir: string): Promise<void> {
    const latestResponse = await fetch('https://data.metabrainz.org/pub/musicbrainz/data/fullexport/LATEST');
    const latestTag = (await latestResponse.text()).trim();
    if (!latestTag || latestTag.length > 50) throw new Error('Could not fetch MusicBrainz LATEST valid tag');

    return new Promise((resolve, reject) => {
      const url = `https://data.metabrainz.org/pub/musicbrainz/data/fullexport/${latestTag}/mbdump.tar.bz2`;
      const cmd = `curl -sL ${url} | tar -xjf - -C ${workDir} mbdump/genre mbdump/genre_alias mbdump/l_genre_genre`;
      
      console.log(`[MBDB] Starting download stream: ${cmd}`);
      const child = spawn('bash', ['-c', cmd]);

      let errorOutput = '';

      child.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      child.on('close', (code) => {
        if (code !== 0 && code !== null) {
          return reject(new Error(`Command failed with code ${code}: ${errorOutput}`));
        }

        const mbdumpDir = path.join(workDir, 'mbdump');
        if (!fs.existsSync(mbdumpDir) || !fs.existsSync(path.join(mbdumpDir, 'genre')) || !fs.existsSync(path.join(mbdumpDir, 'genre_alias')) || !fs.existsSync(path.join(mbdumpDir, 'l_genre_genre'))) {
          return reject(new Error('Extraction finished but one or more expected TSV files (genre, genre_alias, l_genre_genre) are missing.'));
        }

        resolve();
      });
    });
  }

  private escape(value: string, index: number, keys: string[]): string {
      const type = keys[index];
      if (['id', 'genre', 'entity0', 'entity1', 'link', 'edits_pending', 'type', 'begin_date_year', 'begin_date_month', 'begin_date_day', 'end_date_year', 'end_date_month', 'end_date_day', 'link_order'].includes(type)) {
          return value; // Number
      }
      if (['primary_for_locale', 'ended'].includes(type)) {
          return value === 't' ? 'true' : 'false';
      }
      return `'${value.replace(/'/g, "''")}'`;
  }

  private async processTSV(filePath: string, insertBatch: (batch: string[][]) => Promise<void>) {
    if (!fs.existsSync(filePath)) return;
    
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

    let batch: string[][] = [];
    const batchSize = 1000;

    for await (const line of rl) {
        if (!line.trim()) continue;
        batch.push(line.split('\t').map(v => v === '\\N' ? null : v) as any);
        if (batch.length >= batchSize) {
            await insertBatch(batch);
            batch = [];
        }
    }

    if (batch.length > 0) {
        await insertBatch(batch);
    }
  }

  private async insertTableData(workDir: string) {
    const db = await initDB();
    const mbdumpDir = path.join(workDir, 'mbdump');

    await db.query('TRUNCATE genre, genre_alias, l_genre_genre RESTART IDENTITY CASCADE');

    this.updateStatus({ message: 'Inserting genre definitions...' });
    const genreKeys = ['id', 'gid', 'name', 'comment', 'edits_pending', 'last_updated'];
    await this.processTSV(path.join(mbdumpDir, 'genre'), async (batch) => {
        const values = batch.map(row => 
            `(${row.map((v, i) => v === null ? 'NULL' : this.escape(v, i, genreKeys)).join(',')})`
        ).join(',');
        await db.query(`INSERT INTO genre (${genreKeys.join(',')}) VALUES ${values}`);
    });

    this.updateStatus({ message: 'Inserting genre aliases...' });
    const aliasKeys = ['id', 'genre', 'name', 'locale', 'edits_pending', 'last_updated', 'type', 'sort_name', 'begin_date_year', 'begin_date_month', 'begin_date_day', 'end_date_year', 'end_date_month', 'end_date_day', 'primary_for_locale', 'ended'];
    await this.processTSV(path.join(mbdumpDir, 'genre_alias'), async (batch) => {
        const values = batch.map(row => 
            `(${row.map((v, i) => v === null ? 'NULL' : this.escape(v, i, aliasKeys)).join(',')})`
        ).join(',');
        await db.query(`INSERT INTO genre_alias (${aliasKeys.join(',')}) VALUES ${values}`);
    });

    this.updateStatus({ message: 'Inserting genre relationships...' });
    const linkKeys = ['id', 'link', 'entity0', 'entity1', 'edits_pending', 'last_updated', 'link_order', 'entity0_credit', 'entity1_credit'];
    await this.processTSV(path.join(mbdumpDir, 'l_genre_genre'), async (batch) => {
        const values = batch.map(row => 
            `(${row.map((v, i) => v === null ? 'NULL' : this.escape(v, i, linkKeys)).join(',')})`
        ).join(',');
        await db.query(`INSERT INTO l_genre_genre (${linkKeys.join(',')}) VALUES ${values}`);
    });
  }

  private async refreshMaterializedView() {
    const db = await initDB();
    await db.query('REFRESH MATERIALIZED VIEW genre_tree_paths');
  }
}

export const mbdbService = new MBDBService();
